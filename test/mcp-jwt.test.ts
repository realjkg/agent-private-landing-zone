import assert from "node:assert/strict";
import { createPublicKey, generateKeyPairSync, sign } from "node:crypto";
import test from "node:test";
import { request } from "node:http";
import { createMcpJwtVerifier, type McpJwtPolicy } from "../src/security/mcp-jwt.js";
import { startAuthenticatedPrivateMcp } from "../src/security/private-mcp.js";
import { UnifiedOperations } from "../src/operations/unified.js";

const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const now = 1_792_533_600_000;
const seconds = now / 1000;
const jwk = { ...publicKey.export({ format: "jwk" }), kid: "test-key", kty: "RSA" as const } as McpJwtPolicy["jwks"]["keys"][number];
const policy = (): McpJwtPolicy => ({
  issuer: "https://issuer.example.test", audience: "private-alz", tenant: "tenant-a", stage: "PRODUCTION",
  jwks: { keys: [jwk] }, now: () => now, isActive: async () => true
});
const claims = () => ({ iss: policy().issuer, aud: "private-alz", sub: "agent-a", tenant: "tenant-a", stage: "PRODUCTION",
  exp: seconds + 300, iat: seconds, nbf: seconds, jti: "session-a", scope: "ALZ_DISCOVERY_READ" });
function jwt(change: Record<string, unknown> = {}, headers: Record<string, unknown> = {}, key = privateKey) {
  const h = Buffer.from(JSON.stringify({ alg: "RS256", typ: "at+jwt", kid: "test-key", ...headers })).toString("base64url");
  const p = Buffer.from(JSON.stringify({ ...claims(), ...change })).toString("base64url");
  return h + "." + p + "." + sign("RSA-SHA256", Buffer.from(h + "." + p), key).toString("base64url");
}
test("MCP accepts a cryptographically verified, active, target-bound access token", async () => {
  const p = policy(); let session: unknown;
  p.isActive = async input => { session = input; return true; };
  const caller = await createMcpJwtVerifier(p)(jwt());
  assert.equal(caller?.verifiedBy, "TRUSTED_GATEWAY");
  assert.equal(caller?.identity.subject, "agent-a");
  assert.deepEqual(caller?.identity.scopes, ["ALZ_DISCOVERY_READ"]);
  assert.deepEqual(session, { subject: "agent-a", jti: "session-a", tenant: "tenant-a", stage: "PRODUCTION" });
});
test("MCP rejects forged, wrong-target, expired, broadened and untrusted tokens", async () => {
  const verify = createMcpJwtVerifier(policy());
  const wrongKey = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey;
  const invalid = [jwt({}, {}, wrongKey), jwt({ iss: "https://evil.test" }), jwt({ aud: "other" }),
    jwt({ tenant: "tenant-b" }), jwt({ stage: "STAGING" }), jwt({ exp: seconds }), jwt({ nbf: seconds + 1 }),
    jwt({ iat: seconds + 1 }), jwt({ exp: seconds + 901 }), jwt({ jti: "" }), jwt({ exp: "9999999999" }),
    jwt({ scope: "ALZ_DISCOVERY_READ ALZ_APPLY" }), jwt({ scope: "ALZ_APPLY" }),
    jwt({}, { alg: "none" }), jwt({}, { alg: "HS256" }), jwt({}, { typ: "JWT" }),
    jwt({}, { kid: "unknown" }), jwt({}, { jku: "https://evil.test/jwks" }), jwt({}, { crit: ["b64"] }),
    "invalid", jwt() + ".extra", "A".repeat(8193)];
  for (const token of invalid) assert.equal(await verify(token), null);
});
test("revoked/unavailable sessions and expiration during lookup fail closed", async () => {
  for (const isActive of [async () => false, async () => { throw Error("unavailable"); }])
    assert.equal(await createMcpJwtVerifier({ ...policy(), isActive })(jwt()), null);
  let clock = now;
  const verify = createMcpJwtVerifier({ ...policy(), now: () => clock,
    isActive: async () => { clock += 301_000; return true; } });
  assert.equal(await verify(jwt()), null);
  assert.equal(await createMcpJwtVerifier({ ...policy(), now: () => Number.NaN })(jwt()), null);
  let calls = 0;
  assert.equal(await createMcpJwtVerifier({ ...policy(), now: () => ++calls === 1 ? now : Number.NaN })(jwt()), null);
});
test("JWT trust policy rejects weak/duplicate keys and cannot be widened by later mutation", async () => {
  const p = policy(); const verify = createMcpJwtVerifier(p);
  p.tenant = "tenant-b"; p.audience = "other";
  assert.equal(await verify(jwt({ tenant: "tenant-b", aud: "other" })), null);
  assert.throws(() => createMcpJwtVerifier({ ...policy(), jwks: { keys: [jwk, jwk] } }));
  assert.throws(() => createMcpJwtVerifier({ ...policy(), issuer: "http://issuer.test" }));
  // Synthetic public-only modulus exercises the size guard without generating a weak key pair.
  const weak = { ...jwk, n: Buffer.alloc(128, 0xff).toString("base64url") };
  assert.equal(createPublicKey({ key: weak, format: "jwk" }).asymmetricKeyDetails?.modulusLength, 1024);
  assert.throws(() => createMcpJwtVerifier({ ...policy(), jwks: { keys: [{ ...jwk, ...weak }] } }), /WEAK/);
});
test("production bootstrap enforces loopback and real JWT auth across MCP discovery and mutation denial", async () => {
  const operations = new UnifiedOperations({ root: process.cwd(), audience: "private-alz", now: () => now,
    catalog: [], runner: async () => { throw Error("must not execute"); } });
  const { server, address } = await startAuthenticatedPrivateMcp({ operations, policy: policy(), port: 0 });
  assert.equal(address.address, "127.0.0.1");
  const call = (token: string, method: string, params: unknown = {}, origin?: string) => fetch(`http://127.0.0.1:${address.port}/mcp`, {
    method: "POST", headers: { authorization: "Bearer " + token, "content-type": "application/json", ...(origin ? { origin } : {}) },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })
  });
  try {
    assert.equal((await call(jwt({ tenant: "tenant-b" }), "tools/list")).status, 401);
    assert.equal((await call(jwt(), "tools/list", {}, "https://evil.test")).status, 403);
    assert.match(await (await call(jwt(), "initialize")).text(), /sovereign-alz-readonly/);
    assert.match(await (await call(jwt(), "tools/list")).text(), /alz.operations.invoke/);
    assert.match(await (await call(jwt(), "tools/call", { name: "alz.operations.invoke", arguments: { operation: "apply" } })).text(), /READ_ONLY_DENIED/);
    // fetch normalizes Host; use the wire client to exercise a forged header.
    const badHostStatus = await new Promise<number | undefined>((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port: address.port, path: "/mcp", method: "POST",
        headers: { host: "attacker.test", authorization: "Bearer " + jwt(), "content-type": "application/json" } },
        res => { res.resume(); res.on("end", () => resolve(res.statusCode)); });
      req.on("error", reject); req.end("{}");
    });
    assert.equal(badHostStatus, 403);
    const oversized = await fetch(`http://127.0.0.1:${address.port}/mcp`, { method: "POST",
      headers: { authorization: "Bearer " + jwt(), "content-type": "application/json" }, body: "x".repeat(65537) });
    assert.equal(oversized.status, 413);
    assert.equal((await oversized.json() as { error: string }).error, "PAYLOAD_TOO_LARGE");
  } finally { await new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve())); }
});
