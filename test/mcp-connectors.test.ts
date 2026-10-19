import assert from "node:assert/strict";
import test from "node:test";
import { McpAuthProviderRegistry } from "../src/mcp/auth-providers.js";
import { McpConnectorRegistry } from "../src/mcp/connectors.js";

const url = "https://mcp.example.test/mcp";
const auth = {
  id: "shared_auth", name: "Shared authentication", endpoint: url,
  type: "api_key", keyRef: "vault://mcp/shared", placement: "header",
  headerName: "X-API-Key",
};

test("MCP connectors reuse an existing auth provider without copying secrets", () => {
  const registry = new McpAuthProviderRegistry();
  registry.create(auth);
  const connectors = new McpConnectorRegistry(registry);
  const first = connectors.register({ id: "one", name: "First", endpoint: url, authProviderId: "shared_auth" });
  connectors.register({ id: "two", name: "Second", endpoint: url, authProviderId: "shared_auth" });
  assert.equal(connectors.resolve("one").authProvider.type, "api_key");
  assert.equal(connectors.list().length, 2);
  assert.equal("keyRef" in first, false);
});

test("connectors fail closed on unknown auth records or mismatched endpoints", () => {
  const registry = new McpAuthProviderRegistry();
  const connectors = new McpConnectorRegistry(registry);
  const value = { id: "one", name: "First", endpoint: url, authProviderId: "shared_auth" };
  assert.throws(() => connectors.register(value), /NOT_FOUND/);
  registry.create(auth);
  assert.throws(() => connectors.register({ ...value, endpoint: "https://other.example.test/mcp" }), /MISMATCH/);
  connectors.register(value);
  registry.delete("shared_auth");
  assert.throws(() => connectors.resolve("one"), /NOT_FOUND/);
});
