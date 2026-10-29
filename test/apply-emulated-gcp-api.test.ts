import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { consumeApprovals, signApproval, signRequest, verifyApprovalSet, verifyRequestSignature } from "../src/apply/approval.js";
import { gcpProtectionOf } from "../src/apply/cleanup-gcp.js";
import { buildCleanupProposal, protectedDeletionIn, type CleanupProposal } from "../src/apply/cleanup-proposal.js";
import { isKillSwitchActive, loadPilotContract, pilotContractSha256, targetSha256Of } from "../src/apply/contract.js";
import { cleanupScopeProblem } from "../src/apply/driver.js";
import type { EngineSpec } from "../src/apply/engine-spec.js";
import { gcpApiEngine, type GcpApiEngineSpec, type GcpApiUnit } from "../src/apply/engines/gcp-api.js";
import { APPLY_AUTHORITY } from "../src/apply/evidence.js";
import { GCP_API_BACKEND_SENTINEL, GCP_API_TARGET } from "../src/apply/gcp-api-target.js";
import { openNonceStore } from "../src/apply/nonces.js";
import { GCP } from "../src/apply/providers/gcp.js";
import { recordSha256, verificationOf, type BlueprintRecord, type ObservationRecord } from "../src/apply/run-records.js";
import { engineBinaryChange, loadSealedPlan, reviewBundleOf, sealPlan, verifyReviewBundle, verifySealedPlan, type LoadedPlan } from "../src/apply/seal.js";
import type { ApplyEvidence, PilotContract, PlanChange, SignedApproval } from "../src/apply/types.js";
import { pilotUnitOf } from "../src/apply/unit.js";
import { blueprintFromGcpApiTopic } from "../src/observe/blueprint.js";
import { createDiscoveryGcpReader } from "../src/observe/gcp-rest.js";
import { observeBlueprint } from "../src/observe/verify.js";
import type { ResolvedTarget } from "../src/teardown/driver/types.js";
import { buildManifest, canonicalJson } from "../src/teardown/manifest.js";
import { captureProjectFiles, createImmutableSnapshot } from "../src/teardown/snapshot.js";
import { NOW, REQUESTER, SOURCE_COMMIT, approvalFor, approvers, keys, writeReviewedContract } from "./helpers/apply-fixtures.js";
import { startGcpApiEmulator, writeIdentities, type GcpApiEmulator } from "./helpers/gcp-api-emulator.js";

/**
 * EMULATED (docs/act-pilot-gcp-api.md, "Evidence"; lane G2). Path 6, end to end, over a loopback Google: the GCP_API spec talks HTTP to
 * an emulator of STS, IAM Credentials, Pub/Sub and Cloud Asset (test/helpers/gcp-api-emulator.ts, the Google side of #345's emulator
 * with D12's custom roles), each request on a fresh connection (`agent: false`, as #356). No Google endpoint is contacted.
 *
 * What runs for real: the driver's sealing module (`sealPlan`: the artifact hash, the requester's signature, the encrypted vault,
 * `loadSealedPlan`), the review bundle and its verification, the module-hash check (`engineBinaryChange`), the requester and approval
 * verification and the once-only nonce store (`consumeApprovals`), the GCP reader (`GCP_REST`) and the observation verdict
 * (`observeBlueprint`), the blueprint mapper (`blueprintFromGcpApiTopic`), the GCP cleanup classifier and the driver's cleanup checks
 * (`gcpProtectionOf`, `protectedDeletionIn`, `cleanupScopeProblem`), the proposal builder's refusal of a run that did not succeed
 * (`buildCleanupProposal`), and the kill switch file (`isKillSwitchActive`).
 *
 * What does not, until INT-2 registers the spec: `runApply`, `runCleanup`, `observeRun`, `verifyProposalLeftovers`, `record-recovery`
 * and the CLI load the contract, and admission refuses a GCP_API contract (`NOT_IMPLEMENTED`, asserted below); `buildCleanupProposal`
 * for a SUCCEEDED run reaches the target hash through `engineOf`, which has no GCP_API spec either. So this test calls the spec's steps in
 * `runApply`'s and `runCleanup`'s order, and builds in memory the evidence and records those would write (TEST FIXTURE, marked where
 * it happens). It is never live provider qualification: IAM, scopes and request shapes Google accepts, Cloud Asset's indexing delay,
 * quotas and latency are not shown by an emulator (GF1 to GF11).
 */

