import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { signApproval } from "../src/apply/approval.js";
import { MATERIAL_RISKS, PROTECTION_REASONS, buildCleanupProposal, isAwsIdentityType, protectedDeletionIn, signCleanupProposal, verifyCleanupProposal, type CleanupProposal } from "../src/apply/cleanup-proposal.js";
import { loadPilotContract, pilotContractSha256 } from "../src/apply/contract.js";
import { runApply, runCleanup, sealPreview, type ApplyDeps } from "../src/apply/driver.js";
import { loadRunRecords, observeRun, verifyProposalLeftovers } from "../src/apply/observe.js";
import { openNonceStore } from "../src/apply/nonces.js";
import { blueprintRecordProblems } from "../src/apply/run-records.js";
import { loadSealedPlan } from "../src/apply/seal.js";
import type { PilotContract, SignedApproval } from "../src/apply/types.js";
import { pilotUnitOf } from "../src/apply/unit.js";
import { blueprintFromTerraformStatePull } from "../src/observe/blueprint.js";
import { AWS_PRINCIPAL_TYPES, AWS_RUN_CREATED_POLICY_TYPES, AZURE_RUN_CREATED_POLICY_TYPES, azurePolicyProblem, policyLinkOf } from "../src/observe/run-created-policies.js";
import { removeTree } from "../src/teardown/driver/cleanup.js";
import {
  NOW, POLICY, SOURCE_COMMIT, approvalFor, awsContractJson, awsIdentityEnv, awsRoleArn, awsTargetOf, behave as behaveIn, behaveAwsReads, callsOf, human, installFakeAwsReads, installFakeTerraform,
  keys, stateResource, testFixtureForgeQualificationEvidence, writeReviewedContract, writeProject, REQUESTER, reHashedProposal, type Behavior, canaryFor, withCanary } from "./helpers/apply-fixtures.js";

// Run-created policies on AWS (owner decision "Unpin the ACT decision", item 2 (c), #39; src/observe/run-created-policies.ts): a
// customer-managed policy, an inline policy and an attachment the run created are deleted through the same proposal, approvals and
// cleanup as every other resource, and only when every principal they touch is one this run created; anything on a pre-existing
// principal, on a pilot identity, on an AWS-managed policy, or in a CloudFormation form is kept by the identity rule. The engine and
// the AWS CLI are fakes, so this is SYNTHETIC evidence: it pins the product's logic and never stands for a live account.

const root = mkdtempSync(join(tmpdir(), "alz-cleanup-pol-"));
const toolDir = mkdtempSync(join(tmpdir(), "alz-cleanup-pol-tf-"));
const awsToolDir = mkdtempSync(join(tmpdir(), "alz-cleanup-pol-aws-"));
process.env.AGENTIC_EVIDENCE_KEY = randomBytes(32).toString("base64");
process.chdir(root);
test.after(() => { removeTree(root); removeTree(toolDir); removeTree(awsToolDir); });
installFakeTerraform(toolDir);
installFakeAwsReads(awsToolDir);
let counter = 0;
const fresh = (label: string): string => { const dir = join(root, label + "-" + ++counter); mkdirSync(dir, { recursive: true }); return dir; };
const KILL = join(root, "KILL");

const ACCOUNT = "111111111111";
const APP_ROLE = "alz-app-role";
const APP_ROLE_ARN = "arn:aws:iam::" + ACCOUNT + ":role/" + APP_ROLE;
const PILOT_ROLE = awsRoleArn("APPLY", "DEV").split("/").pop()!;
const APP_POLICY = "arn:aws:iam::" + ACCOUNT + ":policy/alz-app-policy";
const SHARED_POLICY = "arn:aws:iam::" + ACCOUNT + ":policy/alz-shared-policy";
const PILOT_POLICY = "arn:aws:iam::" + ACCOUNT + ":policy/alz-pilot-extra";
const AWS_MANAGED = "arn:aws:iam::aws:policy/ReadOnlyAccess";
const LOG = "/alz/pilot/canary";
const LOG_ARN = "arn:aws:logs:us-east-1:" + ACCOUNT + ":log-group:" + LOG;

