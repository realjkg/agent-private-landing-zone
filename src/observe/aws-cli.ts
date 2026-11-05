import { readFileSync } from "node:fs";

import { approvedToolDirs, resolveExecutable } from "../tools/child-env.js";
import { createPrivateDirectory } from "../tools/private-workdir.js";
import { runBoundedProcess } from "../tools/process.js";
import { AWS_CFN_APPLY_PROFILE, type ProcessProfile } from "../tools/profiles.js";
import { sha256 } from "../util/sha256.js";
import type { AwsCli } from "./verify.js";

/**
 * The AWS CLI as the independent verifier runs it (docs/observe-and-cleanup.md): read-only calls under the DISCOVERY
 * identity through the governed runner, from a private scratch directory, with the same identity-only environment as
 * every pilot child (no static key, profile, config file, endpoint override or metadata fallback). Only the two read
 * shapes `src/observe/verify.ts` makes, and the cleanup preflight's five (`src/apply/bucket-preflight.ts`), are run; any other
 * argument list is refused before a process exists. Output is returned to the caller, which keeps existence, counts and
 * states, never an object key name.
 */
const EXECUTABLE = "aws";
const REGION = /^[a-z]{2}(-[a-z]+)+-[0-9]$/;
const TYPE_NAME = /^AWS::[A-Za-z0-9]+::[A-Za-z0-9]+$/;
const IDENTIFIER = /^[^\u0000-\u001f\u007f]{1,2048}$/;
const TAG_FILTER = /^Key=[A-Za-z0-9._:/=+@-]{1,128},Values=[A-Za-z0-9._:/=+@-]{1,256}$/;

/** A two-minute read, output capped as the runner's default; excerpts suppressed because a resource description can quote properties. */
export const AWS_READ_PROFILE: ProcessProfile = { ...AWS_CFN_APPLY_PROFILE, timeoutMs: 120_000 };

/** An S3 bucket name as S3 allows it for a new bucket (lowercase letters, digits, dots and hyphens; 3 to 63 characters). */
export const BUCKET_NAME = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;
/** A 12-digit AWS account id: what `--expected-bucket-owner` names, so S3 itself refuses a bucket any other account owns. */
export const ACCOUNT_ID = /^[0-9]{12}$/;
/** A Data Exports export ARN, which exists in us-east-1 only. */
export const EXPORT_ARN = /^arn:aws:bcm-data-exports:us-east-1:[0-9]{12}:export\/[A-Za-z0-9_-]{1,200}$/;
/** The cleanup preflight's bucket reads (src/apply/bucket-preflight.ts). Each one names the expected owner. */
export const BUCKET_READS = ["head-bucket", "get-bucket-versioning", "list-object-versions", "list-multipart-uploads"] as const;

/**
 * Exact shapes only: `cloudcontrol get-resource` for one type and identifier, and `resourcegroupstaggingapi get-resources` for one
 * tag filter, both JSON in one region; and the cleanup preflight's reads: `s3api head-bucket` and `get-bucket-versioning` for one
 * bucket, `list-object-versions` and `list-multipart-uploads` for one bucket and at most one item, each with
 * `--expected-bucket-owner <12-digit account>`, and `bcm-data-exports list-executions` for one export ARN in us-east-1.
 */
export function isAllowedReadArgv(args: readonly string[]): boolean {
  if (args.some((arg) => typeof arg !== "string")) return false;
  if (args.length === 10 && args[0] === "cloudcontrol" && args[1] === "get-resource" && args[2] === "--type-name" && TYPE_NAME.test(args[3]) &&
    args[4] === "--identifier" && IDENTIFIER.test(args[5]) && !args[5].startsWith("-") && args[6] === "--region" && REGION.test(args[7]) && args[8] === "--output" && args[9] === "json") return true;
  if (args.length === 8 && args[0] === "resourcegroupstaggingapi" && args[1] === "get-resources" && args[2] === "--tag-filters" && TAG_FILTER.test(args[3]) &&
    args[4] === "--region" && REGION.test(args[5]) && args[6] === "--output" && args[7] === "json") return true;
  if (args.length === 8 && args[0] === "bcm-data-exports" && args[1] === "list-executions" && args[2] === "--export-arn" && EXPORT_ARN.test(args[3]) &&
    args[4] === "--region" && args[5] === "us-east-1" && args[6] === "--output" && args[7] === "json") return true;
  if (args[0] !== "s3api" || !(BUCKET_READS as readonly string[]).includes(args[1])) return false;
  const bucket = args[2] === "--bucket" && BUCKET_NAME.test(args[3]) && args[4] === "--expected-bucket-owner" && ACCOUNT_ID.test(args[5]);
  const tail = (from: number): boolean => args[from] === "--region" && REGION.test(args[from + 1]) && args[from + 2] === "--output" && args[from + 3] === "json";
  if (args[1] === "head-bucket" || args[1] === "get-bucket-versioning") return args.length === 10 && bucket && tail(6);
  return args.length === 12 && bucket && args[6] === "--max-items" && args[7] === "1" && tail(8);
}

export type DiscoveryCliOptions = {
  /** The runner's environment, holding `ALZ_DISCOVERY_*`. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Approved executable directories. Defaults to the runner's. Tests point this at a fake. */
  toolDirs?: readonly string[];
  /** Where the private working directory is made. */
  scratchParent?: string;
};

/** SHA-256 of the aws program a verification would run, or null when there is none to run. */
export function verifierBinarySha256(options: Pick<DiscoveryCliOptions, "env" | "toolDirs">): string | null {
  const path = resolveExecutable(EXECUTABLE, options.toolDirs ?? approvedToolDirs(options.env ?? process.env));
  try { return path ? sha256(readFileSync(path)) : null; } catch { return null; }
}

/** The verifier's AWS CLI, bound to DISCOVERY. `close` removes the private directory; call it when the observation is done. */
export function createDiscoveryAwsCli(options: DiscoveryCliOptions = {}): { aws: AwsCli; close(): void } {
  const scratch = createPrivateDirectory("alz-observe-", options.scratchParent);
  const aws: AwsCli = async (argv) => {
    if (!isAllowedReadArgv(argv)) throw new Error("OBSERVE_ARGV_NOT_ALLOWED");
    const result = runBoundedProcess("aws_cloudformation", EXECUTABLE, [...argv], scratch.path, {
      profile: AWS_READ_PROFILE, env: options.env ?? process.env, toolDirs: options.toolDirs, identity: "DISCOVERY", root: scratch.path, suppressDetail: true,
    });
    // A refused environment or a truncated answer is a failed read: the verifier records UNKNOWN, never PRESENT or ABSENT.
    if (result.refusedEnvironment?.length || result.truncated) return { code: 254, stdout: "", stderr: "OBSERVE_READ_UNUSABLE" };
    return { code: result.exitCode ?? 254, stdout: result.stdout, stderr: result.stderr };
  };
  return { aws, close: () => { scratch.remove(); } };
}
