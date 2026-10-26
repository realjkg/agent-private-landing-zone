import { CLOUD_CONTROL_TYPES } from "../observe/verify.js";
import { iamRoleIdentity, identityVariables } from "../tools/identity.js";
import { canonicalJson } from "../teardown/manifest.js";
import type { ResolvedTarget } from "../teardown/driver/types.js";
import { sha256 } from "../util/sha256.js";
import { COMMIT, ENVIRONMENTS, HASH, INVISIBLE, stripInvisible } from "./constants.js";
import type { BlueprintRecord, ObservationRecord, ObservedResource } from "./run-records.js";
import { PILOT_CHANNELS, type ApplyEnvironment, type ApplyEvidence, type ApplyRefusalCode, type EngineId, type PilotChannel, type PilotContract, type PlanChange, type ProviderId } from "./types.js";
import { isResourceAddress } from "./terraform.js";
import type { AwsTarget } from "./providers/aws.js";
import type { AzureTarget } from "./providers/azure.js";
import { isContainerEntry } from "./observe.js";
import { armPathSafe, isArmScopeId } from "../observe/azure-rest.js";

/**
 * The cleanup proposal (docs/act-pilot-plan.md, "Cleanup of pilot-created resources"): the reviewable, hash-identified list
 * of exactly the resources one successful apply created, which a separately authorized cleanup may destroy. It is built from
 * three records of the same run, each bound by hash: the apply's own evidence, the blueprint the engine's state gave right
 * after the apply (addresses and cloud identifiers), and a fresh independent observation of those identifiers. Ownership
 * comes from the sealed plan and the engine's state, never from tags: a resource is proposed only when the plan created
 * it, the state still holds it, and the cloud was asked about it. Anything pre-existing, imported, replaced, outside the
 * plan, or protected (the state backend, the pilot's own identities) is excluded and listed as such.
 *
 * The proposal fails closed: no proposal is made from an apply that did not succeed, from a planned resource the state
 * never mapped, from an observation that could not decide, or from an observation that found something unexpected.
 * Approvers sign the proposal's hash under the cleanup domain (src/apply/approval.ts); the cleanup driver destroys the
 * proposal's addresses and nothing else, and refuses when the engine's destroy plan differs from them.
 */
export type Ownership = "RUN_CREATED" | "PRE_EXISTING" | "REPLACED_PRE_EXISTING" | "IMPORTED" | "NOT_IN_PLAN" | "PROTECTED_BACKEND" | "PROTECTED_IDENTITY" | "CONTAINS_OTHERS";

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
export type ExcludedResource = { address: string; type: string; identifier: string | null; ownership: Exclude<Ownership, "RUN_CREATED">; reason: string };
export type AbsentResource = { address: string; type: string; identifier: string | null };

