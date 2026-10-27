import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { signApproval } from "../src/apply/approval.js";
import { MATERIAL_RISKS, PROTECTION_REASONS, buildCleanupProposal, computeProposalSha256, isAwsIdentityType, signCleanupProposal, proposalProblems, protectedDeletionIn, verifyCleanupProposal, type CleanupProposal } from "../src/apply/cleanup-proposal.js";
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
import { AWS_CONTAINER_FAMILIES, AWS_CONTAINER_PREFIXES, awsContainerFamilyOf, isAwsContainerType } from "../src/observe/aws-containers.js";
import { AWS_LEAF_TYPES, AWS_LEAF_TYPE_NAMES, awsLeafConditionProblem, awsLeafEntryOf, awsParentIdOf, isAwsLeafType, isWellFormedResourceType, serviceControlPolicyProblem } from "../src/observe/aws-leaf-types.js";
import { acceptanceOf, acceptanceStatement } from "../src/apply/lifecycle-report.js";
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
  approvalFor, behave as behaveIn, behaveAwsReads, callsOf, human, installFakeAwsReads, installFakeTerraform, keys, stateResource, testFixtureForgeQualificationEvidence,
  writeReviewedContract, writeProject, type AwsReadBehavior, type Behavior,
  REQUESTER, reHashedProposal,
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
const fixtureContractPath = (() => { const path = join(fresh("contract"), "act-pilot-contract.json"); writeReviewedContract(path, awsContractJson(KILL)); return path; })();
const UNIT = pilotUnitOf({ provider: "AWS", contractSha256: pilotContractSha256(loadPilotContract(fixtureContractPath) as PilotContract), environment: "DEV", target: awsTargetOf("DEV") });
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
  writeReviewedContract(contractPath, contract);
  return {
    dirs, contractPath,
    deps: {
      sourceCommit: SOURCE_COMMIT, contractPath, qualificationDir: vaultDir, evidenceDir: dirs.evidence, nonces: openNonceStore(dirs.nonces),
      env: awsIdentityEnv("DEV"), now: () => NOW, scratchParent: dirs.scratch, toolDirs: [toolDir, awsToolDir], killPollMs: 40, killGraceMs: 400,
    },
  };
}
const observeDeps = (w: World, now: Date = new Date(NOW.getTime() + 60_000)) => ({
  contractPath: w.contractPath, evidenceDir: w.dirs.evidence, env: w.deps.env, toolDirs: w.deps.toolDirs, scratchParent: w.dirs.scratch, now: () => now,
});

