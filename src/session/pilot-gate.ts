import { evaluateOperatorRequest, type OperatorPolicyDecision } from "./operator-policy.js";
import { pilotHandoffKind, type HandoffKind } from "./pilot-answer.js";
import type { PilotQuery } from "./pilot-context.js";
import { classifyPilotQuery } from "./query.js";

/**
 * The order every session turn is decided in, first turn or later (review #326 rounds 4–6, deny by default):
 *
 * 1. The operator gate (src/session/operator-policy.ts), unchanged from main, runs first on every turn. A refusal on any
 *    boundary other than OUT_OF_SCOPE (secret disclosure, exfiltration, control bypass, arbitrary execution, …) stands:
 *    no read, no handoff wording, and nothing reaches the model.
 * 2. Pilot authority (contract, approvers, approvals, ledger, kill switch, ACT on or off) and hosted inference: refused
 *    with the owner-only or hosted answer.
 * 3. A read-only pilot question (blueprint, preview, status, observed, failure, readiness), which only reads records, so
 *    "can you tell me the status of the apply?" is a read.
 * 4. Approve, apply and clean-up imperatives: refused with the person's exact step.
 * 5. Main's OUT_OF_SCOPE refusal; otherwise the router decides as before.
 *
 * Steps 2 and 4 only choose refusal text; nothing here admits a request main's gate refuses, except to a read.
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
  if (handoff === "CONTRACT" || handoff === "HOSTED_INFERENCE") return { kind: "HANDOFF", handoff };
  const query = classifyPilotQuery(request.trim().toLowerCase());
  if (query) return { kind: "READ", query };
  if (handoff) return { kind: "HANDOFF", handoff };
  return decision.allowed ? { kind: "CONTINUE" } : { kind: "REFUSED", decision };
}
