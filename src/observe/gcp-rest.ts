import { closeSync, fstatSync, openSync, readSync } from "node:fs";

import { checkCredentialConfiguration, projectOfServiceAccount } from "../tools/gcp-credentials.js";
import { identityVariables } from "../tools/identity.js";
import { ALZ_TAG_KEYS } from "../teardown/unit.js";
import type { BlueprintEntry } from "./blueprint.js";
import type { ResourceCheck, ResourceReader } from "./verify.js";

/**
 * The GCP reader (docs/observe-and-cleanup.md; the GCP release-path PLAN, section 4, owner approval 6433121154 on issue #39):
 * Google's REST APIs, read in process, as the DISCOVERY identity. No `gcloud` runs, so no credential ever reaches a process
 * argument list, a child environment, a log or an evidence digest. It is the Azure reader's pattern (src/observe/azure-rest.ts).
 *
 * NOT YET WIRED. `VerifierId` (src/observe/verify.ts), `openReader` (src/apply/observe.ts) and the run records name the AWS and
 * Azure readers only, and GCP is not an admitted provider (src/apply/providers/gcp.ts). The reader is typed `GcpResourceReader`
 * so the wiring is `VerifierId` gaining "GCP_REST" and `openReader` gaining a GCP branch, with no change here.
 *
 * Credential handling, as the provider spec admits it: DISCOVERY's credential configuration
 * (`ALZ_DISCOVERY_GOOGLE_APPLICATION_CREDENTIALS`) must pass the same check the spec runs (src/tools/gcp-credentials.ts, shared
 * so this module never imports the apply path) (an external_account file source, no
 * key, no impersonation URL of its own). Its OIDC token file is read once and exchanged, in the body of one HTTPS POST to Google's
 * security token service, for a federated token; that token, in one HTTPS POST to the IAM Credentials API, is exchanged for a
 * short-lived access token of DISCOVERY's service account (`ALZ_DISCOVERY_GOOGLE_IMPERSONATE_SERVICE_ACCOUNT`), with the
 * read-only cloud-platform scope. All three live in this module's memory for one observation and are dropped with it. They never
 * appear in a record, a message or an error: failures are recorded as classes.
 *
 * Requests: the two POSTs above, each to its one exact URL, and GETs over https to the read hosts only (`READ_HOSTS`). Nothing
 * else is sent: another host, scheme, port or userinfo, or a path the URL parser would rewrite, is refused before a request exists,
 * so a token never travels in cleartext, to the wrong service, or about a different resource. Only existence and identifiers are
 * kept from an answer.
 *
 * UNVERIFIED (from memory, as the PLAN marks them): the token-exchange and generateAccessToken request shapes; that Pub/Sub's
 * `topics.get` accepts the cloud-platform.read-only scope (if it does not, every check reads UNKNOWN, which fails closed); and Cloud
 * Asset Inventory's `searchAllResources` query syntax `labels.<key>=<value>` and its eventual consistency (minutes). A resource the
 * state names that the sweep does not yet list is no failure; a listed resource the state does not name is one, as on AWS and Azure.
 */
export type GcpRequest = { method: "GET" | "POST"; url: string; headers: Readonly<Record<string, string>>; body?: string };
export type GcpResponse = { status: number; body: string };
/** The HTTP client the reader uses. Production: `fetch`. Tests inject a scripted one. */
export type GcpHttp = (request: GcpRequest) => Promise<GcpResponse>;

/** The verifier id this reader reports. `VerifierId` gains it when GCP is wired. */
export const GCP_VERIFIER = "GCP_REST";
export type GcpResourceReader = Omit<ResourceReader, "verifier"> & { verifier: typeof GCP_VERIFIER };

const STS_TOKEN_URL = "https://sts.googleapis.com/v1/token";
const IAM_CREDENTIALS_HOST = "iamcredentials.googleapis.com";
const PUBSUB_HOST = "pubsub.googleapis.com";
const ASSET_HOST = "cloudasset.googleapis.com";
/** Where a GET with DISCOVERY's access token may go. Each host is one the reader has a use for, and nothing else. */
const READ_HOSTS: ReadonlySet<string> = new Set([PUBSUB_HOST, ASSET_HOST]);
const SCOPE = "https://www.googleapis.com/auth/cloud-platform.read-only";
const PROJECT_ID = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;
const MAX_TOKEN_FILE = 16 * 1024;
const MAX_PAGES = 50;

