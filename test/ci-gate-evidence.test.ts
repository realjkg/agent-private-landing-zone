import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import test from "node:test";

import { releaseCiEvidence, type CiEvidenceCliDeps } from "../src/cli/release-ci-evidence.js";
import { CI_ARTIFACT_NAME, CI_GATES, CI_JOB_NAME, CI_WORKFLOW_PATH, ciConditionsOf, ciGateEvidenceProblems, type CiGateEvidence } from "../src/qualification/ci-gate.js";
import { PRODUCTION_RELEASE_GATES, reviewProductionRelease, type ReleaseGateSubmission } from "../src/qualification/release-admission.js";
import { buildCiGateEvidence, ciAdmissionRecordOf, citeRun, readArtifactFiles } from "../src/release/ci-evidence.js";
import { createReleaseManifest } from "../src/release/manifest.js";

// The product-owned producer of the CI release gates' evidence (src/release/ci-evidence.ts, node dist/cli/release-ci-evidence.js),
// against the contract in src/qualification/ci-gate.ts. Every run fact here is a fixture shaped like GitHub's REST API output and
// every artifact file is a fixture, so every document is SYNTHETIC evidence of the product's logic under a fixture attestation;
// it proves what the producer writes and refuses, never that a gate is closed. Nothing here reads a token or opens a connection.

const root = mkdtempSync(join(tmpdir(), "alz-ci-gate-"));
test.after(() => rmSync(root, { recursive: true, force: true }));
let counter = 0;
const fresh = (label: string): string => { const dir = join(root, label + "-" + (counter += 1)); mkdirSync(dir, { recursive: true, mode: 0o700 }); return dir; };
const sha256 = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");
const CANDIDATE = "c".repeat(40);
const RUN_ID = 40308094029;
const NOW = new Date("2026-10-26T12:00:00.000Z");
const REPO = "realjkg/agent-private-landing-zone";

