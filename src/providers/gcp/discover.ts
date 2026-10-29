import { enforceOwnershipPolicy } from "../../discovery/ownership.js";
import type {
  DiscoveredResource,
  DiscoveryEvidence,
  MockScenario,
  ResiliencyObservation,
  SbomComponentObservation,
  ScannerObservation,
} from "../../discovery/types.js";

/**
 * GCP discovery for the governed agent journey, in the shape of the AWS and Azure discoveries
 * (src/providers/aws/discover.ts, src/providers/azure/discover.ts).
 *
 * Only the offline mock estates exist. They are SYNTHETIC fixtures for the Phase E scenario
 * (src/qualification/phase-e.ts, terraform-gcp-brownfield) and never qualify a provider. There is no
 * live path here: this module opens no socket, runs no CLI and reads no credential. Live, read-only GCP
 * inventory is the Cloud Asset Inventory reader behind a trusted host transport
 * (src/providers/gcp/asset-inventory.ts), and the gcp-provider release gate stays BLOCKED until the
 * owner runs it. Without a mock, discovery refuses rather than guessing an estate.
 */
export type GcpDiscoveryResult = {
  resources: DiscoveredResource[];
  evidence: DiscoveryEvidence[];
  scannerObservations: ScannerObservation[];
  sbomComponents: SbomComponentObservation[];
  sbomComplete: boolean;
  resiliencyObservations: ResiliencyObservation[];
  warnings: string[];
};

export const GCP_LIVE_DISCOVERY_UNAVAILABLE =
  "GCP_LIVE_DISCOVERY_UNAVAILABLE: GCP discovery in the agent journey is offline only (a mock estate). Live read-only GCP inventory needs the Cloud Asset Inventory reader behind a trusted host transport; nothing was read.";

const emptyPosture = {
  scannerObservations: [] as ScannerObservation[],
  sbomComponents: [] as SbomComponentObservation[],
  sbomComplete: false,
  resiliencyObservations: [] as ResiliencyObservation[],
};

export async function discoverGcp(
  mock?: MockScenario,
): Promise<GcpDiscoveryResult> {
  if (!mock) {
    throw new Error(GCP_LIVE_DISCOVERY_UNAVAILABLE);
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
          key: "gcp.greenfield_confirmed",
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
      resourceId: "//cloudresourcemanager.googleapis.com/organizations/123456789012",
      provider: "GCP" as const,
      resourceType: "cloudresourcemanager.googleapis.com/Organization",
      name: "existing-organization",
      ownership: "MANAGED_BY_CUSTOMER" as const,
      mutationPolicy: "READ_ONLY" as const,
      sourceOfTruth: "MANUAL" as const,
      metadata: {
        mock: true,
        assetKind: "CLOUD",
      },
    },
    {
      resourceId: "//orgpolicy.googleapis.com/organizations/123456789012/policies/iam.allowedPolicyMemberDomains",
      provider: "GCP" as const,
      resourceType: "orgpolicy.googleapis.com/Policy",
      name: "iam.allowedPolicyMemberDomains",
      ownership: "MANAGED_BY_CUSTOMER" as const,
      mutationPolicy: "READ_ONLY" as const,
      sourceOfTruth: "MANUAL" as const,
      metadata: {
        mock: true,
        assetKind: "CLOUD",
      },
    },
    {
      resourceId: "//cloudresourcemanager.googleapis.com/projects/sovereign-lz-dev",
      provider: "GCP" as const,
      resourceType: "cloudresourcemanager.googleapis.com/Project",
      name: "sovereign-lz-dev",
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
        key: "gcp.organization",
        value: "present",
        source: "mock",
      },
      {
        key: "gcp.org_policy",
        value: "present",
        source: "mock",
      },
    ],
    scannerObservations: [
      {
        id: "gcp-org-policy-baseline",
        scanner: "fixture-cloud-posture",
        source: "mock",
        status: "PASS",
        domain: "PLATFORM",
        severity: "INFO",
        title: "GCP organization policy baseline observed",
        detail:
          "The fixture contains an existing organization policy constraint.",
        resourceId:
          "//orgpolicy.googleapis.com/organizations/123456789012/policies/iam.allowedPolicyMemberDomains",
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
