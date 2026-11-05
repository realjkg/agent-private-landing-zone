import { ACCOUNT_ID, BUCKET_NAME, EXPORT_ARN, createDiscoveryAwsCli } from "../observe/aws-cli.js";
import type { AwsCli } from "../observe/verify.js";
import { COST_BASELINE_TYPE, type CleanupProposal } from "./cleanup-proposal.js";
import type { Refusal } from "./contract.js";
import type { AwsTarget } from "./providers/aws.js";
import type { ApplyRefusalCode, PilotContract } from "./types.js";

/**
 * The cleanup's bucket preflight (owner decision of 2026-11-05, issue #39 comment 6646346513, items 1 and 2). An S3 bucket is
 * deleted only when it is empty, and Terraform destroys a bucket's policy, public access block, encryption, lifecycle and
 * ownership controls before it reaches DeleteBucket. A cleanup that tried a bucket holding data would therefore strip the data's
 * protections and then fail. So, immediately before the approvals are consumed, every run-owned `aws_s3_bucket` on the approved
 * list is read again as DISCOVERY, and the cleanup goes on only when each one is verified empty:
 *
 * - `s3api head-bucket`: the bucket exists, is owned by the target account (`--expected-bucket-owner`, so S3 itself refuses a
 *   bucket of any other account) and is in the contract's region (the answer's `BucketRegion`);
 * - `s3api get-bucket-versioning`: the versioning state is one S3 defines (never enabled, Enabled or Suspended);
 * - `s3api list-object-versions --max-items 1`: no object version and no delete marker;
 * - `s3api list-multipart-uploads --max-items 1`: no unfinished multipart upload;
 * - when the list also deletes a Data Exports export, `bcm-data-exports list-executions` for it: no execution QUEUED or IN_PROGRESS.
 *
 * Only counts and states are kept: no object key name, version id or upload id leaves this function. Anything that cannot be
 * decided (a non-zero exit, a refused or truncated read, access denied, throttling, another owner or region, malformed output, an
 * unknown versioning or execution state) is CLEANUP_BUCKET_UNVERIFIED; contents or a delivery in flight are CLEANUP_BUCKET_NOT_EMPTY.
 * Either way the cleanup stops before anything is destroyed or consumed, the bucket keeps its data and its protections, and
 * nothing is emptied: there is no automatic emptying and no `force_destroy`. It writes nothing.
 *
 * The residual race, stated plainly: the window between this check and Terraform's DeleteBucket cannot be closed from outside S3.
 * If an object lands in it (a delivery that starts after the check), DeleteBucket still fails, because the bucket is not
 * `force_destroy`; the settings destroyed before it are then gone, the run ends PARTIAL_REQUIRES_REVIEW, and a person reviews it.
 */
export type BucketPreflightDeps = {
  env?: NodeJS.ProcessEnv;
  toolDirs?: readonly string[];
  scratchParent?: string;
  /** Test seam: the DISCOVERY CLI. Production builds it from the DISCOVERY identity (`createDiscoveryAwsCli`). */
  aws?: AwsCli;
};

/** The Terraform type whose deletion the preflight guards. Generic: any run-owned bucket on the list, not only the cost baseline's. */
export const PREFLIGHT_BUCKET_TYPE = "aws_s3_bucket";

/** Execution states (AWS Data Exports `ExecutionStatusCode`) that mean a delivery may still write into the bucket. */
const DELIVERY_IN_FLIGHT = new Set(["INITIATION_IN_PROCESS", "QUERY_QUEUED", "QUERY_IN_PROCESS", "DELIVERY_IN_PROCESS"]);
/** Execution states that are finished: nothing more is written by them. */
const DELIVERY_FINISHED = new Set(["DELIVERY_SUCCESS", "DELIVERY_FAILURE", "QUERY_FAILURE"]);

const END = " Nothing was destroyed and no approval was consumed.";
const refuse = (code: ApplyRefusalCode, message: string): Refusal => ({ ok: false, code, message });

class Unverified extends Error {}
const unverified = (why: string): never => { throw new Unverified(why); };

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** Why a failed read failed, in words, from the CLI's error text. The text itself is never returned: it can name keys. */
function failureOf(code: number, stderr: string): string {
  if (/AccessDenied|\b403\b|Forbidden/i.test(stderr)) return "the read was denied (access denied, or the bucket is owned by another account than the target's)";
  if (/Throttl|SlowDown|TooManyRequests|RequestLimitExceeded|\b503\b/i.test(stderr)) return "the read was throttled";
  if (/PermanentRedirect|\b301\b|AuthorizationHeaderMalformed|IllegalLocationConstraint/i.test(stderr)) return "the bucket answered from another region";
  if (/NoSuchBucket|NotFound|\b404\b/i.test(stderr)) return "the bucket was not found";
  if (/timed? ?out|timeout/i.test(stderr)) return "the read timed out";
  if (stderr === "OBSERVE_READ_UNUSABLE") return "the read was refused or its answer was cut short";
  return "the read did not complete (exit " + code + ")";
}

