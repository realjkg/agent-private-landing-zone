import type {
  RecoveryAutomationState,
} from "./automation.js";
import {
  loadRecoveryAutomationState,
} from "./automation.js";
import {
  loadRecoveryTargets,
} from "./target-loader.js";
import type {
  RecoveryTargetSpec,
} from "./target.js";
import type {
  RecoveryCoverage,
} from "./types.js";

export type RecoveryAutomationInspection = {
  targetId: string;
  enabled: boolean;
  recoveryPointCoverage:
    | RecoveryCoverage
    | "NOT_RUN";
  verificationStatus: string;
  drillStatus: string;
  driftStatus: string;
  lastCaptureAt?: string;
  lastVerifyAt?: string;
  lastDrillAt?: string;
  lastDriftAt?: string;
};

function inspectTarget(
  target: RecoveryTargetSpec,
  state:
    RecoveryAutomationState |
    undefined,
): RecoveryAutomationInspection {
  return {
    targetId:
      target.targetId,
    enabled:
      target.enabled,
    recoveryPointCoverage:
      state?.recoveryPoint
        ?.coverage ??
      "NOT_RUN",
    verificationStatus:
      state?.verification
        ?.status ??
      "NOT_RUN",
    drillStatus:
      state?.drill
        ?.status ??
      "NOT_RUN",
    driftStatus:
      state?.drift
        ?.status ??
      "NOT_RUN",
    lastCaptureAt:
      state?.lastCaptureAt,
    lastVerifyAt:
      state?.lastVerifyAt,
    lastDrillAt:
      state?.lastDrillAt,
    lastDriftAt:
      state?.lastDriftAt,
  };
}

export async function inspectRecoveryAutomationTargets(
  targets: RecoveryTargetSpec[],
  stateLoader: (
    targetId: string,
  ) => Promise<
    RecoveryAutomationState |
    undefined
  > =
    loadRecoveryAutomationState,
): Promise<
  RecoveryAutomationInspection[]
> {
  return Promise.all(
    targets.map(
      async (target) =>
        inspectTarget(
          target,
          await stateLoader(
            target.targetId,
          ),
        ),
    ),
  );
}

export async function inspectConfiguredRecoveryAutomation(
  targetFile =
    process.env
      .AGENTIC_RECOVERY_TARGETS_FILE ??
    "config/recovery-targets.json",
): Promise<
  RecoveryAutomationInspection[]
> {
  try {
    const targets =
      await loadRecoveryTargets(
        targetFile,
      );

    return inspectRecoveryAutomationTargets(
      targets,
    );
  } catch (error) {
    const code =
      error &&
      typeof error === "object" &&
      "code" in error
        ? String(error.code)
        : "";

    if (code === "ENOENT") {
      return [];
    }

    throw error;
  }
}

export function formatRecoveryAutomationInspection(
  inspections:
    RecoveryAutomationInspection[],
): string {
  if (
    inspections.length === 0
  ) {
    return "";
  }

  return [
    "Unattended recovery targets:",
    ...inspections.map(
      (item) =>
        [
          "  • " +
            item.targetId +
            " — " +
            (item.enabled
              ? "enabled"
              : "disabled"),
          "coverage=" +
            item.recoveryPointCoverage,
          "verify=" +
            item.verificationStatus,
          "drill=" +
            item.drillStatus,
          "drift=" +
            item.driftStatus,
        ].join("; "),
    ),
  ].join("\n");
}