const create = (address: string) => ({ address, type: address.split(".")[0]!, change: { actions: ["create"], before: null, after: {} } });
/** A state resource with the attributes the policy link is read from. */
const iam = (type: string, name: string, id: string, attributes: Record<string, unknown>, arn?: string) => {
  const resource = stateResource(type, name, id, arn);
  return { ...resource, instances: [{ ...resource.instances[0]!, attributes: { ...resource.instances[0]!.attributes, ...attributes } }] };
};
const CREATES = [
  create("aws_cloudwatch_log_group.canary"),
  create("aws_iam_role.app"), create("aws_iam_policy.app"), create("aws_iam_role_policy_attachment.app"), create("aws_iam_role_policy.app_inline"),
  // Each of these is held: a run-created policy attached to a role the run did not create (and so the policy too), an inline policy on a
  // pre-existing user, an attachment to the pilot's own APPLY role (with the policy it attaches), and an AWS-managed policy's attachment.
  create("aws_iam_policy.shared"), create("aws_iam_role_policy_attachment.preexisting"), create("aws_iam_user_policy.old_user"),
  create("aws_iam_policy.pilot_extra"), create("aws_iam_role_policy_attachment.pilot"), create("aws_iam_role_policy_attachment.aws_managed"),
];
const STATE = [
  stateResource("aws_cloudwatch_log_group", "canary", LOG, LOG_ARN),
  stateResource("aws_iam_role", "app", APP_ROLE, APP_ROLE_ARN),
  iam("aws_iam_policy", "app", APP_POLICY, {}, APP_POLICY),
  iam("aws_iam_role_policy_attachment", "app", APP_ROLE + "-20261011120000000000000001", { role: APP_ROLE, policy_arn: APP_POLICY }),
  iam("aws_iam_role_policy", "app_inline", APP_ROLE + ":inline", { role: APP_ROLE, name: "inline" }),
  iam("aws_iam_policy", "shared", SHARED_POLICY, {}, SHARED_POLICY),
  iam("aws_iam_role_policy_attachment", "preexisting", "pre-existing-role-20261011120000000000000002", { role: "pre-existing-role", policy_arn: SHARED_POLICY }),
  iam("aws_iam_user_policy", "old_user", "pre-existing-user:inline", { user: "pre-existing-user", name: "inline" }),
  iam("aws_iam_policy", "pilot_extra", PILOT_POLICY, {}, PILOT_POLICY),
  iam("aws_iam_role_policy_attachment", "pilot", PILOT_ROLE + "-20261011120000000000000003", { role: PILOT_ROLE, policy_arn: PILOT_POLICY }),
  iam("aws_iam_role_policy_attachment", "aws_managed", APP_ROLE + "-20261011120000000000000004", { role: APP_ROLE, policy_arn: AWS_MANAGED }),
  stateResource("aws_iam_role", "apply", PILOT_ROLE, awsRoleArn("APPLY", "DEV")),
];
const EXISTING = [LOG, APP_ROLE, PILOT_ROLE];
const DELETED = ["aws_cloudwatch_log_group.canary", "aws_iam_policy.app", "aws_iam_role_policy.app_inline", "aws_iam_role_policy_attachment.app"];
const HELD = ["aws_iam_policy.pilot_extra", "aws_iam_policy.shared", "aws_iam_role.apply", "aws_iam_role.app", "aws_iam_role_policy_attachment.aws_managed",
  "aws_iam_role_policy_attachment.pilot", "aws_iam_role_policy_attachment.preexisting", "aws_iam_user_policy.old_user"];

