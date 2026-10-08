import assert from "node:assert/strict";
import test from "node:test";
import { generateKeyPairSync, sign } from "node:crypto";
import { createApiEnvironmentProvider, createSignedEdgeEnvironmentProvider } from "../src/environment/read-only.js";
import { createFetchEnvironmentTransport } from "../src/environment/transport.js";
import type { EnvironmentBinding, EnvironmentReadTransport } from "../src/environment/types.js";

const binding = (provider: EnvironmentBinding["provider"]): EnvironmentBinding => ({
  environmentId: "private-01", provider, runtimeProfile: "PRIVATE_SOVEREIGN_DISCONNECTED",
  deployment: "LOCAL", origin: "https://infra.internal", authRef: "secret://infrastructure/read-only",
});
const fake = (responses: Record<string, unknown>, observed: string[]): EnvironmentReadTransport =>
  async (r) => {
    assert.equal(r.method, "GET");
    assert.equal(r.origin, "https://infra.internal");
    assert.equal(r.authRef, "secret://infrastructure/read-only");
    observed.push(r.path);
    const value = responses[r.path];
    return value === undefined ? { status: 403, body: "denied" } : { status: 200, body: typeof value === "string" ? value : JSON.stringify(value) };
  };

test("Kubernetes uses GET-only API discovery, readiness and observed namespace topology", async () => {
  const requests: string[] = [];
  const provider = createApiEnvironmentProvider(binding("KUBERNETES"), fake({
    "/version": { gitVersion: "v1.36" }, "/readyz": "ok",
    "/api/v1/nodes": { items: [{ metadata: { name: "node-1", uid: "n-1" } }] },
    "/api/v1/namespaces": { items: [{ metadata: { name: "workload" } }] },
    "/api/v1/services": { items: [{ metadata: { name: "api", uid: "svc-1", namespace: "workload" } }] },
    "/apis/apps/v1/deployments": { items: [{ metadata: { name: "app", uid: "dep-1", namespace: "workload" } }] },
  }, requests));
  const state = await provider.discover();
  assert.equal(state.complete, true);
  assert.equal(state.identityObserved, true);
  assert.equal(state.health, "HEALTHY");
  assert.equal(state.inventory.length, 4);
  assert.equal(state.topology.length, 2);
  assert.equal(state.mutationSupported, false);
  assert.equal(provider.capabilities().mutation, false);
  assert.deepEqual(await provider.inventory(), state.inventory);
  assert.deepEqual(requests, ["/version", "/readyz", "/api/v1/nodes", "/api/v1/namespaces", "/api/v1/services", "/apis/apps/v1/deployments"]);
});

test("OpenShift reads cluster version plus Kubernetes resources and does not infer health from inventory", async () => {
  const requests: string[] = [];
  const provider = createApiEnvironmentProvider(binding("OPENSHIFT"), fake({
    "/version": { major: "1" },
    "/api/v1/nodes": { items: [] }, "/api/v1/namespaces": { items: [] },
    "/api/v1/services": { items: [] }, "/apis/apps/v1/deployments": { items: [] },
    "/apis/config.openshift.io/v1/clusterversions": { items: [{ metadata: { name: "version" }, status: {} }] },
  }, requests));
  const state = await provider.discover();
  assert.equal(state.complete, true);
  assert.equal(state.health, "UNKNOWN");
  assert.ok(requests.includes("/apis/config.openshift.io/v1/clusterversions"));
  assert.equal(state.inventory[0]?.kind, "CLUSTER_VERSION");
});

test("VCF domains/clusters/hosts and vCenter inventory use actual read API paths", async () => {
  const requests: string[] = [];
  const provider = createApiEnvironmentProvider(binding("VCF"), fake({
    "/v1/domains": { elements: [{ id: "domain-1", name: "management", status: "ACTIVE" }] },
    "/v1/clusters": { elements: [{ id: "cluster-1", name: "cluster" }] },
    "/v1/hosts": { elements: [{ id: "host-1", name: "esx", clusterId: "cluster-1" }] },
  }, requests));
  const state = await provider.discover();
  assert.equal(state.complete, true);
  assert.equal(state.inventory.length, 3);
  assert.equal(state.topology.length, 1);
  assert.equal(state.health, "UNKNOWN");
  const vr: string[] = [];
  const vcenter = createApiEnvironmentProvider(binding("VCENTER"), fake({
    "/api/vcenter/cluster": [{ cluster: "cluster-1", name: "cluster" }],
    "/api/vcenter/host": [{ host: "host-1", name: "esx", cluster: "cluster-1" }],
    "/api/vcenter/vm": [{ vm: "vm-1", name: "app" }],
    "/api/vcenter/datastore": [{ datastore: "ds-1", name: "shared" }],
  }, vr));
  const vs = await vcenter.discover();
  assert.equal(vs.inventory.length, 4);
  assert.equal(vs.topology.length, 1);
  assert.equal(vs.complete, true);
  assert.ok(vr.includes("/api/vcenter/vm"));
});

