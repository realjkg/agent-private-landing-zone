import assert from "node:assert/strict";
import test from "node:test";

import { normalizePulumiPreview } from "../src/iac/pulumi-preview.js";
import { normalizeTerraformPlan } from "../src/iac/terraform-plan.js";

test("Terraform plan normalizes create update delete and replacement", () => {
  const result = normalizeTerraformPlan(
    JSON.stringify({
      resource_changes: [
        {
          address: "aws_s3_bucket.new",
          type: "aws_s3_bucket",
          change: { actions: ["create"] },
        },
        {
          address: "aws_iam_role.update",
          type: "aws_iam_role",
          change: { actions: ["update"] },
        },
        {
          address: "aws_security_group.old",
          type: "aws_security_group",
          change: { actions: ["delete"] },
        },
        {
          address: "aws_instance.replace",
          type: "aws_instance",
          change: {
            actions: ["delete", "create"],
          },
        },
      ],
    }),
  );

  assert.equal(result.creates, 1);
  assert.equal(result.updates, 1);
  assert.equal(result.deletes, 1);
  assert.equal(result.replacements, 1);
  assert.equal(result.destructive, true);
  assert.equal(
    result.evidenceHash.length,
    64,
  );
});

test("Pulumi preview normalizes operations and de-duplicates replacement steps", () => {
  const urn =
    "urn:pulumi:dev::app::aws:s3/bucket:Bucket::data";

  const result = normalizePulumiPreview(
    JSON.stringify({
      steps: [
        {
          op: "create-replacement",
          urn,
          type: "aws:s3/bucket:Bucket",
        },
        {
          op: "delete-replaced",
          urn,
          type: "aws:s3/bucket:Bucket",
        },
        {
          op: "create",
          urn:
            "urn:pulumi:dev::app::aws:iam/role:Role::agent",
          type: "aws:iam/role:Role",
        },
      ],
    }),
  );

  assert.equal(result.creates, 1);
  assert.equal(result.replacements, 1);
  assert.equal(result.deletes, 0);
  assert.equal(result.destructive, true);
});

test("normalized change sets do not retain raw plan values", () => {
  const secret =
    "DO_NOT_PERSIST_THIS_VALUE";

  const result = normalizeTerraformPlan(
    JSON.stringify({
      resource_changes: [
        {
          address: "aws_ssm_parameter.secret",
          type: "aws_ssm_parameter",
          change: {
            actions: ["update"],
            before: { value: secret },
            after: { value: secret },
          },
        },
      ],
    }),
  );

  assert.equal(
    JSON.stringify(result).includes(secret),
    false,
  );
});
