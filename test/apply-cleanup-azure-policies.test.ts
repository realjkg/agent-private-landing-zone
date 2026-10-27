import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { signApproval } from "../src/apply/approval.js";
import { MATERIAL_RISKS, PROTECTION_REASONS, buildCleanupProposal, signCleanupProposal, verifyCleanupProposal, type CleanupProposal } from "../src/apply/cleanup-proposal.js";
import { loadPilotContract, pilotContractSha256 } from "../src/apply/contract.js";
import { runApply, runCleanup, sealPreview, type ApplyDeps } from "../src/apply/driver.js";
import { loadRunRecords, observeRun, verifyProposalLeftovers, type ObserveDeps } from "../src/apply/observe.js";
import { openNonceStore } from "../src/apply/nonces.js";
import { loadSealedPlan } from "../src/apply/seal.js";
import type { PilotContract, SignedApproval } from "../src/apply/types.js";
import { pilotUnitOf } from "../src/apply/unit.js";
import { removeTree } from "../src/teardown/driver/cleanup.js";
import {
  ARM_FEDERATED_TOKEN_CANARY, DEV_TARGET, NOW, POLICY, SOURCE_COMMIT, approvalFor, azureStateResource, behave as behaveIn, callsOf, contractJson, fakeArmHttp, human, identityEnv,
  installFakeTerraform, keys, targetOf, testFixtureForgeQualificationEvidence, writeReviewedContract, writeProject, REQUESTER, reHashedProposal, type ArmBehavior, type Behavior,
} from "./helpers/apply-fixtures.js";

// Azure Terraform DEV removal, end to end with the fake engine and the fake Resource Manager (owner decision "Unpin the ACT decision",
// item 2 (a) and (c), #39): the run's ordinary resources and its policy definitions, set definitions and assignments at the target
// subscription's own scopes are deleted under one proposal and its approvals; the resource group, the backend, role assignments,
// exemptions, an assignment at a management group, a definition in another subscription and a pre-existing assignment are kept.
// SYNTHETIC evidence: it pins the product's logic and never stands for a live subscription.

const root = mkdtempSync(join(tmpdir(), "alz-cleanup-az-pol-"));
const toolDir = mkdtempSync(join(tmpdir(), "alz-cleanup-az-pol-tf-"));
process.env.AGENTIC_EVIDENCE_KEY = randomBytes(32).toString("base64");
test.after(() => { removeTree(root); removeTree(toolDir); });
installFakeTerraform(toolDir);
let counter = 0;
const fresh = (label: string): string => { const path = join(root, label + "-" + (counter += 1)); mkdirSync(path, { recursive: true, mode: 0o700 }); return path; };
const KILL = join(root, "KILL");
const SUB = DEV_TARGET.account;
const SUB_ID = "/subscriptions/" + SUB;
const AUTH = "/providers/Microsoft.Authorization/";
const RG = SUB_ID + "/resourceGroups/alz-pilot-rg";
const LAW = RG + "/providers/Microsoft.OperationalInsights/workspaces/alz-pilot-law";
const DEF = SUB_ID + AUTH + "policyDefinitions/alz-pilot-def";
const SET = SUB_ID + AUTH + "policySetDefinitions/alz-pilot-set";
const RG_ASSIGN = RG + AUTH + "policyAssignments/alz-pilot-rg-assign";
const SUB_ASSIGN = SUB_ID + AUTH + "policyAssignments/alz-pilot-sub-assign";
const RES_ASSIGN = LAW + AUTH + "policyAssignments/alz-pilot-res-assign";
const MG_ASSIGN = "/providers/Microsoft.Management/managementGroups/mg-platform" + AUTH + "policyAssignments/alz-pilot-mg-assign";
const OTHER_DEF = "/subscriptions/00000000-0000-4000-8000-00000000beef" + AUTH + "policyDefinitions/alz-other-def";
const SHARED_ASSIGN = SUB_ID + AUTH + "policyAssignments/alz-shared-policy";
const EXEMPTION = RG + AUTH + "policyExemptions/alz-pilot-exemption";
const ROLE = RG + AUTH + "roleAssignments/11111111-aaaa-4aaa-8aaa-111111111111";
const change = (address: string, actions: string[] = ["create"]) => ({ address, type: address.split(".")[0]!, change: { actions, before: actions[0] === "create" ? null : {}, after: { tags: {} } } });
const CREATES = [
  change("azurerm_resource_group.pilot"), change("azurerm_log_analytics_workspace.pilot"),
  change("azurerm_policy_definition.pilot"), change("azurerm_policy_set_definition.pilot"), change("azurerm_resource_group_policy_assignment.pilot"),
  change("azurerm_subscription_policy_assignment.pilot"), change("azurerm_resource_policy_assignment.pilot"),
  change("azurerm_management_group_policy_assignment.mg"), change("azurerm_policy_definition.other"), change("azurerm_resource_group_policy_exemption.pilot"), change("azurerm_role_assignment.pilot"),
  change("azurerm_subscription_policy_assignment.shared", ["update"]),
];
const STATE = [
  azureStateResource("azurerm_resource_group", "pilot", RG), azureStateResource("azurerm_log_analytics_workspace", "pilot", LAW),
  azureStateResource("azurerm_policy_definition", "pilot", DEF), azureStateResource("azurerm_policy_set_definition", "pilot", SET), azureStateResource("azurerm_resource_group_policy_assignment", "pilot", RG_ASSIGN),
  azureStateResource("azurerm_subscription_policy_assignment", "pilot", SUB_ASSIGN), azureStateResource("azurerm_resource_policy_assignment", "pilot", RES_ASSIGN),
  azureStateResource("azurerm_management_group_policy_assignment", "mg", MG_ASSIGN), azureStateResource("azurerm_policy_definition", "other", OTHER_DEF),
  azureStateResource("azurerm_resource_group_policy_exemption", "pilot", EXEMPTION), azureStateResource("azurerm_role_assignment", "pilot", ROLE),
  azureStateResource("azurerm_subscription_policy_assignment", "shared", SHARED_ASSIGN),
];
const KEPT = [RG, MG_ASSIGN, OTHER_DEF, EXEMPTION, ROLE, SHARED_ASSIGN];
const EXISTING = [LAW, DEF, SET, RG_ASSIGN, SUB_ASSIGN, RES_ASSIGN, ...KEPT];
const DELETED = ["azurerm_log_analytics_workspace.pilot", "azurerm_policy_definition.pilot", "azurerm_policy_set_definition.pilot", "azurerm_resource_group_policy_assignment.pilot",
  "azurerm_resource_policy_assignment.pilot", "azurerm_subscription_policy_assignment.pilot"];
