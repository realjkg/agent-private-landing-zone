import assert from "node:assert/strict";
import test from "node:test";

import { AWS_CONTAINER_PREFIXES } from "../src/apply/aws-containers.js";
import { SCAN_DEPTH, blueprintFromTerraformState } from "../src/observe/blueprint.js";
import { cleanupDisposition, retentionProblems } from "../src/observe/disposition.js";
import { CLOUD_CONTROL_TYPES, observeBlueprint, type AwsCli } from "../src/observe/verify.js";

// Observe and cleanup (docs/observe-and-cleanup.md): the blueprint read from the state, the independent Cloud Control
// check, and the disposition after cleanup. The AWS CLI is a fake here; this is synthetic evidence.

/** Real `terraform show -json` output from Terraform 1.16.4 (terraform_data in the root and in a child module). */
const REAL_SHOW = JSON.stringify({ format_version: "1.0", terraform_version: "1.16.4", values: { root_module: {
  resources: [{ address: "terraform_data.root", mode: "managed", type: "terraform_data", name: "root", provider_name: "terraform.io/builtin/terraform", schema_version: 0,
    values: { id: "5bdeca05-e8b9-3ab2-25f6-492121580363", input: "root-value-not-an-id", output: "root-value-not-an-id", store: null, triggers_replace: null }, sensitive_values: {} }],
  child_modules: [{ resources: [{ address: "module.child.terraform_data.inner", mode: "managed", type: "terraform_data", name: "inner", provider_name: "terraform.io/builtin/terraform", schema_version: 0,
    values: { id: "1cdf9124-b05f-a4e9-e119-d288f7ee59b1", input: "secret-like-value", output: "secret-like-value", store: null, triggers_replace: null }, sensitive_values: {} }],
  address: "module.child" }],
} } });

/** The pilot canary's shape (qualification/aws/act-dev1-canary): one log group, plus a bucket and an OIDC provider. Synthetic values. */
const LOG = "alz-act-dev1-canary";
const BUCKET = "alz-dev-state-000000000000";
const OIDC = "arn:aws:iam::000000000000:oidc-provider/token.actions.githubusercontent.com";
const AWS_SHOW = JSON.stringify({ format_version: "1.0", values: { root_module: { resources: [
  { address: "aws_cloudwatch_log_group.act_dev1", mode: "managed", type: "aws_cloudwatch_log_group",
    values: { id: LOG, arn: "arn:aws:logs:us-east-2:000000000000:log-group:" + LOG, retention_in_days: 1, kms_key_id: "SECRET-NOT-COPIED" } },
  { address: "aws_s3_bucket.state", mode: "managed", type: "aws_s3_bucket", values: { id: BUCKET, arn: "arn:aws:s3:::" + BUCKET, policy: "SECRET-NOT-COPIED" } },
  { address: "aws_s3_bucket_versioning.state", mode: "managed", type: "aws_s3_bucket_versioning", values: { id: BUCKET } },
  { address: "aws_iam_openid_connect_provider.github", mode: "managed", type: "aws_iam_openid_connect_provider", values: { id: OIDC, arn: OIDC } },
  { address: "data.aws_caller_identity.current", mode: "data", type: "aws_caller_identity", values: { id: "000000000000" } },
] } } });
const PLAN = [
  { address: "aws_cloudwatch_log_group.act_dev1", type: "aws_cloudwatch_log_group", action: "CREATE" },
  { address: "aws_s3_bucket.state", type: "aws_s3_bucket", action: "SAME" },
  { address: "aws_s3_bucket_versioning.state", type: "aws_s3_bucket_versioning", action: "UPDATE" },
  { address: "aws_iam_openid_connect_provider.github", type: "aws_iam_openid_connect_provider", action: "CREATE" },
  { address: "output.log_group", type: "output", action: "CREATE" },
];

