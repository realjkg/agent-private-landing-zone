import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { signApproval } from "../src/apply/approval.js";
import {
  buildCleanupProposal, buildLocationRemediationProposal, computeProposalSha256, proposalLines, signCleanupProposal, verifyCleanupProposal, type CleanupProposal, type ProposalInput,
} from "../src/apply/cleanup-proposal.js";
import { loadPilotContract, pilotContractSha256 } from "../src/apply/contract.js";
import { runApply, runCleanup, sealPreview, type ApplyDeps } from "../src/apply/driver.js";
import { readCleanupEvidence } from "../src/apply/ledger.js";
import { openNonceStore } from "../src/apply/nonces.js";
import { loadRunRecords, observeRun, verifyProposalLeftovers, type ObserveDeps } from "../src/apply/observe.js";
import { observationRecordProblems, readObservationRecord } from "../src/apply/run-records.js";
import { loadSealedPlan } from "../src/apply/seal.js";
import type { PilotContract, SignedApproval } from "../src/apply/types.js";
import { pilotUnitOf } from "../src/apply/unit.js";
import { createDiscoveryArmReader } from "../src/observe/azure-rest.js";
import { removeTree } from "../src/teardown/driver/cleanup.js";
import { runApplyCommand, type ApplyCliDeps } from "../src/cli/apply.js";
import { targetString } from "../src/cli/teardown-driver.js";
import {
  ARM_FEDERATED_TOKEN_CANARY, AZURE_LOCATION_FIXTURE, DEV_TARGET, NOW, POLICY, REQUESTER, SOURCE_COMMIT, approvalFor, azureStateResource, behave as behaveIn, callsOf, contractJson,
  fakeArmHttp, human, identityEnv, installFakeTerraform, keys, reHashedProposal, requesterArgs, targetOf, testFixtureForgeQualificationEvidence, withCanary, writeProject, writeReviewedContract,
  type ArmBehavior, type Behavior,
} from "./helpers/apply-fixtures.js";

// The governed location remediation (owner decision 6486426552, item 2): an Azure Terraform virtual network this run created and the
// independent observation found outside the contract's location. SYNTHETIC: the engine is the fake Terraform and the cloud is the
// scripted ARM client; nothing here reaches Azure, and none of it is live provider evidence. It pins the product's logic: the
// mismatch stays a FAILED observation, an ordinary cleanup is still refused, the remediation is a cleanup proposal of its own kind
// (same requester, approvals, ledger, kill switch and CLEANUP authorization), it binds the exact resource id, the run, its target,
// the contract, the observed location and the ownership evidence, it is rechecked as DISCOVERY and against the engine's state
// immediately before any approval is consumed, and absence is verified independently afterward.

const root = mkdtempSync(join(tmpdir(), "alz-remediate-"));
const toolDir = mkdtempSync(join(tmpdir(), "alz-remediate-tf-"));
test.after(() => { removeTree(root); removeTree(toolDir); });
installFakeTerraform(toolDir);
let counter = 0;
const fresh = (label: string): string => { const path = join(root, label + "-" + (counter += 1)); mkdirSync(path, { recursive: true, mode: 0o700 }); return path; };
const KILL = join(root, "KILL");
const SUB = DEV_TARGET.account;
const VNET = "/subscriptions/" + SUB + "/resourceGroups/alz-pilot-dev/providers/Microsoft.Network/virtualNetworks/vnet-alz-pilot-dev";
const ADDRESS = "azurerm_virtual_network.pilot";
/** The contract's authorized location is the fixtures' (westeurope); the network is found in another. */
const AUTHORIZED = AZURE_LOCATION_FIXTURE;
const WRONG = "eastus2";
const AZURERM = "registry.terraform.io/hashicorp/azurerm";
const VNET_CANARY = { resources: [{ type: "azurerm_virtual_network", count: 1 }] };
/** A plan that creates exactly the canary's network at the contract's location: the seal and the apply accept it. */
const CREATES = [{ address: ADDRESS, mode: "managed", type: "azurerm_virtual_network", provider_name: AZURERM,
  change: { actions: ["create"], before: null, after: { name: "vnet-alz-pilot-dev", address_space: ["10.250.0.0/24"], location: AUTHORIZED } } }];
const PLANNED_VALUES = { planned_values: { root_module: { resources: [{ address: ADDRESS, mode: "managed", type: "azurerm_virtual_network", provider_name: AZURERM, values: { location: AUTHORIZED } }] } } };
const STATE = [azureStateResource("azurerm_virtual_network", "pilot", VNET)];
const runContract = (over: Record<string, unknown> = {}) => withCanary(contractJson(KILL, over), VNET_CANARY);
const unitOf = (contract: unknown) => {
  const path = join(fresh("contract"), "act-pilot-contract.json");
  writeReviewedContract(path, contract);
  return pilotUnitOf({ provider: "AZURE", contractSha256: pilotContractSha256(loadPilotContract(path) as PilotContract), environment: "DEV", target: targetOf("DEV") });
};
const UNIT = unitOf(runContract());
const behave = (behavior: Behavior = {}) => behaveIn(toolDir, KILL, {
  applyAdvance: true, showOnlyConfigured: true, showResources: CREATES, showDocumentExtra: PLANNED_VALUES, stateResources: STATE, unitTags: { ...UNIT.tags }, unitTagAttribute: "tags", ...behavior,
});
const calls = () => callsOf(toolDir);
const applyCalls = () => calls().filter((c) => c.args[0] === "apply");
const destroyPlans = () => calls().filter((c) => c.args[0] === "plan" && c.args[1] === "-destroy");
const refused = (result: unknown, code: string, label = "") => {
  assert.equal((result as { ok: boolean }).ok, false, label + " " + JSON.stringify(result).slice(0, 400));
  assert.equal((result as { code?: string }).code, code, label + " " + JSON.stringify(result).slice(0, 400));
};

