import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { evidenceOperations } from "../src/operations/families/evidence.js";
import { OPERATIONS } from "../src/operations/registry.js";
import { planOperation, runPlanned } from "../src/operations/run.js";
import { fillCommand, validateInputs } from "../src/operations/schema.js";
import { AGENT_BUILDER_TARGET_CONNECTORS } from "../src/integration-sim/catalog.js";
import type { OperatorJob } from "../src/operations/types.js";

// Drives each evidence-family entry through the path the server uses:
// planOperation (validation) then runPlanned (argument building and the
// forbidden-word check), with a fake runner that records the job.

const CONNECTOR = AGENT_BUILDER_TARGET_CONNECTORS[0].id;
const spec = (id: string) => evidenceOperations.find((item) => item.id === id)!;
const runnable = evidenceOperations.filter((item) => item.safety !== "HANDOFF");
const handoffs = evidenceOperations.filter((item) => item.safety === "HANDOFF");

async function jobFor(id: string, inputs: object = {}): Promise<OperatorJob> {
  let captured: OperatorJob | undefined;
  await runPlanned(planOperation(id, JSON.stringify(inputs), OPERATIONS), "/repo", async (job) => {
    captured = job;
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
    ["demo", "SYNTHETIC"], ["demo-gcp-offline", "SYNTHETIC"], ["design", "SYNTHETIC"], ["discover", "WRITES_LOCAL"], ["debug", "SYNTHETIC"],
    ["debug-live", "LOCAL_MODEL"], ["build-loop", "WRITES_LOCAL"], ["agent", "WRITES_LOCAL"],
    ["agent-live", "LOCAL_MODEL"], ["agent-builder-sim", "SYNTHETIC"],
  ]);
  assert.deepEqual(handoffs.map((item) => item.id), [
    "inspect", "session", "session-fixture", "real-private-build", "lz-live-journey", "qualify-terraform-validate", "qualify-terraform-plan",
  ]);
  for (const item of evidenceOperations) assert.equal(OPERATIONS.filter((other) => other.id === item.id).length, 1);
});

test("every runnable entry builds a job for a compiled script that has a source file", async () => {
  for (const item of runnable) {
    const job = await jobFor(item.id, {});
    assert.equal(job.mode, item.id);
    assert.ok(existsSync(resolve("src", job.script.replace(/\.js$/, ".ts"))), item.id + " -> " + job.script);
    assert.ok(job.args.every((arg) => typeof arg === "string"));
    assert.doesNotMatch(job.args.join(" "), /destroy|preview-only|apply|auto-approve/i);
    assert.match(job.evidenceBasis, /\S/);
  }
});

/** Splits a package.json script into its tsx script and a flag map (a bare flag maps to true). */
function scriptFlags(command: string): { file: string; flags: Record<string, string | true> } {
  const words = [...command.matchAll(/"([^"]*)"|(\S+)/g)].map((match) => match[1] ?? match[2]);
  const flags: Record<string, string | true> = {};
  words.slice(2).forEach((word, index, rest) => {
    if (word.startsWith("--")) flags[word] = rest[index + 1] && !rest[index + 1].startsWith("--") ? rest[index + 1] : true;
  });
  return { file: words[1], flags };
}

function argvFlags(args: string[]): Record<string, string | true> {
  const flags: Record<string, string | true> = {};
  args.forEach((arg, index) => {
    if (arg.startsWith("--")) flags[arg] = args[index + 1] && !args[index + 1].startsWith("--") ? args[index + 1] : true;
  });
  return flags;
}

