import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { signApproval } from "../src/apply/approval.js";
import { buildCleanupProposal, signCleanupProposal, type CleanupProposal } from "../src/apply/cleanup-proposal.js";
import { authorizeContract, inspectPilotContract, loadPilotContract, pilotContractSha256, pilotTargetSha256, targetMoved, writeQualificationEvidence } from "../src/apply/contract.js";
import { runApply, runCleanup, sealPreview, type ApplyDeps } from "../src/apply/driver.js";
import { ENGINE_IDS, engineSpec } from "../src/apply/engine-spec.js";
import { BICEP } from "../src/apply/engines/bicep.js";
import { loadRunRecords, observeRun, verifyProposalLeftovers, type ObserveDeps } from "../src/apply/observe.js";
import { openNonceStore } from "../src/apply/nonces.js";
import { providerSpec } from "../src/apply/provider.js";
import { readBlueprintRecord } from "../src/apply/run-records.js";
import { isPinnedDeploymentStackId } from "../src/observe/blueprint.js";
import { loadSealedPlan } from "../src/apply/seal.js";
import type { PilotContract, SignedApproval } from "../src/apply/types.js";
import { pilotUnitOf } from "../src/apply/unit.js";
import { ACT_RELEASE_PATHS, actGateId } from "../src/qualification/release-admission.js";
import { removeTree } from "../src/teardown/driver/cleanup.js";
import { canonicalJson } from "../src/teardown/manifest.js";
import { sha256 } from "../src/util/sha256.js";
import { ARM_ACCESS_TOKEN_CANARY, CANARIES, NOW, POLICY, REQUESTER, SOURCE_COMMIT, approvalFor, approvers, fakeArmHttp, human, keys, writeReviewedContract } from "./helpers/apply-fixtures.js";
import {
  APPLY_TOKEN_CANARY, ARM_FEDERATED_TOKEN_CANARY, AZ_VERSION, CANARY, CLIENTS, LOCATION, FAKE_AZ_SHA256, RESOLVED, RESOURCE_GROUP, STACK_NAME, SUBSCRIPTION_ID, TEMPLATE_CANARY, TENANT_ID, VNET_ID,
  behave, callsOf, identityEnv, installFakes, patch, stateOf, vnetTemplate, writeBicepProject,
} from "./helpers/bicep-fixtures.js";

// Azure Bicep admission (path 4; owner decision E2, #39). SYNTHETIC: the `az` and `bicep` executables are fakes and Azure Resource
// Manager is a scripted HTTP client, so this pins the product's logic for a BICEP contract through the driver (contract, requester
// signature, approvals, ledger, kill switch, evidence, the canary allowlist, the blueprint hook, observe, proposal, cleanup and
// leftovers). There is no ARM emulator: nothing here is emulation or provider qualification, and it never stands for a live
// subscription. Registration is not readiness; live qualification needs the owner's authorization.

const root = mkdtempSync(join(tmpdir(), "alz-bicep-admission-"));
test.after(() => removeTree(root));
const toolDir = join(root, "bin");
installFakes(toolDir);
let counter = 0;
const fresh = (label: string): string => { const dir = join(root, label + "-" + counter++); mkdirSync(dir, { recursive: true, mode: 0o700 }); return dir; };
const KILL = join(root, "kill-switch");
const STACK_ID = "/subscriptions/" + SUBSCRIPTION_ID + "/resourceGroups/" + RESOURCE_GROUP + "/providers/Microsoft.Resources/deploymentStacks/" + STACK_NAME;

const bicepContract = (over: Record<string, unknown> = {}) => ({
  schemaVersion: 1, enabled: true, provider: "AZURE", engine: "BICEP", enabledEnvironments: ["DEV"],
  targets: { DEV: { tenantId: TENANT_ID, subscriptionId: SUBSCRIPTION_ID, backend: STACK_NAME, workspace: "default", resourceGroup: RESOURCE_GROUP, location: LOCATION, canary: CANARY } },
  requiredApprovals: { DEV: 1 }, maxApprovalAgeMinutes: 60, approvers, killSwitchPath: KILL, authorize: { DEV: ["APPLY", "CLEANUP"] }, ...over,
});
const contractAt = (contract: unknown): string => { const path = join(fresh("contract"), "act-pilot-contract.json"); writeReviewedContract(path, contract); return path; };
const reason = (raw: unknown): string => { const r = inspectPilotContract(raw); return r.ok ? "OK" : r.reason; };