const tokenFile = join(fresh("token"), "discovery-oidc-token");
writeFileSync(tokenFile, ARM_FEDERATED_TOKEN_CANARY + "\n", { mode: 0o600 });
const env = (): NodeJS.ProcessEnv => ({ ...identityEnv("DEV"), ALZ_DISCOVERY_ARM_OIDC_TOKEN_FILE: tokenFile });
/** The run's network, found in the wrong location, tagged with the run's unit, and nothing else. */
const MISPLACED: ArmBehavior = { existing: [VNET], tagged: [VNET], locations: { [VNET]: WRONG } };

type World = { deps: ApplyDeps; dirs: { scratch: string; evidence: string; nonces: string }; contractPath: string; contract: unknown; arm: ReturnType<typeof fakeArmHttp> };
let vaultDir = "";
test.before(async () => {
  vaultDir = fresh("qualification");
  await testFixtureForgeQualificationEvidence(vaultDir);
});
function world(cloud: ArmBehavior = MISPLACED, contract: unknown = runContract()): World {
  const dirs = { scratch: fresh("scratch"), evidence: fresh("evidence"), nonces: fresh("nonces") };
  const contractPath = join(fresh("contract"), "act-pilot-contract.json");
  writeReviewedContract(contractPath, contract);
  behave();
  const arm = fakeArmHttp(cloud, { defaultLocation: AUTHORIZED });
  return {
    dirs, contractPath, contract, arm,
    deps: {
      sourceCommit: SOURCE_COMMIT, contractPath, qualificationDir: vaultDir, evidenceDir: dirs.evidence, nonces: openNonceStore(dirs.nonces),
      env: env(), now: () => NOW, scratchParent: dirs.scratch, toolDirs: [toolDir], killPollMs: 40, killGraceMs: 400, arm: arm.http,
    },
  };
}
const observeDeps = (w: World): ObserveDeps => ({
  contractPath: w.contractPath, evidenceDir: w.dirs.evidence, env: w.deps.env, toolDirs: w.deps.toolDirs, scratchParent: w.dirs.scratch, now: () => new Date(NOW.getTime() + 60_000), arm: w.arm.http,
});

async function applied(w: World) {
  const target = targetOf("DEV");
  const project = writeProject(fresh("project"), target);
  const sealedResult = await sealPreview({ invocation: human(target), environment: "DEV", target, manifest: project.manifest, projectRoot: project.projectRoot, policyVersion: POLICY, resolved: project.resolved, requester: REQUESTER }, w.deps);
  assert.ok(sealedResult.ok, JSON.stringify(sealedResult));
  const loaded = await loadSealedPlan(sealedResult.path);
  assert.ok(loaded.ok);
  const s = { sealed: sealedResult.sealed, project, loaded: { sealed: loaded.sealed, planBytes: loaded.planBytes } };
  const result = await runApply({
    invocation: human(target), environment: "DEV", target: { ...target }, sealedPlan: s.loaded, manifest: project.manifest, projectRoot: project.projectRoot, approvals: [approvalFor(s.sealed, "alice")],
  }, w.deps);
  assert.ok(result.ok, JSON.stringify(result));
  const observation = await observeRun(s.sealed.artifactSha256, observeDeps(w));
  assert.ok(observation.ok, JSON.stringify(observation));
  const records = await loadRunRecords(s.sealed.artifactSha256, w.dirs.evidence);
  assert.ok(records.ok, JSON.stringify(records));
  return { s, observation, records };
}
type Run = Awaited<ReturnType<typeof applied>>;
const inputOf = (w: World, run: Run, over: Partial<ProposalInput> = {}): ProposalInput => ({
  requesterId: REQUESTER.requesterId, ...(run.records as Extract<Run["records"], { ok: true }>), changes: run.s.sealed.changes, channel: "CLI", contract: loadPilotContract(w.contractPath) as PilotContract,
  engineVersion: run.s.sealed.engineVersion, env: w.deps.env!, now: new Date(NOW.getTime() + 120_000), ...over,
});
function proposed(w: World, run: Run): CleanupProposal {
  const built = buildLocationRemediationProposal(inputOf(w, run));
  assert.ok(built.ok, JSON.stringify(built));
  return signCleanupProposal(built.proposal, REQUESTER.privateKeyPem);
}
const approval = (proposal: CleanupProposal, who: keyof typeof keys = "alice"): SignedApproval => signApproval({
  schemaVersion: 1, artifactSha256: proposal.proposalSha256, environment: proposal.environment, target: proposal.target, approverId: who,
  issuedAt: new Date(NOW.getTime() - 5 * 60_000).toISOString(), expiresAt: new Date(NOW.getTime() + 25 * 60_000).toISOString(), nonce: randomBytes(16).toString("hex"),
}, keys[who].priv, "CLEANUP");
const remediate = (w: World, run: Run, proposal: CleanupProposal, approvals: SignedApproval[] = [approval(proposal)]) => runCleanup({
  invocation: human(run.s.sealed.target), environment: "DEV", target: { ...run.s.sealed.target }, proposal, sealedPlan: run.s.loaded, manifest: run.s.project.manifest, projectRoot: run.s.project.projectRoot, approvals,
}, w.deps);
/** The ARM GETs of the network itself (not the provider's API versions or the tag listing). */
const vnetReads = (w: World) => w.arm.calls.filter((c) => c.method === "GET" && new URL(c.url).pathname.toLowerCase() === VNET.toLowerCase()).length;