test("each package.json script the family covers is reproduced by the form inputs", async () => {
  const scripts = (JSON.parse(readFileSync("package.json", "utf8")) as { scripts: Record<string, string> }).scripts;
  const brownfield = { provider: "aws", engine: "terraform", mock: "brownfield" };
  const azure = { provider: "azure", engine: "pulumi", mock: "greenfield" };
  const cases: Record<string, [string, object]> = {
    "discover:aws": ["discover", { provider: "aws", mock: "brownfield", resources: true }],
    "discover:azure": ["discover", { provider: "azure", mock: "greenfield", resources: true }],
    "discover:unknown": ["discover", { provider: "aws", mock: "unknown" }],
    "discover:verbose": ["discover", { provider: "aws", mock: "brownfield", verbose: true }],
    "build:aws:terraform": ["build-loop", brownfield],
    "build:azure:pulumi": ["build-loop", azure],
    "build:unknown": ["build-loop", { ...brownfield, mock: "unknown", approve: true }],
    "build:approved": ["build-loop", { ...azure, approve: true }],
    "agent:assess": ["agent", { ...brownfield, request: "Review this environment and assess the strongest operational risk." }],
    "agent:build": ["agent", { ...brownfield, request: "Build additive infrastructure using Terraform." }],
    "agent:change": ["agent", { ...azure, approve: true, request: "Deploy an additive platform resource." }],
    "agent:unknown": ["agent", { ...brownfield, mock: "unknown", request: "Build additive infrastructure using Terraform." }],
    "agent:verbose": ["agent", { ...brownfield, verbose: true, request: "Build additive infrastructure using Terraform." }],
  };
  for (const [script, [id, inputs]] of Object.entries(cases)) {
    const expected = scriptFlags(scripts[script]);
    const job = await jobFor(id, inputs);
    assert.equal("src/" + job.script.replace(/\.js$/, ".ts"), expected.file, script);
    assert.deepEqual(argvFlags(job.args), expected.flags, script);
  }
  // demo and the matrix script run with no flags; the form defaults are the dispatcher's defaults.
  assert.deepEqual((await jobFor("demo", {})).args, ["--provider", "aws", "--engine", "terraform", "--scenario", "brownfield"]);
  assert.deepEqual((await jobFor("demo-gcp-offline", {})).args, ["brownfield"]);
  assert.deepEqual((await jobFor("demo-gcp-offline", { mock: "unknown" })).args, ["unknown"]);
  assert.equal(refusal("demo-gcp-offline", { mock: "production" }), "INPUT_ENUM:mock");
  assert.deepEqual((await jobFor("agent-builder-sim", {})).args, []);
  // The bare scripts forward whatever the operator types, so they map to the private-model entries.
  const live = await jobFor("agent-live", brownfield);
  assert.deepEqual(argvFlags(live.args), { "--provider": "aws", "--engine": "terraform", "--mock": "brownfield" });
  assert.ok(!live.args.includes("--fixture"));
  assert.ok((await jobFor("agent", brownfield)).args.includes("--fixture"));
  assert.ok((await jobFor("debug", brownfield)).args.includes("--fixture"));
  assert.ok(!(await jobFor("debug-live", brownfield)).args.includes("--fixture"));
});

test("design and demo run the same fixture flow, as the ./alz dispatcher does", async () => {
  const inputs = { provider: "azure", engine: "bicep", mock: "unknown" };
  const [demo, design] = [await jobFor("demo", inputs), await jobFor("design", inputs)];
  assert.deepEqual(design.args, ["--provider", "azure", "--engine", "bicep", "--scenario", "unknown"]);
  assert.deepEqual({ ...design, mode: "", title: "", evidenceBasis: "" }, { ...demo, mode: "", title: "", evidenceBasis: "" });
});

test("the connector matrix takes only catalog connectors and modes, and 'all' omits the flag", async () => {
  assert.deepEqual((await jobFor("agent-builder-sim", {})).args, []);
  assert.deepEqual((await jobFor("agent-builder-sim", { connector: CONNECTOR, mode: "RECONCILED" })).args,
    ["--connector", CONNECTOR, "--mode", "RECONCILED"]);
  assert.equal(refusal("agent-builder-sim", { connector: "JIRA" }), "INPUT_ENUM:connector");
  assert.equal(refusal("agent-builder-sim", { mode: "connected" }), "INPUT_ENUM:mode");
  assert.equal(refusal("agent-builder-sim", { json: true }), "INPUT_UNKNOWN_FIELD");
});

