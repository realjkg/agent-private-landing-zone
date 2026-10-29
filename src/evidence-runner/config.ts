import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, normalize, relative, resolve, sep } from "node:path";

import { ACT_PATHS, type ActPathId } from "./types.js";

/**
 * The runner's configuration, `config/evidence-runner.json` (git-ignored; `config/evidence-runner.example.json` is the
 * committed template). It names identifiers only: the candidate commit, the host's hardware id, where evidence goes, and
 * the account, tenant and subscription each provider stage must find itself in. It never names a credential, a profile, a
 * key file or a token path, and a closed set of keys means one cannot be slipped in.
 */
export type AwsTarget = { expectedAccountId: string; region: string; qualificationStack: string };
export type AzureTarget = { expectedTenantId: string; expectedSubscriptionId: string; location: string };
export type GcpTarget = { expectedProjectId: string; region: string };
/**
 * What the guided ACT stages need that is not in the pilot contract: the repository the D4 delivery workflow runs in (for
 * `./alz apply identity-check`), and per path the project folder `./alz apply prepare` reads (the canary copied outside the
 * checkout, as each canary's README says, so an absolute path), the requester's allowlisted id
 * and, optionally, the id of an approver who approves at this terminal. Ids and a folder only: key files are asked for at
 * the terminal each time and never stored.
 */
export type ActPathTarget = { project: string; requesterId: string; approverId?: string };
export type ActTargets = { repository: string; paths: Partial<Record<ActPathId, ActPathTarget>> };
export type EvidenceRunnerConfig = {
  schemaVersion: 1;
  candidateCommit: string;
  targetHardwareId: string;
  /** `.runs/evidence` or a folder under it (git-ignored), with no symbolic link anywhere on the path. */
  evidenceDir: string;
  aws?: AwsTarget;
  azure?: AzureTarget;
  gcp?: GcpTarget;
  act?: ActTargets;
};

export type ConfigResult = { ok: true; config: EvidenceRunnerConfig } | { ok: false; problems: string[] };

export const DEFAULT_CONFIG_PATH = "config/evidence-runner.json";
export const EXAMPLE_CONFIG_PATH = "config/evidence-runner.example.json";
export const PLACEHOLDER = "REPLACE-WITH";

const COMMIT = /^[0-9a-f]{40}$/;
const HARDWARE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const ACCOUNT = /^\d{12}$/;
const REGION = /^[a-z]{2}(-gov|-iso[a-z]?)?-[a-z]+-\d{1,2}$/;
const STACK = /^[A-Za-z][A-Za-z0-9-]{0,127}$/;
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const LOCATION = /^[a-z][a-z0-9]{1,31}$/;
const PROJECT_ID = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;
const GCP_REGION = /^[a-z]+-[a-z]+\d{1,2}$/;
const REPOSITORY = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
/** The id rule `./alz apply` applies to requesters and approvers. */
const PERSON_ID = /^[A-Za-z0-9._@+-]{1,128}$/;
/** Values that look like a credential even inside an allowed pattern: an AWS key id, a JWT, a long unbroken opaque run. */
const SECRET_LIKE = /^(AKIA|ASIA)[A-Z0-9]{16}$|^eyJ|[A-Za-z0-9+/=]{40,}/;

const TOP_KEYS = new Set(["schemaVersion", "candidateCommit", "targetHardwareId", "evidenceDir", "aws", "azure", "gcp", "act"]);
/** The only place evidence may go: git-ignored, so a run never dirties the checkout it is bound to. */
export const EVIDENCE_ROOT = ".runs/evidence";
const AWS_KEYS = new Set(["expectedAccountId", "region", "qualificationStack"]);
const AZURE_KEYS = new Set(["expectedTenantId", "expectedSubscriptionId", "location"]);
const GCP_KEYS = new Set(["expectedProjectId", "region"]);
const ACT_KEYS = new Set(["repository", "paths"]);
const ACT_PATH_KEYS = new Set(["project", "requesterId", "approverId"]);

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** Every string anywhere in the document, so a placeholder is found wherever it was left. */
function strings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(strings);
  if (isRecord(value)) return Object.values(value).flatMap(strings);
  return [];
}

/**
 * Validates a parsed configuration. Problems are stable phrases that name the field and never echo the value, so a
 * pasted secret does not reach the terminal or a log.
 */
