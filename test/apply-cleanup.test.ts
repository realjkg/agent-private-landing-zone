import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { signApproval } from "../src/apply/approval.js";
import { buildCleanupProposal, computeProposalSha256, isAwsIdentityType, proposalProblems, protectedDeletionIn, verifyCleanupProposal, type CleanupProposal } from "../src/apply/cleanup-proposal.js";
import { CLEANUP_SUFFIX, SUFFIX, loadPilotContract, pilotContractSha256 } from "../src/apply/contract.js";
import { pilotUnitOf } from "../src/apply/unit.js";
import { cleanupScopeProblem, runApply, runCleanup, sealPreview, type ApplyDeps, type ApplyRequest, type CleanupRequest } from "../src/apply/driver.js";
import { cleanupEvidenceProblems } from "../src/apply/evidence.js";
import { readCleanupEvidence, reserveArtifact } from "../src/apply/ledger.js";
import { verifyLeftovers } from "../src/apply/leftovers.js";
import { loadRunRecords, observeRun, verifyProposalLeftovers } from "../src/apply/observe.js";
import { openNonceStore } from "../src/apply/nonces.js";
import { loadSealedPlan } from "../src/apply/seal.js";
import {
  BLUEPRINT_SUFFIX, OBSERVATION_SUFFIX, blueprintRecordProblems, leftoversRecordProblems, observationRecordProblems, readBlueprintRecord, readObservationRecord,
  recordSha256, writeBlueprintRecord, type BlueprintRecord,
} from "../src/apply/run-records.js";
import { CLEANUP_ADAPTER, CLEANUP_APPLY_ARGV, CLEANUP_SHOW_ARGV, cleanupPlanArgv, isAllowedCleanupArgv } from "../src/apply/terraform.js";
import type { ApplyEnvironment, PilotContract, SignedApproval } from "../src/apply/types.js";
import { blueprintFromTerraformStatePull } from "../src/observe/blueprint.js";
import { isAllowedReadArgv } from "../src/observe/aws-cli.js";
import { readEncryptedEvidence } from "../src/evidence/vault.js";
import { removeTree } from "../src/teardown/driver/cleanup.js";
import { canonicalJson } from "../src/teardown/manifest.js";
import { sha256 } from "../src/util/sha256.js";
import {
  AWS_DEV_TARGET, AWS_REGION, CANARIES, NOW, POLICY, SOURCE_COMMIT, STATE_CANARY, VALUE_CANARY, awsContractJson, awsIdentityEnv, awsReadCallsOf, awsRoleArn, awsTargetOf,
  approvalFor, behave as behaveIn, behaveAwsReads, callsOf, human, installFakeAwsReads, installFakeTerraform, keys, pinPathOf, stateResource, testFixtureForgeQualificationEvidence,
  writePinnedContract, writeProject, type AwsReadBehavior, type Behavior,
} from "./helpers/apply-fixtures.js";

// The AWS Terraform observe and cleanup steps (docs/observe-and-cleanup.md, docs/act-pilot-plan.md "Cleanup of pilot-created
// resources"): the blueprint the driver records from the engine's state, the independent Cloud Control observation under
// DISCOVERY, the hash-identified cleanup proposal, the separately approved cleanup the APPLY identity executes on exactly
// that list, and the leftover check. The engine and the AWS CLI are fakes, so this is SYNTHETIC evidence: it pins the
// product's logic and never stands for a live account. Fixtures only: no real account, bucket, role or approver.

const root = mkdtempSync(join(tmpdir(), "alz-cleanup-"));
const toolDir = mkdtempSync(join(tmpdir(), "alz-cleanup-tf-"));
const awsToolDir = mkdtempSync(join(tmpdir(), "alz-cleanup-aws-"));
process.env.AGENTIC_EVIDENCE_KEY = randomBytes(32).toString("base64");
process.chdir(root);
test.after(() => { removeTree(root); removeTree(toolDir); removeTree(awsToolDir); });
installFakeTerraform(toolDir);
installFakeAwsReads(awsToolDir);

let counter = 0;
const fresh = (label: string): string => {
  const dir = join(root, label + "-" + ++counter);
  mkdirSync(dir, { recursive: true });
  return dir;
};
const KILL = join(root, "KILL");

// The run's shape: two resources the plan creates, the pre-existing state bucket (the backend), an identity role, and one resource the plan never mentioned.
const BUCKET = "examplefake-pilot-logs";
const BUCKET_ARN = "arn:aws:s3:::" + BUCKET;
const LOG = "/alz/pilot/canary";
const LOG_ARN = "arn:aws:logs:us-east-1:111111111111:log-group:" + LOG;
const STATE_BUCKET = AWS_DEV_TARGET.backend.split("/")[0];
const OLD_QUEUE = "https://sqs.us-east-1.amazonaws.com/111111111111/pre-existing";
const KMS = "1234abcd-12ab-34cd-56ef-1234567890ab";
const AWS_PROVIDER_CONFIG = { aws: { name: "aws", full_name: "registry.terraform.io/hashicorp/aws", expressions: { region: { references: ["var.region"] } } } };
const CREATES = [
  { address: "aws_s3_bucket.logs", type: "aws_s3_bucket", change: { actions: ["create"], before: null, after: { secret: VALUE_CANARY } } },
  { address: "aws_s3_bucket_versioning.logs", type: "aws_s3_bucket_versioning", change: { actions: ["create"], before: null, after: {} } },
  { address: "aws_cloudwatch_log_group.canary", type: "aws_cloudwatch_log_group", change: { actions: ["create"], before: null, after: {} } },
  { address: "aws_s3_bucket.state", type: "aws_s3_bucket", change: { actions: ["update"], before: {}, after: {} } },
];
const STATE = [
  stateResource("aws_s3_bucket", "logs", BUCKET, BUCKET_ARN),
  stateResource("aws_s3_bucket_versioning", "logs", BUCKET),
  stateResource("aws_cloudwatch_log_group", "canary", LOG, LOG_ARN),
  stateResource("aws_s3_bucket", "state", STATE_BUCKET, "arn:aws:s3:::" + STATE_BUCKET),
  stateResource("aws_iam_role", "apply", "alz-apply-dev", awsRoleArn("APPLY", "DEV")),
  stateResource("aws_sqs_queue", "preexisting", OLD_QUEUE, "arn:aws:sqs:us-east-1:111111111111:pre-existing"),
];
// What the fake cloud holds, by the identifier Cloud Control names each type by: a role by its name, a queue by its URL.
const EXISTING = [BUCKET, LOG, STATE_BUCKET, OLD_QUEUE, "alz-apply-dev"];
/** The deletion unit of the DEV state container under the fixture contract: what the sealed plan must stamp and the fake cloud lists by. */
const fixtureContractPath = (() => { const path = join(fresh("contract"), "act-pilot-contract.json"); writePinnedContract(path, awsContractJson(KILL)); return path; })();
const UNIT = pilotUnitOf({ provider: "AWS", contractSha256: pilotContractSha256(loadPilotContract(fixtureContractPath, pinPathOf(fixtureContractPath)) as PilotContract), environment: "DEV", target: awsTargetOf("DEV") });
const behave = (behavior: Behavior = {}) => behaveIn(toolDir, KILL, { applyAdvance: true, showOnlyConfigured: true, showResources: CREATES, showProviderConfig: AWS_PROVIDER_CONFIG, stateResources: STATE, unitTags: { ...UNIT.tags }, ...behavior });
/** The ARNs the fake tagging API lists for this unit: what the plan created and nothing else, unless a test says otherwise. */
const TAGGED = [BUCKET_ARN, LOG_ARN];
const cloud = (behavior: AwsReadBehavior = {}) => behaveAwsReads(awsToolDir, { existing: EXISTING, tagged: TAGGED, ...behavior });
const calls = () => callsOf(toolDir);
const applyCalls = () => calls().filter((c) => c.args[0] === "apply");

type World = { deps: ApplyDeps; dirs: { scratch: string; evidence: string; nonces: string }; contractPath: string };
let vaultDir = "";
test.before(async () => {
  vaultDir = fresh("qualification");
  await testFixtureForgeQualificationEvidence(vaultDir, undefined, "AWS");
});
function world(contract: unknown = awsContractJson(KILL)): World {
  behave();
  cloud();
  const dirs = { scratch: fresh("scratch"), evidence: fresh("evidence"), nonces: fresh("nonces") };
  const contractPath = join(fresh("contract"), "act-pilot-contract.json");
  writePinnedContract(contractPath, contract);
  return {
    dirs, contractPath,
    deps: {
      sourceCommit: SOURCE_COMMIT, contractPath, contractPinPath: pinPathOf(contractPath), qualificationDir: vaultDir, evidenceDir: dirs.evidence, nonces: openNonceStore(dirs.nonces),
      env: awsIdentityEnv("DEV"), now: () => NOW, scratchParent: dirs.scratch, toolDirs: [toolDir, awsToolDir], killPollMs: 40, killGraceMs: 400,
    },
  };
}
const observeDeps = (w: World, now: Date = new Date(NOW.getTime() + 60_000)) => ({
  contractPath: w.contractPath, contractPinPath: pinPathOf(w.contractPath), evidenceDir: w.dirs.evidence, env: w.deps.env, toolDirs: w.deps.toolDirs, scratchParent: w.dirs.scratch, now: () => now,
});

async function seal(w: World, environment: ApplyEnvironment = "DEV", mainTf = 'resource "aws_s3_bucket" "logs" {}\n') {
  const target = awsTargetOf(environment);
  const p = writeProject(fresh("project"), target, mainTf);
  const result = await sealPreview({ invocation: human(target), environment, target, manifest: p.manifest, projectRoot: p.projectRoot, policyVersion: POLICY, resolved: p.resolved }, w.deps);
  assert.ok(result.ok, JSON.stringify(result));
  const loaded = await loadSealedPlan(result.path);
  assert.ok(loaded.ok);
  return { sealed: result.sealed, project: p, loaded: { sealed: loaded.sealed, planBytes: loaded.planBytes } };
}
type Sealed = Awaited<ReturnType<typeof seal>>;
const apply = (w: World, s: Sealed, approvals: SignedApproval[] = [approvalFor(s.sealed, "alice")], over: Partial<ApplyRequest> = {}) => runApply({
  invocation: human(s.sealed.target), environment: s.sealed.environment, target: { ...s.sealed.target }, sealedPlan: s.loaded, manifest: s.project.manifest, projectRoot: s.project.projectRoot, approvals, ...over,
}, w.deps);

