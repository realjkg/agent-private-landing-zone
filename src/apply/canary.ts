import { codeOf, reasonOf, stop, stopBecause } from "./engine.js";
import type { PilotCanary } from "./types.js";

/**
 * The canary allowlist judge (owner decision E1; docs/act-pilot-apply.md, "Canary allowlist"). An APPLY may create exactly the
 * resource types and counts its target's `canary` names, and do nothing else: no update, delete, replace, import, move or unknown
 * action, no type the allowlist does not name (an IAM role or a role assignment included), and no count above or below the one
 * listed. It judges what an engine read from its own artifact (Terraform's `show -json` of the plan file, CloudFormation's
 * template and change set), never a summary, and an engine calls it at seal, at the qualification plan and again when an apply
 * re-derives the change list. A cleanup has its own path and never comes here. The refusal reason names addresses, types,
 * actions and counts only, which the redacted change list already shows the approvers; never a value.
 */
export const RESOURCE_NOT_IN_CANARY = "RESOURCE_NOT_IN_CANARY";
export const CANARY_ALLOWLIST_MISSING = "CANARY_ALLOWLIST_MISSING";

/**
 * The types a canary entry may mark `retain: true` (created at APPLY, intentionally kept at CLEANUP): a small reviewed list of no-cost,
 * inert sentinels only. Today exactly `AWS::CloudFormation::WaitConditionHandle`, which keeps a CDK canary's stack from being emptied by
 * its cleanup (CLEANUP_WOULD_EMPTY_STACK). A `retain` on any other type is refused when the contract is read. A type joins by review.
 */
export const RETAINABLE_CANARY_TYPES: ReadonlySet<string> = new Set(["AWS::CloudFormation::WaitConditionHandle"]);

/** One resource the artifact would touch: its address, its type, its action as the engine reports it, and whether that action is a plain create. */
export type CanaryEntry = { address: string; type: string; action: string; creates: boolean };

const MAX_REASON = 200;
const clip = (text: string): string => (text.length > MAX_REASON ? text.slice(0, MAX_REASON) + "..." : text);

/** Throws `RESOURCE_NOT_IN_CANARY` with the first reason found, or `CANARY_ALLOWLIST_MISSING` when the target names no canary. */
export function assertCanary(canary: PilotCanary | undefined, entries: readonly CanaryEntry[], what: string): void {
  if (!canary || !Array.isArray(canary.resources) || canary.resources.length === 0) return stop(CANARY_ALLOWLIST_MISSING);
  const listed = new Map(canary.resources.map((resource) => [resource.type, resource.count]));
  for (const entry of entries) {
    if (!entry.creates) {
      stopBecause(RESOURCE_NOT_IN_CANARY, clip(entry.address) + " (" + clip(entry.type) + "): the " + what + " would " + clip(entry.action) + " it; the canary allows create only");
    }
    if (!listed.has(entry.type)) stopBecause(RESOURCE_NOT_IN_CANARY, clip(entry.address) + ": type " + clip(entry.type) + " is not in the canary allowlist");
  }
  for (const [type, count] of listed) {
    const found = entries.filter((entry) => entry.type === type).length;
    if (found !== count) stopBecause(RESOURCE_NOT_IN_CANARY, type + ": the " + what + " creates " + found + ", the canary allowlist names exactly " + count);
  }
}

/**
 * The refusal a seal, a qualification plan or an apply reports for a canary stop, with its reason, or undefined for any other
 * error. `outcome` says what did not happen ("Nothing was sealed.", "Nothing was applied and no approval was consumed.").
 */
export function canaryRefusal(error: unknown, outcome: string): { code: "RESOURCE_NOT_IN_CANARY" | "CANARY_ALLOWLIST_MISSING"; message: string } | undefined {
  const code = codeOf(error);
  if (code === CANARY_ALLOWLIST_MISSING) {
    return { code, message: "The contract's target names no canary allowlist, so nothing may be created there. " + outcome + " Only the owner's reviewed commit of the contract can add one." };
  }
  if (code !== RESOURCE_NOT_IN_CANARY) return undefined;
  return {
    code, message: "The plan does not create exactly what the contract's canary allowlist names: " + (reasonOf(error) ?? "a change outside it") + ". " + outcome +
      " Change the project so it creates exactly the listed types and counts and nothing else, or have the owner change the allowlist in a reviewed commit (docs/act-pilot-apply.md, \"Canary allowlist\").",
  };
}
