import type { ToolName, ToolResult } from "./types.js";

/**
 * Tools that run code the project (or its providers) supplies. A Terraform or
 * OpenTofu plan loads provider binaries, evaluates `external` data sources and
 * module code, and reads cloud state; it is not static inspection. Static
 * inspection (`version`, `fmt_check`, `validate`) stays available without the
 * capability. See docs/identity-and-execution-contracts.md.
 */
export const PROJECT_CODE_TOOLS: ReadonlySet<ToolName> = new Set<ToolName>([
  "terraform_plan",
  "opentofu_plan",
  "pulumi_preview",
  "cdk_synth",
  "cdk_preview",
  "ansible_syntax_check",
  "ansible_preview",
  "crossplane_preview",
]);

const ENGINE_PLAN_DENIAL =
  " runs provider and module code, so it needs the PROJECT_CODE_EXECUTION capability " +
  "(allowProjectCodeExecution). That capability is a separate approval from cloud read, and it " +
  "never permits changing infrastructure: apply and destroy stay unavailable either way. " +
  "Static checks (version, fmt-check, validate) do not need it.";

/** Why a project-code tool was denied, in terms of what the operator can do about it. */
export function projectCodeDenial(tool: ToolName): string {
  if (tool === "terraform_plan" || tool === "opentofu_plan") {
    return "Project-code execution is required: " + tool + ENGINE_PLAN_DENIAL;
  }
  return "This tool loads project code or plug-ins. Explicit project-code execution capability is required.";
}

export function planBlocked(tool: "terraform_plan" | "opentofu_plan"): ToolResult {
  return {
    tool, ok: false, exitCode: null, stdout: "", stderr: "", durationMs: 0,
    blocked: true, reason: projectCodeDenial(tool),
  };
}
