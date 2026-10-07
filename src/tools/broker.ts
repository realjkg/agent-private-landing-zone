import {
  relative,
  resolve,
  sep,
} from "node:path";
import {
  runAllowlistedProcess,
} from "./process.js";

import {
  getIaCAdapter,
} from "../iac/index.js";
import {
  evaluateBuiltinSecurityPolicy,
} from "../security/policy/builtin.js";
import type {
  ToolContext,
  ToolRequest,
  ToolResult,
} from "./types.js";

const SAFE_TOOLS = new Set([
  "terraform_version",
  "terraform_fmt_check",
  "terraform_validate",
  "terraform_plan",
  "opentofu_version",
  "opentofu_fmt_check",
  "opentofu_validate",
  "opentofu_plan",
  "bicep_version",
  "bicep_lint",
  "bicep_build",
  "bicep_what_if",
  "cloudformation_version",
  "cloudformation_validate",
  "cloudformation_preview",
  "cdk_version",
  "cdk_synth",
  "cdk_preview",
  "ansible_version",
  "ansible_syntax_check",
  "ansible_preview",
  "crossplane_version",
  "crossplane_validate",
  "crossplane_preview",
  "pulumi_version",
  "pulumi_preview",
  "aws_version",
  "aws_sts_identity",
  "aws_org_describe",
  "aws_controltower_list_landing_zones",
  "aws_org_list_scps",
  "aws_config_recorders",
  "aws_cloudtrail_trails",
  "azure_version",
  "azure_account_show",
  "azure_management_groups",
  "azure_policy_assignments",
  "query_environment",
  "show_evidence",
]);

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

function adapterContext(
  context: ToolContext,
  cwd: string,
): ToolContext {
  return {
    ...context,
    cwd,
  };
}

