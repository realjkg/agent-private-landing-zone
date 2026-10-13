import { sha256 } from "../../util/sha256.js";

/**
 * Google Cloud Asset Inventory v1 discovery.
 *
 * The transport is supplied only by a trusted host boundary. This module never
 * accepts cloud credentials, executes CLI commands, opens sockets, or mutates
 * resources. It cannot confer model, IaC, or ACT authority.
 */
export type GcpInventoryScope = string;
export type GcpInventoryRequest = {
  method: "GET";
  origin: "https://cloudasset.googleapis.com";
  path: string;
  timeoutMs: 8000;
  maxResponseBytes: 2_000_000;
};
export type GcpInventoryResponse = { status: number; body: string };
export type GcpInventoryTransport = (request: GcpInventoryRequest) => Promise<GcpInventoryResponse>;

export type GcpInventoryAsset = {
  resourceId: string;
  provider: "GCP";
  resourceType: string;
  name: string;
  project?: string;
  location?: string;
  ownership: "UNKNOWN";
  mutationPolicy: "READ_ONLY";
  sourceOfTruth: "UNKNOWN";
};
export type GcpInventoryEvidence = {
  responseSha256: string;
  resultCount: number;
  page: number;
  httpStatus: 200;
};
export type GcpInventorySnapshot = {
  schemaVersion: 1;
  provider: "GCP";
  scope: GcpInventoryScope;
  inventory: GcpInventoryAsset[];
  evidence: GcpInventoryEvidence[];
  snapshotSha256: string;
  discoveryBasis: "TRUSTED_INJECTED_TRANSPORT";
  completeness: "COMPLETE_FOR_RETURNED_SEARCH_RESULTS";
  identityAttestation: "NOT_ATTESTED";
  posture: "UNKNOWN";
  readOnly: true;
  mutationSupported: false;
};

const ORIGIN = "https://cloudasset.googleapis.com" as const;
const PAGE_SIZE = 100;
const MAX_PAGES = 10;
const MAX_RESPONSE_BYTES = 2_000_000;
const MAX_ASSETS = PAGE_SIZE * MAX_PAGES;
const MASK = "name,assetType,project,displayName,location";
const PROJECT = /^projects\/(?:[a-z][a-z0-9-]{4,28}[a-z0-9]|[0-9]{6,20})$/;
const NUMBERED_SCOPE = /^(?:organizations|folders)\/[0-9]{1,20}$/;
const ASSET_TYPE = /^[a-z0-9][a-z0-9.-]{0,160}\/[A-Za-z0-9._-]{1,128}$/;
const RESOURCE_NAME = /^\/\/[^\s\x00-\x1f]{1,2000}$/;

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

export function validateGcpScope(scope: string): GcpInventoryScope {
  if (PROJECT.test(scope) || NUMBERED_SCOPE.test(scope)) return scope;
  throw new Error("GCP_SCOPE_INVALID");
}

function optionalText(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length > 1024 || /[\x00-\x1f\x7f]/.test(value)) {
    throw new Error("GCP_ASSET_" + field + "_INVALID");
  }
  return value;
}

function parseAsset(value: unknown): GcpInventoryAsset {
  const item = record(value);
  if (!item ||
      typeof item.name !== "string" || !RESOURCE_NAME.test(item.name) ||
      typeof item.assetType !== "string" || !ASSET_TYPE.test(item.assetType)) {
    throw new Error("GCP_ASSET_SCHEMA_INVALID");
  }
  const project = optionalText(item.project, "PROJECT");
  const displayName = optionalText(item.displayName, "DISPLAY_NAME");
  const location = optionalText(item.location, "LOCATION");
  return {
    resourceId: item.name,
    provider: "GCP",
    resourceType: item.assetType,
    name: displayName || item.name,
    ...(project ? { project } : {}),
    ...(location ? { location } : {}),
    ownership: "UNKNOWN",
    mutationPolicy: "READ_ONLY",
    sourceOfTruth: "UNKNOWN",
  };
}

function parsePage(body: string): { results: unknown[]; nextPageToken?: string } {
  let parsed: unknown;
  try { parsed = JSON.parse(body) as unknown; }
  catch { throw new Error("GCP_INVENTORY_JSON_INVALID"); }
  const data = record(parsed);
  if (!data || (data.results !== undefined && !Array.isArray(data.results))) {
    throw new Error("GCP_INVENTORY_SCHEMA_INVALID");
  }
  if (data.nextPageToken !== undefined &&
      (typeof data.nextPageToken !== "string" ||
        !data.nextPageToken || data.nextPageToken.length > 4096 ||
        /[\x00-\x1f\x7f]/.test(data.nextPageToken))) {
    throw new Error("GCP_PAGE_TOKEN_INVALID");
  }
  return {
    results: (data.results ?? []) as unknown[],
    ...(typeof data.nextPageToken === "string" ? { nextPageToken: data.nextPageToken } : {}),
  };
}

/** Validates a fixed scope and bounded pages; any partial page fails closed. */
export async function discoverGcpInventory(
  scopeInput: string,
  transport: GcpInventoryTransport,
): Promise<GcpInventorySnapshot> {
  const scope = validateGcpScope(scopeInput);
  const inventory: GcpInventoryAsset[] = [];
  const evidence: GcpInventoryEvidence[] = [];
  const resourceIds = new Set<string>();
  const pageTokens = new Set<string>();
  let token: string | undefined;

  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const query = new URLSearchParams({ pageSize: String(PAGE_SIZE), readMask: MASK });
    if (token) query.set("pageToken", token);
    const path = "/v1/" + scope + ":searchAllResources?" + query.toString();
    const response = await transport({
      method: "GET", origin: ORIGIN, path,
      timeoutMs: 8000, maxResponseBytes: MAX_RESPONSE_BYTES,
    });
    if (response.status !== 200) throw new Error("GCP_ASSET_READ_FAILED");
    if (typeof response.body !== "string" ||
        Buffer.byteLength(response.body, "utf8") > MAX_RESPONSE_BYTES) {
      throw new Error("GCP_RESPONSE_TOO_LARGE_OR_INVALID");
    }
    const parsed = parsePage(response.body);
    if (parsed.results.length > PAGE_SIZE || inventory.length + parsed.results.length > MAX_ASSETS) {
      throw new Error("GCP_INVENTORY_LIMIT_EXCEEDED");
    }
    for (const raw of parsed.results) {
      const asset = parseAsset(raw);
      if (resourceIds.has(asset.resourceId)) throw new Error("GCP_DUPLICATE_RESOURCE");
      resourceIds.add(asset.resourceId);
      inventory.push(asset);
    }
    evidence.push({
      responseSha256: sha256(response.body),
      resultCount: parsed.results.length, page, httpStatus: 200,
    });
    token = parsed.nextPageToken;
    if (!token) {
      const snapshotSha256 = sha256(JSON.stringify({
        provider: "GCP", scope, inventory, evidence,
      }));
      return {
        schemaVersion: 1, provider: "GCP", scope, inventory, evidence,
        snapshotSha256, discoveryBasis: "TRUSTED_INJECTED_TRANSPORT",
        completeness: "COMPLETE_FOR_RETURNED_SEARCH_RESULTS",
        identityAttestation: "NOT_ATTESTED",
        posture: "UNKNOWN", readOnly: true, mutationSupported: false,
      };
    }
    if (parsed.results.length === 0 || pageTokens.has(token)) {
      throw new Error("GCP_PAGINATION_INVALID");
    }
    pageTokens.add(token);
  }
  throw new Error("GCP_PAGINATION_LIMIT_EXCEEDED");
}