export function parseConfig(value: unknown): ConfigResult {
  if (!isRecord(value)) return { ok: false, problems: ["config: not a JSON object"] };
  const problems: string[] = [];
  if (strings(value).some((text) => text.includes(PLACEHOLDER))) {
    problems.push("config: still holds " + PLACEHOLDER + " placeholders; replace every one with your own identifiers");
  }
  for (const key of Object.keys(value)) {
    if (!TOP_KEYS.has(key)) problems.push("config." + key + ": unknown key (no credential, profile, key or token path belongs here)");
  }
  if (value.schemaVersion !== 1) problems.push("config.schemaVersion: must be 1");
  const field = (name: string, text: unknown, pattern: RegExp, rule: string): void => {
    if (typeof text !== "string" || !pattern.test(text)) problems.push(name + ": must be " + rule);
    else if (SECRET_LIKE.test(text)) problems.push(name + ": looks like a credential, which never belongs in this file");
  };
  if (typeof value.candidateCommit !== "string" || !COMMIT.test(value.candidateCommit)) problems.push("config.candidateCommit: must be a full 40-character commit");
  field("config.targetHardwareId", value.targetHardwareId, HARDWARE_ID, "1-64 letters, digits, '.', '_' or '-'");
  const evidenceDir = value.evidenceDir ?? ".runs/evidence";
  if (!evidenceDirAllowed(evidenceDir)) problems.push("config.evidenceDir: must be " + EVIDENCE_ROOT + " or a folder under it");
  if (value.aws !== undefined) {
    if (!isRecord(value.aws)) problems.push("config.aws: must be an object");
    else {
      for (const key of Object.keys(value.aws)) if (!AWS_KEYS.has(key)) problems.push("config.aws." + key + ": unknown key");
      field("config.aws.expectedAccountId", value.aws.expectedAccountId, ACCOUNT, "a 12-digit AWS account id");
      field("config.aws.region", value.aws.region, REGION, "an AWS region such as eu-west-1");
      field("config.aws.qualificationStack", value.aws.qualificationStack, STACK, "a CloudFormation stack name");
    }
  }
  if (value.azure !== undefined) {
    if (!isRecord(value.azure)) problems.push("config.azure: must be an object");
    else {
      for (const key of Object.keys(value.azure)) if (!AZURE_KEYS.has(key)) problems.push("config.azure." + key + ": unknown key");
      field("config.azure.expectedTenantId", value.azure.expectedTenantId, GUID, "a lower-case tenant GUID");
      field("config.azure.expectedSubscriptionId", value.azure.expectedSubscriptionId, GUID, "a lower-case subscription GUID");
      field("config.azure.location", value.azure.location, LOCATION, "an Azure location such as westeurope");
    }
  }
  if (value.gcp !== undefined) {
    if (!isRecord(value.gcp)) problems.push("config.gcp: must be an object");
    else {
      for (const key of Object.keys(value.gcp)) if (!GCP_KEYS.has(key)) problems.push("config.gcp." + key + ": unknown key");
      field("config.gcp.expectedProjectId", value.gcp.expectedProjectId, PROJECT_ID, "a GCP project id such as alz-dev-pilot");
      field("config.gcp.region", value.gcp.region, GCP_REGION, "a GCP region such as europe-west1");
    }
  }
  if (value.act !== undefined) problems.push(...actProblems(value.act));
  if (problems.length > 0) return { ok: false, problems };
  const config: EvidenceRunnerConfig = {
    schemaVersion: 1,
    candidateCommit: value.candidateCommit as string,
    targetHardwareId: value.targetHardwareId as string,
    evidenceDir: normalize(evidenceDir as string).replace(/[\\/]+$/, ""),
    ...(value.aws ? { aws: value.aws as AwsTarget } : {}),
    ...(value.azure ? { azure: value.azure as AzureTarget } : {}),
    ...(value.gcp ? { gcp: value.gcp as GcpTarget } : {}),
    ...(value.act ? { act: value.act as ActTargets } : {}),
  };
  return { ok: true, config };
}

type FieldCheck = (name: string, text: unknown, pattern: RegExp, rule: string) => void;

