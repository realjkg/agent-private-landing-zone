import test from "node:test";
import assert from "node:assert/strict";
import { classifyAwsResource } from "../src/integrations/ai-studio/aws-governance.js";

test("read existing governance via AWS APIs without making another estate", () => {
  for (const resourceType of ["AWS::ControlTower::LandingZone", "aws_organizations_organization", "AWS::Organizations::Policy"]) {
    assert.equal(classifyAwsResource({ resourceType, action: "READ" }).verdict, "REUSE");
  }
});
test("block duplicate estate roots with IaC engine resource aliases", () => {
  for (const resourceType of ["AWS::ControlTower::LandingZone", "aws_controltower_landing_zone", "aws_organizations_organization", "AWS::Organizations::Organization"]) {
    for (const action of ["CREATE", "UPDATE", "DELETE", "IMPORT"] as const) {
      assert.equal(classifyAwsResource({ resourceType, action }, { organization: "EXISTS", landingZone: "EXISTS", managementAccountVerified: true }).verdict, action === "CREATE" ? "PARALLEL_GOVERNANCE_FORBIDDEN" : "GOVERNANCE_APPROVAL_REQUIRED");
    }
  }
});
test("existing controls, accounts, baselines, SCP and account factory are separately authorized", () => {
  for (const resourceType of ["AWS::ControlTower::EnabledControl", "aws_controltower_control", "AWS::Organizations::Policy",
    "aws_organizations_policy", "aws_organizations_account", "AWS::Organizations::OrganizationalUnit",
    "aws_servicecatalog_provisioned_product", "aws_controltower_enabled_baseline"]) {
    assert.equal(classifyAwsResource({ resourceType, action: "CREATE" }).verdict, "GOVERNANCE_APPROVAL_REQUIRED");
  }
});
test("additive application resources stay eligible for ordinary plan gates", () => {
  for (const resourceType of ["aws_cloudwatch_log_group", "AWS::EC2::VPC", "aws_iam_role"]) {
    assert.equal(classifyAwsResource({ resourceType, action: "CREATE" }).verdict, "APPLICATION_CHANGE");
  }
});
test("ambiguous governance names and malformed resource types fail closed", () => {
  for (const resourceType of ["control_tower-custom-thing", "custom_landing_zone", ""]) {
    assert.equal(classifyAwsResource({ resourceType, action: "CREATE" }).verdict, "UNKNOWN_REVIEW_REQUIRED");
  }
});

test("first-time landing-zone bootstrap requires attested absence and management identity", () => {
  const intent = { resourceType: "AWS::ControlTower::LandingZone", action: "CREATE" } as const;
  assert.equal(classifyAwsResource(intent, {organization:"EXISTS",landingZone:"ABSENT",managementAccountVerified:true}).verdict,"BOOTSTRAP_APPROVAL_REQUIRED");
  assert.equal(classifyAwsResource(intent, {organization:"EXISTS",landingZone:"ABSENT",managementAccountVerified:false}).verdict,"UNKNOWN_REVIEW_REQUIRED");
  assert.equal(classifyAwsResource(intent, {organization:"EXISTS",landingZone:"UNKNOWN",managementAccountVerified:true}).verdict,"UNKNOWN_REVIEW_REQUIRED");
  assert.equal(classifyAwsResource(intent, {organization:"EXISTS",landingZone:"EXISTS",managementAccountVerified:true}).verdict,"PARALLEL_GOVERNANCE_FORBIDDEN");
});
test("first-time organization creation is separately approved only with verified absence", () => {
  const intent = {resourceType:"aws_organizations_organization",action:"CREATE"} as const;
  assert.equal(classifyAwsResource(intent,{organization:"ABSENT",landingZone:"ABSENT",managementAccountVerified:true}).verdict,"BOOTSTRAP_APPROVAL_REQUIRED");
  assert.equal(classifyAwsResource(intent,{organization:"EXISTS",landingZone:"ABSENT",managementAccountVerified:true}).verdict,"PARALLEL_GOVERNANCE_FORBIDDEN");
});
