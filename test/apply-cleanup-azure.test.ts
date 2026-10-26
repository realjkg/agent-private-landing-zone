import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { signApproval } from "../src/apply/approval.js";
import { buildCleanupProposal, type CleanupProposal } from "../src/apply/cleanup-proposal.js";
import { CLEANUP_SUFFIX, loadPilotContract, pilotContractSha256 } from "../src/apply/contract.js";
import { runApply, runCleanup, sealPreview, type ApplyDeps, type ApplyRequest } from "../src/apply/driver.js";
import { readCleanupEvidence } from "../src/apply/ledger.js";
import { loadRunRecords, observeRun, verifyProposalLeftovers, type ObserveDeps } from "../src/apply/observe.js";
import { openNonceStore } from "../src/apply/nonces.js";
import { loadSealedPlan } from "../src/apply/seal.js";
import { BLUEPRINT_SUFFIX, readBlueprintRecord } from "../src/apply/run-records.js";
import type { PilotContract, SignedApproval } from "../src/apply/types.js";
import { pilotUnitOf } from "../src/apply/unit.js";
import { armTypeOf, createDiscoveryArmReader } from "../src/observe/azure-rest.js";
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
const RG = "/subscriptions/" + SUB + "/resourceGroups/alz-pilot-rg";
const LAW = RG + "/providers/Microsoft.OperationalInsights/workspaces/alz-pilot-law";
const STATE_ACCOUNT = RG + "/providers/Microsoft.Storage/storageAccounts/" + DEV_TARGET.backend.split("/")[0];
const OLD_ROLE = "/subscriptions/" + SUB + "/providers/Microsoft.Authorization/roleAssignments/11111111-aaaa-4aaa-8aaa-111111111111";
const APP = "/applications/00000000-0000-4000-8000-000000000001";
const SECRET = "https://alz-pilot-kv.vault.azure.net/secrets/canary/0123456789abcdef";
const CREATES = [
  { address: "azurerm_resource_group.pilot", type: "azurerm_resource_group", change: { actions: ["create"], before: null, after: { tags: { team: "CANARY_TEAM_TAG" } } } },
  { address: "azurerm_log_analytics_workspace.pilot", type: "azurerm_log_analytics_workspace", change: { actions: ["create"], before: null, after: { tags: {} } } },
  { address: "azurerm_key_vault_secret.canary", type: "azurerm_key_vault_secret", change: { actions: ["create"], before: null, after: { value: "CANARY_SECRET_VALUE" } } },
  { address: "azurerm_storage_account.state", type: "azurerm_storage_account", change: { actions: ["update"], before: {}, after: {} } },
];
const STATE = [
  azureStateResource("azurerm_resource_group", "pilot", RG), azureStateResource("azurerm_log_analytics_workspace", "pilot", LAW), azureStateResource("azurerm_key_vault_secret", "canary", SECRET),
  azureStateResource("azurerm_storage_account", "state", STATE_ACCOUNT), azureStateResource("azuread_application", "pilot", APP), azureStateResource("azurerm_role_assignment", "old", OLD_ROLE),
];
const EXISTING = [RG, LAW, STATE_ACCOUNT, OLD_ROLE];
/** What the fake tag listing returns for this unit: the two things the plan created and tagged, and nothing else. */
const TAGGED = [RG, LAW];
const fixtureContractPath = (() => { const path = join(fresh("contract"), "act-pilot-contract.json"); writePinnedContract(path, contractJson(KILL)); return path; })();
const UNIT = pilotUnitOf({ provider: "AZURE", contractSha256: pilotContractSha256(loadPilotContract(fixtureContractPath, pinPathOf(fixtureContractPath)) as PilotContract), environment: "DEV", target: targetOf("DEV") });
const behave = (behavior: Behavior = {}) => behaveIn(toolDir, KILL, { applyAdvance: true, showOnlyConfigured: true, showResources: CREATES, stateResources: STATE, unitTags: { ...UNIT.tags }, unitTagAttribute: "tags", ...behavior });
const calls = () => callsOf(toolDir);
const applyCalls = () => calls().filter((c) => c.args[0] === "apply");
const destroyPlans = () => calls().filter((c) => c.args[0] === "plan" && c.args[1] === "-destroy");

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
function world(cloud: ArmBehavior = { existing: EXISTING, tagged: TAGGED }): World {
  behave();
  const dirs = { scratch: fresh("scratch"), evidence: fresh("evidence"), nonces: fresh("nonces") };
  const contractPath = join(fresh("contract"), "act-pilot-contract.json");
  writePinnedContract(contractPath, contractJson(KILL));
  return {
    dirs, contractPath, arm: fakeArmHttp(cloud),
    deps: {
      sourceCommit: SOURCE_COMMIT, contractPath, contractPinPath: pinPathOf(contractPath), qualificationDir: vaultDir, evidenceDir: dirs.evidence, nonces: openNonceStore(dirs.nonces),
      env: env(), now: () => NOW, scratchParent: dirs.scratch, toolDirs: [toolDir], killPollMs: 40, killGraceMs: 400,
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
async function proposed(w: World) {
  const run = await applied(w);
  const observation = await observeRun(run.s.sealed.artifactSha256, observeDeps(w));
  assert.ok(observation.ok, JSON.stringify(observation));
  const records = await loadRunRecords(run.s.sealed.artifactSha256, w.dirs.evidence);
  assert.ok(records.ok, JSON.stringify(records));
  const built = buildCleanupProposal({
    ...records, changes: run.s.sealed.changes, channel: "CLI", contract: contractJson(KILL) as never, engineVersion: run.s.sealed.engineVersion, env: w.deps.env!, now: new Date(NOW.getTime() + 120_000),
  });
  assert.ok(built.ok, JSON.stringify(built));
  return { ...run, observation, records, proposal: built.proposal };
}
const cleanupApproval = (proposal: CleanupProposal, who: keyof typeof keys): SignedApproval => signApproval({
  schemaVersion: 1, artifactSha256: proposal.proposalSha256, environment: proposal.environment, target: proposal.target, approverId: who,
  issuedAt: new Date(NOW.getTime() - 5 * 60_000).toISOString(), expiresAt: new Date(NOW.getTime() + 25 * 60_000).toISOString(), nonce: randomBytes(16).toString("hex"),
}, keys[who].priv, "CLEANUP");
const cleanup = (w: World, run: Awaited<ReturnType<typeof proposed>>, approvals: SignedApproval[] = [cleanupApproval(run.proposal, "alice")]) => runCleanup({
  invocation: human(run.s.sealed.target), environment: "DEV", target: { ...run.s.sealed.target }, proposal: run.proposal, sealedPlan: run.s.loaded, manifest: run.s.project.manifest, projectRoot: run.s.project.projectRoot, approvals,
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

// --- observe -----------------------------------------------------------------------------------------------

test("Azure Terraform observe: after a successful apply the driver records the blueprint from the state, identifiers only, and observe verifies each resource through Azure Resource Manager as DISCOVERY, with no credential outside memory", async () => {
  const w = world();
  const { s, evidence } = await applied(w);
  assert.equal(s.sealed.unit?.unitId, UNIT.unitId, "the Azure plan carries the same deletion unit scheme");
  assert.deepEqual(s.sealed.unit?.untagged, [], "the fake provider stamps every created resource");
  const blueprint = await readBlueprintRecord(s.sealed.artifactSha256, sha256(canonicalJson(evidence as never)), w.dirs.evidence);
  assert.ok(blueprint);
  assert.deepEqual(blueprint.blueprint.entries.map((e) => [e.address, e.origin, e.id, e.arn]), [
    ["azuread_application.pilot", "NOT_IN_PLAN", APP, null], ["azurerm_key_vault_secret.canary", "IN_PLAN", SECRET, null], ["azurerm_log_analytics_workspace.pilot", "IN_PLAN", LAW, null],
    ["azurerm_resource_group.pilot", "IN_PLAN", RG, null], ["azurerm_role_assignment.old", "NOT_IN_PLAN", OLD_ROLE, null], ["azurerm_storage_account.state", "IN_PLAN", STATE_ACCOUNT, null],
  ]);
  const raw = JSON.stringify(await readEncryptedEvidence(join(w.dirs.evidence, s.sealed.artifactSha256 + BLUEPRINT_SUFFIX)));
  for (const canary of [...CANARIES, STATE_CANARY]) assert.ok(!raw.includes(canary), "a state value reached the blueprint: " + canary);

  const observation = await observeRun(s.sealed.artifactSha256, observeDeps(w));
  assert.ok(observation.ok, JSON.stringify(observation));
  assert.equal(observation.record.verifier, "AZURE_RESOURCE_MANAGER");
  assert.equal(observation.record.verifierBinarySha256, null, "the reader runs in process; there is no program to hash");
  assert.equal(observation.record.verdict, "PARTIAL", "a key vault secret has no ARM id and cannot be read here, so it is named, not assumed");
  assert.deepEqual(observation.record.resources.map((r) => [r.address, r.result, r.reason]), [
    ["azuread_application.pilot", "UNVERIFIABLE", "NOT_AN_ARM_RESOURCE_ID"], ["azurerm_key_vault_secret.canary", "UNVERIFIABLE", "NOT_AN_ARM_RESOURCE_ID"],
    ["azurerm_log_analytics_workspace.pilot", "VERIFIED", undefined], ["azurerm_resource_group.pilot", "VERIFIED", undefined], ["azurerm_role_assignment.old", "VERIFIED", undefined],
    ["azurerm_storage_account.state", "VERIFIED", undefined],
  ]);
  assert.equal(observation.record.inventory, "COMPLETE");
  assert.deepEqual(observation.record.unexpected, []);
  // The credential path: one token POST to the tenant's endpoint with the assertion in the body, then GETs to management.azure.com only.
  assert.deepEqual(hosts(w), ["login.microsoftonline.com", "management.azure.com"]);
  const posts = w.arm.calls.filter((c) => c.method === "POST");
  assert.equal(posts.length, 1, "the federated token is exchanged once");
  assert.equal(posts[0].url, "https://login.microsoftonline.com/" + identityEnv("DEV").ALZ_DISCOVERY_ARM_TENANT_ID + "/oauth2/v2.0/token");
  assert.ok(new URLSearchParams(posts[0].body).get("client_assertion") === ARM_FEDERATED_TOKEN_CANARY, "the assertion travels in the POST body");
  assert.equal(new URLSearchParams(posts[0].body).get("client_id"), "discovery-client-1", "the DISCOVERY identity, no other");
  assert.ok(w.arm.calls.filter((c) => c.method === "GET").every((c) => new URL(c.url).host === "management.azure.com" && c.headers.authorization === "Bearer " + ARM_ACCESS_TOKEN_CANARY));
  assert.deepEqual(methods(w), ["GET", "POST"], "reads and the token exchange; nothing else is ever sent");
  noTokenIn(w, observation.record, observation.report);
  assert.ok(calls().every((c) => !JSON.stringify(c).includes(ARM_FEDERATED_TOKEN_CANARY) && !JSON.stringify(c).includes(ARM_ACCESS_TOKEN_CANARY)), "no token reached the engine's argv or environment");
  const listing = w.arm.calls.filter((c) => /\/(resources|resourcegroups)\?/.test(c.url));
  assert.equal(listing.length, 2, "resources and resource groups are both listed by the unit tag");
  assert.ok(listing.every((c) => decodeURIComponent(c.url).includes("tagName eq 'alz-unit' and tagValue eq '" + UNIT.unitId + "'")));
});

test("Azure observe denied and interrupted: a refused token, a forbidden or throttled read, a paginated listing and a tagged resource outside the state never pass, and nothing but the class is recorded", async () => {
  const w = world();
  const { s } = await applied(w);
  const before = applyCalls().length;
  // The token endpoint refuses the identity: nothing is read, nothing is verified, and the reason is a class.
  cloud(w, { existing: EXISTING, tagged: TAGGED, tokenStatus: 401 });
  const refusedToken = await observeRun(s.sealed.artifactSha256, observeDeps(w));
  assert.ok(refusedToken.ok);
  assert.equal(refusedToken.record.verdict, "INCONCLUSIVE");
  assert.ok(refusedToken.record.resources.filter((r) => r.result !== "UNVERIFIABLE").every((r) => r.result === "UNVERIFIABLE" || r.reason === "CREDENTIALS"), JSON.stringify(refusedToken.record.resources));
  assert.equal(refusedToken.record.inventory, "INCOMPLETE");
  assert.equal(w.arm.calls.filter((c) => c.method === "GET").length, 0, "no read is attempted without a token");
  noTokenIn(w, refusedToken.record);
  // Forbidden for one resource, throttled for another.
  cloud(w, { existing: EXISTING, tagged: TAGGED, fail: { [LAW]: 403, [RG]: 429 } });
  const partial = await observeRun(s.sealed.artifactSha256, observeDeps(w));
  assert.ok(partial.ok);
  assert.equal(partial.record.verdict, "INCONCLUSIVE");
  const byAddress = new Map(partial.record.resources.map((r) => [r.address, r]));
  assert.deepEqual([byAddress.get("azurerm_log_analytics_workspace.pilot")!.result, byAddress.get("azurerm_log_analytics_workspace.pilot")!.reason], ["UNVERIFIABLE", "ACCESS_DENIED"]);
  assert.deepEqual([byAddress.get("azurerm_resource_group.pilot")!.result, byAddress.get("azurerm_resource_group.pilot")!.reason], ["NOT_YET_OBSERVABLE", "THROTTLED"]);
  assert.ok(!JSON.stringify(partial.record).includes("CANARY_CLOUD_ERROR"), "the cloud's message is never recorded");
  // The identity has no access at all: nothing verified, nothing guessed.
  cloud(w, { existing: EXISTING, tagged: TAGGED, failAll: 403 });
  const denied = await observeRun(s.sealed.artifactSha256, observeDeps(w));
  assert.ok(denied.ok);
  assert.ok(denied.record.resources.every((r) => r.result !== "VERIFIED"));
  assert.equal(denied.record.inventory, "INCOMPLETE");
  // A paginated listing is followed to its end and still counts as complete; a resource of this unit the state does not name fails the observation.
  cloud(w, { existing: EXISTING, tagged: [...TAGGED, RG + "/providers/Microsoft.Storage/storageAccounts/orphanofthisunit"], pages: 2 });
  const stray = await observeRun(s.sealed.artifactSha256, observeDeps(w));
  assert.ok(stray.ok);
  assert.equal(stray.record.inventory, "COMPLETE");
  assert.equal(stray.record.verdict, "FAILED");
  assert.deepEqual(stray.record.unexpected, [RG + "/providers/Microsoft.Storage/storageAccounts/orphanofthisunit"]);
  const records = await loadRunRecords(s.sealed.artifactSha256, w.dirs.evidence);
  assert.ok(records.ok);
  const built = buildCleanupProposal({ ...records, changes: s.sealed.changes, channel: "CLI", contract: contractJson(KILL) as never, engineVersion: s.sealed.engineVersion, env: w.deps.env!, now: new Date(NOW.getTime() + 120_000) });
  assert.ok(!built.ok && built.code === "OBSERVATION_INCONCLUSIVE");
  // Observing again and again never applies again.
  cloud(w, { existing: EXISTING, tagged: TAGGED });
  const again = await observeRun(s.sealed.artifactSha256, observeDeps(w));
  assert.ok(again.ok && again.record.verdict === "PARTIAL");
  assert.equal(applyCalls().length, before);
});

test("the Azure reader refuses to read outside its two hosts or outside the target subscription, needs an ARM id, and resolves API versions once per type", async () => {
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
  assert.deepEqual(armTypeOf(LAW), { namespace: "Microsoft.OperationalInsights", typePath: "workspaces" });
  assert.deepEqual(armTypeOf(RG + "/providers/Microsoft.Storage/storageAccounts/x/blobServices/default/containers/c"), { namespace: "Microsoft.Storage", typePath: "storageAccounts/blobServices/containers" });
  assert.deepEqual(armTypeOf(RG), { namespace: "Microsoft.Resources", typePath: "resourceGroups" });
  assert.deepEqual(armTypeOf(OLD_ROLE), { namespace: "Microsoft.Authorization", typePath: "roleAssignments" }, "a subscription-scoped resource has no resource group and is still addressable");
  assert.equal(armTypeOf("/subscriptions/" + SUB), undefined);
  assert.equal(armTypeOf("https://x.vault.azure.net/secrets/y"), undefined);
  // A unit id that is not tag-safe is never put into a filter.
  assert.equal(await reader.listTagged("x'; drop"), undefined);
  // A subscription that is not a GUID is refused before anything is read.
  assert.throws(() => createDiscoveryArmReader({ env: env(), subscriptionId: "not-a-guid", http: arm.http }), /ARM_SUBSCRIPTION_INVALID/);
  // A missing token file is a credential failure, with nothing read.
  const noFile = fakeArmHttp({ existing: [RG] });
  const broken = createDiscoveryArmReader({ env: { ...env(), ALZ_DISCOVERY_ARM_OIDC_TOKEN_FILE: join(root, "absent") }, subscriptionId: SUB, http: noFile.http });
  const unreadable = await broken.reader.check(entry("a.b", "azurerm_resource_group", RG));
  assert.deepEqual([unreadable.existence, unreadable.reason], ["UNKNOWN", "CREDENTIALS"]);
  assert.equal(noFile.calls.length, 0);
  close(); broken.close();
});

// --- propose, clean up, verify --------------------------------------------------------------------------------

const withoutSecret = <T extends { address?: string; type?: string }>(items: readonly T[]): T[] => items.filter((item) => !(item.address ?? item.type ?? "").includes("key_vault_secret"));

test("Azure Terraform cleanup: the proposal keeps the state storage account and the pilot's identity objects, the APPLY identity destroys exactly the created list after a targeted destroy plan, and the leftover check reads ARM again: COMPLETE only when the unit sweep finds nothing else", async () => {
  const w = world();
  // This run creates only resources the reader can address; a run with a key vault secret is checked below.
  behave({ showResources: withoutSecret(CREATES), stateResources: withoutSecret(STATE as { type: string }[]) });
  const run = await proposed(w);
  assert.deepEqual(run.proposal.deletes.map((d) => [d.address, d.identifier, d.observed]), [
    ["azurerm_log_analytics_workspace.pilot", LAW, "VERIFIED"], ["azurerm_resource_group.pilot", RG, "VERIFIED"],
  ]);
  assert.deepEqual(run.proposal.excluded.map((x) => [x.address, x.ownership]), [
    ["azuread_application.pilot", "PROTECTED_IDENTITY"], ["azurerm_role_assignment.old", "NOT_IN_PLAN"], ["azurerm_storage_account.state", "PROTECTED_BACKEND"],
  ]);
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

  // Before the cloud catches up: the tag listing still names the group, and the leftover check says so.
  cloud(w, { existing: [STATE_ACCOUNT, OLD_ROLE], tagged: [RG] });
  const early = await verifyProposalLeftovers(run.proposal, observeDeps(w, new Date(NOW.getTime() + 600_000)));
  assert.ok(early.ok);
  assert.equal(early.record.disposition, "COMPLETE", "the group is a known identifier of this run: a listing that still names something the per-resource check confirmed gone is not a leftover");
  // A tagged resource outside the state keeps the cleanup incomplete; an empty complete listing completes it.
  cloud(w, { existing: [STATE_ACCOUNT, OLD_ROLE], tagged: [RG + "/providers/Microsoft.Storage/storageAccounts/strayofthisunit"] });
  const stray = await verifyProposalLeftovers(run.proposal, observeDeps(w, new Date(NOW.getTime() + 700_000)));
  assert.ok(stray.ok);
  assert.equal(stray.record.disposition, "INCOMPLETE");
  assert.deepEqual(stray.record.resources.filter((r) => r.address === "(not in state)").map((r) => [r.identifier, r.disposition]), [[RG + "/providers/Microsoft.Storage/storageAccounts/strayofthisunit", "STILL_PRESENT"]]);
  cloud(w, { existing: [STATE_ACCOUNT, OLD_ROLE], tagged: [] });
  const leftovers = await verifyProposalLeftovers(run.proposal, observeDeps(w, new Date(NOW.getTime() + 800_000)));
  assert.ok(leftovers.ok);
  assert.equal(leftovers.record.verifier, "AZURE_RESOURCE_MANAGER");
  assert.equal(leftovers.record.disposition, "COMPLETE");
  assert.equal(leftovers.record.sweep, "COMPLETE");
  assert.deepEqual(leftovers.record.resources.map((r) => [r.address, r.disposition, r.basis]), [
    ["azurerm_log_analytics_workspace.pilot", "CONFIRMED_DELETED", "CLOUD_CONTROL_ABSENT"], ["azurerm_resource_group.pilot", "CONFIRMED_DELETED", "CLOUD_CONTROL_ABSENT"],
    ["azuread_application.pilot", "INTENTIONALLY_RETAINED", "RETENTION_DECISION"], ["azurerm_role_assignment.old", "INTENTIONALLY_RETAINED", "RETENTION_DECISION"], ["azurerm_storage_account.state", "INTENTIONALLY_RETAINED", "RETENTION_DECISION"],
  ]);
  noTokenIn(w, leftovers.record, result.evidence);

  // A run that also created a key vault secret: the secret has no ARM id, so after the cleanup it is UNKNOWN, never confirmed, and the record stays INCOMPLETE with a person's next step.
  const w2 = world();
  const run2 = await proposed(w2);
  assert.ok((await cleanup(w2, run2)).ok);
  cloud(w2, { existing: [STATE_ACCOUNT, OLD_ROLE], tagged: [] });
  const open = await verifyProposalLeftovers(run2.proposal, observeDeps(w2, new Date(NOW.getTime() + 800_000)));
  assert.ok(open.ok);
  assert.equal(open.record.disposition, "INCOMPLETE");
  assert.deepEqual(open.record.resources.find((r) => r.address === "azurerm_key_vault_secret.canary")?.disposition, "UNKNOWN");
  assert.match(open.record.nextAction, /cannot be read independently.*confirms by hand/);
});
