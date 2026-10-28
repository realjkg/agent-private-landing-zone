import { evaluateOperatorRequest, type OperatorPolicyDecision } from "./operator-policy.js";
import { pilotHandoffKind, type HandoffKind } from "./pilot-answer.js";
import type { PilotQuery } from "./pilot-context.js";
import { classifyPilotQuery } from "./query.js";

/**
 * The order every session turn is decided in, first turn or later (review #326 rounds 4 and 5, deny by default):
 *
 * 1. The operator gate (src/session/operator-policy.ts), unchanged from main, runs first on every turn. A refusal on any
 *    boundary other than OUT_OF_SCOPE (secret disclosure, exfiltration, control bypass, arbitrary execution, …) stands:
 *    no read, no handoff wording, and nothing reaches the model.
 * 2. Then the pilot handoff and authority patterns: a request to approve, apply, clean up, change pilot authority or use
 *    hosted inference is refused with the person's or owner's exact step. They only choose refusal text and win over reads.
 * 3. Then a read-only pilot question (blueprint, preview, status, observed, failure, readiness), which only reads records.
 *    An OUT_OF_SCOPE refusal gives way to these two only; anything else keeps main's refusal.
 * 4. Otherwise, if the gate allowed it, the router decides as before.
 */
export type PilotTurn =
  | { kind: "READ"; query: PilotQuery }
  | { kind: "HANDOFF"; handoff: HandoffKind }
  | { kind: "REFUSED"; decision: Exclude<OperatorPolicyDecision, { allowed: true }> }
  | { kind: "CONTINUE" };

export function decidePilotTurn(request: string, hasSessionContext: boolean): PilotTurn {
  const decision = evaluateOperatorRequest(request, hasSessionContext);
  if (!decision.allowed && decision.boundary !== "OUT_OF_SCOPE") return { kind: "REFUSED", decision };
  const handoff = pilotHandoffKind(request);
  if (handoff) return { kind: "HANDOFF", handoff };
  const query = classifyPilotQuery(request.trim().toLowerCase());
  if (query) return { kind: "READ", query };
  return decision.allowed ? { kind: "CONTINUE" } : { kind: "REFUSED", decision };
}
