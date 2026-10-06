import { enforceOwnershipPolicy } from "../../discovery/ownership.js";
import type {
  DiscoveredResource,
  DiscoveryEvidence,
  MockScenario,
  ResiliencyObservation,
  SbomComponentObservation,
  ScannerObservation,
} from "../../discovery/types.js";
import {
  executeTool,
} from "../../tools/broker.js";
import type {
  ToolName,
  ToolResult,
} from "../../tools/types.js";

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

function runRead(
  tool: ToolName,
): ToolResult {
  const result = executeTool(
    { tool },
    {
      cwd: process.cwd(),
      allowCloudRead: true,
      allowMutation: false,
    },
  );

  return Array.isArray(result)
    ? result[0]
    : result;
}

function parseJson<T>(
  result: ToolResult,
): T | undefined {
  if (!result.ok) {
    return undefined;
  }

  try {
    return JSON.parse(
      result.stdout,
    ) as T;
  } catch {
    return undefined;
  }
}

function readWarning(
  tool: ToolName,
  result: ToolResult,
): string | undefined {
  if (result.ok) {
    return undefined;
  }

  return (
    "DISCOVERY_PARTIAL: " +
    tool +
    " was unavailable or not permitted."
  );
}

async function discoverAwsLive(): Promise<AwsDiscoveryResult> {
  const identityResult =
    runRead("aws_sts_identity");

  const identity =
    parseJson<{
      Account?: string;
      Arn?: string;
      UserId?: string;
    }>(identityResult);

  if (!identity?.Account) {
    return {
      resources: [],
      evidence: [],
      ...emptyPosture,
      warnings: [
        "AWS_IDENTITY_UNAVAILABLE: no authenticated read-only AWS identity could be established.",
      ],
    };
  }

  const [
    organizationResult,
    controlTowerResult,
    scpResult,
    configResult,
    cloudTrailResult,
  ] = [
    runRead("aws_org_describe"),
    runRead(
      "aws_controltower_list_landing_zones",
    ),
    runRead("aws_org_list_scps"),
    runRead("aws_config_recorders"),
    runRead("aws_cloudtrail_trails"),
  ];

  const organization =
    parseJson<{
      Organization?: {
        Id?: string;
        Arn?: string;
        MasterAccountId?: string;
        ManagementAccountId?: string;
      };
    }>(organizationResult);

  const controlTower =
    parseJson<{
      landingZones?: Array<{
        arn?: string;
        status?: string;
      }>;
    }>(controlTowerResult);

  const scps =
    parseJson<{
      Policies?: Array<{
        Id?: string;
        Name?: string;
        Type?: string;
      }>;
    }>(scpResult);

  const config =
    parseJson<{
      ConfigurationRecorders?: Array<{
        name?: string;
        roleARN?: string;
      }>;
    }>(configResult);

  const cloudTrail =
    parseJson<{
      trailList?: Array<{
        TrailARN?: string;
        Name?: string;
        HomeRegion?: string;
        IsOrganizationTrail?: boolean;
        KmsKeyId?: string;
      }>;
    }>(cloudTrailResult);

  const resources: DiscoveredResource[] = [
    {
      resourceId:
        "aws:account:" +
        identity.Account,
      provider: "AWS",
      resourceType:
        "AWS::Organizations::Account",
      name:
        "account-" +
        identity.Account,
      ownership:
        "MANAGED_BY_CUSTOMER",
      mutationPolicy: "READ_ONLY",
      sourceOfTruth: "MANUAL",
      metadata: {
        assetKind: "CLOUD",
        callerArn: identity.Arn,
      },
    },
  ];

  const evidence: DiscoveryEvidence[] = [
    {
      key: "aws.identity",
      value: "authenticated",
      source: "aws-cli",
    },
  ];

  if (
    organization?.Organization?.Id
  ) {
    resources.push({
      resourceId:
        "aws:organizations:" +
        organization.Organization.Id,
      provider: "AWS",
      resourceType:
        "AWS::Organizations::Organization",
      name:
        organization.Organization.Id,
      ownership:
        "MANAGED_BY_CUSTOMER",
      mutationPolicy: "READ_ONLY",
      sourceOfTruth: "MANUAL",
      metadata: {
        assetKind: "CLOUD",
      },
    });

    evidence.push({
      key: "aws.organizations",
      value: "present",
      source: "aws-cli",
    });
  }

  for (
    const [index, landingZone] of
    (controlTower?.landingZones ?? []).entries()
  ) {
    resources.push({
      resourceId:
        landingZone.arn ??
        "aws:controltower:landing-zone:" +
          index,
      provider: "AWS",
      resourceType:
        "AWS::ControlTower::LandingZone",
      name:
        landingZone.arn ??
        "landing-zone-" + index,
      ownership:
        "MANAGED_BY_CUSTOMER",
      mutationPolicy: "READ_ONLY",
      sourceOfTruth:
        "CONTROL_TOWER",
      metadata: {
        assetKind: "CLOUD",
        status: landingZone.status,
      },
    });
  }

  if (
    (controlTower?.landingZones
      ?.length ?? 0) > 0
  ) {
    evidence.push({
      key: "aws.control_tower",
      value: "present",
      source: "aws-cli",
    });
  }

  for (
    const policy of
    scps?.Policies ?? []
  ) {
    if (!policy.Id) {
      continue;
    }

    resources.push({
      resourceId:
        "aws:organizations:scp:" +
        policy.Id,
      provider: "AWS",
      resourceType:
        "AWS::Organizations::Policy",
      name:
        policy.Name ??
        policy.Id,
      ownership:
        "MANAGED_BY_CUSTOMER",
      mutationPolicy: "READ_ONLY",
      sourceOfTruth: "MANUAL",
      metadata: {
        assetKind: "CLOUD",
        policyType: policy.Type,
      },
    });
  }

  if (
    (scps?.Policies?.length ?? 0) >
    0
  ) {
    evidence.push({
      key: "aws.scp",
      value: "present",
      source: "aws-cli",
    });
  }

  for (
    const recorder of
    config?.ConfigurationRecorders ??
    []
  ) {
    resources.push({
      resourceId:
        "aws:config:recorder:" +
        (recorder.name ??
          "default"),
      provider: "AWS",
      resourceType:
        "AWS::Config::ConfigurationRecorder",
      name:
        recorder.name ??
        "config-recorder",
      ownership:
        "MANAGED_BY_CUSTOMER",
      mutationPolicy: "READ_ONLY",
      sourceOfTruth: "MANUAL",
      metadata: {
        assetKind: "CLOUD",
      },
    });
  }

  for (
    const [index, trail] of
    (cloudTrail?.trailList ?? []).entries()
  ) {
    resources.push({
      resourceId:
        trail.TrailARN ??
        "aws:cloudtrail:trail:" +
          index,
      provider: "AWS",
      resourceType:
        "AWS::CloudTrail::Trail",
      name:
        trail.Name ??
        "trail-" + index,
      region:
        trail.HomeRegion,
      ownership:
        "MANAGED_BY_CUSTOMER",
      mutationPolicy: "READ_ONLY",
      sourceOfTruth: "MANUAL",
      metadata: {
        assetKind: "CLOUD",
        organizationTrail:
          trail.IsOrganizationTrail ??
          false,
        kmsKeyObserved:
          Boolean(trail.KmsKeyId),
      },
    });
  }

  const scannerObservations:
    ScannerObservation[] = [];

  if (configResult.ok) {
    const count =
      config?.ConfigurationRecorders
        ?.length ?? 0;

    scannerObservations.push({
      id: "aws-config-recorder",
      scanner:
        "aws-readonly-posture",
      source: "aws-cli",
      status:
        count > 0 ? "PASS" : "FAIL",
      domain: "CONFIGURATION",
      severity:
        count > 0
          ? "INFO"
          : "MEDIUM",
      title:
        count > 0
          ? "AWS Config recorder observed"
          : "No AWS Config recorder observed",
      detail:
        count > 0
          ? "At least one configuration recorder is visible in the accessible account scope."
          : "The accessible account scope returned no AWS Config configuration recorder.",
    });
  } else {
    scannerObservations.push({
      id:
        "aws-config-recorder-evidence",
      scanner:
        "aws-readonly-posture",
      source: "aws-cli",
      status: "UNKNOWN",
      domain: "CONFIGURATION",
      severity: "MEDIUM",
      title:
        "AWS Config posture is not evidenced",
      detail:
        "The read-only discovery identity could not establish AWS Config recorder posture.",
    });
  }

  if (cloudTrailResult.ok) {
    const count =
      cloudTrail?.trailList
        ?.length ?? 0;

    scannerObservations.push({
      id: "aws-cloudtrail",
      scanner:
        "aws-readonly-posture",
      source: "aws-cli",
      status:
        count > 0 ? "PASS" : "FAIL",
      domain: "LOGGING",
      severity:
        count > 0
          ? "INFO"
          : "HIGH",
      title:
        count > 0
          ? "CloudTrail trail observed"
          : "No CloudTrail trail observed",
      detail:
        count > 0
          ? "At least one CloudTrail trail is visible, including shadow trails where the CLI returned them."
          : "The accessible account scope returned no CloudTrail trails.",
    });
  } else {
    scannerObservations.push({
      id:
        "aws-cloudtrail-evidence",
      scanner:
        "aws-readonly-posture",
      source: "aws-cli",
      status: "UNKNOWN",
      domain: "LOGGING",
      severity: "MEDIUM",
      title:
        "CloudTrail posture is not evidenced",
      detail:
        "The read-only discovery identity could not establish CloudTrail posture.",
    });
  }

  const warnings = [
    organizationResult,
    controlTowerResult,
    scpResult,
    configResult,
    cloudTrailResult,
  ]
    .map((result) =>
      readWarning(
        result.tool,
        result,
      ),
    )
    .filter(
      (warning):
        warning is string =>
          Boolean(warning),
    );

  warnings.push(
    "SBOM_UNKNOWN: attach a CycloneDX/SPDX SBOM or scanner evidence to assess software and attached component supply-chain posture.",
  );
  warnings.push(
    "RESILIENCY_UNKNOWN: provider-native configuration backup and restore proof are not yet established by read-only discovery.",
  );

  return {
    resources:
      resources.map(
        enforceOwnershipPolicy,
      ),
    evidence,
    scannerObservations,
    sbomComponents: [],
    sbomComplete: false,
    resiliencyObservations: [],
    warnings,
  };
}