const PROTECTED = ["azurerm_management_group_policy_assignment.mg", "azurerm_policy_definition.other", "azurerm_resource_group_policy_exemption.pilot", "azurerm_role_assignment.pilot", "azurerm_subscription_policy_assignment.shared"];

const fixtureContractPath = (() => { const path = join(fresh("contract"), "act-pilot-contract.json"); writeReviewedContract(path, contractJson(KILL)); return path; })();
const UNIT = pilotUnitOf({ provider: "AZURE", contractSha256: pilotContractSha256(loadPilotContract(fixtureContractPath) as PilotContract), environment: "DEV", target: targetOf("DEV") });
const behave = (behavior: Behavior = {}) => behaveIn(toolDir, KILL, { applyAdvance: true, showOnlyConfigured: true, showResources: CREATES, stateResources: STATE, unitTags: { ...UNIT.tags }, unitTagAttribute: "tags", ...behavior });
const calls = () => callsOf(toolDir);
const applyCalls = () => calls().filter((c) => c.args[0] === "apply");
const destroyPlans = () => calls().filter((c) => c.args[0] === "plan" && c.args[1] === "-destroy");
const refused = (result: { ok: boolean }, code: string) => { assert.equal(result.ok, false, JSON.stringify(result).slice(0, 400)); assert.equal((result as { code?: string }).code, code, JSON.stringify(result).slice(0, 400)); };
const tokenFile = join(fresh("token"), "discovery-oidc-token");
writeFileSync(tokenFile, ARM_FEDERATED_TOKEN_CANARY + "\n", { mode: 0o600 });