export type CleanupProposal = {
  schemaVersion: 1;
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
  contractSha256: string;
  sourceCommit: string;
  engineVersion: string;
  createdAt: string;
  /** The deletion unit the run stamped (from the blueprint record), swept by the leftover check; null when the engine sealed none. */
  unitId: string | null;
  /** Exactly what a cleanup may destroy, in address order. */
  deletes: ProposedDeletion[];
  /** Resources this run created that the observation already finds gone: nothing to destroy, listed so the person knows. */
  alreadyAbsent: AbsentResource[];
  /** Everything in the state that is not this run's to delete, with why. */
  excluded: ExcludedResource[];
  /** Material risks a person reads before approving: data loss, deletion windows, dependents the engine may add. */
  risks: string[];
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
const MATERIAL_RISKS: Readonly<Record<string, string>> = {
  aws_s3_bucket: "deletes stored objects and versions, which cannot be recovered",
  aws_dynamodb_table: "deletes stored items, which cannot be recovered",
  aws_kms_key: "schedules the key for deletion (a waiting period of at least seven days) and makes anything it encrypted unreadable afterward",
  aws_cloudwatch_log_group: "deletes retained log events",
  aws_secretsmanager_secret: "schedules the secret for deletion; its value is unrecoverable after the recovery window",
  aws_efs_file_system: "deletes stored files, which cannot be recovered",
  aws_rds_cluster: "deletes the database and its data unless a final snapshot was configured",
  aws_rds_instance: "deletes the database and its data unless a final snapshot was configured",
  aws_db_instance: "deletes the database and its data unless a final snapshot was configured",
  aws_ebs_volume: "deletes the volume and its data",
  azurerm_resource_group: "deletes every resource in the group, including any the state never recorded",
  azurerm_storage_account: "deletes stored blobs, tables, queues and files, which cannot be recovered",
  azurerm_storage_container: "deletes stored blobs, which cannot be recovered",
  azurerm_key_vault: "soft-deletes the vault; purge protection or the retention window decides when its secrets are gone for good",
  azurerm_log_analytics_workspace: "deletes retained log data (the workspace may stay recoverable for a limited time)",
  azurerm_mssql_database: "deletes the database and its data unless a backup was kept",
  azurerm_postgresql_flexible_server: "deletes the server and its databases unless a backup was kept",
  azurerm_kubernetes_cluster: "deletes the cluster and every workload running in it",
};

/**
 * Azure identity objects and grants the pilot runs on; a run that created one still never deletes it from here (fail closed:
 * an identity, or a role grant whose principal the state does not name, needs its own decision). Every `azuread_*` type counts.
 */
const AZURE_IDENTITY_TYPES = new Set(["azurerm_user_assigned_identity", "azurerm_federated_identity_credential", "azurerm_role_assignment", "azurerm_role_definition"]);
const isAzureIdentityType = (type: string): boolean => type.startsWith("azuread_") || AZURE_IDENTITY_TYPES.has(type);
/** Scopes that hold other people's deployments: never proposed, whatever created them, because nothing here can list what deleting them would take. */
const AZURE_SCOPE_TYPES = new Set(["azurerm_subscription", "azurerm_subscription_alias", "azurerm_management_group", "azurerm_management_group_subscription_association"]);
const isAzureScope = (entry: { type: string; id: string | null }): boolean => AZURE_SCOPE_TYPES.has(entry.type) || (entry.id !== null && isArmScopeId(entry.id));

/** A storage data-plane URL (`https://<account>.blob.core.windows.net/<container>`), which the azurerm provider uses as the id of containers and blobs. */
const STORAGE_DATA_PLANE = /^https:\/\/([a-z0-9]{3,24})\.(?:blob|dfs|file|queue|table|web)\.core\.windows\.net(?:\/|$)/;
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
    if (!/^azurerm_storage_/.test(entry.type) || !namesBackendAccount(entry.id, accounts)) continue;
    const group = /^(\/subscriptions\/[^/]+\/resourcegroups\/[^/]+)\//.exec((entry.id ?? "").toLowerCase())?.[1];
    if (group) groups.add(group);
  }
  return groups;
}

/** The Azure bootstrap a cleanup never touches: the backend storage account in any form, its containers and settings, the group that holds it, and the pilot's identities and grants. */
function azureProtectionOf(entry: { type: string; id: string | null }, contract: PilotContract, backendGroups: Set<string>): ExcludedResource["ownership"] | undefined {
  const accounts = azureBackendAccounts(contract);
  if (/^azurerm_storage_/.test(entry.type) && namesBackendAccount(entry.id, accounts)) return "PROTECTED_BACKEND";
  if (isContainerEntry(entry) && entry.id !== null && backendGroups.has(entry.id.toLowerCase())) return "PROTECTED_BACKEND";
  if (isAzureIdentityType(entry.type)) return "PROTECTED_IDENTITY";
  if (isAzureScope(entry)) return "CONTAINS_OTHERS";
  return undefined;
}

const IDENTITY_TYPES = new Set(["aws_iam_openid_connect_provider", "aws_iam_role", "aws_iam_role_policy", "aws_iam_role_policy_attachment", "aws_iam_policy"]);

