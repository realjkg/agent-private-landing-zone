/** A full commit id and a SHA-256 digest, as the admission manifest spells them; local, so this contract reaches nothing in src/apply. */
const COMMIT = /^[0-9a-f]{40}$/;
const HASH = /^[0-9a-f]{64}$/;

/**
 * The CI release gates' contract (mode CI: `source-ci`, `release-archive`), shared by the producer (src/release/ci-evidence.ts,
 * `node dist/cli/release-ci-evidence.js`) and, once wired, the admission review (src/qualification/release-admission.ts): what
 * each gate is about, the one workflow and the closed list of steps whose success it rests on, the shape of its evidence, and
 * the validator that recomputes `passed` and every derived field from the recorded run facts. One module, so the review can
 * enforce exactly what the producer promises and neither imports the other.
 *
 * Both gates come from one run of `.github/workflows/supply-chain.yml` (job "Verify, package, reproduce and scan") for the
 * exact frozen candidate commit. The producer reads only files: the run facts a person exported from GitHub beforehand
 * (`run.json`, `jobs.json`, `artifacts.json`) and the artifact files the run uploaded. Nothing in the product reads a token
 * or talks to GitHub. The honest limit is the same as the preview and recovery gates: admission is structural, the attestation
 * and the run URL are recorded, and a consistent fabrication is not detectable offline.
 */
export const CI_GATE_IDS = ["source-ci", "release-archive"] as const;
export type CiGateId = (typeof CI_GATE_IDS)[number];
export const CI_EVIDENCE_VERSION = 1;
/** The one workflow and job the CI gates rest on, as GitHub names them. */
export const CI_WORKFLOW_PATH = ".github/workflows/supply-chain.yml";
export const CI_JOB_NAME = "Verify, package, reproduce and scan";
/** The artifact the job uploads and the files in it each gate rests on. */
export const CI_ARTIFACT_NAME = "agent-private-landing-zone-supply-chain";
export const CI_GATES: Readonly<Record<CiGateId, { why: string; steps: readonly string[]; files: readonly string[] }>> = Object.freeze({
  "source-ci": Object.freeze({
    why: "Type check and functional regression on the exact candidate source",
    steps: Object.freeze(["Install locked dependencies", "Type and regression checks", "Build compiled runtime"]),
    files: Object.freeze([]),
  }),
  "release-archive": Object.freeze({
    why: "Reproducible archive, SBOM, release manifest and provenance for the candidate",
    steps: Object.freeze(["Generate CycloneDX SBOM", "Stage Preview Operate artifact", "Prove deterministic archive", "Upload release and qualification evidence"]),
    files: Object.freeze(["sbom.cdx.json", "release-manifest.json", "agent-private-landing-zone.tar.gz", "agent-private-landing-zone.tar.gz.sha256"]),
  }),
});
export const isCiGateId = (value: string): value is CiGateId => (CI_GATE_IDS as readonly string[]).includes(value);

/** Each condition, derived from the exported run facts, the artifact files and the frozen candidate; the gate passes only when every one holds. */
export type CiConditions = {
  /** run.json names the exact candidate commit. */
  headShaIsCandidate: boolean;
  /** run.json is a run of the supply-chain workflow. */
  workflowIsSupplyChain: boolean;
  /** The run finished with conclusion success. */
  runSucceeded: boolean;
  /** jobs.json holds the one job, on the same run and attempt, and it succeeded. */
  jobSucceeded: boolean;
  /** Every step the gate names is present in that job with conclusion success. */
  stepsSucceeded: boolean;
  /** The run's artifact list names the supply-chain artifact, not expired. */
  artifactListed: boolean;
  /** Every file the gate rests on was read and its digest recorded; the release manifest names the candidate and its SBOM hash matches; the archive matches its digest file. */
  filesVerified: boolean;
};
export const CI_CONDITION_REASONS: Readonly<Record<keyof CiConditions, string>> = {
  headShaIsCandidate: "the run is not of the frozen candidate commit",
  workflowIsSupplyChain: "the run is not of " + CI_WORKFLOW_PATH,
  runSucceeded: "the run did not finish with conclusion success",
  jobSucceeded: "the job \"" + CI_JOB_NAME + "\" is not in the run's jobs with conclusion success, on the same run and attempt",
  stepsSucceeded: "a step the gate rests on is missing from the job or did not succeed",
  artifactListed: "the run's artifact list does not name " + CI_ARTIFACT_NAME + ", or it expired",
  filesVerified: "a file the gate rests on is missing, or the release manifest, SBOM or archive does not verify",
};

