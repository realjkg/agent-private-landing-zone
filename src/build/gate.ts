import type {
  BuildCandidate,
  BuildGateDecision,
} from "./types.js";
import {
  approvalMatchesArtifact,
  evidenceComplete,
} from "./provenance.js";

const BLOCKING_SEVERITIES = new Set([
  "HIGH",
  "CRITICAL",
]);

export function evaluateBuildGate(
  candidate: BuildCandidate,
  requireApproval = true,
): BuildGateDecision {
  const reasons: string[] = [];

  if (candidate.environment.classification === "UNKNOWN") {
    reasons.push("Environment classification is UNKNOWN.");
  }

  if (
    candidate.environment.safeBuildMode === "READ_ONLY" ||
    candidate.environment.safeBuildMode === "BLOCKED"
  ) {
    reasons.push(
      `Safe build mode is ${candidate.environment.safeBuildMode}.`,
    );
  }

  if (!evidenceComplete(candidate.evidence)) {
    reasons.push("Build evidence is incomplete.");
  }

  const failedScanners = candidate.evidence.scannerResults.filter(
    (result) => !result.passed,
  );

  if (failedScanners.length > 0) {
    reasons.push(
      `Static/policy validation failed: ${failedScanners
        .map((result) => result.scanner)
        .join(", ")}.`,
    );
  }

  const blockingFindings =
    candidate.evidence.scannerResults.flatMap((result) =>
      result.findings.filter((finding) =>
        BLOCKING_SEVERITIES.has(finding.severity),
      ),
    );

  if (blockingFindings.length > 0) {
    reasons.push(
      `Blocking findings remain: ${blockingFindings.length}.`,
    );
  }

  if (candidate.repairAttempt > candidate.maxRepairAttempts) {
    reasons.push("Maximum repair attempts exceeded.");
  }

  if (
    candidate.artifact.provider !==
    candidate.environment.provider
  ) {
    reasons.push(
      "Artifact provider does not match discovered environment.",
    );
  }

  if (
    candidate.environment.classification === "BROWNFIELD" &&
    candidate.environment.safeBuildMode !== "ADDITIVE_ONLY"
  ) {
    reasons.push(
      "Brownfield builds must remain ADDITIVE_ONLY at this stage.",
    );
  }

  if (
    candidate.environment.resources.some(
      (resource) =>
        resource.mutationPolicy === "DELETE_ALLOWED",
    )
  ) {
    reasons.push(
      "Discovery state contains forbidden DELETE_ALLOWED authority.",
    );
  }

  if (
    requireApproval &&
    !approvalMatchesArtifact(
      candidate.artifact,
      candidate.evidence,
    )
  ) {
    reasons.push(
      "Human approval is missing or does not match the exact artifact hash.",
    );
  }

  return {
    allowed: reasons.length === 0,
    reasons,
  };
}
