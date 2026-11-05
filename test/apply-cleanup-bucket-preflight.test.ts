import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { signApproval } from "../src/apply/approval.js";
import { recheckBucketsEmpty } from "../src/apply/bucket-preflight.js";
import { buildCleanupProposal, signCleanupProposal, type CleanupProposal } from "../src/apply/cleanup-proposal.js";
import { CLEANUP_SUFFIX, loadPilotContract, pilotContractSha256 } from "../src/apply/contract.js";
import { runApply, runCleanup, sealPreview, type ApplyDeps } from "../src/apply/driver.js";
import { readCleanupEvidence } from "../src/apply/ledger.js";
import { openNonceStore, type NonceStore } from "../src/apply/nonces.js";
import { loadRunRecords, observeRun } from "../src/apply/observe.js";
import { loadSealedPlan } from "../src/apply/seal.js";
import { pilotUnitOf } from "../src/apply/unit.js";
import type { PilotContract, SignedApproval } from "../src/apply/types.js";
import { isAllowedReadArgv } from "../src/observe/aws-cli.js";
import type { AwsCli } from "../src/observe/verify.js";
import { removeTree } from "../src/teardown/driver/cleanup.js";
import {
  AWS_DEV_TARGET, KEY_NAME_CANARY, NOW, POLICY, REQUESTER, SOURCE_COMMIT, approvalFor, awsContractJson, awsIdentityEnv, awsReadCallsOf, awsRoleArn, awsTargetOf, behave as behaveIn,
  behaveAwsReads, callsOf, canaryFor, human, installFakeAwsReads, installFakeTerraform, keys, stateResource, testFixtureForgeQualificationEvidence, withCanary, writeProject,
  writeReviewedContract, type AwsReadBehavior, type Behavior, type FakeBucket,
} from "./helpers/apply-fixtures.js";

// The cleanup's bucket preflight (owner decision of 2026-11-05, issue #39 comment 6646346513, items 1 and 2): every run-owned S3 bucket
// on the approved list is read again as DISCOVERY immediately before the approvals are consumed, and a bucket that is not empty, or
// cannot be verified empty, stops the cleanup before anything is destroyed. Each refusal here is shown to make no destroy apply, to give
// the reservation back and to consume no approval, and the same approval then succeeds once the condition clears. The engine and the
// AWS CLI are fakes, so this is SYNTHETIC evidence: it pins the product's logic and never stands for a live account.

const root = mkdtempSync(join(tmpdir(), "alz-preflight-"));
const toolDir = mkdtempSync(join(tmpdir(), "alz-preflight-tf-"));
const awsToolDir = mkdtempSync(join(tmpdir(), "alz-preflight-aws-"));
process.env.AGENTIC_EVIDENCE_KEY = randomBytes(32).toString("base64");
process.chdir(root);
test.after(() => { removeTree(root); removeTree(toolDir); removeTree(awsToolDir); });
installFakeTerraform(toolDir);
installFakeAwsReads(awsToolDir);

let counter = 0;
const fresh = (label: string): string => {
  const dir = join(root, label + "-" + ++counter);
  mkdirSync(dir, { recursive: true });
  return dir;
};
const KILL = join(root, "KILL");
const ACCOUNT = AWS_DEV_TARGET.account;
const BUCKET = "examplefake-pilot-logs";
const BUCKET_ARN = "arn:aws:s3:::" + BUCKET;
const LOG = "/alz/pilot/canary";
const LOG_ARN = "arn:aws:logs:us-east-1:" + ACCOUNT + ":log-group:" + LOG;
const EXPORT = "arn:aws:bcm-data-exports:us-east-1:" + ACCOUNT + ":export/alz-cur2-0f1e2d3c";
const AWS_PROVIDER_CONFIG = { aws: { name: "aws", full_name: "registry.terraform.io/hashicorp/aws", expressions: { region: { references: ["var.region"] } } } };
const created = (address: string, type: string) => ({ address, type, change: { actions: ["create"], before: null, after: {} } });
const CREATES = [created("aws_s3_bucket.logs", "aws_s3_bucket"), created("aws_cloudwatch_log_group.canary", "aws_cloudwatch_log_group")];
const STATE = [stateResource("aws_s3_bucket", "logs", BUCKET, BUCKET_ARN), stateResource("aws_cloudwatch_log_group", "canary", LOG, LOG_ARN)];
/** A cost-baseline run: the bucket, and the CUR 2.0 export that delivers into it. */
const COST_CREATES = [...CREATES, created("aws_bcmdataexports_export.cur", "aws_bcmdataexports_export")];
const COST_STATE = [...STATE, stateResource("aws_bcmdataexports_export", "cur", EXPORT, EXPORT)];