/** A fake AWS CLI over a set of existing identifiers, recording every call. */
function fakeAws(existing: Set<string>, options: { fail?: Record<string, string>; tagged?: string[]; paginated?: boolean } = {}) {
  const calls: string[][] = [];
  const aws: AwsCli = async (argv) => {
    calls.push([...argv]);
    if (argv[0] === "resourcegroupstaggingapi") {
      return { code: 0, stderr: "", stdout: JSON.stringify({ ResourceTagMappingList: (options.tagged ?? []).map((arn) => ({ ResourceARN: arn, Tags: [] })),
        ...(options.paginated ? { PaginationToken: "next" } : {}) }) };
    }
    const identifier = argv[argv.indexOf("--identifier") + 1]!;
    const failure = options.fail?.[identifier];
    if (failure) return { code: 254, stdout: "", stderr: failure };
    if (existing.has(identifier)) return { code: 0, stderr: "", stdout: JSON.stringify({ TypeName: argv[3], ResourceDescription: { Identifier: identifier, Properties: "{\"Secret\":\"x\"}" } }) };
    return { code: 254, stdout: "", stderr: "An error occurred (ResourceNotFoundException) when calling the GetResource operation: not found" };
  };
  return { aws, calls };
}
const everything = new Set([LOG, BUCKET, OIDC]);

test("real terraform show output: managed resources from the root and child modules, identifiers only", () => {
  const blueprint = blueprintFromTerraformState(REAL_SHOW, [{ address: "terraform_data.root", type: "terraform_data", action: "CREATE" }]);
  assert.deepEqual(blueprint.entries, [
    { address: "module.child.terraform_data.inner", type: "terraform_data", arn: null, id: "1cdf9124-b05f-a4e9-e119-d288f7ee59b1", origin: "NOT_IN_PLAN" },
    { address: "terraform_data.root", type: "terraform_data", arn: null, id: "5bdeca05-e8b9-3ab2-25f6-492121580363", origin: "IN_PLAN" },
  ]);
  assert.deepEqual(blueprint.missing, []);
  assert.doesNotMatch(JSON.stringify(blueprint), /secret-like-value|root-value-not-an-id/);
  assert.throws(() => blueprintFromTerraformState("{}", []), /STATE_JSON_INVALID/);
  assert.throws(() => blueprintFromTerraformState('{"format_version": "1.0", "values": {"secret": "AKIA-LEAK"', []), (error: Error) =>
    /^STATE_JSON_INVALID/.test(error.message) && !error.message.includes("AKIA"), "a parse error never quotes the state");
  const key = JSON.stringify({ format_version: "1.0", values: { root_module: { resources: [
    { address: "aws_iam_access_key.ci", mode: "managed", type: "aws_iam_access_key", values: { id: "AKIAEXAMPLECREDENTIAL", secret: "S" } }] } } });
  assert.equal(blueprintFromTerraformState(key, []).entries[0]?.id, null, "a credential identifier is not copied");
});

test("the blueprint names what the plan left in place but the state lacks, and skips data sources and outputs", () => {
  const blueprint = blueprintFromTerraformState(AWS_SHOW, [...PLAN, { address: "aws_iam_role.apply", type: "aws_iam_role", action: "CREATE" },
    { address: "aws_s3_bucket.old", type: "aws_s3_bucket", action: "DELETE" }]);
  assert.deepEqual(blueprint.entries.map((x) => x.address), ["aws_cloudwatch_log_group.act_dev1", "aws_iam_openid_connect_provider.github", "aws_s3_bucket.state", "aws_s3_bucket_versioning.state"]);
  assert.deepEqual(blueprint.missing, ["aws_iam_role.apply"], "a planned create is missing; a planned delete is not expected");
  assert.doesNotMatch(JSON.stringify(blueprint), /SECRET-NOT-COPIED/);
});

test("observe: every resource present under its Cloud Control identifier is verified, read-only, with no property copied", async () => {
  const blueprint = blueprintFromTerraformState(AWS_SHOW, PLAN);
  const { aws, calls } = fakeAws(everything);
  const report = await observeBlueprint(blueprint, { unitId: "alz-unit-1", region: "us-east-2", aws });
  assert.equal(report.verdict, "PARTIAL", "the bucket's versioning is a setting, not a resource Cloud Control can read alone");
  assert.deepEqual(report.checks.map((x) => [x.address, x.existence, x.identifier]), [
    ["aws_cloudwatch_log_group.act_dev1", "PRESENT", LOG], ["aws_iam_openid_connect_provider.github", "PRESENT", OIDC],
    ["aws_s3_bucket.state", "PRESENT", BUCKET], ["aws_s3_bucket_versioning.state", "NOT_CHECKABLE", BUCKET],
  ]);
  assert.equal(report.inventory, "COMPLETE");
  for (const call of calls) assert.ok(["get-resource", "get-resources"].includes(call[1]!), "read-only calls only: " + call.join(" "));
  assert.ok(calls.some((call) => call.includes("AWS::IAM::OIDCProvider") && call.includes(OIDC)), "OIDC providers are named by ARN");
  assert.doesNotMatch(JSON.stringify(report), /Secret/);
  const checkable = { ...blueprint, entries: blueprint.entries.filter((x) => x.type in CLOUD_CONTROL_TYPES) };
  assert.equal((await observeBlueprint(checkable, { unitId: "alz-unit-1", region: "us-east-2", aws })).verdict, "VERIFIED");
});

