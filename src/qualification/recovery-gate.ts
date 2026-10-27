import type { ApplyEnvironment, ApplyEvidence, ApplyOutcome } from "../apply/types.js";
import { COMMIT, HASH } from "../apply/constants.js";

/**
 * The `act-run-recovery` release gate's contract (mode ACT_RECOVERY), shared by the producer (src/apply/recovery-record.ts,
 * `./alz apply record-recovery`) and the admission review (src/qualification/release-admission.ts): what the gate is about,
 * the shape of its evidence, and the validator that recomputes every derived field from the evidence's own inputs. One
 * module, so the review enforces exactly what the producer promises and neither imports the other.
 *
 * The gate: an interrupted real pilot apply, reconciled from its ledger, never resumed without new approval. The producer
 * reads two apply evidences from the encrypted ledger: the interrupted one (outcome PARTIAL_REQUIRES_REVIEW or KILLED, the
 * ledger's own record of how the run ended) and the apply that followed it (a new artifact, under the same contract, target
 * and environment, that SUCCEEDED with approvals issued after the interruption, since a reserved artifact is never applied
 * again and an approval is consumed once). The four fields the gate asks for are derived from those records, never typed.
 */
export const RECOVERY_GATE_ID = "act-run-recovery";
export const RECOVERY_EVIDENCE_VERSION = 1;
/** The outcomes that are an interruption: the engine ran and did not finish cleanly, and the ledger holds the evidence. */
export const INTERRUPTED_OUTCOMES: readonly ApplyOutcome[] = ["PARTIAL_REQUIRES_REVIEW", "KILLED"];

/** Each condition, derived from the two ledger evidences and the contract; the gate passes only when every one holds. */
export type RecoveryConditions = {
  /** The interrupted run's evidence is in the ledger as finished evidence, so its outcome is the ledger's, not a person's. */
  interruptedRecordedInLedger: boolean;
  /** The interrupted run ended PARTIAL_REQUIRES_REVIEW or KILLED. */
  outcomeInterrupted: boolean;
  /** The apply that followed is another sealed artifact: the interrupted one was never applied again. */
  resumedDistinctArtifact: boolean;
  /** The apply that followed ran under the same contract, environment and target as the interrupted one. */
  resumedSameTarget: boolean;
  /** The apply that followed SUCCEEDED. */
  resumedSucceeded: boolean;
  /** Every approval the apply that followed consumed was issued after the interruption ended: no approval carried over. */
  resumedApprovalsIssuedAfterInterruption: boolean;
  /** The apply that followed consumed at least the contract's required number of distinct approvals for the environment. */
  resumedApprovalsSufficient: boolean;
};
export const RECOVERY_CONDITION_REASONS: Readonly<Record<keyof RecoveryConditions, string>> = {
  interruptedRecordedInLedger: "the interrupted run has no finished evidence in the ledger",
  outcomeInterrupted: "the first run was not interrupted (its outcome is not PARTIAL_REQUIRES_REVIEW or KILLED), so there is nothing to recover from",
  resumedDistinctArtifact: "the apply that followed names the interrupted artifact itself; a reserved artifact is never applied again",
  resumedSameTarget: "the apply that followed ran under another contract, environment or target than the interrupted one",
  resumedSucceeded: "the apply that followed did not succeed",
  resumedApprovalsIssuedAfterInterruption: "an approval the apply that followed consumed was issued before the interruption ended: the resume carried an approval over",
  resumedApprovalsSufficient: "the apply that followed consumed fewer distinct approvals than the contract requires for the environment",
};

/** One apply evidence as the record cites it: identifiers, hashes and times only, never a value. */
export type CitedApply = {
  artifactSha256: string;
  /** The canonical sha256 of the apply evidence read from the ledger. */
  evidenceSha256: string;
  outcome: ApplyOutcome;
  environment: ApplyEnvironment;
  target: ApplyEvidence["target"];
  contractSha256: string;
  sourceCommit: string;
  startedAt: string;
  finishedAt: string;
  approvals: { approverId: string; issuedAt: string }[];
  /** The interrupted run's recovery files (errored state, crash log), by count and hash, when the engine left any. */
  recovery: { files: number; sha256: string } | null;
};