type Shape = { creates: typeof CREATES; state: typeof STATE; existing: string[] };
const PLAIN: Shape = { creates: CREATES, state: STATE, existing: [BUCKET, LOG] };
const COST: Shape = { creates: COST_CREATES, state: COST_STATE, existing: [BUCKET, LOG, EXPORT] };

type World = { deps: ApplyDeps & { nonces: NonceStore }; dirs: { scratch: string; evidence: string }; contractPath: string; contract: unknown; shape: Shape };
let vaultDir = "";
test.before(async () => {
  vaultDir = fresh("qualification");
  await testFixtureForgeQualificationEvidence(vaultDir, undefined, "AWS");
});
let current: Shape = PLAIN;
let unitTags: Record<string, string> = {};
const behave = (behavior: Behavior = {}) => behaveIn(toolDir, KILL, {
  applyAdvance: true, showOnlyConfigured: true, showResources: current.creates, showProviderConfig: AWS_PROVIDER_CONFIG, stateResources: current.state, unitTags: { ...unitTags }, ...behavior,
});
const cloud = (behavior: AwsReadBehavior = {}) => behaveAwsReads(awsToolDir, { existing: current.existing, tagged: [BUCKET_ARN, LOG_ARN, ...(current === COST ? [EXPORT] : [])], ...behavior });
const applyCalls = () => callsOf(toolDir).filter((c) => c.args[0] === "apply");
const destroyPlans = () => callsOf(toolDir).filter((c) => c.args[0] === "plan" && c.args[1] === "-destroy");
const preflightReads = () => awsReadCallsOf(awsToolDir).filter((c) => c.args[0] === "s3api" || c.args[0] === "bcm-data-exports");

function world(shape: Shape = PLAIN): World {
  current = shape;
  const dirs = { scratch: fresh("scratch"), evidence: fresh("evidence") };
  const contract = withCanary(awsContractJson(KILL), canaryFor(shape.creates));
  const contractPath = join(fresh("contract"), "act-pilot-contract.json");
  writeReviewedContract(contractPath, contract);
  const loaded = loadPilotContract(contractPath) as PilotContract;
  unitTags = { ...pilotUnitOf({ provider: "AWS", contractSha256: pilotContractSha256(loaded), environment: "DEV", target: awsTargetOf("DEV") }).tags };
  behave();
  cloud();
  return {
    dirs, contractPath, contract, shape,
    deps: {
      sourceCommit: SOURCE_COMMIT, contractPath, qualificationDir: vaultDir, evidenceDir: dirs.evidence, nonces: openNonceStore(fresh("nonces")),
      env: awsIdentityEnv("DEV"), now: () => NOW, scratchParent: dirs.scratch, toolDirs: [toolDir, awsToolDir], killPollMs: 40, killGraceMs: 400,
    },
  };
}

