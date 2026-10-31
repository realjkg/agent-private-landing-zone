import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname } from "node:path";
import test from "node:test";

import { governanceOperations } from "../src/operations/families/governance.js";
import { planOperation, runPlanned } from "../src/operations/run.js";
import { assertSafeArgv, fillCommand, sampleArgvs, validateInputs } from "../src/operations/schema.js";
import type { OperatorJob } from "../src/operations/types.js";
import { recoveryIntentFromAnswers } from "../src/recovery/profile/operator.js";

const catalog = governanceOperations;
const byId = (id: string) => catalog.find((spec) => spec.id === id)!;
const read = (path: string) => readFileSync(path, "utf8");

/** A fake runner: records the job and what the job could read at that moment. */
async function capture(id: string, inputs: unknown) {
  const seen: { job?: OperatorJob; file?: string; mode?: number; directoryMode?: number } = {};
  await runPlanned(planOperation(id, JSON.stringify(inputs), catalog), ".", async (job) => {
    seen.job = job;
    const path = job.args.find((arg) => arg.endsWith(".json"));
    if (path) {
      seen.file = read(path);
      seen.mode = statSync(path).mode & 0o777;
      seen.directoryMode = statSync(dirname(path)).mode & 0o777;
      seen.job = { ...job, args: job.args.map((arg) => (arg === path ? "<file>" : arg)) };
      assert.ok(!path.startsWith(process.cwd()), "pasted JSON must not land in the repository");
    }
    return "";
  });
  return seen;
}

/** Runs the real script (tsx) the way the server would run the compiled one. */
function runReal(job: OperatorJob) {
  const result = spawnSync(process.execPath, ["--import", "tsx", "src/" + job.script.replace(/\.js$/, ".ts"), ...job.args],
    { encoding: "utf8", env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR } });
  return { status: result.status, out: result.stdout + result.stderr };
}
const realRunner = (log: { status: number | null; out: string }[]) => async (job: OperatorJob) => {
  log.push(runReal(job));
  return "";
};
async function execute(id: string, inputs: unknown) {
  const log: { status: number | null; out: string }[] = [];
  await runPlanned(planOperation(id, JSON.stringify(inputs), catalog), ".", realRunner(log));
  return log[0];
}

const intent = recoveryIntentFromAnswers(["aws-platform-primary", "platform-operations", "aws", "o-example", "enterprise",
  "production", "critical"], ["SOC2@1"]);
const targets = read("config/recovery-targets.example.json");
const economics = read("config/economics.example.json");

test("the family is well formed: runnable entries are read-only or local-model, the rest are handoffs", () => {
  assert.ok(catalog.length >= 20);
  for (const spec of catalog) {
    assert.equal(spec.family, "governance");
    if (spec.safety === "HANDOFF") {
      assert.equal(spec.job, undefined, spec.id);
      assert.throws(() => planOperation(spec.id, null, catalog), /OPERATION_HANDOFF_ONLY/);
    } else {
      assert.ok(["READ_ONLY", "LOCAL_MODEL"].includes(spec.safety), spec.id);
      assert.ok(existsSync("src/" + spec.job!.script.replace(/\.js$/, ".ts")), spec.id);
    }
    for (const field of spec.inputs) assert.doesNotMatch(field.name, /token|secret|password|credential|apikey/i, spec.id);
    for (const args of sampleArgvs(spec)) assert.doesNotThrow(() => assertSafeArgv(args));
  }
  const handoffs = catalog.filter((spec) => spec.safety === "HANDOFF").map((spec) => spec.id).sort();
  assert.deepEqual(handoffs, ["act-pilot-apply", "control-plane-capture", "control-plane-drill", "control-plane-restore", "control-plane-verify",
    "cost-status", "deps", "doctor", "evidence-migrate", "lifecycle", "operator-verify", "sbom", "scan", "security-check", "target-init", "target-preflight"]);
});

test("target check and explain validate and describe a pasted intent, and refuse a bad one", async () => {
  const text = JSON.stringify(intent);
  const seen = await capture("target-check", { intent: text });
  assert.deepEqual(seen.job?.args, ["target-check", "<file>"]);
  assert.equal(JSON.parse(seen.file!).targetId, "aws-platform-primary");
  assert.equal(seen.mode, 0o600);
  assert.equal(seen.directoryMode, 0o700);

  const ok = await execute("target-check", { intent: text });
  assert.equal(ok.status, 0);
  assert.match(ok.out, /Target intent is valid\.[\s\S]*No infrastructure changes were made\./);
  const explained = await execute("target-explain", { intent: text });
  assert.equal(explained.status, 0);
  assert.match(explained.out, /Compliance overlays/);

  const bad = await execute("target-check", { intent: JSON.stringify({ targetId: "x" }) });
  assert.equal(bad.status, 1);
  assert.match(bad.out, /GOVERNANCE_VIEW_FAILED: .*owner/);
});

