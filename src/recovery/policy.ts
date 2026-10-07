import { sha256 } from "../build/provenance.js";
import type {
  DesignSpec,
} from "../design/types.js";
import type {
  EnvironmentState,
} from "../discovery/types.js";
import type {
  RecoveryArtifactKind,
  RecoveryPolicy,
} from "./types.js";

export type RecoveryPolicyOverrides = {
  retentionDays?: number;
  rpo?: string;
  rto?: string;
  owner?: string;
  requiredArtifacts?: RecoveryArtifactKind[];
  immutability?:
    | "REQUIRED"
    | "OPTIONAL";
  offlineCopy?:
    | "REQUIRED"
    | "OPTIONAL";
};

function resiliencyValue(
  environment: EnvironmentState,
  key: "rpo" | "rto",
): string | "UNKNOWN" {
  const value =
    environment.resiliencyObservations.find(
      (item) =>
        item.key === key,
    )?.value;

  return !value ||
    value.toLowerCase() ===
      "unknown"
    ? "UNKNOWN"
    : value;
}

function explicitEvidenceRefs(
  environment: EnvironmentState,
): string[] {
  return [
    ...environment.resiliencyObservations.map(
      (item) =>
        item.source + ":" + item.key,
    ),
    ...environment.evidence
      .filter((item) =>
        [
          "backup",
          "recovery",
          "retention",
          "immutab",
          "offline",
          "state",
          "configuration_export",
          "config_export",
        ].some((token) =>
          item.key
            .toLowerCase()
            .includes(token),
        ),
      )
      .map(
        (item) =>
          item.source + ":" + item.key,
      ),
  ];
}

function requiredArtifacts(
  design?: DesignSpec,
): RecoveryArtifactKind[] {
  const required:
    RecoveryArtifactKind[] = [
      "INVENTORY_MANIFEST",
      "CONFIGURATION_EXPORT",
      "POLICY_CONFIGURATION",
  ];

  if (design) {
    required.push("IAC_SOURCE");

    if (
      [
        "TERRAFORM",
        "OPENTOFU",
        "PULUMI",
      ].includes(
        design.plugin.plugin,
      )
    ) {
      required.push("IAC_STATE");
    }
  }

  return [
    ...new Set(required),
  ];
}

export function createRecoveryPolicy(input: {
  environment: EnvironmentState;
  design?: DesignSpec;
  overrides?: RecoveryPolicyOverrides;
}): RecoveryPolicy {
  const normalized = {
    provider: input.environment.provider,
    scope:
      input.environment.provider +
      ":" +
      input.environment.classification,
    retentionDays:
      input.overrides?.retentionDays ??
      ("UNKNOWN" as const),
    rpo:
      input.overrides?.rpo ??
      resiliencyValue(
        input.environment,
        "rpo",
      ),
    rto:
      input.overrides?.rto ??
      resiliencyValue(
        input.environment,
        "rto",
      ),
    owner:
      input.overrides?.owner ??
      ("UNKNOWN" as const),
    immutability:
      input.overrides
        ?.immutability ??
      ("UNKNOWN" as const),
    offlineCopy:
      input.overrides?.offlineCopy ??
      ("UNKNOWN" as const),
    requiredArtifacts:
      input.overrides
        ?.requiredArtifacts ??
      requiredArtifacts(
        input.design,
      ),
    evidenceRefs: [
      ...new Set(
        explicitEvidenceRefs(
          input.environment,
        ),
      ),
    ].sort(),
  };

  const policyHash =
    sha256(JSON.stringify(normalized));

  return {
    policyId:
      "recovery-policy-" +
      policyHash.slice(0, 12),
    ...normalized,
  };
}
