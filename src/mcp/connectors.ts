import { McpAuthProviderRegistry, type McpAuthProvider } from "./auth-providers.js";

/** A connector references a reusable Auth Provider; it never owns secret material. */
export type McpConnector = {
  id: string;
  name: string;
  endpoint: string;
  authProviderId: string;
};

export class McpConnectorRegistry {
  private readonly connectors = new Map<string, McpConnector>();
  constructor(private readonly authProviders: McpAuthProviderRegistry) {}

  register(value: McpConnector): McpConnector {
    if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(value.id)) throw new Error("MCP_CONNECTOR_INVALID_ID");
    if (!value || typeof value !== "object") throw new Error("MCP_CONNECTOR_INVALID");
    if (typeof value.name !== "string" || !value.name.trim()) throw new Error("MCP_CONNECTOR_NAME_REQUIRED");
    if (Object.keys(value).some(key => !["id","name","endpoint","authProviderId"].includes(key))) throw new Error("MCP_CONNECTOR_UNEXPECTED_FIELD");
    if (typeof value.authProviderId !== "string") throw new Error("MCP_AUTH_PROVIDER_NOT_FOUND");
    const auth = this.authProviders.get(value.authProviderId);
    if (!auth) throw new Error("MCP_AUTH_PROVIDER_NOT_FOUND");
    if (value.endpoint !== auth.endpoint) throw new Error("MCP_AUTH_ENDPOINT_MISMATCH");
    if (this.connectors.has(value.id)) throw new Error("MCP_CONNECTOR_EXISTS");
    const connector = structuredClone(value);
    this.connectors.set(value.id, connector);
    return structuredClone(connector);
  }

  resolve(id: string): { connector: McpConnector; authProvider: McpAuthProvider } {
    const connector = this.connectors.get(id);
    if (!connector) throw new Error("MCP_CONNECTOR_NOT_FOUND");
    const authProvider = this.authProviders.get(connector.authProviderId);
    if (!authProvider) throw new Error("MCP_AUTH_PROVIDER_NOT_FOUND");
    if (connector.endpoint !== authProvider.endpoint) throw new Error("MCP_AUTH_ENDPOINT_MISMATCH");
    return { connector: structuredClone(connector), authProvider };
  }

  list(): McpConnector[] {
    return [...this.connectors.values()].map(value => structuredClone(value));
  }
}
