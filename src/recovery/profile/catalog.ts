import type {
  RecoveryContinuityProfile,
  RecoveryCriticality,
  RecoveryEnvironment,
  RecoveryOrganization,
} from "./types.js";

export const PROFILE_CATALOG_VERSION =
  1 as const;

const BASE: RecoveryContinuityProfile = {
  rpoMinutes: 1440,
  rtoMinutes: 1440,
  retentionDays: 14,
  maximumRestoreEvidenceAgeDays: 90,
  captureEveryMinutes: 1440,
  verifyEveryMinutes: 1440,
  drillEveryMinutes: 129600,
  driftEveryMinutes: 1440,
  minimumHealthyCopies: 1,
  minimumFailureDomains: 1,
  immutable: true,
};

const ORGANIZATION_DEFAULTS:
  Record<
    RecoveryOrganization,
    Partial<RecoveryContinuityProfile>
  > = {
    STARTUP: {},
    ENTERPRISE: {
      retentionDays: 30,
      minimumHealthyCopies: 2,
      minimumFailureDomains: 2,
    },
  };

const ENVIRONMENT_DEFAULTS:
  Record<
    RecoveryEnvironment,
    Partial<RecoveryContinuityProfile>
  > = {
    DEVELOPMENT: {
      rpoMinutes: 1440,
      rtoMinutes: 1440,
      retentionDays: 14,
      maximumRestoreEvidenceAgeDays: 90,
      drillEveryMinutes: 129600,
    },
    PRODUCTION: {
      rpoMinutes: 240,
      rtoMinutes: 480,
      retentionDays: 30,
      maximumRestoreEvidenceAgeDays: 30,
      drillEveryMinutes: 43200,
    },
  };

const CRITICALITY_DEFAULTS:
  Record<
    RecoveryCriticality,
    Partial<RecoveryContinuityProfile>
  > = {
    NON_CRITICAL: {},
    BUSINESS: {
      rpoMinutes: 240,
      rtoMinutes: 480,
      retentionDays: 30,
      maximumRestoreEvidenceAgeDays: 30,
      drillEveryMinutes: 43200,
    },
    CRITICAL: {
      rpoMinutes: 60,
      rtoMinutes: 240,
      retentionDays: 90,
      maximumRestoreEvidenceAgeDays: 14,
      captureEveryMinutes: 60,
      verifyEveryMinutes: 60,
      drillEveryMinutes: 20160,
      driftEveryMinutes: 60,
      minimumHealthyCopies: 2,
      minimumFailureDomains: 2,
      immutable: true,
    },
  };

function validateProfile(
  profile: RecoveryContinuityProfile,
): RecoveryContinuityProfile {
  for (const [
    key,
    value,
  ] of Object.entries(profile)) {
    if (
      key !== "immutable" &&
      (
        !Number.isInteger(value) ||
        Number(value) <= 0
      )
    ) {
      throw new Error(
        "RECOVERY_PROFILE_INVALID: " +
          key +
          " must be a positive integer.",
      );
    }
  }

  return profile;
}

export function composeContinuityProfile(
  organization: RecoveryOrganization,
  environment: RecoveryEnvironment,
  criticality: RecoveryCriticality,
  complianceOverlays:
    Array<
      Partial<RecoveryContinuityProfile>
    > = [],
  authorizedOverrides:
    Partial<RecoveryContinuityProfile> = {},
): RecoveryContinuityProfile {
  const profile = {
    ...BASE,
    ...ORGANIZATION_DEFAULTS[
      organization
    ],
    ...ENVIRONMENT_DEFAULTS[
      environment
    ],
    ...CRITICALITY_DEFAULTS[
      criticality
    ],
    ...Object.assign(
      {},
      ...complianceOverlays,
    ),
    ...authorizedOverrides,
  };

  if (!profile.immutable) {
    throw new Error(
      "RECOVERY_PROFILE_INVALID: immutable recovery is locked by the security baseline.",
    );
  }

  return validateProfile(
    profile,
  );
}
