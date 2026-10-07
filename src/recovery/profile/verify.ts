import type {
  RecoveryTargetSpec,
} from "../target.js";
import {
  hashRecoveryPolicyMetadata,
  hashRecoveryTargetContract,
} from "./compiler.js";

export type RecoveryProfileVerification = {
  valid: boolean;
  blockers: string[];
};

export function verifyCompiledRecoveryTarget(
  target: RecoveryTargetSpec,
): RecoveryProfileVerification {
  const metadata =
    target.recoveryMetadata;

  if (!metadata) {
    return {
      valid: true,
      blockers: [],
    };
  }

  const blockers: string[] = [];

  if (
    metadata.provenance
      .baselineDocumentHash !==
    metadata.securityBaseline
      .expectedSha256
  ) {
    blockers.push(
      "Security baseline provenance hash does not match the compiled baseline reference.",
    );
  }

  if (
    metadata.provenance
      .compiledTargetHash !==
    hashRecoveryTargetContract(
      target as unknown as {
        recoveryMetadata?: unknown;
        [key: string]: unknown;
      },
    )
  ) {
    blockers.push(
      "Compiled target hash does not match the runtime recovery target.",
    );
  }

  if (
    metadata.provenance
      .compiledPolicyHash !==
    hashRecoveryPolicyMetadata(
      metadata as unknown as {
        provenance?: unknown;
        [key: string]: unknown;
      },
    )
  ) {
    blockers.push(
      "Compiled policy hash does not match recovery metadata.",
    );
  }

  const objectivePairs = [
    [
      "RPO",
      target.objectives.rpoMinutes,
      metadata.objectives.rpoMinutes,
    ],
    [
      "RTO",
      target.objectives.rtoMinutes,
      metadata.objectives.rtoMinutes,
    ],
    [
      "retention",
      target.objectives.retentionDays,
      metadata.objectives.retentionDays,
    ],
  ] as const;

  for (const [
    name,
    targetValue,
    metadataValue,
  ] of objectivePairs) {
    if (
      targetValue !==
      metadataValue
    ) {
      blockers.push(
        name +
          " differs between the runtime target and compiled recovery metadata.",
      );
    }
  }

  const schedulePairs = [
    [
      "capture cadence",
      target.schedule
        .captureEveryMinutes,
      metadata.automation
        .captureEveryMinutes,
    ],
    [
      "verification cadence",
      target.schedule
        .verifyEveryMinutes,
      metadata.automation
        .verifyEveryMinutes,
    ],
    [
      "drill cadence",
      target.schedule
        .drillEveryMinutes,
      metadata.automation
        .drillEveryMinutes,
    ],
    [
      "drift cadence",
      target.schedule
        .driftEveryMinutes,
      metadata.automation
        .driftEveryMinutes,
    ],
  ] as const;

  for (const [
    name,
    targetValue,
    metadataValue,
  ] of schedulePairs) {
    if (
      targetValue !==
      metadataValue
    ) {
      blockers.push(
        name +
          " differs between the runtime target and compiled recovery metadata.",
      );
    }
  }

  if (
    metadata.automation
      .productionMutation !==
      false ||
    metadata.automation
      .restoreMode !==
      "ISOLATED_PREVIEW"
  ) {
    blockers.push(
      "Recovery test policy must remain isolated and non-mutating.",
    );
  }

  if (
    metadata.destination
      .centralControlCanDecrypt !==
      false ||
    metadata.destination
      .encryption !==
      "CUSTOMER_MANAGED" ||
    metadata.destination
      .placement !==
      "PROVIDER_EDGE"
  ) {
    blockers.push(
      "Recovery destination violates the sovereign encryption boundary.",
    );
  }

  if (
    metadata.selection
      .environment ===
      "DEVELOPMENT" &&
    metadata.dataBoundary
      .productionDataAllowed !==
      false
  ) {
    blockers.push(
      "Development profiles cannot permit production data by default.",
    );
  }

  return {
    valid:
      blockers.length === 0,
    blockers,
  };
}
