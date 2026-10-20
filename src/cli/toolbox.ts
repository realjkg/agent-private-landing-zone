import { runGovernedTool } from "../tools/governed.js";
import { approvedToolDirs, resolveExecutable } from "../tools/child-env.js";
import { PLUGIN_CATALOG } from "../plugins/catalog.js";
import type { ToolName, ToolResult } from "../tools/types.js";

const context = {
  cwd: process.cwd(),
  allowCloudRead: false,
  allowMutation: false as const,
};

const checks: ToolName[] = [
  "terraform_version", "opentofu_version", "bicep_version",
  "cloudformation_version", "cdk_version", "ansible_version",
  "crossplane_version", "pulumi_version", "aws_version", "azure_version",
];

const labels: Partial<Record<ToolName, string>> = {
  terraform_version: "Terraform",
  opentofu_version: "OpenTofu",
  bicep_version: "Bicep",
  cloudformation_version: "CloudFormation",
  cdk_version: "AWS CDK",
  ansible_version: "Ansible",
  crossplane_version: "Crossplane",
  pulumi_version: "Pulumi",
  aws_version: "AWS CLI",
  azure_version: "Azure CLI",
};

const executable: Partial<Record<ToolName, string>> = {
  terraform_version: "terraform",
  opentofu_version: "tofu",
  bicep_version: "bicep",
  cloudformation_version: "aws",
  cdk_version: "cdk",
  ansible_version: "ansible-playbook",
  crossplane_version: "crossplane",
  pulumi_version: "pulumi",
  aws_version: "aws",
  azure_version: "az",
};

function displayVersion(tool: ToolName, output: string): string {
  if (tool === "azure_version") {
    try {
      const json = JSON.parse(output) as Record<string, unknown>;
      return "Azure CLI " + String(json["azure-cli"] ?? json["azure-cli-core"] ?? "available");
    } catch {
      return "Azure CLI available (version output unreadable)";
    }
  }
  return output.split("\n")[0] || "available";
}

console.log();
console.log("Agent Private Landing Zone");
console.log("────────────────────────────────");
console.log("TOOLBOX SELF-CHECK (actual local executables)");
console.log();

const approvedDirs = approvedToolDirs();
const missing: string[] = [];
for (const tool of checks) {
  const result = await runGovernedTool({ tool }, context);
  const primary: ToolResult = Array.isArray(result) ? result[0]! : result;
  const label = labels[tool] ?? tool;
  const binary = executable[tool];

  if (primary.ok) {
    const value = displayVersion(tool, primary.stdout.trim() || primary.stderr.trim());
    const plugin = PLUGIN_CATALOG.find(p => p.executable === binary);
    const tested = plugin?.testedVersion;
    const mismatch = tested && /^\d+\.\d+\.\d+$/.test(tested) && !value.includes(tested);
    console.log("✓ " + label.padEnd(15) + value + (mismatch ? "  (tested: " + tested + ")" : ""));
  } else {
    const available = binary ? resolveExecutable(binary, approvedDirs) : undefined;
    const message = primary.reason ?? primary.stderr.trim().split("\n")[0] ?? "";
    missing.push(label);
    console.log("! " + label.padEnd(15) + (available ? "found but unusable" : "not found in approved tool directories"));
    if (message) console.log("  " + message.slice(0, 230));
  }
}

if (missing.length) {
  console.log();
  console.log("Tools unavailable to this runtime: " + missing.join(", "));
  console.log("Run ./alz deps for pinned Terraform checks/installation and optional-tool guidance.");
  console.log("Install optional engines only when your selected blueprint needs them.");
  console.log("For other trusted binary locations, set ALZ_TOOL_DIRS to approved absolute directories.");
}

console.log();
console.log("Cloud read     DISABLED");
console.log("Preview write  DISABLED");
console.log("Project code   DISABLED");
console.log("Managed access DISABLED");
console.log("Cloud mutation DISABLED");