/** Owner decision E1: the run's contract names, as its canary allowlist, exactly what the plan creates. */
const RUN_CONTRACT = withCanary(awsContractJson(KILL), canaryFor(CREATES));
const fixtureContractPath = (() => { const path = join(fresh("contract"), "act-pilot-contract.json"); writeReviewedContract(path, RUN_CONTRACT); return path; })();
const CONTRACT = loadPilotContract(fixtureContractPath) as PilotContract;
const UNIT = pilotUnitOf({ provider: "AWS", contractSha256: pilotContractSha256(CONTRACT), environment: "DEV", target: awsTargetOf("DEV") });
const behave = (behavior: Behavior = {}) => behaveIn(toolDir, KILL, {
  applyAdvance: true, showOnlyConfigured: true, showResources: CREATES, stateResources: STATE, unitTags: { ...UNIT.tags },
  showProviderConfig: { aws: { name: "aws", full_name: "registry.terraform.io/hashicorp/aws", expressions: { region: { references: ["var.region"] } } } }, ...behavior,
});
const cloud = (existing: string[] = EXISTING) => behaveAwsReads(awsToolDir, { existing, tagged: [LOG_ARN] });
const calls = () => callsOf(toolDir);
const applyCalls = () => calls().filter((c) => c.args[0] === "apply");
const destroyPlans = () => calls().filter((c) => c.args[0] === "plan" && c.args[1] === "-destroy");
const refused = (result: { ok: boolean }, code: string) => { assert.equal(result.ok, false, JSON.stringify(result)); assert.equal((result as { code: string }).code, code, JSON.stringify(result)); };

