import { evaluateOperatorRequest, type OperatorPolicyDecision } from "./operator-policy.js";
import { pilotHandoffKind, type HandoffKind } from "./pilot-answer.js";
import type { PilotQuery } from "./pilot-context.js";
import { classifyPilotQuery } from "./query.js";

/**
 * The order every session turn is decided in, first turn or later (review #326 round 4, deny by default):
 *
 * 1. READ: a read-only pilot question (blueprint, preview, status, observed, failure, readiness). It only reads records.
 * 2. HANDOFF: a request to approve, apply, clean up, change pilot authority (contract, approvers, approvals, ledger,
 *    kill switch, ACT on or off) or use hosted inference. Always refused, with the person's or owner's exact step. These
 *    patterns only choose the refusal text: they never admit anything.
 * 3. REFUSED: the operator gate (src/session/operator-policy.ts), unchanged from main, refused it.
 * 4. CONTINUE: the gate allowed it; the router decides as before.
 */
export type PilotTurn =
  | { kind: "READ"; query: PilotQuery }
  | { kind: "HANDOFF"; handoff: HandoffKind }
  | { kind: "REFUSED"; decision: Exclude<OperatorPolicyDecision, { allowed: true }> }
  | { kind: "CONTINUE" };

export function decidePilotTurn(request: string, hasSessionContext: boolean): PilotTurn {
  const query = classifyPilotQuery(request.trim().toLowerCase());
  if (query) return { kind: "READ", query };
  const handoff = pilotHandoffKind(request);
  if (handoff) return { kind: "HANDOFF", handoff };
  const decision = evaluateOperatorRequest(request, hasSessionContext);
  return decision.allowed ? { kind: "CONTINUE" } : { kind: "REFUSED", decision };
}
