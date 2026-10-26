import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { signApproval } from "../src/apply/approval.js";
import { buildCleanupProposal, computeProposalSha256, verifyCleanupProposal, type CleanupProposal } from "../src/apply/cleanup-proposal.js";
import { CLEANUP_SUFFIX, loadPilotContract, pilotContractSha256 } from "../src/apply/contract.js";
import { runApply, runCleanup, sealPreview, type ApplyDeps, type ApplyRequest } from "../src/apply/driver.js";
import { readCleanupEvidence } from "../src/apply/ledger.js";
import { loadRunRecords, observeRun, verifyProposalLeftovers, type ObserveDeps } from "../src/apply/observe.js";
import { openNonceStore } from "../src/apply/nonces.js";
import { loadSealedPlan } from "../src/apply/seal.js";
import { BLUEPRINT_SUFFIX, readBlueprintRecord } from "../src/apply/run-records.js";
import type { PilotContract, SignedApproval } from "../src/apply/types.js";
import { pilotUnitOf } from "../src/apply/unit.js";
import { armPathSafe, armTypeOf, createDiscoveryArmReader, type ArmHttp, type ArmRequest } from "../src/observe/azure-rest.js";
import { readEncryptedEvidence } from "../src/evidence/vault.js";
import { removeTree } from "../src/teardown/driver/cleanup.js";
import { canonicalJson } from "../src/teardown/manifest.js";
import { sha256 } from "../src/util/sha256.js";
import {
  ARM_ACCESS_TOKEN_CANARY, ARM_FEDERATED_TOKEN_CANARY, CANARIES, DEV_TARGET, NOW, POLICY, SOURCE_COMMIT, STATE_CANARY, approvalFor, azureStateResource, behave as behaveIn, callsOf, contractJson,
  fakeArmHttp, human, identityEnv, installFakeTerraform, keys, pinPathOf, targetOf, testFixtureForgeQualificationEvidence, writePinnedContract, writeProject, type ArmBehavior, type Behavior,
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
/** What each group holds: the run's group holds only the run's workspace; the state group holds the backend and the shared things. */
const GROUPS = { [RG]: [LAW], [RG_STATE]: [STATE_ACCOUNT, REUSED_VAULT, UNRELATED_VNET] };
const CLOUD: ArmBehavior = { existing: EXISTING, tagged: TAGGED, groupMembers: GROUPS };
const RETAINED = [STATE_ACCOUNT, RG_STATE, OLD_ROLE, POLICY_ASSIGNMENT, REUSED_VAULT, UNRELATED_VNET];
const fixtureContractPath = (() => { const path = join(fresh("contract"), "act-pilot-contract.json"); writePinnedContract(path, contractJson(KILL)); return path; })();
const UNIT = pilotUnitOf({ provider: "AZURE", contractSha256: pilotContractSha256(loadPilotContract(fixtureContractPath, pinPathOf(fixtureContractPath)) as PilotContract), environment: "DEV", target: targetOf("DEV") });
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
  writePinnedContract(contractPath, contractJson(KILL));
  const arm = fakeArmHttp(cloudBehavior);
  return {
    dirs, contractPath, arm,
    deps: {
      sourceCommit: SOURCE_COMMIT, contractPath, contractPinPath: pinPathOf(contractPath), qualificationDir: vaultDir, evidenceDir: dirs.evidence, nonces: openNonceStore(dirs.nonces),
      env: env(), now: () => NOW, scratchParent: dirs.scratch, toolDirs: [toolDir], killPollMs: 40, killGraceMs: 400, arm: arm.http,
    },
  };
}
const observeDeps = (w: World, now: Date = new Date(NOW.getTime() + 60_000)): ObserveDeps => ({
  contractPath: w.contractPath, contractPinPath: pinPathOf(w.contractPath), evidenceDir: w.dirs.evidence, env: w.deps.env, toolDirs: w.deps.toolDirs, scratchParent: w.dirs.scratch, now: () => now, arm: w.arm.http,
});
const cloud = (w: World, behavior: ArmBehavior) => w.arm.behave(behavior);

