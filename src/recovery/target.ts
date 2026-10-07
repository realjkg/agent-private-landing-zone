import type { IaCEngine } from "../build/types.js";
import type {
  MockScenario,
  Provider,
} from "../discovery/types.js";
import type {
  SovereignCapability,
} from "../orchestration/types.js";
import type {
  RecoveryArtifactKind,
} from "./types.js";
import type {
  RecoveryMetadata,
} from "./profile/types.js";

export type RecoveryScopeType =
  | "AWS_ORGANIZATION"
  | "AWS_ACCOUNT"
  | "AZURE_TENANT"
  | "AZURE_MANAGEMENT_GROUP"
  | "AZURE_SUBSCRIPTION";

export type RecoveryEvidenceDestination =
  | {
      kind: "LOCAL_ENCRYPTED_VAULT";
      namespace: string;
    }
  | {
      kind: "EXTERNAL_ENCRYPTED_STORE";
      locationRef: string;
    };

export type RecoveryTargetSpec = {
  targetId: string;
  enabled: boolean;
  owner: string;
  provider: Provider;
  scope: {
    type: RecoveryScopeType;
    id: string;
  };
  environment: {
    mode: "LIVE_READ_ONLY" | "FIXTURE";
    fixture?: MockScenario;
  };
  source: {
    engine: IaCEngine;
    approvedDesignHash: string;
    designRef: string;
    sourceOfTruthRef: string;
  };
  protectedArtifacts: RecoveryArtifactKind[];
  evidenceDestination: RecoveryEvidenceDestination;
  schedule: {
    captureEveryMinutes: number;
    verifyEveryMinutes: number;
    drillEveryMinutes: number;
    driftEveryMinutes: number;
  };
  objectives: {
    retentionDays: number;
    rpoMinutes: number;
    rtoMinutes: number;
  };
  protection: {
    encryptionRequired: true;
    immutability: "REQUIRED" | "OPTIONAL";
    offlineCopy: "REQUIRED" | "OPTIONAL";
  };
  capabilityRequests: SovereignCapability[];
  recoveryMetadata?: RecoveryMetadata;
};

export type RecoveryTargetValidation = {
  valid: boolean;
  blockers: string[];
};

const STATEFUL_ENGINES =
  new Set<IaCEngine>([
    "TERRAFORM",
    "OPENTOFU",
    "PULUMI",
  ]);

function positiveInteger(
  value: number,
): boolean {
  return (
    Number.isInteger(value) &&
    value > 0
  );
}

function providerScopeMatches(
  target: RecoveryTargetSpec,
): boolean {
  return target.provider === "AWS"
    ? target.scope.type.startsWith("AWS_")
    : target.scope.type.startsWith(
        "AZURE_",
      );
}

export function validateRecoveryTarget(
  target: RecoveryTargetSpec,
): RecoveryTargetValidation {
  const blockers: string[] = [];

  if (
    !/^[a-z0-9][a-z0-9._-]{2,63}$/i.test(
      target.targetId,
    )
  ) {
    blockers.push(
      "Target ID must be 3-64 characters using letters, numbers, dot, underscore, or hyphen.",
    );
  }

  if (!target.owner.trim()) {
    blockers.push(
      "Recovery target owner is required.",
    );
  }

  if (
    !target.scope.id.trim() ||
    !providerScopeMatches(target)
  ) {
    blockers.push(
      "Provider scope is missing or incompatible with the selected provider.",
    );
  }

  if (
    target.environment.mode ===
      "FIXTURE" &&
    !target.environment.fixture
  ) {
    blockers.push(
      "Fixture mode requires a fixture name.",
    );
  }

  if (
    target.environment.mode ===
      "LIVE_READ_ONLY" &&
    !target.capabilityRequests.includes(
      "CLOUD_READ",
    )
  ) {
    blockers.push(
      "Live recovery automation requires an explicit CLOUD_READ capability request.",
    );
  }

  if (
    !target.capabilityRequests.includes(
      "EVIDENCE_READ",
    )
  ) {
    blockers.push(
      "Recovery automation requires EVIDENCE_READ.",
    );
  }

  if (
    !target.capabilityRequests.includes(
      "EVIDENCE_WRITE",
    )
  ) {
    blockers.push(
      "Recovery automation requires EVIDENCE_WRITE for encrypted recovery evidence.",
    );
  }

  if (
    target.source.approvedDesignHash
      .length !== 64
  ) {
    blockers.push(
      "Approved DesignSpec hash must be a 64-character SHA-256 value.",
    );
  }

  for (const [
    name,
    value,
  ] of Object.entries(
    target.schedule,
  )) {
    if (!positiveInteger(value)) {
      blockers.push(
        name +
          " must be a positive integer number of minutes.",
      );
    }
  }

  if (
    !positiveInteger(
      target.objectives
        .retentionDays,
    )
  ) {
    blockers.push(
      "Retention days must be a positive integer.",
    );
  }

  if (
    !positiveInteger(
      target.objectives.rpoMinutes,
    ) ||
    !positiveInteger(
      target.objectives.rtoMinutes,
    )
  ) {
    blockers.push(
      "RPO and RTO must be positive integer minute values.",
    );
  }

  const required =
    new Set<RecoveryArtifactKind>([
      "INVENTORY_MANIFEST",
      "CONFIGURATION_EXPORT",
      "IAC_SOURCE",
      "POLICY_CONFIGURATION",
    ]);

  if (
    STATEFUL_ENGINES.has(
      target.source.engine,
    )
  ) {
    required.add("IAC_STATE");
  }

  for (const artifact of required) {
    if (
      !target.protectedArtifacts.includes(
        artifact,
      )
    ) {
      blockers.push(
        "Protected artifact set is missing required class: " +
          artifact +
          ".",
      );
    }
  }

  if (
    target.evidenceDestination.kind ===
      "EXTERNAL_ENCRYPTED_STORE" &&
    !target.evidenceDestination
      .locationRef.trim()
  ) {
    blockers.push(
      "External evidence destination requires a location reference.",
    );
  }

  if (
    target.evidenceDestination.kind ===
      "LOCAL_ENCRYPTED_VAULT" &&
    !target.evidenceDestination
      .namespace.trim()
  ) {
    blockers.push(
      "Local encrypted evidence destination requires a namespace.",
    );
  }

  return {
    valid: blockers.length === 0,
    blockers,
  };
}
