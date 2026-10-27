import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

/**
 * The runner's configuration, `config/evidence-runner.json` (git-ignored; `config/evidence-runner.example.json` is the
 * committed template). It names identifiers only: the candidate commit, the host's hardware id, where evidence goes, and
 * the account, tenant and subscription each provider stage must find itself in. It never names a credential, a profile, a
 * key file or a token path, and a closed set of keys means one cannot be slipped in.
 */
export type AwsTarget = { expectedAccountId: string; region: string; qualificationStack: string };
export type AzureTarget = { expectedTenantId: string; expectedSubscriptionId: string; location: string };
export type EvidenceRunnerConfig = {
  schemaVersion: 1;
  candidateCommit: string;
  targetHardwareId: string;
  /** Relative to the repository, and inside it. */
  evidenceDir: string;
  /** True only when this host is the private-model target host (the model stage runs here). */
  modelHost: boolean;
  aws?: AwsTarget;
  azure?: AzureTarget;
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
/** Values that look like a credential even inside an allowed pattern: an AWS key id, a JWT, a long unbroken opaque run. */
const SECRET_LIKE = /^(AKIA|ASIA)[A-Z0-9]{16}$|^eyJ|[A-Za-z0-9+/=]{40,}/;

const TOP_KEYS = new Set(["schemaVersion", "candidateCommit", "targetHardwareId", "evidenceDir", "modelHost", "aws", "azure"]);
const AWS_KEYS = new Set(["expectedAccountId", "region", "qualificationStack"]);
const AZURE_KEYS = new Set(["expectedTenantId", "expectedSubscriptionId", "location"]);

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
    if (key === "gcp") problems.push("config.gcp: GCP joins in slice S4, after the GCP lane's PLAN lands; remove the block for now");
    else if (!TOP_KEYS.has(key)) problems.push("config." + key + ": unknown key (no credential, profile, key or token path belongs here)");
  }
  if (value.schemaVersion !== 1) problems.push("config.schemaVersion: must be 1");
  const field = (name: string, text: unknown, pattern: RegExp, rule: string): void => {
    if (typeof text !== "string" || !pattern.test(text)) problems.push(name + ": must be " + rule);
    else if (SECRET_LIKE.test(text)) problems.push(name + ": looks like a credential, which never belongs in this file");
  };
  if (typeof value.candidateCommit !== "string" || !COMMIT.test(value.candidateCommit)) problems.push("config.candidateCommit: must be a full 40-character commit");
  field("config.targetHardwareId", value.targetHardwareId, HARDWARE_ID, "1-64 letters, digits, '.', '_' or '-'");
  const evidenceDir = value.evidenceDir ?? ".runs/evidence";
  if (typeof evidenceDir !== "string" || evidenceDir === "" || isAbsolute(evidenceDir) || evidenceDir.split(/[\\/]/).includes("..") || evidenceDir.includes("\u0000")) {
    problems.push("config.evidenceDir: must be a relative path inside the repository");
  }
  const modelHost = value.modelHost ?? false;
  if (typeof modelHost !== "boolean") problems.push("config.modelHost: must be true or false");
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
  if (problems.length > 0) return { ok: false, problems };
  const config: EvidenceRunnerConfig = {
    schemaVersion: 1,
    candidateCommit: value.candidateCommit as string,
    targetHardwareId: value.targetHardwareId as string,
    evidenceDir: evidenceDir as string,
    modelHost: modelHost as boolean,
    ...(value.aws ? { aws: value.aws as AwsTarget } : {}),
    ...(value.azure ? { azure: value.azure as AzureTarget } : {}),
  };
  return { ok: true, config };
}

/** A path the operator named, resolved inside the repository, or undefined when it escapes it. */
export function insideRoot(root: string, path: string): string | undefined {
  const full = resolve(root, path);
  const rel = relative(root, full);
  return rel === "" || rel.startsWith("..") || isAbsolute(rel) || rel.split(sep).includes("..") ? undefined : full;
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
  if (!insideRoot(root, result.config.evidenceDir)) return { ok: false, problems: ["config.evidenceDir: must be a relative path inside the repository"] };
  return { ok: true, config: result.config, sha256: createHash("sha256").update(bytes).digest("hex"), path: full };
}
