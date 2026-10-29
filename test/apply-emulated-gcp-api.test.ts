import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";

import { signApproval } from "../src/apply/approval.js";
import { buildCleanupProposal, signCleanupProposal, type CleanupProposal } from "../src/apply/cleanup-proposal.js";
import { loadPilotContract, pilotContractSha256, writeQualificationEvidence } from "../src/apply/contract.js";
import { runApply, runCleanup, sealPreview, type ApplyDeps } from "../src/apply/driver.js";
import { engineOf, engineSpec } from "../src/apply/engine-spec.js";
import { GCP_API, GCP_API_ENGINE_VERSION, gcpApiEngine, type GcpHttp } from "../src/apply/engines/gcp-api.js";
import { GCP_API_BACKEND_SENTINEL } from "../src/apply/gcp-api-target.js";
import { openNonceStore } from "../src/apply/nonces.js";
import { loadRunRecords, observeRun, verifyProposalLeftovers, type ObserveDeps } from "../src/apply/observe.js";
import { GCP } from "../src/apply/providers/gcp.js";
import { readBlueprintRecord, verificationOf } from "../src/apply/run-records.js";
import { readCleanupEvidence } from "../src/apply/ledger.js";
import { buildLifecycleReport, lifecycleReportProblems } from "../src/apply/lifecycle-report.js";
import { readAppliedEvidence } from "../src/apply/live-record.js";
import { loadSealedPlan } from "../src/apply/seal.js";
import type { PilotContract, SignedApproval } from "../src/apply/types.js";
import { pilotUnitOf } from "../src/apply/unit.js";
import type { ResolvedTarget } from "../src/teardown/driver/types.js";
import { buildManifest, canonicalJson } from "../src/teardown/manifest.js";
import { captureProjectFiles } from "../src/teardown/snapshot.js";
import { sha256 } from "../src/util/sha256.js";
import { NOW, REQUESTER, SOURCE_COMMIT, approvalFor, approvers, human, keys, writeReviewedContract } from "./helpers/apply-fixtures.js";
import { startGcpApiEmulator, writeIdentities, type GcpApiEmulator } from "./helpers/gcp-api-emulator.js";

/**
 * EMULATED (docs/act-pilot-gcp-api.md, "Evidence"; INT-2, #357 review N3). Path 6, end to end, through the real driver over a loopback
 * Google: `sealPreview`, `runApply`, `observeRun`, `buildCleanupProposal` and `signCleanupProposal`, `runCleanup` and
 * `verifyProposalLeftovers`, with a reviewed GCP_API contract the product loads and authorizes itself. The registered GCP_API spec is the
 * one the driver runs; only its HTTP client is the emulator's (test/helpers/gcp-api-emulator.ts: STS, IAM Credentials, Pub/Sub and
 * Cloud Asset with D12's custom roles, each request on a fresh connection). No Google endpoint is contacted, and nothing here re-implements
 * a driver step.
 *
 * The qualification evidence below is FORGED for the emulator (no person attests an emulator run), so the gates that read it run for real
 * on it. This is never live provider qualification: IAM, scopes and request shapes Google accepts, Cloud Asset's indexing delay and label
 * query syntax, quotas and latency are not shown by an emulator (GF1 to GF11). The repository ships no contract: ACT stays DISABLED.
 */

const PROJECT = "examplefake-dev";
const REGION = "europe-west4";
const PREFIX = "alz-act-dev1-";
const AUDIENCE = "//iam.googleapis.com/projects/123456789012/locations/global/workloadIdentityPools/alz-pilot-dev/providers/oidc";
const TARGET: ResolvedTarget = { account: PROJECT, backend: GCP_API_BACKEND_SENTINEL, workspace: "default" };
const POLICY = "2026-10-29.1";