test("recovery status reports READY and recovery test reports BLOCKED without compiled metadata", async () => {
  const status = await execute("recovery-status", { targets });
  assert.equal(status.status, 0);
  assert.match(status.out, /aws-platform-primary: READY/);
  const readiness = await execute("recovery-test", { targets });
  assert.equal(readiness.status, 1);
  assert.match(readiness.out, /BLOCKED[\s\S]*requires compiled recovery profile metadata/);
  const invalid = await execute("recovery-status", { targets: '{"not":"a list"}' });
  assert.equal(invalid.status, 1);
  assert.match(invalid.out, /GOVERNANCE_VIEW_FAILED/);
});

test("the economics report is computed from the pasted entries only", async () => {
  const seen = await capture("economics-report", { input: economics });
  assert.deepEqual(seen.job?.args, ["economics", "<file>"]);
  const report = await execute("economics-report", { input: economics });
  assert.equal(report.status, 0);
  assert.match(report.out, /"reportMonth": "2026-09"[\s\S]*Advisory only/);
  assert.equal((await execute("economics-report", { input: "{}" })).status, 1);
});

test("the offline read-only scripts run for real with fixed arguments", async () => {
  for (const [id, pattern] of [
    ["health", /ACT DISABLED/],
    ["plugins", /PLUG-IN (?:ADAPTER )?COMPATIBILITY/],
    ["toolbox-check", /Cloud mutation DISABLED/],
    ["prompts", /Prompt Guide/],
    ["models-list", /PRIVATE MODEL CATALOG/],
  ] as const) {
    const result = await execute(id, {});
    assert.equal(result.status, 0, id + "\n" + result.out);
    assert.match(result.out, pattern, id);
  }
});

test("models verify builds a fixed argument list and never adds --production", async () => {
  const args = async (inputs: unknown) => (await capture("models-verify", inputs)).job!.args;
  assert.deepEqual(await args({}), ["verify"]);
  assert.deepEqual(await args({ all: true }), ["verify", "--all"]);
  assert.deepEqual(await args({ model: "qwen3:8b" }), ["verify", "--model", "qwen3:8b"]);
  assert.equal(byId("models-verify").safety, "LOCAL_MODEL");
  assert.equal((await capture("models-list", {})).job!.script, "cli/models.js");
  assert.ok(!(await args({ all: true, model: "m" })).includes("--production"));
});

test("every runnable entry refuses unknown fields, wrong types and unrequested input", () => {
  for (const spec of catalog.filter((item) => item.job)) {
    assert.throws(() => planOperation(spec.id, '{"extra":1}', catalog), /INPUT_UNKNOWN_FIELD/, spec.id);
    assert.throws(() => planOperation(spec.id, "[1]", catalog), /INPUTS_NOT_OBJECT/, spec.id);
    assert.throws(() => planOperation(spec.id, "{nope", catalog), /INPUTS_NOT_JSON/, spec.id);
  }
  assert.throws(() => planOperation("health", '{"script":"cli/x.js"}', catalog), /INPUT_UNKNOWN_FIELD/);
});

test("pasted JSON is required, valid and capped", () => {
  const refuse = (id: string, inputs: unknown, code: RegExp) =>
    assert.throws(() => planOperation(id, JSON.stringify(inputs), catalog), code);
  for (const [id, field, cap] of [["target-check", "intent", 4096], ["target-explain", "intent", 4096],
    ["recovery-status", "targets", 65536], ["recovery-test", "targets", 65536], ["economics-report", "input", 65536]] as const) {
    refuse(id, {}, new RegExp("INPUT_REQUIRED:" + field));
    refuse(id, { [field]: "{nope" }, new RegExp("INPUT_JSON_INVALID:" + field));
    refuse(id, { [field]: 5 }, new RegExp("INPUT_TYPE:" + field));
    refuse(id, { [field]: JSON.stringify({ pad: "x".repeat(cap) }) }, new RegExp("INPUT_TOO_LARGE:" + field));
  }
});

test("models verify refuses an option-like, malformed or oversized model name", () => {
  const refuse = (inputs: unknown, code: string) =>
    assert.throws(() => planOperation("models-verify", JSON.stringify(inputs), catalog), new RegExp(code));
  refuse({ model: "--production" }, "INPUT_CHARACTERS:model");
  refuse({ model: "a\nb" }, "INPUT_CHARACTERS:model");
  refuse({ model: "qwen 3" }, "INPUT_PATTERN:model");
  refuse({ model: "a".repeat(81) }, "INPUT_TOO_LONG:model");
  refuse({ model: 3 }, "INPUT_TYPE:model");
  refuse({ all: "yes" }, "INPUT_TYPE:all");
});

