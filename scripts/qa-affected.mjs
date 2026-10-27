#!/usr/bin/env node
/**
 * Change-aware ALZ QA. No hosted model, network, cloud credentials or infra
 * mutation is involved. Agents run this locally before submitting a change;
 * CI repeats the same deterministic scope against the PR diff.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, extname, posix, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const TEST = /^test\/[^/]+\.test\.(?:ts|tsx|mjs)$/;
const PY_TEST = /^test\/[^/]+\.test\.py$/;
const PY_SOURCE = /^scripts\/[^/]+\.py$/;
const SOURCE = /^src\/.+\.(?:ts|tsx|js|mjs)$/;
const QA_SELF_TEST = "test/qa-affected.test.mjs";
const MAX_AFFECTED_TESTS = 45;
const RUNTIME_FRAMEWORK_IMPORT = /from\s+["']@langchain\//;
// Inventory guards scan the filesystem (src/cli, ./alz, package.json scripts,
// generated docs) instead of importing what they check, so the import closure
// can never select them. Without this rule a new CLI entry point merges with
// a red parity guard that only surfaces on the next PR touching the catalog.
const INVENTORY_GUARDS = ["test/operations-parity.test.ts", "test/operations-core.test.ts",
  "test/cli-ui-journey-map.test.ts"];
const INVENTORY_INPUT = /^(?:src\/cli\/[^/]+\.ts|src\/operations\/.+\.ts|alz|package\.json|docs\/operator-console\.md|docs\/cli-ui-journey-map\.md)$/;

// The ./alz dispatcher runs its command switch at module top level, so no test can import it; its owners are the guards that
// read its text (operations-parity checks every `command === "x"` branch against the catalog and the help text) and the
// operator CLI test that runs it.
export const UNIMPORTABLE_OWNERS = {
  "src/cli/operator.ts": ["test/operations-parity.test.ts", "test/operator-cli.test.ts"],
};

// Fixtures a test reads from disk (not imported), so the import closure never selects their owner.
export const FIXTURE_OWNERS = {
  "test/fixtures/backend-pin/cases.json": ["test/apply-backend-pin-real.test.ts"],
};

// Source-scan guards read a source tree from disk (a forbidden literal, import or call anywhere under it) instead of
// importing what they check, so the import closure never selects them. Each is declared with the roots it scans and
// runs for any source change under one of them; test/qa-affected.test.mjs fails if a test scans source without an
// entry here. Without this, a governed -destroy builder added under src/apply merged with the destroy-literal scan red.
export const SOURCE_SCAN_GUARDS = {
  "test/apply-boundary.test.ts": ["src/"],
  "test/policy-path.test.ts": ["src/"],
  "test/teardown-adapter-terraform.test.ts": ["src/"],
  "test/teardown-driver-denials.test.ts": ["src/"],
  "test/teardown-driver-cli.test.ts": ["src/tools/", "src/operator-ui/", "src/agent/"],
  "test/teardown-driver.test.ts": ["src/tools/"],
  "test/teardown-adapter-pulumi.test.ts": ["src/tools/"],
  "test/destroy-preview-boundary.test.ts": ["src/iac/"],
  "test/runner-hardening.test.ts": ["src/iac/", "src/tools/"],
  "test/learn-path.test.ts": ["src/learn/"],
  "test/compliance-packs.test.ts": ["src/compliance/"],
  "test/cli-ui-journey-map.test.ts": ["src/operator-ui/", "src/operations/"],
  "test/operations-teardown.test.ts": ["src/operations/"],
  "test/operations-enterprise.test.ts": ["src/cli/"],
  "test/operations-parity.test.ts": ["src/cli/"],
  // The console's plain-words check reads codes out of src/apply/types.ts, src/apply/prepare.ts, src/apply/preview-evidence.ts
  // (the producer's refusals), src/cli/apply.ts and src/cli/ui-channel.ts, so a code added under either directory without its
  // words merged unnoticed (#257 round 1: PREVIEW_ATTESTATION_MISMATCH; round 2 NB6: the producer's own codes).
  "test/pilot-wizard.test.tsx": ["src/apply/", "src/cli/"],
};

// The journey matrix cites code and test titles by path, which no import reaches: a change to the matrix or to any file it
// cites re-runs its check, so a renamed test or a removed module fails here instead of on a later, unrelated PR.
const ACCEPTANCE_MATRIX = "config/acceptance/journeys.json";
const ACCEPTANCE_TEST = "test/acceptance-journeys.test.ts";
export function acceptanceCited(files) {
  const cited = new Set([ACCEPTANCE_MATRIX]);
  try {
    JSON.stringify(JSON.parse(files.get(ACCEPTANCE_MATRIX) ?? "{}"), (key, value) => {
      if ((key === "file" || key === "liveEvidence" || key === "evidence" || typeof key === "string" && /^\d+$/.test(key)) && typeof value === "string" && /^(?:src|test|scripts|config\/acceptance)\//.test(value)) cited.add(value);
      return value;
    });
  } catch { /* an unreadable matrix fails its own test, which the matrix path still selects */ }
  return cited;
}

