import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { BlueprintEntry } from "../src/observe/blueprint.js";
import { GCP_READ_TYPES, GCP_VERIFIER, createDiscoveryGcpReader, type GcpHttp, type GcpRequest, type GcpResponse } from "../src/observe/gcp-rest.js";

// The GCP reader (slice S3 of the GCP release-path PLAN). SYNTHETIC: a scripted HTTP fake stands in for Google, and every token
// is a canary that must never appear in a check, a listing, a request URL or a request to the wrong service. No Google endpoint,
// no real credential.

const root = mkdtempSync(join(tmpdir(), "alz-gcp-observe-"));
test.after(() => rmSync(root, { recursive: true, force: true }));

const PROJECT = "alz-pilot-dev";
const SA = "alz-pilot-dev-discovery@alz-pilot-dev.iam.gserviceaccount.com";
const AUDIENCE = "//iam.googleapis.com/projects/123456789012/locations/global/workloadIdentityPools/alz-pilot-dev/providers/oidc";
const OIDC = "CANARY-OIDC-TOKEN-0001";
const FEDERATED = "CANARY-FEDERATED-TOKEN-0002";
const ACCESS = "CANARY-ACCESS-TOKEN-0003";
const CANARIES = [OIDC, FEDERATED, ACCESS];
const STS = "https://sts.googleapis.com/v1/token";
const GENERATE = "https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/" + SA + ":generateAccessToken";
const TOPIC = "projects/" + PROJECT + "/topics/alz-unit-topic";

let counter = 0;
function identityEnv(overrides: Record<string, unknown> = {}, token = OIDC): NodeJS.ProcessEnv {
  const tokenFile = join(root, "token-" + ++counter + ".jwt");
  writeFileSync(tokenFile, token + "\n");
  const config = join(root, "config-" + counter + ".json");
  writeFileSync(config, JSON.stringify({
    type: "external_account", audience: AUDIENCE, subject_token_type: "urn:ietf:params:oauth:token-type:jwt",
    token_url: STS, credential_source: { file: tokenFile }, ...overrides,
  }));
  return { ALZ_DISCOVERY_GOOGLE_APPLICATION_CREDENTIALS: config, ALZ_DISCOVERY_GOOGLE_IMPERSONATE_SERVICE_ACCOUNT: SA, ALZ_DISCOVERY_GOOGLE_PROJECT: PROJECT };
}

type Script = { sts?: GcpResponse; generate?: GcpResponse; get?: (url: URL) => GcpResponse };
function fake(script: Script = {}): { http: GcpHttp; requests: GcpRequest[] } {
  const requests: GcpRequest[] = [];
  const http: GcpHttp = async (request) => {
    requests.push(request);
    if (request.method === "POST" && request.url === STS) return script.sts ?? { status: 200, body: JSON.stringify({ access_token: FEDERATED, token_type: "Bearer" }) };
    if (request.method === "POST" && request.url === GENERATE) return script.generate ?? { status: 200, body: JSON.stringify({ accessToken: ACCESS, expireTime: "2026-10-27T15:00:00Z" }) };
    if (request.method === "GET" && script.get) return script.get(new URL(request.url));
    return { status: 500, body: "" };
  };
  return { http, requests };
}

const entry = (id: string | null, type = "google_pubsub_topic"): BlueprintEntry => ({ address: type + ".unit", type, id, arn: null, origin: "IN_PLAN" });
const noCanary = (value: unknown, label: string) => {
  const text = JSON.stringify(value);
  for (const canary of CANARIES) assert.equal(text.includes(canary), false, label + ": " + canary);
};

