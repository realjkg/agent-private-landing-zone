import { randomBytes } from "node:crypto";

import { DATA_BEARING_TYPES, cloudControlMappingOf } from "../observe/verify.js";
import { canonicalJson } from "../teardown/manifest.js";
import type { ResolvedTarget } from "../teardown/driver/types.js";
import { sha256 } from "../util/sha256.js";
import { COMMIT, ENVIRONMENTS, HASH, INVISIBLE, stripInvisible } from "./constants.js";
import type { BlueprintRecord, ObservationRecord, ObservedResource } from "./run-records.js";
import { PILOT_CHANNELS, type ApplyEnvironment, type ApplyEvidence, type ApplyRefusalCode, type EngineId, type PilotChannel, type PilotContract, type PlanChange, type ProviderId, type SealedRequest } from "./types.js";
import { REQUESTER_MAY_APPROVE, signRequest } from "./approval.js";
import { authorizeContract, targetMoved } from "./contract.js";
import { REQUESTER_ID, wellFormedRequest } from "./seal.js";
import { isResourceAddress } from "./terraform.js";
import type { AwsTarget } from "./providers/aws.js";
import type { AzureTarget } from "./providers/azure.js";
import type { GcpTarget } from "./providers/gcp.js";
import { gcpProtectionOf } from "./cleanup-gcp.js";
import { armPathSafe, isArmGroupId, isArmRegistrationId, isArmScopeId, parseArmId, type ArmType } from "../observe/azure-rest.js";
import { awsContainerFamilyOf } from "../observe/aws-containers.js";
import { awsLeafConditionProblem, awsLeafEntryOf, awsParentIdOf, isAwsLeafType, isWellFormedResourceType } from "../observe/aws-leaf-types.js";
import { AWS_PRINCIPAL_TYPES, AWS_RUN_CREATED_POLICY_TYPES, AZURE_RUN_CREATED_POLICY_TYPES, CUSTOMER_POLICY_ARN, awsPolicyEntryOf, azurePolicyProblem, type PolicyLink } from "../observe/run-created-policies.js";
import { EXECUTION_IDENTITIES, identityVariables } from "../tools/identity.js";

/**
 * The cleanup proposal (docs/act-pilot-plan.md, "Cleanup of pilot-created resources"): the reviewable, hash-identified list
 * of exactly the resources one successful apply created, which a separately authorized cleanup may destroy. It is built from
 * three records of the same run, each bound by hash: the apply's own evidence, the blueprint the engine's state gave right
 * after the apply (addresses and cloud identifiers), and a fresh independent observation of those identifiers. Ownership
 * comes from the sealed plan and the engine's state, never from tags: a resource is proposed only when the plan created
 * it, the state still holds it, and the cloud was asked about it. Anything pre-existing, imported, replaced, outside the
 * plan, or protected (the state backend, the pilot's own identities) is excluded and listed as such, each with who keeps it.
 *
 * The pilot cleanup policy (owner decisions of 2026-10-26, issue #39): a pilot cleanup deletes only explicitly approved,
 * independently identified, run-owned resources. It never deletes a resource group (whatever type created it, whatever it
 * holds; the group is recorded as intentionally retained by the pilot owner, and its deletion is a separate, reviewed
 * action), never an identity or authorization object (role assignments, role definitions, `azuread_*` objects, the
 * bootstrap and execution identities, by Terraform type or by the ARM type of the id), and never deployment history
 * (`Microsoft.Resources/deployments`, by Terraform type or by the ARM type of the id). The same classification refuses a
 * destroy plan that would take any of them along as a dependent (`protectedDeletionIn`), before anything is consumed.
 *
 * The proposal fails closed: no proposal is made from an apply that did not succeed, from a planned resource the state
 * never mapped, from an observation that could not decide, or from an observation that found something unexpected.
 * Approvers sign the proposal's hash under the cleanup domain (src/apply/approval.ts); the cleanup driver destroys the
 * proposal's addresses and nothing else, and refuses when the engine's destroy plan differs from them.
 *
 * A cleanup has a requester, as an apply does (owner decision 6440801434, item 1: production cleanup approvals use the same
 * quorum as production apply). The requester's id is part of the proposal's hash, so every approver signs who requested;
 * the requester signs that hash under the cleanup request domain with their allowlisted key (`signCleanupProposal`), and
 * the signature sits beside the hashed fields. In PROD no cleanup approval may come from the requester's id or key, and two
 * distinct approvals are required, through the same check as an apply (`verifyApprovalSet`, `REQUESTER_MAY_APPROVE`).
 * A proposal made before cleanup requesters existed (schema 1) is refused everywhere.
 */
/**
 * TYPE_UNREVIEWED (AWS; delegated owner decision 6433391052, item 1): the run created it, but its type is not on the reviewed leaf
 * allowlist (src/observe/aws-leaf-types.ts), so the cleanup cannot tell what deleting it would take with it. It is kept, listed with
 * its type, and left to the environment's owner; it is never deleted, directly or as a dependent, and the leftover check cannot
 * report COMPLETE while one remains. The same class holds an allowlisted attachment or setting whose parent this proposal does not
 * delete (design review 6434540427, B3), with its own reason (`parentKeptReason`).
 */
export type Ownership = "RUN_CREATED" | "PRE_EXISTING" | "REPLACED_PRE_EXISTING" | "IMPORTED" | "NOT_IN_PLAN" | "TYPE_UNREVIEWED" | "PROTECTED_BACKEND" | "PROTECTED_IDENTITY" | "PROTECTED_DEPLOYMENT" | "RETAINED_GROUP" | "CONTAINS_OTHERS" | "CANARY_RETAINED";
/**
 * The ownership classes a pilot cleanup never deletes, whoever created the resource and whatever the plan said. CANARY_RETAINED (owner
 * decision E1): a run-created resource of a type the reviewed contract's canary allowlist marks `retain: true`, within its count; kept
 * by the pilot owner as an intentional retention (the leftover check records it as RETENTION_DECISION, never as an unreviewed type).
 */
export const PROTECTED_OWNERSHIPS: readonly Ownership[] = ["PROTECTED_BACKEND", "PROTECTED_IDENTITY", "PROTECTED_DEPLOYMENT", "RETAINED_GROUP", "CONTAINS_OTHERS", "CANARY_RETAINED"];
/**
 * Who keeps a resource the cleanup leaves: the pilot owner (a policy decision: the backend, identities and grants, deployment
 * history, resource groups, subscriptions and management groups; environment retirement is the owner's separate, reviewed
 * action) or the environment's owner (a resource this run did not create is not the pilot's to delete).
 */
export type RetentionOwner = "PILOT_OWNER" | "ENVIRONMENT_OWNER";
export const RETENTION_OWNERS: readonly RetentionOwner[] = ["PILOT_OWNER", "ENVIRONMENT_OWNER"];
export const retentionOwnerOf = (ownership: Exclude<Ownership, "RUN_CREATED">): RetentionOwner => PROTECTED_OWNERSHIPS.includes(ownership) ? "PILOT_OWNER" : "ENVIRONMENT_OWNER";
/** Why a resource of a protected class is kept, in the words the proposal, the leftover check and the report use. */
export const PROTECTION_REASONS: Readonly<Record<Exclude<Ownership, "RUN_CREATED" | "PRE_EXISTING" | "REPLACED_PRE_EXISTING" | "IMPORTED" | "NOT_IN_PLAN" | "TYPE_UNREVIEWED">, string>> = {
  PROTECTED_BACKEND: "the state backend the pilot itself runs on is never deleted by a cleanup",
  // Under 512 characters: a proposal's reason text has that limit.
  PROTECTED_IDENTITY: "an identity or authorization object (on Azure anything under Microsoft.Authorization or Microsoft.ManagedIdentity: an identity, a trust, a role or policy assignment, a role definition, a policy exemption or a lock; on AWS anything in the IAM, IAM Identity Center or Identity Store services, including attachments, access keys and other credentials of those identities) is never deleted by a cleanup, directly or as a dependent (sole exception: run-created policies, src/observe/run-created-policies.ts)",
  PROTECTED_DEPLOYMENT: "deployment history (Microsoft.Resources/deployments) records what was deployed and is never deleted by a cleanup",
  RETAINED_GROUP: "a resource group is never deleted by a pilot cleanup, whatever it holds; the pilot owner retains it, and its deletion is a separate, reviewed action (environment retirement, outstanding)",
  // Under 512 characters: a proposal's reason text has that limit.
  CANARY_RETAINED: "the reviewed contract's canary allowlist names this type with retain: true: a no-cost, inert sentinel the run created and the cleanup intentionally keeps (it keeps the stack from being emptied); the pilot owner retains it until the environment is retired",
  CONTAINS_OTHERS: "a container is never deleted by a cleanup: on Azure a subscription or management group holds other deployments, and a provider or feature registration is a setting others rely on; on AWS anything that deploys a CloudFormation stack or a provisioned product (Service Catalog, SAR, SageMaker, Proton, Beanstalk, SSM Quick Setup, DataZone, Control Tower) is kept: deleting it deletes all the stack holds, identities among it, unlisted in the state; a custom resource runs its own code on removal",
};