async function readJson(aws: AwsCli, argv: readonly string[], emptyIs?: Record<string, unknown>): Promise<Record<string, unknown>> {
  let result: Awaited<ReturnType<AwsCli>>;
  try { result = await aws(argv); } catch { return unverified("the read could not be started"); }
  if (result.code !== 0) return unverified(failureOf(result.code, result.stderr));
  const text = result.stdout.trim();
  // `get-bucket-versioning` on a bucket that never had versioning answers with no fields, which the CLI prints as nothing.
  if (text === "" && emptyIs !== undefined) return emptyIs;
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return unverified("the answer was not readable"); }
  return isObject(parsed) ? parsed : unverified("the answer was not readable");
}

/** The number of entries in an optional list field; anything but an absent field, null or a list is malformed. */
function countOf(body: Record<string, unknown>, field: string): number {
  const value = body[field];
  if (value === undefined || value === null) return 0;
  return Array.isArray(value) ? value.length : unverified("the answer was not readable");
}

/** The counts (never the names) a bucket's contents reads found. */
type BucketContents = { versioning: "NEVER_ENABLED" | "Enabled" | "Suspended"; versions: number; deleteMarkers: number; uploads: number };

async function readBucket(aws: AwsCli, bucket: string, account: string, region: string): Promise<BucketContents> {
  const owner = ["--bucket", bucket, "--expected-bucket-owner", account];
  const where = ["--region", region, "--output", "json"];
  const head = await readJson(aws, ["s3api", "head-bucket", ...owner, ...where]);
  // HeadBucket names the bucket's region; the CLI follows a redirect to another region, so the answer is what is judged.
  if (typeof head.BucketRegion !== "string") unverified("the answer did not name the bucket's region");
  if (head.BucketRegion !== region) unverified("the bucket is in " + String(head.BucketRegion).slice(0, 32) + ", not the contract's region " + region);
  const versioning = await readJson(aws, ["s3api", "get-bucket-versioning", ...owner, ...where], {});
  if (Object.keys(versioning).some((key) => key !== "Status" && key !== "MFADelete")) unverified("the versioning state is unknown");
  if (versioning.MFADelete !== undefined && versioning.MFADelete !== "Enabled" && versioning.MFADelete !== "Disabled") unverified("the versioning state is unknown");
  const status = versioning.Status === undefined ? "NEVER_ENABLED" : versioning.Status === "Enabled" || versioning.Status === "Suspended" ? versioning.Status : unverified("the versioning state is unknown");
  const listed = await readJson(aws, ["s3api", "list-object-versions", ...owner, "--max-items", "1", ...where]);
  const versions = countOf(listed, "Versions");
  const deleteMarkers = countOf(listed, "DeleteMarkers");
  // A page that holds nothing but says more follows cannot show the bucket empty.
  if (versions + deleteMarkers === 0 && (listed.NextToken !== undefined || listed.IsTruncated === true)) unverified("the list of object versions was cut short");
  const pending = await readJson(aws, ["s3api", "list-multipart-uploads", ...owner, "--max-items", "1", ...where]);
  const uploads = countOf(pending, "Uploads");
  if (uploads === 0 && (pending.NextToken !== undefined || pending.IsTruncated === true)) unverified("the list of multipart uploads was cut short");
  return { versioning: status as BucketContents["versioning"], versions, deleteMarkers, uploads };
}

/** How many of the export's executions may still deliver. Every execution's state must be one Data Exports defines. */
async function deliveriesInFlight(aws: AwsCli, exportArn: string): Promise<number> {
  const body = await readJson(aws, ["bcm-data-exports", "list-executions", "--export-arn", exportArn, "--region", "us-east-1", "--output", "json"]);
  if (typeof body.NextToken === "string" && body.NextToken !== "") unverified("the list of export deliveries was cut short");
  const executions = body.Executions;
  if (executions !== undefined && !Array.isArray(executions)) unverified("the list of export deliveries was not readable");
  let inFlight = 0;
  for (const execution of (executions ?? []) as unknown[]) {
    const status = isObject(execution) && isObject(execution.ExecutionStatus) ? execution.ExecutionStatus.StatusCode : undefined;
    if (typeof status !== "string") unverified("an export delivery's state was not readable");
    if (DELIVERY_IN_FLIGHT.has(status as string)) inFlight += 1;
    else if (!DELIVERY_FINISHED.has(status as string)) unverified("an export delivery is in a state this check does not know");
  }
  return inFlight;
}

