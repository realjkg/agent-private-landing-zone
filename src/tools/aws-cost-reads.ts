import type { ToolName, ToolRequest } from "./types.js";

/**
 * The read-only AWS cost reads the broker runs (plan item 4, owner direction 2026-10-31, issue #39 comment 6536926009).
 *
 * Each tool is one fixed AWS CLI call, built from constants and from request fields that pass an exact pattern; there is no
 * wildcard, no free-form flag and no shell. Budgets, Cost Explorer and Data Exports are answered by their us-east-1
 * endpoint, so those calls name it; the tagging API is regional and takes the caller's validated region. The IAM actions
 * these calls need are the `costStatus` and `independentObservation` allows in bootstrap/aws/discovery-policy.json.
 */
export const AWS_COST_READ_TOOLS = [
  "aws_budgets_describe_budgets",
  "aws_budgets_describe_notifications",
  "aws_budgets_describe_subscribers",
  "aws_bcm_list_exports",
  "aws_bcm_get_export",
  "aws_bcm_list_executions",
  "aws_ce_list_cost_allocation_tags",
  "aws_tagging_get_resources",
] as const satisfies readonly ToolName[];
export type AwsCostReadTool = (typeof AWS_COST_READ_TOOLS)[number];

/**
 * The deletion unit's tag key. The broker's modules never import the deletion-unit module (a boundary test pins that), so
 * the key is written here, and test/aws-cost-reads.test.ts pins it to ALZ_TAG_KEYS.unit.
 */
export const UNIT_TAG_KEY = "alz-unit";

/** Budgets, Cost Explorer and Data Exports are global services answered in us-east-1. */
export const COST_SERVICE_REGION = "us-east-1";

const ACCOUNT = /^[0-9]{12}$/;
/** A budget name as this product renders one: no colon, backslash, comma, equals sign or leading dash, at most 100 characters. */
const BUDGET_NAME = /^[A-Za-z0-9][A-Za-z0-9 _.()@+-]{0,99}$/;
const EXPORT_ARN = /^arn:aws:bcm-data-exports:us-east-1:[0-9]{12}:export\/[A-Za-z0-9_-]{1,200}$/;
const REGION = /^[a-z]{2}(-[a-z]+)+-[0-9]$/;
/** The same value shape the verifier's tag filter accepts (src/observe/aws-cli.ts). */
const UNIT_ID = /^[A-Za-z0-9._:/+@-]{1,256}$/;
/** A threshold as Budgets stores it: a plain non-negative decimal, at most 15 digits before and 6 after the point. */
const THRESHOLD = /^(0|[1-9][0-9]{0,14})(\.[0-9]{1,6})?$/;

const NOTIFICATION_TYPES = new Set(["ACTUAL", "FORECASTED"]);
const COMPARISONS = new Set(["GREATER_THAN", "LESS_THAN", "EQUAL_TO"]);
const THRESHOLD_TYPES = new Set(["PERCENTAGE", "ABSOLUTE_VALUE"]);

/** The request fields each cost tool takes. Every other parameter field on the request is refused for that tool. */
const FIELDS: Record<AwsCostReadTool, readonly CostField[]> = {
  aws_budgets_describe_budgets: ["accountId"],
  aws_budgets_describe_notifications: ["accountId", "budgetName"],
  aws_budgets_describe_subscribers: ["accountId", "budgetName", "notification"],
  aws_bcm_list_exports: [],
  aws_bcm_get_export: ["exportArn"],
  aws_bcm_list_executions: ["exportArn"],
  aws_ce_list_cost_allocation_tags: [],
  aws_tagging_get_resources: ["unitId", "region"],
};
type CostField = "accountId" | "budgetName" | "notification" | "exportArn" | "unitId" | "region";
/** Every parameter field a ToolRequest may carry, including the Control Tower one, so a cost tool refuses it too. */
const PARAMETER_FIELDS = ["accountId", "budgetName", "notification", "exportArn", "unitId", "region", "operationIdentifier"] as const;

export const isAwsCostReadTool = (tool: string): tool is AwsCostReadTool => (AWS_COST_READ_TOOLS as readonly string[]).includes(tool);

/** True when a request that is not a cost tool carries a cost parameter: the broker refuses it. */
export const carriesCostParameter = (request: ToolRequest): boolean =>
  (["accountId", "budgetName", "notification", "exportArn", "unitId", "region"] as const).some((field) => request[field] !== undefined);

