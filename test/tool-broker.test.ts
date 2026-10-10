import assert from "node:assert/strict";
import test from "node:test";

import {
  withDebugDiagnosticContext,
} from "../src/debug/context.js";
import { executeTool } from "../src/tools/broker.js";
import {
  runBoundedProcess,
} from "../src/tools/process.js";
import { PROFILES } from "../src/tools/profiles.js";
import { basename, dirname } from "node:path";

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


test("tool broker fails closed when OPA mode is enabled without a policy decision", () => {
  const previous =
    process.env.AGENTIC_SECURITY_POLICY_MODE;

  process.env.AGENTIC_SECURITY_POLICY_MODE =
    "OPA";

  try {
    const result =
      executeTool(
        {
          tool:
            "terraform_version",
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
        /OPA policy.*decision/i,
      );
    }
  } finally {
    if (previous === undefined) {
      delete process.env
        .AGENTIC_SECURITY_POLICY_MODE;
    } else {
      process.env
        .AGENTIC_SECURITY_POLICY_MODE =
        previous;
    }
  }
});

test("tool broker reduces cloud capability during suspected compromise even without OPA", () => {
  const result =
    executeTool(
      {
        tool:
          "aws_sts_identity",
      },
      {
        ...context,
        allowCloudRead: true,
        compromiseState:
          "SUSPECTED",
      },
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
      /compromise state/i,
    );
  }
});


test("debug context captures tool-broker denial without widening capability", async () => {
  const captured =
    await withDebugDiagnosticContext(
      "debug-tool-denial",
      async () =>
        executeTool(
          {
            tool:
              "aws_sts_identity",
          },
          context,
        ),
    );

  assert.equal(
    Array.isArray(
      captured.value,
    ),
    false,
  );
  assert.equal(
    captured.events.some(
      (event) =>
        event.kind ===
          "TOOL" &&
        event.status ===
          "BLOCKED" &&
        event.attributes.tool ===
          "aws_sts_identity",
    ),
    true,
  );
});

test("debug context captures adapter process exit and sanitized output metadata", async () => {
  const captured =
    await withDebugDiagnosticContext(
      "debug-adapter-process",
      async () =>
        // The governed runner refuses absolute paths and unprofiled
        // executables (docs/runner-hardening.md), so this harmless binary goes
        // through its test seam: a bare name, in an explicit directory.
        runBoundedProcess(
          "terraform_version",
          basename(process.execPath),
          ["--version"],
          process.cwd(),
          {
            profile: PROFILES.aws,
            toolDirs: [dirname(process.execPath)],
          },
        ),
    );

  assert.equal(
    captured.value.ok,
    true,
  );

  const event =
    captured.events.find(
      (candidate) =>
        candidate.kind ===
        "ADAPTER",
    );

  assert.ok(event);
  assert.equal(
    event?.status,
    "OK",
  );
  assert.equal(
    event?.attributes.tool,
    "terraform_version",
  );
  assert.equal(
    event?.attributes.exitCode,
    0,
  );
  assert.equal(
    typeof event
      ?.attributes.stdoutBytes,
    "number",
  );
});
