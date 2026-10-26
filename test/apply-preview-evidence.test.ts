import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import test from "node:test";

import { loadPilotContract } from "../src/apply/contract.js";
import { buildPreviewGateEvidence, countChanges, previewGateEvidenceProblems, type PreviewGateEvidence } from "../src/apply/preview-evidence.js";
import { loadSealedPlan } from "../src/apply/seal.js";
import type { PilotContract, SealedPlan } from "../src/apply/types.js";
import { runApplyCommand, type ApplyCliDeps } from "../src/cli/apply.js";
import { targetString } from "../src/cli/teardown-driver.js";
import { openNonceStore } from "../src/apply/nonces.js";
import { PREVIEW_GATE_ACTIONS, previewGateScenarioOf, unauthorizedPreviewActions } from "../src/qualification/preview-gate.js";
import { PREVIEW_GATE_SCENARIOS, PRODUCTION_RELEASE_GATES, previewScenarioOf, reviewProductionRelease, type ReleaseGateSubmission } from "../src/qualification/release-admission.js";
import { removeTree } from "../src/teardown/driver/cleanup.js";
import {
  CANARIES, NOW, POLICY, SOURCE_COMMIT, behave as behaveIn, callsOf, contractJson, identityEnv, installFakeTerraform, pinPathOf, targetOf, testFixtureForgeQualificationEvidence,
  writePinnedContract, writeProject, type Behavior, type Project,
} from "./helpers/apply-fixtures.js";

// The product-owned producer of the `preview:terraform-azure-brownfield` release gate's evidence (src/apply/preview-evidence.ts,
// `./alz apply preview-evidence`), against the LIVE_PREVIEW validator the admission review runs (src/qualification/release-admission.ts).
// The engine here is the fake terraform, so every document it writes is SYNTHETIC evidence of the product's logic: the one
// LIVE-labeled document below is made under a fixture attestation that a person would type at a real target, and it proves only
// that the producer's output is what the gate accepts, never that the gate is closed. ACT stays DISABLED throughout.

const root = mkdtempSync(join(tmpdir(), "alz-preview-evidence-"));
const toolDir = mkdtempSync(join(tmpdir(), "alz-preview-evidence-tf-"));
test.after(() => { removeTree(root); removeTree(toolDir); });
installFakeTerraform(toolDir);
let counter = 0;
const fresh = (label: string): string => { const dir = join(root, label + "-" + (counter += 1)); mkdirSync(dir, { recursive: true, mode: 0o700 }); return dir; };
const KILL = join(root, "KILL");
const behave = (behavior: Behavior = {}) => behaveIn(toolDir, KILL, { applyAdvance: true, ...behavior });
const json = (value: unknown, label = "file"): string => { const path = join(fresh(label), label + ".json"); writeFileSync(path, JSON.stringify(value)); return path; };
const change = (address: string, type: string, actions: string[]) => ({ address, type, change: { actions, before: actions[0] === "create" ? null : {}, after: { tags: {} } } });
/** A brownfield plan: the fake's default create and update, plus another pre-existing resource the plan updates. */
const BROWNFIELD: Behavior = { showResources: [change("azurerm_virtual_network.existing", "azurerm_virtual_network", ["update"])] };
/** A greenfield plan: creates only (a type that carries no tags, so the seal lists it as untagged and the unit check passes). */
const GREENFIELD: Behavior = { showOnlyConfigured: true, showResources: [{ address: "azurerm_resource_group.fresh", type: "azurerm_resource_group", change: { actions: ["create"], before: null, after: { location: "westeurope" } } }] };
const GATE = "preview:terraform-azure-brownfield";
const HOST = "private-lab-host-01";
const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");

type Terminal = NonNullable<ApplyCliDeps["terminal"]> & { out: string[]; asked: { prompt: string; kind?: string; phrase?: string }[] };
const terminal = (answers: string[]): Terminal => {
  const out: string[] = [];
  const asked: Terminal["asked"] = [];
  return {
    stdinIsTTY: true, stdoutIsTTY: true, out, asked,
    write: (text: string) => { out.push(text); },
    ask: async (prompt: string, expectation?: { kind: string; phrase: string }) => { asked.push({ prompt, ...expectation }); return answers.shift() ?? ""; },
  };
};
type Run = { code: number; stdout: string; stderr: string; term: Terminal };
type World = { deps: (term: Terminal, over?: Partial<ApplyCliDeps>) => ApplyCliDeps; contractPath: string; releaseEvidenceDir: string; contract: PilotContract };

