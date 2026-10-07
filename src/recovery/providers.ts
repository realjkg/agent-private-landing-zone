import type {
  EnvironmentState,
  Provider,
} from "../discovery/types.js";
import type {
  PlatformConfigurationCapture,
} from "./types.js";

const EXPECTED_EVIDENCE:
  Record<Provider, string[]> = {
    AWS: [
      "aws.organizations",
      "aws.control_tower",
    ],
    AZURE: [
      "azure.management_groups",
      "azure.policy",
    ],
  };

const PLATFORM_EVIDENCE_PREFIXES:
  Record<Provider, string[]> = {
    AWS: [
      "aws.organizations",
      "aws.control_tower",
      "aws.scp",
      "aws.config",
      "aws.cloudtrail",
    ],
    AZURE: [
      "azure.management_groups",
      "azure.policy",
    ],
  };

export function captureProviderConfiguration(
  environment: EnvironmentState,
): PlatformConfigurationCapture {
  const keys = new Set(
    environment.evidence
      .filter(
        (item) =>
          item.value !== "unknown",
      )
      .map((item) => item.key),
  );

  const prefixes =
    PLATFORM_EVIDENCE_PREFIXES[
      environment.provider
    ];

  const configurationEvidenceRefs =
    environment.evidence
      .filter((item) =>
        prefixes.some(
          (prefix) =>
            item.key.startsWith(
              prefix,
            ),
        ),
      )
      .map(
        (item) =>
          item.source +
          ":" +
          item.key,
      )
      .sort();

  const missingEvidence =
    EXPECTED_EVIDENCE[
      environment.provider
    ].filter(
      (key) => !keys.has(key),
    );

  const resourceIds =
    environment.resources
      .filter(
        (resource) =>
          resource.sourceOfTruth !==
            "UNKNOWN" ||
          resource.ownership ===
            "MANAGED_BY_ACCELERATOR",
      )
      .map(
        (resource) =>
          resource.resourceId,
      )
      .sort();

  return {
    provider:
      environment.provider,
    resourceIds,
    configurationEvidenceRefs,
    missingEvidence,
    secretFree: true,
  };
}
