import type { IaCEngine } from "../build/types.js";
import type { Provider } from "../discovery/types.js";
import type { AdapterInput } from "../iac/input.js";
import type {
  CompromiseState,
  SecurityPolicyDecision,
} from "../security/policy/types.js";

export type ToolName =
  | "terraform_version"
  | "terraform_fmt_check"
  | "terraform_validate"
  | "terraform_plan"
  | "opentofu_version"
  | "opentofu_fmt_check"
  | "opentofu_validate"
  | "opentofu_plan"
  | "bicep_version"
  | "bicep_lint"
  | "bicep_build"
  | "bicep_what_if"
  | "cloudformation_version"
  | "cloudformation_validate"
  | "cloudformation_preview"
  | "cdk_version"
  | "cdk_synth"
  | "cdk_preview"
  | "ansible_version"
  | "ansible_syntax_check"
  | "ansible_preview"
  | "crossplane_version"
  | "crossplane_validate"
  | "crossplane_preview"
  | "pulumi_version"
  | "pulumi_preview"
  | "aws_version"
  | "aws_sts_identity"
  | "aws_org_describe"
  | "aws_controltower_list_landing_zones"
  | "aws_org_list_scps"
  | "aws_config_recorders"
  | "aws_cloudtrail_trails"
  | "azure_version"
  | "azure_account_show"
  | "azure_management_groups"
  | "azure_policy_assignments"
  | "query_environment"
  | "show_evidence";

export type ToolRequest = {
  tool: ToolName;
  provider?: Provider;
  engine?: IaCEngine;
  workspace?: string;
  input?: AdapterInput;
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
  /** Output hit the size limit: the child was stopped and what is here is a prefix. */
  truncated?: boolean;
  /** Names (never values) of injected environment variables the runner refused. */
  refusedEnvironment?: string[];
};

export type ToolContext = {
  cwd: string;
  allowCloudRead: boolean;
  allowProjectCodeExecution?: boolean;
  allowPreviewWrite?: boolean;
  allowManagedAccess?: boolean;
  securityPolicyDecision?: SecurityPolicyDecision;
  compromiseState?: CompromiseState;
  allowMutation: false;
};