async function world(contract: unknown = contractJson(KILL)): Promise<World> {
  behave();
  const contractPath = join(fresh("contract"), "act-pilot-contract.json");
  writePinnedContract(contractPath, contract);
  const vault = fresh("vault");
  await testFixtureForgeQualificationEvidence(vault);
  const releaseEvidenceDir = join(root, "evidence-" + (counter += 1));
  return {
    contractPath, releaseEvidenceDir, contract: loadPilotContract(contractPath, pinPathOf(contractPath)) as PilotContract,
    deps: (term, over = {}) => ({
      sourceCommit: SOURCE_COMMIT, terminal: term, env: identityEnv("DEV"), now: () => NOW, operatorId: "operator.fixture", contractPath, contractPinPath: pinPathOf(contractPath),
      qualificationDir: vault, evidenceDir: fresh("ledger"), nonces: openNonceStore(fresh("nonces")), scratchParent: fresh("scratch"), toolDirs: [toolDir], releaseEvidenceDir, ...over,
    }),
  };
}
async function cli(w: World, args: string[], answers: string[], over: Partial<ApplyCliDeps> = {}): Promise<Run> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const term = terminal(answers);
  const code = await runApplyCommand(args, { ...w.deps(term, over), stdout: (t: string) => { stdout.push(t); }, stderr: (t: string) => { stderr.push(t); } });
  return { code, stdout: stdout.join(""), stderr: stderr.join(""), term };
}
type Sealed = { project: Project; path: string; sealed: SealedPlan };
/** A sealed preview made by the fake engine; `behavior` shapes the plan the fake reports (brownfield by default). */
async function seal(w: World, behavior: Behavior = BROWNFIELD): Promise<Sealed> {
  behave(behavior);
  const target = targetOf("DEV");
  const project = writeProject(fresh("project"), target);
  const request = json({ environment: "DEV", target, projectRoot: project.projectRoot, policyVersion: POLICY, resolved: project.resolved }, "request");
  const run = await cli(w, ["seal", "--request", request, "--manifest", json(project.manifest, "manifest")], [targetString(target), "RUN PROJECT CODE"]);
  assert.equal(run.code, 0, run.stderr);
  const { sealedPlanPath } = JSON.parse(run.stdout) as { sealedPlanPath: string };
  const loaded = await loadSealedPlan(sealedPlanPath);
  assert.ok(loaded.ok);
  return { project, path: sealedPlanPath, sealed: loaded.sealed };
}
const phraseFor = (s: Sealed, gate = GATE): string => "PREVIEW LIVE " + gate.slice("preview:".length) + " " + s.sealed.artifactSha256.slice(0, 12);
const produce = (w: World, s: Sealed, answers: string[], gate = GATE, host = HOST) => cli(w, ["preview-evidence", "--sealed", s.path, "--gate", gate, "--target-hardware-id", host], answers);
const engineCalls = () => callsOf(toolDir).map((call) => call.args);

/** The admission review of a manifest holding exactly this evidence file, reviewed from `root`. */
async function admit(w: World, written: string, record: ReleaseGateSubmission) {
  const review = await reviewProductionRelease({
    manifest: { schemaVersion: 1, sourceCommit: SOURCE_COMMIT, operatingMode: "PREVIEW_OPERATE", infrastructureAct: "DISABLED", records: [{ ...record, evidencePath: relative(root, written) }] },
    root, expectedCommit: SOURCE_COMMIT,
  });
  return review.gates.find((gate) => gate.id === record.id)!;
}