export type ProposedDeletion = {
  address: string;
  type: string;
  identifier: string | null;
  ownership: "RUN_CREATED";
  /** What the independent observation said: VERIFIED (present under its identifier) or UNVERIFIABLE (a setting or object the independent reader cannot read alone). */
  observed: "VERIFIED" | "UNVERIFIABLE";
  /** A material risk of deleting this kind of resource, when the type is known to hold data or to have a deletion window. */
  risk?: string;
};
export type ExcludedResource = { address: string; type: string; identifier: string | null; ownership: Exclude<Ownership, "RUN_CREATED">; reason: string; retainedBy: RetentionOwner };
export type AbsentResource = { address: string; type: string; identifier: string | null };

export type CleanupProposal = {
  /** 2 since a cleanup has a requester; a schema 1 proposal (no requester) is refused everywhere. */
  schemaVersion: 2;
  kind: "CLEANUP_PROPOSAL";
  /** The proposal's own identity: the hash approvers sign, and what the cleanup driver and its evidence name. */
  proposalSha256: string;
  /** The run this proposal cleans up: the sealed plan's artifact, the apply evidence, the blueprint and the observation, each by hash. */
  artifactSha256: string;
  applyEvidenceSha256: string;
  blueprintSha256: string;
  observationSha256: string;
  provider: ProviderId;
  engine: EngineId;
  environment: ApplyEnvironment;
  target: ResolvedTarget;
  /** The channel the run was started in; the cleanup runs in the same one. */
  channel: PilotChannel;
  /** The contract the cleaned-up apply ran under (from its evidence): the run's identity, never re-judged against the current contract. */
  contractSha256: string;
  /**
   * AUTHORIZED, as proposed: the CURRENT committed contract that authorizes CLEANUP (its hash) and that entry's hash, so an
   * `authorize` edit after the apply (revoking APPLY, adding CLEANUP) does not strand the run's cleanup. Hashed, so approvals cover
   * them; the cleanup re-checks both at its gate and before approvals are consumed. The run's target stays bound to the apply.
   */
  authorizingContractSha256: string;
  authorizationSha256: string;
  /** The run's full target (from its apply evidence): the contract committed now must state exactly it (provider, account, tenant, region, backend, workspace). */
  targetSha256: string;
  sourceCommit: string;
  engineVersion: string;
  createdAt: string;
  /** The deletion unit the run stamped (from the blueprint record), swept by the leftover check; null when the engine sealed none. */
  unitId: string | null;
  /** Exactly what a cleanup may destroy, in address order. */
  deletes: ProposedDeletion[];
  /** Resources this run created that the observation already finds gone: nothing to destroy, listed so the person knows. */
  alreadyAbsent: AbsentResource[];
  /** Everything in the state that is not this run's to delete, with why and who keeps it. */
  excluded: ExcludedResource[];
  /** Material risks a person reads before approving: data loss, deletion windows, dependents the engine may add. */
  risks: string[];
  /** Who requested this cleanup, by allowlist id. Bound by the proposal's hash, so every approver signs it; in PROD no approval may come from this id or its key. */
  requesterId: string;
  /**
   * The requester's signature over the proposal's hash, environment and a nonce (CLEANUP_REQUEST domain). Beside the hashed
   * fields, since it signs the hash. Null only while the proposal is being built, before it is signed; never in a stored proposal.
   */
  request: SealedRequest | null;
  authorization: {
    /** Signatures are made under the cleanup domain; an apply approval never verifies here. */
    subject: "CLEANUP";
    requiredApprovals: number;
    /** The identity that executes the delete: the pilot's APPLY identity, bound to this list (owner decision, 2026-10-25). */
    executesAs: "APPLY";
  };
};

type Refusal = { ok: false; code: ApplyRefusalCode; message: string };
const refuse = (code: ApplyRefusalCode, message: string): Refusal => ({ ok: false, code, message });
/** `INVISIBLE` is global (for replace); tests use this stateless copy. */
const HAS_INVISIBLE = new RegExp(INVISIBLE.source);

/** What deleting a resource of this type can cost, said before approval. Types not listed carry no note, not a promise of safety. */
export const MATERIAL_RISKS: Readonly<Record<string, string>> = {
  aws_s3_bucket: "deletes stored objects and versions, which cannot be recovered",
  awscc_s3_bucket: "deletes stored objects and versions, which cannot be recovered",
  aws_dynamodb_table: "deletes the table, its stored items and any replicas in other Regions, which cannot be recovered",
  awscc_dynamodb_table: "deletes the table, its stored items and any replicas in other Regions, which cannot be recovered",
  aws_kms_key: "schedules the key for deletion (a waiting period of at least seven days); after it, anything encrypted under the key becomes unreadable, including data in resources outside the state and resources this cleanup keeps",
  awscc_kms_key: "schedules the key for deletion (a waiting period of at least seven days); after it, anything encrypted under the key becomes unreadable, including data in resources outside the state and resources this cleanup keeps",
  aws_cloudwatch_log_group: "deletes retained log events",
  awscc_logs_log_group: "deletes retained log events",
  aws_secretsmanager_secret: "schedules the secret for deletion; its value is unrecoverable after the recovery window",
  awscc_secretsmanager_secret: "schedules the secret for deletion; its value is unrecoverable after the recovery window",
  aws_efs_file_system: "deletes stored files, which cannot be recovered",
  awscc_efs_file_system: "deletes stored files, which cannot be recovered",
  aws_rds_cluster: "deletes the database and its data unless a final snapshot was configured",
  aws_rds_instance: "deletes the database and its data unless a final snapshot was configured",
  aws_db_instance: "deletes the database and its data unless a final snapshot was configured",
  awscc_rds_db_instance: "deletes the database and its data unless a final snapshot was configured",
  awscc_rds_db_cluster: "deletes the database and its data unless a final snapshot was configured",
  aws_ebs_volume: "deletes the volume and its data",
  awscc_ec2_volume: "deletes the volume and its data",
  azurerm_storage_account: "deletes stored blobs, tables, queues and files, which cannot be recovered",
  azurerm_storage_container: "deletes stored blobs, which cannot be recovered",
  azurerm_key_vault: "soft-deletes the vault; purge protection or the retention window decides when its secrets are gone for good",
  azurerm_log_analytics_workspace: "deletes retained log data (the workspace may stay recoverable for a limited time)",
  azurerm_mssql_database: "deletes the database and its data unless a backup was kept",
  azurerm_postgresql_flexible_server: "deletes the server and its databases unless a backup was kept",
  azurerm_kubernetes_cluster: "deletes the cluster and every workload running in it",
  // Run-created policies (owner decision "Unpin the ACT decision", item 2 (c); src/observe/run-created-policies.ts): every reviewed type carries one, a test enforces it.
  ...Object.fromEntries(AWS_RUN_CREATED_POLICY_TYPES.map((entry) => [entry.type, entry.role === "MANAGED_POLICY"
    ? "deletes the customer-managed policy and every version of it; a workload that still relied on the permissions it granted loses them at once"
    : entry.role === "INLINE_POLICY" ? "removes the permissions this inline policy grants its principal; a workload running as that principal loses them at once"
    : "detaches the policy from its principal; a workload running as that principal loses the permissions it granted at once"])),
  azurerm_policy_definition: "deletes the custom definition; Azure refuses while an assignment still uses it, and compliance results that named it are no longer reported",
  azurerm_policy_set_definition: "deletes the custom initiative; Azure refuses while an assignment still uses it, and compliance results that named it are no longer reported",
  ...Object.fromEntries(AZURE_RUN_CREATED_POLICY_TYPES.filter((entry) => entry.armType === "policyAssignments").map((entry) => [entry.type,
    "stops the policy at its scope at once: deny effects lift and audits stop; a system-assigned identity the assignment holds is deleted with it, and role assignments made for that identity are kept and left orphaned"])),
  // The same risks by CloudFormation type, for the CDK engine's logical ids.
  "AWS::S3::Bucket": "deletes stored objects, which cannot be recovered (CloudFormation refuses to delete a bucket that still holds objects)",
  "AWS::Logs::LogGroup": "deletes retained log data, which cannot be recovered",
  "AWS::KMS::Key": "schedules the key for deletion (a waiting period of at least seven days); after it, anything encrypted under the key becomes unreadable, including data in resources outside the state and resources this cleanup keeps",
  "AWS::DynamoDB::Table": "deletes the table, its data and any replicas in other Regions unless a backup was kept",
  "AWS::SecretsManager::Secret": "schedules the secret for deletion; its value is unrecoverable after the recovery window",
  "AWS::RDS::DBInstance": "deletes the database and its data unless a final snapshot was configured",
  "AWS::RDS::DBCluster": "deletes the database and its data unless a final snapshot was configured",
  "AWS::EFS::FileSystem": "deletes stored files, which cannot be recovered",
  "AWS::EC2::Volume": "deletes the volume and its data",
};

