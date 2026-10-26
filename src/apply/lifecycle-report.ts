import { canonicalJson } from "../teardown/manifest.js";
import type { ResolvedTarget } from "../teardown/driver/types.js";
import { sha256 } from "../util/sha256.js";
import type { CleanupProposal } from "./cleanup-proposal.js";
import { COMMIT, HASH } from "./constants.js";
import type { LiveAcceptanceRecord } from "./live-record.js";
import type { LeftoversRecord, ObservationRecord } from "./run-records.js";
import type { ApplyEnvironment, ApplyEvidence, CleanupEvidence, EngineId, ProviderId } from "./types.js";

/**
 * The lifecycle acceptance report (docs/observe-and-cleanup.md, "The report"): one machine-checked document per pilot
 * run that says how far the journey got (execute, observe, propose, cleanup, leftovers), from the run's own records and
 * nothing else. The product writes it (`./alz apply report`); a caller never declares a result. `passed` is derived from
 * the records, and `lifecycleReportProblems` recomputes it, so a report that claims more than its records show is
 * refused. Each stage carries its own evidence mode: the execute step is LIVE only when the owner's live record
 * (`./alz apply record-live`) covers this exact apply evidence, and every other stage is SYNTHETIC until an attestation
 * form exists for it; the report's mode is derived from the stages, so with the owner's record it is MIXED, and LIVE only
 * once every stage has an attestation. A fake engine and a fake cloud write the same records as real ones, and only a
 * person's attestation tells them apart.
 *
 * Identifiers and hashes only: no state value, cloud property, approval signature or engine output.
 */
export const LIFECYCLE_REPORT_VERSION = 1;
export type StageStatus = "PASS" | "FAIL" | "NOT_RUN" | "INCONCLUSIVE";
export type EvidenceMode = "SYNTHETIC" | "LIVE";
/**
 * One stage's result and the mode of the evidence behind it. A stage is LIVE only when the owner attested that very
 * record from the real account (`./alz apply record-live` attests the execute step's apply evidence; no attestation exists
 * yet for the other stages, so they are SYNTHETIC whatever the execute step says).
 */
export type StageResult = { status: StageStatus; mode: EvidenceMode; detail: string; evidenceSha256?: string; at?: string };
export type LifecycleStages = { execute: StageResult; observe: StageResult; propose: StageResult; cleanup: StageResult; leftovers: StageResult };

export type LifecycleReport = {
  schemaVersion: 1;
  reportKind: "ACT_LIFECYCLE";
  gateVersion: typeof LIFECYCLE_REPORT_VERSION;
  /** The release gate this report is for (src/qualification/release-admission.ts `actGateId`). */
  gateId: string;
  provider: ProviderId;
  engine: EngineId;
  scenario: "pilot-apply-observe-cleanup";
  /** Derived from the stages: LIVE when every stage is LIVE, MIXED when some are, SYNTHETIC when none is. Never a caller's claim. */
  mode: "SYNTHETIC" | "MIXED" | "LIVE";
  sourceCommit: string;
  contractSha256: string;
  environment: ApplyEnvironment;
  target: ResolvedTarget;
  artifactSha256: string;
  applyEvidenceSha256: string;
  proposalSha256: string | null;
  stages: LifecycleStages;
  approvals: { apply: string[]; cleanup: string[] };
  observation: { verdict: string; resources: { address: string; type: string; identifier: string | null; result: string }[] } | null;
  dispositions: { disposition: "COMPLETE" | "KNOWN_ADDRESSES_CONFIRMED" | "INCOMPLETE"; resources: { address: string; disposition: string; basis: string }[] } | null;
  /** Derived: every stage PASS. Never set by a caller. */
  passed: boolean;
  /** What stands between this run and a pass, in sentences. */
  unresolved: string[];
  liveAttestation: { attestedBy: string; attestedAt: string; evidenceSha256: string } | null;
  generatedAt: string;
};

export type LifecycleReportInput = {
  gateId: string;
  provider: ProviderId;
  engine: EngineId;
  applyEvidence: ApplyEvidence;
  observation: ObservationRecord | undefined;
  proposal: CleanupProposal | undefined;
  cleanup: CleanupEvidence | undefined;
  leftovers: LeftoversRecord | undefined;
  /** The owner's live record for this run, when one exists. */
  live: LiveAcceptanceRecord | undefined;
  now: Date;
};

