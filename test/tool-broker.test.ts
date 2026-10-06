import assert from "node:assert/strict";
import test from "node:test";

import { executeTool } from "../src/tools/broker.js";

const context = {
  cwd: process.cwd(),
  allowCloudRead: false,
  allowMutation: false as const,
};

test("tool broker blocks workspace escape", () => {
  const result = executeTool(
    {
      tool: "terraform_version",
      workspace: "../",
    },
    context,
  );

  assert.equal(
    Array.isArray(result),
    false,
  );

  if (!Array.isArray(result)) {
    assert.equal(result.blocked, true);
  }
});

test("tool broker exposes no apply or destroy operations", () => {
  const allowed = [
    "terraform_version",
    "terraform_fmt_check",
    "terraform_validate",
    "terraform_plan",
    "pulumi_version",
    "pulumi_preview",
    "aws_version",
    "aws_sts_identity",
    "aws_org_describe",
    "aws_controltower_list_landing_zones",
    "aws_org_list_scps",
    "aws_config_recorders",
    "aws_cloudtrail_trails",
    "azure_version",
    "azure_account_show",
    "azure_management_groups",
    "azure_policy_assignments",
    "query_environment",
    "show_evidence",
  ];

  assert.equal(
    allowed.includes("terraform_apply"),
    false,
  );
  assert.equal(
    allowed.includes("pulumi_up"),
    false,
  );
  assert.equal(
    allowed.includes("terraform_destroy"),
    false,
  );
  assert.equal(
    allowed.includes("pulumi_destroy"),
    false,
  );
});


test("provider discovery reads require explicit cloud-read capability", () => {
  const aws = executeTool(
    {
      tool:
        "aws_sts_identity",
    },
    context,
  );

  const azure = executeTool(
    {
      tool:
        "azure_account_show",
    },
    context,
  );

  for (const result of [
    aws,
    azure,
  ]) {
    assert.equal(
      Array.isArray(result),
      false,
    );

    if (!Array.isArray(result)) {
      assert.equal(
        result.blocked,
        true,
      );
      assert.match(
        result.reason ?? "",
        /read-only cloud access/i,
      );
    }
  }
});
