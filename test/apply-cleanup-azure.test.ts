import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { consumeApprovals, signApproval } from "../src/apply/approval.js";
import { buildCleanupProposal, protectedDeletionIn, signCleanupProposal, verifyCleanupProposal, type CleanupProposal } from "../src/apply/cleanup-proposal.js";
import { CLEANUP_SUFFIX, authorizeContract, loadPilotContract, pilotContractSha256, pilotTargetSha256, targetMoved } from "../src/apply/contract.js";
import { cleanupScopeProblem, runApply, runCleanup, sealPreview, type ApplyDeps, type ApplyRequest } from "../src/apply/driver.js";
import { readCleanupEvidence } from "../src/apply/ledger.js";
import { loadRunRecords, observeRun, verifyProposalLeftovers, type ObserveDeps } from "../src/apply/observe.js";
import { openNonceStore } from "../src/apply/nonces.js";
import { loadSealedPlan } from "../src/apply/seal.js";
import { BLUEPRINT_SUFFIX, OBSERVATION_SUFFIX, readBlueprintRecord, readObservationRecord } from "../src/apply/run-records.js";
import type { PilotContract, SignedApproval } from "../src/apply/types.js";
import { pilotUnitOf } from "../src/apply/unit.js";
import { armPathSafe, armTypeOf, armTypePairsOf, createDiscoveryArmReader, sameListing, type ArmHttp, type ArmRequest } from "../src/observe/azure-rest.js";
import { encryptEvidence, ensureEvidenceKey, readEncryptedEvidence } from "../src/evidence/vault.js";
import { removeTree } from "../src/teardown/driver/cleanup.js";
import { canonicalJson } from "../src/teardown/manifest.js";
import { sha256 } from "../src/util/sha256.js";
import {
  ARM_ACCESS_TOKEN_CANARY, ARM_FEDERATED_TOKEN_CANARY, CANARIES, DEV_TARGET, NOW, POLICY, SOURCE_COMMIT, STATE_CANARY, approvalFor, azureStateResource, behave as behaveIn, callsOf, contractJson,
  fakeArmHttp, human, identityEnv, installFakeTerraform, keys, targetOf, testFixtureForgeQualificationEvidence, writeReviewedContract, writeProject, type ArmBehavior, type Behavior,
  REQUESTER, reHashedProposal,
} from "./helpers/apply-fixtures.js";

// The Azure Terraform observe and cleanup steps (docs/observe-and-cleanup.md; docs/act-pilot-plan.md "Cleanup of pilot-created
// resources"): the same records, proposal, approvals and cleanup as AWS, read through Azure Resource Manager in process as the
// DISCOVERY identity. The engine and the ARM client are fakes, so this is SYNTHETIC evidence: it pins the product's logic and
// never stands for a live subscription. The one thing it proves about credentials is negative: the federated token and the
// access token never appear anywhere a person or a record could read them.

const root = mkdtempSync(join(tmpdir(), "alz-cleanup-az-"));
const toolDir = mkdtempSync(join(tmpdir(), "alz-cleanup-az-tf-"));
test.after(() => { removeTree(root); removeTree(toolDir); });
installFakeTerraform(toolDir);
let counter = 0;
const fresh = (label: string): string => { const path = join(root, label + "-" + (counter += 1)); mkdirSync(path, { recursive: true, mode: 0o700 }); return path; };
const KILL = join(root, "KILL");
const SUB = DEV_TARGET.account;
const STATE_ACCOUNT_NAME = DEV_TARGET.backend.split("/")[0];
/** The group this run creates, and the one thing it creates inside it. */
const RG = "/subscriptions/" + SUB + "/resourceGroups/alz-pilot-rg";
const LAW = RG + "/providers/Microsoft.OperationalInsights/workspaces/alz-pilot-law";
/** The pre-existing group that holds the state backend: never deleted, nor is anything named after the backend account. */
const RG_STATE = "/subscriptions/" + SUB + "/resourceGroups/alz-state-rg";
const STATE_ACCOUNT = RG_STATE + "/providers/Microsoft.Storage/storageAccounts/" + STATE_ACCOUNT_NAME;
/** The state container by its provider v3-style id: a data-plane URL, not an ARM id. */
const STATE_CONTAINER = "https://" + STATE_ACCOUNT_NAME + ".blob.core.windows.net/" + DEV_TARGET.backend.split("/")[1];
const OLD_ROLE = "/subscriptions/" + SUB + "/providers/Microsoft.Authorization/roleAssignments/11111111-aaaa-4aaa-8aaa-111111111111";
const POLICY_ASSIGNMENT = "/subscriptions/" + SUB + "/providers/Microsoft.Authorization/policyAssignments/alz-shared-policy";
const REUSED_VAULT = RG_STATE + "/providers/Microsoft.KeyVault/vaults/alz-reused-kv";
const UNRELATED_VNET = RG_STATE + "/providers/Microsoft.Network/virtualNetworks/alz-unrelated-vnet";
const APP = "/applications/00000000-0000-4000-8000-000000000001";
const SECRET = "https://alz-pilot-kv.vault.azure.net/secrets/canary/0123456789abcdef";
const change = (address: string, type: string, actions: string[], extra: Record<string, unknown> = {}) => ({ address, type, change: { actions, before: actions[0] === "create" ? null : {}, after: { tags: {} }, ...extra } });
const CREATES = [
  { address: "azurerm_resource_group.pilot", type: "azurerm_resource_group", change: { actions: ["create"], before: null, after: { tags: { team: "CANARY_TEAM_TAG" } } } },
  change("azurerm_log_analytics_workspace.pilot", "azurerm_log_analytics_workspace", ["create"]),
  { address: "azurerm_key_vault_secret.canary", type: "azurerm_key_vault_secret", change: { actions: ["create"], before: null, after: { value: "CANARY_SECRET_VALUE" } } },
  // Created by this run and still never proposed: the state container of the backend the pilot itself runs on.
  change("azurerm_storage_container.state", "azurerm_storage_container", ["create"]),
  // Pre-existing (the plan updates them), shared, or imported: not this run's to delete.
  change("azurerm_storage_account.state", "azurerm_storage_account", ["update"]),
  change("azurerm_resource_group.state", "azurerm_resource_group", ["update"]),
  change("azurerm_subscription_policy_assignment.shared", "azurerm_subscription_policy_assignment", ["update"]),
  change("azurerm_key_vault.reused", "azurerm_key_vault", ["no-op"], { importing: { id: REUSED_VAULT } }),
];
const STATE = [
  azureStateResource("azurerm_resource_group", "pilot", RG), azureStateResource("azurerm_log_analytics_workspace", "pilot", LAW), azureStateResource("azurerm_key_vault_secret", "canary", SECRET),
  azureStateResource("azurerm_storage_container", "state", STATE_CONTAINER), azureStateResource("azurerm_storage_account", "state", STATE_ACCOUNT), azureStateResource("azurerm_resource_group", "state", RG_STATE),
  azureStateResource("azurerm_subscription_policy_assignment", "shared", POLICY_ASSIGNMENT), azureStateResource("azurerm_key_vault", "reused", REUSED_VAULT),
  // In the state and not in the plan at all.
  azureStateResource("azuread_application", "pilot", APP), azureStateResource("azurerm_role_assignment", "old", OLD_ROLE), azureStateResource("azurerm_virtual_network", "unrelated", UNRELATED_VNET),
];
const EXISTING = [RG, LAW, RG_STATE, STATE_ACCOUNT, OLD_ROLE, POLICY_ASSIGNMENT, REUSED_VAULT, UNRELATED_VNET];
/** What the fake tag listing returns for this unit: the two things the plan created and tagged, and nothing else. */
const TAGGED = [RG, LAW];
const CLOUD: ArmBehavior = { existing: EXISTING, tagged: TAGGED };
/** What stays after a cleanup: everything the proposal keeps, the run's own resource group among them (a pilot cleanup never deletes a group). */
const RETAINED = [RG, STATE_ACCOUNT, RG_STATE, OLD_ROLE, POLICY_ASSIGNMENT, REUSED_VAULT, UNRELATED_VNET];
const fixtureContractPath = (() => { const path = join(fresh("contract"), "act-pilot-contract.json"); writeReviewedContract(path, contractJson(KILL)); return path; })();
const UNIT = pilotUnitOf({ provider: "AZURE", contractSha256: pilotContractSha256(loadPilotContract(fixtureContractPath) as PilotContract), environment: "DEV", target: targetOf("DEV") });
const behave = (behavior: Behavior = {}) => behaveIn(toolDir, KILL, { applyAdvance: true, showOnlyConfigured: true, showResources: CREATES, stateResources: STATE, unitTags: { ...UNIT.tags }, unitTagAttribute: "tags", ...behavior });
const calls = () => callsOf(toolDir);
const applyCalls = () => calls().filter((c) => c.args[0] === "apply");
const destroyPlans = () => calls().filter((c) => c.args[0] === "plan" && c.args[1] === "-destroy");
const refused = (result: { ok: boolean }, code: string) => { assert.equal(result.ok, false, JSON.stringify(result).slice(0, 300)); assert.equal((result as { code?: string }).code, code, JSON.stringify(result).slice(0, 300)); };

/** The DISCOVERY identity's federated token lives in a file the reader reads; the canary value must never be seen again. */
const tokenFile = join(fresh("token"), "discovery-oidc-token");
writeFileSync(tokenFile, ARM_FEDERATED_TOKEN_CANARY + "\n", { mode: 0o600 });
const env = (): NodeJS.ProcessEnv => ({ ...identityEnv("DEV"), ALZ_DISCOVERY_ARM_OIDC_TOKEN_FILE: tokenFile });

type World = { deps: ApplyDeps; dirs: { scratch: string; evidence: string; nonces: string }; contractPath: string; arm: ReturnType<typeof fakeArmHttp> };
let vaultDir = "";
test.before(async () => {
  vaultDir = fresh("qualification");
  await testFixtureForgeQualificationEvidence(vaultDir);
});
function world(cloudBehavior: ArmBehavior = CLOUD): World {
  behave();
  const dirs = { scratch: fresh("scratch"), evidence: fresh("evidence"), nonces: fresh("nonces") };
  const contractPath = join(fresh("contract"), "act-pilot-contract.json");
  writeReviewedContract(contractPath, contractJson(KILL));
  const arm = fakeArmHttp(cloudBehavior);
  return {
    dirs, contractPath, arm,
    deps: {
      sourceCommit: SOURCE_COMMIT, contractPath, qualificationDir: vaultDir, evidenceDir: dirs.evidence, nonces: openNonceStore(dirs.nonces),
      env: env(), now: () => NOW, scratchParent: dirs.scratch, toolDirs: [toolDir], killPollMs: 40, killGraceMs: 400, arm: arm.http,
    },
  };
}
const observeDeps = (w: World, now: Date = new Date(NOW.getTime() + 60_000)): ObserveDeps => ({
  contractPath: w.contractPath, evidenceDir: w.dirs.evidence, env: w.deps.env, toolDirs: w.deps.toolDirs, scratchParent: w.dirs.scratch, now: () => now, arm: w.arm.http,
});
const cloud = (w: World, behavior: ArmBehavior) => w.arm.behave(behavior);

async function seal(w: World) {
  const target = targetOf("DEV");
  const p = writeProject(fresh("project"), target);
  const result = await sealPreview({ invocation: human(target), environment: "DEV", target, manifest: p.manifest, projectRoot: p.projectRoot, policyVersion: POLICY, resolved: p.resolved, requester: REQUESTER }, w.deps);
  assert.ok(result.ok, JSON.stringify(result));
  const loaded = await loadSealedPlan(result.path);
  assert.ok(loaded.ok);
  return { sealed: result.sealed, project: p, loaded: { sealed: loaded.sealed, planBytes: loaded.planBytes } };
}
type Sealed = Awaited<ReturnType<typeof seal>>;
const apply = (w: World, s: Sealed, approvals: SignedApproval[] = [approvalFor(s.sealed, "alice")], over: Partial<ApplyRequest> = {}) => runApply({
  invocation: human(s.sealed.target), environment: s.sealed.environment, target: { ...s.sealed.target }, sealedPlan: s.loaded, manifest: s.project.manifest, projectRoot: s.project.projectRoot, approvals, ...over,
}, w.deps);
async function applied(w: World) {
  const s = await seal(w);
  const result = await apply(w, s);
  assert.ok(result.ok, JSON.stringify(result));
  return { s, evidence: result.evidence };
}
const build = (w: World, s: Sealed, records: Awaited<ReturnType<typeof loadRunRecords>> & { ok: true }) => buildCleanupProposal({ requesterId: REQUESTER.requesterId,
  ...records, changes: s.sealed.changes, channel: "CLI", contract: contractJson(KILL) as never, engineVersion: s.sealed.engineVersion, env: w.deps.env!, now: new Date(NOW.getTime() + 120_000),
});
async function proposed(w: World) {
  const run = await applied(w);
  const observation = await observeRun(run.s.sealed.artifactSha256, observeDeps(w));
  assert.ok(observation.ok, JSON.stringify(observation));
  const records = await loadRunRecords(run.s.sealed.artifactSha256, w.dirs.evidence);
  assert.ok(records.ok, JSON.stringify(records));
  const built = build(w, run.s, records);
  assert.ok(built.ok, JSON.stringify(built));
  return { ...run, observation, records, proposal: signCleanupProposal(built.proposal, REQUESTER.privateKeyPem) };
}
const cleanupApproval = (proposal: CleanupProposal, who: keyof typeof keys): SignedApproval => signApproval({
  schemaVersion: 1, artifactSha256: proposal.proposalSha256, environment: proposal.environment, target: proposal.target, approverId: who,
  issuedAt: new Date(NOW.getTime() - 5 * 60_000).toISOString(), expiresAt: new Date(NOW.getTime() + 25 * 60_000).toISOString(), nonce: randomBytes(16).toString("hex"),
}, keys[who].priv, "CLEANUP");
const cleanup = (w: World, run: Awaited<ReturnType<typeof proposed>>, approvals: SignedApproval[] = [cleanupApproval(run.proposal, "alice")], proposal: CleanupProposal = run.proposal) => runCleanup({
  invocation: human(run.s.sealed.target), environment: "DEV", target: { ...run.s.sealed.target }, proposal, sealedPlan: run.s.loaded, manifest: run.s.project.manifest, projectRoot: run.s.project.projectRoot, approvals,
}, w.deps);

/**
 * Review of #327, B2. This release admits neither azapi nor azuread (`PROVIDER_NOT_ADMITTED`), so their objects reach the cleanup
 * as STATE DATA only (the classifier's input: `stateResources`), never as a sealed create: `admitted` drops them from what the seal
 * plans. The classifier reads protection before plan membership, so they are kept by the same rule. A destroy plan that names one is
 * refused by the plan judge first, with nothing destroyed and no approval consumed; for such an address the policy check's own
 * refusal is asserted on `protectedDeletionIn`, the function the driver runs next, with this run's blueprint and the driver's words.
 */
const notAdmitted = (type: string): boolean => /^(azapi|azuread)_/.test(type);
const admitted = <T extends { type?: string }>(items: readonly T[]): T[] => items.filter((item) => !notAdmitted(item.type ?? ""));
async function destroyPlanRefused(w: World, run: Awaited<ReturnType<typeof proposed>>, approvals: SignedApproval[], show: { type?: string }[], state: unknown[], address: string, type: string, pattern: RegExp): Promise<{ ok: boolean }> {
  behave({ showResources: admitted(show), stateResources: state, destroyExtra: [{ address, type, change: { actions: ["delete"], before: {}, after: null } }] });
  const taken = await cleanup(w, run, approvals);
  if (!notAdmitted(type)) {
    refused(taken, "PROPOSAL_SCOPE_MISMATCH");
    assert.match((taken as { message: string }).message, pattern, address);
    return taken;
  }
  assert.equal(taken.ok, false, address);
  assert.match((taken as { message: string }).message, /PROVIDER_NOT_ADMITTED/, address + ": the plan judge refuses the destroy plan first");
  const policy = protectedDeletionIn([{ address, type, action: "DELETE" }], run.records.blueprint.blueprint.entries, loadPilotContract(fixtureContractPath) as PilotContract, w.deps.env!,
    { account: run.proposal.target.account, addresses: new Set(run.proposal.deletes.map((d) => d.address)) });
  assert.ok(policy, address + ": the policy check refuses it too");
  assert.match(policy + " Nothing was destroyed and no approval was consumed.", pattern, address + ": in the driver's words");
  return taken;
}

