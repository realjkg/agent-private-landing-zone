import { resolve } from "node:path";

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
  "pulumi_version",
  "pulumi_preview",
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

  if (
    workspace !== root &&
    !workspace.startsWith(root + "/")
  ) {
    return blocked(
      request,
      "Workspace escapes the allowed root.",
    );
  }

  if (
    (request.tool === "terraform_plan" ||
      request.tool === "pulumi_preview") &&
    !context.allowCloudRead
  ) {
    return blocked(
      request,
      "Preview requires explicit read-only cloud access.",
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