// --- the contract ----------------------------------------------------------------------------------------------------------

test("BICEP is a registered engine admitted with Azure for DEV only: the DEV-only contract loads and authorizes; three stages, another provider, a missing or bad resource group are refused", () => {
  assert.ok(ENGINE_IDS.includes("BICEP"));
  assert.equal(engineSpec("BICEP"), BICEP);
  const loaded = loadPilotContract(contractAt(bicepContract()));
  assert.ok(!("reason" in loaded), JSON.stringify(loaded));
  const authorized = authorizeContract(loaded as PilotContract, "DEV", "APPLY");
  assert.ok(authorized.ok);
  assert.deepEqual(authorized.authorization.entry, { provider: "AZURE", engine: "BICEP", environment: "DEV", account: SUBSCRIPTION_ID, operations: ["APPLY", "CLEANUP"] });
  const threeStage = bicepContract({
    enabledEnvironments: undefined, requiredApprovals: { DEV: 1, QA: 1, PROD: 2 },
    targets: Object.fromEntries((["DEV", "QA", "PROD"] as const).map((env, i) => [env, { tenantId: TENANT_ID, subscriptionId: SUBSCRIPTION_ID.replace(/^2/, String(i + 3)), backend: STACK_NAME, workspace: "default", resourceGroup: RESOURCE_GROUP, location: LOCATION }])),
  });
  assert.match(reason(threeStage), /^enabledEnvironments: AZURE BICEP \(path 4\) is admitted for DEV only/);
  // Wrong provider: BICEP is Azure's only (AWS and GCP are providers the pilot has).
  assert.match(reason(bicepContract({ provider: "AWS" })), /^engine: BICEP is valid only with AZURE/);
  // GCP is an admitted provider (Terraform only, DEV only; owner decision 6481421924), so GCP with BICEP is refused by the engine's provider list.
  assert.match(reason(bicepContract({ provider: "GCP" })), /^engine: BICEP is valid only with AZURE/);
  // QA or PROD under the DEV-only scope is not a contract either.
  assert.notEqual(reason(bicepContract({ enabledEnvironments: ["QA"] })), "OK");
  assert.notEqual(reason(bicepContract({ enabledEnvironments: ["DEV", "QA"] })), "OK");
  const target = (over: Record<string, unknown>) => bicepContract({ targets: { DEV: { tenantId: TENANT_ID, subscriptionId: SUBSCRIPTION_ID, backend: STACK_NAME, workspace: "default", resourceGroup: RESOURCE_GROUP, location: LOCATION, ...over } } });
  for (const [label, over] of [["no group", { resourceGroup: undefined }], ["group with a slash", { resourceGroup: "a/b" }], ["option-like stack", { backend: "--debug" }], ["@ stack", { backend: "@x" }], ["workspace", { workspace: "other" }]] as const) {
    assert.notEqual(reason(target(over)), "OK", label);
  }
  // The resource group is where the stack is: it joins the run's target hash, so a cleanup refuses a contract that moved it.
  const hashOf = (over: Record<string, unknown>) => pilotTargetSha256(loadPilotContract(contractAt(target(over))) as PilotContract, "DEV")!;
  assert.notEqual(hashOf({}), hashOf({ resourceGroup: "alz-pilot-other" }));
  const moved = targetMoved(hashOf({}), loadPilotContract(contractAt(target({ resourceGroup: "alz-pilot-other" }))) as PilotContract, "DEV");
  assert.equal(moved?.code, "TARGET_NOT_IN_CONTRACT");
});

test("act:azure-bicep is a release path (an unmet requirement until live evidence exists); GCP's one path is Terraform", () => {
  assert.ok(ACT_RELEASE_PATHS.some((path) => path.provider === "AZURE" && path.engine === "BICEP"));
  assert.ok(ACT_RELEASE_PATHS.map(actGateId).includes("act:azure-bicep"));
  assert.deepEqual(ACT_RELEASE_PATHS.filter((path) => path.provider === "GCP").map(actGateId), ["act:gcp-terraform"], "GCP API-native has no release path yet");
});

// --- the journey -----------------------------------------------------------------------------------------------------------

