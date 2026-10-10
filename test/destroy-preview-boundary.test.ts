import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { getIaCAdapter } from "../src/iac/index.js";
import { normalizeTerraformPlan } from "../src/iac/terraform-plan.js";
import { dangerousPreviewCommand } from "../src/qualification/provider-production.js";
import { executeTool, getToolSecurityPosture } from "../src/tools/broker.js";
import type { ToolName, ToolResult } from "../src/tools/types.js";

// Pins the boundary described in docs/teardown-broker-review.md. Nothing here
// grants authority: these tests exist so that adding a destroy-capable tool,
// or a destroy/apply flag to an existing preview, fails loudly and sends the
// author to that review instead of slipping through.

const REVIEW = "see docs/teardown-broker-review.md before changing this";
const command = (...parts: string[]): ToolResult => ({
  tool: "terraform_plan", ok: true, exitCode: 0, stdout: "", stderr: "", durationMs: 0, command: parts,
});

test("the qualification guard sees destroy-mode and auto-approve flags, not just the bare word", () => {
  for (const flagged of [
    ["terraform", "plan", "-destroy"],
    ["terraform", "plan", "-destroy=true"],
    ["pulumi", "preview", "--destroy"],
    ["pulumi", "preview", "--DESTROY"],
    ["terraform", "apply", "-auto-approve"],
    ["pulumi", "up", "--yes"],
    // The forms that were already caught keep being caught.
    ["terraform", "destroy"], ["terraform", "apply"], ["aws", "cloudformation", "execute-change-set"],
    ["aws", "cloudformation", "delete-stack"], ["pulumi", "up"],
  ]) {
    assert.equal(dangerousPreviewCommand(command(...flagged)), true, flagged.join(" "));
  }
  for (const benign of [
    ["terraform", "plan", "-input=false", "-refresh=false", "-out=.agentic-preview.tfplan"],
    ["pulumi", "preview", "--non-interactive", "--diff"],
    ["aws", "sts", "get-caller-identity", "--output", "json"],
    ["az", "deployment", "group", "what-if", "--no-pretty-print"],
  ]) {
    assert.equal(dangerousPreviewCommand(command(...benign)), false, benign.join(" "));
  }
  assert.equal(dangerousPreviewCommand({ ...command(), command: undefined }), false);
});

test("adapter previews pass exactly these arguments: no destroy, apply, target or replace flag", () => {
  const original = process.env.PATH;
  process.env.PATH = ""; // hermetic: no tool can run, and the attempted command is still recorded
  const cwd = mkdtempSync(join(tmpdir(), "alz-argv-"));
  try {
    const context = { cwd, allowCloudRead: true, allowProjectCodeExecution: true, allowMutation: false as const };
    const argv = (engine: "TERRAFORM" | "OPENTOFU" | "PULUMI") => {
      const result = getIaCAdapter(engine).preview(context);
      assert.ok(result.command, engine + " recorded no command");
      return result.command;
    };
    assert.deepEqual(argv("TERRAFORM"),
      ["terraform", "plan", "-input=false", "-refresh=false", "-out=.agentic-preview.tfplan"], REVIEW);
    assert.deepEqual(argv("OPENTOFU"),
      ["tofu", "plan", "-input=false", "-refresh=false", "-out=.agentic-preview.tfplan"], REVIEW);
    assert.deepEqual(argv("PULUMI"), ["pulumi", "preview", "--non-interactive", "--diff"], REVIEW);
    for (const engine of ["TERRAFORM", "OPENTOFU", "PULUMI"] as const) {
      assert.equal(dangerousPreviewCommand(command(...argv(engine))), false, engine);
      // Locking stays on: no preview may switch it off to look "read-only".
      assert.ok(!argv(engine).some((arg) => /^-lock(=|$)/.test(arg)), engine + " must not pass -lock");
    }
  } finally {
    process.env.PATH = original;
    rmSync(cwd, { recursive: true, force: true });
  }
});

const ADAPTERS = ["terraform", "opentofu", "pulumi", "bicep", "cloudformation", "cdk", "ansible", "crossplane"];
const FORBIDDEN_LITERAL = /^-{0,2}(apply|destroy|up|deploy|auto-approve|yes|execute-change-set|create-stack|update-stack|delete-stack|target|replace)(=.*)?$/;

