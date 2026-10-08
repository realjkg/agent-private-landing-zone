import { createHash, verify } from "node:crypto";
import { runtimeProfile } from "../runtime-profile/catalog.js";
import type { RuntimeProfileId } from "../runtime-profile/types.js";
import type {
  EnvironmentAsset, EnvironmentBinding, EnvironmentEvidence, EnvironmentHealth,
  EnvironmentLink, EnvironmentProvider, EnvironmentProviderId, EnvironmentReadResponse,
  EnvironmentReadTransport, EnvironmentSnapshot,
} from "./types.js";

const ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,79}$/;
const NAME = /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,127}$/;
const paths: Record<Exclude<EnvironmentProviderId, "SOVEREIGN_EDGE">, string[]> = {
  KUBERNETES: ["/api/v1/nodes", "/api/v1/namespaces", "/api/v1/services", "/apis/apps/v1/deployments"],
  OPENSHIFT: ["/api/v1/nodes", "/api/v1/namespaces", "/api/v1/services", "/apis/apps/v1/deployments", "/apis/config.openshift.io/v1/clusterversions"],
  VCF: ["/v1/domains", "/v1/clusters", "/v1/hosts"],
  VCENTER: ["/api/vcenter/cluster", "/api/vcenter/host", "/api/vcenter/vm", "/api/vcenter/datastore"],
};
const kindFor: Record<string, string> = {
  "/api/v1/nodes": "NODE", "/api/v1/namespaces": "NAMESPACE",
  "/api/v1/services": "SERVICE", "/apis/apps/v1/deployments": "DEPLOYMENT",
  "/apis/config.openshift.io/v1/clusterversions": "CLUSTER_VERSION",
  "/v1/domains": "DOMAIN", "/v1/clusters": "CLUSTER", "/v1/hosts": "HOST",
  "/api/vcenter/cluster": "CLUSTER", "/api/vcenter/host": "HOST",
  "/api/vcenter/vm": "VM", "/api/vcenter/datastore": "DATASTORE",
};
function digest(body: string): string { return createHash("sha256").update(body).digest("hex"); }
function safe(value: unknown, fallback: string): string {
  return typeof value === "string" && NAME.test(value) ? value : fallback;
}
function obj(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function itemsFor(value: unknown): unknown[] | null {
  if (Array.isArray(value)) return value;
  const record = obj(value);
  if (Array.isArray(record.items)) return record.items;
  if (Array.isArray(record.elements)) return record.elements;
  if (Array.isArray(record.value)) return record.value;
  return null;
}
function rawIdentifier(value: Record<string, unknown>, kind: string, index: number): string {
  const metadata = obj(value.metadata);
  const candidate =
    kind === "NODE" || kind === "NAMESPACE" || kind === "SERVICE" || kind === "DEPLOYMENT" || kind === "CLUSTER_VERSION"
      ? metadata.uid ?? metadata.name
      : value.id ?? value.vm ?? value.host ?? value.cluster ?? value.datastore;
  return safe(candidate, "unknown-" + index);
}
function normalizeAssets(environmentId: string, kind: string, rows: unknown[]): EnvironmentAsset[] {
  return rows.map((row, index) => {
    const r = obj(row);
    const metadata = obj(r.metadata);
    const id = rawIdentifier(r, kind, index);
    const name = safe(metadata.name ?? r.name, id);
    const namespace = typeof metadata.namespace === "string" && NAME.test(metadata.namespace) ? metadata.namespace : undefined;
    const parent = kind === "CLUSTER" ? r.domainId : kind === "HOST" ? (r.cluster ?? r.clusterId) : kind === "VM" ? r.host : undefined;
    const parentKind = kind === "CLUSTER" ? "DOMAIN" : kind === "VM" ? "HOST" : "CLUSTER";
    const parentId = kind === "DEPLOYMENT" || kind === "SERVICE"
      ? (namespace ? environmentId + ":NAMESPACE:" + namespace : undefined)
      : (typeof parent === "string" && NAME.test(parent) ? environmentId + ":" + parentKind + ":" + parent : undefined);
    const status = typeof r.status === "string" ? r.status : "";
    const health: EnvironmentHealth = ["ERROR", "DEGRADED", "NOT_RESPONDING", "DISABLED"].includes(status.toUpperCase()) ? "DEGRADED" : "UNKNOWN";
    return { id: environmentId + ":" + kind + ":" + id, kind, name, ...(namespace ? { namespace } : {}), ...(parentId ? { parentId } : {}), health };
  });
}
function topologyFor(inventory: EnvironmentAsset[]): EnvironmentLink[] {
  const known = new Set(inventory.map((asset) => asset.id));
  const links: EnvironmentLink[] = [];
  const index = new Set<string>();
  for (const asset of inventory) {
    if (!asset.parentId) continue;
    // Namespace UID may differ from namespace name. Link to exact observed namespace only.
    const parent = known.has(asset.parentId) ? asset.parentId : inventory.find((x) => x.kind === "NAMESPACE" && x.name === asset.namespace)?.id;
    if (parent && parent !== asset.id && known.has(parent)) {
      const key = parent + "/" + asset.id;
      if (!index.has(key)) { index.add(key); links.push({ from: parent, to: asset.id, relation: "CONTAINS" }); }
    }
  }
  return links;
}
function deniedBinding(binding: EnvironmentBinding): void {
  if (!ID.test(binding.environmentId)) throw new Error("ENVIRONMENT_ID_INVALID");
  const profile = runtimeProfile(binding.runtimeProfile);
  const strict = profile.sovereignty === "PRIVATE_SOVEREIGN" || profile.sovereignty === "SOVEREIGN_PUBLIC";
  if (strict && binding.deployment === "EXTERNAL") throw new Error("ENVIRONMENT_SOVEREIGNTY_DENIED");
  if (profile.connectivity === "DISCONNECTED" && binding.deployment !== "LOCAL") throw new Error("ENVIRONMENT_DISCONNECTED_LOCAL_ONLY");
  if (profile.connectivity === "SAME_SOVEREIGN_DOMAIN_ONLY" && binding.deployment === "EXTERNAL") throw new Error("ENVIRONMENT_EGRESS_DENIED");
  if (binding.authRef && !/^(secret|vault|keyring):\/\/[a-zA-Z0-9._/-]{1,128}$/.test(binding.authRef)) throw new Error("ENVIRONMENT_CREDENTIAL_REF_INVALID");
  let parsed: URL;
  try { parsed = new URL(binding.origin); } catch { throw new Error("ENVIRONMENT_ORIGIN_INVALID"); }
  if (parsed.protocol !== "https:" || parsed.pathname !== "/" || parsed.search || parsed.hash || parsed.username || parsed.password) {
    throw new Error("ENVIRONMENT_ORIGIN_INVALID");
  }
}
function emptyCapabilities(): EnvironmentProvider["capabilities"] extends () => infer T ? T : never {
  return { discover: true, health: true, inventory: true, topology: true, evidence: true, mutation: false };
}

export function createApiEnvironmentProvider(binding: EnvironmentBinding, transport: EnvironmentReadTransport): EnvironmentProvider {
  deniedBinding(binding);
  let cached: EnvironmentSnapshot | undefined;
  async function probe(path: string): Promise<{ response?: EnvironmentReadResponse; evidence: EnvironmentEvidence; parsed?: unknown }> {
    try {
      const result = await transport({ method: "GET", origin: binding.origin, path, authRef: binding.authRef, timeoutMs: 8000, maxResponseBytes: 2_000_000 });
      const evidence: EnvironmentEvidence = { path, status: result.status >= 200 && result.status < 300 ? "OBSERVED" : "UNAVAILABLE", httpStatus: result.status };
      if (evidence.status !== "OBSERVED") return { evidence };
      evidence.responseSha256 = digest(result.body);
      try { return { response: result, evidence, parsed: JSON.parse(result.body) as unknown }; }
      catch { return { response: result, evidence }; }
    } catch {
      return { evidence: { path, status: "UNAVAILABLE" } };
    }
  }
  async function discover(): Promise<EnvironmentSnapshot> {
    const evidence: EnvironmentEvidence[] = [];
    const warnings: string[] = [];
    const inventory: EnvironmentAsset[] = [];
    let partial = false;
    let identityObserved = false;
    let health: EnvironmentHealth = "UNKNOWN";
    const identityPath = binding.provider === "KUBERNETES" || binding.provider === "OPENSHIFT" ? "/version" : paths[binding.provider][0]!;
    const identity = await probe(identityPath);
    if (identity.parsed && typeof identity.parsed === "object") identityObserved = true;
    if (binding.provider === "KUBERNETES" || binding.provider === "OPENSHIFT") evidence.push(identity.evidence);
    if (binding.provider === "KUBERNETES" || binding.provider === "OPENSHIFT") {
      const ready = await probe("/readyz");
      evidence.push(ready.evidence);
      if (ready.response?.body.trim() === "ok") health = "HEALTHY";
    }
    for (const path of paths[binding.provider]) {
      let next = path;
      let page = 0;
      const seen = new Set<string>();
      while (next && page < 10) {
        const result = page === 0 && path === identityPath ? identity : await probe(next);
        evidence.push(result.evidence);
        if (!result.parsed) { partial = true; warnings.push("ENVIRONMENT_EVIDENCE_UNAVAILABLE: " + path); break; }
        const rows = itemsFor(result.parsed);
        if (!rows) { partial = true; warnings.push("ENVIRONMENT_SCHEMA_UNKNOWN: " + path); break; }
        if (binding.provider === "VCENTER" && path === "/api/vcenter/vm" && rows.length >= 4000) {
          partial = true;
          warnings.push("VCENTER_VM_RESULT_LIMIT: scope discovery by datacenter/cluster for complete estate inventory.");
        }
        const remain = Math.max(0, 5000 - inventory.length);
        if (rows.length > remain) { partial = true; warnings.push("ENVIRONMENT_INVENTORY_LIMIT"); }
        inventory.push(...normalizeAssets(binding.environmentId, kindFor[path]!, rows.slice(0, remain)));
        const pageData = obj(obj(result.parsed).metadata);
        const continuation = pageData.continue;
        const vcfPage = obj(obj(result.parsed).pageMetadata);
        const pages = vcfPage.totalPages;
        next = "";
        if (typeof continuation === "string" && continuation) {
          if (seen.has(continuation)) { partial = true; break; }
          seen.add(continuation);
          next = path + "?continue=" + encodeURIComponent(continuation);
        } else if (typeof pages === "number" && pages > page + 1 && page < 9) {
          next = path + "?pageNumber=" + (page + 1);
        }
        page++;
        if (inventory.length >= 5000 && next) { partial = true; break; }
      }
      if (next) { partial = true; warnings.push("ENVIRONMENT_PAGINATION_INCOMPLETE: " + path); }
    }
    if (binding.provider === "VCF") {
      const domains = inventory.filter((x) => x.kind === "DOMAIN");
      if (domains.length > 0 && !partial) health = "UNKNOWN"; // inventory visibility never proves domain health
    }
    if (!identityObserved) warnings.push("ENVIRONMENT_IDENTITY_UNVERIFIED");
    const complete = identityObserved && !partial;
    if (!complete) health = "UNKNOWN";
    cached = {
      schemaVersion: 1, environmentId: binding.environmentId, provider: binding.provider,
      runtimeProfile: binding.runtimeProfile, health, identityObserved, inventory,
      topology: topologyFor(inventory), evidence, complete, warnings, readOnly: true, mutationSupported: false,
    };
    return cached;
  }
  async function current(): Promise<EnvironmentSnapshot> { return cached ?? discover(); }
  return {
    identify: async () => { const snapshot = await current(); return { environmentId: binding.environmentId, provider: binding.provider, observed: snapshot.identityObserved }; },
    capabilities: emptyCapabilities,
    discover,
    health: async () => (await current()).health,
    inventory: async () => (await current()).inventory,
    topology: async () => (await current()).topology,
    evidence: async () => (await current()).evidence,
  };
}

export type SignedEdgeAsset = { id: string; kind: string; name: string; health: EnvironmentHealth; parentId?: string };
export type SignedEdgeManifest = { schemaVersion: 1; environmentId: string; assets: SignedEdgeAsset[] };

/** The operator-supplied Ed25519 trust key must be pinned independently of the signed manifest. */
export function createSignedEdgeEnvironmentProvider(input: {
  rawManifest: string;
  signatureBase64: string;
  trustedPublicKeyPem: string;
  runtimeProfile: RuntimeProfileId;
}): EnvironmentProvider {
  if (!runtimeProfile(input.runtimeProfile).localTraceabilityRequired) throw new Error("ENVIRONMENT_PROFILE_INVALID");
  if (!/^[a-zA-Z0-9+/]+={0,2}$/.test(input.signatureBase64)) throw new Error("EDGE_SIGNATURE_INVALID");
  let valid = false;
  try {
    valid = verify(null, Buffer.from(input.rawManifest, "utf8"), input.trustedPublicKeyPem, Buffer.from(input.signatureBase64, "base64"));
  } catch { valid = false; }
  if (!valid) throw new Error("EDGE_SIGNATURE_INVALID");
  let decoded: unknown;
  try { decoded = JSON.parse(input.rawManifest) as unknown; } catch { throw new Error("EDGE_MANIFEST_INVALID"); }
  const m = obj(decoded);
  if (m.schemaVersion !== 1 || typeof m.environmentId !== "string" || !ID.test(m.environmentId) || !Array.isArray(m.assets) || m.assets.length > 5000) {
    throw new Error("EDGE_MANIFEST_INVALID");
  }
  const seen = new Set<string>();
  const inventory: EnvironmentAsset[] = m.assets.map((asset: unknown) => {
    const a = obj(asset);
    if (typeof a.id !== "string" || !NAME.test(a.id) || typeof a.name !== "string" || !NAME.test(a.name) ||
      typeof a.kind !== "string" || !NAME.test(a.kind) || !["HEALTHY", "DEGRADED", "UNKNOWN"].includes(String(a.health)) ||
      seen.has(a.id)) throw new Error("EDGE_ASSET_INVALID");
    seen.add(a.id);
    const parentId = a.parentId;
    if (parentId !== undefined && (typeof parentId !== "string" || !NAME.test(parentId))) throw new Error("EDGE_ASSET_PARENT_INVALID");
    return {
      id: m.environmentId + ":EDGE:" + a.id, kind: a.kind, name: a.name,
      health: a.health as EnvironmentHealth,
      ...(typeof parentId === "string" ? { parentId: m.environmentId + ":EDGE:" + parentId } : {}),
    };
  });
  const health: EnvironmentHealth = inventory.some((a) => a.health === "DEGRADED") ? "DEGRADED"
    : inventory.length > 0 && inventory.every((a) => a.health === "HEALTHY") ? "HEALTHY" : "UNKNOWN";
  const snapshot: EnvironmentSnapshot = {
    schemaVersion: 1, environmentId: m.environmentId as string, provider: "SOVEREIGN_EDGE",
    runtimeProfile: input.runtimeProfile, health, identityObserved: true, inventory,
    topology: topologyFor(inventory),
    evidence: [{ path: "local-signed-manifest", status: "OBSERVED", responseSha256: digest(input.rawManifest) }],
    complete: true, warnings: ["EDGE_HEALTH_ATTESTED_NOT_LIVE: inventory and health are signed source observations."],
    readOnly: true, mutationSupported: false,
  };
  return {
    identify: async () => ({ environmentId: snapshot.environmentId, provider: "SOVEREIGN_EDGE", observed: true }),
    capabilities: emptyCapabilities,
    discover: async () => snapshot,
    health: async () => snapshot.health,
    inventory: async () => snapshot.inventory,
    topology: async () => snapshot.topology,
    evidence: async () => snapshot.evidence,
  };
}