type World = { deps: ApplyDeps; contractPath: string; evidenceDir: string; arm: ReturnType<typeof fakeArmHttp>; observe(at?: number): ObserveDeps; project: ReturnType<typeof writeBicepProject> };
let vaultDir = "";
test.before(async () => {
  vaultDir = fresh("qualification");
  for (const adapter of [BICEP.previewAdapter(), BICEP.applyAdapter, BICEP.cleanupAdapter!]) {
    const written = await writeQualificationEvidence({
      schemaVersion: 1, engine: "BICEP", realEngine: true, backendIdentitySeparated: true, tenantId: TENANT_ID, subscriptionId: SUBSCRIPTION_ID, backend: STACK_NAME, workspace: "default",
      stateWriteClientId: CLIENTS.DISCOVERY, applyClientId: CLIENTS.APPLY, terraformSha256: FAKE_AZ_SHA256, adapterVersion: adapter.adapterVersion, argvDigest: adapter.argvDigest,
      engineVersion: AZ_VERSION, qualifiedAt: "2026-10-11T00:00:00.000Z",
    } as never, providerSpec("AZURE")!, vaultDir);
    assert.ok(written.ok, JSON.stringify(written));
  }
});

function world(): World {
  const contractPath = contractAt(bicepContract());
  const unit = pilotUnitOf({ provider: "AZURE", contractSha256: pilotContractSha256(loadPilotContract(contractPath) as PilotContract), environment: "DEV", target: RESOLVED });
  behave(toolDir, "0.47.16", { killPath: KILL });
  rmSync(KILL, { force: true });
  const evidenceDir = fresh("evidence");
  const env = identityEnv(fresh("tokens"));
  const arm = fakeArmHttp({ existing: [VNET_ID, STACK_ID], tagged: [VNET_ID, STACK_ID] });
  const deps: ApplyDeps = {
    sourceCommit: SOURCE_COMMIT, contractPath, qualificationDir: vaultDir, evidenceDir, nonces: openNonceStore(fresh("nonces")), env, now: () => NOW,
    scratchParent: fresh("scratch"), toolDirs: [toolDir], killPollMs: 40, killGraceMs: 400,
  };
  return {
    deps, contractPath, evidenceDir, arm, project: writeBicepProject(fresh("project"), vnetTemplate({ tags: unit.tags })),
    observe: (at = 60_000) => ({ contractPath, evidenceDir, env, toolDirs: [toolDir], scratchParent: deps.scratchParent, now: () => new Date(NOW.getTime() + at), arm: arm.http }),
  };
}

async function seal(w: World) {
  const p = w.project;
  const result = await sealPreview({ invocation: human(RESOLVED), environment: "DEV", target: RESOLVED, manifest: p.manifest, projectRoot: p.projectRoot, policyVersion: POLICY,
    resolved: { engineVersion: AZ_VERSION, providers: [], dependencies: [], inputs: [] }, requester: REQUESTER }, w.deps);
  assert.ok(result.ok, JSON.stringify(result));
  const loaded = await loadSealedPlan(result.path);
  assert.ok(loaded.ok);
  return { sealed: result.sealed, loaded: { sealed: loaded.sealed, planBytes: loaded.planBytes } };
}
const cleanupApproval = (proposal: CleanupProposal, who: keyof typeof keys): SignedApproval => signApproval({
  schemaVersion: 1, artifactSha256: proposal.proposalSha256, environment: proposal.environment, target: proposal.target, approverId: who,
  issuedAt: new Date(NOW.getTime() - 5 * 60_000).toISOString(), expiresAt: new Date(NOW.getTime() + 25 * 60_000).toISOString(), nonce: randomBytes(16).toString("hex"),
}, keys[who].priv, "CLEANUP");
const noSecretIn = (label: string, ...values: unknown[]) => {
  for (const text of values.map((v) => JSON.stringify(v))) {
    for (const canary of [...CANARIES, TEMPLATE_CANARY, ARM_FEDERATED_TOKEN_CANARY, ARM_ACCESS_TOKEN_CANARY, APPLY_TOKEN_CANARY, "CANARY_CLOUD_PROPERTY_c5"]) assert.ok(!text.includes(canary), label + ": " + canary);
  }
};