export async function discoverAws(
  mock?: MockScenario,
): Promise<AwsDiscoveryResult> {
  if (!mock) {
    return discoverAwsLive();
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
    {
      resourceId: "edge:appliance:secure-node-01",
      provider: "AWS" as const,
      resourceType: "EDGE::PhysicalAppliance",
      name: "secure-edge-node-01",
      ownership: "EXTERNAL" as const,
      mutationPolicy: "READ_ONLY" as const,
      sourceOfTruth: "MANUAL" as const,
      metadata: {
        mock: true,
        assetKind: "PHYSICAL",
        attachedToLandingZone: true,
      },
    },
    {
      resourceId: "edge:virtual:security-gateway-01",
      provider: "AWS" as const,
      resourceType: "EDGE::VirtualAppliance",
      name: "security-gateway-01",
      ownership: "MANAGED_BY_CUSTOMER" as const,
      mutationPolicy: "READ_ONLY" as const,
      sourceOfTruth: "MANUAL" as const,
      metadata: {
        mock: true,
        assetKind: "VIRTUAL",
        attachedToLandingZone: true,
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
        id: "edge-secure-boot-evidence",
        scanner: "fixture-edge-posture",
        source: "mock",
        status: "UNKNOWN",
        domain: "PLATFORM",
        severity: "MEDIUM",
        title:
          "Physical edge appliance boot integrity is not evidenced",
        detail:
          "The attached appliance is visible in inventory, but secure-boot or device-attestation evidence was not supplied.",
        resourceId:
          "edge:appliance:secure-node-01",
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
      {
        name: "secure-edge-node-firmware",
        componentType: "FIRMWARE",
        format: "UNKNOWN",
        vulnerabilities: 1,
        evidenceRefs: [
          "mock:edge-firmware-inventory",
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