type World = { deps: ApplyDeps; dirs: { scratch: string; evidence: string; nonces: string }; contractPath: string; arm: ReturnType<typeof fakeArmHttp> };
let vaultDir = "";
test.before(async () => { vaultDir = fresh("qualification"); await testFixtureForgeQualificationEvidence(vaultDir); });
function world(cloud: ArmBehavior = { existing: EXISTING, tagged: [RG, LAW] }): World {
  behave();
  const dirs = { scratch: fresh("scratch"), evidence: fresh("evidence"), nonces: fresh("nonces") };
  const contractPath = join(fresh("contract"), "act-pilot-contract.json");
  writeReviewedContract(contractPath, contractJson(KILL));
  const arm = fakeArmHttp(cloud);
  return {
    dirs, contractPath, arm,
    deps: {
      sourceCommit: SOURCE_COMMIT, contractPath, qualificationDir: vaultDir, evidenceDir: dirs.evidence, nonces: openNonceStore(dirs.nonces),
      env: { ...identityEnv("DEV"), ALZ_DISCOVERY_ARM_OIDC_TOKEN_FILE: tokenFile }, now: () => NOW, scratchParent: dirs.scratch, toolDirs: [toolDir], killPollMs: 40, killGraceMs: 400, arm: arm.http,
    },
  };
}
const observeDeps = (w: World, now: Date = new Date(NOW.getTime() + 60_000)): ObserveDeps => ({
  contractPath: w.contractPath, evidenceDir: w.dirs.evidence, env: w.deps.env, toolDirs: w.deps.toolDirs, scratchParent: w.dirs.scratch, now: () => now, arm: w.arm.http,
});
async function proposed(w: World) {
  const target = targetOf("DEV");
  const p = writeProject(fresh("project"), target);
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
  const built = buildCleanupProposal({ requesterId: REQUESTER.requesterId, ...records, changes: s.sealed.changes, channel: "CLI", contract: contractJson(KILL) as never, engineVersion: s.sealed.engineVersion, env: w.deps.env!, now: new Date(NOW.getTime() + 120_000) });
  assert.ok(built.ok, JSON.stringify(built));
  return { s, proposal: signCleanupProposal(built.proposal, REQUESTER.privateKeyPem) };
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

test("Azure Terraform DEV cleanup end to end: the run's resources and its policy definitions, set definitions and assignments at the target subscription's scopes are deleted under the cleanup's approvals; the group, grants, exemptions, a management-group assignment, another subscription's definition and a pre-existing assignment are kept, and nothing protected is ever executed", async () => {
  const w = world();
  const run = await proposed(w);
  assert.deepEqual(run.proposal.deletes.map((d) => d.address), DELETED);
  assert.ok(run.proposal.deletes.every((d) => d.observed === "VERIFIED"), "the reader checked each one under DISCOVERY");
  const kept = new Map(run.proposal.excluded.map((x) => [x.address, x]));
  for (const address of PROTECTED) assert.deepEqual([kept.get(address)?.ownership, kept.get(address)?.retainedBy, kept.get(address)?.reason], ["PROTECTED_IDENTITY", "PILOT_OWNER", PROTECTION_REASONS.PROTECTED_IDENTITY], address);
  assert.equal(kept.get("azurerm_resource_group.pilot")?.ownership, "RETAINED_GROUP");
  for (const type of ["azurerm_policy_definition", "azurerm_policy_set_definition", "azurerm_resource_group_policy_assignment", "azurerm_subscription_policy_assignment"]) {
    assert.ok(run.proposal.risks.includes(type + ": " + MATERIAL_RISKS[type]), type + " names its risk before approval");
  }

  // A destroy plan that would take a protected policy object along stops before any approval is consumed.
  for (const address of PROTECTED) {
    behave({ destroyExtra: [{ address, type: address.split(".")[0]!, change: { actions: ["delete"], before: {}, after: null } }] });
    const taken = await cleanup(w, run);
    refused(taken, "PROPOSAL_SCOPE_MISMATCH");
    assert.match((taken as { message: string }).message, /an identity or authorization object.*\(PROTECTED_IDENTITY\)/, address);
    assert.deepEqual([destroyPlans().length, applyCalls().length], [1, 0], address);
  }
  // A forged proposal that adds one never executes.
  behave();
  for (const [address, id] of [["azurerm_management_group_policy_assignment.mg", MG_ASSIGN], ["azurerm_policy_definition.other", OTHER_DEF], ["azurerm_subscription_policy_assignment.shared", SHARED_ASSIGN]] as const) {
    const forged = reHashedProposal({ ...run.proposal, deletes: [...run.proposal.deletes, { address, type: address.split(".")[0]!, identifier: id, ownership: "RUN_CREATED" as const, observed: "VERIFIED" as const }]
      .sort((a, b) => (a.address < b.address ? -1 : 1)), excluded: run.proposal.excluded.filter((x) => x.address !== address) });
    assert.ok(verifyCleanupProposal(forged).ok);
    refused(await cleanup(w, run, forged), "PROPOSAL_INVALID");
  }
  assert.deepEqual([destroyPlans().length, applyCalls().length], [0, 0]);

  // The honest cleanup runs once and targets exactly the list; the leftover check confirms every listed object gone and the kept ones retained.
  behave();
  const done = await cleanup(w, run);
  assert.ok(done.ok, JSON.stringify(done));
  assert.deepEqual(destroyPlans().at(-1)!.args.filter((a) => a.startsWith("-target=")).sort(), DELETED.map((a) => "-target=" + a));
  w.arm.behave({ existing: KEPT, tagged: [RG] });
  const leftovers = await verifyProposalLeftovers(run.proposal, observeDeps(w, new Date(NOW.getTime() + 600_000)));
  assert.ok(leftovers.ok, JSON.stringify(leftovers));
  const disposition = new Map(leftovers.record.resources.map((r) => [r.address, r.disposition]));
  for (const address of DELETED) assert.equal(disposition.get(address), "CONFIRMED_DELETED", address);
  for (const address of [...PROTECTED, "azurerm_resource_group.pilot"]) assert.equal(disposition.get(address), "INTENTIONALLY_RETAINED", address);
  assert.equal(leftovers.record.disposition, "COMPLETE");
});