/**
 * The preflight: undefined when every run-owned bucket on the approved list is verified empty (and no export delivery is in flight),
 * else the refusal. Runs nothing destructive and writes nothing. Not an AWS contract, or no bucket on the list: nothing to check.
 */
export async function recheckBucketsEmpty(proposal: CleanupProposal, contract: PilotContract, deps: BucketPreflightDeps): Promise<Refusal | undefined> {
  if (contract.provider !== "AWS" || proposal.provider !== "AWS") return undefined;
  const buckets = proposal.deletes.filter((item) => item.type === PREFLIGHT_BUCKET_TYPE);
  if (buckets.length === 0) return undefined;
  const exports = proposal.deletes.filter((item) => item.type === COST_BASELINE_TYPE);
  const account = proposal.target.account;
  const region = (contract.targets[proposal.environment] as AwsTarget | undefined)?.region;
  const unverifiedRefusal = (subject: string, why: string): Refusal => refuse("CLEANUP_BUCKET_UNVERIFIED", subject + " could not be verified empty when it was read again as DISCOVERY immediately before deletion: " + why + "." + END +
    " The bucket keeps its data and its protections. Fix what stopped the read (the DISCOVERY identity's access, the region, or a retry after throttling), then run the same approved cleanup again while its approvals are valid (none was consumed); nothing here empties a bucket.");
  if (!ACCOUNT_ID.test(account) || region === undefined) return unverifiedRefusal("The run's buckets", "the target names no 12-digit account or no region");
  const opened = deps.aws ? { aws: deps.aws, close: () => undefined } : createDiscoveryAwsCli({ env: deps.env, toolDirs: deps.toolDirs, scratchParent: deps.scratchParent });
  try {
    // A delivery in flight would write into the bucket after any emptiness check, so it is read first.
    for (const item of exports) {
      const subject = "The Data Exports export " + item.address;
      if (item.identifier === null || !EXPORT_ARN.test(item.identifier) || item.identifier.split(":")[4] !== account) return unverifiedRefusal(subject, "its identifier is not an export ARN of the target account");
      let inFlight: number;
      try { inFlight = await deliveriesInFlight(opened.aws, item.identifier); } catch (error) {
        if (error instanceof Unverified) return unverifiedRefusal(subject + "'s deliveries", error.message);
        throw error;
      }
      if (inFlight > 0) {
        return refuse("CLEANUP_BUCKET_NOT_EMPTY", subject + " has " + inFlight + " delivery(ies) QUEUED or IN_PROGRESS, which may still write into the run's bucket." + END +
          " The bucket keeps its data and its protections. Wait until the delivery has finished, decide what to do with the delivered data, and run the same approved cleanup again, while its approvals are valid, only once the bucket is empty.");
      }
    }
    for (const item of [...buckets].sort((a, b) => (a.address < b.address ? -1 : 1))) {
      const subject = "The bucket " + item.address + " (" + (item.identifier ?? "no name in state") + ")";
      if (item.identifier === null || !BUCKET_NAME.test(item.identifier)) return unverifiedRefusal(subject, "its identifier is not a bucket name");
      let contents: BucketContents;
      try { contents = await readBucket(opened.aws, item.identifier, account, region); } catch (error) {
        if (error instanceof Unverified) return unverifiedRefusal(subject, error.message);
        throw error;
      }
      const found = [
        ...(contents.versions > 0 ? ["at least one object version"] : []),
        ...(contents.deleteMarkers > 0 ? ["at least one delete marker"] : []),
        ...(contents.uploads > 0 ? ["at least one unfinished multipart upload"] : []),
      ];
      if (found.length > 0) {
        return refuse("CLEANUP_BUCKET_NOT_EMPTY", subject + " is not empty: it holds " + found.join(", ") + " (versioning " + contents.versioning + "; counts only, no key names are kept)." + END +
          " The bucket keeps its data and its protections; nothing empties it automatically. A person decides what happens to the data (copy it, or empty the bucket by hand, versions and delete markers included), then runs the same approved cleanup again while its approvals are valid (none was consumed).");
      }
    }
  } finally {
    opened.close();
  }
  return undefined;
}
