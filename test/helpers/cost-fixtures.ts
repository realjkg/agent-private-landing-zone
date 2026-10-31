import { readCostStatus, type CostRead, type CostStatus, type CostStatusRequest } from "../../src/cost/status.js";

// SYNTHETIC cost fixtures for the cost panel, readiness and CLI tests: answers shaped like the AWS CLI's JSON output (the same
// shapes test/cost-status.test.ts uses). Nothing here reads AWS.

export const COST_ACCOUNT = "111111111111";
export const COST_NOW = new Date("2026-10-31T12:00:00Z");
const EXPORT_ARN = "arn:aws:bcm-data-exports:us-east-1:111111111111:export/alz-cur2-0f3c8a1e-1111-4222-8333-944445555666";
export const COST_REQUEST: CostStatusRequest = {
  accountId: COST_ACCOUNT, budgetName: "alz-dev-monthly", requiredTagKeys: ["cost-center", "environment", "owner"],
  unitId: "unit-0001", region: "us-east-2", exportArn: EXPORT_ARN, expectedBucket: "examplefake-cur", analytics: "off",
};

export function costAnswers(): Record<string, unknown> {
  return {
    aws_budgets_describe_budgets: { Budgets: [{
      BudgetName: "alz-dev-monthly", BudgetType: "COST", TimeUnit: "MONTHLY", BudgetLimit: { Amount: "50.0", Unit: "USD" },
      CalculatedSpend: { ActualSpend: { Amount: "12.34", Unit: "USD" }, ForecastedSpend: { Amount: "40.1", Unit: "USD" } },
      LastUpdatedTime: "2026-10-31T06:00:00+00:00",
    }] },
    aws_budgets_describe_notifications: { Notifications: [
      { NotificationType: "ACTUAL", ComparisonOperator: "GREATER_THAN", Threshold: 80, ThresholdType: "PERCENTAGE", NotificationState: "OK" },
      { NotificationType: "FORECASTED", ComparisonOperator: "GREATER_THAN", Threshold: 100, ThresholdType: "PERCENTAGE" },
    ] },
    aws_budgets_describe_subscribers: { Subscribers: [{ SubscriptionType: "EMAIL", Address: "finops@example.com" }] },
    aws_tagging_get_resources: { ResourceTagMappingList: [
      { ResourceARN: "arn:aws:s3:::examplefake-cur", Tags: [{ Key: "owner", Value: "qa" }, { Key: "cost-center", Value: "1" }, { Key: "environment", Value: "dev" }] },
    ] },
    aws_ce_list_cost_allocation_tags: { CostAllocationTags: ["owner", "cost-center", "environment"].map((TagKey) => ({ TagKey, Type: "UserDefined", Status: "Active" })) },
    aws_bcm_list_exports: { Exports: [{ ExportArn: EXPORT_ARN, ExportName: "alz-cur2" }] },
    aws_bcm_get_export: {
      Export: {
        ExportArn: EXPORT_ARN, Name: "alz-cur2",
        DataQuery: { QueryStatement: "SELECT bill_billing_period_start_date, line_item_unblended_cost FROM COST_AND_USAGE_REPORT", TableConfigurations: {} },
        DestinationConfigurations: { S3Destination: { S3Bucket: "examplefake-cur", S3Prefix: "cur2", S3Region: "us-east-2",
          S3OutputConfigurations: { Format: "PARQUET", Compression: "PARQUET", OutputType: "CUSTOM", Overwrite: "OVERWRITE_REPORT" } } },
        RefreshCadence: { Frequency: "SYNCHRONOUS" },
      },
      ExportStatus: { StatusCode: "HEALTHY", CreatedAt: "2026-10-29T00:00:00Z", LastUpdatedAt: "2026-10-31T02:00:00Z" },
    },
    aws_bcm_list_executions: { Executions: [
      { ExecutionId: "e-2", ExecutionStatus: { StatusCode: "DELIVERY_SUCCESS", CreatedAt: "2026-10-31T01:00:00Z", CompletedAt: "2026-10-31T02:00:00Z" } },
    ] },
  };
}

export function costReader(answers: Record<string, unknown>): CostRead {
  return async (request) => {
    const answer = answers[request.tool];
    if (answer instanceof Error) throw answer;
    if (answer === undefined) throw new Error("no fixture for " + request.tool);
    return structuredClone(answer);
  };
}

export type CostVariant = "observed" | "waiting" | "stale" | "attention" | "missing" | "incomplete";

/** A status in each overall state, read from the fixtures above. */
export async function costStatusOf(variant: CostVariant): Promise<CostStatus> {
  const answers = costAnswers();
  let now = COST_NOW;
  if (variant === "waiting") {
    answers.aws_bcm_list_executions = { Executions: [] };
    (answers.aws_bcm_get_export as { ExportStatus: Record<string, unknown> }).ExportStatus.CreatedAt = "2026-10-31T00:00:00Z";
  }
  if (variant === "stale") now = new Date("2026-11-03T12:00:00Z");
  if (variant === "attention") answers.aws_budgets_describe_subscribers = { Subscribers: [] };
  if (variant === "missing") answers.aws_budgets_describe_budgets = { Budgets: [] };
  if (variant === "incomplete") answers.aws_ce_list_cost_allocation_tags = new Error("An error occurred (AccessDeniedException) when calling the ListCostAllocationTags operation: User is not authorized");
  return readCostStatus(COST_REQUEST, costReader(answers), now);
}
