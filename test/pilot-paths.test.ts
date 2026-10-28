import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { request, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { openNonceStore } from "../src/apply/nonces.js";
import { PILOT_TOKEN_HEADER } from "../src/cli/ui-channel.js";
import { createLocalOperatorServer } from "../src/operator-ui/server.js";
import { checkJourneyMatrix, loadJourneyMatrix } from "../src/release/acceptance.js";
import { deploymentPaths, rememberedReadiness, type RememberedReadiness } from "../src/release/pilot-paths.js";
import { loadReleaseStatus } from "../src/release/status.js";
import { removeTree } from "../src/teardown/driver/cleanup.js";
import {
  NOW, SOURCE_COMMIT, behave, callsOf, contractJson, identityEnv, installFakeTerraform, testFixtureForgeQualificationEvidence, writeReviewedContract,
} from "./helpers/apply-fixtures.js";

// GET /pilot/paths (owner decision E5, #39 6480066863): the deployment paths from the journey matrix and the release status, with
// the readiness checks the console already ran. SYNTHETIC: a fake engine and a fixture contract in a temporary folder; nothing live.

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), "alz-paths-"));
const toolDir = mkdtempSync(join(tmpdir(), "alz-paths-tools-"));
process.env.AGENTIC_EVIDENCE_KEY = randomBytes(32).toString("base64");
const servers: Server[] = [];
test.after(() => { for (const server of servers) server.close(); removeTree(scratch); removeTree(toolDir); });
installFakeTerraform(toolDir);
const KILL = join(scratch, "KILL");
const TOKEN = "p".repeat(64);
let counter = 0;
const fresh = (label: string): string => { const dir = join(scratch, label + "-" + ++counter); mkdirSync(dir, { recursive: true }); return dir; };

async function serve(env: NodeJS.ProcessEnv = identityEnv("DEV")): Promise<{ port: number; contractPath: string }> {
  behave(toolDir, KILL, { applyAdvance: true });
  const contractPath = join(fresh("contract"), "act-pilot-contract.json");
  writeReviewedContract(contractPath, contractJson(KILL));
  const vault = fresh("vault");
  await testFixtureForgeQualificationEvidence(vault);
  const { server } = createLocalOperatorServer({
    root: ROOT,
    pilot: {
      token: TOKEN, dialogTimeoutMs: 30_000, approvalsDir: fresh("approvals"),
      cli: { sourceCommit: SOURCE_COMMIT, env, now: () => NOW, operatorId: "operator.fixture", contractPath, qualificationDir: vault,
        evidenceDir: fresh("evidence"), nonces: openNonceStore(fresh("nonces")), scratchParent: fresh("scratch"), toolDirs: [toolDir] },
    },
  });
  servers.push(server);
  await new Promise<void>((done) => { server.listen(0, "127.0.0.1", done); });
  const address = server.address();
  return { port: typeof address === "object" && address ? address.port : 0, contractPath };
}

type Reply = { status: number; body: any; text: string };
function call(port: number, method: string, path: string, options: { body?: unknown; token?: string | null; host?: string } = {}): Promise<Reply> {
  const payload = options.body === undefined ? undefined : JSON.stringify(options.body);
  const headers: Record<string, string> = { Host: options.host ?? "127.0.0.1:" + port, Origin: "http://127.0.0.1:" + port };
  if (options.token !== null) headers[PILOT_TOKEN_HEADER] = options.token ?? TOKEN;
  if (payload !== undefined) { headers["Content-Type"] = "application/json"; headers["Content-Length"] = String(Buffer.byteLength(payload)); }
  return new Promise((done, fail) => {
    const req = request({ host: "127.0.0.1", port, method, path, headers, setHost: false }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let body: unknown;
        try { body = JSON.parse(text); } catch { body = undefined; }
        done({ status: res.statusCode ?? 0, body, text });
      });
    });
    req.on("error", fail);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}
async function preflight(port: number, environment: string): Promise<any> {
  assert.equal((await call(port, "POST", "/pilot/path", { body: { path: "UI" } })).status, 200);
  assert.equal((await call(port, "POST", "/pilot/preflight", { body: { environment } })).status, 202);
  for (let attempt = 0; attempt < 600; attempt += 1) {
    const state = (await call(port, "GET", "/pilot/state")).body;
    if (state.run?.status === "DONE") return state.run.result;
    await new Promise((done) => setTimeout(done, 25));
  }
  throw new Error("preflight never finished");
}
const fingerprint = (path: string): string => createHash("sha256").update(readFileSync(path)).digest("hex") + ":" + statSync(path).mtimeMs;