const hashOf = (value: unknown): string => sha256(canonicalJson(value as never));

function stagesOf(input: LifecycleReportInput, applyEvidenceSha256: string): { stages: LifecycleStages; unresolved: string[] } {
  const { applyEvidence, observation, proposal, cleanup, leftovers } = input;
  const unresolved: string[] = [];
  const executeMode: EvidenceMode = liveRecordFor(input, applyEvidenceSha256) ? "LIVE" : "SYNTHETIC";
  const execute: StageResult = applyEvidence.outcome === "SUCCEEDED"
    ? { status: "PASS", mode: executeMode, detail: "the apply succeeded and its evidence is recorded", evidenceSha256: applyEvidenceSha256, at: applyEvidence.finishedAt }
    : { status: "FAIL", mode: executeMode, detail: "the apply ended " + applyEvidence.outcome, evidenceSha256: applyEvidenceSha256, at: applyEvidence.finishedAt };
  if (execute.status !== "PASS") unresolved.push("the apply did not succeed");
  let observe: StageResult;
  if (!observation) { observe = { status: "NOT_RUN", mode: "SYNTHETIC", detail: "the run has not been observed" }; unresolved.push("observe the run"); }
  else if (observation.verdict === "VERIFIED" || observation.verdict === "PARTIAL") observe = { status: "PASS", mode: "SYNTHETIC", detail: "independent observation " + observation.verdict + " (" + observation.inventory + " inventory)", evidenceSha256: hashOf(observation), at: observation.observedAt };
  else if (observation.verdict === "FAILED") { observe = { status: "FAIL", mode: "SYNTHETIC", detail: "independent observation FAILED", evidenceSha256: hashOf(observation), at: observation.observedAt }; unresolved.push("a planned resource is missing or something unexpected was found"); }
  else { observe = { status: "INCONCLUSIVE", mode: "SYNTHETIC", detail: "independent observation could not decide", evidenceSha256: hashOf(observation), at: observation.observedAt }; unresolved.push("observe again until every resource is decided"); }
  let propose: StageResult;
  if (!proposal) { propose = { status: "NOT_RUN", mode: "SYNTHETIC", detail: "no cleanup proposal" }; unresolved.push("propose the cleanup"); }
  else if (proposal.artifactSha256 !== applyEvidence.artifactSha256 || proposal.applyEvidenceSha256 !== applyEvidenceSha256) { propose = { status: "FAIL", mode: "SYNTHETIC", detail: "the proposal is not this run's" }; unresolved.push("the proposal belongs to another run"); }
  else propose = { status: "PASS", mode: "SYNTHETIC", detail: proposal.deletes.length + " deletion(s) proposed, " + proposal.excluded.length + " kept", evidenceSha256: proposal.proposalSha256, at: proposal.createdAt };
  let cleanupStage: StageResult;
  if (!proposal) cleanupStage = { status: "NOT_RUN", mode: "SYNTHETIC", detail: "no proposal to execute" };
  else if (proposal.deletes.length === 0) cleanupStage = { status: "PASS", mode: "SYNTHETIC", detail: "nothing to destroy: every created resource was already gone", at: proposal.createdAt };
  else if (!cleanup) { cleanupStage = { status: "NOT_RUN", mode: "SYNTHETIC", detail: "the cleanup has not run" }; unresolved.push("run the approved cleanup"); }
  else if (cleanup.proposalSha256 !== proposal.proposalSha256) { cleanupStage = { status: "FAIL", mode: "SYNTHETIC", detail: "the cleanup evidence is for another proposal", evidenceSha256: hashOf(cleanup) }; unresolved.push("the cleanup evidence belongs to another proposal"); }
  else if (cleanup.outcome === "SUCCEEDED") cleanupStage = { status: "PASS", mode: "SYNTHETIC", detail: "the cleanup destroyed the approved list as " + cleanup.authority.executedAs, evidenceSha256: hashOf(cleanup), at: cleanup.finishedAt };
  else { cleanupStage = { status: "FAIL", mode: "SYNTHETIC", detail: "the cleanup ended " + cleanup.outcome, evidenceSha256: hashOf(cleanup), at: cleanup.finishedAt }; unresolved.push("the cleanup did not succeed; a person reviews"); }
  let leftoversStage: StageResult;
  if (!proposal) leftoversStage = { status: "NOT_RUN", mode: "SYNTHETIC", detail: "no proposal to verify" };
  else if (!leftovers || leftovers.proposalSha256 !== proposal.proposalSha256) { leftoversStage = { status: "NOT_RUN", mode: "SYNTHETIC", detail: "leftovers not verified for this proposal" }; unresolved.push("verify leftovers"); }
  else if (leftovers.disposition === "COMPLETE") leftoversStage = { status: "PASS", mode: "SYNTHETIC", detail: "every proposed deletion confirmed gone by independent read, and a complete sweep by the run's deletion-unit tag found nothing else", evidenceSha256: hashOf(leftovers), at: leftovers.observedAt };
  else if (leftovers.disposition === "KNOWN_ADDRESSES_CONFIRMED") {
    // The named resources are settled, but nothing outside the state could be searched for: not completion, and the gap is named.
    leftoversStage = { status: "INCONCLUSIVE", mode: "SYNTHETIC", detail: "every proposed deletion confirmed gone by address; no deletion-unit sweep was possible (the run carries no unit tag), so the cleanup is not independently complete", evidenceSha256: hashOf(leftovers), at: leftovers.observedAt };
    unresolved.push("a complete sweep by the run's deletion-unit tag is needed for completion; this run carries none, so a person confirms by hand that nothing else of it remains");
  }
  else { leftoversStage = { status: "INCONCLUSIVE", mode: "SYNTHETIC", detail: "leftover check INCOMPLETE", evidenceSha256: hashOf(leftovers), at: leftovers.observedAt }; unresolved.push(leftovers.nextAction); }
  return { stages: { execute, observe, propose, cleanup: cleanupStage, leftovers: leftoversStage }, unresolved };
}

