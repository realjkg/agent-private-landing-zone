
import { checkCredentialConfiguration, exchangeSubjectToken, generateAccessTokenUrl, impersonateServiceAccount, projectOfServiceAccount, readTokenFile, STS_TOKEN_URL, type GcpTokenFailure } from "../tools/gcp-credentials.js";
import { identityVariables } from "../tools/identity.js";
import { ALZ_TAG_KEYS } from "../teardown/unit.js";
import type { BlueprintEntry } from "./blueprint.js";
import type { ResourceCheck, ResourceReader, VerifierId } from "./verify.js";

/**
 * The GCP reader (docs/observe-and-cleanup.md; the GCP release-path PLAN, section 4, owner approval 6433121154 on issue #39):
 * Google's REST APIs, read in process, as the DISCOVERY identity. No `gcloud` runs, so no credential ever reaches a process
 * argument list, a child environment, a log or an evidence digest. It is the Azure reader's pattern (src/observe/azure-rest.ts).
 *
 * Wired: `VerifierId` (src/observe/verify.ts) names "GCP_REST", and `openReader` (src/apply/observe.ts) opens this reader for a
 * GCP contract's target project.
 *
 * Credential handling, as the provider spec admits it: DISCOVERY's credential configuration
 * (`ALZ_DISCOVERY_GOOGLE_APPLICATION_CREDENTIALS`) must pass the same check the spec runs (src/tools/gcp-credentials.ts, shared
 * so this module never imports the apply path) (an external_account file source, no
 * key, no impersonation URL of its own). Its OIDC token file is read once and exchanged, in the body of one HTTPS POST to Google's
 * security token service, for a federated token; that token, in one HTTPS POST to the IAM Credentials API, is exchanged for a
 * short-lived access token of DISCOVERY's service account (`ALZ_DISCOVERY_GOOGLE_IMPERSONATE_SERVICE_ACCOUNT`). D15 (G1): one
 * federated exchange, then one access token per read host, each with that host's own scope (`READ_SCOPES`) and used on that host
 * only. All of them live in this module's memory for one observation and are dropped with it. They never appear in a record, a
 * message or an error: failures are recorded as classes.
 *
 * Scopes (D15, part of owner decision D12, 6483366237). Pub/Sub gets `https://www.googleapis.com/auth/pubsub`: the Pub/Sub v1
 * discovery document (revision 20261006, read offline) lists only `cloud-platform` and `pubsub` on `topics.get`, so the read-only
 * cloud-platform scope this reader used to request would have been refused and every topic check would have read UNKNOWN (GF2).
 * The pubsub scope is not read-only: DISCOVERY's read-only property rests on its IAM grant (`pubsub.topics.get` only,
 * bootstrap/gcp), not on the OAuth scope. Cloud Asset gets `cloud-platform`: whether `searchAllResources` accepts the narrower
 * `cloud-platform.read-only` is UNVERIFIED (GF3), so the scope that certainly works is requested and DISCOVERY's grant
 * (`cloudasset.assets.searchAllResources` on the project only) is what keeps it read-only; once GF3 is verified, the narrower scope
 * is one constant below. The exchange itself asks for `cloud-platform`, the scope Google's own Go auth library sends there (seen in
 * the EMULATED run of test/apply-emulated-gcp.test.ts; what Google accepts is GF8, UNVERIFIED).
 *
 * D11 read-back (G1): for `google_pubsub_topic`, when the reader is given the contract's region (`storagePolicyRegion`), the
 * topic's `messageStoragePolicy.allowedPersistenceRegions` must be exactly that one region. `openReader` (src/apply/observe.ts)
 * passes the contract target's region. A different value is PRESENT and `misplaced` (the shared check of #343): the observation
 * FAILS and the resource is DIFFERENT_FROM_DESIRED, so no cleanup is proposed. A missing or unreadable policy is UNKNOWN
 * (STORAGE_POLICY_NOT_READ), never assumed. This names one Pub/Sub property; it is not a data-residency claim.
 *
 * Requests: the two POSTs above, each to its one exact URL, and GETs over https to the read hosts only (`READ_HOSTS`). Nothing
 * else is sent: another host, scheme, port or userinfo, or a path the URL parser would rewrite, is refused before a request exists,
 * so a token never travels in cleartext, to the wrong service, or about a different resource. Only existence and identifiers are
 * kept from an answer.
 *
 * The token exchange and the impersonation are the shared ones (src/tools/gcp-credentials.ts, D20), whose request shapes were
 * checked offline against Google's discovery documents and auth library (GF1 stays open until the owner's live run).
 * UNVERIFIED (from memory, as the PLAN marks them): the scopes Cloud Asset
 * accepts (GF3); and Cloud Asset Inventory's `searchAllResources` query syntax `labels.<key>=<value>` and its eventual consistency
 * (minutes, GF5). A resource the
 * state names that the sweep does not yet list is no failure; a listed resource the state does not name is one, as on AWS and Azure.
 */
