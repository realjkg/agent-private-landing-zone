import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { encryptEvidence, ensureEvidenceKey, readEncryptedEvidence } from "../evidence/vault.js";
import type { Blueprint, BlueprintEntry } from "../observe/blueprint.js";
import type { ObserveReport } from "../observe/verify.js";
import { VERIFIERS, type VerifierId } from "../observe/verify.js";
import { canonicalJson } from "../teardown/manifest.js";
import type { ResolvedTarget } from "../teardown/driver/types.js";
import { sha256 } from "../util/sha256.js";
import { COMMIT, HASH } from "./constants.js";
import type { ApplyEnvironment, ApplyOutcome } from "./types.js";

/**
 * The records one run leaves beside its apply evidence, in the same encrypted ledger directory (docs/observe-and-cleanup.md):
 *
 * - `<artifact>.blueprint.evidence`: what the engine's state said the run left, as addresses and cloud identifiers only,
 *   read by the driver right after the engine ended. Written once; the state itself is dropped.
 * - `<artifact>.observation.evidence`: the latest independent read of those identifiers (Cloud Control, DISCOVERY).
 *   Replaced by each observation, because an observation is a fresh look, never a ledger. A record written with the
 *   group-contents field of an earlier version (`groups`) is refused on read-back: observe the run again.
 * - `<proposal>.leftovers.evidence`: the latest independent read after a cleanup, per proposed resource. Replaced the same way.
 *
 * Every record names the artifact (or proposal) it belongs to, and the hash of the apply evidence it was made for, so a
 * record for one run is never read as another's. Nothing here carries a state value, a cloud property or engine output.
 */
export const BLUEPRINT_SUFFIX = ".blueprint.evidence";
export type BlueprintSource = BlueprintRecord["source"];
export const OBSERVATION_SUFFIX = ".observation.evidence";
export const LEFTOVERS_SUFFIX = ".leftovers.evidence";

export type BlueprintRecord = {
  schemaVersion: 1;
  kind: "BLUEPRINT";
  artifactSha256: string;
  /** The canonical sha256 of the apply evidence this blueprint was read for, so a blueprint never stands for another run. */
  applyEvidenceSha256: string;
  environment: ApplyEnvironment;
  target: ResolvedTarget;
  sourceCommit: string;
  contractSha256: string;
  /** How the apply ended; a blueprint after anything but SUCCEEDED is for review, never for a cleanup proposal. */
  outcome: ApplyOutcome;
  /** Where the identifiers came from: Terraform's state read as STATE, or CloudFormation's stack resources (logical to physical ids) read as DISCOVERY. */
  source: "TERRAFORM_STATE_PULL" | "CLOUDFORMATION_STACK_RESOURCES";
  blueprint: Blueprint;
  /** The deletion unit the sealed plan stamped on what it created (src/apply/unit.ts), or null when the engine seals none. The observation sweeps by it. */
  unitId: string | null;
  readAt: string;
};

/** How one resource stands after an independent read, in the words the journey uses (docs/observe-and-cleanup.md). */
export type VerificationResult = "VERIFIED" | "DIFFERENT_FROM_DESIRED" | "MISSING" | "NOT_YET_OBSERVABLE" | "UNVERIFIABLE";

export type ObservedResource = {
  address: string;
  type: string;
  /** The cloud identifier the check used: an ARN or the provider's id. Never a property. */
  identifier: string | null;
  /** IN_PLAN: the sealed plan named it. NOT_IN_PLAN: the state holds it but the plan never mentioned it. */
  origin: BlueprintEntry["origin"];
  result: VerificationResult;
  /** Why the result is not VERIFIED: an error class or a fixed reason, never the cloud's message. */
  reason?: string;
};

export type ObservationRecord = {
  schemaVersion: 1;
  kind: "OBSERVATION";
  artifactSha256: string;
  applyEvidenceSha256: string;
  blueprintSha256: string;
  environment: ApplyEnvironment;
  target: ResolvedTarget;
  sourceCommit: string;
  contractSha256: string;
  verifier: ObserveReport["verifier"];
  /** SHA-256 of the verifier program (the aws CLI) that ran, so the record says which program looked. */
  verifierBinarySha256: string | null;
  verdict: ObserveReport["verdict"];
  resources: ObservedResource[];
  /** Addresses the plan says should exist that the state never held. */
  missingFromState: string[];
  /** Identifiers tagged with the run's unit that the blueprint does not name. */
  unexpected: string[];
  inventory: ObserveReport["inventory"];
  observedAt: string;
};

