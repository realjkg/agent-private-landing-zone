import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { authorizeContract, parsePilotContract, pilotContractSha256 } from "../src/apply/contract.js";
import { APPLY_AUTHORITY } from "../src/apply/evidence.js";
import { buildRecoveryEvidence, recoveryAdmissionRecordOf } from "../src/apply/recovery-record.js";
import type { ApplyEvidence, PilotContract } from "../src/apply/types.js";
import {
  actGateId, gitContractReader, reviewProductionRelease,
  type ActPilotPath, type ContractAtCommit, type ContractReader, type ReleaseAdmissionInput, type ReleaseGateSubmission,
} from "../src/qualification/release-admission.js";
import { contractJson as azureContractJson, awsContractJson, approvers } from "./helpers/apply-fixtures.js";
import { CANARY as BICEP_CANARY, LOCATION, RESOURCE_GROUP, STACK_NAME, SUBSCRIPTION_ID, TENANT_ID } from "./helpers/bicep-fixtures.js";
import { cdkContractJson } from "./helpers/cdk-fixtures.js";

// Six-path pilot release admission (owner decision 6483993252 on #39). SYNTHETIC: every contract, commit, hash and record below is a
// fixture; nothing here is live evidence or reaches a cloud. It pins how one release candidate holds valid evidence for every ACT path,
// each bound to its own reviewed contract and the commit that carries it, and that nothing weaker is ever admitted.

const root = mkdtempSync(join(tmpdir(), "alz-release-paths-"));
test.after(() => rmSync(root, { recursive: true, force: true }));
const KILL = join(root, "KILL");
const CANDIDATE = "a".repeat(40);
const HARDWARE = "private-lab-host-01";
const CONTRACT_FILE = "config/act-pilot-contract.json";
const hash = (value: string): string => createHash("sha256").update(value).digest("hex");

const gcpContractJson = (over: Record<string, unknown> = {}) => ({
  schemaVersion: 1, enabled: true, provider: "GCP", engine: "TERRAFORM", enabledEnvironments: ["DEV"],
  targets: { DEV: { projectId: "alz-pilot-dev", region: "europe-west4", backend: "alz-pilot-dev-state/pilot/dev", workspace: "default", canary: { resources: [{ type: "google_pubsub_topic", count: 1 }] } } },
  requiredApprovals: { DEV: 1 }, maxApprovalAgeMinutes: 60, approvers, killSwitchPath: KILL, authorize: { DEV: ["APPLY", "CLEANUP"] }, embedStateWrite: true, ...over,
});
const bicepContractJson = (over: Record<string, unknown> = {}) => ({
  schemaVersion: 1, enabled: true, provider: "AZURE", engine: "BICEP", enabledEnvironments: ["DEV"],
  targets: { DEV: { tenantId: TENANT_ID, subscriptionId: SUBSCRIPTION_ID, backend: STACK_NAME, workspace: "default", resourceGroup: RESOURCE_GROUP, location: LOCATION, canary: BICEP_CANARY } },
  requiredApprovals: { DEV: 1 }, maxApprovalAgeMinutes: 60, approvers, killSwitchPath: KILL, authorize: { DEV: ["APPLY", "CLEANUP"] }, ...over,
});

/** The five admitted paths, each with its own reviewed contract text and the commit that carries it (differing from the candidate in the contract file only). */
type Path = { provider: string; engine: string; commit: string; text: string; contract: PilotContract };
const pathOf = (raw: object, commit: string): Path => {
  const text = JSON.stringify(raw);
  const contract = parsePilotContract(text);
  assert.equal(contract.enabled, true, JSON.stringify(contract));
  const loaded = contract as PilotContract;
  return { provider: loaded.provider, engine: loaded.engine, commit, text, contract: loaded };
};
const PATHS: Path[] = [
  pathOf(awsContractJson(KILL), "1".repeat(40)),
  pathOf(azureContractJson(KILL), "2".repeat(40)),
  pathOf(cdkContractJson(KILL), "3".repeat(40)),
  pathOf(bicepContractJson(), "4".repeat(40)),
  pathOf(gcpContractJson(), "5".repeat(40)),
];
const byGate = (gate: string): Path => PATHS.find((p) => actGateId(p) === gate)!;
const entryOf = (p: Path): ActPilotPath => ({ provider: p.provider, engine: p.engine, contractSha256: pilotContractSha256(p.contract), contractCommit: p.commit } as ActPilotPath);

/** A fake commit store: each path's commit holds its contract text and differs from the candidate in the contract file only, unless told otherwise. */
const readerOf = (over: Record<string, ContractAtCommit | "THROW"> = {}): ContractReader => async (commit) => {
  const special = over[commit];
  if (special === "THROW") throw new Error("reader failed");
  if (special !== undefined) return special;
  const path = PATHS.find((p) => p.commit === commit);
  return path ? { ok: true, contract: parsePilotContract(path.text), changedPaths: [CONTRACT_FILE] } : { ok: false, reason: "no such commit" };
};

