import assert from "node:assert/strict";
import test from "node:test";

import { normalizeAnsibleCheck } from "../src/iac/ansible-check.js";
import { normalizeBicepWhatIf } from "../src/iac/bicep-whatif.js";
import { normalizeCloudFormationChangeSet } from "../src/iac/cloudformation-changeset.js";
import { normalizeCrossplaneRender } from "../src/iac/crossplane-render.js";
import { normalizePulumiPreview } from "../src/iac/pulumi-preview.js";
import {
  normalizeOpenTofuPlan,
  normalizeTerraformPlan,
} from "../src/iac/terraform-plan.js";

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


test("OpenTofu reuses Terraform-compatible plan normalization without retaining values", () => {
  const secret =
    "DO_NOT_PERSIST_OPENTOFU_SECRET";

  const result = normalizeOpenTofuPlan(
    JSON.stringify({
      resource_changes: [
        {
          address: "aws_kms_key.audit",
          type: "aws_kms_key",
          change: {
            actions: ["create"],
            after: {
              description: secret,
            },
          },
        },
      ],
    }),
  );

  assert.equal(
    result.engine,
    "OPENTOFU",
  );
  assert.equal(result.creates, 1);
  assert.equal(
    JSON.stringify(result).includes(secret),
    false,
  );
});


test("CloudFormation change sets normalize replacement conservatively", () => {
  const result =
    normalizeCloudFormationChangeSet(
      JSON.stringify({
        Changes: [
          {
            ResourceChange: {
              Action: "Add",
              LogicalResourceId: "NewBucket",
              ResourceType:
                "AWS::S3::Bucket",
              Replacement: "False",
            },
          },
          {
            ResourceChange: {
              Action: "Modify",
              LogicalResourceId:
                "ExistingRole",
              ResourceType:
                "AWS::IAM::Role",
              Replacement:
                "Conditional",
            },
          },
          {
            ResourceChange: {
              Action: "Remove",
              LogicalResourceId:
                "OldTopic",
              ResourceType:
                "AWS::SNS::Topic",
              Replacement: "False",
            },
          },
        ],
      }),
    );

  assert.equal(
    result.engine,
    "CLOUDFORMATION",
  );
  assert.equal(result.creates, 1);
  assert.equal(
    result.replacements,
    1,
  );
  assert.equal(result.deletes, 1);
  assert.equal(
    result.destructive,
    true,
  );
});

test("CloudFormation import semantics fail closed as unknown", () => {
  const result =
    normalizeCloudFormationChangeSet(
      JSON.stringify({
        Changes: [
          {
            ResourceChange: {
              Action: "Import",
              LogicalResourceId:
                "ExistingTable",
              ResourceType:
                "AWS::DynamoDB::Table",
            },
          },
        ],
      }),
    );

  assert.equal(result.unknown, 1);
});

test("Bicep ResourceIdOnly what-if normalizes without property payloads", () => {
  const result =
    normalizeBicepWhatIf(
      JSON.stringify({
        changes: [
          {
            resourceId:
              "/subscriptions/example/resourceGroups/rg/providers/Microsoft.Storage/storageAccounts/new",
            changeType: "Create",
          },
          {
            resourceId:
              "/subscriptions/example/resourceGroups/rg/providers/Microsoft.Network/virtualNetworks/vnet",
            changeType: "Modify",
          },
          {
            resourceId:
              "/subscriptions/example/resourceGroups/rg/providers/Microsoft.KeyVault/vaults/old",
            changeType: "Delete",
          },
          {
            resourceId:
              "/subscriptions/example/resourceGroups/rg/providers/Microsoft.Insights/components/unknown",
            changeType:
              "Unsupported",
          },
        ],
      }),
    );

  assert.equal(result.engine, "BICEP");
  assert.equal(result.creates, 1);
  assert.equal(result.updates, 1);
  assert.equal(result.deletes, 1);
  assert.equal(result.unknown, 1);
});


test("Ansible check mode normalizes host-level change evidence", () => {
  const result =
    normalizeAnsibleCheck(
      [
        "PLAY RECAP ****",
        "edge-01 : ok=4 changed=2 unreachable=0 failed=0 skipped=1 rescued=0 ignored=0",
        "edge-02 : ok=4 changed=0 unreachable=0 failed=0 skipped=1 rescued=0 ignored=0",
      ].join("\n"),
    );

  assert.equal(
    result.engine,
    "ANSIBLE",
  );
  assert.equal(result.updates, 1);
  assert.equal(result.unchanged, 1);
  assert.equal(result.unknown, 0);
});

test("Ansible check mode fails closed when recap is missing", () => {
  const result =
    normalizeAnsibleCheck(
      "module output without recap",
    );

  assert.equal(result.unknown, 1);
});

test("Crossplane render normalizes resources as unknown until reconciliation is observed", () => {
  const result =
    normalizeCrossplaneRender(
      [
        "apiVersion: s3.aws.upbound.io/v1beta1",
        "kind: Bucket",
        "metadata:",
        "  name: audit-bucket",
        "---",
        "apiVersion: iam.aws.upbound.io/v1beta1",
        "kind: Role",
        "metadata:",
        "  name: audit-role",
      ].join("\n"),
    );

  assert.equal(
    result.engine,
    "CROSSPLANE",
  );
  assert.equal(result.unknown, 2);
  assert.equal(result.creates, 0);
  assert.equal(result.updates, 0);
  assert.equal(result.destructive, false);
});
