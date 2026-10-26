import { readFileSync } from "node:fs";

import { identityVariables } from "../tools/identity.js";
import { ALZ_TAG_KEYS } from "../teardown/unit.js";
import type { BlueprintEntry } from "./blueprint.js";
import type { ResourceCheck, ResourceReader } from "./verify.js";

/**
 * The Azure reader (docs/observe-and-cleanup.md, docs/act-pilot-plan.md "Cleanup of pilot-created resources"): Azure
 * Resource Manager's REST API, read in process, as the DISCOVERY identity. No `az` CLI runs, so no credential ever
 * reaches a process argument list, a child environment, a log or an evidence digest.
 *
 * Credential handling: the DISCOVERY identity's federated token is read from `ALZ_DISCOVERY_ARM_OIDC_TOKEN_FILE` and
 * exchanged once, in the body of one HTTPS POST to the tenant's token endpoint, for an access token scoped to
 * management.azure.com. Both tokens live in this module's memory for one observation and are dropped with it. They
 * never appear in a record, a message or an error: failures are recorded as classes.
 *
 * Requests: GETs against https://management.azure.com only (one resource by its ARM id, after reading the provider's API
 * versions; the subscription's resources and resource groups carrying the unit tag; a resource group's members), plus one
 * POST to the tenant's token endpoint on https://login.microsoftonline.com. Nothing else is sent: a URL on any other host,
 * scheme or port, with userinfo, or a GET to the login host, is refused before a request exists, so the bearer never
 * travels in cleartext or to the token service. Only existence and identifiers are kept from an answer.
 */
export type ArmRequest = { method: "GET" | "POST"; url: string; headers: Readonly<Record<string, string>>; body?: string };
export type ArmResponse = { status: number; body: string };
/** The HTTP client the reader uses. Production: `fetch`. Tests inject a scripted one. */
export type ArmHttp = (request: ArmRequest) => Promise<ArmResponse>;