let counter = 0;
const attach = (id: string, mode: ReleaseGateSubmission["mode"], payload: object, bytesOver?: string): ReleaseGateSubmission => {
  const name = id.replaceAll(":", "-") + "-" + (counter += 1) + ".json";
  const bytes = JSON.stringify(payload) + "\n";
  mkdirSync(join(root, "evidence"), { recursive: true });
  writeFileSync(join(root, "evidence", name), bytesOver ?? bytes);
  return { id, mode, sourceCommit: CANDIDATE, targetHardwareId: HARDWARE, evidencePath: "evidence/" + name, evidenceSha256: hash(bytes) };
};
const authOf = (contract: PilotContract, env: "DEV" | "QA" | "PROD" = "DEV"): string | undefined => {
  const a = authorizeContract(contract, env, "APPLY");
  return a.ok ? a.authorization.authorizationSha256 : undefined;
};
/** The live record `./alz apply record-live` writes for a path's DEV apply, at the commit that carried its contract. */
const liveOf = (p: Path, over: Record<string, unknown> = {}) => ({
  schemaVersion: 1, label: "LIVE", step: "execute", cloud: p.provider, engine: p.engine, environment: "DEV", target: { account: "a", backend: "b", workspace: "default" },
  sourceCommit: p.commit, artifactSha256: "1".repeat(64), outcome: "SUCCEEDED", evidenceSha256: "2".repeat(64), contractSha256: pilotContractSha256(p.contract),
  authorizationSha256: authOf(p.contract), attestedBy: "owner", attestedAt: "2026-10-29T00:00:00.000Z", ...over,
});
const manifestOf = (fields: Record<string, unknown>, records: ReleaseGateSubmission[] = []): ReleaseAdmissionInput =>
  ({ schemaVersion: 1, sourceCommit: CANDIDATE, operatingMode: "PREVIEW_OPERATE", infrastructureAct: "PILOT", records, ...fields }) as unknown as ReleaseAdmissionInput;
const review = (manifest: ReleaseAdmissionInput, options: { pilotContract?: PilotContract | { enabled: false }; contractAt?: ContractReader } = { contractAt: readerOf() }) =>
  reviewProductionRelease({ manifest, root, expectedCommit: CANDIDATE, ...options });
const actBlockers = (r: { blockers: string[] }) => r.blockers.filter((b) => /^ACT_PILOT|^RELEASE_MANIFEST/.test(b));
const statusOf = async (manifest: ReleaseAdmissionInput, gate: string, options?: Parameters<typeof review>[1]) => (await review(manifest, options)).gates.find((g) => g.id === gate)?.status;
const allPaths = () => ({ actPilots: PATHS.map(entryOf) });

test("one candidate, five admitted paths: each path's live record is admitted against its own contract, authorization and contract commit, and the report lists every bound path", async () => {
  const records = PATHS.map((p) => attach(actGateId(p), "LIVE_ACT", liveOf(p)));
  const result = await review(manifestOf(allPaths(), records));
  assert.deepEqual(actBlockers(result), []);
  assert.deepEqual(result.actPilots, PATHS.map(entryOf));
  assert.equal(result.actPilot, null);
  for (const p of PATHS) assert.equal(result.gates.find((g) => g.id === actGateId(p))?.status, "EVIDENCE_PRESENT", actGateId(p));
  assert.deepEqual(PATHS.map((p) => actGateId(p)).sort(), ["act:aws-cdk", "act:aws-terraform", "act:azure-bicep", "act:azure-terraform", "act:gcp-terraform"]);
  // ACT stays disabled globally, nothing is approved, and every other gate still needs its own evidence.
  assert.equal(result.infrastructureAct, "DISABLED");
  assert.equal(result.productionReleaseApproved, false);
  assert.equal(result.readyForIndependentReleaseReview, false);
  // A path whose contract the candidate itself carries is declared with the candidate as its contract commit.
  const gcp = byGate("act:gcp-terraform");
  const atCandidate = { ...entryOf(gcp), contractCommit: CANDIDATE };
  const reader = readerOf({ [CANDIDATE]: { ok: true, contract: gcp.contract, changedPaths: [] } });
  const own = await review(manifestOf({ actPilots: [atCandidate] }, [attach("act:gcp-terraform", "LIVE_ACT", liveOf(gcp, { sourceCommit: CANDIDATE }))]), { contractAt: reader, pilotContract: gcp.contract });
  assert.deepEqual(actBlockers(own), []);
  assert.equal(own.gates.find((g) => g.id === "act:gcp-terraform")?.status, "EVIDENCE_PRESENT");
});

