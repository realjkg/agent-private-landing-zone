/** D4 operator-configured target binding; no credentials, network or mutation. */
export type AwsQualificationTarget = {
  expectedRoleArn: string;
  expectedAccountId: string;
  configuredRegion: string;
  stackName: string;
  actualCallerArn: string;
  actualAccountId: string;
};
export type AwsQualificationBinding = {
  allowed: boolean;
  reasons: string[];
  accountId?: string;
  roleName?: string;
};
const ACCOUNT=/^[0-9]{12}$/;
const REGION=/^[a-z]{2}(?:-gov)?-[a-z]+-\d$/;
const STACK=/^[A-Za-z][A-Za-z0-9-]{0,127}$/;
const ROLE=/^arn:(aws|aws-us-gov|aws-cn):iam::([0-9]{12}):role\/((?:[A-Za-z0-9+=,.@_-]+\/)*[A-Za-z0-9+=,.@_-]+)$/;
const CALLER=/^arn:(aws|aws-us-gov|aws-cn):sts::([0-9]{12}):assumed-role\/([A-Za-z0-9+=,.@_-]+)\/([A-Za-z0-9+=,.@_-]+)$/;
export function assessAwsQualificationTarget(t: AwsQualificationTarget): AwsQualificationBinding {
  const reasons: string[]=[];
  if (!t || typeof t!=="object") return {allowed:false,reasons:["AWS_TARGET_MISSING"]};
  const expected=typeof t.expectedRoleArn==="string" ? ROLE.exec(t.expectedRoleArn) : null;
  const actual=typeof t.actualCallerArn==="string" ? CALLER.exec(t.actualCallerArn) : null;
  if (!expected) reasons.push("AWS_EXPECTED_ROLE_INVALID");
  if (!actual) reasons.push("AWS_CALLER_NOT_ASSUMED_ROLE");
  if (typeof t.expectedAccountId!=="string" || !ACCOUNT.test(t.expectedAccountId))
    reasons.push("AWS_EXPECTED_ACCOUNT_INVALID");
  if (typeof t.actualAccountId!=="string" || !ACCOUNT.test(t.actualAccountId))
    reasons.push("AWS_ACTUAL_ACCOUNT_INVALID");
  if (expected && actual && (
    expected[1]!==actual[1] ||
    expected[2]!==actual[2] ||
    expected[3]?.split("/").at(-1)!==actual[3]))
    reasons.push("AWS_ASSUMED_ROLE_MISMATCH");
  if (expected && t.expectedAccountId!==expected[2]) reasons.push("AWS_ROLE_ACCOUNT_MISMATCH");
  if (actual && t.actualAccountId!==actual[2]) reasons.push("AWS_CALLER_ACCOUNT_MISMATCH");
  if (t.expectedAccountId!==t.actualAccountId) reasons.push("AWS_WRONG_TARGET_ACCOUNT");
  if (typeof t.configuredRegion!=="string" || !REGION.test(t.configuredRegion))
    reasons.push("AWS_QUALIFICATION_REGION_INVALID");
  if (typeof t.stackName!=="string" || !STACK.test(t.stackName))
    reasons.push("AWS_QUALIFICATION_STACK_INVALID");
  return {
    allowed:reasons.length===0,
    reasons,
    ...(reasons.length===0?{accountId:t.actualAccountId,roleName:actual![3]}:{})
  };
}
