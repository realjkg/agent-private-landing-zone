import {
  relative,
  resolve,
  sep,
} from "node:path";
import {
  runAllowlistedProcess,
} from "./process.js";

import { getIaCAdapter } from "../iac/index.js";
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

  if (context.allowMutation !== false) {
    return blocked(
      request,
      "Mutation capability is prohibited in MVP.",
    );
  }

  const workspace = resolve(
    context.cwd,
    request.workspace ?? ".",
  );
  const root = resolve(context.cwd);

  const workspaceRelation =
    relative(root, workspace);

  if (
    workspaceRelation === ".." ||
    workspaceRelation.startsWith(
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

  if (
    (request.tool === "terraform_plan" ||
      request.tool === "opentofu_plan" ||
      request.tool === "pulumi_preview" ||
      providerReadTool) &&
    !context.allowCloudRead
  ) {
    return blocked(
      request,
      "Preview requires explicit read-only cloud access.",
    );
  }

  if (request.tool.startsWith("aws_")) {
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

  if (
    request.tool.startsWith("terraform_")
  ) {
    const adapter =
      getIaCAdapter("TERRAFORM");

    if (request.tool === "terraform_version") {
      return adapter.version({
        ...context,
        cwd: workspace,
      });
    }

    if (
      request.tool === "terraform_fmt_check" ||
      request.tool === "terraform_validate"
    ) {
      return adapter.validate({
        ...context,
        cwd: workspace,
      });
    }

    return adapter.preview({
      ...context,
      cwd: workspace,
    });
  }

  if (
    request.tool.startsWith("opentofu_")
  ) {
    const adapter =
      getIaCAdapter("OPENTOFU");

    if (request.tool === "opentofu_version") {
      return adapter.version({
        ...context,
        cwd: workspace,
      });
    }

    if (
      request.tool === "opentofu_fmt_check" ||
      request.tool === "opentofu_validate"
    ) {
      return adapter.validate({
        ...context,
        cwd: workspace,
      });
    }

    return adapter.preview({
      ...context,
      cwd: workspace,
    });
  }

  if (
    request.tool.startsWith("pulumi_")
  ) {
    const adapter =
      getIaCAdapter("PULUMI");

    if (request.tool === "pulumi_version") {
      return adapter.version({
        ...context,
        cwd: workspace,
      });
    }

    return adapter.preview({
      ...context,
      cwd: workspace,
    });
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
} {
  const allowedTools = [...SAFE_TOOLS].sort();
  const mutationTokens = new Set([
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

  const mutationTools = allowedTools.filter(
    (tool) =>
      tool
        .toLowerCase()
        .split("_")
        .some(
          (token) =>
            mutationTokens.has(token),
        ),
  );

  return {
    allowedTools,
    mutationTools,
    arbitraryShell: false,
    cloudReadDefault: false,
  };
}