test("one token exchange, then each topic is PRESENT, ABSENT or UNKNOWN by its exact name; no token appears in a result or travels to the wrong service", async () => {
  const { http, requests } = fake({
    get: (url) => {
      const name = url.pathname.replace(/^\/v1\//, "");
      if (name === TOPIC) return { status: 200, body: JSON.stringify({ name: TOPIC, labels: { "alz-unit": "x" }, secret: "never-read" }) };
      if (name.endsWith("/gone")) return { status: 404, body: "{}" };
      if (name.endsWith("/denied")) return { status: 403, body: JSON.stringify({ error: { message: "Permission denied " + ACCESS } }) };
      if (name.endsWith("/throttled")) return { status: 429, body: "" };
      return { status: 200, body: JSON.stringify({ name: "projects/" + PROJECT + "/topics/someone-else" }) };
    },
  });
  const { reader, close } = createDiscoveryGcpReader({ env: identityEnv(), projectId: PROJECT, http });
  assert.equal(reader.verifier, GCP_VERIFIER);
  const results = [];
  for (const name of ["alz-unit-topic", "gone", "denied", "throttled", "mismatch"]) results.push(await reader.check(entry("projects/" + PROJECT + "/topics/" + name)));
  assert.deepEqual(results.map((r) => [r.existence, r.reason]), [
    ["PRESENT", undefined], ["ABSENT", undefined], ["UNKNOWN", "ACCESS_DENIED"], ["UNKNOWN", "THROTTLED"], ["UNKNOWN", "UNEXPECTED_RESPONSE"],
  ]);
  noCanary(results, "results");
  assert.deepEqual(Object.keys(results[0]).sort(), ["address", "existence", "identifier", "type"], "only existence and the identifier are kept");

  const posts = requests.filter((r) => r.method === "POST");
  assert.deepEqual(posts.map((r) => r.url), [STS, GENERATE], "exchanged once for every check");
  const sts = new URLSearchParams(posts[0].body);
  assert.equal(sts.get("subject_token"), OIDC);
  assert.equal(sts.get("audience"), AUDIENCE);
  assert.equal(sts.get("grant_type"), "urn:ietf:params:oauth:grant-type:token-exchange");
  assert.equal(posts[0].headers.authorization, undefined, "no bearer to the token service");
  assert.equal(posts[1].headers.authorization, "Bearer " + FEDERATED);
  assert.deepEqual(JSON.parse(posts[1].body ?? "{}").scope, ["https://www.googleapis.com/auth/cloud-platform.read-only"]);
  for (const get of requests.filter((r) => r.method === "GET")) {
    assert.equal(get.headers.authorization, "Bearer " + ACCESS, "only the service account's token reads");
    assert.match(get.url, /^https:\/\/pubsub\.googleapis\.com\/v1\/projects\/alz-pilot-dev\/topics\/[a-z-]+$/);
  }
  for (const request of requests) noCanary(request.url, "url");
  close();
  assert.deepEqual(await reader.check(entry(TOPIC)), { address: "google_pubsub_topic.unit", type: "google_pubsub_topic", identifier: TOPIC, existence: "UNKNOWN", reason: "READER_CLOSED" });
  assert.equal(requests.length, 7, "a closed reader sends nothing");
});

test("an entry the reader cannot ask about exactly is NOT_CHECKABLE, and nothing is sent for it", async () => {
  const { http, requests } = fake({ get: () => ({ status: 200, body: "{}" }) });
  const { reader } = createDiscoveryGcpReader({ env: identityEnv(), projectId: PROJECT, http });
  assert.deepEqual(Object.keys(GCP_READ_TYPES), ["google_pubsub_topic"]);
  for (const [id, type, reason] of [
    [null, "google_pubsub_topic", "NO_IDENTIFIER_IN_STATE"],
    [TOPIC, "google_storage_bucket", "NO_GCP_READ_MAPPING"],
    [TOPIC, "toString", "NO_GCP_READ_MAPPING"],
    ["projects/other-project/topics/alz-unit-topic", "google_pubsub_topic", "OUTSIDE_TARGET_PROJECT"],
    ["projects/" + PROJECT + "/topics/../subscriptions/x", "google_pubsub_topic", "NOT_A_GCP_RESOURCE_NAME"],
    ["projects/" + PROJECT + "/topics/a%2F..%2Fb", "google_pubsub_topic", "NOT_A_GCP_RESOURCE_NAME"],
    ["projects/" + PROJECT + "/topics/goog-topic", "google_pubsub_topic", "NOT_A_GCP_RESOURCE_NAME"],
    ["projects/" + PROJECT + "/topics/a b", "google_pubsub_topic", "NOT_A_GCP_RESOURCE_NAME"],
    ["https://pubsub.googleapis.com/v1/" + TOPIC, "google_pubsub_topic", "NOT_A_GCP_RESOURCE_NAME"],
    ["//pubsub.googleapis.com/" + TOPIC, "google_pubsub_topic", "NOT_A_GCP_RESOURCE_NAME"],
    [TOPIC + "\n", "google_pubsub_topic", "NOT_A_GCP_RESOURCE_NAME"],
  ] as const) {
    const result = await reader.check(entry(id, type));
    assert.equal(result.existence, "NOT_CHECKABLE", String(id) + " " + type);
    assert.equal(result.reason, reason, String(id) + " " + type);
  }
  assert.equal(requests.length, 0, "no token was even exchanged");
  assert.throws(() => createDiscoveryGcpReader({ env: identityEnv(), projectId: "Bad Project", http }), /GCP_PROJECT_INVALID/);
});

test("DISCOVERY's credentials are judged as the provider spec judges them: a key file, P1's own impersonation, another project's account or a missing variable sends nothing", async () => {
  const cases: [string, NodeJS.ProcessEnv][] = [
    ["no variables", {}],
    ["no service account", { ...identityEnv(), ALZ_DISCOVERY_GOOGLE_IMPERSONATE_SERVICE_ACCOUNT: undefined }],
    ["another project's account", { ...identityEnv(), ALZ_DISCOVERY_GOOGLE_IMPERSONATE_SERVICE_ACCOUNT: "alz-pilot-qa-discovery@alz-pilot-qa.iam.gserviceaccount.com" }],
    ["not a service account", { ...identityEnv(), ALZ_DISCOVERY_GOOGLE_IMPERSONATE_SERVICE_ACCOUNT: "person@example.com" }],
    ["P1 impersonation url", identityEnv({ service_account_impersonation_url: "https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/other@x-proj.iam.gserviceaccount.com:generateAccessToken" })],
    ["key file", identityEnv({ type: "service_account", private_key: "CANARY-KEY-0004" })],
    ["executable source", identityEnv({ credential_source: { executable: { command: "/bin/true" } } })],
    ["empty token file", identityEnv({}, "")],
    ["token with whitespace", identityEnv({}, "a b")],
    ["relative configuration path", { ...identityEnv(), ALZ_DISCOVERY_GOOGLE_APPLICATION_CREDENTIALS: "config.json" }],
    ["APPLY's variables only", { ALZ_APPLY_GOOGLE_APPLICATION_CREDENTIALS: identityEnv().ALZ_DISCOVERY_GOOGLE_APPLICATION_CREDENTIALS, ALZ_APPLY_GOOGLE_IMPERSONATE_SERVICE_ACCOUNT: SA }],
  ];
  for (const [label, env] of cases) {
    const { http, requests } = fake();
    const { reader } = createDiscoveryGcpReader({ env, projectId: PROJECT, http });
    const result = await reader.check(entry(TOPIC));
    assert.deepEqual([result.existence, result.reason], ["UNKNOWN", "CREDENTIALS"], label);
    assert.equal(await reader.listTagged("alzu-0123456789abcdef0123"), undefined, label);
    assert.equal(requests.length, 0, label + ": nothing sent");
    noCanary(result, label);
  }
});

test("a refused or malformed token exchange is a class, never a token or Google's message", async () => {
  for (const [label, script, reason] of [
    ["STS 400", { sts: { status: 400, body: JSON.stringify({ error: "invalid_grant", error_description: OIDC }) } }, "CREDENTIALS"],
    ["STS 403", { sts: { status: 403, body: "" } }, "ACCESS_DENIED"],
    ["STS no token", { sts: { status: 200, body: JSON.stringify({ token_type: "Bearer" }) } }, "UNEXPECTED_RESPONSE"],
    ["STS not JSON", { sts: { status: 200, body: "<html>" } }, "UNEXPECTED_RESPONSE"],
    ["STS unreachable", { sts: { status: 0, body: "" } }, "HOST_REFUSED"],
    ["impersonation denied", { generate: { status: 403, body: JSON.stringify({ error: { message: FEDERATED } }) } }, "ACCESS_DENIED"],
    ["impersonation token with whitespace", { generate: { status: 200, body: JSON.stringify({ accessToken: "a b" }) } }, "UNEXPECTED_RESPONSE"],
  ] as const) {
    const { http, requests } = fake(script as Script);
    const { reader } = createDiscoveryGcpReader({ env: identityEnv(), projectId: PROJECT, http });
    const first = await reader.check(entry(TOPIC));
    const second = await reader.check(entry(TOPIC));
    assert.deepEqual([first.existence, first.reason], ["UNKNOWN", reason], label);
    assert.deepEqual(second, first, label + ": the failure is remembered, not retried");
    assert.equal(requests.filter((r) => r.method === "GET").length, 0, label + ": no read without a token");
    noCanary([first, second], label);
  }
});

test("the unit sweep lists every page of Cloud Asset Inventory by resource name, follows a page token only with the same query, and fails closed on a malformed page", async () => {
  const unit = "alzu-0123456789abcdef0123";
  const pages = new Map<string, GcpResponse>([
    ["", { status: 200, body: JSON.stringify({ results: [{ name: "//pubsub.googleapis.com/" + TOPIC, labels: { "alz-unit": unit } }], nextPageToken: "page/2+=" }) }],
    ["page/2+=", { status: 200, body: JSON.stringify({ results: [{ name: "//storage.googleapis.com/alz-stray-bucket" }, { name: "unexpected-form" }] }) }],
  ]);
  const { http, requests } = fake({ get: (url) => pages.get(url.searchParams.get("pageToken") ?? "") ?? { status: 500, body: "" } });
  const { reader } = createDiscoveryGcpReader({ env: identityEnv(), projectId: PROJECT, http });
  assert.deepEqual(await reader.listTagged(unit), { identifiers: ["alz-stray-bucket", TOPIC, "unexpected-form"].sort(), complete: true });
  const gets = requests.filter((r) => r.method === "GET").map((r) => new URL(r.url));
  assert.equal(gets.length, 2);
  for (const url of gets) {
    assert.equal(url.origin + url.pathname, "https://cloudasset.googleapis.com/v1/projects/" + PROJECT + ":searchAllResources");
    assert.equal(url.searchParams.get("query"), "labels.alz-unit=" + unit);
  }
  assert.equal(gets[1].searchParams.get("pageToken"), "page/2+=");
  assert.equal(await reader.listTagged("Not A Unit"), undefined);

  const listing = async (get: (url: URL) => GcpResponse) => {
    const { reader: r } = createDiscoveryGcpReader({ env: identityEnv(), projectId: PROJECT, http: fake({ get }).http });
    return r.listTagged(unit);
  };
  assert.deepEqual(await listing(() => ({ status: 200, body: "{}" })), { identifiers: [], complete: true }, "no results is an empty, complete listing");
  for (const [label, body] of [
    ["results not a list", JSON.stringify({ results: { name: "x" } })], ["item without a name", JSON.stringify({ results: [{ assetType: "pubsub.googleapis.com/Topic" }] })],
    ["empty name", JSON.stringify({ results: [{ name: "" }] })], ["not an object", "[]"], ["not JSON", "<html>"],
  ]) assert.equal(await listing(() => ({ status: 200, body })), undefined, label);
  assert.equal(await listing(() => ({ status: 403, body: "" })), undefined, "a denied listing failed");
  let sent = 0;
  assert.deepEqual(await listing(() => (sent += 1, { status: 200, body: JSON.stringify({ results: [], nextPageToken: "bad token\n" }) })), { identifiers: [], complete: false }, "a token it cannot send safely ends the listing incomplete");
  assert.equal(sent, 1, "and is never sent");
  assert.deepEqual(await listing(() => ({ status: 200, body: JSON.stringify({ results: [], nextPageToken: 42 }) })), { identifiers: [], complete: false });
  let calls = 0;
  const endless = await listing(() => ({ status: 200, body: JSON.stringify({ results: [{ name: "//pubsub.googleapis.com/projects/" + PROJECT + "/topics/t" + ++calls }], nextPageToken: "more" }) }));
  assert.equal(endless?.complete, false, "a listing past 50 pages is incomplete");
  assert.equal(calls, 50);
});
