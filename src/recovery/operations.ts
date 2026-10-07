import {
  sha256,
} from "../build/provenance.js";
import type {
  DiscoveryAssessment,
} from "../assessment/types.js";
import type {
  DesignSpec,
} from "../design/types.js";
import type {
  EnvironmentState,
} from "../discovery/types.js";
import {
  captureProviderConfiguration,
} from "./providers.js";
import type {
  PlatformConfigurationCapture,
  RecoveryArtifact,
  RecoveryArtifactKind,
  RecoveryDriftComparison,
  RecoveryPoint,
  RecoveryPolicy,
  RecoveryVerification,
  SimulatedRestoreDrill,
} from "./types.js";

function matchingEvidenceRefs(
  environment: EnvironmentState,
  tokens: string[],
): string[] {
  return environment.evidence
    .filter((item) => {
      const key =
        item.key.toLowerCase();

      return (
        item.value.toLowerCase() !==
          "unknown" &&
        tokens.some(
          (token) =>
            key.includes(token),
        )
      );
    })
    .map(
      (item) =>
        item.source + ":" + item.key,
    )
    .sort();
}

function makeArtifact(input: {
  kind: RecoveryArtifactKind;
  provider:
    RecoveryArtifact["provider"];
  source: string;
  resourceIds: string[];
  evidenceRefs: string[];
  contentHash: string;
  protection:
    RecoveryArtifact["protection"];
}): RecoveryArtifact {
  const normalized = {
    kind: input.kind,
    provider: input.provider,
    source: input.source,
    resourceIds:
      [...new Set(input.resourceIds)]
        .sort(),
    evidenceRefs:
      [...new Set(input.evidenceRefs)]
        .sort(),
    contentHash: input.contentHash,
    protection: input.protection,
    secretFree: true as const,
  };

  return {
    artifactId:
      "recovery-artifact-" +
      sha256(
        JSON.stringify(
          normalized,
        ),
      ).slice(0, 12),
    ...normalized,
  };
}

function hasKind(
  artifacts: RecoveryArtifact[],
  kind: RecoveryArtifactKind,
): boolean {
  return artifacts.some(
    (artifact) =>
      artifact.kind === kind,
  );
}

function coverageFor(
  artifacts: RecoveryArtifact[],
  policy: RecoveryPolicy,
): RecoveryPoint["coverage"] {
  const complete =
    policy.requiredArtifacts.every(
      (kind) =>
        hasKind(
          artifacts,
          kind,
        ),
    );

  if (complete) {
    return "FULL";
  }

  if (
    hasKind(
      artifacts,
      "CONFIGURATION_EXPORT",
    )
  ) {
    return "CONFIGURATION_EXPORT";
  }

  if (
    hasKind(
      artifacts,
      "IAC_STATE",
    )
  ) {
    return "IAC_STATE";
  }

  return "MANIFEST_ONLY";
}

function hashableRecoveryPoint(
  point: Omit<
    RecoveryPoint,
    "recoveryPointId" |
    "recoveryPointHash"
  >,
): string {
  return sha256(
    JSON.stringify(point),
  );
}

function explicitConfigurationExport(
  environment: EnvironmentState,
): string[] {
  return matchingEvidenceRefs(
    environment,
    [
      "configuration_export",
      "config_export",
    ],
  );
}

function explicitIaCState(
  environment: EnvironmentState,
): string[] {
  return matchingEvidenceRefs(
    environment,
    [
      "terraform_state",
      "opentofu_state",
      "pulumi_state",
      "iac_state",
    ],
  );
}

function encryptionEvidence(
  environment: EnvironmentState,
): string[] {
  return matchingEvidenceRefs(
    environment,
    [
      "recovery_encryption",
      "backup_encryption",
      "state_encryption",
      "evidence_encryption",
    ],
  );
}

function policyUnknowns(
  policy: RecoveryPolicy,
): string[] {
  const unknowns: string[] = [];

  if (
    policy.retentionDays ===
    "UNKNOWN"
  ) {
    unknowns.push(
      "Recovery retention is UNKNOWN.",
    );
  }
  if (policy.rpo === "UNKNOWN") {
    unknowns.push(
      "RPO is UNKNOWN.",
    );
  }
  if (policy.rto === "UNKNOWN") {
    unknowns.push(
      "RTO is UNKNOWN.",
    );
  }
  if (policy.owner === "UNKNOWN") {
    unknowns.push(
      "Recovery ownership is UNKNOWN.",
    );
  }
  if (
    policy.immutability ===
    "UNKNOWN"
  ) {
    unknowns.push(
      "Recovery immutability posture is UNKNOWN.",
    );
  }
  if (
    policy.offlineCopy ===
    "UNKNOWN"
  ) {
    unknowns.push(
      "Offline-copy posture is UNKNOWN.",
    );
  }

  return unknowns;
}