/** Budgets' shorthand for one notification, from validated parts only. */
function notificationShorthand(value: unknown): string | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const n = value as Record<string, unknown>;
  const keys = Object.keys(n).sort().join(",");
  if (keys !== "comparisonOperator,notificationType,threshold,thresholdType") return null;
  if (typeof n.notificationType !== "string" || !NOTIFICATION_TYPES.has(n.notificationType)) return null;
  if (typeof n.comparisonOperator !== "string" || !COMPARISONS.has(n.comparisonOperator)) return null;
  if (typeof n.thresholdType !== "string" || !THRESHOLD_TYPES.has(n.thresholdType)) return null;
  if (typeof n.threshold !== "string" || !THRESHOLD.test(n.threshold)) return null;
  return "NotificationType=" + n.notificationType + ",ComparisonOperator=" + n.comparisonOperator +
    ",Threshold=" + n.threshold + ",ThresholdType=" + n.thresholdType;
}

/**
 * The exact argv for one cost read, or the reason it is refused. Pure: nothing runs here, so a test can pin each shape.
 */
export function awsCostReadArgs(request: ToolRequest): { args: string[] } | { reason: string } {
  if (!isAwsCostReadTool(request.tool)) return { reason: "Not a cost read tool." };
  const tool = request.tool;
  const accepted = FIELDS[tool];
  for (const field of PARAMETER_FIELDS) {
    if (request[field] !== undefined && !(accepted as readonly string[]).includes(field))
      return { reason: "The field " + field + " is not accepted by " + tool + "." };
  }
  for (const field of accepted) if (request[field] === undefined) return { reason: "The field " + field + " is required by " + tool + "." };
  const global = ["--region", COST_SERVICE_REGION, "--output", "json"];
  const account = (): string | null => typeof request.accountId === "string" && ACCOUNT.test(request.accountId) ? request.accountId : null;
  const budget = (): string | null => typeof request.budgetName === "string" && BUDGET_NAME.test(request.budgetName) ? request.budgetName : null;
  const exportArn = (): string | null => typeof request.exportArn === "string" && EXPORT_ARN.test(request.exportArn) ? request.exportArn : null;
  switch (tool) {
    case "aws_budgets_describe_budgets": {
      const id = account();
      return id ? { args: ["budgets", "describe-budgets", "--account-id", id, ...global] } : { reason: "The account id must be 12 digits." };
    }
    case "aws_budgets_describe_notifications": {
      const id = account(), name = budget();
      if (!id) return { reason: "The account id must be 12 digits." };
      if (!name) return { reason: "The budget name is not a supported budget name." };
      return { args: ["budgets", "describe-notifications-for-budget", "--account-id", id, "--budget-name", name, ...global] };
    }
    case "aws_budgets_describe_subscribers": {
      const id = account(), name = budget(), notification = notificationShorthand(request.notification);
      if (!id) return { reason: "The account id must be 12 digits." };
      if (!name) return { reason: "The budget name is not a supported budget name." };
      if (!notification) return { reason: "The notification must name its type, comparison, threshold and threshold type exactly." };
      return { args: ["budgets", "describe-subscribers-for-notification", "--account-id", id, "--budget-name", name, "--notification", notification, ...global] };
    }
    case "aws_bcm_list_exports":
      return { args: ["bcm-data-exports", "list-exports", ...global] };
    case "aws_bcm_get_export":
    case "aws_bcm_list_executions": {
      const arn = exportArn();
      if (!arn) return { reason: "The export ARN must be a us-east-1 Data Exports export ARN." };
      return { args: ["bcm-data-exports", tool === "aws_bcm_get_export" ? "get-export" : "list-executions", "--export-arn", arn, ...global] };
    }
    case "aws_ce_list_cost_allocation_tags":
      return { args: ["ce", "list-cost-allocation-tags", "--type", "UserDefined", ...global] };
    case "aws_tagging_get_resources": {
      if (typeof request.unitId !== "string" || !UNIT_ID.test(request.unitId)) return { reason: "The unit id is not a supported tag value." };
      if (typeof request.region !== "string" || !REGION.test(request.region)) return { reason: "The region is not a supported region name." };
      return { args: ["resourcegroupstaggingapi", "get-resources", "--tag-filters", "Key=" + UNIT_TAG_KEY + ",Values=" + request.unitId,
        "--region", request.region, "--output", "json"] };
    }
  }
}
