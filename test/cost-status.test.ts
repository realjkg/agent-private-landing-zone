import assert from "node:assert/strict";
import test from "node:test";

import { costStatusLines, readCostStatus, type CostRead, type CostReadRequest, type CostStatusRequest } from "../src/cost/status.js";
import { awsCostReadArgs } from "../src/tools/aws-cost-reads.js";

// Synthetic: every answer below is a fixture shaped like the AWS CLI's JSON output. Nothing here reads AWS; that the live
// account answers this way is shown only by the owner's live acceptance (plan items 1-8, pillar:cost).

const ACCOUNT = "111111111111";
const EXPORT_ARN = "arn:aws:bcm-data-exports:us-east-1:111111111111:export/alz-cur2-0f3c8a1e-1111-4222-8333-944445555666";
const NOW = new Date("2026-10-31T12:00:00Z");
const REQUEST: CostStatusRequest = {
  accountId: ACCOUNT, budgetName: "alz-dev-monthly", requiredTagKeys: ["owner", "cost-center", "environment"],
  unitId: "unit-0001", region: "us-east-2", exportArn: EXPORT_ARN, expectedBucket: "examplefake-cur", analytics: "off",
};

type Answer = unknown | Error;
const denied = (operation: string) => new Error("An error occurred (AccessDeniedException) when calling the " + operation + " operation: User is not authorized");

function fixtures(): Record<string, Answer> {
  return {
    aws_budgets_describe_budgets: { Budgets: [{
      BudgetName: "alz-dev-monthly", BudgetType: "COST", TimeUnit: "MONTHLY",
      BudgetLimit: { Amount: "50.0", Unit: "USD" }, CostFilters: { TagKeyValue: ["user:environment$dev"] },
      CalculatedSpend: { ActualSpend: { Amount: "12.34", Unit: "USD" }, ForecastedSpend: { Amount: "40.1", Unit: "USD" } },
      LastUpdatedTime: "2026-10-31T06:00:00+00:00",
    }] },
    aws_budgets_describe_notifications: { Notifications: [
      { NotificationType: "ACTUAL", ComparisonOperator: "GREATER_THAN", Threshold: 80, ThresholdType: "PERCENTAGE", NotificationState: "OK" },
      { NotificationType: "FORECASTED", ComparisonOperator: "GREATER_THAN", Threshold: 100, ThresholdType: "PERCENTAGE" },
    ] },
    aws_budgets_describe_subscribers: { Subscribers: [
      { SubscriptionType: "EMAIL", Address: "finops@example.com" },
      { SubscriptionType: "SNS", Address: "arn:aws:sns:us-east-1:111111111111:alz-budget-alerts" },
    ] },
    aws_tagging_get_resources: { ResourceTagMappingList: [
      { ResourceARN: "arn:aws:s3:::examplefake-cur", Tags: [{ Key: "owner", Value: "qa" }, { Key: "cost-center", Value: "1" }, { Key: "environment", Value: "dev" }] },
    ] },
    aws_ce_list_cost_allocation_tags: { CostAllocationTags: [
      { TagKey: "owner", Type: "UserDefined", Status: "Active", LastUpdatedDate: "2026-10-30T00:00:00Z" },
      { TagKey: "cost-center", Type: "UserDefined", Status: "Active" },
      { TagKey: "environment", Type: "UserDefined", Status: "Active" },
    ] },
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
      { ExecutionId: "e-1", ExecutionStatus: { StatusCode: "DELIVERY_SUCCESS", CreatedAt: "2026-10-30T01:00:00Z", CompletedAt: "2026-10-30T02:00:00Z" } },
    ] },
  };
}

function reader(answers: Record<string, Answer>): { read: CostRead; calls: CostReadRequest[] } {
  const calls: CostReadRequest[] = [];
  const read: CostRead = async (request) => {
    calls.push(request);
    const answer = answers[request.tool];
    if (answer instanceof Error) throw answer;
    if (answer === undefined) throw new Error("no fixture for " + request.tool);
    return structuredClone(answer);
  };
  return { read, calls };
}

