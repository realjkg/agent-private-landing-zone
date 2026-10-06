import { enforceOwnershipPolicy } from "../../discovery/ownership.js";
import type {
  DiscoveredResource,
  DiscoveryEvidence,
  MockScenario,
  ResiliencyObservation,
  SbomComponentObservation,
  ScannerObservation,
} from "../../discovery/types.js";

export type AwsDiscoveryResult = {
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

export async function discoverAws(
  mock?: MockScenario,
): Promise<AwsDiscoveryResult> {
  if (!mock) {
    return {
      resources: [],
      evidence: [],
      ...emptyPosture,
      warnings: [
        "CREDENTIALS_MISSING: real AWS discovery is not enabled yet.",
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
          key: "aws.greenfield_confirmed",
          value: "true",
          source: "mock",
        },
      ],
      ...emptyPosture,
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
      metadata: {
        mock: true,
        assetKind: "CLOUD",
      },
    },
    {
      resourceId: "aws:controltower:landing-zone",
      provider: "AWS" as const,
      resourceType: "AWS::ControlTower::LandingZone",
      name: "existing-landing-zone",
      ownership: "MANAGED_BY_CUSTOMER" as const,
      mutationPolicy: "READ_ONLY" as const,
      sourceOfTruth: "CONTROL_TOWER" as const,
      metadata: {
        mock: true,
        assetKind: "CLOUD",
      },
    },
    {
      resourceId: "aws:iam:role:agent-execution",
      provider: "AWS" as const,
      resourceType: "AWS::IAM::Role",
      name: "agent-execution",
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
        key: "aws.organizations",
        value: "present",
        source: "mock",
      },
      {
        key: "aws.control_tower",
        value: "present",
        source: "mock",
      },
      {
        key: "aws.logging",
        value: "present",
        source: "mock",
      },
    ],
    scannerObservations: [
      {
        id: "aws-logging-baseline",
        scanner: "fixture-cloud-posture",
        source: "mock",
        status: "PASS",
        domain: "LOGGING",
        severity: "INFO",
        title: "Central logging observed",
        detail:
          "The fixture contains evidence for an existing landing-zone logging baseline.",
        resourceId:
          "aws:controltower:landing-zone",
      },
      {
        id: "aws-agent-role-boundary",
        scanner: "fixture-cloud-posture",
        source: "mock",
        status: "FAIL",
        domain: "IDENTITY",
        severity: "HIGH",
        title:
          "Execution-role permissions boundary is not evidenced",
        detail:
          "The accelerator-managed execution role exists, but the fixture does not prove an attached permissions boundary.",
        resourceId:
          "aws:iam:role:agent-execution",
      },
    ],
    sbomComponents: [
      {
        name: "agentic-landing-zone-runtime",
        version: "0.1.0",
        componentType: "PACKAGE",
        format: "CYCLONEDX",
        vulnerabilities: 0,
        evidenceRefs: [
          "mock:sbom-agent-runtime",
        ],
      },
      {
        name: "local-reasoning-models",
        componentType: "MODEL",
        format: "NATIVE",
        vulnerabilities: 0,
        evidenceRefs: [
          "mock:model-manifest",
        ],
      },
    ],
    sbomComplete: false,
    resiliencyObservations: [
      {
        key: "configuration_backup",
        value: "partial",
        source: "mock",
      },
      {
        key: "restore_test",
        value: "unverified",
        source: "mock",
      },
      {
        key: "redundant_control_plane",
        value: "present",
        source: "mock",
      },
      {
        key: "rpo",
        value: "unknown",
        source: "mock",
      },
      {
        key: "rto",
        value: "unknown",
        source: "mock",
      },
    ],
    warnings: [
      "SBOM_PARTIAL: attached/preexisting component coverage is incomplete.",
      "RESILIENCY_PARTIAL: configuration backup exists only partially and restore evidence is unverified.",
    ],
  };
}