// --- the end-to-end journey ---------------------------------------------------------------------------------------------------

test("location remediation (SYNTHETIC): a run's network found in the wrong location stays a FAILED observation, an ordinary cleanup is refused with a way forward, and the remediation is proposed, shown, approved, rechecked, deleted by its exact id and verified absent", async () => {
  const w = world();
  const run = await applied(w);
  // The mismatch is recorded as a verification failure, with where the network was found; the run's records are never rewritten.
  const recorded = run.observation.ok ? run.observation.record : assert.fail();
  assert.equal(recorded.verdict, "FAILED");
  assert.deepEqual(recorded.resources, [{ address: ADDRESS, type: "azurerm_virtual_network", identifier: VNET, origin: "IN_PLAN", result: "DIFFERENT_FROM_DESIRED", reason: "LOCATION_NOT_IN_CONTRACT", observedLocation: WRONG }]);
  assert.equal(recorded.inventory, "COMPLETE");

  // Ordinary target binding is unchanged: no ordinary cleanup for a location mismatch, and the refusal no longer says to observe again (#343 N2).
  const ordinary = buildCleanupProposal(inputOf(w, run));
  refused(ordinary, "LOCATION_MISMATCH");
  const message = (ordinary as { message: string }).message;
  assert.match(message, /propose-remediation/);
  assert.match(message, new RegExp(WRONG));
  assert.doesNotMatch(message, /Observe this run again/);

  // The remediation binds every fact the owner named, by hash.
  const proposal = proposed(w, run);
  assert.equal(proposal.kind, "LOCATION_REMEDIATION");
  assert.deepEqual(proposal.deletes, [{ address: ADDRESS, type: "azurerm_virtual_network", identifier: VNET, ownership: "RUN_CREATED", observed: "VERIFIED" }]);
  assert.deepEqual(proposal.excluded, []);
  assert.deepEqual(proposal.alreadyAbsent, []);
  assert.deepEqual(proposal.remediation, {
    reason: "LOCATION_NOT_IN_CONTRACT", address: ADDRESS, type: "azurerm_virtual_network", resourceId: VNET, authorizedLocation: AUTHORIZED, observedLocation: WRONG,
    verificationFailure: { verdict: "FAILED", result: "DIFFERENT_FROM_DESIRED", observedAt: recorded.observedAt },
    ownership: { plannedAction: "CREATE", importing: false, stateOrigin: "IN_PLAN", unitId: UNIT.unitId, sweep: "COMPLETE" },
  });
  const records = run.records.ok ? run.records : assert.fail();
  assert.equal(proposal.artifactSha256, run.s.sealed.artifactSha256);
  assert.equal(proposal.applyEvidenceSha256, records.applyEvidenceSha256);
  assert.equal(proposal.observationSha256, records.observationSha256);
  assert.equal(proposal.targetSha256, records.applyEvidence.targetSha256);
  assert.equal(proposal.contractSha256, records.applyEvidence.contractSha256);
  assert.deepEqual(proposal.authorization, { subject: "CLEANUP", requiredApprovals: 1, executesAs: "APPLY" });
  assert.ok(verifyCleanupProposal(proposal).ok);
  // The approver sees the mismatch explicitly, before the deletion list.
  const lines = proposalLines(proposal).join("\n");
  assert.match(lines, /LOCATION REMEDIATION/);
  assert.match(lines, new RegExp("observed " + WRONG + ", but the contract authorizes " + AUTHORIZED));
  assert.ok(lines.indexOf("LOCATION ") < lines.indexOf("deletes (1)"));
  assert.ok(proposal.risks.some((risk) => /never corrects the region, moves the network or creates it again/.test(risk)));

  // Approve and run: rechecked as DISCOVERY immediately before deletion, then the targeted destroy of exactly that address.
  const readsBefore = vnetReads(w);
  const result = await remediate(w, run, proposal);
  assert.ok(result.ok, JSON.stringify(result));
  assert.equal(vnetReads(w), readsBefore + 1, "the network was read again as DISCOVERY before the delete");
  assert.deepEqual(destroyPlans().map((c) => c.args.filter((a) => a.startsWith("-target="))), [["-target=" + ADDRESS]]);
  assert.equal(applyCalls().length, 2, "the run's apply, then the one destroy of the approved plan");
  const evidence = await readCleanupEvidence(proposal.proposalSha256, w.dirs.evidence);
  assert.deepEqual(evidence?.deletes, [ADDRESS]);
  assert.equal(evidence?.decisions.authorized.operation, "CLEANUP");

  // Absence verified independently afterward; the run's observation still says FAILED.
  // (The scripted client answers 404 for the deleted network, as ARM does; its type stays known to the provider listing.)
  w.arm.behave({ existing: [], tagged: [], fail: { [VNET]: 404 } });
  const leftovers = await verifyProposalLeftovers(proposal, observeDeps(w));
  assert.ok(leftovers.ok, JSON.stringify(leftovers));
  if (leftovers.ok) {
    assert.equal(leftovers.record.disposition, "COMPLETE", JSON.stringify(leftovers.record));
    assert.deepEqual(leftovers.record.resources.map((r) => [r.address, r.disposition, r.basis]), [[ADDRESS, "CONFIRMED_DELETED", "ARM_ABSENT"]]);
  }
  const after = await readObservationRecord(run.s.sealed.artifactSha256, records.applyEvidenceSha256, w.dirs.evidence);
  assert.equal(after?.verdict, "FAILED");

  // A proposal runs once: replaying it after the deletion is refused.
  refused(await remediate(w, run, proposal), "PROPOSAL_ALREADY_EXECUTED");
});

