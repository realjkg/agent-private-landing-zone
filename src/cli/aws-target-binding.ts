import { assessAwsQualificationTarget } from "../qualification/aws-target-binding.js";
// This preflight consumes identity metadata only, never credentials or tokens.
const values={
 expectedRoleArn:process.env.AWS_QUALIFICATION_ROLE_ARN??"",
 expectedAccountId:process.env.AWS_QUALIFICATION_ACCOUNT_ID??"",
 configuredRegion:process.env.AWS_QUALIFICATION_REGION??"",
 stackName:process.env.AWS_QUALIFICATION_STACK_NAME??"",
 actualCallerArn:process.env.AWS_QUALIFICATION_CALLER_ARN??"",
 actualAccountId:process.env.AWS_QUALIFICATION_CALLER_ACCOUNT??""
};
const result=assessAwsQualificationTarget(values);
if(!result.allowed) {
  console.error("AWS D4 TARGET BINDING BLOCKED: "+result.reasons.join(","));
  process.exitCode=1;
} else {
  console.log("AWS D4 target binding verified: account "+result.accountId+", role "+result.roleName+"; ACT DISABLED");
}