test("observe denied: an absent resource, a planned resource missing from the state, or an unexpected tagged resource fails", async () => {
  const blueprint = blueprintFromTerraformState(AWS_SHOW, PLAN);
  const absent = await observeBlueprint(blueprint, { unitId: "u", region: "us-east-2", aws: fakeAws(new Set([BUCKET, OIDC])).aws });
  assert.equal(absent.verdict, "FAILED");
  assert.equal(absent.checks.find((x) => x.address === "aws_cloudwatch_log_group.act_dev1")?.existence, "ABSENT");
  const missing = await observeBlueprint({ ...blueprint, missing: ["aws_iam_role.apply"] }, { unitId: "u", region: "us-east-2", aws: fakeAws(everything).aws });
  assert.equal(missing.verdict, "FAILED");
  const extra = "arn:aws:sqs:us-east-2:000000000000:not-in-the-blueprint";
  const unexpected = await observeBlueprint(blueprint, { unitId: "u", region: "us-east-2", aws: fakeAws(everything, { tagged: [extra, "arn:aws:s3:::" + BUCKET] }).aws });
  assert.equal(unexpected.verdict, "FAILED");
  assert.deepEqual(unexpected.unexpected, [extra]);
  // AWS identifiers are compared exactly: an ARN that differs from a known one only in case names another resource and stays a stray.
  const spelled = "arn:aws:s3:::" + BUCKET.toUpperCase();
  const cased = await observeBlueprint(blueprint, { unitId: "u", region: "us-east-2", aws: fakeAws(everything, { tagged: [spelled, "arn:aws:s3:::" + BUCKET] }).aws });
  assert.equal(cased.verdict, "FAILED");
  assert.deepEqual(cased.unexpected, [spelled]);
  assert.equal(cased.inventory, "COMPLETE");
});

test("observe interrupted: access, throttling, credentials or a paginated listing never pass, and no unit tag caps the verdict", async () => {
  const blueprint = { entries: blueprintFromTerraformState(AWS_SHOW, PLAN).entries.filter((x) => x.type in CLOUD_CONTROL_TYPES), missing: [] };
  for (const [stderr, reason] of [["AccessDeniedException: not authorized", "ACCESS_DENIED"], ["ThrottlingException", "THROTTLED"],
    ["ExpiredTokenException", "CREDENTIALS"], ["something else", "CLI_ERROR"]] as const) {
    const report = await observeBlueprint(blueprint, { unitId: "u", region: "us-east-2", aws: fakeAws(everything, { fail: { [LOG]: stderr } }).aws });
    assert.equal(report.verdict, "INCONCLUSIVE", stderr);
    assert.equal(report.checks.find((x) => x.identifier === LOG)?.reason, reason);
    assert.doesNotMatch(JSON.stringify(report), /not authorized/, "the cloud's message is not copied");
  }
  const echoed = await observeBlueprint(blueprint, { unitId: "u", region: "us-east-2", aws: fakeAws(everything, { fail: { [LOG]: "AccessDenied: the role cannot read ResourceNotFoundException-named-thing" } }).aws });
  assert.equal(echoed.checks.find((x) => x.identifier === LOG)?.existence, "UNKNOWN", "only the CLI's own not-found line means absent");
  const nothing = await observeBlueprint({ entries: [], missing: [] }, { unitId: "u", region: "us-east-2", aws: fakeAws(everything).aws });
  assert.equal(nothing.verdict, "INCONCLUSIVE", "an empty blueprint verifies nothing");
  const thrown: AwsCli = async () => { throw new Error("spawn failed"); };
  assert.equal((await observeBlueprint(blueprint, { unitId: "u", region: "us-east-2", aws: thrown })).verdict, "INCONCLUSIVE");
  assert.equal((await observeBlueprint(blueprint, { unitId: "u", region: "us-east-2", aws: fakeAws(everything, { paginated: true }).aws })).verdict, "INCONCLUSIVE");
  const untagged = await observeBlueprint(blueprint, { unitId: null, region: "us-east-2", aws: fakeAws(everything).aws });
  assert.equal(untagged.verdict, "PARTIAL");
  assert.equal(untagged.inventory, "NOT_AVAILABLE");
});