// --- eligibility --------------------------------------------------------------------------------------------------------------

test("location remediation eligibility: only a run that created exactly one network, now found elsewhere with clean, complete records; anything pre-existing, ambiguous, unobserved or of another path is not eligible", async () => {
  const w = world();
  const run = await applied(w);
  const base = inputOf(w, run);
  const notEligible = (over: Partial<ProposalInput>, label: string) => refused(buildLocationRemediationProposal({ ...base, ...over }), "REMEDIATION_NOT_ELIGIBLE", label);
  const obs = base.observation;
  const net = obs.resources[0];
  const blue = base.blueprint;
  const entry = blue.blueprint.entries[0];
  const change = base.changes.find((c) => c.address === ADDRESS)!;

  // Not created by this run: an update, a replacement, an import, a moved address.
  notEligible({ changes: [{ ...change, action: "UPDATE" }] }, "pre-existing (update)");
  notEligible({ changes: [{ ...change, action: "REPLACE" }] }, "replaced");
  notEligible({ changes: [{ ...change, importing: true }] }, "imported");
  notEligible({ changes: [{ ...change, previousAddress: "azurerm_virtual_network.old" }] }, "moved");
  // More than the one network, or another type.
  notEligible({ changes: [change, { address: "azurerm_resource_group.pilot", type: "azurerm_resource_group", action: "CREATE" }] }, "two creates");
  notEligible({ changes: [{ ...change, type: "azurerm_resource_group" }] }, "another type");
  // The state: missing, extra, another id, not in the plan, no unit.
  notEligible({ blueprint: { ...blue, blueprint: { ...blue.blueprint, missing: [ADDRESS] } } }, "missing from state");
  notEligible({ blueprint: { ...blue, blueprint: { ...blue.blueprint, entries: [entry, { ...entry, address: "azurerm_virtual_network.other" }] } } }, "two entries");
  notEligible({ blueprint: { ...blue, blueprint: { ...blue.blueprint, entries: [{ ...entry, origin: "NOT_IN_PLAN" }] } } }, "not in plan");
  notEligible({ blueprint: { ...blue, blueprint: { ...blue.blueprint, entries: [{ ...entry, id: null }] } } }, "no id");
  for (const [label, id] of [
    ["another subscription", VNET.replace(SUB, "99999999-9999-4999-8999-999999999999")],
    ["not a network", VNET.replace("virtualNetworks", "networkSecurityGroups")],
    ["a subnet", VNET + "/subnets/default"],
    ["a group", "/subscriptions/" + SUB + "/resourceGroups/alz-pilot-dev"],
    ["unsafe path", VNET.replace("alz-pilot-dev/", "alz-pilot-dev/../")],
  ] as const) {
    notEligible({ blueprint: { ...blue, blueprint: { ...blue.blueprint, entries: [{ ...entry, id }] } }, observation: { ...obs, resources: [{ ...net, identifier: id }] } }, label);
  }
  notEligible({ blueprint: { ...blue, unitId: null } }, "no unit");
  // The observation: not FAILED, not this resource, not outside the location, ambiguous, or without a recorded location.
  notEligible({ observation: { ...obs, verdict: "VERIFIED", resources: [{ ...net, result: "VERIFIED", reason: undefined, observedLocation: undefined }] } }, "correctly located");
  notEligible({ observation: { ...obs, resources: [{ ...net, result: "NOT_YET_OBSERVABLE", reason: "THROTTLED", observedLocation: undefined }] } }, "undecided");
  notEligible({ observation: { ...obs, resources: [{ ...net, result: "MISSING", reason: undefined, observedLocation: undefined }] } }, "already gone");
  notEligible({ observation: { ...obs, resources: [{ ...net, observedLocation: undefined }] } }, "location not recorded");
  notEligible({ observation: { ...obs, resources: [{ ...net, observedLocation: AUTHORIZED }] } }, "recorded at the authorized location");
  notEligible({ observation: { ...obs, resources: [{ ...net, identifier: VNET.replace("vnet-alz", "vnet-other") }] } }, "another id observed");
  notEligible({ observation: { ...obs, unexpected: ["/subscriptions/" + SUB + "/resourceGroups/x/providers/Microsoft.Network/virtualNetworks/stray"] } }, "something else tagged");
  notEligible({ observation: { ...obs, inventory: "INCOMPLETE" } }, "incomplete sweep");
  notEligible({ observation: { ...obs, missingFromState: [ADDRESS] } }, "missing per observation");
  notEligible({ observation: { ...obs, resources: [] } }, "no resources observed");
  // The apply did not succeed.
  notEligible({ applyEvidence: { ...base.applyEvidence, outcome: "PARTIAL_REQUIRES_REVIEW" } }, "partial apply");
  // Another path: AWS, or a target with no location, or a retained sentinel.
  const awsContract = { ...base.contract, provider: "AWS" } as PilotContract;
  notEligible({ contract: awsContract }, "AWS");
  const unlocated = structuredClone(base.contract) as PilotContract;
  delete (unlocated.targets.DEV as { location?: string }).location;
  notEligible({ contract: unlocated }, "no location in the target");
  const retained = structuredClone(base.contract) as PilotContract;
  retained.targets.DEV!.canary = { resources: [{ type: "azurerm_virtual_network", count: 1, retain: true }] };
  notEligible({ contract: retained }, "retained sentinel");
  // Records of another run, or an observation older than the apply.
  refused(buildLocationRemediationProposal({ ...base, blueprintSha256: "f".repeat(64) }), "RUN_RECORD_MISSING", "another blueprint");
  refused(buildLocationRemediationProposal({ ...base, observation: { ...obs, observedAt: new Date(NOW.getTime() - 3_600_000).toISOString() } }), "RUN_RECORD_MISSING", "stale observation");
  // The same separate CLEANUP authorization, and the run's target (location included) still the contract's.
  const noCleanup = structuredClone(base.contract) as PilotContract;
  noCleanup.authorize = { DEV: ["APPLY"] };
  refused(buildLocationRemediationProposal({ ...base, contract: noCleanup }), "ACT_NOT_AUTHORIZED", "no CLEANUP");
  const moved = structuredClone(base.contract) as PilotContract;
  (moved.targets.DEV as { location?: string }).location = "northeurope";
  refused(buildLocationRemediationProposal({ ...base, contract: moved }), "TARGET_NOT_IN_CONTRACT", "the contract's location changed");
  // And the honest input builds.
  assert.ok(buildLocationRemediationProposal(base).ok);
});