const PROJECT = "examplefake-dev";
const REGION = "europe-west4";
const PREFIX = "alz-act-dev1-";
const AUDIENCE = "//iam.googleapis.com/projects/123456789012/locations/global/workloadIdentityPools/alz-pilot-dev/providers/oidc";
const TARGET: ResolvedTarget = { account: PROJECT, backend: GCP_API_BACKEND_SENTINEL, workspace: "default" };
const POLICY = "2026-10-29.1";

describe("EMULATED: GCP API-native over a loopback Google: seal, approve, apply, observe, propose-cleanup, cleanup, verify-cleanup", () => {
  const root = mkdtempSync(join(tmpdir(), "alz-gcp-api-em-"));
  const previousCwd = process.cwd();
  const previousKey = process.env.AGENTIC_EVIDENCE_KEY;
  let emulator: GcpApiEmulator;
  let spec: GcpApiEngineSpec;
  let env: NodeJS.ProcessEnv;
  let email: (name: string) => string;
  let subjects: string[];
  let contract: PilotContract;
  let killPath: string;
  const nonces = openNonceStore(join(root, "nonces"));
  const fresh = (name: string): string => { const dir = join(root, name + "-" + randomBytes(3).toString("hex")); mkdirSync(dir, { recursive: true }); return dir; };

  before(async () => {
    process.env.AGENTIC_EVIDENCE_KEY = randomBytes(32).toString("base64");
    process.chdir(root); // the vault writes sealed plans under ./.runs
    const ids = writeIdentities(fresh("identities"), PROJECT, AUDIENCE);
    env = ids.env;
    email = ids.email;
    subjects = Object.values(ids.subjectOf);
    emulator = await startGcpApiEmulator(ids.trust, {
      [email("DISCOVERY")]: ["pubsub.topics.get", "cloudasset.assets.searchAllResources"],
      [email("APPLY")]: ["pubsub.topics.create", "pubsub.topics.delete"],
    });
    spec = gcpApiEngine({ http: emulator.http, settleDelayMs: 20 });
    killPath = join(root, "KILL");
    contract = {
      schemaVersion: 1, enabled: true, provider: "GCP", engine: "GCP_API", enabledEnvironments: ["DEV"],
      targets: { DEV: { projectId: PROJECT, region: REGION, parent: "folders/123456789", backend: GCP_API_BACKEND_SENTINEL, workspace: "default", topicPrefix: PREFIX, canary: { resources: [{ type: "google_pubsub_topic", count: 1 }] } } as never },
      requiredApprovals: { DEV: 1 }, maxApprovalAgeMinutes: 60, approvers, killSwitchPath: killPath, authorize: { DEV: ["APPLY", "CLEANUP"] },
    } as unknown as PilotContract;
  });

  after(async () => {
    await emulator?.close();
    process.chdir(previousCwd);
    if (previousKey === undefined) delete process.env.AGENTIC_EVIDENCE_KEY; else process.env.AGENTIC_EVIDENCE_KEY = previousKey;
    rmSync(root, { recursive: true, force: true });
  });

  // --- fixtures -------------------------------------------------------------------------------------------------------------

  const contractSha256 = (): string => pilotContractSha256(contract);
  const unit = () => pilotUnitOf({ provider: "GCP", contractSha256: contractSha256(), environment: "DEV", target: TARGET, engine: "GCP_API" });
  function project() {
    const projectRoot = fresh("project");
    writeFileSync(join(projectRoot, "request.json"), JSON.stringify({ schemaVersion: 1, kind: "PUBSUB_TOPIC" }) + "\n");
    const manifest = buildManifest({ engine: "GCP_API", mode: "PROJECT", target: TARGET, unitHash: "1".repeat(64), files: captureProjectFiles(projectRoot), policyVersion: POLICY, engineVersion: "gcp-api-1", providers: [], dependencies: [], inputs: [] } as never);
    return { projectRoot, manifest };
  }
  type Project = ReturnType<typeof project>;
  const snapshotOf = (p: Project) => createImmutableSnapshot(p.projectRoot, p.manifest, fresh("snapshots"));
  const runInput = (p: Project, sealedUnit: GcpApiUnit) => ({ scratchDir: fresh("scratch"), env, manifest: p.manifest, pinned: contract.targets.DEV, spec: GCP, target: { ...TARGET }, engineVersion: "gcp-api-1", unit: sealedUnit });
  const noSecrets = (value: unknown): void => {
    const text = JSON.stringify(value, (_key, v) => (Buffer.isBuffer(v) ? v.toString("utf8") : v));
    for (const subject of subjects) assert.ok(!text.includes(subject), "a subject token leaked");
    assert.ok(!/\b(?:fed|sa)-[0-9a-f]{24}\b/.test(text), "an emulated access token leaked");
  };

  /** The driver's sealing module with this spec: the plan stored encrypted, the requester's signature over the artifact hash. */
  async function seal(p: Project = project()): Promise<{ p: Project; loaded: LoadedPlan }> {
    const snapshot = snapshotOf(p);
    try {
      const result = await sealPlan({
        engine: spec as unknown as EngineSpec, environment: "DEV", channel: "CLI", policyVersion: POLICY, contractSha256: contractSha256(), authorizationSha256: "a".repeat(64),
        targetSha256: targetSha256Of(GCP, GCP_API_TARGET, contract.targets.DEV), sourceCommit: SOURCE_COMMIT,
        provenance: { engineBinarySha256: spec.binarySha256(undefined, env)!, qualification: { state: "UNQUALIFIED", reason: "EMULATED: no person attests an emulator run" } },
        requester: REQUESTER, now: () => NOW, scratchDir: fresh("seal"), env, manifest: p.manifest, pinned: contract.targets.DEV, spec: GCP, target: { ...TARGET },
        engineVersion: "gcp-api-1", snapshotPath: snapshot.path, unit: unit(),
      });
      assert.ok(result.ok, JSON.stringify(result));
      const loaded = await loadSealedPlan(result.path);
      assert.ok(loaded.ok);
      return { p, loaded: { sealed: loaded.sealed, planBytes: loaded.planBytes } };
    } finally { snapshot.remove(); }
  }
  type Sealed = Awaited<ReturnType<typeof seal>>;
  const sealedUnit = (s: Sealed): GcpApiUnit => ({ unitId: s.loaded.sealed.unit!.unitId, tags: s.loaded.sealed.unit!.tags });
  const topicIdOf = (s: Sealed): string => s.loaded.sealed.changes[0].address.slice("google_pubsub_topic.".length);
  const nameOf = (s: Sealed): string => "projects/" + PROJECT + "/topics/" + topicIdOf(s);

  type Applied = { outcome: string; evidence: ApplyEvidence; blueprint: BlueprintRecord | undefined } | { refused: string; consumed: boolean };
  /**
   * `runApply`'s steps 5 to 15 with this spec (src/apply/driver.ts): the sealed plan verified, the module hash unchanged, the requester
   * and the approvals verified, `prepare` and `rederive` with the change list compared, the approvals consumed, `execute` with the kill
   * switch file as `stopWhen`, `settle`, then (TEST FIXTURE) the apply evidence and the blueprint record runApply would write.
   */
  async function apply(s: Sealed, approvals: SignedApproval[]): Promise<Applied> {
    const verified = verifySealedPlan(s.loaded);
    if (!verified.ok) return { refused: verified.code, consumed: false };
    const changed = engineBinaryChange(verified.sealed, spec.binarySha256(undefined, env));
    if (changed) return { refused: changed.code, consumed: false };
    const requested = verifyRequestSignature({ request: verified.sealed.request, artifactSha256: verified.sealed.artifactSha256, environment: "DEV", requesterId: verified.sealed.requesterId, contract });
    if (!requested.ok) return { refused: requested.code, consumed: false };
    const verdict = verifyApprovalSet({ approvals, artifactSha256: verified.sealed.artifactSha256, environment: "DEV", target: verified.sealed.target, contract, now: NOW, nonces, requester: requested });
    if (!verdict.ok) return { refused: verdict.code, consumed: false };
    const snapshot = snapshotOf(s.p);
    try {
      const run = spec.openApply(runInput(s.p, sealedUnit(s)));
      let derived: PlanChange[];
      try {
        await run.prepare(snapshot.path);
        derived = await run.rederive(verified.planBytes);
      } catch (error) { return { refused: (error as Error).message, consumed: false }; }
      if (canonicalJson(derived) !== canonicalJson(verified.sealed.changes)) return { refused: "ARTIFACT_TAMPERED", consumed: false };
      const consumed = consumeApprovals(nonces, approvals);
      if (!consumed.ok) return { refused: consumed.code, consumed: false };
      let ran;
      try { ran = await run.execute(verified.planBytes, { stopWhen: () => isKillSwitchActive(contract) }); } catch (error) { return { refused: "APPROVALS_SPENT:" + (error as Error).message, consumed: true }; }
      if (ran.notStarted) return { refused: "KILL_SWITCH_AFTER_APPROVALS", consumed: true };
      const end = await run.settle(ran);
      const outcome = "stale" in end ? "FAILED_NO_CHANGE" : end.outcome;
      // TEST FIXTURE: the evidence runApply writes (step 15), with this spec's mutation value; INT-2 adds it to the enum.
      const evidence = {
        schemaVersion: 1, environment: "DEV", target: { ...TARGET }, artifactSha256: verified.sealed.artifactSha256, manifestHash: verified.sealed.manifestHash, releaseIdentity: verified.sealed.releaseIdentity,
        contractSha256: verified.sealed.contractSha256, targetSha256: verified.sealed.targetSha256,
        decisions: { authorized: { operation: "APPLY", contractSha256: contractSha256(), authorizationSha256: "a".repeat(64) }, ready: { engineBinarySha256: verified.sealed.provenance.engineBinarySha256, qualificationEvidenceHash: null }, execute: { requesterId: requested.requesterId, approverIds: verdict.approvers.map((a) => a.approverId) } },
        sourceCommit: SOURCE_COMMIT, approvals: verdict.approvers, requester: { requesterId: requested.requesterId, nonce: verified.sealed.request!.statement.nonce },
        adapter: { adapterVersion: spec.applyAdapter.adapterVersion, argvDigest: spec.applyAdapter.argvDigest }, toolVersions: { engine: "gcp-api-1" }, outcome, exitCode: ran.exitCode,
        startedAt: NOW.toISOString(), finishedAt: new Date(NOW.getTime() + 1_000).toISOString(), authority: { ...APPLY_AUTHORITY, mutation: spec.mutation },
      } as unknown as ApplyEvidence;
      // TEST FIXTURE: the blueprint record keepBlueprint writes from the spec's stateDocument (INT-2 adds the GCP_API_TOPIC branch).
      const state = await run.stateDocument();
      const blueprint = state === undefined ? undefined : {
        schemaVersion: 1, kind: "BLUEPRINT", artifactSha256: evidence.artifactSha256, applyEvidenceSha256: recordSha256(evidence), environment: "DEV", target: { ...TARGET }, sourceCommit: SOURCE_COMMIT,
        contractSha256: evidence.contractSha256, outcome, source: state.source, blueprint: blueprintFromGcpApiTopic(state.document, verified.sealed.changes, { project: PROJECT }),
        unitId: verified.sealed.unit?.unitId ?? null, readAt: NOW.toISOString(),
      } as unknown as BlueprintRecord;
      noSecrets([ran, end, state, evidence]);
      return { outcome, evidence, blueprint };
    } finally { snapshot.remove(); }
  }

  /** The GCP reader as `openReader` opens it for a GCP contract: DISCOVERY, the target project, the contract region for D11. */
  async function withReader<T>(body: (reader: ReturnType<typeof createDiscoveryGcpReader>["reader"]) => Promise<T>): Promise<T> {
    const opened = createDiscoveryGcpReader({ env, projectId: PROJECT, storagePolicyRegion: REGION, http: emulator.http });
    try { return await body(opened.reader); } finally { opened.close(); }
  }
  /** `observeRun`'s verdict and (TEST FIXTURE) its record, through the real GCP_REST reader. */
  async function observe(evidence: ApplyEvidence, blueprint: BlueprintRecord): Promise<ObservationRecord> {
    const report = await withReader((reader) => observeBlueprint(blueprint.blueprint, { unitId: blueprint.unitId, reader }));
    const origins = new Map(blueprint.blueprint.entries.map((entry) => [entry.address, entry.origin]));
    return {
      schemaVersion: 1, kind: "OBSERVATION", artifactSha256: evidence.artifactSha256, applyEvidenceSha256: recordSha256(evidence), blueprintSha256: recordSha256(blueprint), environment: "DEV", target: { ...TARGET },
      sourceCommit: SOURCE_COMMIT, contractSha256: evidence.contractSha256, verifier: report.verifier, verifierBinarySha256: null, verdict: report.verdict,
      resources: report.checks.map((check) => ({ address: check.address, type: check.type, identifier: check.identifier, origin: origins.get(check.address) ?? "NOT_IN_PLAN", ...(check.misplaced ? { result: "DIFFERENT_FROM_DESIRED" as const, reason: "LOCATION_NOT_IN_CONTRACT" } : verificationOf(check.existence, check.reason)) })),
      missingFromState: [...report.missingFromState], unexpected: [...report.unexpected], inventory: report.inventory, observedAt: new Date(NOW.getTime() + 60_000).toISOString(),
    } as ObservationRecord;
  }
  /** What a cleanup step needs of a proposal: its hash, its requester's signature, its target and its deletions. */
  type Proposal = Pick<CleanupProposal, "proposalSha256" | "request" | "requesterId" | "target" | "deletes">;
  /**
   * `./alz apply propose-cleanup` on the run's records. The real `buildCleanupProposal` refuses a run that did not succeed before it
   * reads anything else (asserted below). For a SUCCEEDED run it needs the contract's target hash through `engineOf`, which has no
   * GCP_API spec until INT-2, so (TEST FIXTURE) the one deletion is derived here as the builder derives it: an IN_PLAN CREATE of the
   * sealed change list, observed VERIFIED, of a type the real GCP classifier (`gcpProtectionOf`) passes as a reviewed leaf. The
   * proposal hash is the fixture's own and is signed by the requester under the cleanup request domain, as `signCleanupProposal` signs.
   */
  function propose(s: Sealed, evidence: ApplyEvidence, blueprint: BlueprintRecord, observation: ObservationRecord): { ok: true; proposal: Proposal } | { ok: false; code: string } {
    if (evidence.outcome !== "SUCCEEDED") {
      const built = buildCleanupProposal({
        applyEvidence: evidence, applyEvidenceSha256: recordSha256(evidence), blueprint, blueprintSha256: recordSha256(blueprint), observation, observationSha256: recordSha256(observation),
        changes: s.loaded.sealed.changes, channel: "CLI", contract, engineVersion: "gcp-api-1", env, now: new Date(NOW.getTime() + 120_000), requesterId: REQUESTER.requesterId,
      });
      assert.equal(built.ok, false);
      return built as { ok: false; code: string };
    }
    const created = new Map(s.loaded.sealed.changes.filter((c) => c.action === "CREATE").map((c) => [c.address, c]));
    const verified = new Set(observation.resources.filter((r) => r.result === "VERIFIED").map((r) => r.address));
    const deletes = blueprint.blueprint.entries
      .filter((entry) => entry.origin === "IN_PLAN" && created.has(entry.address) && verified.has(entry.address) && gcpProtectionOf({ type: entry.type, id: entry.id }, []) === undefined)
      .map((entry) => ({ address: entry.address, type: entry.type, identifier: entry.id, ownership: "RUN_CREATED" as const }));
    const proposalSha256 = recordSha256({ kind: "TEST_FIXTURE_CLEANUP_PROPOSAL", artifactSha256: evidence.artifactSha256, blueprintSha256: recordSha256(blueprint), observationSha256: recordSha256(observation), deletes });
    const request = signRequest({ schemaVersion: 1, requesterId: REQUESTER.requesterId, artifactSha256: proposalSha256, environment: "DEV", nonce: randomBytes(16).toString("hex") }, REQUESTER.privateKeyPem, "CLEANUP_REQUEST");
    return { ok: true, proposal: { proposalSha256, request, requesterId: REQUESTER.requesterId, target: { ...TARGET }, deletes: deletes as unknown as CleanupProposal["deletes"] } };
  }
  const cleanupApproval = (proposal: Proposal, who: keyof typeof keys): SignedApproval => signApproval({
    schemaVersion: 1, artifactSha256: proposal.proposalSha256, environment: "DEV", target: proposal.target, approverId: who,
    issuedAt: new Date(NOW.getTime() - 5 * 60_000).toISOString(), expiresAt: new Date(NOW.getTime() + 25 * 60_000).toISOString(), nonce: randomBytes(16).toString("hex"),
  }, keys[who].priv, "CLEANUP");

  /** `runCleanup`'s steps with this spec: requester and CLEANUP approvals verified, `prepare`, `planDestroy`, the protection and scope checks, consumption, `execute`, `settle`. */
  async function cleanup(s: Sealed, blueprint: BlueprintRecord, proposal: Proposal, approvals: SignedApproval[]) {
    const requested = verifyRequestSignature({ request: proposal.request, artifactSha256: proposal.proposalSha256, environment: "DEV", requesterId: proposal.requesterId, contract, subject: "CLEANUP_REQUEST" });
    assert.ok(requested.ok);
    const verdict = verifyApprovalSet({ approvals, artifactSha256: proposal.proposalSha256, environment: "DEV", target: proposal.target, contract, now: NOW, nonces, subject: "CLEANUP", requester: requested });
    if (!verdict.ok) return { refused: verdict.code };
    const addresses = proposal.deletes.map((d) => d.address);
    const snapshot = snapshotOf(s.p);
    try {
      const run = spec.openCleanup(runInput(s.p, sealedUnit(s)));
      let planned: PlanChange[];
      try {
        await run.prepare(snapshot.path);
        planned = await run.planDestroy(addresses);
      } catch (error) { return { refused: (error as Error).message }; }
      const protectedDeletion = protectedDeletionIn(planned, blueprint.blueprint.entries, contract, env, { account: PROJECT, addresses: new Set(addresses) });
      if (protectedDeletion) return { refused: "PROPOSAL_SCOPE_MISMATCH" };
      if (cleanupScopeProblem(planned, addresses)) return { refused: "PROPOSAL_SCOPE_MISMATCH" };
      const consumed = consumeApprovals(nonces, approvals);
      if (!consumed.ok) return { refused: consumed.code };
      const ran = await run.execute({ stopWhen: () => isKillSwitchActive(contract) });
      if (ran.notStarted) return { refused: "KILL_SWITCH_AFTER_APPROVALS" };
      const end = await run.settle(ran);
      return { outcome: "stale" in end ? "FAILED_NO_CHANGE" : end.outcome, deletedByRun: run.deletedByRun() };
    } finally { snapshot.remove(); }
  }
  /** `./alz apply verify-cleanup`: the independent DISCOVERY read of the id and the unit sweep, never the APPLY call's answer. */
  const leftovers = (blueprint: BlueprintRecord) => withReader(async (reader) => ({
    checks: await Promise.all(blueprint.blueprint.entries.map((entry) => reader.check(entry))),
    listed: await reader.listTagged(blueprint.unitId!),
  }));

  // --- the path ---------------------------------------------------------------------------------------------------------------

  it("admission still refuses a GCP_API contract: the spec is not registered (INT-2)", () => {
    const path = join(fresh("contract"), "act-pilot-contract.json");
    writeReviewedContract(path, contract);
    const loaded = loadPilotContract(path);
    assert.ok("reason" in loaded);
    assert.match(String((loaded as { code?: string }).code ?? loaded.reason), /NOT_IMPLEMENTED|not implemented/i);
  });

  it("the whole path for one run, and the replay and reuse refusals", async () => {
    emulator.topics.clear();
    // Seal: one CREATE of the full sealed name, the requester's signature, a review bundle that verifies.
    const s = await seal();
    const sealed = s.loaded.sealed;
    assert.deepEqual(sealed.changes, [{ address: "google_pubsub_topic." + topicIdOf(s), type: "google_pubsub_topic", action: "CREATE" }]);
    assert.match(topicIdOf(s), /^alz-act-dev1-[0-9a-f]{12}$/);
    const bundle = verifyReviewBundle(JSON.parse(JSON.stringify(reviewBundleOf(sealed))));
    assert.ok(bundle.ok);
    assert.equal(bundle.bundle.changes[0].address, "google_pubsub_topic." + topicIdOf(s), "D4: approvers see the full topic name");
    assert.deepEqual(bundle.bundle.unit, { unitId: unit().unitId, tags: { ...unit().tags }, untagged: [] });
    assert.equal(sealed.provenance.engineBinarySha256, spec.binarySha256(undefined, env), "D1: the module hash is sealed");
    assert.equal(emulator.topics.size, 0, "a seal creates nothing");
    noSecrets(sealed);

    // Approve and apply.
    const approvals = [approvalFor(sealed, "alice")];
    const applied = await apply(s, approvals);
    assert.ok("outcome" in applied && applied.outcome === "SUCCEEDED", JSON.stringify(applied));
    const topic = emulator.topics.get(nameOf(s));
    assert.deepEqual(topic, { name: nameOf(s), labels: { ...unit().tags }, messageStoragePolicy: { allowedPersistenceRegions: [REGION] } }, "D11: the storage policy was set");
    const putLog = emulator.log().filter((e) => e.method === "PUT");
    assert.equal(putLog.length, 1);
    assert.deepEqual(putLog[0].createBody, { labels: { ...unit().tags }, messageStoragePolicy: { allowedPersistenceRegions: [REGION] } });
    assert.equal(putLog[0].sa, email("APPLY"));

    // Replay: the approvals cannot be reused, and the same artifact cannot create again.
    assert.equal(consumeApprovals(nonces, approvals).ok, false, "approvals are single use");
    const again = await apply(s, [approvalFor(sealed, "bob")]);
    assert.deepEqual(again, { refused: "UNIT_NOT_EMPTY", consumed: false });

    // Observe through GCP_REST: VERIFIED.
    assert.ok(applied.blueprint);
    assert.deepEqual(applied.blueprint.blueprint.entries.map((e) => [e.address, e.id, e.origin]), [[sealed.changes[0].address, nameOf(s), "IN_PLAN"]]);
    const observation = await observe(applied.evidence, applied.blueprint);
    assert.equal(observation.verdict, "VERIFIED");
    assert.equal(observation.verifier, "GCP_REST");
    assert.equal(observation.inventory, "COMPLETE");

    // Propose the cleanup: exactly the run's topic.
    const proposed = propose(s, applied.evidence, applied.blueprint, observation);
    assert.ok(proposed.ok, JSON.stringify(proposed));
    assert.deepEqual(proposed.proposal.deletes.map((d) => [d.address, d.identifier, d.ownership]), [[sealed.changes[0].address, nameOf(s), "RUN_CREATED"]]);

    // An apply approval is never a cleanup approval.
    const wrongDomain = await cleanup(s, applied.blueprint, proposed.proposal, [approvalFor(sealed, "carol")]);
    assert.ok("refused" in wrongDomain && typeof wrongDomain.refused === "string", JSON.stringify(wrongDomain));
    assert.equal(emulator.log().filter((e) => e.method === "DELETE").length, 0);

    // Clean up: one DELETE, deleted by this run.
    const cleanupApprovals = [cleanupApproval(proposed.proposal, "alice")];
    const cleaned = await cleanup(s, applied.blueprint, proposed.proposal, cleanupApprovals);
    assert.deepEqual(cleaned, { outcome: "SUCCEEDED", deletedByRun: true });
    assert.equal(emulator.topics.size, 0);
    const deleteLog = emulator.log().filter((e) => e.method === "DELETE");
    assert.deepEqual(deleteLog.map((e) => [e.path, e.sa]), [["/v1/" + nameOf(s), email("APPLY")]]);
    assert.deepEqual(await cleanup(s, applied.blueprint, proposed.proposal, cleanupApprovals), { refused: "APPROVAL_REPLAYED" }, "the cleanup approvals cannot be reused");

    // Verify the cleanup independently: the id reads absent and the unit lists nothing, completely.
    const left = await leftovers(applied.blueprint);
    assert.deepEqual(left.checks.map((c) => c.existence), ["ABSENT"]);
    assert.deepEqual(left.listed, { identifiers: [], complete: true });
    noSecrets([applied, observation, proposed, cleaned, left]);
    // Every request went to one of the four emulated Google hosts; DISCOVERY only read and APPLY only created and deleted.
    for (const e of emulator.log()) assert.ok(!e.refused, JSON.stringify(e));
    assert.ok(emulator.log().filter((e) => e.sa === email("DISCOVERY")).every((e) => e.method === "GET"));
    assert.ok(emulator.log().filter((e) => e.sa === email("APPLY")).every((e) => e.method === "PUT" || e.method === "DELETE"));
  });

  it("the kill switch file stops the apply after the approvals are consumed and before the PUT; the same plan then applies with new approvals", async () => {
    emulator.topics.clear();
    const s = await seal();
    writeFileSync(killPath, "stop\n");
    try {
      assert.deepEqual(await apply(s, [approvalFor(s.loaded.sealed, "alice")]), { refused: "KILL_SWITCH_AFTER_APPROVALS", consumed: true });
    } finally { rmSync(killPath, { force: true }); }
    assert.equal(emulator.topics.size, 0);
    const applied = await apply(s, [approvalFor(s.loaded.sealed, "bob")]);
    assert.ok("outcome" in applied && applied.outcome === "SUCCEEDED");
    assert.deepEqual([...emulator.topics.keys()], [nameOf(s)], "the same sealed name (D4)");
    emulator.topics.clear();
  });

  it("a run that did not succeed: no product cleanup, later seals refused, a hand deletion, then observe again reports the expected absence", async () => {
    emulator.topics.clear();
    const s = await seal();
    // The service stores another storage policy than sealed (D11): never SUCCEEDED.
    emulator.behave({ createRegions: ["us-central1"] });
    const applied = await apply(s, [approvalFor(s.loaded.sealed, "alice")]);
    emulator.behave({});
    assert.ok("outcome" in applied && applied.outcome === "PARTIAL_REQUIRES_REVIEW", JSON.stringify(applied));
    assert.ok(applied.blueprint, "the blueprint is written from what settle read (D14)");
    // observe: the reader sees the topic stored elsewhere: FAILED.
    const first = await observe(applied.evidence, applied.blueprint);
    assert.equal(first.verdict, "FAILED");
    assert.equal(first.resources[0].result, "DIFFERENT_FROM_DESIRED");
    // No cleanup proposal for a run that did not succeed.
    const proposed = propose(s, applied.evidence, applied.blueprint, first);
    assert.deepEqual([proposed.ok, !proposed.ok && proposed.code], [false, "OWNERSHIP_AMBIGUOUS"]);
    // Its topic keeps every later seal refused until a person resolves it.
    await assert.rejects(seal(), /UNIT_NOT_EMPTY/);
    // MANUAL: a person deletes the one topic by its exact sealed name, outside the product.
    assert.equal(emulator.deleteByHand(nameOf(s)), true);
    // observe again: the independent DISCOVERY read is the absence check. FAILED is the expected result: the planned topic is gone.
    const second = await observe(applied.evidence, applied.blueprint);
    assert.equal(second.verdict, "FAILED");
    assert.deepEqual(second.resources.map((r) => [r.address, r.result]), [[s.loaded.sealed.changes[0].address, verificationOf("ABSENT", undefined).result]]);
    assert.equal(second.inventory, "COMPLETE");
    assert.deepEqual(second.unexpected, []);
    // Recovery is a new seal: a new name.
    const next = await seal();
    assert.notEqual(topicIdOf(next), topicIdOf(s));
  });
});

