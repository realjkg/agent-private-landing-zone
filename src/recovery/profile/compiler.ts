import {
  sha256,
} from "../../build/provenance.js";
import type {
  RecoveryArtifactKind,
} from "../types.js";
import type {
  RecoveryScopeType,
} from "../target.js";
import {
  composeContinuityProfile,
  PROFILE_CATALOG_VERSION,
} from "./catalog.js";
import type {
  CompiledRecoveryTarget,
  RecoveryCompileContext,
  RecoverySecurityBaseline,
  RecoveryTargetIntent,
} from "./types.js";

const STATEFUL_ENGINES =
  new Set([
    "TERRAFORM",
    "OPENTOFU",
    "PULUMI",
  ]);

export function stableRecoveryJson(
  value: unknown,
): string {
  if (
    value === null ||
    typeof value !== "object"
  ) {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return (
      "[" +
      value
        .map(stableRecoveryJson)
        .join(",") +
      "]"
    );
  }

  const record =
    value as Record<
      string,
      unknown
    >;

  return (
    "{" +
    Object.keys(record)
      .sort()
      .map(
        (key) =>
          JSON.stringify(key) +
          ":" +
          stableRecoveryJson(record[key]),
      )
      .join(",") +
    "}"
  );
}

function defaultScopeType(
  provider: "AWS" | "AZURE",
): RecoveryScopeType {
  return provider === "AWS"
    ? "AWS_ACCOUNT"
    : "AZURE_SUBSCRIPTION";
}

function protectedArtifacts(
  engine:
    RecoveryCompileContext[
      "engine"
    ],
): RecoveryArtifactKind[] {
  const artifacts:
    RecoveryArtifactKind[] = [
      "INVENTORY_MANIFEST",
      "CONFIGURATION_EXPORT",
      "IAC_SOURCE",
      "POLICY_CONFIGURATION",
    ];

  if (
    STATEFUL_ENGINES.has(
      engine,
    )
  ) {
    artifacts.push(
      "IAC_STATE",
    );
  }

  return artifacts;
}

function capabilityRequests(
  liveRead: boolean,
) {
  return [
    "EVIDENCE_READ" as const,
    "EVIDENCE_WRITE" as const,
    ...(liveRead
      ? [
          "CLOUD_READ" as const,
        ]
      : []),
  ];
}

