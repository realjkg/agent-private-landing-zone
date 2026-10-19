import assert from "node:assert/strict";
import test from "node:test";
import { McpAuthProviderRegistry } from "../src/mcp/auth-providers.js";
import { McpConnectorRegistry } from "../src/mcp/connectors.js";

const endpoint = "https://mcp.example.test/mcp";
const keyProvider = {
  id: "shared", name: "Shared", endpoint,
  type: "api_key", keyRef: "vault://providers/shared",
  placement: "header", headerName: "X-API-Key",
};

test("AI Studio: create → bind → provider deletion → failed closed → recreate → recover", () => {
  const providers = new McpAuthProviderRegistry();
  const connectors = new McpConnectorRegistry(providers);
  providers.create(keyProvider);
  connectors.register({ id: "tool_one", name: "Tool one", endpoint, authProviderId: "shared" });
  assert.equal(connectors.resolve("tool_one").authProvider.id, "shared");
  assert.equal(providers.delete("shared"), true);
  assert.throws(() => connectors.resolve("tool_one"), /MCP_AUTH_PROVIDER_NOT_FOUND/);
  providers.create(keyProvider);
  assert.equal(connectors.resolve("tool_one").authProvider.type, "api_key");
});

test("AI Studio: failed connector registration leaves no partial state", () => {
  const providers = new McpAuthProviderRegistry();
  const connectors = new McpConnectorRegistry(providers);
  assert.throws(() => connectors.register({
    id: "tool", name: "Tool", endpoint, authProviderId: "missing",
  }), /NOT_FOUND/);
  assert.equal(connectors.list().length, 0);
  providers.create(keyProvider);
  assert.throws(() => connectors.register({
    id: "tool", name: "Tool", endpoint, authProviderId: "shared",
    keyRef: "vault://should-not-be-here",
  } as never), /UNEXPECTED_FIELD/);
  assert.equal(connectors.list().length, 0);
});

test("AI Studio: duplicate ID and endpoint-confused provider binding fail closed", () => {
  const providers = new McpAuthProviderRegistry();
  const connectors = new McpConnectorRegistry(providers);
  providers.create(keyProvider);
  const connector = { id: "tool", name: "Tool", endpoint, authProviderId: "shared" };
  connectors.register(connector);
  assert.throws(() => connectors.register(connector), /EXISTS/);
  assert.throws(() => connectors.register({
    id: "second", name: "Second",
    endpoint: "https://other.example.test/mcp", authProviderId: "shared",
  }), /MISMATCH/);
  assert.equal(connectors.list().length, 1);
});

test("AI Studio: no raw credentials admitted through provider metadata", () => {
  const providers = new McpAuthProviderRegistry();
  assert.throws(() => providers.create({ ...keyProvider, apiKey: "plaintext" }), /unsupported field/);
  assert.equal(providers.list().length, 0);
});

test("AI Studio: malformed OAuth configuration leaves no registered provider", () => {
  const providers = new McpAuthProviderRegistry();
  assert.throws(() => providers.create({
    id: "oauth", name: "OAuth", endpoint, type: "oauth2.1",
    clientId: "client", authorizationUrl: "https://auth.example.test/authorize",
    tokenUrl: "https://auth.example.test/token", redirectUri: "https://studio.example.test/callback",
    scopes: ["mcp:read"], pkce: false,
  }), /PKCE/);
  assert.equal(providers.list().length, 0);
});
