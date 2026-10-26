import { runnableTasks, type WorkGraph, type WorkNode, type WorkOwner } from "./work-graph.js";

/**
 * The release scheduler's decision step (docs/work-graph.md). Each tick it reads the work graph and what GitHub shows
 * for every PR, and returns the actions for that tick: start a dependency-ready task under one owner, review a head,
 * merge an eligible head, send a blocking finding back to its owner, or escalate. It decides; it executes nothing. The
 * runner (a scheduled tick of the coordinating session, resumed from the checkpoint) carries the actions out.
 *
 * A blocked task stops only the tasks that depend on it; everything else keeps moving.
 */

/**
 * What GitHub and the coordinator show for one PR at the moment of the tick. The runner supplies facts for every PR the
 * graph lists, closed and merged ones included: a listed PR without facts holds its task in WAIT.
 */
export type PrFacts = {
  pr: number;
  head: string;
  open: boolean;
  merged: boolean;
  /** The change stays within the declared release scope (config/release/scope.json) and its task. */
  inScope: boolean;
  /** Every required check on `head` passed. */
  checksGreen: boolean;
  /** A required check on `head` failed (as opposed to still running). */
  checksFailed: boolean;
  /** Affected QA passed on `head`. */
  qaPassed: boolean;
  /** The latest independent review verdict, and the head it reviewed. */
  verdict?: { result: "NO_BLOCKING_ISSUES" | "BLOCKING"; head: string; commentId: number };
  /** A comment posted after that verdict, from any source, raises a blocking finding not yet resolved. */
  laterBlocking: boolean;
  /** The branch merges cleanly into current main. */
  compatibleWithMain: boolean;
  /** The head the PR's recorded evidence names (its QA and check results). */
  evidenceHead?: string;
  /** The PR introduces a security exception or a policy change that needs the owner. */
  policyChange: boolean;
  /** The PR is explicitly on hold. */
  onHold: boolean;
  /** Branch protection permits this merge without bypassing a rule, a required review or a failed check. */
  protectionsPermit: boolean;
  /** Repair rounds already spent on the same root problem. */
  repairRounds: number;
};

export type SchedulerState = {
  /** Tasks with a live worker, and who it is. */
  active: Record<string, WorkOwner>;
  /** PR heads with a review running. */
  reviewing: { pr: number; head: string }[];
};

export type Budget = { lanes: number; reviewers: number; maxRepairRounds: number };
/** The owner's budget (#39 6408800595): one implementation lane, one concurrent reviewer; the mandate's two-repair rule. */
export const OWNER_BUDGET: Budget = { lanes: 1, reviewers: 1, maxRepairRounds: 2 };

export type Action =
  | { kind: "MERGE"; task: string; pr: number; head: string; verdictCommentId: number }
  | { kind: "REVIEW"; task: string; pr: number; head: string }
  | { kind: "FIX"; task: string; pr: number; head: string; owner: WorkOwner; reason: string }
  | { kind: "DISPATCH"; task: string; owner: WorkOwner }
  | { kind: "ESCALATE"; task: string; pr?: number; reason: string }
  | { kind: "WAIT"; task: string; pr?: number; reason: string };

const FULL_SHA = /^[0-9a-f]{40}$/;

/**
 * The nine mandate conditions, as the reasons a head may not merge yet, in the mandate's order. Empty means it may merge.
 * A fact that contradicts another (green checks with a failed one, a head that is not a commit) is read as not met.
 */