export function executeTool(
  request: ToolRequest,
  context: ToolContext,
): ToolResult | ToolResult[] {
  if (!SAFE_TOOLS.has(request.tool)) {
    return blocked(
      request,
      "Tool is not on the allowlist.",
    );
  }

  if (
    process.env
      .AGENTIC_SECURITY_POLICY_MODE ===
      "OPA" &&
    !context.securityPolicyDecision
  ) {
    return blocked(
      request,
      "OPA policy mode requires a precomputed local policy decision.",
    );
  }

  if (
    context.securityPolicyDecision &&
    !context.securityPolicyDecision.allow
  ) {
    return blocked(
      request,
      context.securityPolicyDecision
        .reasons.join(" ") ||
        "Security policy denied tool execution.",
    );
  }

  const requestedCapabilities = [
    ...(context.allowCloudRead
      ? ["CLOUD_READ" as const]
      : []),
    ...(context.allowProjectCodeExecution
      ? [
          "PROJECT_CODE_EXECUTION" as const,
        ]
      : []),
    ...(context.allowPreviewWrite
      ? ["PREVIEW_WRITE" as const]
      : []),
    ...(context.allowManagedAccess
      ? ["MANAGED_ACCESS" as const]
      : []),
  ];

  const compromiseDecision =
    evaluateBuiltinSecurityPolicy({
      kind: "CAPABILITY",
      compromiseState:
        context.compromiseState ??
        "NORMAL",
      requested:
        requestedCapabilities,
    });

  if (!compromiseDecision.allow) {
    return blocked(
      request,
      compromiseDecision.reasons.join(
        " ",
      ),
    );
  }

  if (context.allowMutation !== false) {
    return blocked(
      request,
      "Mutation capability is prohibited.",
    );
  }

  const workspace = resolve(
    context.cwd,
    request.workspace ?? ".",
  );
  const root = resolve(context.cwd);
  const relation =
    relative(root, workspace);

  if (
    relation === ".." ||
    relation.startsWith(
      ".." + sep,
    )
  ) {
    return blocked(
      request,
      "Workspace escapes the allowed root.",
    );
  }

  const providerReadTool =
    (request.tool.startsWith("aws_") &&
      request.tool !== "aws_version") ||
    (request.tool.startsWith("azure_") &&
      request.tool !== "azure_version");

  const cloudReadTools = new Set([
    "terraform_plan",
    "opentofu_plan",
    "pulumi_preview",
    "bicep_what_if",
    "cloudformation_validate",
    "cloudformation_preview",
    "cdk_preview",
  ]);

  if (
    (cloudReadTools.has(
      request.tool,
    ) ||
      providerReadTool) &&
    !context.allowCloudRead
  ) {
    return blocked(
      request,
      "Preview requires explicit read-only cloud access.",
    );
  }

  if (
    (request.tool ===
      "cloudformation_preview" ||
      request.tool ===
        "cdk_preview") &&
    context.allowPreviewWrite !== true
  ) {
    return blocked(
      request,
      "This preview uses a temporary control-plane object and requires explicit preview-write capability.",
    );
  }

  if (
    [
      "pulumi_preview",
      "cdk_synth",
      "cdk_preview",
      "ansible_syntax_check",
      "ansible_preview",
      "crossplane_preview",
    ].includes(request.tool) &&
    context.allowProjectCodeExecution !==
      true
  ) {
    return blocked(
      request,
      "This tool loads project code or plug-ins. Explicit project-code execution capability is required.",
    );
  }

  if (
    request.tool ===
      "ansible_preview" &&
    context.allowManagedAccess !== true
  ) {
    return blocked(
      request,
      "Ansible preview may connect to managed hosts. Explicit managed-host access is required.",
    );
  }

  if (
    request.tool.startsWith(
      "aws_",
    )
  ) {
    const argsByTool: Partial<
      Record<
        ToolRequest["tool"],
        string[]
      >
    > = {
      aws_version: ["--version"],
      aws_sts_identity: [
        "sts",
        "get-caller-identity",
        "--output",
        "json",
      ],
      aws_org_describe: [
        "organizations",
        "describe-organization",
        "--output",
        "json",
      ],
      aws_controltower_list_landing_zones: [
        "controltower",
        "list-landing-zones",
        "--output",
        "json",
      ],
      aws_org_list_scps: [
        "organizations",
        "list-policies",
        "--filter",
        "SERVICE_CONTROL_POLICY",
        "--output",
        "json",
      ],
      aws_config_recorders: [
        "configservice",
        "describe-configuration-recorders",
        "--output",
        "json",
      ],
      aws_cloudtrail_trails: [
        "cloudtrail",
        "describe-trails",
        "--include-shadow-trails",
        "--output",
        "json",
      ],
    };

    const args =
      argsByTool[request.tool];

    if (!args) {
      return blocked(
        request,
        "Unsupported AWS read tool.",
      );
    }

    return runAllowlistedProcess(
      request.tool,
      "aws",
      args,
      workspace,
    );
  }

  if (
    request.tool.startsWith(
      "azure_",
    )
  ) {
    const argsByTool: Partial<
      Record<
        ToolRequest["tool"],
        string[]
      >
    > = {
      azure_version: [
        "version",
        "--output",
        "json",
      ],
      azure_account_show: [
        "account",
        "show",
        "--output",
        "json",
      ],
      azure_management_groups: [
        "account",
        "management-group",
        "list",
        "--output",
        "json",
      ],
      azure_policy_assignments: [
        "policy",
        "assignment",
        "list",
        "--output",
        "json",
      ],
    };

    const args =
      argsByTool[request.tool];

    if (!args) {
      return blocked(
        request,
        "Unsupported Azure read tool.",
      );
    }

    return runAllowlistedProcess(
      request.tool,
      "az",
      args,
      workspace,
    );
  }

  const ctx =
    adapterContext(
      context,
      workspace,
    );

  if (
    request.tool.startsWith(
      "terraform_",
    )
  ) {
    const adapter =
      getIaCAdapter(
        "TERRAFORM",
      );

    if (
      request.tool ===
      "terraform_version"
    ) {
      return adapter.version(ctx);
    }

    if (
      request.tool ===
        "terraform_fmt_check" ||
      request.tool ===
        "terraform_validate"
    ) {
      return adapter.validate(
        ctx,
        request.input,
      );
    }

    return adapter.preview(
      ctx,
      request.input,
    );
  }

  if (
    request.tool.startsWith(
      "opentofu_",
    )
  ) {
    const adapter =
      getIaCAdapter(
        "OPENTOFU",
      );

    if (
      request.tool ===
      "opentofu_version"
    ) {
      return adapter.version(ctx);
    }

    if (
      request.tool ===
        "opentofu_fmt_check" ||
      request.tool ===
        "opentofu_validate"
    ) {
      return adapter.validate(
        ctx,
        request.input,
      );
    }

    return adapter.preview(
      ctx,
      request.input,
    );
  }

  if (
    request.tool.startsWith(
      "bicep_",
    )
  ) {
    const adapter =
      getIaCAdapter("BICEP");

    if (
      request.tool ===
      "bicep_version"
    ) {
      return adapter.version(ctx);
    }

    if (
      request.tool ===
        "bicep_lint" ||
      request.tool ===
        "bicep_build"
    ) {
      return adapter.validate(
        ctx,
        request.input,
      );
    }

    return adapter.preview(
      ctx,
      request.input,
    );
  }

  if (
    request.tool.startsWith(
      "cloudformation_",
    )
  ) {
    const adapter =
      getIaCAdapter(
        "CLOUDFORMATION",
      );

    if (
      request.tool ===
      "cloudformation_version"
    ) {
      return adapter.version(ctx);
    }

    if (
      request.tool ===
      "cloudformation_validate"
    ) {
      return adapter.validate(
        ctx,
        request.input,
      );
    }

    return adapter.preview(
      ctx,
      request.input,
    );
  }

  if (
    request.tool.startsWith(
      "cdk_",
    )
  ) {
    const adapter =
      getIaCAdapter("AWS_CDK");

    if (
      request.tool ===
      "cdk_version"
    ) {
      return adapter.version(ctx);
    }

    if (
      request.tool ===
      "cdk_synth"
    ) {
      return adapter.validate(
        ctx,
        request.input,
      );
    }

    return adapter.preview(
      ctx,
      request.input,
    );
  }

  if (
    request.tool.startsWith(
      "ansible_",
    )
  ) {
    const adapter =
      getIaCAdapter("ANSIBLE");

    if (
      request.tool ===
      "ansible_version"
    ) {
      return adapter.version(ctx);
    }

    if (
      request.tool ===
      "ansible_syntax_check"
    ) {
      return adapter.validate(
        ctx,
        request.input,
      );
    }

    return adapter.preview(
      ctx,
      request.input,
    );
  }

  if (
    request.tool.startsWith(
      "crossplane_",
    )
  ) {
    const adapter =
      getIaCAdapter(
        "CROSSPLANE",
      );

    if (
      request.tool ===
      "crossplane_version"
    ) {
      return adapter.version(ctx);
    }

    if (
      request.tool ===
      "crossplane_validate"
    ) {
      return adapter.validate(
        ctx,
        request.input,
      );
    }

    return adapter.preview(
      ctx,
      request.input,
    );
  }

  if (
    request.tool.startsWith(
      "pulumi_",
    )
  ) {
    const adapter =
      getIaCAdapter("PULUMI");

    if (
      request.tool ===
      "pulumi_version"
    ) {
      return adapter.version(ctx);
    }

    return adapter.preview(
      ctx,
      request.input,
    );
  }

  return blocked(
    request,
    "State/evidence query tools are handled by the session layer.",
  );
}

export function getToolSecurityPosture(): {
  allowedTools: string[];
  mutationTools: string[];
  arbitraryShell: boolean;
  cloudReadDefault: boolean;
  projectCodeExecutionDefault: boolean;
  previewWriteDefault: boolean;
  managedAccessDefault: boolean;
} {
  const allowedTools =
    [...SAFE_TOOLS].sort();
  const mutationTokens =
    new Set([
      "apply",
      "destroy",
      "delete",
      "remove",
      "create",
      "update",
      "modify",
      "up",
      "exec",
      "shell",
      "bash",
      "provision",
      "deploy",
    ]);

  const mutationTools =
    allowedTools.filter(
      (tool) =>
        tool
          .toLowerCase()
          .split("_")
          .some(
            (token) =>
              mutationTokens.has(
                token,
              ),
          ),
    );

  return {
    allowedTools,
    mutationTools,
    arbitraryShell: false,
    cloudReadDefault: false,
    projectCodeExecutionDefault:
      false,
    previewWriteDefault: false,
    managedAccessDefault: false,
  };
}