export function compileRecoveryTarget(
  intent: RecoveryTargetIntent,
  context: RecoveryCompileContext,
  baseline: RecoverySecurityBaseline,
): CompiledRecoveryTarget {
  if (
    intent.compliancePacks?.some(
      (pack) =>
        !/^[A-Z0-9_]+@\d+$/.test(
          pack,
        ),
    )
  ) {
    throw new Error(
      "RECOVERY_PROFILE_INVALID: compliance packs must be versioned identifiers such as NIST_CSF_2@1.",
    );
  }

  if (
    baseline.actEnabled !== false ||
    baseline.centralControlCanDecrypt !== false ||
    baseline.customerManagedEncryption !== true ||
    baseline.providerEdgeRecovery !== true ||
    baseline.immutableRecovery !== true
  ) {
    throw new Error(
      "RECOVERY_BASELINE_INVALID: locked authority controls cannot be weakened.",
    );
  }

  const selectedPacks = [
    ...(intent.compliancePacks ?? []),
  ].sort();

  const complianceOverlays =
    selectedPacks.map(
      (pack) => {
        const overlay =
          context
            .complianceOverlays?.[
              pack
            ];

        if (!overlay) {
          throw new Error(
            "RECOVERY_PROFILE_BLOCKED: compliance pack " +
              pack +
              " has no installed overlay.",
          );
        }

        return overlay;
      },
    );

  const continuity =
    composeContinuityProfile(
      intent.organization,
      intent.environment,
      intent.criticality,
      complianceOverlays,
      context.authorizedOverrides,
    );

  const selection = {
    organization:
      intent.organization,
    environment:
      intent.environment,
    criticality:
      intent.criticality,
    compliancePacks:
      selectedPacks,
  };

  const policyIntent = {
    selection,
    objectives: {
      rpoMinutes:
        continuity.rpoMinutes,
      rtoMinutes:
        continuity.rtoMinutes,
      retentionDays:
        continuity.retentionDays,
      maximumRestoreEvidenceAgeDays:
        continuity
          .maximumRestoreEvidenceAgeDays,
    },
    destination: {
      placement:
        "PROVIDER_EDGE" as const,
      targetRef:
        context
          .destinationTargetRef,
      encryption:
        "CUSTOMER_MANAGED" as const,
      immutable:
        continuity.immutable,
      minimumHealthyCopies:
        continuity
          .minimumHealthyCopies,
      minimumFailureDomains:
        continuity
          .minimumFailureDomains,
      centralControlCanDecrypt:
        false as const,
    },
    automation: {
      captureEveryMinutes:
        continuity
          .captureEveryMinutes,
      verifyEveryMinutes:
        continuity
          .verifyEveryMinutes,
      drillEveryMinutes:
        continuity
          .drillEveryMinutes,
      driftEveryMinutes:
        continuity
          .driftEveryMinutes,
      restoreMode:
        "ISOLATED_PREVIEW" as const,
      productionMutation:
        false as const,
    },
    securityBaseline: {
      documentId:
        baseline.documentId,
      documentVersion:
        baseline.documentVersion,
      documentRef:
        baseline.documentRef,
      expectedSha256:
        baseline.expectedSha256,
      failClosedOnMissing:
        true as const,
      failClosedOnHashMismatch:
        true as const,
    },
    dataBoundary: {
      productionDataAllowed:
        intent.environment ===
        "PRODUCTION",
    },
    policy: {
      evaluator:
        "INHERIT" as const,
      decisions: {
        capture:
          "recovery/capture" as const,
        verify:
          "recovery/verify" as const,
        drill:
          "recovery/drill" as const,
        drift:
          "recovery/drift" as const,
        restore:
          "recovery/restore" as const,
      },
      compromiseBehavior: {
        NORMAL:
          "EVALUATE" as const,
        SUSPECTED:
          "SUSPEND" as const,
        CONTAINED:
          "SUSPEND" as const,
        RECOVERY:
          "ISOLATED_ONLY" as const,
        VERIFIED:
          "EVALUATE" as const,
      },
    },
  };

  const compiledPolicyHash =
    sha256(
      stableRecoveryJson(policyIntent),
    );

  const baseTarget = {
    targetId:
      intent.targetId,
    enabled: true,
    owner: intent.owner,
    provider:
      intent.provider,
    scope: {
      type:
        context.scopeType ??
        defaultScopeType(
          intent.provider,
        ),
      id: intent.scopeId,
    },
    environment: {
      mode:
        "LIVE_READ_ONLY" as const,
    },
    source: {
      engine:
        context.engine,
      approvedDesignHash:
        context.approvedDesignHash,
      designRef:
        context.designRef,
      sourceOfTruthRef:
        context.sourceOfTruthRef,
    },
    protectedArtifacts:
      protectedArtifacts(
        context.engine,
      ),
    evidenceDestination: {
      kind:
        "LOCAL_ENCRYPTED_VAULT" as const,
      namespace:
        "recovery-" +
        intent.targetId,
    },
    schedule: {
      captureEveryMinutes:
        continuity
          .captureEveryMinutes,
      verifyEveryMinutes:
        continuity
          .verifyEveryMinutes,
      drillEveryMinutes:
        continuity
          .drillEveryMinutes,
      driftEveryMinutes:
        continuity
          .driftEveryMinutes,
    },
    objectives: {
      retentionDays:
        continuity.retentionDays,
      rpoMinutes:
        continuity.rpoMinutes,
      rtoMinutes:
        continuity.rtoMinutes,
    },
    protection: {
      encryptionRequired:
        true as const,
      immutability:
        continuity.immutable
          ? "REQUIRED" as const
          : "OPTIONAL" as const,
      offlineCopy:
        "OPTIONAL" as const,
    },
    capabilityRequests:
      capabilityRequests(true),
  };

  const compiledTargetHash =
    sha256(
      stableRecoveryJson(baseTarget),
    );

  return {
    ...baseTarget,
    recoveryMetadata: {
      apiVersion:
        "alz.io/recovery/v1",
      ...policyIntent,
      provenance: {
        targetSchemaVersion:
          1,
        profileCatalogVersion:
          PROFILE_CATALOG_VERSION,
        compilerVersion:
          "1",
        baselineDocumentHash:
          baseline.expectedSha256,
        compiledTargetHash,
        compiledPolicyHash,
        ...(context.sourceCommit
          ? {
              sourceCommit:
                context.sourceCommit,
            }
          : {}),
      },
    },
  };
}


export function hashRecoveryTargetContract(
  target: {
    recoveryMetadata?: unknown;
    [key: string]: unknown;
  },
): string {
  const {
    recoveryMetadata: _metadata,
    ...contract
  } = target;

  return sha256(
    stableRecoveryJson(contract),
  );
}

export function hashRecoveryPolicyMetadata(
  metadata: {
    provenance?: unknown;
    [key: string]: unknown;
  },
): string {
  const {
    provenance: _provenance,
    ...policy
  } = metadata;

  return sha256(
    stableRecoveryJson(policy),
  );
}