/** The run facts as the record cites them: identifiers, names, conclusions and times only, never a log line. */
export type CitedRun = {
  id: number;
  attempt: number;
  workflowPath: string;
  event: string;
  headSha: string;
  conclusion: string;
  startedAt: string;
  htmlUrl: string;
  repository: string;
  runner: { name: string; labels: string[] };
  job: { id: number; name: string; conclusion: string };
  steps: { name: string; conclusion: string }[];
  artifact: { id: number; name: string; expired: boolean; sizeInBytes: number } | null;
};
export type CitedFile = { name: string; sha256: string; bytes: number };

export type CiGateEvidence = {
  schemaVersion: 1;
  reportKind: "CI_GATE";
  gateVersion: typeof CI_EVIDENCE_VERSION;
  gateId: CiGateId;
  executionMode: "CI";
  /** A CI record is made only when every condition holds; otherwise nothing is written. Derived, never a caller's claim. */
  label: "LIVE";
  passed: true;
  actEnabled: false;
  mutationObserved: false;
  sourceCommit: string;
  /** The GitHub-hosted runner the job ran on, as jobs.json names it: the host of this evidence is not a machine the person controls. */
  targetHardwareId: string;
  run: CitedRun;
  files: CitedFile[];
  /** The release manifest's source commit and SBOM hash as read, for the release-archive gate; null for source-ci. */
  releaseManifest: { sourceCommit: string; productVersion: string; sbomSha256: string } | null;
  conditions: CiConditions;
  attestation: { attestedBy: string; attestedAt: string };
  checks: { name: string; passed: true; evidenceSha256: string }[];
  generatedAt: string;
};

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 512;
const hashText = (value: unknown): value is string => typeof value === "string" && HASH.test(value);
const isoText = (value: unknown): value is string => typeof value === "string" && !Number.isNaN(Date.parse(value));
const count = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value >= 0;
const KEYS = ["schemaVersion", "reportKind", "gateVersion", "gateId", "executionMode", "label", "passed", "actEnabled", "mutationObserved", "sourceCommit", "targetHardwareId", "run", "files",
  "releaseManifest", "conditions", "attestation", "checks", "generatedAt"];
const RUN_KEYS = "artifact,attempt,conclusion,event,headSha,htmlUrl,id,job,repository,runner,startedAt,steps,workflowPath";
const CONDITIONS = Object.keys(CI_CONDITION_REASONS).sort().join();
const RAW_KEY = /^(logs?|stdout|stderr|output|transcript|token|secret|credentials|password|signature|authorization)$/i;
const EVENTS: readonly string[] = ["push", "pull_request", "workflow_dispatch", "schedule"];

/** The conditions as they follow from the cited run, the cited files and the candidate: the one derivation the producer and the validator share. */
export function ciConditionsOf(gateId: CiGateId, run: CitedRun, files: readonly CitedFile[], releaseManifest: CiGateEvidence["releaseManifest"], candidate: string): CiConditions {
  const gate = CI_GATES[gateId];
  const stepsSucceeded = gate.steps.every((name) => run.steps.some((step) => step.name === name && step.conclusion === "success"));
  const byName = new Map(files.map((file) => [file.name, file]));
  const everyFile = gate.files.every((name) => byName.has(name));
  const archive = byName.get("agent-private-landing-zone.tar.gz");
  const manifestOk = gateId === "source-ci" ? releaseManifest === null
    : releaseManifest !== null && releaseManifest.sourceCommit === candidate && byName.get("sbom.cdx.json")?.sha256 === releaseManifest.sbomSha256;
  return {
    headShaIsCandidate: COMMIT.test(candidate) && run.headSha === candidate,
    workflowIsSupplyChain: run.workflowPath === CI_WORKFLOW_PATH,
    runSucceeded: run.conclusion === "success",
    jobSucceeded: run.job.name === CI_JOB_NAME && run.job.conclusion === "success",
    stepsSucceeded,
    artifactListed: run.artifact !== null && run.artifact.name === CI_ARTIFACT_NAME && run.artifact.expired === false,
    filesVerified: everyFile && manifestOk && (gateId === "source-ci" || (archive !== undefined && HASH.test(archive.sha256))),
  };
}

