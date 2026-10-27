import { namesBackendBucket } from "./providers/gcp.js";

/**
 * The GCP branch of the cleanup classifier (docs/observe-and-cleanup.md; the GCP release-path PLAN, section 4, and the G0 package's
 * protected classes, docs/act-pilot-gcp-terraform-g0.md). One function, `gcpProtectionOf`, answers for the cleanup proposal and for
 * `protectedDeletionIn` alike: why an entry is never deleted by a pilot cleanup, or undefined when it is an ordinary leaf.
 *
 * It lives beside the classifier it extends. `protectionOf` (src/apply/cleanup-proposal.ts) calls it for a GCP contract, with every
 * environment's backend bucket, and refuses any provider with no branch of its own as unclassifiable (review N5 of #310). GCP is not
 * yet an admitted provider, and `MATERIAL_RISKS` gains a spread of `GCP_MATERIAL_RISKS` when it is, with no change here. The answers
 * are the cleanup proposal's own ownership classes, so they map one to one.
 *
 * The rules, in order:
 * 1. PROTECTED_BACKEND: any entry whose identifier names an environment's state bucket under any form (P4, `namesBackendBucket`).
 * 2. CONTAINS_OTHERS, by type: projects, folders and organizations; project-wide API enablement; Deployment Manager and
 *    Infrastructure Manager deployments, whose deletion tears down everything their template created (the CloudFormation reasoning,
 *    reviews 6412896598 and 6432262110); Access Context Manager service perimeters. And by identifier: a whole
 *    `projects/<id>`, `folders/<n>` or `organizations/<n>`.
 * 3. PROTECTED_IDENTITY, by anchored prefix with no hand list: service accounts and everything of theirs, the `google_iam_`
 *    namespace (workload and workforce pools and providers, custom roles, deny policies, access boundaries), every project, folder,
 *    organization, billing-account and tag IAM type, Cloud Identity groups and memberships, Access Context Manager levels and
 *    perimeter memberships, and every resource-level binding (`_iam_policy`, `_iam_binding`, `_iam_member`, `_iam_audit_config`).
 * 4. UNCLASSIFIABLE: an identity's name under any other type (a service account, a pool, a role, a principal), a blank identifier,
 *    a wrapper whose attributes hold one (`gcpIdentityIn`), or a type field that is not a well-formed resource type.
 * 5. TYPE_UNREVIEWED: a well-formed type that is not on the reviewed leaf allowlist (`GCP_LEAF_TYPES`), the posture owner decision
 *    6433391052 item 1 set for AWS. The list starts with the minimal workload; a type joins it only by review. The PLAN's
 *    parity item for organization policies (ordinary, as SCPs are) waits for that review, so until then they are kept.
 */

export type GcpProtection = "PROTECTED_BACKEND" | "PROTECTED_IDENTITY" | "CONTAINS_OTHERS" | "TYPE_UNREVIEWED" | "UNCLASSIFIABLE";

/** The reviewed leaf types: deleting one deletes that resource and nothing it does not own. */
export const GCP_LEAF_TYPES: readonly string[] = ["google_pubsub_topic"];

const CONTAINER_TYPE = /^google_(?:project|folder|organization|project_service|project_service_identity|deployment_manager_deployment|access_context_manager_service_perimeters?)$|^google_infra_manager_/;
const IDENTITY_PREFIXES: readonly string[] = [
  "google_service_account", "google_iam_", "google_project_iam_", "google_folder_iam_", "google_organization_iam_", "google_billing_account_iam_",
  "google_tags_tag_key_iam_", "google_tags_tag_value_iam_", "google_cloud_identity_", "google_access_context_manager_",
  // The default service accounts' roles are managed by these: an identity setting, never a leaf.
  "google_project_default_service_accounts",
];
const RESOURCE_BINDING = /_iam_(?:policy|binding|member|audit_config)$/;
export const isGcpIdentityType = (type: string): boolean => IDENTITY_PREFIXES.some((prefix) => type.startsWith(prefix)) || RESOURCE_BINDING.test(type);
export const isGcpContainerType = (type: string): boolean => CONTAINER_TYPE.test(type);