test("positive: every value is read back and labeled, and the forecast is an estimate", async () => {
  const { read, calls } = reader(fixtures());
  const s = await readCostStatus(REQUEST, read, NOW);
  assert.equal(s.overall, "OBSERVED_COMPLETE");
  assert.equal(s.budget.state, "PRESENT");
  assert.deepEqual(s.budget.limit, { label: "OBSERVED", value: { amount: "50.0", unit: "USD" } });
  assert.deepEqual(s.budget.period, { label: "OBSERVED", value: "MONTHLY" });
  assert.deepEqual(s.budget.filters, { label: "OBSERVED", value: { TagKeyValue: ["user:environment$dev"] } });
  assert.deepEqual(s.budget.actualSpend, { label: "OBSERVED", value: { amount: "12.34", unit: "USD" } });
  assert.equal(s.budget.forecastedSpend.label, "ESTIMATE");
  assert.deepEqual(s.budget.hasActualAlert, { label: "OBSERVED", value: true });
  assert.deepEqual(s.budget.hasForecastAlert, { label: "OBSERVED", value: true });
  assert.equal(s.budget.hardSpendCap, false);
  assert.equal(s.budget.notifications.label, "OBSERVED");
  if (s.budget.notifications.label !== "OBSERVED") return;
  const [actual, forecast] = s.budget.notifications.value;
  assert.equal(actual!.threshold, "80");
  assert.deepEqual(actual!.alarmState, { label: "OBSERVED", value: "OK" });
  assert.deepEqual(forecast!.alarmState, { label: "UNKNOWN", reason: "NOT_REPORTED_BY_AWS" });
  assert.equal(actual!.subscribers.label, "OBSERVED");
  if (actual!.subscribers.label !== "OBSERVED") return;
  // Budgets has no confirmation API; SNS confirmation is not read. Never assumed confirmed.
  assert.deepEqual(actual!.subscribers.value.map((x) => x.confirmation), [
    { label: "UNKNOWN", reason: "NOT_REPORTED_BY_AWS" }, { label: "UNKNOWN", reason: "NOT_READ" }]);
  assert.equal(s.tags.state, "ALL_PRESENT");
  assert.equal(s.costAllocationTags.state, "ALL_ACTIVE");
  assert.deepEqual(s.costAllocationTags.tags[1]!.lastUpdated, { label: "UNKNOWN", reason: "NOT_REPORTED_BY_AWS" });
  assert.equal(s.export.state, "DELIVERED");
  assert.deepEqual(s.export.configValid, { label: "OBSERVED", value: true });
  assert.deepEqual(s.export.destination, { label: "OBSERVED", value: { bucket: "examplefake-cur", prefix: "cur2", region: "us-east-2" } });
  assert.deepEqual(s.export.lastDelivery, { label: "OBSERVED", value: "2026-10-31T02:00:00.000Z" });
  assert.equal(s.freshness.state, "FRESH");
  assert.equal(s.freshness.billingPeriod.label, "ESTIMATE");
  assert.deepEqual(s.freshness.analyticsIngestion, { label: "UNKNOWN", reason: "NOT_SELECTED" });
  assert.deepEqual(s.freshness.dashboardRefresh, { label: "UNKNOWN", reason: "NOT_SELECTED" });
  assert.equal(s.actEnabled, false);
  assert.equal(s.advisory, true);
  // Every call is a shape the broker accepts, and one subscriber read per notification.
  for (const call of calls) assert.ok("args" in awsCostReadArgs(call), call.tool);
  assert.equal(calls.filter((c) => c.tool === "aws_budgets_describe_subscribers").length, 2);
  assert.deepEqual(calls.find((c) => c.tool === "aws_budgets_describe_subscribers")!.notification,
    { notificationType: "ACTUAL", comparisonOperator: "GREATER_THAN", threshold: "80", thresholdType: "PERCENTAGE" });
  const lines = costStatusLines(s);
  assert.ok(lines.length <= 8);
  assert.match(lines[0]!, /OBSERVED_COMPLETE/);
  assert.match(lines.join("\n"), /never caps spend/);
  assert.match(lines.join("\n"), /forecast 40\.1 USD \[ESTIMATE\]/);
});

test("analytics selected: the phase 2 fields are present and UNKNOWN, never filled", async () => {
  const s = await readCostStatus({ ...REQUEST, analytics: "on" }, reader(fixtures()).read, NOW);
  assert.deepEqual(s.freshness.analyticsIngestion, { label: "UNKNOWN", reason: "PHASE_2_NOT_READ" });
  assert.deepEqual(s.freshness.dashboardRefresh, { label: "UNKNOWN", reason: "PHASE_2_NOT_READ" });
});