/**
 * The Terraform types the reader can check, each by the id the google provider records, and the GET that asks about exactly that
 * resource. The table is the minimal workload's (one labeled Pub/Sub topic) and DISCOVERY's grant (`pubsub.topics.get`,
 * bootstrap/gcp). A type the table does not name is NOT_CHECKABLE, never assumed: it joins the table, with its grant, by review.
 */
export const GCP_READ_TYPES: Readonly<Record<string, { host: string; id: RegExp }>> = {
  // projects/<project>/topics/<topic>; a topic name is 3 to 255 characters starting with a letter, never "goog", and the reader refuses `%` (a URL escape).
  google_pubsub_topic: { host: PUBSUB_HOST, id: /^projects\/([a-z][a-z0-9-]{4,28}[a-z0-9])\/topics\/(?!goog)[A-Za-z][A-Za-z0-9._~+-]{2,254}$/ },
};

export type GcpErrorClass = "ACCESS_DENIED" | "THROTTLED" | "CREDENTIALS" | "HTTP_ERROR" | "HOST_REFUSED" | "UNEXPECTED_RESPONSE" | "READER_CLOSED";
const classOf = (status: number): GcpErrorClass => status === 401 ? "CREDENTIALS" : status === 403 ? "ACCESS_DENIED" : status === 429 ? "THROTTLED" : "HTTP_ERROR";

/** The default client: `fetch`, with the response read as text and no redirect followed. Any failure is a status of 0 and an empty body. */
export const fetchGcpHttp: GcpHttp = async (request) => {
  try {
    const response = await fetch(request.url, { method: request.method, headers: { ...request.headers }, body: request.body, redirect: "error" });
    return { status: response.status, body: await response.text() };
  } catch {
    return { status: 0, body: "" };
  }
};

/** An https URL on exactly this host: no other scheme, no port, no userinfo, no fragment. */
const httpsOn = (url: string, hosts: ReadonlySet<string>): boolean => {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && hosts.has(parsed.hostname) && parsed.port === "" && parsed.username === "" && parsed.password === "" && parsed.hash === "";
  } catch { return false; }
};
/** The path of a URL exactly as written, before any parsing normalizes it. */
const rawPathOf = (url: string): string | undefined => /^https:\/\/[^/?#]*([^?#]*)/.exec(url)?.[1];
/** Whether a URL's path is sent exactly as written: the parser would not rewrite it (no `.`/`..` segment, escape, backslash or control character). */
const sentAsWritten = (url: string): boolean => {
  const raw = rawPathOf(url);
  try { return raw !== undefined && !/[\\%\s\u0000-\u001f\u007f]/.test(raw) && new URL(url).pathname === raw; } catch { return false; }
};

function readTokenFile(path: string): string | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_TOKEN_FILE) return undefined;
    const buffer = Buffer.alloc(MAX_TOKEN_FILE + 1);
    const length = readSync(fd, buffer, 0, buffer.length, 0);
    const token = buffer.subarray(0, length).toString("utf8").trim();
    return length <= MAX_TOKEN_FILE && token !== "" && !/\s/.test(token) ? token : undefined;
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** DISCOVERY's facts, checked as the provider spec checks them, or the class of why none can be used. */
function discoveryIdentity(env: NodeJS.ProcessEnv, projectId: string):
  { ok: true; serviceAccount: string; tokenFile: string; audience: string; subjectTokenType: string } | { ok: false } {
  const variables = identityVariables(env, "DISCOVERY");
  const serviceAccount = variables.get("GOOGLE_IMPERSONATE_SERVICE_ACCOUNT") ?? "";
  if (projectOfServiceAccount(serviceAccount) !== projectId) return { ok: false };
  const configuration = checkCredentialConfiguration(variables.get("GOOGLE_APPLICATION_CREDENTIALS") ?? "");
  if (!configuration.ok) return { ok: false };
  return { ok: true, serviceAccount, tokenFile: configuration.tokenFile, audience: configuration.audience, subjectTokenType: configuration.subjectTokenType };
}

