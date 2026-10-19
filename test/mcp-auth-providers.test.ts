import assert from "node:assert/strict";
import test from "node:test";
import { McpAuthProviderRegistry, validateMcpAuthProvider } from "../src/mcp/auth-providers.js";

const base = {
  id: "test_mcp", name: "Test MCP", endpoint: "https://mcp.example.test/mcp",
};
const oauth = {
  ...base, type: "oauth2.1", clientId: "public-client",
  authorizationUrl: "https://identity.example.test/authorize",
  tokenUrl: "https://identity.example.test/token",
  redirectUri: "https://console.example.test/callback",
  scopes: ["mcp:read"], pkce: true,
};
const key = {
  ...base, type: "api_key", keyRef: "vault://mcp/test",
  placement: "header", headerName: "X-API-Key",
};

test("OAuth 2.0 and 2.1 accept PKCE-based configuration", () => {
  for (const type of ["oauth2", "oauth2.1"]) {
    assert.equal(validateMcpAuthProvider({...oauth, type}).type, type);
  }
});
test("API key config uses opaque secret reference", () => {
  assert.equal(validateMcpAuthProvider(key).type, "api_key");
});
test("unsupported auth methods fail closed", () => {
  for (const type of ["basic", "password", "sigv4", "none", "bearer"]) {
    assert.throws(() => validateMcpAuthProvider({...oauth, type}), /MCP_AUTH_PROVIDER_INVALID/);
  }
});
test("raw secrets and unknown properties cannot enter registry", () => {
  assert.throws(() => validateMcpAuthProvider({...key, keyRef: "my-secret-value"}), /opaque secret reference/);
  assert.throws(() => validateMcpAuthProvider({...oauth, clientSecret: "plaintext"}), /unsupported field/);
});
test("OAuth insecure URLs and missing PKCE are rejected", () => {
  assert.throws(() => validateMcpAuthProvider({...oauth, tokenUrl: "http://identity.example.test/token"}), /HTTPS/);
  assert.throws(() => validateMcpAuthProvider({...oauth, pkce: false}), /PKCE/);
});
test("API keys cannot use URL query string, cookies or reserved headers", () => {
  assert.throws(() => validateMcpAuthProvider({...key, placement: "query"}), /headers/);
  assert.throws(() => validateMcpAuthProvider({...key, headerName: "Cookie"}), /invalid API key header/);
});
test("registry rejects duplicates and returns immutable copies", () => {
  const registry = new McpAuthProviderRegistry();
  registry.create(key);
  assert.throws(() => registry.create(key), /EXISTS/);
  const copy = registry.get("test_mcp")!;
  copy.name = "Modified";
  assert.equal(registry.get("test_mcp")?.name, "Test MCP");
  assert.equal(registry.list().length, 1);
  assert.equal(registry.delete("test_mcp"), true);
});
