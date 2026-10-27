import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import test from "node:test";

import { loadPilotContract, pilotContractSha256 } from "../src/apply/contract.js";
import { APPLY_AUTHORITY } from "../src/apply/evidence.js";
import { finalizeArtifact, reserveArtifact } from "../src/apply/ledger.js";
import { openNonceStore } from "../src/apply/nonces.js";
import { buildRecoveryEvidence, citeApply, recoveryGateEvidenceProblems, type RecoveryGateEvidence } from "../src/apply/recovery-record.js";
import { loadSealedPlan } from "../src/apply/seal.js";
import type { ApplyEvidence, PilotContract, SealedPlan } from "../src/apply/types.js";
import { runApplyCommand, type ApplyCliDeps } from "../src/cli/apply.js";
import { targetString } from "../src/cli/teardown-driver.js";
import { INTERRUPTED_OUTCOMES, RECOVERY_GATE_ID, recoveryConditionsOf } from "../src/qualification/recovery-gate.js";
import { PRODUCTION_RELEASE_GATES, reviewProductionRelease, type ReleaseGateSubmission } from "../src/qualification/release-admission.js";
import { removeTree } from "../src/teardown/driver/cleanup.js";
import {
  NOW, POLICY, SOURCE_COMMIT, behave as behaveIn, contractJson, identityEnv, installFakeTerraform, pinPathOf, targetOf, testFixtureForgeQualificationEvidence,
  writePinnedContract, writeProject, type Behavior, type Project,
} from "./helpers/apply-fixtures.js";

// The product-owned producer of the `act-run-recovery` release gate's evidence (src/apply/recovery-record.ts, `./alz apply
// record-recovery`), against the ACT_RECOVERY validator the admission review runs (src/qualification/release-admission.ts).
// The ledger entries here are written by the test through the ledger's own API for plans the fake terraform sealed, so every
// document is SYNTHETIC evidence of the product's logic under a fixture attestation; it proves what the producer writes and
// what the gate accepts, never that the gate is closed. ACT stays DISABLED throughout; no engine applies anything.

const root = mkdtempSync(join(tmpdir(), "alz-recovery-record-"));
const toolDir = mkdtempSync(join(tmpdir(), "alz-recovery-record-tf-"));
test.after(() => { removeTree(root); removeTree(toolDir); });
installFakeTerraform(toolDir);
let counter = 0;
const fresh = (label: string): string => { const dir = join(root, label + "-" + (counter += 1)); mkdirSync(dir, { recursive: true, mode: 0o700 }); return dir; };
const KILL = join(root, "KILL");
const behave = (behavior: Behavior = {}) => behaveIn(toolDir, KILL, { applyAdvance: true, ...behavior });
const json = (value: unknown, label = "file"): string => { const path = join(fresh(label), label + ".json"); writeFileSync(path, JSON.stringify(value)); return path; };
const HOST = "private-lab-host-01";
const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");
const minutes = (n: number): string => new Date(NOW.getTime() + n * 60_000).toISOString();

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
type World = { deps: (term: Terminal, over?: Partial<ApplyCliDeps>) => ApplyCliDeps; contractPath: string; releaseEvidenceDir: string; ledger: string; contract: PilotContract };

