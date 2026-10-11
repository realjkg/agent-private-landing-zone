import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

import { createChangeSet } from "../src/iac/changeset.js";
import { normalizeTerraformPlan } from "../src/iac/terraform-plan.js";
import { OPERATIONS } from "../src/operations/registry.js";
import { teardownOperations } from "../src/operations/families/teardown.js";
import { planOperation, runPlanned } from "../src/operations/run.js";
import { fillCommand, validateInputs } from "../src/operations/schema.js";
import type { OperatorJob } from "../src/operations/types.js";
import { evidenceAuthorityProblems, evidenceProblems } from "../src/teardown/driver/evidence.js";
import { recordDeletionUnit } from "../src/teardown/unit.js";
import type { DeletionUnit } from "../src/teardown/types.js";

// Drives each teardown entry through the path the server uses: planOperation
// (validation) then runPlanned (private files, argument building, forbidden-word
// check). Fast offline entries also run for real, with the compiled script
// replaced by its TypeScript source.

const spec = (id: string) => teardownOperations.find((item) => item.id === id)!;
const runnable = teardownOperations.filter((item) => item.safety !== "HANDOFF");
const handoffs = teardownOperations.filter((item) => item.safety === "HANDOFF");

const STATE = { engine: "TERRAFORM", backend: "s3", location: "s3://alz-state/b/terraform.tfstate", workspace: "default" };
const planWith = (tags: object, ...changes: [string, string[]][]) => JSON.stringify({
  format_version: "1.2",
  resource_changes: changes.map(([address, actions]) => ({
    address, type: "aws_cloudwatch_log_group", change: { actions, after: { tags_all: tags }, after_unknown: {} },
  })),
});
const plan = (...changes: [string, string[]][]) => planWith({}, ...changes);
const unit: DeletionUnit = recordDeletionUnit({
  buildId: "build-1", provider: "AWS", stateRef: STATE as never, designHash: "d".repeat(64),
  createPlan: normalizeTerraformPlan(plan(["aws_cloudwatch_log_group.a", ["create"]])),
});
const tagged = (...changes: [string, string[]][]) => planWith(unit.tags, ...changes);
const text = (value: unknown) => JSON.stringify(value);
const evidence = (extra: object = {}) => ({
  schemaVersion: 1, operation: "DESTROY_PREVIEW", engine: "TERRAFORM", mode: "PROJECT",
  adapter: { engine: "TERRAFORM", adapterVersion: "1", argvDigest: "a".repeat(64) },
  toolVersions: { engine: "1.9.0", adapter: "1" },
  changes: createChangeSet("TERRAFORM", [{ address: "aws_cloudwatch_log_group.a", type: "aws_cloudwatch_log_group", operation: "DELETE" }]),
  hashes: { manifestHash: "m".repeat(8), unitHash: unit.unitHash, changeSetHash: "c".repeat(8) },
  stateVersion: { kind: "TERRAFORM_SERIAL", value: "7", observedAt: "2026-10-10T00:00:00.000Z" },
  label: "ARTIFACT_VALIDATED_DESTROY_PREVIEW", verdict: "READY",
  target: { account: "123456789012", backend: "s3", workspace: "default" }, policyVersion: "1",
  invokedBy: { operatorId: "ops", confirmedAt: "2026-10-10T00:00:00.000Z" },
  startedAt: "2026-10-10T00:00:00.000Z", finishedAt: "2026-10-10T00:00:01.000Z",
  authority: { infrastructureAct: "DISABLED", mutation: "NONE", executionMode: "PREVIEW_ONLY", agentInitiated: false },
  ...extra,
});

async function jobFor(id: string, inputs: object): Promise<OperatorJob> {
  let captured: OperatorJob | undefined;
  await runPlanned(planOperation(id, text(inputs), OPERATIONS), "/repo", async (job) => {
    captured = job;
    return "ok";
  });
  return captured!;
}

/** Runs the real script from source: stdout and exit code, the way the server's worker would see them. */
async function execute(id: string, inputs: object): Promise<{ code: number | null; out: string }> {
  let result = { code: -1 as number | null, out: "" };
  await runPlanned(planOperation(id, text(inputs), OPERATIONS), process.cwd(), async (job) => {
    const run = spawnSync(process.execPath, ["--import", "tsx", resolve("src", job.script.replace(/\.js$/, ".ts")), ...job.args], { encoding: "utf8" });
    result = { code: run.status, out: run.stdout + run.stderr };
    return run.stdout;
  });
  return result;
}

