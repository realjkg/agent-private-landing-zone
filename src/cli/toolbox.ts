import { runGovernedTool } from "../tools/governed.js";
import type {
  ToolName,
  ToolResult,
} from "../tools/types.js";

const context = {
  cwd: process.cwd(),
  allowCloudRead: false,
  allowMutation: false as const,
};

const checks: ToolName[] = [
  "terraform_version",
  "opentofu_version",
  "bicep_version",
  "cloudformation_version",
  "cdk_version",
  "ansible_version",
  "crossplane_version",
  "pulumi_version",
  "aws_version",
  "azure_version",
];

const labels: Partial<
  Record<ToolName, string>
> = {
  terraform_version: "Terraform",
  opentofu_version: "OpenTofu",
  bicep_version: "Bicep",
  cloudformation_version:
    "CloudFormation",
  cdk_version: "AWS CDK",
  ansible_version: "Ansible",
  crossplane_version: "Crossplane",
  pulumi_version: "Pulumi",
  aws_version: "AWS CLI",
  azure_version: "Azure CLI",
};

console.log();
console.log("Agent Private Landing Zone");
console.log("────────────────────────────────");
console.log("TOOLBOX SELF-CHECK (actual local executables)");
console.log();

const approvedDirs = approvedToolDirs();\nconst binaryByTool: Partial<Record<ToolName, string>> = {\n  terraform_version: "terraform", opentofu_version: "tofu", bicep_version: "bicep",\n  cloudformation_version: "aws", cdk_version: "cdk", ansible_version: "ansible-playbook",\n  crossplane_version: "crossplane", pulumi_version: "pulumi", aws_version: "aws", azure_version: "az"\n};\nconst missing: string[] = [];\nfor (const tool of checks) {
  const result =
    await runGovernedTool(
      { tool },
      context,
    );

  const rows =
    Array.isArray(result)
      ? result
      : [result];

  const primary =
    rows[0] as ToolResult;

  const label =
    labels[tool] ?? tool;

  if (primary.ok) {
    const versionText =
      primary.stdout.trim() ||
      primary.stderr.trim();

    const value =
      versionText
        .split("\n")[0] ||
      "available";

    console.log(
      "✓ " +
        label.padEnd(12) +
        value,
    );
  } else {
    console.log(
      "! " +
        label.padEnd(12) +
        "not available",
    );
  }
}

console.log();
console.log(
  "Cloud read     DISABLED",
);
console.log(
  "Preview write  DISABLED",
);
console.log(
  "Project code   DISABLED",
);
console.log(
  "Managed access DISABLED",
);
console.log(
  "Cloud mutation DISABLED",
);