/** Every place a token could leak into: the recorded requests' URLs and headers other than the bearer, the records, the result. */
function noTokenIn(w: World, ...texts: unknown[]): void {
  for (const call of w.arm.calls) {
    assert.ok(!call.url.includes(ARM_FEDERATED_TOKEN_CANARY) && !call.url.includes(ARM_ACCESS_TOKEN_CANARY), "a token reached a URL");
    if (call.method === "GET") assert.equal(call.body, undefined);
  }
  for (const text of texts.map((t) => JSON.stringify(t))) {
    assert.ok(!text.includes(ARM_FEDERATED_TOKEN_CANARY) && !text.includes(ARM_ACCESS_TOKEN_CANARY), "a token reached a record or a result");
    for (const canary of [...CANARIES, STATE_CANARY, "CANARY_CLOUD_PROPERTY_c5", "CANARY_TEAM_TAG", "CANARY_SECRET_VALUE"]) assert.ok(!text.includes(canary), "a value reached a record: " + canary);
  }
}
const hosts = (w: World) => [...new Set(w.arm.calls.map((c) => new URL(c.url).host))].sort();
const methods = (w: World) => [...new Set(w.arm.calls.map((c) => c.method))].sort();
const sorted = <T>(rows: T[]): T[] => [...rows].sort((a, b) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1));

// --- observe -----------------------------------------------------------------------------------------------

test("Azure Terraform observe: after a successful apply the driver records the blueprint from the state, identifiers only, and observe verifies each resource through Azure Resource Manager as DISCOVERY, with no credential outside memory", async () => {
  const w = world();
  const { s, evidence } = await applied(w);
  assert.equal(s.sealed.unit?.unitId, UNIT.unitId, "the Azure plan carries the same deletion unit scheme");
  assert.deepEqual(s.sealed.unit?.untagged, [], "the fake provider stamps every created resource");
  const blueprint = await readBlueprintRecord(s.sealed.artifactSha256, sha256(canonicalJson(evidence as never)), w.dirs.evidence);
  assert.ok(blueprint);
  assert.deepEqual(sorted(blueprint.blueprint.entries.map((e) => [e.address, e.origin, e.id, e.arn])), sorted([
    ["azuread_application.pilot", "NOT_IN_PLAN", APP, null], ["azurerm_key_vault.reused", "IN_PLAN", REUSED_VAULT, null], ["azurerm_key_vault_secret.canary", "IN_PLAN", SECRET, null],
    ["azurerm_log_analytics_workspace.pilot", "IN_PLAN", LAW, null], ["azurerm_resource_group.pilot", "IN_PLAN", RG, null], ["azurerm_resource_group.state", "IN_PLAN", RG_STATE, null],
    ["azurerm_role_assignment.old", "NOT_IN_PLAN", OLD_ROLE, null], ["azurerm_storage_account.state", "IN_PLAN", STATE_ACCOUNT, null], ["azurerm_storage_container.state", "IN_PLAN", STATE_CONTAINER, null],
    ["azurerm_subscription_policy_assignment.shared", "IN_PLAN", POLICY_ASSIGNMENT, null], ["azurerm_virtual_network.unrelated", "NOT_IN_PLAN", UNRELATED_VNET, null],
  ]));
  const raw = JSON.stringify(await readEncryptedEvidence(join(w.dirs.evidence, s.sealed.artifactSha256 + BLUEPRINT_SUFFIX)));
  for (const canary of [...CANARIES, STATE_CANARY]) assert.ok(!raw.includes(canary), "a state value reached the blueprint: " + canary);

  const observation = await observeRun(s.sealed.artifactSha256, observeDeps(w));
  assert.ok(observation.ok, JSON.stringify(observation));
  assert.equal(observation.record.verifier, "AZURE_RESOURCE_MANAGER");
  assert.equal(observation.record.verifierBinarySha256, null, "the reader runs in process; there is no program to hash");
  assert.equal(observation.record.verdict, "PARTIAL", "a key vault secret, a directory object and a data-plane URL have no ARM id and cannot be read here, so they are named, not assumed");
  const results = new Map(observation.record.resources.map((r) => [r.address, [r.result, r.reason]]));
  for (const address of ["azuread_application.pilot", "azurerm_key_vault_secret.canary", "azurerm_storage_container.state"]) assert.deepEqual(results.get(address), ["UNVERIFIABLE", "NOT_AN_ARM_RESOURCE_ID"], address);
  for (const address of ["azurerm_key_vault.reused", "azurerm_log_analytics_workspace.pilot", "azurerm_resource_group.pilot", "azurerm_resource_group.state", "azurerm_role_assignment.old",
    "azurerm_storage_account.state", "azurerm_subscription_policy_assignment.shared", "azurerm_virtual_network.unrelated"]) assert.deepEqual(results.get(address), ["VERIFIED", undefined], address);
  assert.equal(observation.record.inventory, "COMPLETE");
  assert.deepEqual(observation.record.unexpected, []);
  assert.ok(!("groups" in observation.record), "the record carries no group contents: a pilot cleanup never deletes a group, so what one holds is not a deletion decision");
  // The credential path: one token POST to the tenant's endpoint with the assertion in the body, then GETs to management.azure.com only.
  assert.deepEqual(hosts(w), ["login.microsoftonline.com", "management.azure.com"]);
  const posts = w.arm.calls.filter((c) => c.method === "POST");
  assert.equal(posts.length, 1, "the federated token is exchanged once");
  assert.equal(posts[0].url, "https://login.microsoftonline.com/" + identityEnv("DEV").ALZ_DISCOVERY_ARM_TENANT_ID + "/oauth2/v2.0/token");
  assert.ok(new URLSearchParams(posts[0].body).get("client_assertion") === ARM_FEDERATED_TOKEN_CANARY, "the assertion travels in the POST body");
  assert.equal(new URLSearchParams(posts[0].body).get("client_id"), "discovery-client-1", "the DISCOVERY identity, no other");
  assert.ok(w.arm.calls.filter((c) => c.method === "GET").every((c) => new URL(c.url).protocol === "https:" && new URL(c.url).host === "management.azure.com" && c.headers.authorization === "Bearer " + ARM_ACCESS_TOKEN_CANARY));
  assert.deepEqual(methods(w), ["GET", "POST"], "reads and the token exchange; nothing else is ever sent");
  noTokenIn(w, observation.record, observation.report);
  assert.ok(calls().every((c) => !JSON.stringify(c).includes(ARM_FEDERATED_TOKEN_CANARY) && !JSON.stringify(c).includes(ARM_ACCESS_TOKEN_CANARY)), "no token reached the engine's argv or environment");
  const listing = w.arm.calls.filter((c) => /\/(resources|resourcegroups)\?\$filter=/.test(c.url));
  assert.equal(listing.length, 2, "resources and resource groups are both listed by the unit tag");
  assert.ok(listing.every((c) => decodeURIComponent(c.url).includes("tagName eq 'alz-unit' and tagValue eq '" + UNIT.unitId + "'")));
  assert.equal(w.arm.calls.filter((c) => /\/resourceGroups\/[^/]+\/(resources|providers\/Microsoft\.Authorization)/.test(c.url)).length, 0, "no resource group's contents or grants are listed: nothing here decides a group's deletion");
});

test("Azure observe denied and interrupted: a refused token, a forbidden or throttled read, a paginated listing and a tagged resource outside the state never pass, and nothing but the class is recorded", async () => {
  const w = world();
  const { s } = await applied(w);
  const before = applyCalls().length;
  // The token endpoint refuses the identity: nothing is read, nothing is verified, and the reason is a class.
  cloud(w, { ...CLOUD, tokenStatus: 401 });
  const refusedToken = await observeRun(s.sealed.artifactSha256, observeDeps(w));
  assert.ok(refusedToken.ok);
  assert.equal(refusedToken.record.verdict, "INCONCLUSIVE");
  assert.ok(refusedToken.record.resources.filter((r) => r.result !== "UNVERIFIABLE").every((r) => r.result === "UNVERIFIABLE" || r.reason === "CREDENTIALS"), JSON.stringify(refusedToken.record.resources));
  assert.equal(refusedToken.record.inventory, "INCOMPLETE");
  assert.equal(w.arm.calls.filter((c) => c.method === "GET").length, 0, "no read is attempted without a token");
  noTokenIn(w, refusedToken.record);
  // Forbidden for one resource, throttled for another.
  cloud(w, { ...CLOUD, fail: { [LAW]: 403, [RG]: 429 } });
  const partial = await observeRun(s.sealed.artifactSha256, observeDeps(w));
  assert.ok(partial.ok);
  assert.equal(partial.record.verdict, "INCONCLUSIVE");
  const byAddress = new Map(partial.record.resources.map((r) => [r.address, r]));
  assert.deepEqual([byAddress.get("azurerm_log_analytics_workspace.pilot")!.result, byAddress.get("azurerm_log_analytics_workspace.pilot")!.reason], ["UNVERIFIABLE", "ACCESS_DENIED"]);
  assert.deepEqual([byAddress.get("azurerm_resource_group.pilot")!.result, byAddress.get("azurerm_resource_group.pilot")!.reason], ["NOT_YET_OBSERVABLE", "THROTTLED"]);
  assert.ok(!JSON.stringify(partial.record).includes("CANARY_CLOUD_ERROR"), "the cloud's message is never recorded");
  // The identity has no access at all: nothing verified, nothing guessed.
  cloud(w, { ...CLOUD, failAll: 403 });
  const denied = await observeRun(s.sealed.artifactSha256, observeDeps(w));
  assert.ok(denied.ok);
  assert.ok(denied.record.resources.every((r) => r.result !== "VERIFIED"));
  assert.equal(denied.record.inventory, "INCOMPLETE");
  // A paginated listing is followed to its end and still counts as complete; a resource of this unit the state does not name fails the observation.
  cloud(w, { ...CLOUD, tagged: [...TAGGED, RG + "/providers/Microsoft.Storage/storageAccounts/orphanofthisunit"], pages: 2 });
  const stray = await observeRun(s.sealed.artifactSha256, observeDeps(w));
  assert.ok(stray.ok);
  assert.equal(stray.record.inventory, "COMPLETE");
  assert.equal(stray.record.verdict, "FAILED");
  assert.deepEqual(stray.record.unexpected, [RG + "/providers/Microsoft.Storage/storageAccounts/orphanofthisunit"]);
  const records = await loadRunRecords(s.sealed.artifactSha256, w.dirs.evidence);
  assert.ok(records.ok);
  refused(build(w, s, records), "OBSERVATION_INCONCLUSIVE");
  // ARM ids are case-insensitive: a listing that spells a known id differently is not a stray.
  cloud(w, { ...CLOUD, tagged: [RG.toUpperCase(), LAW] });
  const spelled = await observeRun(s.sealed.artifactSha256, observeDeps(w));
  assert.ok(spelled.ok && spelled.record.verdict === "PARTIAL" && spelled.record.unexpected.length === 0, JSON.stringify(spelled));
  // Observing again and again never applies again.
  cloud(w, CLOUD);
  const again = await observeRun(s.sealed.artifactSha256, observeDeps(w));
  assert.ok(again.ok && again.record.verdict === "PARTIAL");
  assert.equal(applyCalls().length, before);
});