test("every input refusal holds for each runnable entry", async () => {
  for (const item of runnable) {
    assert.equal(refusal(item.id, { extra: 1 }), "INPUT_UNKNOWN_FIELD", item.id);
    assert.equal(refusal(item.id, []), "INPUTS_NOT_OBJECT", item.id);
    assert.throws(() => planOperation(item.id, "{nope", OPERATIONS), /INPUTS_NOT_JSON/);
    for (const field of item.inputs) {
      if (field.kind === "enum") {
        assert.equal(refusal(item.id, { [field.name]: "gcp" }), "INPUT_ENUM:" + field.name);
        assert.equal(refusal(item.id, { [field.name]: 1 }), "INPUT_TYPE:" + field.name);
      } else if (field.kind === "flag") {
        assert.equal(refusal(item.id, { [field.name]: "yes" }), "INPUT_TYPE:" + field.name);
      } else if (field.kind === "text") {
        assert.equal(refusal(item.id, { [field.name]: "--fixture" }), "INPUT_CHARACTERS:" + field.name);
        assert.equal(refusal(item.id, { [field.name]: "a\nb" }), "INPUT_CHARACTERS:" + field.name);
        assert.equal(refusal(item.id, { [field.name]: "x".repeat(field.maxLength + 1) }), "INPUT_TOO_LONG:" + field.name);
        assert.equal(refusal(item.id, { [field.name]: "rm -rf $(id)|`id`" }), "INPUT_PATTERN:" + field.name);
        assert.equal(refusal(item.id, { [field.name]: 7 }), "INPUT_TYPE:" + field.name);
      }
    }
  }
  // Fields the browser must never supply do not exist on any entry.
  for (const item of evidenceOperations) {
    assert.ok(!item.inputs.some((field) => /path|file|script|command|token|key|credential|secret/i.test(field.name)), item.id);
  }
});

test("a request cannot smuggle apply, destroy or an auto-approval into a job", async () => {
  for (const id of ["agent", "agent-live", "debug", "debug-live"]) {
    for (const word of ["apply", "Please DESTROY it", "auto-approve", "preview-only"]) {
      // Refused at validation, before the server answers 202 or marks the console RUNNING.
      await assert.rejects(jobFor(id, { request: word }), /^Error: INPUT_FORBIDDEN:request$/, id + " " + word);
      // The argv guard stays as the backstop when a plan skips validation.
      const spec = evidenceOperations.find((item) => item.id === id)!;
      await assert.rejects(runPlanned({ spec, values: { provider: "aws", engine: "terraform", mock: "brownfield", request: word } },
        "/repo", async () => "ran"), /OPERATION_ARGV_FORBIDDEN/, id + " backstop " + word);
    }
    assert.ok((await jobFor(id, { request: "Review this environment and assess the strongest operational risk." })).args.includes("Review this environment and assess the strongest operational risk."));
  }
});

