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
 * Requests: exactly two kinds of GET against management.azure.com (one resource by its ARM id, after reading the
 * provider's API versions; the subscription's resources and resource groups carrying the unit tag), plus the token POST.
 * Nothing else is sent, and only those two hosts are allowed. Only existence and identifiers are kept from an answer.
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

export type ArmErrorClass = "ACCESS_DENIED" | "THROTTLED" | "CREDENTIALS" | "HTTP_ERROR" | "HOST_REFUSED" | "UNEXPECTED_RESPONSE";

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

/** Only the two hosts the reader is for; a URL anywhere else is refused before a request exists. */
const hostAllowed = (url: string): boolean => {
  try { const host = new URL(url).host; return host === LOGIN_HOST || host === ARM_HOST; } catch { return false; }
};

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
  const apiVersions = new Map<string, Promise<string | undefined>>();

  const send = async (request: ArmRequest): Promise<ArmResponse> => {
    if (!hostAllowed(request.url)) return { status: 0, body: "HOST_REFUSED" };
    return http(request);
  };

  /** The access token for management.azure.com, exchanged once from the federated token. Neither token leaves this closure. */
  const bearer = async (): Promise<{ token: string } | { failed: ArmErrorClass }> => {
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
    const response = await send({ method: "POST", url: "https://" + LOGIN_HOST + "/" + identity.tenantId + "/oauth2/v2.0/token", headers: { "content-type": "application/x-www-form-urlencoded" }, body });
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

  /** The newest stable API version a provider offers for a type, read once per type; undefined when it cannot be read. */
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
          return versions.find((v) => !/preview/i.test(v)) ?? versions[0];
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
    const type = RESOURCE_ID.test(identifier) ? armTypeOf(identifier) : undefined;
    if (!type) return { ...base, identifier, existence: "NOT_CHECKABLE", reason: "NOT_AN_ARM_RESOURCE_ID" };
    if (!identifier.toLowerCase().startsWith("/subscriptions/" + subscription + "/")) return { ...base, identifier, existence: "NOT_CHECKABLE", reason: "OUTSIDE_TARGET_SUBSCRIPTION" };
    const version = await apiVersionFor(type.namespace, type.typePath);
    if (version === undefined) {
      const auth = await bearer();
      return { ...base, identifier, existence: "UNKNOWN", reason: "failed" in auth ? auth.failed : "TYPE_NOT_SUPPORTED" };
    }
    const response = await get(ARM + identifier + "?api-version=" + version);
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
        if (url !== undefined && !hostAllowed(url)) { complete = false; url = undefined; }
      }
      if (url !== undefined) complete = false;
    }
    return { identifiers: identifiers.sort(), complete };
  };

  return {
    reader: { verifier: "AZURE_RESOURCE_MANAGER", check, listTagged },
    close: () => { access = undefined; apiVersions.clear(); },
  };
}