test("Azure Bicep journey (SYNTHETIC): seal (what-if as APPLY), apply (one deployment stack as APPLY), the blueprint from the stack's managed resources, observe, propose the VNet, delete the whole stack, verify leftovers", async () => {
  const w = world();
  const s = await seal(w);
  assert.deepEqual(s.sealed.changes, [{ address: VNET_ID, type: "Microsoft.Network/virtualNetworks", action: "CREATE" }]);
  assert.equal(s.sealed.provenance.qualification.state, "QUALIFIED");
  assert.equal(stateOf(toolDir).stack, null, "sealing creates nothing");
  // Owner decision E2, option A: the seal-time what-if runs as APPLY; DISCOVERY only signs in and reads.
  assert.deepEqual(callsOf(toolDir).filter((call) => call.args.slice(0, 3).join(" ") === "deployment group what-if").map((call) => call.who), ["APPLY"]);

  const applied = await runApply({
    invocation: human(RESOLVED), environment: "DEV", target: { ...RESOLVED }, sealedPlan: s.loaded, manifest: w.project.manifest, projectRoot: w.project.projectRoot,
    approvals: [approvalFor(s.sealed, "alice")],
  }, { ...w.deps, killPollMs: 1 });
  assert.ok(applied.ok, JSON.stringify(applied));
  assert.equal(applied.evidence.outcome, "SUCCEEDED");
  assert.equal(applied.evidence.authority.mutation, "AZURE_DEPLOYMENT_STACK_CREATE_OF_SEALED_TEMPLATE");
  // The evidence names the product commit that sealed and ran the plan.
  assert.equal(s.sealed.sourceCommit, SOURCE_COMMIT);
  assert.equal(applied.evidence.sourceCommit, SOURCE_COMMIT);
  assert.deepEqual(stateOf(toolDir).stack?.resources, [VNET_ID]);
  const creates = callsOf(toolDir).filter((call) => call.args.slice(0, 3).join(" ") === "stack group create");
  assert.equal(creates.length, 1);
  assert.equal(creates[0]!.who, "APPLY");
  // The deny settings are on and stay on: the cleanup below runs against a stack with denyWriteAndDelete applied to child scopes.
  assert.deepEqual([stateOf(toolDir).stack?.denyMode, stateOf(toolDir).stack?.childScopes], ["denyWriteAndDelete", true]);

  // The driver's blueprint hook: the stack's managed resources, by ARM id, and the stack as the unit's container.
  const blueprint = await readBlueprintRecord(s.sealed.artifactSha256, sha256(canonicalJson(applied.evidence as never)), w.evidenceDir);
  assert.ok(blueprint, "the blueprint was kept");
  assert.equal(blueprint.source, "AZURE_DEPLOYMENT_STACK_RESOURCES");
  assert.deepEqual(blueprint.blueprint.entries.map((e) => [e.address, e.type, e.id, e.origin]), [[VNET_ID, "Microsoft.Network/virtualNetworks", VNET_ID, "IN_PLAN"]]);
  assert.deepEqual(blueprint.blueprint.container, { type: "Microsoft.Resources/deploymentStacks", identifier: STACK_ID });
  noSecretIn("blueprint", blueprint);

  const observation = await observeRun(s.sealed.artifactSha256, w.observe());
  assert.ok(observation.ok, JSON.stringify(observation));
  assert.equal(observation.record.verifier, "AZURE_RESOURCE_MANAGER");
  assert.deepEqual(observation.record.resources.map((r) => [r.address, r.result]), [[VNET_ID, "VERIFIED"]]);
  assert.deepEqual(observation.record.unexpected, [], "the stack carries the unit tags too, and is a known identifier of this run");
  noSecretIn("observation", observation.record);

  const records = await loadRunRecords(s.sealed.artifactSha256, w.evidenceDir);
  assert.ok(records.ok, JSON.stringify(records));
  const built = buildCleanupProposal({
    requesterId: REQUESTER.requesterId, ...records, changes: s.sealed.changes, channel: "CLI", contract: loadPilotContract(w.contractPath) as PilotContract,
    engineVersion: s.sealed.engineVersion, env: w.deps.env!, now: new Date(NOW.getTime() + 120_000),
  });
  assert.ok(built.ok, JSON.stringify(built));
  const proposal = signCleanupProposal(built.proposal, REQUESTER.privateKeyPem);
  assert.equal(proposal.engine, "BICEP");
  assert.deepEqual(proposal.deletes.map((d) => [d.address, d.identifier, d.observed]), [[VNET_ID, VNET_ID, "VERIFIED"]]);
  assert.deepEqual(proposal.excluded, []);

  const cleaned = await runCleanup({
    invocation: human(RESOLVED), environment: "DEV", target: { ...RESOLVED }, proposal, sealedPlan: s.loaded, manifest: w.project.manifest, projectRoot: w.project.projectRoot,
    approvals: [cleanupApproval(proposal, "alice")],
  }, { ...w.deps, killPollMs: 1 });
  assert.ok(cleaned.ok, JSON.stringify(cleaned));
  assert.equal(cleaned.evidence.authority.mutation, "AZURE_DEPLOYMENT_STACK_DELETE_OF_RUN_STACK");
  assert.deepEqual(cleaned.evidence.deletes, [VNET_ID]);
  assert.equal(stateOf(toolDir).stack, null, "the whole stack was deleted");
  assert.ok(!callsOf(toolDir).some((call) => call.who === "DISCOVERY" && call.args[0] === "deployment"), "DISCOVERY never ran a what-if in the whole journey");
  const deletes = callsOf(toolDir).filter((call) => call.args.slice(0, 3).join(" ") === "stack group delete");
  assert.equal(deletes.length, 1);
  assert.ok(deletes[0]!.args.includes("deleteResources") && deletes[0]!.args.includes(RESOURCE_GROUP));
  assert.ok(!callsOf(toolDir).some((call) => call.args[0] === "group" && call.args[1] === "delete"), "the pilot resource group is never deleted");

  // The VNet is gone (ARM answers 404 for its id) and nothing carries the unit's tag any more.
  w.arm.behave({ existing: [], tagged: [], fail: { [VNET_ID]: 404 } });
  const leftovers = await verifyProposalLeftovers(proposal, w.observe(600_000));
  assert.ok(leftovers.ok, JSON.stringify(leftovers));
  const vnet = leftovers.record.resources.find((r) => r.address === VNET_ID)!;
  assert.deepEqual([vnet.disposition, vnet.basis], ["CONFIRMED_DELETED", "ARM_ABSENT"]);
  noSecretIn("records", proposal, cleaned.evidence, leftovers.record);
  assert.ok(callsOf(toolDir).every((call) => !call.args.some((arg) => arg.includes(ARM_FEDERATED_TOKEN_CANARY) || arg.includes(APPLY_TOKEN_CANARY))), "no token in argv");
});

