import { executeTool } from "../tools/broker.js";
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
  "pulumi_version",
  "aws_version",
  "azure_version",
];

const labels: Partial<
  Record<ToolName, string>
> = {
  terraform_version: "Terraform",
  pulumi_version: "Pulumi",
  aws_version: "AWS CLI",
  azure_version: "Azure CLI",
};

console.log();
console.log("Agentic Landing Zone");
console.log("────────────────────────────────");
console.log("TOOLBOX SELF-CHECK");
console.log();

for (const tool of checks) {
  const result =
    executeTool(
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
  "Cloud mutation DISABLED",
);
