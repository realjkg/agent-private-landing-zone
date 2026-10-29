import { closeSync, constants, fstatSync, openSync, readSync, statSync } from "node:fs";

/**
 * Google workload identity federation credentials, judged the one way the pilot judges them (docs/act-pilot-gcp-terraform-g0.md).
 * The provider spec (src/apply/providers/gcp.ts) refuses an identity whose configuration fails `checkCredentialConfiguration`, and the
 * GCP reader (src/observe/gcp-rest.ts) refuses to exchange one. This module sits outside src/apply so the reader can share it
 * without reaching the apply path (test/apply-boundary.test.ts). The checks read a file and return a verdict. The token exchange
 * below contacts nothing itself: it sends only through the caller's own gated sender.
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
/** The security token service's token endpoint, the only `token_url` a credential configuration may name and the only one the exchange posts to. */
export const STS_TOKEN_URL = "https://sts.googleapis.com/v1/token";
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
 * hang the read waiting for a writer (the descriptor's own `fstat` then refuses it), and `O_NOCTTY` keeps a terminal swapped in
 * from becoming the process's controlling terminal (review N6 of #320). A device, a socket or a directory is refused
 * the same way, and so is a file larger than `max`. Throws only what `stat` or `open` throws (a missing file, a denied read).
 */
export function readRegularFile(path: string, max: number): Buffer | undefined {
  if (!statSync(path).isFile()) return undefined;
  const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOCTTY);
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

/* ------------------------------------------------------------------ the one token exchange (D20) */

/**
 * The token exchange and the impersonation, one implementation for every GCP reader and engine (docs/act-pilot-gcp-api-driver.md
 * D20): the path-6 engine (src/apply/engines/gcp-api.ts) and the independent reader (src/observe/gcp-rest.ts) both call these, so
 * they cannot disagree on the wire format again. Each caller sends through its own gated sender (its host allowlist decides
 * whether a request leaves at all) and maps a failure to its own refusal class; the scope and the lifetime are the caller's.
 *
 * Wire format, checked offline on 2026-10-29 against Google's published sources (no Google API endpoint was called):
 * - Google's discovery document for the Security Token Service, `sts:v1` revision 20261014, as mirrored in
 *   https://raw.githubusercontent.com/googleapis/google-api-go-client/main/sts/v1/sts-api.json: method `sts.token`, `POST v1/token`,
 *   request `GoogleIdentityStsV1ExchangeTokenRequest` (`grantType` must be `urn:ietf:params:oauth:grant-type:token-exchange`;
 *   `audience`; `scope`, space-delimited; `requestedTokenType` `urn:ietf:params:oauth:token-type:access_token`; `subjectToken`;
 *   `subjectTokenType` `...:jwt` or `...:id_token`), response `access_token`, `issued_token_type`, `token_type`, `expires_in`; the
 *   caller must not send an `Authorization` header.
 * - Google's own Node.js auth library, https://raw.githubusercontent.com/googleapis/google-auth-library-nodejs/main/src/auth/stscredentials.ts,
 *   sends the same request form-encoded with the RFC 8693 snake_case names (`grant_type`, `audience`, `scope`, `requested_token_type`,
 *   `subject_token`, `subject_token_type`) and reads `access_token`; the EMULATED run showed Google's Go library (the google provider
 *   and the gcs backend) sending the same form.
 * - The IAM Credentials discovery document, `iamcredentials:v1` revision 20260630, as mirrored in
 *   https://raw.githubusercontent.com/googleapis/google-api-go-client/main/iamcredentials/v1/iamcredentials-api.json: `POST
 *   v1/{+name}:generateAccessToken`, name `projects/-/serviceAccounts/<email>` (the `-` wildcard is required), request JSON
 *   `{ "scope": [...], "lifetime": "<seconds>s" }`, response `accessToken` and `expireTime`.
 * The exchange is sent form-encoded with snake_case names, as Google's own libraries send it. The discovery document describes the
 * same request as a JSON body with camelCase names; only one encoding is used here. Google's page at
 * https://docs.cloud.google.com/iam/docs/reference/sts/rest/v1/TopLevel/token could not be read from this session (its host is
 * outside the session's network allowlist). What Google accepts is shown only by the owner's live DEV run (GF1).
 */
export type GcpTokenRequest = { method: "POST"; url: string; headers: Readonly<Record<string, string>>; body: string };
export type GcpTokenResponse = { status: number; body: string };
/** The caller's gated sender. Status 0 means not sent or no answer; a caller's gate answers `HOST_REFUSED` in the body when it refused. */
export type GcpTokenSender = (request: GcpTokenRequest) => Promise<GcpTokenResponse>;
/**
 * A failed step: the status the service answered (0: not sent or no answer), whether the caller's gate refused the request before
 * it existed, and whether a 200 answer carried no usable token. Never the answer's body, which can quote a token.
 */
export type GcpTokenFailure = { ok: false; step: "EXCHANGE" | "IMPERSONATE"; status: number; hostRefused: boolean; malformed: boolean };
export type GcpTokenResult = { ok: true; token: string } | GcpTokenFailure;

const EXCHANGE_GRANT = "urn:ietf:params:oauth:grant-type:token-exchange";
const ACCESS_TOKEN_TYPE = "urn:ietf:params:oauth:token-type:access_token";
const IAM_CREDENTIALS = "https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/";

/** The generateAccessToken URL of one service account, with the `-` project wildcard the API requires. */
export const generateAccessTokenUrl = (serviceAccount: string): string => IAM_CREDENTIALS + serviceAccount + ":generateAccessToken";

function tokenOf(response: GcpTokenResponse, field: string, step: GcpTokenFailure["step"]): GcpTokenResult {
  const failed = (malformed: boolean): GcpTokenFailure => ({ ok: false, step, status: response.status, hostRefused: response.status === 0 && response.body === "HOST_REFUSED", malformed });
  if (response.status !== 200) return failed(false);
  try {
    const value = (JSON.parse(response.body) as Record<string, unknown>)[field];
    return typeof value === "string" && value !== "" && !/\s/.test(value) ? { ok: true, token: value } : failed(true);
  } catch { return failed(true); }
}

/** Exchanges an identity's OIDC subject token at the security token service for a federated access token. No Authorization header is sent. */
export async function exchangeSubjectToken(send: GcpTokenSender, input: { audience: string; subjectTokenType: string; subjectToken: string; scope: string }): Promise<GcpTokenResult> {
  const response = await send({
    method: "POST", url: STS_TOKEN_URL, headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: EXCHANGE_GRANT, audience: input.audience, scope: input.scope, requested_token_type: ACCESS_TOKEN_TYPE,
      subject_token: input.subjectToken, subject_token_type: input.subjectTokenType,
    }).toString(),
  });
  return tokenOf(response, "access_token", "EXCHANGE");
}

/** Uses a federated token once to get the identity's service account's access token, with exactly the caller's scopes and lifetime. */
export async function impersonateServiceAccount(send: GcpTokenSender, input: { federatedToken: string; serviceAccount: string; scopes: readonly string[]; lifetime: string }): Promise<GcpTokenResult> {
  if (!SERVICE_ACCOUNT.test(input.serviceAccount) || !/^[0-9]{1,5}s$/.test(input.lifetime) || input.scopes.length === 0) {
    return { ok: false, step: "IMPERSONATE", status: 0, hostRefused: true, malformed: false };
  }
  const response = await send({
    method: "POST", url: generateAccessTokenUrl(input.serviceAccount),
    headers: { authorization: "Bearer " + input.federatedToken, "content-type": "application/json" },
    body: JSON.stringify({ scope: [...input.scopes], lifetime: input.lifetime }),
  });
  return tokenOf(response, "accessToken", "IMPERSONATE");
}