/** The bootstrap the pilot runs on, which a cleanup never touches: the state backend and the identities that run it. */
function protectionOf(entry: { type: string; id: string | null; arn: string | null }, contract: PilotContract, env: NodeJS.ProcessEnv, backendGroups: Set<string>): ExcludedResource["ownership"] | undefined {
  if (contract.provider === "AZURE") return azureProtectionOf(entry, contract, backendGroups);
  if (contract.provider !== "AWS") return undefined;
  const pinned = contract.targets[contract.enabledEnvironments?.[0] ?? "DEV"] as AwsTarget | undefined;
  const buckets = new Set(Object.values(contract.targets).map((target) => (target as AwsTarget).backend.split("/")[0]));
  if (/^aws_s3_bucket(_|$)/.test(entry.type) && entry.id !== null && buckets.has(entry.id)) return "PROTECTED_BACKEND";
  if (pinned === undefined) return undefined;
  if (entry.type === "aws_iam_openid_connect_provider") return "PROTECTED_IDENTITY";
  const roles = new Set((["DISCOVERY", "STATE", "STATE_WRITE", "APPLY"] as const).map((identity) => iamRoleIdentity(identityVariables(env, identity).get("AWS_ROLE_ARN") ?? "")).filter((x): x is string => x !== undefined));
  if (IDENTITY_TYPES.has(entry.type) && entry.arn !== null && roles.has(iamRoleIdentity(entry.arn) ?? "")) return "PROTECTED_IDENTITY";
  if (entry.type === "aws_iam_role_policy" && entry.id !== null && [...roles].some((role) => entry.id!.toLowerCase().startsWith(role.split("/").pop() ?? "\u0000"))) return "PROTECTED_IDENTITY";
  return undefined;
}

type ProposalFields = Omit<CleanupProposal, "proposalSha256">;

