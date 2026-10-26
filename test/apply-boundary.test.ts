import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import test from "node:test";

import { OPERATIONS } from "../src/operations/registry.js";
import { validateCatalog } from "../src/operations/schema.js";
import type { OperationSpec } from "../src/operations/types.js";

// The pilot plan (PR #117; docs/act-pilot-plan.md once merged). The operator authorizes and the driver enforces, so
// the apply path must be reachable from exactly one place: the human CLI. These
// tests pin that structurally, over the real import graph and the real catalog.

const walk = (path: string): string[] => readdirSync(path, { withFileTypes: true }).flatMap((entry) =>
  entry.isDirectory() ? walk(join(path, entry.name)) : /\.tsx?$/.test(entry.name) ? [join(path, entry.name)] : []);

const IMPORT = /(?:from\s+|import\s*\(\s*|import\s+|require\s*\(\s*)["'](\.{1,2}\/[^"']+)["']/g;
function importsOf(file: string): string[] {
  const found: string[] = [];
  for (const match of readFileSync(file, "utf8").matchAll(IMPORT)) {
    const base = normalize(join(dirname(file), match[1]));
    const candidates = [base.replace(/\.js$/, ".ts"), base.replace(/\.js$/, ".tsx"), base + ".ts", join(base, "index.ts")];
    const hit = candidates.find((candidate) => existsSync(candidate) && /\.tsx?$/.test(candidate));
    if (hit) found.push(hit);
  }
  return found;
}
/** Everything the roots can reach by import. A file in `barrier` is reached but its own imports are not followed. */
function reachableFrom(roots: string[], barrier: readonly string[] = []): Set<string> {
  const seen = new Set<string>(roots);
  const queue = [...roots];
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (barrier.includes(file)) continue;
    for (const next of importsOf(file)) if (!seen.has(next)) { seen.add(next); queue.push(next); }
  }
  return seen;
}
const UI_CHANNEL = "src/cli/ui-channel.ts";
const CONSOLE_SERVER = "src/operator-ui/server.ts";
const isApplyPath = (file: string): boolean => file.startsWith("src/apply/") || file === "src/cli/apply.ts";

test("nothing the broker, agents, orchestration or the catalog can reach imports the apply path, the console adapter or the console server", () => {
  const roots = ["src/tools", "src/agent", "src/orchestration", "src/a2a", "src/delegation", "src/operations"].flatMap(walk);
  assert.ok(roots.length > 30, "the walk found the agent-facing modules");
  const reached = reachableFrom(roots);
  assert.deepEqual([...reached].filter(isApplyPath), [], "an agent-facing module reaches the apply path");
  assert.ok(!reached.has(UI_CHANNEL), "an agent-facing module reaches the console adapter");
  assert.ok(!reached.has(CONSOLE_SERVER), "an agent-facing module reaches the console server that mounts the adapter");
});

test("from the console side exactly src/cli/ui-channel.ts reaches the apply path, and only the console server mounts it", () => {
  // The browser bundle and every console module except the server: no route to the apply path or the adapter at all.
  const browserSide = walk("src/operator-ui").filter((file) => file !== CONSOLE_SERVER);
  assert.ok(browserSide.length > 20, "the walk found the console modules");
  const browserReach = reachableFrom(browserSide);
  assert.deepEqual([...browserReach].filter(isApplyPath), [], "console code outside the adapter reaches the apply path");
  assert.ok(!browserReach.has(UI_CHANNEL), "console code other than the server imports the adapter");
  // The server mounts the adapter, and with the adapter set aside it reaches nothing of the apply path.
  assert.ok(importsOf(CONSOLE_SERVER).includes(UI_CHANNEL), "the server mounts the adapter");
  assert.deepEqual([...reachableFrom([CONSOLE_SERVER], [UI_CHANNEL])].filter(isApplyPath), [], "the server reaches the apply path other than through the adapter");
  // Who may import the adapter, and who may import the CLI the adapter drives.
  const sources = walk("src");
  assert.deepEqual(sources.filter((file) => importsOf(file).includes(UI_CHANNEL)), [CONSOLE_SERVER]);
  assert.deepEqual(sources.filter((file) => importsOf(file).includes("src/cli/apply.ts")), [UI_CHANNEL]);
  // The adapter takes from src/apply only what it names here: no driver, no engine, no identities, no approvals, no ledger.
  const taken = importsOf(UI_CHANNEL).filter((file) => file.startsWith("src/apply/")).sort();
  assert.deepEqual(taken, ["src/apply/channel.ts", "src/apply/cleanup-proposal.ts", "src/apply/constants.ts", "src/apply/contract.ts", "src/apply/seal.ts", "src/apply/types.ts"]);
  // Outside src/apply, exactly these modules import it: the two CLI doors and the release-admission checks that read the same pin.
  const outside = sources.filter((file) => !file.startsWith("src/apply/") && importsOf(file).some((dep) => dep.startsWith("src/apply/"))).sort();
  assert.deepEqual(outside, ["src/cli/apply.ts", "src/cli/release-admission.ts", "src/cli/ui-channel.ts", "src/qualification/release-admission.ts", "src/tools/profiles.ts"]
    .filter((file) => outside.includes(file)));
  assert.ok(outside.includes(UI_CHANNEL) && outside.includes("src/cli/apply.ts"));
  assert.deepEqual(outside.filter((file) => file.startsWith("src/operator-ui/")), [], "no console module imports src/apply directly");
});

test("negative: the agent-facing directories still cannot import the adapter, the CLI door or the driver, by any path", () => {
  for (const directory of ["src/tools", "src/agent", "src/orchestration", "src/a2a", "src/delegation", "src/operations"]) {
    for (const file of walk(directory)) {
      const forbidden = importsOf(file).filter((dep) => isApplyPath(dep) || dep === UI_CHANNEL || dep === CONSOLE_SERVER || dep === "src/cli/teardown-driver.ts");
      assert.deepEqual(forbidden, [], file);
    }
  }
});

test("only the human CLI imports the driver, and it calls runApply in exactly one place", () => {
  const sources = walk("src");
  const importers = sources.filter((file) => importsOf(file).includes("src/apply/driver.ts")).sort();
  assert.deepEqual(importers, ["src/cli/apply.ts"]);
  const callers = sources.filter((file) => !file.startsWith("src/apply/") && /\brunApply\s*\(/.test(readFileSync(file, "utf8")));
  assert.deepEqual(callers, ["src/cli/apply.ts"]);
  // The console adapter runs the same commands, through the CLI's own entry, and nothing else does.
  const commandCallers = sources.filter((file) => /\brunApplyCommand\s*\(/.test(readFileSync(file, "utf8")));
  assert.deepEqual(commandCallers, ["src/cli/apply.ts", UI_CHANNEL]);
  assert.equal([...readFileSync("src/cli/apply.ts", "utf8").matchAll(/\brunApply\s*\(/g)].length, 1, "one call site");
  // The operator dispatcher reaches it as a child process, never by import.
  assert.ok(!importsOf("src/cli/operator.ts").includes("src/cli/apply.ts"));
});

test("the console job table has no apply script, and the catalog validator refuses one", () => {
  for (const spec of OPERATIONS) {
    if (spec.job) assert.doesNotMatch(spec.job.script, /apply/, spec.id);
    assert.doesNotMatch(spec.cliScript && spec.safety !== "HANDOFF" ? spec.cliScript : "", /apply/, spec.id);
  }
  const probe: OperationSpec = {
    id: "probe", title: "Probe", summary: "A probe.", family: "governance", cli: "./alz probe", safety: "READ_ONLY",
    inputs: [], evidenceBasis: "FIXTURE", job: { script: "cli/health.js", args: () => [] },
  };
  assert.deepEqual(validateCatalog([probe]), []);
  assert.match(validateCatalog([{ ...probe, job: { script: "cli/apply.js", args: () => [] } }]).join(), /may not be run by the console/);
});

test("the apply command is a handoff: the console shows the command and its reason and never runs it", () => {
  const specs = OPERATIONS.filter((spec) => spec.cliScript === "src/cli/apply.ts");
  assert.equal(specs.length, 1);
  const [spec] = specs;
  assert.equal(spec.safety, "HANDOFF");
  assert.equal(spec.job, undefined);
  assert.match(spec.handoff!.reason, /terminal/);
  assert.match(spec.handoff!.reason, /wizard/, "and it points at the guided wizard, which is the other way to run it");
  assert.match(spec.handoff!.reason, /approver/i);
  assert.match(spec.handoff!.command, /^\.\/alz apply /);
  // Names only: the console never holds a value, and all four identities are listed.
  for (const identity of ["DISCOVERY", "STATE", "STATE_WRITE", "APPLY"]) {
    assert.ok(spec.handoff!.env!.some((name) => name.startsWith("ALZ_" + identity + "_ARM_")), identity);
  }
  assert.ok(spec.handoff!.env!.every((name) => /^[A-Z][A-Z0-9_]*$/.test(name)));
});

test("-auto-approve appears nowhere in src; the apply path carries no -target, -replace, -refresh=false or -lock=false, and the cleanup adapter's targeting is the one exception", () => {
  for (const file of walk("src")) assert.doesNotMatch(readFileSync(file, "utf8"), /-auto-approve/, file);
  // Existing plan-only flows may use -refresh=false; the apply path never does, and locking stays on. The cleanup adapter
  // (src/apply/terraform.ts) is the one place that builds `-target=`: a destroy limited to the addresses of an approved cleanup
  // proposal (docs/act-pilot-plan.md, "Cleanup of pilot-created resources"), which the driver compares with the plan before
  // any approval is consumed. The apply argument lists themselves still carry no targeting.
  for (const file of [...walk("src/apply"), "src/cli/apply.ts"]) {
    const text = readFileSync(file, "utf8");
    assert.doesNotMatch(text, /["'`]-(replace|refresh=false|lock=false|lock-timeout)\b/, file);
    if (file === "src/apply/terraform.ts") {
      const targets = [...text.matchAll(/["'`]-target\b[^"'`]*["'`]/g)].map((m) => m[0]);
      assert.deepEqual(targets, ['"-target="'], "one targeting flag, in the cleanup adapter's own builder");
      assert.doesNotMatch(text, /APPLY_ARGV[^;]*-target/, "the apply list never targets");
    } else {
      assert.doesNotMatch(text, /["'`]-target\b/, file);
    }
  }
});
