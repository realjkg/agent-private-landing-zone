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
function reachableFrom(roots: string[]): Set<string> {
  const seen = new Set<string>(roots);
  const queue = [...roots];
  while (queue.length > 0) {
    for (const next of importsOf(queue.pop()!)) if (!seen.has(next)) { seen.add(next); queue.push(next); }
  }
  return seen;
}

test("nothing the broker, agents, orchestration, the console or the catalog can reach imports the apply path", () => {
  const roots = ["src/tools", "src/operator-ui", "src/agent", "src/orchestration", "src/a2a", "src/delegation", "src/operations"].flatMap(walk);
  assert.ok(roots.length > 50, "the walk found the agent-facing modules");
  const reached = reachableFrom(roots);
  const apply = [...reached].filter((file) => file.startsWith("src/apply/") || file === "src/cli/apply.ts");
  assert.deepEqual(apply, [], "an agent-facing module reaches the apply path");
});

test("only the human CLI imports the driver, and it calls runApply in exactly one place", () => {
  const sources = walk("src");
  const importers = sources.filter((file) => importsOf(file).includes("src/apply/driver.ts")).sort();
  assert.deepEqual(importers, ["src/cli/apply.ts"]);
  const callers = sources.filter((file) => !file.startsWith("src/apply/") && /\brunApply\s*\(/.test(readFileSync(file, "utf8")));
  assert.deepEqual(callers, ["src/cli/apply.ts"]);
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
  assert.match(spec.handoff!.reason, /approver/i);
  assert.match(spec.handoff!.command, /^\.\/alz apply /);
  // Names only: the console never holds a value, and all four identities are listed.
  for (const identity of ["DISCOVERY", "STATE", "STATE_WRITE", "APPLY"]) {
    assert.ok(spec.handoff!.env!.some((name) => name.startsWith("ALZ_" + identity + "_ARM_")), identity);
  }
  assert.ok(spec.handoff!.env!.every((name) => /^[A-Z][A-Z0-9_]*$/.test(name)));
});

test("-auto-approve appears nowhere in src, and the apply path carries no -target, -replace, -refresh=false or -lock=false", () => {
  for (const file of walk("src")) assert.doesNotMatch(readFileSync(file, "utf8"), /-auto-approve/, file);
  // Existing plan-only flows may use -refresh=false; the apply path never does, and locking stays on.
  for (const file of [...walk("src/apply"), "src/cli/apply.ts"]) {
    assert.doesNotMatch(readFileSync(file, "utf8"), /["'`]-(target|replace|refresh=false|lock=false|lock-timeout)\b/, file);
  }
});