test("GET /pilot/paths: one entry per journey row, read from journeys.json and status.json the way the release view reads them", async () => {
  const { port } = await serve();
  const reply = await call(port, "GET", "/pilot/paths");
  assert.equal(reply.status, 200, reply.text);
  const report = reply.body;
  assert.equal(report.label, "RELEASE_RECORDS");
  const matrix = checkJourneyMatrix(loadJourneyMatrix(ROOT), ROOT);
  assert.deepEqual(report.paths.map((p: any) => [p.cloud, p.engine, p.journeyStatus, p.liveStatus]), matrix.rows.map((r) => [r.cloud, r.path, r.status, r.live]));
  const gates = (loadReleaseStatus(ROOT) as { gates: { gate: string; status: string; owner: string }[] }).gates;
  for (const path of report.paths) {
    for (const key of ["cloud", "engine", "label", "inRelease", "liveStatus", "journeyStatus", "implemented", "actGate", "blockers", "isContractPath"]) assert.ok(key in path, path.label + " has " + key);
    const gate = gates.find((g) => g.gate === "act:" + path.cloud.toLowerCase() + "-" + path.engine.toLowerCase());
    assert.equal(path.actGate?.status, gate?.status, path.label);
    assert.equal(path.actGate?.owner, gate?.owner, path.label);
    // Nothing is ready before a readiness check, and every path that is not live says why.
    assert.equal(path.isContractPath, false);
    assert.equal(path.decisions, undefined);
    if (path.liveStatus !== "LIVE_PASS") assert.ok(path.blockers.length > 0 && path.blockers.every((b: any) => typeof b.text === "string" && b.text.length > 10), path.label);
  }
  // GCP is not in this release; its rows say so first.
  for (const gcp of report.paths.filter((p: any) => p.cloud === "GCP")) {
    assert.equal(gcp.inRelease, false);
    assert.equal(gcp.actGate, null);
    assert.equal(gcp.blockers[0].party, "RELEASE_SCOPE");
  }
  assert.deepEqual(report.paths.filter((p: any) => p.inRelease).map((p: any) => p.label), ["AWS · Terraform", "AWS · CDK", "Azure · Terraform", "Azure · Bicep"]);
  assert.deepEqual(report.contract, { state: "UNKNOWN" });
  assert.deepEqual(report.environments, []);
});

test("GET /pilot/paths needs the session token and the console's own address, and answers only GET", async () => {
  const { port } = await serve();
  for (const token of [null, "", "x".repeat(64)]) {
    const reply = await call(port, "GET", "/pilot/paths", { token });
    assert.equal(reply.status, 401, String(token));
    assert.equal(reply.body.error, "PILOT_TOKEN_REQUIRED");
    assert.doesNotMatch(reply.text, /TERRAFORM|journey|AWS/);
  }
  const foreign = await call(port, "GET", "/pilot/paths", { host: "attacker.example:80" });
  assert.equal(foreign.status, 403);
  assert.equal(foreign.body.error, "LOCAL_HOST_ONLY");
  const posted = await call(port, "POST", "/pilot/paths", { body: {} });
  assert.equal(posted.status, 404, "there is no POST behind the read-only route");
});

