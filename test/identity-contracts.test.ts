import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { getIaCAdapter } from "../src/iac/index.js";
import { executeTool } from "../src/tools/broker.js";
import { PROJECT_CODE_TOOLS } from "../src/tools/execution-permission.js";
import {
  collapsedIdentityVariables,
  EXECUTION_IDENTITIES,
  forbiddenIdentityVariables,
} from "../src/tools/identity.js";
import type { ToolContext, ToolName } from "../src/tools/types.js";

const base: ToolContext = { cwd: process.cwd(), allowCloudRead: true, allowMutation: false };
const result = (tool: ToolName, context: ToolContext) => {
  const value = executeTool({ tool }, context);
  assert.ok(!Array.isArray(value), tool);
  return value;
};

test("terraform and opentofu plans require project-code execution, with an actionable denial", () => {
  for (const tool of ["terraform_plan", "opentofu_plan"] as const) {
    const denied = result(tool, base);
    assert.equal(denied.blocked, true, tool);
    assert.match(denied.reason ?? "", /PROJECT_CODE_EXECUTION/);
    assert.match(denied.reason ?? "", /never permits changing infrastructure/);
    assert.match(denied.reason ?? "", /Static checks/);
    // Cloud read plus preview-write plus managed access still do not stand in for it.
    const stillDenied = result(tool, { ...base, allowPreviewWrite: true, allowManagedAccess: true });
    assert.equal(stillDenied.blocked, true, tool);
    assert.match(stillDenied.reason ?? "", /PROJECT_CODE_EXECUTION/);
  }
});

test("project-code approval is not mutation authority", () => {
  const granted = { ...base, allowProjectCodeExecution: true };
  const refused = result("terraform_plan", { ...granted, allowMutation: true as unknown as false });
  assert.equal(refused.blocked, true);
  assert.match(refused.reason ?? "", /Mutation capability/);
  // The capability unlocks no new tool: apply and destroy are still off the allowlist.
  for (const tool of ["terraform_apply", "terraform_destroy", "pulumi_up", "pulumi_destroy"]) {
    const denied = result(tool as ToolName, granted);
    assert.equal(denied.blocked, true, tool);
    assert.match(denied.reason ?? "", /allowlist/i);
  }
});

test("the static inspection path needs neither project-code execution nor cloud read", () => {
  const staticContext: ToolContext = { cwd: process.cwd(), allowCloudRead: false, allowMutation: false };
  for (const tool of ["terraform_version", "terraform_fmt_check", "terraform_validate",
    "opentofu_version", "opentofu_fmt_check", "opentofu_validate"] as const) {
    assert.equal(PROJECT_CODE_TOOLS.has(tool), false, tool);
    const outcome = executeTool({ tool }, staticContext);
    const rows = Array.isArray(outcome) ? outcome : [outcome];
    // The tool may be missing on this machine; what matters is that the broker did not block it.
    assert.ok(rows.every((row) => row.blocked !== true), tool);
  }
});

test("the adapters refuse a plan without the capability, even if called directly", () => {
  const cwd = mkdtempSync(join(tmpdir(), "alz-identity-"));
  try {
    for (const engine of ["TERRAFORM", "OPENTOFU"] as const) {
      const outcome = getIaCAdapter(engine).preview({ cwd, allowCloudRead: true, allowMutation: false });
      assert.equal(outcome.blocked, true, engine);
      assert.equal(outcome.command, undefined, engine + " must not have started a process");
      assert.match(outcome.reason ?? "", /PROJECT_CODE_EXECUTION/);
    }
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("the set of tools that run project code is pinned", () => {
  assert.deepEqual([...PROJECT_CODE_TOOLS].sort(), [
    "ansible_preview", "ansible_syntax_check", "cdk_preview", "cdk_synth", "crossplane_preview",
    "opentofu_plan", "pulumi_preview", "terraform_plan",
  ]);
});

test("every project-code tool is blocked without the capability", () => {
  for (const tool of PROJECT_CODE_TOOLS) {
    const denied = result(tool, { ...base, allowPreviewWrite: true, allowManagedAccess: true });
    assert.equal(denied.blocked, true, tool);
    assert.match(denied.reason ?? "", /project[- ]code/i, tool);
  }
});

test("exactly two identities exist, and a deployment or operator identity is reported, never read", () => {
  assert.deepEqual([...EXECUTION_IDENTITIES], ["DISCOVERY", "STATE"]);
  assert.deepEqual(
    forbiddenIdentityVariables({
      ALZ_DEPLOY_AWS_ACCESS_KEY_ID: "x", ALZ_OPERATOR_AWS_PROFILE: "x", ALZ_DISCOVERY_AWS_REGION: "x", ALZ_STATE_AWS_REGION: "x",
    }),
    ["ALZ_DEPLOY_AWS_ACCESS_KEY_ID", "ALZ_OPERATOR_AWS_PROFILE"],
  );
});

test("one credential configured for both identities is reported by name, never by value", () => {
  const env = {
    ALZ_STATE_AWS_ACCESS_KEY_ID: "AKIASAMEKEY0000001", ALZ_DISCOVERY_AWS_ACCESS_KEY_ID: "AKIASAMEKEY0000001",
    ALZ_STATE_AWS_SECRET_ACCESS_KEY: "state-secret-0001", ALZ_DISCOVERY_AWS_SECRET_ACCESS_KEY: "discovery-secret-0002",
    ALZ_STATE_AWS_REGION: "eu-west-1", ALZ_DISCOVERY_AWS_REGION: "eu-west-1",
  };
  const collapsed = collapsedIdentityVariables(env);
  assert.deepEqual(collapsed, ["AWS_ACCESS_KEY_ID"]);
  assert.equal(JSON.stringify(collapsed).includes("AKIASAMEKEY"), false);
});

test("no adapter or driver source disables locking", () => {
  for (const file of ["src/iac/terraform.ts", "src/iac/opentofu.ts", "src/iac/pulumi.ts", "src/tools/broker.ts"]) {
    assert.doesNotMatch(readFileSync(file, "utf8"), /-lock=false|-lock\b|--skip-lock|lock-timeout=0/, file);
  }
});