/** The proposal's identity: every field but itself, canonically. The one definition; building and verifying both use it. */
export function computeProposalSha256(fields: ProposalFields): string {
  const { proposalSha256: _ignored, ...rest } = fields as CleanupProposal;
  return sha256(canonicalJson(rest as never));
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
  for (const entry of record.blueprint.entries) {
    // The identifier the independent verifier uses for this type (the one it will be asked about again after the cleanup), else whatever the state had.
    const mapping = CLOUD_CONTROL_TYPES[entry.type];
    const identifier = contract.provider === "AZURE" ? entry.id : mapping ? (mapping.identifier === "arn" ? entry.arn : entry.id) ?? entry.arn ?? entry.id : entry.arn ?? entry.id;
    const base = { address: entry.address, type: entry.type, identifier };
    if (!isResourceAddress(entry.address) || HAS_INVISIBLE.test(entry.address) || HAS_INVISIBLE.test(entry.type)) {
      return refuse("OWNERSHIP_AMBIGUOUS", "A resource address in the state is not one the cleanup can name exactly. A person reviews it by hand; no cleanup proposal is made.");
    }
    // An ARM-shaped id the URL parser would rewrite (a `..` segment, a backslash, a percent escape) names no resource exactly; the state that holds it is reviewed by hand.
    if (contract.provider === "AZURE" && identifier !== null && identifier.startsWith("/") && !armPathSafe(identifier)) {
      return refuse("OWNERSHIP_AMBIGUOUS", "The state holds an identifier for " + entry.address + " that cannot be read exactly as written. A person reviews it by hand; no cleanup proposal is made.");
    }
    const protection = protectionOf(entry, contract, input.env, backendGroups);
    if (protection) {
      excluded.push({ ...base, ownership: protection, reason: protection === "PROTECTED_BACKEND" ? "the state backend the pilot itself runs on is never deleted by a cleanup"
        : protection === "CONTAINS_OTHERS" ? "a subscription or management group holds deployments no listing here accounts for; it is never deleted by a cleanup"
        : "a pilot identity or trust is never deleted by a cleanup" });
      continue;
    }
    const change = byAddress.get(entry.address);
    if (entry.origin === "NOT_IN_PLAN" || change === undefined) { excluded.push({ ...base, ownership: "NOT_IN_PLAN", reason: "the state holds it but the sealed plan never mentioned it, so this run did not create it" }); continue; }
    if (change.importing) { excluded.push({ ...base, ownership: "IMPORTED", reason: "the plan imported an existing resource; it was not created by this run" }); continue; }
    if (change.action === "REPLACE" || change.action === "REPLACE_CONDITIONAL") { excluded.push({ ...base, ownership: "REPLACED_PRE_EXISTING", reason: "the plan replaced a resource that existed before this run" }); continue; }
    if (change.action !== "CREATE") { excluded.push({ ...base, ownership: "PRE_EXISTING", reason: "the plan left or changed a resource that existed before this run (" + change.action + ")" }); continue; }
    const seen: ObservedResource | undefined = observed.get(entry.address);
    if (seen === undefined || seen.result === "NOT_YET_OBSERVABLE" || seen.result === "DIFFERENT_FROM_DESIRED") {
      return refuse("OBSERVATION_INCONCLUSIVE", "The observation could not decide about " + entry.address + " (" + (seen?.reason ?? "not observed") + "). Observe this run again before proposing a cleanup.");
    }
    // A type the reader cannot address (no Cloud Control mapping; an Azure id that is not an ARM resource id) is named, not refused; a denied or failed read is refused.
    if (seen.result === "UNVERIFIABLE" && !["NO_CLOUD_CONTROL_MAPPING", "NO_IDENTIFIER_IN_STATE", "NOT_INDEPENDENTLY_CHECKABLE", "NOT_AN_ARM_RESOURCE_ID"].includes(seen.reason ?? "")) {
      return refuse("OBSERVATION_INCONCLUSIVE", "The observation was refused for " + entry.address + " (" + seen.reason + "). Fix the DISCOVERY identity's access and observe again.");
    }
    if (seen.result === "MISSING") { alreadyAbsent.push(base); continue; }
    const risk = MATERIAL_RISKS[entry.type];
    if (risk) risks.add(entry.type + ": " + risk);
    deletes.push({ ...base, ownership: "RUN_CREATED", observed: seen.result === "VERIFIED" ? "VERIFIED" : "UNVERIFIABLE", ...(risk ? { risk } : {}) });
  }
  // A container (an Azure resource group) is never deleted on run ownership alone: the observation listed its members, and
  // every one must be a resource of this run that goes with it. Anything else inside, or an incomplete listing, keeps it.
  const deletedIdentifiers = new Set(deletes.map((d) => d.identifier?.toLowerCase()).filter((x): x is string => x !== undefined));
  for (const group of deletes.filter((d) => isContainerEntry({ type: d.type, id: d.identifier }))) {
    const listed = observation.groups.find((g) => g.address === group.address && g.identifier.toLowerCase() === (group.identifier ?? "").toLowerCase());
    const others = listed ? listed.members.filter((m) => m.toLowerCase() !== (group.identifier ?? "").toLowerCase() && !deletedIdentifiers.has(m.toLowerCase())) : [];
    const reason = !listed || !listed.complete ? "its contents could not be listed completely, so what deleting it would take along is unknown"
      : others.length > 0 ? "it holds " + others.length + " resource(s) this run did not create or does not delete with it; a group is never deleted on run ownership alone" : undefined;
    if (reason === undefined) continue;
    deletes.splice(deletes.indexOf(group), 1);
    excluded.push({ address: group.address, type: group.type, identifier: group.identifier, ownership: "CONTAINS_OTHERS", reason });
  }
  if (deletes.some((x) => x.observed === "UNVERIFIABLE")) risks.add("some listed resources are settings the independent reader cannot read alone; their deletion is proved through the resource they belong to");
  risks.add("the engine destroys a listed resource together with anything in the state that depends on it; a dependent outside this list stops the cleanup before anything is destroyed");
  const required = contract.requiredApprovals[evidence.environment];
  if (required === undefined) return refuse("TARGET_NOT_IN_CONTRACT", "The pilot contract does not enable " + evidence.environment + ".");
  const fields: ProposalFields = {
    schemaVersion: 1, kind: "CLEANUP_PROPOSAL", artifactSha256: evidence.artifactSha256, applyEvidenceSha256: input.applyEvidenceSha256, blueprintSha256: input.blueprintSha256,
    observationSha256: input.observationSha256, provider: contract.provider, engine: contract.engine, environment: evidence.environment, target: { ...evidence.target }, channel: input.channel,
    contractSha256: evidence.contractSha256, sourceCommit: evidence.sourceCommit, engineVersion: input.engineVersion, createdAt: input.now.toISOString(), unitId: record.unitId,
    deletes, alreadyAbsent, excluded, risks: [...risks].sort(), authorization: { subject: "CLEANUP", requiredApprovals: required, executesAs: "APPLY" },
  };
  return { ok: true, proposal: { ...fields, proposalSha256: computeProposalSha256(fields) } };
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown, max = 512): value is string => typeof value === "string" && value.length > 0 && value.length <= max && !HAS_INVISIBLE.test(value);
const hashText = (value: unknown): value is string => typeof value === "string" && HASH.test(value);
const idText = (value: unknown): boolean => value === null || text(value, 2048);
const OWNERSHIPS: readonly Ownership[] = ["RUN_CREATED", "PRE_EXISTING", "REPLACED_PRE_EXISTING", "IMPORTED", "NOT_IN_PLAN", "PROTECTED_BACKEND", "PROTECTED_IDENTITY", "CONTAINS_OTHERS"];
const KEYS = ["schemaVersion", "kind", "proposalSha256", "artifactSha256", "applyEvidenceSha256", "blueprintSha256", "observationSha256", "provider", "engine", "environment", "target", "unitId",
  "channel", "contractSha256", "sourceCommit", "engineVersion", "createdAt", "deletes", "alreadyAbsent", "excluded", "risks", "authorization"];

