import {
  emitDebugDiagnostic,
} from "../debug/context.js";
import {
  createSecurityPolicyEvaluator,
} from "../security/policy/engine.js";
import type {
  Emitter,
} from "../observability/bus.js";
import type {
  SovereignCapability,
} from "../orchestration/types.js";
import type {
  OpaPolicyOptions,
} from "../security/policy/opa.js";
import type {
  SecurityPolicyMode,
} from "../security/policy/engine.js";
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
    /**
     * Consult the evaluator even when the request needs no capability or
     * egress check, so an external decision point is never bypassed.
     */
    requireDecision?: boolean;
    /** Process observability bus; defaults to disabled (no emission). */
    emitter?: Emitter;
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

  if (
    decisions.length === 0 &&
    options.requireDecision
  ) {
    decisions.push(
      await options.evaluator.evaluate(
        {
          kind: "CAPABILITY",
          compromiseState:
            options
              .compromiseState,
          requested: [],
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
    options.emitter?.emit({
      signal: "policy-denials",
      status: "BLOCKED",
      component: "governed-tool",
      detail:
        composite.reasons.join(" ") ||
        "Security policy denied tool execution.",
      attributes: {
        tool: request.tool,
        source: composite.source,
      },
    });
    return blocked(
      request,
      composite.reasons.join(
        " ",
      ) ||
        "Security policy denied tool execution.",
    );
  }

  try {
    const results =
      await executeTool(
        request,
        {
          ...context,
          securityPolicyDecision:
            composite,
          compromiseState:
            options.compromiseState,
        },
      );

    // Real adapter failures: commands that ran and failed. Policy refusals
    // (blocked: true) are policy-denials, not adapter failures, and are
    // excluded here; thrown errors keep the rethrow path below.
    const failures = Array.isArray(results)
      ? results.filter(
          (item) => !item.ok && !item.blocked,
        )
      : !results.ok && !results.blocked
        ? [results]
        : [];

    for (const failure of failures) {
      options.emitter?.emit({
        signal: "adapter-failures",
        status: "FAILED",
        component: "governed-tool",
        detail:
          failure.reason ??
          failure.stderr.slice(0, 200) ??
          "adapter command failed",
        attributes: {
          tool: failure.tool,
          exitCode: failure.exitCode,
        },
      });
    }

    return results;
  } catch (error) {
    // Real adapter/tool failure on the governed path: report it, then
    // rethrow unchanged — the governed command still fails as before.
    options.emitter?.emit({
      signal: "adapter-failures",
      status: "FAILED",
      component: "governed-tool",
      detail:
        error instanceof Error
          ? error.message
          : "unknown tool failure",
      attributes: {
        tool: request.tool,
      },
    });
    throw error;
  }
}

const OPA_UNAVAILABLE_HINT =
  " AGENTIC_SECURITY_POLICY_MODE=OPA requires a reachable local OPA server with the policy bundle loaded (default http://127.0.0.1:8181, see policy/opa); start it, or unset the variable to use the BUILTIN policy.";

// The control-plane labels egressDestination() can produce; OPA still
// decides whether each one is allowed.
const CONTROL_PLANE_HOSTS = [
  "aws-control-plane",
  "azure-control-plane",
];

/**
 * The single production entry to the tool broker. BUILTIN (the default)
 * leaves the broker call untouched because the broker already applies the
 * built-in policy. OPA mode computes the decision locally through the
 * governed path and fails closed on a bad mode, an unavailable or invalid
 * decision point, or a denial.
 */
export async function runGovernedTool(
  request: ToolRequest,
  context: ToolContext,
  options: {
    opa?: OpaPolicyOptions;
    emitter?: Emitter;
  } = {},
): Promise<ToolResult | ToolResult[]> {
  let evaluator: SecurityPolicyEvaluator;
  let mode: string | undefined;

  try {
    mode =
      process.env
        .AGENTIC_SECURITY_POLICY_MODE;
    evaluator =
      createSecurityPolicyEvaluator(
        mode as SecurityPolicyMode | undefined,
        options.opa,
      );
  } catch (error) {
    return blocked(
      request,
      error instanceof Error
        ? error.message
        : "SECURITY_POLICY_MODE_INVALID: AGENTIC_SECURITY_POLICY_MODE must be BUILTIN or OPA.",
    );
  }

  if (mode !== "OPA") {
    return executeTool(request, context);
  }

  const opa = evaluator;
  const actionable: SecurityPolicyEvaluator = {
    async evaluate(input) {
      const decision =
        await opa.evaluate(input);

      return !decision.allow &&
        decision.reasons.some(
          (reason) =>
            reason.startsWith(
              "OPA decision",
            ),
        )
        ? {
            ...decision,
            reasons: [
              ...decision.reasons,
              OPA_UNAVAILABLE_HINT.trim(),
            ],
          }
        : decision;
    },
  };

  return executeGovernedTool(
    request,
    context,
    {
      evaluator: actionable,
      compromiseState:
        context.compromiseState ??
        "NORMAL",
      classification: "INTERNAL",
      allowedEgressHosts:
        CONTROL_PLANE_HOSTS,
      requireDecision: true,
      emitter: options.emitter,
    },
  );
}