/** The exported run facts as `gh api` prints them, for a successful supply-chain run of the candidate; `over` reshapes any of the three. */
function facts(over: { run?: Record<string, unknown>; job?: Record<string, unknown>; steps?: { name: string; conclusion: string }[]; artifacts?: unknown[] } = {}) {
  const steps = over.steps ?? ["Checkout", "Node", "Install locked dependencies", "Type and regression checks", "Build compiled runtime", "Compiled operator design scenarios", "Dependency audit",
    "Generate CycloneDX SBOM", "Stage Preview Operate artifact", "Prove deterministic archive", "Clean production install smoke", "Scan vulnerabilities and IaC configuration", "Upload release and qualification evidence"]
    .map((name, index) => ({ name, status: "completed", conclusion: "success", number: index + 1 }));
  const run = { id: RUN_ID, name: "Agent Private Landing Zone Supply Chain", path: CI_WORKFLOW_PATH, head_sha: CANDIDATE, event: "push", status: "completed", conclusion: "success", run_attempt: 1,
    run_started_at: "2026-10-26T09:00:00Z", html_url: "https://github.com/" + REPO + "/actions/runs/" + RUN_ID, repository: { full_name: REPO }, head_branch: "main", logs_url: "https://api.github.com/x", ...over.run };
  const job = { id: 121511720192, run_id: RUN_ID, run_attempt: 1, name: CI_JOB_NAME, status: "completed", conclusion: "success", runner_name: "GitHub Actions 7", labels: ["ubuntu-latest"], head_sha: CANDIDATE, steps, ...over.job };
  const artifacts = over.artifacts ?? [{ id: 3344, name: CI_ARTIFACT_NAME, size_in_bytes: 123456, expired: false, archive_download_url: "https://api.github.com/x/zip" }, { id: 3345, name: "agent-private-landing-zone-docker-arm64-security", size_in_bytes: 10, expired: false }];
  return { run, jobs: { total_count: 2, jobs: [job, { id: 1, run_id: RUN_ID, run_attempt: 1, name: "Build, test and scan Linux ARM64 Docker image", conclusion: "success", runner_name: "GitHub Actions 8", labels: [], steps: [{ name: "x", conclusion: "success" }] }] }, artifacts: { total_count: artifacts.length, artifacts } };
}
/** The files the supply-chain artifact holds, as `gh run download` leaves them: a valid release manifest for the candidate, the SBOM it hashes, the archive and its digest line. */
function artifactFiles(over: { sourceCommit?: string; sbom?: string; manifestSbomSha256?: string; archive?: string; digestLine?: string } = {}): Record<string, Buffer> {
  const sbom = Buffer.from(over.sbom ?? JSON.stringify({ bomFormat: "CycloneDX", specVersion: "1.5", components: [] }));
  const archive = Buffer.from(over.archive ?? "fixture-archive-bytes");
  const manifest = createReleaseManifest({ productVersion: "1.2.3", sourceCommit: over.sourceCommit ?? CANDIDATE, files: [{ path: "alz", sha256: "a".repeat(64) }], sbomPath: "sbom.cdx.json", sbomSha256: over.manifestSbomSha256 ?? sha256(sbom) });
  return {
    "sbom.cdx.json": sbom, "release-manifest.json": Buffer.from(JSON.stringify(manifest, null, 2)), "agent-private-landing-zone.tar.gz": archive,
    "agent-private-landing-zone.tar.gz.sha256": Buffer.from(over.digestLine ?? sha256(archive) + "  .runs/release/agent-private-landing-zone.tar.gz\n"),
  };
}
/** A repository root with a frozen (or not) candidate in config/release/scope.json, and an export directory with the facts and files. */
function world(candidate: string | null = CANDIDATE, exported = facts(), files = artifactFiles()): { root: string; dir: string } {
  const r = fresh("root");
  mkdirSync(join(r, "config", "release"), { recursive: true });
  const scope = JSON.parse(readFileSync(join(process.cwd(), "config", "release", "scope.json"), "utf8")) as Record<string, unknown>;
  writeFileSync(join(r, "config", "release", "scope.json"), JSON.stringify({ ...scope, candidate, manifest: null }));
  const dir = join(r, "export");
  mkdirSync(dir);
  for (const [name, value] of Object.entries(exported)) writeFileSync(join(dir, name + ".json"), JSON.stringify(value));
  for (const [name, bytes] of Object.entries(files)) writeFileSync(join(dir, name), bytes);
  return { root: r, dir };
}
type Run = { code: number; stdout: string; stderr: string; asked: { prompt: string; phrase?: string }[]; shown: string };
async function cli(w: { root: string; dir: string }, gate: string, answers: string[], over: Partial<CiEvidenceCliDeps> = {}, run = String(RUN_ID)): Promise<Run> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const shown: string[] = [];
  const asked: Run["asked"] = [];
  const code = await releaseCiEvidence(["--gate", gate, "--run", run, "--artifacts", w.dir], {
    root: w.root, operatorId: "operator.fixture", now: () => NOW, releaseEvidenceDir: join(w.root, "evidence"),
    terminal: { stdinIsTTY: true, stdoutIsTTY: true, write: (t) => { shown.push(t); }, ask: async (prompt, expectation) => { asked.push({ prompt, phrase: expectation?.phrase }); return answers.shift() ?? ""; } },
    stdout: (t) => { stdout.push(t); }, stderr: (t) => { stderr.push(t); }, ...over,
  });
  return { code, stdout: stdout.join(""), stderr: stderr.join(""), asked, shown: shown.join("") };
}
const phraseFor = (gate: string): string => "CI LIVE " + gate + " " + CANDIDATE.slice(0, 12) + " " + RUN_ID;
/** The admission review (today structural for mode CI) of a manifest holding exactly this evidence file. */
async function admit(w: { root: string }, written: string, record: ReleaseGateSubmission) {
  const review = await reviewProductionRelease({
    manifest: { schemaVersion: 1, sourceCommit: CANDIDATE, operatingMode: "PREVIEW_OPERATE", infrastructureAct: "DISABLED", records: [{ ...record, evidencePath: relative(w.root, written) }] },
    root: w.root, expectedCommit: CANDIDATE,
  });
  return review.gates.find((gate) => gate.id === record.id)!;
}