export function mergeBlockers(facts: PrFacts): string[] {
  const reasons: string[] = [];
  const head = FULL_SHA.test(facts.head) ? facts.head : null;
  if (!facts.open || facts.merged) reasons.push("not an open PR");
  if (head === null) reasons.push("the head is not a full commit SHA");
  // 1. Within the approved scope.
  if (!facts.inScope) reasons.push("outside the declared release scope");
  // 2. Independent review complete, on the current head.
  if (!facts.verdict) reasons.push("no independent review");
  else if (head === null || facts.verdict.head !== head) reasons.push("the review is of " + facts.verdict.head.slice(0, 7) + ", not the current head");
  // 3. Required checks pass on the current head.
  if (!facts.checksGreen || facts.checksFailed) reasons.push("required checks not green on " + facts.head.slice(0, 7));
  if (!facts.qaPassed) reasons.push("affected QA not passed on " + facts.head.slice(0, 7));
  // 4. Findings resolved, including any raised after the verdict.
  if (facts.verdict && facts.verdict.result !== "NO_BLOCKING_ISSUES") reasons.push("the review did not report NO_BLOCKING_ISSUES");
  if (facts.laterBlocking) reasons.push("a later comment raises a blocking finding");
  // 5. Compatible with main.
  if (!facts.compatibleWithMain) reasons.push("not compatible with current main");
  // 6. Evidence is current and names the reviewed head.
  if (head === null || facts.evidenceHead !== head) reasons.push("the evidence does not name the current head");
  // 7. No new security exception or policy change.
  if (facts.policyChange) reasons.push("introduces a policy or security change the owner decides");
  // 8. Not on hold.
  if (facts.onHold) reasons.push("on hold");
  // 9. Protections permit it.
  if (!facts.protectionsPermit) reasons.push("branch protection does not permit the merge");
  return reasons;
}

/**
 * The actions for one tick. Integration is serialized: at most one MERGE per tick, the first eligible one in graph
 * order, and only for a task that is not BLOCKED and whose dependencies are all DONE. Reviews and lanes stay within the
 * budget. A task that needs another repair after its limit escalates, which stops it and, through the dependency rule,
 * its dependents; nothing else.
 */
