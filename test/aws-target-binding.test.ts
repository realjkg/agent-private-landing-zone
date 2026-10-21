import assert from "node:assert/strict";
import test from "node:test";
import { assessAwsQualificationTarget, type AwsQualificationTarget } from "../src/qualification/aws-target-binding.js";
const good:AwsQualificationTarget={
 expectedRoleArn:"arn:aws:iam::123456789012:role/alz-qualification",
 expectedAccountId:"123456789012",configuredRegion:"us-east-1",
 stackName:"alz-qualify",actualCallerArn:"arn:aws:sts::123456789012:assumed-role/alz-qualification/alz-provider-123",
 actualAccountId:"123456789012"
};
const verify=(patch:Partial<AwsQualificationTarget>)=>assessAwsQualificationTarget({...good,...patch});
test("same federated role, account, and controlled stack qualify before preview",()=> {
 assert.equal(verify({}).allowed,true);
});
test("wrong accounts, reused accounts and root/user identities are denied",()=> {
 assert.ok(verify({actualAccountId:"210987654321"}).reasons.includes("AWS_WRONG_TARGET_ACCOUNT"));
 assert.ok(verify({expectedAccountId:"210987654321"}).reasons.includes("AWS_ROLE_ACCOUNT_MISMATCH"));
 assert.ok(verify({actualCallerArn:"arn:aws:iam::123456789012:root"}).reasons.includes("AWS_CALLER_NOT_ASSUMED_ROLE"));
 assert.ok(verify({actualCallerArn:"arn:aws:iam::123456789012:user/admin"}).reasons.includes("AWS_CALLER_NOT_ASSUMED_ROLE"));
});
test("wrong assumed role or AWS partition cannot be mistaken for approved identity",()=> {
 assert.ok(verify({actualCallerArn:"arn:aws:sts::123456789012:assumed-role/other/session"}).reasons.includes("AWS_ASSUMED_ROLE_MISMATCH"));
 assert.ok(verify({actualCallerArn:"arn:aws-us-gov:sts::123456789012:assumed-role/alz-qualification/session"}).reasons.includes("AWS_ASSUMED_ROLE_MISMATCH"));
});
test("invalid role, stack, region and missing target fail closed",()=> {
 assert.ok(verify({expectedRoleArn:"role/alz-qualification"}).reasons.includes("AWS_EXPECTED_ROLE_INVALID"));
 assert.ok(verify({configuredRegion:"unknown"}).reasons.includes("AWS_QUALIFICATION_REGION_INVALID"));
 assert.ok(verify({stackName:"name; aws cloudformation execute-change-set"}).reasons.includes("AWS_QUALIFICATION_STACK_INVALID"));
 assert.equal(assessAwsQualificationTarget(null as unknown as AwsQualificationTarget).allowed,false);
});
test("a role path is allowed but must match the assumed final role name",()=>{
 assert.equal(verify({expectedRoleArn:"arn:aws:iam::123456789012:role/qualifiers/alz-qualification"}).allowed,true);
});
