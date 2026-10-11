import assert from "node:assert/strict";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createLocalOperatorServer, evidenceKeyMissing, minimumEnv, runOperatorJob } from "../src/operator-ui/server.js";
import { OPERATIONS } from "../src/operations/registry.js";
import { maxRequestBytes, validateCatalog, validateInputs } from "../src/operations/schema.js";
import type { OperationSpec, OperatorJob } from "../src/operations/types.js";

// Fix-pass regressions: the console's child environment, the evidence-key rule,
// the POST /run body cap and the early refusal of forbidden words.

const spec = (id: string) => OPERATIONS.find((item) => item.id === id)!;

test("minimumEnv forwards the evidence key file path and the policy mode name, never the key itself", () => {
  const env = minimumEnv({
    PATH: "/bin", HOME: "/home/x", AGENTIC_EVIDENCE_KEY_FILE: "/keys/evidence.key", AGENTIC_SECURITY_POLICY_MODE: "OPA",
    AGENTIC_EVIDENCE_KEY: "c2VjcmV0", AWS_SECRET_ACCESS_KEY: "nope", OLLAMA_BASE_URL: "http://127.0.0.1:11434",
  });
  assert.equal(env.AGENTIC_EVIDENCE_KEY_FILE, "/keys/evidence.key");
  assert.equal(env.AGENTIC_SECURITY_POLICY_MODE, "OPA");
  assert.equal("AGENTIC_EVIDENCE_KEY" in env, false);
  assert.equal("AWS_SECRET_ACCESS_KEY" in env, false);
});