test("evidence for one path is never checked against another path's contract: a record naming another path's contract, authorization or commit, or a path the release does not declare, is BLOCKED", async () => {
  const gcp = byGate("act:gcp-terraform");
  const bicep = byGate("act:azure-bicep");
  const manifest = (record: ReleaseGateSubmission, fields = allPaths()) => manifestOf(fields, [record]);
  const gate = "act:gcp-terraform";
  assert.equal(await statusOf(manifest(attach(gate, "LIVE_ACT", liveOf(gcp))), gate), "EVIDENCE_PRESENT");
  assert.equal(await statusOf(manifest(attach(gate, "LIVE_ACT", liveOf(gcp, { contractSha256: pilotContractSha256(bicep.contract), authorizationSha256: authOf(bicep.contract) }))), gate), "BLOCKED", "Bicep's contract");
  assert.equal(await statusOf(manifest(attach(gate, "LIVE_ACT", liveOf(gcp, { sourceCommit: bicep.commit }))), gate), "BLOCKED", "Bicep's contract commit");
  assert.equal(await statusOf(manifest(attach(gate, "LIVE_ACT", liveOf(gcp, { sourceCommit: CANDIDATE }))), gate), "BLOCKED", "the candidate does not carry the GCP contract");
  // A path the release does not declare binds nothing, so its record is refused even when it is well formed.
  const withoutGcp = { actPilots: PATHS.filter((p) => p !== gcp).map(entryOf) };
  assert.equal(await statusOf(manifest(attach(gate, "LIVE_ACT", liveOf(gcp)), withoutGcp), gate), "BLOCKED");
  // The single-path form (AWS Terraform) no longer judges another path's record by its own contract: an Azure Bicep record naming
  // the AWS Terraform contract and authorization was admitted before this change; it is BLOCKED now.
  const aws = byGate("act:aws-terraform");
  const single = manifestOf({ actPilot: { provider: "AWS", engine: "TERRAFORM", contractSha256: pilotContractSha256(aws.contract) } },
    [attach("act:azure-bicep", "LIVE_ACT", liveOf(bicep, { sourceCommit: CANDIDATE, contractSha256: pilotContractSha256(aws.contract), authorizationSha256: authOf(aws.contract) }))]);
  assert.equal(await statusOf(single, "act:azure-bicep", { pilotContract: aws.contract }), "BLOCKED");
});

test("a missing, disabled, unauthorized or unreadable contract keeps its path blocked, and the release binds nothing", async () => {
  const gcp = byGate("act:gcp-terraform");
  const one = (contractAt: ContractReader | undefined) => review(manifestOf({ actPilots: [entryOf(gcp)] }), { contractAt });
  const gate = "act:gcp-terraform";
  assert.deepEqual(actBlockers(await one(undefined)), ["ACT_PILOT_CONTRACT_SOURCE_UNAVAILABLE:" + gate]);
  assert.deepEqual(actBlockers(await one(readerOf({ [gcp.commit]: { ok: false, reason: "gone" } }))), ["ACT_PILOT_CONTRACT_COMMIT_UNREADABLE:" + gate]);
  assert.deepEqual(actBlockers(await one(readerOf({ [gcp.commit]: "THROW" }))), ["ACT_PILOT_CONTRACT_COMMIT_UNREADABLE:" + gate]);
  for (const text of [undefined, JSON.stringify(gcpContractJson({ enabled: false })), JSON.stringify(gcpContractJson({ authorize: {} })), "{"]) {
    const contract = text === undefined ? { enabled: false as const } : parsePilotContract(text);
    assert.equal(contract.enabled, false);
    assert.deepEqual(actBlockers(await one(readerOf({ [gcp.commit]: { ok: true, contract, changedPaths: [CONTRACT_FILE] } }))), ["ACT_PILOT_CONTRACT_MISSING_OR_DISABLED:" + gate], String(text));
  }
  // A hand-built contract object that says enabled but authorizes nothing, named by its own hash.
  const empty = { ...gcp.contract, authorize: {} } as PilotContract;
  const refused = await review(manifestOf({ actPilots: [{ ...entryOf(gcp), contractSha256: pilotContractSha256(empty) }] }), { contractAt: readerOf({ [gcp.commit]: { ok: true, contract: empty, changedPaths: [CONTRACT_FILE] } }) });
  assert.deepEqual(actBlockers(refused), ["ACT_PILOT_CONTRACT_NOT_AUTHORIZED:" + gate]);
  // With any path refused, no path is bound: a valid record for another declared path is not admitted either.
  const aws = byGate("act:aws-terraform");
  const mixed = await review(manifestOf({ actPilots: [entryOf(aws), entryOf(gcp)] }, [attach("act:aws-terraform", "LIVE_ACT", liveOf(aws))]), { contractAt: readerOf({ [gcp.commit]: { ok: false, reason: "gone" } }) });
  assert.equal(mixed.gates.find((g) => g.id === "act:aws-terraform")?.status, "BLOCKED");
  assert.deepEqual(mixed.actPilots, []);
});