test("Azure Bicep refusals (SYNTHETIC): a three-stage contract seals nothing; a contract that moved the stack's group refuses the cleanup proposal, and nothing is deleted", async () => {
  const w0 = world();
  writeReviewedContract(w0.contractPath, bicepContract({ enabledEnvironments: undefined }));
  const p = w0.project;
  const refused = await sealPreview({ invocation: human(RESOLVED), environment: "DEV", target: RESOLVED, manifest: p.manifest, projectRoot: p.projectRoot, policyVersion: POLICY,
    resolved: { engineVersion: AZ_VERSION, providers: [], dependencies: [], inputs: [] }, requester: REQUESTER }, w0.deps);
  assert.equal((refused as { code?: string }).code, "CONTRACT_INVALID");
  assert.equal(callsOf(toolDir).length, 0, "no az or bicep ran");

  const w = world();
  const s = await seal(w);
  const applied = await runApply({
    invocation: human(RESOLVED), environment: "DEV", target: { ...RESOLVED }, sealedPlan: s.loaded, manifest: w.project.manifest, projectRoot: w.project.projectRoot,
    approvals: [approvalFor(s.sealed, "alice")],
  }, { ...w.deps, killPollMs: 1 });
  assert.ok(applied.ok, JSON.stringify(applied));
  assert.ok((await observeRun(s.sealed.artifactSha256, w.observe())).ok);
  // The owner's committed contract now points the same stack name at another group: no cleanup can be proposed for this run, and the stack stays.
  writeReviewedContract(w.contractPath, bicepContract({ targets: { DEV: { tenantId: TENANT_ID, subscriptionId: SUBSCRIPTION_ID, backend: STACK_NAME, workspace: "default", resourceGroup: "alz-pilot-other", location: LOCATION } } }));
  const records = await loadRunRecords(s.sealed.artifactSha256, w.evidenceDir);
  assert.ok(records.ok);
  const moved = buildCleanupProposal({
    requesterId: REQUESTER.requesterId, ...records, changes: s.sealed.changes, channel: "CLI", contract: loadPilotContract(w.contractPath) as PilotContract,
    engineVersion: s.sealed.engineVersion, env: w.deps.env!, now: new Date(NOW.getTime() + 120_000),
  });
  assert.equal(moved.ok, false);
  assert.equal((moved as { code?: string }).code, "TARGET_NOT_IN_CONTRACT", JSON.stringify(moved));
  assert.ok(!callsOf(toolDir).some((call) => call.args.slice(0, 3).join(" ") === "stack group delete"));
  assert.deepEqual(stateOf(toolDir).stack?.resources, [VNET_ID], "nothing was deleted");
});

