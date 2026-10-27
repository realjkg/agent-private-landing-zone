import { canonicalJson } from "../teardown/manifest.js";
import { sha256 } from "../util/sha256.js";
import { COMMIT } from "./constants.js";
import { pilotContractSha256 } from "./contract.js";
import { engineOf } from "./engine-spec.js";
import { specOf } from "./provider.js";
import { RECOVERY_CONDITION_REASONS, RECOVERY_EVIDENCE_VERSION, RECOVERY_GATE_ID, recoveryConditionsOf, type CitedApply, type RecoveryConditions, type RecoveryGateEvidence } from "../qualification/recovery-gate.js";
import type { ApplyEvidence, PilotContract } from "./types.js";

/**
 * The product-owned producer of the `act-run-recovery` release gate's evidence (src/qualification/release-admission.ts, mode
 * ACT_RECOVERY; the contract in src/qualification/recovery-gate.ts), following `record-live`: it reads the interrupted apply's
 * evidence and the evidence of the apply that followed it from the encrypted ledger, derives the gate's fields from those
 * records and the pinned contract, and writes identifiers, hashes and times only, after the person who ran them attests.
 * Nothing is taken as typed input but the attestation and the host name; a run that does not show a recovery is refused by
 * name and nothing is written, so no SYNTHETIC recovery record exists to relabel. It starts no engine and reads no cloud.
 */
export { RECOVERY_GATE_ID, recoveryGateEvidenceProblems, type RecoveryGateEvidence } from "../qualification/recovery-gate.js";
export type RecoveryRecordInput = {
  /** The interrupted apply's evidence, read from the ledger. */
  interrupted: ApplyEvidence;
  /** The evidence of the apply that followed, read from the ledger. */
  resumed: ApplyEvidence;
  contract: PilotContract;
  /** The product commit this producer runs from, or undefined when it could not be established. */
  sourceCommit: string | undefined;
  targetHardwareId: string;
  attestedBy: string;
  now: Date;
};
export type RecoveryRecordRefusal = { ok: false; code: "RECOVERY_NOT_INTERRUPTED" | "RECOVERY_RESUME_MISMATCH" | "RECOVERY_APPROVAL_REUSED" | "CONTRACT_MISMATCH" | "SOURCE_CHANGED"; message: string };

/** The apply evidence as the record cites it: identifiers, hashes and times only. */
export function citeApply(evidence: ApplyEvidence): CitedApply {
  return {
    artifactSha256: evidence.artifactSha256, evidenceSha256: sha256(canonicalJson(evidence as never)), outcome: evidence.outcome, environment: evidence.environment,
    target: { ...evidence.target }, contractSha256: evidence.contractSha256, sourceCommit: evidence.sourceCommit, startedAt: evidence.startedAt, finishedAt: evidence.finishedAt,
    approvals: evidence.approvals.map((approval) => ({ approverId: approval.approverId, issuedAt: approval.issuedAt })),
    recovery: evidence.recovery ? { files: evidence.recovery.files, sha256: evidence.recovery.sha256 } : null,
  };
}

const NOTHING = " Nothing was written.";

/** Builds the gate evidence from the two ledger records, or says by name why they do not show a recovery. */
export function buildRecoveryEvidence(input: RecoveryRecordInput): { ok: true; evidence: RecoveryGateEvidence } | RecoveryRecordRefusal {
  const { contract } = input;
  const contractSha256 = pilotContractSha256(contract);
  if (input.interrupted.contractSha256 !== contractSha256) return { ok: false, code: "CONTRACT_MISMATCH", message: "The interrupted apply ran under another pilot contract than the one pinned now." + NOTHING };
  if (input.sourceCommit === undefined || !COMMIT.test(input.sourceCommit)) return { ok: false, code: "SOURCE_CHANGED", message: "The product source commit could not be established, so the record cannot be bound to the candidate." + NOTHING };
  if (input.interrupted.sourceCommit !== input.sourceCommit || input.resumed.sourceCommit !== input.sourceCommit) {
    return { ok: false, code: "SOURCE_CHANGED", message: "The interrupted apply or the apply that followed ran from another product commit than this one; a recovery record is bound to the candidate commit both ran on." + NOTHING };
  }
  const interrupted = citeApply(input.interrupted);
  const resumed = citeApply(input.resumed);
  const requiredApprovals = contract.requiredApprovals[interrupted.environment] ?? contract.requiredApprovals.DEV;
  const conditions = recoveryConditionsOf(interrupted, resumed, requiredApprovals);
  const refusal = (code: RecoveryRecordRefusal["code"], keys: (keyof RecoveryConditions)[]): RecoveryRecordRefusal | undefined => {
    const failed = keys.filter((key) => !conditions[key]);
    return failed.length === 0 ? undefined : { ok: false, code, message: failed.map((key) => RECOVERY_CONDITION_REASONS[key]).join("; ") + "." + NOTHING };
  };
  const problem = refusal("RECOVERY_NOT_INTERRUPTED", ["interruptedRecordedInLedger", "outcomeInterrupted"]) ??
    refusal("RECOVERY_RESUME_MISMATCH", ["resumedDistinctArtifact", "resumedSameTarget", "resumedSucceeded"]) ??
    refusal("RECOVERY_APPROVAL_REUSED", ["resumedApprovalsIssuedAfterInterruption", "resumedApprovalsSufficient"]);
  if (problem) return problem;
  const evidence: RecoveryGateEvidence = {
    schemaVersion: 1, reportKind: "ACT_RECOVERY", gateVersion: RECOVERY_EVIDENCE_VERSION, gateId: RECOVERY_GATE_ID, executionMode: "ACT_RECOVERY", label: "LIVE", passed: true,
    actEnabled: true, authority: "PILOT_ENABLED", cloud: specOf(contract).id, engine: engineOf(contract).id, environment: interrupted.environment, target: { ...interrupted.target },
    contractSha256, sourceCommit: input.sourceCommit, targetHardwareId: input.targetHardwareId, interrupted, resumed, requiredApprovals,
    interruptedArtifactSha256: interrupted.artifactSha256, interruptedOutcome: interrupted.outcome as "PARTIAL_REQUIRES_REVIEW" | "KILLED", reconciledFromLedger: true, resumedWithoutApproval: false,
    conditions, attestation: { attestedBy: input.attestedBy, attestedAt: input.now.toISOString() },
    checks: [
      { name: "interrupted-apply-evidence", passed: true, evidenceSha256: interrupted.evidenceSha256 },
      { name: "resumed-apply-evidence", passed: true, evidenceSha256: resumed.evidenceSha256 },
      { name: "pilot-contract", passed: true, evidenceSha256: contractSha256 },
    ],
    generatedAt: input.now.toISOString(),
  };
  return { ok: true, evidence };
}

/** The admission manifest record for one written evidence file (src/qualification/release-admission.ts `ReleaseGateSubmission`). */
export function recoveryAdmissionRecordOf(evidence: RecoveryGateEvidence, evidencePath: string, bytes: string): { id: string; mode: "ACT_RECOVERY"; sourceCommit: string; targetHardwareId: string; evidencePath: string; evidenceSha256: string } {
  return { id: evidence.gateId, mode: "ACT_RECOVERY", sourceCommit: evidence.sourceCommit, targetHardwareId: evidence.targetHardwareId, evidencePath, evidenceSha256: sha256(Buffer.from(bytes)) };
}
