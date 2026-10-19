import test from "node:test";
import assert from "node:assert/strict";
import { assessEarlyAwsExecution, type ExecutionRequest } from "../src/integrations/ai-studio/aws-execution.js";

const eligible: ExecutionRequest = {
  provider: "AWS", engine: "TERRAFORM", environment: "DEV",
  caller: "OPERATOR", targetClass: "INTERNAL_PILOT", operation: "APPLY",
  governance: "EXISTING_CONTROL_TOWER",
  resourceActions: [{ resourceType: "aws_cloudwatch_log_group", action: "CREATE" }],
  pilotContractPinned: true, engineQualified: true,
  targetIdentityVerified: true, sealedArtifactVerified: true,
  signedApprovalsVerified: true
};

test("early AWS Terraform and CDK internal DEV pilot may proceed only through human driver", () => {
  for (const engine of ["TERRAFORM", "CDK"] as const) {
    assert.deepEqual(assessEarlyAwsExecution({ ...eligible, engine }), {
      status: "PILOT_ELIGIBLE", route: "HUMAN_PILOT_DRIVER", reasons: []
    });
  }
});

test("agent cannot directly apply even when other evidence passes", () => {
  const result = assessEarlyAwsExecution({ ...eligible, caller: "AI_STUDIO_AGENT" });
  assert.equal(result.status, "BLOCKED");
  assert.ok(result.reasons.includes("AGENT_CANNOT_EXECUTE_APPLY"));
});

test("CloudFormation and Pulumi may not use Terraform/CDK pilot apply contract", () => {
  for (const engine of ["CLOUDFORMATION", "PULUMI"] as const) {
    const result = assessEarlyAwsExecution({ ...eligible, engine });
    assert.equal(result.status, "BLOCKED");
    assert.ok(result.reasons.includes("APPLY_ENGINE_NOT_IN_PILOT_CONTRACT"));
  }
});

test("missing any gate fails closed", () => {
  const keys = ["pilotContractPinned", "engineQualified", "targetIdentityVerified", "sealedArtifactVerified", "signedApprovalsVerified"] as const;
  for (const key of keys) {
    const result = assessEarlyAwsExecution({ ...eligible, [key]: false });
    assert.equal(result.status, "BLOCKED");
  }
});

test("customer target and non-DEV early applies are refused", () => {
  assert.equal(assessEarlyAwsExecution({ ...eligible, targetClass: "CUSTOMER" }).status, "BLOCKED");
  assert.equal(assessEarlyAwsExecution({ ...eligible, environment: "PROD" }).status, "BLOCKED");
});

test("preview eligibility is distinct from apply authorization", () => {
  const result = assessEarlyAwsExecution({
    ...eligible, caller: "AI_STUDIO_AGENT", engine: "PULUMI",
    operation: "PREVIEW", pilotContractPinned: false,
    engineQualified: false, signedApprovalsVerified: false
  });
  assert.equal(result.status, "PILOT_ELIGIBLE");
  assert.equal(result.route, "HUMAN_PILOT_DRIVER");
});

test("never proposes a parallel Control Tower or Organizations deployment", () => {
  for (const resourceType of [
    "AWS::ControlTower::LandingZone", "aws_controltower_landing_zone",
    "aws_organizations_organization", "AWS::Organizations::Account",
    "aws_organizations_policy", "AWS::Organizations::OrganizationalUnit",
  ]) {
    for (const operation of ["PREVIEW", "APPLY"] as const) {
      const r = assessEarlyAwsExecution({
        ...eligible, operation, resourceActions: [{ resourceType, action: "CREATE" }]
      });
      assert.equal(r.status, "BLOCKED");
      assert.ok(r.reasons.includes("GOVERNANCE_MUTATION_FORBIDDEN"));
    }
  }
});

test("read-only discovery of existing Control Tower and Organizations is allowed", () => {
  const r = assessEarlyAwsExecution({
    ...eligible, operation: "PREVIEW", caller: "AI_STUDIO_AGENT",
    resourceActions: [{ resourceType: "AWS::ControlTower::LandingZone", action: "READ" }]
  });
  assert.equal(r.status, "PILOT_ELIGIBLE");
});

test("unknown governance, attempted adoption and non-additive changes fail closed", () => {
  assert.equal(assessEarlyAwsExecution({ ...eligible, governance: "UNVERIFIED" }).status, "BLOCKED");
  for (const action of ["UPDATE", "DELETE", "IMPORT"] as const) {
    const r = assessEarlyAwsExecution({
      ...eligible, resourceActions: [{ resourceType: "aws_iam_role", action }]
    });
    assert.equal(r.status, "BLOCKED");
    assert.ok(r.reasons.includes("EARLY_EXECUTION_ADDITIVE_ONLY"));
  }
});

test("valid additive workload resource inside inherited governance remains eligible", () => {
  const r = assessEarlyAwsExecution({
    ...eligible, governance: "EXISTING_ORGANIZATIONS",
    resourceActions: [{ resourceType: "aws_cloudwatch_log_group", action: "CREATE" }]
  });
  assert.equal(r.status, "PILOT_ELIGIBLE");
});
