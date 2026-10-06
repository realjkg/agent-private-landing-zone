import { enforceOwnershipPolicy } from "../../discovery/ownership.js";
import type {
  DiscoveredResource,
  DiscoveryEvidence,
  MockScenario,
} from "../../discovery/types.js";

export type AwsDiscoveryResult = {
  resources: DiscoveredResource[];
  evidence: DiscoveryEvidence[];
  warnings: string[];
};

export async function discoverAws(
  mock?: MockScenario,
): Promise<AwsDiscoveryResult> {
  if (!mock) {
    return {
      resources: [],
      evidence: [],
      warnings: [
        "CREDENTIALS_MISSING: real AWS discovery is not enabled yet.",
      ],
    };
  }

  if (mock === "unknown") {
    return {
      resources: [],
      evidence: [],
      warnings: [
        "DISCOVERY_PARTIAL: insufficient evidence to classify the environment.",
      ],
    };
  }

  if (mock === "greenfield") {
    return {
      resources: [],
      evidence: [
        {
          key: "aws.greenfield_confirmed",
          value: "true",
          source: "mock",
        },
      ],
      warnings: [],
    };
  }

  const resources = [
    {
      resourceId: "aws:organizations:o-example",
      provider: "AWS" as const,
      resourceType: "AWS::Organizations::Organization",
      name: "existing-organization",
      ownership: "MANAGED_BY_CUSTOMER" as const,
      mutationPolicy: "READ_ONLY" as const,
      sourceOfTruth: "CONTROL_TOWER" as const,
      metadata: { mock: true },
    },
    {
      resourceId: "aws:controltower:landing-zone",
      provider: "AWS" as const,
      resourceType: "AWS::ControlTower::LandingZone",
      name: "existing-landing-zone",
      ownership: "MANAGED_BY_CUSTOMER" as const,
      mutationPolicy: "READ_ONLY" as const,
      sourceOfTruth: "CONTROL_TOWER" as const,
      metadata: { mock: true },
    },
    {
      resourceId: "aws:iam:role:agent-execution",
      provider: "AWS" as const,
      resourceType: "AWS::IAM::Role",
      name: "agent-execution",
      ownership: "MANAGED_BY_ACCELERATOR" as const,
      mutationPolicy: "ADDITIVE_ONLY" as const,
      sourceOfTruth: "UNKNOWN" as const,
      metadata: { mock: true },
    },
  ].map(enforceOwnershipPolicy);

  return {
    resources,
    evidence: [
      {
        key: "aws.organizations",
        value: "present",
        source: "mock",
      },
      {
        key: "aws.control_tower",
        value: "present",
        source: "mock",
      },
    ],
    warnings: [],
  };
}