export function createSimulatedRecoveryPoint(input: {
  environment: EnvironmentState;
  assessment: DiscoveryAssessment;
  design?: DesignSpec;
  policy: RecoveryPolicy;
  capturedAt?: string;
}): RecoveryPoint {
  const artifacts: RecoveryArtifact[] = [];
  const providerCapture:
    PlatformConfigurationCapture =
      captureProviderConfiguration(
        input.environment,
      );

  artifacts.push(
    makeArtifact({
      kind: "INVENTORY_MANIFEST",
      provider:
        input.environment.provider,
      source:
        "assessment-recovery-manifest",
      resourceIds:
        input.assessment
          .recoverySnapshot.resources
          .map(
            (resource) =>
              resource.resourceId,
          ),
      evidenceRefs:
        input.assessment
          .recoverySnapshot
          .evidenceRefs,
      contentHash:
        input.assessment
          .recoverySnapshot
          .configurationHash,
      protection: "HASHED",
    }),
  );

  const exportRefs =
    explicitConfigurationExport(
      input.environment,
    );
  const encryptionRefs =
    encryptionEvidence(
      input.environment,
    );

  if (exportRefs.length > 0) {
    artifacts.push(
      makeArtifact({
        kind:
          "CONFIGURATION_EXPORT",
        provider:
          input.environment.provider,
        source:
          "provider-configuration-export",
        resourceIds:
          providerCapture.resourceIds,
        evidenceRefs: [
          ...exportRefs,
          ...encryptionRefs,
        ],
        contentHash:
          sha256(
            JSON.stringify({
              refs: exportRefs,
              resources:
                providerCapture
                  .resourceIds,
            }),
          ),
        protection:
          encryptionRefs.length > 0
            ? "ENCRYPTED_EVIDENCE"
            : "HASHED",
      }),
    );
  }

  if (
    providerCapture
      .configurationEvidenceRefs
      .length > 0 ||
    input.design
  ) {
    const evidenceRefs = [
      ...providerCapture
        .configurationEvidenceRefs,
      ...(input.design
        ? [
            "policy:" +
              input.design.policies
                .bundleHash,
          ]
        : []),
    ];

    artifacts.push(
      makeArtifact({
        kind:
          "POLICY_CONFIGURATION",
        provider:
          input.environment.provider,
        source:
          "governed-platform-policy",
        resourceIds:
          providerCapture.resourceIds,
        evidenceRefs,
        contentHash:
          sha256(
            JSON.stringify({
              provider:
                input.environment
                  .provider,
              evidenceRefs,
              policyBundleHash:
                input.design?.policies
                  .bundleHash,
            }),
          ),
        protection: "HASHED",
      }),
    );
  }

  if (input.design) {
    artifacts.push(
      makeArtifact({
        kind: "IAC_SOURCE",
        provider:
          input.environment.provider,
        source:
          input.design.plugin.plugin,
        resourceIds:
          input.design.entries.map(
            (entry) =>
              entry.resourceId,
          ),
        evidenceRefs: [
          "design:" +
            input.design.designHash,
        ],
        contentHash:
          input.design.designHash,
        protection: "HASHED",
      }),
    );
  }

  const stateRefs =
    explicitIaCState(
      input.environment,
    );

  if (
    stateRefs.length > 0 &&
    input.design
  ) {
    artifacts.push(
      makeArtifact({
        kind: "IAC_STATE",
        provider:
          input.environment.provider,
        source:
          input.design.plugin.plugin,
        resourceIds:
          input.design.entries.map(
            (entry) =>
              entry.resourceId,
          ),
        evidenceRefs: [
          ...stateRefs,
          ...encryptionRefs,
        ],
        contentHash:
          sha256(
            JSON.stringify({
              refs: stateRefs,
              designHash:
                input.design.designHash,
            }),
          ),
        protection:
          encryptionRefs.length > 0
            ? "ENCRYPTED_EVIDENCE"
            : "HASHED",
      }),
    );
  }

  const blockers =
    input.policy.requiredArtifacts
      .filter(
        (kind) =>
          !hasKind(
            artifacts,
            kind,
          ),
      )
      .map(
        (kind) =>
          "Required recovery artifact is missing: " +
          kind +
          ".",
      );

  const coverage =
    coverageFor(
      artifacts,
      input.policy,
    );

  const base:
    Omit<
      RecoveryPoint,
      "recoveryPointId" |
      "recoveryPointHash"
    > = {
      kind:
        "SIMULATED_PLATFORM_RECOVERY_POINT",
      provider:
        input.environment.provider,
      capturedAt:
        input.capturedAt ??
        new Date().toISOString(),
      policyId:
        input.policy.policyId,
      sourceConfigurationHash:
        input.assessment
          .recoverySnapshot
          .configurationHash,
      designHash:
        input.design?.designHash,
      policyBundleHash:
        input.design?.policies
          .bundleHash,
      artifacts,
      coverage,
      restoreStatus: "UNVERIFIED",
      restorePrerequisites: [
        "Approved DesignSpec or explicit recovery design intent.",
        "Selected preview adapter available.",
        "Required recovery artifacts verified.",
        "Operator approval remains required for any future mutation path.",
      ],
      blockers,
      unknowns:
        policyUnknowns(
          input.policy,
        ),
      actEnabled: false,
    };

  const recoveryPointHash =
    hashableRecoveryPoint(base);

  return {
    recoveryPointId:
      "recovery-point-" +
      recoveryPointHash.slice(
        0,
        12,
      ),
    recoveryPointHash,
    ...base,
  };
}

