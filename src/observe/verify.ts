import { parseAwsTaggedResources } from "../teardown/readers.js";
import { ALZ_TAG_KEYS } from "../teardown/unit.js";
import type { Blueprint, BlueprintEntry } from "./blueprint.js";

/**
 * Independent verification of a blueprint against AWS (docs/observe-and-cleanup.md).
 *
 * It shares nothing with the engine: it asks the AWS Cloud Control API, read-only (`cloudcontrol get-resource`), whether
 * each resource exists under the identifier the state recorded, and it lists the resources tagged with the run's deletion
 * unit to find any the blueprint does not name. The caller runs the AWS CLI under the read-only DISCOVERY identity. Only
 * existence is recorded, never a property the cloud returns.
 *
 * The same check answers both questions the journey asks: after an apply, is everything planned there (PRESENT); after
 * cleanup, is everything deleted gone (ABSENT).
 */

/** How Cloud Control names a Terraform resource type: its CloudFormation type, and which state identifier is its primary identifier. */
export const CLOUD_CONTROL_TYPES: Readonly<Record<string, { typeName: string; identifier: "id" | "arn"; pendingDeletion?: { property: string; value: string } }>> = {
  aws_cloudwatch_log_group: { typeName: "AWS::Logs::LogGroup", identifier: "id" },
  aws_s3_bucket: { typeName: "AWS::S3::Bucket", identifier: "id" },
  aws_iam_role: { typeName: "AWS::IAM::Role", identifier: "id" },
  aws_iam_openid_connect_provider: { typeName: "AWS::IAM::OIDCProvider", identifier: "arn" },
  aws_sns_topic: { typeName: "AWS::SNS::Topic", identifier: "arn" },
  aws_sqs_queue: { typeName: "AWS::SQS::Queue", identifier: "id" },
  // A deleted KMS key exists for a waiting period in KeyState PendingDeletion: present, and on its way out.
  aws_kms_key: { typeName: "AWS::KMS::Key", identifier: "id", pendingDeletion: { property: "KeyState", value: "PendingDeletion" } },
  aws_dynamodb_table: { typeName: "AWS::DynamoDB::Table", identifier: "id" },
  aws_vpc: { typeName: "AWS::EC2::VPC", identifier: "id" },
  aws_subnet: { typeName: "AWS::EC2::Subnet", identifier: "id" },
  aws_security_group: { typeName: "AWS::EC2::SecurityGroup", identifier: "id" },
};

/**
 * Types whose only Cloud Control read returns application data or secret contents, so the verifier never asks for them
 * (owner decision 2026-10-27, issue #39 comment 6440801434, item 2: DISCOVERY reads control-plane metadata only). The
 * Lambda function read handler returns the environment variables and needs kms:Decrypt. Each is NOT_CHECKABLE with
 * DATA_BEARING_READ_EXCLUDED: named, never assumed present or absent. A cleanup proposal lists a run-created one as
 * UNVERIFIABLE (it still needs the contract's human approvals), and the leftover check reports it UNKNOWN, so the record
 * stays INCOMPLETE.
 */
export const DATA_BEARING_TYPES: ReadonlySet<string> = new Set([
  "aws_lambda_function", "awscc_lambda_function", "AWS::Lambda::Function",
  "aws_ssm_parameter", "awscc_ssm_parameter", "AWS::SSM::Parameter",
  "aws_secretsmanager_secret", "awscc_secretsmanager_secret", "AWS::SecretsManager::Secret",
]);

/**
 * The same reader for a CloudFormation-typed blueprint entry (the CDK engine, whose addresses are logical ids and whose
 * types are CloudFormation types): a type the table above names is read under its own type name with the physical id the
 * stack reported as the identifier. UNVERIFIED (9, src/apply/engines/cdk.ts): that the physical id is the Cloud Control
 * primary identifier for each of these types. A CloudFormation type the table does not name is NOT_CHECKABLE, never assumed.
 */
