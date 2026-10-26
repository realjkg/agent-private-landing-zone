import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { CI_ARTIFACT_NAME, CI_CONDITION_REASONS, CI_EVIDENCE_VERSION, CI_GATES, CI_JOB_NAME, ciConditionsOf, isCiGateId, type CiConditions, type CiGateEvidence, type CiGateId, type CitedFile, type CitedRun } from "../qualification/ci-gate.js";
import { canonicalJson } from "../teardown/manifest.js";
import { sha256 } from "../util/sha256.js";
import { validateReleaseManifest, type PreviewOperateReleaseManifest } from "./manifest.js";

/**
 * The product-owned producer of the CI release gates' evidence (`source-ci`, `release-archive`; the contract in
 * src/qualification/ci-gate.ts). It reads only files a person exported and downloaded beforehand into one directory:
 *
 *   gh api repos/{owner}/{repo}/actions/runs/{run_id}            > DIR/run.json
 *   gh api repos/{owner}/{repo}/actions/runs/{run_id}/jobs       > DIR/jobs.json
 *   gh api repos/{owner}/{repo}/actions/runs/{run_id}/artifacts  > DIR/artifacts.json
 *   gh run download {run_id} --name agent-private-landing-zone-supply-chain --dir DIR
 *
 * Nothing here reads a token or opens a connection; the run id a person types must be the one run.json names. Every gate
 * field is derived from those files and the frozen candidate commit; a run that does not show the gate passed is refused by
 * name and nothing is written, so no SYNTHETIC CI record exists to relabel. Identifiers, names, conclusions, digests and
 * times only: no log line, output or secret reaches the record.
 */
export { CI_GATE_IDS, CI_GATES, ciGateEvidenceProblems, isCiGateId, type CiGateEvidence, type CiGateId } from "../qualification/ci-gate.js";

/** The exported run facts, read as files; each is the body `gh api` printed. */
export type ExportedRunFacts = { run: unknown; jobs: unknown; artifacts: unknown };
export type CiEvidenceInput = {
  gateId: string;
  /** The run id the person typed; it must be the run the facts describe. */
  runId: number;
  facts: ExportedRunFacts;
  /** The downloaded artifact files by bare name, with their bytes. */
  files: Readonly<Record<string, Buffer>>;
  /** The frozen candidate commit from config/release/scope.json, or null while none is frozen. */
  candidate: string | null;
  attestedBy: string;
  now: Date;
};
export type CiEvidenceRefusal = {
  ok: false;
  code: "GATE_UNKNOWN" | "CANDIDATE_NOT_FROZEN" | "RUN_FACTS_UNREADABLE" | "RUN_ID_MISMATCH" | "CI_RUN_NOT_CANDIDATE" | "CI_RUN_NOT_PASSED" | "CI_ARTIFACT_MISSING" | "CI_ARTIFACT_INVALID";
  message: string;
};

const COMMIT = /^[0-9a-f]{40}$/;
const NOTHING = " Nothing was written.";
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const str = (value: unknown): string | undefined => (typeof value === "string" && value.length > 0 && value.length <= 512 ? value : undefined);
const num = (value: unknown): number | undefined => (typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined);
const fail = (code: CiEvidenceRefusal["code"], message: string): CiEvidenceRefusal => ({ ok: false, code, message: message + NOTHING });