// The release gate status is checked against its scope, the generated release view and the journey matrix, all read from
// disk: a change to any of them re-runs that check, so a stale docs/release-status.md or an unprovable claim fails here.
const RELEASE_STATUS_INPUT = /^(?:config\/release\/.+\.json|docs\/release-status\.md|config\/acceptance\/journeys\.json)$/;
const RELEASE_STATUS_TEST = "test/release-status.test.ts";

function uniq(values) { return [...new Set(values)].sort(); }
function hasFile(files, name) { return files.has(name); }
function matching(files, re) { return [...files.keys()].filter(p => re.test(p)); }
function addExisting(target, files, paths) {
  for (const path of paths) if (hasFile(files, path)) target.add(path);
}
function candidates(path) {
  const base = path.replace(/\.(?:js|mjs|cjs)$/, "");
  return uniq([path, base + ".ts", base + ".tsx", base + ".js", base + ".mjs",
    base + "/index.ts", base + "/index.tsx", base + "/index.js"]);
}
export function importsOf(text, path, files) {
  const found = new Set();
  const re = /(?:\bfrom\s*|\bimport\s*(?:\(\s*)?|\brequire\s*\(\s*)["'](\.[^"']+)["']/g;
  for (const match of text.matchAll(re)) {
    const base = posix.normalize(posix.join(posix.dirname(path), match[1]));
    for (const candidate of candidates(base)) {
      if (hasFile(files, candidate)) { found.add(candidate); break; }
    }
  }
  return found;
}
export function planChanged(changedPaths, files) {
  const changed = uniq(changedPaths);
  const selected = new Set();
  const gaps = [];
  const notes = [];
  const pythonTests = new Set();
  const pythonChanged = new Set();
  const pythonEntrypoints = new Set();
  let buildUi = false;
  let pinCheck = false;
  let pluginCheck = false;
  let configCheck = false;

  // Reverse dependency closure: changing a module selects tests importing it
  // directly or through other source modules. No tests outside this closure
  // are run unless an explicit safety/fixture ownership rule below selects them.
  const parents = new Map();
  for (const [file, content] of files) {
    if (!SOURCE.test(file) && !TEST.test(file) && !/^scripts\/.+\.(?:ts|tsx|mjs|js)$/.test(file)) continue;
    for (const child of importsOf(content, file, files)) {
      if (!parents.has(child)) parents.set(child, new Set());
      parents.get(child).add(file);
    }
  }
  const impactedBy = path => {
    const seen = new Set([path]);
    const queue = [path];
    while (queue.length) {
      const item = queue.shift();
      for (const parent of parents.get(item) ?? []) {
        if (!seen.has(parent)) { seen.add(parent); queue.push(parent); }
      }
    }
    return [...seen].filter(p => TEST.test(p));
  };

  const cited = acceptanceCited(files);
  for (const path of changed) {
    if (INVENTORY_INPUT.test(path)) addExisting(selected, files, INVENTORY_GUARDS);
    if (cited.has(path)) addExisting(selected, files, [ACCEPTANCE_TEST]);
    if (RELEASE_STATUS_INPUT.test(path)) {
      addExisting(selected, files, [RELEASE_STATUS_TEST]);
      if (path.startsWith("config/release/")) continue;
    }
    if (/^docs\/(?:operator-console|cli-ui-journey-map)\.md$/.test(path)) continue;
    if (path === "scripts/qa-affected.mjs" || path === QA_SELF_TEST) {
      addExisting(selected, files, [QA_SELF_TEST]);
      continue;
    }
    if (TEST.test(path)) { selected.add(path); if (path === "test/csp-first-party.test.tsx") buildUi = true; continue; }
    if (PY_TEST.test(path)) { pythonTests.add(path); continue; }
    if (PY_SOURCE.test(path)) {
      pythonChanged.add(path);
      const script = files.get(path) ?? "";
      const importing = matching(files, PY_TEST).filter(testPath => {
        const body = files.get(testPath) ?? "";
        return body.includes(posix.basename(path)) || body.includes(path);
      });
      for (const testPath of importing) pythonTests.add(testPath);
      if (posix.basename(path) === "alz-synthetic-qualification.py") {
        // Its contract is executing the two named synthetic tests end to end.
        pythonEntrypoints.add(path);
        for (const testPath of matching(files, PY_TEST)) {
          if (script.includes(posix.basename(testPath))) pythonTests.add(testPath);
        }
      }
      if (!importing.length && !pythonEntrypoints.has(path)) {
        gaps.push(path + " has no Python test owner. Add a focused test.");
      }
      continue;
    }
    if (/^docs\/|\.md$|^\.github\/(ISSUE_TEMPLATE|PULL_REQUEST_TEMPLATE)\//.test(path)) continue;
    if (/^\.github\/workflows\/.+\.ya?ml$/.test(path)) {
      pinCheck = true;
      addExisting(selected, files, [QA_SELF_TEST]);
      continue;
    }
    if (/^(?:package(?:-lock)?\.json|tsconfig(?:\.ui)?\.json|vite\.config\.ts|vitest\.config\.ts)$/.test(path)) {
      configCheck = true;
      if (/vite|vitest/.test(path)) buildUi = true;
      addExisting(selected, files, ["test/deps-install.test.ts", "test/development-readiness.test.ts", QA_SELF_TEST]);
      if (/^package(?:-lock)?\.json$/.test(path)) {
        // A dependency bump changes code no import edge in this repo points at. The agent runtime's framework is the
        // dependency whose behavior tests can observe (graph execution, checkpoints, no tracing egress), so its
        // consumers' tests run. zod is left to the typecheck: it is imported almost everywhere.
        for (const [file, content] of files) {
          if (SOURCE.test(file) && RUNTIME_FRAMEWORK_IMPORT.test(content)) addExisting(selected, files, impactedBy(file));
        }
      }
      continue;
    }
    if (/^src\/plugins\/|^config\/plugins/.test(path)) {
      pluginCheck = true;
    }
    // The lifecycle runner's evidence is judged by the release admission review it reuses: a change under src/lifecycle runs
    // the runner's own tests and the admission review's, so a report shape the review would refuse never merges unnoticed.
    if (/^src\/lifecycle\//.test(path)) {
      addExisting(selected, files, ["test/lifecycle-runner.test.ts", "test/lifecycle-cli.test.ts", "test/release-admission.test.ts"]);
    }
    // The Azure pilot bootstrap is Terraform no import reaches: its owner reads the files and, opt-in, runs their own
    // offline `terraform test` (mocked providers). Any file under it selects that owner; nothing else under bootstrap/ does.
    if (/^bootstrap\/azure\//.test(path)) {
      addExisting(selected, files, ["test/bootstrap-azure.test.ts"]);
      if (!hasFile(files, "test/bootstrap-azure.test.ts")) gaps.push("The Azure bootstrap has no focused test owner.");
      continue;
    }
    if (/^src\/operator-ui\/app\/.*\.(?:css|svg)$/.test(path)) {
      buildUi = true;
      addExisting(selected, files, ["test/operator-ui-react.test.tsx",
        "test/operator-ui-shell.test.tsx", "test/csp-first-party.test.tsx"]);
      continue;
    }
    if (SOURCE.test(path)) {
      const directlyImpacted = impactedBy(path);
      addExisting(selected, files, directlyImpacted);
      if (/^src\/operator-ui\/app\//.test(path)) buildUi = true;
      if (/^src\/(?:apply|security|identity|actions|policy)\//.test(path)) {
        addExisting(selected, files, ["test/security-boundaries.test.ts"]);
      }
      for (const [guard, roots] of Object.entries(SOURCE_SCAN_GUARDS)) {
        if (roots.some((root) => path.startsWith(root))) addExisting(selected, files, [guard]);
      }
      if (directlyImpacted.length === 0) {
        // Do not mask missing test ownership with a blanket full-suite run.
        const owners = UNIMPORTABLE_OWNERS[path];
        if (owners) addExisting(selected, files, owners);
        // A deleted module has no importer left to select; the type check (npm run check) proves none still imports it.
        else if (!files.has(path)) notes.push(path + " was deleted; the type check proves no importer remains.");
        else gaps.push(path + " has no importing test. Add a focused test.");
      }
      continue;
    }
    if (/^test\/(?:fixtures|helpers)\//.test(path)) {
      const dependent = [...impactedBy(path), ...(FIXTURE_OWNERS[path] ?? []).filter((owner) => files.has(owner))];
      addExisting(selected, files, dependent);
      if (!dependent.length) gaps.push(path + " has no known test owner; add an explicit focused test.");
      continue;
    }
    if (/^qualification\/aws\/act-dev1-canary\/(?:.+\.tf|terraform\.tfvars\.example\.json)$/.test(path) ||
        /^bootstrap\/aws\/(?:(?:main|variables|discovery)\.tf|discovery-policy\.json|terraform\.tfvars\.example|tests\/discovery\.tftest\.hcl)$/.test(path) ||
        path === "tests_python/test_aws_dev_terraform_handoff.py") {
      addExisting(pythonTests, files, ["test/act-dev1-automation.test.py"]);
      // The DISCOVERY scope (owner decision 6440801434, item 2): its policy content is asserted by a focused node test.
      if (/^bootstrap\/aws\/(?:discovery|variables)\b|^bootstrap\/aws\/tests\/discovery\./.test(path)) addExisting(selected, files, ["test/discovery-scope.test.ts"]);
      if (!hasFile(files, "test/act-dev1-automation.test.py")) {
        gaps.push("ACT-DEV-1 Terraform canary has no focused test owner.");
      }
      continue;
    }
    if (/^(?:config|policy|security)\//.test(path)) {
      const family = path.startsWith("policy/") ? ["test/security-policy.test.ts", "test/policy-path.test.ts"]
        : path.startsWith("security/") ? ["test/security-boundaries.test.ts", "test/security-policy.test.ts"]
        : ["test/config.test.ts", "test/security-policy.test.ts"];
      addExisting(selected, files, family);
      continue;
    }
    if (/^scripts\/.+\.(?:ts|js|mjs|py|sh)$/.test(path)) {
      const stem = posix.basename(path).replace(/\.(?:ts|js|mjs|py|sh)$/, "");
      addExisting(selected, files, ["test/" + stem + ".test.ts", "test/" + stem + ".test.tsx", QA_SELF_TEST]);
      continue;
    }
    if (path === ".gitignore") {
      addExisting(selected, files, ["test/gitignore-secrets.test.ts"]);
      continue;
    }
    if (/^(?:Dockerfile|compose(?:\.production)?\.yaml|\.dockerignore|alz)$/.test(path)) {
      addExisting(selected, files, ["test/container-security.test.ts", "test/deps-cli.test.ts"]);
      notes.push("Release-sensitive artifact changed: dedicated qualification remains independent.");
      continue;
    }
    // Unknown executable or deployment configuration: do not silently pass.
    gaps.push(path + " has no QA ownership rule.");
  }
  if (selected.size + pythonTests.size > MAX_AFFECTED_TESTS) {
    gaps.push("Affected test count " + (selected.size + pythonTests.size) + " exceeds " + MAX_AFFECTED_TESTS +
      ". Split the change or qualify it through an explicit release gate.");
  }
  if (!selected.size && !pythonTests.size && gaps.length === 0 && changed.some(p => !(/\.md$|^docs\//.test(p)))) {
    gaps.push("Executable changes selected no tests.");
  }
  const tests = uniq([...selected]);
  const nodeTests = tests.filter(p => p.endsWith(".test.ts"));
  const uiTests = tests.filter(p => p.endsWith(".test.tsx"));
  const jsTests = tests.filter(p => p.endsWith(".test.mjs"));
  if (uiTests.includes("test/csp-first-party.test.tsx") ||
      nodeTests.includes("test/operations-core.test.ts")) {
    // The HTTP inventory guard serves the generated UI index to obtain its
    // CSRF token. A clean CI checkout must build that real asset first.
    buildUi = true;
  }
  return {
    changed, nodeTests, uiTests, jsTests, pythonTests: uniq([...pythonTests]),
    pythonChanged: uniq([...pythonChanged]), pythonEntrypoints: uniq([...pythonEntrypoints]),
    gaps, notes, buildUi, pinCheck,
    pluginCheck, configCheck,
    typeNode: uniq(changed.filter(p => /^src\/.+\.ts$/.test(p) &&
      !p.startsWith("src/operator-ui/app/"))),
    typeUi: uniq([...changed.filter(p => /^src\/operator-ui\/app\/.+\.tsx?$/.test(p)),
      ...uiTests]),
    needsDeps: Boolean(nodeTests.length || uiTests.length || buildUi || pluginCheck || configCheck ||
      changed.some(p => SOURCE.test(p))),
    testCount: tests.length + pythonTests.size,
  };
}
function git(args) {
  const r = spawnSync("git", args, {encoding: "utf8"});
  if (r.status !== 0) throw Error("git " + args.join(" ") + " failed: " + r.stderr);
  return r.stdout;
}
// Three-dot semantics: only changes introduced by the PR branch are in
// scope. Comparing base tip to head incorrectly treats newer main files as
// deletions in an older PR and triggers unrelated QA (regression PR #192).
export function diffCommand(base, head, runner) {
  const ancestor = runner(["merge-base", base, head]).trim();
  if (!ancestor) throw Error("QA cannot find the PR merge-base");
  return ["diff", "--name-only", "-z", "--diff-filter=ACMRD", ancestor, head];
}
function arg(name, fallback = "") {
  const index = process.argv.indexOf(name);
  return index < 0 ? fallback : process.argv[index + 1];
}
function runCmd(name, args) {
  console.log("QA: " + name + " " + args.join(" "));
  const r = spawnSync(name, args, {stdio: "inherit", env: {...process.env,
    CI: process.env.CI ?? "true"}});
  if (r.status !== 0) throw Error("QA failed: " + name + " " + args.join(" ") +
    " (exit " + (r.status ?? r.signal ?? "unknown") + ")");
}
function writeTsconfig(name, base, files) {
  if (!files.length) return null;
  const path = ".runs/qa/" + name + ".json";
  writeFileSync(path, JSON.stringify({
    extends: "../../" + base,
    compilerOptions: {noEmit: true, rootDir: "../.."},
    files: files.map(p => "../../" + p),
    include: [],
    exclude: [],
  }, null, 2) + "\n");
  return path;
}
function execute(plan) {
  if (plan.gaps.length) throw Error("QA coverage gaps:\n" + plan.gaps.join("\n"));
  if (!plan.testCount && !plan.pinCheck) return console.log("QA: documentation-only; no tests needed.");
  mkdirSync(".runs/qa", {recursive: true});
  if (plan.pinCheck) runCmd("npm", ["run", "ci:actions-pinned"]);
  // Even manifest/compiler changes compile only representative entry points
  // and their import closures. A full project compile belongs to the
  // separately approved release gate, never routine PR iterations.
  const nodeInputs = plan.typeNode.length ? plan.typeNode :
    (plan.configCheck ? ["src/config.ts"] : []);
  const uiInputs = plan.typeUi.length ? plan.typeUi :
    (plan.configCheck ? ["test/operator-ui-react.test.tsx"] : []);
  const nodeConfig = writeTsconfig("node-affected", "tsconfig.json", nodeInputs);
  const uiConfig = writeTsconfig("ui-affected", "tsconfig.ui.json", uiInputs);
  if (nodeConfig) runCmd("./node_modules/.bin/tsc", ["-p", nodeConfig]);
  if (uiConfig) runCmd("./node_modules/.bin/tsc", ["-p", uiConfig]);
  if (plan.buildUi) runCmd("npm", ["run", "build:ui"]);
  if (plan.nodeTests.length) runCmd("./node_modules/.bin/tsx", ["--test", ...plan.nodeTests]);
  if (plan.uiTests.length) runCmd("./node_modules/.bin/vitest", ["run", ...plan.uiTests]);
  if (plan.jsTests.length) runCmd("node", ["--test", ...plan.jsTests]);
  if (plan.pythonChanged?.length) runCmd("python3", ["-m", "py_compile", ...plan.pythonChanged]);
  for (const testPath of plan.pythonTests ?? []) runCmd("python3", [testPath]);
  for (const entrypoint of plan.pythonEntrypoints ?? []) runCmd("python3", [entrypoint]);
  if (plan.pluginCheck) runCmd("npm", ["run", "plugins:check"]);
  console.log("QA: passed " + plan.testCount + " affected test files.");
}
function main() {
  const mode = process.argv[2] ?? "plan";
  if (mode === "run") {
    const file = arg("--plan", ".runs/qa/plan.json");
    return execute(JSON.parse(readFileSync(file, "utf8")));
  }
  if (mode !== "plan" && mode !== "local") throw Error("Usage: qa-affected.mjs plan|local [--base SHA] [--head SHA] [--out FILE]");
  const base = arg("--base", process.env.QA_BASE ?? "origin/main");
  const head = arg("--head", process.env.QA_HEAD ?? "");
  // Local edits are based on the common ancestor, not the moving main tip.
  // Include untracked files so a newly added source/test is not invisible.
  const compareHead = head || "HEAD";
  const diff = git(diffCommand(base, compareHead, git));
  const untracked = head ? [] : git(["ls-files", "--others", "--exclude-standard", "-z"])
    .split("\0").filter(Boolean);
  const changed = uniq([...diff.split("\0").filter(Boolean), ...untracked]);
  const tracked = uniq([...git(["ls-files", "-z"]).split("\0").filter(Boolean), ...untracked]);
  const files = new Map();
  for (const file of tracked) {
    if (SOURCE.test(file) || TEST.test(file) || PY_TEST.test(file) || PY_SOURCE.test(file) || /^scripts\/.+\.(?:ts|tsx|js|mjs)$/.test(file)) {
      if (existsSync(file)) files.set(file, readFileSync(file, "utf8"));
    } else files.set(file, "");
  }
  const plan = planChanged(changed, files);
  const file = arg("--out", ".runs/qa/plan.json");
  mkdirSync(dirname(file), {recursive: true});
  writeFileSync(file, JSON.stringify(plan, null, 2) + "\n");
  console.log("QA scope: " + plan.testCount + " affected test files; " + changed.length + " changed paths.");
  console.log("QA paths: " + JSON.stringify({node:plan.nodeTests, ui:plan.uiTests,
    js:plan.jsTests, python:plan.pythonTests, gaps:plan.gaps, notes:plan.notes}));
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY,
    "### Affected QA\n\nChanged paths: " + changed.length + "; test files: " + plan.testCount +
    "\n\n" + plan.nodeTests.concat(plan.uiTests, plan.jsTests, plan.pythonTests).map(p => "- " + p).join("\n") + "\n");
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT,
    "needs_deps=" + String(plan.needsDeps) + "\n");
  if (plan.gaps.length) throw Error("QA requires focused coverage:\n" + plan.gaps.join("\n"));
  if (mode === "local") return execute(plan);
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { main(); } catch (err) { console.error(err.message); process.exitCode = 1; }
}
