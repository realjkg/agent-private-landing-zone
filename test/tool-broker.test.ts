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
    "opentofu_version",
    "opentofu_fmt_check",
    "opentofu_validate",
    "opentofu_plan",
    "bicep_version",
    "bicep_lint",
    "bicep_build",
    "bicep_what_if",
    "cloudformation_version",
    "cloudformation_validate",
    "cloudformation_preview",
    "cdk_version",
    "cdk_synth",
    "cdk_preview",
    "ansible_version",
    "ansible_syntax_check",
    "ansible_preview",
    "crossplane_version",
    "crossplane_validate",
    "crossplane_preview",
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
  assert.equal(
    allowed.includes("opentofu_apply"),
    false,
  );
  assert.equal(
    allowed.includes("opentofu_destroy"),
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


test("OpenTofu preview requires explicit cloud-read capability", () => {
  const result = executeTool(
    {
      tool: "opentofu_plan",
    },
    context,
  );

  assert.equal(
    Array.isArray(result),
    false,
  );

  if (!Array.isArray(result)) {
    assert.equal(result.blocked, true);
    assert.match(
      result.reason ?? "",
      /read-only cloud access/i,
    );
  }
});


test("CloudFormation preview requires cloud-read and preview-write capabilities", () => {
  const noCloudRead = executeTool(
    {
      tool: "cloudformation_preview",
    },
    context,
  );

  assert.equal(
    Array.isArray(noCloudRead),
    false,
  );

  if (!Array.isArray(noCloudRead)) {
    assert.equal(
      noCloudRead.blocked,
      true,
    );
    assert.match(
      noCloudRead.reason ?? "",
      /read-only cloud access/i,
    );
  }

  const noPreviewWrite = executeTool(
    {
      tool: "cloudformation_preview",
    },
    {
      ...context,
      allowCloudRead: true,
    },
  );

  assert.equal(
    Array.isArray(noPreviewWrite),
    false,
  );

  if (!Array.isArray(noPreviewWrite)) {
    assert.equal(
      noPreviewWrite.blocked,
      true,
    );
    assert.match(
      noPreviewWrite.reason ?? "",
      /preview-write/i,
    );
  }
});

test("Bicep what-if requires explicit Azure read capability", () => {
  const result = executeTool(
    {
      tool: "bicep_what_if",
    },
    context,
  );

  assert.equal(
    Array.isArray(result),
    false,
  );

  if (!Array.isArray(result)) {
    assert.equal(result.blocked, true);
    assert.match(
      result.reason ?? "",
      /read-only cloud access/i,
    );
  }
});


test("CDK preview requires cloud read preview write and project-code execution", () => {
  const noCloudRead = executeTool(
    {
      tool: "cdk_preview",
    },
    context,
  );

  assert.equal(
    Array.isArray(noCloudRead),
    false,
  );

  if (!Array.isArray(noCloudRead)) {
    assert.equal(
      noCloudRead.blocked,
      true,
    );
    assert.match(
      noCloudRead.reason ?? "",
      /read-only cloud access/i,
    );
  }

  const noPreviewWrite = executeTool(
    {
      tool: "cdk_preview",
    },
    {
      ...context,
      allowCloudRead: true,
    },
  );

  assert.equal(
    Array.isArray(noPreviewWrite),
    false,
  );

  if (!Array.isArray(noPreviewWrite)) {
    assert.equal(
      noPreviewWrite.blocked,
      true,
    );
    assert.match(
      noPreviewWrite.reason ?? "",
      /preview-write/i,
    );
  }

  const noProjectCode = executeTool(
    {
      tool: "cdk_preview",
    },
    {
      ...context,
      allowCloudRead: true,
      allowPreviewWrite: true,
    },
  );

  assert.equal(
    Array.isArray(noProjectCode),
    false,
  );

  if (!Array.isArray(noProjectCode)) {
    assert.equal(
      noProjectCode.blocked,
      true,
    );
    assert.match(
      noProjectCode.reason ?? "",
      /project-code/i,
    );
  }
});

test("Ansible preview requires project-code and managed-host grants", () => {
  const noProjectCode = executeTool(
    {
      tool: "ansible_preview",
    },
    context,
  );

  assert.equal(
    Array.isArray(noProjectCode),
    false,
  );

  if (!Array.isArray(noProjectCode)) {
    assert.equal(
      noProjectCode.blocked,
      true,
    );
    assert.match(
      noProjectCode.reason ?? "",
      /project-code/i,
    );
  }

  const noManagedAccess = executeTool(
    {
      tool: "ansible_preview",
    },
    {
      ...context,
      allowProjectCodeExecution: true,
    },
  );

  assert.equal(
    Array.isArray(noManagedAccess),
    false,
  );

  if (!Array.isArray(noManagedAccess)) {
    assert.equal(
      noManagedAccess.blocked,
      true,
    );
    assert.match(
      noManagedAccess.reason ?? "",
      /managed-host/i,
    );
  }
});

test("Crossplane render requires project-code execution capability", () => {
  const result = executeTool(
    {
      tool: "crossplane_preview",
    },
    context,
  );

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
      /project-code/i,
    );
  }
});