export type RecoveryGateEvidence = {
  schemaVersion: 1;
  reportKind: "ACT_RECOVERY";
  gateVersion: typeof RECOVERY_EVIDENCE_VERSION;
  gateId: typeof RECOVERY_GATE_ID;
  executionMode: "ACT_RECOVERY";
  /** A recovery record is made only when every condition holds; otherwise nothing is written. Derived, never a caller's claim. */
  label: "LIVE";
  passed: true;
  /** A pilot apply ran: this is the one gate whose report says ACT was enabled, under the pilot contract. */
  actEnabled: true;
  authority: "PILOT_ENABLED";
  cloud: string;
  engine: string;
  environment: ApplyEnvironment;
  target: ApplyEvidence["target"];
  contractSha256: string;
  sourceCommit: string;
  targetHardwareId: string;
  interrupted: CitedApply;
  resumed: CitedApply;
  /** The contract's required approvals for the environment, as the resume had to meet them. */
  requiredApprovals: number;
  /** The gate's four fields (src/qualification/release-admission.ts), each derived from the cited records above. */
  interruptedArtifactSha256: string;
  interruptedOutcome: "PARTIAL_REQUIRES_REVIEW" | "KILLED";
  reconciledFromLedger: true;
  resumedWithoutApproval: false;
  conditions: RecoveryConditions;
  attestation: { attestedBy: string; attestedAt: string };
  checks: { name: string; passed: true; evidenceSha256: string }[];
  generatedAt: string;
};

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const hashText = (value: unknown): value is string => typeof value === "string" && HASH.test(value);
const isoText = (value: unknown): value is string => typeof value === "string" && !Number.isNaN(Date.parse(value));
const OUTCOMES: readonly string[] = ["SUCCEEDED", "FAILED_NO_CHANGE", "PARTIAL_REQUIRES_REVIEW", "KILLED"];
const KEYS = ["schemaVersion", "reportKind", "gateVersion", "gateId", "executionMode", "label", "passed", "actEnabled", "authority", "cloud", "engine", "environment", "target", "contractSha256",
  "sourceCommit", "targetHardwareId", "interrupted", "resumed", "requiredApprovals", "interruptedArtifactSha256", "interruptedOutcome", "reconciledFromLedger", "resumedWithoutApproval",
  "conditions", "attestation", "checks", "generatedAt"];
const CITED_KEYS = "approvals,artifactSha256,contractSha256,environment,evidenceSha256,finishedAt,outcome,recovery,sourceCommit,startedAt,target";
const CONDITIONS = Object.keys(RECOVERY_CONDITION_REASONS).sort().join();
const RAW_KEY = /^(values|attributes|properties|state|plan|stdout|stderr|output|credentials|secret|token|password|signature)$/i;

function citedProblems(value: unknown, label: string): string[] {
  if (!isRecord(value) || Object.keys(value).sort().join() !== CITED_KEYS) return ["recovery evidence." + label + ": exactly artifactSha256, evidenceSha256, outcome, environment, target, contractSha256, sourceCommit, startedAt, finishedAt, approvals and recovery"];
  const problems: string[] = [];
  if (!hashText(value.artifactSha256) || !hashText(value.evidenceSha256) || !hashText(value.contractSha256)) problems.push("recovery evidence." + label + ": a hash is not a SHA-256 digest");
  if (!OUTCOMES.includes(value.outcome as string)) problems.push("recovery evidence." + label + ".outcome: unknown");
  if (!["DEV", "QA", "PROD"].includes(value.environment as string)) problems.push("recovery evidence." + label + ".environment: unknown");
  const target = value.target;
  if (!isRecord(target) || Object.keys(target).sort().join() !== "account,backend,workspace" || !["account", "backend", "workspace"].every((key) => typeof target[key] === "string" && target[key] !== "")) problems.push("recovery evidence." + label + ".target: malformed");
  if (typeof value.sourceCommit !== "string" || !COMMIT.test(value.sourceCommit)) problems.push("recovery evidence." + label + ".sourceCommit: not a commit id");
  if (!isoText(value.startedAt) || !isoText(value.finishedAt)) problems.push("recovery evidence." + label + ": startedAt or finishedAt is malformed");
  if (!Array.isArray(value.approvals) || !value.approvals.every((a) => isRecord(a) && Object.keys(a).sort().join() === "approverId,issuedAt" && typeof a.approverId === "string" && a.approverId !== "" && isoText(a.issuedAt))) {
    problems.push("recovery evidence." + label + ".approvals: each an approverId and an issuedAt");
  }
  if (value.recovery !== null && (!isRecord(value.recovery) || Object.keys(value.recovery).sort().join() !== "files,sha256" || typeof value.recovery.files !== "number" || !Number.isInteger(value.recovery.files) || value.recovery.files < 1 || !hashText(value.recovery.sha256))) {
    problems.push("recovery evidence." + label + ".recovery: null, or a file count and a hash");
  }
  return problems;
}