test("cleanup: deleted only when the cloud says gone, kept only with an owner and reason, and leftovers are named", async () => {
  const blueprint = blueprintFromTerraformState(AWS_SHOW, PLAN);
  const keepBucket = [{ address: "aws_s3_bucket.state", owner: "platform-owner", reason: "The shared state bucket outlives this journey." },
    { address: "aws_s3_bucket_versioning.state", owner: "platform-owner", reason: "A setting of the kept state bucket." }];
  const clean = await cleanupDisposition(blueprint, keepBucket, { unitId: "u", region: "us-east-2", aws: fakeAws(new Set([BUCKET])).aws });
  assert.equal(clean.verdict, "CLEAN");
  assert.deepEqual(clean.dispositions.map((x) => [x.address, x.disposition]), [
    ["aws_cloudwatch_log_group.act_dev1", "DELETED"], ["aws_iam_openid_connect_provider.github", "DELETED"],
    ["aws_s3_bucket.state", "RETAINED"], ["aws_s3_bucket_versioning.state", "RETAINED"],
  ]);
  const left = await cleanupDisposition(blueprint, keepBucket, { unitId: "u", region: "us-east-2", aws: fakeAws(new Set([BUCKET, LOG])).aws });
  assert.equal(left.verdict, "LEFTOVERS");
  assert.equal(left.dispositions.find((x) => x.address === "aws_cloudwatch_log_group.act_dev1")?.disposition, "LEFTOVER");
  const unproven = await cleanupDisposition(blueprint, keepBucket, { unitId: "u", region: "us-east-2", aws: fakeAws(new Set([BUCKET]), { fail: { [OIDC]: "ThrottlingException" } }).aws });
  assert.equal(unproven.verdict, "INCONCLUSIVE");
  assert.equal(unproven.dispositions.find((x) => x.address === "aws_iam_openid_connect_provider.github")?.disposition, "UNPROVEN");
  const notCheckable = await cleanupDisposition(blueprint, keepBucket.slice(0, 1), { unitId: "u", region: "us-east-2", aws: fakeAws(new Set([BUCKET])).aws });
  assert.equal(notCheckable.verdict, "INCONCLUSIVE", "a setting nobody kept cannot be proven deleted");
  const gone = await cleanupDisposition(blueprint, keepBucket, { unitId: "u", region: "us-east-2", aws: fakeAws(new Set()).aws });
  assert.equal(gone.verdict, "INCONCLUSIVE");
  assert.deepEqual(gone.retainedButAbsent, ["aws_s3_bucket.state"]);
  const extra = "arn:aws:sqs:us-east-2:000000000000:outside-the-state";
  const untracked = await cleanupDisposition(blueprint, keepBucket, { unitId: "u", region: "us-east-2", aws: fakeAws(new Set([BUCKET]), { tagged: [extra] }).aws });
  assert.equal(untracked.verdict, "LEFTOVERS", "a resource still carrying the run's tag is a leftover even when the state never named it");
  assert.deepEqual(untracked.untrackedLeftovers, [extra]);
});