async function seal(w: World, environment: ApplyEnvironment = "DEV", mainTf = 'resource "aws_s3_bucket" "logs" {}\n') {
  const target = awsTargetOf(environment);
  const p = writeProject(fresh("project"), target, mainTf);
  const result = await sealPreview({ invocation: human(target), environment, target, manifest: p.manifest, projectRoot: p.projectRoot, policyVersion: POLICY, resolved: p.resolved, requester: REQUESTER }, w.deps);
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
  const built = buildCleanupProposal({ requesterId: REQUESTER.requesterId,
    ...records, changes: run.s.sealed.changes, channel: "CLI", contract: { ...(contract as object), enabled: true } as never, engineVersion: run.s.sealed.engineVersion, env: w.deps.env!, now: new Date(NOW.getTime() + 120_000),
  });
  assert.ok(built.ok, JSON.stringify(built));
  return { ...run, records, proposal: signCleanupProposal(built.proposal, REQUESTER.privateKeyPem) };
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
  // The container (a CloudFormation stack) is accepted only from a CloudFormation read, for the stack type, with the pinned stack's own id (review of #265, N1).
  const stacked = { ...genuine, target: { ...genuine.target, backend: "PilotStack" } };
  const stackId = "arn:aws:cloudformation:us-east-1:" + stacked.target.account + ":stack/PilotStack/11111111-2222-3333-4444-555555555555";
  const withContainer = (container: unknown, source = "CLOUDFORMATION_STACK_RESOURCES", record = stacked) => blueprintRecordProblems({ ...record, source, blueprint: { ...record.blueprint, container } }).join();
  assert.equal(withContainer({ type: "AWS::CloudFormation::Stack", identifier: stackId }), "");
  assert.match(withContainer({ type: "AWS::CloudFormation::Stack", identifier: stackId }, "TERRAFORM_STATE_PULL"), /a container only from a CloudFormation read/, "a Terraform read has no container");
  assert.match(withContainer({ type: "AWS::CloudFormation::StackSet", identifier: stackId }), /a container only from a CloudFormation read/, "the stack type only");
  assert.match(withContainer({ type: "AWS::CloudFormation::Stack", identifier: stackId.replace(genuine.target.account, "222222222222") }), /a container only from a CloudFormation read/, "another account");
  assert.match(withContainer({ type: "AWS::CloudFormation::Stack", identifier: stackId.replace("stack/PilotStack/", "stack/OtherStack/") }), /a container only from a CloudFormation read/, "another stack");
  assert.match(withContainer({ type: "AWS::CloudFormation::Stack", identifier: stackId }, "CLOUDFORMATION_STACK_RESOURCES", genuine), /a container only from a CloudFormation read/, "a backend that is not a stack name has no container");
  assert.match(withContainer({ type: "AWS::CloudFormation::Stack", identifier: "arn:aws:cloudformation:us-east-1:" + stacked.target.account + ":stack/PilotStack" }), /a container only from a CloudFormation read/, "no stack guid");
  assert.match(withContainer({ type: "AWS::CloudFormation::Stack", identifier: stackId, extra: 1 }), /a container only from a CloudFormation read/, "closed shape");
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
  refused(await (async () => { const records = await loadRunRecords(s2.sealed.artifactSha256, other.dirs.evidence); assert.ok(records.ok); return buildCleanupProposal({ requesterId: REQUESTER.requesterId, ...records, changes: s2.sealed.changes, channel: "CLI",
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
  const build = (over: Partial<Parameters<typeof buildCleanupProposal>[0]>) => buildCleanupProposal({ requesterId: REQUESTER.requesterId,
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
  refused(await cleanup(w, run, undefined, { proposal: reHashedProposal({ ...run.proposal, channel: "UI" }) }), "CHANNEL_MISMATCH");
  refused(await cleanup(w, run, undefined, { proposal: reHashedProposal({ ...run.proposal, applyEvidenceSha256: "d".repeat(64) }) }), "RUN_RECORD_MISSING");
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
    return reHashedProposal(fields);
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
  refused(buildCleanupProposal({ requesterId: REQUESTER.requesterId, ...records, changes: s.sealed.changes, channel: "CLI", contract: { ...(awsContractJson(KILL) as object), enabled: true } as never, engineVersion: s.sealed.engineVersion, env: w.deps.env!, now: new Date(NOW.getTime() + 120_000) }), "OBSERVATION_INCONCLUSIVE");
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

const IDENTITY_FIXTURE_CONTRACT = loadPilotContract(fixtureContractPath) as PilotContract;
/** Every type the reviewer named (6412182848), and the account-wide settings: all in the identity service, all kept. */
const AWS_IAM_TYPES = ["aws_iam_role", "aws_iam_policy", "aws_iam_policy_attachment", "aws_iam_role_policy", "aws_iam_role_policy_attachment", "aws_iam_role_policies_exclusive", "aws_iam_role_policy_attachments_exclusive",
  "aws_iam_user", "aws_iam_user_policy", "aws_iam_user_policy_attachment", "aws_iam_user_login_profile", "aws_iam_user_ssh_key", "aws_iam_user_group_membership", "aws_iam_group", "aws_iam_group_policy", "aws_iam_group_policy_attachment",
  "aws_iam_group_membership", "aws_iam_instance_profile", "aws_iam_openid_connect_provider", "aws_iam_saml_provider", "aws_iam_service_linked_role", "aws_iam_access_key", "aws_iam_signing_certificate", "aws_iam_service_specific_credential",
  "aws_iam_virtual_mfa_device", "aws_iam_account_password_policy", "aws_iam_account_alias", "aws_iam_security_token_service_preferences", "aws_iam_organizations_features", "aws_iam_server_certificate",
  "awscc_iam_role", "awscc_iam_user", "aws_ssoadmin_account_assignment", "aws_ssoadmin_permission_set", "aws_ssoadmin_managed_policy_attachment",
  "aws_identitystore_user", "aws_identitystore_group", "aws_identitystore_group_membership", "awscc_sso_assignment", "awscc_sso_permission_set", "awscc_identitystore_group", "awscc_identitystore_group_membership",
  "AWS::IdentityStore::Group", "AWS::IdentityStore::GroupMembership",
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
  // Not identity types. Since the leaf allowlist (delegated owner decision 6433391052), only an allowlisted one is ordinary; any other well-formed
  // type is held as TYPE_UNREVIEWED and a malformed type field is unclassifiable, so none of them is ever deletable by resemblance either.
  for (const [type, expected] of [["aws_iamx", "TYPE_UNREVIEWED"], ["aws_iam", "TYPE_UNREVIEWED"], ["aws_s3_bucket", undefined], ["aws_cloudwatch_log_group", undefined], ["AWS::IAMX::Foo", "TYPE_UNREVIEWED"], ["AWS::Iam::Role", "TYPE_UNREVIEWED"],
    ["aws::iam::role", "TYPE_UNREVIEWED"], ["AWS::IAM:Role", "OWNERSHIP_AMBIGUOUS"], ["aws_sso_admin", "TYPE_UNREVIEWED"], ["awscc_s3_bucket", undefined], ["aws_ssoadminx", "TYPE_UNREVIEWED"]] as const) {
    assert.ok(!isAwsIdentityType(type), type + " is not an identity type");
    const refusal = protectedDeletionIn(change("x.y", type), [entry("x.y", type, "x", "arn:aws:s3:::x")], IDENTITY_FIXTURE_CONTRACT, awsIdentityEnv("DEV"));
    if (expected === undefined) assert.equal(refusal, undefined, type + " is an allowlisted leaf");
    else assert.ok(refusal !== undefined && refusal.includes("(" + expected + ")") && !refusal.includes("(PROTECTED_IDENTITY)"), type + ": " + refusal);
  }
  // A pilot role's ARN recorded under a type outside the identity service: fail closed, never ordinary.
  const pilot = awsRoleArn("APPLY", "DEV");
  for (const [type, id, arn] of [["terraform_data", pilot, null], ["AWS::CloudFormation::CustomResource", pilot, null], ["Custom::PilotRole", "x", pilot], ["aws_lambda_function", "fn", "arn:aws-us-gov:iam::111111111111:role/x"]] as const) {
    const refusal = protectedDeletionIn(change("x.y", type), [entry("x.y", type, id, arn)], IDENTITY_FIXTURE_CONTRACT, awsIdentityEnv("DEV"));
    assert.ok(refusal !== undefined && refusal.includes("(OWNERSHIP_AMBIGUOUS)") && refusal.includes("an identity's ARN under another type"), type + ": " + refusal);
  }
  // terraform_data without an IAM ARN is not an identity question, and it is not on the leaf allowlist (a destroy-time provisioner is still the owner's question): held, never deleted.
  assert.ok(protectedDeletionIn(change("x.y", "terraform_data"), [entry("x.y", "terraform_data", "not-an-arn", null)], IDENTITY_FIXTURE_CONTRACT, awsIdentityEnv("DEV"))?.includes("(TYPE_UNREVIEWED)"), "terraform_data without an IAM ARN is held as unreviewed");
  // A wrapper whose attributes held an identity's ARN, or nested past what the blueprint could scan (judged by the blueprint, N2 of 6412488764, B2 of 6412896598), is refused the same way.
  const flagged = protectedDeletionIn(change("x.y", "terraform_data"), [{ ...entry("x.y", "terraform_data", "plain", null), holdsIdentityArn: true }], IDENTITY_FIXTURE_CONTRACT, awsIdentityEnv("DEV"));
  assert.ok(flagged !== undefined && flagged.includes("(OWNERSHIP_AMBIGUOUS)") && flagged.includes("could not scan in full"), flagged);
});

/**
 * Every stack container type by name, each of which must fall in a family of the one table (reviews 6412896598 B1 and 6432262110 B1; owner
 * decision 6431744115): CONTAINS_OTHERS, never deleted, whatever its identifier says. The table itself is iterated too, so a family added to it is tested.
 */
const AWS_CONTAINER_TYPES = ["aws_cloudformation_stack", "aws_cloudformation_stack_set", "aws_cloudformation_stack_set_instance", "aws_cloudformation_stack_instances", "awscc_cloudformation_stack", "awscc_cloudformation_stack_set",
  "aws_servicecatalog_provisioned_product", "awscc_servicecatalog_cloud_formation_provisioned_product", "AWS::CloudFormation::Stack", "AWS::CloudFormation::StackSet", "AWS::ServiceCatalog::CloudFormationProvisionedProduct",
  "aws_serverlessapplicationrepository_cloudformation_stack", "awscc_serverlessapplicationrepository_cloudformation_stack", "AWS::Serverless::Application", "AWS::ServerlessRepo::Application",
  "aws_sagemaker_project", "awscc_sagemaker_project", "AWS::SageMaker::Project",
  "aws_proton_environment", "aws_proton_service", "awscc_proton_environment", "awscc_proton_service", "AWS::Proton::Environment", "AWS::Proton::Service",
  "aws_elastic_beanstalk_environment", "awscc_elasticbeanstalk_environment", "AWS::ElasticBeanstalk::Environment",
  // Review 6433014148 B1, through the delegated owner decision 6433391052 item 4: SSM Quick Setup, DataZone environments and Control Tower.
  "aws_ssmquicksetup_configuration_manager", "awscc_ssmquicksetup_configuration_manager", "AWS::SSMQuickSetup::ConfigurationManager",
  "aws_datazone_environment", "awscc_datazone_environment", "AWS::DataZone::Environment",
  "aws_controltower_landing_zone", "aws_controltower_control", "aws_controltower_baseline", "awscc_controltower_landing_zone", "awscc_controltower_enabled_control", "AWS::ControlTower::LandingZone", "AWS::ControlTower::EnabledControl", "AWS::ControlTower::EnabledBaseline"];

test("anything that deploys a CloudFormation stack or a provisioned product (a stack, stack set or stack instance, a Service Catalog provisioned product, a Serverless Application Repository application, a SageMaker project, a Proton environment or service, an Elastic Beanstalk environment, an SSM Quick Setup configuration, a DataZone environment, Control Tower) is CONTAINS_OTHERS by the one family table: never deleted, directly or as a dependent, whatever it carries, because what the stack holds (IAM roles among it) is not in the state (reviews 6412896598 B1, 6432262110 B1)", () => {
  const entry = (address: string, type: string, id: string | null = "x", arn: string | null = null) => ({ address, type, id, arn });
  const change = (address: string, type: string, action = "DELETE") => [{ address, type, action }];
  const pilot = awsRoleArn("APPLY", "DEV");
  // Every named type belongs to a family, and every prefix of every family is a container; the two lists are checked against each other.
  for (const type of AWS_CONTAINER_TYPES) assert.ok(awsContainerFamilyOf(type) !== undefined, type + " is in no family of AWS_CONTAINER_FAMILIES");
  for (const family of AWS_CONTAINER_FAMILIES) {
    assert.ok(family.what.length > 0 && family.reason.length > 0 && family.prefixes.length > 0, "a family has a description, a reason and prefixes");
    for (const prefix of family.prefixes) assert.ok(AWS_CONTAINER_TYPES.some((type) => type.startsWith(prefix)), prefix + " of family '" + family.what + "' names no type in the test list: add one");
  }
  assert.equal(new Set(AWS_CONTAINER_PREFIXES).size, AWS_CONTAINER_PREFIXES.length, "no prefix is listed twice");
  for (const type of [...AWS_CONTAINER_TYPES, ...AWS_CONTAINER_PREFIXES]) {
    const family = awsContainerFamilyOf(type)!;
    assert.ok(isAwsContainerType(type), type);
    assert.ok(!isAwsIdentityType(type), type + " is a container, not an identity");
    for (const [id, arn] of [["stack-id", null], ["arn:aws:cloudformation:us-east-1:111111111111:stack/s/1", "arn:aws:cloudformation:us-east-1:111111111111:stack/s/1"], ["stack", pilot]] as const) {
      const refusal = protectedDeletionIn(change("x.y", type), [entry("x.y", type, id, arn)], IDENTITY_FIXTURE_CONTRACT, awsIdentityEnv("DEV"));
      assert.ok(refusal !== undefined && refusal.includes("a stack container (" + family.what + ")") && refusal.includes("never deletes, directly or as a dependent (CONTAINS_OTHERS)"), type + " " + id + ": " + refusal);
    }
    // By type alone, for a dependent the state does not hold, and for an update as much as a delete.
    assert.ok(protectedDeletionIn(change("x.y", type), [], IDENTITY_FIXTURE_CONTRACT, awsIdentityEnv("DEV"))?.includes("(CONTAINS_OTHERS)"), type + " by type alone");
    assert.ok(protectedDeletionIn(change("x.y", type, "UPDATE"), [], IDENTITY_FIXTURE_CONTRACT, awsIdentityEnv("DEV"))?.includes("would update x.y, a stack container"), type + " on update");
    // A container whose attributes hold an identity's ARN is still a container: kept with its reason, not a refusal of the whole proposal.
    assert.ok(protectedDeletionIn(change("x.y", type), [{ ...entry("x.y", type), holdsIdentityArn: true }], IDENTITY_FIXTURE_CONTRACT, awsIdentityEnv("DEV"))?.includes("(CONTAINS_OTHERS)"), type + " with a flagged attribute");
  }
  for (const type of ["aws_cloudformation_type", "aws_cloudformation_export", "aws_cloudformationx_stack", "AWS::CloudFormation::CustomResource", "AWS::CloudFormation::WaitCondition", "aws_servicecatalog_product", "aws_servicecatalog_portfolio", "AWS::ServiceCatalog::Portfolio",
    "aws_serverlessapplicationrepository_application", "aws_sagemaker_model", "aws_sagemaker_domain", "AWS::SageMaker::Model", "aws_elastic_beanstalk_application", "aws_elastic_beanstalk_application_version", "AWS::ElasticBeanstalk::Application", "aws_datazone_project", "aws_datazone_domain", "aws_ssm_parameter", "aws_s3_bucket", "AWS_CLOUDFORMATION_STACK", " aws_cloudformation_stack", "module.m.aws_cloudformation_stack"]) {
    assert.ok(!isAwsContainerType(type), type + " is not a container");
  }
  assert.ok(PROTECTION_REASONS.CONTAINS_OTHERS.length <= 512 && /anything that deploys a CloudFormation stack or a provisioned product/.test(PROTECTION_REASONS.CONTAINS_OTHERS), "the reason states the class within a proposal's limit");
});

/** One run per container family: the container holds an IAM role the state cannot show (a template names types; a repository application or a product has no template in the state at all). */
const CONTAINER_RUNS: readonly { type: string; name: string; attributes: Record<string, unknown> }[] = [
  { type: "aws_cloudformation_stack", name: "app_iam", attributes: { id: "arn:aws:cloudformation:us-east-1:111111111111:stack/app-iam/11111111-2222-4333-8444-555555555555", name: "app-iam",
    template_body: JSON.stringify({ Resources: { AppRole: { Type: "AWS::IAM::Role", Properties: { AssumeRolePolicyDocument: {} } } } }), template_url: null, capabilities: ["CAPABILITY_NAMED_IAM"], outputs: {}, iam_role_arn: null } },
  { type: "aws_serverlessapplicationrepository_cloudformation_stack", name: "app_iam", attributes: { id: "arn:aws:cloudformation:us-east-1:111111111111:stack/serverlessrepo-app-iam/22222222-2222-4333-8444-555555555555", name: "app-iam",
    application_id: "arn:aws:serverlessrepo:us-east-1:222222222222:applications/app-iam", semantic_version: "1.0.0", capabilities: ["CAPABILITY_IAM", "CAPABILITY_NAMED_IAM"], parameters: {}, outputs: {} } },
  { type: "aws_sagemaker_project", name: "app_iam", attributes: { id: "app-iam", project_name: "app-iam", project_id: "p-abcdefghijkl", arn: "arn:aws:sagemaker:us-east-1:111111111111:project/app-iam",
    service_catalog_provisioning_details: [{ product_id: "prod-abcdefghijklm", provisioning_artifact_id: "pa-abcdefghijklm" }] } },
];

for (const { type, name, attributes } of CONTAINER_RUNS) {
  test("a run that created " + type + " (" + awsContainerFamilyOf(type)!.what + ", holding an IAM role the state cannot show) keeps it as CONTAINS_OTHERS by the pilot owner, never targets it, refuses a destroy plan that would take it along before any approval is consumed, and cleans up the run's other resources (reviews 6412896598 B1, 6432262110 B1)", async () => {
    const address = type + "." + name;
    const family = awsContainerFamilyOf(type)!;
    const creates = [...CREATES, { address, type, change: { actions: ["create"], before: null, after: {} } }];
    const container = { mode: "managed", type, name, provider: 'provider["registry.terraform.io/hashicorp/aws"]', instances: [{ schema_version: 0, attributes: { ...attributes, secret_value: STATE_CANARY } }] };
    const state = [...STATE, container];
    const w = world();
    behave({ showResources: creates, stateResources: state });
    const run = await proposed(w);
    assert.deepEqual(run.proposal.deletes.map((d) => d.address), ["aws_cloudwatch_log_group.canary", "aws_s3_bucket.logs", "aws_s3_bucket_versioning.logs"], "the container is never proposed");
    const kept = run.proposal.excluded.find((x) => x.address === address);
    assert.equal(kept?.ownership, "CONTAINS_OTHERS");
    assert.equal(kept?.retainedBy, "PILOT_OWNER");
    assert.match(kept!.reason, /anything that deploys a CloudFormation stack or a provisioned product .* is kept: deleting it deletes all the stack holds, identities among it/);
    assert.ok(!JSON.stringify([run.proposal, run.records.blueprint, run.records.observation]).includes("AWS::IAM::Role") && !JSON.stringify([run.proposal, run.records.blueprint]).includes(STATE_CANARY), "no attribute text reaches a record");
    assert.equal(run.records.blueprint.blueprint.entries.find((e) => e.address === address)?.holdsIdentityArn, undefined, "no ARN is in the state: the container rule, not the ARN scan, keeps it");
    // A destroy plan that would take the container along (and its role with it) stops before any approval is consumed, naming the policy and the family.
    const approval = cleanupApproval(run.proposal, "alice");
    behave({ showResources: creates, stateResources: state, destroyExtra: [{ address, type, change: { actions: ["delete"], before: {}, after: null } }] });
    const taken = await cleanup(w, run, [approval]);
    refused(taken, "PROPOSAL_SCOPE_MISMATCH");
    assert.ok((taken as { message: string }).message.includes("would delete " + address + ", a stack container (" + family.what + ") holding resources the state does not list, which a pilot cleanup never deletes, directly or as a dependent (CONTAINS_OTHERS)"), (taken as { message: string }).message);
    assert.equal(applyCalls().length, 0);
    // A forged proposal that lists the container never executes: the list is derived again and the type is a container.
    const fields = { ...run.proposal, deletes: [...run.proposal.deletes, { address, type, identifier: kept!.identifier, ownership: "RUN_CREATED" as const, observed: "UNVERIFIABLE" as const }].sort((a, b) => (a.address < b.address ? -1 : 1)), excluded: run.proposal.excluded.filter((x) => x.address !== address) };
    const forged = reHashedProposal(fields);
    assert.ok(verifyCleanupProposal(forged).ok);
    behave({ showResources: creates, stateResources: state });
    refused(await cleanup(w, { ...run, proposal: forged }, [cleanupApproval(forged, "alice")]), "PROPOSAL_INVALID");
    assert.equal(applyCalls().length, 0);
    // The honest cleanup targets only the run's other resources and the container stays.
    const done = await cleanup(w, run, [approval]);
    assert.ok(done.ok, JSON.stringify(done));
    assert.ok(destroyPlans().length > 0 && destroyPlans().every((c) => !c.args.join(" ").includes(type)), "the container is never targeted");
  });
}

test("a wrapper nested past the scan depth refuses the whole proposal, and the execution guard stops a plan that touches it (review 6412896598 B2)", async () => {
  // B2: a terraform_data whose input nests deeper than the scan reads (no ARN anywhere) is unclassifiable: the proposal is refused for a person to review, and the execution guard stops a plan that touches it.
  let deep: unknown = "plain";
  for (let i = 0; i < 40; i++) deep = { level: deep };
  const wrapper = { mode: "managed", type: "terraform_data", name: "deep", provider: 'provider["terraform.io/builtin/terraform"]', instances: [{ schema_version: 0, attributes: { id: "d1b2d3e4-0000-4000-8000-000000000000", input: deep, output: null, triggers_replace: null } }] };
  const w2 = world();
  behave({ showResources: [...CREATES, { address: "terraform_data.deep", type: "terraform_data", change: { actions: ["create"], before: null, after: {} } }], stateResources: [...STATE, wrapper] });
  const applied2 = await observed(w2);
  const records2 = await loadRunRecords(applied2.s.sealed.artifactSha256, w2.dirs.evidence);
  assert.ok(records2.ok);
  const built2 = buildCleanupProposal({ requesterId: REQUESTER.requesterId, ...records2, changes: applied2.s.sealed.changes, channel: "CLI", contract: { ...(JSON.parse(JSON.stringify(awsContractJson(KILL))) as object), enabled: true } as never, engineVersion: applied2.s.sealed.engineVersion, env: w2.deps.env!, now: new Date(NOW.getTime() + 120_000) });
  refused(built2, "OWNERSHIP_AMBIGUOUS");
  assert.match((built2 as { message: string }).message, /terraform_data\.deep that is not a resource id the cleanup can classify exactly/);
  const entry2 = records2.blueprint.blueprint.entries.find((e) => e.address === "terraform_data.deep");
  assert.equal(entry2?.holdsIdentityArn, true, "the blueprint could not scan the attribute in full, so it fails closed");
  assert.ok(!JSON.stringify(records2.blueprint).includes("level"), "no attribute value was copied into the blueprint");
  const guard = protectedDeletionIn([{ address: "terraform_data.deep", type: "terraform_data", action: "DELETE" }], records2.blueprint.blueprint.entries, { ...(JSON.parse(JSON.stringify(awsContractJson(KILL))) as object), enabled: true } as never, w2.deps.env!);
  assert.ok(guard !== undefined && guard.includes("(OWNERSHIP_AMBIGUOUS)") && guard.includes("could not scan in full"), guard);
});

test("AWS identities the run created are never deleted (owner policy #39): an application role, its inline policy, a policy attachment and an access key are kept as PROTECTED_IDENTITY by the pilot owner, a destroy plan that would take any of them along stops before any approval is consumed, a pilot role's ARN under terraform_data refuses the proposal, the run's other resources are cleaned up, and the leftover check is COMPLETE with the identities intentionally retained", async () => {
  const APP_ROLE = "alz-app-role";
  const APP_ROLE_ARN = "arn:aws:iam::111111111111:role/" + APP_ROLE;
  const creates = [...CREATES,
    { address: "aws_iam_role.app", type: "aws_iam_role", change: { actions: ["create"], before: null, after: {} } },
    { address: "aws_iam_role_policy.app_inline", type: "aws_iam_role_policy", change: { actions: ["create"], before: null, after: {} } },
    { address: "aws_iam_policy_attachment.shared", type: "aws_iam_policy_attachment", change: { actions: ["create"], before: null, after: {} } },
    { address: "aws_iam_access_key.app", type: "aws_iam_access_key", change: { actions: ["create"], before: null, after: {} } },
    { address: "aws_identitystore_user.ops", type: "aws_identitystore_user", change: { actions: ["create"], before: null, after: {} } },
    { address: "aws_identitystore_group.ops", type: "aws_identitystore_group", change: { actions: ["create"], before: null, after: {} } },
    { address: "aws_identitystore_group_membership.ops", type: "aws_identitystore_group_membership", change: { actions: ["create"], before: null, after: {} } },
  ];
  const state = [...STATE, stateResource("aws_iam_role", "app", APP_ROLE, APP_ROLE_ARN), stateResource("aws_iam_role_policy", "app_inline", APP_ROLE + ":inline"),
    stateResource("aws_iam_policy_attachment", "shared", "shared-attachment"), stateResource("aws_iam_access_key", "app", "AKIAFAKEAPPKEY000000"),
    stateResource("aws_identitystore_user", "ops", "d-1234567890/11111111-aaaa-4aaa-8aaa-111111111111"), stateResource("aws_identitystore_group", "ops", "d-1234567890/22222222-bbbb-4bbb-8bbb-222222222222"),
    stateResource("aws_identitystore_group_membership", "ops", "d-1234567890/33333333-cccc-4ccc-8ccc-333333333333")];
  const w = world();
  behave({ showResources: creates, stateResources: state });
  cloud({ existing: [...EXISTING, APP_ROLE], tagged: [...TAGGED, APP_ROLE_ARN] });
  const run = await proposed(w);
  assert.deepEqual(run.proposal.deletes.map((d) => d.address), ["aws_cloudwatch_log_group.canary", "aws_s3_bucket.logs", "aws_s3_bucket_versioning.logs"], "only the run's non-identity resources are proposed");
  const kept = new Map(run.proposal.excluded.map((x) => [x.address, x]));
  for (const address of ["aws_iam_role.app", "aws_iam_role_policy.app_inline", "aws_iam_policy_attachment.shared", "aws_iam_access_key.app", "aws_iam_role.apply", "aws_identitystore_user.ops", "aws_identitystore_group.ops", "aws_identitystore_group_membership.ops"]) {
    assert.equal(kept.get(address)?.ownership, "PROTECTED_IDENTITY", address);
    assert.equal(kept.get(address)?.retainedBy, "PILOT_OWNER", address);
    assert.match(kept.get(address)!.reason, /anything in the IAM, IAM Identity Center or Identity Store services, including attachments, access keys and other credentials of those identities.*never deleted by a cleanup, directly or as a dependent/, address);
    assert.ok(kept.get(address)!.reason.length <= 512, "a proposal's reason stays within its limit");
  }
  assert.equal(kept.get("aws_iam_access_key.app")?.identifier, null, "the access key id is never recorded");
  assert.ok(!JSON.stringify([run.proposal, run.records.blueprint, run.records.observation]).includes("AKIAFAKEAPPKEY000000"), "no access key id reaches a record");
  // A destroy plan that would take the role, the attachment or the key along stops before any approval is consumed, naming the policy.
  const approval = cleanupApproval(run.proposal, "alice");
  for (const [address, type] of [["aws_iam_role.app", "aws_iam_role"], ["aws_iam_policy_attachment.shared", "aws_iam_policy_attachment"], ["aws_iam_access_key.app", "aws_iam_access_key"],
    ["aws_identitystore_user.ops", "aws_identitystore_user"], ["aws_identitystore_group.ops", "aws_identitystore_group"], ["aws_identitystore_group_membership.ops", "aws_identitystore_group_membership"]] as const) {
    behave({ showResources: creates, stateResources: state, destroyExtra: [{ address, type, change: { actions: ["delete"], before: {}, after: null } }] });
    const taken = await cleanup(w, run, [approval]);
    refused(taken, "PROPOSAL_SCOPE_MISMATCH");
    assert.match((taken as { message: string }).message, new RegExp("would delete " + address.replace(".", "\\.") + ", an identity or authorization object, which a pilot cleanup never deletes, directly or as a dependent \\(PROTECTED_IDENTITY\\)"), address);
    assert.equal(applyCalls().length, 0, address);
  }
  // A pilot role's ARN recorded under terraform_data, not as its identifier but inside an attribute (a list element): the whole proposal is refused for a person to review.
  const disguised = world();
  const wrapper = { mode: "managed", type: "terraform_data", name: "pilot_role", provider: 'provider["terraform.io/builtin/terraform"]',
    instances: [{ schema_version: 0, attributes: { id: "c1b2d3e4-0000-4000-8000-000000000000", input: { roles: "reader," + awsRoleArn("APPLY", "DEV") + ",writer" }, output: null, triggers_replace: null } }] };
  behave({ showResources: [...creates, { address: "terraform_data.pilot_role", type: "terraform_data", change: { actions: ["create"], before: null, after: {} } }], stateResources: [...state, wrapper] });
  cloud({ existing: [...EXISTING, APP_ROLE], tagged: [...TAGGED, APP_ROLE_ARN] });
  const applied2 = await observed(disguised);
  const records2 = await loadRunRecords(applied2.s.sealed.artifactSha256, disguised.dirs.evidence);
  assert.ok(records2.ok);
  const built2 = buildCleanupProposal({ requesterId: REQUESTER.requesterId, ...records2, changes: applied2.s.sealed.changes, channel: "CLI", contract: { ...(JSON.parse(JSON.stringify(awsContractJson(KILL))) as object), enabled: true } as never, engineVersion: applied2.s.sealed.engineVersion, env: disguised.deps.env!, now: new Date(NOW.getTime() + 120_000) });
  refused(built2, "OWNERSHIP_AMBIGUOUS");
  assert.match((built2 as { message: string }).message, /terraform_data\.pilot_role that is not a resource id the cleanup can classify exactly/);
  assert.equal(records2.blueprint.blueprint.entries.find((e) => e.address === "terraform_data.pilot_role")?.holdsIdentityArn, true, "the blueprint judged the attribute in place");
  assert.ok(!JSON.stringify(records2.blueprint).includes("reader,"), "no attribute value was copied into the blueprint");
  behave({ showResources: creates, stateResources: state });
  // A forged proposal that lists the role never executes.
  const fields = { ...run.proposal, deletes: [...run.proposal.deletes, { address: "aws_iam_role.app", type: "aws_iam_role", identifier: APP_ROLE, ownership: "RUN_CREATED" as const, observed: "VERIFIED" as const }].sort((a, b) => (a.address < b.address ? -1 : 1)), excluded: run.proposal.excluded.filter((x) => x.address !== "aws_iam_role.app") };
  const forged = reHashedProposal(fields);
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
  for (const address of ["aws_iam_role.app", "aws_iam_role_policy.app_inline", "aws_iam_policy_attachment.shared", "aws_iam_access_key.app", "aws_iam_role.apply", "aws_identitystore_user.ops", "aws_identitystore_group.ops", "aws_identitystore_group_membership.ops"]) assert.deepEqual(dispositions.get(address), ["INTENTIONALLY_RETAINED", "PILOT_OWNER"], address);
  assert.deepEqual(dispositions.get("aws_s3_bucket.logs"), ["CONFIRMED_DELETED", undefined]);
  assert.ok(!JSON.stringify(leftovers.record).includes("AKIAFAKEAPPKEY000000"));
});

/**
 * The reviewed AWS leaf allowlist by name (delegated owner decision 6433391052, item 1): the test list and the table are checked against each other
 * both ways, so an entry added to the table without a test row, or a test row the table lost, fails here.
 */
const AWS_LEAF_TYPES_BY_NAME = [
  "aws_s3_bucket", "awscc_s3_bucket", "AWS::S3::Bucket",
  "aws_s3_bucket_versioning", "aws_s3_bucket_server_side_encryption_configuration", "aws_s3_bucket_public_access_block", "aws_s3_bucket_ownership_controls", "aws_s3_bucket_lifecycle_configuration",
  "aws_cloudwatch_log_group", "awscc_logs_log_group", "AWS::Logs::LogGroup",
  "aws_sqs_queue", "awscc_sqs_queue", "AWS::SQS::Queue",
  "aws_sns_topic", "awscc_sns_topic", "AWS::SNS::Topic",
  "aws_ssm_parameter", "awscc_ssm_parameter", "AWS::SSM::Parameter",
  "aws_dynamodb_table", "awscc_dynamodb_table", "AWS::DynamoDB::Table",
  "aws_kms_key", "awscc_kms_key", "AWS::KMS::Key",
  "aws_lambda_function", "awscc_lambda_function", "AWS::Lambda::Function",
  "aws_cloudwatch_metric_alarm", "awscc_cloudwatch_alarm", "AWS::CloudWatch::Alarm",
  "aws_budgets_budget", "AWS::Budgets::Budget",
  "AWS::CDK::Metadata",
  // The owner's decision 6431744115, item 3, exactly (design review 6434540427 B1 and N5 removed the delegated administrator, Lake Formation and the Redshift role set).
  "aws_organizations_policy", "aws_organizations_policy_attachment", "awscc_organizations_policy", "AWS::Organizations::Policy",
  "aws_kms_grant",
  "aws_s3_bucket_policy", "awscc_s3_bucket_policy", "AWS::S3::BucketPolicy", "aws_sqs_queue_policy", "AWS::SQS::QueuePolicy", "aws_lambda_permission", "awscc_lambda_permission", "AWS::Lambda::Permission",
  "aws_rolesanywhere_trust_anchor", "aws_rolesanywhere_profile", "awscc_rolesanywhere_trust_anchor", "awscc_rolesanywhere_profile", "AWS::RolesAnywhere::TrustAnchor", "AWS::RolesAnywhere::Profile",
  "aws_rds_cluster_role_association", "aws_db_instance_role_association",
  "aws_cognito_user", "awscc_cognito_user_pool_user", "AWS::Cognito::UserPoolUser",
  // Common leaves with a material-risk note.
  "aws_secretsmanager_secret", "awscc_secretsmanager_secret", "AWS::SecretsManager::Secret",
  "aws_db_instance", "aws_rds_cluster", "awscc_rds_db_instance", "awscc_rds_db_cluster", "AWS::RDS::DBInstance", "AWS::RDS::DBCluster",
  "aws_efs_file_system", "awscc_efs_file_system", "AWS::EFS::FileSystem", "aws_ebs_volume", "awscc_ec2_volume", "AWS::EC2::Volume",
  "aws_kms_alias", "awscc_kms_alias", "AWS::KMS::Alias",
];
/** Well-formed types that are on no list: held as TYPE_UNREVIEWED. The round-5 fail-safes, the owner's open questions, and near misses of allowlisted names. */
const AWS_UNREVIEWED_TYPES = [
  "aws_cloud9_environment_ec2", "aws_config_conformance_pack", "aws_config_organization_conformance_pack", "awscc_launchwizard_deployment", "AWS::LaunchWizard::Deployment", "aws_amplify_app", "aws_amplify_branch", "aws_amplify_backend_environment",
  "aws_eks_access_entry", "aws_eks_access_policy_association", "aws_eks_pod_identity_association", "AWS::EKS::AccessEntry", "aws_verifiedpermissions_policy_store", "aws_verifiedpermissions_policy",
  "terraform_data", "null_resource", "random_id", "aws_datazone_project", "aws_vpc", "aws_instance",
  // Removed by design review 6434540427 (B1, N5): held for the owner, not re-justified here.
  "aws_organizations_delegated_administrator", "aws_lakeformation_permissions", "awscc_lakeformation_principal_permissions", "AWS::LakeFormation::Permissions", "AWS::LakeFormation::PrincipalPermissions", "aws_redshift_cluster_iam_roles",
  "aws_s3_bucketx", "aws_s3_bucket_notification", "aws_s3_object", "aws_sqs_queue_redrive_policy", "AWS::S3::BucketX", "AWS::S3::Bucket::Thing", "AWS::s3::Bucket", "AWS::CloudFormation::WaitCondition",
  // A custom resource (`Custom::*`, `AWS::CloudFormation::CustomResource`) is CONTAINS_OTHERS with its own reason here, ahead of the allowlist (test/apply-cdk.test.ts).
];

test("the reviewed AWS leaf allowlist is closed (delegated owner decision 6433391052): only a type listed by exact name is ordinary, every other well-formed type is TYPE_UNREVIEWED, a malformed type is unclassifiable, and the identity and container rules still come first", () => {
  const entry = (address: string, type: string, id: string | null = "x", arn: string | null = null) => ({ address, type, id, arn });
  const change = (address: string, type: string, action = "DELETE") => [{ address, type, action }];
  const env = awsIdentityEnv("DEV");
  // The table and the test list, both ways; every entry carries what it is, why it is a leaf and its basis.
  assert.deepEqual([...AWS_LEAF_TYPE_NAMES].sort(), [...AWS_LEAF_TYPES_BY_NAME].sort(), "the allowlist and the test list are the same set");
  assert.equal(new Set(AWS_LEAF_TYPE_NAMES).size, AWS_LEAF_TYPE_NAMES.length, "no type is listed twice");
  for (const leaf of AWS_LEAF_TYPES) {
    assert.ok(leaf.what.length > 0 && leaf.reason.length > 0 && leaf.types.length > 0 && ["PILOT_JOURNEY", "OWNER_DECISION", "COMMON_LEAF"].includes(leaf.basis), "an entry has a description, a reason, a basis and types");
  }
  for (const type of AWS_LEAF_TYPE_NAMES) {
    assert.ok(isWellFormedResourceType(type) && isAwsLeafType(type) && awsLeafEntryOf(type) !== undefined, type);
    // A leaf is never an identity or a container: the deny tables would win, and the allowlist must not pretend otherwise.
    assert.ok(!isAwsIdentityType(type) && !isAwsContainerType(type), type + " is neither an identity nor a container");
    if (awsLeafEntryOf(type)!.condition !== undefined) {
      // An entry that admits only some objects (Organizations policies: service control policies only) holds an object it cannot judge, by entry and by type alone.
      assert.ok(protectedDeletionIn(change("x.y", type), [entry("x.y", type)], IDENTITY_FIXTURE_CONTRACT, env)?.endsWith("(TYPE_UNREVIEWED)."), type + " with no recorded kind is held");
      assert.ok(protectedDeletionIn(change("x.y", type), [], IDENTITY_FIXTURE_CONTRACT, env)?.endsWith("(TYPE_UNREVIEWED)."), type + " by type alone is held");
      continue;
    }
    assert.equal(protectedDeletionIn(change("x.y", type), [entry("x.y", type)], IDENTITY_FIXTURE_CONTRACT, env), undefined, type + " is ordinary by entry");
    assert.equal(protectedDeletionIn(change("x.y", type), [], IDENTITY_FIXTURE_CONTRACT, env), undefined, type + " is ordinary by type alone");
  }
  assert.deepEqual(AWS_LEAF_TYPES.filter((leaf) => leaf.condition).flatMap((leaf) => leaf.types), ["aws_organizations_policy", "awscc_organizations_policy", "AWS::Organizations::Policy"], "only the Organizations policy entry is conditional");
  // Every data-bearing entry's types carry a material-risk note, and every allowlisted type with a note is in a data-bearing entry, so the two lists cannot drift apart (design review 6434540427, B2).
  for (const leaf of AWS_LEAF_TYPES) for (const type of leaf.types) {
    if (leaf.dataBearing) assert.ok((MATERIAL_RISKS[type] ?? "").length > 0, type + " (" + leaf.what + ") holds data but has no material-risk note");
    else assert.equal(MATERIAL_RISKS[type], undefined, type + " has a material-risk note but its entry is not marked data-bearing");
  }
  assert.match(MATERIAL_RISKS.aws_kms_key, /resources outside the state and resources this cleanup keeps/);
  assert.match(MATERIAL_RISKS.aws_dynamodb_table, /replicas in other Regions/);
  // Every attachment or setting names its parent by the one rule: the parent types are allowlisted leaves with no parent of their own (design review 6434540427, B3).
  const PARENTED = ["aws_s3_bucket_versioning", "aws_s3_bucket_server_side_encryption_configuration", "aws_s3_bucket_public_access_block", "aws_s3_bucket_ownership_controls", "aws_s3_bucket_lifecycle_configuration",
    "aws_s3_bucket_policy", "awscc_s3_bucket_policy", "AWS::S3::BucketPolicy", "aws_sqs_queue_policy", "AWS::SQS::QueuePolicy", "aws_lambda_permission", "awscc_lambda_permission", "AWS::Lambda::Permission",
    "aws_kms_grant", "aws_rds_cluster_role_association", "aws_db_instance_role_association", "aws_organizations_policy_attachment"];
  assert.deepEqual(AWS_LEAF_TYPES.filter((leaf) => leaf.parent).flatMap((leaf) => leaf.types).sort(), [...PARENTED].sort(), "exactly the attachment and setting types name a parent");
  for (const leaf of AWS_LEAF_TYPES.filter((x) => x.parent)) for (const type of leaf.parent!.types) assert.ok(isAwsLeafType(type) && awsLeafEntryOf(type)!.parent === undefined, type + " is a parent leaf");
  assert.equal(awsParentIdOf("SAME", "bucket-a"), "bucket-a");
  assert.equal(awsParentIdOf("BEFORE_FIRST_COLON", "1234abcd-key:grant0123"), "1234abcd-key");
  assert.equal(awsParentIdOf("BEFORE_FIRST_COMMA", "cluster-a,arn:aws:iam::111111111111:role/x"), "cluster-a");
  assert.equal(awsParentIdOf("AFTER_LAST_COLON", "ou-abcd-12345678:p-12345678"), "p-12345678");
  for (const [key, id] of [["NOT_IN_STATE", "anything"], ["SAME", null], ["SAME", ""], ["BEFORE_FIRST_COLON", "nocolon"], ["BEFORE_FIRST_COLON", ":grant"], ["BEFORE_FIRST_COMMA", "cluster,"], ["AFTER_LAST_COLON", "target:"]] as const) {
    assert.equal(awsParentIdOf(key, id), undefined, key + " " + id);
  }
  // The owner's open questions are not seeded (round 3, N2 and N4).
  for (const type of ["aws_eks_access_entry", "aws_eks_access_policy_association", "AWS::EKS::AccessEntry", "aws_verifiedpermissions_policy_store", "terraform_data", "null_resource"]) assert.ok(!isAwsLeafType(type), type + " is not seeded");
  // Every other well-formed type is held, by entry and by type alone, on delete and on update.
  for (const type of AWS_UNREVIEWED_TYPES) {
    assert.ok(isWellFormedResourceType(type) && !isAwsLeafType(type), type);
    for (const [planned, entries] of [[change("x.y", type), [entry("x.y", type)]], [change("x.y", type), []], [change("x.y", type, "UPDATE"), []]] as const) {
      const refusal = protectedDeletionIn(planned, entries, IDENTITY_FIXTURE_CONTRACT, env);
      assert.ok(refusal !== undefined && refusal.includes("whose type (" + type + ") is not on the reviewed leaf allowlist") && refusal.endsWith("never deletes it, directly or as a dependent (TYPE_UNREVIEWED)."), type + ": " + refusal);
    }
  }
  // A type field that is not a well-formed type names nothing the cleanup can judge: unclassifiable, the whole proposal refused.
  for (const type of ["", " aws_s3_bucket", "aws_s3_bucket ", "AWS_S3_BUCKET", "module.m.aws_s3_bucket", "AWS::S3:Bucket", "aws-s3-bucket", "s3", "AWS::S3::Bucket::A::B"]) {
    assert.ok(!isWellFormedResourceType(type), JSON.stringify(type));
    assert.ok(protectedDeletionIn(change("x.y", type), [entry("x.y", type)], IDENTITY_FIXTURE_CONTRACT, env)?.includes("(OWNERSHIP_AMBIGUOUS)"), JSON.stringify(type));
  }
  // The deny rules stay first: an allowlisted type holding an identity's ARN is still refused, and the backend bucket is still the backend.
  assert.ok(protectedDeletionIn(change("x.y", "aws_lambda_function"), [entry("x.y", "aws_lambda_function", "fn", awsRoleArn("APPLY", "DEV"))], IDENTITY_FIXTURE_CONTRACT, env)?.includes("(OWNERSHIP_AMBIGUOUS)"));
  assert.ok(protectedDeletionIn(change("x.y", "aws_s3_bucket"), [entry("x.y", "aws_s3_bucket", STATE_BUCKET)], IDENTITY_FIXTURE_CONTRACT, env)?.includes("(PROTECTED_BACKEND)"));
});

test("a run that created an allowlisted resource and one of an unreviewed type cleans up the first and keeps the second, named, for the environment's owner: a dependent destroy of it is refused before any approval is consumed, a forged proposal naming it never executes, and the leftover check is never COMPLETE while it remains (delegated owner decision 6433391052)", async () => {
  const UNREVIEWED = "aws_cloud9_environment_ec2";
  const address = UNREVIEWED + ".dev";
  const creates = [...CREATES, { address, type: UNREVIEWED, change: { actions: ["create"], before: null, after: {} } }];
  const state = [...STATE, stateResource(UNREVIEWED, "dev", "0123456789abcdef0123456789abcdef", "arn:aws:cloud9:us-east-1:111111111111:environment:0123456789abcdef0123456789abcdef")];
  const w = world();
  behave({ showResources: creates, stateResources: state });
  const run = await proposed(w);
  assert.deepEqual(run.proposal.deletes.map((d) => d.address), ["aws_cloudwatch_log_group.canary", "aws_s3_bucket.logs", "aws_s3_bucket_versioning.logs"], "the allowlisted resources are proposed, the unreviewed one is not");
  const kept = run.proposal.excluded.find((x) => x.address === address);
  assert.equal(kept?.ownership, "TYPE_UNREVIEWED");
  assert.equal(kept?.retainedBy, "ENVIRONMENT_OWNER");
  assert.ok(kept!.reason.includes("its type (" + UNREVIEWED + ") is not on the reviewed leaf allowlist") && kept!.reason.length <= 512, kept!.reason);
  assert.ok(run.proposal.risks.some((r) => r.includes("not on the reviewed leaf allowlist, and attachments or settings on a resource this cleanup keeps, are held, named and never deleted")), "the proposal says so before approval");
  // The other classes are unchanged: the pilot role is an identity, the backend is the backend, the old queue is outside the plan.
  assert.equal(run.proposal.excluded.find((x) => x.address === "aws_iam_role.apply")?.ownership, "PROTECTED_IDENTITY");
  assert.equal(run.proposal.excluded.find((x) => x.address === "aws_s3_bucket.state")?.ownership, "PROTECTED_BACKEND");
  assert.equal(run.proposal.excluded.find((x) => x.address === "aws_sqs_queue.preexisting")?.ownership, "NOT_IN_PLAN");
  // A destroy plan that would take it along stops before any approval is consumed.
  const approval = cleanupApproval(run.proposal, "alice");
  behave({ showResources: creates, stateResources: state, destroyExtra: [{ address, type: UNREVIEWED, change: { actions: ["delete"], before: {}, after: null } }] });
  const taken = await cleanup(w, run, [approval]);
  refused(taken, "PROPOSAL_SCOPE_MISMATCH");
  assert.ok((taken as { message: string }).message.includes("would delete " + address + ", whose type (" + UNREVIEWED + ") is not on the reviewed leaf allowlist"), (taken as { message: string }).message);
  assert.equal(applyCalls().length, 0);
  // A forged, re-hashed proposal that lists it never executes: the list is derived again.
  const fields = { ...run.proposal, deletes: [...run.proposal.deletes, { address, type: UNREVIEWED, identifier: kept!.identifier, ownership: "RUN_CREATED" as const, observed: "UNVERIFIABLE" as const }].sort((a, b) => (a.address < b.address ? -1 : 1)), excluded: run.proposal.excluded.filter((x) => x.address !== address) };
  const forged = reHashedProposal(fields);
  assert.ok(verifyCleanupProposal(forged).ok);
  behave({ showResources: creates, stateResources: state });
  refused(await cleanup(w, { ...run, proposal: forged }, [cleanupApproval(forged, "alice")]), "PROPOSAL_INVALID");
  assert.equal(applyCalls().length, 0);
  // The honest cleanup removes the allowlisted resources and never targets the unreviewed one.
  behave({ showResources: creates, stateResources: state });
  const done = await cleanup(w, run, [approval]);
  assert.ok(done.ok, JSON.stringify(done));
  assert.deepEqual(destroyPlans()[0]!.args.filter((a) => a.startsWith("-target=")).sort(), run.proposal.deletes.map((d) => "-target=" + d.address).sort());
  assert.ok(destroyPlans().every((c) => !c.args.join(" ").includes(UNREVIEWED)), "the unreviewed resource is never targeted");
  // Leftovers: every listed resource is gone and the sweep is complete, yet the record is INCOMPLETE and names the type for a person.
  cloud({ existing: [STATE_BUCKET, OLD_QUEUE, "alz-apply-dev"], tagged: [] });
  const leftovers = await verifyProposalLeftovers(run.proposal, observeDeps(w, new Date(NOW.getTime() + 600_000)));
  assert.ok(leftovers.ok, JSON.stringify(leftovers));
  assert.equal(leftovers.record.sweep, "COMPLETE");
  assert.equal(leftovers.record.disposition, "INCOMPLETE");
  const held = leftovers.record.resources.find((r) => r.address === address)!;
  assert.deepEqual([held.disposition, held.basis, held.owner], ["INTENTIONALLY_RETAINED", "UNREVIEWED_TYPE", "ENVIRONMENT_OWNER"]);
  assert.ok(leftovers.record.nextAction.includes(UNREVIEWED) && leftovers.record.nextAction.includes("a person deletes or keeps them by hand"), leftovers.record.nextAction);
  assert.deepEqual(leftovers.record.resources.find((r) => r.address === "aws_s3_bucket.logs")?.disposition, "CONFIRMED_DELETED");
  // A record that claims completion while one is held is refused as a record.
  for (const claimed of ["COMPLETE", "KNOWN_ADDRESSES_CONFIRMED"] as const) {
    const problems = leftoversRecordProblems({ ...leftovers.record, disposition: claimed, sweep: claimed === "COMPLETE" ? "COMPLETE" : "NOT_AVAILABLE" });
    assert.ok(problems.some((p) => p.includes("its type is unreviewed")), claimed + ": " + problems.join("; "));
  }
  // The acceptance statement names them, and stays as it was when none is held.
  const acceptance = acceptanceOf({ leftovers: { status: "INCONCLUSIVE" } } as never, run.proposal.excluded);
  assert.equal(acceptance.resourceCleanup, "INCOMPLETE");
  assert.equal(acceptance.retained.byOwnership.TYPE_UNREVIEWED, 1);
  // Held objects are counted under their own label, never as protected or pre-existing (design review 6434540427, N2).
  const keptCount = run.proposal.excluded.length - 1;
  assert.ok(acceptance.statement.startsWith("resource cleanup incomplete; " + keptCount + " protected or pre-existing object(s) intentionally retained ("), acceptance.statement);
  assert.match(acceptance.statement, /; 1 object\(s\) held for a person's decision \(a type not on the reviewed leaf allowlist, or a setting on a resource this cleanup keeps; kept by ENVIRONMENT_OWNER\); environment retirement outstanding/);
  assert.equal(acceptanceStatement("NOT_RUN", { total: 2, byOwnership: { TYPE_UNREVIEWED: 2 }, byOwner: { ENVIRONMENT_OWNER: 2 } }),
    "resource cleanup not run; 2 object(s) held for a person's decision (a type not on the reviewed leaf allowlist, or a setting on a resource this cleanup keeps; kept by ENVIRONMENT_OWNER); environment retirement outstanding (a separate, reviewed action; this report does not claim the environment retired)");
  assert.ok(!acceptanceStatement("COMPLETED", { total: 1, byOwnership: { PROTECTED_IDENTITY: 1 }, byOwner: { PILOT_OWNER: 1 } }).includes("leaf allowlist"));
});

// Owner decision 6440801434, item 3: an Organizations policy is a leaf only when it is a service control policy, judged from the policy ARN the state recorded.
const ORG = "o-exampleorg1";
const policyArn = (kind: string, id: string) => "arn:aws:organizations::999999999999:policy/" + ORG + "/" + kind + "/" + id;
const POLICY_KINDS = ["resource_control_policy", "tag_policy", "backup_policy", "aiservices_opt_out_policy", "chatbot_policy", "declarative_policy_ec2", "security_hub_policy", "some_future_policy"];

test("Organizations policies: only a service control policy is a leaf; every other kind, a missing or unreadable ARN, and an id that is not the ARN's are held with a named reason (owner decision 6440801434, item 3)", () => {
  const env = awsIdentityEnv("DEV");
  const change = (address: string, type: string) => [{ address, type, action: "DELETE" }];
  for (const type of ["aws_organizations_policy", "awscc_organizations_policy"]) {
    const scp = { type, id: "p-scp00001", arn: policyArn("service_control_policy", "p-scp00001") };
    assert.equal(serviceControlPolicyProblem(scp), undefined, type);
    assert.equal(awsLeafConditionProblem(scp), undefined, type);
    assert.equal(awsLeafConditionProblem({ ...scp, id: null }), undefined, type + ": the ARN alone names the kind");
    assert.equal(protectedDeletionIn(change("x.y", type), [{ address: "x.y", ...scp }], IDENTITY_FIXTURE_CONTRACT, env), undefined, type + ": an SCP is ordinary");
    for (const kind of POLICY_KINDS) {
      const other = { type, id: "p-other0001", arn: policyArn(kind, "p-other0001") };
      const reason = awsLeafConditionProblem(other);
      assert.ok(reason?.includes("of kind " + kind.toUpperCase() + ", not a service control policy") && reason.includes("owner decision 6440801434, item 3") && reason.length <= 512, kind + ": " + reason);
      const refusal = protectedDeletionIn(change("x.y", type), [{ address: "x.y", ...other }], IDENTITY_FIXTURE_CONTRACT, env);
      assert.ok(refusal?.includes(kind.toUpperCase()) && refusal.endsWith("(TYPE_UNREVIEWED)."), kind + ": " + refusal);
    }
    for (const [label, arn, id, words] of [
      ["no ARN", null, "p-scp00001", "the state records no policy ARN"],
      ["another service's ARN", "arn:aws:s3:::examplefake-bucket", "p-scp00001", "not an Organizations policy ARN"],
      ["a truncated ARN", "arn:aws:organizations::999999999999:policy/service_control_policy/p-scp00001", "p-scp00001", "not an Organizations policy ARN"],
      ["an AWS managed policy", "arn:aws:organizations::aws:policy/service_control_policy/p-FullAWSAccess", "p-FullAWSAccess", "not an Organizations policy ARN"],
      ["a kind in capitals", policyArn("SERVICE_CONTROL_POLICY", "p-scp00001"), "p-scp00001", "not an Organizations policy ARN"],
      ["an id the ARN does not name", policyArn("service_control_policy", "p-scp00001"), "p-other0001", "does not match the policy its ARN names"],
    ] as const) {
      const reason = awsLeafConditionProblem({ type, id, arn });
      assert.ok(reason?.includes(words), label + ": " + reason);
      assert.ok(protectedDeletionIn(change("x.y", type), [{ address: "x.y", type, id, arn }], IDENTITY_FIXTURE_CONTRACT, env)?.endsWith("(TYPE_UNREVIEWED)."), label);
    }
  }
  // The CloudFormation physical id of a policy is its id alone: a CDK-created policy's kind cannot be read, so it is always held.
  assert.match(awsLeafConditionProblem({ type: "AWS::Organizations::Policy", id: "p-scp00001", arn: null }) ?? "", /cannot be read/);
  // Types without a condition are untouched by it.
  assert.equal(awsLeafConditionProblem({ type: "aws_s3_bucket", id: "b", arn: null }), undefined);
  assert.equal(awsLeafConditionProblem({ type: "aws_cloud9_environment_ec2", id: "x", arn: null }), undefined);
});

test("a run that created an SCP and a tag policy, each attached, cleans up the SCP and its attachment and holds the tag policy and its attachment: a forged proposal naming the tag policy never executes, and a destroy that would take it along stops before any approval is consumed", async () => {
  const SCP = "p-scp00001";
  const TAGS = "p-tags0001";
  const OU = "ou-abcd-12345678";
  const resources = [
    ["aws_organizations_policy", "scp", SCP, policyArn("service_control_policy", SCP)],
    ["aws_organizations_policy", "tags", TAGS, policyArn("tag_policy", TAGS)],
    ["aws_organizations_policy_attachment", "scp", OU + ":" + SCP, null],
    ["aws_organizations_policy_attachment", "tags", OU + ":" + TAGS, null],
  ] as const;
  const creates = [...CREATES, ...resources.map(([type, name]) => ({ address: type + "." + name, type, change: { actions: ["create"], before: null, after: {} } }))];
  const state = [...STATE, ...resources.map(([type, name, id, arn]) => arn === null ? stateResource(type, name, id) : stateResource(type, name, id, arn))];
  const w = world();
  behave({ showResources: creates, stateResources: state });
  const run = await proposed(w);
  const deleted = run.proposal.deletes.map((d) => d.address);
  assert.ok(deleted.includes("aws_organizations_policy.scp") && deleted.includes("aws_organizations_policy_attachment.scp"), deleted.join(", "));
  assert.ok(!deleted.includes("aws_organizations_policy.tags") && !deleted.includes("aws_organizations_policy_attachment.tags"), deleted.join(", "));
  const kept = new Map(run.proposal.excluded.map((x) => [x.address, x]));
  assert.equal(kept.get("aws_organizations_policy.tags")?.ownership, "TYPE_UNREVIEWED");
  assert.equal(kept.get("aws_organizations_policy.tags")?.retainedBy, "ENVIRONMENT_OWNER");
  assert.match(kept.get("aws_organizations_policy.tags")!.reason, /of kind TAG_POLICY, not a service control policy/);
  assert.equal(kept.get("aws_organizations_policy_attachment.tags")?.ownership, "TYPE_UNREVIEWED");
  assert.match(kept.get("aws_organizations_policy_attachment.tags")!.reason, /an attachment or setting .* that modifies another resource, and this proposal does not delete that resource with it/);
  assert.ok(verifyCleanupProposal(run.proposal).ok);
  // A forged, re-hashed proposal that lists the tag policy never executes: the list is derived again from the records.
  const address = "aws_organizations_policy.tags";
  const fields = { ...run.proposal, deletes: [...run.proposal.deletes, { address, type: "aws_organizations_policy", identifier: kept.get(address)!.identifier, ownership: "RUN_CREATED" as const, observed: "UNVERIFIABLE" as const }].sort((a, b) => (a.address < b.address ? -1 : 1)), excluded: run.proposal.excluded.filter((x) => x.address !== address) };
  const forged = reHashedProposal(fields);
  assert.ok(verifyCleanupProposal(forged).ok, "the forgery is self-consistent");
  behave({ showResources: creates, stateResources: state });
  refused(await cleanup(w, { ...run, proposal: forged }, [cleanupApproval(forged, "alice")]), "PROPOSAL_INVALID");
  assert.equal(applyCalls().length, 0);
  // A destroy plan that would take the tag policy along as a dependent stops before any approval is consumed.
  const approval = cleanupApproval(run.proposal, "alice");
  behave({ showResources: creates, stateResources: state, destroyExtra: [{ address, type: "aws_organizations_policy", change: { actions: ["delete"], before: {}, after: null } }] });
  const taken = await cleanup(w, run, [approval]);
  refused(taken, "PROPOSAL_SCOPE_MISMATCH");
  assert.match((taken as { message: string }).message, /would delete aws_organizations_policy\.tags \(aws_organizations_policy\), which a pilot cleanup never deletes.*TAG_POLICY/);
  assert.equal(applyCalls().length, 0);
  // The honest cleanup removes the SCP and its attachment and never targets the tag policy or its attachment.
  behave({ showResources: creates, stateResources: state });
  const done = await cleanup(w, run, [approval]);
  assert.ok(done.ok, JSON.stringify(done));
  const targets = destroyPlans()[0]!.args.filter((a) => a.startsWith("-target=")).sort();
  assert.deepEqual(targets, run.proposal.deletes.map((d) => "-target=" + d.address).sort());
  assert.ok(destroyPlans().every((c) => !c.args.join(" ").includes(".tags")), "the tag policy and its attachment are never targeted");
});

test("an attachment or setting is deleted only with its parent (design review 6434540427, B3): a pre-existing bucket kept for its owner keeps the public access block, ownership controls and policy the plan 'created' on it, a pre-existing queue keeps its policy, and the run's own bucket loses its settings with it", async () => {
  const TEAM = "examplefake-team-data";
  const settings = [["aws_s3_bucket_public_access_block", "team"], ["aws_s3_bucket_ownership_controls", "team"], ["aws_s3_bucket_policy", "team"]] as const;
  const creates = [...CREATES,
    ...settings.map(([type, name]) => ({ address: type + "." + name, type, change: { actions: ["create"], before: null, after: {} } })),
    { address: "aws_sqs_queue_policy.preexisting", type: "aws_sqs_queue_policy", change: { actions: ["create"], before: null, after: {} } },
    { address: "aws_s3_bucket_policy.logs", type: "aws_s3_bucket_policy", change: { actions: ["create"], before: null, after: {} } },
  ];
  const state = [...STATE, stateResource("aws_s3_bucket", "team", TEAM, "arn:aws:s3:::" + TEAM), ...settings.map(([type, name]) => stateResource(type, name, TEAM)),
    stateResource("aws_sqs_queue_policy", "preexisting", OLD_QUEUE), stateResource("aws_s3_bucket_policy", "logs", BUCKET)];
  const w = world();
  behave({ showResources: creates, stateResources: state });
  cloud({ existing: [...EXISTING, TEAM] });
  const run = await proposed(w);
  // The run's own bucket goes, and its versioning and policy go with it; nothing on the kept bucket or the kept queue is proposed.
  assert.deepEqual(run.proposal.deletes.map((d) => d.address), ["aws_cloudwatch_log_group.canary", "aws_s3_bucket.logs", "aws_s3_bucket_policy.logs", "aws_s3_bucket_versioning.logs"]);
  const kept = new Map(run.proposal.excluded.map((x) => [x.address, x]));
  assert.equal(kept.get("aws_s3_bucket.team")?.ownership, "NOT_IN_PLAN", "the bucket is the environment owner's");
  for (const address of [...settings.map(([type, name]) => type + "." + name), "aws_sqs_queue_policy.preexisting"]) {
    assert.equal(kept.get(address)?.ownership, "TYPE_UNREVIEWED", address);
    assert.equal(kept.get(address)?.retainedBy, "ENVIRONMENT_OWNER", address);
    assert.match(kept.get(address)!.reason, /an attachment or setting .* that modifies another resource, and this proposal does not delete that resource with it/, address);
    assert.ok(kept.get(address)!.reason.length <= 512);
  }
  assert.ok(verifyCleanupProposal(run.proposal).ok);
  // A forged, re-hashed proposal that lists the kept bucket's public access block never executes, and the honest cleanup never targets it.
  const approval = cleanupApproval(run.proposal, "alice");
  const address = "aws_s3_bucket_public_access_block.team";
  const fields = { ...run.proposal, deletes: [...run.proposal.deletes, { address, type: "aws_s3_bucket_public_access_block", identifier: kept.get(address)!.identifier, ownership: "RUN_CREATED" as const, observed: "UNVERIFIABLE" as const }].sort((a, b) => (a.address < b.address ? -1 : 1)), excluded: run.proposal.excluded.filter((x) => x.address !== address) };
  const forged = reHashedProposal(fields);
  behave({ showResources: creates, stateResources: state });
  refused(await cleanup(w, { ...run, proposal: forged }, [cleanupApproval(forged, "alice")]), "PROPOSAL_INVALID");
  assert.equal(applyCalls().length, 0);
  behave({ showResources: creates, stateResources: state });
  const done = await cleanup(w, run, [approval]);
  assert.ok(done.ok, JSON.stringify(done));
  assert.deepEqual(destroyPlans()[0]!.args.filter((a) => a.startsWith("-target=")).sort(), run.proposal.deletes.map((d) => "-target=" + d.address).sort());
  assert.ok(destroyPlans().every((c) => !c.args.join(" ").includes(".team") && !c.args.join(" ").includes("aws_sqs_queue_policy")), "nothing on a kept parent is targeted");
});