test("a wrong provider, engine, target, environment, contract hash, authorization binding or source commit stays blocked", async () => {
  const gcp = byGate("act:gcp-terraform");
  const gate = "act:gcp-terraform";
  const declare = async (entry: Record<string, unknown>, reader: ContractReader = readerOf()) => actBlockers(await review(manifestOf({ actPilots: [entry] }), { contractAt: reader }));
  // The declared scope must be the contract's: provider, engine and hash.
  assert.deepEqual(await declare({ ...entryOf(gcp), contractSha256: "0".repeat(64) }), ["ACT_PILOT_SCOPE_MISMATCH:" + gate]);
  assert.deepEqual(await declare({ ...entryOf(gcp), engine: "BICEP" }), ["ACT_PILOT_COMBINATION_NOT_ALLOWED:act:gcp-bicep"]);
  assert.deepEqual(await declare({ ...entryOf(byGate("act:azure-bicep")), contractCommit: gcp.commit }), ["ACT_PILOT_SCOPE_MISMATCH:act:azure-bicep"], "a commit carrying another path's contract");
  // The contract commit may change the contract file only: a commit that also changes product code is not this candidate's code.
  assert.deepEqual(await declare(entryOf(gcp), readerOf({ [gcp.commit]: { ok: true, contract: gcp.contract, changedPaths: [CONTRACT_FILE, "src/apply/driver.ts"] } })), ["ACT_PILOT_CONTRACT_COMMIT_CHANGES_PRODUCT:" + gate]);
  // A record under a contract with another target (its hash and authorization differ), another environment, authorization or commit.
  const moved = parsePilotContract(JSON.stringify(gcpContractJson({ targets: { DEV: { ...gcpContractJson().targets.DEV, projectId: "alz-pilot-other" } } }))) as PilotContract;
  assert.notEqual(pilotContractSha256(moved), pilotContractSha256(gcp.contract));
  const status = (over: Record<string, unknown>) => statusOf(manifestOf(allPaths(), [attach(gate, "LIVE_ACT", liveOf(gcp, over))]), gate);
  assert.equal(await status({}), "EVIDENCE_PRESENT");
  for (const [label, over] of [
    ["another target's contract", { contractSha256: pilotContractSha256(moved), authorizationSha256: authOf(moved) }],
    ["another target's authorization", { authorizationSha256: authOf(moved) }],
    ["QA", { environment: "QA" }], ["PROD", { environment: "PROD" }],
    ["another authorization", { authorizationSha256: "3".repeat(64) }], ["no authorization", { authorizationSha256: undefined }],
    ["another source commit", { sourceCommit: "6".repeat(40) }], ["another provider", { cloud: "AWS" }], ["another engine", { engine: "GCP_API" }],
  ] as const) assert.equal(await status(over as Record<string, unknown>), "BLOCKED", label);
});

test("synthetic, mocked, emulated, stale or substituted evidence never satisfies a live ACT gate of a declared path", async () => {
  const bicep = byGate("act:azure-bicep");
  const gate = "act:azure-bicep";
  const status = (record: ReleaseGateSubmission) => statusOf(manifestOf(allPaths(), [record]), gate);
  assert.equal(await status(attach(gate, "LIVE_ACT", liveOf(bicep))), "EVIDENCE_PRESENT");
  for (const [label, over] of [
    ["SYNTHETIC", { label: "SYNTHETIC" }], ["EMULATED", { label: "EMULATED" }], ["mock", { mock: true }], ["fixture", { fixture: true }],
    ["simulation", { simulation: true }], ["offline fixture", { mode: "OFFLINE_FIXTURE_ONLY" }], ["not SUCCEEDED", { outcome: "PARTIAL_REQUIRES_REVIEW" }],
    ["unattested", { attestedBy: " " }], ["stale commit", { sourceCommit: "7".repeat(40) }], ["mutation observed", { mutationObserved: true }],
  ] as const) assert.equal(await status(attach(gate, "LIVE_ACT", liveOf(bicep, over as Record<string, unknown>))), "BLOCKED", label);
  // Substituted: the file no longer holds the bytes the manifest hashed, or the record is another path's, or the wrong mode or candidate.
  assert.equal(await status(attach(gate, "LIVE_ACT", liveOf(bicep), JSON.stringify(liveOf(bicep, { attestedBy: "someone else" })) + "\n")), "BLOCKED", "substituted bytes");
  assert.equal(await status(attach(gate, "LIVE_ACT", liveOf(byGate("act:azure-terraform")))), "BLOCKED", "Azure Terraform's record");
  assert.equal(await status({ ...attach(gate, "LIVE_ACT", liveOf(bicep)), mode: "LIVE_PREVIEW" }), "BLOCKED", "wrong mode");
  assert.equal(await status({ ...attach(gate, "LIVE_ACT", liveOf(bicep)), sourceCommit: bicep.commit }), "BLOCKED", "the manifest entry names another candidate");
});

test("QA and PROD are refused for the DEV-only paths (Azure Bicep, GCP Terraform): no authorization exists for them, and a contract that authorizes them does not load", async () => {
  for (const gate of ["act:azure-bicep", "act:gcp-terraform"]) {
    const p = byGate(gate);
    assert.deepEqual(p.contract.enabledEnvironments, ["DEV"]);
    assert.equal(authOf(p.contract, "QA"), undefined);
    assert.equal(authOf(p.contract, "PROD"), undefined);
    for (const environment of ["QA", "PROD"]) {
      // Even with DEV's authorization hash copied in, a QA or PROD record finds no authorization to match.
      assert.equal(await statusOf(manifestOf(allPaths(), [attach(gate, "LIVE_ACT", liveOf(p, { environment }))]), gate), "BLOCKED", gate + " " + environment);
    }
  }
  const widened = [
    gcpContractJson({ enabledEnvironments: undefined }), gcpContractJson({ enabledEnvironments: ["DEV", "QA"] }), gcpContractJson({ authorize: { DEV: ["APPLY"], QA: ["APPLY"] } }),
    bicepContractJson({ enabledEnvironments: undefined }), bicepContractJson({ enabledEnvironments: ["PROD"] }),
  ];
  for (const raw of widened) assert.equal(parsePilotContract(JSON.stringify(raw)).enabled, false, JSON.stringify(raw).slice(0, 120));
});

