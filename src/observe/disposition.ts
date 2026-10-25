import type { Blueprint } from "./blueprint.js";
import { checkResource, type AwsCli, type Existence } from "./verify.js";

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
  /** CLEAN: every resource is DELETED or RETAINED. LEFTOVERS: something still exists that nobody kept. INCONCLUSIVE: otherwise. */
  verdict: "CLEAN" | "LEFTOVERS" | "INCONCLUSIVE";
  dispositions: Disposition[];
  /** Kept resources the cloud reports gone: the retention record no longer matches the cloud. */
  retainedButAbsent: string[];
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

/** The disposition of every resource in the blueprint, after cleanup. Throws on invalid retention decisions. */
export async function cleanupDisposition(blueprint: Blueprint, retained: readonly RetentionDecision[], input: { region: string; aws: AwsCli }):
  Promise<CleanupReport> {
  const problems = retentionProblems(blueprint, retained);
  if (problems.length > 0) throw new Error("RETENTION_INVALID: " + problems.join("; "));
  const kept = new Map(retained.map((decision) => [decision.address, decision]));
  const dispositions: Disposition[] = [];
  const retainedButAbsent: string[] = [];
  for (const entry of blueprint.entries) {
    const check = await checkResource(entry, input.region, input.aws);
    const base = { address: entry.address, type: entry.type, identifier: check.identifier, existence: check.existence };
    const decision = kept.get(entry.address);
    if (decision) {
      if (check.existence === "ABSENT") retainedButAbsent.push(entry.address);
      dispositions.push({ ...base, disposition: "RETAINED", owner: decision.owner.trim(), reason: decision.reason.trim() });
    } else {
      dispositions.push({ ...base, disposition: check.existence === "ABSENT" ? "DELETED" : check.existence === "PRESENT" ? "LEFTOVER" : "UNPROVEN" });
    }
  }
  const verdict = dispositions.some((x) => x.disposition === "LEFTOVER") ? "LEFTOVERS"
    : dispositions.every((x) => x.disposition === "DELETED" || x.disposition === "RETAINED") && retainedButAbsent.length === 0 ? "CLEAN"
    : "INCONCLUSIVE";
  return { verdict, dispositions, retainedButAbsent };
}