export function verifyRecoveryPoint(input: {
  point: RecoveryPoint;
  policy: RecoveryPolicy;
}): RecoveryVerification {
  const expectedHash =
    hashableRecoveryPoint({
      kind: input.point.kind,
      provider:
        input.point.provider,
      capturedAt:
        input.point.capturedAt,
      policyId:
        input.point.policyId,
      sourceConfigurationHash:
        input.point
          .sourceConfigurationHash,
      designHash:
        input.point.designHash,
      policyBundleHash:
        input.point
          .policyBundleHash,
      artifacts:
        input.point.artifacts,
      coverage:
        input.point.coverage,
      restoreStatus:
        input.point.restoreStatus,
      restorePrerequisites:
        input.point
          .restorePrerequisites,
      blockers:
        input.point.blockers,
      unknowns:
        input.point.unknowns,
      actEnabled: false,
    });

  const checks = [
    {
      name:
        "recovery-point-hash",
      status:
        expectedHash ===
        input.point.recoveryPointHash
          ? "PASS" as const
          : "FAIL" as const,
      detail:
        expectedHash ===
        input.point.recoveryPointHash
          ? "Recovery-point hash matches."
          : "Recovery-point hash does not match.",
    },
    {
      name:
        "required-artifacts",
      status:
        input.policy.requiredArtifacts
          .every(
            (kind) =>
              hasKind(
                input.point
                  .artifacts,
                kind,
              ),
          )
          ? "PASS" as const
          : "FAIL" as const,
      detail:
        "Required recovery artifact coverage was evaluated.",
    },
    {
      name:
        "secret-free-evidence",
      status:
        input.point.artifacts.every(
          (artifact) =>
            artifact.secretFree,
        )
          ? "PASS" as const
          : "FAIL" as const,
      detail:
        "Recovery evidence stores references and hashes, not secret values.",
    },
    {
      name:
        "artifact-hashes",
      status:
        input.point.artifacts.every(
          (artifact) =>
            artifact.contentHash
              .length === 64,
        )
          ? "PASS" as const
          : "FAIL" as const,
      detail:
        "Recovery artifact hashes were checked.",
    },
    {
      name:
        "sensitive-artifact-encryption",
      status:
        input.point.artifacts
          .filter(
            (artifact) =>
              artifact.kind ===
                "CONFIGURATION_EXPORT" ||
              artifact.kind ===
                "IAC_STATE",
          )
          .every(
            (artifact) =>
              artifact.protection ===
              "ENCRYPTED_EVIDENCE",
          )
          ? "PASS" as const
          : "FAIL" as const,
      detail:
        "Configuration export and IaC state require explicit encryption evidence.",
    },
    {
      name:
        "restore-prerequisites",
      status:
        input.point
          .restorePrerequisites
          .length > 0
          ? "PASS" as const
          : "FAIL" as const,
      detail:
        "Restore prerequisites are recorded.",
    },
    {
      name: "rpo-rto",
      status:
        input.policy.rpo !==
          "UNKNOWN" &&
        input.policy.rto !==
          "UNKNOWN"
          ? "PASS" as const
          : "UNKNOWN" as const,
      detail:
        "RPO/RTO remain UNKNOWN unless explicit evidence exists.",
    },
  ];

  const blockers = [
    ...input.point.blockers,
    ...checks
      .filter(
        (check) =>
          check.status === "FAIL",
      )
      .map(
        (check) =>
          check.detail,
      ),
  ];

  const unknowns = [
    ...input.point.unknowns,
    ...checks
      .filter(
        (check) =>
          check.status ===
          "UNKNOWN",
      )
      .map(
        (check) =>
          check.detail,
      ),
  ];

  const status:
    RecoveryVerification["status"] =
      blockers.length > 0
        ? "BLOCKED"
        : unknowns.length > 0
          ? "PARTIAL"
          : "VERIFIED";

  return {
    recoveryPointId:
      input.point.recoveryPointId,
    status,
    verifiedAt:
      new Date().toISOString(),
    checks,
    blockers: [
      ...new Set(blockers),
    ],
    unknowns: [
      ...new Set(unknowns),
    ],
    evidenceRefs: [
      ...new Set(
        input.point.artifacts
          .flatMap(
            (artifact) =>
              artifact.evidenceRefs,
          ),
      ),
    ].sort(),
  };
}