export type GcpRequest = { method: "GET" | "POST"; url: string; headers: Readonly<Record<string, string>>; body?: string };
export type GcpResponse = { status: number; body: string };
/** The HTTP client the reader uses. Production: `fetch`. Tests inject a scripted one. */
export type GcpHttp = (request: GcpRequest) => Promise<GcpResponse>;

/** The verifier id this reader reports. */
export const GCP_VERIFIER = "GCP_REST" satisfies VerifierId;
export type GcpResourceReader = Omit<ResourceReader, "verifier"> & { verifier: typeof GCP_VERIFIER };

const PUBSUB_HOST = "pubsub.googleapis.com";
const ASSET_HOST = "cloudasset.googleapis.com";
/** Where a GET with DISCOVERY's access token may go. Each host is one the reader has a use for, and nothing else. */
const READ_HOSTS: ReadonlySet<string> = new Set([PUBSUB_HOST, ASSET_HOST]);
/** The one scope each read host's token carries (D15). A token is minted per host and sent to that host only. */
export const READ_SCOPES: Readonly<Record<string, string>> = {
  [PUBSUB_HOST]: "https://www.googleapis.com/auth/pubsub",
  [ASSET_HOST]: "https://www.googleapis.com/auth/cloud-platform",
};
/** The scope the federated exchange asks for (GF8, UNVERIFIED): what Google's Go auth library sends. */
const EXCHANGE_SCOPE = "https://www.googleapis.com/auth/cloud-platform";
const PROJECT_ID = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;
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
  /**
   * The contract's region, when the topic's storage policy is to be read back (D11, R2): every `google_pubsub_topic` checked must
   * report exactly `[region]` as its `messageStoragePolicy.allowedPersistenceRegions`. Unset, the policy is not read.
   */
  storagePolicyRegion?: string;
  http?: GcpHttp;
};

/** The reader's class for a failed impersonation: the same classes it always gave. */
const readerFailure = (failure: GcpTokenFailure): { failed: GcpErrorClass } =>
  ({ failed: failure.invalidInput ? "CREDENTIALS" : failure.malformed ? "UNEXPECTED_RESPONSE" : failure.status === 0 ? "HOST_REFUSED" : classOf(failure.status) });

