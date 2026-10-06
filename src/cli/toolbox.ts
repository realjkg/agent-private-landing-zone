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
];

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
    tool === "terraform_version"
      ? "Terraform"
      : "Pulumi";

  if (primary.ok) {
    const value =
      primary.stdout.trim()
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