// --- owner decision E2: the driver-level refusals ------------------------------------------------------------------------

const azSub = (call: { args: string[] }) => call.args.slice(0, 3).join(" ");
const sealWith = (w: World, over: Partial<Parameters<typeof sealPreview>[0]> = {}) => sealPreview({
  invocation: human(RESOLVED), environment: "DEV", target: RESOLVED, manifest: w.project.manifest, projectRoot: w.project.projectRoot, policyVersion: POLICY,
  resolved: { engineVersion: AZ_VERSION, providers: [], dependencies: [], inputs: [] }, requester: REQUESTER, ...over,
}, w.deps);
const applyWith = (w: World, s: Awaited<ReturnType<typeof seal>>, approvals: SignedApproval[], deps: ApplyDeps = { ...w.deps, killPollMs: 1 }) => runApply({
  invocation: human(RESOLVED), environment: "DEV", target: { ...RESOLVED }, sealedPlan: s.loaded, manifest: w.project.manifest, projectRoot: w.project.projectRoot, approvals,
}, deps);

test("Azure Bicep ledger and kill switch (SYNTHETIC): an approval is used once, an applied plan never runs again, and the kill switch refuses seal and apply before any az call", async () => {
  const w = world();
  const s = await seal(w);
  const approval = approvalFor(s.sealed, "alice");
  const first = await applyWith(w, s, [approval]);
  assert.ok(first.ok, JSON.stringify(first));
  // The same sealed plan and the same approval again: the ledger refuses it before the engine starts.
  const again = await applyWith(w, s, [approval]);
  assert.equal(again.ok, false);
  assert.ok(["ARTIFACT_ALREADY_APPLIED", "APPROVAL_REPLAYED"].includes((again as { code: string }).code), JSON.stringify(again));
  // A fresh approval for the spent plan is refused as well.
  const fresh2 = await applyWith(w, s, [approvalFor(s.sealed, "alice")]);
  assert.equal((fresh2 as { code?: string }).code, "ARTIFACT_ALREADY_APPLIED", JSON.stringify(fresh2));
  assert.equal(callsOf(toolDir).filter((call) => azSub(call) === "stack group create").length, 1, "one create, ever");

  const k = world();
  const ks = await seal(k);
  writeFileSync(KILL, "stop");
  const before = callsOf(toolDir).length;
  const sealRefused = await sealWith(k);
  assert.equal((sealRefused as { code?: string }).code, "KILL_SWITCH_ACTIVE");
  const applyRefused = await applyWith(k, ks, [approvalFor(ks.sealed, "alice")]);
  assert.equal((applyRefused as { code?: string }).code, "KILL_SWITCH_ACTIVE");
  assert.equal(callsOf(toolDir).length, before, "no az or bicep ran under the kill switch");
  assert.equal(stateOf(toolDir).stack, null);
  rmSync(KILL, { force: true });
});

