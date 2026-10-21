import { UnifiedOperations, type VerifiedCaller, type OperationsResult } from "./unified.js";
import type { OperationDescriptor } from "./types.js";

/**
 * Local CLI is a thin adapter to the same service used by Studio MCP.
 * A session can only come from a trusted host verifier; terminal input,
 * browser cookies and claims pasted by agents are not accepted as identities.
 */
export type LocalSessionVerifier = () => Promise<VerifiedCaller | null>;
export type LocalEntryResult =
  | { ok: true; operations: ReturnType<UnifiedOperations["list"]> }
  | { ok: false; error: "LOCAL_AUTH_REQUIRED" | "LOCAL_UNAUTHORIZED" };

export class LocalOperationsAdapter {
  constructor(
    private readonly operations: UnifiedOperations,
    private readonly verifySession: LocalSessionVerifier,
  ) {}

  private async caller(): Promise<VerifiedCaller | null> {
    try {
      const verified = await this.verifySession();
      return verified?.verifiedBy === "TRUSTED_GATEWAY" ? verified : null;
    } catch {
      return null;
    }
  }

  async list(): Promise<LocalEntryResult> {
    const caller = await this.caller();
    if (!caller) return { ok: false, error: "LOCAL_AUTH_REQUIRED" };
    try {
      return { ok: true, operations: this.operations.list(caller) };
    } catch {
      return { ok: false, error: "LOCAL_UNAUTHORIZED" };
    }
  }

  async invoke(operation: string, inputs: unknown = {}): Promise<OperationsResult> {
    const caller = await this.caller();
    if (!caller) return { ok: false, operation, traceId: "unverified", error: "OPERATIONS_UNAUTHORIZED" };
    return this.operations.invoke(caller, operation, inputs);
  }
}
