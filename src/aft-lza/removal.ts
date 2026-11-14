import { canonical, sha256, type AccountObservation, type PipelineObservation } from "./workflow.js";

/**
 * Removing the pilot's account from LZA and AFT management, in the order AWS documents it:
 *
 *   1. AFT: the person merges the deletion of the account's `aft-account-request` entry. AFT then deletes the account's
 *      customization pipeline and metadata. The account stays managed by Control Tower.
 *   2. Control Tower: the person unmanages (unenrolls) the account.
 *   3. LZA: the person merges the change that moves the account under an ignored OU in organization-config.yaml and
 *      accounts-config.yaml, and the LZA Core pipeline runs on that commit.
 *
 * The run ends RETIRED once the account is observed under the ignored OU. Closing the account is account deletion: an owner
 * decision outside this run. This module decides; it never writes to a cloud or a repository, and it never closes an account.
 */

export const REMOVAL_WORKFLOW_ID = "aws-aft-lza-removal" as const;

export type RemovalCard = {
  runId: string;
  homeRegion: string;
  account: { accountId: string; name: string; email: string };
  ignoredOuId: string;
  aft: { repository: string; baseBranch: string; requestPipelineName: string; removalDigest: string };
  lza: { repository: string; baseBranch: string; pipelineName: string; configurationDigest: string };
};

export type RemovalObservations = {
  aftRemovalCommit?: string;
  aftRemovalExecution?: PipelineObservation;
  unmanagedAccountId?: string;
  lzaMoveCommit?: string;
  lzaMoveExecution?: PipelineObservation;
  account?: AccountObservation;
  accountLookup?: "FOUND" | "NOT_FOUND" | "ACCESS_DENIED";
};

export type RemovalPhase =
  | "AWAIT_AFT_REMOVAL" | "OBSERVE_AFT_REMOVAL" | "AWAIT_UNMANAGE" | "AWAIT_LZA_MOVE" | "OBSERVE_LZA_MOVE" | "CONFIRM_MOVED"
  | "RETIRED" | "FAILED" | "UNRESOLVED";

export type RemovalDecision = { phase: RemovalPhase; code: string; detail: string; nextAction: string; mutationByPerson: boolean };

const d = (phase: RemovalPhase, code: string, detail: string, nextAction: string, mutationByPerson = false): RemovalDecision =>
  ({ phase, code, detail, nextAction, mutationByPerson });

const HEX64 = /^[0-9a-f]{64}$/;
const SHA = /^[0-9a-f]{40}$/;
const ACCOUNT = /^\d{12}$/;
const OU = /^ou-[0-9a-z]{4,32}-[0-9a-z]{8,32}$/;
const REGION = /^[a-z]{2}(-gov)?-[a-z]+-\d$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function validateRemovalCard(card: RemovalCard): string[] {
  const issues: string[] = [];
  if (!card || typeof card !== "object") return ["the removal card is not an object"];
  if (!card.runId || !/^[A-Za-z0-9._-]{1,64}$/.test(card.runId)) issues.push("runId must be 1-64 safe characters");
  if (!REGION.test(card.homeRegion ?? "")) issues.push("homeRegion is unresolved or malformed");
  if (!ACCOUNT.test(card.account?.accountId ?? "")) issues.push("account.accountId must be the 12-digit id of the account to remove");
  if (!card.account?.name) issues.push("account.name is unresolved");
  if (!EMAIL.test(card.account?.email ?? "")) issues.push("account.email is unresolved or malformed");
  if (!OU.test(card.ignoredOuId ?? "")) issues.push("ignoredOuId must name the OU that LZA ignores, from the owner's organization-config.yaml");
  if (!HEX64.test(card.aft?.removalDigest ?? "")) issues.push("aft.removalDigest must be the sha256 of the approved account-request removal");
  if (!HEX64.test(card.lza?.configurationDigest ?? "")) issues.push("lza.configurationDigest must be the sha256 of the approved ignored-OU change");
  for (const [k, v] of [["aft.repository", card.aft?.repository], ["aft.baseBranch", card.aft?.baseBranch], ["aft.requestPipelineName", card.aft?.requestPipelineName],
    ["lza.repository", card.lza?.repository], ["lza.baseBranch", card.lza?.baseBranch], ["lza.pipelineName", card.lza?.pipelineName]] as const) {
    if (!v) issues.push(k + " is unresolved");
  }
  return issues;
}

