import { closeSync, constants, fstatSync, openSync, readSync, statSync } from "node:fs";

/**
 * Google workload identity federation credentials, judged the one way the pilot judges them (docs/act-pilot-gcp-terraform-g0.md).
 * The provider spec (src/apply/providers/gcp.ts) refuses an identity whose configuration fails `checkCredentialConfiguration`, and the
 * GCP reader (src/observe/gcp-rest.ts) refuses to exchange one. This module sits outside src/apply so the reader can share it
 * without reaching the apply path (test/apply-boundary.test.ts). It reads a file and returns a verdict; it never contacts anything.
 */

/** A user-managed service account email; the capture is its project. */
export const SERVICE_ACCOUNT = /^[a-z][a-z0-9-]{4,28}[a-z0-9]@([a-z][a-z0-9-]{4,28}[a-z0-9])\.iam\.gserviceaccount\.com$/;
/** The project a service account email names, or undefined if it is not a user-managed service account email. */
export const projectOfServiceAccount = (email: string): string | undefined => SERVICE_ACCOUNT.exec(email)?.[1];

/** An absolute file path of plain characters: the same pattern as `TOKEN_FILE` in src/apply/constants.ts, pinned equal by test/apply-gcp.test.ts. */
export const CREDENTIAL_FILE = /^\/[A-Za-z0-9._/-]{1,512}$/;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** The most a credential configuration may be; a real one is well under 2 KiB. */
const MAX_CREDENTIAL_CONFIGURATION = 64 * 1024;
const STS_TOKEN_URL = "https://sts.googleapis.com/v1/token";
const WIF_AUDIENCE = /^\/\/iam\.googleapis\.com\/projects\/[0-9]{1,24}\/locations\/global\/workloadIdentityPools\/[a-z0-9-]{4,32}\/providers\/[a-z0-9-]{4,32}$/;
const OIDC_SUBJECT_TOKEN = /^urn:ietf:params:oauth:token-type:(jwt|id_token)$/;
/**
 * The only keys a pilot credential configuration may hold. Anything else is refused, which keeps out a key file
 * (`private_key`, `private_key_id`, `client_email`), an authorized-user file (`client_secret`, `refresh_token`), a second
 * impersonation path (`service_account_impersonation_url`, P1), a workforce (human) pool and a token introspection endpoint.
 */
const CONFIGURATION_KEYS = new Set(["type", "audience", "subject_token_type", "token_url", "credential_source", "universe_domain"]);
/** A file source only: an `executable` source runs a program, and a `url` or `environment_id` source reads a metadata service. */
const SOURCE_KEYS = new Set(["file", "format"]);

/** The failure class of a credential configuration. The file's contents are never put in a message. */
export type ConfigurationResult = { ok: true; tokenFile: string; audience: string; subjectTokenType: string } | { ok: false; reason: string };

/**
 * At most `max` bytes of a regular file, read without ever blocking (review N1 of #305), or undefined: a path that is not a regular
 * file is refused by `stat` before it is opened, and the open itself is non-blocking, so a FIFO swapped in between the two cannot
 * hang the read waiting for a writer (the descriptor's own `fstat` then refuses it). A device, a socket or a directory is refused
 * the same way, and so is a file larger than `max`. Throws only what `stat` or `open` throws (a missing file, a denied read).
 */
export function readRegularFile(path: string, max: number): Buffer | undefined {
  if (!statSync(path).isFile()) return undefined;
  const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > max) return undefined;
    const buffer = Buffer.alloc(max + 1);
    const length = readSync(fd, buffer, 0, buffer.length, 0);
    return length > max ? undefined : buffer.subarray(0, length);
  } finally {
    closeSync(fd);
  }
}

/** The most an OIDC subject token file may be; a real one is a few KiB. */
export const MAX_TOKEN_FILE = 16 * 1024;

/**
 * The OIDC subject token a credential configuration's file source names: one word of at most `MAX_TOKEN_FILE` bytes from a regular
 * file, read without blocking (`readRegularFile`), or undefined for anything else. The token is never put in a message.
 */
export function readTokenFile(path: string): string | undefined {
  try {
    const bytes = readRegularFile(path, MAX_TOKEN_FILE);
    const token = bytes?.toString("utf8").trim();
    return token !== undefined && token !== "" && !/\s/.test(token) ? token : undefined;
  } catch {
    return undefined;
  }
}

function readConfiguration(path: string): unknown {
  const bytes = readRegularFile(path, MAX_CREDENTIAL_CONFIGURATION);
  return bytes === undefined ? undefined : JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}

/** Judges one identity's credential configuration file: a workload identity federation file source, and nothing else. */
export function checkCredentialConfiguration(path: string): ConfigurationResult {
  if (!CREDENTIAL_FILE.test(path)) return { ok: false, reason: "is not an absolute path of plain characters" };
  let parsed: unknown;
  try {
    parsed = readConfiguration(path);
  } catch {
    return { ok: false, reason: "cannot be read as UTF-8 JSON" };
  }
  if (!isRecord(parsed)) return { ok: false, reason: "is not a JSON object of at most 64 KiB" };
  if (Object.hasOwn(parsed, "service_account_impersonation_url")) return { ok: false, reason: "carries its own service account impersonation (impersonation is the identity's GOOGLE_IMPERSONATE_SERVICE_ACCOUNT only)" };
  if (parsed.type !== "external_account") return { ok: false, reason: "is not an external_account (workload identity federation) configuration" };
  if (Object.keys(parsed).some((key) => !CONFIGURATION_KEYS.has(key))) return { ok: false, reason: "holds a key a workload identity federation file source does not need" };
  if (typeof parsed.audience !== "string" || !WIF_AUDIENCE.test(parsed.audience)) return { ok: false, reason: "does not name a workload identity pool provider as its audience" };
  if (typeof parsed.subject_token_type !== "string" || !OIDC_SUBJECT_TOKEN.test(parsed.subject_token_type)) return { ok: false, reason: "does not exchange an OIDC token" };
  if (parsed.token_url !== undefined && parsed.token_url !== STS_TOKEN_URL) return { ok: false, reason: "sends its token somewhere other than Google's security token service" };
  if (parsed.universe_domain !== undefined && parsed.universe_domain !== "googleapis.com") return { ok: false, reason: "names another universe domain" };
  const source = parsed.credential_source;
  if (!isRecord(source) || Object.keys(source).some((key) => !SOURCE_KEYS.has(key))) return { ok: false, reason: "does not read its token from a file only" };
  if (typeof source.file !== "string" || !CREDENTIAL_FILE.test(source.file)) return { ok: false, reason: "does not name an absolute token file path" };
  if (source.format !== undefined && !(isRecord(source.format) && source.format.type === "text" && Object.keys(source.format).length === 1)) return { ok: false, reason: "reads its token in a format other than plain text" };
  return { ok: true, tokenFile: source.file, audience: parsed.audience, subjectTokenType: parsed.subject_token_type };
}