/** The disposition of one proposed resource after a cleanup, in the journey's words. */
export type LeftoverDisposition = "CONFIRMED_DELETED" | "INTENTIONALLY_RETAINED" | "STILL_PRESENT" | "DELETION_PENDING" | "UNKNOWN";
export type LeftoverResource = {
  address: string;
  type: string;
  identifier: string | null;
  disposition: LeftoverDisposition;
  /** What the disposition rests on: the provider's read API said absent or present (Cloud Control for AWS, Azure Resource Manager for Azure), a parent's absence, a retention decision, or why no proof exists. */
  basis: LeftoverBasis;
  reason?: string;
  /** For INTENTIONALLY_RETAINED: who keeps the resource (the pilot owner for a protected object, the environment's owner for one this run did not create). */
  owner?: string;
};
export type LeftoversRecord = {
  schemaVersion: 1;
  kind: "LEFTOVERS";
  proposalSha256: string;
  artifactSha256: string;
  applyEvidenceSha256: string;
  /** The canonical sha256 of the cleanup evidence this read followed, or null when the cleanup has not run (or not finished). */
  cleanupEvidenceSha256: string | null;
  environment: ApplyEnvironment;
  target: ResolvedTarget;
  sourceCommit: string;
  contractSha256: string;
  verifier: ObserveReport["verifier"];
  verifierBinarySha256: string | null;
  resources: LeftoverResource[];
  /**
   * COMPLETE only when every proposed deletion is CONFIRMED_DELETED, every excluded resource is INTENTIONALLY_RETAINED, and a
   * COMPLETE sweep by the run's deletion-unit tag found nothing else, and nothing was kept only because its type is unreviewed. KNOWN_ADDRESSES_CONFIRMED: the named resources are
   * settled but no sweep was possible (the run carries no unit tag), so resources outside the state were not searched for;
   * it is not completion. INCOMPLETE otherwise.
   */
  disposition: "COMPLETE" | "KNOWN_ADDRESSES_CONFIRMED" | "INCOMPLETE";
  /** Resources outside the engine's state were looked for by the run's unit tag, or could not be (NOT_AVAILABLE). */
  sweep: "COMPLETE" | "INCOMPLETE" | "NOT_AVAILABLE";
  /** What a person does next when the disposition is INCOMPLETE. */
  nextAction: string;
  observedAt: string;
};

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const hashText = (value: unknown): value is string => typeof value === "string" && HASH.test(value);
const isoText = (value: unknown): value is string => typeof value === "string" && /^\d{4}-\d\d-\d\dT[\d:.]+Z$/.test(value) && !Number.isNaN(Date.parse(value));
const targetOk = (value: unknown): value is ResolvedTarget => isRecord(value) && Object.keys(value).sort().join() === "account,backend,workspace" &&
  ["account", "backend", "workspace"].every((key) => typeof value[key] === "string" && (value[key] as string).length > 0);
const idText = (value: unknown): boolean => value === null || (typeof value === "string" && value.length > 0 && value.length <= 2048);
const RAW_KEY = /^(values|attributes|properties|state|plan|stdout|stderr|output|credentials|secret|token|password)$/i;
const ENVIRONMENTS = ["DEV", "QA", "PROD"];

function entryOk(value: unknown): value is BlueprintEntry {
  return isRecord(value) && ["address,arn,id,origin,type", "address,arn,holdsIdentityArn,id,origin,type"].includes(Object.keys(value).sort().join()) && typeof value.address === "string" && value.address.length > 0 &&
    typeof value.type === "string" && idText(value.arn) && idText(value.id) && (value.origin === "IN_PLAN" || value.origin === "NOT_IN_PLAN") && (value.holdsIdentityArn === undefined || value.holdsIdentityArn === true);
}