test("the gate's scenario is bound: every preview gate names one provider, engine and estate, and the Azure Terraform brownfield gate is the Azure Terraform path's", () => {
  for (const gate of PRODUCTION_RELEASE_GATES.filter((g) => g.mode === "LIVE_PREVIEW")) {
    const scenario = previewScenarioOf(gate.id);
    assert.ok(scenario, gate.id);
    assert.ok(["AWS", "AZURE"].includes(scenario.provider) && ["brownfield", "greenfield"].includes(scenario.estate), gate.id);
  }
  assert.deepEqual(PREVIEW_GATE_SCENARIOS["terraform-azure-brownfield"], { provider: "AZURE", engine: "TERRAFORM", estate: "brownfield" });
  assert.deepEqual(PREVIEW_GATE_SCENARIOS["cdk-aws-brownfield"], { provider: "AWS", engine: "AWS_CDK", estate: "brownfield" });
  assert.equal(previewScenarioOf("act:azure-terraform"), undefined);
  // A scenario's estate and provider are parsed, never cast: an unknown estate or provider is refused, so nothing binds silently.
  assert.deepEqual(previewGateScenarioOf({ id: "x", provider: "AWS", engine: "TERRAFORM", mock: "greenfield" }), { provider: "AWS", engine: "TERRAFORM", estate: "greenfield" });
  assert.throws(() => previewGateScenarioOf({ id: "x", provider: "AWS", engine: "TERRAFORM", mock: "unknown" }), /PREVIEW_GATE_ESTATE_UNKNOWN: x has mock unknown/);
  assert.throws(() => previewGateScenarioOf({ id: "x", provider: "GCP", engine: "TERRAFORM", mock: "brownfield" }), /PREVIEW_GATE_PROVIDER_UNKNOWN/);
  assert.deepEqual(countChanges([{ address: "a.b", type: "x", action: "CREATE" }, { address: "a.c", type: "x", action: "UPDATE" }, { address: "output.o", type: "output", action: "UPDATE" }]),
    { total: 2, create: 1, preExistingTouched: 1, byAction: { CREATE: 1, UPDATE: 1 } });
});

