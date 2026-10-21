import { UnifiedOperations, type OperationsDeps } from "../../operations/unified.js";
import { LocalOperationsAdapter, type LocalSessionVerifier } from "../../operations/local-adapter.js";
import { StudioMcpAdapter } from "../ai-studio/operations-mcp.js";
import { createPrivateMcpServer, type BearerVerifier } from "../ai-studio/operations-mcp-http.js";

/**
 * Both authenticated entry points share the SAME service instance, root,
 * allowlisted operation catalog, runner and authorization rules.
 * This wires no listeners and grants no AWS permissions.
 */
export function createDualEntryOperations(
  deps: OperationsDeps,
  authentication: {
    verifyLocalSession: LocalSessionVerifier;
    verifyStudioBearer: BearerVerifier;
  },
) {
  const operations = new UnifiedOperations(deps);
  const local = new LocalOperationsAdapter(operations, authentication.verifyLocalSession);
  const studio = new StudioMcpAdapter(operations);
  return {
    operations,
    local,
    studio,
    /** Caller explicitly binds the server to approved private loopback ingress. */
    createStudioServer: () => createPrivateMcpServer({
      adapter: studio,
      verifyBearer: authentication.verifyStudioBearer,
    }),
  };
}
