import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

import { qualificationOperations } from "../src/operations/families/qualification.js";
import { OPERATIONS } from "../src/operations/registry.js";
import { planOperation, runPlanned } from "../src/operations/run.js";
import { fillCommand, validateInputs } from "../src/operations/schema.js";
import type { OperatorJob } from "../src/operations/types.js";

// Drives each qualification entry through the path the server uses:
// planOperation (validation) then runPlanned (argument building, the private
// directory for pasted JSON and the forbidden-word check) with a fake runner.

const spec = (id: string) => qualificationOperations.find((item) => item.id === id)!;
const runnable = qualificationOperations.filter((item) => item.safety !== "HANDOFF");
const handoffs = qualificationOperations.filter((item) => item.safety === "HANDOFF");
const MANIFEST = JSON.stringify({ candidate: "x" });

async function jobFor(id: string, inputs: object = {}): Promise<OperatorJob & { pasted?: string }> {
  let captured: (OperatorJob & { pasted?: string }) | undefined;
  await runPlanned(planOperation(id, JSON.stringify(inputs), OPERATIONS), "/repo", async (job) => {
    captured = job;
    if (job.args[0] === "--manifest") {
      // The file exists only while the run is in flight, and holds the pasted text.
      const { readFileSync, statSync } = await import("node:fs");
      captured = { ...job, pasted: readFileSync(job.args[1], "utf8") };
      assert.equal(statSync(resolve(job.args[1], "..")).mode & 0o777, 0o700);
    }
    return "ok";
  });
  return captured!;
}

