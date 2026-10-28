// Readiness-first ordering for the console's selections (owner decision E5, #39 6480066863). Pure: it reorders what the server
// reported and decides nothing. Being listed first never makes a path or an environment executable; the reviewed contract's
// path stays the only one that can run, behind every gate.
import type { DeploymentPath, EnvironmentDecision, PilotEnvironment } from "./pilot-api.js";

/**
 * 1 READY: the contract's path, with an environment that is Authorized, Ready and Approved.
 * 2 PARTIAL: implemented and in this release, waiting only on people's inputs (the owner's, or the operator's machine setup).
 * 3 BLOCKED: engineering or qualification work remains, or the data is incomplete.
 * 4 OUT: not in this release, or not implemented.
 */
export type ReadinessTier = 1 | 2 | 3 | 4;
export const TIER_WORDS: Readonly<Record<ReadinessTier, string>> = {
  1: "Ready", 2: "Waiting on owner inputs", 3: "Blocked: engineering or qualification", 4: "Not in this release",
};

const CLOUD_RANK = ["AWS", "AZURE", "GCP"];
const ENVIRONMENT_RANK: readonly PilotEnvironment[] = ["DEV", "QA", "PROD"];
const rank = (list: readonly string[], value: unknown): number => {
  const index = list.indexOf(String(value));
  return index === -1 ? list.length : index;
};
/** Terraform first, the native path second. */
const engineRank = (engine: unknown): number => engine === "TERRAFORM" ? 0 : 1;
const PEOPLE = new Set(["OWNER", "OPERATOR"]);

/** All three decisions are exactly true. Anything missing or unknown is not ready. */
export const environmentReady = (decision: Partial<EnvironmentDecision> | undefined | null): boolean =>
  decision?.authorized === true && decision.ready === true && decision.approved === true;

/** The tier of one path and how many blockers it still has. Unknown or malformed data is never tier 1. */
export function tierOf(path: Partial<DeploymentPath> | undefined | null): { tier: ReadinessTier; outstanding: number } {
  const blockers = Array.isArray(path?.blockers) ? path.blockers : undefined;
  const outstanding = blockers?.length ?? Number.POSITIVE_INFINITY;
  if (!path || path.inRelease !== true || path.journeyStatus === "NOT_IMPLEMENTED") return { tier: 4, outstanding };
  if (path.isContractPath === true && Array.isArray(path.decisions) && path.decisions.some(environmentReady)) return { tier: 1, outstanding };
  if (path.implemented === true && blockers !== undefined && blockers.every((b: { party?: unknown } | undefined) => PEOPLE.has(String(b?.party)))) return { tier: 2, outstanding };
  return { tier: 3, outstanding };
}

/**
 * Paths, readiest first: by tier; within the partial tier, fewer outstanding blockers first; ties keep a stable order by cloud
 * (AWS, Azure, GCP), then engine (Terraform, then native), then the order given.
 */
export function orderByReadiness<T extends Partial<DeploymentPath>>(paths: readonly T[]): T[] {
  return paths
    .map((path, index) => ({ path, index, ...tierOf(path) }))
    .sort((a, b) => a.tier - b.tier ||
      (a.tier === 2 ? a.outstanding - b.outstanding : 0) ||
      rank(CLOUD_RANK, a.path.cloud) - rank(CLOUD_RANK, b.path.cloud) ||
      engineRank(a.path.engine) - engineRank(b.path.engine) ||
      a.index - b.index)
    .map((item) => item.path);
}

export type EnvironmentChoice = {
  environment: PilotEnvironment;
  /** False only when the contract is known and does not enable it. Unknown data leaves every environment selectable, in today's order. */
  enabled: boolean;
  ready: boolean;
  /** Why it is disabled, in plain words; empty when enabled. */
  reason: string;
};

/**
 * DEV, QA and PROD for the wizard: READY first, then enabled environments by fewest unmet readiness items (not yet checked
 * after checked), then the ones the contract does not enable, kept visible but disabled. Without decisions, today's order.
 */
export function orderEnvironments(decisions: readonly EnvironmentDecision[] | null | undefined, environments: readonly PilotEnvironment[] = ENVIRONMENT_RANK): EnvironmentChoice[] {
  if (!Array.isArray(decisions) || decisions.length === 0) return environments.map((environment) => ({ environment, enabled: true, ready: false, reason: "" }));
  const items = environments.map((environment, index) => {
    const decision = decisions.find((d) => d.environment === environment);
    const enabled = decision?.authorized === true;
    const ready = environmentReady(decision);
    const tier = ready ? 1 : enabled ? 2 : 4;
    const outstanding = decision && decision.ready === false ? decision.notReady.length : Number.POSITIVE_INFINITY;
    const reason = enabled ? "" : "the owner's reviewed rules do not allow changes in " + environment;
    return { choice: { environment, enabled, ready, reason }, tier, outstanding, index };
  });
  return items
    .sort((a, b) => a.tier - b.tier || (a.tier === 2 ? (a.outstanding === b.outstanding ? 0 : a.outstanding < b.outstanding ? -1 : 1) : 0) ||
      rank(ENVIRONMENT_RANK, a.choice.environment) - rank(ENVIRONMENT_RANK, b.choice.environment) || a.index - b.index)
    .map((item) => item.choice);
}

/** The first sentence of a blocker, for a one-line row; the full text is in the row's details. */
export function firstSentence(text: string): string {
  const match = /^(.+?[.!?])(\s|$)/.exec(text.trim());
  return match ? match[1] : text.trim();
}