const CLOUD_CONTROL_TYPE_NAMES = new Map(Object.values(CLOUD_CONTROL_TYPES).map((mapping) => [mapping.typeName, mapping]));
export function cloudControlMappingOf(type: string): { typeName: string; identifier: "id" | "arn"; pendingDeletion?: { property: string; value: string } } | undefined {
  const byTerraformType = CLOUD_CONTROL_TYPES[type];
  if (byTerraformType) return byTerraformType;
  // A CloudFormation-typed entry: the physical id is the primary identifier; for a type whose primary identifier is an ARN (an SNS topic, an
  // OIDC provider) the physical id is that ARN, and the blueprint holds it as both `id` and `arn`.
  return CLOUD_CONTROL_TYPE_NAMES.get(type);
}

/** One AWS CLI call. The caller supplies it, bound to the DISCOVERY identity and the bounded runner. */
export type AwsCli = (argv: readonly string[]) => Promise<{ code: number; stdout: string; stderr: string }>;

export type Existence = "PRESENT" | "ABSENT" | "UNKNOWN" | "NOT_CHECKABLE";
export type ResourceCheck = {
  address: string;
  type: string;
  /** The identifier the check used, or null when there was none to use. */
  identifier: string | null;
  existence: Existence;
  /** Why the check could not decide: an error class, never the cloud's message. */
  reason?: string;
  /** PRESENT, and the cloud says the resource is scheduled for deletion (a KMS key in its waiting period): not gone, not a leftover a person must remove. */
  pendingDeletion?: true;
  /**
   * PRESENT, and a property the reader was asked to compare differs from the desired value: a fixed reason, never the value (the GCP
   * reader's `STORAGE_POLICY_MISMATCH`, D11). The observation FAILS; the resource is recorded as DIFFERENT_FROM_DESIRED.
   */
  differs?: string;
};
export type ObserveVerdict = "VERIFIED" | "PARTIAL" | "INCONCLUSIVE" | "FAILED";
export type ObserveReport = {
  verdict: ObserveVerdict;
  checks: ResourceCheck[];
  /** Planned addresses the state does not hold (from the blueprint). */
  missingFromState: string[];
  /** ARNs tagged with this run's unit that the blueprint does not name. */
  unexpected: string[];
  /**
   * COMPLETE: the tag listing covered every page. INCOMPLETE: it was paginated or failed, so it cannot prove there is
   * nothing unexpected. NOT_AVAILABLE: the run's resources carry no deletion-unit tag, so there is nothing to list by.
   */
  inventory: "COMPLETE" | "INCOMPLETE" | "NOT_AVAILABLE";
  verifier: VerifierId;
};

/** Which independent read API answered: AWS Cloud Control through the aws CLI, or Azure Resource Manager or Google's REST APIs in process. */
export type VerifierId = "AWS_CLOUD_CONTROL" | "AZURE_RESOURCE_MANAGER" | "GCP_REST";
export const VERIFIERS: readonly VerifierId[] = ["AWS_CLOUD_CONTROL", "AZURE_RESOURCE_MANAGER", "GCP_REST"];

/**
 * One cloud's independent reader: existence of one blueprint entry, and the identifiers carrying this run's unit tag.
 * Both read-only, both under the DISCOVERY identity, both returning existence and identifiers and nothing else.
 */
export type ResourceReader = {
  verifier: VerifierId;
  check(entry: BlueprintEntry): Promise<ResourceCheck>;
  /** Identifiers tagged with the unit, and whether the listing covered every page; undefined when the listing failed. */
  listTagged(unitId: string): Promise<{ identifiers: string[]; complete: boolean } | undefined>;
};

/** How a verifier is handed in: the AWS CLI with its region (the original shape), or any reader. */
export type ReaderInput = { region: string; aws: AwsCli } | { reader: ResourceReader };
export const readerOf = (input: ReaderInput): ResourceReader => "reader" in input ? input.reader : cloudControlReader(input.aws, input.region);