/** The `act` block: the repository and, per path, a project folder inside the repository and the people's ids. */
function actProblems(act: unknown): string[] {
  if (!isRecord(act)) return ["config.act: must be an object"];
  const local: string[] = [];
  for (const key of Object.keys(act)) if (!ACT_KEYS.has(key)) local.push("config.act." + key + ": unknown key");
  const check: FieldCheck = (name, text, pattern, rule) => {
    if (typeof text !== "string" || !pattern.test(text)) local.push(name + ": must be " + rule);
    else if (SECRET_LIKE.test(text)) local.push(name + ": looks like a credential, which never belongs in this file");
  };
  check("config.act.repository", act.repository, REPOSITORY, "OWNER/REPO, the repository the identity delivery workflow runs in");
  if (!isRecord(act.paths)) local.push("config.act.paths: must be an object keyed by path (" + ACT_PATHS.join(", ") + ")");
  else {
    for (const [path, target] of Object.entries(act.paths)) {
      const name = "config.act.paths." + path;
      if (!(ACT_PATHS as readonly string[]).includes(path)) { local.push(name + ": unknown path (one of " + ACT_PATHS.join(", ") + ")"); continue; }
      if (!isRecord(target)) { local.push(name + ": must be an object"); continue; }
      for (const key of Object.keys(target)) if (!ACT_PATH_KEYS.has(key)) local.push(name + "." + key + ": unknown key (key files are asked for at the terminal, never stored)");
      if (!projectAllowed(target.project)) local.push(name + ".project: must be the absolute path of the project folder (the canary copied outside the checkout), with no '..'");
      check(name + ".requesterId", target.requesterId, PERSON_ID, "the requester's allowlisted id");
      if (target.approverId !== undefined) check(name + ".approverId", target.approverId, PERSON_ID, "an approver's allowlisted id");
    }
  }
  return local;
}

/** An absolute folder path: no `..` or `.` component, no backslash, no NUL, at most 512 characters. */
function projectAllowed(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 512 || !value.startsWith("/") || value.includes("\u0000") || value.includes("\\")) return false;
  return value.replace(/\/+$/, "").split("/").slice(1).every((part) => part !== "" && part !== "." && part !== "..");
}

/** `.runs/evidence` or a relative folder under it, with no `..`, backslash or empty component. */
function evidenceDirAllowed(value: unknown): value is string {
  if (typeof value !== "string" || value === "" || isAbsolute(value) || value.includes("\u0000") || value.includes("\\")) return false;
  const parts = value.replace(/\/+$/, "").split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..")) return false;
  const path = parts.join("/");
  return path === EVIDENCE_ROOT || path.startsWith(EVIDENCE_ROOT + "/");
}

/** A path the operator named, resolved inside the repository, or undefined when it escapes it. */
export function insideRoot(root: string, path: string): string | undefined {
  const full = resolve(root, path);
  const rel = relative(root, full);
  return rel === "" || rel.startsWith("..") || isAbsolute(rel) || rel.split(sep).includes("..") ? undefined : full;
}

export class EvidencePathError extends Error {
  readonly code = "EVIDENCE_PATH_REFUSED";
}

/**
 * The folder `parts` names under the repository, refused when any existing component below the repository root is a
 * symbolic link, or when the result does not resolve under the repository's real `.runs/evidence`. Every write then
 * re-checks its folder and refuses a link at the file name (`safe-write.ts`), and its limits are written there.
 */
export function evidencePath(root: string, ...parts: string[]): string {
  const realRoot = realpathSync(root);
  const relativeParts = join(...parts).split(sep).filter(Boolean);
  if (!evidenceDirAllowed(relativeParts.join("/"))) throw new EvidencePathError("Evidence may only be written under " + EVIDENCE_ROOT + ".");
  let current = realRoot;
  for (const part of relativeParts) {
    current = join(current, part);
    let isLink = false;
    try { isLink = lstatSync(current).isSymbolicLink(); } catch { break; /* not created yet: nothing below it exists */ }
    if (isLink) throw new EvidencePathError(relative(realRoot, current) + " is a symbolic link; evidence is never written through one. Replace it with a real folder.");
  }
  const full = join(realRoot, ...relativeParts);
  if (!full.startsWith(join(realRoot, EVIDENCE_ROOT))) throw new EvidencePathError("Evidence may only be written under " + EVIDENCE_ROOT + ".");
  return full;
}

export type LoadedConfig = { ok: true; config: EvidenceRunnerConfig; sha256: string; path: string } | { ok: false; problems: string[] };

/** Reads and validates the configuration file. The digest binds the journal to these exact bytes. */
export function loadConfig(root: string, path: string = DEFAULT_CONFIG_PATH): LoadedConfig {
  const full = insideRoot(root, path);
  if (!full) return { ok: false, problems: ["--config: must be a file inside the repository"] };
  let bytes: Buffer;
  try { bytes = readFileSync(full); } catch {
    return { ok: false, problems: [path + ": not found. Run ./alz evidence init, then fill in your own identifiers."] };
  }
  let parsed: unknown;
  try { parsed = JSON.parse(bytes.toString("utf8")); } catch { return { ok: false, problems: [path + ": not valid JSON"] }; }
  const result = parseConfig(parsed);
  if (!result.ok) return result;
  try { evidencePath(root, result.config.evidenceDir); } catch (error) {
    if (error instanceof EvidencePathError) return { ok: false, problems: ["config.evidenceDir: " + error.message] };
    throw error;
  }
  return { ok: true, config: result.config, sha256: createHash("sha256").update(bytes).digest("hex"), path: full };
}