/** Seal, apply, observe and propose one run, as `./alz apply` does; a cost-baseline run carries the person's teardown disposition. */
async function proposed(w: World) {
  const target = awsTargetOf("DEV");
  const p = writeProject(fresh("project"), target, 'resource "aws_s3_bucket" "logs" {}\n');
  const sealed = await sealPreview({ invocation: human(target), environment: "DEV", target, manifest: p.manifest, projectRoot: p.projectRoot, policyVersion: POLICY, resolved: p.resolved, requester: REQUESTER }, w.deps);
  assert.ok(sealed.ok, JSON.stringify(sealed));
  const loaded = await loadSealedPlan(sealed.path);
  assert.ok(loaded.ok);
  const s = { sealed: sealed.sealed, project: p, loaded: { sealed: loaded.sealed, planBytes: loaded.planBytes } };
  const applied = await runApply({ invocation: human(target), environment: "DEV", target: { ...target }, sealedPlan: s.loaded, manifest: p.manifest, projectRoot: p.projectRoot,
    approvals: [approvalFor(s.sealed, "alice")] }, w.deps);
  assert.ok(applied.ok, JSON.stringify(applied));
  const observed = await observeRun(s.sealed.artifactSha256, { contractPath: w.contractPath, evidenceDir: w.dirs.evidence, env: w.deps.env, toolDirs: w.deps.toolDirs, scratchParent: w.dirs.scratch,
    now: () => new Date(NOW.getTime() + 60_000) });
  assert.ok(observed.ok, JSON.stringify(observed));
  const records = await loadRunRecords(s.sealed.artifactSha256, w.dirs.evidence);
  assert.ok(records.ok, JSON.stringify(records));
  const built = buildCleanupProposal({ requesterId: REQUESTER.requesterId, ...records, changes: s.sealed.changes, channel: "CLI", contract: { ...(w.contract as object), enabled: true } as never,
    engineVersion: s.sealed.engineVersion, env: w.deps.env!, now: new Date(NOW.getTime() + 120_000), ...(w.shape === COST ? { disposition: "TEARDOWN_CONFIRMED" as const } : {}) });
  assert.ok(built.ok, JSON.stringify(built));
  return { s, proposal: signCleanupProposal(built.proposal, REQUESTER.privateKeyPem) };
}
type Run = Awaited<ReturnType<typeof proposed>>;
const cleanupApproval = (proposal: CleanupProposal, who: keyof typeof keys): SignedApproval => signApproval({
  schemaVersion: 1, artifactSha256: proposal.proposalSha256, environment: proposal.environment, target: proposal.target, approverId: who,
  issuedAt: new Date(NOW.getTime() - 5 * 60_000).toISOString(), expiresAt: new Date(NOW.getTime() + 25 * 60_000).toISOString(), nonce: randomBytes(16).toString("hex"),
}, keys[who].priv, "CLEANUP");
const cleanup = (w: World, run: Run, approvals: SignedApproval[]) => runCleanup({
  invocation: human(run.s.sealed.target), environment: "DEV", target: { ...run.s.sealed.target }, proposal: run.proposal, sealedPlan: run.s.loaded, manifest: run.s.project.manifest,
  projectRoot: run.s.project.projectRoot, approvals,
}, w.deps);
const reserved = (w: World) => readdirSync(w.dirs.evidence).filter((name) => name.endsWith(CLEANUP_SUFFIX));
const END = "Nothing was destroyed and no approval was consumed.";

/**
 * One refusal, then the same approval once the condition clears: the refusal's code and words, no destroy apply, the reservation given
 * back, the approval's nonce unconsumed and no cleanup evidence; then a cleared cloud, and the very same approval runs the cleanup.
 */
async function refusedThenCleared(label: string, shape: Shape, condition: AwsReadBehavior, code: string, pattern: RegExp) {
  const w = world(shape);
  const run = await proposed(w);
  const approval = cleanupApproval(run.proposal, "alice");
  behave();
  cloud(condition);
  const result = await cleanup(w, run, [approval]);
  assert.equal(result.ok, false, label + ": " + JSON.stringify(result));
  assert.equal((result as { code: string }).code, code, label + ": " + JSON.stringify(result));
  const message = (result as { message: string }).message;
  assert.match(message, pattern, label);
  assert.ok(message.includes(END), label + ": " + message);
  assert.ok(!message.includes(KEY_NAME_CANARY), label + ": no object key name is kept");
  assert.equal(destroyPlans().length, 1, label + ": the destroy plan was made before the preflight");
  assert.equal(applyCalls().length, 0, label + ": nothing was destroyed");
  assert.deepEqual(reserved(w), [], label + ": the reservation was given back");
  assert.equal(w.deps.nonces.has(approval.statement.nonce), false, label + ": the approval was not consumed");
  assert.equal(await readCleanupEvidence(run.proposal.proposalSha256, w.dirs.evidence), undefined, label + ": no cleanup evidence");
  // Every preflight read is an exact allowed shape under DISCOVERY, bound to the target account; nothing else was sent.
  const reads = preflightReads();
  assert.ok(reads.length > 0, label);
  for (const read of reads) {
    assert.ok(isAllowedReadArgv(read.args), label + ": " + read.args.join(" "));
    assert.equal(read.env.AWS_ROLE_ARN, awsRoleArn("DISCOVERY", "DEV"), label + ": read as DISCOVERY");
    if (read.args[0] === "s3api") assert.equal(read.args[read.args.indexOf("--expected-bucket-owner") + 1], ACCOUNT, label);
  }
  // The condition clears (the bucket emptied by a person, the delivery finished): the same approval runs the cleanup once.
  behave();
  cloud(shape === COST ? { executions: { [EXPORT]: ["DELIVERY_SUCCESS"] } } : {});
  const done = await cleanup(w, run, [approval]);
  assert.ok(done.ok, label + ": " + JSON.stringify(done));
  assert.equal(applyCalls().length, 1, label + ": the destroy ran once");
  assert.equal(w.deps.nonces.has(approval.statement.nonce), true, label + ": consumed only now");
}