test("handoff entries are never run, and fill an exact command with names-only environment", () => {
  for (const item of handoffs) {
    assert.throws(() => planOperation(item.id, null, OPERATIONS), /OPERATION_HANDOFF_ONLY/, item.id);
    assert.ok(item.handoff!.reason.length > 20 && !item.job, item.id);
    for (const name of item.handoff!.env ?? []) assert.match(name, /^[A-Z][A-Z0-9_]*$/);
    const checked = validateInputs(item.inputs, {});
    assert.ok(checked.ok);
    const command = fillCommand(item.handoff!.command, item.inputs, checked.values);
    assert.doesNotMatch(command, /[{}]|-destroy|--preview-only|--apply|auto-approve/, item.id);
  }
  const fill = (id: string, raw: object) => {
    const item = spec(id);
    const checked = validateInputs(item.inputs, raw);
    assert.ok(checked.ok);
    return fillCommand(item.handoff!.command, item.inputs, checked.values);
  };
  assert.equal(fill("inspect", { provider: "azure" }), "./alz inspect azure");
  assert.equal(fill("session", { engine: "pulumi" }), "./alz session aws pulumi");
  assert.equal(fill("session-fixture", { mock: "unknown" }),
    "npx tsx src/cli/session.ts --provider aws --engine terraform --mock unknown --fixture");
  assert.equal(fill("qualify-terraform-plan", {}),
    "npx tsx src/cli/qualify-aws-terraform-agent.ts --live-models --terraform-validate --terraform-plan");
  assert.equal(fill("real-private-build", {}), "npx tsx src/cli/real-private-build.ts --live-aws-read-only");
  assert.deepEqual(spec("real-private-build").handoff!.env,
    ["ALZ_ALLOW_REAL_PRIVATE_BUILD", "ALZ_ALLOW_TERRAFORM_PLAN", "AWS_PROFILE"]);
  assert.equal(refusal("inspect", {}), "OPERATION_HANDOFF_ONLY");
  // Handoff inputs are validated when the card is filled, so a bad value never reaches the command.
  assert.equal(validateInputs(spec("inspect").inputs, { provider: "gcp" }).ok, false);
});

// Real scripts, offline and fast, run in an empty working directory so any stray write is caught.
function runReal(script: string, args: string[]) {
  const cwd = mkdtempSync(join(tmpdir(), "alz-evidence-"));
  const result = spawnSync(process.execPath, ["--import", import.meta.resolve("tsx"), resolve("src", script.replace(/\.js$/, ".ts")), ...args], {
    cwd, encoding: "utf8", timeout: 60_000, env: { PATH: process.env.PATH, HOME: cwd, AGENT_SKIP_LOCAL_MODEL: "1" },
  });
  const written = readdirSync(cwd);
  rmSync(cwd, { recursive: true, force: true });
  return { ...result, written };
}

test("the connector matrix and the demo run for real, offline, without writing anything", async () => {
  const sim = await jobFor("agent-builder-sim", { connector: CONNECTOR, mode: "CONNECTED" });
  const simRun = runReal(sim.script, sim.args);
  assert.equal(simRun.status, 0, simRun.stderr);
  assert.match(simRun.stdout, /Infrastructure ACT: DISABLED/);
  assert.deepEqual(simRun.written, []);

  const demo = await jobFor("demo", {});
  const demoRun = runReal(demo.script, demo.args);
  assert.equal(demoRun.status, 0, demoRun.stderr);
  assert.match(demoRun.stdout, /ACT\s+DISABLED/);
  assert.deepEqual(demoRun.written, [], "the demo is classed SYNTHETIC, so it must not write");

  const gcpDemo = await jobFor("demo-gcp-offline", {});
  const gcpRun = runReal(gcpDemo.script, gcpDemo.args);
  assert.equal(gcpRun.status, 0, gcpRun.stderr);
  assert.match(gcpRun.stdout, /GCP OFFLINE WALKTHROUGH/);
  assert.match(gcpRun.stdout, /LIVE QUALIFICATION\s+NOT PERFORMED/);
  assert.match(gcpRun.stdout, /ACT\s+DISABLED/);
  assert.deepEqual(gcpRun.written, [], "the GCP synthetic demo must not write");
});

test("each WRITES_LOCAL or SYNTHETIC fixture job runs for real with its form defaults and the placeholder request", async () => {
  // The placeholder request must be one the debug policy accepts, or the first click on the card ends BLOCKED.
  for (const id of ["debug", "discover", "build-loop", "agent"]) {
    const item = evidenceOperations.find((entry) => entry.id === id)!;
    const example = item.inputs.find((field) => field.name === "request");
    const job = await jobFor(id, example && example.kind === "text" ? { request: example.example } : {});
    const run = runReal(job.script, job.args);
    assert.equal(run.status, 0, id + ": " + run.stdout.slice(-400) + run.stderr.slice(-400));
  }
});