export const removalCardDigest = (card: RemovalCard): string => sha256(canonical(card));

function bound(execution: PipelineObservation | undefined, pipeline: string, commit: string): "BOUND" | "UNRELATED" | "NONE" {
  if (!execution) return "NONE";
  return execution.pipelineName === pipeline && execution.sourceRevision === commit ? "BOUND" : "UNRELATED";
}

/** The next removal step. Pure: the same observations always give the same decision. */
export function decideRemoval(card: RemovalCard, obs: RemovalObservations): RemovalDecision {
  const issues = validateRemovalCard(card);
  if (issues.length > 0) return d("UNRESOLVED", "REMOVAL_CARD_INCOMPLETE", issues.join("; "), "Resolve the removal card fields from the owner's records.");
  const id = card.account.accountId;

  // Step 1: AFT first.
  if (!obs.aftRemovalCommit) {
    return d("AWAIT_AFT_REMOVAL", "AFT_REMOVAL_NOT_SUBMITTED", "Account " + id + " is still registered with AFT.",
      "Person: open, review and merge the approved deletion of account " + id + "'s request in " + card.aft.repository + "@" + card.aft.baseBranch + ", then record the merge commit.", true);
  }
  if (!SHA.test(obs.aftRemovalCommit)) return d("FAILED", "AFT_REMOVAL_COMMIT_MALFORMED", "The recorded AFT removal commit is not a full SHA.", "Record the full 40-character merge commit.");
  const aft = bound(obs.aftRemovalExecution, card.aft.requestPipelineName, obs.aftRemovalCommit);
  if (aft !== "BOUND") {
    return d("OBSERVE_AFT_REMOVAL", aft === "NONE" ? "AFT_REMOVAL_EXECUTION_NOT_FOUND" : "AFT_REMOVAL_EXECUTION_UNRELATED",
      "No " + card.aft.requestPipelineName + " execution bound to " + obs.aftRemovalCommit + " has been observed yet.", "Observe again; do not merge the removal a second time.");
  }
  const aftExec = obs.aftRemovalExecution!;
  if (aftExec.evidence !== "OBSERVED") return d("UNRESOLVED", "AFT_REMOVAL_EVIDENCE_SIMULATED", "The AFT removal execution is simulated.", "Observe the real pipeline execution.");
  if (aftExec.status === "InProgress") return d("OBSERVE_AFT_REMOVAL", "AFT_REMOVAL_RUNNING", "AFT execution " + aftExec.executionId + " is running.", "Keep observing the same execution.");
  if (aftExec.status === "Failed" || aftExec.status === "Stopped") {
    return d("FAILED", "AFT_REMOVAL_FAILED", "AFT execution " + aftExec.executionId + " ended " + aftExec.status + "; the account stays registered.",
      "Diagnose the AFT request pipeline and re-run it after review. Do not unmanage the account or change LZA yet.");
  }
  if (aftExec.status !== "Succeeded") return d("UNRESOLVED", "AFT_REMOVAL_STATUS_UNKNOWN", "AFT execution " + aftExec.executionId + " status is " + aftExec.status + ".", "Observe again.");

  // Step 2: Control Tower unenrollment, before LZA changes the OU.
  if (!obs.unmanagedAccountId) {
    return d("AWAIT_UNMANAGE", "NOT_UNMANAGED", "AFT no longer manages account " + id + "; Control Tower still does.",
      "Person: unmanage account " + id + " in AWS Control Tower, then record its account id.", true);
  }
  if (obs.unmanagedAccountId !== id) return d("FAILED", "UNMANAGED_ACCOUNT_MISMATCH", "The recorded unmanaged account " + obs.unmanagedAccountId + " is not " + id + ".", "Stop. Check which account was unmanaged in Control Tower.");

  // Step 3: LZA moves the account under the ignored OU.
  if (!obs.lzaMoveCommit) {
    return d("AWAIT_LZA_MOVE", "LZA_MOVE_NOT_SUBMITTED", "Account " + id + " is unmanaged; LZA still places it in a governed OU.",
      "Person: open, review and merge the approved change moving account " + id + " under " + card.ignoredOuId + " in " + card.lza.repository + "@" + card.lza.baseBranch + ", then record the merge commit.", true);
  }
  if (!SHA.test(obs.lzaMoveCommit)) return d("FAILED", "LZA_MOVE_COMMIT_MALFORMED", "The recorded LZA commit is not a full SHA.", "Record the full 40-character merge commit.");
  const lza = bound(obs.lzaMoveExecution, card.lza.pipelineName, obs.lzaMoveCommit);
  if (lza !== "BOUND") {
    return d("OBSERVE_LZA_MOVE", lza === "NONE" ? "LZA_MOVE_EXECUTION_NOT_FOUND" : "LZA_MOVE_EXECUTION_UNRELATED",
      "No " + card.lza.pipelineName + " execution bound to " + obs.lzaMoveCommit + " has been observed yet.", "Observe again; do not merge the change a second time.");
  }
  const lzaExec = obs.lzaMoveExecution!;
  if (lzaExec.evidence !== "OBSERVED") return d("UNRESOLVED", "LZA_MOVE_EVIDENCE_SIMULATED", "The LZA execution is simulated.", "Observe the real pipeline execution.");
  if (lzaExec.status === "InProgress") return d("OBSERVE_LZA_MOVE", "LZA_MOVE_RUNNING", "LZA execution " + lzaExec.executionId + " is running.", "Keep observing the same execution.");
  if (lzaExec.status === "Failed" || lzaExec.status === "Stopped") {
    return d("FAILED", "LZA_MOVE_FAILED", "LZA execution " + lzaExec.executionId + " ended " + lzaExec.status + ".",
      "Diagnose the LZA stage that failed and retry it through the LZA pipeline after review. Do not close the account.");
  }
  if (lzaExec.status !== "Succeeded") return d("UNRESOLVED", "LZA_MOVE_STATUS_UNKNOWN", "LZA execution " + lzaExec.executionId + " status is " + lzaExec.status + ".", "Observe again.");

  // Independent confirmation: pipeline success is not placement.
  if (!obs.account) {
    if (obs.accountLookup === "ACCESS_DENIED") return d("UNRESOLVED", "ACCOUNT_NOT_READABLE", "The discovery identity cannot read the account.", "Fix the read-only permission, then confirm again.");
    if (obs.accountLookup === "NOT_FOUND") return d("FAILED", "ACCOUNT_NOT_FOUND", "Account " + id + " is no longer in the organization.", "Stop. Find out who removed or closed it.");
    return d("CONFIRM_MOVED", "MOVE_NOT_CONFIRMED", "LZA succeeded; the account's OU has not been observed.", "Read the account by email in the organization.");
  }
  const a = obs.account;
  if (a.evidence !== "OBSERVED") return d("UNRESOLVED", "ACCOUNT_EVIDENCE_SIMULATED", "Account placement is simulated.", "Observe the real account.");
  if (a.accountId !== id) return d("FAILED", "ACCOUNT_ID_MISMATCH", "The account found by email is " + a.accountId + ", not " + id + ".", "Stop. Check the card's email and account id.");
  if (a.parentOuId !== card.ignoredOuId) {
    return d("FAILED", "ACCOUNT_NOT_IN_IGNORED_OU", "Account " + id + " is under " + a.parentOuId + ", not " + card.ignoredOuId + ".", "Diagnose the LZA change; do not close the account.");
  }
  return d("RETIRED", "RETIRED", "Account " + id + " is out of AFT, unmanaged in Control Tower, and under the ignored OU " + card.ignoredOuId + ".",
    "Closing the account is an owner decision (account deletion). The runner never closes an account.");
}