/** Seal, apply and observe one run: the start of every cleanup. */
async function applied(w: World) {
  const s = await seal(w);
  const result = await apply(w, s);
  assert.ok(result.ok, JSON.stringify(result));
  return { s, evidence: result.evidence };
}
async function observed(w: World) {
  const run = await applied(w);
  const observation = await observeRun(run.s.sealed.artifactSha256, observeDeps(w));
  assert.ok(observation.ok, JSON.stringify(observation));
  return { ...run, observation };
}
async function proposed(w: World) {
  const run = await observed(w);
  const records = await loadRunRecords(run.s.sealed.artifactSha256, w.dirs.evidence);
  assert.ok(records.ok, JSON.stringify(records));
  const contract = JSON.parse(JSON.stringify(awsContractJson(KILL))) as never;
  const built = buildCleanupProposal({
    ...records, changes: run.s.sealed.changes, channel: "CLI", contract: { ...(contract as object), enabled: true } as never, engineVersion: run.s.sealed.engineVersion, env: w.deps.env!, now: new Date(NOW.getTime() + 120_000),
  });
  assert.ok(built.ok, JSON.stringify(built));
  return { ...run, records, proposal: built.proposal };
}
const cleanupApproval = (proposal: CleanupProposal, who: keyof typeof keys, over: Partial<SignedApproval["statement"]> = {}): SignedApproval => signApproval({
  schemaVersion: 1, artifactSha256: proposal.proposalSha256, environment: proposal.environment, target: proposal.target, approverId: who,
  issuedAt: new Date(NOW.getTime() - 5 * 60_000).toISOString(), expiresAt: new Date(NOW.getTime() + 25 * 60_000).toISOString(), nonce: randomBytes(16).toString("hex"), ...over,
}, keys[who].priv, "CLEANUP");
const cleanup = (w: World, run: Awaited<ReturnType<typeof proposed>>, approvals: SignedApproval[] = [cleanupApproval(run.proposal, "alice")], over: Partial<CleanupRequest> = {}) => runCleanup({
  invocation: human(run.s.sealed.target), environment: "DEV", target: { ...run.s.sealed.target }, proposal: run.proposal, sealedPlan: run.s.loaded, manifest: run.s.project.manifest, projectRoot: run.s.project.projectRoot, approvals, ...over,
}, w.deps);
const refused = (result: { ok: boolean }, code: string) => {
  assert.equal(result.ok, false, JSON.stringify(result));
  assert.equal((result as { code: string }).code, code, JSON.stringify(result));
};
const destroyPlans = () => calls().filter((c) => c.args[0] === "plan" && c.args[1] === "-destroy");

// --- observe -----------------------------------------------------------------------------------------------

test("AWS Terraform observe: after a successful apply the driver records the blueprint from the state, identifiers only, and observe verifies each resource through Cloud Control as DISCOVERY", async () => {
  const w = world();
  const { s, evidence } = await applied(w);
  assert.ok(existsSync(join(w.dirs.evidence, s.sealed.artifactSha256 + BLUEPRINT_SUFFIX)), "the blueprint sits beside the apply evidence");
  const blueprint = await readBlueprintRecord(s.sealed.artifactSha256, sha256(canonicalJson(evidence as never)), w.dirs.evidence);
  assert.ok(blueprint);
  assert.deepEqual(blueprint.blueprint.entries.map((e) => [e.address, e.origin, e.id, e.arn]), [
    ["aws_cloudwatch_log_group.canary", "IN_PLAN", LOG, LOG_ARN], ["aws_iam_role.apply", "NOT_IN_PLAN", "alz-apply-dev", awsRoleArn("APPLY", "DEV")],
    ["aws_s3_bucket.logs", "IN_PLAN", BUCKET, BUCKET_ARN], ["aws_s3_bucket.state", "IN_PLAN", STATE_BUCKET, "arn:aws:s3:::" + STATE_BUCKET],
    ["aws_s3_bucket_versioning.logs", "IN_PLAN", BUCKET, null], ["aws_sqs_queue.preexisting", "NOT_IN_PLAN", OLD_QUEUE, "arn:aws:sqs:us-east-1:111111111111:pre-existing"],
  ]);
  assert.deepEqual(blueprint.blueprint.missing, []);
  assert.equal(blueprint.source, "TERRAFORM_STATE_PULL");
  const raw = JSON.stringify(await readEncryptedEvidence(join(w.dirs.evidence, s.sealed.artifactSha256 + BLUEPRINT_SUFFIX)));
  for (const canary of [...CANARIES, STATE_CANARY]) assert.ok(!raw.includes(canary), "a state value reached the blueprint: " + canary);
  // The state pull that fed the blueprint ran as STATE, after the apply.
  const steps = calls().map((c) => [c.args[0], c.env.AWS_ROLE_ARN]);
  assert.deepEqual(steps.slice(-2), [["state", awsRoleArn("STATE", "DEV")], ["state", awsRoleArn("STATE", "DEV")]]);

  const observation = await observeRun(s.sealed.artifactSha256, observeDeps(w));
  assert.ok(observation.ok, JSON.stringify(observation));
  assert.equal(observation.record.verdict, "PARTIAL", "a bucket setting cannot be read alone, so apply success alone never reads VERIFIED for everything");
  assert.deepEqual(observation.record.resources.map((r) => [r.address, r.result]), [
    ["aws_cloudwatch_log_group.canary", "VERIFIED"], ["aws_iam_role.apply", "VERIFIED"], ["aws_s3_bucket.logs", "VERIFIED"], ["aws_s3_bucket.state", "VERIFIED"],
    ["aws_s3_bucket_versioning.logs", "UNVERIFIABLE"], ["aws_sqs_queue.preexisting", "VERIFIED"],
  ]);
  assert.equal(blueprint.unitId, UNIT.unitId, "the blueprint carries the unit the sealed plan stamped");
  assert.equal(s.sealed.unit?.unitId, UNIT.unitId);
  assert.deepEqual(s.sealed.unit?.untagged, [], "the fake provider stamps every created resource, as default_tags would");
  assert.equal(observation.record.inventory, "COMPLETE", "the run carries its unit tag, so the sweep by it ran and was complete");
  assert.deepEqual(observation.record.unexpected, []);
  assert.match(observation.record.verifierBinarySha256 ?? "", /^[0-9a-f]{64}$/);
  const reads = awsReadCallsOf(awsToolDir);
  assert.equal(reads.length, 6, "one read per checkable resource, and one tag listing for the unit");
  assert.deepEqual(reads.filter((r) => r.args[0] === "resourcegroupstaggingapi").map((r) => r.args.slice(0, 4)), [["resourcegroupstaggingapi", "get-resources", "--tag-filters", "Key=alz-unit,Values=" + UNIT.unitId]]);
  for (const read of reads.filter((r) => r.args[0] !== "resourcegroupstaggingapi")) {
    assert.equal(read.args[1], "get-resource");
    assert.equal(read.env.AWS_ROLE_ARN, awsRoleArn("DISCOVERY", "DEV"), "the verifier reads as DISCOVERY");
    assert.equal(read.env.AWS_EC2_METADATA_DISABLED, "true");
    assert.ok(!JSON.stringify(read.env).includes("alz-apply") && !JSON.stringify(read.env).includes("AKIAFAKEOPERATORKEY00"), "no other identity reaches the verifier");
  }
  const stored = JSON.stringify(await readEncryptedEvidence(join(w.dirs.evidence, s.sealed.artifactSha256 + OBSERVATION_SUFFIX)));
  assert.ok(!stored.includes("CANARY_CLOUD_PROPERTY"), "no cloud property is recorded");
  assert.deepEqual(readdirSync(w.dirs.scratch), [], "the verifier's private directory is removed");
});

test("observe refuses a run with no apply evidence, a blueprint that is not this run's, and a forged blueprint record, and reads nothing from the cloud", async () => {
  const w = world();
  refused(await observeRun("a".repeat(64), observeDeps(w)), "RUN_RECORD_MISSING");
  const { s, evidence } = await applied(w);
  const applyEvidenceSha256 = sha256(canonicalJson(evidence as never));
  // A blueprint record forged for another apply evidence, or with a raw state field, is not this run's record.
  const genuine = (await readBlueprintRecord(s.sealed.artifactSha256, applyEvidenceSha256, w.dirs.evidence))!;
  assert.deepEqual(blueprintRecordProblems({ ...genuine, applyEvidenceSha256: "b".repeat(64) }), []);
  assert.equal(await readBlueprintRecord(s.sealed.artifactSha256, "b".repeat(64), w.dirs.evidence), undefined, "a blueprint stands only for the evidence it names");
  assert.match(blueprintRecordProblems({ ...genuine, state: { secret: 1 } }).join(), /raw state or output field/);
  assert.match(blueprintRecordProblems({ ...genuine, blueprint: { entries: [{ address: "a", type: "t", arn: null, id: "x", origin: "IN_PLAN", values: {} }], missing: [] } }).join(), /entries must carry/);
  assert.equal(await writeBlueprintRecord(genuine, w.dirs.evidence), "EXISTS", "a blueprint is written once");
  // A run whose state could not be read leaves no blueprint, and observe says so instead of guessing.
  const other = world();
  behave({ stateResources: [], failOn: undefined });
  const s2 = await seal(other);
  behave({ stateResources: [] });
  const r2 = await apply(other, s2);
  assert.ok(r2.ok);
  const empty = await observeRun(s2.sealed.artifactSha256, observeDeps(other));
  assert.ok(empty.ok);
  assert.equal(empty.record.verdict, "FAILED", "the plan created resources the state never recorded: a failed observation, never a pass");
  assert.deepEqual(empty.record.missingFromState, ["aws_cloudwatch_log_group.canary", "aws_s3_bucket.logs", "aws_s3_bucket.state", "aws_s3_bucket_versioning.logs"]);
  assert.deepEqual(awsReadCallsOf(awsToolDir).map((r) => r.args[0]), ["resourcegroupstaggingapi"], "no resource to read; the unit listing still runs, so an orphan of this unit would be found");
  refused(await (async () => { const records = await loadRunRecords(s2.sealed.artifactSha256, other.dirs.evidence); assert.ok(records.ok); return buildCleanupProposal({ ...records, changes: s2.sealed.changes, channel: "CLI",
    contract: { ...awsContractJson(KILL), enabled: true } as never, engineVersion: s2.sealed.engineVersion, env: other.deps.env!, now: new Date(NOW.getTime() + 120_000) }); })(), "OWNERSHIP_AMBIGUOUS");
});

