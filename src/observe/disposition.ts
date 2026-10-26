import type { Blueprint } from "./blueprint.js";
import { readerOf, unexpectedOf, type Existence, type ReaderInput } from "./verify.js";

/**
 * The cleanup disposition of one journey (docs/observe-and-cleanup.md): for every resource the apply left, whether it is
 * now gone or deliberately kept. It reads; it deletes nothing. Executing a destroy needs its own plan
 * (docs/act-pilot-plan.md), and this module is the check that runs after one, or after a person removed resources by hand.
 *
 * DELETED: the cloud says the resource no longer exists. RETAINED: a named owner keeps it, for a stated reason.
 * LEFTOVER: it still exists and nobody kept it. UNPROVEN: the cloud check could not decide, so it is not called deleted.
 */
export type RetentionDecision = { address: string; owner: string; reason: string };
export type Disposition = {
  address: string;
  type: string;
  identifier: string | null;
  existence: Existence;
  disposition: "DELETED" | "RETAINED" | "LEFTOVER" | "UNPROVEN";
  owner?: string;
  reason?: string;
};
export type CleanupReport = {
  /**
   * CLEAN: the blueprint names resources, every one is DELETED or RETAINED, nothing planned is unaccounted for, and a
   * complete tag listing finds nothing else of this run. LEFTOVERS: something of this run still exists that nobody kept.
   * INCONCLUSIVE: anything else; `unresolved` says what, and completion is never reported.
   */
  verdict: "CLEAN" | "LEFTOVERS" | "INCONCLUSIVE";
  dispositions: Disposition[];
  /** Kept resources the cloud reports gone: the retention record no longer matches the cloud. */
  retainedButAbsent: string[];
  /** ARNs still tagged with this run's unit that the blueprint does not name: leftovers outside the state. */
  untrackedLeftovers: string[];
  inventory: "COMPLETE" | "INCOMPLETE" | "NOT_AVAILABLE";
  /** What stops a CLEAN verdict. With LEFTOVERS it can also list what else is unresolved. */
  unresolved: string[];
};

const named = (value: unknown, min: number): value is string => typeof value === "string" && value.trim().length >= min;

/** Refuses retention decisions that name no owner or reason, name a resource the blueprint lacks, or repeat one. */
export function retentionProblems(blueprint: Blueprint, retained: readonly RetentionDecision[]): string[] {
  const addresses = new Set(blueprint.entries.map((entry) => entry.address));
  const seen = new Set<string>();
  const problems: string[] = [];
  for (const decision of retained) {
    if (!addresses.has(decision.address)) problems.push(decision.address + ": not a resource of this journey");
    if (seen.has(decision.address)) problems.push(decision.address + ": kept twice");
    seen.add(decision.address);
    if (!named(decision.owner, 2)) problems.push(decision.address + ": a kept resource needs an owner");
    if (!named(decision.reason, 10)) problems.push(decision.address + ": a kept resource needs a reason");
  }
  return problems;
}

/**
 * The disposition of every resource in the blueprint, after cleanup. Throws on invalid retention decisions.
 *
 * The blueprint must be the one recorded when the journey was observed, not one rebuilt from the state after a destroy:
 * an empty blueprint, or one with planned resources it never mapped, proves nothing and is never CLEAN.
 */
export async function cleanupDisposition(blueprint: Blueprint, retained: readonly RetentionDecision[],
  input: { unitId: string | null } & ReaderInput): Promise<CleanupReport> {
  const problems = retentionProblems(blueprint, retained);
  if (problems.length > 0) throw new Error("RETENTION_INVALID: " + problems.join("; "));
  const reader = readerOf(input);
  const kept = new Map(retained.map((decision) => [decision.address, decision]));
  const dispositions: Disposition[] = [];
  const retainedButAbsent: string[] = [];
  for (const entry of blueprint.entries) {
    const check = await reader.check(entry);
    const base = { address: entry.address, type: entry.type, identifier: check.identifier, existence: check.existence };
    const decision = kept.get(entry.address);
    if (decision) {
      if (check.existence === "ABSENT") retainedButAbsent.push(entry.address);
      dispositions.push({ ...base, disposition: "RETAINED", owner: decision.owner.trim(), reason: decision.reason.trim() });
    } else {
      dispositions.push({ ...base, disposition: check.existence === "ABSENT" ? "DELETED" : check.existence === "PRESENT" && !check.pendingDeletion ? "LEFTOVER" : "UNPROVEN" });
    }
  }
  const listed = input.unitId === null ? null : unexpectedOf(blueprint, await reader.listTagged(input.unitId));
  const inventory = listed === null ? "NOT_AVAILABLE" : listed.complete ? "COMPLETE" : "INCOMPLETE";
  const untrackedLeftovers = listed?.unexpected ?? [];
  const unresolved = [
    ...(blueprint.entries.length === 0 ? ["the blueprint names no resources, so nothing was shown to be deleted"] : []),
    ...blueprint.missing.map((address) => address + " was planned but never mapped to a cloud identifier"),
    ...dispositions.filter((x) => x.disposition === "UNPROVEN").map((x) => x.existence === "PRESENT" ? x.address + " is scheduled for deletion and not yet gone" : x.address + " could not be checked (" + x.existence + ")"),
    ...retainedButAbsent.map((address) => address + " is kept but the cloud reports it gone"),
    ...(inventory === "NOT_AVAILABLE" ? ["this run carries no unit tag, so resources outside the state cannot be looked for"] : []),
    ...(inventory === "INCOMPLETE" ? ["the tag listing was incomplete"] : []),
  ];
  const verdict = dispositions.some((x) => x.disposition === "LEFTOVER") || untrackedLeftovers.length > 0 ? "LEFTOVERS"
    : unresolved.length === 0 ? "CLEAN" : "INCONCLUSIVE";
  return { verdict, dispositions, retainedButAbsent, untrackedLeftovers, inventory, unresolved };
}