const bucket = (spec: FakeBucket): AwsReadBehavior => ({ buckets: { [BUCKET]: spec } });

test("a bucket that is not empty stops the cleanup before anything is destroyed: an object version, a delete marker, or an unfinished multipart upload", async () => {
  await refusedThenCleared("version", PLAIN, bucket({ versioning: "Enabled", versions: 3 }), "CLEANUP_BUCKET_NOT_EMPTY", /aws_s3_bucket\.logs .* is not empty: it holds at least one object version \(versioning Enabled; counts only/);
  await refusedThenCleared("delete marker", PLAIN, bucket({ versioning: "Suspended", deleteMarkers: 1 }), "CLEANUP_BUCKET_NOT_EMPTY", /at least one delete marker/);
  await refusedThenCleared("multipart", PLAIN, bucket({ uploads: 2 }), "CLEANUP_BUCKET_NOT_EMPTY", /at least one unfinished multipart upload \(versioning NEVER_ENABLED/);
});

test("a bucket that cannot be verified empty stops the cleanup: another owner, another region, denied, throttled, timed out, malformed, truncated, unknown versioning", async () => {
  const denied = "An error occurred (AccessDenied) when calling the ListObjectVersions operation: Access Denied";
  for (const [label, condition, pattern] of [
    ["owner mismatch", bucket({ owner: "222222222222", versions: 1 }), /denied \(access denied, or the bucket is owned by another account/],
    ["region mismatch", bucket({ region: "eu-west-1" }), /the bucket is in eu-west-1, not the contract's region us-east-1/],
    ["access denied", bucket({ fail: { "list-object-versions": denied } }), /the read was denied/],
    ["throttled", bucket({ fail: { "head-bucket": "An error occurred (SlowDown) when calling the HeadBucket operation: Please reduce your request rate." } }), /throttled/],
    ["timeout", bucket({ fail: { "list-multipart-uploads": "Read timeout on endpoint URL" } }), /timed out/],
    ["malformed", bucket({ stdout: { "list-object-versions": "<html>not json" } }), /not readable/],
    ["malformed field", bucket({ stdout: { "list-multipart-uploads": JSON.stringify({ Uploads: "one" }) } }), /not readable/],
    ["no region in answer", bucket({ stdout: { "head-bucket": "{}" } }), /did not name the bucket's region/],
    ["truncated", bucket({ stdout: { "list-object-versions": JSON.stringify({ NextToken: "more" }) } }), /cut short/],
    ["unknown versioning", bucket({ versioning: "Paused" }), /versioning state is unknown/],
    ["refused read", bucket({ fail: { "get-bucket-versioning": "OBSERVE_READ_UNUSABLE" } }), /refused or its answer was cut short/],
  ] as const) {
    await refusedThenCleared(label, PLAIN, condition as AwsReadBehavior, "CLEANUP_BUCKET_UNVERIFIED", pattern);
  }
});

test("a cost-baseline cleanup (with the person's disposition) also faces the preflight: a delivery QUEUED or IN_PROGRESS stops it, an unknown delivery state is unverified", async () => {
  await refusedThenCleared("queued", COST, { executions: { [EXPORT]: ["DELIVERY_SUCCESS", "QUERY_QUEUED"] } }, "CLEANUP_BUCKET_NOT_EMPTY", /aws_bcmdataexports_export\.cur has 1 delivery\(ies\) QUEUED or IN_PROGRESS/);
  await refusedThenCleared("in progress", COST, { executions: { [EXPORT]: ["DELIVERY_IN_PROCESS"] } }, "CLEANUP_BUCKET_NOT_EMPTY", /QUEUED or IN_PROGRESS/);
  await refusedThenCleared("unknown state", COST, { executions: { [EXPORT]: ["SOMETHING_NEW"] } }, "CLEANUP_BUCKET_UNVERIFIED", /a state this check does not know/);
  await refusedThenCleared("cost bucket not empty", COST, bucket({ versions: 1 }), "CLEANUP_BUCKET_NOT_EMPTY", /is not empty/);
});

test("an empty, verified bucket: the cleanup proceeds exactly as before, after five exact DISCOVERY reads and no others", async () => {
  const w = world(COST);
  const run = await proposed(w);
  behave();
  cloud({ executions: { [EXPORT]: ["DELIVERY_SUCCESS", "DELIVERY_FAILURE"] } });
  const done = await cleanup(w, run, [cleanupApproval(run.proposal, "alice")]);
  assert.ok(done.ok, JSON.stringify(done));
  assert.deepEqual(preflightReads().map((r) => r.args), [
    ["bcm-data-exports", "list-executions", "--export-arn", EXPORT, "--region", "us-east-1", "--output", "json"],
    ["s3api", "head-bucket", "--bucket", BUCKET, "--expected-bucket-owner", ACCOUNT, "--region", "us-east-1", "--output", "json"],
    ["s3api", "get-bucket-versioning", "--bucket", BUCKET, "--expected-bucket-owner", ACCOUNT, "--region", "us-east-1", "--output", "json"],
    ["s3api", "list-object-versions", "--bucket", BUCKET, "--expected-bucket-owner", ACCOUNT, "--max-items", "1", "--region", "us-east-1", "--output", "json"],
    ["s3api", "list-multipart-uploads", "--bucket", BUCKET, "--expected-bucket-owner", ACCOUNT, "--max-items", "1", "--region", "us-east-1", "--output", "json"],
  ]);
  assert.equal(applyCalls().length, 1);
  assert.deepEqual((await readCleanupEvidence(run.proposal.proposalSha256, w.dirs.evidence))?.deletes, run.proposal.deletes.map((d) => d.address));
});

test("unauthorized: a cleanup refused at its gate (an apply approval, not a cleanup one) never reaches the preflight, so no bucket is read", async () => {
  const w = world();
  const run = await proposed(w);
  behave();
  cloud();
  const result = await cleanup(w, run, [approvalFor(run.s.sealed, "alice")]);
  assert.equal(result.ok, false);
  assert.equal(preflightReads().length, 0, "no bucket read before authorization");
  assert.equal(destroyPlans().length, 0);
  assert.deepEqual(reserved(w), []);
});

test("interrupted: a stop signal that arrives during the preflight is read before the approvals are consumed, and nothing is destroyed or consumed", async () => {
  const w = world();
  const run = await proposed(w);
  const approval = cleanupApproval(run.proposal, "alice");
  behave();
  cloud({ signalParentOn: { op: "list-object-versions", signal: "SIGTERM" } });
  const result = await cleanup(w, run, [approval]);
  assert.equal(result.ok, false, JSON.stringify(result));
  assert.equal((result as { code: string }).code, "APPLY_FAILED");
  assert.match((result as { message: string }).message, /interrupted by a signal before the engine started\. Nothing was destroyed and no approval was consumed/);
  assert.equal(applyCalls().length, 0);
  assert.deepEqual(reserved(w), []);
  assert.equal(w.deps.nonces.has(approval.statement.nonce), false);
  behave();
  cloud();
  assert.ok((await cleanup(w, run, [approval])).ok, "the same approval runs once the stop has passed");
});

// --- the preflight on its own (the `aws` seam): exact argv, counts only, fail closed -----------------------------------------

const proposalWith = (deletes: CleanupProposal["deletes"], account = ACCOUNT): CleanupProposal => ({
  provider: "AWS", environment: "DEV", target: { ...AWS_DEV_TARGET, account }, deletes,
} as unknown as CleanupProposal);
const CONTRACT = { provider: "AWS", targets: { DEV: { region: "us-east-1" } } } as unknown as PilotContract;
const del = (address: string, type: string, identifier: string | null) => ({ address, type, identifier, ownership: "RUN_CREATED" as const, observed: "VERIFIED" as const });
const answering = (answer: (argv: readonly string[]) => { code: number; stdout: string; stderr?: string }) => {
  const calls: string[][] = [];
  const aws: AwsCli = async (argv) => { calls.push([...argv]); const a = answer(argv); return { code: a.code, stdout: a.stdout, stderr: a.stderr ?? "" }; };
  return { aws, calls };
};
const empty = (argv: readonly string[]) => ({ code: 0, stdout: argv[1] === "head-bucket" ? JSON.stringify({ BucketRegion: "us-east-1" }) : argv[1] === "get-bucket-versioning" ? "" : "{}" });

test("preflight: nothing to read for a run without a bucket, or another provider; a non-bucket name, a non-export ARN or a target without a 12-digit account is unverified without a read", async () => {
  const none = answering(empty);
  assert.equal(await recheckBucketsEmpty(proposalWith([del("aws_cloudwatch_log_group.x", "aws_cloudwatch_log_group", "/x")]), CONTRACT, { aws: none.aws }), undefined);
  assert.equal(await recheckBucketsEmpty(proposalWith([del("aws_s3_bucket.x", "aws_s3_bucket", "b-1")]), { ...CONTRACT, provider: "AZURE" } as PilotContract, { aws: none.aws }), undefined);
  assert.deepEqual(none.calls, []);
  for (const [label, proposal] of [
    ["bucket name", proposalWith([del("aws_s3_bucket.x", "aws_s3_bucket", "--bucket")])],
    ["null bucket", proposalWith([del("aws_s3_bucket.x", "aws_s3_bucket", null)])],
    ["export of another account", proposalWith([del("aws_s3_bucket.x", "aws_s3_bucket", "examplefake-b"), del("aws_bcmdataexports_export.c", "aws_bcmdataexports_export", "arn:aws:bcm-data-exports:us-east-1:999999999999:export/x")])],
    ["account", proposalWith([del("aws_s3_bucket.x", "aws_s3_bucket", "examplefake-b")], "not-an-account")],
  ] as const) {
    const probe = answering(empty);
    const refusal = await recheckBucketsEmpty(proposal, CONTRACT, { aws: probe.aws });
    assert.equal(refusal?.code, "CLEANUP_BUCKET_UNVERIFIED", label);
    assert.deepEqual(probe.calls.filter((c) => c[0] === "s3api" && c[3] !== "examplefake-b"), [], label + ": no read of an unchecked name");
  }
});

test("preflight: every read it sends is an exact allowed shape, each bucket read names the target account as expected owner, and an empty bucket passes", async () => {
  const probe = answering(empty);
  const proposal = proposalWith([del("aws_s3_bucket.b", "aws_s3_bucket", "examplefake-b"), del("aws_s3_bucket.a", "aws_s3_bucket", "examplefake-a"),
    del("aws_bcmdataexports_export.c", "aws_bcmdataexports_export", "arn:aws:bcm-data-exports:us-east-1:" + ACCOUNT + ":export/x")]);
  assert.equal(await recheckBucketsEmpty(proposal, CONTRACT, { aws: probe.aws }), undefined);
  assert.equal(probe.calls.length, 9, "one export listing and four reads per bucket");
  for (const call of probe.calls) assert.ok(isAllowedReadArgv(call), call.join(" "));
  assert.deepEqual(probe.calls.filter((c) => c[0] === "s3api").slice(0, 4).map((c) => c[3]), ["examplefake-a", "examplefake-a", "examplefake-a", "examplefake-a"], "buckets in address order");
  for (const call of probe.calls.filter((c) => c[0] === "s3api")) assert.equal(call[call.indexOf("--expected-bucket-owner") + 1], ACCOUNT);
  // A thrown read, a non-zero exit with no recognized text, and versioning with an unknown field are each unverified.
  for (const [label, answer] of [
    ["thrown", () => { throw new Error("spawn"); }],
    ["exit", (argv: readonly string[]) => argv[1] === "list-multipart-uploads" ? { code: 255, stdout: "" } : empty(argv)],
    ["versioning field", (argv: readonly string[]) => argv[1] === "get-bucket-versioning" ? { code: 0, stdout: JSON.stringify({ Status: "Enabled", Other: 1 }) } : empty(argv)],
    ["MFADelete", (argv: readonly string[]) => argv[1] === "get-bucket-versioning" ? { code: 0, stdout: JSON.stringify({ Status: "Enabled", MFADelete: "Maybe" }) } : empty(argv)],
    ["executions not a list", (argv: readonly string[]) => argv[0] === "bcm-data-exports" ? { code: 0, stdout: JSON.stringify({ Executions: {} }) } : empty(argv)],
    ["executions truncated", (argv: readonly string[]) => argv[0] === "bcm-data-exports" ? { code: 0, stdout: JSON.stringify({ Executions: [], NextToken: "t" }) } : empty(argv)],
  ] as const) {
    const failing = answering(answer as never);
    assert.equal((await recheckBucketsEmpty(proposal, CONTRACT, { aws: failing.aws }))?.code, "CLEANUP_BUCKET_UNVERIFIED", label);
  }
  // Versions and delete markers count, but a page that holds items and a NextToken is already decisive: not empty.
  const full = answering((argv) => argv[1] === "list-object-versions" ? { code: 0, stdout: JSON.stringify({ DeleteMarkers: [{ Key: KEY_NAME_CANARY }], NextToken: "t" }) } : empty(argv));
  const refusal = await recheckBucketsEmpty(proposal, CONTRACT, { aws: full.aws });
  assert.equal(refusal?.code, "CLEANUP_BUCKET_NOT_EMPTY");
  assert.ok(!refusal!.message.includes(KEY_NAME_CANARY), "counts only, never a key name");
});

test("argv allowlist: the preflight's shapes only, exactly; a missing or foreign owner, more items, another region, a write or an object read is refused", () => {
  const owner = ["--bucket", "examplefake-b", "--expected-bucket-owner", ACCOUNT];
  const tail = ["--region", "us-east-1", "--output", "json"];
  assert.ok(isAllowedReadArgv(["s3api", "head-bucket", ...owner, ...tail]));
  assert.ok(isAllowedReadArgv(["s3api", "list-object-versions", ...owner, "--max-items", "1", ...tail]));
  for (const argv of [
    ["s3api", "head-bucket", "--bucket", "examplefake-b", ...tail],
    ["s3api", "head-bucket", "--bucket", "examplefake-b", "--expected-bucket-owner", "12345", ...tail],
    ["s3api", "list-object-versions", ...owner, "--max-items", "1000", ...tail],
    ["s3api", "list-object-versions", ...owner, ...tail],
    ["s3api", "list-object-versions", ...owner, "--max-items", "1", "--prefix", "x", ...tail],
    ["s3api", "list-objects-v2", ...owner, "--max-items", "1", ...tail],
    ["s3api", "get-object", ...owner, ...tail],
    ["s3api", "delete-bucket", ...owner, ...tail],
    ["s3api", "delete-objects", ...owner, ...tail],
    ["s3api", "put-bucket-versioning", ...owner, ...tail],
    ["s3api", "abort-multipart-upload", ...owner, ...tail],
    ["s3", "rm", "s3://examplefake-b", "--recursive"],
    ["s3api", "head-bucket", "--bucket", "Bad_Bucket", "--expected-bucket-owner", ACCOUNT, ...tail],
    ["s3api", "head-bucket", ...owner, "--region", "us-east-1", "--output", "text"],
    ["s3api", "get-bucket-versioning", ...owner, "--region", "us-east-1", "--output", "json", "--debug"],
    ["bcm-data-exports", "list-executions", "--export-arn", "arn:aws:bcm-data-exports:us-east-1:" + ACCOUNT + ":export/x", "--region", "us-east-2", "--output", "json"],
    ["bcm-data-exports", "delete-export", "--export-arn", "arn:aws:bcm-data-exports:us-east-1:" + ACCOUNT + ":export/x", "--region", "us-east-1", "--output", "json"],
    ["bcm-data-exports", "list-executions", "--export-arn", "arn:aws:s3:::x", "--region", "us-east-1", "--output", "json"],
  ]) assert.equal(isAllowedReadArgv(argv), false, argv.join(" "));
});
