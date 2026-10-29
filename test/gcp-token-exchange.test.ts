import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { exchangeSubjectToken, generateAccessTokenUrl, impersonateServiceAccount, STS_TOKEN_URL, type GcpTokenRequest, type GcpTokenResponse } from "../src/tools/gcp-credentials.js";

// SYNTHETIC. The one GCP token exchange and impersonation (docs/act-pilot-gcp-api-driver.md D20). A scripted sender stands in for
// Google; nothing is sent anywhere. The request shapes follow Google's discovery documents and auth library (see the module's notes).

const SUBJECT = "oidc-canary-subject-token";
const FEDERATED = "federated-canary-token";
const ACCESS = "access-canary-token";
const AUDIENCE = "//iam.googleapis.com/projects/123456789/locations/global/workloadIdentityPools/alz-pool/providers/alz-provider";
const SA = "alz-pilot-dev-apply@alz-pilot-dev.iam.googleapis.com".replace("googleapis", "gserviceaccount");
const scripted = (answer: GcpTokenResponse) => {
  const sent: GcpTokenRequest[] = [];
  return { sent, send: async (request: GcpTokenRequest) => { sent.push(request); return answer; } };
};

test("D20: the exchange posts the RFC 8693 form to the one STS URL, with no Authorization header, and returns only the access token", async () => {
  const google = scripted({ status: 200, body: JSON.stringify({ access_token: FEDERATED, issued_token_type: "urn:ietf:params:oauth:token-type:access_token", token_type: "Bearer", expires_in: 3600 }) });
  const result = await exchangeSubjectToken(google.send, { audience: AUDIENCE, subjectTokenType: "urn:ietf:params:oauth:token-type:jwt", subjectToken: SUBJECT, scope: "https://www.googleapis.com/auth/cloud-platform" });
  assert.deepEqual(result, { ok: true, token: FEDERATED });
  assert.equal(google.sent.length, 1);
  const [request] = google.sent;
  assert.equal(request!.method, "POST");
  assert.equal(request!.url, "https://sts.googleapis.com/v1/token");
  assert.equal(request!.url, STS_TOKEN_URL);
  assert.deepEqual(request!.headers, { "content-type": "application/x-www-form-urlencoded" }, "no Authorization header (Google's discovery document: sending one can fail the request)");
  assert.deepEqual(Object.fromEntries(new URLSearchParams(request!.body)), {
    grant_type: "urn:ietf:params:oauth:grant-type:token-exchange", audience: AUDIENCE, scope: "https://www.googleapis.com/auth/cloud-platform",
    requested_token_type: "urn:ietf:params:oauth:token-type:access_token", subject_token: SUBJECT, subject_token_type: "urn:ietf:params:oauth:token-type:jwt",
  });
});

test("D20: the impersonation posts the scopes and lifetime as JSON to the service account's generateAccessToken URL with the - project wildcard, bearing the federated token", async () => {
  const google = scripted({ status: 200, body: JSON.stringify({ accessToken: ACCESS, expireTime: "2026-10-29T12:00:00Z" }) });
  const result = await impersonateServiceAccount(google.send, { federatedToken: FEDERATED, serviceAccount: SA, scopes: ["https://www.googleapis.com/auth/pubsub"], lifetime: "300s" });
  assert.deepEqual(result, { ok: true, token: ACCESS });
  const [request] = google.sent;
  assert.equal(request!.url, "https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/" + SA + ":generateAccessToken");
  assert.equal(request!.url, generateAccessTokenUrl(SA));
  assert.deepEqual(request!.headers, { authorization: "Bearer " + FEDERATED, "content-type": "application/json" });
  assert.deepEqual(JSON.parse(request!.body), { scope: ["https://www.googleapis.com/auth/pubsub"], lifetime: "300s" });
});

test("D20: a failed step names its status and kind, never the answer's body; a malformed or whitespace token is malformed; a refused request is marked so", async () => {
  const leak = "secret-looking-body-" + SUBJECT;
  for (const [answer, expected] of [
    [{ status: 401, body: leak }, { status: 401, hostRefused: false, malformed: false }],
    [{ status: 503, body: leak }, { status: 503, hostRefused: false, malformed: false }],
    [{ status: 0, body: "HOST_REFUSED" }, { status: 0, hostRefused: true, malformed: false }],
    [{ status: 0, body: "" }, { status: 0, hostRefused: false, malformed: false }],
    [{ status: 200, body: "not json " + leak }, { status: 200, hostRefused: false, malformed: true }],
    [{ status: 200, body: JSON.stringify({ access_token: "two words" }) }, { status: 200, hostRefused: false, malformed: true }],
    [{ status: 200, body: JSON.stringify({ access_token: "" }) }, { status: 200, hostRefused: false, malformed: true }],
    [{ status: 200, body: JSON.stringify({ accessToken: FEDERATED }) }, { status: 200, hostRefused: false, malformed: true }],
  ] as const) {
    const result = await exchangeSubjectToken(scripted(answer).send, { audience: AUDIENCE, subjectTokenType: "urn:ietf:params:oauth:token-type:jwt", subjectToken: SUBJECT, scope: "s" });
    assert.deepEqual(result, { ok: false, step: "EXCHANGE", ...expected }, JSON.stringify(answer).slice(0, 40));
    assert.ok(!JSON.stringify(result).includes(SUBJECT));
  }
});

test("D20: the impersonation sends nothing for a malformed service account, lifetime or empty scope list", async () => {
  for (const input of [
    { serviceAccount: "someone@example.com", scopes: ["s"], lifetime: "300s" },
    { serviceAccount: SA + "/../x", scopes: ["s"], lifetime: "300s" },
    { serviceAccount: SA, scopes: ["s"], lifetime: "5m" },
    { serviceAccount: SA, scopes: [], lifetime: "300s" },
  ]) {
    const google = scripted({ status: 200, body: JSON.stringify({ accessToken: ACCESS }) });
    const result = await impersonateServiceAccount(google.send, { federatedToken: FEDERATED, ...input });
    assert.equal(result.ok, false, JSON.stringify(input));
    assert.equal(google.sent.length, 0, "nothing was sent");
  }
});

test("D20: one implementation: no other source file builds a GCP token exchange or impersonation request", () => {
  const root = resolve(fileURLToPath(new URL("..", import.meta.url)), "src");
  const hits: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) { walk(path); continue; }
      if (!name.endsWith(".ts") || path.endsWith(join("tools", "gcp-credentials.ts"))) continue;
      const text = readFileSync(path, "utf8");
      for (const marker of ["grant-type:token-exchange", "grantType", "subject_token", "subjectToken:", "requested_token_type", "requestedTokenType", ":generateAccessToken\""]) {
        if (text.includes(marker)) hits.push(path.slice(root.length + 1) + ": " + marker);
      }
    }
  };
  walk(root);
  assert.deepEqual(hits, []);
});