/**
 * Azure identity and authorization objects; a run that created one still never deletes it from here (fail closed: an identity,
 * a grant, a policy or a lock needs its own decision). By Terraform type: every `azuread_*` type, every `azurerm_role_*` and
 * `azurerm_pim_*` type (assignments, definitions, schedules, management policies), every policy assignment, exemption and
 * `azurerm_policy_*` type, `azurerm_management_lock`, the user-assigned identities and their federated credentials. By id,
 * whatever Terraform type recorded it (`azapi_resource`, a module's type): any id with a `/providers/` pair under
 * `Microsoft.Authorization` (the whole namespace: role assignments and definitions, PIM schedules, policy assignments,
 * definitions and exemptions, locks) or `Microsoft.ManagedIdentity`, at any scope. Every pair of the id is judged, not only the
 * first or the last, so an extension resource on a tracked resource and a tracked resource under an authorization scope are both caught.
 */
const AZURE_IDENTITY_TYPES = new Set(["azurerm_user_assigned_identity", "azurerm_federated_identity_credential", "azurerm_management_lock"]);
const AZURE_IDENTITY_TYPE = /^azurerm_(?:role_|pim_|policy_|[a-z_]+_policy_assignment$|[a-z_]+_policy_exemption$|key_vault_managed_hardware_security_module_role_(?:assignment|definition)$)/;
const AZURE_IDENTITY_NAMESPACE = /^Microsoft\.(?:Authorization|ManagedIdentity)$/i;
const isAzureIdentityType = (type: string): boolean => type.startsWith("azuread_") || AZURE_IDENTITY_TYPE.test(type) || AZURE_IDENTITY_TYPES.has(type);
const isAzureIdentityPair = (pair: ArmType): boolean => AZURE_IDENTITY_NAMESPACE.test(pair.namespace);
/**
 * Deployment history: every template-deployment type (the four scoped ones and the legacy `azurerm_template_deployment`), and,
 * whatever type recorded it, any id with a `/providers/` pair of `Microsoft.Resources/deployments` at any scope (a resource
 * group's, a resource's, a subscription's or a management group's deployment; an `azapi_resource` deployment).
 */
const isAzureDeploymentType = (type: string): boolean => /^azurerm_(?:[a-z_]+_)?template_deployment$/.test(type);
const isAzureDeploymentPair = (pair: ArmType): boolean => /^Microsoft\.Resources$/i.test(pair.namespace) && /^deployments(?:\/|$)/i.test(pair.typePath);
/**
 * A container: an entry whose recorded ARM id is a resource group, whatever Terraform type created it (`azurerm_resource_group`,
 * `azapi_resource`, a module's own type), or the azurerm type itself. Classified by the id the state holds, never by the type name alone.
 */
export const isContainerEntry = (entry: { type: string; id: string | null }): boolean => entry.type === "azurerm_resource_group" || (entry.id !== null && isArmGroupId(entry.id));
/** Scopes that hold other people's deployments: never proposed, whatever created them, because nothing here can list what deleting them would take. */
const AZURE_SCOPE_TYPES = new Set(["azurerm_subscription", "azurerm_subscription_alias", "azurerm_management_group", "azurerm_management_group_subscription_association"]);

/** A storage data-plane URL (`https://<account>.blob.core.windows.net/<container>`), which the azurerm provider uses as the id of containers and blobs. */
const STORAGE_DATA_PLANE = /^https:\/\/([a-z0-9]{3,24})\.(?:blob|dfs|file|queue|table|web)\.core\.windows\.net(?:\/|$)/;
/** A key vault or managed HSM data-plane URL (`https://<vault>.vault.azure.net/secrets/<name>/<version>`), the azurerm id of secrets, keys and certificates. */
const VAULT_DATA_PLANE = /^https:\/\/[a-z0-9-]{3,24}\.(?:vault\.azure\.net|managedhsm\.azure\.net)\/[^\s/]+(?:\/[^\s/]+)*$/i;
/** A managed HSM data-plane URL in any form. */
const MANAGED_HSM_HOST = /^https:\/\/[a-z0-9-]{3,24}\.managedhsm\.azure\.net\//i;
/**
 * The azurerm types whose recorded id is a data-plane URL, and the host family each records: the storage containers, blobs,
 * queues, tables and shares (and what lives in them) on `*.core.windows.net`; key vault keys, secrets and certificates on
 * `*.vault.azure.net`; managed HSM keys on `*.managedhsm.azure.net`. Only these types are judged by their type alone when
 * their id is such a URL (review 6411080437, B1): any other type with a non-ARM id, every `azapi_*` type among them, may
 * name an ARM object the parser never saw and fails closed. A data-plane path with a `providers` segment never qualifies.
 */