test("waiting: an export with no execution, or only one in progress, is WAITING, never delivered", async () => {
  for (const executions of [[], [{ ExecutionId: "e-1", ExecutionStatus: { StatusCode: "QUERY_IN_PROCESS", CreatedAt: "2026-10-31T01:00:00Z" } }]]) {
    const answers = fixtures();
    answers.aws_bcm_list_executions = { Executions: executions };
    const s = await readCostStatus(REQUEST, reader(answers).read, NOW);
    assert.equal(s.export.state, "WAITING");
    assert.equal(s.freshness.state, "WAITING");
    assert.equal(s.overall, "WAITING");
    assert.equal(s.export.lastDelivery.label, "UNKNOWN");
  }
});

test("empty: no spend reported is UNKNOWN, never zero; no budget at all is MISSING", async () => {
  const answers = fixtures();
  const budget = (answers.aws_budgets_describe_budgets as { Budgets: Record<string, unknown>[] }).Budgets[0]!;
  delete budget.CalculatedSpend;
  let s = await readCostStatus(REQUEST, reader(answers).read, NOW);
  assert.deepEqual(s.budget.actualSpend, { label: "UNKNOWN", reason: "NOT_REPORTED_BY_AWS" });
  assert.deepEqual(s.budget.forecastedSpend, { label: "UNKNOWN", reason: "NOT_REPORTED_BY_AWS" });
  assert.doesNotMatch(costStatusLines(s).join("\n"), /spend 0/);

  answers.aws_budgets_describe_budgets = { Budgets: [] };
  s = await readCostStatus(REQUEST, reader(answers).read, NOW);
  assert.equal(s.budget.state, "MISSING");
  assert.deepEqual(s.budget.budgetCount, { label: "OBSERVED", value: 0 });
  assert.deepEqual(s.budget.actualSpend, { label: "UNKNOWN", reason: "PARENT_MISSING" });
  assert.equal(s.overall, "ATTENTION");

  // Budgets answers NotFoundException when the account has no budgets: observed absence, not a failed read.
  answers.aws_budgets_describe_budgets = new Error("An error occurred (NotFoundException) when calling the DescribeBudgets operation: Unable to get budgets for account");
  s = await readCostStatus(REQUEST, reader(answers).read, NOW);
  assert.equal(s.budget.state, "MISSING");
  assert.deepEqual(s.budget.budgetCount, { label: "OBSERVED", value: 0 });

  // Nothing tagged with the unit is not a pass.
  answers.aws_tagging_get_resources = { ResourceTagMappingList: [] };
  s = await readCostStatus(REQUEST, reader(answers).read, NOW);
  assert.equal(s.tags.state, "NO_RESOURCES_FOUND");
});

test("stale: a last delivery older than the window is STALE", async () => {
  const later = new Date("2026-11-03T12:00:00Z");
  let s = await readCostStatus(REQUEST, reader(fixtures()).read, later);
  assert.equal(s.export.state, "STALE");
  assert.equal(s.freshness.state, "STALE");
  assert.equal(s.overall, "STALE");
  assert.equal(s.freshness.billingPeriod.label === "ESTIMATE" && s.freshness.billingPeriod.value, "2026-11");
  s = await readCostStatus({ ...REQUEST, staleAfterHours: 200 }, reader(fixtures()).read, later);
  assert.equal(s.export.state, "DELIVERED");
});

test("failed: a failed latest execution or an UNHEALTHY export is FAILED, even after an earlier delivery", async () => {
  let answers = fixtures();
  (answers.aws_bcm_list_executions as { Executions: unknown[] }).Executions.unshift(
    { ExecutionId: "e-3", ExecutionStatus: { StatusCode: "DELIVERY_FAILURE", StatusReason: "BILL_OWNER_CHANGED", CreatedAt: "2026-10-31T09:00:00Z", CompletedAt: "2026-10-31T10:00:00Z" } });
  let s = await readCostStatus(REQUEST, reader(answers).read, NOW);
  assert.equal(s.export.state, "FAILED");
  assert.equal(s.export.lastExecution.label === "OBSERVED" && s.export.lastExecution.value.reason, "BILL_OWNER_CHANGED");
  assert.equal(s.overall, "ATTENTION");
  answers = fixtures();
  (answers.aws_bcm_get_export as { ExportStatus: Record<string, unknown> }).ExportStatus.StatusCode = "UNHEALTHY";
  s = await readCostStatus(REQUEST, reader(answers).read, NOW);
  assert.equal(s.export.state, "FAILED");
});