test("cleanup never reports completion it cannot prove: an empty or unmapped blueprint, no unit tag, or an incomplete listing", async () => {
  const blueprint = blueprintFromTerraformState(AWS_SHOW, PLAN);
  const keepBucket = [{ address: "aws_s3_bucket.state", owner: "platform-owner", reason: "The shared state bucket outlives this journey." },
    { address: "aws_s3_bucket_versioning.state", owner: "platform-owner", reason: "A setting of the kept state bucket." }];
  const allGone = fakeAws(new Set([BUCKET])).aws;
  // A blueprint rebuilt from the state after a destroy is empty: it must not read as a clean cleanup.
  const empty = await cleanupDisposition({ entries: [], missing: [] }, [], { unitId: "u", region: "us-east-2", aws: allGone });
  assert.equal(empty.verdict, "INCONCLUSIVE");
  assert.match(empty.unresolved.join(" "), /names no resources/);
  const unmapped = await cleanupDisposition({ ...blueprint, missing: ["aws_vpc.main"] }, keepBucket, { unitId: "u", region: "us-east-2", aws: allGone });
  assert.equal(unmapped.verdict, "INCONCLUSIVE");
  assert.match(unmapped.unresolved.join(" "), /aws_vpc\.main was planned but never mapped/);
  const untagged = await cleanupDisposition(blueprint, keepBucket, { unitId: null, region: "us-east-2", aws: allGone });
  assert.equal(untagged.verdict, "INCONCLUSIVE");
  assert.equal(untagged.inventory, "NOT_AVAILABLE");
  const paginated = await cleanupDisposition(blueprint, keepBucket, { unitId: "u", region: "us-east-2", aws: fakeAws(new Set([BUCKET]), { paginated: true }).aws });
  assert.equal(paginated.verdict, "INCONCLUSIVE");
  assert.equal(paginated.inventory, "INCOMPLETE");
  const listingFails: AwsCli = async (argv) => argv[0] === "resourcegroupstaggingapi" ? { code: 255, stdout: "", stderr: "ThrottlingException" } : allGone(argv);
  const failed = await cleanupDisposition(blueprint, keepBucket, { unitId: "u", region: "us-east-2", aws: listingFails });
  assert.equal(failed.verdict, "INCONCLUSIVE");
  assert.equal(failed.inventory, "INCOMPLETE");
  const extra = "arn:aws:sqs:us-east-2:000000000000:outside-the-state";
  const emptyButTagged = await cleanupDisposition({ entries: [], missing: [] }, [], { unitId: "u", region: "us-east-2", aws: fakeAws(new Set(), { tagged: [extra] }).aws });
  assert.equal(emptyButTagged.verdict, "LEFTOVERS");
  assert.deepEqual(emptyButTagged.untrackedLeftovers, [extra]);
});

test("cleanup denied: a kept resource needs a real owner and reason, must belong to the journey, and is kept once", async () => {
  const blueprint = blueprintFromTerraformState(AWS_SHOW, PLAN);
  for (const decision of [{ address: "aws_s3_bucket.state", owner: "", reason: "The shared state bucket." },
    { address: "aws_s3_bucket.state", owner: "owner", reason: "short" }, { address: "aws_s3_bucket.other", owner: "owner", reason: "Not part of this journey." }]) {
    assert.notDeepEqual(retentionProblems(blueprint, [decision]), [], JSON.stringify(decision));
    await assert.rejects(cleanupDisposition(blueprint, [decision], { unitId: "u", region: "us-east-2", aws: fakeAws(everything).aws }), /RETENTION_INVALID/);
  }
  const twice = { address: "aws_s3_bucket.state", owner: "owner", reason: "The shared state bucket." };
  assert.ok(retentionProblems(blueprint, [twice, twice]).some((x) => x.includes("twice")));
});

// --- CloudFormation (the CDK engine) ----------------------------------------------------------------------------------