const LOGIN_HOST = "login.microsoftonline.com";
const ARM_HOST = "management.azure.com";
const ARM = "https://" + ARM_HOST;
const RESOURCES_API = "2021-04-01";
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CLIENT_ID = /^[A-Za-z0-9._:/-]{1,128}$/;
/** An ARM id the reader can ask about: a resource group, or a resource under a provider namespace at subscription or resource-group scope. Anything else (a data-plane URL, a key vault secret, a directory object) is not checkable here. */
const RESOURCE_ID = /^\/subscriptions\/[0-9a-f-]{36}(?:\/resourceGroups\/[^/?#]+(?:\/providers\/[A-Za-z0-9.]+\/[^?#]+)?|\/providers\/[A-Za-z0-9.]+\/[^?#]+)$/i;
const GROUP_ID = /^\/subscriptions\/[0-9a-f-]{36}\/resourceGroups\/[^/?#]+$/i;

/**
 * Whether an ARM id's path is sent exactly as written: no empty, `.` or `..` segment, no backslash, no percent escape, no
 * whitespace or control character. URL parsing normalizes those before a request leaves, so an id from an engine's state
 * that carries them would make the reader ask about a different path and read its 404 as this resource's absence.
 */
export const armPathSafe = (id: string): boolean =>
  id.startsWith("/") && !/[\\%\s\u0000-\u001f\u007f]/.test(id) && id.slice(1).split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
/** An ARM resource id the reader can address: well-formed and sent exactly as written. */
export const isArmResourceId = (id: string): boolean => RESOURCE_ID.test(id) && armPathSafe(id);

export type ArmErrorClass = "ACCESS_DENIED" | "THROTTLED" | "CREDENTIALS" | "HTTP_ERROR" | "HOST_REFUSED" | "UNEXPECTED_RESPONSE" | "READER_CLOSED";

const classOf = (status: number): ArmErrorClass => status === 401 ? "CREDENTIALS" : status === 403 ? "ACCESS_DENIED" : status === 429 ? "THROTTLED" : "HTTP_ERROR";

/** The default client: `fetch`, with the response read as text. Any failure is reported as a status of 0 and an empty body. */
export const fetchArmHttp: ArmHttp = async (request) => {
  try {
    const response = await fetch(request.url, { method: request.method, headers: { ...request.headers }, body: request.body, redirect: "error" });
    return { status: response.status, body: await response.text() };
  } catch {
    return { status: 0, body: "" };
  }
};

export type DiscoveryArmOptions = {
  /** The runner's environment, holding `ALZ_DISCOVERY_ARM_*`. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** The subscription the contract's target names; every read is scoped to it. */
  subscriptionId: string;
  http?: ArmHttp;
};

/** The DISCOVERY identity's ARM facts, or the reason none can be used (a class, never a value). */
function discoveryIdentity(env: NodeJS.ProcessEnv): { ok: true; clientId: string; tenantId: string; tokenFile: string } | { ok: false; reason: ArmErrorClass } {
  const variables = identityVariables(env, "DISCOVERY");
  const clientId = variables.get("ARM_CLIENT_ID") ?? "";
  const tenantId = variables.get("ARM_TENANT_ID") ?? "";
  const tokenFile = variables.get("ARM_OIDC_TOKEN_FILE") ?? "";
  if (!CLIENT_ID.test(clientId) || !GUID.test(tenantId) || tokenFile === "" || tokenFile.includes("\u0000")) return { ok: false, reason: "CREDENTIALS" };
  return { ok: true, clientId, tenantId, tokenFile };
}

/** An https URL on exactly this host: no other scheme, no port, no userinfo. */
const httpsOn = (url: string, host: string): boolean => {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && parsed.hostname === host && parsed.port === "" && parsed.username === "" && parsed.password === "";
  } catch { return false; }
};
/** Where a GET with the bearer may go: management.azure.com over https, nowhere else (a nextLink is checked the same way). */
const armUrlAllowed = (url: string): boolean => httpsOn(url, ARM_HOST);

/** The resource type path of an ARM id: `Microsoft.Storage/storageAccounts` or `.../blobServices/containers`; the resource group when the id ends at the group. */
export function armTypeOf(id: string): { namespace: string; typePath: string } | undefined {
  const match = /\/providers\/([A-Za-z0-9.]+)\/(.+)$/.exec(id);
  if (!match) return /^\/subscriptions\/[0-9a-f-]{36}\/resourceGroups\/[^/?#]+$/i.test(id) ? { namespace: "Microsoft.Resources", typePath: "resourceGroups" } : undefined;
  const segments = match[2].split("/").filter((s) => s !== "");
  const typeSegments = segments.filter((_, index) => index % 2 === 0);
  return typeSegments.length === 0 || segments.length % 2 !== 0 ? undefined : { namespace: match[1], typePath: typeSegments.join("/") };
}

/** The Azure reader bound to DISCOVERY. `close` drops the tokens; call it when the observation is done. */
export function createDiscoveryArmReader(options: DiscoveryArmOptions): { reader: ResourceReader; close(): void } {
  const http = options.http ?? fetchArmHttp;
  const env = options.env ?? process.env;
  if (!GUID.test(options.subscriptionId)) throw new Error("ARM_SUBSCRIPTION_INVALID");
  const subscription = options.subscriptionId.toLowerCase();
  let access: { token: string } | { failed: ArmErrorClass } | undefined;
  let closed = false;
  const apiVersions = new Map<string, Promise<string | undefined>>();

  /** The one gate every request passes: a POST only to this tenant's token endpoint, a GET only to management.azure.com, both https. */
  const send = async (request: ArmRequest, tokenEndpoint?: string): Promise<ArmResponse> => {
    const allowed = request.method === "POST" ? tokenEndpoint !== undefined && request.url === tokenEndpoint && httpsOn(request.url, LOGIN_HOST) : armUrlAllowed(request.url);
    if (!allowed) return { status: 0, body: "HOST_REFUSED" };
    return http(request);
  };

  /** The access token for management.azure.com, exchanged once from the federated token. Neither token leaves this closure. */
  const bearer = async (): Promise<{ token: string } | { failed: ArmErrorClass }> => {
    if (closed) return { failed: "READER_CLOSED" };
    if (access) return access;
    const identity = discoveryIdentity(env);
    if (!identity.ok) return (access = { failed: identity.reason });
    let assertion: string;
    try { assertion = readFileSync(identity.tokenFile, "utf8").trim(); } catch { return (access = { failed: "CREDENTIALS" }); }
    if (assertion === "" || /\s/.test(assertion)) return (access = { failed: "CREDENTIALS" });
    const body = new URLSearchParams({
      client_id: identity.clientId, grant_type: "client_credentials", scope: ARM + "/.default",
      client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer", client_assertion: assertion,
    }).toString();
    const tokenEndpoint = "https://" + LOGIN_HOST + "/" + identity.tenantId + "/oauth2/v2.0/token";
    const response = await send({ method: "POST", url: tokenEndpoint, headers: { "content-type": "application/x-www-form-urlencoded" }, body }, tokenEndpoint);
    if (response.status !== 200) return (access = { failed: response.status === 400 || response.status === 401 ? "CREDENTIALS" : classOf(response.status) });
    try {
      const token = (JSON.parse(response.body) as { access_token?: unknown }).access_token;
      if (typeof token !== "string" || token === "") return (access = { failed: "UNEXPECTED_RESPONSE" });
      return (access = { token });
    } catch { return (access = { failed: "UNEXPECTED_RESPONSE" }); }
  };

  const get = async (url: string): Promise<ArmResponse | { failed: ArmErrorClass }> => {
    const auth = await bearer();
    if ("failed" in auth) return auth;
    const response = await send({ method: "GET", url, headers: { authorization: "Bearer " + auth.token, accept: "application/json" } });
    if (response.status === 0) return { failed: response.body === "HOST_REFUSED" ? "HOST_REFUSED" : "HTTP_ERROR" };
    return response;
  };

  /** The newest stable API version a provider offers for a type, read once per type; undefined when it cannot be read or the type has only preview versions (fail closed: TYPE_NOT_SUPPORTED). */
  const apiVersionFor = (namespace: string, typePath: string): Promise<string | undefined> => {
    if (namespace === "Microsoft.Resources" && typePath === "resourceGroups") return Promise.resolve(RESOURCES_API);
    const key = (namespace + "/" + typePath).toLowerCase();
    let pending = apiVersions.get(key);
    if (!pending) {
      pending = (async () => {
        const response = await get(ARM + "/subscriptions/" + subscription + "/providers/" + namespace + "?api-version=" + RESOURCES_API);
        if ("failed" in response || response.status !== 200) return undefined;
        try {
          const body = JSON.parse(response.body) as { resourceTypes?: { resourceType?: unknown; apiVersions?: unknown }[] };
          const found = (body.resourceTypes ?? []).find((t) => typeof t.resourceType === "string" && t.resourceType.toLowerCase() === typePath.toLowerCase());
          const versions = Array.isArray(found?.apiVersions) ? found!.apiVersions.filter((v): v is string => typeof v === "string") : [];
          return versions.find((v) => !/preview/i.test(v));
        } catch { return undefined; }
      })();
      apiVersions.set(key, pending);
    }
    return pending;
  };

  const check = async (entry: BlueprintEntry): Promise<ResourceCheck> => {
    const base = { address: entry.address, type: entry.type };
    const identifier = entry.id;
    if (identifier === null) return { ...base, identifier: null, existence: "NOT_CHECKABLE", reason: "NO_IDENTIFIER_IN_STATE" };
    const type = isArmResourceId(identifier) ? armTypeOf(identifier) : undefined;
    if (!type) return { ...base, identifier, existence: "NOT_CHECKABLE", reason: "NOT_AN_ARM_RESOURCE_ID" };
    if (!identifier.toLowerCase().startsWith("/subscriptions/" + subscription + "/")) return { ...base, identifier, existence: "NOT_CHECKABLE", reason: "OUTSIDE_TARGET_SUBSCRIPTION" };
    const version = await apiVersionFor(type.namespace, type.typePath);
    if (version === undefined) {
      const auth = await bearer();
      return { ...base, identifier, existence: "UNKNOWN", reason: "failed" in auth ? auth.failed : "TYPE_NOT_SUPPORTED" };
    }
    const url = ARM + identifier + "?api-version=" + version;
    // The request asks about exactly this id: a path the URL parser would rewrite is never sent, so a 404 can only mean this resource.
    if (new URL(url).pathname !== identifier) return { ...base, identifier, existence: "NOT_CHECKABLE", reason: "NOT_AN_ARM_RESOURCE_ID" };
    const response = await get(url);
    if ("failed" in response) return { ...base, identifier, existence: "UNKNOWN", reason: response.failed };
    if (response.status === 404) return { ...base, identifier, existence: "ABSENT" };
    if (response.status !== 200) return { ...base, identifier, existence: "UNKNOWN", reason: classOf(response.status) };
    try {
      const body = JSON.parse(response.body) as { id?: unknown };
      // The one fact ever read from the answer: that it names the resource that was asked about.
      if (typeof body.id === "string" && body.id.toLowerCase() === identifier.toLowerCase()) return { ...base, identifier, existence: "PRESENT" };
    } catch { /* falls through */ }
    return { ...base, identifier, existence: "UNKNOWN", reason: "UNEXPECTED_RESPONSE" };
  };

  /** Resources and resource groups carrying the unit tag, every page, by id only. */
  const listTagged = async (unitId: string): Promise<{ identifiers: string[]; complete: boolean } | undefined> => {
    if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(unitId)) return undefined;
    const filter = "$filter=tagName eq '" + ALZ_TAG_KEYS.unit + "' and tagValue eq '" + unitId + "'";
    const identifiers: string[] = [];
    let complete = true;
    for (const collection of ["resources", "resourcegroups"]) {
      let url: string | undefined = ARM + "/subscriptions/" + subscription + "/" + collection + "?" + filter + "&api-version=" + RESOURCES_API;
      for (let page = 0; url !== undefined && page < 50; page += 1) {
        const response = await get(url);
        if ("failed" in response || response.status !== 200) return undefined;
        let body: { value?: unknown; nextLink?: unknown };
        try { body = JSON.parse(response.body) as typeof body; } catch { return undefined; }
        for (const item of Array.isArray(body.value) ? body.value : []) {
          const id = (item as { id?: unknown })?.id;
          if (typeof id === "string" && id !== "") identifiers.push(id);
        }
        url = typeof body.nextLink === "string" && body.nextLink !== "" ? body.nextLink : undefined;
        if (url !== undefined && !armUrlAllowed(url)) { complete = false; url = undefined; }
      }
      if (url !== undefined) complete = false;
    }
    return { identifiers: identifiers.sort(), complete };
  };

  /** Every resource inside a resource group, every page, by id only: what a cleanup of the group would take with it. */
  const listGroup = async (groupIdentifier: string): Promise<{ identifiers: string[]; complete: boolean } | undefined> => {
    if (!GROUP_ID.test(groupIdentifier) || !armPathSafe(groupIdentifier) || !groupIdentifier.toLowerCase().startsWith("/subscriptions/" + subscription + "/")) return undefined;
    const identifiers: string[] = [];
    let complete = true;
    let url: string | undefined = ARM + groupIdentifier + "/resources?api-version=" + RESOURCES_API;
    if (new URL(url).pathname !== groupIdentifier + "/resources") return undefined;
    for (let page = 0; url !== undefined && page < 50; page += 1) {
      const response = await get(url);
      if ("failed" in response || response.status !== 200) return undefined;
      let body: { value?: unknown; nextLink?: unknown };
      try { body = JSON.parse(response.body) as typeof body; } catch { return undefined; }
      for (const item of Array.isArray(body.value) ? body.value : []) {
        const id = (item as { id?: unknown })?.id;
        if (typeof id === "string" && id !== "") identifiers.push(id);
      }
      url = typeof body.nextLink === "string" && body.nextLink !== "" ? body.nextLink : undefined;
      if (url !== undefined && !armUrlAllowed(url)) { complete = false; url = undefined; }
    }
    if (url !== undefined) complete = false;
    return { identifiers: identifiers.sort(), complete };
  };

  return {
    reader: { verifier: "AZURE_RESOURCE_MANAGER", check, listTagged, listGroup },
    close: () => { closed = true; access = undefined; apiVersions.clear(); },
  };
}