/** Every reason this is not a blueprint record. Empty means it is. Checks every key, so a raw state value cannot ride along. */
export function blueprintRecordProblems(value: unknown): string[] {
  if (!isRecord(value)) return ["blueprint record: expected an object"];
  const problems: string[] = [];
  const keys = ["schemaVersion", "kind", "artifactSha256", "applyEvidenceSha256", "environment", "target", "sourceCommit", "contractSha256", "outcome", "source", "blueprint", "unitId", "readAt"];
  for (const key of Object.keys(value)) if (!keys.includes(key)) problems.push("blueprint record." + key + (RAW_KEY.test(key) ? ": raw state or output field" : ": not part of the record"));
  for (const key of keys) if (!Object.hasOwn(value, key)) problems.push("blueprint record." + key + ": missing");
  if (problems.length > 0) return problems;
  if (value.schemaVersion !== 1 || value.kind !== "BLUEPRINT") problems.push("blueprint record: not a schemaVersion 1 BLUEPRINT");
  if (!hashText(value.artifactSha256) || !hashText(value.applyEvidenceSha256) || !hashText(value.contractSha256)) problems.push("blueprint record: a hash is not a SHA-256 digest");
  if (!ENVIRONMENTS.includes(value.environment as string) || !targetOk(value.target)) problems.push("blueprint record: environment or target is malformed");
  if (typeof value.sourceCommit !== "string" || !COMMIT.test(value.sourceCommit)) problems.push("blueprint record: sourceCommit is not a commit id");
  if (!["SUCCEEDED", "FAILED_NO_CHANGE", "PARTIAL_REQUIRES_REVIEW", "KILLED"].includes(value.outcome as string)) problems.push("blueprint record: outcome is unknown");
  if (!["TERRAFORM_STATE_PULL", "CLOUDFORMATION_STACK_RESOURCES"].includes(value.source as string) || !isoText(value.readAt)) problems.push("blueprint record: source or readAt is malformed");
  if (value.unitId !== null && !(typeof value.unitId === "string" && /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(value.unitId))) problems.push("blueprint record: unitId is not a tag-safe unit id or null");
  const blueprint = value.blueprint;
  if (!isRecord(blueprint) || Object.keys(blueprint).sort().join() !== "entries,missing" || !Array.isArray(blueprint.entries) || !blueprint.entries.every(entryOk) ||
    !Array.isArray(blueprint.missing) || !blueprint.missing.every((x) => typeof x === "string")) {
    problems.push("blueprint record.blueprint: entries must carry address, type, arn, id and origin only");
  }
  return problems;
}

const RESULTS: readonly VerificationResult[] = ["VERIFIED", "DIFFERENT_FROM_DESIRED", "MISSING", "NOT_YET_OBSERVABLE", "UNVERIFIABLE"];
function observedOk(value: unknown): value is ObservedResource {
  return isRecord(value) && Object.keys(value).every((key) => ["address", "type", "identifier", "origin", "result", "reason"].includes(key)) &&
    typeof value.address === "string" && typeof value.type === "string" && idText(value.identifier) && (value.origin === "IN_PLAN" || value.origin === "NOT_IN_PLAN") &&
    RESULTS.includes(value.result as VerificationResult) && (value.reason === undefined || (typeof value.reason === "string" && /^[A-Z_]{1,64}$/.test(value.reason)));
}

/** Every reason this is not an observation record. Empty means it is. */
export function observationRecordProblems(value: unknown): string[] {
  if (!isRecord(value)) return ["observation record: expected an object"];
  const problems: string[] = [];
  const keys = ["schemaVersion", "kind", "artifactSha256", "applyEvidenceSha256", "blueprintSha256", "environment", "target", "sourceCommit", "contractSha256", "verifier",
    "verifierBinarySha256", "verdict", "resources", "missingFromState", "unexpected", "inventory", "observedAt"];
  for (const key of Object.keys(value)) if (!keys.includes(key)) problems.push("observation record." + key + (RAW_KEY.test(key) ? ": raw state or output field" : ": not part of the record"));
  for (const key of keys) if (!Object.hasOwn(value, key)) problems.push("observation record." + key + ": missing");
  if (problems.length > 0) return problems;
  if (value.schemaVersion !== 1 || value.kind !== "OBSERVATION") problems.push("observation record: not a schemaVersion 1 OBSERVATION");
  if (![value.artifactSha256, value.applyEvidenceSha256, value.blueprintSha256, value.contractSha256].every(hashText)) problems.push("observation record: a hash is not a SHA-256 digest");
  if (value.verifierBinarySha256 !== null && !hashText(value.verifierBinarySha256)) problems.push("observation record: verifierBinarySha256 is malformed");
  if (!ENVIRONMENTS.includes(value.environment as string) || !targetOk(value.target)) problems.push("observation record: environment or target is malformed");
  if (typeof value.sourceCommit !== "string" || !COMMIT.test(value.sourceCommit)) problems.push("observation record: sourceCommit is not a commit id");
  if (!VERIFIERS.includes(value.verifier as VerifierId) || !["VERIFIED", "PARTIAL", "INCONCLUSIVE", "FAILED"].includes(value.verdict as string)) problems.push("observation record: verifier or verdict is unknown");
  if (!Array.isArray(value.resources) || !value.resources.every(observedOk)) problems.push("observation record.resources: each needs address, type, identifier, origin and a result");
  if (!Array.isArray(value.missingFromState) || !value.missingFromState.every((x) => typeof x === "string") || !Array.isArray(value.unexpected) || !value.unexpected.every((x) => typeof x === "string")) {
    problems.push("observation record: missingFromState and unexpected are lists of addresses or identifiers");
  }
  if (!["COMPLETE", "INCOMPLETE", "NOT_AVAILABLE"].includes(value.inventory as string) || !isoText(value.observedAt)) problems.push("observation record: inventory or observedAt is malformed");
  return problems;
}