/** Every reason a value is not a well-formed cleanup proposal (shape only; the hash is checked by `verifyCleanupProposal`). */
export function proposalProblems(value: unknown): string[] {
  if (!isRecord(value)) return ["proposal: expected an object"];
  const problems: string[] = [];
  for (const key of Object.keys(value)) if (!KEYS.includes(key)) problems.push("proposal." + key + ": not part of a proposal");
  for (const key of KEYS) if (!Object.hasOwn(value, key)) problems.push("proposal." + key + ": missing");
  if (problems.length > 0) return problems;
  if (value.schemaVersion !== 1 || value.kind !== "CLEANUP_PROPOSAL") problems.push("proposal: not a schemaVersion 1 CLEANUP_PROPOSAL");
  if (![value.proposalSha256, value.artifactSha256, value.applyEvidenceSha256, value.blueprintSha256, value.observationSha256, value.contractSha256].every(hashText)) problems.push("proposal: a hash is not a SHA-256 digest");
  if (!["AWS", "AZURE"].includes(value.provider as string) || !["TERRAFORM", "CDK"].includes(value.engine as string)) problems.push("proposal: provider or engine is unknown");
  if (!ENVIRONMENTS.includes(value.environment as ApplyEnvironment) || !PILOT_CHANNELS.includes(value.channel as PilotChannel)) problems.push("proposal: environment or channel is unknown");
  const target = value.target;
  if (!isRecord(target) || Object.keys(target).sort().join() !== "account,backend,workspace" || !["account", "backend", "workspace"].every((key) => text(target[key]))) problems.push("proposal.target: malformed");
  if (typeof value.sourceCommit !== "string" || !COMMIT.test(value.sourceCommit) || !text(value.engineVersion, 64) || !text(value.createdAt, 64) || Number.isNaN(Date.parse(value.createdAt as string))) {
    problems.push("proposal: sourceCommit, engineVersion or createdAt is malformed");
  }
  if (value.unitId !== null && !(typeof value.unitId === "string" && /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(value.unitId))) problems.push("proposal.unitId: not a tag-safe unit id or null");
  const deletes = value.deletes;
  if (!Array.isArray(deletes) || !deletes.every((x) => isRecord(x) && Object.keys(x).every((key) => ["address", "type", "identifier", "ownership", "observed", "risk"].includes(key)) &&
    isResourceAddress(x.address) && text(x.type, 128) && idText(x.identifier) && x.ownership === "RUN_CREATED" && (x.observed === "VERIFIED" || x.observed === "UNVERIFIABLE") &&
    (x.risk === undefined || text(x.risk)))) problems.push("proposal.deletes: each needs a resource address, type, identifier, RUN_CREATED ownership and an observation");
  else if (new Set(deletes.map((x) => x.address)).size !== deletes.length) problems.push("proposal.deletes: an address is listed twice");
  else if ([...deletes.map((x) => x.address)].some((address, index, all) => index > 0 && !(all[index - 1] < address))) problems.push("proposal.deletes: addresses must be in code-point order");
  if (!Array.isArray(value.alreadyAbsent) || !value.alreadyAbsent.every((x) => isRecord(x) && Object.keys(x).sort().join() === "address,identifier,type" && isResourceAddress(x.address) && text(x.type, 128) && idText(x.identifier))) {
    problems.push("proposal.alreadyAbsent: each needs address, type and identifier");
  }
  if (!Array.isArray(value.excluded) || !value.excluded.every((x) => isRecord(x) && Object.keys(x).sort().join() === "address,identifier,ownership,reason,type" && text(x.address, 256) && text(x.type, 128) &&
    idText(x.identifier) && OWNERSHIPS.includes(x.ownership as Ownership) && x.ownership !== "RUN_CREATED" && text(x.reason))) problems.push("proposal.excluded: each needs address, type, identifier, an ownership other than RUN_CREATED and a reason");
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
  return { ok: true, proposal };
}