async function seal(w: World) {
  const target = targetOf("DEV");
  const p = writeProject(fresh("project"), target);
  const result = await sealPreview({ invocation: human(target), environment: "DEV", target, manifest: p.manifest, projectRoot: p.projectRoot, policyVersion: POLICY, resolved: p.resolved }, w.deps);
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
const build = (w: World, s: Sealed, records: Awaited<ReturnType<typeof loadRunRecords>> & { ok: true }) => buildCleanupProposal({
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
  return { ...run, observation, records, proposal: built.proposal };
}
const cleanupApproval = (proposal: CleanupProposal, who: keyof typeof keys): SignedApproval => signApproval({
  schemaVersion: 1, artifactSha256: proposal.proposalSha256, environment: proposal.environment, target: proposal.target, approverId: who,
  issuedAt: new Date(NOW.getTime() - 5 * 60_000).toISOString(), expiresAt: new Date(NOW.getTime() + 25 * 60_000).toISOString(), nonce: randomBytes(16).toString("hex"),
}, keys[who].priv, "CLEANUP");
const cleanup = (w: World, run: Awaited<ReturnType<typeof proposed>>, approvals: SignedApproval[] = [cleanupApproval(run.proposal, "alice")], proposal: CleanupProposal = run.proposal) => runCleanup({
  invocation: human(run.s.sealed.target), environment: "DEV", target: { ...run.s.sealed.target }, proposal, sealedPlan: run.s.loaded, manifest: run.s.project.manifest, projectRoot: run.s.project.projectRoot, approvals,
}, w.deps);

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

test("Azure Terraform observe: after a successful apply the driver records the blueprint from the state, identifiers only, and observe verifies each resource through Azure Resource Manager as DISCOVERY, lists what each group holds, with no credential outside memory", async () => {
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
  // Each present group was listed: what a deletion of it would take along is on record, identifiers only.
  assert.deepEqual(sorted(observation.record.groups.map((g) => [g.address, g.identifier, [...g.members].sort(), g.complete])), sorted([
    ["azurerm_resource_group.pilot", RG, [LAW], true], ["azurerm_resource_group.state", RG_STATE, [...GROUPS[RG_STATE]].sort(), true],
  ]));
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
  assert.equal(w.arm.calls.filter((c) => /\/resourceGroups\/[^/]+\/resources\?/.test(c.url)).length, 2, "each present group is listed once");
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
  assert.deepEqual(refusedToken.record.groups, [], "no group is listed without a token");
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
  assert.ok(!partial.record.groups.some((g) => g.address === "azurerm_resource_group.pilot"), "a group not confirmed present is not listed");
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
  const arm = fakeArmHttp({ existing: [RG, LAW], groupMembers: { [RG]: [LAW] } });
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
  assert.deepEqual(await reader.listGroup!(RG), { identifiers: [LAW], complete: true });
  assert.equal(await reader.listGroup!(LAW), undefined, "only a resource group is listed as a container");
  assert.equal(await reader.listGroup!("/subscriptions/99999999-9999-4999-8999-999999999999/resourceGroups/elsewhere"), undefined);
  assert.deepEqual(armTypeOf(LAW), { namespace: "Microsoft.OperationalInsights", typePath: "workspaces" });
  assert.deepEqual(armTypeOf(RG + "/providers/Microsoft.Storage/storageAccounts/x/blobServices/default/containers/c"), { namespace: "Microsoft.Storage", typePath: "storageAccounts/blobServices/containers" });
  assert.deepEqual(armTypeOf(RG), { namespace: "Microsoft.Resources", typePath: "resourceGroups" });
  assert.deepEqual(armTypeOf(OLD_ROLE), { namespace: "Microsoft.Authorization", typePath: "roleAssignments" }, "a subscription-scoped resource has no resource group and is still addressable");
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
    assert.equal(await reader.listGroup!("/subscriptions/" + SUB + "/resourceGroups/..%2F" + "x"), undefined);
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
    const members = await hooked.reader.listGroup!(RG);
    assert.deepEqual(members, { identifiers: [RG], complete: false }, next + ": a group listing refuses the same link, and is incomplete");
    assert.ok(seen.every((r) => r.url !== next), next + ": the link was never followed by the group listing either");
    hooked.close();
  }
});

// --- propose, clean up, verify --------------------------------------------------------------------------------

const withoutSecret = <T extends { address?: string; type?: string }>(items: readonly T[]): T[] => items.filter((item) => !(item.address ?? item.type ?? "").includes("key_vault_secret"));
/** The exclusions the fixture always produces: everything this run did not create, or must never delete. */
const PROTECTED_EXCLUSIONS: [string, string][] = [
  ["azuread_application.pilot", "PROTECTED_IDENTITY"], ["azurerm_key_vault.reused", "IMPORTED"], ["azurerm_resource_group.state", "PROTECTED_BACKEND"], ["azurerm_role_assignment.old", "PROTECTED_IDENTITY"],
  ["azurerm_storage_account.state", "PROTECTED_BACKEND"], ["azurerm_storage_container.state", "PROTECTED_BACKEND"], ["azurerm_subscription_policy_assignment.shared", "PRE_EXISTING"], ["azurerm_virtual_network.unrelated", "NOT_IN_PLAN"],
];

test("Azure Terraform cleanup: the proposal keeps the state backend in every form and the group that holds it, the pilot's identities and grants, and every pre-existing, shared, imported or unrelated resource; the APPLY identity destroys exactly the created list after a targeted destroy plan, and the leftover check reads ARM again: COMPLETE only when the unit sweep finds nothing else", async () => {
  const w = world();
  // This run creates only resources the reader can address; a run with a key vault secret is checked below.
  behave({ showResources: withoutSecret(CREATES), stateResources: withoutSecret(STATE as { type: string }[]) });
  const run = await proposed(w);
  assert.deepEqual(run.proposal.deletes.map((d) => [d.address, d.identifier, d.observed]), [
    ["azurerm_log_analytics_workspace.pilot", LAW, "VERIFIED"], ["azurerm_resource_group.pilot", RG, "VERIFIED"],
  ]);
  assert.deepEqual(sorted(run.proposal.excluded.map((x) => [x.address, x.ownership])), sorted(PROTECTED_EXCLUSIONS));
  assert.ok(run.proposal.excluded.find((x) => x.address === "azurerm_storage_container.state")!.reason.includes("state backend"), "a created container of the backend account, by its data-plane URL, is still the backend");
  assert.ok(run.proposal.risks.some((r) => r.startsWith("azurerm_resource_group:")), "deleting a resource group is named as a material risk");
  assert.equal(run.proposal.unitId, UNIT.unitId);
  noTokenIn(w, run.proposal, run.observation.record);

  const result = await cleanup(w, run);
  assert.ok(result.ok, JSON.stringify(result));
  assert.equal(result.evidence.outcome, "SUCCEEDED");
  assert.deepEqual(result.evidence.deletes, ["azurerm_log_analytics_workspace.pilot", "azurerm_resource_group.pilot"]);
  assert.deepEqual(destroyPlans()[0]!.args.filter((a) => a.startsWith("-target=")).sort(), result.evidence.deletes.map((d) => "-target=" + d));
  assert.ok(existsSync(join(w.dirs.evidence, run.proposal.proposalSha256 + CLEANUP_SUFFIX)));
  assert.deepEqual(await readCleanupEvidence(run.proposal.proposalSha256, w.dirs.evidence), result.evidence);
  assert.ok(w.arm.calls.some((c) => c.url.startsWith("https://management.azure.com" + RG + "/resources?")), "the group's members were listed again right before the destroy");

  // Before the cloud catches up: the tag listing still names the group, and the leftover check says so.
  cloud(w, { existing: RETAINED, tagged: [RG] });
  const early = await verifyProposalLeftovers(run.proposal, observeDeps(w, new Date(NOW.getTime() + 600_000)));
  assert.ok(early.ok);
  assert.equal(early.record.disposition, "COMPLETE", "the group is a known identifier of this run: a listing that still names something the per-resource check confirmed gone is not a leftover");
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
  assert.deepEqual(leftovers.record.resources.filter((r) => r.disposition === "CONFIRMED_DELETED").map((r) => [r.address, r.basis]), [
    ["azurerm_log_analytics_workspace.pilot", "ARM_ABSENT"], ["azurerm_resource_group.pilot", "ARM_ABSENT"],
  ], "the basis names the API that answered");
  assert.deepEqual(sorted(leftovers.record.resources.filter((r) => r.disposition === "INTENTIONALLY_RETAINED").map((r) => [r.address, r.basis, r.owner])),
    sorted(PROTECTED_EXCLUSIONS.map(([address, ownership]) => [address, "RETENTION_DECISION", ownership])));
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

test("Azure resource-group containment: a group is deleted only when everything it holds is this run's and goes with it; a foreign member, a pre-existing group or an incomplete listing keeps it, and a member added after the proposal stops the cleanup before anything is consumed", async () => {
  const foreign = RG + "/providers/Microsoft.Storage/storageAccounts/someoneelses";
  // A resource this run did not create sits inside the group it created: the workspace is proposed, the group is kept and the reason says why.
  const shared = world({ ...CLOUD, groupMembers: { ...GROUPS, [RG]: [LAW, foreign] } });
  const run = await proposed(shared);
  assert.deepEqual(run.proposal.deletes.map((d) => d.address), ["azurerm_key_vault_secret.canary", "azurerm_log_analytics_workspace.pilot"]);
  const kept = run.proposal.excluded.find((x) => x.address === "azurerm_resource_group.pilot");
  assert.equal(kept?.ownership, "CONTAINS_OTHERS");
  assert.match(kept!.reason, /holds 1 resource/);
  assert.ok(!JSON.stringify(run.proposal).includes("someoneelses"), "the foreign resource is counted, not named: it is not this run's to describe");
  const done = await cleanup(shared, run);
  assert.ok(done.ok, JSON.stringify(done));
  assert.deepEqual(done.evidence.deletes, ["azurerm_key_vault_secret.canary", "azurerm_log_analytics_workspace.pilot"]);
  cloud(shared, { ...CLOUD, existing: [RG, ...RETAINED, foreign], tagged: [RG], groupMembers: { ...GROUPS, [RG]: [foreign] } });
  const leftovers = await verifyProposalLeftovers(run.proposal, observeDeps(shared, new Date(NOW.getTime() + 600_000)));
  assert.ok(leftovers.ok);
  assert.equal(leftovers.record.disposition, "INCOMPLETE", "the secret cannot be read independently; the kept group itself is a retention decision and a known identifier of this run, not a leftover");
  assert.ok(leftovers.record.resources.every((r) => r.address === "azurerm_key_vault_secret.canary" || r.disposition === "CONFIRMED_DELETED" || r.disposition === "INTENTIONALLY_RETAINED"), JSON.stringify(leftovers.record.resources));
  assert.deepEqual(leftovers.record.resources.find((r) => r.address === "azurerm_resource_group.pilot")?.owner, "CONTAINS_OTHERS");

  // The plan only changed a group that existed before: pre-existing, whatever it holds.
  const preexisting = world();
  behave({ showResources: CREATES.map((c) => (c.address === "azurerm_resource_group.pilot" ? change(c.address, c.type, ["update"]) : c)) });
  const older = await proposed(preexisting);
  assert.deepEqual(older.proposal.deletes.map((d) => d.address), ["azurerm_key_vault_secret.canary", "azurerm_log_analytics_workspace.pilot"]);
  assert.equal(older.proposal.excluded.find((x) => x.address === "azurerm_resource_group.pilot")?.ownership, "PRE_EXISTING");

  // The group's contents could not be listed completely at observation: kept, with the listing on record as incomplete.
  const unlisted = world({ ...CLOUD, groupPages: 2, groupListingFails: true });
  const partial = await proposed(unlisted);
  assert.deepEqual(partial.observation.record.groups.find((g) => g.address === "azurerm_resource_group.pilot")?.complete, false);
  assert.deepEqual(partial.proposal.deletes.map((d) => d.address), ["azurerm_key_vault_secret.canary", "azurerm_log_analytics_workspace.pilot"]);
  assert.match(partial.proposal.excluded.find((x) => x.address === "azurerm_resource_group.pilot")!.reason, /could not be listed completely/);

  // Proposed when the group held only the run's workspace; something appeared inside before the cleanup ran.
  const w = world();
  const honest = await proposed(w);
  assert.deepEqual(honest.proposal.deletes.map((d) => d.address), ["azurerm_key_vault_secret.canary", "azurerm_log_analytics_workspace.pilot", "azurerm_resource_group.pilot"]);
  const approval = cleanupApproval(honest.proposal, "alice");
  cloud(w, { ...CLOUD, groupMembers: { ...GROUPS, [RG]: [LAW, foreign] } });
  const grown = await cleanup(w, honest, [approval]);
  refused(grown, "PROPOSAL_SCOPE_MISMATCH");
  assert.match((grown as { message: string }).message, /now holds 1 resource.*Nothing was run and no approval was consumed/);
  assert.ok(!JSON.stringify(grown).includes("someoneelses"));
  // The listing fails or is cut short right before the destroy: the cleanup does not run either.
  cloud(w, { ...CLOUD, groupPages: 2, groupListingFails: true });
  refused(await cleanup(w, honest, [approval]), "OBSERVATION_INCONCLUSIVE");
  cloud(w, { ...CLOUD, failAll: 403 });
  refused(await cleanup(w, honest, [approval]), "OBSERVATION_INCONCLUSIVE");
  assert.equal(destroyPlans().length, 0, "no destroy was planned");
  assert.deepEqual(readdirSync(w.dirs.evidence).filter((n) => n.endsWith(CLEANUP_SUFFIX)), [], "nothing was reserved or recorded");
  noTokenIn(w, grown);
  // Back to what was approved: the same approval runs once.
  cloud(w, CLOUD);
  const done2 = await cleanup(w, honest, [approval]);
  assert.ok(done2.ok, JSON.stringify(done2));
  assert.deepEqual(done2.evidence.deletes, honest.proposal.deletes.map((d) => d.address));
});

test("Azure cleanup denied: a forged, re-hashed proposal naming the backend account, its container, the group that holds it, a grant, a pre-existing, imported, shared or unrelated resource, or a dropped entry never executes, an apply approval never authorizes a cleanup, and a state id that cannot be read exactly as written makes no proposal", async () => {
  const w = world();
  const run = await proposed(w);
  const honest = run.proposal;
  const rehashed = (edit: Partial<CleanupProposal>): CleanupProposal => {
    const fields = { ...honest, ...edit, deletes: [...(edit.deletes ?? honest.deletes)].sort((a, b) => (a.address < b.address ? -1 : 1)) };
    return { ...fields, proposalSha256: computeProposalSha256(fields) };
  };
  const row = (address: string, type: string, identifier: string) => ({ address, type, identifier, ownership: "RUN_CREATED" as const, observed: "VERIFIED" as const });
  const without = (address: string) => honest.excluded.filter((x) => x.address !== address);
  const approval = cleanupApproval(honest, "alice");
  const forgeries: [string, CleanupProposal][] = [
    ["the state storage account", rehashed({ deletes: [...honest.deletes, row("azurerm_storage_account.state", "azurerm_storage_account", STATE_ACCOUNT)], excluded: without("azurerm_storage_account.state") })],
    ["the state container, by its data-plane URL", rehashed({ deletes: [...honest.deletes, row("azurerm_storage_container.state", "azurerm_storage_container", STATE_CONTAINER)], excluded: without("azurerm_storage_container.state") })],
    ["the group that holds the backend", rehashed({ deletes: [...honest.deletes, row("azurerm_resource_group.state", "azurerm_resource_group", RG_STATE)], excluded: without("azurerm_resource_group.state") })],
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
    assert.ok(verifyCleanupProposal(forged).ok, label + ": the forgery is self-consistent");
    const result = await cleanup(w, run, [cleanupApproval(forged, "alice")], forged);
    refused(result, "PROPOSAL_INVALID");
    assert.match((result as { message: string }).message, /nothing was run|Nothing was run/i, label);
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
  behave({ applyExit: 1, applyStderr: "Error: something failed CANARY_ENGINE_ERROR", destroyKeeps: ["azurerm_resource_group.pilot"] });
  const partial = await cleanup(w, run);
  refused(partial, "APPLY_FAILED");
  assert.equal((partial as { outcome?: string }).outcome, "PARTIAL_REQUIRES_REVIEW");
  assert.ok(!JSON.stringify(partial).includes("CANARY_ENGINE_ERROR"), "engine output is withheld");
  assert.equal((await readCleanupEvidence(run.proposal.proposalSha256, w.dirs.evidence))?.outcome, "PARTIAL_REQUIRES_REVIEW");
  refused(await cleanup(w, run), "PROPOSAL_ALREADY_EXECUTED");
  cloud(w, { existing: [RG, ...RETAINED], tagged: [RG], groupMembers: { ...GROUPS, [RG]: [] } });
  const leftovers = await verifyProposalLeftovers(run.proposal, observeDeps(w, new Date(NOW.getTime() + 600_000)));
  assert.ok(leftovers.ok);
  assert.equal(leftovers.record.disposition, "INCOMPLETE");
  const byAddress = new Map(leftovers.record.resources.map((r) => [r.address, r]));
  assert.deepEqual([byAddress.get("azurerm_log_analytics_workspace.pilot")!.disposition, byAddress.get("azurerm_log_analytics_workspace.pilot")!.basis], ["CONFIRMED_DELETED", "ARM_ABSENT"]);
  assert.deepEqual([byAddress.get("azurerm_resource_group.pilot")!.disposition, byAddress.get("azurerm_resource_group.pilot")!.basis], ["DELETION_PENDING", "CLEANUP_NOT_FINISHED"], "the cleanup did not finish, so a present resource is pending a person's review, not a leftover of a finished cleanup");
  assert.match(leftovers.record.nextAction, /PARTIAL_REQUIRES_REVIEW.*by hand/);
  noTokenIn(w, leftovers.record, partial);
});

test("Azure containers by identifier: a resource group created through any type (azapi_resource) is listed and kept when it holds another's resource, re-listed before the destroy, and a subscription or management group is never proposed, even through a forged proposal", async () => {
  const AZAPI_RG = "/subscriptions/" + SUB + "/resourceGroups/rg-azapi";
  const AZAPI_OWNED = AZAPI_RG + "/providers/Microsoft.Storage/storageAccounts/azapiowned";
  const FOREIGN = AZAPI_RG + "/providers/Microsoft.Storage/storageAccounts/foreignone";
  const ALIAS = "/providers/Microsoft.Subscription/aliases/vended-sub";
  const MG = "/providers/Microsoft.Management/managementGroups/mg-platform";
  const creates = [...withoutSecret(CREATES), change("azapi_resource.rg", "azapi_resource", ["create"]), change("azurerm_storage_account.azapi", "azurerm_storage_account", ["create"]),
    change("azurerm_subscription.vended", "azurerm_subscription", ["create"]), change("azurerm_management_group.platform", "azurerm_management_group", ["create"])];
  const state = [...withoutSecret(STATE as { type: string }[]), azureStateResource("azapi_resource", "rg", AZAPI_RG), azureStateResource("azurerm_storage_account", "azapi", AZAPI_OWNED),
    azureStateResource("azurerm_subscription", "vended", ALIAS), azureStateResource("azurerm_management_group", "platform", MG)];
  const existing = [...EXISTING, AZAPI_RG, AZAPI_OWNED, FOREIGN];
  // The azapi group holds a resource of someone else: the group is kept, its run-owned member is still proposed, the scopes are never proposed.
  const w = world({ existing, tagged: [...TAGGED, AZAPI_RG, AZAPI_OWNED], groupMembers: { ...GROUPS, [AZAPI_RG]: [AZAPI_OWNED, FOREIGN] } });
  behave({ showResources: creates, stateResources: state });
  const run = await proposed(w);
  assert.deepEqual(run.observation.record.groups.find((g) => g.address === "azapi_resource.rg"), { address: "azapi_resource.rg", identifier: AZAPI_RG, members: [AZAPI_OWNED, FOREIGN].sort(), complete: true }, "a group is recognized by its id, not its type");
  assert.deepEqual(run.proposal.deletes.map((d) => d.address), ["azurerm_log_analytics_workspace.pilot", "azurerm_resource_group.pilot", "azurerm_storage_account.azapi"]);
  const kept = new Map(run.proposal.excluded.map((x) => [x.address, x]));
  assert.equal(kept.get("azapi_resource.rg")?.ownership, "CONTAINS_OTHERS");
  assert.match(kept.get("azapi_resource.rg")!.reason, /holds 1 resource/);
  for (const address of ["azurerm_subscription.vended", "azurerm_management_group.platform"]) {
    assert.equal(kept.get(address)?.ownership, "CONTAINS_OTHERS", address);
    assert.match(kept.get(address)!.reason, /subscription or management group/);
  }
  assert.ok(!JSON.stringify(run.proposal).includes("foreignone"));
  const done = await cleanup(w, run);
  assert.ok(done.ok, JSON.stringify(done));
  assert.deepEqual(done.evidence.deletes, run.proposal.deletes.map((d) => d.address));

  // The azapi group holds only what the run created: proposed; then a member appears before the cleanup, and it stops before anything is reserved.
  const w2 = world({ existing, tagged: [...TAGGED, AZAPI_RG, AZAPI_OWNED], groupMembers: { ...GROUPS, [AZAPI_RG]: [AZAPI_OWNED] } });
  behave({ showResources: creates, stateResources: state });
  const honest = await proposed(w2);
  assert.deepEqual(honest.proposal.deletes.map((d) => d.address), ["azapi_resource.rg", "azurerm_log_analytics_workspace.pilot", "azurerm_resource_group.pilot", "azurerm_storage_account.azapi"]);
  const approval = cleanupApproval(honest.proposal, "alice");
  cloud(w2, { existing, tagged: [...TAGGED, AZAPI_RG, AZAPI_OWNED], groupMembers: { ...GROUPS, [AZAPI_RG]: [AZAPI_OWNED, FOREIGN] } });
  const grown = await cleanup(w2, honest, [approval]);
  refused(grown, "PROPOSAL_SCOPE_MISMATCH");
  assert.match((grown as { message: string }).message, /azapi_resource\.rg now holds 1 resource/);
  assert.equal(destroyPlans().length, 0);
  assert.deepEqual(readdirSync(w2.dirs.evidence).filter((n) => n.endsWith(CLEANUP_SUFFIX)), []);
  // A forged proposal that adds the subscription alias or the management group never executes.
  const row = (address: string, type: string, identifier: string) => ({ address, type, identifier, ownership: "RUN_CREATED" as const, observed: "UNVERIFIABLE" as const });
  for (const [address, type, id] of [["azurerm_subscription.vended", "azurerm_subscription", ALIAS], ["azurerm_management_group.platform", "azurerm_management_group", MG]] as const) {
    const fields = { ...honest.proposal, deletes: [...honest.proposal.deletes, row(address, type, id)].sort((a, b) => (a.address < b.address ? -1 : 1)), excluded: honest.proposal.excluded.filter((x) => x.address !== address) };
    const forged = { ...fields, proposalSha256: computeProposalSha256(fields) };
    assert.ok(verifyCleanupProposal(forged).ok);
    refused(await cleanup(w2, honest, [cleanupApproval(forged, "alice")], forged), "PROPOSAL_INVALID");
  }
  assert.equal(destroyPlans().length, 0);
  // Back to what was approved: the same approval runs once, and the group was listed again after the destroy plan, right before the approvals were consumed.
  cloud(w2, { existing, tagged: [...TAGGED, AZAPI_RG, AZAPI_OWNED], groupMembers: { ...GROUPS, [AZAPI_RG]: [AZAPI_OWNED] } });
  const done2 = await cleanup(w2, honest, [approval]);
  assert.ok(done2.ok, JSON.stringify(done2));
  assert.equal(w2.arm.calls.filter((c) => c.url.startsWith("https://management.azure.com" + AZAPI_RG + "/resources?")).length, 2, "listed once before the destroy plan and once right before the approvals were consumed");
  assert.equal(destroyPlans().length, 1);
});