const refusal = (id: string, inputs: unknown): string => {
  try {
    planOperation(id, JSON.stringify(inputs), OPERATIONS);
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error("expected a refusal for " + id);
};

test("the family is registered once, with the safety classes it claims", () => {
  assert.deepEqual(runnable.map((item) => [item.id, item.safety]), [
    ["full-offline-matrix", "WRITES_LOCAL"], ["prelive-campaign", "WRITES_LOCAL"], ["pulumi-permutations", "WRITES_LOCAL"],
    ["private-security-redteam", "WRITES_LOCAL"], ["opa-qualification", "SYNTHETIC"], ["release-admission", "WRITES_LOCAL"],
    ["release-verify", "READ_ONLY"],
  ]);
  assert.deepEqual(handoffs.map((item) => item.id), [
    "release-package", "provider-qualification-aws", "provider-qualification-azure", "private-model-adversarial",
  ]);
  for (const item of qualificationOperations) {
    assert.equal(OPERATIONS.filter((other) => other.id === item.id).length, 1);
    assert.equal(item.family, "qualification");
    assert.equal(item.command?.group, "qualify");
    assert.ok(existsSync(item.cliScript!), item.id);
  }
});

test("every runnable entry builds a fixed job for a compiled script that has a source file", async () => {
  const expected: Record<string, string[]> = {
    "full-offline-matrix": [], "prelive-campaign": [], "pulumi-permutations": [], "private-security-redteam": [],
    "opa-qualification": [], "release-verify": ["--verify"],
  };
  for (const item of runnable.filter((other) => other.id !== "release-admission")) {
    const job = await jobFor(item.id, {});
    assert.equal(job.mode, item.id);
    assert.equal(job.script, "cli/" + item.cliScript!.slice(8).replace(/\.ts$/, ".js"));
    assert.ok(existsSync(resolve("src", job.script.replace(/\.js$/, ".ts"))), item.id);
    assert.deepEqual(job.args, expected[item.id], item.id);
    assert.match(job.evidenceBasis, /\S/);
  }
});

test("release admission receives only the path of a server-written private copy of the pasted JSON", async () => {
  const job = await jobFor("release-admission", { manifest: MANIFEST });
  assert.equal(job.script, "cli/release-admission.js");
  assert.deepEqual(job.args.slice(0, 1), ["--manifest"]);
  assert.equal(job.args.length, 2);
  assert.match(job.args[1], /manifest\.json$/);
  assert.doesNotMatch(job.args.join(" "), /candidate/);
  assert.deepEqual(JSON.parse(job.pasted!), { candidate: "x" });
  assert.equal(existsSync(job.args[1]), false, "the copy is removed after the run");
  assert.equal(refusal("release-admission", {}), "INPUT_REQUIRED:manifest");
  assert.equal(refusal("release-admission", { manifest: "{nope" }), "INPUT_JSON_INVALID:manifest");
  assert.equal(refusal("release-admission", { manifest: " ".repeat(64 * 1024) + "{}" }), "INPUT_TOO_LARGE:manifest");
  assert.equal(refusal("release-admission", { manifest: 7 }), "INPUT_TYPE:manifest");
});

test("every input refusal holds for each runnable entry", () => {
  for (const item of runnable) {
    assert.equal(refusal(item.id, { extra: 1 }), "INPUT_UNKNOWN_FIELD", item.id);
    assert.equal(refusal(item.id, []), "INPUTS_NOT_OBJECT", item.id);
    assert.throws(() => planOperation(item.id, "{nope", OPERATIONS), /INPUTS_NOT_JSON/);
  }
  // Nothing the browser can supply names a script, a path, a command or a credential.
  for (const item of qualificationOperations) {
    assert.ok(!item.inputs.some((field) => /path|file|script|command|token|key|credential|secret|root|output/i.test(field.name)), item.id);
  }
});

test("handoff entries are never run, and fill an exact command with names-only environment", () => {
  const fill = (id: string, raw: object) => {
    const item = spec(id);
    const checked = validateInputs(item.inputs, raw);
    assert.ok(checked.ok, id);
    return fillCommand(item.handoff!.command, item.inputs, checked.values);
  };
  for (const item of handoffs) {
    assert.throws(() => planOperation(item.id, null, OPERATIONS), /OPERATION_HANDOFF_ONLY/, item.id);
    assert.ok(item.handoff!.reason.length > 40 && !item.job, item.id);
    for (const name of item.handoff!.env ?? []) assert.match(name, /^[A-Z][A-Z0-9_]*$/);
    assert.doesNotMatch(item.handoff!.command, /destroy|preview-only|--apply|auto-approve/i, item.id);
  }
  assert.equal(fill("release-package", { version: "1.2.3", sourceCommit: "6fed61a" }),
    "./alz qualify package --root <staged-release-root> --version 1.2.3 --source-commit 6fed61a");
  assert.equal(fill("provider-qualification-aws", { sourceCommit: "6fed61a", stack: "alz-noop" }),
    "./alz qualify provider-aws --provider AWS --source-commit 6fed61a --aws-stack alz-noop --aws-template qualification/provider/aws-noop-stack.yaml --output .runs/qualification/provider-aws.json");
  assert.match(fill("provider-qualification-azure", { sourceCommit: "6fed61a", location: "westeurope" }),
    /--azure-scope subscription --azure-location westeurope --output/);
  assert.equal(fill("private-model-adversarial", { scope: "all" }), "./alz qualify adversarial --scope all");
  assert.equal(fill("private-model-adversarial", {}), "./alz qualify adversarial --scope first");
  assert.deepEqual(spec("private-model-adversarial").handoff!.env, ["ALZ_TARGET_HARDWARE_ID", "RUNNER_NAME", "OLLAMA_BASE_URL"]);
  assert.match(spec("provider-qualification-aws").handoff!.reason, /release gate/);
  assert.match(spec("private-model-adversarial").handoff!.reason, /release gate/);
  // Handoff inputs are validated when the card is filled, so a bad value never reaches the command.
  const bad = (id: string, raw: object) => validateInputs(spec(id).inputs, raw).ok;
  assert.equal(bad("release-package", { version: "1.0; rm -rf /", sourceCommit: "6fed61a" }), false);
  assert.equal(bad("release-package", { version: "1.0.0", sourceCommit: "--force" }), false);
  assert.equal(bad("provider-qualification-aws", { sourceCommit: "6fed61a", stack: "$(id)" }), false);
  assert.equal(bad("provider-qualification-azure", { sourceCommit: "6fed61a", location: "west europe" }), false);
  assert.equal(bad("private-model-adversarial", { scope: "everything" }), false);
  assert.equal(bad("release-package", { version: "1.0.0", sourceCommit: "main" }), false);
  assert.equal(bad("release-package", {}), false);
  assert.equal(spec("release-package").handoff!.viewer, "release-verify");
});

test("the console never opens a terminal-only or credentialed path", () => {
  for (const item of runnable) {
    assert.ok(["READ_ONLY", "SYNTHETIC", "WRITES_LOCAL"].includes(item.safety), item.id);
    assert.doesNotMatch(item.job!.script, /provider-qualification|private-model-adversarial|teardown-driver/);
  }
});

test("each script the family fronts is offline and answers --help without side effects", { timeout: 60000 }, () => {
  const scripts = ["full-offline-matrix", "prelive-campaign", "pulumi-permutations", "private-security-redteam",
    "release-admission", "private-model-adversarial"];
  for (const name of scripts) {
    const result = spawnSync(process.execPath, ["--import", "tsx", "src/cli/" + name + ".ts", "--help"], { encoding: "utf8" });
    assert.equal(result.status, 0, name + " " + result.stderr);
    assert.match(result.stdout, /\S/);
  }
  assert.ok(!readdirSync(".").includes("release-manifest.json"));
});

test("release-verify fails closed in a source checkout", () => {
  // release-verify in a source checkout has no manifest; the failure is a clear nonzero exit, not a pass.
  const result = spawnSync(process.execPath, ["--import", "tsx", "src/cli/release-package.ts", "--verify"], { encoding: "utf8" });
  if (!existsSync("release-manifest.json")) assert.equal(result.status, 1);
});