test("GET /pilot/paths is read-only: no file it reads changes, no step starts, and the engine is never called", async () => {
  const { port, contractPath } = await serve();
  const watched = [join(ROOT, "config/acceptance/journeys.json"), join(ROOT, "config/release/status.json"), contractPath];
  const before = watched.map(fingerprint);
  const engineBefore = callsOf(toolDir).length;
  for (let i = 0; i < 3; i += 1) assert.equal((await call(port, "GET", "/pilot/paths")).status, 200);
  assert.deepEqual(watched.map(fingerprint), before);
  assert.equal(callsOf(toolDir).length, engineBefore);
  const state = (await call(port, "GET", "/pilot/state")).body;
  assert.equal(state.run, null, "reading the paths starts no step");
  assert.equal(state.path, null, "reading the paths chooses no path");
  // Structurally: the reader writes nothing, starts nothing and imports nothing of the apply path directly.
  const source = readFileSync(join(ROOT, "src/release/pilot-paths.ts"), "utf8");
  assert.doesNotMatch(source, /\b(?:writeFile|writeFileSync|appendFile|rename|rmSync|unlink|mkdir|spawn|exec|execFile|fork)\w*\s*\(/);
  assert.doesNotMatch(source, /from "\.\.\/apply\//);
  assert.doesNotMatch(source, /node:child_process/);
});

test("after a readiness check, the contract's path carries the three decisions per environment; other environments read not checked", async () => {
  const { port } = await serve();
  const result = await preflight(port, "DEV");
  assert.equal(result.data.ready, true, JSON.stringify(result));
  const report = (await call(port, "GET", "/pilot/paths")).body;
  assert.equal(report.contract.state, "ENABLED");
  assert.equal(report.contract.provider, "AZURE");
  assert.equal(report.contract.engine, "TERRAFORM");
  assert.equal(report.contract.contractSha256, result.data.decisions.contract.contractSha256);
  const contractPaths = report.paths.filter((p: any) => p.isContractPath);
  assert.deepEqual(contractPaths.map((p: any) => p.label), ["Azure · Terraform"]);
  const decisions = contractPaths[0].decisions;
  assert.deepEqual(decisions.map((d: any) => [d.environment, d.authorized, d.ready, d.approved, d.requiredApprovals]),
    [["DEV", true, true, true, 1], ["QA", true, null, true, 1], ["PROD", true, null, true, 2]]);
  assert.deepEqual(report.environments, decisions);
  assert.ok(report.paths.filter((p: any) => !p.isContractPath).every((p: any) => p.decisions === undefined));
  // A failed readiness check for an environment is remembered as not ready, with the items that did not pass.
  const bare = await serve({});
  const red = await preflight(bare.port, "DEV");
  assert.equal(red.data.ready, false);
  const redReport = (await call(bare.port, "GET", "/pilot/paths")).body;
  const dev = redReport.environments.find((d: any) => d.environment === "DEV");
  assert.equal(dev.ready, false);
  assert.ok(dev.notReady.some((item: any) => /identities configured/.test(item.check)), JSON.stringify(dev.notReady));
});

// --- the reader, directly -------------------------------------------------------------------------

const remembered = (over: Partial<RememberedReadiness> & { sha?: string } = {}): RememberedReadiness => ({
  environment: "DEV", ready: true, checks: [{ check: "kill switch absent", ok: true }], checkedAt: "2026-10-28T10:00:00.000Z",
  decisions: {
    act: "PILOT_ENABLED", contract: { contractSha256: over.sha ?? "a".repeat(64), provider: "AWS", engine: "TERRAFORM" },
    authorized: [{ environment: "DEV", operations: ["APPLY", "CLEANUP"] }], approved: [{ environment: "DEV", requiredApprovals: 1 }],
  },
  ...over,
});

test("a readiness result taken against an older contract is not reused: that environment reads not checked", () => {
  const old = remembered({ environment: "QA", sha: "b".repeat(64), checkedAt: "2026-10-28T09:00:00.000Z" });
  const report = deploymentPaths(ROOT, [old, remembered()]);
  assert.equal(report.contract.state, "ENABLED");
  const qa = report.environments.find((d) => d.environment === "QA")!;
  assert.equal(qa.ready, null);
  assert.equal(qa.authorized, false, "the current contract authorizes DEV only");
  assert.equal(report.paths.find((p) => p.isContractPath)?.label, "AWS · Terraform");
});

test("a disabled contract enables no environment and marks no path; malformed readiness output is never remembered", () => {
  const disabled = remembered({ decisions: { act: "DISABLED", contract: { code: "CONTRACT_MISSING", reason: "The pilot contract has not been installed." }, authorized: [], approved: [] } });
  const report = deploymentPaths(ROOT, [disabled]);
  assert.deepEqual(report.contract, { state: "DISABLED", reason: "The pilot contract has not been installed." });
  assert.ok(report.environments.every((d) => !d.authorized && !d.approved && d.ready === null));
  assert.ok(report.paths.every((p) => !p.isContractPath));
  for (const bad of [undefined, null, "READY", {}, { environment: "DEV", ready: "yes", checks: [] }, { environment: "STAGE", ready: true, checks: [], decisions: {} },
    { environment: "DEV", ready: true, checks: [], decisions: { act: "ON", contract: {}, authorized: [], approved: [] } },
    { environment: "DEV", ready: true, checks: ["x"], decisions: { act: "DISABLED", contract: {}, authorized: [], approved: [] } }]) {
    assert.equal(rememberedReadiness(bad, "2026-10-28T10:00:00.000Z"), undefined, JSON.stringify(bad));
  }
  const kept = rememberedReadiness({ environment: "QA", ready: false, checks: [{ check: "c", ok: false, state: "MISSING", responsible: "OWNER", detail: "secret-free" }],
    next: { check: "c", responsible: "OWNER" }, decisions: { act: "PILOT_ENABLED", contract: { contractSha256: "c".repeat(64), provider: "AWS", engine: "CDK", extra: 1 }, authorized: [], approved: [] } }, "t");
  assert.deepEqual(kept, { environment: "QA", ready: false, checks: [{ check: "c", ok: false, responsible: "OWNER" }], checkedAt: "t",
    decisions: { act: "PILOT_ENABLED", contract: { contractSha256: "c".repeat(64), provider: "AWS", engine: "CDK" }, authorized: [], approved: [] } });
});