test("GCP_API is not GCP Terraform and Bicep is not Terraform: GCP_API has no pilot path, and a record of one engine never fills another engine's gate", async () => {
  const gcp = byGate("act:gcp-terraform");
  const api = { ...entryOf(gcp), engine: "GCP_API" };
  assert.deepEqual(actBlockers(await review(manifestOf({ actPilots: [api] }))), ["ACT_PILOT_COMBINATION_NOT_ALLOWED:act:gcp-gcp_api"]);
  assert.equal(parsePilotContract(JSON.stringify(gcpContractJson({ engine: "GCP_API" }))).enabled, false, "a GCP_API contract does not load");
  assert.equal(await statusOf(manifestOf(allPaths(), [attach("act:gcp-terraform", "LIVE_ACT", liveOf(gcp, { engine: "GCP_API" }))]), "act:gcp-terraform"), "BLOCKED");
  const bicep = byGate("act:azure-bicep");
  assert.equal(await statusOf(manifestOf(allPaths(), [attach("act:azure-terraform", "LIVE_ACT", liveOf(bicep))]), "act:azure-terraform"), "BLOCKED", "a Bicep record on the Azure Terraform gate");
  assert.equal(await statusOf(manifestOf(allPaths(), [attach("act:azure-bicep", "LIVE_ACT", liveOf(byGate("act:azure-terraform")))]), "act:azure-bicep"), "BLOCKED", "a Terraform record on the Bicep gate");
});

test("a recovery record is bound to the declared path whose contract it names, at that contract's commit, with that contract's approval count", async () => {
  const bicep = byGate("act:azure-bicep");
  const at = (minutes: number): string => new Date(Date.UTC(2026, 9, 29, 12, minutes)).toISOString();
  const apply = (over: Partial<ApplyEvidence>): ApplyEvidence => ({
    schemaVersion: 1, environment: "DEV", target: { account: SUBSCRIPTION_ID, backend: STACK_NAME, workspace: "default" }, artifactSha256: "5".repeat(64), manifestHash: "2".repeat(64), releaseIdentity: "3".repeat(64),
    contractSha256: pilotContractSha256(bicep.contract), sourceCommit: bicep.commit, approvals: [{ approverId: approvers[0]!.id, issuedAt: at(-30) }], adapter: { adapterVersion: "a", argvDigest: "4".repeat(64) },
    toolVersions: { engine: "2.0" }, outcome: "SUCCEEDED", exitCode: 0, startedAt: at(-10), finishedAt: at(0), authority: APPLY_AUTHORITY, ...over,
  });
  const built = buildRecoveryEvidence({
    interrupted: apply({ outcome: "KILLED", exitCode: null }), resumed: apply({ artifactSha256: "6".repeat(64), approvals: [{ approverId: approvers[0]!.id, issuedAt: at(15) }], startedAt: at(20), finishedAt: at(25) }),
    contract: bicep.contract, sourceCommit: bicep.commit, targetHardwareId: HARDWARE, attestedBy: "operator", now: new Date(Date.UTC(2026, 9, 29, 13)),
  });
  assert.ok(built.ok, JSON.stringify(built));
  const recovery = built.evidence;
  const status = (fields: Record<string, unknown>, doc: object = recovery) => statusOf(manifestOf(fields, [attach("act-run-recovery", "ACT_RECOVERY", doc)]), "act-run-recovery");
  assert.equal(await status(allPaths()), "EVIDENCE_PRESENT");
  // The same record is refused when its path is not declared, and when the release names only the single-path form for another contract.
  assert.equal(await status({ actPilots: PATHS.filter((p) => p !== bicep).map(entryOf) }), "BLOCKED");
  // Relabeled to PROD (one approval where the contract states none for PROD), or naming another commit, it is refused.
  const prod = { ...recovery, environment: "PROD", interrupted: { ...recovery.interrupted, environment: "PROD" }, resumed: { ...recovery.resumed, environment: "PROD" } };
  assert.equal(await status(allPaths(), prod), "BLOCKED", "PROD");
  assert.equal(await status(allPaths(), { ...recovery, sourceCommit: CANDIDATE }), "BLOCKED", "the candidate is not the commit that carried the Bicep contract");
});

/** A recovery record for `p`'s DEV apply, as `./alz apply record-recovery` builds it, at `sourceCommit`. */
const recoveryFor = (p: Path, sourceCommit: string) => {
  const at = (minutes: number): string => new Date(Date.UTC(2026, 9, 29, 12, minutes)).toISOString();
  const apply = (over: Partial<ApplyEvidence>): ApplyEvidence => ({
    schemaVersion: 1, environment: "DEV", target: { account: "a", backend: "b", workspace: "default" }, artifactSha256: "5".repeat(64), manifestHash: "2".repeat(64), releaseIdentity: "3".repeat(64),
    contractSha256: pilotContractSha256(p.contract), sourceCommit, approvals: [{ approverId: approvers[0]!.id, issuedAt: at(-30) }], adapter: { adapterVersion: "a", argvDigest: "4".repeat(64) },
    toolVersions: { engine: "1.0" }, outcome: "SUCCEEDED", exitCode: 0, startedAt: at(-10), finishedAt: at(0), authority: APPLY_AUTHORITY, ...over,
  });
  const built = buildRecoveryEvidence({
    interrupted: apply({ outcome: "KILLED", exitCode: null }), resumed: apply({ artifactSha256: "6".repeat(64), approvals: [{ approverId: approvers[0]!.id, issuedAt: at(15) }], startedAt: at(20), finishedAt: at(25) }),
    contract: p.contract, sourceCommit, targetHardwareId: HARDWARE, attestedBy: "operator", now: new Date(Date.UTC(2026, 9, 29, 13)),
  });
  assert.ok(built.ok, JSON.stringify(built));
  return built.evidence;
};
/** Writes the evidence bytes as the producer does and returns the producer's manifest entry for them. */
const producerEntry = (evidence: object, candidateCommit?: string): ReleaseGateSubmission => {
  const name = "recovery-" + (counter += 1) + ".json";
  const bytes = JSON.stringify(evidence, null, 2) + "\n";
  mkdirSync(join(root, "evidence"), { recursive: true });
  writeFileSync(join(root, "evidence", name), bytes);
  return recoveryAdmissionRecordOf(evidence as never, "evidence/" + name, bytes, candidateCommit);
};