test("no adapter source contains a destroy, apply, deploy, target or replace argument literal", () => {
  for (const name of ADAPTERS) {
    const source = readFileSync(resolve("src/iac", name + ".ts"), "utf8");
    for (const match of source.matchAll(/"([^"\n]{1,60})"/g)) {
      assert.doesNotMatch(match[1].toLowerCase(), FORBIDDEN_LITERAL, name + ".ts has the literal \"" + match[1] + "\". " + REVIEW);
    }
  }
  assert.deepEqual(readdirSync(resolve("src/iac")).filter((file) => /destroy/i.test(file)), []);
});

// Adding a tool to the broker widens what an agent can ask for. This snapshot
// makes that a deliberate, reviewed act rather than a side effect.
const ALLOWLIST: readonly string[] = [
  "ansible_preview", "ansible_syntax_check", "ansible_version", "aws_cloudtrail_trails", "aws_config_recorders",
  "aws_controltower_list_landing_zones", "aws_org_describe", "aws_org_list_scps", "aws_sts_identity", "aws_version",
  "azure_account_show", "azure_management_groups", "azure_policy_assignments", "azure_version", "bicep_build",
  "bicep_lint", "bicep_version", "bicep_what_if", "cdk_preview", "cdk_synth", "cdk_version", "cloudformation_preview",
  "cloudformation_validate", "cloudformation_version", "crossplane_preview", "crossplane_validate", "crossplane_version",
  "opentofu_fmt_check", "opentofu_plan", "opentofu_validate", "opentofu_version", "pulumi_preview", "pulumi_version",
  "query_environment", "show_evidence", "terraform_fmt_check", "terraform_plan", "terraform_validate", "terraform_version",
];

test("the broker allowlist is exactly this set, and none of it can destroy", () => {
  const posture = getToolSecurityPosture();
  assert.deepEqual(posture.allowedTools, [...ALLOWLIST].sort(),
    "the broker allowlist changed. A new tool needs the review in docs/teardown-broker-review.md");
  assert.deepEqual(posture.mutationTools, []);
  assert.equal(posture.arbitraryShell, false);
  assert.ok(posture.allowedTools.every((tool) => !/destroy/i.test(tool)));
  const context = { cwd: process.cwd(), allowCloudRead: true, allowProjectCodeExecution: true,
    allowPreviewWrite: true, allowManagedAccess: true, allowMutation: false as const };
  for (const tool of ["terraform_destroy", "terraform_plan_destroy", "terraform_apply", "pulumi_destroy",
    "pulumi_up", "opentofu_destroy", "cdk_deploy", "cdk_destroy", "cloudformation_delete_stack"]) {
    const result = executeTool({ tool: tool as ToolName }, context);
    assert.ok(!Array.isArray(result) && result.blocked === true && /allowlist/i.test(result.reason ?? ""), tool);
  }
  // Mutation capability is refused even for an allowed tool.
  const result = executeTool({ tool: "terraform_plan" }, { ...context, allowMutation: true as unknown as false });
  assert.ok(!Array.isArray(result) && result.blocked === true && /Mutation capability/.test(result.reason ?? ""));
});

test("a destroy plan's JSON carries secrets in plaintext, and the normalized change set keeps none of them", () => {
  const json = readFileSync(resolve("test/fixtures/live/terraform/destroy-sensitive-values.plan.json"), "utf8");
  const plan = JSON.parse(json) as {
    resource_changes: Array<{ change: { before: { input: string }; before_sensitive: { input: boolean } } }>;
    prior_state: unknown;
  };
  // The hazard (real Terraform 1.16.5): `show -json` flags the value as sensitive AND prints it.
  assert.equal(plan.resource_changes[0].change.before_sensitive.input, true);
  assert.equal(plan.resource_changes[0].change.before.input, "hunter2-secret-value");
  assert.ok(JSON.stringify(plan.prior_state).includes("hunter2-secret-value"));
  // The property a destroy-preview runner relies on: only address, type and operation survive.
  const normalized = normalizeTerraformPlan(json);
  assert.deepEqual(normalized.resources, [{ address: "terraform_data.db", type: "terraform_data", operation: "DELETE" }]);
  assert.equal(JSON.stringify(normalized).includes("hunter2"), false);
});