/** The AWS reader: Cloud Control for existence, the tagging API for the sweep. */
export function cloudControlReader(aws: AwsCli, region: string): ResourceReader {
  return {
    verifier: "AWS_CLOUD_CONTROL",
    check: (entry) => checkResource(entry, region, aws),
    async listTagged(unitId) {
      try {
        const result = await aws(["resourcegroupstaggingapi", "get-resources", "--tag-filters", "Key=" + ALZ_TAG_KEYS.unit + ",Values=" + unitId, "--region", region, "--output", "json"]);
        if (result.code !== 0) return undefined;
        const inventory = parseAwsTaggedResources(result.stdout);
        return { identifiers: inventory.resources.map((resource) => resource.resourceId), complete: inventory.complete };
      } catch {
        return undefined;
      }
    },
  };
}

const ERROR_CLASSES: readonly [RegExp, string][] = [
  [/AccessDenied|UnauthorizedOperation|not authorized/i, "ACCESS_DENIED"],
  [/Throttl|TooManyRequests|RequestLimitExceeded/i, "THROTTLED"],
  [/ExpiredToken|InvalidClientTokenId|UnrecognizedClient|Unable to locate credentials/i, "CREDENTIALS"],
  [/UnsupportedAction|TypeNotFound/i, "TYPE_NOT_SUPPORTED"],
];
const errorClass = (stderr: string): string => ERROR_CLASSES.find(([pattern]) => pattern.test(stderr))?.[1] ?? "CLI_ERROR";

/** Whether one blueprint entry exists in AWS. */
export async function checkResource(entry: BlueprintEntry, region: string, aws: AwsCli): Promise<ResourceCheck> {
  const base = { address: entry.address, type: entry.type };
  if (DATA_BEARING_TYPES.has(entry.type)) return { ...base, identifier: entry.arn ?? entry.id, existence: "NOT_CHECKABLE", reason: "DATA_BEARING_READ_EXCLUDED" };
  const mapping = cloudControlMappingOf(entry.type);
  if (!mapping) return { ...base, identifier: entry.arn ?? entry.id, existence: "NOT_CHECKABLE", reason: "NO_CLOUD_CONTROL_MAPPING" };
  // For a type Cloud Control identifies by ARN (an SNS topic, an OIDC provider) a CloudFormation physical id is that ARN, and a proposal
  // files it as `id` or `arn` depending on which field held it, so either field serves when it is an ARN. For a type identified by its
  // id, only `id` serves: an ARN is never read as the id (review of #265, N2).
  const cloudFormation = /^AWS::/.test(entry.type);
  const identifier = mapping.identifier === "arn" ? entry.arn ?? (cloudFormation && entry.id?.startsWith("arn:") ? entry.id : null) : entry.id;
  if (identifier === null) return { ...base, identifier: null, existence: "NOT_CHECKABLE", reason: "NO_IDENTIFIER_IN_STATE" };
  let result: Awaited<ReturnType<AwsCli>>;
  try {
    result = await aws(["cloudcontrol", "get-resource", "--type-name", mapping.typeName, "--identifier", identifier, "--region", region, "--output", "json"]);
  } catch {
    return { ...base, identifier, existence: "UNKNOWN", reason: "CLI_NOT_RUN" };
  }
  if (result.code === 0) {
    try {
      const body = JSON.parse(result.stdout) as { ResourceDescription?: { Identifier?: unknown; Properties?: unknown } };
      if (body.ResourceDescription?.Identifier === identifier) {
        // The one property ever read: the deletion state of a type that has a waiting period. Nothing else leaves the answer.
        const pending = mapping.pendingDeletion;
        let scheduled = false;
        if (pending && typeof body.ResourceDescription.Properties === "string") {
          try { scheduled = (JSON.parse(body.ResourceDescription.Properties) as Record<string, unknown>)[pending.property] === pending.value; } catch { scheduled = false; }
        }
        return { ...base, identifier, existence: "PRESENT", ...(scheduled ? { pendingDeletion: true as const } : {}) };
      }
    } catch { /* falls through: an answer that does not name the resource proves nothing */ }
    return { ...base, identifier, existence: "UNKNOWN", reason: "UNEXPECTED_RESPONSE" };
  }
  // The AWS CLI's own error line for this call, not the word anywhere in the output.
  if (/An error occurred \(ResourceNotFoundException\) when calling the GetResource operation/.test(result.stderr)) return { ...base, identifier, existence: "ABSENT" };
  return { ...base, identifier, existence: "UNKNOWN", reason: errorClass(result.stderr) };
}

