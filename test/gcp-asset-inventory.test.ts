import assert from "node:assert/strict";
import test from "node:test";

import {
  discoverGcpInventory, validateGcpScope,
  type GcpInventoryRequest, type GcpInventoryResponse,
} from "../src/providers/gcp/asset-inventory.js";

const projectScope = "projects/sovereign-lz-dev";
const goodAsset = (name: string) => ({
  name: "//compute.googleapis.com/projects/sovereign-lz-dev/global/networks/" + name,
  assetType: "compute.googleapis.com/Network",
  project: "projects/1234567890",
  displayName: name, location: "global",
});
const page = (results: unknown[] = [], nextPageToken?: string) => JSON.stringify({
  results, ...(nextPageToken ? { nextPageToken } : {}),
});
function fakeTransport(...responses: GcpInventoryResponse[]) {
  const requests: GcpInventoryRequest[] = [];
  const transport = async (req: GcpInventoryRequest): Promise<GcpInventoryResponse> => {
    requests.push(req);
    const response = responses[requests.length - 1];
    if (!response) throw new Error("UNEXPECTED_TRANSPORT_CALL");
    return response;
  };
  return { transport, requests };
}

test("GCP scopes are explicit project, folder, or organization identifiers", () => {
  for (const scope of [projectScope, "projects/123456789", "folders/12345", "organizations/12345"]) {
    assert.equal(validateGcpScope(scope), scope);
  }
  for (const scope of [
    "", "projects/", "projects/../secrets", "projects/example?query=all",
    "organizations/not-an-id", "https://cloudasset.googleapis.com/v1/projects/p",
    "projects/foo/bar", "folders/123:searchAllResources",
  ]) {
    assert.throws(() => validateGcpScope(scope), /GCP_SCOPE_INVALID/);
  }
});

