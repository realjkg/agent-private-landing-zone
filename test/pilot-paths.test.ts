import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { request, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { openNonceStore } from "../src/apply/nonces.js";
import { PILOT_TOKEN_HEADER } from "../src/cli/ui-channel.js";
import { createLocalOperatorServer } from "../src/operator-ui/server.js";
import { checkJourneyMatrix, loadJourneyMatrix } from "../src/release/acceptance.js";
import { deploymentPaths, livePartyOf, rememberedReadiness, type CurrentContract, type RememberedReadiness } from "../src/release/pilot-paths.js";
import { loadReleaseStatus } from "../src/release/status.js";
import { removeTree } from "../src/teardown/driver/cleanup.js";
import {
  NOW, SOURCE_COMMIT, awsContractJson, behave, callsOf, contractJson, identityEnv, installFakeTerraform, testFixtureForgeQualificationEvidence, writeReviewedContract,
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

async function serve(env: NodeJS.ProcessEnv = identityEnv("DEV")): Promise<{ port: number; contractPath: string; kill: string }> {
  behave(toolDir, KILL, { applyAdvance: true });
  // Each console has its own kill switch file, so engaging one never touches another test's fixture.
  const kill = join(fresh("kill"), "KILL");
  const contractPath = join(fresh("contract"), "act-pilot-contract.json");
  writeReviewedContract(contractPath, contractJson(kill));
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
  return { port: typeof address === "object" && address ? address.port : 0, contractPath, kill };
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
    // Only the contract's path carries decisions, and nothing is ready before a readiness check. Every path that is not live says why.
    assert.equal(path.isContractPath, path.label === "Azure · Terraform", path.label);
    if (!path.isContractPath) assert.equal(path.decisions, undefined);
    if (path.liveStatus !== "LIVE_PASS") assert.ok(path.blockers.length > 0 && path.blockers.every((b: any) => typeof b.text === "string" && b.text.length > 10), path.label);
  }
  // GCP Terraform (act:gcp-terraform) and GCP API-native (act:gcp-gcp_api, INT-2) are release paths and show their real gate status.
  // The API-native row's engine is GCP_API (decision D18), and its display word stays "API-native".
  const gcpTerraform = report.paths.find((p: any) => p.cloud === "GCP" && p.engine === "TERRAFORM");
  assert.equal(gcpTerraform.label, "GCP · Terraform");
  assert.equal(gcpTerraform.inRelease, true);
  assert.deepEqual([gcpTerraform.actGate?.id, gcpTerraform.actGate?.status, gcpTerraform.actGate?.owner], ["act:gcp-terraform", "BLOCKED", "OWNER"]);
  assert.ok(!gcpTerraform.blockers.some((b: any) => b.party === "RELEASE_SCOPE"), "GCP Terraform is in this release");
  assert.ok(gcpTerraform.blockers.some((b: any) => b.source === "GATE" && b.party === "OWNER"), "its gate waits on the owner");
  const gcpApi = report.paths.find((p: any) => p.cloud === "GCP" && p.engine === "GCP_API");
  assert.equal(gcpApi.label, "GCP · API-native");
  assert.equal(gcpApi.inRelease, true);
  assert.deepEqual([gcpApi.actGate?.id, gcpApi.actGate?.status, gcpApi.actGate?.owner], ["act:gcp-gcp_api", "BLOCKED", "OWNER"]);
  assert.ok(!gcpApi.blockers.some((b: any) => b.party === "RELEASE_SCOPE"), "GCP API-native is in this release");
  assert.ok(gcpApi.blockers.some((b: any) => b.source === "GATE" && b.party === "OWNER"), "its gate waits on the owner");
  assert.deepEqual(report.paths.filter((p: any) => p.inRelease).map((p: any) => p.label), ["AWS · Terraform", "AWS · CDK", "Azure · Terraform", "Azure · Bicep", "GCP · Terraform", "GCP · API-native"]);
  // The contract is read as it is now, before any readiness check: known, but nothing ready.
  assert.equal(report.contract.state, "ENABLED");
  assert.equal(report.contract.provider, "AZURE");
  assert.deepEqual(report.environments.map((d: any) => [d.environment, d.authorized, d.ready]), [["DEV", true, null], ["QA", true, null], ["PROD", true, null]]);
  // A live blocker is attributed from the record's own words: Azure Terraform waits on AWS Terraform going live first.
  const live = (label: string) => report.paths.find((p: any) => p.label === label).blockers.find((b: any) => b.source === "JOURNEY");
  assert.equal(live("Azure · Terraform").party, "SEQUENCED");
  assert.equal(live("AWS · CDK").party, "SEQUENCED");
  assert.equal(live("AWS · Terraform").party, "OWNER");
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
  assert.match(decisions[0].checkedAt, /^\d{4}-\d{2}-\d{2}T/, "a READY environment carries the time of the check that said so");
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

// --- a remembered READY never outlives the contract it was checked against (review of #334, B1) ----------------------------

/** Runs a READY readiness check for DEV, changes the world, and returns the paths report afterwards. */
async function afterChange(change: (world: { contractPath: string; kill: string }) => void): Promise<any> {
  const world = await serve();
  const result = await preflight(world.port, "DEV");
  assert.equal(result.data.ready, true, JSON.stringify(result));
  const before = (await call(world.port, "GET", "/pilot/paths")).body;
  assert.equal(before.environments.find((d: any) => d.environment === "DEV").ready, true, "READY before the change");
  change(world);
  const after = await call(world.port, "GET", "/pilot/paths");
  assert.equal(after.status, 200, after.text);
  return after.body;
}
const readyAnywhere = (report: any): boolean => report.environments.some((d: any) => d.ready === true) ||
  report.paths.some((p: any) => (p.decisions ?? []).some((d: any) => d.ready === true));

test("A: once the contract's authorize is emptied, the remembered READY is gone and the contract reads disabled", async () => {
  const report = await afterChange(({ contractPath, kill }) => writeReviewedContract(contractPath, contractJson(kill, { authorize: {} })));
  assert.equal(report.contract.state, "DISABLED");
  assert.equal(readyAnywhere(report), false);
  assert.ok(report.paths.every((p: any) => !p.isContractPath));
  assert.ok(report.environments.every((d: any) => !d.authorized));
});

test("A': once APPLY is no longer authorized for DEV, DEV's remembered READY is dropped even though the hash also moved", async () => {
  const report = await afterChange(({ contractPath, kill }) => writeReviewedContract(contractPath, contractJson(kill, { authorize: { QA: ["APPLY", "CLEANUP"] } })));
  assert.equal(report.contract.state, "ENABLED");
  assert.deepEqual(report.environments.map((d: any) => [d.environment, d.authorized, d.ready]), [["DEV", false, null], ["QA", true, null], ["PROD", false, null]]);
});

test("B: once the kill switch is engaged, no environment reads ready and the contract view says the stop is on", async () => {
  const report = await afterChange(({ kill }) => writeFileSync(kill, ""));
  assert.equal(report.contract.state, "ENABLED");
  assert.equal(report.contract.killSwitch, true);
  assert.equal(readyAnywhere(report), false);
});

test("C: once the contract switches provider, the old path loses its decisions and the new one reads not checked", async () => {
  const report = await afterChange(({ contractPath, kill }) => writeReviewedContract(contractPath, awsContractJson(kill)));
  assert.equal(report.contract.provider, "AWS");
  assert.deepEqual(report.paths.filter((p: any) => p.isContractPath).map((p: any) => p.label), ["AWS · Terraform"]);
  assert.equal(report.paths.find((p: any) => p.label === "Azure · Terraform").decisions, undefined);
  assert.equal(readyAnywhere(report), false);
});

test("D: once the contract file is deleted, the contract reads disabled and nothing is ready", async () => {
  const report = await afterChange(({ contractPath }) => rmSync(contractPath));
  assert.deepEqual(report.contract, { state: "DISABLED", reason: "contract file is missing" });
  assert.equal(readyAnywhere(report), false);
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

const enabled = (over: Partial<Extract<CurrentContract, { act: "PILOT_ENABLED" }>> = {}): CurrentContract => ({
  act: "PILOT_ENABLED", contractSha256: "a".repeat(64), provider: "AWS", engine: "TERRAFORM", killSwitch: false,
  authorized: [{ environment: "DEV", operations: ["APPLY", "CLEANUP"] }], approved: [{ environment: "DEV", requiredApprovals: 1 }], ...over,
});

test("a readiness result taken against an older contract is not reused: that environment reads not checked", () => {
  const old = remembered({ environment: "QA", sha: "b".repeat(64), checkedAt: "2026-10-28T09:00:00.000Z" });
  const report = deploymentPaths(ROOT, [old, remembered()], enabled());
  assert.equal(report.environments.find((d) => d.environment === "DEV")!.ready, true);
  assert.equal(report.contract.state, "ENABLED");
  const qa = report.environments.find((d) => d.environment === "QA")!;
  assert.equal(qa.ready, null);
  assert.equal(qa.authorized, false, "the current contract authorizes DEV only");
  assert.equal(report.paths.find((p) => p.isContractPath)?.label, "AWS · Terraform");
});

test("a disabled contract enables no environment and marks no path; malformed readiness output is never remembered", () => {
  const disabled = remembered({ decisions: { act: "DISABLED", contract: { code: "CONTRACT_MISSING", reason: "The pilot contract has not been installed." }, authorized: [], approved: [] } });
  const report = deploymentPaths(ROOT, [disabled, remembered()], { act: "DISABLED", reason: "The pilot contract has not been installed." });
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

test("without the current contract the view is unknown, and a remembered READY alone is never shown", () => {
  const report = deploymentPaths(ROOT, [remembered()]);
  assert.deepEqual(report.contract, { state: "UNKNOWN" });
  assert.deepEqual(report.environments, []);
  assert.ok(report.paths.every((p) => !p.isContractPath && p.decisions === undefined));
  // The kill switch in the contract as it is now drops every remembered result, whatever its own report said.
  const stopped = deploymentPaths(ROOT, [remembered()], enabled({ killSwitch: true }));
  assert.ok(stopped.environments.every((d) => d.ready === null));
});

test("a missing release status reads as readiness unknown, never as out of this release (review of #334, N5)", () => {
  const bare = mkdtempSync(join(tmpdir(), "alz-paths-root-"));
  try {
    mkdirSync(join(bare, "config/acceptance"), { recursive: true });
    copyFileSync(join(ROOT, "config/acceptance/journeys.json"), join(bare, "config/acceptance/journeys.json"));
    const report = deploymentPaths(bare, [], enabled());
    for (const label of ["AWS · Terraform", "AWS · CDK", "Azure · Terraform", "Azure · Bicep", "GCP · Terraform", "GCP · API-native"]) {
      const path = report.paths.find((p) => p.label === label)!;
      assert.equal(path.inRelease, true, label);
      assert.equal(path.actGate, null, label);
      assert.ok(path.blockers.some((b) => b.party === "UNKNOWN" && /Readiness unknown/.test(b.text)), label);
      assert.ok(!path.blockers.some((b) => b.party === "RELEASE_SCOPE"), label);
    }
    // Every row is one of the code's release paths now (GCP API-native since INT-2), so none reads as out of this release.
    assert.deepEqual(report.paths.filter((p) => !p.inRelease).map((p) => p.label), []);
  } finally { removeTree(bare); }
});

test("live blockers are attributed from the record's own words", () => {
  assert.equal(livePartyOf("AWS Terraform goes live first. Then owner inputs for Azure."), "SEQUENCED");
  assert.equal(livePartyOf("AWS Terraform must pass live first (focus row), then owner inputs."), "SEQUENCED");
  assert.equal(livePartyOf("Owner supervision and inputs: a pinned contract."), "OWNER");
  assert.equal(livePartyOf("The owner-authorized G2 DEV run."), "OWNER");
  assert.equal(livePartyOf("No ARM emulator exists yet."), "ENGINEERING");
});