function citedRunProblems(value: unknown): string[] {
  if (!isRecord(value) || Object.keys(value).sort().join() !== RUN_KEYS) return ["ci evidence.run: exactly " + RUN_KEYS.replaceAll(",", ", ")];
  const problems: string[] = [];
  if (!count(value.id) || value.id < 1 || !count(value.attempt) || value.attempt < 1) problems.push("ci evidence.run: id and attempt are positive integers");
  if (!text(value.workflowPath) || !text(value.conclusion) || !text(value.repository) || !EVENTS.includes(value.event as string)) problems.push("ci evidence.run: workflowPath, event, conclusion or repository is malformed");
  if (typeof value.headSha !== "string" || !COMMIT.test(value.headSha)) problems.push("ci evidence.run.headSha: not a commit id");
  if (!isoText(value.startedAt)) problems.push("ci evidence.run.startedAt: malformed");
  if (typeof value.htmlUrl !== "string" || !/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/actions\/runs\/[0-9]+(?:\/attempts\/[0-9]+)?$/.test(value.htmlUrl)) problems.push("ci evidence.run.htmlUrl: not a GitHub Actions run page");
  const runner = value.runner;
  if (!isRecord(runner) || Object.keys(runner).sort().join() !== "labels,name" || !text(runner.name) || !Array.isArray(runner.labels) || !runner.labels.every(text)) problems.push("ci evidence.run.runner: a name and labels");
  const job = value.job;
  if (!isRecord(job) || Object.keys(job).sort().join() !== "conclusion,id,name" || !count(job.id) || !text(job.name) || !text(job.conclusion)) problems.push("ci evidence.run.job: id, name and conclusion");
  if (!Array.isArray(value.steps) || value.steps.length === 0 || !value.steps.every((step) => isRecord(step) && Object.keys(step).sort().join() === "conclusion,name" && text(step.name) && text(step.conclusion))) problems.push("ci evidence.run.steps: each a name and a conclusion");
  const artifact = value.artifact;
  if (artifact !== null && (!isRecord(artifact) || Object.keys(artifact).sort().join() !== "expired,id,name,sizeInBytes" || !count(artifact.id) || !text(artifact.name) || typeof artifact.expired !== "boolean" || !count(artifact.sizeInBytes))) {
    problems.push("ci evidence.run.artifact: null, or id, name, expired and sizeInBytes");
  }
  return problems;
}

/**
 * Every reason a document is not valid CI-gate evidence. Empty means it is. The conditions, `passed` and `label` are recomputed
 * from the cited run facts, files and the expected candidate commit, so a hand-written document, or one relabeled over a run
 * that failed, ran another commit or another workflow, or lacks a step, is refused here and at admission alike.
 */
