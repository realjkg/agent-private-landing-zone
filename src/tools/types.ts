import type { IaCEngine } from "../build/types.js";
import type { Provider } from "../discovery/types.js";

export type ToolName =
  | "terraform_version"
  | "terraform_fmt_check"
  | "terraform_validate"
  | "terraform_plan"
  | "pulumi_version"
  | "pulumi_preview"
  | "query_environment"
  | "show_evidence";

export type ToolRequest = {
  tool: ToolName;
  provider?: Provider;
  engine?: IaCEngine;
  workspace?: string;
};

export type ToolResult = {
  tool: ToolName;
  ok: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  command?: string[];
  blocked?: boolean;
  reason?: string;
};

export type ToolContext = {
  cwd: string;
  allowCloudRead: boolean;
  allowMutation: false;
};
