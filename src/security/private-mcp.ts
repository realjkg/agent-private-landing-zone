import type { AddressInfo } from "node:net";
import type { UnifiedOperations } from "../operations/unified.js";
import { StudioMcpAdapter } from "../integrations/ai-studio/operations-mcp.js";
import { createPrivateMcpServer } from "../integrations/ai-studio/operations-mcp-http.js";
import { createMcpJwtVerifier, type McpJwtPolicy } from "./mcp-jwt.js";

/** Trusted-host bootstrap. A private TLS proxy on the same host is required.
 * Bind is enforced here; a caller cannot select a public/wildcard address.
 * No environment flag or request metadata may supply a verified identity.
 */
export async function startAuthenticatedPrivateMcp(options: {
  operations: UnifiedOperations; policy: McpJwtPolicy; port: number;
}) {
  if (!Number.isSafeInteger(options.port) || options.port < 0 || options.port > 65535)
    throw new Error("MCP_PORT_INVALID");
  const server = createPrivateMcpServer({
    adapter: new StudioMcpAdapter(options.operations),
    verifyBearer: createMcpJwtVerifier(options.policy)
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, "127.0.0.1", () => { server.off("error", reject); resolve(); });
  });
  return { server, address: server.address() as AddressInfo };
}