const SCOPE_ID = /^(?:projects\/[a-z][a-z0-9-]{4,28}[a-z0-9]|projects\/[0-9]{1,24}|folders\/[0-9]{1,24}|organizations\/[0-9]{1,24})\/?$/;
/** An identity's name anywhere in a value: a service account (by path or email), a pool, a role, a principal identifier or an IAM member string. */
const IDENTITY_NAME = /\/serviceAccounts\/|\/workloadIdentityPools\/|\/workforcePools\/|(?:^|\/)roles\/|\.iam\.gserviceaccount\.com|gserviceaccount\.com\b|principal(?:Set)?:\/\/|\b(?:serviceAccount|user|group|domain|principal|principalSet|deleted):[^\s]/;
/** A Terraform resource type: a provider prefix and a name, lowercase letters, digits and underscores. */
const RESOURCE_TYPE = /^[a-z][a-z0-9]*_[a-z0-9_]+$/;

/** How deep the wrapper scan reads nested attributes; an entry nested deeper is treated as holding an identity (fail closed). */
export const GCP_SCAN_DEPTH = 32;

/**
 * Whether a state entry's attributes hold an identity's name anywhere (as a whole value, inside a string, or as an element of a
 * list), or nest past `GCP_SCAN_DEPTH` so one cannot be ruled out. For wrapper types (`terraform_data`, `null_resource`), which
 * can carry a service account in disguise. Judged in place; nothing is copied.
 */
export function gcpIdentityIn(value: unknown, depth = 0): boolean {
  if (depth > GCP_SCAN_DEPTH) return true;
  if (typeof value === "string") return IDENTITY_NAME.test(value);
  if (Array.isArray(value)) return value.some((item) => gcpIdentityIn(item, depth + 1));
  if (typeof value === "object" && value !== null) return Object.entries(value).some(([key, item]) => IDENTITY_NAME.test(key) || gcpIdentityIn(item, depth + 1));
  return false;
}

/**
 * Why a pilot cleanup never deletes this entry, or undefined for an ordinary leaf. `backendBuckets` are every environment's state
 * buckets from the reviewed contract. `holdsIdentity` is the wrapper scan's verdict (`gcpIdentityIn`) for the entry's attributes.
 */
export function gcpProtectionOf(entry: { type: string; id: string | null; holdsIdentity?: true }, backendBuckets: readonly string[]): GcpProtection | undefined {
  if (entry.id !== null && namesBackendBucket(entry.id, backendBuckets)) return "PROTECTED_BACKEND";
  // By type first: a container or an identity type is protected whatever its identifier says, and a dependent the state does not hold has only a type.
  if (isGcpContainerType(entry.type)) return "CONTAINS_OTHERS";
  if (isGcpIdentityType(entry.type)) return "PROTECTED_IDENTITY";
  if (entry.id !== null && entry.id.trim() === "") return "UNCLASSIFIABLE";
  if (entry.id !== null && SCOPE_ID.test(entry.id)) return "CONTAINS_OTHERS";
  // Fail closed: an identity's name under a type that is not an identity type may be a pilot service account in disguise.
  if ((entry.id !== null && IDENTITY_NAME.test(entry.id)) || entry.holdsIdentity === true) return "UNCLASSIFIABLE";
  if (!RESOURCE_TYPE.test(entry.type)) return "UNCLASSIFIABLE";
  return GCP_LEAF_TYPES.includes(entry.type) ? undefined : "TYPE_UNREVIEWED";
}

/** What deleting a resource of these types loses for good, shown to the cleanup approvers. Spread into `MATERIAL_RISKS` when wired. */
export const GCP_MATERIAL_RISKS: Readonly<Record<string, string>> = {
  google_storage_bucket: "deletes stored objects and their versions, which cannot be recovered once the bucket's soft-delete window has passed",
  google_sql_database_instance: "deletes the instance and its databases unless a backup or deletion protection was kept",
  google_kms_crypto_key: "a key is never deleted, but its versions are scheduled for destruction, after which data encrypted with them cannot be decrypted",
  google_secret_manager_secret: "deletes every version of the secret, which cannot be recovered",
  google_bigquery_dataset: "deletes the dataset and every table in it, which cannot be recovered after the time-travel window",
  google_compute_disk: "deletes the disk and its data unless a snapshot was kept",
  google_logging_project_bucket_config: "deletes the log bucket and its retained logs once its retention lock and grace period allow",
  google_pubsub_topic: "detaches its subscriptions, and messages not yet delivered from them are lost",
};