/** The conditions as they follow from the cited records and the required approvals: the one derivation the producer and the validator share. */
export function recoveryConditionsOf(interrupted: CitedApply, resumed: CitedApply, requiredApprovals: number): RecoveryConditions {
  const ended = Date.parse(interrupted.finishedAt);
  return {
    interruptedRecordedInLedger: HASH.test(interrupted.evidenceSha256),
    outcomeInterrupted: INTERRUPTED_OUTCOMES.includes(interrupted.outcome),
    resumedDistinctArtifact: resumed.artifactSha256 !== interrupted.artifactSha256,
    resumedSameTarget: resumed.contractSha256 === interrupted.contractSha256 && resumed.environment === interrupted.environment &&
      resumed.target.account === interrupted.target.account && resumed.target.backend === interrupted.target.backend && resumed.target.workspace === interrupted.target.workspace,
    resumedSucceeded: resumed.outcome === "SUCCEEDED",
    resumedApprovalsIssuedAfterInterruption: resumed.approvals.length > 0 && resumed.approvals.every((approval) => Date.parse(approval.issuedAt) > ended) && Date.parse(resumed.startedAt) > ended,
    resumedApprovalsSufficient: new Set(resumed.approvals.map((approval) => approval.approverId)).size >= requiredApprovals && requiredApprovals >= 1,
  };
}

/**
 * Every reason a document is not valid recovery-gate evidence. Empty means it is. The conditions, the four gate fields, the
 * label and `passed` are recomputed from the cited records, so a hand-written document, or one relabeled over records that
 * do not show a recovery, is refused here and at admission alike.
 */
