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

async function discoverAzureLive(): Promise<AzureDiscoveryResult> {
  const accountResult =
    runRead("azure_account_show");

  const account =
    parseJson<{
      id?: string;
      name?: string;
      tenantId?: string;
      environmentName?: string;
    }>(accountResult);

  if (!account?.id) {
    return {
      resources: [],
      evidence: [],
      ...emptyPosture,
      warnings: [
        "AZURE_IDENTITY_UNAVAILABLE: no authenticated read-only Azure subscription context could be established.",
      ],
    };
  }

  const managementGroupsResult =
    runRead(
      "azure_management_groups",
    );
  const policyAssignmentsResult =
    runRead(
      "azure_policy_assignments",
    );

  const managementGroups =
    parseJson<
      Array<{
        id?: string;
        name?: string;
        displayName?: string;
      }>
    >(managementGroupsResult);

  const policyAssignments =
    parseJson<
      Array<{
        id?: string;
        name?: string;
        displayName?: string;
        scope?: string;
        policyDefinitionId?: string;
      }>
    >(policyAssignmentsResult);

  const resources: DiscoveredResource[] = [
    {
      resourceId:
        "/subscriptions/" +
        account.id,
      provider: "AZURE",
      resourceType:
        "Microsoft.Resources/subscriptions",
      name:
        account.name ??
        account.id,
      ownership:
        "MANAGED_BY_CUSTOMER",
      mutationPolicy: "READ_ONLY",
      sourceOfTruth: "MANUAL",
      metadata: {
        assetKind: "CLOUD",
        tenantId: account.tenantId,
        environment:
          account.environmentName,
      },
    },
  ];

  const evidence: DiscoveryEvidence[] = [
    {
      key: "azure.identity",
      value: "authenticated",
      source: "azure-cli",
    },
  ];

  for (
    const [index, group] of
    (managementGroups ?? []).entries()
  ) {
    resources.push({
      resourceId:
        group.id ??
        "/providers/Microsoft.Management/managementGroups/" +
          (group.name ??
            String(index)),
      provider: "AZURE",
      resourceType:
        "Microsoft.Management/managementGroups",
      name:
        group.displayName ??
        group.name ??
        "management-group-" +
          index,
      ownership:
        "MANAGED_BY_CUSTOMER",
      mutationPolicy: "READ_ONLY",
      sourceOfTruth:
        "AZURE_POLICY",
      metadata: {
        assetKind: "CLOUD",
      },
    });
  }

  if (
    (managementGroups?.length ?? 0) >
    0
  ) {
    evidence.push({
      key:
        "azure.management_groups",
      value: "present",
      source: "azure-cli",
    });
  }

  for (
    const [index, assignment] of
    (policyAssignments ??
      []).entries()
  ) {
    resources.push({
      resourceId:
        assignment.id ??
        "azure:policy-assignment:" +
          index,
      provider: "AZURE",
      resourceType:
        "Microsoft.Authorization/policyAssignments",
      name:
        assignment.displayName ??
        assignment.name ??
        "policy-assignment-" +
          index,
      scope:
        assignment.scope,
      ownership:
        "MANAGED_BY_CUSTOMER",
      mutationPolicy: "READ_ONLY",
      sourceOfTruth:
        "AZURE_POLICY",
      metadata: {
        assetKind: "CLOUD",
        policyDefinitionId:
          assignment.policyDefinitionId,
      },
    });
  }

  if (
    (policyAssignments?.length ??
      0) > 0
  ) {
    evidence.push({
      key: "azure.policy",
      value: "present",
      source: "azure-cli",
    });
  }

  const scannerObservations:
    ScannerObservation[] = [];

  if (
    policyAssignmentsResult.ok
  ) {
    const count =
      policyAssignments?.length ??
      0;

    scannerObservations.push({
      id:
        "azure-policy-assignments",
      scanner:
        "azure-readonly-posture",
      source: "azure-cli",
      status:
        count > 0
          ? "PASS"
          : "UNKNOWN",
      domain: "PLATFORM",
      severity:
        count > 0
          ? "INFO"
          : "MEDIUM",
      title:
        count > 0
          ? "Azure Policy assignments observed"
          : "No Azure Policy assignments observed in accessible scope",
      detail:
        count > 0
          ? "At least one Azure Policy assignment is visible to the discovery identity."
          : "The accessible subscription scope returned no policy assignments; higher-scope assignments may still exist.",
    });
  } else {
    scannerObservations.push({
      id:
        "azure-policy-evidence",
      scanner:
        "azure-readonly-posture",
      source: "azure-cli",
      status: "UNKNOWN",
      domain: "PLATFORM",
      severity: "MEDIUM",
      title:
        "Azure Policy posture is not evidenced",
      detail:
        "The read-only discovery identity could not establish policy-assignment posture.",
    });
  }

  const warnings = [
    managementGroupsResult,
    policyAssignmentsResult,
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

export async function discoverAzure(
  mock?: MockScenario,
): Promise<AzureDiscoveryResult> {
  if (!mock) {
    return discoverAzureLive();
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
