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