/** `run.json`, `jobs.json` and `artifacts.json` as GitHub's REST API shapes them, read strictly; anything missing or odd is unreadable, never guessed. */
export function citeRun(facts: ExportedRunFacts, runId: number): { ok: true; run: CitedRun } | CiEvidenceRefusal {
  const run = facts.run;
  if (!isRecord(run)) return fail("RUN_FACTS_UNREADABLE", "run.json is not a run object.");
  const id = num(run.id);
  const attempt = num(run.run_attempt) ?? 1;
  const headSha = str(run.head_sha);
  const workflowPath = str(run.path);
  const event = str(run.event);
  const conclusion = str(run.conclusion);
  const startedAt = str(run.run_started_at) ?? str(run.created_at);
  const htmlUrl = str(run.html_url);
  const repository = isRecord(run.repository) ? str(run.repository.full_name) : undefined;
  if (id === undefined || headSha === undefined || !COMMIT.test(headSha) || workflowPath === undefined || event === undefined || conclusion === undefined || startedAt === undefined || htmlUrl === undefined || repository === undefined) {
    return fail("RUN_FACTS_UNREADABLE", "run.json lacks id, head_sha, path, event, conclusion, run_started_at, html_url or repository.full_name, or one is malformed.");
  }
  if (id !== runId) return fail("RUN_ID_MISMATCH", "run.json describes run " + id + ", not the run " + runId + " named on the command line.");
  const jobs = isRecord(facts.jobs) && Array.isArray(facts.jobs.jobs) ? facts.jobs.jobs.filter(isRecord) : undefined;
  if (jobs === undefined) return fail("RUN_FACTS_UNREADABLE", "jobs.json is not a jobs listing.");
  const job = jobs.find((candidate) => candidate.name === CI_JOB_NAME && num(candidate.run_id) === id && (num(candidate.run_attempt) ?? 1) === attempt);
  if (job === undefined) return fail("CI_RUN_NOT_PASSED", "jobs.json holds no job named \"" + CI_JOB_NAME + "\" for run " + id + " attempt " + attempt + ".");
  const jobId = num(job.id);
  const jobConclusion = str(job.conclusion);
  const runnerName = str(job.runner_name);
  const labels = Array.isArray(job.labels) ? job.labels.map(str).filter((label): label is string => label !== undefined) : [];
  const steps = Array.isArray(job.steps) ? job.steps.filter(isRecord).map((step) => ({ name: str(step.name), conclusion: str(step.conclusion) })) : [];
  if (jobId === undefined || jobConclusion === undefined || runnerName === undefined || steps.length === 0 || steps.some((step) => step.name === undefined || step.conclusion === undefined)) {
    return fail("RUN_FACTS_UNREADABLE", "the job in jobs.json lacks id, conclusion, runner_name or readable steps.");
  }
  const artifacts = isRecord(facts.artifacts) && Array.isArray(facts.artifacts.artifacts) ? facts.artifacts.artifacts.filter(isRecord) : undefined;
  if (artifacts === undefined) return fail("RUN_FACTS_UNREADABLE", "artifacts.json is not an artifact listing.");
  const listed = artifacts.find((artifact) => artifact.name === CI_ARTIFACT_NAME);
  const artifact = listed === undefined ? null : (() => {
    const artifactId = num(listed.id);
    const sizeInBytes = num(listed.size_in_bytes);
    return artifactId === undefined || sizeInBytes === undefined || typeof listed.expired !== "boolean" ? undefined : { id: artifactId, name: CI_ARTIFACT_NAME, expired: listed.expired, sizeInBytes };
  })();
  if (artifact === undefined) return fail("RUN_FACTS_UNREADABLE", "the supply-chain artifact in artifacts.json lacks id, expired or size_in_bytes.");
  return {
    ok: true,
    run: { id, attempt, workflowPath, event, headSha, conclusion, startedAt, htmlUrl, repository, runner: { name: runnerName, labels }, job: { id: jobId, name: CI_JOB_NAME, conclusion: jobConclusion },
      steps: steps.map((step) => ({ name: step.name!, conclusion: step.conclusion! })), artifact },
  };
}

/** The artifact files in a directory, by the bare names the gates know; a name that is not there is simply absent. */
export function readArtifactFiles(dir: string): Record<string, Buffer> {
  const files: Record<string, Buffer> = {};
  for (const name of new Set(Object.values(CI_GATES).flatMap((gate) => gate.files))) {
    try {
      const path = join(dir, name);
      if (statSync(path).isFile()) files[name] = readFileSync(path);
    } catch {
      // absent: the gate's filesVerified condition says so
    }
  }
  return files;
}

