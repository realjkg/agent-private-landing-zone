import type { UnifiedOperations, VerifiedCaller, OperationsResult } from "./unified.js";

/**
 * Local ./alz / loopback workspace entry adapter.
 * The caller comes from an authenticated host-owned identity resolver, never
 * CLI flags, HTTP headers, model text, or unverified client assertions.
 *
 * Studio enters the exact same UnifiedOperations through StudioMcpAdapter.
 * Neither entry adapter can widen scopes or authorize mutation.
 */
export type LocalIdentityResolver = {
  resolveLocalCaller(): Promise<VerifiedCaller | null>;
};
export type LocalEntryResult =
  | { ok: true; operations: ReturnType<UnifiedOperations["list"]> }
  | { ok: false; error: "LOCAL_AUTH_REQUIRED" | "LOCAL_ACCESS_DENIED" };

export class LocalOperationsAdapter {
  constructor(
    private readonly operations: UnifiedOperations,
    private readonly identity: LocalIdentityResolver,
  ) {}
  private async caller(): Promise<VerifiedCaller | null> {
    try {
      const caller = await this.identity.resolveLocalCaller();
      return caller?.verifiedBy === "TRUSTED_GATEWAY" ? caller : null;
    } catch {
      return null;
    }
  }
  async list(): Promise<LocalEntryResult> {
    const caller = await this.caller();
    if (!caller) return { ok: false, error: "LOCAL_AUTH_REQUIRED" };
    try { return { ok: true, operations: this.operations.list(caller) }; }
    catch { return { ok: false, error: "LOCAL_ACCESS_DENIED" }; }
  }
  async invoke(id: string, inputs: unknown = {}): Promise<OperationsResult> {
    const caller = await this.caller();
    if (!caller) return { ok: false, operation: id, traceId: "unverified", error: "LOCAL_AUTH_REQUIRED" };
    return this.operations.invoke(caller, id, inputs);
  }
}