function withEnv<T>(values: Record<string, string | undefined>, body: () => Promise<T>): Promise<T> {
  const saved = Object.fromEntries(Object.keys(values).map((name) => [name, process.env[name]]));
  for (const [name, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
  return body().finally(() => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  });
}

test("a WRITES_LOCAL job is refused, without creating a key, when no evidence key exists", async () => {
  const root = mkdtempSync(join(tmpdir(), "alz-key-"));
  try {
    mkdirSync(join(root, "dist", "cli"), { recursive: true });
    writeFileSync(join(root, "dist", "cli", "probe.js"),
      "console.log('FILE=' + process.env.AGENTIC_EVIDENCE_KEY_FILE + ' SECRET=' + process.env.AGENTIC_EVIDENCE_KEY);");
    const job: OperatorJob = { mode: "probe", script: "cli/probe.js", args: [], title: "Probe", evidenceBasis: "FIXTURE", writesLocal: true };
    const keyFile = join(root, "keys", "evidence.key");
    await withEnv({ AGENTIC_EVIDENCE_KEY_FILE: keyFile, AGENTIC_EVIDENCE_KEY: "c2VjcmV0", HOME: root }, async () => {
      assert.match(evidenceKeyMissing() ?? "", /EVIDENCE_KEY_MISSING/);
      await assert.rejects(runOperatorJob(job, root), /EVIDENCE_KEY_MISSING: .*never creates one.*\.\/alz doctor/);
      assert.equal(existsSync(join(root, "keys")), false, "the refusal must not create a key or its directory");
      // A read-only job does not need a key and still runs.
      assert.match(await runOperatorJob({ ...job, writesLocal: undefined }, root), /FILE=.*evidence\.key SECRET=undefined/);
      // With a key in place the job runs and sees the same path the operator chose.
      mkdirSync(join(root, "keys"));
      writeFileSync(keyFile, "a".repeat(44) + "\n");
      assert.equal(evidenceKeyMissing(), null);
      assert.match(await runOperatorJob(job, root), new RegExp("FILE=" + keyFile.replaceAll("/", "\\/") + " SECRET=undefined"));
    });
    // The default location is used when no path is set.
    await withEnv({ AGENTIC_EVIDENCE_KEY_FILE: undefined, HOME: root }, async () => {
      assert.match(evidenceKeyMissing() ?? "", /EVIDENCE_KEY_MISSING/);
      mkdirSync(join(root, ".config", "agentic-landing-zone"), { recursive: true });
      writeFileSync(join(root, ".config", "agentic-landing-zone", "evidence.key"), "a".repeat(44));
      assert.equal(evidenceKeyMissing(), null);
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("every WRITES_LOCAL catalog entry reaches the runner marked writesLocal", async () => {
  const writes = OPERATIONS.filter((item) => item.safety === "WRITES_LOCAL");
  assert.ok(writes.length > 0);
  const { planOperation, runPlanned } = await import("../src/operations/run.js");
  for (const item of writes) {
    const defaults = Object.fromEntries(item.inputs.flatMap((field) => field.kind === "text" && !field.optional ? [[field.name, field.example]]
      : field.kind === "json" && !field.optional ? [[field.name, "{}"]] : []));
    let seen: OperatorJob | undefined;
    await runPlanned(planOperation(item.id, JSON.stringify(defaults)), "/repo", async (job) => { seen = job; return ""; });
    assert.equal(seen?.writesLocal, true, item.id);
  }
});

async function withRealServer(body: (url: string, token: string) => Promise<void>, runner: (job: OperatorJob) => Promise<string>): Promise<void> {
  const { server } = createLocalOperatorServer({ root: process.cwd(), runner });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("ADDRESS_UNAVAILABLE");
    const url = "http://127.0.0.1:" + address.port;
    const token = (await (await fetch(url)).text()).match(/name="token" value="([0-9a-f]{48})"/)?.[1] ?? "";
    assert.ok(token);
    await body(url, token);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

const post = (url: string, form: Record<string, string>) => fetch(url + "/run", { method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(form) });

/** A valid JSON document of exactly `bytes` bytes in which every byte is a backslash (the costliest byte to encode). */
const worstJson = (bytes: number): string => '"' + "\\\\".repeat((bytes - 2) / 2) + '"';

test("the POST /run cap is derived from the catalog and admits the largest legal body", async () => {
  const cap = maxRequestBytes(OPERATIONS);
  assert.ok(cap > 3 * 64 * 1024 * 6, "the cap must cover three 64 KiB JSON fields at six characters per byte");
  // Every operation's worst-case body fits under the cap.
  for (const item of OPERATIONS) assert.ok(maxRequestBytes([item]) <= cap, item.id);
  const received: OperatorJob[] = [];
  await withRealServer(async (url, token) => {
    const orphans = spec("teardown-orphans");
    const json = worstJson(64 * 1024);
    assert.equal(new TextEncoder().encode(json).length, 64 * 1024);
    const inputs = JSON.stringify({ unit: json, otherUnit: json, source: "resources", inventory: json });
    const form = new URLSearchParams({ operation: orphans.id, token, inputs });
    const size = form.toString().length;
    assert.ok(size > 256 * 1024, "the old cap would have refused this body (" + size + ")");
    assert.ok(size <= cap, "the derived cap must admit it (" + size + " <= " + cap + ")");
    const response = await post(url, { operation: orphans.id, token, inputs });
    assert.equal(response.status, 202);
    // A body beyond every legal request is still refused with the stable code.
    await new Promise((resolve) => setTimeout(resolve, 100));
    const tooBig = await post(url, { operation: orphans.id, token, inputs: "x".repeat(cap + 1) });
    assert.equal(tooBig.status, 413);
    assert.deepEqual(await tooBig.json(), { error: "REQUEST_TOO_LARGE" });
  }, async (job) => { received.push(job); return "OK"; });
  assert.equal(received.length, 1);
});

test("a forbidden word in a text value is refused with a 400 before any state change", async () => {
  const agent = spec("agent");
  const request = agent.inputs.find((field) => field.name === "request")!;
  assert.equal(request.kind, "text");
  for (const word of ["Please apply the change", "destroy everything", "use auto-approve", "run preview-run now"]) {
    assert.deepEqual(validateInputs(agent.inputs, { request: word }), { ok: false, error: "INPUT_FORBIDDEN:request" }, word);
  }
  assert.equal(validateInputs(agent.inputs, { request: "Review the strongest operational risk." }).ok, true);
  let calls = 0;
  await withRealServer(async (url, token) => {
    const response = await post(url, { operation: "agent", token, inputs: JSON.stringify({ request: "Please apply the change" }) });
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: "INPUT_FORBIDDEN:request" });
    const state = await (await fetch(url + "/state")).json() as { status: string };
    assert.equal(state.status, "IDLE", "a refused request must not move the console to RUNNING");
  }, async () => { calls += 1; return ""; });
  assert.equal(calls, 0);
});

test("the catalog may not point a job at the driver, the dispatcher or the console host", () => {
  const base = spec("health");
  for (const script of ["cli/teardown-driver.js", "cli/operator.js", "cli/operator-web.js", "cli/session.js", "cli/evidence-migrate.js"]) {
    const bad: OperationSpec = { ...base, id: "bad-script", job: { script, args: () => [] } };
    assert.match(validateCatalog([bad]).join(), /may not be run by the console/, script);
  }
  assert.deepEqual(validateCatalog([spec("health")]), []);
});

test("a group command passes exactly the arguments the console job passes", async () => {
  const { resolveGroupCommand } = await import("../src/operations/groups.js");
  // ./alz qualify verify-package must run release-package with --verify, as the console job does.
  assert.deepEqual(resolveGroupCommand("qualify", ["verify-package"]), { kind: "run", script: "src/cli/release-package.ts", args: ["--verify"] });
  const listed = resolveGroupCommand("qualify", ["list"]);
  assert.match(listed?.kind === "list" ? listed.lines.join("\n") : "", /qualify verify-package --verify {2}/);
  // For every runnable group entry without inputs, the CLI arguments equal the console job's arguments.
  for (const item of OPERATIONS.filter((entry) => entry.command && entry.job && entry.inputs.length === 0)) {
    const resolved = resolveGroupCommand(item.command!.group, [item.command!.sub]);
    assert.deepEqual(resolved?.kind === "run" ? resolved.args : null, item.job!.args({}), item.id);
  }
});

test("a LOCAL_MODEL operation is refused with a 400 unless the model endpoint is on this machine", async () => {
  let calls = 0;
  const runner = async () => { calls += 1; return "OK"; };
  const localModel = OPERATIONS.filter((item) => item.safety === "LOCAL_MODEL").map((item) => item.id);
  assert.ok(["debug-live", "agent-live", "models-verify", "matrix-live", "aws-review"].every((id) => localModel.includes(id)), localModel.join());
  await withEnv({ OLLAMA_BASE_URL: "http://models.example.com:11434" }, () => withRealServer(async (url, token) => {
    for (const id of ["debug-live", "agent-live"]) {
      const response = await post(url, { operation: id, token, inputs: "{}" });
      assert.equal(response.status, 400, id);
      assert.deepEqual(await response.json(), { error: "MODEL_ENDPOINT_NOT_LOOPBACK" });
    }
    const legacy = await post(url, { mode: "matrix-live", scenario: "all", token });
    assert.equal(legacy.status, 400);
    assert.equal(calls, 0, "a refused request never reaches the runner");
    // Offline work is unaffected.
    assert.equal((await post(url, { mode: "chaos", scenario: "all", token })).status, 202);
  }, runner));
  calls = 0;
  await withEnv({ OLLAMA_BASE_URL: "http://127.0.0.1:11434" }, () => withRealServer(async (url, token) => {
    assert.equal((await post(url, { operation: "debug-live", token, inputs: "{}" })).status, 202);
  }, runner));
  assert.equal(calls, 1);
});

test("catalog titles are unique, so a fixture run can never be mistaken for a private-model run", () => {
  const titles = OPERATIONS.map((item) => item.title);
  assert.deepEqual(titles.filter((title, index) => titles.indexOf(title) !== index), []);
});

test("every operation that takes an approval flag stays on a fixture environment and a preview", () => {
  const approving = OPERATIONS.filter((item) => item.inputs.some((field) => field.name === "approve"));
  assert.deepEqual(approving.map((item) => item.id).sort(), ["agent", "agent-live", "build-loop"]);
  for (const item of approving) {
    const argv = item.job!.args({ provider: "aws", engine: "terraform", mock: "brownfield", approve: true });
    assert.ok(argv.includes("--mock"), item.id + " must name a recorded environment");
    assert.ok(argv.includes("--approve"));
    assert.match(item.evidenceBasis, /FIXTURE|NO LIVE CLOUD/, item.id);
    assert.notEqual(item.safety, "HANDOFF");
  }
});

test("an invalid policy mode is refused with a bounded message, and the empty and lower-case values stay invalid", async () => {
  const { createSecurityPolicyEvaluator } = await import("../src/security/policy/engine.js");
  for (const mode of ["", "builtin", "opa"]) {
    assert.throws(() => createSecurityPolicyEvaluator(mode as never), /SECURITY_POLICY_MODE_INVALID/, JSON.stringify(mode));
  }
  assert.doesNotThrow(() => createSecurityPolicyEvaluator("BUILTIN"));
  assert.doesNotThrow(() => createSecurityPolicyEvaluator(undefined));
  let message = "";
  try { createSecurityPolicyEvaluator(("x".repeat(5000)) as never); } catch (error) { message = (error as Error).message; }
  assert.ok(message.length < 300, "the received value must be truncated, was " + message.length);
});

test("a group command propagates a diagnosis exit code without an 'Operator command failed' block", async () => {
  const { spawnSync } = await import("node:child_process");
  const run = spawnSync(process.execPath, ["--import", "tsx", "src/cli/operator.ts", "enterprise", "models", "--role", "NOPE"], { encoding: "utf8" });
  assert.notEqual(run.status, 0);
  assert.doesNotMatch(run.stdout + run.stderr, /Operator command failed/);
});