export function ciGateEvidenceProblems(value: unknown, expected: { sourceCommit?: string; gateId?: string } = {}): string[] {
  if (!isRecord(value)) return ["ci evidence: expected an object"];
  const problems: string[] = [];
  for (const key of Object.keys(value)) if (!KEYS.includes(key)) problems.push("ci evidence." + key + (RAW_KEY.test(key) ? ": raw log, output or secret field" : ": not part of the evidence"));
  for (const key of KEYS) if (!Object.hasOwn(value, key)) problems.push("ci evidence." + key + ": missing");
  if (problems.length > 0) return problems;
  if (value.schemaVersion !== 1 || value.reportKind !== "CI_GATE" || value.gateVersion !== CI_EVIDENCE_VERSION || value.executionMode !== "CI") problems.push("ci evidence: not a schemaVersion 1 CI_GATE document of gate version " + CI_EVIDENCE_VERSION);
  if (typeof value.gateId !== "string" || !isCiGateId(value.gateId)) problems.push("ci evidence.gateId: not a CI release gate");
  if (expected.gateId !== undefined && value.gateId !== expected.gateId) problems.push("ci evidence.gateId: not the expected gate");
  if (value.actEnabled !== false || value.mutationObserved !== false) problems.push("ci evidence: CI applies nothing and observes no mutation");
  if (typeof value.sourceCommit !== "string" || !COMMIT.test(value.sourceCommit)) problems.push("ci evidence.sourceCommit: not a commit id");
  if (expected.sourceCommit !== undefined && value.sourceCommit !== expected.sourceCommit) problems.push("ci evidence.sourceCommit: not the expected source commit");
  if (!text(value.targetHardwareId) || value.targetHardwareId === "UNKNOWN") problems.push("ci evidence.targetHardwareId: the runner is not named");
  problems.push(...citedRunProblems(value.run));
  if (!Array.isArray(value.files) || !value.files.every((file) => isRecord(file) && Object.keys(file).sort().join() === "bytes,name,sha256" && text(file.name) && !/[\\/]/.test(file.name) && hashText(file.sha256) && count(file.bytes))) {
    problems.push("ci evidence.files: each a bare file name, its sha256 and its size");
  }
  const manifest = value.releaseManifest;
  if (manifest !== null && (!isRecord(manifest) || Object.keys(manifest).sort().join() !== "productVersion,sbomSha256,sourceCommit" || typeof manifest.sourceCommit !== "string" || !COMMIT.test(manifest.sourceCommit) || !text(manifest.productVersion) || !hashText(manifest.sbomSha256))) {
    problems.push("ci evidence.releaseManifest: null, or sourceCommit, productVersion and sbomSha256");
  }
  const attestation = value.attestation;
  if (!isRecord(attestation) || Object.keys(attestation).sort().join() !== "attestedAt,attestedBy" || !text(attestation.attestedBy) || (attestation.attestedBy as string).trim() === "" || !isoText(attestation.attestedAt)) problems.push("ci evidence.attestation: a name and a time");
  if (!Array.isArray(value.checks) || value.checks.length === 0 || !value.checks.every((c) => isRecord(c) && Object.keys(c).sort().join() === "evidenceSha256,name,passed" && text(c.name) && c.passed === true && hashText(c.evidenceSha256))) {
    problems.push("ci evidence.checks: each names what it checked and the hash it rests on");
  }
  if (!isoText(value.generatedAt)) problems.push("ci evidence.generatedAt: malformed");
  if (problems.length > 0) return problems;
  // Everything below is recomputed from the cited facts: a declaration never counts.
  const gateId = value.gateId as CiGateId;
  const run = value.run as CitedRun;
  const files = value.files as CitedFile[];
  const conditions = ciConditionsOf(gateId, run, files, manifest as CiGateEvidence["releaseManifest"], value.sourceCommit as string);
  const declared = value.conditions;
  if (!isRecord(declared) || Object.keys(declared).sort().join() !== CONDITIONS || (Object.keys(conditions) as (keyof CiConditions)[]).some((key) => declared[key] !== conditions[key])) {
    problems.push("ci evidence.conditions: not derived from the cited run and files (a declaration never counts)");
  }
  const failed = (Object.keys(conditions) as (keyof CiConditions)[]).filter((key) => !conditions[key]);
  if (failed.length > 0) problems.push("ci evidence: the cited run and files do not show the gate passed (" + failed.map((key) => CI_CONDITION_REASONS[key]).join("; ") + ")");
  if (value.label !== "LIVE" || value.passed !== true) problems.push("ci evidence: label LIVE and passed true are the only values a written record holds; anything else was not made by the producer");
  if (value.targetHardwareId !== run.runner.name) problems.push("ci evidence.targetHardwareId: not the cited runner");
  if (!/\/actions\/runs\/[0-9]+/.test(run.htmlUrl) || !run.htmlUrl.includes("/actions/runs/" + run.id)) problems.push("ci evidence.run.htmlUrl: not this run's page");
  const checks = value.checks as { name: string; evidenceSha256: string }[];
  const cites = (name: string, hash: string): boolean => checks.some((check) => check.name === name && check.evidenceSha256 === hash);
  if (!files.every((file) => cites("artifact:" + file.name, file.sha256))) problems.push("ci evidence.checks: must cite every file by its hash");
  if (!checks.some((check) => check.name === "run-facts")) problems.push("ci evidence.checks: must cite the run facts by their canonical hash");
  return problems;
}