test("#344 N1: the recovery producer's manifest entry names the candidate when a path's contract commit is not the candidate, and keeps the evidence commit in the single-path form", async () => {
  // Multi-path: the Bicep recovery ran at the commit carrying the Bicep contract. The entry passed the candidate names it, and is admitted.
  const bicep = byGate("act:azure-bicep");
  const multi = recoveryFor(bicep, bicep.commit);
  const named = producerEntry(multi, CANDIDATE);
  assert.equal(named.sourceCommit, CANDIDATE);
  assert.equal(await statusOf(manifestOf(allPaths(), [named]), "act-run-recovery"), "EVIDENCE_PRESENT");
  // Without the candidate, the entry names the evidence's commit, which admission refuses for this candidate (fails closed).
  const unnamed = producerEntry(multi);
  assert.equal(unnamed.sourceCommit, bicep.commit);
  assert.equal(await statusOf(manifestOf(allPaths(), [unnamed]), "act-run-recovery"), "BLOCKED");
  // The evidence bytes and hash are the same either way; only the entry's index field differs.
  assert.equal(named.evidenceSha256, producerEntry(multi).evidenceSha256);
  // Single path: the apply ran at the candidate, so the entry is exactly what it was before (the evidence's commit) and is admitted.
  const aws = byGate("act:aws-terraform");
  const single = recoveryFor(aws, CANDIDATE);
  const entry = producerEntry(single);
  assert.equal(entry.sourceCommit, CANDIDATE);
  assert.deepEqual(producerEntry(single, CANDIDATE).sourceCommit, entry.sourceCommit);
  const scope = { provider: "AWS", engine: "TERRAFORM", contractSha256: pilotContractSha256(aws.contract) };
  assert.equal(await statusOf(manifestOf({ actPilot: scope }, [entry]), "act-run-recovery", { pilotContract: aws.contract }), "EVIDENCE_PRESENT");
  assert.throws(() => producerEntry(single, "HEAD"), /RECOVERY_CANDIDATE_COMMIT_INVALID/);
});

test("the multi-path form is exact: it is PILOT only, never beside actPilot, well formed, one entry per path, and the candidate's own enabled contract must be one of them", async () => {
  const gcp = byGate("act:gcp-terraform");
  const aws = byGate("act:aws-terraform");
  const blockersOf = async (fields: Record<string, unknown>, options?: Parameters<typeof review>[1]) => actBlockers(await review(manifestOf(fields), options));
  assert.deepEqual(await blockersOf({ actPilots: [entryOf(gcp)], infrastructureAct: "DISABLED" }), ["ACT_PILOT_SCOPE_ON_NON_PILOT_RELEASE"]);
  assert.deepEqual(await blockersOf({ actPilots: [entryOf(gcp)], actPilot: { provider: "GCP", engine: "TERRAFORM", contractSha256: pilotContractSha256(gcp.contract) } }), ["ACT_PILOT_SCOPE_AMBIGUOUS"]);
  for (const malformed of [[], {}, null, "GCP", [{ ...entryOf(gcp), extra: true }], [{ ...entryOf(gcp), contractCommit: "HEAD" }], [{ ...entryOf(gcp), contractSha256: "x" }],
    [(({ contractCommit: _c, ...rest }) => rest)(entryOf(gcp))]]) {
    assert.deepEqual(await blockersOf({ actPilots: malformed }), ["ACT_PILOT_PATHS_MALFORMED"], JSON.stringify(malformed));
  }
  assert.deepEqual(await blockersOf({ actPilots: [entryOf(gcp), entryOf(gcp)] }), ["ACT_PILOT_PATH_DUPLICATE:act:gcp-terraform"]);
  assert.deepEqual(await blockersOf({ actPilots: [{ ...entryOf(gcp), provider: "*", engine: "*" }] }), ["ACT_PILOT_COMBINATION_NOT_ALLOWED:act:*-*"]);
  // The candidate carries the AWS Terraform contract, enabled: a release that declares only GCP Terraform is refused.
  assert.deepEqual(await blockersOf({ actPilots: [entryOf(gcp)] }, { contractAt: readerOf(), pilotContract: aws.contract }), ["ACT_PILOT_SHIPPED_CONTRACT_NOT_DECLARED"]);
  assert.deepEqual(await blockersOf({ actPilots: [entryOf(gcp), entryOf(aws)] }, { contractAt: readerOf(), pilotContract: aws.contract }), []);
});

