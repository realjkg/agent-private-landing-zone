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
  | "aws_cloudformation"
  | "azure_deployment_stack"
  /** The GCP API-native engine's one call (path 6): the sealed Pub/Sub topic create or delete, in process; no program runs. */
  | "gcp_pubsub_topic"
  | "aws_sts_identity"
  | "aws_org_describe"
  | "aws_controltower_list_landing_zones"
  | "aws_controltower_list_landing_zone_operations"
  | "aws_controltower_get_landing_zone_operation"
  | "aws_org_list_scps"
  | "aws_config_recorders"
  | "aws_cloudtrail_trails"
  /** Read-only cost status reads (src/tools/aws-cost-reads.ts): Budgets, Data Exports, cost-allocation tags, unit tags. */
  | "aws_budgets_describe_budgets"
  | "aws_budgets_describe_notifications"
  | "aws_budgets_describe_subscribers"
  | "aws_bcm_list_exports"
  | "aws_bcm_get_export"
  | "aws_bcm_list_executions"
  | "aws_ce_list_cost_allocation_tags"
  | "aws_tagging_get_resources"
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
  /** Optional, validated AWS Control Tower operation UUID for read-only polling. */
  operationIdentifier?: string;
  /** Cost reads only (src/tools/aws-cost-reads.ts); each tool accepts exactly its own fields, validated there. */
  accountId?: string;
  budgetName?: string;
  notification?: BudgetNotificationKey;
  exportArn?: string;
  unitId?: string;
  region?: string;
  input?: AdapterInput;
};

/** One budget notification, as Budgets identifies it. The threshold is a plain decimal string, never a float. */
export type BudgetNotificationKey = {
  notificationType: "ACTUAL" | "FORECASTED";
  comparisonOperator: "GREATER_THAN" | "LESS_THAN" | "EQUAL_TO";
  threshold: string;
  thresholdType: "PERCENTAGE" | "ABSOLUTE_VALUE";
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
