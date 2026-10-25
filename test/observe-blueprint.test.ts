import assert from "node:assert/strict";
import test from "node:test";

import { blueprintFromTerraformState } from "../src/observe/blueprint.js";
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
  assert.throws(() => blueprintFromTerraformState("not json", []), SyntaxError);
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
  const clean = await cleanupDisposition(blueprint, keepBucket, { region: "us-east-2", aws: fakeAws(new Set([BUCKET])).aws });
  assert.equal(clean.verdict, "CLEAN");
  assert.deepEqual(clean.dispositions.map((x) => [x.address, x.disposition]), [
    ["aws_cloudwatch_log_group.act_dev1", "DELETED"], ["aws_iam_openid_connect_provider.github", "DELETED"],
    ["aws_s3_bucket.state", "RETAINED"], ["aws_s3_bucket_versioning.state", "RETAINED"],
  ]);
  const left = await cleanupDisposition(blueprint, keepBucket, { region: "us-east-2", aws: fakeAws(new Set([BUCKET, LOG])).aws });
  assert.equal(left.verdict, "LEFTOVERS");
  assert.equal(left.dispositions.find((x) => x.address === "aws_cloudwatch_log_group.act_dev1")?.disposition, "LEFTOVER");
  const unproven = await cleanupDisposition(blueprint, keepBucket, { region: "us-east-2", aws: fakeAws(new Set([BUCKET]), { fail: { [OIDC]: "ThrottlingException" } }).aws });
  assert.equal(unproven.verdict, "INCONCLUSIVE");
  assert.equal(unproven.dispositions.find((x) => x.address === "aws_iam_openid_connect_provider.github")?.disposition, "UNPROVEN");
  const notCheckable = await cleanupDisposition(blueprint, keepBucket.slice(0, 1), { region: "us-east-2", aws: fakeAws(new Set([BUCKET])).aws });
  assert.equal(notCheckable.verdict, "INCONCLUSIVE", "a setting nobody kept cannot be proven deleted");
  const gone = await cleanupDisposition(blueprint, keepBucket, { region: "us-east-2", aws: fakeAws(new Set()).aws });
  assert.equal(gone.verdict, "INCONCLUSIVE");
  assert.deepEqual(gone.retainedButAbsent, ["aws_s3_bucket.state"]);
});

test("cleanup denied: a kept resource needs a real owner and reason, must belong to the journey, and is kept once", async () => {
  const blueprint = blueprintFromTerraformState(AWS_SHOW, PLAN);
  for (const decision of [{ address: "aws_s3_bucket.state", owner: "", reason: "The shared state bucket." },
    { address: "aws_s3_bucket.state", owner: "owner", reason: "short" }, { address: "aws_s3_bucket.other", owner: "owner", reason: "Not part of this journey." }]) {
    assert.notDeepEqual(retentionProblems(blueprint, [decision]), [], JSON.stringify(decision));
    await assert.rejects(cleanupDisposition(blueprint, [decision], { region: "us-east-2", aws: fakeAws(everything).aws }), /RETENTION_INVALID/);
  }
  const twice = { address: "aws_s3_bucket.state", owner: "owner", reason: "The shared state bucket." };
  assert.ok(retentionProblems(blueprint, [twice, twice]).some((x) => x.includes("twice")));
});
