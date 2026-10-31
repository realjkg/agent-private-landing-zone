import assert from "node:assert/strict";
import test from "node:test";

import { ALZ_TAG_KEYS } from "../src/teardown/unit.js";
import { AWS_COST_READ_TOOLS, UNIT_TAG_KEY, awsCostReadArgs } from "../src/tools/aws-cost-reads.js";
import { executeTool, getToolSecurityPosture } from "../src/tools/broker.js";
import type { ToolRequest } from "../src/tools/types.js";

// Synthetic: these tests pin the argv the broker would run. No AWS CLI is started.

const ACCOUNT = "111111111111";
const EXPORT_ARN = "arn:aws:bcm-data-exports:us-east-1:111111111111:export/alz-cur2-0f3c8a1e-1111-4222-8333-944445555666";
const NOTIFICATION = { notificationType: "ACTUAL", comparisonOperator: "GREATER_THAN", threshold: "80", thresholdType: "PERCENTAGE" } as const;
const G = ["--region", "us-east-1", "--output", "json"];
const argsOf = (request: ToolRequest): string[] => {
  const built = awsCostReadArgs(request);
  assert.ok("args" in built, request.tool + ": " + ("reason" in built ? built.reason : ""));
  return built.args;
};
const refusal = (request: ToolRequest): string => {
  const built = awsCostReadArgs(request);
  assert.ok("reason" in built, request.tool + " must be refused: " + JSON.stringify(request));
  return built.reason;
};

test("each cost read is exactly one fixed, read-only AWS CLI call", () => {
  assert.deepEqual(argsOf({ tool: "aws_budgets_describe_budgets", accountId: ACCOUNT }), ["budgets", "describe-budgets", "--account-id", ACCOUNT, ...G]);
  assert.deepEqual(argsOf({ tool: "aws_budgets_describe_notifications", accountId: ACCOUNT, budgetName: "alz-dev monthly" }),
    ["budgets", "describe-notifications-for-budget", "--account-id", ACCOUNT, "--budget-name", "alz-dev monthly", ...G]);
  assert.deepEqual(argsOf({ tool: "aws_budgets_describe_subscribers", accountId: ACCOUNT, budgetName: "alz-dev", notification: NOTIFICATION }),
    ["budgets", "describe-subscribers-for-notification", "--account-id", ACCOUNT, "--budget-name", "alz-dev", "--notification",
      "NotificationType=ACTUAL,ComparisonOperator=GREATER_THAN,Threshold=80,ThresholdType=PERCENTAGE", ...G]);
  assert.deepEqual(argsOf({ tool: "aws_bcm_list_exports" }), ["bcm-data-exports", "list-exports", ...G]);
  assert.deepEqual(argsOf({ tool: "aws_bcm_get_export", exportArn: EXPORT_ARN }), ["bcm-data-exports", "get-export", "--export-arn", EXPORT_ARN, ...G]);
  assert.deepEqual(argsOf({ tool: "aws_bcm_list_executions", exportArn: EXPORT_ARN }), ["bcm-data-exports", "list-executions", "--export-arn", EXPORT_ARN, ...G]);
  assert.deepEqual(argsOf({ tool: "aws_ce_list_cost_allocation_tags" }), ["ce", "list-cost-allocation-tags", "--type", "UserDefined", ...G]);
  // The verifier's own tag-filter shape (src/observe/aws-cli.ts), on the deletion unit's tag key.
  assert.equal(UNIT_TAG_KEY, ALZ_TAG_KEYS.unit);
  assert.deepEqual(argsOf({ tool: "aws_tagging_get_resources", unitId: "unit-0001", region: "us-east-2" }),
    ["resourcegroupstaggingapi", "get-resources", "--tag-filters", "Key=alz-unit,Values=unit-0001", "--region", "us-east-2", "--output", "json"]);
  for (const tool of AWS_COST_READ_TOOLS) {
    assert.match(tool, /^aws_[a-z]+_(describe|list|get)_[a-z_]+$/, tool + " is named as a read");
  }
});