/** ARNs carrying this unit's tag that the blueprint does not name, and whether the listing was complete. */
export async function unexpectedTagged(blueprint: Blueprint, unitId: string, region: string, aws: AwsCli):
  Promise<{ unexpected: string[]; complete: boolean }> {
  try {
    const result = await aws(["resourcegroupstaggingapi", "get-resources", "--tag-filters", "Key=" + ALZ_TAG_KEYS.unit + ",Values=" + unitId,
      "--region", region, "--output", "json"]);
    if (result.code !== 0) return { unexpected: [], complete: false };
    const inventory = parseAwsTaggedResources(result.stdout);
    const known = new Set([...blueprint.entries.flatMap((entry) => [entry.arn, entry.id]), blueprint.container?.identifier ?? null].filter((x): x is string => x !== null));
    const unexpected = inventory.resources.map((resource) => resource.resourceId).filter((arn) => !known.has(arn)).sort();
    return { unexpected, complete: inventory.complete };
  } catch {
    return { unexpected: [], complete: false };
  }
}

/**
 * After an apply: is every resource the plan left in the state really there, and is nothing else carrying this run's tag?
 *
 * VERIFIED: every entry is PRESENT, nothing planned is missing, nothing unexpected, and the listing was complete.
 * PARTIAL: as VERIFIED, except some resource types cannot be checked independently (they are named, not assumed), or the
 * run carries no unit tag, so nothing outside the state can be looked for.
 * INCONCLUSIVE: a check could not decide (access, throttling, an incomplete listing), or the blueprint names no resources
 * so nothing was checked; nothing is known to be wrong.
 * FAILED: something planned is absent or missing from the state, a compared property differs from the desired value, or an
 * unexpected resource carries the tag.
 */
export async function observeBlueprint(blueprint: Blueprint, input: { unitId: string | null } & ReaderInput): Promise<ObserveReport> {
  const reader = readerOf(input);
  const checks: ResourceCheck[] = [];
  for (const entry of blueprint.entries) checks.push(await reader.check(entry));
  const listed = input.unitId === null ? null : unexpectedOf(blueprint, await reader.listTagged(input.unitId), reader.verifier);
  const inventory = listed === null ? "NOT_AVAILABLE" : listed.complete ? "COMPLETE" : "INCOMPLETE";
  const unexpected = listed?.unexpected ?? [];
  const has = (existence: Existence) => checks.some((check) => check.existence === existence);
  const verdict: ObserveVerdict =
    has("ABSENT") || checks.some((check) => check.differs !== undefined) || blueprint.missing.length > 0 || unexpected.length > 0 ? "FAILED"
    : has("UNKNOWN") || inventory === "INCOMPLETE" || blueprint.entries.length === 0 ? "INCONCLUSIVE"
    : has("NOT_CHECKABLE") || inventory === "NOT_AVAILABLE" ? "PARTIAL" : "VERIFIED";
  return { verdict, checks, missingFromState: [...blueprint.missing], unexpected, inventory, verifier: reader.verifier };
}

/**
 * The listed identifiers the blueprint does not name, from any reader's listing. A failed listing is incomplete and names
 * nothing. Identifiers are compared exactly, except under Azure Resource Manager, whose ids are case-insensitive: an AWS
 * ARN that differs only in case names another resource (queue, topic and function names are case-sensitive) and stays a stray.
 */
export function unexpectedOf(blueprint: Blueprint, listed: { identifiers: string[]; complete: boolean } | undefined, verifier: VerifierId): { unexpected: string[]; complete: boolean } {
  if (!listed) return { unexpected: [], complete: false };
  const fold = (x: string): string => verifier === "AZURE_RESOURCE_MANAGER" ? x.toLowerCase() : x;
  // The unit's container (a CloudFormation stack) carries the tags too: known, never a stray.
  const known = new Set([...blueprint.entries.flatMap((entry) => [entry.arn, entry.id]), blueprint.container?.identifier ?? null].filter((x): x is string => x !== null).map(fold));
  return { unexpected: listed.identifiers.filter((identifier) => !known.has(fold(identifier))).sort(), complete: listed.complete };
}