/** The GCP reader bound to DISCOVERY. `close` drops the tokens; call it when the observation is done. */
export function createDiscoveryGcpReader(options: DiscoveryGcpOptions): { reader: GcpResourceReader; close(): void } {
  const http = options.http ?? fetchGcpHttp;
  const env = options.env ?? process.env;
  if (!PROJECT_ID.test(options.projectId)) throw new Error("GCP_PROJECT_INVALID");
  const project = options.projectId;
  const region = options.storagePolicyRegion;
  if (region !== undefined && !/^[a-z]+-[a-z]+[0-9]{1,2}$/.test(region)) throw new Error("GCP_REGION_INVALID");
  type Access = { token: string } | { failed: GcpErrorClass };
  /** The federated token, once per observation; then one access token per read host, each minted with that host's scope. */
  let federation: Access | undefined;
  const access = new Map<string, Access>();
  let closed = false;

  /** The one gate every request passes. `allowedPost` is the one URL a POST may go to; a GET goes to a read host only. */
  const send = async (request: GcpRequest, allowedPost?: string): Promise<GcpResponse> => {
    const allowed = request.method === "POST"
      ? allowedPost !== undefined && request.url === allowedPost && /^https:\/\/(sts|iamcredentials)\.googleapis\.com\//.test(request.url) && sentAsWritten(request.url)
      : httpsOn(request.url, READ_HOSTS) && sentAsWritten(request.url);
    if (!allowed) return { status: 0, body: "HOST_REFUSED" };
    return http(request);
  };


  /** The federated token: DISCOVERY's OIDC token exchanged once at the security token service. It never leaves this closure. */
  const federated = async (): Promise<Access> => {
    if (federation) return federation;
    const identity = discoveryIdentity(env, project);
    if (!identity.ok) return (federation = { failed: "CREDENTIALS" });
    const subjectToken = readTokenFile(identity.tokenFile);
    if (subjectToken === undefined) return (federation = { failed: "CREDENTIALS" });
    // The one exchange (src/tools/gcp-credentials.ts, D20), through this reader's gate: a POST to the one STS URL only.
    const exchange = await exchangeSubjectToken((request) => send(request, STS_TOKEN_URL), { audience: identity.audience, subjectTokenType: identity.subjectTokenType, subjectToken, scope: EXCHANGE_SCOPE });
    if (!exchange.ok) {
      return (federation = { failed: exchange.malformed ? "UNEXPECTED_RESPONSE" : exchange.status === 400 || exchange.status === 401 ? "CREDENTIALS" : exchange.status === 0 ? "HOST_REFUSED" : classOf(exchange.status) });
    }
    return (federation = { token: exchange.token });
  };

  /** DISCOVERY's access token for one read host, with that host's scope only: OIDC token, federated token, then the service account's token. */
  const bearer = async (host: string): Promise<Access> => {
    if (closed) return { failed: "READER_CLOSED" };
    const minted = access.get(host);
    if (minted) return minted;
    const scope = Object.hasOwn(READ_SCOPES, host) ? READ_SCOPES[host] : undefined;
    if (scope === undefined) return { failed: "HOST_REFUSED" };
    const identity = discoveryIdentity(env, project);
    if (!identity.ok) return { failed: "CREDENTIALS" };
    const exchanged = await federated();
    if ("failed" in exchanged) { access.set(host, exchanged); return exchanged; }
    const impersonate = generateAccessTokenUrl(identity.serviceAccount);
    // The one impersonation (D20), through this reader's gate: a POST to this service account's generateAccessToken URL only.
    const generated = await impersonateServiceAccount((request) => send(request, impersonate), { federatedToken: exchanged.token, serviceAccount: identity.serviceAccount, scopes: [scope], lifetime: "900s" });
    const result: Access = generated.ok ? { token: generated.token } : readerFailure(generated);
    access.set(host, result);
    return result;
  };

  const get = async (url: string): Promise<GcpResponse | { failed: GcpErrorClass }> => {
    let host: string;
    try { host = new URL(url).hostname; } catch { return { failed: "HOST_REFUSED" }; }
    if (!READ_HOSTS.has(host)) return { failed: "HOST_REFUSED" };
    const auth = await bearer(host);
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
    let body: { name?: unknown; messageStoragePolicy?: unknown };
    try { body = JSON.parse(response.body) as typeof body; } catch { return { ...base, identifier, existence: "UNKNOWN", reason: "UNEXPECTED_RESPONSE" }; }
    // The facts ever read from the answer: that it names the resource that was asked about and, for a topic when a region is
    // given, the regions its storage policy allows (D11). Nothing else is kept.
    if (typeof body !== "object" || body === null || body.name !== identifier) return { ...base, identifier, existence: "UNKNOWN", reason: "UNEXPECTED_RESPONSE" };
    if (region === undefined || entry.type !== "google_pubsub_topic") return { ...base, identifier, existence: "PRESENT" };
    const policy = body.messageStoragePolicy;
    const regions = typeof policy === "object" && policy !== null ? (policy as { allowedPersistenceRegions?: unknown }).allowedPersistenceRegions : undefined;
    if (!Array.isArray(regions) || !regions.every((item) => typeof item === "string")) return { ...base, identifier, existence: "UNKNOWN", reason: "STORAGE_POLICY_NOT_READ" };
    return regions.length === 1 && regions[0] === region ? { ...base, identifier, existence: "PRESENT" }
      : { ...base, identifier, existence: "PRESENT", misplaced: true };
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
    close: () => { closed = true; federation = undefined; access.clear(); },
  };
}