// --- schema ---------------------------------------------------------------------------------------------------------------------

test("the observation records a location only for a resource found elsewhere, and a remediation's shape is exactly one Azure Terraform network: an ordinary proposal never carries it", async () => {
  const w = world();
  const run = await applied(w);
  const obs = run.records.ok ? run.records.observation : assert.fail();
  const net = obs.resources[0];
  assert.deepEqual(observationRecordProblems(obs), []);
  assert.notDeepEqual(observationRecordProblems({ ...obs, resources: [{ ...net, result: "VERIFIED", reason: undefined }] }), [], "a location beside VERIFIED");
  assert.notDeepEqual(observationRecordProblems({ ...obs, resources: [{ ...net, observedLocation: "East US 2" }] }), [], "a display name");
  assert.notDeepEqual(observationRecordProblems({ ...obs, resources: [{ ...net, reason: "ACCESS_DENIED" }] }), [], "a location under another reason");

  const proposal = proposed(w, run);
  const { proposalSha256: _hash, request: _request, ...fields } = proposal;
  const invalid = (value: unknown, label: string) => refused(verifyCleanupProposal(value), "PROPOSAL_INVALID", label);
  invalid(reHashedProposal({ ...fields, kind: "CLEANUP_PROPOSAL" } as never), "an ordinary proposal carrying a remediation");
  const { remediation: _r, ...withoutRemediation } = fields;
  invalid(reHashedProposal(withoutRemediation as never), "a remediation without its facts");
  invalid(reHashedProposal({ ...fields, deletes: [...fields.deletes, { ...fields.deletes[0], address: "azurerm_virtual_network.other" }] } as never), "two deletions");
  invalid(reHashedProposal({ ...fields, remediation: { ...fields.remediation!, observedLocation: AUTHORIZED } } as never), "observed equals authorized");
  invalid(reHashedProposal({ ...fields, deletes: [{ ...fields.deletes[0], identifier: VNET.replace("vnet-alz", "vnet-other") }] } as never), "deletes another id than it names");
  invalid(reHashedProposal({ ...fields, engine: "BICEP" } as never), "another engine");
  invalid(reHashedProposal({ ...fields, excluded: [{ address: "x.y", type: "x", identifier: null, ownership: "NOT_IN_PLAN", reason: "r", retainedBy: "ENVIRONMENT_OWNER" }] } as never), "kept entries");
  // An ordinary proposal's hash is what it always was: no remediation key, so nothing about its identity changed.
  assert.equal(computeProposalSha256(proposal), proposal.proposalSha256);
});