test("pagination is followed conservatively and failure leaves discovery incomplete", async () => {
  const requests: string[] = [];
  const p = createApiEnvironmentProvider(binding("KUBERNETES"), fake({
    "/version": { gitVersion: "v1" }, "/readyz": "ok",
    "/api/v1/nodes": { items: [{ metadata: { name: "first" } }], metadata: { continue: "next" } },
    "/api/v1/nodes?continue=next": { items: [{ metadata: { name: "second" } }] },
    "/api/v1/namespaces": { items: [] }, "/api/v1/services": { items: [] }, "/apis/apps/v1/deployments": { items: [] },
  }, requests));
  const state = await p.discover();
  assert.equal(state.inventory.filter((a) => a.kind === "NODE").length, 2);
  assert.equal(state.complete, true);
  const q = createApiEnvironmentProvider(binding("OPENSHIFT"), fake({ "/version": {} }, []));
  const partial = await q.discover();
  assert.equal(partial.complete, false);
  assert.equal(partial.health, "UNKNOWN");
  assert.ok(partial.evidence.some((e) => e.status === "UNAVAILABLE"));
});

test("strict private sovereignty rejects external endpoint bindings and raw credentials", () => {
  assert.throws(() => createApiEnvironmentProvider({ ...binding("KUBERNETES"), deployment: "EXTERNAL" }, fake({}, [])), /SOVEREIGNTY_DENIED/);
  assert.throws(() => createApiEnvironmentProvider({ ...binding("VCF"), authRef: "plain-secret" }, fake({}, [])), /CREDENTIAL_REF_INVALID/);
  assert.throws(() => createApiEnvironmentProvider({ ...binding("VCENTER"), origin: "http://insecure" }, fake({}, [])), /ORIGIN_INVALID/);
});

test("HTTP transport only allows operator-pinned HTTPS origins and resolves secrets inside transport", async () => {
  const captured: { url?: string; method?: string; authorization?: string; redirect?: RequestRedirect } = {};
  const transport = createFetchEnvironmentTransport({
    allowedOrigins: ["https://infra.internal"],
    resolveSecret: async (ref) => { assert.equal(ref, "secret://infrastructure/read-only"); return "hidden-private-token"; },
    fetchImpl: async (input, init) => {
      captured.url = String(input);
      captured.method = init?.method;
      captured.authorization = new Headers(init?.headers).get("authorization") ?? undefined;
      captured.redirect = init?.redirect;
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    },
  });
  const response = await transport({ method: "GET", origin: "https://infra.internal", path: "/version", authRef: "secret://infrastructure/read-only", timeoutMs: 8000, maxResponseBytes: 1024 });
  assert.equal(response.status, 200);
  assert.equal(captured.method, "GET");
  assert.equal(captured.url, "https://infra.internal/version");
  assert.equal(captured.authorization, "Bearer hidden-private-token");
  assert.equal(captured.redirect, "error");
  assert.equal(JSON.stringify(response).includes("hidden-private-token"), false);
  await assert.rejects(() => transport({ method: "GET", origin: "https://evil.invalid", path: "/version", timeoutMs: 8000, maxResponseBytes: 1024 }), /NOT_ALLOWLISTED/);
  await assert.rejects(() => transport({ method: "POST" as "GET", origin: "https://infra.internal", path: "/version", timeoutMs: 8000, maxResponseBytes: 1024 }), /READ_ONLY/);
});

test("offline edge inventory requires an independently trusted Ed25519 signature", async () => {
  const keys = generateKeyPairSync("ed25519");
  const rawManifest = JSON.stringify({
    schemaVersion: 1, environmentId: "edge-01",
    assets: [{ id: "node-01", kind: "EDGE_NODE", name: "appliance", health: "HEALTHY" },
      { id: "vm-01", kind: "VM", name: "service", health: "UNKNOWN", parentId: "node-01" }],
  });
  const signatureBase64 = sign(null, Buffer.from(rawManifest), keys.privateKey).toString("base64");
  const trustedPublicKeyPem = keys.publicKey.export({ format: "pem", type: "spki" }).toString();
  const input = { rawManifest, signatureBase64, trustedPublicKeyPem, runtimeProfile: "PRIVATE_SOVEREIGN_DISCONNECTED" as const };
  const p = createSignedEdgeEnvironmentProvider(input);
  const snapshot = await p.discover();
  assert.equal(snapshot.complete, true);
  assert.equal(snapshot.inventory.length, 2);
  assert.equal(snapshot.topology.length, 1);
  assert.equal(snapshot.health, "UNKNOWN");
  assert.equal(snapshot.readOnly, true);
  assert.match(snapshot.warnings.join(" "), /NOT_LIVE/);
  assert.throws(() => createSignedEdgeEnvironmentProvider({ ...input, rawManifest: rawManifest + " " }), /EDGE_SIGNATURE_INVALID/);
});
