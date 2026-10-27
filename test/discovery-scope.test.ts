import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { isAllowedReadArgv } from "../src/observe/aws-cli.js";
import { CLOUD_CONTROL_TYPES, DATA_BEARING_TYPES, checkResource, cloudControlMappingOf, type AwsCli } from "../src/observe/verify.js";

// Owner decision 2026-10-27 (issue #39, comment 6440801434, item 2): read-only discovery defaults to control-plane
// metadata; application data and secret contents are excluded; an exception needs an explicit scope and purpose.
// Synthetic: these tests read the bootstrap's policy as written and run the verifier against a fake AWS CLI. That AWS
// enforces the policy is shown only by the live DEV qualification.

const root = new URL("../", import.meta.url);
const read = (path: string): string => readFileSync(new URL(path, root), "utf8");
type Group = { why: string; actions: string[] };
const policy = JSON.parse(read("bootstrap/aws/discovery-policy.json")) as { decision: string; allow: Record<string, Group>; deny: Record<string, Group> };
const allow = [...new Set(Object.values(policy.allow).flatMap((group) => group.actions))];
const deny = [...new Set(Object.values(policy.deny).flatMap((group) => group.actions))];
/** IAM action matching: case-insensitive, `*` matches any run of characters. */
const matches = (pattern: string, action: string): boolean =>
  new RegExp("^" + pattern.split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$", "i").test(action);

/**
 * The read-handler permissions of each Cloud Control type the verifier reads, from the CloudFormation resource provider
 * schemas (CloudformationSchema.zip, us-east-1, read 2026-10-27). Cloud Control calls these with the caller's credentials.
 */
const READ_HANDLERS: Record<string, string[]> = {
  "AWS::Logs::LogGroup": ["logs:DescribeLogGroups", "logs:ListTagsForResource", "logs:GetDataProtectionPolicy", "logs:DescribeIndexPolicies", "logs:DescribeResourcePolicies"],
  "AWS::S3::Bucket": ["s3:GetAccelerateConfiguration", "s3:GetLifecycleConfiguration", "s3:GetBucketPublicAccessBlock", "s3:GetAnalyticsConfiguration", "s3:GetBucketCORS",
    "s3:GetEncryptionConfiguration", "s3:GetInventoryConfiguration", "s3:GetBucketLogging", "s3:GetMetricsConfiguration", "s3:GetBucketNotification", "s3:GetBucketVersioning",
    "s3:GetReplicationConfiguration", "s3:GetBucketWebsite", "s3:GetBucketObjectLockConfiguration", "s3:GetBucketTagging", "s3:ListTagsForResource", "s3:GetBucketAbac",
    "s3:GetBucketOwnershipControls", "s3:GetIntelligentTieringConfiguration", "s3:GetBucketMetadataTableConfiguration", "s3:ListBucket"],
  "AWS::IAM::Role": ["iam:GetRole", "iam:ListAttachedRolePolicies", "iam:ListRolePolicies", "iam:GetRolePolicy"],
  "AWS::IAM::OIDCProvider": ["iam:GetOpenIDConnectProvider"],
  "AWS::SNS::Topic": ["sns:GetTopicAttributes", "sns:ListTagsForResource", "sns:ListSubscriptionsByTopic", "sns:GetDataProtectionPolicy"],
  "AWS::SQS::Queue": ["sqs:GetQueueAttributes", "sqs:ListQueueTags"],
  "AWS::KMS::Key": ["kms:DescribeKey", "kms:GetKeyPolicy", "kms:GetKeyRotationStatus", "kms:ListResourceTags"],
  "AWS::DynamoDB::Table": ["dynamodb:DescribeTable", "dynamodb:DescribeContinuousBackups", "dynamodb:DescribeContributorInsights", "dynamodb:DescribeKinesisStreamingDestination",
    "dynamodb:ListTagsOfResource", "dynamodb:GetResourcePolicy", "dynamodb:DescribeTimeToLive"],
  "AWS::EC2::VPC": ["ec2:DescribeNetworkAcls", "ec2:DescribeSecurityGroups", "ec2:DescribeVpcAttribute", "ec2:DescribeVpcEncryptionControls", "ec2:DescribeVpcs"],
  "AWS::EC2::Subnet": ["ec2:DescribeSubnets", "ec2:DescribeNetworkAcls"],
  "AWS::EC2::SecurityGroup": ["ec2:DescribeSecurityGroups"],
};
/** Read handlers that return data or secrets, from the same schemas: why these types are never read. */
const DATA_BEARING_HANDLERS: Record<string, string[]> = {
  "AWS::Lambda::Function": ["lambda:GetFunction", "kms:Decrypt"],
  "AWS::SSM::Parameter": ["ssm:GetParameters"],
  "AWS::SecretsManager::Secret": ["secretsmanager:GetSecretValue"],
};

test("the DISCOVERY deny names every data-plane and secret read the owner decision excludes", () => {
  for (const action of ["s3:GetObject*", "dynamodb:GetItem", "dynamodb:BatchGetItem", "dynamodb:Query", "dynamodb:Scan", "logs:GetLogEvents", "logs:FilterLogEvents",
    "logs:StartQuery", "secretsmanager:GetSecretValue", "ssm:GetParameter", "ssm:GetParameters", "ssm:GetParametersByPath", "kms:Decrypt", "sqs:ReceiveMessage",
    "kinesis:GetRecords", "rds-data:*", "athena:GetQueryResults", "lambda:GetFunction", "lambda:GetFunctionConfiguration"]) {
    assert.ok(deny.includes(action), "denied: " + action);
  }
  for (const action of ["s3:GetObject", "s3:GetObjectVersion", "s3:GetObjectAttributes", "rds-data:ExecuteStatement"]) {
    assert.ok(deny.some((pattern) => matches(pattern, action)), "covered by a deny pattern: " + action);
  }
  assert.match(policy.decision, /6440801434/);
});

test("no allowed read is a denied read, and every allowed action is a read", () => {
  for (const action of allow) {
    assert.ok(!deny.some((pattern) => matches(pattern, action)), "allowed and denied at once: " + action);
    assert.match(action, /^[a-z0-9-]+:(Describe|Get|List)[A-Za-z]+$/, "a read, named exactly: " + action);
  }
});

test("the allow covers exactly the reads the product makes as DISCOVERY", () => {
  // The verifier's two argument shapes (src/observe/aws-cli.ts): Cloud Control GetResource and the tagging API.
  assert.ok(isAllowedReadArgv(["cloudcontrol", "get-resource", "--type-name", "AWS::S3::Bucket", "--identifier", "b", "--region", "us-east-1", "--output", "json"]));
  assert.ok(isAllowedReadArgv(["resourcegroupstaggingapi", "get-resources", "--tag-filters", "Key=k,Values=v", "--region", "us-east-1", "--output", "json"]));
  for (const action of ["cloudformation:GetResource", "tag:GetResources", "cloudformation:DescribeStacks", "cloudformation:DescribeStackResources",
    "organizations:DescribeOrganization", "organizations:ListPolicies", "controltower:ListLandingZones", "controltower:ListLandingZoneOperations",
    "controltower:GetLandingZoneOperation", "config:DescribeConfigurationRecorders", "cloudtrail:DescribeTrails"]) {
    assert.ok(allow.includes(action), "allowed: " + action);
  }
  // Each Cloud Control type the verifier reads has its read handler's permissions, and nothing is allowed that no read needs.
  const typeNames = new Set(Object.values(CLOUD_CONTROL_TYPES).map((mapping) => mapping.typeName));
  assert.deepEqual([...typeNames].sort(), Object.keys(READ_HANDLERS).sort(), "every verifier type has a recorded read handler");
  for (const [type, actions] of Object.entries(READ_HANDLERS)) for (const action of actions) assert.ok(allow.includes(action), type + " needs " + action);
  const needed = new Set([...Object.values(READ_HANDLERS).flat(), ...policy.allow.cdkStackReads!.actions, ...policy.allow.independentObservation!.actions, ...policy.allow.previewDiscovery!.actions]);
  assert.deepEqual(allow.filter((action) => !needed.has(action)), [], "no unexplained allow");
});

test("bootstrap: the default is ViewOnlyAccess, the deny is inline and independent of the managed list, and broad overrides are refused", () => {
  const variables = read("bootstrap/aws/variables.tf");
  const discovery = read("bootstrap/aws/discovery.tf");
  assert.match(variables, /default\s+=\s+\["arn:aws:iam::aws:policy\/job-function\/ViewOnlyAccess"\]/);
  assert.doesNotMatch(variables, /default\s+=\s+\["arn:aws:iam::aws:policy\/ReadOnlyAccess"\]/);
  assert.match(variables, /scope[^"]*purpose/, "the override's documentation asks for scope and purpose");
  assert.match(discovery, /file\("\$\{path\.module\}\/discovery-policy\.json"\)/);
  assert.match(discovery, /role\s+=\s+aws_iam_role\.identity\["DISCOVERY"\]\.name/);
  const code = discovery.split("\n").filter((line) => !/^\s*#/.test(line)).join("\n");
  assert.doesNotMatch(code.split("check \"discovery_managed_policy_scope\"")[0]!, /discovery_managed_policy_arns/, "the deny never depends on the managed list");
  assert.match(discovery, /check "discovery_managed_policy_scope"[\s\S]*ReadOnlyAccess/, "ReadOnlyAccess draws a plan warning");
  // The refusal pattern, as Terraform's regex reads it (RE2; the same syntax in JavaScript for this pattern).
  const source = /regex\(\s*"([^"]+)", arn/.exec(variables)?.[1]?.replace(/\\\\/g, "\\");
  assert.ok(source);
  const broad = new RegExp(source);
  for (const arn of ["arn:aws:iam::aws:policy/AdministratorAccess", "arn:aws:iam::aws:policy/PowerUserAccess", "arn:aws:iam::aws:policy/AmazonS3FullAccess",
    "arn:aws:iam::aws:policy/job-function/SystemAdministrator", "arn:aws:iam::aws:policy/job-function/DatabaseAdministrator", "arn:aws-us-gov:iam::aws:policy/AdministratorAccess"]) {
    assert.ok(broad.test(arn), "refused: " + arn);
  }
  for (const arn of ["arn:aws:iam::aws:policy/job-function/ViewOnlyAccess", "arn:aws:iam::aws:policy/ReadOnlyAccess", "arn:aws:iam::aws:policy/SecurityAudit",
    "arn:aws:iam::111111111111:policy/pilot-discovery-reads"]) {
    assert.ok(!broad.test(arn), "accepted: " + arn);
  }
  assert.match(variables, /variable "discovery_data_read_exceptions"[\s\S]*purpose\s+=\s+string/);
});

test("observe: a type whose read returns data or secrets is never read, and is named, not assumed", async () => {
  const calls: string[][] = [];
  const aws: AwsCli = async (argv) => { calls.push([...argv]); return { code: 0, stdout: "{}", stderr: "" }; };
  for (const type of DATA_BEARING_TYPES) {
    assert.equal(CLOUD_CONTROL_TYPES[type], undefined, type);
    const check = await checkResource({ address: "x." + type, type, arn: null, id: "pilot-fn", origin: "IN_PLAN" }, "us-east-1", aws);
    assert.equal(check.existence, "NOT_CHECKABLE", type);
    assert.equal(check.reason, "DATA_BEARING_READ_EXCLUDED", type);
  }
  assert.deepEqual(calls, [], "no Cloud Control read is sent for a data-bearing type");
  for (const [type, actions] of Object.entries(DATA_BEARING_HANDLERS)) {
    assert.ok(DATA_BEARING_TYPES.has(type), type);
    assert.equal(cloudControlMappingOf(type) === undefined || DATA_BEARING_TYPES.has(type), true);
    assert.ok(actions.some((action) => deny.some((pattern) => matches(pattern, action))), type + ": its read handler is denied");
  }
});
