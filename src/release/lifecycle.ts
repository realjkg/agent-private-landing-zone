export type ReleaseLifecycleOperation =
  | "CLEAN_INSTALL"
  | "UPGRADE"
  | "ROLLBACK"
  | "UNINSTALL"
  | "MIGRATE_CONFIG";

export type ReleaseLifecycleStep = {
  operation:
    ReleaseLifecycleOperation;
  fromVersion?: string;
  toVersion?: string;
  fromConfigSchema?: number;
  toConfigSchema?: number;
  requiresBackup: boolean;
  requiresIntegrityVerification:
    true;
  infrastructureActEnabled:
    false;
};

export type ReleaseLifecyclePlan = {
  steps: ReleaseLifecycleStep[];
  releaseFilesystemOnly: true;
  cloudMutationAllowed: false;
};

function versionChanged(
  current:
    | string
    | undefined,
  target: string,
): boolean {
  return (
    current !== undefined &&
    current !== target
  );
}

export function planReleaseLifecycle(input: {
  currentVersion?: string;
  previousVersion?: string;
  targetVersion: string;
  currentConfigSchema?: number;
  targetConfigSchema: number;
  uninstallVersion?: string;
}): ReleaseLifecyclePlan {
  const steps:
    ReleaseLifecycleStep[] = [];

  if (!input.currentVersion) {
    steps.push({
      operation:
        "CLEAN_INSTALL",
      toVersion:
        input.targetVersion,
      requiresBackup: false,
      requiresIntegrityVerification:
        true,
      infrastructureActEnabled:
        false,
    });
  } else if (
    versionChanged(
      input.currentVersion,
      input.targetVersion,
    )
  ) {
    steps.push({
      operation: "UPGRADE",
      fromVersion:
        input.currentVersion,
      toVersion:
        input.targetVersion,
      requiresBackup: true,
      requiresIntegrityVerification:
        true,
      infrastructureActEnabled:
        false,
    });
  }

  if (
    input.currentConfigSchema !==
      undefined &&
    input.currentConfigSchema !==
      input.targetConfigSchema
  ) {
    steps.push({
      operation:
        "MIGRATE_CONFIG",
      fromConfigSchema:
        input.currentConfigSchema,
      toConfigSchema:
        input.targetConfigSchema,
      requiresBackup: true,
      requiresIntegrityVerification:
        true,
      infrastructureActEnabled:
        false,
    });
  }

  if (
    input.previousVersion &&
    input.currentVersion &&
    input.previousVersion !==
      input.currentVersion
  ) {
    steps.push({
      operation: "ROLLBACK",
      fromVersion:
        input.currentVersion,
      toVersion:
        input.previousVersion,
      requiresBackup: true,
      requiresIntegrityVerification:
        true,
      infrastructureActEnabled:
        false,
    });
  }

  if (input.uninstallVersion) {
    if (
      input.uninstallVersion ===
      input.currentVersion
    ) {
      throw new Error(
        "RELEASE_UNINSTALL_CURRENT_DENIED",
      );
    }

    steps.push({
      operation: "UNINSTALL",
      fromVersion:
        input.uninstallVersion,
      requiresBackup: false,
      requiresIntegrityVerification:
        true,
      infrastructureActEnabled:
        false,
    });
  }

  return {
    steps,
    releaseFilesystemOnly:
      true,
    cloudMutationAllowed:
      false,
  };
}

export function validateReleaseLifecyclePlan(
  plan: ReleaseLifecyclePlan,
): string[] {
  const blockers: string[] = [];

  if (
    plan.releaseFilesystemOnly !==
      true ||
    plan.cloudMutationAllowed !==
      false
  ) {
    blockers.push(
      "Release lifecycle escaped the local product filesystem boundary.",
    );
  }

  if (
    plan.steps.some(
      (step) =>
        step.infrastructureActEnabled !==
          false ||
        step.requiresIntegrityVerification !==
          true,
    )
  ) {
    blockers.push(
      "Release lifecycle contains an unverified or infrastructure-authorized step.",
    );
  }

  return blockers;
}