test("config: a non-CUR 2.0 query, a different bucket or a non-synchronous refresh are named problems", async () => {
  const answers = fixtures();
  const e = (answers.aws_bcm_get_export as { Export: Record<string, any> }).Export;
  e.DataQuery.QueryStatement = "SELECT * FROM FOCUS_1_0_AWS";
  e.DestinationConfigurations.S3Destination.S3Bucket = "someone-else";
  e.RefreshCadence.Frequency = "DAILY";
  const s = await readCostStatus(REQUEST, reader(answers).read, NOW);
  assert.deepEqual(s.export.configValid, { label: "OBSERVED", value: false });
  assert.deepEqual(s.export.configProblems, ["QUERY_NOT_CUR_2_0", "REFRESH_NOT_SYNCHRONOUS", "DESTINATION_BUCKET_DIFFERS"]);
  assert.equal(s.overall, "ATTENTION");
});

test("tags: a missing required tag and an inactive or unseen cost-allocation tag are reported", async () => {
  const answers = fixtures();
  (answers.aws_tagging_get_resources as { ResourceTagMappingList: unknown[] }).ResourceTagMappingList.push(
    { ResourceARN: "arn:aws:sns:us-east-2:111111111111:alz-budget-alerts", Tags: [{ Key: "owner", Value: "qa" }] });
  answers.aws_ce_list_cost_allocation_tags = { CostAllocationTags: [{ TagKey: "owner", Type: "UserDefined", Status: "Inactive" }] };
  const s = await readCostStatus(REQUEST, reader(answers).read, NOW);
  assert.equal(s.tags.state, "MISSING");
  assert.deepEqual(s.tags.resources.label === "OBSERVED" && s.tags.resources.value[1], {
    arn: "arn:aws:sns:us-east-2:111111111111:alz-budget-alerts", present: ["owner"], missing: ["cost-center", "environment"] });
  assert.equal(s.costAllocationTags.state, "INACTIVE");
  assert.deepEqual(s.costAllocationTags.tags[1]!.status, { label: "UNKNOWN", reason: "TAG_KEY_NOT_YET_IN_BILLING" });
  assert.equal(s.overall, "ATTENTION");
});

test("permission denied: each denied read is UNKNOWN (ACCESS_DENIED), never a pass", async () => {
  const answers = fixtures();
  answers.aws_budgets_describe_budgets = denied("DescribeBudgets");
  answers.aws_tagging_get_resources = denied("GetResources");
  answers.aws_ce_list_cost_allocation_tags = denied("ListCostAllocationTags");
  answers.aws_bcm_get_export = denied("GetExport");
  const s = await readCostStatus(REQUEST, reader(answers).read, NOW);
  assert.equal(s.budget.state, "UNKNOWN");
  assert.deepEqual(s.budget.budgetCount, { label: "UNKNOWN", reason: "ACCESS_DENIED" });
  assert.deepEqual(s.budget.hasActualAlert, { label: "UNKNOWN", reason: "ACCESS_DENIED" });
  assert.equal(s.tags.state, "UNKNOWN");
  assert.equal(s.costAllocationTags.state, "UNKNOWN");
  assert.equal(s.export.state, "UNKNOWN");
  assert.equal(s.freshness.state, "UNKNOWN");
  assert.equal(s.overall, "INCOMPLETE");
  assert.notEqual(s.overall, "OBSERVED_COMPLETE");

  // A denied subscriber or execution read alone still keeps the status INCOMPLETE.
  const partial = fixtures();
  partial.aws_budgets_describe_subscribers = denied("DescribeSubscribersForNotification");
  const p = await readCostStatus(REQUEST, reader(partial).read, NOW);
  assert.equal(p.overall, "INCOMPLETE");
  const executions = fixtures();
  executions.aws_bcm_list_executions = new Error("An error occurred (ThrottlingException) when calling the ListExecutions operation: Rate exceeded");
  const x = await readCostStatus(REQUEST, reader(executions).read, NOW);
  assert.equal(x.export.state, "UNKNOWN");
  assert.deepEqual(x.export.lastDelivery, { label: "UNKNOWN", reason: "THROTTLED" });
  assert.equal(x.overall, "INCOMPLETE");
});