test("preview-evidence writes LIVE evidence only from a qualified sealed preview of the gate's estate, made from this commit by the engine program on this machine, after the person attests the real target; the admission review accepts exactly that document (fixture attestation: synthetic evidence of the producer's contract, not of the gate)", async () => {
  const w = await world();
  const s = await seal(w);
  assert.equal(s.sealed.provenance.qualification.state, "QUALIFIED", "the fixture vault qualifies the preview adapter");
  assert.ok(s.sealed.changes.some((c) => c.action !== "CREATE" && c.type !== "output"), "the plan touches a pre-existing resource: brownfield");
  const before = engineCalls().length;
  const run = await produce(w, s, [phraseFor(s)]);
  assert.equal(run.code, 0, run.stderr);
  assert.equal(engineCalls().length, before, "recording evidence starts no engine");
  assert.deepEqual(run.term.asked.map((a) => [a.kind, a.phrase]), [["ATTEST", phraseFor(s)]], "the attestation is asked as a typed phrase, as record-live does");
  assert.match(run.term.out.join(""), /Type this only if this preview ran the pinned, qualified TERRAFORM against the real AZURE target above/);
  const { written, label, record } = JSON.parse(run.stdout) as { written: string; label: string; record: ReleaseGateSubmission };
  const evidence = JSON.parse(readFileSync(written, "utf8")) as PreviewGateEvidence;
  assert.equal(label, "LIVE");
  assert.equal(evidence.label, "LIVE");
  assert.equal(evidence.executionMode, "LIVE_PREVIEW");
  assert.equal(evidence.passed, true);
  assert.ok(!("simulation" in evidence));
  assert.deepEqual(evidence.reasons, []);
  assert.deepEqual([evidence.gateId, evidence.scenario, evidence.provider, evidence.engine, evidence.estate], [GATE, "terraform-azure-brownfield", "AZURE", "TERRAFORM", "brownfield"]);
  assert.deepEqual([evidence.sourceCommit, evidence.targetHardwareId, evidence.artifactSha256, evidence.toolOutputHash, evidence.engineProgramSha256],
    [SOURCE_COMMIT, HOST, s.sealed.artifactSha256, s.sealed.planSha256, s.sealed.provenance.engineBinarySha256]);
  assert.deepEqual([evidence.actEnabled, evidence.mutationObserved, evidence.previewExecuted, evidence.infrastructureApplied], [false, false, true, false]);
  assert.deepEqual(evidence.attestation, { attestedBy: "operator.fixture", attestedAt: NOW.toISOString() });
  assert.ok(Object.values(evidence.liveConditions).every((x) => x === true));
  assert.equal(evidence.changes.preExistingTouched, s.sealed.changes.filter((c) => c.type !== "output" && c.action !== "CREATE").length);
  assert.ok(evidence.changes.preExistingTouched >= 1 && evidence.changes.total === s.sealed.changes.filter((c) => c.type !== "output").length);
  assert.ok(evidence.checks.some((c) => c.name === "engine-qualification" && c.evidenceSha256 === (s.sealed.provenance.qualification as { evidenceHash: string }).evidenceHash));
  assert.deepEqual(previewGateEvidenceProblems(evidence, { sourceCommit: SOURCE_COMMIT, gateId: GATE }), []);
  const text = readFileSync(written, "utf8");
  for (const canary of CANARIES) assert.ok(!text.includes(canary), "no plan, state or output value reaches the evidence: " + canary);
  assert.ok(!text.includes(s.sealed.changes[0]!.address), "no address reaches the evidence: the change list is counted, not copied");
  // The record the owner adds to the admission manifest cites this very file, and the admission review finds the gate's evidence present.
  assert.deepEqual(record, { id: GATE, mode: "LIVE_PREVIEW", sourceCommit: SOURCE_COMMIT, targetHardwareId: HOST, evidencePath: written, evidenceSha256: sha256(text) });
  const reviewed = await admit(w, written, record);
  assert.deepEqual([reviewed.status, reviewed.blockers], ["EVIDENCE_PRESENT", []], "the producer's output is what the LIVE_PREVIEW gate accepts");
  // The same document never qualifies another gate: the CDK gate, the AWS Terraform gate, or a gate of another commit.
  for (const other of ["preview:cdk-aws-brownfield", "preview:terraform-aws-brownfield"]) {
    const wrong = await admit(w, written, { ...record, id: other });
    assert.deepEqual([wrong.status, wrong.blockers], ["BLOCKED", ["EVIDENCE_GATE_CONTRACT_FAILED"]], other + ": Terraform evidence for Azure never qualifies another provider or engine");
  }
  assert.deepEqual((await admit(w, written, { ...record, sourceCommit: "f".repeat(40) })).blockers, ["EVIDENCE_IDENTITY_MISMATCH"]);
  // The admission review runs the same validator as the producer: every document that is not a valid, LIVE preview-gate document of this
  // gate and commit is refused, not only one whose label disagrees with a present condition (review 6409586918, B1).
  const forge = async (label: string, document: unknown) => {
    const path = join(w.releaseEvidenceDir, "forged-" + label.replaceAll(/[^a-z]+/g, "-") + ".json");
    const text = JSON.stringify(document) + "\n";
    writeFileSync(path, text);
    const reviewed = await admit(w, path, { ...record, evidenceSha256: sha256(text) });
    assert.deepEqual([reviewed.status, reviewed.blockers], ["BLOCKED", ["EVIDENCE_GATE_CONTRACT_FAILED"]], label);
  };
  await forge("a live label over a failed condition", { ...evidence, liveConditions: { ...evidence.liveConditions, attested: false }, attestation: null });
  const { liveConditions: _conditions, ...withoutConditions } = evidence;
  await forge("a hand-written LIVE document with no live conditions", withoutConditions);
  await forge("a LIVE document whose conditions are an empty, vacuously true set", { ...evidence, liveConditions: {} });
  // A producer-written SYNTHETIC document relabeled by hand: label, mode and passed set to LIVE, simulation removed, every condition flipped
  // to true, while the reasons, the null attestation and the UNQUALIFIED provenance it was written with stay behind.
  const syntheticBuilt = buildPreviewGateEvidence({ sealed: { ...s.sealed, provenance: { ...s.sealed.provenance, qualification: { state: "UNQUALIFIED", reason: "no evidence" } } }, gateId: GATE, sourceCommit: SOURCE_COMMIT,
    targetHardwareId: HOST, engineProgramSha256Now: s.sealed.provenance.engineBinarySha256, contract: w.contract, attestedBy: null, now: NOW });
  assert.ok(syntheticBuilt.ok && syntheticBuilt.evidence.label === "SYNTHETIC" && syntheticBuilt.evidence.reasons.length === 2);
  const { simulation: _simulation, ...relabeled } = { ...syntheticBuilt.evidence, label: "LIVE" as const, executionMode: "LIVE_PREVIEW" as const, passed: true,
    liveConditions: Object.fromEntries(Object.keys(syntheticBuilt.evidence.liveConditions).map((key) => [key, true])) as PreviewGateEvidence["liveConditions"] };
  assert.ok(previewGateEvidenceProblems(relabeled).length >= 3, "the validator names the leftover reasons, attestation and qualification");
  await forge("a relabeled synthetic document", relabeled);
  await forge("a LIVE document whose gate version is unknown", { ...evidence, gateVersion: 2 });
  await forge("a LIVE document of another commit", { ...evidence, sourceCommit: "0".repeat(40) });
  // Written once: the same gate and artifact are never overwritten.
  const again = await produce(w, s, [phraseFor(s)]);
  assert.equal(again.code, 1);
  assert.match(again.stderr, /^PREVIEW_EVIDENCE_EXISTS/);
  assert.equal(readdirSync(w.releaseEvidenceDir).filter((n) => n.startsWith("preview-")).length, 1);
});