async function world(): Promise<World> {
  behave();
  const contractPath = join(fresh("contract"), "act-pilot-contract.json");
  writePinnedContract(contractPath, contractJson(KILL));
  const vault = fresh("vault");
  await testFixtureForgeQualificationEvidence(vault);
  const releaseEvidenceDir = join(root, "evidence-" + (counter += 1));
  const ledger = fresh("ledger");
  return {
    contractPath, releaseEvidenceDir, ledger, contract: loadPilotContract(contractPath, pinPathOf(contractPath)) as PilotContract,
    deps: (term, over = {}) => ({
      sourceCommit: SOURCE_COMMIT, terminal: term, env: identityEnv("DEV"), now: () => NOW, operatorId: "operator.fixture", contractPath, contractPinPath: pinPathOf(contractPath),
      qualificationDir: vault, evidenceDir: ledger, nonces: openNonceStore(fresh("nonces")), scratchParent: fresh("scratch"), toolDirs: [toolDir], releaseEvidenceDir, ...over,
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
/** A sealed preview made by the fake engine, salted so each is another artifact. */
async function seal(w: World, salt: string): Promise<Sealed> {
  behave({ planSalt: salt });
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
/** Apply evidence for a sealed plan, as the driver would have recorded it; `over` shapes the outcome, the times and the approvals. */
const evidenceFor = (w: World, s: Sealed, over: Partial<ApplyEvidence>): ApplyEvidence => ({
  schemaVersion: 1, environment: s.sealed.environment, target: { ...s.sealed.target }, artifactSha256: s.sealed.artifactSha256, manifestHash: s.sealed.manifestHash,
  releaseIdentity: s.sealed.releaseIdentity, contractSha256: pilotContractSha256(w.contract), sourceCommit: SOURCE_COMMIT,
  approvals: [{ approverId: "alice", issuedAt: minutes(-30) }], adapter: { adapterVersion: "terraform-apply-1.0.0", argvDigest: "4".repeat(64) }, toolVersions: { engine: "1.9.5" },
  outcome: "SUCCEEDED", exitCode: 0, startedAt: minutes(-10), finishedAt: minutes(0), authority: APPLY_AUTHORITY, ...over,
});
/** Writes finished apply evidence into the ledger the way the driver does: a reservation, replaced by the evidence. */
async function record(w: World, evidence: ApplyEvidence): Promise<ApplyEvidence> {
  assert.ok((await reserveArtifact(evidence.artifactSha256, w.ledger, NOW)).ok);
  const finalized = await finalizeArtifact(evidence, w.ledger);
  assert.ok(finalized.ok, JSON.stringify(finalized));
  return evidence;
}
const KILLED = (w: World, s: Sealed): Promise<ApplyEvidence> => record(w, evidenceFor(w, s, { outcome: "KILLED", exitCode: null, finishedAt: minutes(0), recovery: { files: 2, sha256: "7".repeat(64) } }));
const RESUMED = (w: World, s: Sealed, over: Partial<ApplyEvidence> = {}): Promise<ApplyEvidence> =>
  record(w, evidenceFor(w, s, { approvals: [{ approverId: "alice", issuedAt: minutes(15) }], startedAt: minutes(20), finishedAt: minutes(25), ...over }));
const phraseFor = (interrupted: Sealed, resumed: Sealed): string => "RECOVERY LIVE DEV " + interrupted.sealed.artifactSha256.slice(0, 12) + " " + resumed.sealed.artifactSha256.slice(0, 12);
const produce = (w: World, interrupted: Sealed, resumed: Sealed, answers: string[], host = HOST) =>
  cli(w, ["record-recovery", "--sealed", interrupted.path, "--resumed", resumed.path, "--target-hardware-id", host], answers);
const writtenPath = (w: World, interrupted: Sealed): string => join(w.releaseEvidenceDir, RECOVERY_GATE_ID + "-" + interrupted.sealed.artifactSha256.slice(0, 12) + ".json");

/** The admission review of a manifest holding exactly this evidence file, reviewed from `root`. */
async function admit(written: string, record: ReleaseGateSubmission) {
  const review = await reviewProductionRelease({
    manifest: { schemaVersion: 1, sourceCommit: SOURCE_COMMIT, operatingMode: "PREVIEW_OPERATE", infrastructureAct: "DISABLED", records: [{ ...record, evidencePath: relative(root, written) }] },
    root, expectedCommit: SOURCE_COMMIT,
  });
  return review.gates.find((gate) => gate.id === record.id)!;
}

test("the act-run-recovery gate exists with mode ACT_RECOVERY, and the producer's derivation is one shared function", () => {
  assert.deepEqual(PRODUCTION_RELEASE_GATES.find((gate) => gate.id === RECOVERY_GATE_ID)?.mode, "ACT_RECOVERY");
  assert.deepEqual([...INTERRUPTED_OUTCOMES], ["PARTIAL_REQUIRES_REVIEW", "KILLED"]);
});

test("record-recovery writes LIVE recovery evidence only from the ledger's own records of an interrupted apply and of the apply that followed it under new approvals, after the person attests; every gate field is derived; the admission review accepts exactly that document; it is written once (fixture attestation: synthetic evidence of the producer's contract, not of the gate)", async () => {
  const w = await world();
  const first = await seal(w, "first");
  const second = await seal(w, "second");
  assert.notEqual(first.sealed.artifactSha256, second.sealed.artifactSha256);
  const interrupted = await KILLED(w, first);
  const resumed = await RESUMED(w, second);
  const run = await produce(w, first, second, [phraseFor(first, second)]);
  assert.equal(run.code, 0, run.stderr);
  const shown = run.term.out.join("");
  assert.match(shown, /interrupted\s+[0-9a-f]{64} ended KILLED at /);
  assert.match(shown, /2 recovery file\(s\) kept in the vault/);
  assert.match(shown, /resumed\s+[0-9a-f]{64} SUCCEEDED, 1 approval\(s\) issued after the interruption \(1 required\)/);
  assert.deepEqual(run.term.asked.map((a) => [a.kind, a.phrase]), [["ATTEST", phraseFor(first, second)]]);
  const out = JSON.parse(run.stdout) as { written: string; record: ReleaseGateSubmission; next: string };
  assert.equal(out.written, writtenPath(w, first));
  const bytes = readFileSync(out.written, "utf8");
  const evidence = JSON.parse(bytes) as RecoveryGateEvidence;
  // The four gate fields, derived from the ledger records and nothing typed.
  assert.equal(evidence.interruptedArtifactSha256, first.sealed.artifactSha256);
  assert.equal(evidence.interruptedOutcome, "KILLED");
  assert.equal(evidence.reconciledFromLedger, true);
  assert.equal(evidence.resumedWithoutApproval, false);
  assert.deepEqual([evidence.gateId, evidence.executionMode, evidence.label, evidence.passed, evidence.actEnabled, evidence.authority, evidence.cloud, evidence.engine, evidence.environment],
    [RECOVERY_GATE_ID, "ACT_RECOVERY", "LIVE", true, true, "PILOT_ENABLED", "AZURE", "TERRAFORM", "DEV"]);
  assert.deepEqual(evidence.interrupted, citeApply(interrupted));
  assert.deepEqual(evidence.resumed, citeApply(resumed));
  assert.deepEqual(evidence.conditions, recoveryConditionsOf(citeApply(interrupted), citeApply(resumed), 1));
  assert.ok(Object.values(evidence.conditions).every((x) => x === true));
  assert.deepEqual(evidence.attestation, { attestedBy: "operator.fixture", attestedAt: NOW.toISOString() });
  assert.deepEqual(evidence.checks.map((c) => c.name), ["interrupted-apply-evidence", "resumed-apply-evidence", "pilot-contract"]);
  assert.equal(evidence.sourceCommit, SOURCE_COMMIT);
  assert.equal(evidence.targetHardwareId, HOST);
  // Identifiers, hashes and times only: no plan value, state, output or approval signature reaches the record.
  assert.ok(!/signature|stdout|stderr|nonce|values|properties/i.test(bytes), "no raw field");
  assert.deepEqual(recoveryGateEvidenceProblems(evidence, { sourceCommit: SOURCE_COMMIT }), []);
  // The admission record cites the written bytes, and the review of this commit accepts the gate.
  assert.deepEqual(out.record, { id: RECOVERY_GATE_ID, mode: "ACT_RECOVERY", sourceCommit: SOURCE_COMMIT, targetHardwareId: HOST, evidencePath: out.written, evidenceSha256: sha256(bytes) });
  const gate = await admit(out.written, out.record);
  assert.deepEqual(gate.blockers, [], JSON.stringify(gate));
  assert.equal(gate.status, "EVIDENCE_PRESENT");
  // Written once: a second run with the same phrase refuses to overwrite, and the file is unchanged.
  const again = await produce(w, first, second, [phraseFor(first, second)]);
  assert.equal(again.code, 1);
  assert.match(again.stderr, /^RECOVERY_RECORD_EXISTS/);
  assert.equal(readFileSync(out.written, "utf8"), bytes);
  assert.equal(readdirSync(w.releaseEvidenceDir).length, 1);
});

test("record-recovery refuses by name, before any phrase is asked for and writing nothing: no interruption in the ledger, an approval reused or carried over on resume, too few approvals, a mismatched artifact or target, a resume that did not finish, a missing ledger entry, another commit; a wrong phrase writes nothing", async () => {
  const w = await world();
  const first = await seal(w, "first");
  const second = await seal(w, "second");
  const third = await seal(w, "third");
  await KILLED(w, first);
  // No interruption: the first run finished on its own, so there is nothing to recover from.
  const finished = await seal(w, "finished");
  await record(w, evidenceFor(w, finished, {}));
  await RESUMED(w, second);
  const notInterrupted = await produce(w, finished, second, [phraseFor(finished, second)]);
  assert.equal(notInterrupted.code, 2);
  assert.match(notInterrupted.stderr, /^BLOCKED RECOVERY_NOT_INTERRUPTED: the first run was not interrupted/);
  assert.deepEqual(notInterrupted.term.asked, []);
  // An approval reused on resume: the resumed apply's approval was issued before the interruption ended.
  const reused = await seal(w, "reused");
  await RESUMED(w, reused, { approvals: [{ approverId: "alice", issuedAt: minutes(-30) }] });
  const carried = await produce(w, first, reused, [phraseFor(first, reused)]);
  assert.equal(carried.code, 2);
  assert.match(carried.stderr, /^BLOCKED RECOVERY_APPROVAL_REUSED: an approval the apply that followed consumed was issued before the interruption ended/);
  assert.deepEqual(carried.term.asked, []);
  // A resume started before the interruption ended (the ledger itself never holds an apply without approvals, so too few is a builder and validator case below).
  const early = await seal(w, "early");
  await RESUMED(w, early, { startedAt: minutes(-5) });
  assert.match((await produce(w, first, early, [phraseFor(first, early)])).stderr, /^BLOCKED RECOVERY_APPROVAL_REUSED: an approval the apply that followed consumed was issued before the interruption ended/);
  // A mismatched artifact: the resumed plan is the interrupted one itself.
  const same = await produce(w, first, first, [phraseFor(first, first)]);
  assert.equal(same.code, 2);
  assert.match(same.stderr, /^BLOCKED RECOVERY_RESUME_MISMATCH: the apply that followed names the interrupted artifact itself/);
  // Another target or environment, and a resume that did not finish.
  const elsewhere = await seal(w, "elsewhere");
  await RESUMED(w, elsewhere, { target: { ...second.sealed.target, workspace: "other" } });
  assert.match((await produce(w, first, elsewhere, [phraseFor(first, elsewhere)])).stderr, /^BLOCKED RECOVERY_RESUME_MISMATCH: the apply that followed ran under another contract, environment or target/);
  const failed = await seal(w, "failed");
  await RESUMED(w, failed, { outcome: "PARTIAL_REQUIRES_REVIEW", exitCode: 1 });
  assert.match((await produce(w, first, failed, [phraseFor(first, failed)])).stderr, /^BLOCKED RECOVERY_RESUME_MISMATCH: the apply that followed did not succeed/);
  // A plan the ledger never finished (third was sealed, never applied), on either side.
  assert.match((await produce(w, first, third, [phraseFor(first, third)])).stderr, /^RECOVERY_RECORD_UNAVAILABLE: the resumed plan has no finished apply evidence/);
  assert.match((await produce(w, third, second, [phraseFor(third, second)])).stderr, /^RECOVERY_RECORD_UNAVAILABLE: the interrupted plan has no finished apply evidence/);
  // Another product commit than the one both runs ran on, or none.
  assert.match((await cli(w, ["record-recovery", "--sealed", first.path, "--resumed", second.path, "--target-hardware-id", HOST], [], { sourceCommit: "0".repeat(40) })).stderr, /^BLOCKED SOURCE_CHANGED: /);
  // The builder refuses the same pairs directly, so no caller gets a document out of it.
  const interrupted = evidenceFor(w, first, { outcome: "KILLED", exitCode: null });
  const base = { interrupted, resumed: evidenceFor(w, second, { approvals: [{ approverId: "alice", issuedAt: minutes(15) }], startedAt: minutes(20), finishedAt: minutes(25) }), contract: w.contract, sourceCommit: SOURCE_COMMIT, targetHardwareId: HOST, attestedBy: "operator.fixture", now: NOW };
  assert.ok(buildRecoveryEvidence(base).ok);
  const refusals: [string, Partial<typeof base>, string][] = [
    ["succeeded first run", { interrupted: { ...interrupted, outcome: "SUCCEEDED", exitCode: 0 } }, "RECOVERY_NOT_INTERRUPTED"],
    ["failed-no-change first run", { interrupted: { ...interrupted, outcome: "FAILED_NO_CHANGE", exitCode: 1 } }, "RECOVERY_NOT_INTERRUPTED"],
    ["same artifact", { resumed: { ...base.resumed, artifactSha256: interrupted.artifactSha256 } }, "RECOVERY_RESUME_MISMATCH"],
    ["another environment", { resumed: { ...base.resumed, environment: "QA" } }, "RECOVERY_RESUME_MISMATCH"],
    ["approval carried over", { resumed: { ...base.resumed, approvals: [{ approverId: "alice", issuedAt: minutes(15) }, { approverId: "bob", issuedAt: minutes(-1) }] } }, "RECOVERY_APPROVAL_REUSED"],
    ["too few approvals", { resumed: { ...base.resumed, approvals: [] } }, "RECOVERY_APPROVAL_REUSED"],
    ["another contract", { interrupted: { ...interrupted, contractSha256: "9".repeat(64) } }, "CONTRACT_MISMATCH"],
    ["another commit", { resumed: { ...base.resumed, sourceCommit: "0".repeat(40) } }, "SOURCE_CHANGED"],
    ["no commit", { sourceCommit: undefined }, "SOURCE_CHANGED"],
  ];
  for (const [label, over, code] of refusals) {
    const built = buildRecoveryEvidence({ ...base, ...over });
    assert.equal(built.ok, false, label);
    assert.equal((built as { code: string }).code, code, label);
    assert.match((built as { message: string }).message, /Nothing was written\.$/, label);
  }
  // A wrong phrase writes nothing; a malformed host is an input error; the flag set is closed.
  const wrong = await produce(w, first, second, ["RECOVERY LIVE DEV"]);
  assert.equal(wrong.code, 1);
  assert.match(wrong.stderr, /^RECOVERY_ATTESTATION_MISMATCH/);
  assert.match((await produce(w, first, second, [phraseFor(first, second)], "UNKNOWN host")).stderr, /^APPLY_INPUT_INVALID/);
  assert.match((await cli(w, ["record-recovery", "--sealed", first.path, "--resumed", second.path, "--target-hardware-id", HOST, "--live", "yes"], [])).stderr, /^APPLY_FLAG_UNKNOWN/);
  assert.ok(!existsSync(w.releaseEvidenceDir) || readdirSync(w.releaseEvidenceDir).length === 0, "nothing written by any refused run");
});

test("the validator recomputes every derived field: a hand-written or relabeled recovery document is refused by the validator and blocked at admission", async () => {
  const w = await world();
  const first = await seal(w, "first");
  const second = await seal(w, "second");
  const built = buildRecoveryEvidence({
    interrupted: evidenceFor(w, first, { outcome: "PARTIAL_REQUIRES_REVIEW", exitCode: 1 }),
    resumed: evidenceFor(w, second, { approvals: [{ approverId: "alice", issuedAt: minutes(15) }], startedAt: minutes(20), finishedAt: minutes(25) }),
    contract: w.contract, sourceCommit: SOURCE_COMMIT, targetHardwareId: HOST, attestedBy: "operator.fixture", now: NOW,
  });
  assert.ok(built.ok);
  const evidence = built.evidence;
  assert.equal(evidence.interruptedOutcome, "PARTIAL_REQUIRES_REVIEW");
  assert.deepEqual(recoveryGateEvidenceProblems(evidence, { sourceCommit: SOURCE_COMMIT }), []);
  const problems = (edit: Record<string, unknown>) => recoveryGateEvidenceProblems({ ...evidence, ...edit }, { sourceCommit: SOURCE_COMMIT }).join(" | ");
  const forged: [string, Record<string, unknown>, RegExp][] = [
    // Relabeled over records that show no interruption: the gate fields kept, the cited outcome changed.
    ["interruption relabeled", { interrupted: { ...evidence.interrupted, outcome: "SUCCEEDED" } }, /interruptedOutcome: not the cited interrupted outcome|do not show a recovery \(the first run was not interrupted/],
    ["gate field relabeled", { interruptedOutcome: "SUCCEEDED" }, /interruptedOutcome: not the cited interrupted outcome/],
    ["another interrupted artifact", { interruptedArtifactSha256: "a".repeat(64) }, /interruptedArtifactSha256: not the cited interrupted artifact/],
    ["approval carried over, field kept", { resumed: { ...evidence.resumed, approvals: [{ approverId: "alice", issuedAt: minutes(-30) }] } }, /the resume carried an approval over/],
    ["resumed without approval declared false over none", { resumed: { ...evidence.resumed, approvals: [] } }, /fewer distinct approvals than the contract requires/],
    ["same artifact resumed", { resumed: { ...evidence.resumed, artifactSha256: evidence.interrupted.artifactSha256 } }, /names the interrupted artifact itself/],
    ["conditions declared", { conditions: { ...evidence.conditions, resumedSucceeded: false } }, /conditions: not derived from the cited records/],
    ["reconciled declared false", { reconciledFromLedger: false }, /reconciledFromLedger: not derived/],
    ["resumed without approval declared true", { resumedWithoutApproval: true }, /resumedWithoutApproval: not derived/],
    ["passed declared false", { passed: false }, /label LIVE and passed true are the only values/],
    ["label synthetic", { label: "SYNTHETIC" }, /label LIVE and passed true are the only values/],
    ["act disabled", { actEnabled: false }, /actEnabled true under PILOT_ENABLED/],
    ["another commit", { sourceCommit: "0".repeat(40) }, /sourceCommit: not the expected source commit/],
    ["commit not the runs'", { interrupted: { ...evidence.interrupted, sourceCommit: "0".repeat(40) } }, /source commit is not the cited records'/],
    ["another target", { target: { ...evidence.target, workspace: "other" } }, /target, contract or source commit is not the cited records'/],
    ["check hash swapped", { checks: evidence.checks.map((c) => (c.name === "resumed-apply-evidence" ? { ...c, evidenceSha256: "b".repeat(64) } : c)) }, /must cite the interrupted and resumed apply evidence/],
    ["unknown host", { targetHardwareId: "UNKNOWN" }, /the host is not named/],
    ["raw field", { stdout: "x" }, /raw plan, output or secret field/],
    ["other gate", { gateId: "act:aws-terraform" }, /not a schemaVersion 1 ACT_RECOVERY document/],
    ["no attestation", { attestation: null }, /attestation: a name and a time/],
    ["recovery files malformed", { interrupted: { ...evidence.interrupted, recovery: { files: 0, sha256: "7".repeat(64) } } }, /recovery: null, or a file count and a hash/],
  ];
  for (const [label, edit, pattern] of forged) assert.match(problems(edit), pattern, label);
  const { checks: _dropped, ...withoutChecks } = evidence;
  assert.match(recoveryGateEvidenceProblems(withoutChecks).join(" | "), /checks: missing/);
  assert.deepEqual(recoveryGateEvidenceProblems("text"), ["recovery evidence: expected an object"]);
  // At admission: the genuine document passes, and each relabeled one is blocked, whatever its four gate fields say.
  const file = (doc: unknown, label: string): { path: string; bytes: string } => { const path = join(fresh(label), "evidence.json"); const bytes = JSON.stringify(doc, null, 2) + "\n"; writeFileSync(path, bytes); return { path, bytes }; };
  const genuine = file(evidence, "genuine");
  const recordOf = (f: { path: string; bytes: string }): ReleaseGateSubmission => ({ id: RECOVERY_GATE_ID, mode: "ACT_RECOVERY", sourceCommit: SOURCE_COMMIT, targetHardwareId: HOST, evidencePath: f.path, evidenceSha256: sha256(f.bytes) });
  assert.deepEqual((await admit(genuine.path, recordOf(genuine))).blockers, []);
  for (const [label, edit] of [["interruption relabeled", { interrupted: { ...evidence.interrupted, outcome: "SUCCEEDED" } }], ["approval carried over", { resumed: { ...evidence.resumed, approvals: [{ approverId: "alice", issuedAt: minutes(-30) }] } }], ["same artifact", { resumed: { ...evidence.resumed, artifactSha256: evidence.interrupted.artifactSha256 } }]] as const) {
    const f = file({ ...evidence, ...edit }, "forged");
    assert.deepEqual((await admit(f.path, recordOf(f))).blockers, ["EVIDENCE_GATE_CONTRACT_FAILED"], label);
  }
  // A hand-written document that only carries the four gate fields the old check asked for is refused.
  const bare = file({ schemaVersion: 1, gateId: RECOVERY_GATE_ID, executionMode: "ACT_RECOVERY", passed: true, sourceCommit: SOURCE_COMMIT, targetHardwareId: HOST, actEnabled: true,
    interruptedArtifactSha256: "a".repeat(64), interruptedOutcome: "KILLED", reconciledFromLedger: true, resumedWithoutApproval: false, checks: [{ name: "x", passed: true, evidenceSha256: "c".repeat(64) }] }, "bare");
  assert.deepEqual((await admit(bare.path, recordOf(bare))).blockers, ["EVIDENCE_GATE_CONTRACT_FAILED"]);
});