test("the git contract reader reads a path's contract from its commit and names every path that differs from the candidate (a temporary repository; SYNTHETIC)", async () => {
  const repo = mkdtempSync(join(tmpdir(), "alz-release-paths-git-"));
  try {
    const git = (...args: string[]) => execFileSync("git", ["-C", repo, "-c", "commit.gpgsign=false", "-c", "user.email=fixture@example.invalid", "-c", "user.name=fixture", ...args], { encoding: "utf8" }).trim();
    git("init", "-q");
    mkdirSync(join(repo, "config"), { recursive: true });
    mkdirSync(join(repo, "src"), { recursive: true });
    writeFileSync(join(repo, "src", "product.ts"), "export const x = 1;\n");
    git("add", "-A"); git("commit", "-q", "-m", "candidate");
    const candidate = git("rev-parse", "HEAD");
    const gcp = byGate("act:gcp-terraform");
    writeFileSync(join(repo, CONTRACT_FILE), gcp.text);
    git("add", "-A"); git("commit", "-q", "-m", "GCP contract");
    const contractOnly = git("rev-parse", "HEAD");
    writeFileSync(join(repo, "src", "product.ts"), "export const x = 2;\n");
    git("add", "-A"); git("commit", "-q", "-m", "product change");
    const withProduct = git("rev-parse", "HEAD");
    const read = gitContractReader(repo, candidate);
    const one = await read(contractOnly);
    assert.ok(one.ok);
    assert.deepEqual(one.changedPaths, [CONTRACT_FILE]);
    assert.equal(one.contract.enabled, true);
    assert.equal(pilotContractSha256(one.contract as PilotContract), pilotContractSha256(gcp.contract));
    const two = await read(withProduct);
    assert.ok(two.ok);
    assert.deepEqual(two.changedPaths.sort(), [CONTRACT_FILE, "src/product.ts"]);
    const none = await read(candidate);
    assert.ok(none.ok);
    assert.deepEqual([none.changedPaths, none.contract.enabled], [[], false], "the candidate carries no contract");
    assert.equal((await read("f".repeat(40))).ok, false);
    assert.equal((await read("HEAD")).ok, false);
    // Through the review: the contract-only commit binds; the commit that also changed product code is refused.
    const entry = { ...entryOf(gcp), contractCommit: contractOnly };
    const manifest = (e: Record<string, unknown>) => ({ schemaVersion: 1, sourceCommit: candidate, operatingMode: "PREVIEW_OPERATE", infrastructureAct: "PILOT", records: [], actPilots: [e] }) as unknown as ReleaseAdmissionInput;
    const ok = await reviewProductionRelease({ manifest: manifest(entry), root: repo, expectedCommit: candidate, contractAt: read });
    assert.deepEqual(actBlockers(ok), []);
    const bad = await reviewProductionRelease({ manifest: manifest({ ...entry, contractCommit: withProduct }), root: repo, expectedCommit: candidate, contractAt: read });
    assert.deepEqual(actBlockers(bad), ["ACT_PILOT_CONTRACT_COMMIT_CHANGES_PRODUCT:act:gcp-terraform"]);
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

test("#344 N2: contract-commit provenance on temporary repositories: a tag id, a dangling object and an unrelated history are refused; a later contract commit on the candidate's line and a merge commit are accepted (SYNTHETIC)", async () => {
  const repo = mkdtempSync(join(tmpdir(), "alz-release-provenance-"));
  try {
    const git = (...args: string[]) => execFileSync("git", ["-C", repo, "-c", "commit.gpgsign=false", "-c", "tag.gpgsign=false", "-c", "user.email=fixture@example.invalid", "-c", "user.name=fixture", ...args], { encoding: "utf8" }).trim();
    const commitAll = (message: string) => { git("add", "-A"); git("commit", "-q", "-m", message); return git("rev-parse", "HEAD"); };
    git("init", "-q", "-b", "main");
    mkdirSync(join(repo, "config"), { recursive: true });
    mkdirSync(join(repo, "src"), { recursive: true });
    writeFileSync(join(repo, "src", "product.ts"), "export const x = 1;\n");
    const candidate = commitAll("candidate");
    const gcp = byGate("act:gcp-terraform");
    const bicep = byGate("act:azure-bicep");
    writeFileSync(join(repo, CONTRACT_FILE), gcp.text);
    const first = commitAll("GCP contract");
    writeFileSync(join(repo, CONTRACT_FILE), bicep.text);
    const second = commitAll("Bicep contract replaces it");
    const read = gitContractReader(repo, candidate);
    const provenance = async (commit: string) => { const r = await read(commit); return r.ok ? "OK" : r.provenance === true ? "PROVENANCE" : "UNREADABLE"; };
    // The owner's line: each contract commit descends from the candidate. The second one's parent is the first, not the candidate.
    assert.equal(await provenance(first), "OK");
    assert.equal(await provenance(second), "OK");
    const later = await read(second);
    assert.ok(later.ok && later.contract.enabled === true && (later.contract as PilotContract).engine === "BICEP");
    // A reviewed change that lands as a merge commit is accepted too.
    git("checkout", "-q", "-b", "review", candidate);
    mkdirSync(join(repo, "config"), { recursive: true });
    writeFileSync(join(repo, CONTRACT_FILE), gcp.text);
    commitAll("GCP contract on a review branch");
    git("checkout", "-q", "main");
    git("merge", "-q", "--no-ff", "-X", "theirs", "-m", "merge the reviewed contract", "review");
    const merged = git("rev-parse", "HEAD");
    assert.equal(await provenance(merged), "OK");
    // An annotated tag on the right commit: its id is not the commit's.
    git("tag", "-a", "-m", "contract", "contract-tag", first);
    const tagId = git("rev-parse", "contract-tag");
    assert.notEqual(tagId, first);
    assert.equal(await provenance(tagId), "PROVENANCE");
    // A dangling object: the right parent and tree, but on no branch or tag.
    const dangling = git("commit-tree", git("rev-parse", first + "^{tree}"), "-p", candidate, "-m", "dangling");
    assert.equal(await provenance(dangling), "PROVENANCE");
    // An unrelated history: the same files, on its own branch, with no ancestor in common with the candidate.
    git("checkout", "-q", "--orphan", "unrelated");
    const orphan = commitAll("unrelated history");
    git("checkout", "-q", "main");
    assert.equal(await provenance(orphan), "PROVENANCE");
    // A commit the store does not hold is unreadable, never guessed.
    assert.equal(await provenance("f".repeat(40)), "UNREADABLE");
    // Through the review, each refusal is a provenance blocker that names the gate.
    const manifest = (commit: string) => ({ schemaVersion: 1, sourceCommit: candidate, operatingMode: "PREVIEW_OPERATE", infrastructureAct: "PILOT", records: [], actPilots: [{ ...entryOf(gcp), contractCommit: commit }] }) as unknown as ReleaseAdmissionInput;
    for (const commit of [tagId, dangling, orphan]) {
      const r = await reviewProductionRelease({ manifest: manifest(commit), root: repo, expectedCommit: candidate, contractAt: read });
      assert.deepEqual(actBlockers(r), ["ACT_PILOT_CONTRACT_COMMIT_PROVENANCE:act:gcp-terraform"], commit);
    }
    assert.deepEqual(actBlockers(await reviewProductionRelease({ manifest: manifest(first), root: repo, expectedCommit: candidate, contractAt: read })), []);
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

test("#351 review N3: a contract commit counts as reachable only from a local branch or an origin branch; a stash, a tag, another remote's ref or a pull-request ref is not enough (SYNTHETIC)", async () => {
  const repo = mkdtempSync(join(tmpdir(), "alz-release-reachability-"));
  try {
    const git = (...args: string[]) => execFileSync("git", ["-C", repo, "-c", "commit.gpgsign=false", "-c", "tag.gpgsign=false", "-c", "user.email=fixture@example.invalid", "-c", "user.name=fixture", ...args], { encoding: "utf8" }).trim();
    git("init", "-q", "-b", "main");
    mkdirSync(join(repo, "config"), { recursive: true });
    writeFileSync(join(repo, "README"), "candidate\n");
    git("add", "-A"); git("commit", "-q", "-m", "candidate");
    const candidate = git("rev-parse", "HEAD");
    writeFileSync(join(repo, CONTRACT_FILE), byGate("act:gcp-terraform").text);
    git("add", "-A");
    const tree = git("write-tree");
    git("reset", "-q", "--hard", candidate);
    // Each commit carries the right tree and descends from the candidate; only the ref that holds it differs.
    const commitOn = (ref: string, label: string): string => { const c = git("commit-tree", tree, "-p", candidate, "-m", label); git("update-ref", ref, c); return c; };
    const read = gitContractReader(repo, candidate);
    const provenance = async (commit: string) => { const r = await read(commit); return r.ok ? "OK" : r.provenance === true ? "PROVENANCE" : "UNREADABLE"; };
    assert.equal(await provenance(commitOn("refs/heads/contract", "local branch")), "OK");
    assert.equal(await provenance(commitOn("refs/remotes/origin/contract", "origin branch")), "OK");
    for (const ref of ["refs/stash", "refs/tags/contract-only", "refs/remotes/fork/contract", "refs/pull/7/head", "refs/notes/contract", "refs/original/refs/heads/main"]) {
      assert.equal(await provenance(commitOn(ref, "only " + ref)), "PROVENANCE", ref);
    }
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

test("the AWS Terraform, AWS CDK and Azure Terraform single-path releases are unchanged: each is admitted with its own contract, and its own live record is admitted", async () => {
  for (const gate of ["act:aws-terraform", "act:aws-cdk", "act:azure-terraform"]) {
    const p = byGate(gate);
    const scope = { provider: p.provider, engine: p.engine, contractSha256: pilotContractSha256(p.contract) };
    const result = await review(manifestOf({ actPilot: scope }, [attach(gate, "LIVE_ACT", liveOf(p, { sourceCommit: CANDIDATE }))]), { pilotContract: p.contract });
    assert.deepEqual(actBlockers(result), [], gate);
    assert.deepEqual(result.actPilot, scope);
    assert.deepEqual(result.actPilots, []);
    assert.equal(result.gates.find((g) => g.id === gate)?.status, "EVIDENCE_PRESENT", gate);
    // Its record at another commit than the candidate, or under another contract, is refused as before.
    const at = async (over: Record<string, unknown>) => (await review(manifestOf({ actPilot: scope }, [attach(gate, "LIVE_ACT", liveOf(p, { sourceCommit: CANDIDATE, ...over }))]), { pilotContract: p.contract })).gates.find((g) => g.id === gate)?.status;
    assert.equal(await at({ sourceCommit: p.commit }), "BLOCKED", gate);
    assert.equal(await at({ contractSha256: "9".repeat(64) }), "BLOCKED", gate);
  }
});