test("observe records NOT_YET_OBSERVABLE on throttling and UNVERIFIABLE on access denial, never VERIFIED, and can be repeated without applying again", async () => {
  const w = world();
  const { s } = await applied(w);
  const applies = applyCalls().length;
  cloud({ fail: { [LOG]: "An error occurred (ThrottlingException): Rate exceeded", [BUCKET]: "An error occurred (AccessDeniedException): not authorized" } });
  const first = await observeRun(s.sealed.artifactSha256, observeDeps(w));
  assert.ok(first.ok);
  assert.equal(first.record.verdict, "INCONCLUSIVE");
  const byAddress = new Map(first.record.resources.map((r) => [r.address, r]));
  assert.deepEqual([byAddress.get("aws_cloudwatch_log_group.canary")!.result, byAddress.get("aws_cloudwatch_log_group.canary")!.reason], ["NOT_YET_OBSERVABLE", "THROTTLED"]);
  assert.deepEqual([byAddress.get("aws_s3_bucket.logs")!.result, byAddress.get("aws_s3_bucket.logs")!.reason], ["UNVERIFIABLE", "ACCESS_DENIED"]);
  assert.ok(!JSON.stringify(first.record).includes("Rate exceeded"), "the cloud's message is never recorded");
  // The identity itself has no access: nothing is verified and nothing is guessed.
  cloud({ failAll: "An error occurred (AccessDeniedException) when calling the GetResource operation: not authorized" });
  const denied = await observeRun(s.sealed.artifactSha256, observeDeps(w));
  assert.ok(denied.ok);
  assert.ok(denied.record.resources.every((r) => r.result !== "VERIFIED"));
  // Observing again replaces the record with a fresh one; the apply is never repeated.
  cloud();
  const again = await observeRun(s.sealed.artifactSha256, observeDeps(w, new Date(NOW.getTime() + 300_000)));
  assert.ok(again.ok);
  assert.equal(again.record.verdict, "PARTIAL");
  const stored = await readObservationRecord(s.sealed.artifactSha256, again.record.applyEvidenceSha256, w.dirs.evidence);
  assert.equal(stored?.observedAt, new Date(NOW.getTime() + 300_000).toISOString());
  assert.equal(applyCalls().length, applies, "no apply ran");
});

// --- propose -----------------------------------------------------------------------------------------------

test("the proposal lists exactly what this run created and the observation found present, keeps the state backend, the pilot identities and pre-existing resources, and hashes to its identity", async () => {
  const w = world();
  const { proposal } = await proposed(w);
  assert.deepEqual(proposal.deletes.map((d) => [d.address, d.observed, d.identifier]), [
    ["aws_cloudwatch_log_group.canary", "VERIFIED", LOG], ["aws_s3_bucket.logs", "VERIFIED", BUCKET], ["aws_s3_bucket_versioning.logs", "UNVERIFIABLE", BUCKET],
  ], "each by the identifier the verifier reads it by");
  assert.deepEqual(proposal.excluded.map((x) => [x.address, x.ownership]), [
    ["aws_iam_role.apply", "PROTECTED_IDENTITY"], ["aws_s3_bucket.state", "PROTECTED_BACKEND"], ["aws_sqs_queue.preexisting", "NOT_IN_PLAN"],
  ]);
  assert.ok(proposal.deletes.find((d) => d.type === "aws_s3_bucket")!.risk?.includes("objects"), "data loss is named before approval");
  assert.ok(proposal.risks.some((r) => r.includes("depends on it")), "dependents the engine adds are named as a risk");
  assert.deepEqual(proposal.authorization, { subject: "CLEANUP", requiredApprovals: 1, executesAs: "APPLY" });
  assert.equal(proposal.proposalSha256, computeProposalSha256(proposal));
  assert.deepEqual(proposalProblems(proposal), []);
  assert.ok(verifyCleanupProposal(proposal).ok);
  refused(verifyCleanupProposal({ ...proposal, deletes: proposal.deletes.slice(1) }), "PROPOSAL_INVALID");
  refused(verifyCleanupProposal({ ...proposal, deletes: [...proposal.deletes, { ...proposal.deletes[0], address: "aws_sqs_queue.preexisting" }] }), "PROPOSAL_INVALID");
  refused(verifyCleanupProposal({ ...proposal, extra: 1 }), "PROPOSAL_INVALID");
  assert.ok(!JSON.stringify(proposal).includes(VALUE_CANARY) && !JSON.stringify(proposal).includes(STATE_CANARY));
});

test("a proposal is refused on ambiguous ownership (a partial apply, a planned resource the state never held) and on an inconclusive or changed observation", async () => {
  const w = world();
  const run = await observed(w);
  const records = await loadRunRecords(run.s.sealed.artifactSha256, w.dirs.evidence);
  assert.ok(records.ok);
  const contract = { ...awsContractJson(KILL), enabled: true } as never;
  const build = (over: Partial<Parameters<typeof buildCleanupProposal>[0]>) => buildCleanupProposal({
    ...records, changes: run.s.sealed.changes, channel: "CLI", contract, engineVersion: run.s.sealed.engineVersion, env: w.deps.env!, now: new Date(NOW.getTime() + 120_000), ...over,
  });
  refused(build({ applyEvidence: { ...records.applyEvidence, outcome: "PARTIAL_REQUIRES_REVIEW" } }), "OWNERSHIP_AMBIGUOUS");
  refused(build({ blueprint: { ...records.blueprint, blueprint: { ...records.blueprint.blueprint, missing: ["aws_kms_key.planned"] } } }), "OWNERSHIP_AMBIGUOUS");
  refused(build({ observation: { ...records.observation, unexpected: ["arn:aws:sqs:us-east-1:111111111111:tagged-but-not-in-state"] } }), "OBSERVATION_INCONCLUSIVE");
  refused(build({ observation: { ...records.observation, resources: records.observation.resources.map((r) => r.address === "aws_s3_bucket.logs" ? { ...r, result: "NOT_YET_OBSERVABLE" as const, reason: "THROTTLED" } : r) } }), "OBSERVATION_INCONCLUSIVE");
  refused(build({ observation: { ...records.observation, resources: records.observation.resources.map((r) => r.address === "aws_s3_bucket.logs" ? { ...r, result: "UNVERIFIABLE" as const, reason: "ACCESS_DENIED" } : r) } }), "OBSERVATION_INCONCLUSIVE");
  refused(build({ observation: { ...records.observation, observedAt: new Date(NOW.getTime() - 60_000).toISOString() } }), "RUN_RECORD_MISSING");
  refused(build({ blueprint: { ...records.blueprint, applyEvidenceSha256: "c".repeat(64) } }), "RUN_RECORD_MISSING");
  // An address the cleanup cannot name exactly (a bidi character) is never proposed.
  const bidi = { ...records.blueprint, blueprint: { ...records.blueprint.blueprint, entries: records.blueprint.blueprint.entries.map((e) => e.address === "aws_s3_bucket.logs" ? { ...e, address: "aws_s3_bucket.lo‮gs" } : e) } };
  refused(build({ blueprint: bidi }), "OWNERSHIP_AMBIGUOUS");
  // A resource already gone is listed as such, and a proposal with nothing to delete is made (verify-cleanup handles it; cleanup refuses to run it).
  cloud({ existing: EXISTING.filter((x) => x !== BUCKET && x !== LOG) });
  const gone = await observeRun(run.s.sealed.artifactSha256, observeDeps(w, new Date(NOW.getTime() + 180_000)));
  assert.ok(gone.ok);
  const after = await loadRunRecords(run.s.sealed.artifactSha256, w.dirs.evidence);
  assert.ok(after.ok);
  const nothing = build({ observation: after.observation, observationSha256: after.observationSha256 });
  assert.ok(nothing.ok, JSON.stringify(nothing));
  assert.deepEqual(nothing.proposal.alreadyAbsent.map((x) => x.address), ["aws_cloudwatch_log_group.canary", "aws_s3_bucket.logs"]);
  assert.deepEqual(nothing.proposal.deletes.map((x) => x.address), ["aws_s3_bucket_versioning.logs"]);
});

// --- cleanup --------------------------------------------------------------------------------------------------