/** The lines a person reads before approving or running a cleanup: what goes, what stays, and why. Identifiers only. */
export function proposalLines(proposal: CleanupProposal): string[] {
  const show = (value: string | null): string => value === null ? "(no cloud identifier in state)" : stripInvisible(value);
  return [
    "  proposal        " + proposal.proposalSha256,
    "  cleans up       apply artifact " + proposal.artifactSha256.slice(0, 12) + " in " + proposal.environment + " (" + proposal.provider + " " + proposal.engine + ")",
    "  executes as     the " + proposal.authorization.executesAs + " identity, bound to exactly the list below; " + proposal.authorization.requiredApprovals + " cleanup approval(s) required",
    "  deletes (" + proposal.deletes.length + ")",
    ...(proposal.deletes.length === 0 ? ["    (nothing: every resource this run created is already gone)"] : proposal.deletes.map((x) =>
      "    " + stripInvisible(x.address) + " (" + stripInvisible(x.type) + ") " + show(x.identifier) + (x.observed === "UNVERIFIABLE" ? " [not independently checkable]" : "") + (x.risk ? " [risk: " + x.risk + "]" : ""))),
    ...(proposal.alreadyAbsent.length > 0 ? ["  already gone (" + proposal.alreadyAbsent.length + ")", ...proposal.alreadyAbsent.map((x) => "    " + stripInvisible(x.address) + " " + show(x.identifier))] : []),
    "  kept (" + proposal.excluded.length + ")",
    ...(proposal.excluded.length === 0 ? ["    (nothing else is in the state)"] : proposal.excluded.map((x) => "    " + stripInvisible(x.address) + " (" + stripInvisible(x.type) + ") " + x.ownership + ": " + x.reason)),
    "  risks", ...proposal.risks.map((risk) => "    - " + risk),
  ];
}