const DISPOSITIONS: readonly LeftoverDisposition[] = ["CONFIRMED_DELETED", "INTENTIONALLY_RETAINED", "STILL_PRESENT", "DELETION_PENDING", "UNKNOWN"];
/** UNREVIEWED_TYPE: kept because its type is not on the reviewed AWS leaf allowlist (TYPE_UNREVIEWED); a person still decides about it, so a record holding one is never COMPLETE. */
export type LeftoverBasis = "CLOUD_CONTROL_ABSENT" | "CLOUD_CONTROL_PRESENT" | "ARM_ABSENT" | "ARM_PRESENT" | "PARENT_ABSENT" | "RETENTION_DECISION" | "UNREVIEWED_TYPE" | "CLEANUP_NOT_FINISHED" | "NOT_INDEPENDENTLY_CHECKABLE" | "CHECK_FAILED";
const BASES: readonly LeftoverBasis[] = ["CLOUD_CONTROL_ABSENT", "CLOUD_CONTROL_PRESENT", "ARM_ABSENT", "ARM_PRESENT", "PARENT_ABSENT", "RETENTION_DECISION", "UNREVIEWED_TYPE", "CLEANUP_NOT_FINISHED", "NOT_INDEPENDENTLY_CHECKABLE", "CHECK_FAILED"];
/** The read API's absent and present bases for a verifier, so a record never names a service that did not answer. */
export const basesOf = (verifier: VerifierId): { absent: LeftoverBasis; present: LeftoverBasis } =>
  verifier === "AZURE_RESOURCE_MANAGER" ? { absent: "ARM_ABSENT", present: "ARM_PRESENT" } : { absent: "CLOUD_CONTROL_ABSENT", present: "CLOUD_CONTROL_PRESENT" };
function leftoverOk(value: unknown): value is LeftoverResource {
  return isRecord(value) && Object.keys(value).every((key) => ["address", "type", "identifier", "disposition", "basis", "reason", "owner"].includes(key)) &&
    typeof value.address === "string" && typeof value.type === "string" && idText(value.identifier) && DISPOSITIONS.includes(value.disposition as LeftoverDisposition) &&
    BASES.includes(value.basis as LeftoverBasis) && (value.reason === undefined || typeof value.reason === "string") && (value.owner === undefined || typeof value.owner === "string");
}

