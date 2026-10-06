import type {
  ControlPlaneState,
  DiscoveryConflict,
  DiscoveryEvidence,
  EnvironmentClassification,
  SafeBuildMode,
} from "./types.js";

const BROWNFIELD_EVIDENCE = new Set([
  "aws.organizations",
  "aws.control_tower",
  "aws.scp",
  "aws.aft",
  "aws.existing_iac",
  "azure.management_groups",
  "azure.policy",
  "azure.existing_iac",
  "azure.platform_subscription",
]);

const GREENFIELD_EVIDENCE = new Set([
  "aws.greenfield_confirmed",
  "azure.greenfield_confirmed",
]);

export function classifyEnvironment(
  evidence: DiscoveryEvidence[],
): {
  classification: EnvironmentClassification;
  controlPlane: ControlPlaneState;
} {
  const keys = new Set(evidence.map((item) => item.key));

  if ([...BROWNFIELD_EVIDENCE].some((key) => keys.has(key))) {
    return {
      classification: "BROWNFIELD",
      controlPlane: "EXISTING",
    };
  }

  if ([...GREENFIELD_EVIDENCE].some((key) => keys.has(key))) {
    return {
      classification: "GREENFIELD",
      controlPlane: "MINIMAL",
    };
  }

  return {
    classification: "UNKNOWN",
    controlPlane: "UNKNOWN",
  };
}

export function deriveSafeBuildMode(
  classification: EnvironmentClassification,
  conflicts: DiscoveryConflict[],
): SafeBuildMode {
  if (conflicts.length > 0) {
    return "BLOCKED";
  }

  if (classification === "BROWNFIELD") {
    return "ADDITIVE_ONLY";
  }

  if (classification === "GREENFIELD") {
    return "GREENFIELD_BASELINE";
  }

  return "READ_ONLY";
}