test("handoffs show the exact filled command, env names only, and never a destroy driver", () => {
  const command = (id: string, inputs: unknown) => {
    const spec = byId(id);
    const checked = validateInputs(spec.inputs, inputs);
    assert.ok(checked.ok, id);
    return fillCommand(spec.handoff!.command, spec.inputs, checked.values);
  };
  assert.equal(command("target-init", { targetId: "aws-platform-primary", owner: "platform-operations", scopeId: "o-example",
    compliance: "SOC2@1,HIPAA@1", provider: "azure", criticality: "business" }),
  "./alz target init aws-platform-primary platform-operations azure o-example startup development business --compliance=SOC2@1,HIPAA@1");
  assert.equal(command("control-plane-capture", { root: ".", evidence: ".runs/evidence/cp.bundle" }),
    "./alz control-plane capture --root . --evidence .runs/evidence/cp.bundle");
  assert.equal(command("control-plane-verify", { evidence: "a/b.bundle" }), "./alz control-plane verify --evidence a/b.bundle");
  assert.equal(command("control-plane-drill", { evidence: "a/b.bundle" }), "./alz control-plane drill --evidence a/b.bundle");
  assert.equal(command("control-plane-restore", { evidence: "a/b.bundle", restoreRoot: "/var/tmp/restore" }),
    "./alz control-plane restore --evidence a/b.bundle --restore-root /var/tmp/restore");
  assert.equal(command("target-preflight", { hardwareId: "gpu-node-01", output: "out/p.json" }),
    "npx tsx src/cli/target-preflight.ts --target-hardware-id gpu-node-01 --output out/p.json");
  assert.equal(command("operator-verify", {}), "./alz verify");
  for (const spec of catalog.filter((item) => item.handoff)) {
    assert.ok(spec.handoff!.reason.length > 20, spec.id);
    for (const name of spec.handoff!.env ?? []) assert.match(name, /^[A-Z][A-Z0-9_]*$/);
    assert.doesNotMatch(spec.handoff!.command, /destroy|preview-only|teardown-driver/, spec.id);
    const viewer = spec.handoff!.viewer;
    if (viewer) assert.equal(byId(viewer).safety, "READ_ONLY");
  }
  assert.equal(byId("target-init").handoff!.viewer, "target-explain");
  assert.deepEqual(byId("control-plane-verify").handoff!.env, ["AGENTIC_EVIDENCE_KEY_FILE"]);
});

test("handoff inputs refuse shell metacharacters, option-like words and bad enums", () => {
  const refuse = (id: string, inputs: unknown, code: string) => {
    const checked = validateInputs(byId(id).inputs, inputs);
    assert.deepEqual(checked, { ok: false, error: code });
  };
  const init = { targetId: "aws-platform-primary", owner: "ops", scopeId: "o-example" };
  refuse("target-init", { ...init, targetId: "AB" }, "INPUT_PATTERN:targetId");
  refuse("target-init", { ...init, targetId: "-rf" }, "INPUT_CHARACTERS:targetId");
  refuse("target-init", { ...init, owner: "ops; rm -rf /" }, "INPUT_PATTERN:owner");
  refuse("target-init", { ...init, scopeId: "$(id)" }, "INPUT_PATTERN:scopeId");
  refuse("target-init", { ...init, provider: "gcp" }, "INPUT_ENUM:provider");
  refuse("target-init", { ...init, criticality: "low" }, "INPUT_ENUM:criticality");
  refuse("target-init", { ...init, compliance: "SOC2" }, "INPUT_PATTERN:compliance");
  refuse("target-init", { owner: "ops", scopeId: "o-example" }, "INPUT_REQUIRED:targetId");
  refuse("control-plane-verify", { evidence: "a b" }, "INPUT_PATTERN:evidence");
  refuse("control-plane-verify", { evidence: "--restore-root" }, "INPUT_CHARACTERS:evidence");
  refuse("control-plane-verify", { evidence: "x\u0000y" }, "INPUT_CHARACTERS:evidence");
  refuse("control-plane-verify", { evidence: "a".repeat(201) }, "INPUT_TOO_LONG:evidence");
  refuse("control-plane-restore", { evidence: "a.bundle", restoreRoot: "`id`" }, "INPUT_PATTERN:restoreRoot");
  refuse("target-preflight", { hardwareId: "a b", output: "p.json" }, "INPUT_PATTERN:hardwareId");
  refuse("target-preflight", { hardwareId: "gpu", output: "p.json;ls" }, "INPUT_PATTERN:output");
  refuse("operator-verify", { all: true }, "INPUT_UNKNOWN_FIELD");
});
