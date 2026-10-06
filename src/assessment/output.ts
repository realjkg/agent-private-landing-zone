import type {
  DiscoveryAssessment,
} from "./types.js";
import {
  writeEncryptedEvidence,
} from "../evidence/vault.js";

export async function writeAssessmentRun(
  assessment: DiscoveryAssessment,
): Promise<string> {
  const filename =
    assessment.assessedAt
      .replace(/[:.]/g, "-") +
    "-" +
    assessment.assessmentId;

  return writeEncryptedEvidence(
    "assessment",
    filename,
    assessment,
  );
}

export function formatAssessmentSummary(
  assessment: DiscoveryAssessment,
): string[] {
  const highOrCritical =
    assessment.findings.filter(
      (finding) =>
        finding.severity === "HIGH" ||
        finding.severity === "CRITICAL",
    ).length;

  return [
    "Assessment",
    "  Security       " +
      assessment.securityStatus,
    "  Findings       " +
      assessment.findings.length +
      " total / " +
      highOrCritical +
      " high-or-critical",
    "  SBOM           " +
      assessment.sbom.status +
      " / " +
      assessment.sbom.componentCount +
      " components",
    "  Resiliency     " +
      assessment.resiliency.status,
    "  Config backup  " +
      assessment.resiliency.configurationBackup,
    "  Restore proof  " +
      assessment.resiliency.restoreEvidence,
    "  Recovery scope " +
      assessment.recoverySnapshot.coverage,
    "  Recovery hash  " +
      assessment.recoverySnapshot.configurationHash.slice(
        0,
        16,
      ) +
      "…",
  ];
}