/** Builds the gate evidence from the exported facts and the files, or says by name why they do not show the gate passed. Reads nothing itself. */
export function buildCiGateEvidence(input: CiEvidenceInput): { ok: true; evidence: CiGateEvidence } | CiEvidenceRefusal {
  if (!isCiGateId(input.gateId)) return fail("GATE_UNKNOWN", input.gateId + " is not a CI release gate (" + Object.keys(CI_GATES).join(", ") + ").");
  const gateId: CiGateId = input.gateId;
  if (input.candidate === null || !COMMIT.test(input.candidate)) return fail("CANDIDATE_NOT_FROZEN", "No release candidate is frozen in config/release/scope.json; CI evidence is recorded only for a frozen candidate commit.");
  const cited = citeRun(input.facts, input.runId);
  if (!cited.ok) return cited;
  const { run } = cited;
  const gate = CI_GATES[gateId];
  const files: CitedFile[] = gate.files.filter((name) => input.files[name] !== undefined).map((name) => ({ name, sha256: sha256(input.files[name]!), bytes: input.files[name]!.length }));
  const missing = gate.files.filter((name) => input.files[name] === undefined);
  if (missing.length > 0) return fail("CI_ARTIFACT_MISSING", "The downloaded artifact lacks " + missing.join(", ") + " (gh run download " + run.id + " --name " + CI_ARTIFACT_NAME + ").");
  let releaseManifest: CiGateEvidence["releaseManifest"] = null;
  if (gateId === "release-archive") {
    let manifest: unknown;
    try { manifest = JSON.parse(input.files["release-manifest.json"]!.toString("utf8")); } catch { return fail("CI_ARTIFACT_INVALID", "release-manifest.json is not JSON."); }
    // The manifest validator assumes the manifest's shape; a document of another shape is refused here, not thrown on.
    const shaped = isRecord(manifest) && isRecord(manifest.contract) && isRecord(manifest.sbom) && isRecord(manifest.lifecycle) && Array.isArray(manifest.files) && manifest.files.every(isRecord);
    let blockers: string[];
    try { blockers = shaped ? validateReleaseManifest(manifest as PreviewOperateReleaseManifest) : ["not a release manifest"]; } catch { blockers = ["not a release manifest"]; }
    if (blockers.length > 0) return fail("CI_ARTIFACT_INVALID", "release-manifest.json does not validate: " + blockers.slice(0, 4).join("; ") + ".");
    const typed = manifest as PreviewOperateReleaseManifest;
    releaseManifest = { sourceCommit: typed.sourceCommit, productVersion: typed.productVersion, sbomSha256: typed.sbom.sha256 };
    const digestLine = input.files["agent-private-landing-zone.tar.gz.sha256"]!.toString("utf8").trim().split(/\s+/)[0] ?? "";
    const archive = files.find((file) => file.name === "agent-private-landing-zone.tar.gz")!;
    if (digestLine !== archive.sha256) return fail("CI_ARTIFACT_INVALID", "agent-private-landing-zone.tar.gz does not match its .sha256 file.");
  }
  const conditions = ciConditionsOf(gateId, run, files, releaseManifest, input.candidate);
  const refusal = (code: CiEvidenceRefusal["code"], keys: (keyof CiConditions)[]): CiEvidenceRefusal | undefined => {
    const failed = keys.filter((key) => !conditions[key]);
    return failed.length === 0 ? undefined : fail(code, failed.map((key) => CI_CONDITION_REASONS[key]).join("; ") + ".");
  };
  const problem = refusal("CI_RUN_NOT_CANDIDATE", ["headShaIsCandidate", "workflowIsSupplyChain"]) ??
    refusal("CI_RUN_NOT_PASSED", ["runSucceeded", "jobSucceeded", "stepsSucceeded", "artifactListed"]) ??
    refusal("CI_ARTIFACT_INVALID", ["filesVerified"]);
  if (problem) return problem;
  const evidence: CiGateEvidence = {
    schemaVersion: 1, reportKind: "CI_GATE", gateVersion: CI_EVIDENCE_VERSION, gateId, executionMode: "CI", label: "LIVE", passed: true, actEnabled: false, mutationObserved: false,
    sourceCommit: input.candidate, targetHardwareId: run.runner.name, run, files, releaseManifest, conditions,
    attestation: { attestedBy: input.attestedBy, attestedAt: input.now.toISOString() },
    checks: [
      { name: "run-facts", passed: true, evidenceSha256: sha256(canonicalJson(run as never)) },
      ...files.map((file) => ({ name: "artifact:" + file.name, passed: true as const, evidenceSha256: file.sha256 })),
    ],
    generatedAt: input.now.toISOString(),
  };
  return { ok: true, evidence };
}

/** The admission manifest record for one written evidence file (src/qualification/release-admission.ts `ReleaseGateSubmission`). */
export function ciAdmissionRecordOf(evidence: CiGateEvidence, evidencePath: string, bytes: string): { id: string; mode: "CI"; sourceCommit: string; targetHardwareId: string; evidencePath: string; evidenceSha256: string } {
  return { id: evidence.gateId, mode: "CI", sourceCommit: evidence.sourceCommit, targetHardwareId: evidence.targetHardwareId, evidencePath, evidenceSha256: createHash("sha256").update(bytes).digest("hex") };
}