export type DiscoveryGcpOptions = {
  /** The runner's environment, holding `ALZ_DISCOVERY_GOOGLE_*`. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** The project the contract's target names; every read is scoped to it, and DISCOVERY's service account must be of it. */
  projectId: string;
  http?: GcpHttp;
};

/** The GCP reader bound to DISCOVERY. `close` drops the tokens; call it when the observation is done. */
export function createDiscoveryGcpReader(options: DiscoveryGcpOptions): { reader: GcpResourceReader; close(): void } {
  const http = options.http ?? fetchGcpHttp;
  const env = options.env ?? process.env;
  if (!PROJECT_ID.test(options.projectId)) throw new Error("GCP_PROJECT_INVALID");
  const project = options.projectId;
  let access: { token: string } | { failed: GcpErrorClass } | undefined;
  let closed = false;

  /** The one gate every request passes. `allowedPost` is the one URL a POST may go to; a GET goes to a read host only. */
  const send = async (request: GcpRequest, allowedPost?: string): Promise<GcpResponse> => {
    const allowed = request.method === "POST"
      ? allowedPost !== undefined && request.url === allowedPost && /^https:\/\/(sts|iamcredentials)\.googleapis\.com\//.test(request.url) && sentAsWritten(request.url)
      : httpsOn(request.url, READ_HOSTS) && sentAsWritten(request.url);
    if (!allowed) return { status: 0, body: "HOST_REFUSED" };
    return http(request);
  };

  const tokenFrom = (body: string, field: string): string | undefined => {
    try {
      const value = (JSON.parse(body) as Record<string, unknown>)[field];
      return typeof value === "string" && value !== "" && !/\s/.test(value) ? value : undefined;
    } catch { return undefined; }
  };

  /** DISCOVERY's access token: OIDC token, then federated token, then the service account's token. None leaves this closure. */
  const bearer = async (): Promise<{ token: string } | { failed: GcpErrorClass }> => {
    if (closed) return { failed: "READER_CLOSED" };
    if (access) return access;
    const identity = discoveryIdentity(env, project);
    if (!identity.ok) return (access = { failed: "CREDENTIALS" });
    const subjectToken = readTokenFile(identity.tokenFile);
    if (subjectToken === undefined) return (access = { failed: "CREDENTIALS" });
    const exchange = await send({
      method: "POST", url: STS_TOKEN_URL, headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:token-exchange", audience: identity.audience, scope: "https://www.googleapis.com/auth/cloud-platform",
        requested_token_type: "urn:ietf:params:oauth:token-type:access_token", subject_token: subjectToken, subject_token_type: identity.subjectTokenType,
      }).toString(),
    }, STS_TOKEN_URL);
    if (exchange.status !== 200) return (access = { failed: exchange.status === 400 || exchange.status === 401 ? "CREDENTIALS" : exchange.status === 0 ? "HOST_REFUSED" : classOf(exchange.status) });
    const federated = tokenFrom(exchange.body, "access_token");
    if (federated === undefined) return (access = { failed: "UNEXPECTED_RESPONSE" });
    const impersonate = "https://" + IAM_CREDENTIALS_HOST + "/v1/projects/-/serviceAccounts/" + identity.serviceAccount + ":generateAccessToken";
    const generated = await send({
      method: "POST", url: impersonate, headers: { authorization: "Bearer " + federated, "content-type": "application/json" },
      body: JSON.stringify({ scope: [SCOPE], lifetime: "900s" }),
    }, impersonate);
    if (generated.status !== 200) return (access = { failed: generated.status === 0 ? "HOST_REFUSED" : classOf(generated.status) });
    const token = tokenFrom(generated.body, "accessToken");
    return (access = token === undefined ? { failed: "UNEXPECTED_RESPONSE" } : { token });
  };

  const get = async (url: string): Promise<GcpResponse | { failed: GcpErrorClass }> => {
    const auth = await bearer();
    if ("failed" in auth) return auth;
    const response = await send({ method: "GET", url, headers: { authorization: "Bearer " + auth.token, accept: "application/json" } });
    if (response.status === 0) return { failed: response.body === "HOST_REFUSED" ? "HOST_REFUSED" : "HTTP_ERROR" };
    return response;
  };

  const check = async (entry: BlueprintEntry): Promise<ResourceCheck> => {
    const base = { address: entry.address, type: entry.type };
    const identifier = entry.id;
    if (identifier === null) return { ...base, identifier: null, existence: "NOT_CHECKABLE", reason: "NO_IDENTIFIER_IN_STATE" };
    const mapping = Object.hasOwn(GCP_READ_TYPES, entry.type) ? GCP_READ_TYPES[entry.type] : undefined;
    if (!mapping) return { ...base, identifier, existence: "NOT_CHECKABLE", reason: "NO_GCP_READ_MAPPING" };
    const match = mapping.id.exec(identifier);
    if (!match) return { ...base, identifier, existence: "NOT_CHECKABLE", reason: "NOT_A_GCP_RESOURCE_NAME" };
    if (match[1] !== project) return { ...base, identifier, existence: "NOT_CHECKABLE", reason: "OUTSIDE_TARGET_PROJECT" };
    const url = "https://" + mapping.host + "/v1/" + identifier;
    if (!sentAsWritten(url)) return { ...base, identifier, existence: "NOT_CHECKABLE", reason: "NOT_A_GCP_RESOURCE_NAME" };
    const response = await get(url);
    if ("failed" in response) return { ...base, identifier, existence: "UNKNOWN", reason: response.failed };
    if (response.status === 404) return { ...base, identifier, existence: "ABSENT" };
    if (response.status !== 200) return { ...base, identifier, existence: "UNKNOWN", reason: classOf(response.status) };
    try {
      // The one fact ever read from the answer: that it names the resource that was asked about.
      if ((JSON.parse(response.body) as { name?: unknown }).name === identifier) return { ...base, identifier, existence: "PRESENT" };
    } catch { /* falls through */ }
    return { ...base, identifier, existence: "UNKNOWN", reason: "UNEXPECTED_RESPONSE" };
  };

  /**
   * Every resource in the project carrying the unit label, from Cloud Asset Inventory, every page, by name only. An asset name
   * `//<service>.googleapis.com/<resource name>` is reported as the resource name the google provider records as its id (a
   * topic's `projects/<p>/topics/<t>`), so the sweep compares with the state; any other name is reported as written, so it is a
   * stray rather than silently matched. A page that is not an object whose `results` (when present) is an array of items with a
   * non-empty string `name` fails the listing, so a malformed answer never reads as "nothing here". A page token is followed
   * only with the same query; anything else ends the listing as incomplete.
   */
  const listTagged = async (unitId: string): Promise<{ identifiers: string[]; complete: boolean } | undefined> => {
    if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(unitId)) return undefined;
    const first = "https://" + ASSET_HOST + "/v1/projects/" + project + ":searchAllResources?" +
      new URLSearchParams({ query: "labels." + ALZ_TAG_KEYS.unit + "=" + unitId, pageSize: "500" }).toString();
    const identifiers: string[] = [];
    let url = first;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const response = await get(url);
      if ("failed" in response || response.status !== 200) return undefined;
      let body: unknown;
      try { body = JSON.parse(response.body); } catch { return undefined; }
      if (typeof body !== "object" || body === null || Array.isArray(body)) return undefined;
      const { results, nextPageToken } = body as { results?: unknown; nextPageToken?: unknown };
      if (results !== undefined && !Array.isArray(results)) return undefined;
      for (const item of (results as unknown[] | undefined) ?? []) {
        const name = (item as { name?: unknown } | null)?.name;
        if (typeof name !== "string" || name === "") return undefined;
        const resource = /^\/\/[a-z0-9-]+\.googleapis\.com\/(.+)$/.exec(name);
        identifiers.push(resource ? resource[1] : name);
      }
      if (nextPageToken === undefined || nextPageToken === null || nextPageToken === "") return { identifiers: identifiers.sort(), complete: true };
      if (typeof nextPageToken !== "string" || !/^[A-Za-z0-9._~+/=-]{1,4096}$/.test(nextPageToken)) return { identifiers: identifiers.sort(), complete: false };
      url = first + "&" + new URLSearchParams({ pageToken: nextPageToken }).toString();
    }
    return { identifiers: identifiers.sort(), complete: false };
  };

  return {
    reader: { verifier: GCP_VERIFIER, check, listTagged },
    close: () => { closed = true; access = undefined; },
  };
}