/** Every reason this is not a leftovers record. Empty means it is. A COMPLETE disposition with anything but confirmed deletions and retentions is refused here too. */
export function leftoversRecordProblems(value: unknown): string[] {
  if (!isRecord(value)) return ["leftovers record: expected an object"];
  const problems: string[] = [];
  const keys = ["schemaVersion", "kind", "proposalSha256", "artifactSha256", "applyEvidenceSha256", "cleanupEvidenceSha256", "environment", "target", "sourceCommit", "contractSha256",
    "verifier", "verifierBinarySha256", "resources", "disposition", "sweep", "nextAction", "observedAt"];
  for (const key of Object.keys(value)) if (!keys.includes(key)) problems.push("leftovers record." + key + (RAW_KEY.test(key) ? ": raw state or output field" : ": not part of the record"));
  for (const key of keys) if (!Object.hasOwn(value, key)) problems.push("leftovers record." + key + ": missing");
  if (problems.length > 0) return problems;
  if (value.schemaVersion !== 1 || value.kind !== "LEFTOVERS") problems.push("leftovers record: not a schemaVersion 1 LEFTOVERS");
  if (![value.proposalSha256, value.artifactSha256, value.applyEvidenceSha256, value.contractSha256].every(hashText)) problems.push("leftovers record: a hash is not a SHA-256 digest");
  if (value.cleanupEvidenceSha256 !== null && !hashText(value.cleanupEvidenceSha256)) problems.push("leftovers record: cleanupEvidenceSha256 is malformed");
  if (value.verifierBinarySha256 !== null && !hashText(value.verifierBinarySha256)) problems.push("leftovers record: verifierBinarySha256 is malformed");
  if (!ENVIRONMENTS.includes(value.environment as string) || !targetOk(value.target)) problems.push("leftovers record: environment or target is malformed");
  if (typeof value.sourceCommit !== "string" || !COMMIT.test(value.sourceCommit)) problems.push("leftovers record: sourceCommit is not a commit id");
  if (!VERIFIERS.includes(value.verifier as VerifierId)) problems.push("leftovers record: verifier is unknown");
  const resources = value.resources;
  if (!Array.isArray(resources) || !resources.every(leftoverOk)) problems.push("leftovers record.resources: each needs address, type, identifier, disposition and basis");
  else {
    const settled = resources.every((x) => x.disposition === "CONFIRMED_DELETED" || x.disposition === "INTENTIONALLY_RETAINED");
    if ((value.disposition === "COMPLETE" || value.disposition === "KNOWN_ADDRESSES_CONFIRMED") && (!settled || resources.length === 0)) problems.push("leftovers record: COMPLETE needs every resource confirmed deleted or intentionally retained");
    if ((value.disposition === "COMPLETE" || value.disposition === "KNOWN_ADDRESSES_CONFIRMED") && resources.some((x) => x.basis === "UNREVIEWED_TYPE")) problems.push("leftovers record: a resource kept because its type is unreviewed still needs a person's decision, so the record is INCOMPLETE");
    if (value.disposition === "COMPLETE" && value.sweep !== "COMPLETE") problems.push("leftovers record: COMPLETE needs a complete deletion-unit sweep; without one the most a record says is KNOWN_ADDRESSES_CONFIRMED");
    if (value.disposition === "KNOWN_ADDRESSES_CONFIRMED" && value.sweep !== "NOT_AVAILABLE") problems.push("leftovers record: KNOWN_ADDRESSES_CONFIRMED is for a run with no unit tag; with a sweep the record is COMPLETE or INCOMPLETE");
    if (!["COMPLETE", "KNOWN_ADDRESSES_CONFIRMED", "INCOMPLETE"].includes(value.disposition as string)) problems.push("leftovers record: disposition is unknown");
  }
  if (!["COMPLETE", "INCOMPLETE", "NOT_AVAILABLE"].includes(value.sweep as string) || typeof value.nextAction !== "string" || !isoText(value.observedAt)) {
    problems.push("leftovers record: sweep, nextAction or observedAt is malformed");
  }
  return problems;
}

/** The canonical sha256 of any record: the identity another record binds to. */
export const recordSha256 = (record: unknown): string => sha256(canonicalJson(record as never));

async function writableKey(): Promise<Buffer | undefined> {
  const { key, info } = await ensureEvidenceKey();
  return info.securePermissions ? key : undefined;
}

