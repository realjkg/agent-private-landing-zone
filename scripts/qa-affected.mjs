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
const SOURCE = /^src\/.+\.(?:ts|tsx|js|mjs)$/;
const QA_SELF_TEST = "test/qa-affected.test.mjs";
const MAX_AFFECTED_TESTS = 45;

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

  for (const path of changed) {
    if (path === "scripts/qa-affected.mjs" || path === QA_SELF_TEST) {
      addExisting(selected, files, [QA_SELF_TEST]);
      continue;
    }
    if (TEST.test(path)) { selected.add(path); if (path === "test/csp-first-party.test.tsx") buildUi = true; continue; }
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
      continue;
    }
    if (/^src\/plugins\/|^config\/plugins/.test(path)) {
      pluginCheck = true;
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
        addExisting(selected, files, ["test/security-boundaries.test.ts",
          "test/apply-boundary.test.ts"]);
      }
      if (directlyImpacted.length === 0) {
        // Do not mask missing test ownership with a blanket full-suite run.
        gaps.push(path + " has no importing test. Add a focused test.");
      }
      continue;
    }
    if (/^test\/(?:fixtures|helpers)\//.test(path)) {
      const dependent = impactedBy(path);
      addExisting(selected, files, dependent);
      if (!dependent.length) gaps.push(path + " has no known test owner; add an explicit focused test.");
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
    if (/^(?:Dockerfile|compose(?:\.production)?\.yaml|\.dockerignore|alz)$/.test(path)) {
      addExisting(selected, files, ["test/container-security.test.ts", "test/deps-cli.test.ts"]);
      notes.push("Release-sensitive artifact changed: dedicated qualification remains independent.");
      continue;
    }
    // Unknown executable or deployment configuration: do not silently pass.
    gaps.push(path + " has no QA ownership rule.");
  }
  if (selected.size > MAX_AFFECTED_TESTS) {
    gaps.push("Affected test count " + selected.size + " exceeds " + MAX_AFFECTED_TESTS +
      ". Split the change or qualify it through an explicit release gate.");
  }
  if (!selected.size && gaps.length === 0 && changed.some(p => !(/\.md$|^docs\//.test(p)))) {
    gaps.push("Executable changes selected no tests.");
  }
  const tests = uniq([...selected]);
  const nodeTests = tests.filter(p => p.endsWith(".test.ts"));
  const uiTests = tests.filter(p => p.endsWith(".test.tsx"));
  const jsTests = tests.filter(p => p.endsWith(".test.mjs"));
  if (uiTests.includes("test/csp-first-party.test.tsx")) buildUi = true;
  return {
    changed, nodeTests, uiTests, jsTests, gaps, notes, buildUi, pinCheck,
    pluginCheck, configCheck,
    typeNode: uniq(changed.filter(p => /^src\/.+\.ts$/.test(p) &&
      !p.startsWith("src/operator-ui/app/"))),
    typeUi: uniq([...changed.filter(p => /^src\/operator-ui\/app\/.+\.tsx?$/.test(p)),
      ...uiTests]),
    needsDeps: Boolean(nodeTests.length || uiTests.length || buildUi || pluginCheck || configCheck ||
      changed.some(p => SOURCE.test(p))),
    testCount: tests.length,
  };
}
function git(args) {
  const r = spawnSync("git", args, {encoding: "utf8"});
  if (r.status !== 0) throw Error("git " + args.join(" ") + " failed: " + r.stderr);
  return r.stdout;
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
  if (plan.configCheck) {
    // Build-configuration changes affect all project types, but not the full
    // regression suite. This path intentionally qualifies the compiler only.
    runCmd("npm", ["run", "check"]);
  } else {
    const nodeConfig = writeTsconfig("node-affected", "tsconfig.json", plan.typeNode);
    const uiConfig = writeTsconfig("ui-affected", "tsconfig.ui.json", plan.typeUi);
    if (nodeConfig) runCmd("./node_modules/.bin/tsc", ["-p", nodeConfig]);
    if (uiConfig) runCmd("./node_modules/.bin/tsc", ["-p", uiConfig]);
  }
  if (plan.buildUi && !plan.configCheck) runCmd("npm", ["run", "build:ui"]);
  if (plan.nodeTests.length) runCmd("./node_modules/.bin/tsx", ["--test", ...plan.nodeTests]);
  if (plan.uiTests.length) runCmd("./node_modules/.bin/vitest", ["run", ...plan.uiTests]);
  if (plan.jsTests.length) runCmd("node", ["--test", ...plan.jsTests]);
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
  const diff = git(["diff", "--name-only", "-z", "--diff-filter=ACMRD", base, ...(head ? [head] : [])]);
  const changed = diff.split("\0").filter(Boolean);
  const tracked = git(["ls-files", "-z"]).split("\0").filter(Boolean);
  const files = new Map();
  for (const file of tracked) {
    if (SOURCE.test(file) || TEST.test(file) || /^scripts\/.+\.(?:ts|tsx|js|mjs)$/.test(file)) {
      if (existsSync(file)) files.set(file, readFileSync(file, "utf8"));
    } else files.set(file, "");
  }
  const plan = planChanged(changed, files);
  const file = arg("--out", ".runs/qa/plan.json");
  mkdirSync(dirname(file), {recursive: true});
  writeFileSync(file, JSON.stringify(plan, null, 2) + "\n");
  console.log("QA scope: " + plan.testCount + " affected test files; " + changed.length + " changed paths.");
  console.log("QA paths: " + JSON.stringify({node:plan.nodeTests, ui:plan.uiTests,
    js:plan.jsTests, gaps:plan.gaps, notes:plan.notes}));
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY,
    "### Affected QA\n\nChanged paths: " + changed.length + "; test files: " + plan.testCount +
    "\n\n" + plan.nodeTests.concat(plan.uiTests, plan.jsTests).map(p => "- " + p).join("\n") + "\n");
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT,
    "needs_deps=" + String(plan.needsDeps) + "\n");
  if (plan.gaps.length) throw Error("QA requires focused coverage:\n" + plan.gaps.join("\n"));
  if (mode === "local") return execute(plan);
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { main(); } catch (err) { console.error(err.message); process.exitCode = 1; }
}