test("GCP inventory returns normalized, read-only, hash-linked evidence", async () => {
  const { transport, requests } = fakeTransport({
    status: 200, body: page([goodAsset("platform-vpc")]),
  });
  const result = await discoverGcpInventory(projectScope, transport);
  assert.equal(result.provider, "GCP");
  assert.equal(result.scope, projectScope);
  assert.equal(result.inventory.length, 1);
  assert.equal(result.inventory[0]?.resourceType, "compute.googleapis.com/Network");
  assert.equal(result.inventory[0]?.name, "platform-vpc");
  assert.equal(result.inventory[0]?.ownership, "UNKNOWN");
  assert.equal(result.inventory[0]?.mutationPolicy, "READ_ONLY");
  assert.equal(result.inventory[0]?.sourceOfTruth, "UNKNOWN");
  assert.equal(result.readOnly, true);
  assert.equal(result.mutationSupported, false);
  assert.equal(result.identityAttestation, "NOT_ATTESTED");
  assert.equal(result.posture, "UNKNOWN");
  assert.match(result.snapshotSha256, /^[a-f0-9]{64}$/);
  assert.match(result.evidence[0]!.responseSha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(requests.map((r) => r.method), ["GET"]);
  assert.equal(requests[0]!.origin, "https://cloudasset.googleapis.com");
  assert.match(requests[0]!.path, /^\/v1\/projects\/sovereign-lz-dev:searchAllResources\?/);
  assert.equal(new URLSearchParams(requests[0]!.path.split("?")[1]).get("pageSize"), "100");
  assert.equal(requests[0]!.timeoutMs, 8000);
  assert.equal(requests[0]!.maxResponseBytes, 2_000_000);
  assert.doesNotMatch(JSON.stringify(result), /accessToken|credentials|secretValue/);
});

test("GCP folder-scoped pagination preserves scope and bounded GET semantics", async () => {
  const { transport, requests } = fakeTransport(
    { status: 200, body: page([goodAsset("vpc-one")], "opaque-token") },
    { status: 200, body: page([goodAsset("vpc-two")]) },
  );
  const snapshot = await discoverGcpInventory("folders/12345", transport);
  assert.equal(snapshot.inventory.length, 2);
  assert.equal(snapshot.evidence.length, 2);
  assert.equal(requests.length, 2);
  assert.match(requests[0]!.path, /^\/v1\/folders\/12345:searchAllResources\?/);
  assert.match(requests[1]!.path, /^\/v1\/folders\/12345:searchAllResources\?/);
  const params = new URLSearchParams(requests[1]!.path.split("?")[1]);
  assert.equal(params.get("pageToken"), "opaque-token");
  assert.equal(params.get("pageSize"), "100");
});

test("GCP empty search never asserts greenfield or security posture", async () => {
  const { transport } = fakeTransport({ status: 200, body: "{}" });
  const result = await discoverGcpInventory("organizations/12345", transport);
  assert.deepEqual(result.inventory, []);
  assert.equal(result.posture, "UNKNOWN");
  assert.equal(result.completeness, "COMPLETE_FOR_RETURNED_SEARCH_RESULTS");
  assert.equal(result.identityAttestation, "NOT_ATTESTED");
});

test("GCP access denial, invalid JSON and schema errors fail closed", async () => {
  for (const response of [
    { status: 403, body: '{"error":{"message":"permission denied"}}' },
    { status: 200, body: "not-json" },
    { status: 200, body: '{"results":{}}' },
    { status: 200, body: page([{ name: "//host/path", assetType: "not/a/google/asset" }]) },
    { status: 200, body: page([goodAsset("one"), goodAsset("one")]) },
  ]) {
    const { transport } = fakeTransport(response);
    await assert.rejects(discoverGcpInventory(projectScope, transport), /GCP_/);
  }
});

test("GCP duplicates and invalid next page tokens fail closed", async () => {
  const duplicated = fakeTransport(
    { status: 200, body: page([goodAsset("same")], "token-a") },
    { status: 200, body: page([goodAsset("same")]) },
  );
  await assert.rejects(discoverGcpInventory(projectScope, duplicated.transport), /GCP_DUPLICATE_RESOURCE/);
  const repeated = fakeTransport(
    { status: 200, body: page([goodAsset("first")], "repeat") },
    { status: 200, body: page([goodAsset("second")], "repeat") },
  );
  await assert.rejects(discoverGcpInventory(projectScope, repeated.transport), /GCP_PAGINATION_INVALID/);
  const empty = fakeTransport({ status: 200, body: page([], "continue") });
  await assert.rejects(discoverGcpInventory(projectScope, empty.transport), /GCP_PAGINATION_INVALID/);
});

test("GCP page count, response byte and page token limits fail closed", async () => {
  const largePage = fakeTransport({ status: 200, body: page(Array.from({ length: 101 }, (_, n) => goodAsset("net-" + n))) });
  await assert.rejects(discoverGcpInventory(projectScope, largePage.transport), /GCP_INVENTORY_LIMIT_EXCEEDED/);
  const oversized = fakeTransport({ status: 200, body: "x".repeat(2_000_001) });
  await assert.rejects(discoverGcpInventory(projectScope, oversized.transport), /GCP_RESPONSE_TOO_LARGE_OR_INVALID/);
  const badToken = fakeTransport({ status: 200, body: JSON.stringify({ results: [goodAsset("one")], nextPageToken: "x".repeat(4097) }) });
  await assert.rejects(discoverGcpInventory(projectScope, badToken.transport), /GCP_PAGE_TOKEN_INVALID/);
  const pages = Array.from({ length: 10 }, (_, n) => ({
    status: 200, body: page([goodAsset("net-" + n)], "token-" + n),
  }));
  const many = fakeTransport(...pages);
  await assert.rejects(discoverGcpInventory(projectScope, many.transport), /GCP_PAGINATION_LIMIT_EXCEEDED/);
  assert.equal(many.requests.length, 10);
});

test("GCP refuses schema fields with control characters and cannot grant ownership", async () => {
  const malicious = {
    ...goodAsset("name"), displayName: "bad\nname",
    ownership: "MANAGED_BY_ACCELERATOR", mutationPolicy: "DELETE_ALLOWED",
  };
  await assert.rejects(
    discoverGcpInventory(projectScope, fakeTransport({ status: 200, body: page([malicious]) }).transport),
    /GCP_ASSET_DISPLAY_NAME_INVALID/,
  );
  const untrusted = { ...goodAsset("safe"), ownership: "MANAGED_BY_ACCELERATOR", mutationPolicy: "DELETE_ALLOWED" };
  const result = await discoverGcpInventory(
    projectScope, fakeTransport({ status: 200, body: page([untrusted]) }).transport,
  );
  assert.equal(result.inventory[0]!.ownership, "UNKNOWN");
  assert.equal(result.inventory[0]!.mutationPolicy, "READ_ONLY");
});

test("GCP includes Cloud Asset Inventory Kubernetes asset types", async () => {
  const k8s = {
    name: "//container.googleapis.com/projects/sovereign-lz-dev/locations/us-central1/clusters/primary/k8s/namespaces/default/pods/demo",
    assetType: "k8s.io/Pod",
    displayName: "demo",
  };
  const result = await discoverGcpInventory(
    projectScope,
    fakeTransport({ status: 200, body: page([k8s]) }).transport,
  );
  assert.equal(result.inventory[0]!.resourceType, "k8s.io/Pod");
  assert.equal(result.inventory[0]!.mutationPolicy, "READ_ONLY");
});