export function recoveryGateEvidenceProblems(value: unknown, expected: { sourceCommit?: string } = {}): string[] {
  if (!isRecord(value)) return ["recovery evidence: expected an object"];
  const problems: string[] = [];
  for (const key of Object.keys(value)) if (!KEYS.includes(key)) problems.push("recovery evidence." + key + (RAW_KEY.test(key) ? ": raw plan, output or secret field" : ": not part of the evidence"));
  for (const key of KEYS) if (!Object.hasOwn(value, key)) problems.push("recovery evidence." + key + ": missing");
  if (problems.length > 0) return problems;
  if (value.schemaVersion !== 1 || value.reportKind !== "ACT_RECOVERY" || value.gateVersion !== RECOVERY_EVIDENCE_VERSION || value.gateId !== RECOVERY_GATE_ID || value.executionMode !== "ACT_RECOVERY") {
    problems.push("recovery evidence: not a schemaVersion 1 ACT_RECOVERY document of gate " + RECOVERY_GATE_ID + ", version " + RECOVERY_EVIDENCE_VERSION);
  }
  if (value.actEnabled !== true || value.authority !== "PILOT_ENABLED") problems.push("recovery evidence: a recovery is of a pilot apply that ran (actEnabled true under PILOT_ENABLED)");
  if (typeof value.cloud !== "string" || value.cloud === "" || typeof value.engine !== "string" || value.engine === "") problems.push("recovery evidence: cloud or engine is malformed");
  if (typeof value.targetHardwareId !== "string" || value.targetHardwareId.trim() === "" || value.targetHardwareId === "UNKNOWN") problems.push("recovery evidence.targetHardwareId: the host is not named");
  if (typeof value.sourceCommit !== "string" || !COMMIT.test(value.sourceCommit)) problems.push("recovery evidence.sourceCommit: not a commit id");
  if (expected.sourceCommit !== undefined && value.sourceCommit !== expected.sourceCommit) problems.push("recovery evidence.sourceCommit: not the expected source commit");
  if (typeof value.requiredApprovals !== "number" || !Number.isInteger(value.requiredApprovals) || value.requiredApprovals < 1) problems.push("recovery evidence.requiredApprovals: a count of at least 1");
  const cited = [...citedProblems(value.interrupted, "interrupted"), ...citedProblems(value.resumed, "resumed")];
  problems.push(...cited);
  const attestation = value.attestation;
  if (!isRecord(attestation) || Object.keys(attestation).sort().join() !== "attestedAt,attestedBy" || typeof attestation.attestedBy !== "string" || attestation.attestedBy.trim() === "" || !isoText(attestation.attestedAt)) {
    problems.push("recovery evidence.attestation: a name and a time");
  }
  if (!Array.isArray(value.checks) || value.checks.length === 0 || !value.checks.every((c) => isRecord(c) && Object.keys(c).sort().join() === "evidenceSha256,name,passed" && typeof c.name === "string" && c.passed === true && hashText(c.evidenceSha256))) {
    problems.push("recovery evidence.checks: each names what it checked and the hash it rests on");
  }
  if (!isoText(value.generatedAt)) problems.push("recovery evidence.generatedAt: malformed");
  if (problems.length > 0) return problems;
  // Everything below is recomputed from the cited records: a declaration never counts.
  const interrupted = value.interrupted as CitedApply;
  const resumed = value.resumed as CitedApply;
  const conditions = recoveryConditionsOf(interrupted, resumed, value.requiredApprovals as number);
  const declared = value.conditions;
  if (!isRecord(declared) || Object.keys(declared).sort().join() !== CONDITIONS || (Object.keys(conditions) as (keyof RecoveryConditions)[]).some((key) => declared[key] !== conditions[key])) {
    problems.push("recovery evidence.conditions: not derived from the cited records (a declaration never counts)");
  }
  const failed = (Object.keys(conditions) as (keyof RecoveryConditions)[]).filter((key) => !conditions[key]);
  if (failed.length > 0) problems.push("recovery evidence: the cited records do not show a recovery (" + failed.map((key) => RECOVERY_CONDITION_REASONS[key]).join("; ") + ")");
  if (value.label !== "LIVE" || value.passed !== true) problems.push("recovery evidence: label LIVE and passed true are the only values a written record holds; anything else was not made by the producer");
  if (value.interruptedArtifactSha256 !== interrupted.artifactSha256) problems.push("recovery evidence.interruptedArtifactSha256: not the cited interrupted artifact");
  if (value.interruptedOutcome !== interrupted.outcome) problems.push("recovery evidence.interruptedOutcome: not the cited interrupted outcome");
  if (value.reconciledFromLedger !== (conditions.interruptedRecordedInLedger && conditions.outcomeInterrupted)) problems.push("recovery evidence.reconciledFromLedger: not derived from the cited records");
  if (value.resumedWithoutApproval !== !(conditions.resumedDistinctArtifact && conditions.resumedApprovalsIssuedAfterInterruption && conditions.resumedApprovalsSufficient)) problems.push("recovery evidence.resumedWithoutApproval: not derived from the cited records");
  if (value.environment !== interrupted.environment || value.contractSha256 !== interrupted.contractSha256 || !isRecord(value.target) ||
    JSON.stringify(value.target) !== JSON.stringify(interrupted.target) || value.sourceCommit !== resumed.sourceCommit || interrupted.sourceCommit !== resumed.sourceCommit) {
    problems.push("recovery evidence: environment, target, contract or source commit is not the cited records'");
  }
  const checks = value.checks as { name: string; evidenceSha256: string }[];
  const cites = (name: string, hash: string): boolean => checks.some((check) => check.name === name && check.evidenceSha256 === hash);
  if (!cites("interrupted-apply-evidence", interrupted.evidenceSha256) || !cites("resumed-apply-evidence", resumed.evidenceSha256) || !cites("pilot-contract", interrupted.contractSha256)) {
    problems.push("recovery evidence.checks: must cite the interrupted and resumed apply evidence and the pilot contract by hash");
  }
  return problems;
}