export function schedule(graph: WorkGraph, prs: readonly PrFacts[], state: SchedulerState, budget: Budget = OWNER_BUDGET): Action[] {
  const actions: Action[] = [];
  const byPr = new Map(prs.map((facts) => [facts.pr, facts]));
  const done = new Set(graph.nodes.filter((node) => node.status === "DONE").map((node) => node.id));
  let reviewers = state.reviewing.length;
  let merged = false;
  const openPrs = (node: WorkNode) => (node.prs ?? []).map((pr) => byPr.get(pr)).filter((x): x is PrFacts => x !== undefined && x.open && !x.merged);

  for (const node of graph.nodes) {
    if (node.status === "DONE" || node.status === "HOLD") continue;
    const waitingOn = node.dependsOn.filter((id) => !done.has(id));
    for (const facts of openPrs(node)) {
      if (facts.onHold) continue;
      if (node.status === "BLOCKED") { actions.push({ kind: "WAIT", task: node.id, pr: facts.pr, reason: "the task is blocked: " + (node.blockedBy ?? "") }); continue; }
      if (facts.policyChange) { actions.push({ kind: "ESCALATE", task: node.id, pr: facts.pr, reason: "a policy or security change the owner decides" }); continue; }
      const blockers = mergeBlockers(facts);
      if (blockers.length === 0) {
        if (waitingOn.length > 0) actions.push({ kind: "WAIT", task: node.id, pr: facts.pr, reason: "its dependencies are not DONE: " + waitingOn.join(", ") });
        else if (!merged) { actions.push({ kind: "MERGE", task: node.id, pr: facts.pr, head: facts.head, verdictCommentId: facts.verdict!.commentId }); merged = true; }
        else actions.push({ kind: "WAIT", task: node.id, pr: facts.pr, reason: "integration is serialized; one merge per tick" });
        continue;
      }
      const fixReason = facts.checksFailed ? "a required check failed" : facts.laterBlocking ? "a later comment raises a blocking finding"
        : facts.verdict?.head === facts.head && facts.verdict.result === "BLOCKING" ? "the review found blocking issues" : null;
      if (fixReason !== null) {
        // Rounds already spent; one more would exceed the limit.
        if (facts.repairRounds >= budget.maxRepairRounds) actions.push({ kind: "ESCALATE", task: node.id, pr: facts.pr, reason: facts.repairRounds + " repair rounds on the same root problem; " + fixReason });
        else actions.push({ kind: "FIX", task: node.id, pr: facts.pr, head: facts.head, owner: node.owner, reason: fixReason });
        continue;
      }
      const reviewed = facts.verdict?.head === facts.head;
      const underReview = state.reviewing.some((x) => x.pr === facts.pr && x.head === facts.head);
      if (facts.checksGreen && !facts.checksFailed && facts.qaPassed && !reviewed && !underReview) {
        if (reviewers < budget.reviewers) { actions.push({ kind: "REVIEW", task: node.id, pr: facts.pr, head: facts.head }); reviewers += 1; }
        else actions.push({ kind: "WAIT", task: node.id, pr: facts.pr, reason: "the reviewer slot is in use" });
        continue;
      }
      actions.push({ kind: "WAIT", task: node.id, pr: facts.pr, reason: blockers.join("; ") });
    }
  }

  // Start dependency-ready work that has no worker and no PR in flight, one owner per task, lanes within the budget.
  // A PR the tick has no facts for, or a merged PR the graph has not recorded, means the task may already be under way:
  // it waits for the record to catch up instead of getting a second owner.
  let lanes = Object.values(state.active).filter((owner) => owner === "LANE").length;
  for (const node of runnableTasks(graph)) {
    if (state.active[node.id] || openPrs(node).length > 0) continue;
    if (node.owner === "OWNER" || node.owner === "EXTERNAL" || node.owner === "DEPENDABOT") continue;
    const unknown = (node.prs ?? []).filter((pr) => !byPr.has(pr));
    const mergedPrs = (node.prs ?? []).filter((pr) => byPr.get(pr)?.merged);
    const unrecorded = mergedPrs.length > (node.merges ?? []).length ? mergedPrs : [];
    if (unknown.length > 0 || unrecorded.length > 0) {
      actions.push({ kind: "WAIT", task: node.id, reason: unknown.length > 0 ? "no facts for PR " + unknown.join(", ") : "merged PRs (" + unrecorded.join(", ") + ") outnumber the merges recorded; update the work graph" });
      continue;
    }
    if (node.owner === "LANE") {
      if (lanes >= budget.lanes) continue;
      lanes += 1;
    }
    actions.push({ kind: "DISPATCH", task: node.id, owner: node.owner });
  }
  return actions;
}

/**
 * The durable checkpoint the runner writes after every tick (a marked comment on the coordination issue), so a restarted
 * session resumes from it instead of from memory. A worker the checkpoint names but the new session cannot see is
 * presumed lost: its task goes back to the scheduler, which re-dispatches it to resume from the task's branch.
 */
export type Checkpoint = {
  schemaVersion: 1;
  tick: number;
  at: string;
  mainHead: string;
  state: SchedulerState;
  /** The actions the last tick decided, and what came of each. */
  last: { action: Action; outcome: "DONE" | "STARTED" | "FAILED" | "SKIPPED"; detail?: string }[];
};

export const CHECKPOINT_MARKER = "<!-- alz-release-scheduler-checkpoint -->";

/** The state to resume from: the checkpoint's, minus workers the resuming session has no handle on. */
export function resumeState(checkpoint: Checkpoint, liveWorkers: ReadonlySet<string>): SchedulerState {
  const active: Record<string, WorkOwner> = {};
  for (const [task, owner] of Object.entries(checkpoint.state.active)) if (liveWorkers.has(task)) active[task] = owner;
  const reviewing = checkpoint.state.reviewing.filter((review) => liveWorkers.has("review:" + review.pr + ":" + review.head));
  return { active, reviewing };
}