test("every argument is validated: no wildcard, flag, separator or other shape reaches the argv", () => {
  for (const accountId of ["", "11111111111", "1111111111111", "*", "111111111111 --profile x", "--profile"]) {
    refusal({ tool: "aws_budgets_describe_budgets", accountId });
  }
  for (const budgetName of ["", "-x", "--profile admin", "a:b", "a\\b", "a,b", "a=b", "*", "a\nb", "x".repeat(101)]) {
    refusal({ tool: "aws_budgets_describe_notifications", accountId: ACCOUNT, budgetName });
  }
  for (const notification of [
    { ...NOTIFICATION, threshold: "80,ThresholdType=ABSOLUTE_VALUE" }, { ...NOTIFICATION, threshold: "-1" }, { ...NOTIFICATION, threshold: "1e3" },
    { ...NOTIFICATION, notificationType: "ANY" }, { ...NOTIFICATION, comparisonOperator: "*" }, { ...NOTIFICATION, thresholdType: "PERCENT" },
    { ...NOTIFICATION, extra: "x" }, { notificationType: "ACTUAL" },
  ]) {
    refusal({ tool: "aws_budgets_describe_subscribers", accountId: ACCOUNT, budgetName: "alz-dev", notification: notification as never });
  }
  for (const exportArn of ["", "*", "arn:aws:bcm-data-exports:us-east-2:111111111111:export/x", "arn:aws:bcm-data-exports:us-east-1:111111111111:export/*",
    "arn:aws:s3:::bucket", EXPORT_ARN + " --profile x", "arn:aws:bcm-data-exports:us-east-1:111111111111:export/a/b"]) {
    refusal({ tool: "aws_bcm_get_export", exportArn });
    refusal({ tool: "aws_bcm_list_executions", exportArn });
  }
  for (const unitId of ["", "a,Values=b", "a b", "*?", "x".repeat(257)]) refusal({ tool: "aws_tagging_get_resources", unitId, region: "us-east-1" });
  for (const region of ["", "us-east", "US-EAST-1", "us-east-1 --profile x"]) refusal({ tool: "aws_tagging_get_resources", unitId: "u", region });
});

test("each cost tool takes exactly its own fields: a missing field or another tool's field is refused", () => {
  assert.match(refusal({ tool: "aws_budgets_describe_budgets" }), /accountId is required/);
  assert.match(refusal({ tool: "aws_bcm_get_export" }), /exportArn is required/);
  assert.match(refusal({ tool: "aws_tagging_get_resources", unitId: "u" }), /region is required/);
  assert.match(refusal({ tool: "aws_bcm_list_exports", accountId: ACCOUNT }), /accountId is not accepted/);
  assert.match(refusal({ tool: "aws_ce_list_cost_allocation_tags", region: "us-east-2" }), /region is not accepted/);
  assert.match(refusal({ tool: "aws_budgets_describe_budgets", accountId: ACCOUNT, exportArn: EXPORT_ARN }), /exportArn is not accepted/);
  assert.match(refusal({ tool: "aws_bcm_list_exports", operationIdentifier: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" }), /operationIdentifier is not accepted/);
  assert.match(refusal({ tool: "aws_sts_identity" }), /Not a cost read tool/);
});

test("the broker allows the cost reads, needs cloud-read capability for them, and refuses cost fields on any other tool", () => {
  const posture = getToolSecurityPosture();
  for (const tool of AWS_COST_READ_TOOLS) assert.ok(posture.allowedTools.includes(tool), tool);
  assert.deepEqual(posture.mutationTools, []);
  const context = { cwd: process.cwd(), allowCloudRead: false, allowMutation: false as const };
  for (const tool of AWS_COST_READ_TOOLS) {
    const result = executeTool({ tool, accountId: ACCOUNT }, context);
    assert.ok(!Array.isArray(result) && result.blocked, tool);
    if (!Array.isArray(result)) assert.match(result.reason ?? "", /read-only cloud access/);
  }
  const reading = { ...context, allowCloudRead: true };
  // Refused before any process exists: a wrong field, and a cost field on a non-cost tool.
  const wrong = executeTool({ tool: "aws_budgets_describe_budgets", accountId: "--profile admin" }, reading);
  assert.ok(!Array.isArray(wrong) && wrong.blocked && wrong.exitCode === null);
  for (const request of [{ tool: "aws_sts_identity", accountId: ACCOUNT }, { tool: "aws_controltower_get_landing_zone_operation",
    operationIdentifier: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", region: "us-east-1" }] as ToolRequest[]) {
    const result = executeTool(request, reading);
    assert.ok(!Array.isArray(result) && result.blocked, request.tool);
    if (!Array.isArray(result)) assert.match(result.reason ?? "", /only by the cost read tools/);
  }
});