describe("EMULATED: GCP API-native through the real driver over a loopback Google: seal, approve, apply, observe, propose-cleanup, cleanup, verify-cleanup", () => {
  const root = mkdtempSync(join(tmpdir(), "alz-gcp-api-em-"));
  const previousCwd = process.cwd();
  const previousKey = process.env.AGENTIC_EVIDENCE_KEY;
  // The registered spec as it was, restored after: the driver runs `GCP_API` itself, with the emulator's HTTP client in it.
  const registered = { ...GCP_API };
  let emulator: GcpApiEmulator;
  let env: NodeJS.ProcessEnv;
  let email: (name: string) => string;
  let subjects: string[];
  let contractPath: string;
  let vault: string;
  let killPath: string;
  /** What every request the engine and the reader send passes through first: a test can act at one request (the N1 interrupt). */
  let onRequest: ((request: Parameters<GcpHttp>[0]) => void) | undefined;
  const fresh = (name: string): string => { const dir = join(root, name + "-" + randomBytes(3).toString("hex")); mkdirSync(dir, { recursive: true, mode: 0o700 }); return dir; };
  const http: GcpHttp = (request) => { onRequest?.(request); return emulator.http(request); };

  before(async () => {
    process.env.AGENTIC_EVIDENCE_KEY = randomBytes(32).toString("base64");
    process.chdir(root); // the vault writes sealed plans under ./.runs
    const ids = writeIdentities(fresh("identities"), PROJECT, AUDIENCE);
    env = { ...ids.env };
    for (const name of ["DISCOVERY", "APPLY"]) { env["ALZ_" + name + "_GOOGLE_PROJECT"] = PROJECT; env["ALZ_" + name + "_GOOGLE_REGION"] = REGION; }
    email = ids.email;
    subjects = Object.values(ids.subjectOf);
    emulator = await startGcpApiEmulator(ids.trust, {
      [email("DISCOVERY")]: ["pubsub.topics.get", "cloudasset.assets.searchAllResources"],
      [email("APPLY")]: ["pubsub.topics.create", "pubsub.topics.delete"],
    });
    Object.assign(GCP_API, gcpApiEngine({ http, settleDelayMs: 20 }));
    killPath = join(root, "KILL");
    contractPath = join(fresh("contract"), "act-pilot-contract.json");
    writeReviewedContract(contractPath, {
      schemaVersion: 1, enabled: true, provider: "GCP", engine: "GCP_API", enabledEnvironments: ["DEV"],
      targets: { DEV: { projectId: PROJECT, region: REGION, parent: "folders/123456789", backend: GCP_API_BACKEND_SENTINEL, workspace: "default", topicPrefix: PREFIX, canary: { resources: [{ type: "google_pubsub_topic", count: 1 }] } } },
      requiredApprovals: { DEV: 1 }, maxApprovalAgeMinutes: 60, approvers, killSwitchPath: killPath, authorize: { DEV: ["APPLY", "CLEANUP"] },
    });
    // FORGED qualification evidence for the emulator, one per adapter, bound to this module closure and these two service accounts.
    vault = fresh("qualification");
    for (const adapter of [GCP_API.previewAdapter(), GCP_API.applyAdapter, GCP_API.cleanupAdapter!]) {
      const written = await writeQualificationEvidence({
        schemaVersion: 1, engine: "GCP_API", realEngine: true, backendIdentitySeparated: true, projectId: PROJECT, region: REGION, backend: GCP_API_BACKEND_SENTINEL, workspace: "default",
        stateWriteClientId: email("DISCOVERY"), applyClientId: email("APPLY"), terraformSha256: GCP_API.binarySha256(undefined, env)!, adapterVersion: adapter.adapterVersion, argvDigest: adapter.argvDigest,
        engineVersion: GCP_API_ENGINE_VERSION, qualifiedAt: "2026-10-11T00:00:00.000Z",
      } as never, GCP, vault);
      assert.ok(written.ok, JSON.stringify(written));
    }
  });

  after(async () => {
    Object.assign(GCP_API, registered);
    await emulator?.close();
    process.chdir(previousCwd);
    if (previousKey === undefined) delete process.env.AGENTIC_EVIDENCE_KEY; else process.env.AGENTIC_EVIDENCE_KEY = previousKey;
    rmSync(root, { recursive: true, force: true });
  });

  // --- fixtures -------------------------------------------------------------------------------------------------------------

  type World = { deps: ApplyDeps; observe(at?: number): ObserveDeps };
  function world(): World {
    const evidenceDir = fresh("evidence");
    const deps: ApplyDeps = {
      sourceCommit: SOURCE_COMMIT, contractPath, qualificationDir: vault, evidenceDir, nonces: openNonceStore(fresh("nonces")), env, now: () => NOW,
      scratchParent: fresh("scratch"), killPollMs: 40, killGraceMs: 400,
    };
    return { deps, observe: (at = 60_000) => ({ contractPath, evidenceDir, env, scratchParent: deps.scratchParent, now: () => new Date(NOW.getTime() + at), gcp: http }) };
  }
  const contract = (): PilotContract => loadPilotContract(contractPath) as PilotContract;
  const unit = () => pilotUnitOf({ provider: "GCP", contractSha256: pilotContractSha256(contract()), environment: "DEV", target: TARGET, engine: "GCP_API" });
  function project() {
    const projectRoot = fresh("project");
    writeFileSync(join(projectRoot, "request.json"), JSON.stringify({ schemaVersion: 1, kind: "PUBSUB_TOPIC" }) + "\n");
    const resolved = { engineVersion: GCP_API_ENGINE_VERSION, providers: [], dependencies: [], inputs: [] };
    const manifest = buildManifest({ engine: "GCP_API", mode: "PROJECT", target: TARGET, unitHash: "1".repeat(64), files: captureProjectFiles(projectRoot), policyVersion: POLICY, ...resolved } as never);
    return { projectRoot, manifest, resolved };
  }
  const sealRequest = (p: ReturnType<typeof project>) => ({ invocation: human(TARGET), environment: "DEV" as const, target: { ...TARGET }, manifest: p.manifest, projectRoot: p.projectRoot, policyVersion: POLICY, resolved: p.resolved as never, requester: REQUESTER });
  async function seal(w: World) {
    const p = project();
    const result = await sealPreview(sealRequest(p), w.deps);
    assert.ok(result.ok, JSON.stringify(result));
    const loaded = await loadSealedPlan(result.path);
    assert.ok(loaded.ok);
    return { sealed: result.sealed, project: p, loaded: { sealed: loaded.sealed, planBytes: loaded.planBytes } };
  }
  type Sealed = Awaited<ReturnType<typeof seal>>;
  const apply = (w: World, s: Sealed, approvals: SignedApproval[] = [approvalFor(s.sealed, "alice")]) => runApply({
    invocation: human(TARGET), environment: "DEV", target: { ...TARGET }, sealedPlan: s.loaded, manifest: s.project.manifest, projectRoot: s.project.projectRoot, approvals,
  }, w.deps);
  const cleanupApproval = (proposal: CleanupProposal, who: keyof typeof keys): SignedApproval => signApproval({
    schemaVersion: 1, artifactSha256: proposal.proposalSha256, environment: proposal.environment, target: proposal.target, approverId: who,
    issuedAt: new Date(NOW.getTime() - 5 * 60_000).toISOString(), expiresAt: new Date(NOW.getTime() + 25 * 60_000).toISOString(), nonce: randomBytes(16).toString("hex"),
  }, keys[who].priv, "CLEANUP");
  const cleanup = (w: World, s: Sealed, proposal: CleanupProposal, approvals: SignedApproval[]) => runCleanup({
    invocation: human(TARGET), environment: "DEV", target: { ...TARGET }, proposal, sealedPlan: s.loaded, manifest: s.project.manifest, projectRoot: s.project.projectRoot, approvals,
  }, w.deps);
  async function propose(w: World, s: Sealed) {
    const records = await loadRunRecords(s.sealed.artifactSha256, w.deps.evidenceDir!);
    assert.ok(records.ok, JSON.stringify(records));
    return buildCleanupProposal({ requesterId: REQUESTER.requesterId, ...records, changes: s.sealed.changes, channel: "CLI", contract: contract(), engineVersion: s.sealed.engineVersion, env, now: new Date(NOW.getTime() + 120_000) });
  }
  const topicIdOf = (s: Sealed): string => s.sealed.changes[0].address.slice("google_pubsub_topic.".length);
  const nameOf = (s: Sealed): string => "projects/" + PROJECT + "/topics/" + topicIdOf(s);
  const noSecrets = (value: unknown): void => {
    const text = JSON.stringify(value, (_key, v) => (Buffer.isBuffer(v) ? v.toString("utf8") : v));
    for (const subject of subjects) assert.ok(!text.includes(subject), "a subject token leaked");
    assert.ok(!/\b(?:fed|sa)-[0-9a-f]{24}\b/.test(text), "an emulated access token leaked");
  };

  // --- registration and admission -----------------------------------------------------------------------------------------------

  test("the reviewed GCP_API contract loads, DEV only, and the driver runs the registered GCP_API spec (never GCP Terraform)", () => {
    const loaded = loadPilotContract(contractPath);
    assert.ok(!("reason" in loaded), JSON.stringify(loaded));
    assert.equal(engineOf(loaded as PilotContract), GCP_API);
    assert.equal(engineSpec("GCP_API"), GCP_API);
    assert.notEqual(engineSpec("TERRAFORM"), GCP_API);
    assert.deepEqual((loaded as PilotContract).enabledEnvironments, ["DEV"]);
  });

  // --- the path ---------------------------------------------------------------------------------------------------------------

  test("the whole path for one run through the real driver, and the replay and reuse refusals", async () => {
    emulator.topics.clear();
    const w = world();
    // Seal: one CREATE of the full sealed name under the engine's own unit (D10), the module hash sealed (D1).
    const s = await seal(w);
    assert.deepEqual(s.sealed.changes, [{ address: "google_pubsub_topic." + topicIdOf(s), type: "google_pubsub_topic", action: "CREATE" }]);
    assert.match(topicIdOf(s), /^alz-act-dev1-[0-9a-f]{12}$/);
    assert.equal(s.sealed.unit?.unitId, unit().unitId);
    assert.notEqual(s.sealed.unit?.unitId, pilotUnitOf({ provider: "GCP", contractSha256: s.sealed.contractSha256, environment: "DEV", target: TARGET }).unitId, "not the Terraform path's unit");
    assert.equal(s.sealed.provenance.engineBinarySha256, GCP_API.binarySha256(undefined, env), "D1: the module closure's hash is sealed");
    assert.equal(s.sealed.provenance.qualification.state, "QUALIFIED");
    assert.equal(emulator.topics.size, 0, "a seal creates nothing");
    noSecrets(s.sealed);

    // Apply: one PUT as APPLY, the evidence with this path's own mutation value and the verified storage policy (D11).
    const approvals = [approvalFor(s.sealed, "alice")];
    const applied = await apply(w, s, approvals);
    assert.ok(applied.ok, JSON.stringify(applied));
    assert.equal(applied.evidence.outcome, "SUCCEEDED");
    assert.equal(applied.evidence.authority.mutation, "GCP_PUBSUB_TOPIC_CREATE_OF_SEALED_REQUEST");
    assert.deepEqual(applied.evidence.verifiedProperty, { name: "messageStoragePolicy.allowedPersistenceRegions", value: [REGION] });
    assert.equal(applied.evidence.decisions.ready.engineBinarySha256, GCP_API.binarySha256(undefined, env));
    assert.match(String(applied.evidence.decisions.ready.qualificationEvidenceHash), /^[0-9a-f]{64}$/);
    assert.deepEqual(emulator.topics.get(nameOf(s)), { name: nameOf(s), labels: { ...unit().tags }, messageStoragePolicy: { allowedPersistenceRegions: [REGION] } });
    const puts = emulator.log().filter((e) => e.method === "PUT");
    assert.deepEqual(puts.map((e) => [e.path, e.sa]), [["/v1/" + nameOf(s), email("APPLY")]]);
    // The driver kept the blueprint from what settle read (D6), under the GCP_API_TOPIC source.
    const blueprint = await readBlueprintRecord(s.sealed.artifactSha256, sha256(canonicalJson(applied.evidence as never)), w.deps.evidenceDir!);
    assert.ok(blueprint);
    assert.equal(blueprint.source, "GCP_API_TOPIC");
    assert.equal(blueprint.unitId, unit().unitId);
    // Source-bound: the seal, the apply evidence and the blueprint name the product commit that sealed and ran the plan.
    assert.deepEqual([s.sealed.sourceCommit, applied.evidence.sourceCommit, blueprint.sourceCommit], [SOURCE_COMMIT, SOURCE_COMMIT, SOURCE_COMMIT]);
    assert.deepEqual(blueprint.blueprint.entries.map((e) => [e.address, e.type, e.id, e.origin]), [[s.sealed.changes[0].address, "google_pubsub_topic", nameOf(s), "IN_PLAN"]]);

    // Replay: the ledger refuses the same artifact, and the same approvals are spent.
    const again = await apply(w, s, approvals);
    assert.ok(!again.ok);
    assert.equal(emulator.log().filter((e) => e.method === "PUT").length, 1, "never sent again");

    // Observe through GCP_REST as DISCOVERY: VERIFIED, the unit sweep complete.
    const observation = await observeRun(s.sealed.artifactSha256, w.observe());
    assert.ok(observation.ok, JSON.stringify(observation));
    assert.equal(observation.record.verifier, "GCP_REST");
    assert.equal(observation.record.verdict, "VERIFIED");
    assert.equal(observation.record.sourceCommit, SOURCE_COMMIT);
    assert.equal(observation.report.sweepControl, "PASSED");
    assert.equal(observation.record.sweepControlPassedAt, observation.record.observedAt, "the sweep listed the run's own topic: the control passed");
    assert.equal(observation.record.inventory, "COMPLETE");
    assert.deepEqual(observation.record.unexpected, []);

    // Propose the cleanup: exactly the run's topic, by its full name.
    const built = await propose(w, s);
    assert.ok(built.ok, JSON.stringify(built));
    const proposal = signCleanupProposal(built.proposal, REQUESTER.privateKeyPem);
    assert.equal(proposal.engine, "GCP_API");
    assert.deepEqual(proposal.deletes.map((d) => [d.address, d.identifier, d.observed]), [[s.sealed.changes[0].address, nameOf(s), "VERIFIED"]]);
    noSecrets(proposal);

    // An apply approval is never a cleanup approval.
    const wrongDomain = await cleanup(w, s, proposal, [approvalFor(s.sealed, "carol")]);
    assert.ok(!wrongDomain.ok);
    assert.equal(emulator.log().filter((e) => e.method === "DELETE").length, 0);

    // Clean up: one DELETE as APPLY; the evidence names this path's cleanup mutation and that this run deleted the topic.
    const cleanupApprovals = [cleanupApproval(proposal, "alice")];
    const cleaned = await cleanup(w, s, proposal, cleanupApprovals);
    assert.ok(cleaned.ok, JSON.stringify(cleaned));
    assert.deepEqual(cleaned.evidence.deletes, [s.sealed.changes[0].address]);
    assert.equal(cleaned.evidence.authority.mutation, "GCP_PUBSUB_TOPIC_DELETE_OF_RUN_TOPIC");
    assert.equal(cleaned.evidence.deletedByRun, true);
    assert.equal(emulator.topics.size, 0);
    assert.deepEqual(emulator.log().filter((e) => e.method === "DELETE").map((e) => [e.path, e.sa]), [["/v1/" + nameOf(s), email("APPLY")]]);
    const replayed = await cleanup(w, s, proposal, cleanupApprovals);
    assert.ok(!replayed.ok, "the proposal runs once");

    // Verify the cleanup independently, as DISCOVERY: the id reads absent and the unit lists nothing, completely.
    const leftovers = await verifyProposalLeftovers(proposal, w.observe(600_000));
    assert.ok(leftovers.ok, JSON.stringify(leftovers));
    assert.equal(leftovers.record.verifier, "GCP_REST");
    const topic = leftovers.record.resources.find((r) => r.address === s.sealed.changes[0].address)!;
    assert.deepEqual([topic.disposition, topic.basis], ["CONFIRMED_DELETED", "GCP_REST_ABSENT"]);
    // #359 review N1: an observation of this run passed the sweep's positive control, so "no strays" is PROVEN and the record is clean.
    assert.deepEqual([leftovers.record.strays, leftovers.record.disposition, leftovers.record.sweep], ["PROVEN", "COMPLETE", "COMPLETE"]);
    noSecrets([applied, observation, cleaned, leftovers]);
    // Every request went to one of the four emulated Google hosts; DISCOVERY only read and APPLY only created and deleted.
    for (const e of emulator.log()) assert.ok(!e.refused, JSON.stringify(e));
    assert.ok(emulator.log().filter((e) => e.sa === email("DISCOVERY")).every((e) => e.method === "GET"));
    assert.ok(emulator.log().filter((e) => e.sa === email("APPLY")).every((e) => e.method === "PUT" || e.method === "DELETE"));
  });

  test("the kill switch, set after the approvals are consumed, stops the apply before the PUT; the same plan then applies with new approvals", async () => {
    emulator.topics.clear();
    const w = world();
    const s = await seal(w);
    // The switch appears as APPLY's token is minted, inside execute: after consumption, before anything is sent to Pub/Sub.
    onRequest = (request) => { if (request.url.includes(":generateAccessToken") && request.url.includes(email("APPLY"))) writeFileSync(killPath, "stop\n"); };
    let killed;
    try { killed = await apply(w, s); } finally { onRequest = undefined; rmSync(killPath, { force: true }); }
    assert.ok(!killed.ok && killed.code === "KILL_SWITCH_AFTER_APPROVALS", JSON.stringify(killed));
    assert.equal(emulator.topics.size, 0);
    assert.equal(emulator.log().filter((e) => e.method === "PUT" && e.path === "/v1/" + nameOf(s)).length, 0);
    const applied = await apply(w, s, [approvalFor(s.sealed, "bob")]);
    assert.ok(applied.ok && applied.evidence.outcome === "SUCCEEDED", JSON.stringify(applied));
    assert.deepEqual([...emulator.topics.keys()], [nameOf(s)], "the same sealed name (D4)");
    emulator.topics.clear();
  });

  test("#357 review N1: a signal during APPLY's token exchange stops execute before the PUT (APPROVALS_SPENT); the same plan then applies with new approvals", async () => {
    emulator.topics.clear();
    const w = world();
    const s = await seal(w);
    // The interrupt arrives while APPLY's token is minted: the driver's handler records it, and the engine's next stop point sees it.
    let signaled = 0;
    onRequest = (request) => { if (request.url.includes(":generateAccessToken") && request.url.includes(email("APPLY")) && signaled === 0) { signaled += 1; process.emit("SIGINT", "SIGINT"); } };
    let interrupted;
    try { interrupted = await apply(w, s); } finally { onRequest = undefined; }
    assert.equal(signaled, 1, "the signal was sent during the APPLY token exchange");
    assert.ok(!interrupted.ok && interrupted.code === "APPROVALS_SPENT", JSON.stringify(interrupted));
    assert.match(interrupted.message, /interrupted by a signal before the engine sent anything/);
    assert.equal(emulator.log().filter((e) => e.method === "PUT" && e.path === "/v1/" + nameOf(s)).length, 0, "no PUT was sent");
    assert.equal(emulator.topics.size, 0);
    const applied = await apply(w, s, [approvalFor(s.sealed, "bob")]);
    assert.ok(applied.ok && applied.evidence.outcome === "SUCCEEDED", JSON.stringify(applied));
    emulator.topics.clear();
  });

  test("#357 review N1, cleanup: a signal during APPLY's token exchange stops the cleanup before the DELETE (APPROVALS_SPENT); the proposal then runs with new approvals", async () => {
    emulator.topics.clear();
    const w = world();
    const s = await seal(w);
    const applied = await apply(w, s);
    assert.ok(applied.ok, JSON.stringify(applied));
    assert.ok((await observeRun(s.sealed.artifactSha256, w.observe())).ok);
    const built = await propose(w, s);
    assert.ok(built.ok, JSON.stringify(built));
    const proposal = signCleanupProposal(built.proposal, REQUESTER.privateKeyPem);
    let signaled = 0;
    onRequest = (request) => { if (request.url.includes(":generateAccessToken") && request.url.includes(email("APPLY")) && signaled === 0) { signaled += 1; process.emit("SIGINT", "SIGINT"); } };
    let interrupted;
    try { interrupted = await cleanup(w, s, proposal, [cleanupApproval(proposal, "alice")]); } finally { onRequest = undefined; }
    assert.equal(signaled, 1);
    assert.ok(!interrupted.ok && interrupted.code === "APPROVALS_SPENT", JSON.stringify(interrupted));
    assert.match(interrupted.message, /interrupted by a signal before the engine sent anything/);
    assert.equal(emulator.log().filter((e) => e.method === "DELETE" && e.path === "/v1/" + nameOf(s)).length, 0, "no DELETE was sent");
    assert.deepEqual([...emulator.topics.keys()], [nameOf(s)]);
    const cleaned = await cleanup(w, s, proposal, [cleanupApproval(proposal, "bob")]);
    assert.ok(cleaned.ok && cleaned.evidence.deletedByRun === true, JSON.stringify(cleaned));
    assert.equal(emulator.topics.size, 0);
  });

  test("#358 review N2 through the real driver: until Cloud Asset lists the run's own topic, observe is INCONCLUSIVE (inventory INCOMPLETE), never VERIFIED; once it is listed, VERIFIED", async () => {
    emulator.topics.clear();
    const w = world();
    const s = await seal(w);
    const applied = await apply(w, s);
    assert.ok(applied.ok, JSON.stringify(applied));
    // GF5's window, or a query that matches nothing: the topic exists and reads present, but the sweep does not list it.
    emulator.behave({ unindexed: [nameOf(s)] });
    let early;
    try { early = await observeRun(s.sealed.artifactSha256, w.observe()); } finally { emulator.behave({}); }
    assert.ok(early.ok, JSON.stringify(early));
    assert.deepEqual([early.record.verdict, early.record.inventory, early.record.unexpected], ["INCONCLUSIVE", "INCOMPLETE", []]);
    assert.deepEqual(early.report.sweepNotListing, [nameOf(s)]);
    assert.equal(early.record.resources[0].result, "VERIFIED", "the topic's own read is still positive");
    // Indexed: observe again (a new record), and the control holds.
    const later = await observeRun(s.sealed.artifactSha256, w.observe(300_000));
    assert.ok(later.ok, JSON.stringify(later));
    assert.deepEqual([later.record.verdict, later.record.inventory, later.report.sweepNotListing], ["VERIFIED", "COMPLETE", undefined]);
    emulator.topics.clear();
  });

  test("#359 review N1 through the real driver: when no observation of the run ever passed the sweep's positive control, verify-cleanup records \"no strays\" UNPROVEN, never COMPLETE, and the lifecycle report's leftovers stage is not PASS; a pass is carried forward", async () => {
    emulator.topics.clear();
    const w = world();
    const s = await seal(w);
    const applied = await apply(w, s);
    assert.ok(applied.ok, JSON.stringify(applied));
    // Cloud Asset never lists the topic (a query Google accepts but that matches nothing looks the same): every observation is INCONCLUSIVE.
    emulator.behave({ unindexed: [nameOf(s)] });
    let left;
    let proposal: CleanupProposal;
    try {
      const observed = await observeRun(s.sealed.artifactSha256, w.observe());
      assert.ok(observed.ok, JSON.stringify(observed));
      assert.deepEqual([observed.record.verdict, observed.report.sweepControl, observed.record.sweepControlPassedAt], ["INCONCLUSIVE", "NOT_PASSED", null]);
      // The coordinator's decision: cleanup does not wait for the sweep. The run's own verified topic is proposed and deleted.
      const built = await propose(w, s);
      assert.ok(built.ok, JSON.stringify(built));
      proposal = signCleanupProposal(built.proposal, REQUESTER.privateKeyPem);
      const cleaned = await cleanup(w, s, proposal, [cleanupApproval(proposal, "alice")]);
      assert.ok(cleaned.ok && cleaned.evidence.deletedByRun === true, JSON.stringify(cleaned));
      left = await verifyProposalLeftovers(proposal, w.observe(600_000));
    } finally { emulator.behave({}); }
    assert.ok(left.ok, JSON.stringify(left));
    // Every proposed resource is confirmed gone and the sweep is complete and empty, but nothing shows the query matches: UNPROVEN.
    assert.deepEqual(left.record.resources.map((r) => r.disposition), ["CONFIRMED_DELETED"]);
    assert.deepEqual([left.record.strays, left.record.sweep, left.record.disposition], ["UNPROVEN", "COMPLETE", "INCOMPLETE"]);
    assert.match(left.record.nextAction, /"no strays" is UNPROVEN/);
    assert.match(left.record.nextAction, /not a clean leftovers result/);
    // The lifecycle report never presents it as a pass.
    const records = await loadRunRecords(s.sealed.artifactSha256, w.deps.evidenceDir!);
    assert.ok(records.ok);
    const report = buildLifecycleReport({
      gateId: "act:gcp-gcp_api", provider: "GCP", engine: "GCP_API", applyEvidence: records.applyEvidence, observation: records.observation, proposal: proposal!,
      cleanup: await readCleanupEvidence(proposal!.proposalSha256, w.deps.evidenceDir!), leftovers: left.record, live: undefined, now: new Date(NOW.getTime() + 700_000),
    });
    assert.equal(report.stages.leftovers.status, "INCONCLUSIVE");
    assert.equal(report.passed, false);
    assert.deepEqual(lifecycleReportProblems(report), []);

    // A second run that passed the control once keeps the proof through a later observation that does not pass it.
    emulator.topics.clear();
    const t = await seal(w);
    assert.ok((await apply(w, t)).ok);
    const first = await observeRun(t.sealed.artifactSha256, w.observe());
    assert.ok(first.ok && first.report.sweepControl === "PASSED");
    emulator.behave({ unindexed: [nameOf(t)] });
    let second;
    try { second = await observeRun(t.sealed.artifactSha256, w.observe(120_000)); } finally { emulator.behave({}); }
    assert.ok(second.ok);
    assert.equal(second.report.sweepControl, "NOT_PASSED");
    assert.equal(second.record.sweepControlPassedAt, first.record.observedAt, "the earlier pass is carried forward");
    emulator.topics.clear();
  });

  test("#358 review N3, D14 through the real driver: a definite refusal of the PUT with the topic absent on every read is FAILED_NO_CHANGE; the plan is spent, nothing was created, and no cleanup is proposed", async () => {
    emulator.topics.clear();
    const w = world();
    const s = await seal(w);
    emulator.behave({ put: { status: 403 } });
    let refused;
    try { refused = await apply(w, s); } finally { emulator.behave({}); }
    assert.ok(!refused.ok && refused.code === "APPLY_FAILED" && refused.outcome === "FAILED_NO_CHANGE", JSON.stringify(refused));
    assert.equal(emulator.topics.size, 0);
    assert.equal(emulator.log().filter((e) => e.method === "PUT" && e.path === "/v1/" + nameOf(s)).length, 1, "the PUT was sent once, never retried");
    const evidence = await readAppliedEvidence(s.sealed.artifactSha256, w.deps.evidenceDir!);
    assert.ok(evidence);
    assert.deepEqual([evidence.outcome, evidence.authority.mutation, evidence.verifiedProperty], ["FAILED_NO_CHANGE", "GCP_PUBSUB_TOPIC_CREATE_OF_SEALED_REQUEST", undefined]);
    // The ledger holds the artifact: the same plan never applies again, even with new approvals.
    const again = await apply(w, s, [approvalFor(s.sealed, "bob")]);
    assert.ok(!again.ok);
    assert.equal(emulator.log().filter((e) => e.method === "PUT" && e.path === "/v1/" + nameOf(s)).length, 1);
    // A new seal is a new name, and it applies.
    const next = await seal(w);
    assert.notEqual(topicIdOf(next), topicIdOf(s));
    const applied = await apply(w, next);
    assert.ok(applied.ok && applied.evidence.outcome === "SUCCEEDED", JSON.stringify(applied));
    emulator.topics.clear();
  });

  test("#358 review N3, D16 through the real driver: a DELETE answered 404 (the topic gone when it arrived) is SUCCEEDED with deletedByRun false, never claimed as this run's deletion", async () => {
    emulator.topics.clear();
    const w = world();
    const s = await seal(w);
    const applied = await apply(w, s);
    assert.ok(applied.ok, JSON.stringify(applied));
    assert.ok((await observeRun(s.sealed.artifactSha256, w.observe())).ok);
    const built = await propose(w, s);
    assert.ok(built.ok, JSON.stringify(built));
    const proposal = signCleanupProposal(built.proposal, REQUESTER.privateKeyPem);
    // The topic is removed between cleanup's read (present and unchanged) and its DELETE, which then answers 404.
    emulator.behave({ delete: { status: 404, remove: true } });
    let cleaned;
    try { cleaned = await cleanup(w, s, proposal, [cleanupApproval(proposal, "alice")]); } finally { emulator.behave({}); }
    assert.ok(cleaned.ok, JSON.stringify(cleaned));
    assert.equal(cleaned.evidence.authority.mutation, "GCP_PUBSUB_TOPIC_DELETE_OF_RUN_TOPIC");
    assert.equal(cleaned.evidence.deletedByRun, false, "a 404 never supports \"this run deleted it\"");
    assert.equal(emulator.log().filter((e) => e.method === "DELETE" && e.path === "/v1/" + nameOf(s)).length, 1);
    assert.equal(emulator.topics.size, 0);
    // The independent check still confirms the absence.
    const leftovers = await verifyProposalLeftovers(proposal, w.observe(600_000));
    assert.ok(leftovers.ok, JSON.stringify(leftovers));
    assert.deepEqual(leftovers.record.resources.map((r) => r.disposition), ["CONFIRMED_DELETED"]);
  });

  test("a run that did not succeed: no product cleanup, later seals refused, a hand deletion, then observe again reports the expected absence", async () => {
    emulator.topics.clear();
    const w = world();
    const s = await seal(w);
    // The service stores another storage policy than sealed (D11): never SUCCEEDED, and no verified property in the evidence.
    emulator.behave({ createRegions: ["us-central1"] });
    let applied;
    try { applied = await apply(w, s); } finally { emulator.behave({}); }
    assert.ok(!applied.ok && applied.code === "APPLY_FAILED" && applied.outcome === "PARTIAL_REQUIRES_REVIEW", JSON.stringify(applied));
    assert.equal(emulator.log().filter((e) => e.method === "PUT" && e.path === "/v1/" + nameOf(s)).length, 1, "sent once, never again");
    const evidence = await readAppliedEvidence(s.sealed.artifactSha256, w.deps.evidenceDir!);
    assert.ok(evidence);
    assert.equal(evidence.outcome, "PARTIAL_REQUIRES_REVIEW");
    assert.equal(evidence.authority.mutation, "GCP_PUBSUB_TOPIC_CREATE_OF_SEALED_REQUEST");
    assert.equal(evidence.verifiedProperty, undefined, "D11: a property is named only when it was read back as sealed");
    const blueprint = await readBlueprintRecord(s.sealed.artifactSha256, sha256(canonicalJson(evidence as never)), w.deps.evidenceDir!);
    assert.ok(blueprint, "the blueprint is written from what settle read (D14)");
    // observe: the reader sees the topic stored elsewhere: FAILED.
    const first = await observeRun(s.sealed.artifactSha256, w.observe());
    assert.ok(first.ok, JSON.stringify(first));
    assert.equal(first.record.verdict, "FAILED");
    assert.equal(first.record.resources[0].result, "DIFFERENT_FROM_DESIRED");
    // No cleanup proposal for a run that did not succeed.
    const proposed = await propose(w, s);
    assert.ok(!proposed.ok && proposed.code === "OWNERSHIP_AMBIGUOUS", JSON.stringify(proposed));
    // Its topic keeps every later seal refused until a person resolves it.
    const refused = await sealPreview(sealRequest(project()), w.deps);
    assert.ok(!refused.ok && /UNIT_NOT_EMPTY/.test(refused.code + " " + refused.message), JSON.stringify(refused));
    // MANUAL: a person deletes the one topic by its exact sealed name, outside the product.
    assert.equal(emulator.deleteByHand(nameOf(s)), true);
    // observe again: the independent DISCOVERY read is the absence check. FAILED is the expected result: the planned topic is gone.
    const second = await observeRun(s.sealed.artifactSha256, w.observe(120_000));
    assert.ok(second.ok, JSON.stringify(second));
    assert.equal(second.record.verdict, "FAILED");
    assert.deepEqual(second.record.resources.map((r) => [r.address, r.result]), [[s.sealed.changes[0].address, verificationOf("ABSENT", undefined).result]]);
    assert.equal(second.record.inventory, "COMPLETE");
    assert.deepEqual(second.record.unexpected, []);
    // Recovery is a new seal: a new name.
    const next = await seal(w);
    assert.notEqual(topicIdOf(next), topicIdOf(s));
  });
});