test("the two CI gates exist with mode CI, rest on one workflow and job, and each names a closed list of steps and files that cannot be widened at run time", () => {
  for (const id of Object.keys(CI_GATES)) assert.equal(PRODUCTION_RELEASE_GATES.find((gate) => gate.id === id)?.mode, "CI", id);
  assert.ok(Object.isFrozen(CI_GATES) && Object.isFrozen(CI_GATES["source-ci"].steps) && Object.isFrozen(CI_GATES["release-archive"].files));
  assert.deepEqual([...CI_GATES["source-ci"].steps], ["Install locked dependencies", "Type and regression checks", "Build compiled runtime"]);
  assert.deepEqual([...CI_GATES["release-archive"].files], ["sbom.cdx.json", "release-manifest.json", "agent-private-landing-zone.tar.gz", "agent-private-landing-zone.tar.gz.sha256"]);
  // The steps and the artifact the gates name are the ones the workflow in this repository runs and uploads.
  const workflow = readFileSync(join(process.cwd(), CI_WORKFLOW_PATH), "utf8");
  for (const step of [...CI_GATES["source-ci"].steps, ...CI_GATES["release-archive"].steps]) assert.ok(workflow.includes("- name: " + step), step);
  assert.ok(workflow.includes("name: " + CI_JOB_NAME) && workflow.includes("name: " + CI_ARTIFACT_NAME));
  for (const file of CI_GATES["release-archive"].files) assert.ok(workflow.includes(file), file);
});

test("release-ci-evidence writes LIVE evidence for each gate only from the exported facts of a successful supply-chain run of the frozen candidate and the artifact files it uploaded, reading files only, after the person attests; every field is derived; the record is admitted structurally; it is written once (fixture facts and files: synthetic evidence of the producer's contract, not of the gate)", async () => {
  const w = world();
  for (const gate of ["source-ci", "release-archive"] as const) {
    const run = await cli(w, gate, [phraseFor(gate)]);
    assert.equal(run.code, 0, run.stderr);
    assert.match(run.shown, /candidate\s+c{40}/);
    assert.match(run.shown, /run\s+https:\/\/github\.com\/realjkg\/agent-private-landing-zone\/actions\/runs\/40308094029 \(attempt 1, push, success\)/);
    assert.match(run.shown, /job\s+Verify, package, reproduce and scan on GitHub Actions 7 \[ubuntu-latest\]/);
    assert.deepEqual(run.asked.map((a) => a.phrase), [phraseFor(gate)]);
    const out = JSON.parse(run.stdout) as { written: string; record: ReleaseGateSubmission };
    assert.equal(out.written, join(w.root, "evidence", gate + "-" + CANDIDATE.slice(0, 12) + ".json"));
    const bytes = readFileSync(out.written, "utf8");
    const evidence = JSON.parse(bytes) as CiGateEvidence;
    assert.deepEqual([evidence.gateId, evidence.executionMode, evidence.label, evidence.passed, evidence.actEnabled, evidence.mutationObserved, evidence.sourceCommit, evidence.targetHardwareId],
      [gate, "CI", "LIVE", true, false, false, CANDIDATE, "GitHub Actions 7"]);
    assert.equal(evidence.run.id, RUN_ID);
    assert.equal(evidence.run.headSha, CANDIDATE);
    assert.equal(evidence.run.workflowPath, CI_WORKFLOW_PATH);
    assert.deepEqual(evidence.run.job, { id: 121511720192, name: CI_JOB_NAME, conclusion: "success" });
    assert.deepEqual(evidence.run.artifact, { id: 3344, name: CI_ARTIFACT_NAME, expired: false, sizeInBytes: 123456 });
    assert.ok(Object.values(evidence.conditions).every((x) => x === true));
    assert.deepEqual(evidence.conditions, ciConditionsOf(gate, evidence.run, evidence.files, evidence.releaseManifest, CANDIDATE));
    if (gate === "source-ci") { assert.deepEqual(evidence.files, []); assert.equal(evidence.releaseManifest, null); }
    else {
      assert.deepEqual(evidence.files.map((f) => f.name), [...CI_GATES["release-archive"].files]);
      assert.deepEqual(evidence.releaseManifest, { sourceCommit: CANDIDATE, productVersion: "1.2.3", sbomSha256: sha256(readFileSync(join(w.dir, "sbom.cdx.json"))) });
    }
    assert.deepEqual(evidence.attestation, { attestedBy: "operator.fixture", attestedAt: NOW.toISOString() });
    assert.ok(evidence.checks.some((c) => c.name === "run-facts") && evidence.files.every((f) => evidence.checks.some((c) => c.name === "artifact:" + f.name && c.evidenceSha256 === f.sha256)));
    // Identifiers, names, conclusions, digests and times only: no log, output, token or download URL reaches the record.
    assert.ok(!/logs_url|archive_download_url|token|authorization|stdout/i.test(bytes), "no raw field");
    assert.deepEqual(ciGateEvidenceProblems(evidence, { sourceCommit: CANDIDATE, gateId: gate }), []);
    assert.deepEqual(out.record, { id: gate, mode: "CI", sourceCommit: CANDIDATE, targetHardwareId: "GitHub Actions 7", evidencePath: relative(w.root, out.written), evidenceSha256: sha256(bytes) });
    const admitted = await admit(w, out.written, out.record);
    assert.deepEqual(admitted.blockers, [], JSON.stringify(admitted));
    // Written once.
    const again = await cli(w, gate, [phraseFor(gate)]);
    assert.equal(again.code, 1);
    assert.match(again.stderr, /^CI_EVIDENCE_EXISTS/);
    assert.equal(readFileSync(out.written, "utf8"), bytes);
  }
  assert.equal(readdirSync(join(w.root, "evidence")).length, 2);
});