const refusal = (id: string, inputs: unknown): string => {
  try {
    planOperation(id, text(inputs), OPERATIONS);
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error("expected a refusal for " + id);
};

const orphanInputs = { unit: text(unit), source: "resources", inventory: text([]) };

const given: Record<string, object> = {
  "teardown-record": { buildId: "build-1", provider: "AWS", engine: "TERRAFORM", state: text(STATE), designHash: "d".repeat(64), plan: plan() },
  "teardown-check-plan": { unit: text(unit), plan: plan() },
  "teardown-destroy-preview": { unit: text(unit), plan: plan() },
  "teardown-orphans": orphanInputs,
  "teardown-evidence": { evidence: text(evidence()) },
};

test("the family is registered once, with honest safety classes", () => {
  assert.deepEqual(runnable.map((item) => [item.id, item.safety]), [
    ["teardown-record", "READ_ONLY"], ["teardown-check-plan", "READ_ONLY"], ["teardown-destroy-preview", "READ_ONLY"],
    ["teardown-orphans", "READ_ONLY"], ["teardown-evidence", "READ_ONLY"],
  ]);
  assert.deepEqual(handoffs.map((item) => item.id), ["teardown-destroy-preview-run", "teardown-preview-run"]);
  for (const item of teardownOperations) assert.equal(OPERATIONS.filter((other) => other.id === item.id).length, 1);
});

test("every runnable entry builds a job for a script with a source file, and none takes a path or credential", async () => {
  for (const item of runnable) {
    const job = await jobFor(item.id, given[item.id]);
    assert.ok(existsSync(resolve("src", job.script.replace(/\.js$/, ".ts"))), item.id);
    assert.doesNotMatch(job.args.join(" "), /destroy|preview-only|apply|auto-approve/i, item.id);
    assert.ok(!job.script.includes("teardown-driver"));
    assert.ok(!item.inputs.some((field) => field.kind === "text" && /path|file|script|command|token|key|secret/i.test(field.name)), item.id);
    // Every json field arrived as a server-written file path, never as the pasted text.
    for (const field of item.inputs.filter((f) => f.kind === "json")) assert.ok(!job.args.some((arg) => arg.includes("{")), field.name);
  }
});

test("record builds the documented argument list, with optional expiry", async () => {
  const inputs = { buildId: "build-1", provider: "AZURE", engine: "PULUMI", state: text(STATE), designHash: "d".repeat(64), plan: plan() };
  const args = (await jobFor("teardown-record", inputs)).args;
  assert.deepEqual(args.filter((arg) => arg.startsWith("--")), ["--build-id", "--provider", "--engine", "--state", "--design-hash", "--plan"]);
  assert.deepEqual(args.slice(0, 6), ["record", "--build-id", "build-1", "--provider", "AZURE", "--engine"]);
  const dated = (await jobFor("teardown-record", { ...inputs, expires: "2027-01-31" })).args;
  assert.deepEqual(dated.slice(-2), ["--expires", "2027-01-31"]);
});

test("check-plan and orphans map their options to the CLI flags", async () => {
  assert.deepEqual((await jobFor("teardown-check-plan", { unit: text(unit), plan: plan(), untaggableTypes: "a:b,C" })).args.filter((a) => a.startsWith("--") || a === "a:b,C"),
    ["--unit", "--plan", "--untaggable-types", "a:b,C"]);
  const two = (await jobFor("teardown-orphans", { ...orphanInputs, otherUnit: text(unit), source: "aws-tagged" })).args;
  assert.equal(two[0], "orphans");
  assert.equal(two[2].split(",").length, 2);
  assert.equal(two[3], "--aws-tagged");
  assert.equal((await jobFor("teardown-orphans", orphanInputs)).args[2].split(",").length, 1);
});

test("record, check-plan, destroy-preview and orphans really run over pasted JSON", async () => {
  const created = await execute("teardown-record", { buildId: "build-1", provider: "AWS", engine: "TERRAFORM", state: text(STATE), designHash: "d".repeat(64), plan: plan(["aws_cloudwatch_log_group.a", ["create"]]) });
  assert.equal(created.code, 0, created.out);
  assert.match(created.out, /"plannedCreates"/);
  const checked = await execute("teardown-check-plan", { unit: text(unit), plan: tagged(["aws_cloudwatch_log_group.a", ["create"]]) });
  assert.equal(checked.code, 0);
  assert.match(checked.out, /TRACEABLE/);
  const extra = await execute("teardown-check-plan", { unit: text(unit), plan: tagged(["aws_cloudwatch_log_group.a", ["create"]], ["aws_cloudwatch_log_group.b", ["create"]]) });
  assert.equal(extra.code, 2);
  const ready = await execute("teardown-destroy-preview", { unit: text(unit), plan: plan(["aws_cloudwatch_log_group.a", ["delete"]]) });
  assert.equal(ready.code, 0, ready.out);
  const blocked = await execute("teardown-destroy-preview", { unit: text(unit), plan: plan(["aws_cloudwatch_log_group.a", ["delete"]], ["aws_s3_bucket.customer", ["delete"]]) });
  assert.equal(blocked.code, 2);
  assert.match(blocked.out, /BLOCKED/);
  const clean = await execute("teardown-orphans", orphanInputs);
  assert.equal(clean.code, 0);
  const orphan = await execute("teardown-orphans", { ...orphanInputs, inventory: text([{
    resourceId: "x", provider: "AWS", resourceType: "t", name: "x", ownership: "MANAGED_BY_CUSTOMER", mutationPolicy: "READ_ONLY",
    sourceOfTruth: "UNKNOWN", tags: { "alz-managed-by": "alz" } }]) });
  assert.equal(orphan.code, 2);
  assert.match(orphan.out, /ORPHAN_UNATTRIBUTED/);
});

test("the evidence viewer prints clean evidence and rejects raw plan or state content", async () => {
  const good = await execute("teardown-evidence", { evidence: text(evidence()) });
  assert.equal(good.code, 0);
  assert.match(good.out, /"infrastructureAct": "DISABLED"/);
  const raw = await execute("teardown-evidence", { evidence: text({ ...evidence(), resource_changes: [{ change: { after: { password: "hunter2-canary" } } }] }) });
  assert.equal(raw.code, 2);
  assert.match(raw.out, /EVIDENCE REJECTED/);
  assert.match(raw.out, /raw plan or state field/);
  assert.doesNotMatch(raw.out, /hunter2-canary/);
  const embedded = await execute("teardown-evidence", { evidence: text(evidence({ policyVersion: JSON.stringify({ secret: "hunter2-canary" }) })) });
  assert.equal(embedded.code, 2);
  assert.doesNotMatch(embedded.out, /hunter2-canary/);
  assert.equal((await execute("teardown-evidence", { evidence: text({ resource_changes: [] }) })).code, 2);
  assert.equal((await execute("teardown-evidence", { evidence: text([1]) })).code, 2);
});

test("the evidence viewer requires every field, the driver's authority statement and a valid operation", async () => {
  const rejected = async (document: unknown, expected: RegExp) => {
    const result = await execute("teardown-evidence", { evidence: text(document) });
    assert.equal(result.code, 2, result.out);
    assert.match(result.out, /EVIDENCE REJECTED/);
    assert.match(result.out, expected);
    assert.doesNotMatch(result.out, /PREVIEW ONLY, ACT DISABLED/);
  };
  const { authority: _authority, ...withoutAuthority } = evidence();
  await rejected(withoutAuthority, /evidence\.authority: missing/);
  const { hashes: _hashes, target: _target, ...partial } = evidence();
  await rejected(partial, /hashes: missing[\s\S]*target: missing/);
  await rejected(evidence({ authority: { infrastructureAct: "ENABLED", mutation: "NONE", executionMode: "PREVIEW_ONLY", agentInitiated: false } }), /authority: does not match/);
  await rejected(evidence({ authority: { infrastructureAct: "DISABLED", mutation: "NONE", executionMode: "PREVIEW_ONLY", agentInitiated: true } }), /authority: does not match/);
  await rejected(evidence({ operation: "DESTROY" }), /operation: expected PREVIEW or DESTROY_PREVIEW/);
  await rejected(evidence({ schemaVersion: 2 }), /schemaVersion: expected 1/);
  // A prototype key is not part of the closed shape, even though `key in shape` is true for it.
  const withPrototypeKey = JSON.parse(text(evidence()).replace(/^\{/, '{"constructor":1,')) as object;
  await rejected(withPrototypeKey, /evidence\.constructor: not part of the evidence shape/);
  // Both driver operations are accepted when the rest is intact.
  assert.equal((await execute("teardown-evidence", { evidence: text(evidence({ operation: "PREVIEW" })) })).code, 0);
});

test("evidenceProblems checks own keys only, so prototype names never pass", () => {
  for (const key of ["constructor", "toString", "hasOwnProperty", "__proto__"]) {
    const document = JSON.parse(text(evidence()).replace(/^\{/, "{" + JSON.stringify(key) + ":1,")) as object;
    assert.match(evidenceProblems(document).join(), /not part of the evidence shape/, key);
  }
  assert.deepEqual(evidenceProblems(evidence()), []);
  assert.deepEqual(evidenceAuthorityProblems(evidence()), []);
});

test("every input refusal holds for each runnable entry", () => {
  for (const item of runnable) {
    assert.equal(refusal(item.id, { extra: 1 }), "INPUT_UNKNOWN_FIELD", item.id);
    assert.equal(refusal(item.id, []), "INPUTS_NOT_OBJECT", item.id);
    assert.throws(() => planOperation(item.id, "{nope", OPERATIONS), /INPUTS_NOT_JSON/);
    for (const field of item.inputs) {
      const bad = (value: unknown) => refusal(item.id, { ...given[item.id], [field.name]: value });
      if (field.kind === "json") {
        assert.equal(bad("{nope"), "INPUT_JSON_INVALID:" + field.name);
        assert.equal(bad(" ".repeat(field.maxBytes) + "1"), "INPUT_TOO_LARGE:" + field.name);
        assert.equal(bad(5), "INPUT_TYPE:" + field.name);
      } else if (field.kind === "enum") {
        assert.equal(bad("gcp"), "INPUT_ENUM:" + field.name);
      } else if (field.kind === "text") {
        assert.equal(bad("--unit"), "INPUT_CHARACTERS:" + field.name);
        assert.equal(bad("x".repeat(field.maxLength + 1)), "INPUT_TOO_LONG:" + field.name);
        assert.equal(bad("a b;`"), "INPUT_PATTERN:" + field.name);
      }
    }
  }
  assert.equal(refusal("teardown-record", {}), "INPUT_REQUIRED:buildId");
  assert.equal(refusal("teardown-record", { buildId: "Build_UPPER" }), "INPUT_PATTERN:buildId");
  assert.equal(refusal("teardown-record", { ...given["teardown-record"], engine: "CROSSPLANE" }), "INPUT_ENUM:engine");
  assert.equal(refusal("teardown-record", { ...given["teardown-record"], designHash: "abc" }), "INPUT_PATTERN:designHash");
  assert.equal(refusal("teardown-orphans", { ...orphanInputs, source: "../etc" }), "INPUT_ENUM:source");
  assert.equal(refusal("teardown-check-plan", { unit: "{}" }), "INPUT_REQUIRED:plan");
});

test("a failing script exits non-zero with a stable code and no pasted content", async () => {
  const bad = await execute("teardown-destroy-preview", { unit: text({ engine: "CROSSPLANE" }), plan: text({ secret: "hunter2-canary" }) });
  assert.equal(bad.code, 1);
  assert.doesNotMatch(bad.out, /hunter2-canary/);
});

test("driver commands are handoffs: never run, exact command, names-only environment, evidence viewer", () => {
  for (const item of handoffs) {
    assert.throws(() => planOperation(item.id, null, OPERATIONS), /OPERATION_HANDOFF_ONLY/, item.id);
    assert.ok(!item.job);
    assert.match(item.handoff!.reason, /terminal/);
    assert.match(item.handoff!.reason, /ALZ_DISCOVERY_ and ALZ_STATE_/);
    assert.match(item.handoff!.reason, /qualification record/);
    assert.equal(item.handoff!.viewer, "teardown-evidence");
    assert.equal(spec("teardown-evidence").safety, "READ_ONLY");
    assert.ok(item.handoff!.env!.every((name) => /^ALZ_(DISCOVERY|STATE)_[A-Z0-9_]+$/.test(name)));
    assert.ok(item.handoff!.env!.some((name) => name.startsWith("ALZ_DISCOVERY_")) && item.handoff!.env!.some((name) => name.startsWith("ALZ_STATE_")));
    const filled = validateInputs(item.inputs, { request: "r.json", manifest: "m.json", unit: "u.json", qualifications: "q.json" });
    assert.ok(filled.ok);
    assert.equal(fillCommand(item.handoff!.command, item.inputs, filled.values),
      "./alz teardown " + item.cli.split(" ").pop() + " --request r.json --manifest m.json --unit u.json --qualifications q.json");
    // The form only fills in text; hostile values are refused before they reach the command.
    assert.equal(validateInputs(item.inputs, { request: "r.json; rm -rf /", manifest: "m", unit: "u", qualifications: "q" }).ok, false);
    assert.equal(validateInputs(item.inputs, { request: "--force", manifest: "m", unit: "u", qualifications: "q" }).ok, false);
    assert.equal(validateInputs(item.inputs, { request: "r" }).ok, false);
  }
});

test("the console never imports or spawns the destroy-preview driver", () => {
  for (const file of ["src/operations/families/teardown.ts", ...readdirSync("src/operations").map((name) => "src/operations/" + name).filter((n) => n.endsWith(".ts"))]) {
    assert.doesNotMatch(readFileSync(file, "utf8"), /teardown\/driver|teardown-driver\.js/, file);
  }
  for (const item of runnable) assert.doesNotMatch(item.job!.script, /driver/);
  // The viewer script uses only the pure evidence validator, never the runner or an adapter.
  const imports = readFileSync("src/cli/teardown-review.ts", "utf8").match(/from "[^"]*teardown\/driver[^"]*"/g);
  assert.deepEqual(imports, ['from "../teardown/driver/evidence.js"']);
});
