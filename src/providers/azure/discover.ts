import { enforceOwnershipPolicy } from "../../discovery/ownership.js";
import type {
  DiscoveredResource,
  DiscoveryEvidence,
  MockScenario,
  ResiliencyObservation,
  SbomComponentObservation,
  ScannerObservation,
} from "../../discovery/types.js";

export type AzureDiscoveryResult = {
  resources: DiscoveredResource[];
  evidence: DiscoveryEvidence[];
  scannerObservations: ScannerObservation[];
  sbomComponents: SbomComponentObservation[];
  sbomComplete: boolean;
  resiliencyObservations: ResiliencyObservation[];
  warnings: string[];
};

const emptyPosture = {
  scannerObservations: [] as ScannerObservation[],
  sbomComponents: [] as SbomComponentObservation[],
  sbomComplete: false,
  resiliencyObservations: [] as ResiliencyObservation[],
};

export async function discoverAzure(
  mock?: MockScenario,
): Promise<AzureDiscoveryResult> {
  if (!mock) {
    return {
      resources: [],
      evidence: [],
      ...emptyPosture,
      warnings: [
        "CREDENTIALS_MISSING: real Azure discovery is not enabled yet.",
      ],
    };
  }

  if (mock === "unknown") {
    return {
      resources: [],
      evidence: [],
      ...emptyPosture,
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
      ...emptyPosture,
      warnings: [
        "POSTURE_UNKNOWN: no existing platform components were discovered to assess.",
      ],
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
      metadata: {
        mock: true,
        assetKind: "CLOUD",
      },
    },
    {
      resourceId: "/providers/Microsoft.Authorization/policyAssignments/baseline",
      provider: "AZURE" as const,
      resourceType: "Microsoft.Authorization/policyAssignments",
      name: "baseline",
      ownership: "MANAGED_BY_CUSTOMER" as const,
      mutationPolicy: "READ_ONLY" as const,
      sourceOfTruth: "AZURE_POLICY" as const,
      metadata: {
        mock: true,
        assetKind: "CLOUD",
      },
    },
    {
      resourceId: "/subscriptions/dev/resourceGroups/agentic-lz",
      provider: "AZURE" as const,
      resourceType: "Microsoft.Resources/resourceGroups",
      name: "agentic-lz",
      ownership: "MANAGED_BY_ACCELERATOR" as const,
      mutationPolicy: "ADDITIVE_ONLY" as const,
      sourceOfTruth: "UNKNOWN" as const,
      metadata: {
        mock: true,
        assetKind: "CLOUD",
      },
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
    scannerObservations: [
      {
        id: "azure-policy-baseline",
        scanner: "fixture-cloud-posture",
        source: "mock",
        status: "PASS",
        domain: "PLATFORM",
        severity: "INFO",
        title: "Azure Policy baseline observed",
        detail:
          "The fixture contains an existing policy assignment in the management hierarchy.",
        resourceId:
          "/providers/Microsoft.Authorization/policyAssignments/baseline",
      },
    ],
    sbomComponents: [],
    sbomComplete: false,
    resiliencyObservations: [
      {
        key: "configuration_backup",
        value: "unknown",
        source: "mock",
      },
      {
        key: "restore_test",
        value: "unknown",
        source: "mock",
      },
      {
        key: "redundant_control_plane",
        value: "unknown",
        source: "mock",
      },
    ],
    warnings: [
      "SBOM_UNKNOWN: component inventory is not yet available.",
      "RESILIENCY_UNKNOWN: backup and restore posture has not been evidenced.",
    ],
  };
}