const DATA_PLANE_TYPES: Readonly<Record<string, "STORAGE" | "VAULT" | "MANAGED_HSM">> = {
  azurerm_storage_container: "STORAGE", azurerm_storage_blob: "STORAGE", azurerm_storage_queue: "STORAGE", azurerm_storage_table: "STORAGE", azurerm_storage_table_entity: "STORAGE",
  azurerm_storage_share: "STORAGE", azurerm_storage_share_directory: "STORAGE", azurerm_storage_share_file: "STORAGE", azurerm_storage_data_lake_gen2_filesystem: "STORAGE", azurerm_storage_data_lake_gen2_path: "STORAGE",
  azurerm_key_vault_key: "VAULT", azurerm_key_vault_secret: "VAULT", azurerm_key_vault_certificate: "VAULT", azurerm_key_vault_certificate_issuer: "VAULT",
  azurerm_key_vault_managed_hardware_security_module_key: "MANAGED_HSM", azurerm_key_vault_managed_hardware_security_module_key_rotation_policy: "MANAGED_HSM",
};
const hasProvidersSegment = (id: string): boolean => id.split(/[/?#]/).some((segment) => segment.toLowerCase() === "providers");
const isAzureDataPlaneId = (type: string, id: string): boolean => {
  const family = DATA_PLANE_TYPES[type];
  if (family === undefined || hasProvidersSegment(id)) return false;
  if (family === "STORAGE") return STORAGE_DATA_PLANE.test(id.toLowerCase());
  return VAULT_DATA_PLANE.test(id) && (family === "MANAGED_HSM") === MANAGED_HSM_HOST.test(id);
};
/**
 * A managed HSM role assignment or role definition by any id form the azurerm provider or an import has used
 * (`https://<hsm>.managedhsm.azure.net///RoleAssignment/<guid>`, `.../keys/RoleAssignment/<guid>`, and the authorization
 * path `.../providers/Microsoft.Authorization/roleAssignments/<guid>`; the same for RoleDefinition): an authorization object
 * under the owner's standing policy (#39), whatever Terraform type recorded it (review 6411080437, N1).
 */
const isManagedHsmAuthorizationId = (id: string): boolean => MANAGED_HSM_HOST.test(id) && /\/(?:RoleAssignments?|RoleDefinitions?)\/[^/\s]+\/?$|\/providers\/Microsoft\.Authorization\//i.test(id);
/** The backend storage accounts of every environment's `<storage-account>/<container>/<key>`. */
const azureBackendAccounts = (contract: PilotContract): Set<string> => new Set(Object.values(contract.targets).map((target) => (target as AzureTarget).backend.split("/")[0].toLowerCase()));
/** Whether an id names a backend account in any form: the account name, an ARM id under it, or a data-plane URL on it. */
function namesBackendAccount(id: string | null, accounts: Set<string>): boolean {
  if (id === null) return false;
  const lower = id.toLowerCase();
  const arm = /\/storageaccounts\/([a-z0-9]{3,24})(?:\/|$)/.exec(lower)?.[1];
  const dataPlane = STORAGE_DATA_PLANE.exec(lower)?.[1];
  return accounts.has(lower) || (arm !== undefined && accounts.has(arm)) || (dataPlane !== undefined && accounts.has(dataPlane));
}
/** The resource groups that hold a backend storage account, from the backend account ARM ids the state names: deleting such a group would delete the backend. */
function azureBackendGroups(entries: readonly { type: string; id: string | null }[], accounts: Set<string>): Set<string> {
  const groups = new Set<string>();
  for (const entry of entries) {
    if (!namesBackendAccount(entry.id, accounts)) continue;
    const group = /^(\/subscriptions\/[^/]+\/resourcegroups\/[^/]+)\//.exec((entry.id ?? "").toLowerCase())?.[1];
    if (group) groups.add(group);
  }
  return groups;
}

/**
 * What a cleanup never touches on Azure, in order of specificity: the backend storage account in any form, its containers and
 * settings and the group that holds it; deployment history; identities, grants and trusts; every other resource group; a
 * subscription or management group. A type the plan or state names as a resource group (`azurerm_resource_group`) is a group
 * even without an id, so a destroy plan's change list can be classified too.
 */
/**
 * An entry the cleanup cannot classify: an ARM-shaped id (it starts with `/`) that the positional parser does not consume in
 * full, so its type pairs are unknown. Never "not protected": the proposal refuses it and a destroy plan that touches it stops.
 */
export const UNCLASSIFIABLE = "UNCLASSIFIABLE";
export type AzureProtection = ExcludedResource["ownership"] | typeof UNCLASSIFIABLE;
function azureProtectionOf(entry: { type: string; id: string | null }, contract: PilotContract, backendGroups: Set<string>): AzureProtection | undefined {
  const accounts = azureBackendAccounts(contract);
  // The backend account in any form its identifier takes, whatever Terraform type recorded it (azurerm_storage_*, azapi_resource, a module's type).
  if (namesBackendAccount(entry.id, accounts)) return "PROTECTED_BACKEND";
  if (isContainerEntry(entry) && entry.id !== null && backendGroups.has(entry.id.toLowerCase())) return "PROTECTED_BACKEND";
  // By Terraform type first: a protected type is protected whatever its id says, and a dependent the state does not hold has only a type.
  if (isAzureDeploymentType(entry.type)) return "PROTECTED_DEPLOYMENT";
  if (isAzureIdentityType(entry.type)) return "PROTECTED_IDENTITY";
  if (entry.type === "azurerm_resource_group") return "RETAINED_GROUP";
  if (AZURE_SCOPE_TYPES.has(entry.type)) return "CONTAINS_OTHERS";
  // Then by id. A data-plane URL names no ARM type; it is judged by its type alone, above. An empty or blank id is no id at all,
  // and any other id that is not an ARM path is never ordinary (NB-A: a management-host URL, a leading space).
  if (entry.id === null) return undefined;
  if (entry.id.trim() === "") return UNCLASSIFIABLE;
  if (!entry.id.startsWith("/")) {
    if (isManagedHsmAuthorizationId(entry.id)) return "PROTECTED_IDENTITY";
    return isAzureDataPlaneId(entry.type, entry.id) ? undefined : UNCLASSIFIABLE;
  }
  // Fail closed: an ARM-shaped id the parser cannot consume in full has unknown pairs, so it is never ordinary. (The earlier
  // `armTypePairsOf(id) ?? []` read "unparseable" as "no pairs" and let an authorization object under a group named `providers` through.)
  const parsed = armPathSafe(entry.id) ? parseArmId(entry.id) : undefined;
  if (parsed === undefined) return UNCLASSIFIABLE;
  if (parsed.pairs.some(isAzureDeploymentPair)) return "PROTECTED_DEPLOYMENT";
  if (parsed.pairs.some(isAzureIdentityPair)) return "PROTECTED_IDENTITY";
  if (isArmGroupId(entry.id)) return "RETAINED_GROUP";
  // A subscription, a management group, a provider-level scope, a provider or feature registration: never proposed, kept by the pilot owner.
  if (isArmScopeId(entry.id) || isArmRegistrationId(parsed)) return "CONTAINS_OTHERS";
  return undefined;
}

/**
 * AWS identity and access objects (owner's standing policy, #39: identities and access are never deleted; reviews 6411551942 B2,
 * 6412182848 and 6412488764): anything in the IAM, IAM Identity Center (SSO) or Identity Store services, by an anchored prefix
 * and nothing else, so no hand-picked list can miss an attachment, a credential, a setting or a workforce identity. The full
 * identity family across the four namespaces (docs/observe-and-cleanup.md lists it): Terraform `aws_iam_` (roles, policies,
 * attachments of every kind, users, groups, instance profiles, identity providers, service-linked roles, access keys, login
 * profiles, SSH keys, signing certificates, MFA devices, the account password policy and alias), `aws_ssoadmin_` (Identity
 * Center assignments, permission sets and their policies) and `aws_identitystore_` (workforce users, groups, memberships); the
 * Cloud Control provider's `awscc_iam_`, `awscc_sso_` and `awscc_identitystore_`; and CloudFormation `AWS::IAM::`, `AWS::SSO::`
 * and `AWS::IdentityStore::` (case-exact, as CloudFormation names them). A `Custom::` resource has no namespace of its own; one
 * that carries an identity's ARN is refused below. All are PROTECTED_IDENTITY, kept by the pilot owner, never deleted directly
 * or as a dependent. Credentials are kept with the identity they belong to, in both engines.
 */
const AWS_IDENTITY_PREFIXES: readonly string[] = ["aws_iam_", "aws_ssoadmin_", "aws_identitystore_", "awscc_iam_", "awscc_sso_", "awscc_identitystore_", "AWS::IAM::", "AWS::SSO::", "AWS::IdentityStore::"];
export const isAwsIdentityType = (type: string): boolean => AWS_IDENTITY_PREFIXES.some((prefix) => type.startsWith(prefix));
/** An IAM ARN recorded under a type outside the identity service (a custom resource, a stack, `terraform_data`): unclassifiable, so refused. */
const IAM_ARN = /^arn:aws(?:-[a-z]+)*:iam::/;
/**
 * AWS stack containers (reviews 6412896598 B1 and 6432262110 B1, owner decision 6431744115): anything whose deletion tears
 * down a CloudFormation stack or a provisioned product, by the one family table in src/observe/aws-containers.ts (`isAwsContainerType`).
 * CONTAINS_OTHERS: never deleted, directly or as a dependent, whoever created it; the CDK engine refuses a nested stack at
 * the seal, and one that appears in the stack anyway is never proposed.
 */
export { isAwsContainerType } from "../observe/aws-containers.js";

/** Why a run-created resource of an unreviewed type is kept, naming its type; under the 512-character limit of a proposal's reason. */
export const unreviewedTypeReason = (type: string): string => "its type (" + stripInvisible(type).slice(0, 128) + ") is not on the reviewed leaf allowlist (src/observe/aws-leaf-types.ts), so the cleanup cannot tell what deleting it would take with it; it is left in place for the environment's owner to delete or keep by hand, and the type joins the allowlist only by review";

/** Why an attachment or setting whose parent this proposal does not delete is held; under the 512-character limit of a proposal's reason. */
export const parentKeptReason = (type: string): string => "it is an attachment or setting (" + stripInvisible(type).slice(0, 128) + ") that modifies another resource, and this proposal does not delete that resource with it; a planned create can overwrite what the resource already had, so deleting it would change a resource the cleanup keeps. It is left in place for the environment's owner to remove or keep by hand";

/**
 * The bootstrap the pilot runs on and the identities of the account, which a cleanup never touches: the state backend, every stack
 * container and everything in the identity service. Then the allowlist (delegated owner decision 6433391052, item 1): on AWS a type
 * is ordinary only when it is on the reviewed leaf allowlist; every other well-formed type is TYPE_UNREVIEWED, and a type field
 * that is not a well-formed type at all is unclassifiable. The deny rules come first and stay as defense in depth. GCP has its own
 * branch (src/apply/cleanup-gcp.ts), and any other provider fails closed: every entry is unclassifiable (review N5 of #310).
 */
function protectionOf(entry: { type: string; id: string | null; arn: string | null; holdsIdentityArn?: true }, contract: PilotContract, backendGroups: Set<string>): AzureProtection | undefined {
  // Read as text, so a provider id the types do not (yet) name is still judged here: never "ordinary" (review N5 of #310).
  const provider: string = contract.provider;
  if (provider === "AZURE") return azureProtectionOf(entry, contract, backendGroups);
  if (provider === "GCP") return gcpProtectionOf({ type: entry.type, id: entry.id, ...(entry.holdsIdentityArn ? { holdsIdentity: true as const } : {}) }, gcpBackendBuckets(contract));
  // Fail closed: a provider with no branch of its own here has no classifier, so nothing of it is ever proposed or deleted.
  if (provider !== "AWS") return UNCLASSIFIABLE;
  const buckets = new Set(Object.values(contract.targets).map((target) => (target as AwsTarget).backend.split("/")[0]));
  if (/^aws_s3_bucket(_|$)/.test(entry.type) && entry.id !== null && buckets.has(entry.id)) return "PROTECTED_BACKEND";
  // By type first, as on Azure: a container or an identity type is protected whatever its identifier says, and a dependent the state does not hold has only a type.
  if (awsContainerFamilyOf(entry.type) !== undefined) return "CONTAINS_OTHERS";
  if (isAwsIdentityType(entry.type)) return "PROTECTED_IDENTITY";
  // Fail closed: an identity's ARN under a type that is not an identity type (a custom resource, `terraform_data`) may be a pilot role in disguise, whether it
  // is the recorded identifier or sits in any attribute the state holds (`holdsIdentityArn`, judged in place by the blueprint, which also sets it when the
  // attributes nest past the depth it scans, so an entry it could not scan in full is never ordinary either).
  if ([entry.arn, entry.id].some((value) => value !== null && IAM_ARN.test(value)) || entry.holdsIdentityArn === true) return UNCLASSIFIABLE;
  // A custom resource runs code of its own on removal, and what that code holds no listing here accounts for: never proposed (the CDK engine refuses one at the seal too).
  if (entry.type.startsWith("Custom::") || entry.type === "AWS::CloudFormation::CustomResource") return "CONTAINS_OTHERS";
  if (!isWellFormedResourceType(entry.type)) return UNCLASSIFIABLE;
  // An allowlisted type whose entry admits only some objects (an Organizations policy: service control policies only) holds the rest.
  return isAwsLeafType(entry.type) && awsLeafConditionProblem(entry) === undefined ? undefined : "TYPE_UNREVIEWED";
}

/** Every environment's state bucket from the reviewed contract (a GCP target's backend is `<bucket>/<prefix>`): each is protected under every form (P4). */
const gcpBackendBuckets = (contract: PilotContract): string[] => Object.values(contract.targets).map((target) => (target as unknown as GcpTarget).backend.split("/")[0]);

/**
 * The pilot's own roles (DISCOVERY, STATE, STATE_WRITE, APPLY, CHANGESET), by lowercase name, from the identity variables in the
 * environment. A policy link to any of them is never carved out. Defense in depth: a pilot role is never one this run created, so
 * its policies are held by the principal rule below whether or not its variable is set where the cleanup is proposed.
 */
function pilotRoleNames(env: NodeJS.ProcessEnv): Set<string> {
  const names = new Set<string>();
  for (const identity of EXECUTION_IDENTITIES) {
    const arn = identityVariables(env, identity).get("AWS_ROLE_ARN");
    const name = arn === undefined ? undefined : /^arn:aws(?:-[a-z]+)*:iam::[0-9]{12}:role\/(?:[^/]+\/)*([^/]+)$/.exec(arn.trim())?.[1];
    if (name !== undefined) names.add(name.toLowerCase());
  }
  return names;
}

const NO_ROLES: ReadonlySet<string> = new Set();
type PolicyEntry = { type: string; id: string | null; arn: string | null; holdsIdentityArn?: true; policyLink?: PolicyLink };

/**
 * Whether an entry the identity rule kept is a reviewed run-created policy object the cleanup may consider at all (owner decision
 * "Unpin the ACT decision", item 2 (c); src/observe/run-created-policies.ts). It says nothing about who created it: the caller also
 * requires a planned CREATE, and on AWS the principal and attachment rules (`heldPolicyReason`) run after. `account` is the target's
 * account (the Azure subscription the contract owns for this environment).
 */
function policyCarveOut(entry: PolicyEntry, contract: PilotContract, account: string, pilotRoles: ReadonlySet<string>): boolean {
  if (contract.provider === "AZURE") return azurePolicyProblem(entry.type, entry.id, account) === undefined;
  if (contract.provider !== "AWS") return false;
  const reviewed = awsPolicyEntryOf(entry.type);
  const link = entry.policyLink;
  if (reviewed?.read === undefined || link === undefined || entry.holdsIdentityArn === true) return false;
  if (link.principals.some((p) => p.kind === "ROLE" && pilotRoles.has(p.name.toLowerCase()))) return false;
  // A managed policy is the account's own (never AWS-managed), and the ARN the state records for it is the one its link names.
  if (reviewed.role === "MANAGED_POLICY") return link.policyArn !== null && CUSTOMER_POLICY_ARN.test(link.policyArn) && (entry.arn === null || entry.arn === link.policyArn);
  return true;
}

type ProposalFields = Omit<CleanupProposal, "proposalSha256">;

/**
 * The proposal's identity: every field but itself and the requester's signature (which signs this hash), canonically. The
 * requester's id is hashed. The one definition; building and verifying both use it.
 */
export function computeProposalSha256(fields: ProposalFields): string {
  const { proposalSha256: _ignored, request: _signature, ...rest } = fields as CleanupProposal;
  return sha256(canonicalJson(rest as never));
}

/**
 * Signs a built proposal for its requester under the cleanup request domain. The caller has already checked that the id is on
 * the allowlist and the key is that entry's own (`requesterKeyRefusal`); the driver and `approve` verify the signature again.
 */
export function signCleanupProposal(proposal: CleanupProposal, privateKeyPem: string): CleanupProposal {
  const request = signRequest({
    schemaVersion: 1, requesterId: proposal.requesterId, artifactSha256: proposal.proposalSha256, environment: proposal.environment, nonce: randomBytes(16).toString("hex"),
  }, privateKeyPem, "CLEANUP_REQUEST");
  return { ...proposal, request };
}

export type ProposalInput = {
  applyEvidence: ApplyEvidence;
  applyEvidenceSha256: string;
  blueprint: BlueprintRecord;
  blueprintSha256: string;
  observation: ObservationRecord;
  observationSha256: string;
  /** The sealed plan's redacted change list, as the approvers saw it. */
  changes: readonly PlanChange[];
  channel: PilotChannel;
  contract: PilotContract;
  engineVersion: string;
  env: NodeJS.ProcessEnv;
  now: Date;
  /** Who requests this cleanup, by allowlist id: hashed into the proposal. The signature is added by `signCleanupProposal`. */
  requesterId: string;
};

/** Builds the proposal for one run, or says why none can be made. Nothing here reads a cloud or runs an engine. */
export function buildCleanupProposal(input: ProposalInput): { ok: true; proposal: CleanupProposal } | Refusal {
  const { applyEvidence: evidence, blueprint: record, observation, contract } = input;
  if (evidence.outcome !== "SUCCEEDED") {
    return refuse("OWNERSHIP_AMBIGUOUS", "The apply ended " + evidence.outcome + ", so what it created cannot be told from the state alone. A person reviews the state and the cloud resources by hand; no cleanup proposal is made.");
  }
  if (record.artifactSha256 !== evidence.artifactSha256 || record.applyEvidenceSha256 !== input.applyEvidenceSha256 || observation.artifactSha256 !== evidence.artifactSha256 ||
    observation.applyEvidenceSha256 !== input.applyEvidenceSha256 || observation.blueprintSha256 !== input.blueprintSha256 || record.outcome !== "SUCCEEDED") {
    return refuse("RUN_RECORD_MISSING", "The blueprint and the observation are not records of this apply. Observe this run again.");
  }
  if (Date.parse(observation.observedAt) < Date.parse(evidence.finishedAt)) return refuse("RUN_RECORD_MISSING", "The observation predates the apply. Observe this run again.");
  if (record.blueprint.missing.length > 0) {
    return refuse("OWNERSHIP_AMBIGUOUS", "The plan created resources the state never recorded (" + record.blueprint.missing.join(", ") + "). A person reviews them by hand; no cleanup proposal is made.");
  }
  if (observation.unexpected.length > 0) {
    return refuse("OBSERVATION_INCONCLUSIVE", "The observation found resources carrying this run's tag that the state does not name (" + observation.unexpected.length + "). The scope changed; a person reviews before any cleanup.");
  }
  const byAddress = new Map(input.changes.map((change) => [change.address, change]));
  const observed = new Map(observation.resources.map((resource) => [resource.address, resource]));
  const deletes: ProposedDeletion[] = [];
  const alreadyAbsent: AbsentResource[] = [];
  const excluded: ExcludedResource[] = [];
  const risks = new Set<string>();
  const backendGroups = contract.provider === "AZURE" ? azureBackendGroups(record.blueprint.entries, azureBackendAccounts(contract)) : new Set<string>();
  const pilotRoles = pilotRoleNames(input.env);
  // The canary allowlist's retained sentinels (owner decision E1), by type and count, for this run's environment.
  const retainable = new Map((contract.targets[evidence.environment]?.canary?.resources ?? []).filter((r) => r.retain === true).map((r) => [r.type, r.count]));
  const retainedSoFar = new Map<string, number>();
  for (const entry of record.blueprint.entries) {
    // The identifier the independent verifier uses for this type (the one it will be asked about again after the cleanup), else whatever the state had.
    const mapping = cloudControlMappingOf(entry.type);
    const identifier = contract.provider === "AZURE" ? entry.id : mapping ? (mapping.identifier === "arn" ? entry.arn : entry.id) ?? entry.arn ?? entry.id : entry.arn ?? entry.id;
    const base = { address: entry.address, type: entry.type, identifier };
    if (!isCleanupAddress(contract.engine, entry.address) || HAS_INVISIBLE.test(entry.address) || HAS_INVISIBLE.test(entry.type)) {
      return refuse("OWNERSHIP_AMBIGUOUS", "A resource address in the state is not one the cleanup can name exactly. A person reviews it by hand; no cleanup proposal is made.");
    }
    // An ARM-shaped id the URL parser would rewrite (a `..` segment, a backslash, a percent escape) names no resource exactly; the state that holds it is reviewed by hand.
    if (contract.provider === "AZURE" && identifier !== null && identifier.startsWith("/") && !armPathSafe(identifier)) {
      return refuse("OWNERSHIP_AMBIGUOUS", "The state holds an identifier for " + entry.address + " that cannot be read exactly as written. A person reviews it by hand; no cleanup proposal is made.");
    }
    const keep = (ownership: Exclude<Ownership, "RUN_CREATED">, reason: string): void => { excluded.push({ ...base, ownership, reason, retainedBy: retentionOwnerOf(ownership) }); };
    let protection = protectionOf(entry, contract, backendGroups);
    const change = byAddress.get(entry.address);
    // A reviewed run-created policy (item 2 (c)): carved out of the identity rule only when this run created it and every condition holds.
    if (protection === "PROTECTED_IDENTITY" && change?.action === "CREATE" && !change.importing && entry.origin === "IN_PLAN" && policyCarveOut(entry, contract, evidence.target.account, NO_ROLES)) protection = undefined;
    if (protection === UNCLASSIFIABLE) {
      return refuse("OWNERSHIP_AMBIGUOUS", "The state holds an identifier for " + entry.address + " that is not a resource id the cleanup can classify exactly (it does not parse as an ARM id, is a URL its type does not record, or is an identity's ARN under another type, so what it protects is unknown). A person reviews it by hand; no cleanup proposal is made.");
    }
    if (protection && protection !== "TYPE_UNREVIEWED") { keep(protection, PROTECTION_REASONS[protection as keyof typeof PROTECTION_REASONS]); continue; }
    if (entry.origin === "NOT_IN_PLAN" || change === undefined) { keep("NOT_IN_PLAN", "the state holds it but the sealed plan never mentioned it, so this run did not create it"); continue; }
    if (change.importing) { keep("IMPORTED", "the plan imported an existing resource; it was not created by this run"); continue; }
    if (change.action === "REPLACE" || change.action === "REPLACE_CONDITIONAL") { keep("REPLACED_PRE_EXISTING", "the plan replaced a resource that existed before this run"); continue; }
    if (change.action !== "CREATE") { keep("PRE_EXISTING", "the plan left or changed a resource that existed before this run (" + change.action + ")"); continue; }
    // Created by this run, and a sentinel the reviewed contract retains: kept as an intentional retention, within the declared count only.
    const retainCount = retainable.get(entry.type);
    if (retainCount !== undefined) {
      const n = (retainedSoFar.get(entry.type) ?? 0) + 1;
      retainedSoFar.set(entry.type, n);
      if (n > retainCount) {
        return refuse("OWNERSHIP_AMBIGUOUS", "The run created more " + entry.type + " than the contract's canary allowlist retains (" + retainCount + "). A person reviews them by hand; no cleanup proposal is made.");
      }
      keep("CANARY_RETAINED", PROTECTION_REASONS.CANARY_RETAINED);
      continue;
    }
    // Created by this run, but of a type nobody reviewed as a leaf: kept and named, never deleted; the rest of the run is still cleaned up.
    if (protection === "TYPE_UNREVIEWED") { keep("TYPE_UNREVIEWED", awsLeafConditionProblem(entry) ?? unreviewedTypeReason(entry.type)); continue; }
    const seen: ObservedResource | undefined = observed.get(entry.address);
    if (seen === undefined || seen.result === "NOT_YET_OBSERVABLE" || seen.result === "DIFFERENT_FROM_DESIRED") {
      return refuse("OBSERVATION_INCONCLUSIVE", "The observation could not decide about " + entry.address + " (" + (seen?.reason ?? "not observed") + "). Observe this run again before proposing a cleanup.");
    }
    // A type the reader cannot address (no Cloud Control mapping; an Azure id that is not an ARM resource id) is named, not refused; a denied or failed read is refused.
    // On Azure an entry with no id cannot be classified at all (a container, a scope, a backend?), so it is refused rather than proposed.
    const accepted = contract.provider === "AZURE" ? ["NOT_AN_ARM_RESOURCE_ID"] : ["NO_CLOUD_CONTROL_MAPPING", "DATA_BEARING_READ_EXCLUDED", "NO_IDENTIFIER_IN_STATE", "NOT_INDEPENDENTLY_CHECKABLE"];
    if (seen.result === "UNVERIFIABLE" && !accepted.includes(seen.reason ?? "")) {
      return refuse("OBSERVATION_INCONCLUSIVE", "The observation was refused for " + entry.address + " (" + seen.reason + "). Fix the DISCOVERY identity's access and observe again.");
    }
    if (seen.result === "MISSING") { alreadyAbsent.push(base); continue; }
    const risk = MATERIAL_RISKS[entry.type];
    // A run-created AWS policy's risk is named once the principal and attachment rules below have kept it on the list.
    if (risk && !(contract.provider === "AWS" && awsPolicyEntryOf(entry.type))) risks.add(entry.type + ": " + risk);
    deletes.push({ ...base, ownership: "RUN_CREATED", observed: seen.result === "VERIFIED" ? "VERIFIED" : "UNVERIFIABLE", ...(risk ? { risk } : {}) });
  }
  // The one parent rule (design review 6434540427, B3): an allowlisted attachment or setting (`parent` in src/observe/aws-leaf-types.ts) is deleted only
  // when the resource it modifies, read from its own identifier, is a run-created resource this proposal deletes (or one already gone). Otherwise it is
  // held as TYPE_UNREVIEWED with its own reason: a pre-existing bucket keeps its public access block, ownership controls and policy.
  if (contract.provider === "AWS") {
    const gone = new Set([...deletes, ...alreadyAbsent].map((x) => x.address));
    const entryOf = new Map(record.blueprint.entries.map((entry) => [entry.address, entry]));
    for (const item of [...deletes]) {
      const parent = awsLeafEntryOf(item.type)?.parent;
      if (parent === undefined) continue;
      const parentId = awsParentIdOf(parent.key, entryOf.get(item.address)?.id ?? null);
      if (parentId !== undefined && record.blueprint.entries.some((p) => parent.types.includes(p.type) && p.id === parentId && gone.has(p.address))) continue;
      deletes.splice(deletes.indexOf(item), 1);
      excluded.push({ address: item.address, type: item.type, identifier: item.identifier, ownership: "TYPE_UNREVIEWED", reason: parentKeptReason(item.type), retainedBy: retentionOwnerOf("TYPE_UNREVIEWED") });
    }
  }
  // The run-created policy rules (item 2 (c)), to a fixed point: an inline policy or an attachment goes only from principals this run
  // created; an attachment goes only with the run-created customer-managed policy it attaches; a managed policy goes only when nothing
  // this cleanup keeps still attaches it. What fails is kept by the identity rule, with its reason, so the result never depends on
  // which pilot role variables were set where the proposal was made.
  if (contract.provider === "AWS") {
    const entryOf = new Map(record.blueprint.entries.map((entry) => [entry.address, entry]));
    const createdPrincipals = new Set(record.blueprint.entries.filter((p) => {
      const planned = byAddress.get(p.address);
      return p.origin === "IN_PLAN" && planned?.action === "CREATE" && !planned.importing && p.id !== null;
    }).flatMap((p) => (Object.entries(AWS_PRINCIPAL_TYPES) as [string, readonly string[]][]).filter(([, types]) => types.includes(p.type)).map(([kind]) => kind + ":" + p.id!.toLowerCase())));
    for (let changed = true; changed;) {
      changed = false;
      const gone = new Set([...deletes, ...alreadyAbsent].map((x) => x.address));
      for (const item of [...deletes]) {
        const reviewed = awsPolicyEntryOf(item.type);
        const entry = entryOf.get(item.address);
        if (reviewed === undefined || entry === undefined) continue;
        const link = entry.policyLink!;
        // A pilot role is never one this run created; it is named here too, so a link to one is held whichever variables are set.
        const principalsOk = link.principals.every((p) => createdPrincipals.has(p.kind + ":" + p.name.toLowerCase()) && !(p.kind === "ROLE" && pilotRoles.has(p.name.toLowerCase())));
        const ok = reviewed.role === "INLINE_POLICY" ? principalsOk
          : reviewed.role === "ATTACHMENT" ? principalsOk && link.policyArn !== null && CUSTOMER_POLICY_ARN.test(link.policyArn) &&
            record.blueprint.entries.some((m) => awsPolicyEntryOf(m.type)?.role === "MANAGED_POLICY" && m.policyLink?.policyArn === link.policyArn && gone.has(m.address))
          : principalsOk && !record.blueprint.entries.some((other) => other.address !== entry.address && other.policyLink?.policyArn === link.policyArn && !gone.has(other.address));
        if (ok) continue;
        deletes.splice(deletes.indexOf(item), 1);
        excluded.push({ address: item.address, type: item.type, identifier: item.identifier, ownership: "PROTECTED_IDENTITY", reason: PROTECTION_REASONS.PROTECTED_IDENTITY, retainedBy: retentionOwnerOf("PROTECTED_IDENTITY") });
        changed = true;
      }
    }
    for (const item of deletes) if (awsPolicyEntryOf(item.type) && MATERIAL_RISKS[item.type]) risks.add(item.type + ": " + MATERIAL_RISKS[item.type]);
  }
  if (deletes.some((x) => x.observed === "UNVERIFIABLE" && !DATA_BEARING_TYPES.has(x.type))) risks.add("some listed resources are settings the independent reader cannot read alone; their deletion is proved through the resource they belong to");
  // A data-bearing type is not a setting: it is never read (DATA_BEARING_READ_EXCLUDED), so nothing in the product confirms its deletion.
  if (deletes.some((x) => x.observed === "UNVERIFIABLE" && DATA_BEARING_TYPES.has(x.type))) {
    risks.add("some listed resources (a Lambda function, an SSM parameter or a Secrets Manager secret) are never read by the independent reader, because their only read returns application data or secret contents: they are proposed as UNVERIFIABLE, they still need the contract's human approvals, and after the cleanup the leftover check reports them UNKNOWN, so it stays INCOMPLETE");
  }
  risks.add("the engine destroys a listed resource together with anything in the state that depends on it; a dependent outside this list stops the cleanup before anything is destroyed");
  if (contract.engine === "CDK") {
    risks.add("the CloudFormation stack itself is never deleted by a cleanup: approved resources are removed from it, the stack stays with whatever it still holds, and retiring the stack is a separate, reviewed action that remains outstanding");
  }
  if (excluded.some((x) => x.ownership === "TYPE_UNREVIEWED")) {
    risks.add("resources of a type not on the reviewed leaf allowlist, and attachments or settings on a resource this cleanup keeps, are held, named and never deleted; the leftover check stays INCOMPLETE until a person deletes or keeps them by hand");
  }
  if (excluded.some((x) => PROTECTED_OWNERSHIPS.includes(x.ownership))) {
    risks.add("protected objects (resource groups, identities and grants, deployment history, the state backend) are intentionally retained and never on this list; retiring the environment itself is a separate, reviewed action and stays outstanding after this cleanup");
  }
  const required = contract.requiredApprovals[evidence.environment];
  if (required === undefined) return refuse("TARGET_NOT_IN_CONTRACT", "The pilot contract does not enable " + evidence.environment + ".");
  // AUTHORIZED for CLEANUP by this contract, derived here (never taken from a caller), so a rebuild under a changed contract differs.
  const authorized = authorizeContract(contract, evidence.environment, "CLEANUP");
  if (!authorized.ok) return authorized;
  const moved = targetMoved(evidence.targetSha256, contract, evidence.environment);
  if (moved) return moved;
  const fields: ProposalFields = {
    schemaVersion: 2, kind: "CLEANUP_PROPOSAL", artifactSha256: evidence.artifactSha256, applyEvidenceSha256: input.applyEvidenceSha256, blueprintSha256: input.blueprintSha256,
    observationSha256: input.observationSha256, provider: contract.provider, engine: contract.engine, environment: evidence.environment, target: { ...evidence.target }, channel: input.channel,
    contractSha256: evidence.contractSha256, authorizingContractSha256: authorized.authorization.contractSha256, authorizationSha256: authorized.authorization.authorizationSha256, targetSha256: evidence.targetSha256,
    sourceCommit: evidence.sourceCommit, engineVersion: input.engineVersion, createdAt: input.now.toISOString(), unitId: record.unitId,
    deletes, alreadyAbsent, excluded, risks: [...risks].sort(), authorization: { subject: "CLEANUP", requiredApprovals: required, executesAs: "APPLY" },
    requesterId: input.requesterId, request: null,
  };
  return { ok: true, proposal: { ...fields, proposalSha256: computeProposalSha256(fields) } };
}

/** A CloudFormation logical id, the CDK engine's address. */
const LOGICAL_ID = /^[A-Za-z0-9]{1,255}$/;
/** The address shape a cleanup can name exactly, by engine: a Terraform resource address, or a CloudFormation logical id. */
export const isCleanupAddress = (engine: EngineId, value: unknown): value is string => engine === "CDK" ? typeof value === "string" && LOGICAL_ID.test(value) : isResourceAddress(value);

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown, max = 512): value is string => typeof value === "string" && value.length > 0 && value.length <= max && !HAS_INVISIBLE.test(value);
const hashText = (value: unknown): value is string => typeof value === "string" && HASH.test(value);
const idText = (value: unknown): boolean => value === null || text(value, 2048);
const OWNERSHIPS: readonly Ownership[] = ["RUN_CREATED", "PRE_EXISTING", "REPLACED_PRE_EXISTING", "IMPORTED", "NOT_IN_PLAN", "TYPE_UNREVIEWED", ...PROTECTED_OWNERSHIPS];
const KEYS = ["schemaVersion", "kind", "proposalSha256", "artifactSha256", "applyEvidenceSha256", "blueprintSha256", "observationSha256", "provider", "engine", "environment", "target", "unitId",
  "channel", "contractSha256", "authorizingContractSha256", "authorizationSha256", "targetSha256", "sourceCommit", "engineVersion", "createdAt", "deletes", "alreadyAbsent", "excluded", "risks", "authorization", "requesterId", "request"];

/** Every reason a value is not a well-formed cleanup proposal (shape only; the hash is checked by `verifyCleanupProposal`). */
export function proposalProblems(value: unknown): string[] {
  if (!isRecord(value)) return ["proposal: expected an object"];
  // A proposal made before a cleanup had a requester (schema 1) is refused everywhere, as a schema 1 sealed plan is (#286; owner decision 6440801434, item 1).
  if (value.schemaVersion === 1 && value.kind === "CLEANUP_PROPOSAL") return ["proposal: made before cleanup requesters existed (schema 1); propose the cleanup again with the requester's key"];
  const problems: string[] = [];
  for (const key of Object.keys(value)) if (!KEYS.includes(key)) problems.push("proposal." + key + ": not part of a proposal");
  for (const key of KEYS) if (!Object.hasOwn(value, key)) problems.push("proposal." + key + ": missing");
  if (problems.length > 0) return problems;
  if (value.schemaVersion !== 2 || value.kind !== "CLEANUP_PROPOSAL") problems.push("proposal: not a schemaVersion 2 CLEANUP_PROPOSAL");
  if (typeof value.requesterId !== "string" || !REQUESTER_ID.test(value.requesterId)) problems.push("proposal.requesterId: not an allowlist id");
  if (!wellFormedRequest(value.request)) problems.push("proposal.request: the requester's signature is missing or malformed");
  if (![value.proposalSha256, value.artifactSha256, value.applyEvidenceSha256, value.blueprintSha256, value.observationSha256, value.contractSha256, value.authorizingContractSha256, value.authorizationSha256, value.targetSha256].every(hashText)) problems.push("proposal: a hash is not a SHA-256 digest");
  if (!["AWS", "AZURE"].includes(value.provider as string) || !["TERRAFORM", "CDK"].includes(value.engine as string)) problems.push("proposal: provider or engine is unknown");
  if (!ENVIRONMENTS.includes(value.environment as ApplyEnvironment) || !PILOT_CHANNELS.includes(value.channel as PilotChannel)) problems.push("proposal: environment or channel is unknown");
  const target = value.target;
  if (!isRecord(target) || Object.keys(target).sort().join() !== "account,backend,workspace" || !["account", "backend", "workspace"].every((key) => text(target[key]))) problems.push("proposal.target: malformed");
  if (typeof value.sourceCommit !== "string" || !COMMIT.test(value.sourceCommit) || !text(value.engineVersion, 64) || !text(value.createdAt, 64) || Number.isNaN(Date.parse(value.createdAt as string))) {
    problems.push("proposal: sourceCommit, engineVersion or createdAt is malformed");
  }
  if (value.unitId !== null && !(typeof value.unitId === "string" && /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(value.unitId))) problems.push("proposal.unitId: not a tag-safe unit id or null");
  const deletes = value.deletes;
  // The address shape is the engine's: a Terraform resource address, or a CloudFormation logical id for the CDK engine (an unknown engine was refused above).
  const engine: EngineId = value.engine === "CDK" ? "CDK" : "TERRAFORM";
  if (!Array.isArray(deletes) || !deletes.every((x) => isRecord(x) && Object.keys(x).every((key) => ["address", "type", "identifier", "ownership", "observed", "risk"].includes(key)) &&
    isCleanupAddress(engine, x.address) && text(x.type, 128) && idText(x.identifier) && x.ownership === "RUN_CREATED" && (x.observed === "VERIFIED" || x.observed === "UNVERIFIABLE") &&
    (x.risk === undefined || text(x.risk)))) problems.push("proposal.deletes: each needs a resource address, type, identifier, RUN_CREATED ownership and an observation");
  else if (new Set(deletes.map((x) => x.address)).size !== deletes.length) problems.push("proposal.deletes: an address is listed twice");
  else if ([...deletes.map((x) => x.address)].some((address, index, all) => index > 0 && !(all[index - 1] < address))) problems.push("proposal.deletes: addresses must be in code-point order");
  if (!Array.isArray(value.alreadyAbsent) || !value.alreadyAbsent.every((x) => isRecord(x) && Object.keys(x).sort().join() === "address,identifier,type" && isCleanupAddress(engine, x.address) && text(x.type, 128) && idText(x.identifier))) {
    problems.push("proposal.alreadyAbsent: each needs address, type and identifier");
  }
  if (!Array.isArray(value.excluded) || !value.excluded.every((x) => isRecord(x) && Object.keys(x).sort().join() === "address,identifier,ownership,reason,retainedBy,type" && text(x.address, 256) && text(x.type, 128) &&
    idText(x.identifier) && OWNERSHIPS.includes(x.ownership as Ownership) && x.ownership !== "RUN_CREATED" && text(x.reason) && x.retainedBy === retentionOwnerOf(x.ownership as Exclude<Ownership, "RUN_CREATED">))) {
    problems.push("proposal.excluded: each needs address, type, identifier, an ownership other than RUN_CREATED, a reason and the retention owner that ownership implies");
  }
  if (!Array.isArray(value.risks) || !value.risks.every((x) => text(x, 1024))) problems.push("proposal.risks: a list of sentences");
  const authorization = value.authorization;
  if (!isRecord(authorization) || Object.keys(authorization).sort().join() !== "executesAs,requiredApprovals,subject" || authorization.subject !== "CLEANUP" || authorization.executesAs !== "APPLY" ||
    typeof authorization.requiredApprovals !== "number" || !Number.isInteger(authorization.requiredApprovals) || authorization.requiredApprovals < 1 || authorization.requiredApprovals > 10) {
    problems.push("proposal.authorization: must name the CLEANUP subject, the APPLY identity and the required approvals");
  }
  return problems;
}

/** Proves a proposal is well formed and hashes to its own identity. The one verification: the CLI, the console and the driver all end here. */
export function verifyCleanupProposal(value: unknown): { ok: true; proposal: CleanupProposal } | Refusal {
  const problems = proposalProblems(value);
  if (problems.length > 0) return refuse("PROPOSAL_INVALID", "The cleanup proposal is malformed: " + problems.slice(0, 4).join("; ") + ".");
  const proposal = value as CleanupProposal;
  if (computeProposalSha256(proposal) !== proposal.proposalSha256) {
    return refuse("PROPOSAL_INVALID", "The cleanup proposal does not match its own hash; it was altered after it was made. Propose the cleanup again.");
  }
  // The request names this proposal's own hash, environment and requester; anything else was moved or edited. Whether the signature verifies against the
  // allowlist needs the contract: the driver and `approve` check it (`verifyRequestSignature`, CLEANUP_REQUEST).
  const statement = (proposal.request as SealedRequest).statement;
  if (statement.artifactSha256 !== proposal.proposalSha256 || statement.environment !== proposal.environment || statement.requesterId !== proposal.requesterId) {
    return refuse("PROPOSAL_INVALID", "The cleanup proposal's requester signature names another proposal, environment or requester; it was moved or edited. Propose the cleanup again.");
  }
  return { ok: true, proposal };
}

/** The lines a person reads before approving or running a cleanup: what goes, what stays, and why. Identifiers only. */
export function proposalLines(proposal: CleanupProposal): string[] {
  const show = (value: string | null): string => value === null ? "(no cloud identifier in state)" : stripInvisible(value);
  return [
    "  proposal        " + proposal.proposalSha256,
    "  cleans up       apply artifact " + proposal.artifactSha256.slice(0, 12) + " in " + proposal.environment + " (" + proposal.provider + " " + proposal.engine + ")",
    "  requested by    " + stripInvisible(proposal.requesterId) + (REQUESTER_MAY_APPROVE[proposal.environment] === true ? "" : " (in " + proposal.environment + " the requester cannot approve this cleanup)"),
    "  executes as     the " + proposal.authorization.executesAs + " identity, bound to exactly the list below; " + proposal.authorization.requiredApprovals + " cleanup approval(s) required",
    "  deletes (" + proposal.deletes.length + ")",
    ...(proposal.deletes.length === 0 ? ["    (nothing: every resource this run created is already gone)"] : proposal.deletes.map((x) =>
      "    " + stripInvisible(x.address) + " (" + stripInvisible(x.type) + ") " + show(x.identifier) + (x.observed === "UNVERIFIABLE" ? " [not independently checkable]" : "") + (x.risk ? " [risk: " + x.risk + "]" : ""))),
    ...(proposal.alreadyAbsent.length > 0 ? ["  already gone (" + proposal.alreadyAbsent.length + ")", ...proposal.alreadyAbsent.map((x) => "    " + stripInvisible(x.address) + " " + show(x.identifier))] : []),
    "  kept (" + proposal.excluded.length + ")",
    ...(proposal.excluded.length === 0 ? ["    (nothing else is in the state)"] : proposal.excluded.map((x) => "    " + stripInvisible(x.address) + " (" + stripInvisible(x.type) + ") " + x.ownership + ", kept by " + x.retainedBy + ": " + x.reason)),
    "  risks", ...proposal.risks.map((risk) => "    - " + risk),
  ];
}

/**
 * The first planned change a pilot cleanup must never execute, or undefined: a delete (or any other action) of a resource
 * group, an identity or authorization object, deployment history, the state backend, a subscription or management group, or
 * (on AWS) a stack container or any type not on the reviewed leaf allowlist, whether the proposal named it or the engine added it as a dependent. Each planned address is classified by its blueprint
 * entry (type and recorded id) when the state holds one, else by its type alone, with the same rules the proposal applies.
 * The cleanup driver runs this on the engine's destroy plan before any approval is consumed.
 *
 * `approved` is the verified proposal's own deletion list and target account: a reviewed run-created policy the identity rule keeps
 * passes here only when the proposal lists it (the proposal was derived again from the run's records) and its blueprint entry still meets
 * the carve-out, with the pilot's own roles from `env` refused. Without it, every policy object stays protected, as before.
 */
export function protectedDeletionIn(planned: readonly PlanChange[], entries: readonly { address: string; type: string; id: string | null; arn: string | null; holdsIdentityArn?: true; policyLink?: PolicyLink }[], contract: PilotContract, env: NodeJS.ProcessEnv,
  approved?: { account: string; addresses: ReadonlySet<string> }): string | undefined {
  const byAddress = new Map(entries.map((entry) => [entry.address, entry]));
  const backendGroups = contract.provider === "AZURE" ? azureBackendGroups(entries, azureBackendAccounts(contract)) : new Set<string>();
  const pilotRoles = pilotRoleNames(env);
  for (const change of planned) {
    if (change.type === "output") continue;
    const known = byAddress.get(change.address);
    const entry = known ?? { address: change.address, type: change.type, id: null, arn: null };
    const protection = protectionOf(entry, contract, backendGroups);
    if (protection === undefined) continue;
    if (protection === "PROTECTED_IDENTITY" && approved !== undefined && known !== undefined && change.action === "DELETE" && approved.addresses.has(change.address) && policyCarveOut(known, contract, approved.account, pilotRoles)) continue;
    if (protection === UNCLASSIFIABLE) return "The destroy plan would " + change.action.toLowerCase() + " " + stripInvisible(change.address) + ", whose identifier does not parse as an ARM id (or is a URL its type does not record, or an identity's ARN under another type, or an attribute set the blueprint could not scan in full, or its type is not a well-formed resource type), so what it protects is unknown and a pilot cleanup never deletes it (OWNERSHIP_AMBIGUOUS).";
    const condition = protection === "TYPE_UNREVIEWED" ? awsLeafConditionProblem(entry) : undefined;
    if (condition !== undefined) return "The destroy plan would " + change.action.toLowerCase() + " " + stripInvisible(change.address) + " (" + stripInvisible(change.type) + "), which a pilot cleanup never deletes, directly or as a dependent: " + condition + " (TYPE_UNREVIEWED).";
    if (protection === "TYPE_UNREVIEWED") return "The destroy plan would " + change.action.toLowerCase() + " " + stripInvisible(change.address) + ", whose type (" + stripInvisible(change.type) + ") is not on the reviewed leaf allowlist, so what deleting it would take with it is unknown and a pilot cleanup never deletes it, directly or as a dependent (TYPE_UNREVIEWED).";
    const what = protection === "RETAINED_GROUP" ? "a resource group" : protection === "PROTECTED_IDENTITY" ? "an identity or authorization object" : protection === "PROTECTED_DEPLOYMENT" ? "deployment history"
      : protection === "PROTECTED_BACKEND" ? "the state backend" : contract.provider === "AWS" ? "a stack container (" + (awsContainerFamilyOf(entry.type)?.what ?? "a type that deploys a CloudFormation stack") + ") holding resources the state does not list"
      : "a subscription, management group, provider scope or registration";
    return "The destroy plan would " + change.action.toLowerCase() + " " + stripInvisible(change.address) + ", " + what + ", which a pilot cleanup never deletes, directly or as a dependent (" + protection + ").";
  }
  return undefined;
}