export function runSimulatedRestoreDrill(input: {
  point: RecoveryPoint;
  verification: RecoveryVerification;
  design: DesignSpec;
}): SimulatedRestoreDrill {
  const designHashMatches =
    !input.point.designHash ||
    input.point.designHash ===
      input.design.designHash;

  const reconstructiveEvidence =
    hasKind(
      input.point.artifacts,
      "IAC_SOURCE",
    ) ||
    hasKind(
      input.point.artifacts,
      "CONFIGURATION_EXPORT",
    );

  const decisions =
    input.design.entries.map(
      (entry) => {
        const reconstructible =
          entry.action ===
            "REUSE" ||
          entry.action ===
            "NO_TOUCH" ||
          (reconstructiveEvidence &&
            entry.action !==
              "BLOCKED");

        return {
          resourceId:
            entry.resourceId,
          resourceType:
            entry.resourceType,
          action: entry.action,
          reconstructible,
          rationale:
            reconstructible
              ? "Recovery evidence is sufficient to preserve or reconstruct this design decision in simulation."
              : "Recovery evidence is insufficient to reconstruct this design decision.",
        };
      },
    );

  const blockers = [
    ...input.verification
      .blockers,
    ...input.point.blockers,
  ];

  if (!designHashMatches) {
    blockers.push(
      "Recovery point does not match the approved DesignSpec hash.",
    );
  }

  if (
    decisions.some(
      (decision) =>
        !decision.reconstructible,
    )
  ) {
    blockers.push(
      "At least one DesignSpec entry is not reconstructible from the available recovery evidence.",
    );
  }

  const uniqueBlockers = [
    ...new Set(blockers),
  ];

  return {
    drillId:
      "restore-drill-" +
      sha256(
        JSON.stringify({
          recoveryPointId:
            input.point
              .recoveryPointId,
          designHash:
            input.design.designHash,
          decisions,
        }),
      ).slice(0, 12),
    recoveryPointId:
      input.point.recoveryPointId,
    designHash:
      input.design.designHash,
    status:
      uniqueBlockers.length > 0
        ? "BLOCKED"
        : "READY_FOR_REVIEW",
    designHashMatches,
    decisions,
    blockers:
      uniqueBlockers,
    evidenceRefs:
      input.verification
        .evidenceRefs,
    mutationAttempted: false,
    actEnabled: false,
  };
}

export function compareRecoveryDrift(input: {
  currentEnvironment: EnvironmentState;
  currentAssessment: DiscoveryAssessment;
  point: RecoveryPoint;
  design: DesignSpec;
}): RecoveryDriftComparison {
  const currentIds = new Set(
    input.currentEnvironment
      .resources.map(
        (resource) =>
          resource.resourceId,
      ),
  );

  const protectedIds = new Set(
    input.point.artifacts
      .filter(
        (artifact) =>
          artifact.kind ===
          "INVENTORY_MANIFEST",
      )
      .flatMap(
        (artifact) =>
          artifact.resourceIds,
      ),
  );

  const designIds = new Set(
    input.design.entries.map(
      (entry) =>
        entry.resourceId,
    ),
  );

  const currentNotProtected =
    [...currentIds]
      .filter(
        (id) =>
          !protectedIds.has(id),
      )
      .sort();

  const recoveryOnly =
    [...protectedIds]
      .filter(
        (id) =>
          !currentIds.has(id),
      )
      .sort();

  const expectedDesignDelta =
    [...designIds]
      .filter(
        (id) =>
          !currentIds.has(id),
      )
      .sort();

  const hashChanged =
    input.currentAssessment
      .recoverySnapshot
      .configurationHash !==
    input.point
      .sourceConfigurationHash;

  const recoverabilityRisks = [
    ...(hashChanged
      ? [
          "Current configuration hash differs from the captured recovery point.",
        ]
      : []),
    ...currentNotProtected.map(
      (id) =>
        "Current resource is not represented in the recovery manifest: " +
        id,
    ),
    ...recoveryOnly.map(
      (id) =>
        "Recovery manifest contains a resource no longer observed: " +
        id,
    ),
  ];

  return {
    status:
      recoverabilityRisks.length >
      0
        ? "DRIFTED"
        : "MATCHED",
    currentConfigurationHash:
      input.currentAssessment
        .recoverySnapshot
        .configurationHash,
    recoveryConfigurationHash:
      input.point
        .sourceConfigurationHash,
    designHash:
      input.design.designHash,
    currentNotProtected,
    recoveryOnly,
    expectedDesignDelta,
    recoverabilityRisks,
  };
}