// --- the driver: rebinding, recheck and replay -------------------------------------------------------------------------------

test("a remediation cannot be retargeted, relabeled, or replayed for another run: the driver derives it again from the run's records before anything is reserved or consumed", async () => {
  const w = world();
  const run = await applied(w);
  const proposal = proposed(w, run);
  const { proposalSha256: _hash, request: _request, ...fields } = proposal;
  const OTHER = VNET.replace("vnet-alz-pilot-dev", "vnet-someone-else");
  for (const [label, forged] of [
    ["another resource id", reHashedProposal({ ...fields, deletes: [{ ...fields.deletes[0], identifier: OTHER }], remediation: { ...fields.remediation!, resourceId: OTHER } })],
    ["another observed location", reHashedProposal({ ...fields, remediation: { ...fields.remediation!, observedLocation: "northeurope" } })],
    ["another authorized location", reHashedProposal({ ...fields, remediation: { ...fields.remediation!, authorizedLocation: "northeurope" } })],
    ["another address", reHashedProposal({ ...fields, deletes: [{ ...fields.deletes[0], address: "azurerm_virtual_network.other" }], remediation: { ...fields.remediation!, address: "azurerm_virtual_network.other" } })],
  ] as const) {
    const result = await remediate(w, run, forged);
    refused(result, "PROPOSAL_INVALID", label);
  }
  // Relabeled as an ordinary cleanup of the same run: it is derived by the ordinary rules, which refuse a location mismatch.
  const { remediation: _r, ...plain } = fields;
  refused(await remediate(w, run, reHashedProposal({ ...plain, kind: "CLEANUP_PROPOSAL", risks: [] } as never)), "LOCATION_MISMATCH", "relabeled");
  assert.equal(destroyPlans().length, 0, "nothing was planned");
  assert.equal(applyCalls().length, 1, "only the original apply ran");

  // Another run (its own world and records): this run's remediation does not belong to it.
  const other = world();
  behave({ planSalt: "another-run" });
  const otherRun = await applied(other);
  assert.notEqual(otherRun.s.sealed.artifactSha256, proposal.artifactSha256);
  const foreign = await runCleanup({
    invocation: human(otherRun.s.sealed.target), environment: "DEV", target: { ...otherRun.s.sealed.target }, proposal, sealedPlan: otherRun.s.loaded, manifest: otherRun.s.project.manifest,
    projectRoot: otherRun.s.project.projectRoot, approvals: [approval(proposal)],
  }, other.deps);
  assert.equal(foreign.ok, false);
  assert.ok(["RUN_RECORD_MISSING", "PROPOSAL_INVALID"].includes((foreign as { code: string }).code), JSON.stringify(foreign));

  // The honest proposal still runs: nothing above consumed anything.
  behave();
  const honest = await remediate(w, run, proposal);
  assert.ok(honest.ok, JSON.stringify(honest));
});

test("the recheck immediately before deletion: a network that is gone, back at the authorized location, elsewhere again, untagged, joined by another tagged resource, unreadable, or remapped in the state stops the remediation with nothing deleted and no approval consumed", async () => {
  const w = world();
  const run = await applied(w);
  const proposal = proposed(w, run);
  const approvals = [approval(proposal)];
  const other = "/subscriptions/" + SUB + "/resourceGroups/alz-pilot-dev/providers/Microsoft.Network/virtualNetworks/stray";
  for (const [label, cloud, engine] of [
    ["gone", { existing: [], tagged: [], fail: { [VNET]: 404 } }, {}],
    ["moved back to the authorized location", { existing: [VNET], tagged: [VNET], locations: { [VNET]: AUTHORIZED } }, {}],
    ["moved elsewhere", { existing: [VNET], tagged: [VNET], locations: { [VNET]: "northeurope" } }, {}],
    ["no location in the answer", { existing: [VNET], tagged: [VNET], locations: { [VNET]: null } }, {}],
    ["untagged", { existing: [VNET], tagged: [], locations: { [VNET]: WRONG } }, {}],
    ["another resource tagged", { existing: [VNET, other], tagged: [VNET, other], locations: { [VNET]: WRONG } }, {}],
    ["read denied", { existing: [VNET], tagged: [VNET], fail: { [VNET]: 403 } }, {}],
    ["tag listing incomplete", { existing: [VNET], tagged: [VNET], pages: 99, locations: { [VNET]: WRONG } }, {}],
    ["the state maps the address to another id", MISPLACED, { stateResources: [azureStateResource("azurerm_virtual_network", "pilot", other)] }],
    ["the state no longer readable as the blueprint", MISPLACED, { stateResources: [...STATE, azureStateResource("azurerm_virtual_network", "extra", other)] }],
  ] as const) {
    w.arm.behave(cloud as ArmBehavior);
    behave(engine as Behavior);
    const result = await remediate(w, run, proposal, approvals);
    refused(result, "REMEDIATION_RECHECK_FAILED", label);
    assert.match((result as { message: string }).message, /Nothing was deleted and no approval was consumed/, label);
    if (label === "gone") assert.match((result as { message: string }).message, /the network is gone/);
    assert.equal(calls().filter((c) => c.args[0] === "apply").length, 0, label + ": no apply ran");
  }
  // The kill switch stops it first, as for any cleanup.
  w.arm.behave(MISPLACED);
  behave();
  writeFileSync(KILL, "stop");
  try { refused(await remediate(w, run, proposal, approvals), "KILL_SWITCH_ACTIVE", "kill switch"); } finally { removeTree(KILL); }
  // Nothing was consumed: the same approvals now delete it.
  const result = await remediate(w, run, proposal, approvals);
  assert.ok(result.ok, JSON.stringify(result));
});