test("Azure Bicep template binding (SYNTHETIC): the apply runs only the compiled template the approvers saw; a changed project or compiler output is refused before the create", async () => {
  // The project changed after the seal: the manifest no longer matches.
  const w = world();
  const s = await seal(w);
  writeFileSync(join(w.project.projectRoot, "main.bicep"), vnetTemplate({ addressPrefix: "10.251.0.0/24" }));
  const changed = await applyWith(w, s, [approvalFor(s.sealed, "alice")]);
  assert.equal((changed as { code?: string }).code, "ARTIFACT_TAMPERED", JSON.stringify(changed));
  // The same project compiles to other bytes (another compiler build): the engine compares them with the sealed template.
  const v = world();
  const vs = await seal(v);
  patch(toolDir, { bicepOutput: vnetTemplate({ addressPrefix: "10.252.0.0/24" }) });
  const recompiled = await applyWith(v, vs, [approvalFor(vs.sealed, "alice")]);
  assert.equal((recompiled as { code?: string }).code, "ARTIFACT_TAMPERED", JSON.stringify(recompiled));
  assert.match((recompiled as { message: string }).message, /no approval was consumed/);
  assert.ok(!callsOf(toolDir).some((call) => azSub(call) === "stack group create"), "nothing was created");
  assert.equal(stateOf(toolDir).stack, null);
});

test("Azure Bicep scope (SYNTHETIC): QA, PROD, another provider and another target are refused before any az call", async () => {
  const w = world();
  for (const environment of ["QA", "PROD"] as const) {
    const refused = await sealWith(w, { environment });
    // The DEV-only contract has no QA or PROD target, so neither can be sealed, approved or applied.
    assert.equal((refused as { code?: string }).code, "TARGET_NOT_IN_CONTRACT", environment);
  }
  const other = { ...RESOLVED, account: "33333333-3333-4333-8333-333333333333" };
  const wrongTarget = await sealWith(w, { invocation: human(other), target: other });
  assert.equal((wrongTarget as { code?: string }).code, "TARGET_NOT_IN_CONTRACT", JSON.stringify(wrongTarget));
  const otherStack = { ...RESOLVED, backend: "another-stack" };
  assert.equal(((await sealWith(w, { invocation: human(otherStack), target: otherStack })) as { code?: string }).code, "TARGET_NOT_IN_CONTRACT");
  writeReviewedContract(w.contractPath, bicepContract({ provider: "AWS" }));
  assert.equal(((await sealWith(w)) as { code?: string }).code, "CONTRACT_INVALID");
  writeReviewedContract(w.contractPath, bicepContract({ enabledEnvironments: undefined, requiredApprovals: { DEV: 1, QA: 1, PROD: 2 } }));
  assert.equal(((await sealWith(w)) as { code?: string }).code, "CONTRACT_INVALID");
  assert.equal(callsOf(toolDir).length, 0, "no az or bicep ran");
});

test("Azure Bicep canary allowlist through the driver (SYNTHETIC): a contract whose canary is not exactly the one network, or that names none, seals nothing", async () => {
  for (const [label, canary, code] of [
    ["two networks", { resources: [{ type: "Microsoft.Network/virtualNetworks", count: 2 }] }, "RESOURCE_NOT_IN_CANARY"],
    ["another type", { resources: [{ type: "Microsoft.Storage/storageAccounts", count: 1 }] }, "RESOURCE_NOT_IN_CANARY"],
    ["none", undefined, "CANARY_ALLOWLIST_MISSING"],
  ] as const) {
    const w = world();
    writeReviewedContract(w.contractPath, bicepContract({ targets: { DEV: { tenantId: TENANT_ID, subscriptionId: SUBSCRIPTION_ID, backend: STACK_NAME, workspace: "default", resourceGroup: RESOURCE_GROUP, location: LOCATION, ...(canary ? { canary } : {}) } } }));
    const refused = await sealWith(w);
    assert.equal((refused as { code?: string }).code, code, label + ": " + JSON.stringify(refused));
    assert.ok(!callsOf(toolDir).some((call) => azSub(call) === "deployment group what-if" || azSub(call) === "stack group create"), label);
  }
  // A wildcard or pattern is not a canary type.
  assert.notEqual(reason(bicepContract({ targets: { DEV: { tenantId: TENANT_ID, subscriptionId: SUBSCRIPTION_ID, backend: STACK_NAME, workspace: "default", resourceGroup: RESOURCE_GROUP, location: LOCATION, canary: { resources: [{ type: "Microsoft.Network/*", count: 1 }] } } } })), "OK");
});

// --- review of #332: location (B1) and the stack container (B2, N4) --------------------------------------------------------

