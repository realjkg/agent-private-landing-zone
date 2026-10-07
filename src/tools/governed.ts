import {
  emitDebugDiagnostic,
} from "../debug/context.js";
import type {
  SovereignCapability,
} from "../orchestration/types.js";
import type {
  CompromiseState,
  DataClassification,
  EgressDestination,
  SecurityPolicyDecision,
  SecurityPolicyEvaluator,
} from "../security/policy/types.js";
import {
  executeTool,
} from "./broker.js";
import type {
  ToolContext,
  ToolRequest,
  ToolResult,
} from "./types.js";

function blocked(
  request: ToolRequest,
  reason: string,
): ToolResult {
  return {
    tool: request.tool,
    ok: false,
    exitCode: null,
    stdout: "",
    stderr: "",
    durationMs: 0,
    blocked: true,
    reason,
  };
}

function requiredCapabilities(
  request: ToolRequest,
  context: ToolContext,
): SovereignCapability[] {
  const result:
    SovereignCapability[] = [];

  if (context.allowCloudRead) {
    result.push("CLOUD_READ");
  }

  if (
    context.allowProjectCodeExecution
  ) {
    result.push(
      "PROJECT_CODE_EXECUTION",
    );
  }

  if (
    context.allowPreviewWrite
  ) {
    result.push("PREVIEW_WRITE");
  }

  if (
    context.allowManagedAccess
  ) {
    result.push("MANAGED_ACCESS");
  }

  if (
    request.tool ===
      "show_evidence" ||
    request.tool ===
      "query_environment"
  ) {
    result.push("EVIDENCE_READ");
  }

  return [
    ...new Set(result),
  ];
}

function egressDestination(
  request: ToolRequest,
): EgressDestination | undefined {
  if (
    request.tool.startsWith(
      "aws_",
    ) &&
    request.tool !== "aws_version"
  ) {
    return {
      scheme: "https",
      host: "aws-control-plane",
      purpose:
        "AWS read-only control-plane access",
    };
  }

  if (
    request.tool.startsWith(
      "azure_",
    ) &&
    request.tool !== "azure_version"
  ) {
    return {
      scheme: "https",
      host: "azure-control-plane",
      purpose:
        "Azure read-only control-plane access",
    };
  }

  if (
    [
      "terraform_plan",
      "opentofu_plan",
      "pulumi_preview",
      "bicep_what_if",
      "cloudformation_validate",
      "cloudformation_preview",
      "cdk_preview",
    ].includes(request.tool)
  ) {
    return {
      scheme: "https",
      host:
        request.provider ===
        "AZURE"
          ? "azure-control-plane"
          : "aws-control-plane",
      purpose:
        "IaC preview control-plane access",
    };
  }

  return undefined;
}

function combine(
  decisions:
    SecurityPolicyDecision[],
): SecurityPolicyDecision {
  const denied =
    decisions.filter(
      (item) => !item.allow,
    );

  return {
    allow:
      denied.length === 0,
    reasons: [
      ...new Set(
        decisions.flatMap(
          (item) =>
            item.reasons,
        ),
      ),
    ],
    obligations: [
      ...new Set(
        decisions.flatMap(
          (item) =>
            item.obligations,
        ),
      ),
    ],
    source:
      decisions.some(
        (item) =>
          item.source === "OPA",
      )
        ? "OPA"
        : "BUILTIN",
    decisionId:
      decisions
        .map(
          (item) =>
            item.decisionId,
        )
        .find(Boolean),
  };
}

export async function executeGovernedTool(
  request: ToolRequest,
  context: ToolContext,
  options: {
    evaluator:
      SecurityPolicyEvaluator;
    compromiseState:
      CompromiseState;
    classification:
      DataClassification;
    allowedEgressHosts: string[];
  },
): Promise<
  ToolResult | ToolResult[]
> {
  const decisions:
    SecurityPolicyDecision[] = [];

  const capabilities =
    requiredCapabilities(
      request,
      context,
    );

  if (
    capabilities.length > 0
  ) {
    decisions.push(
      await options.evaluator.evaluate(
        {
          kind: "CAPABILITY",
          compromiseState:
            options
              .compromiseState,
          requested:
            capabilities,
        },
      ),
    );
  }

  const destination =
    egressDestination(request);

  if (destination) {
    decisions.push(
      await options.evaluator.evaluate(
        {
          kind: "EGRESS",
          classification:
            options
              .classification,
          destination,
          allowedHosts:
            options
              .allowedEgressHosts,
        },
      ),
    );
  }

  const composite:
    SecurityPolicyDecision =
    decisions.length > 0
      ? combine(decisions)
      : {
          allow: true,
          reasons: [],
          obligations: [],
          source:
            "BUILTIN" as const,
        };

  emitDebugDiagnostic({
    kind: "POLICY",
    component:
      "governed-tool-policy",
    status: composite.allow
      ? "OK"
      : "BLOCKED",
    decisionId:
      composite.decisionId,
    detail:
      composite.reasons.join(
        " ",
      ),
    attributes: {
      tool: request.tool,
      source:
        composite.source,
      capabilities,
      obligations:
        composite.obligations,
      compromiseState:
        options.compromiseState,
      classification:
        options.classification,
      egressHost:
        destination?.host,
    },
  });

  if (!composite.allow) {
    return blocked(
      request,
      composite.reasons.join(
        " ",
      ) ||
        "Security policy denied tool execution.",
    );
  }

  return executeTool(
    request,
    {
      ...context,
      securityPolicyDecision:
        composite,
      compromiseState:
        options.compromiseState,
    },
  );
}