test("the reader reports where a misplaced network is, as a programmatic name, and nothing for one at the authorized location", async () => {
  const tenantEnv = { ALZ_DISCOVERY_ARM_CLIENT_ID: "discovery-client-1", ALZ_DISCOVERY_ARM_TENANT_ID: identityEnv("DEV").ALZ_DISCOVERY_ARM_TENANT_ID, ALZ_DISCOVERY_ARM_OIDC_TOKEN_FILE: tokenFile };
  for (const [answer, expected] of [["East US 2", { misplaced: true, observedLocation: "eastus2" }], ["west europe", {}], ["not a location!", { misplaced: true }]] as const) {
    const arm = fakeArmHttp({ existing: [VNET], locations: { [VNET]: answer } });
    const { reader, close } = createDiscoveryArmReader({ env: tenantEnv, subscriptionId: SUB, location: AUTHORIZED, http: arm.http });
    try {
      const check = await reader.check({ address: ADDRESS, type: "azurerm_virtual_network", arn: null, id: VNET, origin: "IN_PLAN" });
      assert.deepEqual({ misplaced: check.misplaced, observedLocation: check.observedLocation }, { misplaced: undefined, observedLocation: undefined, ...expected }, answer);
    } finally { close(); }
  }
});

// --- the terminal ----------------------------------------------------------------------------------------------------------------

type Terminal = NonNullable<ApplyCliDeps["terminal"]> & { out: string[]; asked: { kind?: string; phrase?: string }[] };
const terminal = (answers: string[]): Terminal => {
  const out: string[] = [];
  const asked: Terminal["asked"] = [];
  return { stdinIsTTY: true, stdoutIsTTY: true, out, asked, write: (text: string) => { out.push(text); }, ask: async (_prompt, expectation) => { asked.push({ kind: expectation?.kind, phrase: expectation?.phrase }); return answers.shift() ?? ""; } };
};
const jsonFile = (value: unknown, label: string): string => { const path = join(fresh(label), label + ".json"); writeFileSync(path, JSON.stringify(value)); return path; };
const keyFile = (who: keyof typeof keys): string => { const path = join(fresh("key"), who + ".pem"); writeFileSync(path, keys[who].priv, { mode: 0o600 }); return path; };