test("B1 (SYNTHETIC): the location is a target field in the target hash, and a plan placed elsewhere is never sealed or applied", async () => {
  const target = (over: Record<string, unknown>) => bicepContract({ targets: { DEV: { tenantId: TENANT_ID, subscriptionId: SUBSCRIPTION_ID, backend: STACK_NAME, workspace: "default", resourceGroup: RESOURCE_GROUP, location: LOCATION, canary: CANARY, ...over } } });
  const hashOf = (over: Record<string, unknown>) => pilotTargetSha256(loadPilotContract(contractAt(target(over))) as PilotContract, "DEV")!;
  assert.notEqual(hashOf({}), hashOf({ location: "westeurope" }), "a changed location is a target change");
  assert.equal(targetMoved(hashOf({}), loadPilotContract(contractAt(target({ location: "westeurope" }))) as PilotContract, "DEV")?.code, "TARGET_NOT_IN_CONTRACT");
  const { location: _omitted, ...noLocation } = (target({}).targets as { DEV: Record<string, unknown> }).DEV;
  assert.match(reason(bicepContract({ targets: { DEV: noLocation } })), /targets\.DEV\.location: missing/);
  for (const bad of ["East US 2", "west-europe", "*"]) assert.match(reason(target({ location: bad })), /targets\.DEV\.location: invalid/, bad);
  // The reviewer's driver repro: a location default of westeurope against a group in eastus2 is refused at seal; nothing is applied.
  const w = world();
  const template = JSON.parse(readFileSync(join(w.project.projectRoot, "main.bicep"), "utf8"));
  template.parameters.location.defaultValue = "westeurope";
  const moved = { ...w, project: writeBicepProject(fresh("project"), JSON.stringify(template)) };
  const refused = await sealWith(moved);
  assert.equal((refused as { code?: string }).code, "ARTIFACT_INVALID", JSON.stringify(refused));
  assert.match((refused as { message: string }).message, /LOCATION_NOT_IN_CONTRACT/);
  assert.ok(!callsOf(toolDir).some((call) => azSub(call) === "stack group create"));
  assert.equal(stateOf(toolDir).stack, null);
});

test("B2/N4: the deployment stack container is the pinned stack only: parsed, not matched by a pattern, in the pinned subscription and group", () => {
  const id = (sub: string, group: string, ns: string, type: string, name: string) => "/subscriptions/" + sub + "/resourceGroups/" + group + "/providers/" + ns + "/" + type + "/" + name;
  const pinned = { subscription: SUBSCRIPTION_ID, stack: STACK_NAME, resourceGroup: RESOURCE_GROUP };
  assert.equal(isPinnedDeploymentStackId(STACK_ID, pinned), true);
  assert.equal(isPinnedDeploymentStackId(STACK_ID.toUpperCase().replace("/SUBSCRIPTIONS/", "/subscriptions/"), pinned), true, "ARM compares ids case-insensitively");
  for (const [label, value] of [
    ["another group", id(SUBSCRIPTION_ID, "alz-pilot-other", "Microsoft.Resources", "deploymentStacks", STACK_NAME)],
    ["another subscription", id("33333333-3333-4333-8333-333333333333", RESOURCE_GROUP, "Microsoft.Resources", "deploymentStacks", STACK_NAME)],
    ["another stack", id(SUBSCRIPTION_ID, RESOURCE_GROUP, "Microsoft.Resources", "deploymentStacks", "other")],
    ["a name a pattern would match", id(SUBSCRIPTION_ID, RESOURCE_GROUP, "Microsoft.Resources", "deploymentStacks", STACK_NAME.replace("-", "."))],
    ["a deployment, not a stack", id(SUBSCRIPTION_ID, RESOURCE_GROUP, "Microsoft.Resources", "deployments", STACK_NAME)],
    ["a child of the stack", STACK_ID + "/snapshots/x"],
    ["a subscription-scoped stack", "/subscriptions/" + SUBSCRIPTION_ID + "/providers/Microsoft.Resources/deploymentStacks/" + STACK_NAME],
    ["not an id", "deploymentStacks/" + STACK_NAME],
  ] as const) assert.equal(isPinnedDeploymentStackId(value, pinned), false, label);
  assert.equal(isPinnedDeploymentStackId(id(SUBSCRIPTION_ID, "alz-pilot-other", "Microsoft.Resources", "deploymentStacks", STACK_NAME), { subscription: SUBSCRIPTION_ID, stack: STACK_NAME }), true, "the record check, which has no group, binds subscription and stack");
});
