import { enforceOwnershipPolicy } from "../../discovery/ownership.js";
import type {
  DiscoveredResource,
  DiscoveryEvidence,
  MockScenario,
} from "../../discovery/types.js";

export type AzureDiscoveryResult = {
  resources: DiscoveredResource[];
  evidence: DiscoveryEvidence[];
  warnings: string[];
};

export async function discoverAzure(
  mock?: MockScenario,
): Promise<AzureDiscoveryResult> {
  if (!mock) {
    return {
      resources: [],
      evidence: [],
      warnings: [
        "CREDENTIALS_MISSING: real Azure discovery is not enabled yet.",
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
          key: "azure.greenfield_confirmed",
          value: "true",
          source: "mock",
        },
      ],
      warnings: [],
    };
  }

  const resources = [
    {
      resourceId: "/providers/Microsoft.Management/managementGroups/platform",
      provider: "AZURE" as const,
      resourceType: "Microsoft.Management/managementGroups",
      name: "platform",
      ownership: "MANAGED_BY_CUSTOMER" as const,
      mutationPolicy: "READ_ONLY" as const,
      sourceOfTruth: "AZURE_POLICY" as const,
      metadata: { mock: true },
    },
    {
      resourceId: "/providers/Microsoft.Authorization/policyAssignments/baseline",
      provider: "AZURE" as const,
      resourceType: "Microsoft.Authorization/policyAssignments",
      name: "baseline",
      ownership: "MANAGED_BY_CUSTOMER" as const,
      mutationPolicy: "READ_ONLY" as const,
      sourceOfTruth: "AZURE_POLICY" as const,
      metadata: { mock: true },
    },
    {
      resourceId: "/subscriptions/dev/resourceGroups/agentic-lz",
      provider: "AZURE" as const,
      resourceType: "Microsoft.Resources/resourceGroups",
      name: "agentic-lz",
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
        key: "azure.management_groups",
        value: "present",
        source: "mock",
      },
      {
        key: "azure.policy",
        value: "present",
        source: "mock",
      },
    ],
    warnings: [],
  };
}