test("at the terminal (SYNTHETIC): propose-remediation writes the remediation and shows the mismatch, propose-cleanup is refused for the same run, approve signs it under its own phrase, cleanup runs it under its own phrase, and verify-cleanup confirms the network gone", async () => {
  const w = world();
  const proposalsDir = fresh("proposals");
  const cli = async (args: string[], answers: string[] = []) => {
    const term = terminal(answers);
    const stdout: string[] = [];
    const stderr: string[] = [];
    const code = await runApplyCommand(args, {
      sourceCommit: SOURCE_COMMIT, terminal: term, env: w.deps.env, now: () => NOW, operatorId: "operator.fixture", contractPath: w.contractPath, qualificationDir: vaultDir, evidenceDir: w.dirs.evidence,
      nonces: w.deps.nonces, scratchParent: w.dirs.scratch, toolDirs: [toolDir], proposalsDir, observeArm: w.arm.http, stdout: (t) => { stdout.push(t); }, stderr: (t) => { stderr.push(t); },
    });
    let data: unknown;
    try { data = JSON.parse(stdout.join("")); } catch { data = undefined; }
    return { code, stdout: stdout.join(""), stderr: stderr.join(""), term, data };
  };
  const target = targetOf("DEV");
  const project = writeProject(fresh("project"), target);
  const request = jsonFile({ environment: "DEV", target, projectRoot: project.projectRoot, policyVersion: POLICY, resolved: project.resolved }, "request");
  const manifest = jsonFile(project.manifest, "manifest");
  const sealed = await cli(["seal", "--request", request, "--manifest", manifest, ...requesterArgs()], [targetString(target), "RUN PROJECT CODE"]);
  assert.equal(sealed.code, 0, sealed.stderr);
  const { sealedPlanPath, reviewBundlePath, artifactSha256 } = sealed.data as { sealedPlanPath: string; reviewBundlePath: string; artifactSha256: string };
  const approved = await cli(["approve", "--bundle", reviewBundlePath, "--key", keyFile("alice"), "--approver", "alice"], ["APPROVE DEV " + artifactSha256.slice(0, 12)]);
  assert.equal(approved.code, 0, approved.stderr);
  const applyRequest = jsonFile({ environment: "DEV", target, projectRoot: project.projectRoot }, "apply-request");
  const appliedRun = await cli(["apply", "--request", applyRequest, "--manifest", manifest, "--sealed", sealedPlanPath, "--approval", jsonFile(approved.data, "approval")], ["APPLY DEV " + artifactSha256.slice(0, 12) + " " + targetString(target)]);
  assert.equal(appliedRun.code, 0, appliedRun.stderr);
  const observed = await cli(["observe", "--sealed", sealedPlanPath]);
  assert.equal(observed.code, 0, observed.stderr);
  assert.equal((observed.data as { verdict: string }).verdict, "FAILED");

  const ordinary = await cli(["propose-cleanup", "--sealed", sealedPlanPath, ...requesterArgs()]);
  assert.equal(ordinary.code, 2, ordinary.stdout);
  assert.match(ordinary.stderr, /BLOCKED LOCATION_MISMATCH: .*propose-remediation/);

  // Like propose-cleanup, it runs only from a committed source: without one it is refused before anything is read or written.
  const unverified: string[] = [];
  const noSource = await runApplyCommand(["propose-remediation", "--sealed", sealedPlanPath, ...requesterArgs()], {
    terminal: terminal([]), env: w.deps.env, now: () => NOW, contractPath: w.contractPath, evidenceDir: w.dirs.evidence, proposalsDir, sourceCommit: undefined,
    sourceResolver: () => ({ ok: false as const, reason: "recorded by the test" }), stdout: () => undefined, stderr: (t) => { unverified.push(t); },
  });
  assert.equal(noSource, 2);
  assert.match(unverified.join(""), /BLOCKED SOURCE_UNVERIFIED/);

  const proposed = await cli(["propose-remediation", "--sealed", sealedPlanPath, ...requesterArgs()]);
  assert.equal(proposed.code, 0, proposed.stderr);
  assert.deepEqual(proposed.term.asked, [], "a proposal authorizes nothing and asks no phrase");
  assert.match(proposed.stdout, /LOCATION REMEDIATION PROPOSED/);
  assert.match(proposed.stdout, new RegExp("observed " + WRONG + ", but the contract authorizes " + AUTHORIZED));
  const proposalPath = /Saved \(private to this account\): (\S+)/.exec(proposed.stdout)![1];
  assert.match(proposalPath, /\.remediation-proposal\.json$/);
  const proposal = JSON.parse(readFileSync(proposalPath, "utf8")) as CleanupProposal;
  assert.equal(proposal.kind, "LOCATION_REMEDIATION");
  const shortId = proposal.proposalSha256.slice(0, 12);

  // The cleanup phrase of an ordinary proposal does not sign a remediation: its own phrase does, after the mismatch is shown.
  const wrongPhrase = await cli(["approve", "--bundle", proposalPath, "--key", keyFile("alice"), "--approver", "alice"], ["APPROVE CLEANUP DEV " + shortId]);
  assert.notEqual(wrongPhrase.code, 0);
  const signed = await cli(["approve", "--bundle", proposalPath, "--key", keyFile("alice"), "--approver", "alice"], ["APPROVE LOCATION REMEDIATION DEV " + shortId]);
  assert.equal(signed.code, 0, signed.stderr);
  assert.deepEqual(signed.term.asked.map((a) => a.phrase), ["APPROVE LOCATION REMEDIATION DEV " + shortId]);
  const shown = signed.term.out.join("");
  assert.match(shown, /APPROVE A LOCATION REMEDIATION IN DEV/);
  assert.match(shown, new RegExp("observed " + WRONG + ", but the contract authorizes " + AUTHORIZED));
  assert.ok(shown.indexOf("LOCATION ") < shown.indexOf("deletes (1)"), "the mismatch is shown before the deletion list");

  const removed = await cli(["cleanup", "--proposal", proposalPath, "--request", applyRequest, "--manifest", manifest, "--sealed", sealedPlanPath, "--approval", jsonFile(signed.data, "cleanup-approval")],
    ["REMEDIATE LOCATION DEV " + shortId + " " + targetString(target)]);
  assert.equal(removed.code, 0, removed.stderr);
  assert.match(removed.term.out.join(""), /read again as DISCOVERY/);
  assert.deepEqual((removed.data as { deletes: string[] }).deletes, [ADDRESS]);

  w.arm.behave({ existing: [], tagged: [], fail: { [VNET]: 404 } });
  const verified = await cli(["verify-cleanup", "--proposal", proposalPath]);
  assert.equal(verified.code, 0, verified.stderr);
  assert.equal((verified.data as { disposition: string }).disposition, "COMPLETE");
});

test("the location remediation and its LOCATION_MISMATCH refusal are Azure's only: another provider's misplaced resource keeps its own refusal, and gets no remediation", async () => {
  const w = world();
  const run = await applied(w);
  const base = inputOf(w, run);
  const gcp = { ...base.contract, provider: "GCP" } as PilotContract;
  const ordinary = buildCleanupProposal({ ...base, contract: gcp });
  assert.equal(ordinary.ok, false);
  assert.notEqual((ordinary as { code: string }).code, "LOCATION_MISMATCH");
  assert.doesNotMatch((ordinary as { message: string }).message, /propose-remediation/);
  refused(buildLocationRemediationProposal({ ...base, contract: gcp }), "REMEDIATION_NOT_ELIGIBLE", "GCP");
});