test("release-ci-evidence refuses by name before any phrase is asked for and writes nothing: no frozen candidate, a run of another commit or workflow, a failed run, job or step, a missing step, an expired or missing artifact, a run id that is not run.json's, unreadable facts, a manifest for another commit, an SBOM or archive that does not match, a missing file; a wrong phrase writes nothing; the flag set is closed", async () => {
  const refused = async (w: { root: string; dir: string }, gate: string, code: string, pattern: RegExp, run?: string) => {
    const result = await cli(w, gate, [phraseFor(gate)], {}, run);
    assert.equal(result.code, 2, gate + " " + code + ": " + result.stderr);
    assert.match(result.stderr, new RegExp("^BLOCKED " + code + ": "), gate + " " + code);
    assert.match(result.stderr, pattern, gate + " " + code);
    assert.deepEqual(result.asked, [], gate + " " + code + ": refused before any phrase");
    assert.ok(!existsSync(join(w.root, "evidence")) || readdirSync(join(w.root, "evidence")).length === 0, gate + " " + code + ": nothing written");
  };
  await refused(world(null), "source-ci", "CANDIDATE_NOT_FROZEN", /No release candidate is frozen/);
  await refused(world(CANDIDATE, facts({ run: { head_sha: "d".repeat(40) } })), "source-ci", "CI_RUN_NOT_CANDIDATE", /not of the frozen candidate commit/);
  await refused(world(CANDIDATE, facts({ run: { path: ".github/workflows/pr-validation.yml" } })), "source-ci", "CI_RUN_NOT_CANDIDATE", /not of \.github\/workflows\/supply-chain\.yml/);
  await refused(world(CANDIDATE, facts({ run: { conclusion: "failure" } })), "source-ci", "CI_RUN_NOT_PASSED", /did not finish with conclusion success/);
  await refused(world(CANDIDATE, facts({ job: { conclusion: "failure" } })), "source-ci", "CI_RUN_NOT_PASSED", /is not in the run's jobs with conclusion success/);
  await refused(world(CANDIDATE, facts({ job: { run_attempt: 2 } })), "source-ci", "CI_RUN_NOT_PASSED", /holds no job named/);
  const failedStep = facts();
  (failedStep.jobs.jobs[0] as { steps: { name: string; conclusion: string }[] }).steps.find((s) => s.name === "Type and regression checks")!.conclusion = "failure";
  await refused(world(CANDIDATE, failedStep), "source-ci", "CI_RUN_NOT_PASSED", /a step the gate rests on is missing from the job or did not succeed/);
  const missingStep = facts();
  (missingStep.jobs.jobs[0] as { steps: { name: string }[] }).steps = (missingStep.jobs.jobs[0] as { steps: { name: string }[] }).steps.filter((s) => s.name !== "Prove deterministic archive");
  await refused(world(CANDIDATE, missingStep), "release-archive", "CI_RUN_NOT_PASSED", /a step the gate rests on is missing/);
  assert.equal((await cli(world(CANDIDATE, missingStep), "source-ci", [phraseFor("source-ci")])).code, 0, "source-ci does not rest on the archive step");
  await refused(world(CANDIDATE, facts({ artifacts: [{ id: 1, name: CI_ARTIFACT_NAME, size_in_bytes: 1, expired: true }] })), "source-ci", "CI_RUN_NOT_PASSED", /or it expired/);
  await refused(world(CANDIDATE, facts({ artifacts: [] })), "source-ci", "CI_RUN_NOT_PASSED", /does not name agent-private-landing-zone-supply-chain/);
  await refused(world(), "source-ci", "RUN_ID_MISMATCH", /describes run 40308094029, not the run 1/, "1");
  await refused(world(CANDIDATE, facts({ run: { head_sha: "not-a-commit" } })), "source-ci", "RUN_FACTS_UNREADABLE", /run\.json lacks/);
  await refused(world(CANDIDATE, { ...facts(), jobs: { jobs: "x" } }), "source-ci", "RUN_FACTS_UNREADABLE", /jobs\.json is not a jobs listing/);
  const noFacts = world();
  rmSync(join(noFacts.dir, "artifacts.json"));
  await refused(noFacts, "source-ci", "RUN_FACTS_UNREADABLE", /artifacts\.json is missing/);
  await refused(world(CANDIDATE, facts(), artifactFiles({ sourceCommit: "d".repeat(40) })), "release-archive", "CI_ARTIFACT_INVALID", /release manifest, SBOM or archive does not verify/);
  await refused(world(CANDIDATE, facts(), artifactFiles({ manifestSbomSha256: "e".repeat(64) })), "release-archive", "CI_ARTIFACT_INVALID", /release manifest, SBOM or archive does not verify/);
  await refused(world(CANDIDATE, facts(), artifactFiles({ digestLine: "e".repeat(64) + "  archive\n" })), "release-archive", "CI_ARTIFACT_INVALID", /does not match its \.sha256 file/);
  await refused(world(CANDIDATE, facts(), { ...artifactFiles(), "release-manifest.json": Buffer.from("{\"schemaVersion\":2}") }), "release-archive", "CI_ARTIFACT_INVALID", /does not validate|not JSON/);
  const partial = artifactFiles();
  delete partial["agent-private-landing-zone.tar.gz"];
  await refused(world(CANDIDATE, facts(), partial), "release-archive", "CI_ARTIFACT_MISSING", /lacks agent-private-landing-zone\.tar\.gz \(gh run download 40308094029/);
  assert.equal((await cli(world(CANDIDATE, facts(), {}), "source-ci", [phraseFor("source-ci")])).code, 0, "source-ci rests on no file");
  // A wrong phrase writes nothing; an unknown gate, a malformed run id and an unknown or repeated flag are refused.
  const w = world();
  const wrong = await cli(w, "source-ci", ["CI LIVE source-ci"]);
  assert.equal(wrong.code, 1);
  assert.match(wrong.stderr, /^CI_ATTESTATION_MISMATCH/);
  assert.ok(!existsSync(join(w.root, "evidence")));
  assert.match((await cli(w, "preview:terraform-aws-brownfield", [])).stderr, /^BLOCKED GATE_UNKNOWN/);
  assert.match((await cli(w, "source-ci", [], {}, "0x10")).stderr, /^CI_EVIDENCE_ARGUMENT_INVALID/);
  assert.equal(await releaseCiEvidence(["--gate", "source-ci", "--run", "1", "--artifacts", w.dir, "--token", "x"], { stderr: () => undefined }), 1);
  assert.equal(await releaseCiEvidence(["--gate", "source-ci"], { stderr: () => undefined }), 1);
  // The producer never looks at the environment for a token, and the record never carries one.
  const builtWithToken = buildCiGateEvidence({ gateId: "source-ci", runId: RUN_ID, facts: facts(), files: {}, candidate: CANDIDATE, attestedBy: "operator.fixture", now: NOW });
  assert.ok(builtWithToken.ok && !JSON.stringify(builtWithToken.evidence).includes("ghp_"));
});

test("the validator recomputes every derived field: a hand-written or relabeled CI document is refused, and the builder and citeRun refuse the same facts directly", () => {
  const files = artifactFiles();
  const built = buildCiGateEvidence({ gateId: "release-archive", runId: RUN_ID, facts: facts(), files, candidate: CANDIDATE, attestedBy: "operator.fixture", now: NOW });
  assert.ok(built.ok);
  const evidence = built.evidence;
  assert.deepEqual(ciGateEvidenceProblems(evidence, { sourceCommit: CANDIDATE, gateId: "release-archive" }), []);
  const problems = (edit: Record<string, unknown>) => ciGateEvidenceProblems({ ...evidence, ...edit }, { sourceCommit: CANDIDATE }).join(" | ");
  const failedStep = evidence.run.steps.map((s) => (s.name === "Prove deterministic archive" ? { ...s, conclusion: "failure" } : s));
  const forged: [string, Record<string, unknown>, RegExp][] = [
    ["run relabeled over a failure", { run: { ...evidence.run, conclusion: "failure" } }, /did not finish with conclusion success/],
    ["step relabeled over a failure", { run: { ...evidence.run, steps: failedStep } }, /a step the gate rests on is missing from the job or did not succeed/],
    ["step dropped", { run: { ...evidence.run, steps: evidence.run.steps.filter((s) => s.name !== "Generate CycloneDX SBOM") } }, /a step the gate rests on is missing/],
    ["another commit cited", { run: { ...evidence.run, headSha: "d".repeat(40) } }, /not of the frozen candidate commit/],
    ["another workflow", { run: { ...evidence.run, workflowPath: ".github/workflows/pr-validation.yml" } }, /not of \.github\/workflows\/supply-chain\.yml/],
    ["another job", { run: { ...evidence.run, job: { ...evidence.run.job, name: "Affected code QA" } } }, /is not in the run's jobs/],
    ["artifact expired", { run: { ...evidence.run, artifact: { ...evidence.run.artifact!, expired: true } } }, /or it expired/],
    ["conditions declared", { conditions: { ...evidence.conditions, runSucceeded: false } }, /conditions: not derived/],
    ["passed declared false", { passed: false }, /label LIVE and passed true are the only values/],
    ["label synthetic", { label: "SYNTHETIC" }, /label LIVE and passed true are the only values/],
    ["act enabled", { actEnabled: true }, /CI applies nothing/],
    ["another source commit", { sourceCommit: "d".repeat(40) }, /sourceCommit: not the expected source commit/],
    ["runner not the host", { targetHardwareId: "my-laptop" }, /targetHardwareId: not the cited runner/],
    ["unknown host", { targetHardwareId: "UNKNOWN" }, /the runner is not named/],
    ["another run's page", { run: { ...evidence.run, htmlUrl: "https://github.com/" + REPO + "/actions/runs/1" } }, /not this run's page/],
    ["manifest for another commit", { releaseManifest: { ...evidence.releaseManifest!, sourceCommit: "d".repeat(40) } }, /release manifest, SBOM or archive does not verify/],
    ["sbom hash swapped", { files: evidence.files.map((f) => (f.name === "sbom.cdx.json" ? { ...f, sha256: "f".repeat(64) } : f)) }, /does not verify|must cite every file/],
    ["file dropped", { files: evidence.files.filter((f) => f.name !== "agent-private-landing-zone.tar.gz") }, /a file the gate rests on is missing/],
    ["check hash swapped", { checks: evidence.checks.map((c) => (c.name === "run-facts" ? { ...c, name: "run-fact" } : c)) }, /must cite the run facts/],
    ["raw log field", { logs: "x" }, /raw log, output or secret field/],
    ["token field", { token: "ghp_x" }, /raw log, output or secret field/],
    ["other gate", { gateId: "preview:cdk-aws-brownfield" }, /not a CI release gate/],
    ["no attestation", { attestation: null }, /attestation: a name and a time/],
    ["path in a file name", { files: evidence.files.map((f) => ({ ...f, name: "../" + f.name })) }, /each a bare file name/],
  ];
  for (const [label, edit, pattern] of forged) assert.match(problems(edit), pattern, label);
  assert.match(ciGateEvidenceProblems(evidence, { gateId: "source-ci" }).join(" | "), /not the expected gate/);
  const { run: _dropped, ...withoutRun } = evidence;
  assert.match(ciGateEvidenceProblems(withoutRun).join(" | "), /run: missing/);
  assert.deepEqual(ciGateEvidenceProblems("text"), ["ci evidence: expected an object"]);
  // A source-ci document that cites artifact files or a release manifest it does not rest on is not the producer's.
  const source = buildCiGateEvidence({ gateId: "source-ci", runId: RUN_ID, facts: facts(), files, candidate: CANDIDATE, attestedBy: "operator.fixture", now: NOW });
  assert.ok(source.ok && source.evidence.files.length === 0 && source.evidence.releaseManifest === null);
  assert.match(ciGateEvidenceProblems({ ...source.evidence, releaseManifest: evidence.releaseManifest }).join(" | "), /does not verify/);
  // citeRun refuses facts that are not GitHub's shapes, and the builder refuses the same facts the command does.
  assert.equal((citeRun({ run: [], jobs: {}, artifacts: {} }, RUN_ID) as { code: string }).code, "RUN_FACTS_UNREADABLE");
  assert.equal((citeRun({ ...facts(), run: { ...facts().run, repository: {} } }, RUN_ID) as { code: string }).code, "RUN_FACTS_UNREADABLE");
  assert.equal((citeRun(facts(), 7) as { code: string }).code, "RUN_ID_MISMATCH");
  assert.equal((buildCiGateEvidence({ gateId: "release-archive", runId: RUN_ID, facts: facts(), files, candidate: null, attestedBy: "x", now: NOW }) as { code: string }).code, "CANDIDATE_NOT_FROZEN");
  assert.equal((buildCiGateEvidence({ gateId: "release-archive", runId: RUN_ID, facts: facts({ run: { conclusion: "cancelled" } }), files, candidate: CANDIDATE, attestedBy: "x", now: NOW }) as { code: string }).code, "CI_RUN_NOT_PASSED");
  // Files are read by bare name from the directory only; a stray file is not read, and the admission record cites the written bytes.
  const dir = fresh("files");
  for (const [name, bytes] of Object.entries(files)) writeFileSync(join(dir, name), bytes);
  writeFileSync(join(dir, "notes.txt"), "x");
  assert.deepEqual(Object.keys(readArtifactFiles(dir)).sort(), [...CI_GATES["release-archive"].files].sort());
  const bytes = JSON.stringify(evidence) + "\n";
  assert.deepEqual(ciAdmissionRecordOf(evidence, "evidence/x.json", bytes), { id: "release-archive", mode: "CI", sourceCommit: CANDIDATE, targetHardwareId: "GitHub Actions 7", evidencePath: "evidence/x.json", evidenceSha256: sha256(bytes) });
});