test("the CloudFormation blueprint maps logical ids to physical ids, derives the ARN for the known types only, keeps the physical ARN as it is, marks what the change set never named, skips deleted rows and malformed rows, copies no status text, and refuses a document that is not a stack resource listing", async () => {
  const { blueprintFromCloudFormationResources } = await import("../src/observe/blueprint.js");
  const place = { account: "111111111111", region: "us-east-1" };
  const row = (logical: string, type: string, physical: string | undefined, status = "CREATE_COMPLETE") => ({
    StackName: "PilotStack", LogicalResourceId: logical, ResourceType: type, ...(physical === undefined ? {} : { PhysicalResourceId: physical }), ResourceStatus: status,
    ResourceStatusReason: "CANARY_STATUS_REASON_r1", Timestamp: "2026-10-11T12:02:00.000Z", DriftInformation: { StackResourceDriftStatus: "NOT_CHECKED" },
  });
  const document = JSON.stringify({ StackResources: [
    row("PilotBucket", "AWS::S3::Bucket", "pilotstack-pilotbucket-x"),
    row("PilotTopic", "AWS::SNS::Topic", "arn:aws:sns:us-east-1:111111111111:PilotStack-PilotTopic-X"),
    row("PilotRole", "AWS::IAM::Role", "PilotStack-PilotRole-X"),
    row("PathedRole", "AWS::IAM::Role", "service-role/PilotStack-PathedRole-X"),
    row("PilotQueue", "AWS::SQS::Queue", "https://sqs.us-east-1.amazonaws.com/111111111111/PilotStack-PilotQueue-X"),
    row("OddQueue", "AWS::SQS::Queue", "not-a-queue-url"),
    row("PilotLogs", "AWS::Logs::LogGroup", "/aws/pilot/logs"),
    row("PilotAlarm", "AWS::CloudWatch::Alarm", "PilotStack-PilotAlarm-X"),
    row("Nested", "AWS::CloudFormation::Stack", "arn:aws:cloudformation:us-east-1:111111111111:stack/nested/0000"),
    row("Gone", "AWS::SQS::Queue", "https://sqs.us-east-1.amazonaws.com/111111111111/gone", "DELETE_COMPLETE"),
    row("NoPhysical", "AWS::S3::Bucket", undefined, "CREATE_IN_PROGRESS"),
    { LogicalResourceId: "bad id!", ResourceType: "AWS::S3::Bucket", PhysicalResourceId: "x" }, { LogicalResourceId: "BadType", ResourceType: "Bucket", PhysicalResourceId: "x" }, "garbage", null,
  ] });
  const planned = [{ address: "PilotBucket", type: "AWS::S3::Bucket", action: "CREATE" }, { address: "PilotTopic", type: "AWS::SNS::Topic", action: "REPLACE" }, { address: "Planned", type: "AWS::SQS::Queue", action: "CREATE" },
    { address: "Removed", type: "AWS::SQS::Queue", action: "DELETE" }, { address: "Dynamic", type: "AWS::S3::Bucket", action: "DYNAMIC" },
    // A Modify whose replacement the reader could not judge (UNKNOWN) still leaves the resource in the stack: gone from the stack, it is missing (#270 review N3).
    { address: "Unjudged", type: "AWS::SQS::Queue", action: "UNKNOWN" }];
  const blueprint = blueprintFromCloudFormationResources(document, planned, place);
  assert.deepEqual(blueprint.entries, [
    { address: "Nested", type: "AWS::CloudFormation::Stack", id: "arn:aws:cloudformation:us-east-1:111111111111:stack/nested/0000", arn: "arn:aws:cloudformation:us-east-1:111111111111:stack/nested/0000", origin: "NOT_IN_PLAN" },
    { address: "NoPhysical", type: "AWS::S3::Bucket", id: null, arn: null, origin: "NOT_IN_PLAN" },
    { address: "OddQueue", type: "AWS::SQS::Queue", id: "not-a-queue-url", arn: null, origin: "NOT_IN_PLAN" },
    { address: "PathedRole", type: "AWS::IAM::Role", id: "service-role/PilotStack-PathedRole-X", arn: null, origin: "NOT_IN_PLAN" },
    { address: "PilotAlarm", type: "AWS::CloudWatch::Alarm", id: "PilotStack-PilotAlarm-X", arn: null, origin: "NOT_IN_PLAN" },
    { address: "PilotBucket", type: "AWS::S3::Bucket", id: "pilotstack-pilotbucket-x", arn: "arn:aws:s3:::pilotstack-pilotbucket-x", origin: "IN_PLAN" },
    { address: "PilotLogs", type: "AWS::Logs::LogGroup", id: "/aws/pilot/logs", arn: "arn:aws:logs:us-east-1:111111111111:log-group:/aws/pilot/logs", origin: "NOT_IN_PLAN" },
    { address: "PilotQueue", type: "AWS::SQS::Queue", id: "https://sqs.us-east-1.amazonaws.com/111111111111/PilotStack-PilotQueue-X", arn: "arn:aws:sqs:us-east-1:111111111111:PilotStack-PilotQueue-X", origin: "NOT_IN_PLAN" },
    { address: "PilotRole", type: "AWS::IAM::Role", id: "PilotStack-PilotRole-X", arn: "arn:aws:iam::111111111111:role/PilotStack-PilotRole-X", origin: "NOT_IN_PLAN" },
    { address: "PilotTopic", type: "AWS::SNS::Topic", id: "arn:aws:sns:us-east-1:111111111111:PilotStack-PilotTopic-X", arn: "arn:aws:sns:us-east-1:111111111111:PilotStack-PilotTopic-X", origin: "IN_PLAN" },
  ]);
  // Planned to exist and not in the stack (a created queue, a dynamic change); a planned delete is not expected.
  assert.deepEqual(blueprint.missing, ["Dynamic", "Planned", "Unjudged"]);
  assert.ok(!JSON.stringify(blueprint).includes("CANARY_STATUS_REASON_r1"), "no status text is copied");
  // Without a region no ARN is derived; a physical ARN still stands.
  const unplaced = blueprintFromCloudFormationResources(document, planned, { account: "111111111111", region: undefined });
  assert.equal(unplaced.entries.find((e) => e.address === "PilotBucket")!.arn, null);
  assert.equal(unplaced.entries.find((e) => e.address === "PilotTopic")!.arn, "arn:aws:sns:us-east-1:111111111111:PilotStack-PilotTopic-X");
  for (const bad of ["", "not json", "[]", JSON.stringify({ Stacks: [] }), JSON.stringify({ StackResources: {} })]) assert.throws(() => blueprintFromCloudFormationResources(bad, planned, place), /STATE_JSON_INVALID/, bad);
  assert.deepEqual(blueprintFromCloudFormationResources(JSON.stringify({ StackResources: [] }), planned, place), { entries: [], missing: ["Dynamic", "PilotBucket", "PilotTopic", "Planned", "Unjudged"] }, "code-point order");
});