test("the Azure reader sends nothing to a foreign host, a plaintext or login-host link, or a path the URL parser would rewrite; it stays inside the target subscription, needs an ARM id, resolves stable API versions once per type, and reads nothing once closed", async () => {
  const arm = fakeArmHttp({ existing: [RG, LAW] });
  const { reader, close } = createDiscoveryArmReader({ env: env(), subscriptionId: SUB, http: arm.http });
  assert.equal(reader.verifier, "AZURE_RESOURCE_MANAGER");
  const entry = (address: string, type: string, id: string | null) => ({ address, type, id, arn: null, origin: "IN_PLAN" as const });
  assert.deepEqual((await reader.check(entry("a.b", "azurerm_resource_group", RG))).existence, "PRESENT");
  assert.deepEqual((await reader.check(entry("a.c", "azurerm_log_analytics_workspace", LAW))).existence, "PRESENT");
  assert.deepEqual((await reader.check(entry("a.d", "azurerm_log_analytics_workspace", RG + "/providers/Microsoft.OperationalInsights/workspaces/gone"))).existence, "ABSENT");
  const other = await reader.check(entry("a.e", "azurerm_resource_group", "/subscriptions/99999999-9999-4999-8999-999999999999/resourceGroups/elsewhere"));
  assert.deepEqual([other.existence, other.reason], ["NOT_CHECKABLE", "OUTSIDE_TARGET_SUBSCRIPTION"]);
  const url = await reader.check(entry("a.f", "azurerm_key_vault_secret", SECRET));
  assert.deepEqual([url.existence, url.reason], ["NOT_CHECKABLE", "NOT_AN_ARM_RESOURCE_ID"]);
  assert.deepEqual((await reader.check(entry("a.g", "azurerm_x", null))).reason, "NO_IDENTIFIER_IN_STATE");
  assert.equal(arm.calls.filter((c) => /\/providers\/Microsoft\.OperationalInsights\?/.test(c.url)).length, 1, "the provider's API versions are read once for the type");
  assert.ok(arm.calls.every((c) => ["login.microsoftonline.com", "management.azure.com"].includes(new URL(c.url).host)));
  assert.ok(!("listGroup" in reader), "the reader lists no group contents: a pilot cleanup never deletes a resource group");
  assert.deepEqual(armTypeOf(LAW), { namespace: "Microsoft.OperationalInsights", typePath: "workspaces" });
  assert.deepEqual(armTypeOf(RG + "/providers/Microsoft.Storage/storageAccounts/x/blobServices/default/containers/c"), { namespace: "Microsoft.Storage", typePath: "storageAccounts/blobServices/containers" });
  assert.deepEqual(armTypeOf(RG), { namespace: "Microsoft.Resources", typePath: "resourceGroups" });
  assert.deepEqual(armTypeOf(OLD_ROLE), { namespace: "Microsoft.Authorization", typePath: "roleAssignments" }, "a subscription-scoped resource has no resource group and is still addressable");
  // An extension resource's own type is its last `/providers/` pair; every pair is available for classification.
  assert.deepEqual(armTypeOf(LAW + "/providers/Microsoft.Authorization/roleAssignments/aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa"), { namespace: "Microsoft.Authorization", typePath: "roleAssignments" });
  assert.deepEqual(armTypePairsOf(LAW + "/providers/Microsoft.Authorization/roleAssignments/aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa"),
    [{ namespace: "Microsoft.OperationalInsights", typePath: "workspaces" }, { namespace: "Microsoft.Authorization", typePath: "roleAssignments" }]);
  assert.deepEqual(armTypePairsOf(RG), [{ namespace: "Microsoft.Resources", typePath: "resourceGroups" }]);
  assert.equal(armTypePairsOf(RG + "/providers/Microsoft.Storage/storageAccounts"), undefined, "a pair with an odd number of segments names no resource");
  assert.equal(armTypePairsOf(LAW + "/providers//roleAssignments/x"), undefined);
  assert.equal(armTypeOf("/subscriptions/" + SUB), undefined);
  assert.equal(armTypeOf("https://x.vault.azure.net/secrets/y"), undefined);
  // A unit id that is not tag-safe is never put into a filter.
  assert.equal(await reader.listTagged("x'; drop"), undefined);

  // An id whose path the URL parser would rewrite (backslashes, dot segments, percent escapes, an empty segment) is never sent: a 404 for another
  // path must not read as this resource's absence. Nothing but the provider listing was requested for any of them.
  const requests = () => arm.calls.filter((c) => c.method === "GET" && !/\/providers\/[A-Za-z0-9.]+\?/.test(c.url)).length;
  const sent = requests();
  for (const bad of [
    RG + "/providers/Microsoft.Storage/storageAccounts/a\\..\\..\\..\\b", RG + "/providers/Microsoft.Storage/storageAccounts/../../../../subscriptions/99999999-9999-4999-8999-999999999999/resourceGroups/x",
    RG + "/providers/Microsoft.Storage/storageAccounts/%2e%2e/x", RG + "/providers/Microsoft.Storage/storageAccounts//x", RG + "/providers/Microsoft.Storage/storageAccounts/./x", RG + "/providers/Microsoft.Storage/storageAccounts/a b",
  ]) {
    const result = await reader.check(entry("a.h", "azurerm_storage_account", bad));
    assert.deepEqual([result.existence, result.reason], ["NOT_CHECKABLE", "NOT_AN_ARM_RESOURCE_ID"], bad);
    assert.ok(!armPathSafe(bad), bad);
  }
  assert.equal(requests(), sent, "no request was sent for an id that is not sent exactly as written");
  assert.ok(armPathSafe(RG) && armPathSafe(LAW) && armPathSafe(OLD_ROLE));

  // A type the provider offers only in preview versions is not read: fail closed, not guessed.
  const preview = fakeArmHttp({ existing: [LAW], previewOnlyTypes: ["Microsoft.OperationalInsights/workspaces"] });
  const previewReader = createDiscoveryArmReader({ env: env(), subscriptionId: SUB, http: preview.http });
  const unstable = await previewReader.reader.check(entry("a.c", "azurerm_log_analytics_workspace", LAW));
  assert.deepEqual([unstable.existence, unstable.reason], ["UNKNOWN", "TYPE_NOT_SUPPORTED"]);
  assert.equal(preview.calls.filter((c) => c.method === "GET" && c.url.includes("/workspaces/")).length, 0);
  previewReader.close();

  // A subscription that is not a GUID is refused before anything is read.
  assert.throws(() => createDiscoveryArmReader({ env: env(), subscriptionId: "not-a-guid", http: arm.http }), /ARM_SUBSCRIPTION_INVALID/);
  // A missing token file is a credential failure, with nothing read.
  const noFile = fakeArmHttp({ existing: [RG] });
  const broken = createDiscoveryArmReader({ env: { ...env(), ALZ_DISCOVERY_ARM_OIDC_TOKEN_FILE: join(root, "absent") }, subscriptionId: SUB, http: noFile.http });
  const unreadable = await broken.reader.check(entry("a.b", "azurerm_resource_group", RG));
  assert.deepEqual([unreadable.existence, unreadable.reason], ["UNKNOWN", "CREDENTIALS"]);
  assert.equal(noFile.calls.length, 0);
  broken.close();
  // Once closed, a reader exchanges no token again and reads nothing.
  close();
  const closedCalls = arm.calls.length;
  const afterClose = await reader.check(entry("a.b", "azurerm_resource_group", RG));
  assert.deepEqual([afterClose.existence, afterClose.reason], ["UNKNOWN", "READER_CLOSED"]);
  assert.equal(arm.calls.length, closedCalls);

  // A listing whose next page points anywhere but https://management.azure.com (a foreign host, the same host over plaintext or on a port, the
  // login host, a URL with userinfo) ends the listing as incomplete, and the bearer is never sent there.
  for (const next of ["https://evil.example/next", "http://management.azure.com/next1", "https://management.azure.com:8443/next", "https://login.microsoftonline.com/next", "https://user:pw@management.azure.com/next", "https://management.azure.com.evil.example/next"]) {
    const inner = fakeArmHttp({ tagged: [] });
    const seen: ArmRequest[] = [];
    const http: ArmHttp = async (request) => {
      seen.push(request);
      const answer = await inner.http(request);
      return request.method === "GET" && /\/resources\?/.test(request.url) ? { status: 200, body: JSON.stringify({ value: [{ id: RG }], nextLink: next }) } : answer;
    };
    const hooked = createDiscoveryArmReader({ env: env(), subscriptionId: SUB, http });
    const listed = await hooked.reader.listTagged(UNIT.unitId);
    assert.deepEqual(listed, { identifiers: [RG], complete: false }, next);
    assert.ok(seen.every((r) => r.url !== next && /^https:\/\/(login\.microsoftonline\.com|management\.azure\.com)\//.test(r.url)), next + ": the link was never followed");
    hooked.close();
  }
});

// --- propose, clean up, verify --------------------------------------------------------------------------------

const withoutSecret = <T extends { address?: string; type?: string }>(items: readonly T[]): T[] => items.filter((item) => !(item.address ?? item.type ?? "").includes("key_vault_secret"));
/** The exclusions the fixture always produces: everything this run did not create, or must never delete. */
const PROTECTED_EXCLUSIONS: [string, string][] = [
  ["azuread_application.pilot", "PROTECTED_IDENTITY"], ["azurerm_key_vault.reused", "IMPORTED"], ["azurerm_resource_group.pilot", "RETAINED_GROUP"], ["azurerm_resource_group.state", "PROTECTED_BACKEND"], ["azurerm_role_assignment.old", "PROTECTED_IDENTITY"],
  // The shared policy assignment the plan only updated is kept as an authorization object, not merely as pre-existing: the protection is judged first (review 6409512569, B2).
  ["azurerm_storage_account.state", "PROTECTED_BACKEND"], ["azurerm_storage_container.state", "PROTECTED_BACKEND"], ["azurerm_subscription_policy_assignment.shared", "PROTECTED_IDENTITY"], ["azurerm_virtual_network.unrelated", "NOT_IN_PLAN"],
];
/** Who keeps each kept resource: the pilot owner for a protected class, the environment's owner for a resource this run did not create. */
const RETAINED_BY: Record<string, string> = { PROTECTED_IDENTITY: "PILOT_OWNER", PROTECTED_BACKEND: "PILOT_OWNER", PROTECTED_DEPLOYMENT: "PILOT_OWNER", RETAINED_GROUP: "PILOT_OWNER", CONTAINS_OTHERS: "PILOT_OWNER", IMPORTED: "ENVIRONMENT_OWNER", PRE_EXISTING: "ENVIRONMENT_OWNER", NOT_IN_PLAN: "ENVIRONMENT_OWNER" };

test("Azure Terraform cleanup: the proposal keeps the resource group this run created, the state backend in every form and the group that holds it, the pilot's identities and grants, and every pre-existing, shared, imported or unrelated resource, each with its retention owner; the APPLY identity destroys exactly the approved list after a targeted destroy plan; the leftover check reads ARM again and COMPLETE reads approved resources deleted and protected objects retained, never the environment deleted", async () => {
  const w = world();
  // This run creates only resources the reader can address; a run with a key vault secret is checked below.
  behave({ showResources: withoutSecret(CREATES), stateResources: withoutSecret(STATE as { type: string }[]) });
  const run = await proposed(w);
  assert.deepEqual(run.proposal.deletes.map((d) => [d.address, d.identifier, d.observed]), [["azurerm_log_analytics_workspace.pilot", LAW, "VERIFIED"]], "the group this run created is not on the list");
  assert.deepEqual(sorted(run.proposal.excluded.map((x) => [x.address, x.ownership])), sorted(PROTECTED_EXCLUSIONS));
  for (const kept of run.proposal.excluded) assert.equal(kept.retainedBy, RETAINED_BY[kept.ownership], kept.address + " names who keeps it");
  const group = run.proposal.excluded.find((x) => x.address === "azurerm_resource_group.pilot")!;
  assert.equal(group.retainedBy, "PILOT_OWNER");
  assert.match(group.reason, /never deleted by a pilot cleanup.*separate, reviewed action.*environment retirement, outstanding/);
  assert.ok(run.proposal.excluded.find((x) => x.address === "azurerm_storage_container.state")!.reason.includes("state backend"), "a created container of the backend account, by its data-plane URL, is still the backend");
  assert.ok(!run.proposal.risks.some((r) => r.startsWith("azurerm_resource_group:")), "no group is proposed, so no group deletion risk is named");
  assert.ok(run.proposal.risks.some((r) => /intentionally retained.*retiring the environment.*separate, reviewed action.*outstanding/.test(r)), "the approvers read that protected objects stay and the environment is not retired");
  assert.equal(run.proposal.unitId, UNIT.unitId);
  noTokenIn(w, run.proposal, run.observation.record);

  const result = await cleanup(w, run);
  assert.ok(result.ok, JSON.stringify(result));
  assert.equal(result.evidence.outcome, "SUCCEEDED");
  assert.deepEqual(result.evidence.deletes, ["azurerm_log_analytics_workspace.pilot"]);
  assert.deepEqual(destroyPlans()[0]!.args.filter((a) => a.startsWith("-target=")).sort(), result.evidence.deletes.map((d) => "-target=" + d));
  assert.ok(existsSync(join(w.dirs.evidence, run.proposal.proposalSha256 + CLEANUP_SUFFIX)));
  assert.deepEqual(await readCleanupEvidence(run.proposal.proposalSha256, w.dirs.evidence), result.evidence);
  assert.equal(w.arm.calls.filter((c) => c.method === "GET" && /\/resourceGroups\/[^/]+\/(resources|providers\/Microsoft\.Authorization)/.test(c.url)).length, 0, "the cleanup lists no group's contents: there is no group deletion to decide");

  // The group stays and still carries the unit tag: it is a known, retained identifier of this run, not a leftover.
  cloud(w, { existing: RETAINED, tagged: [RG] });
  const early = await verifyProposalLeftovers(run.proposal, observeDeps(w, new Date(NOW.getTime() + 600_000)));
  assert.ok(early.ok);
  assert.equal(early.record.disposition, "COMPLETE", "the retained group is a known identifier of this run: a listing that names it is not a leftover");
  assert.deepEqual(early.record.resources.find((r) => r.address === "azurerm_resource_group.pilot")?.disposition, "INTENTIONALLY_RETAINED");
  // A denied read of a proposed resource is never read as its deletion: the record stays unresolved and incomplete.
  cloud(w, { existing: RETAINED, tagged: [], fail: { [LAW]: 403 } });
  const denied = await verifyProposalLeftovers(run.proposal, observeDeps(w, new Date(NOW.getTime() + 650_000)));
  assert.ok(denied.ok);
  assert.equal(denied.record.disposition, "INCOMPLETE");
  assert.deepEqual([denied.record.resources.find((r) => r.address === "azurerm_log_analytics_workspace.pilot")?.disposition, denied.record.resources.find((r) => r.address === "azurerm_log_analytics_workspace.pilot")?.basis, denied.record.resources.find((r) => r.address === "azurerm_log_analytics_workspace.pilot")?.reason],
    ["UNKNOWN", "CHECK_FAILED", "ACCESS_DENIED"], "a denied observation is unresolved, never a confirmed deletion");
  assert.match(denied.record.nextAction, /Fix the DISCOVERY identity's access/);
  // A tagged resource outside the state keeps the cleanup incomplete; an empty complete listing completes it.
  cloud(w, { existing: RETAINED, tagged: [RG + "/providers/Microsoft.Storage/storageAccounts/strayofthisunit"] });
  const stray = await verifyProposalLeftovers(run.proposal, observeDeps(w, new Date(NOW.getTime() + 700_000)));
  assert.ok(stray.ok);
  assert.equal(stray.record.disposition, "INCOMPLETE");
  assert.deepEqual(stray.record.resources.filter((r) => r.address === "(not in state)").map((r) => [r.identifier, r.disposition]), [[RG + "/providers/Microsoft.Storage/storageAccounts/strayofthisunit", "STILL_PRESENT"]]);
  cloud(w, { existing: RETAINED, tagged: [] });
  const leftovers = await verifyProposalLeftovers(run.proposal, observeDeps(w, new Date(NOW.getTime() + 800_000)));
  assert.ok(leftovers.ok);
  assert.equal(leftovers.record.verifier, "AZURE_RESOURCE_MANAGER");
  assert.equal(leftovers.record.disposition, "COMPLETE");
  assert.equal(leftovers.record.sweep, "COMPLETE");
  assert.deepEqual(leftovers.record.resources.filter((r) => r.disposition === "CONFIRMED_DELETED").map((r) => [r.address, r.basis]), [["azurerm_log_analytics_workspace.pilot", "ARM_ABSENT"]], "the basis names the API that answered");
  assert.deepEqual(sorted(leftovers.record.resources.filter((r) => r.disposition === "INTENTIONALLY_RETAINED").map((r) => [r.address, r.basis, r.owner])),
    sorted(PROTECTED_EXCLUSIONS.map(([address, ownership]) => [address, "RETENTION_DECISION", RETAINED_BY[ownership]])), "every kept resource has a named owner");
  assert.ok(leftovers.record.resources.filter((r) => r.disposition === "INTENTIONALLY_RETAINED").every((r) => /^[A-Z_]+: .{10,}/.test(r.reason ?? "")), "and a reason");
  assert.match(leftovers.record.nextAction, /^Approved resources deleted: every listed resource \(1\) is confirmed gone.*Protected or pre-existing objects intentionally retained \(9, kept by ENVIRONMENT_OWNER and PILOT_OWNER\); they were never on the list, were left in place and were not read.*environment retirement is a separate, reviewed action and remains outstanding.*does not claim the environment retired/);
  assert.ok(!/resource group|identities and grants|state backend/.test(leftovers.record.nextAction), "no cloud's list of protected kinds is recited");
  assert.ok(!/environment (is |was )?deleted|entire environment/.test(leftovers.record.nextAction));
  assert.ok(!JSON.stringify(leftovers.record).includes("CLOUD_CONTROL"), "no record of an Azure run names a service that did not answer");
  noTokenIn(w, leftovers.record, result.evidence);

  // A run that also created a key vault secret: the secret has no ARM id, so after the cleanup it is UNKNOWN, never confirmed, and the record stays INCOMPLETE with a person's next step.
  const w2 = world();
  const run2 = await proposed(w2);
  assert.ok((await cleanup(w2, run2)).ok);
  cloud(w2, { existing: RETAINED, tagged: [] });
  const open = await verifyProposalLeftovers(run2.proposal, observeDeps(w2, new Date(NOW.getTime() + 800_000)));
  assert.ok(open.ok);
  assert.equal(open.record.disposition, "INCOMPLETE");
  assert.deepEqual(open.record.resources.find((r) => r.address === "azurerm_key_vault_secret.canary")?.disposition, "UNKNOWN");
  assert.match(open.record.nextAction, /cannot be read independently.*confirms by hand/);
});

test("Azure resource groups are never deleted: a group this run created, through azurerm_resource_group or any type whose id is a group (azapi_resource), is kept as RETAINED_GROUP by the pilot owner with a reason; a destroy plan that would take a group along as a dependent stops before any approval is consumed; a forged proposal naming a group never executes; a subscription or management group is never proposed", async () => {
  const AZAPI_RG = "/subscriptions/" + SUB + "/resourceGroups/rg-azapi";
  const AZAPI_OWNED = AZAPI_RG + "/providers/Microsoft.Storage/storageAccounts/azapiowned";
  const ALIAS = "/providers/Microsoft.Subscription/aliases/vended-sub";
  const MG = "/providers/Microsoft.Management/managementGroups/mg-platform";
  const creates = [...withoutSecret(CREATES), change("azapi_resource.rg", "azapi_resource", ["create"]), change("azurerm_storage_account.azapi", "azurerm_storage_account", ["create"]),
    change("azurerm_subscription.vended", "azurerm_subscription", ["create"]), change("azurerm_management_group.platform", "azurerm_management_group", ["create"])];
  const state = [...withoutSecret(STATE as { type: string }[]), azureStateResource("azapi_resource", "rg", AZAPI_RG), azureStateResource("azurerm_storage_account", "azapi", AZAPI_OWNED),
    azureStateResource("azurerm_subscription", "vended", ALIAS), azureStateResource("azurerm_management_group", "platform", MG)];
  const existing = [...EXISTING, AZAPI_RG, AZAPI_OWNED];
  const w = world({ existing, tagged: [...TAGGED, AZAPI_RG, AZAPI_OWNED] });
  behave({ showResources: admitted(creates), stateResources: state });
  const run = await proposed(w);
  // Both groups were created by this run, hold nothing foreign, and are still never proposed; what they hold is.
  assert.deepEqual(run.proposal.deletes.map((d) => d.address), ["azurerm_log_analytics_workspace.pilot", "azurerm_storage_account.azapi"]);
  const kept = new Map(run.proposal.excluded.map((x) => [x.address, x]));
  for (const address of ["azapi_resource.rg", "azurerm_resource_group.pilot"]) {
    assert.equal(kept.get(address)?.ownership, "RETAINED_GROUP", address + " is a group by its id, whatever type created it");
    assert.equal(kept.get(address)?.retainedBy, "PILOT_OWNER", address);
    assert.match(kept.get(address)!.reason, /never deleted by a pilot cleanup, whatever it holds.*separate, reviewed action/, address);
  }
  for (const address of ["azurerm_subscription.vended", "azurerm_management_group.platform"]) {
    assert.equal(kept.get(address)?.ownership, "CONTAINS_OTHERS", address);
    assert.equal(kept.get(address)?.retainedBy, "PILOT_OWNER", address);
    assert.match(kept.get(address)!.reason, /subscription or management group/);
  }
  const approval = cleanupApproval(run.proposal, "alice");
  // Indirect deletion: the engine's destroy plan would take a group along (as a dependent of an approved resource). Refused before
  // anything is consumed, and the refusal names the policy, not just the extra address; the same for a group known only by its id.
  for (const [address, type] of [["azurerm_resource_group.pilot", "azurerm_resource_group"], ["azapi_resource.rg", "azapi_resource"]] as const) {
    await destroyPlanRefused(w, run, [approval], creates, state, address, type,
      new RegExp("would delete " + address.replace(".", "\\.") + ", a resource group, which a pilot cleanup never deletes, directly or as a dependent \\(RETAINED_GROUP\\).*Nothing was destroyed and no approval was consumed"));
    assert.equal(destroyPlans().length, 1, address + ": the destroy was planned and stopped there");
    assert.equal(applyCalls().length, 0, address + ": no destroy was applied");
  }
  assert.deepEqual(readdirSync(w.dirs.evidence).filter((n) => n.endsWith(CLEANUP_SUFFIX)), [], "nothing was recorded");
  // A forged proposal that adds either group, the subscription alias or the management group never executes.
  const row = (address: string, type: string, identifier: string) => ({ address, type, identifier, ownership: "RUN_CREATED" as const, observed: "VERIFIED" as const });
  for (const [address, type, id] of [["azurerm_resource_group.pilot", "azurerm_resource_group", RG], ["azapi_resource.rg", "azapi_resource", AZAPI_RG], ["azurerm_subscription.vended", "azurerm_subscription", ALIAS], ["azurerm_management_group.platform", "azurerm_management_group", MG]] as const) {
    const fields = { ...run.proposal, deletes: [...run.proposal.deletes, row(address, type, id)].sort((a, b) => (a.address < b.address ? -1 : 1)), excluded: run.proposal.excluded.filter((x) => x.address !== address) };
    const forged = reHashedProposal(fields);
    assert.ok(verifyCleanupProposal(forged).ok, address + ": self-consistent");
    refused(await cleanup(w, run, [cleanupApproval(forged, "alice")], forged), "PROPOSAL_INVALID");
  }
  assert.equal(destroyPlans().length, 1, "no forgery reached the engine");
  // With the honest destroy plan the same, unconsumed approval runs once: the groups stay, and the leftover check records them as retained.
  behave({ showResources: admitted(creates), stateResources: state });
  const done = await cleanup(w, run, [approval]);
  assert.ok(done.ok, JSON.stringify(done));
  assert.deepEqual(done.evidence.deletes, run.proposal.deletes.map((d) => d.address));
  cloud(w, { existing: [RG, AZAPI_RG, ...RETAINED], tagged: [RG, AZAPI_RG] });
  const leftovers = await verifyProposalLeftovers(run.proposal, observeDeps(w, new Date(NOW.getTime() + 600_000)));
  assert.ok(leftovers.ok);
  assert.equal(leftovers.record.disposition, "COMPLETE", "retained groups still carrying the unit tag are known identifiers of this run, not leftovers");
  assert.deepEqual(sorted(leftovers.record.resources.filter((r) => r.disposition === "INTENTIONALLY_RETAINED" && /RETAINED_GROUP|CONTAINS_OTHERS/.test(r.reason ?? "")).map((r) => [r.address, r.owner])),
    sorted([["azapi_resource.rg", "PILOT_OWNER"], ["azurerm_management_group.platform", "PILOT_OWNER"], ["azurerm_resource_group.pilot", "PILOT_OWNER"], ["azurerm_subscription.vended", "PILOT_OWNER"]]));
  noTokenIn(w, run.proposal, leftovers.record);
});

test("Azure cleanup denied: a forged, re-hashed proposal naming the backend account, its container, the group that holds it, the group this run created, a grant, a pre-existing, imported, shared or unrelated resource, a dropped entry or a changed retention owner never executes, an apply approval never authorizes a cleanup, and a state id that cannot be read exactly as written makes no proposal", async () => {
  const w = world();
  const run = await proposed(w);
  const honest = run.proposal;
  const rehashed = (edit: Partial<CleanupProposal>): CleanupProposal => {
    const fields = { ...honest, ...edit, deletes: [...(edit.deletes ?? honest.deletes)].sort((a, b) => (a.address < b.address ? -1 : 1)) };
    return reHashedProposal(fields);
  };
  const row = (address: string, type: string, identifier: string) => ({ address, type, identifier, ownership: "RUN_CREATED" as const, observed: "VERIFIED" as const });
  const without = (address: string) => honest.excluded.filter((x) => x.address !== address);
  const approval = cleanupApproval(honest, "alice");
  const forgeries: [string, CleanupProposal][] = [
    ["the state storage account", rehashed({ deletes: [...honest.deletes, row("azurerm_storage_account.state", "azurerm_storage_account", STATE_ACCOUNT)], excluded: without("azurerm_storage_account.state") })],
    ["the state container, by its data-plane URL", rehashed({ deletes: [...honest.deletes, row("azurerm_storage_container.state", "azurerm_storage_container", STATE_CONTAINER)], excluded: without("azurerm_storage_container.state") })],
    ["the group that holds the backend", rehashed({ deletes: [...honest.deletes, row("azurerm_resource_group.state", "azurerm_resource_group", RG_STATE)], excluded: without("azurerm_resource_group.state") })],
    ["the resource group this run created", rehashed({ deletes: [...honest.deletes, row("azurerm_resource_group.pilot", "azurerm_resource_group", RG)], excluded: without("azurerm_resource_group.pilot") })],
    ["a kept resource with its retention owner changed", rehashed({ excluded: honest.excluded.map((x) => (x.address === "azurerm_resource_group.pilot" ? { ...x, retainedBy: "ENVIRONMENT_OWNER" as const } : x)) })],
    ["a role assignment", rehashed({ deletes: [...honest.deletes, row("azurerm_role_assignment.old", "azurerm_role_assignment", OLD_ROLE)], excluded: without("azurerm_role_assignment.old") })],
    ["the pilot's directory application", rehashed({ deletes: [...honest.deletes, row("azuread_application.pilot", "azuread_application", APP)], excluded: without("azuread_application.pilot") })],
    ["a shared policy assignment the plan only updated", rehashed({ deletes: [...honest.deletes, row("azurerm_subscription_policy_assignment.shared", "azurerm_subscription_policy_assignment", POLICY_ASSIGNMENT)], excluded: without("azurerm_subscription_policy_assignment.shared") })],
    ["an imported vault", rehashed({ deletes: [...honest.deletes, row("azurerm_key_vault.reused", "azurerm_key_vault", REUSED_VAULT)], excluded: without("azurerm_key_vault.reused") })],
    ["an unrelated network the state holds", rehashed({ deletes: [...honest.deletes, row("azurerm_virtual_network.unrelated", "azurerm_virtual_network", UNRELATED_VNET)], excluded: without("azurerm_virtual_network.unrelated") })],
    ["a resource of another run entirely", rehashed({ deletes: [...honest.deletes, row("azurerm_storage_account.other", "azurerm_storage_account", RG + "/providers/Microsoft.Storage/storageAccounts/otherrun")] })],
    ["a dropped entry", rehashed({ deletes: honest.deletes.slice(1) })],
    ["a kept resource silently removed from the kept list", rehashed({ excluded: without("azurerm_virtual_network.unrelated") })],
  ];
  for (const [label, forged] of forgeries) {
    if (label.includes("retention owner")) assert.equal(verifyCleanupProposal(forged).ok, false, label + ": the owner follows from the ownership class, so a changed one is malformed");
    else assert.ok(verifyCleanupProposal(forged).ok, label + ": the forgery is self-consistent");
    const result = await cleanup(w, run, [cleanupApproval(forged, "alice")], forged);
    refused(result, "PROPOSAL_INVALID");
    if (!label.includes("retention owner")) assert.match((result as { message: string }).message, /nothing was run|Nothing was run/i, label);
  }
  // An apply approval, signed under the other domain over the artifact, never authorizes a cleanup.
  refused(await cleanup(w, run, [approvalFor(run.s.sealed, "alice")]), "APPROVAL_UNVERIFIED");
  assert.equal(destroyPlans().length, 0, "no destroy was planned for any forgery");
  assert.equal(applyCalls().length, 1, "only the original apply ran");
  assert.deepEqual(readdirSync(w.dirs.evidence).filter((n) => n.endsWith(CLEANUP_SUFFIX)), [], "nothing was reserved or recorded");
  noTokenIn(w, ...forgeries.map(([, f]) => f));
  // The honest proposal with the same, unconsumed approval still runs once.
  const done = await cleanup(w, run, [approval]);
  assert.ok(done.ok, JSON.stringify(done));
  assert.deepEqual(destroyPlans()[0]!.args.filter((a) => a.startsWith("-target=")).sort(), honest.deletes.map((d) => "-target=" + d.address).sort());

  // A state whose id for a created resource would be rewritten on the way to the API: observed as unaddressable, and no proposal is made from it.
  const crooked = RG + "/providers/Microsoft.Storage/storageAccounts/a\\..\\..\\..\\b";
  const w2 = world();
  behave({ showResources: [...CREATES, change("azurerm_storage_account.crooked", "azurerm_storage_account", ["create"])], stateResources: [...STATE, azureStateResource("azurerm_storage_account", "crooked", crooked)] });
  const applied2 = await applied(w2);
  const observation = await observeRun(applied2.s.sealed.artifactSha256, observeDeps(w2));
  assert.ok(observation.ok);
  assert.deepEqual(observation.record.resources.find((r) => r.address === "azurerm_storage_account.crooked")?.reason, "NOT_AN_ARM_RESOURCE_ID");
  assert.ok(w2.arm.calls.every((c) => !c.url.includes("\\") && !decodeURIComponent(new URL(c.url).pathname).includes("..")), "nothing was requested under a rewritten path");
  const records = await loadRunRecords(applied2.s.sealed.artifactSha256, w2.dirs.evidence);
  assert.ok(records.ok);
  const built = build(w2, applied2.s, records);
  refused(built, "OWNERSHIP_AMBIGUOUS");
  assert.match((built as { message: string }).message, /cannot be read exactly as written/);
  // An Azure entry with no id at all cannot be classified (a container? a scope? the backend?), so it is refused, never proposed as unverifiable.
  const noId = { ...run.records, observation: { ...run.records.observation, resources: run.records.observation.resources.map((r) => (r.address === "azurerm_log_analytics_workspace.pilot" ? { ...r, result: "UNVERIFIABLE" as const, reason: "NO_IDENTIFIER_IN_STATE" } : r)) } };
  refused(build(w, run.s, noId as never), "OBSERVATION_INCONCLUSIVE");
});

test("Azure cleanup interrupted: an apply that did not succeed makes no proposal, and a cleanup the engine fails part-way records PARTIAL_REQUIRES_REVIEW, spends the proposal, and leaves the leftover check pending or present, never complete", async () => {
  // The apply failed after it started: what it created cannot be told from the state alone.
  const failed = world();
  behave({ applyExit: 1, applyStderr: "Error: something failed CANARY_ENGINE_ERROR" });
  const s = await seal(failed);
  const result = await apply(failed, s);
  refused(result, "APPLY_FAILED");
  assert.equal((result as { outcome?: string }).outcome, "PARTIAL_REQUIRES_REVIEW");
  const records = await loadRunRecords(s.sealed.artifactSha256, failed.dirs.evidence);
  if (records.ok) refused(build(failed, s, records), "OWNERSHIP_AMBIGUOUS");
  else assert.equal(records.code, "RUN_RECORD_MISSING", JSON.stringify(records));
  assert.equal(failed.arm.calls.length, 0, "nothing is read for a run that is reviewed by hand");

  // The cleanup's engine fails after it started.
  const w = world();
  const run = await proposed(w);
  behave({ applyExit: 1, applyStderr: "Error: something failed CANARY_ENGINE_ERROR", destroyKeeps: ["azurerm_log_analytics_workspace.pilot"] });
  const partial = await cleanup(w, run);
  refused(partial, "APPLY_FAILED");
  assert.equal((partial as { outcome?: string }).outcome, "PARTIAL_REQUIRES_REVIEW");
  assert.ok(!JSON.stringify(partial).includes("CANARY_ENGINE_ERROR"), "engine output is withheld");
  assert.equal((await readCleanupEvidence(run.proposal.proposalSha256, w.dirs.evidence))?.outcome, "PARTIAL_REQUIRES_REVIEW");
  refused(await cleanup(w, run), "PROPOSAL_ALREADY_EXECUTED");
  cloud(w, { existing: [LAW, ...RETAINED], tagged: [RG, LAW] });
  const leftovers = await verifyProposalLeftovers(run.proposal, observeDeps(w, new Date(NOW.getTime() + 600_000)));
  assert.ok(leftovers.ok);
  assert.equal(leftovers.record.disposition, "INCOMPLETE");
  const byAddress = new Map(leftovers.record.resources.map((r) => [r.address, r]));
  assert.deepEqual([byAddress.get("azurerm_log_analytics_workspace.pilot")!.disposition, byAddress.get("azurerm_log_analytics_workspace.pilot")!.basis], ["DELETION_PENDING", "CLEANUP_NOT_FINISHED"], "the cleanup did not finish, so a present resource is pending a person's review, not a leftover of a finished cleanup");
  assert.deepEqual([byAddress.get("azurerm_resource_group.pilot")!.disposition, byAddress.get("azurerm_resource_group.pilot")!.owner], ["INTENTIONALLY_RETAINED", "PILOT_OWNER"], "the group was never on the list");
  assert.match(leftovers.record.nextAction, /PARTIAL_REQUIRES_REVIEW.*by hand/);
  noTokenIn(w, leftovers.record, partial);
});

test("Azure identity, authorization and deployment-history objects are never deleted: role assignments, role definitions, user-assigned identities, azuread objects and deployments this run created are kept as PROTECTED_IDENTITY or PROTECTED_DEPLOYMENT by type or by the ARM type of their id (azapi_resource), a destroy plan that would take one along stops before any approval is consumed, and a forged proposal naming one never executes", async () => {
  const GUID = "33333333-cccc-4ccc-8ccc-333333333333";
  const NEW_ROLE = RG + "/providers/Microsoft.Authorization/roleAssignments/" + GUID;
  const ROLE_DEF = "/subscriptions/" + SUB + "/providers/Microsoft.Authorization/roleDefinitions/44444444-dddd-4ddd-8ddd-444444444444";
  const UAI = RG + "/providers/Microsoft.ManagedIdentity/userAssignedIdentities/alz-pilot-uai";
  const AZAPI_GRANT = RG + "/providers/Microsoft.Authorization/roleAssignments/55555555-eeee-4eee-8eee-555555555555";
  const DEPLOYMENT = RG + "/providers/Microsoft.Resources/deployments/alz-pilot-template";
  const AZAPI_DEPLOYMENT = "/subscriptions/" + SUB + "/providers/Microsoft.Resources/deployments/alz-pilot-azapi-deploy";
  const DATA = RG + "/providers/Microsoft.Storage/storageAccounts/alzpilotdata";
  const SP = "/servicePrincipals/00000000-0000-4000-8000-000000000002";
  // Extension scopes and the rest of Microsoft.Authorization (review 6409512569, B1 and B2): a role assignment on the workspace, a PIM
  // eligibility request at resource scope, a deployment at resource scope and at management-group scope, a policy assignment and a lock.
  const EXT_GRANT = LAW + "/providers/Microsoft.Authorization/roleAssignments/66666666-ffff-4fff-8fff-666666666666";
  const PIM = DATA + "/providers/Microsoft.Authorization/roleEligibilityScheduleRequests/77777777-aaaa-4aaa-8aaa-777777777777";
  const RES_DEPLOYMENT = DATA + "/providers/Microsoft.Resources/deployments/alz-pilot-resource-deploy";
  const MG_DEPLOYMENT = "/providers/Microsoft.Management/managementGroups/mg-platform/providers/Microsoft.Resources/deployments/alz-pilot-mg-deploy";
  // A policy assignment at a management group: never a scope the pilot contract owns, so it stays an authorization object the cleanup keeps.
  // (A run-created assignment at the target subscription's own scopes is a reviewed run-created policy since owner decision item 2 (c);
  // test/apply-cleanup-policies.test.ts proves it is deleted and every other policy object kept.)
  const POLICY_ASSIGNED = "/providers/Microsoft.Management/managementGroups/mg-platform/providers/Microsoft.Authorization/policyAssignments/alz-pilot-policy";
  const LOCK = RG + "/providers/Microsoft.Authorization/locks/alz-pilot-lock";
  const AZAPI_POLICY = DATA + "/providers/Microsoft.Authorization/policyExemptions/alz-pilot-exemption";
  const creates = [...withoutSecret(CREATES),
    change("azurerm_role_assignment.pilot", "azurerm_role_assignment", ["create"]), change("azurerm_role_definition.pilot", "azurerm_role_definition", ["create"]), change("azurerm_user_assigned_identity.pilot", "azurerm_user_assigned_identity", ["create"]),
    change("azuread_service_principal.pilot", "azuread_service_principal", ["create"]), change("azapi_resource.grant", "azapi_resource", ["create"]),
    change("azurerm_resource_group_template_deployment.pilot", "azurerm_resource_group_template_deployment", ["create"]), change("azapi_resource.deploy", "azapi_resource", ["create"]),
    change("azurerm_storage_account.data", "azurerm_storage_account", ["create"]),
    change("azapi_resource.ext_grant", "azapi_resource", ["create"]), change("azurerm_pim_eligible_role_assignment.pilot", "azurerm_pim_eligible_role_assignment", ["create"]),
    change("azapi_resource.res_deploy", "azapi_resource", ["create"]), change("azapi_resource.mg_deploy", "azapi_resource", ["create"]),
    change("azurerm_management_group_policy_assignment.pilot", "azurerm_management_group_policy_assignment", ["create"]), change("azurerm_management_lock.pilot", "azurerm_management_lock", ["create"]),
    change("azapi_resource.exemption", "azapi_resource", ["create"])];
  const state = [...withoutSecret(STATE as { type: string }[]),
    azureStateResource("azurerm_role_assignment", "pilot", NEW_ROLE), azureStateResource("azurerm_role_definition", "pilot", ROLE_DEF), azureStateResource("azurerm_user_assigned_identity", "pilot", UAI),
    azureStateResource("azuread_service_principal", "pilot", SP), azureStateResource("azapi_resource", "grant", AZAPI_GRANT),
    azureStateResource("azurerm_resource_group_template_deployment", "pilot", DEPLOYMENT), azureStateResource("azapi_resource", "deploy", AZAPI_DEPLOYMENT), azureStateResource("azurerm_storage_account", "data", DATA),
    azureStateResource("azapi_resource", "ext_grant", EXT_GRANT), azureStateResource("azurerm_pim_eligible_role_assignment", "pilot", PIM), azureStateResource("azapi_resource", "res_deploy", RES_DEPLOYMENT),
    azureStateResource("azapi_resource", "mg_deploy", MG_DEPLOYMENT), azureStateResource("azurerm_management_group_policy_assignment", "pilot", POLICY_ASSIGNED), azureStateResource("azurerm_management_lock", "pilot", LOCK),
    azureStateResource("azapi_resource", "exemption", AZAPI_POLICY)];
  const existing = [...EXISTING, NEW_ROLE, ROLE_DEF, UAI, AZAPI_GRANT, DEPLOYMENT, AZAPI_DEPLOYMENT, DATA, EXT_GRANT, PIM, RES_DEPLOYMENT, POLICY_ASSIGNED, LOCK, AZAPI_POLICY];
  const w = world({ existing, tagged: [...TAGGED, UAI, DATA] });
  behave({ showResources: admitted(creates), stateResources: state });
  const run = await proposed(w);
  assert.deepEqual(run.proposal.deletes.map((d) => d.address), ["azurerm_log_analytics_workspace.pilot", "azurerm_storage_account.data"], "only plain run-owned resources are proposed");
  const kept = new Map(run.proposal.excluded.map((x) => [x.address, x]));
  for (const address of ["azurerm_role_assignment.pilot", "azurerm_role_definition.pilot", "azurerm_user_assigned_identity.pilot", "azuread_service_principal.pilot", "azapi_resource.grant",
    "azapi_resource.ext_grant", "azurerm_pim_eligible_role_assignment.pilot", "azurerm_management_group_policy_assignment.pilot", "azurerm_management_lock.pilot", "azapi_resource.exemption"]) {
    assert.equal(kept.get(address)?.ownership, "PROTECTED_IDENTITY", address);
    assert.equal(kept.get(address)?.retainedBy, "PILOT_OWNER", address);
    assert.match(kept.get(address)!.reason, /never deleted by a cleanup, directly or as a dependent/, address);
  }
  for (const address of ["azurerm_resource_group_template_deployment.pilot", "azapi_resource.deploy", "azapi_resource.res_deploy", "azapi_resource.mg_deploy"]) {
    assert.equal(kept.get(address)?.ownership, "PROTECTED_DEPLOYMENT", address + ": deployment history, by type or by the ARM type of the id, at any scope");
    assert.equal(kept.get(address)?.retainedBy, "PILOT_OWNER", address);
    assert.match(kept.get(address)!.reason, /deployment history.*never deleted by a cleanup/, address);
  }
  assert.ok(!run.proposal.risks.some((r) => /template deployed|template_deployment/.test(r)), "no deployment is proposed, so no deployment deletion risk is named");
  const approval = cleanupApproval(run.proposal, "alice");
  // Indirect deletion: the destroy plan would take an identity or a deployment along. Refused before anything is consumed, naming the policy.
  for (const [address, type, what, cls] of [
    ["azurerm_role_assignment.pilot", "azurerm_role_assignment", "an identity or authorization object", "PROTECTED_IDENTITY"],
    ["azapi_resource.grant", "azapi_resource", "an identity or authorization object", "PROTECTED_IDENTITY"],
    ["azurerm_resource_group_template_deployment.pilot", "azurerm_resource_group_template_deployment", "deployment history", "PROTECTED_DEPLOYMENT"],
    ["azapi_resource.deploy", "azapi_resource", "deployment history", "PROTECTED_DEPLOYMENT"],
    ["azapi_resource.ext_grant", "azapi_resource", "an identity or authorization object", "PROTECTED_IDENTITY"],
    ["azurerm_pim_eligible_role_assignment.pilot", "azurerm_pim_eligible_role_assignment", "an identity or authorization object", "PROTECTED_IDENTITY"],
    ["azapi_resource.res_deploy", "azapi_resource", "deployment history", "PROTECTED_DEPLOYMENT"],
    ["azapi_resource.mg_deploy", "azapi_resource", "deployment history", "PROTECTED_DEPLOYMENT"],
    ["azurerm_management_group_policy_assignment.pilot", "azurerm_management_group_policy_assignment", "an identity or authorization object", "PROTECTED_IDENTITY"],
    ["azurerm_management_lock.pilot", "azurerm_management_lock", "an identity or authorization object", "PROTECTED_IDENTITY"],
    ["azapi_resource.exemption", "azapi_resource", "an identity or authorization object", "PROTECTED_IDENTITY"],
    // A dependent the state does not even hold is classified by its type alone.
    ["azurerm_role_assignment.appeared", "azurerm_role_assignment", "an identity or authorization object", "PROTECTED_IDENTITY"],
    ["azurerm_management_lock.appeared", "azurerm_management_lock", "an identity or authorization object", "PROTECTED_IDENTITY"],
  ] as const) {
    await destroyPlanRefused(w, run, [approval], creates, state, address, type,
      new RegExp("would delete " + address.replace(".", "\\.") + ", " + what + ", which a pilot cleanup never deletes, directly or as a dependent \\(" + cls + "\\)"));
    assert.deepEqual([destroyPlans().length, applyCalls().length], [1, 0], address + ": planned, then stopped; no destroy was applied");
  }
  assert.deepEqual(readdirSync(w.dirs.evidence).filter((n) => n.endsWith(CLEANUP_SUFFIX)), []);
  // Forged proposals adding any of them never execute.
  const row = (address: string, type: string, identifier: string) => ({ address, type, identifier, ownership: "RUN_CREATED" as const, observed: "VERIFIED" as const });
  for (const [address, type, id] of [["azurerm_role_assignment.pilot", "azurerm_role_assignment", NEW_ROLE], ["azurerm_role_definition.pilot", "azurerm_role_definition", ROLE_DEF], ["azurerm_user_assigned_identity.pilot", "azurerm_user_assigned_identity", UAI],
    ["azapi_resource.grant", "azapi_resource", AZAPI_GRANT], ["azurerm_resource_group_template_deployment.pilot", "azurerm_resource_group_template_deployment", DEPLOYMENT], ["azapi_resource.deploy", "azapi_resource", AZAPI_DEPLOYMENT],
    ["azapi_resource.ext_grant", "azapi_resource", EXT_GRANT], ["azurerm_pim_eligible_role_assignment.pilot", "azurerm_pim_eligible_role_assignment", PIM], ["azapi_resource.res_deploy", "azapi_resource", RES_DEPLOYMENT],
    ["azapi_resource.mg_deploy", "azapi_resource", MG_DEPLOYMENT], ["azurerm_management_group_policy_assignment.pilot", "azurerm_management_group_policy_assignment", POLICY_ASSIGNED],
    ["azurerm_management_lock.pilot", "azurerm_management_lock", LOCK], ["azapi_resource.exemption", "azapi_resource", AZAPI_POLICY]] as const) {
    const fields = { ...run.proposal, deletes: [...run.proposal.deletes, row(address, type, id)].sort((a, b) => (a.address < b.address ? -1 : 1)), excluded: run.proposal.excluded.filter((x) => x.address !== address) };
    const forged = reHashedProposal(fields);
    assert.ok(verifyCleanupProposal(forged).ok, address);
    refused(await cleanup(w, run, [cleanupApproval(forged, "alice")], forged), "PROPOSAL_INVALID");
  }
  // The honest plan runs once with the same approval; afterwards every protected object is recorded retained by the pilot owner, and the cleanup is COMPLETE.
  behave({ showResources: admitted(creates), stateResources: state });
  const done = await cleanup(w, run, [approval]);
  assert.ok(done.ok, JSON.stringify(done));
  cloud(w, { existing: [RG, NEW_ROLE, ROLE_DEF, UAI, AZAPI_GRANT, DEPLOYMENT, AZAPI_DEPLOYMENT, EXT_GRANT, PIM, RES_DEPLOYMENT, POLICY_ASSIGNED, LOCK, AZAPI_POLICY, ...RETAINED], tagged: [RG, UAI] });
  const leftovers = await verifyProposalLeftovers(run.proposal, observeDeps(w, new Date(NOW.getTime() + 600_000)));
  assert.ok(leftovers.ok);
  assert.equal(leftovers.record.disposition, "COMPLETE");
  assert.deepEqual(sorted(leftovers.record.resources.filter((r) => /PROTECTED_IDENTITY|PROTECTED_DEPLOYMENT/.test(r.reason ?? "")).map((r) => [r.address, r.disposition, r.owner])),
    sorted([["azuread_application.pilot", "INTENTIONALLY_RETAINED", "PILOT_OWNER"], ["azuread_service_principal.pilot", "INTENTIONALLY_RETAINED", "PILOT_OWNER"], ["azurerm_role_assignment.old", "INTENTIONALLY_RETAINED", "PILOT_OWNER"],
      ["azurerm_role_assignment.pilot", "INTENTIONALLY_RETAINED", "PILOT_OWNER"], ["azurerm_role_definition.pilot", "INTENTIONALLY_RETAINED", "PILOT_OWNER"], ["azurerm_user_assigned_identity.pilot", "INTENTIONALLY_RETAINED", "PILOT_OWNER"],
      ["azapi_resource.grant", "INTENTIONALLY_RETAINED", "PILOT_OWNER"], ["azurerm_resource_group_template_deployment.pilot", "INTENTIONALLY_RETAINED", "PILOT_OWNER"], ["azapi_resource.deploy", "INTENTIONALLY_RETAINED", "PILOT_OWNER"],
      ["azapi_resource.ext_grant", "INTENTIONALLY_RETAINED", "PILOT_OWNER"], ["azurerm_pim_eligible_role_assignment.pilot", "INTENTIONALLY_RETAINED", "PILOT_OWNER"], ["azapi_resource.res_deploy", "INTENTIONALLY_RETAINED", "PILOT_OWNER"],
      ["azapi_resource.mg_deploy", "INTENTIONALLY_RETAINED", "PILOT_OWNER"], ["azurerm_management_group_policy_assignment.pilot", "INTENTIONALLY_RETAINED", "PILOT_OWNER"], ["azurerm_management_lock.pilot", "INTENTIONALLY_RETAINED", "PILOT_OWNER"],
      ["azapi_resource.exemption", "INTENTIONALLY_RETAINED", "PILOT_OWNER"], ["azurerm_subscription_policy_assignment.shared", "INTENTIONALLY_RETAINED", "PILOT_OWNER"]]));
  noTokenIn(w, run.proposal, leftovers.record);
});

test("protectedDeletionIn classifies every planned change by its blueprint entry or type: groups, scopes, the backend, every Microsoft.Authorization and ManagedIdentity pair and every deployment at any scope and in any case are refused, and a plain run-owned resource is not", () => {
  const contract = loadPilotContract(fixtureContractPath) as PilotContract;
  const entry = (address: string, type: string, id: string | null) => ({ address, type, id, arn: null });
  const change = (address: string, type = "azapi_resource", action = "DELETE") => [{ address, type, action }];
  const sub = "/subscriptions/" + SUB;
  const protectedIds: [string, string, string][] = [
    ["a group", RG, "RETAINED_GROUP"], ["a group in another case", RG.toUpperCase(), "RETAINED_GROUP"],
    ["the backend account", STATE_ACCOUNT, "PROTECTED_BACKEND"], ["the group holding the backend, when the state does not name the account", RG_STATE, "RETAINED_GROUP"],
    ["a subscription", sub, "CONTAINS_OTHERS"], ["a management group", "/providers/Microsoft.Management/managementGroups/mg-platform", "CONTAINS_OTHERS"],
    ["a subscription-scoped role assignment", OLD_ROLE, "PROTECTED_IDENTITY"],
    ["a role assignment on a workspace (extension scope)", LAW + "/providers/Microsoft.Authorization/roleAssignments/66666666-ffff-4fff-8fff-666666666666", "PROTECTED_IDENTITY"],
    ["the same in another case", LAW.toUpperCase() + "/PROVIDERS/MICROSOFT.AUTHORIZATION/ROLEASSIGNMENTS/66666666-FFFF-4FFF-8FFF-666666666666", "PROTECTED_IDENTITY"],
    ["a PIM eligibility request at resource scope", LAW + "/providers/Microsoft.Authorization/roleEligibilityScheduleRequests/77777777-aaaa-4aaa-8aaa-777777777777", "PROTECTED_IDENTITY"],
    ["a role definition", sub + "/providers/Microsoft.Authorization/roleDefinitions/44444444-dddd-4ddd-8ddd-444444444444", "PROTECTED_IDENTITY"],
    ["a policy assignment", RG + "/providers/Microsoft.Authorization/policyAssignments/p", "PROTECTED_IDENTITY"],
    ["a policy definition", sub + "/providers/Microsoft.Authorization/policyDefinitions/d", "PROTECTED_IDENTITY"],
    ["a policy exemption at resource scope", LAW + "/providers/Microsoft.Authorization/policyExemptions/e", "PROTECTED_IDENTITY"],
    ["a lock", RG + "/providers/Microsoft.Authorization/locks/l", "PROTECTED_IDENTITY"],
    ["a lock on a resource", LAW + "/providers/Microsoft.Authorization/locks/l", "PROTECTED_IDENTITY"],
    ["a user-assigned identity", RG + "/providers/Microsoft.ManagedIdentity/userAssignedIdentities/u", "PROTECTED_IDENTITY"],
    ["a federated credential under it", RG + "/providers/Microsoft.ManagedIdentity/userAssignedIdentities/u/federatedIdentityCredentials/f", "PROTECTED_IDENTITY"],
    ["a tracked resource under an authorization scope", RG + "/providers/Microsoft.Authorization/roleAssignments/x/providers/Microsoft.Storage/storageAccounts/y", "PROTECTED_IDENTITY"],
    ["a deployment at group scope", RG + "/providers/Microsoft.Resources/deployments/d", "PROTECTED_DEPLOYMENT"],
    ["a deployment at resource scope", LAW + "/providers/Microsoft.Resources/deployments/d", "PROTECTED_DEPLOYMENT"],
    ["a deployment at subscription scope", sub + "/providers/Microsoft.Resources/deployments/d", "PROTECTED_DEPLOYMENT"],
    ["a deployment at management-group scope", "/providers/Microsoft.Management/managementGroups/mg/providers/Microsoft.Resources/deployments/d", "PROTECTED_DEPLOYMENT"],
    ["a deployment in another case", RG + "/providers/microsoft.resources/DEPLOYMENTS/d", "PROTECTED_DEPLOYMENT"],
    // Both pairs are protected; the resource's own kind (the last pair, a deployment) is judged first, and either way nothing is deleted.
    ["a deployment nested under a role-scoped path", RG + "/providers/Microsoft.Authorization/roleAssignments/x/providers/Microsoft.Resources/deployments/d", "PROTECTED_DEPLOYMENT"],
    // Round 2 (review 6410149770, B3): `providers` as a group or resource name is a name, not the keyword; the pairs after it are still judged.
    ["a role assignment in a group named providers", sub + "/resourceGroups/providers/providers/Microsoft.Authorization/roleAssignments/g", "PROTECTED_IDENTITY"],
    ["a lock on a storage account named providers", RG + "/providers/Microsoft.Storage/storageAccounts/providers/providers/Microsoft.Authorization/locks/alz-lock", "PROTECTED_IDENTITY"],
    ["a deployment in a group named providers", sub + "/resourceGroups/providers/providers/Microsoft.Resources/deployments/alz-deploy", "PROTECTED_DEPLOYMENT"],
    ["a group named providers", sub + "/resourceGroups/providers", "RETAINED_GROUP"],
    ["a role assignment on a storage account named providers in a group named providers, mixed case", "/SUBSCRIPTIONS/" + SUB + "/RESOURCEGROUPS/providers/PROVIDERS/Microsoft.Storage/storageAccounts/providers/Providers/microsoft.authorization/roleassignments/g", "PROTECTED_IDENTITY"],
    ["an identity under a nested name of providers", RG + "/providers/Microsoft.Storage/storageAccounts/a/blobServices/providers/providers/Microsoft.ManagedIdentity/userAssignedIdentities/u", "PROTECTED_IDENTITY"],
    // Round 3 (review 6410591513, NB-B): registrations and provider-level scopes are kept, never proposed; an authorization pair under a marketplace scope is an identity.
    ["a provider registration", sub + "/providers/Microsoft.ContainerService", "CONTAINS_OTHERS"],
    ["a feature registration", sub + "/providers/Microsoft.Features/providers/Microsoft.ContainerService/features/AKS-x", "CONTAINS_OTHERS"],
    ["a marketplace scope", "/providers/Microsoft.Marketplace", "CONTAINS_OTHERS"],
    ["a marketplace-scope role assignment", "/providers/Microsoft.Marketplace/providers/Microsoft.Authorization/roleAssignments/g", "PROTECTED_IDENTITY"],
    // Round 1 of #262 (review 6411080437, N1): a managed HSM role assignment or definition, by type and by any id form.
    ["a managed HSM role assignment in the import form", "https://alz-hsm.managedhsm.azure.net///RoleAssignment/55555555-eeee-4eee-8eee-555555555555", "PROTECTED_IDENTITY"],
    ["a managed HSM role assignment in the keys form", "https://alz-hsm.managedhsm.azure.net/keys/RoleAssignment/55555555-eeee-4eee-8eee-555555555555", "PROTECTED_IDENTITY"],
    ["a managed HSM role assignment in the authorization-path form", "https://alz-hsm.managedhsm.azure.net/providers/Microsoft.Authorization/roleAssignments/55555555-eeee-4eee-8eee-555555555555", "PROTECTED_IDENTITY"],
    ["a managed HSM role definition in the import form", "https://alz-hsm.managedhsm.azure.net///RoleDefinition/66666666-ffff-4fff-8fff-666666666666", "PROTECTED_IDENTITY"],
    ["a managed HSM role definition in the authorization-path form", "https://ALZ-HSM.managedhsm.azure.net/providers/Microsoft.Authorization/roleDefinitions/66666666-ffff-4fff-8fff-666666666666", "PROTECTED_IDENTITY"],
  ];
  for (const [label, id, cls] of protectedIds) {
    const refusal = protectedDeletionIn(change("azapi_resource.x"), [entry("azapi_resource.x", "azapi_resource", id)], contract, env());
    assert.ok(refusal !== undefined && refusal.includes("(" + cls + ")"), label + ": " + refusal);
    assert.ok(refusal!.startsWith("The destroy plan would delete azapi_resource.x, "), label);
  }
  // The group holding the backend is PROTECTED_BACKEND when the state names the backend account's ARM id (the more specific class), whatever type recorded either.
  assert.ok(protectedDeletionIn(change("azapi_resource.x"), [entry("azapi_resource.x", "azapi_resource", RG_STATE), entry("azapi_resource.acct", "azapi_resource", STATE_ACCOUNT)], contract, env())?.includes("(PROTECTED_BACKEND)"));
  assert.ok(protectedDeletionIn(change("azapi_resource.acct"), [entry("azapi_resource.acct", "azapi_resource", STATE_ACCOUNT)], contract, env())?.includes("(PROTECTED_BACKEND)"), "the backend account by id, whatever type recorded it");
  // By type alone, for an address the state does not hold.
  for (const [type, cls] of [["azurerm_resource_group", "RETAINED_GROUP"], ["azurerm_role_assignment", "PROTECTED_IDENTITY"], ["azurerm_pim_active_role_assignment", "PROTECTED_IDENTITY"],
    ["azurerm_key_vault_managed_hardware_security_module_role_assignment", "PROTECTED_IDENTITY"], ["azurerm_key_vault_managed_hardware_security_module_role_definition", "PROTECTED_IDENTITY"],
    ["azurerm_subscription_policy_assignment", "PROTECTED_IDENTITY"], ["azurerm_resource_policy_exemption", "PROTECTED_IDENTITY"], ["azurerm_policy_definition", "PROTECTED_IDENTITY"],
    ["azurerm_management_lock", "PROTECTED_IDENTITY"], ["azuread_group", "PROTECTED_IDENTITY"], ["azurerm_subscription_template_deployment", "PROTECTED_DEPLOYMENT"], ["azurerm_template_deployment", "PROTECTED_DEPLOYMENT"],
    ["azurerm_management_group", "CONTAINS_OTHERS"]] as const) {
    assert.ok(protectedDeletionIn(change("x.y", type), [], contract, env())?.includes("(" + cls + ")"), type);
  }
  // Any action on a protected object is refused, not only a delete; an output line is ignored; a plain run-owned resource passes.
  assert.match(protectedDeletionIn(change("azapi_resource.x", "azapi_resource", "UPDATE"), [entry("azapi_resource.x", "azapi_resource", RG)], contract, env())!, /^The destroy plan would update/);
  assert.equal(protectedDeletionIn([{ address: "output.o", type: "output", action: "DELETE" }], [], contract, env()), undefined);
  assert.equal(protectedDeletionIn(change("azurerm_log_analytics_workspace.pilot", "azurerm_log_analytics_workspace"), [entry("azurerm_log_analytics_workspace.pilot", "azurerm_log_analytics_workspace", LAW)], contract, env()), undefined);
  assert.equal(protectedDeletionIn(change("azurerm_storage_account.data", "azurerm_storage_account"), [entry("azurerm_storage_account.data", "azurerm_storage_account", RG + "/providers/Microsoft.Storage/storageAccounts/alzpilotdata")], contract, env()), undefined);
  assert.equal(protectedDeletionIn(change("azurerm_key_vault_secret.s", "azurerm_key_vault_secret"), [entry("azurerm_key_vault_secret.s", "azurerm_key_vault_secret", SECRET)], contract, env()), undefined, "a data-plane URL is not an ARM id and names no protected type");
  // Positive controls: ordinary resources named `providers`, or inside a group named `providers`, are not protected.
  for (const [label, id] of [
    ["a storage account named providers", RG + "/providers/Microsoft.Storage/storageAccounts/providers"],
    ["a storage account in a group named providers", sub + "/resourceGroups/providers/providers/Microsoft.Storage/storageAccounts/alzinproviders"],
    ["a storage account named providers in a group named providers", sub + "/resourceGroups/providers/providers/Microsoft.Storage/storageAccounts/providers"],
    ["a virtual machine", RG + "/providers/Microsoft.Compute/virtualMachines/alz-vm"],
    ["a type named like a protected one inside a name", RG + "/providers/Microsoft.Storage/storageAccounts/Microsoft.Authorization"],
    ["a deployment script (not a deployment)", RG + "/providers/Microsoft.Resources/deploymentScripts/s"],
  ] as const) assert.equal(protectedDeletionIn(change("azapi_resource.x"), [entry("azapi_resource.x", "azapi_resource", id)], contract, env()), undefined, label);
  // Fail closed: an ARM-shaped id the parser cannot consume in full is never ordinary; the destroy plan stops on it, naming the policy.
  for (const [label, id] of [
    ["an authorization type with no name", RG + "/providers/Microsoft.Authorization/roleAssignments"],
    ["a site named providers with an odd tail", RG + "/providers/Microsoft.Web/sites/providers/Microsoft.Authorization/roleAssignments/g"],
    ["a dotless namespace", RG + "/providers/providers/locks/l"],
    ["a trailing slash", RG + "/providers/Microsoft.Authorization/roleAssignments/g/"],
    ["an empty segment", RG + "/providers//roleAssignments/x"],
    ["a stray segment after the subscription", sub + "/foo/Microsoft.Authorization/roleAssignments/g"],
    ["a bad subscription", "/subscriptions/not-a-guid/providers/Microsoft.Authorization/roleAssignments/g"],
    ["a path the URL parser would rewrite", RG + "/providers/Microsoft.Storage/storageAccounts/a\\..\\b"],
    ["a directory-looking path under a slash", "/servicePrincipals/00000000-0000-4000-8000-000000000002"],
    ["a slash alone", "/"], ["an empty identifier", ""], ["a blank identifier", " "],
    ["a keyword with a zero-width character", RG + "/provid\u200bers/Microsoft.Authorization/roleAssignments/g"],
    ["a subscription with a trailing slash", sub + "/"],
    // Round 3 (NB-A): an id that is not an ARM path and not a known data-plane URL may name an ARM object the parser never saw.
    ["a role assignment under the management host", "https://management.azure.com" + RG + "/providers/Microsoft.Authorization/roleAssignments/g"],
    ["a deployment under the management host", "https://management.azure.com" + RG + "/providers/Microsoft.Resources/deployments/d"],
    ["a role assignment with a leading space", " " + RG + "/providers/Microsoft.Authorization/roleAssignments/g"],
    ["a bare GUID on an azapi resource", "33333333-cccc-4ccc-8ccc-333333333333"],
    ["another URL", "https://example.invalid/" + SUB + "/roleAssignments/g"],
    ["a management-host URL with a vault-like path", "https://management.azure.com/secrets/x"],
    // Round 1 of #262 (review 6411080437, B1): a data-plane URL shape on a type that does not record one, or with an authorization or deployment path in it.
    ["a vault-host URL with a role-assignment path on an azapi resource", "https://alz-kv.vault.azure.net/providers/Microsoft.Authorization/roleAssignments/55555555-eeee-4eee-8eee-555555555555"],
    ["a storage-host URL with a role-assignment path on an azapi resource", "https://alzdata.blob.core.windows.net" + RG + "/providers/Microsoft.Authorization/roleAssignments/55555555-eeee-4eee-8eee-555555555555"],
    ["a storage-host URL with a deployment path on an azapi resource", "https://alzdata.blob.core.windows.net" + RG + "/providers/Microsoft.Resources/deployments/d"],
    ["a plain vault secret URL on an azapi resource", SECRET],
    ["a plain storage container URL on an azapi resource", "https://alzpilotdata.blob.core.windows.net/logs"],
    // N4: an empty provider block anywhere but a registration scope.
    ["a provider block with no pair under a resource group", RG + "/providers/Microsoft.Compute"],
    ["a provider block with no pair after a resource", LAW + "/providers/Microsoft.Resources"],
  ] as const) {
    const refusal = protectedDeletionIn(change("azapi_resource.x"), [entry("azapi_resource.x", "azapi_resource", id)], contract, env());
    assert.ok(refusal !== undefined && refusal.includes("(OWNERSHIP_AMBIGUOUS)") && refusal.includes("does not parse as an ARM id"), label + ": " + refusal);
  }
  // The two data-plane URL shapes stay ordinary, judged by their type alone: a storage container, a key vault secret, a managed HSM key.
  for (const [label, type, id] of [
    ["a storage container", "azurerm_storage_container", "https://alzpilotdata.blob.core.windows.net/logs"],
    ["a key vault secret", "azurerm_key_vault_secret", SECRET],
    ["a managed HSM key", "azurerm_key_vault_managed_hardware_security_module_key", "https://alz-hsm.managedhsm.azure.net/keys/k/1"],
    ["a storage blob", "azurerm_storage_blob", "https://alzpilotdata.blob.core.windows.net/logs/2026/01.log"],
    ["a key vault certificate", "azurerm_key_vault_certificate", "https://alz-pilot-kv.vault.azure.net/certificates/c/0123456789abcdef"],
  ] as const) assert.equal(protectedDeletionIn(change(type + ".x", type), [entry(type + ".x", type, id)], contract, env()), undefined, label);
  // The URL must be the family its type records: a vault URL on a storage type, a storage URL on a vault type, a managed HSM URL on a key vault type, or a vault URL on a managed HSM key.
  for (const [label, type, id] of [
    ["a vault URL on a storage container", "azurerm_storage_container", SECRET],
    ["a storage URL on a key vault secret", "azurerm_key_vault_secret", "https://alzpilotdata.blob.core.windows.net/logs"],
    ["a managed HSM URL on a key vault key", "azurerm_key_vault_key", "https://alz-hsm.managedhsm.azure.net/keys/k/1"],
    ["a vault URL on a managed HSM key", "azurerm_key_vault_managed_hardware_security_module_key", "https://alz-pilot-kv.vault.azure.net/keys/k/1"],
    ["a storage URL with a providers segment on a storage container", "azurerm_storage_container", "https://alzpilotdata.blob.core.windows.net/providers/x"],
  ] as const) {
    const refusal = protectedDeletionIn(change(type + ".x", type), [entry(type + ".x", type, id)], contract, env());
    assert.ok(refusal !== undefined && refusal.includes("(OWNERSHIP_AMBIGUOUS)"), label + ": " + refusal);
  }
});

test("ARM ids are classified by position (review 6410149770, B3): an authorization object, a lock and a deployment under a group or a storage account named providers are kept, a destroy plan that would take one along stops, a forged proposal naming one never executes, an id the parser cannot consume in full makes no proposal and stops any destroy plan, and ordinary resources named providers are still proposed, verified and cleaned up", async () => {
  const sub = "/subscriptions/" + SUB;
  const RG_P = sub + "/resourceGroups/providers";
  const ROLE_P = RG_P + "/providers/Microsoft.Authorization/roleAssignments/88888888-bbbb-4bbb-8bbb-888888888888";
  const SA_P = RG + "/providers/Microsoft.Storage/storageAccounts/providers";
  const LOCK_P = SA_P + "/providers/Microsoft.Authorization/locks/alz-lock";
  const DEPLOY_P = RG_P + "/providers/Microsoft.Resources/deployments/alz-deploy";
  const SA_IN_P = RG_P + "/providers/Microsoft.Storage/storageAccounts/alzinproviders";
  const VM = RG + "/providers/Microsoft.Compute/virtualMachines/alz-vm";
  const creates = [...withoutSecret(CREATES),
    change("azurerm_resource_group.providers", "azurerm_resource_group", ["create"]), change("azapi_resource.role_in_providers", "azapi_resource", ["create"]),
    change("azurerm_storage_account.providers", "azurerm_storage_account", ["create"]), change("azapi_resource.lock_on_providers", "azapi_resource", ["create"]),
    change("azapi_resource.deploy_in_providers", "azapi_resource", ["create"]), change("azurerm_storage_account.in_providers", "azurerm_storage_account", ["create"]),
    change("azurerm_linux_virtual_machine.pilot", "azurerm_linux_virtual_machine", ["create"])];
  const state = [...withoutSecret(STATE as { type: string }[]),
    azureStateResource("azurerm_resource_group", "providers", RG_P), azureStateResource("azapi_resource", "role_in_providers", ROLE_P),
    azureStateResource("azurerm_storage_account", "providers", SA_P), azureStateResource("azapi_resource", "lock_on_providers", LOCK_P),
    azureStateResource("azapi_resource", "deploy_in_providers", DEPLOY_P), azureStateResource("azurerm_storage_account", "in_providers", SA_IN_P),
    azureStateResource("azurerm_linux_virtual_machine", "pilot", VM)];
  const existing = [...EXISTING, RG_P, ROLE_P, SA_P, LOCK_P, DEPLOY_P, SA_IN_P, VM];
  const w = world({ existing, tagged: [...TAGGED, RG_P, SA_P, SA_IN_P, VM] });
  behave({ showResources: admitted(creates), stateResources: state });
  const run = await proposed(w);
  const deletes = new Map(run.proposal.deletes.map((d) => [d.address, d]));
  assert.deepEqual([...deletes.keys()].sort(), ["azurerm_linux_virtual_machine.pilot", "azurerm_log_analytics_workspace.pilot", "azurerm_storage_account.in_providers", "azurerm_storage_account.providers"],
    "ordinary resources, named providers or inside a group named providers, are proposed; nothing else is");
  for (const d of deletes.values()) assert.equal(d.observed, "VERIFIED", d.address + ": the reader addressed it by its parsed type");
  const kept = new Map(run.proposal.excluded.map((x) => [x.address, x]));
  assert.equal(kept.get("azapi_resource.role_in_providers")?.ownership, "PROTECTED_IDENTITY");
  assert.equal(kept.get("azapi_resource.lock_on_providers")?.ownership, "PROTECTED_IDENTITY");
  assert.equal(kept.get("azapi_resource.deploy_in_providers")?.ownership, "PROTECTED_DEPLOYMENT");
  assert.equal(kept.get("azurerm_resource_group.providers")?.ownership, "RETAINED_GROUP");
  for (const address of ["azapi_resource.role_in_providers", "azapi_resource.lock_on_providers", "azapi_resource.deploy_in_providers", "azurerm_resource_group.providers"]) assert.equal(kept.get(address)?.retainedBy, "PILOT_OWNER", address);
  const approval = cleanupApproval(run.proposal, "alice");
  // A destroy plan that would take one along stops before any approval is consumed.
  for (const [address, cls] of [["azapi_resource.role_in_providers", "PROTECTED_IDENTITY"], ["azapi_resource.lock_on_providers", "PROTECTED_IDENTITY"], ["azapi_resource.deploy_in_providers", "PROTECTED_DEPLOYMENT"], ["azurerm_resource_group.providers", "RETAINED_GROUP"]] as const) {
    await destroyPlanRefused(w, run, [approval], creates, state, address, address.split(".")[0]!,
      new RegExp("would delete " + address.replace(".", "\\.") + ", .*never deletes, directly or as a dependent \\(" + cls + "\\)"));
    assert.deepEqual([destroyPlans().length, applyCalls().length], [1, 0], address);
  }
  // A forged proposal naming one never executes.
  for (const [address, type, id] of [["azapi_resource.role_in_providers", "azapi_resource", ROLE_P], ["azapi_resource.lock_on_providers", "azapi_resource", LOCK_P], ["azapi_resource.deploy_in_providers", "azapi_resource", DEPLOY_P], ["azurerm_resource_group.providers", "azurerm_resource_group", RG_P]] as const) {
    const fields = { ...run.proposal, deletes: [...run.proposal.deletes, { address, type, identifier: id, ownership: "RUN_CREATED" as const, observed: "VERIFIED" as const }].sort((a, b) => (a.address < b.address ? -1 : 1)), excluded: run.proposal.excluded.filter((x) => x.address !== address) };
    const forged = reHashedProposal(fields);
    assert.ok(verifyCleanupProposal(forged).ok, address);
    behave({ showResources: admitted(creates), stateResources: state });
    refused(await cleanup(w, run, [cleanupApproval(forged, "alice")], forged), "PROPOSAL_INVALID");
    assert.equal(applyCalls().length, 0, address);
  }
  // Fail closed: a state id the parser cannot consume in full is observed as not addressable and makes no proposal; a plan that would delete it stops.
  for (const [label, id] of [
    ["an authorization type with no name", RG + "/providers/Microsoft.Authorization/roleAssignments"],
    ["a site named providers with an odd tail", RG + "/providers/Microsoft.Web/sites/providers/Microsoft.Authorization/roleAssignments/g"],
    ["a dotless namespace", RG + "/providers/providers/locks/l"],
    // Round 3 (NB-A): the reviewer's three ids, which the reader cannot address and the classifier never reads as ordinary.
    ["a role assignment under the management host", "https://management.azure.com" + RG + "/providers/Microsoft.Authorization/roleAssignments/44444444-dddd-4ddd-8ddd-444444444444"],
    ["a role assignment with a leading space", " " + RG + "/providers/Microsoft.Authorization/roleAssignments/44444444-dddd-4ddd-8ddd-444444444444"],
    ["a deployment under the management host", "https://management.azure.com" + RG + "/providers/Microsoft.Resources/deployments/alz-deploy"],
    // Round 1 of #262 (B1): data-plane URL shapes on an azapi resource, with an authorization or deployment path.
    ["a vault-host URL with a role-assignment path", "https://alz-kv.vault.azure.net/providers/Microsoft.Authorization/roleAssignments/55555555-eeee-4eee-8eee-555555555555"],
    ["a storage-host URL with a role-assignment path", "https://alzdata.blob.core.windows.net" + RG + "/providers/Microsoft.Authorization/roleAssignments/55555555-eeee-4eee-8eee-555555555555"],
    ["a storage-host URL with a deployment path", "https://alzdata.blob.core.windows.net" + RG + "/providers/Microsoft.Resources/deployments/d"],
  ] as const) {
    const w2 = world({ existing: EXISTING, tagged: TAGGED });
    behave({ showResources: withoutSecret(CREATES), stateResources: [...withoutSecret(STATE as { type: string }[]), azureStateResource("azapi_resource", "odd", id)] });
    const applied2 = await applied(w2);
    const observation = await observeRun(applied2.s.sealed.artifactSha256, observeDeps(w2));
    assert.ok(observation.ok, label);
    assert.equal(observation.record.resources.find((r) => r.address === "azapi_resource.odd")?.reason, "NOT_AN_ARM_RESOURCE_ID", label);
    const records = await loadRunRecords(applied2.s.sealed.artifactSha256, w2.dirs.evidence);
    assert.ok(records.ok);
    const built = build(w2, applied2.s, records);
    refused(built, "OWNERSHIP_AMBIGUOUS");
    assert.match((built as { message: string }).message, /azapi_resource\.odd that is not a resource id the cleanup can classify exactly/, label);
    // The same address appearing as a dependent of an honest proposal's destroy plan (it was never in the observed blueprint, so it has
    // no id to classify) stops the cleanup as an unlisted resource before any approval is consumed; the id itself is refused by
    // protectedDeletionIn directly (the table test above), and a state that holds it never reaches a proposal at all.
    behave({ showResources: admitted(creates), stateResources: [...state, azureStateResource("azapi_resource", "odd", id)], destroyExtra: [{ address: "azapi_resource.odd", type: "azapi_resource", change: { actions: ["delete"], before: {}, after: null } }] });
    const taken = await cleanup(w, run, [cleanupApproval(run.proposal, "bob")]);
    // Review of #327, B2: azapi is not admitted, so the plan judge refuses this destroy plan first, before the scope check; the scope
    // check's own refusal of the unlisted dependent is asserted on `cleanupScopeProblem`, the function the driver runs next.
    assert.equal(taken.ok, false, label);
    assert.match((taken as { message: string }).message, /PROVIDER_NOT_ADMITTED/, label);
    const scope = cleanupScopeProblem([...run.proposal.deletes.map((d) => ({ address: d.address, type: d.type, action: "DELETE" as const })), { address: "azapi_resource.odd", type: "azapi_resource", action: "DELETE" as const }],
      run.proposal.deletes.map((d) => d.address));
    assert.match(scope + " Nothing was destroyed and no approval was consumed.", /the proposal does not list \(azapi_resource\.odd\).*Nothing was destroyed and no approval was consumed/, label);
    assert.equal(applyCalls().length, 0, label);
  }
  behave({ showResources: admitted(creates), stateResources: state });
  const done = await cleanup(w, run, [approval]);
  assert.ok(done.ok, JSON.stringify(done));
  assert.deepEqual(destroyPlans()[0]!.args.filter((a) => a.startsWith("-target=")).sort(), [...deletes.keys()].sort().map((a) => "-target=" + a));
  cloud(w, { existing: [...RETAINED, RG_P, ROLE_P, LOCK_P, DEPLOY_P], tagged: [RG, RG_P] });
  const leftovers = await verifyProposalLeftovers(run.proposal, observeDeps(w, new Date(NOW.getTime() + 600_000)));
  assert.ok(leftovers.ok);
  assert.equal(leftovers.record.disposition, "COMPLETE", JSON.stringify(leftovers.record).slice(0, 3000));
  const dispositions = new Map(leftovers.record.resources.map((r) => [r.address, r.disposition]));
  for (const address of deletes.keys()) assert.equal(dispositions.get(address), "CONFIRMED_DELETED", address);
  for (const address of ["azapi_resource.role_in_providers", "azapi_resource.lock_on_providers", "azapi_resource.deploy_in_providers", "azurerm_resource_group.providers"]) assert.equal(dispositions.get(address), "INTENTIONALLY_RETAINED", address);
  noTokenIn(w, run.proposal, leftovers.record);

});

test("an observation record written with the earlier version's groups field is refused on read-back, so no cleanup is proposed from it until the run is observed again", async () => {
  const w = world();
  behave({ showResources: withoutSecret(CREATES), stateResources: withoutSecret(STATE as { type: string }[]) });
  const { s } = await applied(w);
  const observed = await observeRun(s.sealed.artifactSha256, observeDeps(w));
  assert.ok(observed.ok);
  const applyEvidenceSha256 = observed.record.applyEvidenceSha256;
  assert.ok(await readObservationRecord(s.sealed.artifactSha256, applyEvidenceSha256, w.dirs.evidence), "the record as written reads back");
  // The same record as the containment-based version wrote it: with the group contents it listed.
  const legacy = { ...observed.record, groups: [{ address: "azurerm_resource_group.pilot", identifier: RG, members: [LAW], complete: true }] };
  const { key } = await ensureEvidenceKey();
  writeFileSync(join(w.dirs.evidence, s.sealed.artifactSha256 + OBSERVATION_SUFFIX), JSON.stringify(encryptEvidence("apply-observation", legacy, key)) + "\n", { mode: 0o600 });
  assert.equal(await readObservationRecord(s.sealed.artifactSha256, applyEvidenceSha256, w.dirs.evidence), undefined, "a record carrying groups is not an observation record");
  const records = await loadRunRecords(s.sealed.artifactSha256, w.dirs.evidence);
  refused(records, "RUN_RECORD_MISSING");
  assert.match((records as { message: string }).message, /has not been observed/);
  // Observing again replaces it, and the proposal follows.
  const again = await observeRun(s.sealed.artifactSha256, observeDeps(w));
  assert.ok(again.ok);
  const fresh2 = await loadRunRecords(s.sealed.artifactSha256, w.dirs.evidence);
  assert.ok(fresh2.ok);
  assert.ok(build(w, s, fresh2).ok);
});

test("Azure listings never change scope while marked complete: a continuation link to another subscription or collection, one that drops, changes, repeats or re-cases the tag filter or API version, one with an extra parameter, a path that only normalizes to the same listing, a continuation under another key, and a malformed page end the listing incomplete or failed, and no observation or leftover check reaches COMPLETE on it", async () => {
  const first = "https://management.azure.com/subscriptions/" + SUB + "/resources?$filter=tagName%20eq%20'alz-unit'%20and%20tagValue%20eq%20'u'&api-version=2021-04-01";
  assert.ok(sameListing(first, first + "&$skiptoken=abc"));
  assert.ok(sameListing(first, first.replace("/subscriptions/", "/SUBSCRIPTIONS/") + "&$skipToken=abc"), "ARM paths are case-insensitive");
  for (const [label, next] of [
    ["another subscription", first.replace(SUB, "99999999-9999-4999-8999-999999999999") + "&$skiptoken=1"],
    ["the filter dropped", "https://management.azure.com/subscriptions/" + SUB + "/resources?api-version=2021-04-01&$skiptoken=1"],
    ["the filter changed", first.replace("'u'", "'v'") + "&$skiptoken=1"],
    ["the API version changed", first.replace("2021-04-01", "2015-01-01") + "&$skiptoken=1"],
    ["an extra parameter", first + "&$expand=all&$skiptoken=1"],
    ["another collection", first.replace("/resources?", "/resourcegroups?") + "&$skiptoken=1"],
    ["another group", "https://management.azure.com" + RG + "/resources?api-version=2021-04-01&$skiptoken=1"],
    ["a fragment", first + "&$skiptoken=1#x"],
    ["plaintext", first.replace("https:", "http:") + "&$skiptoken=1"],
    ["a repeated filter", first + "&$filter=tagName%20eq%20'x'&$skiptoken=1"],
    ["a repeated API version", first + "&$skiptoken=1&api-version=2015-01-01"],
    ["a repeated filter in another key case", first + "&$Filter=tagName%20eq%20'x'&$skiptoken=1"],
    ["a repeated skip token", first + "&$skiptoken=1&$skiptoken=2"],
    ["a repeated API version in another key case", first + "&API-VERSION=2015-01-01&$skiptoken=1"],
    // Path forms that only normalize to the same listing are drift as written: a path is sent exactly as the first page named it or not at all.
    ["a dot-dot segment that normalizes away", first.replace("/resources?", "/x/../resources?") + "&$skiptoken=1"],
    ["a percent-encoded dot-dot segment", first.replace("/resources?", "/x/%2e%2e/resources?") + "&$skiptoken=1"],
    ["a dot segment", first.replace("/resources?", "/./resources?") + "&$skiptoken=1"],
    ["a backslash", first.replace("/resources?", "\\resources?") + "&$skiptoken=1"],
    ["a tab in the path", first.replace("/resources?", "/\tresources?") + "&$skiptoken=1"],
    ["a percent-encoded path character", first.replace("/resources?", "/%72esources?") + "&$skiptoken=1"],
  ] as const) assert.ok(!sameListing(first, next), label);
  assert.ok(!sameListing("https://management.azure.com" + RG + "/resources?api-version=2021-04-01", "https://management.azure.com" + RG_STATE + "/resources?api-version=2021-04-01&$skiptoken=1"), "another group");

  // Through the reader: the first page's ids are kept, the drifted link is never sent, and the listing is incomplete. The sweep
  // reads two collections (resources, then resource groups); a drift on either leaves the whole sweep incomplete.
  const drifts: [string, "resources" | "resourcegroups", (url: string) => unknown][] = [
    ["cross-subscription", "resources", (url) => ({ value: [{ id: LAW }], nextLink: url.replace(SUB, "99999999-9999-4999-8999-999999999999") + "&$skiptoken=1" })],
    ["dropped filter", "resources", (url) => ({ value: [{ id: LAW }], nextLink: url.replace(/\$filter=[^&]*&/, "") + "&$skiptoken=1" })],
    ["changed filter", "resources", (url) => ({ value: [{ id: LAW }], nextLink: url.replace(encodeURIComponent(UNIT.unitId), "other-unit").replace(UNIT.unitId, "other-unit") + "&$skiptoken=1" })],
    ["changed collection", "resourcegroups", (url) => ({ value: [{ id: RG }], nextLink: url.replace("/resourcegroups?", "/resources?") + "&$skiptoken=1" })],
    ["repeated filter", "resources", (url) => ({ value: [{ id: LAW }], nextLink: url + "&$filter=tagName%20eq%20'x'&$skiptoken=1" })],
    ["repeated API version", "resourcegroups", (url) => ({ value: [{ id: RG }], nextLink: url + "&$skiptoken=1&api-version=2015-01-01" })],
    ["a continuation under another key", "resourcegroups", (url) => ({ value: [{ id: RG }], "@odata.nextLink": url + "&$skiptoken=1" })],
    ["a path that only normalizes to the same listing", "resourcegroups", (url) => ({ value: [{ id: RG }], nextLink: url.replace("/resourcegroups?", "/x/../resourcegroups?") + "&$skiptoken=1" })],
  ];
  for (const [label, collection, drift] of drifts) {
    const inner = fakeArmHttp({ tagged: [] });
    const seen: ArmRequest[] = [];
    const hooked = (url: string) => new RegExp("/subscriptions/[^/]+/" + collection + "\\?").test(url) && !url.includes("$skiptoken");
    const http: ArmHttp = async (request) => {
      seen.push(request);
      const answer = await inner.http(request);
      return request.method === "GET" && hooked(request.url) ? { status: 200, body: JSON.stringify(drift(request.url)) } : answer;
    };
    const { reader, close } = createDiscoveryArmReader({ env: env(), subscriptionId: SUB, http });
    const listed = await reader.listTagged(UNIT.unitId);
    assert.deepEqual(listed, { identifiers: [collection === "resources" ? LAW : RG], complete: false }, label);
    assert.ok(seen.every((r) => !r.url.includes("$skiptoken")), label + ": the drifted link was never sent");
    close();
  }
  // Malformed pages fail the listing rather than reading as empty: no `value`, a non-array `value`, an item without an id, a non-object body.
  for (const [label, body] of [["no value", {}], ["value not an array", { value: {} }], ["item without id", { value: [{ name: "x" }] }], ["empty id", { value: [{ id: "" }] }], ["array body", []], ["text", "ok"]] as const) {
    const inner = fakeArmHttp({ tagged: [] });
    const http: ArmHttp = async (request) => (request.method === "GET" && /\/(resources|resourcegroups)\?/.test(request.url) ? { status: 200, body: JSON.stringify(body) } : inner.http(request));
    const { reader, close } = createDiscoveryArmReader({ env: env(), subscriptionId: SUB, http });
    assert.equal(await reader.listTagged(UNIT.unitId), undefined, label);
    close();
  }

  // Through a run: a sweep whose continuation drifts to another subscription is INCOMPLETE at observation and never COMPLETE after the cleanup.
  const drifting = (honest: ArmHttp): ArmHttp => async (request) => {
    const answer = await honest(request);
    if (request.method === "GET" && /\/subscriptions\/[^/]+\/resources\?\$filter/.test(request.url) && !request.url.includes("$skiptoken")) {
      return { status: 200, body: JSON.stringify({ value: [], nextLink: request.url.replace(SUB, "99999999-9999-4999-8999-999999999999") + "&$skiptoken=1" }) };
    }
    return answer;
  };
  const w = world();
  behave({ showResources: withoutSecret(CREATES), stateResources: withoutSecret(STATE as { type: string }[]) });
  const { s } = await applied(w);
  const drifted = await observeRun(s.sealed.artifactSha256, { ...observeDeps(w), arm: drifting(w.arm.http) });
  assert.ok(drifted.ok);
  assert.equal(drifted.record.inventory, "INCOMPLETE");
  assert.equal(drifted.record.verdict, "INCONCLUSIVE");
  const w2 = world();
  behave({ showResources: withoutSecret(CREATES), stateResources: withoutSecret(STATE as { type: string }[]) });
  const run = await proposed(w2);
  assert.ok((await cleanup(w2, run)).ok);
  cloud(w2, { existing: RETAINED, tagged: [] });
  const leftovers = await verifyProposalLeftovers(run.proposal, { ...observeDeps(w2, new Date(NOW.getTime() + 600_000)), arm: drifting(w2.arm.http) });
  assert.ok(leftovers.ok);
  assert.equal(leftovers.record.sweep, "INCOMPLETE");
  assert.notEqual(leftovers.record.disposition, "COMPLETE");
  assert.ok([...w.arm.calls, ...w2.arm.calls].every((c) => !c.url.includes("99999999-9999-4999-8999-999999999999")), "the other subscription was never asked");
});

test("Azure cleanup interrupted at the last check: a stop signal that arrives while the engine plans the destroy stops the cleanup after the plan with nothing destroyed and no approval consumed, and the same approval then runs once", async () => {
  const w = world();
  behave({ showResources: withoutSecret(CREATES), stateResources: withoutSecret(STATE as { type: string }[]) });
  const run = await proposed(w);
  const approval = cleanupApproval(run.proposal, "alice");
  // A person's Ctrl-C arrives while the destroy plan is being made: the plan is made, and nothing more happens.
  behave({ showResources: withoutSecret(CREATES), stateResources: withoutSecret(STATE as { type: string }[]), signalParentOn: { cmd: "plan", signal: "SIGINT" } });
  const interrupted = await cleanup(w, run, [approval]);
  refused(interrupted, "APPLY_FAILED");
  assert.match((interrupted as { message: string }).message, /interrupted by a signal before the engine started/);
  assert.equal(destroyPlans().length, 1, "the destroy was planned");
  assert.equal(applyCalls().length, 0, "no destroy was applied");
  assert.deepEqual(readdirSync(w.dirs.evidence).filter((n) => n.endsWith(CLEANUP_SUFFIX)), [], "nothing was recorded or reserved");
  const readsBefore = w.arm.calls.filter((c) => c.method === "GET").length;
  // The same approval, with nothing in the way: runs once, and the cleanup itself reads nothing from the cloud (the approved list is bound to the records, not re-derived from a listing).
  behave({ showResources: withoutSecret(CREATES), stateResources: withoutSecret(STATE as { type: string }[]) });
  const done = await cleanup(w, run, [approval]);
  assert.ok(done.ok, JSON.stringify(done));
  assert.equal(applyCalls().length, 1);
  assert.equal(w.arm.calls.filter((c) => c.method === "GET").length, readsBefore);
  refused(await cleanup(w, run, [approval]), "PROPOSAL_ALREADY_EXECUTED");
});

test("provider and feature registrations a run made are kept, never proposed (review 6410591513, NB-B), and so are managed HSM role assignments and definitions in every id form (review 6411080437, N1): the proposal still forms, the ordinary resources are cleaned up, and the kept objects are recorded intentionally retained by the pilot owner", async () => {
  const sub = "/subscriptions/" + SUB;
  const REGISTRATION = sub + "/providers/Microsoft.ContainerService";
  const FEATURE = sub + "/providers/Microsoft.Features/providers/Microsoft.ContainerService/features/AKS-ExtensionManager";
  const HSM_IMPORT = "https://alz-hsm.managedhsm.azure.net///RoleAssignment/55555555-eeee-4eee-8eee-555555555555";
  const HSM_KEYS = "https://alz-hsm.managedhsm.azure.net/keys/RoleAssignment/66666666-ffff-4fff-8fff-666666666666";
  const HSM_AUTH = "https://alz-hsm.managedhsm.azure.net/providers/Microsoft.Authorization/roleDefinitions/77777777-aaaa-4aaa-8aaa-777777777777";
  const creates = [...withoutSecret(CREATES), change("azurerm_resource_provider_registration.aks", "azurerm_resource_provider_registration", ["create"]), change("azurerm_resource_provider_feature_registration.ext", "azurerm_resource_provider_feature_registration", ["create"]),
    change("azurerm_key_vault_managed_hardware_security_module_role_assignment.hsm", "azurerm_key_vault_managed_hardware_security_module_role_assignment", ["create"]), change("azapi_resource.hsm_keys", "azapi_resource", ["create"]), change("azapi_resource.hsm_auth", "azapi_resource", ["create"])];
  const state = [...withoutSecret(STATE as { type: string }[]), azureStateResource("azurerm_resource_provider_registration", "aks", REGISTRATION), azureStateResource("azurerm_resource_provider_feature_registration", "ext", FEATURE),
    azureStateResource("azurerm_key_vault_managed_hardware_security_module_role_assignment", "hsm", HSM_IMPORT), azureStateResource("azapi_resource", "hsm_keys", HSM_KEYS), azureStateResource("azapi_resource", "hsm_auth", HSM_AUTH)];
  const w = world({ existing: [...EXISTING, REGISTRATION, FEATURE], tagged: TAGGED });
  behave({ showResources: admitted(creates), stateResources: state });
  const run = await proposed(w);
  assert.deepEqual(run.observation.record.resources.filter((r) => /registration/.test(r.address)).map((r) => [r.address, r.result, r.reason]),
    [["azurerm_resource_provider_feature_registration.ext", "UNVERIFIABLE", "NOT_AN_ARM_RESOURCE_ID"], ["azurerm_resource_provider_registration.aks", "UNVERIFIABLE", "NOT_AN_ARM_RESOURCE_ID"]], "a registration is not a resource the reader asks about");
  assert.ok(!w.arm.calls.some((c) => c.url.includes("Microsoft.ContainerService") || c.url.includes("managedhsm")), "no request was sent for a registration or a managed HSM object");
  assert.deepEqual(run.proposal.deletes.map((d) => d.address), ["azurerm_log_analytics_workspace.pilot"]);
  const kept = new Map(run.proposal.excluded.map((x) => [x.address, x]));
  for (const address of ["azurerm_resource_provider_registration.aks", "azurerm_resource_provider_feature_registration.ext"]) {
    assert.equal(kept.get(address)?.ownership, "CONTAINS_OTHERS", address);
    assert.equal(kept.get(address)?.retainedBy, "PILOT_OWNER", address);
    assert.match(kept.get(address)!.reason, /provider or feature registration/, address);
  }
  for (const address of ["azurerm_key_vault_managed_hardware_security_module_role_assignment.hsm", "azapi_resource.hsm_keys", "azapi_resource.hsm_auth"]) {
    assert.equal(kept.get(address)?.ownership, "PROTECTED_IDENTITY", address + ": a managed HSM role assignment or definition, by type or by any id form");
    assert.equal(kept.get(address)?.retainedBy, "PILOT_OWNER", address);
  }
  // A destroy plan that would take a registration along stops before any approval is consumed.
  const approval = cleanupApproval(run.proposal, "alice");
  behave({ showResources: admitted(creates), stateResources: state, destroyExtra: [{ address: "azurerm_resource_provider_registration.aks", type: "azurerm_resource_provider_registration", change: { actions: ["delete"], before: {}, after: null } }] });
  const taken = await cleanup(w, run, [approval]);
  refused(taken, "PROPOSAL_SCOPE_MISMATCH");
  assert.match((taken as { message: string }).message, /would delete azurerm_resource_provider_registration\.aks, a subscription, management group, provider scope or registration, which a pilot cleanup never deletes.*\(CONTAINS_OTHERS\)/);
  assert.equal(applyCalls().length, 0);
  behave({ showResources: admitted(creates), stateResources: state });
  const done = await cleanup(w, run, [approval]);
  assert.ok(done.ok, JSON.stringify(done));
  cloud(w, { existing: [...RETAINED, REGISTRATION, FEATURE], tagged: [RG] });
  const leftovers = await verifyProposalLeftovers(run.proposal, observeDeps(w, new Date(NOW.getTime() + 600_000)));
  assert.ok(leftovers.ok);
  assert.equal(leftovers.record.disposition, "COMPLETE");
  const dispositions = new Map(leftovers.record.resources.map((r) => [r.address, [r.disposition, r.owner]]));
  for (const address of ["azurerm_key_vault_managed_hardware_security_module_role_assignment.hsm", "azapi_resource.hsm_keys", "azapi_resource.hsm_auth"]) assert.deepEqual(dispositions.get(address), ["INTENTIONALLY_RETAINED", "PILOT_OWNER"], address);
  assert.deepEqual(dispositions.get("azurerm_resource_provider_registration.aks"), ["INTENTIONALLY_RETAINED", "PILOT_OWNER"]);
  assert.deepEqual(dispositions.get("azurerm_resource_provider_feature_registration.ext"), ["INTENTIONALLY_RETAINED", "PILOT_OWNER"]);
  assert.deepEqual(dispositions.get("azurerm_log_analytics_workspace.pilot"), ["CONFIRMED_DELETED", undefined]);
  noTokenIn(w, run.proposal, leftovers.record);
});

test("R1 (Azure): a tenant move refuses the cleanup at propose and at the gate, nothing consumed; the run's full target is bound", async () => {
  const w = world();
  const run = await proposed(w);
  const base = contractJson(KILL) as { targets: Record<string, Record<string, unknown>> };
  const authorizeOnlyCleanup = { DEV: ["CLEANUP"], QA: ["APPLY", "CLEANUP"], PROD: ["APPLY", "CLEANUP"] };
  const moved = { ...base, authorize: authorizeOnlyCleanup, targets: { ...base.targets, DEV: { ...base.targets.DEV, tenantId: "99999999-9999-4999-8999-999999999999" } } };
  assert.equal(run.proposal.targetSha256, pilotTargetSha256(base as never, "DEV"));
  assert.notEqual(pilotTargetSha256(moved as never, "DEV"), run.proposal.targetSha256, "the tenant is part of the target");
  // Propose under the moved contract: refused.
  const reproposed = buildCleanupProposal({ requesterId: REQUESTER.requesterId, ...run.records, changes: run.s.sealed.changes, channel: "CLI", contract: moved as never,
    engineVersion: run.s.sealed.engineVersion, env: w.deps.env!, now: new Date(NOW.getTime() + 120_000) });
  assert.equal(reproposed.ok, false);
  assert.equal((reproposed as { code: string }).code, "TARGET_NOT_IN_CONTRACT");
  // At the gate, with the moved contract committed and named as the proposal's authority: refused, nothing consumed or destroyed.
  writeReviewedContract(w.contractPath, moved);
  const authorized = authorizeContract(moved as never, "DEV", "CLEANUP");
  assert.ok(authorized.ok);
  const forged = reHashedProposal({ ...run.proposal, authorizingContractSha256: authorized.authorization.contractSha256, authorizationSha256: authorized.authorization.authorizationSha256 });
  const approvals = [cleanupApproval(forged, "alice")];
  const result = await cleanup(w, run, approvals, forged);
  assert.equal(result.ok, false);
  assert.equal((result as { code: string }).code, "TARGET_NOT_IN_CONTRACT", JSON.stringify(result));
  assert.deepEqual(consumeApprovals(w.deps.nonces!, approvals), { ok: true }, "nothing was consumed");
  // A subscription move is the same refusal (targetMoved, one comparison for every account field).
  const subscriptionMoved = { ...base, targets: { ...base.targets, DEV: { ...base.targets.DEV, subscriptionId: "88888888-8888-4888-8888-888888888888" } } };
  assert.equal(targetMoved(run.proposal.targetSha256, subscriptionMoved as never, "DEV")?.code, "TARGET_NOT_IN_CONTRACT");
});