/** Writes a record once, exclusively. A second write of the same name is refused: a blueprint is read when the run ends and never again. */
async function writeOnce(path: string, purpose: string, record: unknown): Promise<"WRITTEN" | "EXISTS" | "KEY_INSECURE"> {
  const key = await writableKey();
  if (!key) return "KEY_INSECURE";
  await mkdir(join(path, ".."), { recursive: true, mode: 0o700 });
  try {
    await writeFile(path, JSON.stringify(encryptEvidence(purpose, record, key)) + "\n", { encoding: "utf8", mode: 0o600, flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "EEXIST") return "EXISTS";
    throw error;
  }
  return "WRITTEN";
}

/** Replaces a record in one rename, so the latest observation is never half-written and the previous one is never partly overwritten. */
async function writeLatest(path: string, purpose: string, record: unknown): Promise<"WRITTEN" | "KEY_INSECURE"> {
  const key = await writableKey();
  if (!key) return "KEY_INSECURE";
  const directory = join(path, "..");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const staged = join(directory, "staged-" + randomBytes(6).toString("hex") + ".tmp");
  await writeFile(staged, JSON.stringify(encryptEvidence(purpose, record, key)) + "\n", { encoding: "utf8", mode: 0o600, flag: "wx" });
  await rename(staged, path);
  return "WRITTEN";
}

async function readRecord<T>(path: string, problems: (value: unknown) => string[]): Promise<T | undefined> {
  try {
    await readFile(path);
    const record = await readEncryptedEvidence<unknown>(path);
    return problems(record).length === 0 ? record as T : undefined;
  } catch {
    return undefined;
  }
}

export function writeBlueprintRecord(record: BlueprintRecord, evidenceDir: string): Promise<"WRITTEN" | "EXISTS" | "KEY_INSECURE" | "REJECTED"> {
  if (blueprintRecordProblems(record).length > 0) return Promise.resolve("REJECTED");
  return writeOnce(join(evidenceDir, record.artifactSha256 + BLUEPRINT_SUFFIX), "apply-blueprint", record);
}
/** The blueprint record for an artifact, only when it names that artifact and the apply evidence given. */
export async function readBlueprintRecord(artifactSha256: string, applyEvidenceSha256: string, evidenceDir: string): Promise<BlueprintRecord | undefined> {
  if (!HASH.test(artifactSha256)) return undefined;
  const record = await readRecord<BlueprintRecord>(join(evidenceDir, artifactSha256 + BLUEPRINT_SUFFIX), blueprintRecordProblems);
  return record && record.artifactSha256 === artifactSha256 && record.applyEvidenceSha256 === applyEvidenceSha256 ? record : undefined;
}

export function writeObservationRecord(record: ObservationRecord, evidenceDir: string): Promise<"WRITTEN" | "KEY_INSECURE" | "REJECTED"> {
  if (observationRecordProblems(record).length > 0) return Promise.resolve("REJECTED");
  return writeLatest(join(evidenceDir, record.artifactSha256 + OBSERVATION_SUFFIX), "apply-observation", record);
}
export async function readObservationRecord(artifactSha256: string, applyEvidenceSha256: string, evidenceDir: string): Promise<ObservationRecord | undefined> {
  if (!HASH.test(artifactSha256)) return undefined;
  const record = await readRecord<ObservationRecord>(join(evidenceDir, artifactSha256 + OBSERVATION_SUFFIX), observationRecordProblems);
  return record && record.artifactSha256 === artifactSha256 && record.applyEvidenceSha256 === applyEvidenceSha256 ? record : undefined;
}

export function writeLeftoversRecord(record: LeftoversRecord, evidenceDir: string): Promise<"WRITTEN" | "KEY_INSECURE" | "REJECTED"> {
  if (leftoversRecordProblems(record).length > 0) return Promise.resolve("REJECTED");
  return writeLatest(join(evidenceDir, record.proposalSha256 + LEFTOVERS_SUFFIX), "apply-leftovers", record);
}
export async function readLeftoversRecord(proposalSha256: string, evidenceDir: string): Promise<LeftoversRecord | undefined> {
  if (!HASH.test(proposalSha256)) return undefined;
  const record = await readRecord<LeftoversRecord>(join(evidenceDir, proposalSha256 + LEFTOVERS_SUFFIX), leftoversRecordProblems);
  return record && record.proposalSha256 === proposalSha256 ? record : undefined;
}

/** One blueprint entry's result from an independent existence check, in the journey's words. Apply success alone never yields VERIFIED. */
export function verificationOf(existence: "PRESENT" | "ABSENT" | "UNKNOWN" | "NOT_CHECKABLE", reason: string | undefined): Pick<ObservedResource, "result" | "reason"> {
  switch (existence) {
    case "PRESENT": return { result: "VERIFIED" };
    case "ABSENT": return { result: "MISSING" };
    case "NOT_CHECKABLE": return { result: "UNVERIFIABLE", reason: reason ?? "NOT_INDEPENDENTLY_CHECKABLE" };
    default: return reason === "ACCESS_DENIED" || reason === "CREDENTIALS" ? { result: "UNVERIFIABLE", reason } : { result: "NOT_YET_OBSERVABLE", reason: reason ?? "CLI_ERROR" };
  }
}