test("AWS Terraform cleanup: approve under the cleanup domain, destroy exactly the proposal's addresses as APPLY after a targeted destroy plan as DISCOVERY, record evidence, and verify every deletion gone", async () => {
  const w = world();
  const run = await proposed(w);
  const before = calls().length;
  const result = await cleanup(w, run);
  assert.ok(result.ok, JSON.stringify(result));
  assert.equal(result.evidence.outcome, "SUCCEEDED");
  assert.deepEqual(result.evidence.deletes, run.proposal.deletes.map((d) => d.address));
  assert.equal(result.evidence.proposalSha256, run.proposal.proposalSha256);
  assert.equal(result.evidence.artifactSha256, run.s.sealed.artifactSha256);
  assert.deepEqual(result.evidence.authority, { infrastructureAct: "PILOT_ENABLED", mutation: "TERRAFORM_DESTROY_OF_APPROVED_PROPOSAL", executedAs: "APPLY", agentInitiated: false });
  assert.deepEqual(result.evidence.adapter, { adapterVersion: CLEANUP_ADAPTER.adapterVersion, argvDigest: CLEANUP_ADAPTER.argvDigest });
  assert.deepEqual(cleanupEvidenceProblems(result.evidence), []);
  const steps = calls().slice(before);
  assert.deepEqual(steps.map((c) => c.args[0]), ["version", "init", "workspace", "state", "plan", "show", "apply", "state"]);
  const roleOf = (index: number) => steps[index].env.AWS_ROLE_ARN;
  assert.equal(roleOf(1), awsRoleArn("STATE_WRITE", "DEV"), "init as STATE_WRITE, as an apply");
  assert.equal(roleOf(3), awsRoleArn("STATE", "DEV"));
  assert.equal(roleOf(4), awsRoleArn("DISCOVERY", "DEV"), "the destroy plan reads providers as DISCOVERY");
  assert.deepEqual(steps[4].args, [...cleanupPlanArgv(run.proposal.deletes.map((d) => d.address))], "the plan targets exactly the proposal's addresses");
  assert.equal(roleOf(5), undefined, "show runs with no identity");
  assert.deepEqual(steps[5].args, [...CLEANUP_SHOW_ARGV]);
  assert.equal(roleOf(6), awsRoleArn("APPLY", "DEV"), "the destroy is applied by the APPLY identity, and no other");
  assert.deepEqual(steps[6].args, [...CLEANUP_APPLY_ARGV]);
  assert.ok(steps[6].planText?.endsWith("DESTROY"), "the plan file applied is the destroy plan made moments before");
  assert.ok(!JSON.stringify(steps[6].env).includes("alz-state") && !JSON.stringify(steps[6].env).includes("alz-discovery"));
  assert.deepEqual(readdirSync(w.dirs.scratch), [], "no scratch directory survives");
  assert.ok(existsSync(join(w.dirs.evidence, run.proposal.proposalSha256 + CLEANUP_SUFFIX)));
  assert.ok(existsSync(join(w.dirs.evidence, run.s.sealed.artifactSha256 + SUFFIX)), "the apply evidence stays untouched");
  assert.deepEqual(await readCleanupEvidence(run.proposal.proposalSha256, w.dirs.evidence), result.evidence);

  // The independent leftover check: the fake cloud now lacks what the destroy removed, and the tagging API lists nothing of this unit.
  cloud({ existing: EXISTING.filter((x) => x !== BUCKET && x !== LOG), tagged: [] });
  const leftovers = await verifyProposalLeftovers(run.proposal, observeDeps(w, new Date(NOW.getTime() + 600_000)));
  assert.ok(leftovers.ok, JSON.stringify(leftovers));
  assert.equal(leftovers.cleanupRan, true);
  // Every named resource is settled and the sweep by the run's unit tag found nothing else: COMPLETE (the #235 contract).
  assert.equal(leftovers.record.disposition, "COMPLETE");
  assert.equal(leftovers.record.sweep, "COMPLETE");
  assert.match(leftoversRecordProblems({ ...leftovers.record, disposition: "KNOWN_ADDRESSES_CONFIRMED" }).join(), /with a sweep the record is COMPLETE or INCOMPLETE/);
  assert.deepEqual(leftovers.record.resources.map((r) => [r.address, r.disposition, r.basis]), [
    ["aws_cloudwatch_log_group.canary", "CONFIRMED_DELETED", "CLOUD_CONTROL_ABSENT"], ["aws_s3_bucket.logs", "CONFIRMED_DELETED", "CLOUD_CONTROL_ABSENT"],
    ["aws_s3_bucket_versioning.logs", "CONFIRMED_DELETED", "PARENT_ABSENT"],
    ["aws_iam_role.apply", "INTENTIONALLY_RETAINED", "RETENTION_DECISION"], ["aws_s3_bucket.state", "INTENTIONALLY_RETAINED", "RETENTION_DECISION"], ["aws_sqs_queue.preexisting", "INTENTIONALLY_RETAINED", "RETENTION_DECISION"],
  ]);
  assert.match(leftovers.record.nextAction, /nothing else carries this run's tag/);
  // Had the fake cloud still listed a resource under this unit's tag, the sweep would have found it and the record would not be complete.
  cloud({ existing: EXISTING.filter((x) => x !== BUCKET && x !== LOG), tagged: ["arn:aws:sqs:us-east-1:111111111111:stray-of-this-unit"] });
  const stray = await verifyProposalLeftovers(run.proposal, observeDeps(w, new Date(NOW.getTime() + 700_000)));
  assert.ok(stray.ok);
  assert.equal(stray.record.disposition, "INCOMPLETE");
  assert.deepEqual(stray.record.resources.filter((r) => r.address === "(not in state)").map((r) => [r.identifier, r.disposition]), [["arn:aws:sqs:us-east-1:111111111111:stray-of-this-unit", "STILL_PRESENT"]]);
  assert.equal(leftovers.record.cleanupEvidenceSha256, sha256(canonicalJson(result.evidence as never)));
  assert.deepEqual(leftoversRecordProblems(leftovers.record), []);
  for (const read of awsReadCallsOf(awsToolDir)) assert.equal(read.env.AWS_ROLE_ARN, awsRoleArn("DISCOVERY", "DEV"));
});

test("cleanup refuses, consuming nothing: a wrong target, an apply approval, an expired or replayed approval, an altered proposal, a proposal of another run or channel, and a second execution", async () => {
  const w = world();
  const run = await proposed(w);
  const nothingRan = () => { assert.equal(destroyPlans().length, 0, "no destroy plan ran"); assert.equal(applyCalls().length, 1, "only the original apply ran"); };
  refused(await cleanup(w, run, undefined, { target: awsTargetOf("QA"), invocation: human(awsTargetOf("QA")) }), "TARGET_NOT_IN_CONTRACT");
  refused(await cleanup(w, run, undefined, { target: awsTargetOf("QA") }), "HUMAN_INVOCATION_REQUIRED");
  refused(await cleanup(w, run, undefined, { environment: "QA" }), "TARGET_NOT_IN_CONTRACT");
  // An apply approval signed over the proposal's hash does not verify: the domains differ.
  refused(await cleanup(w, run, [approvalFor({ ...run.s.sealed, artifactSha256: run.proposal.proposalSha256 }, "alice")]), "APPROVAL_UNVERIFIED");
  // And the sealed plan's own approval names another hash.
  refused(await cleanup(w, run, [approvalFor(run.s.sealed, "alice")]), "APPROVAL_UNVERIFIED");
  refused(await cleanup(w, run, [cleanupApproval(run.proposal, "alice", { issuedAt: new Date(NOW.getTime() - 120 * 60_000).toISOString(), expiresAt: new Date(NOW.getTime() - 60_000).toISOString() })]), "APPROVAL_EXPIRED");
  refused(await cleanup(w, run, [cleanupApproval(run.proposal, "mallory")]), "APPROVER_NOT_ALLOWED");
  refused(await cleanup(w, run, [cleanupApproval(run.proposal, "alice", { target: awsTargetOf("QA") })]), "APPROVAL_MISBOUND");
  refused(await cleanup(w, run, undefined, { proposal: { ...run.proposal, deletes: [...run.proposal.deletes, { address: "aws_sqs_queue.preexisting", type: "aws_sqs_queue", identifier: OLD_QUEUE, ownership: "RUN_CREATED", observed: "VERIFIED" }] } }), "PROPOSAL_INVALID");
  refused(await cleanup(w, run, undefined, { proposal: { ...run.proposal, channel: "UI", proposalSha256: computeProposalSha256({ ...run.proposal, channel: "UI" }) } }), "CHANNEL_MISMATCH");
  refused(await cleanup(w, run, undefined, { proposal: { ...run.proposal, applyEvidenceSha256: "d".repeat(64), proposalSha256: computeProposalSha256({ ...run.proposal, applyEvidenceSha256: "d".repeat(64) }) } }), "RUN_RECORD_MISSING");
  refused(await runCleanup({ invocation: human(run.s.sealed.target), environment: "DEV", target: run.s.sealed.target, proposal: run.proposal, sealedPlan: run.s.loaded, manifest: run.s.project.manifest, projectRoot: run.s.project.projectRoot, approvals: [cleanupApproval(run.proposal, "alice")] },
    { ...w.deps, sourceCommit: "0".repeat(40) }), "SOURCE_CHANGED");
  nothingRan();
  assert.deepEqual(readdirSync(w.dirs.evidence).filter((n) => n.endsWith(CLEANUP_SUFFIX)), [], "no cleanup entry exists");
  // A replayed approval: the same signed approval twice in one set, and a consumed one after a real run.
  const approval = cleanupApproval(run.proposal, "alice");
  refused(await cleanup(w, run, [approval, approval]), "APPROVAL_REPLAYED");
  const done = await cleanup(w, run, [approval]);
  assert.ok(done.ok, JSON.stringify(done));
  refused(await cleanup(w, run, [approval]), "PROPOSAL_ALREADY_EXECUTED");
  refused(await cleanup(w, run, [cleanupApproval(run.proposal, "alice")]), "PROPOSAL_ALREADY_EXECUTED");
  assert.equal(destroyPlans().length, 1, "the destroy planned once");
});

test("a forged, re-hashed proposal never executes: the deletion list is derived again from the sealed plan, the blueprint and the observation, and a protected identity, the state backend, a pre-existing resource, a resource of another run, or a dropped entry is refused before any approval is consumed", async () => {
  const w = world();
  cloud();
  const run = await proposed(w);
  const honest = run.proposal;
  const rehashed = (edit: Partial<CleanupProposal>): CleanupProposal => {
    const fields = { ...honest, ...edit, deletes: [...(edit.deletes ?? honest.deletes)].sort((a, b) => (a.address < b.address ? -1 : 1)) };
    return { ...fields, proposalSha256: computeProposalSha256(fields) };
  };
  const row = (address: string, type: string, identifier: string) => ({ address, type, identifier, ownership: "RUN_CREATED" as const, observed: "VERIFIED" as const });
  const without = (address: string) => honest.excluded.filter((x) => x.address !== address);
  const approval = cleanupApproval(honest, "alice");
  const forgeries: [string, CleanupProposal, string][] = [
    // Each forgery hashes to itself, so the self-hash check passes; the records do not derive it.
    ["the pilot's APPLY role, protected", rehashed({ deletes: [...honest.deletes, row("aws_iam_role.apply", "aws_iam_role", "alz-apply-dev")], excluded: without("aws_iam_role.apply") }), "PROPOSAL_INVALID"],
    ["the state backend bucket, protected", rehashed({ deletes: [...honest.deletes, row("aws_s3_bucket.state", "aws_s3_bucket", STATE_BUCKET)], excluded: without("aws_s3_bucket.state") }), "PROPOSAL_INVALID"],
    ["a resource the state holds but the plan never created", rehashed({ deletes: [...honest.deletes, row("aws_sqs_queue.preexisting", "aws_sqs_queue", OLD_QUEUE)], excluded: without("aws_sqs_queue.preexisting") }), "PROPOSAL_INVALID"],
    ["a resource of another run entirely", rehashed({ deletes: [...honest.deletes, row("aws_s3_bucket.other", "aws_s3_bucket", "examplefake-other-run")] }), "PROPOSAL_INVALID"],
    ["a dropped entry", rehashed({ deletes: honest.deletes.slice(1) }), "PROPOSAL_INVALID"],
    ["a kept resource silently removed from the kept list", rehashed({ excluded: without("aws_sqs_queue.preexisting") }), "PROPOSAL_INVALID"],
    ["a blueprint hash of another record", rehashed({ blueprintSha256: "b".repeat(64) }), "RUN_RECORD_MISSING"],
    ["an observation hash of another record", rehashed({ observationSha256: "c".repeat(64) }), "RUN_RECORD_MISSING"],
  ];
  for (const [label, forged, code] of forgeries) {
    assert.ok(verifyCleanupProposal(forged).ok, label + ": the forgery is self-consistent");
    // The approval is signed over the forged hash: it verifies, and still nothing runs.
    const result = await cleanup(w, { ...run, proposal: forged }, [cleanupApproval(forged, "alice")]);
    assert.equal(result.ok, false, label + ": " + JSON.stringify(result).slice(0, 200));
    refused(result, code);
    assert.match((result as { message: string }).message, /nothing was run|Nothing was run/, label);
  }
  // The sealed plan of another run (another project, so another artifact), or a tampered one, with the honest proposal: refused the same way.
  const other = await seal(w, "DEV", 'resource "aws_s3_bucket" "logs" { force_destroy = true }\n');
  assert.notEqual(other.sealed.artifactSha256, run.s.sealed.artifactSha256);
  refused(await cleanup(w, run, [approval], { sealedPlan: other.loaded }), "PROPOSAL_INVALID");
  refused(await cleanup(w, run, [approval], { sealedPlan: { sealed: run.s.loaded.sealed, planBytes: Buffer.from("x") } }), "ARTIFACT_TAMPERED");
  assert.equal(destroyPlans().length, 0, "no destroy was planned for any forgery");
  assert.equal(applyCalls().length, 1, "only the original apply ran");
  assert.deepEqual(readdirSync(w.dirs.evidence).filter((n) => n.endsWith(CLEANUP_SUFFIX)), [], "nothing was reserved or recorded");
  // The honest proposal with the same, unconsumed approval still runs once.
  const done = await cleanup(w, run, [approval]);
  assert.ok(done.ok, JSON.stringify(done));
  assert.deepEqual(destroyPlans()[0]!.args.filter((a) => a.startsWith("-target=")).sort(), honest.deletes.map((d) => "-target=" + d.address).sort());
});

test("the destroy plan must be exactly the approved list: a dependent the engine adds, an address the state no longer holds, or a non-delete action stops before any approval is consumed", async () => {
  for (const [label, behavior, pattern] of [
    ["dependent", { destroyExtra: [{ address: "aws_sqs_queue.preexisting", type: "aws_sqs_queue", change: { actions: ["delete"] } }] }, /does not list/],
    ["missing", { destroyOmit: ["aws_s3_bucket.logs"] }, /leaves out/],
    ["update", { destroyExtra: [{ address: "aws_s3_bucket.state", type: "aws_s3_bucket", change: { actions: ["update"] } }] }, /would update/],
  ] as const) {
    const w = world();
    const run = await proposed(w);
    behave(behavior as Behavior);
    const approval = cleanupApproval(run.proposal, "alice");
    const result = await cleanup(w, run, [approval]);
    refused(result, "PROPOSAL_SCOPE_MISMATCH");
    assert.match((result as { message: string }).message, pattern, label);
    assert.equal(destroyPlans().length, 1, label + ": the destroy was planned");
    assert.equal(applyCalls().length, 0, label + ": no destroy applied");
    assert.deepEqual(readdirSync(w.dirs.evidence).filter((n) => n.endsWith(CLEANUP_SUFFIX)), [], label + ": the reservation was given back");
    assert.deepEqual(readdirSync(w.dirs.scratch), []);
    // The same approval still works once the state matches the proposal again.
    behave();
    assert.ok((await cleanup(w, run, [approval])).ok, label + ": nothing was consumed");
  }
  assert.equal(cleanupScopeProblem([{ address: "a.b", type: "a", action: "DELETE" }, { address: "output.x", type: "output", action: "DELETE" }], ["a.b"]), undefined, "output changes are not resources");
});

test("a partial or killed cleanup records its outcome and spends the proposal, and leftover verification reports deletion pending or still present, never complete", async () => {
  const w = world();
  const run = await proposed(w);
  // The engine fails after it started: the state serial moved, some resources may be gone.
  behave({ applyExit: 1, applyStderr: "Error: something failed " + VALUE_CANARY, destroyKeeps: ["aws_s3_bucket.logs", "aws_s3_bucket_versioning.logs"] });
  const result = await cleanup(w, run);
  refused(result, "APPLY_FAILED");
  assert.equal((result as { outcome?: string }).outcome, "PARTIAL_REQUIRES_REVIEW");
  assert.ok(!(result as { message: string }).message.includes(VALUE_CANARY), "engine output is withheld");
  const evidence = await readCleanupEvidence(run.proposal.proposalSha256, w.dirs.evidence);
  assert.equal(evidence?.outcome, "PARTIAL_REQUIRES_REVIEW");
  refused(await cleanup(w, run), "PROPOSAL_ALREADY_EXECUTED");
  cloud({ existing: EXISTING.filter((x) => x !== LOG) });
  const leftovers = await verifyProposalLeftovers(run.proposal, observeDeps(w, new Date(NOW.getTime() + 600_000)));
  assert.ok(leftovers.ok);
  assert.equal(leftovers.record.disposition, "INCOMPLETE");
  assert.deepEqual(leftovers.record.resources.filter((r) => r.disposition !== "INTENTIONALLY_RETAINED").map((r) => [r.address, r.disposition, r.basis]), [
    ["aws_cloudwatch_log_group.canary", "CONFIRMED_DELETED", "CLOUD_CONTROL_ABSENT"], ["aws_s3_bucket.logs", "DELETION_PENDING", "CLEANUP_NOT_FINISHED"], ["aws_s3_bucket_versioning.logs", "UNKNOWN", "NOT_INDEPENDENTLY_CHECKABLE"],
  ]);
  assert.match(leftovers.record.nextAction, /reviews the state/);
  assert.match(leftoversRecordProblems({ ...leftovers.record, disposition: "COMPLETE" }).join(), /COMPLETE needs every resource/, "a record cannot claim completion over pending resources");

  // A cleanup that reported success but left a resource behind: STILL_PRESENT, never complete.
  const w2 = world();
  const run2 = await proposed(w2);
  behave({ destroyKeeps: ["aws_s3_bucket.logs"] });
  assert.ok((await cleanup(w2, run2)).ok);
  const still = await verifyProposalLeftovers(run2.proposal, observeDeps(w2, new Date(NOW.getTime() + 600_000)));
  assert.ok(still.ok);
  assert.equal(still.record.disposition, "INCOMPLETE");
  assert.equal(still.record.resources.find((r) => r.address === "aws_s3_bucket.logs")?.disposition, "STILL_PRESENT");
  assert.match(still.record.nextAction, /did not remove everything/);
  // Before any cleanup ran, every proposed resource is pending and the next action says to run it.
  const w3 = world();
  const run3 = await proposed(w3);
  const pending = await verifyProposalLeftovers(run3.proposal, observeDeps(w3, new Date(NOW.getTime() + 600_000)));
  assert.ok(pending.ok);
  assert.equal(pending.cleanupRan, false);
  assert.ok(pending.record.resources.filter((r) => r.disposition !== "INTENTIONALLY_RETAINED").every((r) => r.disposition === "DELETION_PENDING" || r.disposition === "UNKNOWN"));
  assert.match(pending.record.nextAction, /Run the approved cleanup/);
});

test("a kill switch during the cleanup stops the engine, records KILLED, and the proposal is spent; one appearing before the engine starts spends the approvals and destroys nothing", async () => {
  const w = world();
  const run = await proposed(w);
  behave({ touchKillOn: "apply", applyWaitFor: join(root, "never-" + counter) });
  const killed = await cleanup(w, run);
  refused(killed, "APPLY_FAILED");
  assert.equal((killed as { outcome?: string }).outcome, "KILLED");
  assert.equal((await readCleanupEvidence(run.proposal.proposalSha256, w.dirs.evidence))?.outcome, "KILLED");
  // The kill switch appearing while the destroy is planned: read again before the approvals are consumed, so nothing is spent.
  const w2 = world();
  const run2 = await proposed(w2);
  behave({ touchKillOn: "show" });
  const approval = cleanupApproval(run2.proposal, "alice");
  refused(await cleanup(w2, run2, [approval]), "KILL_SWITCH_ACTIVE");
  assert.equal(applyCalls().length, 0, "the destroy never ran");
  assert.deepEqual(readdirSync(w2.dirs.evidence).filter((n) => n.endsWith(CLEANUP_SUFFIX)), [], "the reservation was given back");
  refused(await cleanup(w2, run2, [approval]), "KILL_SWITCH_ACTIVE");
  rmSync(KILL, { force: true });
  behave();
  assert.ok((await cleanup(w2, run2, [approval])).ok, "the same approval works once the owner removes the switch");
});

test("a restart or reconnect never executes a proposal twice: a held reservation refuses, verification is repeatable, and a lost response is reconciled from the ledger", async () => {
  const w = world();
  const run = await proposed(w);
  // A process that died holding the reservation: the proposal is never executed again from here.
  assert.ok((await reserveArtifact(run.proposal.proposalSha256, w.dirs.evidence, NOW, "cleanup")).ok);
  refused(await cleanup(w, run), "PROPOSAL_ALREADY_EXECUTED");
  assert.equal(destroyPlans().length, 0);
  // Leftover verification tells the person the cleanup did not finish, and says so again on every reconnect.
  for (const minute of [10, 20]) {
    const leftovers = await verifyProposalLeftovers(run.proposal, observeDeps(w, new Date(NOW.getTime() + minute * 60_000)));
    assert.ok(leftovers.ok);
    assert.equal(leftovers.cleanupRan, false, "a reservation is not finished evidence");
    assert.equal(leftovers.record.disposition, "INCOMPLETE");
  }
  // A real run whose response was lost: the ledger holds the evidence, and a second attempt is refused, not repeated.
  const w2 = world();
  const run2 = await proposed(w2);
  assert.ok((await cleanup(w2, run2)).ok);
  const evidence = await readCleanupEvidence(run2.proposal.proposalSha256, w2.dirs.evidence);
  assert.equal(evidence?.outcome, "SUCCEEDED");
  refused(await cleanup(w2, run2, [cleanupApproval(run2.proposal, "bob")]), "PROPOSAL_ALREADY_EXECUTED");
  assert.equal(destroyPlans().length, 1);
});

test("forged inventory and evidence are rejected: a blueprint, observation or leftovers record with a wrong shape, a raw field or a claimed completion, and a proposal that was edited", async () => {
  const w = world();
  const run = await proposed(w);
  const observation = run.records.observation;
  assert.deepEqual(observationRecordProblems(observation), []);
  assert.match(observationRecordProblems({ ...observation, stdout: "x" }).join(), /raw state or output field/);
  assert.match(observationRecordProblems({ ...observation, verdict: "VERIFIED_BY_APPLY" }).join(), /verdict is unknown/);
  assert.match(observationRecordProblems({ ...observation, resources: [{ ...observation.resources[0], result: "PRESENT_PROBABLY" }] }).join(), /each needs/);
  assert.match(blueprintRecordProblems({ ...run.records.blueprint, outcome: "SUCCEEDED_SURELY" }).join(), /outcome is unknown/);
  // An observation written for another blueprint is not this run's.
  const sibling = { ...observation, blueprintSha256: "e".repeat(64) };
  assert.deepEqual(observationRecordProblems(sibling), []);
  const forged: BlueprintRecord = { ...run.records.blueprint, blueprint: { entries: [], missing: [] } };
  assert.notEqual(recordSha256(forged), run.records.blueprintSha256);
  // A leftovers record that claims COMPLETE over an UNKNOWN resource is refused by the validator the reader uses.
  const leftovers = await verifyProposalLeftovers(run.proposal, observeDeps(w, new Date(NOW.getTime() + 600_000)));
  assert.ok(leftovers.ok);
  assert.equal(leftovers.record.disposition, "INCOMPLETE");
  assert.match(leftoversRecordProblems({ ...leftovers.record, disposition: "COMPLETE" }).join(), /COMPLETE needs every resource/);
  assert.match(leftoversRecordProblems({ ...leftovers.record, resources: [] , disposition: "COMPLETE" }).join(), /COMPLETE needs every resource/);
  // The proposal is bound to its hash: a changed field is refused before anything is asked.
  const edited = { ...run.proposal, risks: [] };
  refused(verifyCleanupProposal(edited), "PROPOSAL_INVALID");
  refused(await cleanup(w, run, undefined, { proposal: edited }), "PROPOSAL_INVALID");
  assert.equal(destroyPlans().length, 0);
});

test("a KMS key scheduled for deletion is DELETION_PENDING: not complete, not a leftover", async () => {
  const w = world();
  const key = [stateResource("aws_kms_key", "logs", KMS, "arn:aws:kms:us-east-1:111111111111:key/" + KMS)];
  behave({ stateResources: [...STATE, ...key], showResources: [...CREATES, { address: "aws_kms_key.logs", type: "aws_kms_key", change: { actions: ["create"], before: null, after: {} } }] });
  cloud({ existing: [...EXISTING, KMS] });
  const run = await proposed(w);
  assert.ok(run.proposal.deletes.some((d) => d.address === "aws_kms_key.logs" && d.risk?.includes("waiting period")));
  assert.ok((await cleanup(w, run)).ok);
  cloud({ existing: [...EXISTING.filter((x) => x !== BUCKET && x !== LOG), KMS], pendingDeletion: [KMS] });
  const leftovers = await verifyProposalLeftovers(run.proposal, observeDeps(w, new Date(NOW.getTime() + 600_000)));
  assert.ok(leftovers.ok);
  assert.equal(leftovers.record.disposition, "INCOMPLETE");
  assert.deepEqual(leftovers.record.resources.find((r) => r.address === "aws_kms_key.logs")?.disposition, "DELETION_PENDING");
  assert.match(leftovers.record.nextAction, /deletion window/);
  cloud({ existing: EXISTING.filter((x) => x !== BUCKET && x !== LOG) });
  const later = await verifyProposalLeftovers(run.proposal, observeDeps(w, new Date(NOW.getTime() + 8 * 86_400_000)));
  assert.ok(later.ok);
  assert.equal(later.record.disposition, "COMPLETE", "settled, and the sweep by the unit tag found nothing else");
});

test("a run sealed without a unit (an engine with no tag reader) stays KNOWN_ADDRESSES_CONFIRMED at best, and a tagged resource outside the state fails the observation", async () => {
  const w = world();
  cloud();
  // The observation of a tagged run finds a resource of this unit the state does not name: FAILED, and no proposal is made from it.
  cloud({ tagged: [...TAGGED, "arn:aws:sqs:us-east-1:111111111111:orphan-of-this-unit"] });
  const { s } = await applied(w);
  const failed = await observeRun(s.sealed.artifactSha256, observeDeps(w));
  assert.ok(failed.ok);
  assert.equal(failed.record.verdict, "FAILED");
  assert.deepEqual(failed.record.unexpected, ["arn:aws:sqs:us-east-1:111111111111:orphan-of-this-unit"]);
  const records = await loadRunRecords(s.sealed.artifactSha256, w.dirs.evidence);
  assert.ok(records.ok);
  refused(buildCleanupProposal({ ...records, changes: s.sealed.changes, channel: "CLI", contract: { ...(awsContractJson(KILL) as object), enabled: true } as never, engineVersion: s.sealed.engineVersion, env: w.deps.env!, now: new Date(NOW.getTime() + 120_000) }), "OBSERVATION_INCONCLUSIVE");
});

test("leftovers are COMPLETE only with a complete deletion-unit sweep, and a check that never ran proves nothing: an already-absent setting is UNKNOWN unless its parent is confirmed gone", async () => {
  // A pure check of verifyLeftovers against a scripted read-only cloud: no engine, no ledger.
  const run = await proposed(world());
  const bucket = run.proposal.deletes.find((d) => d.address === "aws_s3_bucket.logs")!;
  const setting = { address: "aws_s3_bucket_versioning.logs", type: "aws_s3_bucket_versioning", identifier: BUCKET };
  const proposal: CleanupProposal = { ...run.proposal, deletes: [bucket], alreadyAbsent: [setting], excluded: [] };
  const notFound = { code: 254, stdout: "", stderr: "An error occurred (ResourceNotFoundException) when calling the GetResource operation: not found" };
  const found = (identifier: string) => ({ code: 0, stdout: JSON.stringify({ ResourceDescription: { Identifier: identifier, Properties: "{}" } }), stderr: "" });
  const tagged = (arns: string[]) => ({ code: 0, stdout: JSON.stringify({ ResourceTagMappingList: arns.map((arn) => ({ ResourceARN: arn, Tags: [] })) }), stderr: "" });
  const cloud = (bucketExists: boolean, listing?: string[] | "paginated") => async (argv: readonly string[]) => {
    if (argv[0] === "resourcegroupstaggingapi") return listing === "paginated" ? { code: 0, stdout: JSON.stringify({ ResourceTagMappingList: [], PaginationToken: "more" }), stderr: "" } : tagged(listing ?? []);
    return bucketExists ? found(BUCKET) : notFound;
  };
  const check = (bucketExists: boolean, unitId: string | null, listing?: string[] | "paginated") => verifyLeftovers({
    proposal, cleanup: undefined, cleanupEvidenceSha256: null, unitId, knownIdentifiers: [BUCKET, BUCKET_ARN], region: "us-east-1", aws: cloud(bucketExists, listing), verifierBinarySha256: null, now: NOW,
  });
  // The parent is gone: the setting is confirmed through it, and with no unit tag the record is KNOWN_ADDRESSES_CONFIRMED.
  const known = await check(false, null);
  assert.deepEqual(known.resources.map((r) => [r.address, r.disposition, r.basis]), [["aws_s3_bucket.logs", "CONFIRMED_DELETED", "CLOUD_CONTROL_ABSENT"], ["aws_s3_bucket_versioning.logs", "CONFIRMED_DELETED", "PARENT_ABSENT"]]);
  assert.equal(known.disposition, "KNOWN_ADDRESSES_CONFIRMED");
  assert.deepEqual(leftoversRecordProblems(known), []);
  assert.match(leftoversRecordProblems({ ...known, disposition: "COMPLETE" }).join(), /complete deletion-unit sweep/);
  // The parent still exists: the setting's own check never ran, so it is UNKNOWN, never CONFIRMED_DELETED.
  const present = await check(true, null);
  assert.deepEqual(present.resources.map((r) => [r.address, r.disposition, r.basis]), [["aws_s3_bucket.logs", "DELETION_PENDING", "CLEANUP_NOT_FINISHED"], ["aws_s3_bucket_versioning.logs", "UNKNOWN", "NOT_INDEPENDENTLY_CHECKABLE"]]);
  assert.equal(present.disposition, "INCOMPLETE");
  // With a unit tag: a complete, empty sweep makes it COMPLETE; a paginated sweep or a tagged resource outside the state does not.
  const complete = await check(false, "unit-1");
  assert.equal(complete.sweep, "COMPLETE");
  assert.equal(complete.disposition, "COMPLETE");
  assert.deepEqual(leftoversRecordProblems(complete), []);
  assert.match(leftoversRecordProblems({ ...complete, disposition: "KNOWN_ADDRESSES_CONFIRMED" }).join(), /with a sweep the record is COMPLETE or INCOMPLETE/);
  const paginated = await check(false, "unit-1", "paginated");
  assert.equal(paginated.sweep, "INCOMPLETE");
  assert.equal(paginated.disposition, "INCOMPLETE");
  const stray = await check(false, "unit-1", ["arn:aws:sqs:us-east-1:111111111111:stray"]);
  assert.equal(stray.disposition, "INCOMPLETE");
  assert.deepEqual(stray.resources.filter((r) => r.address === "(not in state)").map((r) => [r.identifier, r.disposition]), [["arn:aws:sqs:us-east-1:111111111111:stray", "STILL_PRESENT"]]);
});

test("the cleanup adapter's surface: targeted destroy plan, its show and its apply, and the shared pinned steps; nothing else, and no bare destroy", () => {
  assert.ok(isAllowedCleanupArgv("terraform", cleanupPlanArgv(["aws_s3_bucket.logs", "module.m.aws_sqs_queue.q[0]", 'aws_iam_role.r["key"]'])));
  assert.ok(isAllowedCleanupArgv("terraform", CLEANUP_SHOW_ARGV) && isAllowedCleanupArgv("terraform", CLEANUP_APPLY_ARGV));
  for (const bad of [["destroy", "-auto-approve"], ["destroy"], ["plan", "-destroy", "-input=false", "-no-color", "-out=../alz-cleanup.tfplan"], ["apply", "-input=false", "-no-color", "../alz-apply.tfplan"],
    ["plan", "-destroy", "-input=false", "-no-color", "-target=aws_s3_bucket.logs", "-lock=false", "-out=../alz-cleanup.tfplan"], ["plan", "-destroy", "-input=false", "-no-color", "-target=aws_s3_bucket.logs; rm -rf /", "-out=../alz-cleanup.tfplan"],
    ["plan", "-input=false", "-no-color", "-target=aws_s3_bucket.logs", "-out=../alz-cleanup.tfplan"], ["state", "rm", "aws_s3_bucket.logs"], ["import", "a.b", "c"]]) {
    assert.equal(isAllowedCleanupArgv("terraform", bad), false, bad.join(" "));
  }
  assert.throws(() => cleanupPlanArgv([]), /CLEANUP_ADDRESSES_INVALID/);
  assert.throws(() => cleanupPlanArgv(["not an address"]), /CLEANUP_ADDRESSES_INVALID/);
  assert.throws(() => cleanupPlanArgv(["aws_s3_bucket.logs‮"]), /CLEANUP_ADDRESSES_INVALID/);
  // The verifier's reads: two shapes, JSON, one region; nothing else reaches the aws program.
  assert.ok(isAllowedReadArgv(["cloudcontrol", "get-resource", "--type-name", "AWS::S3::Bucket", "--identifier", BUCKET, "--region", AWS_REGION, "--output", "json"]));
  assert.ok(isAllowedReadArgv(["resourcegroupstaggingapi", "get-resources", "--tag-filters", "Key=alz-unit,Values=alzu-1234", "--region", AWS_REGION, "--output", "json"]));
  for (const bad of [["cloudcontrol", "delete-resource", "--type-name", "AWS::S3::Bucket", "--identifier", BUCKET, "--region", AWS_REGION, "--output", "json"],
    ["cloudcontrol", "get-resource", "--type-name", "AWS::S3::Bucket", "--identifier", "--profile", "--region", AWS_REGION, "--output", "json"], ["s3", "rb", "s3://" + BUCKET], ["sts", "get-caller-identity"]]) {
    assert.equal(isAllowedReadArgv(bad), false, bad.join(" "));
  }
});

test("the raw state parser maps every managed instance, with module paths and index keys, to identifiers only", () => {
  const state = JSON.stringify({ version: 4, serial: 9, resources: [
    stateResource("aws_s3_bucket", "logs", BUCKET, BUCKET_ARN, "module.storage"),
    { mode: "managed", type: "aws_subnet", name: "private", instances: [{ index_key: 0, attributes: { id: "subnet-0a", cidr_block: "10.0.0.0/24" } }, { index_key: "b", attributes: { id: "subnet-0b" } }] },
    { mode: "data", type: "aws_caller_identity", name: "me", instances: [{ attributes: { id: "111111111111" } }] },
    { mode: "managed", type: "aws_iam_access_key", name: "k", instances: [{ attributes: { id: "AKIAFAKEKEYID0000000", secret: "shh" } }] },
  ] });
  const blueprint = blueprintFromTerraformStatePull(state, [{ address: "module.storage.aws_s3_bucket.logs", type: "aws_s3_bucket", action: "CREATE" }, { address: "aws_subnet.private[0]", type: "aws_subnet", action: "CREATE" }, { address: "aws_vpc.main", type: "aws_vpc", action: "CREATE" }]);
  assert.deepEqual(blueprint.entries.map((e) => [e.address, e.id, e.arn, e.origin]), [
    ["aws_iam_access_key.k", null, null, "NOT_IN_PLAN"], ['aws_subnet.private["b"]', "subnet-0b", null, "NOT_IN_PLAN"], ["aws_subnet.private[0]", "subnet-0a", null, "IN_PLAN"],
    ["module.storage.aws_s3_bucket.logs", BUCKET, BUCKET_ARN, "IN_PLAN"],
  ]);
  assert.deepEqual(blueprint.missing, ["aws_vpc.main"]);
  assert.ok(!JSON.stringify(blueprint).includes("10.0.0.0") && !JSON.stringify(blueprint).includes("shh") && !JSON.stringify(blueprint).includes(STATE_CANARY));
  assert.throws(() => blueprintFromTerraformStatePull('{"version":3,"resources":[]}', []), /STATE_JSON_INVALID/);
  assert.throws(() => blueprintFromTerraformStatePull("{" + STATE_CANARY, []), (error: Error) => /STATE_JSON_INVALID/.test(error.message) && !error.message.includes(STATE_CANARY));
});

const IDENTITY_FIXTURE_CONTRACT = loadPilotContract(fixtureContractPath, pinPathOf(fixtureContractPath)) as PilotContract;
/** Every type the reviewer named (6412182848), and the account-wide settings: all in the identity service, all kept. */
const AWS_IAM_TYPES = ["aws_iam_role", "aws_iam_policy", "aws_iam_policy_attachment", "aws_iam_role_policy", "aws_iam_role_policy_attachment", "aws_iam_role_policies_exclusive", "aws_iam_role_policy_attachments_exclusive",
  "aws_iam_user", "aws_iam_user_policy", "aws_iam_user_policy_attachment", "aws_iam_user_login_profile", "aws_iam_user_ssh_key", "aws_iam_user_group_membership", "aws_iam_group", "aws_iam_group_policy", "aws_iam_group_policy_attachment",
  "aws_iam_group_membership", "aws_iam_instance_profile", "aws_iam_openid_connect_provider", "aws_iam_saml_provider", "aws_iam_service_linked_role", "aws_iam_access_key", "aws_iam_signing_certificate", "aws_iam_service_specific_credential",
  "aws_iam_virtual_mfa_device", "aws_iam_account_password_policy", "aws_iam_account_alias", "aws_iam_security_token_service_preferences", "aws_iam_organizations_features", "aws_iam_server_certificate",
  "awscc_iam_role", "awscc_iam_user", "aws_ssoadmin_account_assignment", "aws_ssoadmin_permission_set", "aws_ssoadmin_managed_policy_attachment",
  "AWS::IAM::Role", "AWS::IAM::Policy", "AWS::IAM::ManagedPolicy", "AWS::IAM::User", "AWS::IAM::Group", "AWS::IAM::AccessKey", "AWS::IAM::InstanceProfile", "AWS::IAM::OIDCProvider", "AWS::IAM::SAMLProvider", "AWS::IAM::ServiceLinkedRole",
  "AWS::IAM::UserToGroupAddition", "AWS::IAM::VirtualMFADevice", "AWS::SSO::Assignment", "AWS::SSO::PermissionSet"];

test("anything in the IAM or identity service is PROTECTED_IDENTITY by an anchored prefix (owner policy #39; review 6412182848): every aws_iam_, awscc_iam_, aws_ssoadmin_, AWS::IAM:: and AWS::SSO:: type, and nothing that merely resembles one; an identity's ARN under another type is unclassifiable and refused", () => {
  const entry = (address: string, type: string, id: string | null = "x", arn: string | null = null) => ({ address, type, id, arn });
  const change = (address: string, type: string) => [{ address, type, action: "DELETE" }];
  for (const type of AWS_IAM_TYPES) {
    assert.ok(isAwsIdentityType(type), type);
    const refusal = protectedDeletionIn(change("x.y", type), [entry("x.y", type)], IDENTITY_FIXTURE_CONTRACT, awsIdentityEnv("DEV"));
    assert.ok(refusal !== undefined && refusal.includes("(PROTECTED_IDENTITY)"), type + ": " + refusal);
    // By type alone, for a dependent the state does not hold.
    assert.ok(protectedDeletionIn(change("x.y", type), [], IDENTITY_FIXTURE_CONTRACT, awsIdentityEnv("DEV"))?.includes("(PROTECTED_IDENTITY)"), type + " by type alone");
  }
  for (const type of ["aws_iamx", "aws_iam", "aws_s3_bucket", "aws_cloudwatch_log_group", "AWS::IAMX::Foo", "AWS::Iam::Role", "aws::iam::role", "AWS::IAM:Role", "aws_sso_admin", "awscc_s3_bucket", "aws_ssoadminx"]) {
    assert.ok(!isAwsIdentityType(type), type + " is not an identity type");
    assert.equal(protectedDeletionIn(change("x.y", type), [entry("x.y", type, "x", "arn:aws:s3:::x")], IDENTITY_FIXTURE_CONTRACT, awsIdentityEnv("DEV")), undefined, type);
  }
  // A pilot role's ARN recorded under a type outside the identity service: fail closed, never ordinary.
  const pilot = awsRoleArn("APPLY", "DEV");
  for (const [type, id, arn] of [["terraform_data", pilot, null], ["aws_cloudformation_stack", "stack", pilot], ["AWS::CloudFormation::CustomResource", pilot, null], ["Custom::PilotRole", "x", pilot], ["aws_lambda_function", "fn", "arn:aws-us-gov:iam::111111111111:role/x"]] as const) {
    const refusal = protectedDeletionIn(change("x.y", type), [entry("x.y", type, id, arn)], IDENTITY_FIXTURE_CONTRACT, awsIdentityEnv("DEV"));
    assert.ok(refusal !== undefined && refusal.includes("(OWNERSHIP_AMBIGUOUS)") && refusal.includes("an identity's ARN under another type"), type + ": " + refusal);
  }
  assert.equal(protectedDeletionIn(change("x.y", "terraform_data"), [entry("x.y", "terraform_data", "not-an-arn", null)], IDENTITY_FIXTURE_CONTRACT, awsIdentityEnv("DEV")), undefined, "terraform_data without an IAM ARN stays ordinary");
});

test("AWS identities the run created are never deleted (owner policy #39): an application role, its inline policy, a policy attachment and an access key are kept as PROTECTED_IDENTITY by the pilot owner, a destroy plan that would take any of them along stops before any approval is consumed, a pilot role's ARN under terraform_data refuses the proposal, the run's other resources are cleaned up, and the leftover check is COMPLETE with the identities intentionally retained", async () => {
  const APP_ROLE = "alz-app-role";
  const APP_ROLE_ARN = "arn:aws:iam::111111111111:role/" + APP_ROLE;
  const creates = [...CREATES,
    { address: "aws_iam_role.app", type: "aws_iam_role", change: { actions: ["create"], before: null, after: {} } },
    { address: "aws_iam_role_policy.app_inline", type: "aws_iam_role_policy", change: { actions: ["create"], before: null, after: {} } },
    { address: "aws_iam_policy_attachment.shared", type: "aws_iam_policy_attachment", change: { actions: ["create"], before: null, after: {} } },
    { address: "aws_iam_access_key.app", type: "aws_iam_access_key", change: { actions: ["create"], before: null, after: {} } },
  ];
  const state = [...STATE, stateResource("aws_iam_role", "app", APP_ROLE, APP_ROLE_ARN), stateResource("aws_iam_role_policy", "app_inline", APP_ROLE + ":inline"),
    stateResource("aws_iam_policy_attachment", "shared", "shared-attachment"), stateResource("aws_iam_access_key", "app", "AKIAFAKEAPPKEY000000")];
  const w = world();
  behave({ showResources: creates, stateResources: state });
  cloud({ existing: [...EXISTING, APP_ROLE], tagged: [...TAGGED, APP_ROLE_ARN] });
  const run = await proposed(w);
  assert.deepEqual(run.proposal.deletes.map((d) => d.address), ["aws_cloudwatch_log_group.canary", "aws_s3_bucket.logs", "aws_s3_bucket_versioning.logs"], "only the run's non-identity resources are proposed");
  const kept = new Map(run.proposal.excluded.map((x) => [x.address, x]));
  for (const address of ["aws_iam_role.app", "aws_iam_role_policy.app_inline", "aws_iam_policy_attachment.shared", "aws_iam_access_key.app", "aws_iam_role.apply"]) {
    assert.equal(kept.get(address)?.ownership, "PROTECTED_IDENTITY", address);
    assert.equal(kept.get(address)?.retainedBy, "PILOT_OWNER", address);
    assert.match(kept.get(address)!.reason, /anything in the IAM or identity service.*access keys and credentials of those identities.*never deleted by a cleanup, directly or as a dependent/, address);
  }
  assert.equal(kept.get("aws_iam_access_key.app")?.identifier, null, "the access key id is never recorded");
  assert.ok(!JSON.stringify([run.proposal, run.records.blueprint, run.records.observation]).includes("AKIAFAKEAPPKEY000000"), "no access key id reaches a record");
  // A destroy plan that would take the role, the attachment or the key along stops before any approval is consumed, naming the policy.
  const approval = cleanupApproval(run.proposal, "alice");
  for (const [address, type] of [["aws_iam_role.app", "aws_iam_role"], ["aws_iam_policy_attachment.shared", "aws_iam_policy_attachment"], ["aws_iam_access_key.app", "aws_iam_access_key"]] as const) {
    behave({ showResources: creates, stateResources: state, destroyExtra: [{ address, type, change: { actions: ["delete"], before: {}, after: null } }] });
    const taken = await cleanup(w, run, [approval]);
    refused(taken, "PROPOSAL_SCOPE_MISMATCH");
    assert.match((taken as { message: string }).message, new RegExp("would delete " + address.replace(".", "\\.") + ", an identity or authorization object, which a pilot cleanup never deletes, directly or as a dependent \\(PROTECTED_IDENTITY\\)"), address);
    assert.equal(applyCalls().length, 0, address);
  }
  // A pilot role's ARN recorded under terraform_data: the whole proposal is refused for a person to review.
  const disguised = world();
  behave({ showResources: [...creates, { address: "terraform_data.pilot_role", type: "terraform_data", change: { actions: ["create"], before: null, after: {} } }], stateResources: [...state, stateResource("terraform_data", "pilot_role", "pilot-role", awsRoleArn("APPLY", "DEV"))] });
  cloud({ existing: [...EXISTING, APP_ROLE], tagged: [...TAGGED, APP_ROLE_ARN] });
  const applied2 = await observed(disguised);
  const records2 = await loadRunRecords(applied2.s.sealed.artifactSha256, disguised.dirs.evidence);
  assert.ok(records2.ok);
  const built2 = buildCleanupProposal({ ...records2, changes: applied2.s.sealed.changes, channel: "CLI", contract: { ...(JSON.parse(JSON.stringify(awsContractJson(KILL))) as object), enabled: true } as never, engineVersion: applied2.s.sealed.engineVersion, env: disguised.deps.env!, now: new Date(NOW.getTime() + 120_000) });
  refused(built2, "OWNERSHIP_AMBIGUOUS");
  assert.match((built2 as { message: string }).message, /terraform_data\.pilot_role that is not a resource id the cleanup can classify exactly/);
  behave({ showResources: creates, stateResources: state });
  // A forged proposal that lists the role never executes.
  const fields = { ...run.proposal, deletes: [...run.proposal.deletes, { address: "aws_iam_role.app", type: "aws_iam_role", identifier: APP_ROLE, ownership: "RUN_CREATED" as const, observed: "VERIFIED" as const }].sort((a, b) => (a.address < b.address ? -1 : 1)), excluded: run.proposal.excluded.filter((x) => x.address !== "aws_iam_role.app") };
  const forged = { ...fields, proposalSha256: computeProposalSha256(fields) };
  assert.ok(verifyCleanupProposal(forged).ok);
  behave({ showResources: creates, stateResources: state });
  refused(await cleanup(w, { ...run, proposal: forged }, [cleanupApproval(forged, "alice")]), "PROPOSAL_INVALID");
  assert.equal(applyCalls().length, 0);
  // The honest cleanup runs once with the same approval; the identities stay, tagged, and the check is COMPLETE.
  behave({ showResources: creates, stateResources: state });
  const done = await cleanup(w, run, [approval]);
  assert.ok(done.ok, JSON.stringify(done));
  assert.deepEqual(destroyPlans()[0]!.args.filter((a) => a.startsWith("-target=")).sort(), run.proposal.deletes.map((d) => "-target=" + d.address).sort());
  cloud({ existing: [STATE_BUCKET, OLD_QUEUE, "alz-apply-dev", APP_ROLE], tagged: [APP_ROLE_ARN] });
  const leftovers = await verifyProposalLeftovers(run.proposal, observeDeps(w, new Date(NOW.getTime() + 600_000)));
  assert.ok(leftovers.ok);
  assert.equal(leftovers.record.disposition, "COMPLETE");
  const dispositions = new Map(leftovers.record.resources.map((r) => [r.address, [r.disposition, r.owner]]));
  for (const address of ["aws_iam_role.app", "aws_iam_role_policy.app_inline", "aws_iam_policy_attachment.shared", "aws_iam_access_key.app", "aws_iam_role.apply"]) assert.deepEqual(dispositions.get(address), ["INTENTIONALLY_RETAINED", "PILOT_OWNER"], address);
  assert.deepEqual(dispositions.get("aws_s3_bucket.logs"), ["CONFIRMED_DELETED", undefined]);
  assert.ok(!JSON.stringify(leftovers.record).includes("AKIAFAKEAPPKEY000000"));
});
