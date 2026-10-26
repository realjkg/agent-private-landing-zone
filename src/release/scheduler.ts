import { runnableTasks, type WorkGraph, type WorkNode, type WorkOwner } from "./work-graph.js";

/**
 * The release scheduler's decision step (docs/work-graph.md). Each tick it reads the work graph and what GitHub shows
 * for every PR, and returns the actions for that tick: start a dependency-ready task under one owner, review a head,
 * merge an eligible head, send a blocking finding back to its owner, or escalate. It decides; it executes nothing. The
 * runner (a scheduled tick of the coordinating session, resumed from the checkpoint) carries the actions out.
 *
 * A blocked task stops only the tasks that depend on it; everything else keeps moving.
 */

/** What GitHub shows for one PR at the moment of the tick. */
export type PrFacts = {
  pr: number;
  head: string;
  open: boolean;
  merged: boolean;
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
  /** The PR introduces a security exception or a policy change that needs the owner. */
  policyChange: boolean;
  /** The PR is explicitly on hold. */
  onHold: boolean;
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

/** The nine mandate conditions, as the reasons a head may not merge yet. Empty means it may merge. */
export function mergeBlockers(facts: PrFacts): string[] {
  const reasons: string[] = [];
  if (!facts.open || facts.merged) reasons.push("not an open PR");
  if (facts.onHold) reasons.push("on hold");
  if (!facts.checksGreen) reasons.push("required checks not green on " + facts.head.slice(0, 7));
  if (!facts.qaPassed) reasons.push("affected QA not passed on " + facts.head.slice(0, 7));
  if (!facts.verdict) reasons.push("no independent review");
  else if (facts.verdict.head !== facts.head) reasons.push("the review is of " + facts.verdict.head.slice(0, 7) + ", not the current head");
  else if (facts.verdict.result !== "NO_BLOCKING_ISSUES") reasons.push("the review found blocking issues");
  if (facts.laterBlocking) reasons.push("a later comment raises a blocking finding");
  if (!facts.compatibleWithMain) reasons.push("not compatible with current main");
  if (facts.policyChange) reasons.push("introduces a policy or security change the owner decides");
  return reasons;
}

/**
 * The actions for one tick. Integration is serialized: at most one MERGE per tick, the first eligible one in graph
 * order. Reviews and lanes stay within the budget. A task past its repair limit escalates and stops only itself.
 */
export function schedule(graph: WorkGraph, prs: readonly PrFacts[], state: SchedulerState, budget: Budget = OWNER_BUDGET): Action[] {
  const actions: Action[] = [];
  const byPr = new Map(prs.map((facts) => [facts.pr, facts]));
  let reviewers = state.reviewing.length;
  let merged = false;
  const openPrs = (node: WorkNode) => (node.prs ?? []).map((pr) => byPr.get(pr)).filter((x): x is PrFacts => x !== undefined && x.open && !x.merged);

  for (const node of graph.nodes) {
    if (node.status === "DONE" || node.status === "HOLD") continue;
    for (const facts of openPrs(node)) {
      if (facts.onHold) continue;
      if (facts.repairRounds > budget.maxRepairRounds) {
        actions.push({ kind: "ESCALATE", task: node.id, pr: facts.pr, reason: facts.repairRounds + " repair rounds on the same root problem" });
        continue;
      }
      if (facts.policyChange) { actions.push({ kind: "ESCALATE", task: node.id, pr: facts.pr, reason: "a policy or security change the owner decides" }); continue; }
      const blockers = mergeBlockers(facts);
      if (blockers.length === 0) {
        if (!merged) { actions.push({ kind: "MERGE", task: node.id, pr: facts.pr, head: facts.head, verdictCommentId: facts.verdict!.commentId }); merged = true; }
        else actions.push({ kind: "WAIT", task: node.id, pr: facts.pr, reason: "integration is serialized; one merge per tick" });
        continue;
      }
      if (facts.checksFailed || facts.laterBlocking || (facts.verdict?.head === facts.head && facts.verdict.result === "BLOCKING")) {
        actions.push({ kind: "FIX", task: node.id, pr: facts.pr, head: facts.head, owner: node.owner,
          reason: facts.checksFailed ? "a required check failed" : facts.laterBlocking ? "a later comment raises a blocking finding" : "the review found blocking issues" });
        continue;
      }
      const reviewed = facts.verdict?.head === facts.head;
      const underReview = state.reviewing.some((x) => x.pr === facts.pr && x.head === facts.head);
      if (facts.checksGreen && facts.qaPassed && !reviewed && !underReview) {
        if (reviewers < budget.reviewers) { actions.push({ kind: "REVIEW", task: node.id, pr: facts.pr, head: facts.head }); reviewers += 1; }
        else actions.push({ kind: "WAIT", task: node.id, pr: facts.pr, reason: "the reviewer slot is in use" });
        continue;
      }
      actions.push({ kind: "WAIT", task: node.id, pr: facts.pr, reason: blockers.join("; ") });
    }
  }

  // Start dependency-ready work that has no worker and no open PR, one owner per task, lanes within the budget.
  let lanes = Object.values(state.active).filter((owner) => owner === "LANE").length;
  for (const node of runnableTasks(graph)) {
    if (state.active[node.id] || openPrs(node).length > 0) continue;
    if (node.owner === "OWNER" || node.owner === "EXTERNAL" || node.owner === "DEPENDABOT") continue;
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
