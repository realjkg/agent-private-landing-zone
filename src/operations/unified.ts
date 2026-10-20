import { sanitizeDiagnosticText } from "../observability/redaction.js";
import { randomUUID } from "node:crypto";
import { OPERATIONS } from "./registry.js";
import { describeOperation } from "./schema.js";
import { planOperation, runPlanned } from "./run.js";
import type { OperatorJob, OperationSpec } from "./types.js";

/** The CLI, console and MCP adapter can share this operator service. */
export type OperationsIdentity = {
  subject: string;
  audience: string;
  scopes: readonly string[];
  expiresAt: number;
  traceId: string;
};
export type VerifiedCaller = { identity: OperationsIdentity; verifiedBy: "TRUSTED_GATEWAY" };
export type OperationsRunner = (job: OperatorJob, root: string) => Promise<string>;
export type OperationsDeps = {
  root: string;
  runner: OperationsRunner;
  audience: string;
  catalog?: readonly OperationSpec[];
  now?: () => number;
};
export type OperationsResult =
  | { ok: true; operation: string; traceId: string; output: string }
  | { ok: false; operation: string; traceId: string; error: string };
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/;

/**
 * The MCP adapter does not grant cloud access, local file mutation or inference.
 * Only strictly READ_ONLY entries can be invoked using a verified identity.
 * Authentication is provided by a real token-verifying transport/gateway.
 */
export class UnifiedOperations {
  private readonly catalog: readonly OperationSpec[];
  constructor(private readonly deps: OperationsDeps) {
    this.catalog = deps.catalog ?? OPERATIONS;
  }
  private authorized(caller: VerifiedCaller, scope: string): boolean {
    const id = caller?.identity;
    return caller?.verifiedBy === "TRUSTED_GATEWAY" &&
      !!id && IDENTIFIER.test(id.subject) && IDENTIFIER.test(id.traceId) &&
      id.audience === this.deps.audience && Number.isFinite(id.expiresAt) &&
      id.expiresAt > (this.deps.now?.() ?? Date.now()) &&
      id.scopes.includes(scope);
  }
  list(caller: VerifiedCaller): ReturnType<typeof describeOperation>[] {
    if (!this.authorized(caller, "ALZ_DISCOVERY_READ")) throw new Error("OPERATIONS_UNAUTHORIZED");
    return this.catalog.filter(op => op.safety === "READ_ONLY").map(describeOperation);
  }
  async invoke(caller: VerifiedCaller, id: string, inputs: unknown = {}): Promise<OperationsResult> {
    const traceId = IDENTIFIER.test(caller?.identity?.traceId ?? "") ? caller.identity.traceId : randomUUID();
    if (!this.authorized(caller, "ALZ_DISCOVERY_READ"))
      return {ok:false,operation:id,traceId,error:"OPERATIONS_UNAUTHORIZED"};
    const op = this.catalog.find(item=>item.id===id);
    if (!op || op.safety !== "READ_ONLY" || !op.job)
      return {ok:false,operation:id,traceId,error:"OPERATIONS_READ_ONLY_DENIED"};
    // Never expose a local executable or path through the network contract.
    try {
      const inputText = JSON.stringify(inputs);
      if (Buffer.byteLength(inputText,"utf8") > 64*1024) throw new Error("OPERATIONS_PAYLOAD_TOO_LARGE");
      const plan = planOperation(id,inputText,this.catalog);
      const output = await runPlanned(plan,this.deps.root,this.deps.runner);
      // External clients must not receive uncontrolled command stdout.
      return {ok:true,operation:id,traceId,output:sanitizeDiagnosticText(output,8192)};
    } catch (error) {
      const code = error instanceof Error ? error.message : "OPERATIONS_FAILED";
      return {ok:false,operation:id,traceId,error:/^(INPUT_|INPUTS_|OPERATION_|UNSUPPORTED_|OPERATIONS_)/.test(code)?code:"OPERATIONS_FAILED"};
    }
  }
}