test("malformed: a wrong shape, unparseable JSON or a pagination token left behind is UNKNOWN (MALFORMED_RESPONSE)", async () => {
  const cases: [string, Answer][] = [
    ["aws_budgets_describe_budgets", { Budgets: "x" }],
    ["aws_budgets_describe_budgets", { Budgets: [{ BudgetName: "alz-dev-monthly", BudgetType: "COST", BudgetLimit: { Amount: "fifty", Unit: "USD" } }] }],
    ["aws_budgets_describe_budgets", new SyntaxError("Unexpected token")],
    ["aws_budgets_describe_notifications", { Notifications: [{ NotificationType: "ACTUAL", ComparisonOperator: "GREATER_THAN", Threshold: "80" }] }],
    ["aws_tagging_get_resources", { ResourceTagMappingList: [], PaginationToken: "more" }],
    ["aws_ce_list_cost_allocation_tags", { CostAllocationTags: [{ TagKey: "owner", Status: "Enabled" }] }],
    ["aws_bcm_get_export", { Export: { ExportArn: EXPORT_ARN } }],
    ["aws_bcm_list_executions", { Executions: [{ ExecutionId: "e", ExecutionStatus: { StatusCode: "DONE", CreatedAt: "2026-10-31T01:00:00Z" } }] }],
    ["aws_bcm_list_executions", null],
  ];
  for (const [tool, answer] of cases) {
    const answers = fixtures();
    answers[tool] = answer;
    const s = await readCostStatus(REQUEST, reader(answers).read, NOW);
    assert.notEqual(s.overall, "OBSERVED_COMPLETE", tool);
    const text = JSON.stringify(s);
    assert.match(text, /MALFORMED_RESPONSE/, tool + ": " + JSON.stringify(answer));
  }
  // An answer about another export proves nothing about this one.
  const other = fixtures();
  (other.aws_bcm_get_export as { Export: Record<string, unknown> }).Export.ExportArn = EXPORT_ARN.replace("alz-cur2", "other");
  assert.equal((await readCostStatus(REQUEST, reader(other).read, NOW)).export.state, "UNKNOWN");
});

test("not requested and not found: the export and tags are named UNKNOWN or MISSING, and the export may be found by name", async () => {
  const answers = fixtures();
  let s = await readCostStatus({ ...REQUEST, exportArn: undefined, unitId: undefined, region: undefined }, reader(answers).read, NOW);
  assert.equal(s.export.state, "NOT_REQUESTED");
  assert.deepEqual(s.tags.resources, { label: "UNKNOWN", reason: "NOT_REQUESTED" });
  assert.equal(s.overall, "INCOMPLETE");

  answers.aws_bcm_list_exports = { Exports: [{ ExportArn: EXPORT_ARN, ExportName: "alz-cur2" }] };
  s = await readCostStatus({ ...REQUEST, exportArn: undefined, exportName: "alz-cur2" }, reader(answers).read, NOW);
  assert.equal(s.export.state, "DELIVERED");
  s = await readCostStatus({ ...REQUEST, exportArn: undefined, exportName: "absent" }, reader(answers).read, NOW);
  assert.equal(s.export.state, "MISSING");

  answers.aws_bcm_get_export = new Error("An error occurred (ResourceNotFoundException) when calling the GetExport operation: not found");
  s = await readCostStatus(REQUEST, reader(answers).read, NOW);
  assert.equal(s.export.state, "MISSING");
  assert.equal(s.overall, "ATTENTION");
});

test("requests: a bad account, a unit without a region, a bad window or a field the broker refuses never reach the reader", async () => {
  const { read, calls } = reader(fixtures());
  await assert.rejects(readCostStatus({ ...REQUEST, accountId: "1234" }, read, NOW), /COST_STATUS_ACCOUNT_INVALID/);
  await assert.rejects(readCostStatus({ ...REQUEST, region: undefined }, read, NOW), /COST_STATUS_UNIT_NEEDS_REGION/);
  await assert.rejects(readCostStatus({ ...REQUEST, staleAfterHours: 0 }, read, NOW), /COST_STATUS_STALE_WINDOW_INVALID/);
  assert.equal(calls.length, 0);
  await assert.rejects(readCostStatus({ ...REQUEST, budgetName: "bad:name" }, read, NOW), /COST_STATUS_BUDGET_NAME_INVALID/);
  await assert.rejects(readCostStatus({ ...REQUEST, budgetName: "--profile admin" }, read, NOW), /COST_STATUS_BUDGET_NAME_INVALID/);
  await assert.rejects(readCostStatus({ ...REQUEST, exportArn: "arn:aws:s3:::bucket" }, read, NOW), /COST_STATUS_EXPORT_ARN_INVALID/);
  await assert.rejects(readCostStatus({ ...REQUEST, unitId: "a,Values=b" }, read, NOW), /COST_STATUS_UNIT_INVALID/);
  assert.equal(calls.length, 0, "a refused request never reaches the reader");
});