type World = { deps: ApplyDeps; dirs: { scratch: string; evidence: string; nonces: string }; contractPath: string };
let vaultDir = "";
test.before(async () => { vaultDir = fresh("qualification"); await testFixtureForgeQualificationEvidence(vaultDir, undefined, "AWS"); });
function world(): World {
  behave();
  cloud();
  const dirs = { scratch: fresh("scratch"), evidence: fresh("evidence"), nonces: fresh("nonces") };
  const contractPath = join(fresh("contract"), "act-pilot-contract.json");
  writeReviewedContract(contractPath, RUN_CONTRACT);
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
async function proposed(w: World, env: NodeJS.ProcessEnv = w.deps.env!) {
  const target = awsTargetOf("DEV");
  const p = writeProject(fresh("project"), target, 'resource "aws_iam_policy" "app" {}\n');
  const sealedResult = await sealPreview({ invocation: human(target), environment: "DEV", target, manifest: p.manifest, projectRoot: p.projectRoot, policyVersion: POLICY, resolved: p.resolved, requester: REQUESTER }, w.deps);
  assert.ok(sealedResult.ok, JSON.stringify(sealedResult));
  const loaded = await loadSealedPlan(sealedResult.path);
  assert.ok(loaded.ok);
  const s = { sealed: sealedResult.sealed, project: p, loaded: { sealed: loaded.sealed, planBytes: loaded.planBytes } };
  const applied = await runApply({ invocation: human(target), environment: "DEV", target: { ...target }, sealedPlan: s.loaded, manifest: p.manifest, projectRoot: p.projectRoot, approvals: [approvalFor(s.sealed, "alice")] }, w.deps);
  assert.ok(applied.ok, JSON.stringify(applied));
  const observation = await observeRun(s.sealed.artifactSha256, observeDeps(w));
  assert.ok(observation.ok, JSON.stringify(observation));
  const records = await loadRunRecords(s.sealed.artifactSha256, w.dirs.evidence);
  assert.ok(records.ok, JSON.stringify(records));
  const built = buildCleanupProposal({ requesterId: REQUESTER.requesterId, ...records, changes: s.sealed.changes, channel: "CLI", contract: { ...(JSON.parse(JSON.stringify(RUN_CONTRACT)) as object), enabled: true } as never,
    engineVersion: s.sealed.engineVersion, env, now: new Date(NOW.getTime() + 120_000) });
  assert.ok(built.ok, JSON.stringify(built));
  return { s, records, proposal: signCleanupProposal(built.proposal, REQUESTER.privateKeyPem) };
}
type Run = Awaited<ReturnType<typeof proposed>>;
const cleanupApproval = (proposal: CleanupProposal, who: keyof typeof keys): SignedApproval => signApproval({
  schemaVersion: 1, artifactSha256: proposal.proposalSha256, environment: proposal.environment, target: proposal.target, approverId: who,
  issuedAt: new Date(NOW.getTime() - 5 * 60_000).toISOString(), expiresAt: new Date(NOW.getTime() + 25 * 60_000).toISOString(), nonce: randomBytes(16).toString("hex"),
}, keys[who].priv, "CLEANUP");
const cleanup = (w: World, run: Run, proposal: CleanupProposal = run.proposal) => runCleanup({
  invocation: human(run.s.sealed.target), environment: "DEV", target: { ...run.s.sealed.target }, proposal, sealedPlan: run.s.loaded, manifest: run.s.project.manifest, projectRoot: run.s.project.projectRoot,
  approvals: [cleanupApproval(proposal, "alice")],
}, w.deps);
const row = (address: string, identifier: string | null) => ({ address, type: address.split(".")[0]!, identifier, ownership: "RUN_CREATED" as const, observed: "UNVERIFIABLE" as const });
const forge = (run: Run, address: string, identifier: string | null) => reHashedProposal({
  ...run.proposal, deletes: [...run.proposal.deletes, row(address, identifier)].sort((a, b) => (a.address < b.address ? -1 : 1)), excluded: run.proposal.excluded.filter((x) => x.address !== address),
});

// --- the table ---------------------------------------------------------------------------------------------

test("the run-created policy table is closed and reviewed: every AWS type is in the identity service (so the identity rule runs first), no principal type is on it, every type names a material risk, the CloudFormation forms carry no readable link and are always held, and the Azure list is exactly the policy definitions, set definitions and assignments", () => {
  const principals = Object.values(AWS_PRINCIPAL_TYPES).flat();
  for (const entry of AWS_RUN_CREATED_POLICY_TYPES) {
    assert.ok(isAwsIdentityType(entry.type), entry.type + " is an identity-service type, kept by the identity rule unless carved out");
    assert.ok(!principals.includes(entry.type), entry.type + " is not a principal");
    assert.ok(MATERIAL_RISKS[entry.type], entry.type + " names a material risk");
    assert.equal(entry.read === undefined, entry.type.startsWith("AWS::"), entry.type + ": only the CloudFormation forms have no link in the state");
  }
  assert.deepEqual(AWS_RUN_CREATED_POLICY_TYPES.map((x) => x.type).sort(), [
    "AWS::IAM::GroupPolicy", "AWS::IAM::ManagedPolicy", "AWS::IAM::Policy", "AWS::IAM::RolePolicy", "AWS::IAM::UserPolicy",
    "aws_iam_group_policy", "aws_iam_group_policy_attachment", "aws_iam_policy", "aws_iam_role_policy", "aws_iam_role_policy_attachment", "aws_iam_user_policy", "aws_iam_user_policy_attachment",
    "awscc_iam_group_policy", "awscc_iam_managed_policy", "awscc_iam_role_policy", "awscc_iam_user_policy"]);
  // Never on the list: principals, the exclusive attachments that manage every attachment of a policy, Identity Center, credentials.
  for (const type of [...principals, "aws_iam_policy_attachment", "aws_iam_role_policies_exclusive", "aws_iam_role_policy_attachments_exclusive", "aws_ssoadmin_managed_policy_attachment",
    "aws_iam_access_key", "aws_iam_instance_profile", "aws_organizations_policy"]) assert.ok(!AWS_RUN_CREATED_POLICY_TYPES.some((x) => x.type === type), type);
  assert.deepEqual(AZURE_RUN_CREATED_POLICY_TYPES.map((x) => x.type).sort(), ["azurerm_management_group_policy_assignment", "azurerm_policy_definition", "azurerm_policy_set_definition",
    "azurerm_resource_group_policy_assignment", "azurerm_resource_policy_assignment", "azurerm_subscription_policy_assignment"]);
  for (const entry of AZURE_RUN_CREATED_POLICY_TYPES) assert.ok(MATERIAL_RISKS[entry.type], entry.type + " names a material risk");
  assert.ok(PROTECTION_REASONS.PROTECTED_IDENTITY.length <= 512);
});

test("the policy link is read from the state for the reviewed types only, names and one ARN, and any link the cleanup cannot match exactly is not recorded (the identity rule then keeps the entry)", () => {
  assert.deepEqual(policyLinkOf("aws_iam_role_policy_attachment", { role: "r", policy_arn: APP_POLICY, secret: "x" }), { principals: [{ kind: "ROLE", name: "r" }], policyArn: APP_POLICY });
  assert.deepEqual(policyLinkOf("awscc_iam_managed_policy", { policy_arn: APP_POLICY, roles: ["a"], users: null, groups: ["g"] }), { principals: [{ kind: "ROLE", name: "a" }, { kind: "GROUP", name: "g" }], policyArn: APP_POLICY });
  assert.deepEqual(policyLinkOf("aws_iam_policy_attachment", { policy_arn: APP_POLICY, roles: ["a"] }), { principals: [{ kind: "ROLE", name: "a" }], policyArn: APP_POLICY }, "an exclusive attachment's link is recorded so its policy is held with it");
  for (const [type, values] of [["aws_iam_role_policy", { role: APP_ROLE_ARN }], ["aws_iam_role_policy", {}], ["aws_iam_user_policy", { user: "a/b" }], ["aws_iam_role_policy_attachment", { role: "r" }],
    ["aws_iam_role_policy_attachment", { role: "r", policy_arn: "not-an-arn" }], ["awscc_iam_managed_policy", { policy_arn: APP_POLICY, roles: "a" }], ["aws_iam_role", { name: "r" }], ["AWS::IAM::Policy", { Roles: ["r"] }],
    ["aws_s3_bucket", { role: "r" }]] as const) {
    assert.equal(policyLinkOf(type, values as Record<string, unknown>), undefined, type + " " + JSON.stringify(values));
  }
  // The blueprint carries it, and the run record accepts it on a policy type only, with nothing else in it.
  const pulled = blueprintFromTerraformStatePull(JSON.stringify({ version: 4, resources: [iam("aws_iam_role_policy_attachment", "app", "x-1", { role: APP_ROLE, policy_arn: APP_POLICY })] }), [{ address: "aws_iam_role_policy_attachment.app", type: "aws_iam_role_policy_attachment", action: "CREATE" }]);
  assert.deepEqual(pulled.entries[0]!.policyLink, { principals: [{ kind: "ROLE", name: APP_ROLE }], policyArn: APP_POLICY });
  assert.ok(!JSON.stringify(pulled).includes("secret_value") && !JSON.stringify(pulled).includes("CANARY"), "no other attribute reaches the blueprint");
  const record = (entry: Record<string, unknown>) => blueprintRecordProblems({ schemaVersion: 1, kind: "BLUEPRINT", artifactSha256: "a".repeat(64), applyEvidenceSha256: "b".repeat(64), environment: "DEV", target: awsTargetOf("DEV"),
    sourceCommit: SOURCE_COMMIT, contractSha256: "c".repeat(64), outcome: "SUCCEEDED", source: "TERRAFORM_STATE_PULL", readAt: NOW.toISOString(), unitId: null, blueprint: { entries: [entry], missing: [] } });
  const base = { address: "aws_iam_role_policy_attachment.app", type: "aws_iam_role_policy_attachment", arn: null, id: "x-1", origin: "IN_PLAN" };
  assert.deepEqual(record({ ...base, policyLink: { principals: [{ kind: "ROLE", name: APP_ROLE }], policyArn: APP_POLICY } }), []);
  assert.notDeepEqual(record({ ...base, type: "aws_s3_bucket", policyLink: { principals: [], policyArn: null } }), [], "a link on a type that has none is refused");
  assert.notDeepEqual(record({ ...base, policyLink: { principals: [{ kind: "ROLE", name: APP_ROLE }], policyArn: APP_POLICY, document: "{}" } }), [], "a link with anything more is refused");
  assert.notDeepEqual(record({ ...base, policyLink: { principals: [{ kind: "ROLE", name: APP_ROLE_ARN }], policyArn: APP_POLICY } }), [], "a principal that is not a plain name is refused");
});

// --- AWS end to end ----------------------------------------------------------------------------------------

test("AWS Terraform: a run-created customer-managed policy, its attachment and an inline policy on a run-created role are proposed and deleted under the cleanup's approvals; the role, a policy attached to a pre-existing role, an inline policy on a pre-existing user, an attachment to the pilot's APPLY role and an AWS-managed policy's attachment are kept by the identity rule; held and forged entries never execute", async () => {
  const w = world();
  const run = await proposed(w);
  assert.deepEqual(run.proposal.deletes.map((d) => d.address), DELETED);
  const kept = new Map(run.proposal.excluded.map((x) => [x.address, x]));
  for (const address of HELD) {
    assert.equal(kept.get(address)?.ownership, "PROTECTED_IDENTITY", address);
    assert.equal(kept.get(address)?.retainedBy, "PILOT_OWNER", address);
    assert.equal(kept.get(address)?.reason, PROTECTION_REASONS.PROTECTED_IDENTITY, address);
  }
  for (const type of ["aws_iam_policy", "aws_iam_role_policy", "aws_iam_role_policy_attachment"]) assert.ok(run.proposal.risks.includes(type + ": " + MATERIAL_RISKS[type]), type + " risk is named before approval");
  assert.ok(!run.proposal.risks.some((r) => r.startsWith("aws_iam_user_policy:")), "a held type's risk is not named");

  // The pilot's role variables decide nothing: without them the proposal is the same, because a pilot role is never one this run created.
  const bare = Object.fromEntries(Object.entries(w.deps.env!).filter(([key]) => !key.endsWith("_AWS_ROLE_ARN")));
  const w2 = world();
  const run2 = await proposed(w2, bare);
  assert.deepEqual([run2.proposal.deletes.map((d) => d.address), run2.proposal.excluded.map((x) => [x.address, x.ownership, x.reason])], [run.proposal.deletes.map((d) => d.address), run.proposal.excluded.map((x) => [x.address, x.ownership, x.reason])]);

  // A destroy plan that takes a held policy object along stops before any approval is consumed.
  for (const address of ["aws_iam_role_policy_attachment.preexisting", "aws_iam_role_policy_attachment.pilot", "aws_iam_policy.shared", "aws_iam_user_policy.old_user", "aws_iam_role.app"]) {
    behave({ destroyExtra: [{ address, type: address.split(".")[0]!, change: { actions: ["delete"], before: {}, after: null } }] });
    const taken = await cleanup(w, run);
    refused(taken, "PROPOSAL_SCOPE_MISMATCH");
    assert.match((taken as { message: string }).message, new RegExp("would delete " + address.replace(".", "\\.") + ", an identity or authorization object.*\\(PROTECTED_IDENTITY\\)"), address);
    assert.deepEqual([destroyPlans().length, applyCalls().length], [1, 0], address + ": planned, then stopped; no destroy was applied");
  }
  // A forged proposal that adds a held entry is not the one the run's records give, and never executes.
  behave();
  for (const [address, identifier] of [["aws_iam_role_policy_attachment.pilot", null], ["aws_iam_role_policy_attachment.preexisting", null], ["aws_iam_policy.shared", SHARED_POLICY], ["aws_iam_role.app", APP_ROLE]] as const) {
    const forged = forge(run, address, identifier);
    assert.ok(verifyCleanupProposal(forged).ok, address);
    refused(await cleanup(w, run, forged), "PROPOSAL_INVALID");
  }
  assert.deepEqual([destroyPlans().length, applyCalls().length], [0, 0], "a forged proposal is refused before the engine runs");

  // The honest cleanup runs once: exactly the listed addresses are targeted.
  behave();
  const done = await cleanup(w, run);
  assert.ok(done.ok, JSON.stringify(done));
  assert.deepEqual(destroyPlans().at(-1)!.args.filter((a) => a.startsWith("-target=")).sort(), DELETED.map((a) => "-target=" + a));
  // The leftover check never assumes a policy is gone: the reader has no Cloud Control mapping for IAM policies, so a person confirms them by hand.
  cloud([APP_ROLE, PILOT_ROLE]);
  const leftovers = await verifyProposalLeftovers(run.proposal, observeDeps(w, new Date(NOW.getTime() + 600_000)));
  assert.ok(leftovers.ok, JSON.stringify(leftovers));
  const disposition = new Map(leftovers.record.resources.map((r) => [r.address, r.disposition]));
  assert.equal(disposition.get("aws_cloudwatch_log_group.canary"), "CONFIRMED_DELETED");
  for (const address of ["aws_iam_policy.app", "aws_iam_role_policy.app_inline", "aws_iam_role_policy_attachment.app"]) assert.equal(disposition.get(address), "UNKNOWN", address);
  for (const address of HELD) assert.equal(disposition.get(address), "INTENTIONALLY_RETAINED", address);
  assert.notEqual(leftovers.record.disposition, "COMPLETE");
});

test("protectedDeletionIn keeps every policy object protected unless the verified proposal lists it and its entry still meets the carve-out: the pilot's own role, an unlisted address, a non-delete action, a CloudFormation form, an AWS-managed policy and an entry with no link are refused", () => {
  const env = awsIdentityEnv("DEV");
  const link = (role: string, policyArn: string | null = APP_POLICY) => ({ principals: [{ kind: "ROLE" as const, name: role }], policyArn });
  const entries = [
    { address: "aws_iam_role_policy_attachment.app", type: "aws_iam_role_policy_attachment", id: "x-1", arn: null, policyLink: link(APP_ROLE) },
    { address: "aws_iam_role_policy_attachment.pilot", type: "aws_iam_role_policy_attachment", id: "x-2", arn: null, policyLink: link(PILOT_ROLE) },
    { address: "aws_iam_policy.app", type: "aws_iam_policy", id: APP_POLICY, arn: APP_POLICY, policyLink: { principals: [], policyArn: APP_POLICY } },
    { address: "aws_iam_policy.managed", type: "aws_iam_policy", id: AWS_MANAGED, arn: AWS_MANAGED, policyLink: { principals: [], policyArn: AWS_MANAGED } },
    { address: "aws_iam_role_policy.nolink", type: "aws_iam_role_policy", id: APP_ROLE + ":x", arn: null },
    { address: "PolicyX", type: "AWS::IAM::ManagedPolicy", id: APP_POLICY, arn: null },
  ];
  const approved = { account: ACCOUNT, addresses: new Set(entries.map((e) => e.address)) };
  const del = (address: string, type: string, action = "DELETE") => [{ address, type, action }];
  assert.equal(protectedDeletionIn(del("aws_iam_role_policy_attachment.app", "aws_iam_role_policy_attachment"), entries, CONTRACT, env, approved), undefined);
  assert.equal(protectedDeletionIn(del("aws_iam_policy.app", "aws_iam_policy"), entries, CONTRACT, env, approved), undefined);
  for (const [label, planned, over] of [
    ["no approved list", del("aws_iam_policy.app", "aws_iam_policy"), undefined],
    ["the pilot's APPLY role", del("aws_iam_role_policy_attachment.pilot", "aws_iam_role_policy_attachment"), approved],
    ["an address the proposal does not list", del("aws_iam_policy.app", "aws_iam_policy"), { ...approved, addresses: new Set<string>() }],
    ["an update, not a delete", del("aws_iam_policy.app", "aws_iam_policy", "UPDATE"), approved],
    ["an AWS-managed policy", del("aws_iam_policy.managed", "aws_iam_policy"), approved],
    ["an entry with no readable link", del("aws_iam_role_policy.nolink", "aws_iam_role_policy"), approved],
    ["a CloudFormation form", del("PolicyX", "AWS::IAM::ManagedPolicy"), approved],
    ["a dependent the state does not hold", del("aws_iam_role_policy_attachment.appeared", "aws_iam_role_policy_attachment"), { ...approved, addresses: new Set(["aws_iam_role_policy_attachment.appeared"]) }],
  ] as const) {
    const refusal = protectedDeletionIn(planned as never, entries, CONTRACT, env, over as never);
    assert.ok(refusal?.includes("(PROTECTED_IDENTITY)"), label + ": " + refusal);
  }
  // The Azure rule: the target subscription's own scopes only.
  const sub = "00000000-0000-4000-8000-0000000000aa";
  const rg = "/subscriptions/" + sub + "/resourceGroups/rg";
  assert.equal(azurePolicyProblem("azurerm_policy_definition", "/subscriptions/" + sub + "/providers/Microsoft.Authorization/policyDefinitions/d", sub), undefined);
  assert.equal(azurePolicyProblem("azurerm_resource_group_policy_assignment", rg + "/providers/Microsoft.Authorization/policyAssignments/a", sub), undefined);
  assert.equal(azurePolicyProblem("azurerm_resource_policy_assignment", rg + "/providers/Microsoft.Storage/storageAccounts/s/providers/Microsoft.Authorization/policyAssignments/a", sub), undefined);
  for (const [type, id] of [
    ["azurerm_policy_definition", "/providers/Microsoft.Authorization/policyDefinitions/builtin"],
    ["azurerm_policy_definition", "/providers/Microsoft.Management/managementGroups/mg/providers/Microsoft.Authorization/policyDefinitions/d"],
    ["azurerm_policy_definition", "/subscriptions/00000000-0000-4000-8000-0000000000bb/providers/Microsoft.Authorization/policyDefinitions/d"],
    ["azurerm_policy_definition", rg + "/providers/Microsoft.Authorization/policyDefinitions/d"],
    ["azurerm_policy_definition", "/subscriptions/" + sub + "/providers/Microsoft.Authorization/roleDefinitions/d"],
    ["azurerm_management_group_policy_assignment", "/providers/Microsoft.Management/managementGroups/mg/providers/Microsoft.Authorization/policyAssignments/a"],
    ["azurerm_resource_policy_assignment", rg + "/providers/Microsoft.ManagedIdentity/userAssignedIdentities/u/providers/Microsoft.Authorization/policyAssignments/a"],
    ["azurerm_policy_exemption", rg + "/providers/Microsoft.Authorization/policyExemptions/e"],
    ["azurerm_role_assignment", rg + "/providers/Microsoft.Authorization/roleAssignments/r"],
    ["azurerm_subscription_policy_assignment", "/subscriptions/" + sub + "/providers/Microsoft.Authorization/policyAssignments/a/../x"],
  ] as const) assert.notEqual(azurePolicyProblem(type, id, sub), undefined, type + " " + id);
  assert.notEqual(azurePolicyProblem("azurerm_policy_definition", null, sub), undefined);
});
