import test from "node:test";
import assert from "node:assert/strict";
import { parseArgs } from "../src/cli/lz-live-journey.js";

test("explicit Terraform operator preview arguments are parsed without ACT", () => {
  const args = parseArgs([
    "--instruction", "Design a governed AWS landing zone preview",
    "--engine", "terraform", "--account", "123456789012",
    "--region", "us-east-2", "--workspace", "qualification/aws",
    "--allow-project-code",
  ]);
  assert.equal(args.engine, "TERRAFORM");
  assert.equal(args.allowProjectCodeExecution, true);
  assert.equal(args.allowPreviewWrite, false);
  assert.equal(args.expectedAccount, "123456789012");
});

test("CDK needs explicitly separate preview-write opt-in", () => {
  const args = parseArgs([
    "--instruction", "Design AWS CDK preview", "--engine", "cdk",
    "--account", "123456789012", "--region", "us-east-2",
    "--workspace", "qualification/aws", "--stack", "ExistingStack",
    "--allow-project-code", "--allow-preview-write",
  ]);
  assert.equal(args.engine, "AWS_CDK");
  assert.equal(args.allowPreviewWrite, true);
  assert.equal(args.stack, "ExistingStack");
});

test("unknown and duplicate command flags are refused", () => {
  assert.throws(() => parseArgs(["--engine", "terraform", "--apply"]), /UNKNOWN_OPTION/);
  assert.throws(() => parseArgs(["--allow-project-code", "--allow-project-code"]),
    /DUPLICATE_OPTION/);
  assert.throws(() => parseArgs(["--engine", "terraform"]), /MISSING_OPTION/);
});