/** The owner's live record, only when it attests this very apply evidence of this very artifact for the execute step. */
function liveRecordFor(input: LifecycleReportInput, applyEvidenceSha256: string): LiveAcceptanceRecord | undefined {
  const live = input.live;
  return live && live.label === "LIVE" && live.step === "execute" && live.evidenceSha256 === applyEvidenceSha256 && live.artifactSha256 === input.applyEvidence.artifactSha256 ? live : undefined;
}

/** The report's mode from its stages: every stage LIVE, some, or none. */
export function modeOfStages(stages: LifecycleStages): LifecycleReport["mode"] {
  const modes = Object.values(stages).map((stage) => stage.mode);
  return modes.every((mode) => mode === "LIVE") ? "LIVE" : modes.some((mode) => mode === "LIVE") ? "MIXED" : "SYNTHETIC";
}

/** Builds the report from the records. It writes nothing; the CLI stores what it returns. */
export function buildLifecycleReport(input: LifecycleReportInput): LifecycleReport {
  const applyEvidenceSha256 = hashOf(input.applyEvidence);
  const { stages, unresolved } = stagesOf(input, applyEvidenceSha256);
  const live = liveRecordFor(input, applyEvidenceSha256);
  const passed = Object.values(stages).every((stage) => stage.status === "PASS");
  return {
    schemaVersion: 1, reportKind: "ACT_LIFECYCLE", gateVersion: LIFECYCLE_REPORT_VERSION, gateId: input.gateId, provider: input.provider, engine: input.engine, scenario: "pilot-apply-observe-cleanup",
    mode: modeOfStages(stages), sourceCommit: input.applyEvidence.sourceCommit, contractSha256: input.applyEvidence.contractSha256, environment: input.applyEvidence.environment,
    target: { ...input.applyEvidence.target }, artifactSha256: input.applyEvidence.artifactSha256, applyEvidenceSha256, proposalSha256: input.proposal?.proposalSha256 ?? null, stages,
    approvals: { apply: input.applyEvidence.approvals.map((a) => a.approverId), cleanup: input.cleanup?.approvals.map((a) => a.approverId) ?? [] },
    observation: input.observation ? { verdict: input.observation.verdict, resources: input.observation.resources.map((r) => ({ address: r.address, type: r.type, identifier: r.identifier, result: r.result })) } : null,
    dispositions: input.leftovers ? { disposition: input.leftovers.disposition, resources: input.leftovers.resources.map((r) => ({ address: r.address, disposition: r.disposition, basis: r.basis })) } : null,
    passed, unresolved: [...new Set(unresolved)], liveAttestation: live ? { attestedBy: live.attestedBy, attestedAt: live.attestedAt, evidenceSha256: live.evidenceSha256 } : null,
    generatedAt: input.now.toISOString(),
  };
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const hashText = (value: unknown): value is string => typeof value === "string" && HASH.test(value);
const STATUSES: readonly StageStatus[] = ["PASS", "FAIL", "NOT_RUN", "INCONCLUSIVE"];
const KEYS = ["schemaVersion", "reportKind", "gateVersion", "gateId", "provider", "engine", "scenario", "mode", "sourceCommit", "contractSha256", "environment", "target", "artifactSha256",
  "applyEvidenceSha256", "proposalSha256", "stages", "approvals", "observation", "dispositions", "passed", "unresolved", "liveAttestation", "generatedAt"];
const RAW_KEY = /^(values|attributes|properties|state|plan|stdout|stderr|output|credentials|secret|token|password|signature)$/i;

function stageOk(value: unknown): value is StageResult {
  return isRecord(value) && Object.keys(value).every((key) => ["status", "mode", "detail", "evidenceSha256", "at"].includes(key)) && STATUSES.includes(value.status as StageStatus) &&
    (value.mode === "SYNTHETIC" || value.mode === "LIVE") &&
    typeof value.detail === "string" && (value.evidenceSha256 === undefined || hashText(value.evidenceSha256)) && (value.at === undefined || typeof value.at === "string");
}

/**
 * Every reason a document is not a valid lifecycle report. Empty means it is. Checks the shape, that `passed` is exactly
 * what the stages derive (a caller's declaration never counts), that the mode is what the stages' evidence modes derive,
 * that only the execute step can be LIVE and only with the owner's attestation of this very apply evidence, that a PASS leaves nothing unresolved, and, when the caller knows them,
 * that the report is for the expected source commit and gate.
 */
export function lifecycleReportProblems(value: unknown, expected: { sourceCommit?: string; gateId?: string } = {}): string[] {
  if (!isRecord(value)) return ["report: expected an object"];
  const problems: string[] = [];
  for (const key of Object.keys(value)) if (!KEYS.includes(key)) problems.push("report." + key + (RAW_KEY.test(key) ? ": raw state, output or secret field" : ": not part of the report"));
  for (const key of KEYS) if (!Object.hasOwn(value, key)) problems.push("report." + key + ": missing");
  if (problems.length > 0) return problems;
  if (value.schemaVersion !== 1 || value.reportKind !== "ACT_LIFECYCLE" || value.gateVersion !== LIFECYCLE_REPORT_VERSION) problems.push("report: not a schemaVersion 1 ACT_LIFECYCLE report of gate version " + LIFECYCLE_REPORT_VERSION);
  if (typeof value.gateId !== "string" || !/^act:[a-z]+-[a-z]+$/.test(value.gateId)) problems.push("report.gateId: not an ACT gate id");
  if (!["AWS", "AZURE"].includes(value.provider as string) || !["TERRAFORM", "CDK"].includes(value.engine as string) || value.scenario !== "pilot-apply-observe-cleanup") problems.push("report: provider, engine or scenario is unknown");
  if (value.gateId === "act:" + String(value.provider).toLowerCase() + "-" + String(value.engine).toLowerCase() === false) problems.push("report.gateId: does not name the report's provider and engine");
  if (value.mode !== "SYNTHETIC" && value.mode !== "MIXED" && value.mode !== "LIVE") problems.push("report.mode: SYNTHETIC, MIXED or LIVE");
  if (typeof value.sourceCommit !== "string" || !COMMIT.test(value.sourceCommit)) problems.push("report.sourceCommit: not a commit id");
  if (expected.sourceCommit !== undefined && value.sourceCommit !== expected.sourceCommit) problems.push("report.sourceCommit: not the expected source commit");
  if (expected.gateId !== undefined && value.gateId !== expected.gateId) problems.push("report.gateId: not the expected gate");
  if (!hashText(value.contractSha256) || !hashText(value.artifactSha256) || !hashText(value.applyEvidenceSha256)) problems.push("report: a hash is not a SHA-256 digest");
  if (value.proposalSha256 !== null && !hashText(value.proposalSha256)) problems.push("report.proposalSha256: malformed");
  if (!["DEV", "QA", "PROD"].includes(value.environment as string)) problems.push("report.environment: unknown");
  const target = value.target;
  if (!isRecord(target) || Object.keys(target).sort().join() !== "account,backend,workspace" || !["account", "backend", "workspace"].every((key) => typeof target[key] === "string" && target[key] !== "")) problems.push("report.target: malformed");
  const stages = value.stages;
  if (!isRecord(stages) || Object.keys(stages).sort().join() !== "cleanup,execute,leftovers,observe,propose" || !Object.values(stages).every(stageOk)) problems.push("report.stages: five stages, each with a status, an evidence mode and a detail");
  else {
    const typed = stages as unknown as LifecycleStages;
    if (value.mode !== modeOfStages(typed)) problems.push("report.mode: not derived from the stages' evidence modes (a declaration never counts)");
    // Only the execute step has a live attestation form today; every other stage is synthetic until the owner can attest it.
    for (const name of ["observe", "propose", "cleanup", "leftovers"] as const) {
      if (typed[name].mode === "LIVE") problems.push("report.stages." + name + ": no owner attestation exists for this stage, so it cannot be LIVE");
    }
    const attested = isRecord(value.liveAttestation);
    if (typed.execute.mode === "LIVE" && !attested) problems.push("report.stages.execute: LIVE needs the owner's attestation");
    if (typed.execute.mode === "SYNTHETIC" && attested) problems.push("report.stages.execute: a SYNTHETIC execute step carries no live attestation");
    const derived = Object.values(stages).every((stage) => (stage as StageResult).status === "PASS");
    if (value.passed !== derived) problems.push("report.passed: not derived from the stages (a declaration never counts)");
    if (derived && Array.isArray(value.unresolved) && value.unresolved.length > 0) problems.push("report: a pass leaves nothing unresolved");
    if (!derived && Array.isArray(value.unresolved) && value.unresolved.length === 0) problems.push("report: a report that did not pass says what is unresolved");
    const cleanup = (stages as Record<string, StageResult>).cleanup;
    const leftovers = (stages as Record<string, StageResult>).leftovers;
    if (cleanup.status === "PASS" && leftovers.status !== "PASS" && value.passed === true) problems.push("report: a cleanup is not complete while leftovers are pending or unknown");
  }
  const approvals = value.approvals;
  if (!isRecord(approvals) || !Array.isArray(approvals.apply) || !Array.isArray(approvals.cleanup) || ![...approvals.apply, ...approvals.cleanup].every((x) => typeof x === "string" && x.length > 0)) problems.push("report.approvals: approver ids only");
  if (value.observation !== null && (!isRecord(value.observation) || typeof value.observation.verdict !== "string" || !Array.isArray(value.observation.resources) ||
    !value.observation.resources.every((r) => isRecord(r) && Object.keys(r).sort().join() === "address,identifier,result,type"))) problems.push("report.observation: verdict and resources with address, type, identifier and result only");
  if (value.dispositions !== null && (!isRecord(value.dispositions) || !["COMPLETE", "KNOWN_ADDRESSES_CONFIRMED", "INCOMPLETE"].includes(value.dispositions.disposition as string) || !Array.isArray(value.dispositions.resources) ||
    !value.dispositions.resources.every((r) => isRecord(r) && Object.keys(r).sort().join() === "address,basis,disposition"))) problems.push("report.dispositions: a disposition and resources with address, disposition and basis only");
  if (!Array.isArray(value.unresolved) || !value.unresolved.every((x) => typeof x === "string")) problems.push("report.unresolved: sentences");
  const live = value.liveAttestation;
  if (value.mode !== "SYNTHETIC" && (!isRecord(live) || typeof live.attestedBy !== "string" || live.attestedBy === "" || typeof live.attestedAt !== "string" || live.evidenceSha256 !== value.applyEvidenceSha256)) {
    problems.push("report: LIVE needs the owner's attestation of this very apply evidence; synthetic records never pass as live");
  }
  if (live !== null && (!isRecord(live) || live.evidenceSha256 !== value.applyEvidenceSha256)) problems.push("report.liveAttestation: not of this very apply evidence");
  if (value.mode === "SYNTHETIC" && live !== null) problems.push("report: a SYNTHETIC report carries no live attestation");
  if (typeof value.generatedAt !== "string" || Number.isNaN(Date.parse(value.generatedAt))) problems.push("report.generatedAt: malformed");
  return problems;
}