test("a wrapper type that holds an identity's ARN anywhere in its attributes is flagged in place (holdsIdentityArn), as a whole value or a list element, in any partition; the attribute is never copied, an ordinary type with the same attribute is not flagged, and a wrapper without one is not", () => {
  const ROLE = "arn:aws:iam::000000000000:role/alz-apply-dev";
  const show = (type: string, values: Record<string, unknown>) => JSON.stringify({ format_version: "1.0", values: { root_module: { resources: [{ address: type + ".x", mode: "managed", type, values: { id: "x-id", ...values } }] } } });
  const flagged = (type: string, values: Record<string, unknown>) => blueprintFromTerraformState(show(type, values), []).entries[0].holdsIdentityArn === true;
  assert.ok(flagged("terraform_data", { input: ROLE }), "a whole value");
  assert.ok(flagged("terraform_data", { input: { nested: { deeper: [1, { role: ROLE }] } } }), "nested in objects and lists");
  assert.ok(flagged("null_resource", { triggers: { roles: "reader," + ROLE + ",writer" } }), "an element of a comma list");
  assert.ok(flagged("null_resource", { triggers: { roles: "a;" + ROLE } }), "an element of a semicolon list");
  assert.ok(flagged("aws_cloudformation_stack", { outputs: { RoleArn: ROLE } }), "a stack output");
  assert.ok(flagged("terraform_data", { input: "arn:aws-us-gov:iam::000000000000:role/x" }), "another partition");
  assert.ok(!flagged("terraform_data", { input: "not an arn", output: ["arn:aws:s3:::bucket"] }), "no IAM ARN");
  assert.ok(!flagged("terraform_data", { input: "prefixarn:aws:iam::000000000000:role/x" }), "not anchored as a value or an element");
  assert.ok(!flagged("aws_s3_bucket", { policy: ROLE }), "an ordinary type is judged by its own identifier, not its attributes");
  // Every stack container of the one family table is a wrapper too (review 6432262110 B1): an identity's ARN in its outputs is flagged, whatever the family.
  for (const prefix of AWS_CONTAINER_PREFIXES) assert.ok(flagged(prefix, { outputs: { RoleArn: ROLE } }) && !flagged(prefix, { outputs: { Name: "plain" } }), prefix);
  const blueprint = blueprintFromTerraformState(show("terraform_data", { input: { secret: "CANARY_WRAPPER_VALUE", roles: ROLE } }), []);
  assert.deepEqual(blueprint.entries[0], { address: "terraform_data.x", type: "terraform_data", id: "x-id", arn: null, origin: "NOT_IN_PLAN", holdsIdentityArn: true });
  assert.ok(!JSON.stringify(blueprint).includes("CANARY_WRAPPER_VALUE") && !JSON.stringify(blueprint).includes(ROLE), "nothing of the attributes is copied");
});