test("preview-evidence labels SYNTHETIC, and the gate refuses, a preview recorded without attestation, one whose plan is not the scenario's estate, one from another commit, an unqualified or changed engine program, or an unnamed host; a wrong phrase writes nothing", async () => {
  const w = await world();
  const s = await seal(w);
  // Typing SYNTHETIC: the honest label for a fake engine, a test or a rehearsal.
  const synthetic = await produce(w, s, ["SYNTHETIC"]);
  assert.equal(synthetic.code, 0, synthetic.stderr);
  const out = JSON.parse(synthetic.stdout) as { written: string; label: string; reasons: string[]; record: ReleaseGateSubmission; next: string };
  const evidence = JSON.parse(readFileSync(out.written, "utf8")) as PreviewGateEvidence;
  assert.deepEqual([out.label, evidence.label, evidence.executionMode, evidence.passed, evidence.simulation, evidence.attestation], ["SYNTHETIC", "SYNTHETIC", "SYNTHETIC_PREVIEW", false, true, null]);
  assert.deepEqual(evidence.reasons, ["no person attested that this preview ran the pinned engine against the real target; a fake engine, a test or a rehearsal writes the same records"]);
  assert.match(out.next, /never passes the release gate/);
  assert.deepEqual(previewGateEvidenceProblems(evidence), []);
  assert.deepEqual((await admit(w, out.written, out.record)).blockers, ["EVIDENCE_GATE_CONTRACT_FAILED"], "synthetic evidence never closes the live gate");
  // A wrong phrase writes nothing (another plan, so another artifact: the fake's plan bytes are salted).
  const s2 = await seal(w, { ...BROWNFIELD, planSalt: "second" });
  assert.notEqual(s2.sealed.artifactSha256, s.sealed.artifactSha256);
  const wrong = await produce(w, s2, ["PREVIEW LIVE terraform-azure-brownfield"]);
  assert.equal(wrong.code, 1);
  assert.match(wrong.stderr, /^PREVIEW_ATTESTATION_MISMATCH/);
  assert.ok(!existsSync(join(w.releaseEvidenceDir, "preview-terraform-azure-brownfield-" + s2.sealed.artifactSha256.slice(0, 12) + ".json")));
  // A greenfield plan (creates only) attested as live is still SYNTHETIC for a brownfield gate, and the person is told before typing.
  const greenfield = await seal(w, GREENFIELD);
  assert.ok(greenfield.sealed.changes.every((c) => c.action === "CREATE" || c.type === "output"));
  const estate = await produce(w, greenfield, [phraseFor(greenfield)]);
  assert.equal(estate.code, 0, estate.stderr);
  assert.match(estate.term.out.join(""), /This evidence will be SYNTHETIC whatever you type, because:\n  - the plan's estate is not the scenario's/);
  const estateOut = JSON.parse(estate.stdout) as { label: string; reasons: string[]; written: string; record: ReleaseGateSubmission };
  assert.equal(estateOut.label, "SYNTHETIC");
  assert.match(estateOut.reasons.join(" | "), /estate is not the scenario's/);
  assert.deepEqual((await admit(w, estateOut.written, estateOut.record)).blockers, ["EVIDENCE_GATE_CONTRACT_FAILED"]);
  // The producer's conditions, one at a time, through the builder: each alone makes the evidence SYNTHETIC with its reason, and the validator agrees.
  const base = { sealed: s.sealed, gateId: GATE, sourceCommit: SOURCE_COMMIT, targetHardwareId: HOST, engineProgramSha256Now: s.sealed.provenance.engineBinarySha256, contract: w.contract, attestedBy: "operator.fixture", now: NOW };
  const live = buildPreviewGateEvidence(base);
  assert.ok(live.ok && live.evidence.label === "LIVE");
  const cases: [string, Partial<typeof base>, RegExp][] = [
    ["another commit", { sourceCommit: "0".repeat(40) }, /another product commit/],
    ["no commit", { sourceCommit: undefined }, /another product commit/],
    ["unqualified engine", { sealed: { ...s.sealed, provenance: { ...s.sealed.provenance, qualification: { state: "UNQUALIFIED", reason: "no evidence" } } } }, /no real-engine qualification evidence/],
    ["changed program", { engineProgramSha256Now: "1".repeat(64) }, /not the one that made the preview/],
    ["unreadable program", { engineProgramSha256Now: undefined }, /not the one that made the preview/],
    ["unknown host", { targetHardwareId: "UNKNOWN" }, /host this preview ran on is not named/],
    ["no attestation", { attestedBy: null }, /no person attested/],
  ];
  for (const [label, over, reason] of cases) {
    const built = buildPreviewGateEvidence({ ...base, ...over });
    assert.ok(built.ok, label);
    assert.equal(built.evidence.label, "SYNTHETIC", label);
    assert.equal(built.evidence.simulation, true, label);
    assert.match(built.evidence.reasons.join(" | "), reason, label);
    assert.deepEqual(previewGateEvidenceProblems(built.evidence), [], label);
  }
  // The gate and the plan must belong together: another engine's or provider's gate, or an unknown gate, writes nothing.
  for (const [gate, code] of [["preview:cdk-aws-brownfield", "SCENARIO_MISMATCH"], ["preview:terraform-aws-brownfield", "SCENARIO_MISMATCH"], ["preview:pulumi-azure-brownfield", "SCENARIO_MISMATCH"], ["preview:nonexistent", "GATE_UNKNOWN"], ["act:azure-terraform", "GATE_UNKNOWN"]] as const) {
    const refused = await produce(w, s2, [phraseFor(s2, gate)], gate);
    assert.equal(refused.code, 2, gate);
    assert.match(refused.stderr, new RegExp("^BLOCKED " + code), gate);
    assert.deepEqual(refused.term.asked, [], gate + ": refused before any phrase");
  }
  assert.ok(!readdirSync(w.releaseEvidenceDir).some((n) => n.includes("cdk") || n.includes("aws") || n.includes("pulumi")));
  // A host identity that is not a short name is an input error; the flag set is closed.
  assert.match((await produce(w, s2, [phraseFor(s2)], GATE, "UNKNOWN host")).stderr, /^APPLY_INPUT_INVALID/);
  assert.match((await cli(w, ["preview-evidence", "--sealed", s2.path, "--gate", GATE, "--target-hardware-id", HOST, "--live", "yes"], [])).stderr, /^APPLY_FLAG_UNKNOWN/);
});

test("a change set with a delete, a replacement, a forget or an unreviewed action is never preview-gate evidence (#257 NB3; docs/production-release-admission.md gate 4): the producer refuses it before any attestation is asked for and writes nothing, the validator refuses a LIVE document relabeled over such counts, the admission review refuses the same file, and an update or an adoption of a pre-existing resource still passes", async () => {
  const w = await world();
  assert.deepEqual([...PREVIEW_GATE_ACTIONS], ["CREATE", "UPDATE", "IMPORT", "READ", "SAME"], "the admitted actions are a closed list");
  assert.deepEqual(unauthorizedPreviewActions({ CREATE: 2, UPDATE: 1, IMPORT: 1, READ: 1, SAME: 3, DELETE: 0 }), []);
  assert.deepEqual(unauthorizedPreviewActions({ UPDATE: 1, REPLACE: 2, DELETE: 1, FORGET: 1, REPLACE_CONDITIONAL: 1, DYNAMIC: 1, UNKNOWN: 1, EXOTIC: 1 }),
    ["DELETE: 1", "DYNAMIC: 1", "EXOTIC: 1", "FORGET: 1", "REPLACE: 2", "REPLACE_CONDITIONAL: 1", "UNKNOWN: 1"]);
  // Negative, through the command: a brownfield plan that also deletes, replaces or forgets a pre-existing resource is refused with the
  // action named, before the phrase is asked for, and no file is written. The seal itself is not the gate's concern and still succeeds.
  const cases: [string, unknown[], RegExp][] = [
    ["delete", [change("azurerm_storage_account.old", "azurerm_storage_account", ["delete"])], /DELETE: 1/],
    // A replacement is a delete and a create of the same address (a group, whose type carries no tags, so the seal's unit check is not what refuses it).
    ["replace", [{ address: "azurerm_resource_group.old", type: "azurerm_resource_group", change: { actions: ["delete", "create"], before: {}, after: { location: "westeurope" } } }], /REPLACE: 1/],
    ["forget", [{ address: "azurerm_storage_account.old", type: "azurerm_storage_account", change: { actions: ["forget"], before: {}, after: {} } }], /FORGET: 1/],
    ["delete beside an update", [change("azurerm_virtual_network.existing", "azurerm_virtual_network", ["update"]), change("azurerm_storage_account.old", "azurerm_storage_account", ["delete"])], /DELETE: 1/],
  ];
  for (const [label, resources, pattern] of cases) {
    const s = await seal(w, { showResources: resources, planSalt: label });
    const refused = await produce(w, s, [phraseFor(s)]);
    assert.equal(refused.code, 2, label + ": " + refused.stderr);
    assert.match(refused.stderr, /^BLOCKED CHANGES_UNAUTHORIZED: /, label);
    assert.match(refused.stderr, pattern, label);
    assert.match(refused.stderr, /Nothing was written/, label);
    assert.deepEqual(refused.term.asked, [], label + ": refused before any phrase");
    assert.ok(!existsSync(join(w.releaseEvidenceDir, "preview-terraform-azure-brownfield-" + s.sealed.artifactSha256.slice(0, 12) + ".json")), label);
    // The builder refuses the same plan with the attestation given, so no caller can get a SYNTHETIC document out of it either.
    const built = buildPreviewGateEvidence({ sealed: s.sealed, gateId: GATE, sourceCommit: SOURCE_COMMIT, targetHardwareId: HOST, engineProgramSha256Now: s.sealed.provenance.engineBinarySha256, contract: w.contract, attestedBy: "operator.fixture", now: NOW });
    assert.equal(built.ok, false, label);
    assert.equal((built as { code: string }).code, "CHANGES_UNAUTHORIZED", label);
  }
  // Positive: an update of a pre-existing resource (the brownfield estate) and an adoption (import) are admitted, as before.
  const adopted = await seal(w, { showResources: [change("azurerm_virtual_network.existing", "azurerm_virtual_network", ["update"]),
    { address: "azurerm_storage_account.adopted", type: "azurerm_storage_account", change: { actions: ["update"], before: {}, after: { tags: {} }, importing: { id: "/subscriptions/x" } } }], planSalt: "adopted" });
  assert.ok(adopted.sealed.changes.some((c) => c.importing === true), "the sealed plan records the adoption");
  const live = await produce(w, adopted, [phraseFor(adopted)]);
  assert.equal(live.code, 0, live.stderr);
  const out = JSON.parse(live.stdout) as { written: string; label: string; record: ReleaseGateSubmission };
  assert.equal(out.label, "LIVE");
  const evidence = JSON.parse(readFileSync(out.written, "utf8")) as PreviewGateEvidence;
  assert.deepEqual(unauthorizedPreviewActions(evidence.changes.byAction), []);
  assert.deepEqual((await admit(w, out.written, out.record)).blockers, [], "a brownfield update and an adoption are admitted (fixture attestation: synthetic)");
  // Relabeled: the LIVE document with a delete or a replacement counted in by hand, every other count adjusted so they still add up, is refused by the validator and at admission.
  for (const [label, extra] of [["delete", { DELETE: 1 }], ["replacement", { REPLACE: 1 }], ["conditional replacement", { REPLACE_CONDITIONAL: 1 }], ["dynamic", { DYNAMIC: 1 }]] as const) {
    const byAction = { ...evidence.changes.byAction, ...extra };
    const forged = { ...evidence, changes: { byAction, total: evidence.changes.total + 1, create: evidence.changes.create, preExistingTouched: evidence.changes.preExistingTouched + 1 } };
    assert.match(previewGateEvidenceProblems(forged, { sourceCommit: SOURCE_COMMIT, gateId: GATE }).join(" | "), /a delete, a replacement or an unreviewed action is never admitted \(/, label);
    const path = join(fresh("forged"), "forged.json");
    const bytes = JSON.stringify(forged, null, 2) + "\n";
    writeFileSync(path, bytes);
    const record = { ...out.record, evidencePath: path, evidenceSha256: sha256(bytes) };
    assert.deepEqual((await admit(w, path, record)).blockers, ["EVIDENCE_GATE_CONTRACT_FAILED"], label + ": a relabeled document never closes the gate");
  }
});

test("the preview evidence validator refuses an unknown gate, a mismatched scenario, a declared pass, a hidden raw field, counts that do not add up and a missing field", async () => {
  const w = await world();
  const s = await seal(w);
  const built = buildPreviewGateEvidence({ sealed: s.sealed, gateId: GATE, sourceCommit: SOURCE_COMMIT, targetHardwareId: HOST, engineProgramSha256Now: s.sealed.provenance.engineBinarySha256, contract: w.contract, attestedBy: "operator.fixture", now: NOW });
  assert.ok(built.ok);
  const evidence = built.evidence;
  const problems = (edit: Record<string, unknown>) => previewGateEvidenceProblems({ ...evidence, ...edit }).join(" | ");
  assert.match(problems({ gateId: "preview:nonexistent" }), /not a preview release gate/);
  assert.match(problems({ gateId: "preview:cdk-aws-brownfield", scenario: "cdk-aws-brownfield" }), /scenario, provider, engine or estate does not match/);
  assert.match(problems({ estate: "greenfield" }), /does not match the gate/);
  assert.match(problems({ passed: false }), /passed: not derived/);
  assert.match(problems({ executionMode: "SYNTHETIC_PREVIEW" }), /executionMode: not derived/);
  assert.match(problems({ simulation: true }), /simulation: present exactly when/);
  assert.match(problems({ reasons: ["x"] }), /reasons: the failed conditions/);
  assert.match(problems({ attestation: null }), /attestation: present with a name exactly when attested/);
  assert.match(problems({ qualification: { state: "UNQUALIFIED", reason: "x" } }), /qualification: QUALIFIED/);
  assert.match(problems({ stdout: "x" }), /raw plan, output or secret field/);
  assert.match(problems({ infrastructureApplied: true }), /a preview applies nothing/);
  assert.match(problems({ changes: { ...evidence.changes, total: evidence.changes.total + 1 } }), /counts by action that add up/);
  assert.match(problems({ toolOutputHash: "short" }), /not a SHA-256 digest/);
  assert.match(previewGateEvidenceProblems(evidence, { gateId: "preview:terraform-aws-brownfield" }).join(" | "), /not the expected gate/);
  assert.match(previewGateEvidenceProblems(evidence, { sourceCommit: "0".repeat(40) }).join(" | "), /not the expected source commit/);
  const { checks: _dropped, ...withoutChecks } = evidence;
  assert.match(previewGateEvidenceProblems(withoutChecks).join(" | "), /checks: missing/);
  assert.deepEqual(previewGateEvidenceProblems("text"), ["preview evidence: expected an object"]);
});
