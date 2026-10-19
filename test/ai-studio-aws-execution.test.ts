import test from "node:test";
import assert from "node:assert/strict";
import { assessEarlyAwsExecution, type ExecutionRequest } from "../src/integrations/ai-studio/aws-execution.js";

const eligible: ExecutionRequest = {
  provider: "AWS", engine: "TERRAFORM", environment: "DEV",
  caller: "OPERATOR", targetClass: "INTERNAL_PILOT", operation: "APPLY",
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