test("the wrapper scan fails closed past its depth (SCAN_DEPTH): a leaf at the boundary is read exactly, a container one level deeper is not entered and flags the entry whether or not an ARN is there, very deep and cyclic-looking input are flagged, and very wide input is read in full (review 6412896598 B2)", () => {
  const ROLE = "arn:aws:iam::000000000000:role/alz-apply-dev";
  const show = (type: string, values: Record<string, unknown>) => JSON.stringify({ format_version: "1.0", values: { root_module: { resources: [{ address: type + ".x", mode: "managed", type, values: { id: "x-id", ...values } }] } } });
  const flagged = (values: Record<string, unknown>, type = "terraform_data") => blueprintFromTerraformState(show(type, values), []).entries[0].holdsIdentityArn === true;
  /** `leaf` under `containers` nested objects, the attribute set itself not counted: `{ input: { l: { l: ... leaf } } }` with `containers` objects below the attribute set. */
  const nested = (leaf: unknown, containers: number, key = "l"): Record<string, unknown> => { let value = leaf; for (let i = 0; i < containers; i++) value = { [key]: value }; return { input: value }; };
  assert.equal(SCAN_DEPTH, 32);
  // The attribute set is the first container; `input`'s value is the second. A leaf under SCAN_DEPTH containers in all is read; one more container is not entered.
  const deepest = SCAN_DEPTH - 1;
  assert.ok(flagged(nested(ROLE, deepest)), "an ARN at the deepest scanned level is found");
  assert.ok(!flagged(nested("plain", deepest)), "a plain leaf at the deepest scanned level is read exactly: not flagged");
  assert.ok(!flagged(nested(["plain", 1, null], deepest - 1)), "a list at the deepest scanned level is read exactly: not flagged");
  assert.ok(flagged(nested("plain", deepest + 1)), "one container deeper cannot be entered: flagged without any ARN (fail closed)");
  assert.ok(flagged(nested([], deepest + 1)), "an empty container one level too deep is not entered either");
  assert.ok(flagged(nested(ROLE, 40)), "an ARN 40 levels deep is never passed over");
  assert.ok(flagged(nested("plain", 5_000)), "very deep input");
  assert.ok(flagged(nested("plain", 50, "self")), "cyclic-looking input (an object naming itself at every level) is flagged, not followed");
  // Width is read in full: the scan is linear and has no element limit.
  const wide = Array.from({ length: 200_000 }, (_, i) => "element-" + i);
  assert.ok(!flagged({ input: wide }), "a very wide list without an ARN is read in full and not flagged");
  assert.ok(flagged({ input: [...wide, ROLE] }), "an ARN as the last of 200,000 elements is found");
  assert.ok(flagged({ input: Object.fromEntries(wide.map((v, i) => [v, i === 199_999 ? ROLE : v])) }), "an ARN as the last of 200,000 keys is found");
  assert.ok(!flagged({ input: Object.fromEntries(wide.map((v) => [v, v])) }), "a very wide object without an ARN is not flagged");
  // A wide-and-deep structure stays under the bound by width and over it by depth, independently.
  assert.ok(!flagged({ input: Array.from({ length: 1000 }, () => nested("plain", deepest - 2).input) }), "1000 subtrees each within the depth are read exactly");
  assert.ok(flagged({ input: Array.from({ length: 1000 }, (_, i) => (i === 999 ? nested("plain", deepest + 1).input : "plain")) }), "one subtree past the depth among 1000 flags the entry");
  // The rule is the wrapper's, not every type's: an ordinary type too deep to scan is not judged by its attributes at all.
  assert.ok(!flagged(nested("plain", 100), "aws_s3_bucket"), "an ordinary type is never flagged, however deep");
  const blueprint = blueprintFromTerraformState(show("terraform_data", nested("CANARY_DEEP_VALUE", 100)), []);
  assert.deepEqual(blueprint.entries[0], { address: "terraform_data.x", type: "terraform_data", id: "x-id", arn: null, origin: "NOT_IN_PLAN", holdsIdentityArn: true });
  assert.ok(!JSON.stringify(blueprint).includes("CANARY_DEEP_VALUE"), "nothing of the attributes is copied");
});
