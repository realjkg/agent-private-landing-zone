import { createHash } from "node:crypto";

/**
 * The AWS Control Tower + LZA + AFT pilot workflow (docs/aft-lza-act-workflow.md).
 *
 * One run, two sequential write operations, both started by the person at the terminal:
 *
 *   1. LZA: the approved `accounts-config.yaml` change creates the account through `AWSAccelerator-Pipeline`.
 *   2. AFT: only after (1) is revision-bound and the account's id, name, email and OU are independently observed, the
 *      `aft-account-request` entry registers it and AFT runs its customization pipeline.
 *
 * This module decides; it never writes to a cloud or a repository. Every observation comes from an injected read-only
 * reader, and every write is a guided step a person performs. Simulated or missing observations never reach VERIFIED.
 */

export const AFT_LZA_GATE_ID = "act:aws-aft-lza" as const;
export const AFT_LZA_WORKFLOW_ID = "aws-aft-lza-pilot" as const;

export type AccountTarget = { name: string; email: string; ouId: string; accountId?: string };

export type AftLzaCard = {
  runId: string;
  organizationId: string;
  homeRegion: string;
  regions: string[];
  account: AccountTarget;
  lza: { repository: string; baseBranch: string; pipelineName: string; configurationDigest: string; validatorEvidenceDigest?: string };
  aft: { repository: string; baseBranch: string; requestPipelineName: string; requestDigest: string; requestedName: string; requestedEmail: string };
  disposition: "RETAIN";
};

export type Evidence = "OBSERVED" | "SIMULATED";

export type PipelineObservation = {
  pipelineName: string;
  executionId: string;
  sourceRevision: string;
  status: "InProgress" | "Succeeded" | "Failed" | "Stopped" | "Superseded" | "Unknown";
  evidence: Evidence;
};

export type AccountObservation = { accountId: string; name: string; email: string; parentOuId: string; status: string; evidence: Evidence };

export type ControlObservation = { region: string; controlId: string; result: "PASS" | "FAIL" | "EXCEPTED" | "UNKNOWN"; evidence: Evidence; ref?: string };

/** What has been observed so far in this run. Absent means not yet observed, never "failed". */
export type RunObservations = {
  lzaMergedCommit?: string;
  lzaExecution?: PipelineObservation;
  account?: AccountObservation;
  accountLookup?: "FOUND" | "NOT_FOUND" | "ACCESS_DENIED";
  aftMergedCommit?: string;
  aftRequestExecution?: PipelineObservation;
  customizationExecutions?: PipelineObservation[];
  controls?: ControlObservation[];
  /** The configuration digest the card was approved against, as read again now. */
  currentLzaConfigurationDigest?: string;
  currentAftRequestDigest?: string;
};

export type Phase =
  | "AWAIT_LZA_SUBMISSION" | "OBSERVE_LZA" | "CONFIRM_ACCOUNT" | "AWAIT_AFT_SUBMISSION" | "OBSERVE_AFT"
  | "OBSERVE_CUSTOMIZATION" | "RECOVER_CUSTOMIZATION" | "VERIFY_CONTROLS" | "VERIFIED" | "FAILED" | "UNRESOLVED" | "REAUTHORIZE";

export type Decision = { phase: Phase; code: string; detail: string; nextAction: string; mutationByPerson: boolean };

const d = (phase: Phase, code: string, detail: string, nextAction: string, mutationByPerson = false): Decision => ({ phase, code, detail, nextAction, mutationByPerson });

export const sha256 = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");

/** Canonical JSON (sorted keys) so a digest does not depend on property order. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value && typeof value === "object") {
    return "{" + Object.keys(value as Record<string, unknown>).sort()
      .map((key) => JSON.stringify(key) + ":" + canonical((value as Record<string, unknown>)[key])).join(",") + "}";
  }
  return JSON.stringify(value);
}

const HEX64 = /^[0-9a-f]{64}$/;
const SHA = /^[0-9a-f]{40}$/;
const ACCOUNT = /^\d{12}$/;
const OU = /^ou-[0-9a-z]{4,32}-[0-9a-z]{8,32}$/;
const ORG = /^o-[0-9a-z]{10,32}$/;
const REGION = /^[a-z]{2}(-gov)?-[a-z]+-\d$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Offline card validation: every field the live stages depend on, with the reason it blocks. */
export function validateCard(card: AftLzaCard): string[] {
  const issues: string[] = [];
  if (!card.runId || !/^[A-Za-z0-9._-]{1,64}$/.test(card.runId)) issues.push("runId must be 1-64 safe characters");
  if (!ORG.test(card.organizationId)) issues.push("organizationId is unresolved or malformed");
  if (!REGION.test(card.homeRegion)) issues.push("homeRegion is unresolved or malformed");
  if (card.regions.length === 0 || card.regions.some((r) => !REGION.test(r))) issues.push("regions must list the approved governed Regions");
  if (!card.regions.includes(card.homeRegion)) issues.push("regions must include the home Region");
  if (!card.account.name) issues.push("account.name is unresolved");
  if (!EMAIL.test(card.account.email)) issues.push("account.email is unresolved or malformed");
  if (!OU.test(card.account.ouId)) issues.push("account.ouId is unresolved or malformed");
  if (card.account.accountId !== undefined && !ACCOUNT.test(card.account.accountId)) issues.push("account.accountId must be 12 digits");
  if (!HEX64.test(card.lza.configurationDigest)) issues.push("lza.configurationDigest must be the intake bundle sha256");
  if (!card.lza.validatorEvidenceDigest || !HEX64.test(card.lza.validatorEvidenceDigest)) issues.push("lza.validatorEvidenceDigest is missing: the pinned LZA validator has not been run against this configuration");
  if (!HEX64.test(card.aft.requestDigest)) issues.push("aft.requestDigest must be the sha256 of the account request");
  for (const [k, v] of [["lza.repository", card.lza.repository], ["lza.baseBranch", card.lza.baseBranch], ["lza.pipelineName", card.lza.pipelineName],
    ["aft.repository", card.aft.repository], ["aft.baseBranch", card.aft.baseBranch], ["aft.requestPipelineName", card.aft.requestPipelineName]] as const) {
    if (!v) issues.push(k + " is unresolved");
  }
  if (card.lza.repository && card.lza.repository === card.aft.repository) issues.push("LZA configuration and AFT requests must live in separate repositories (AWS guidance keeps the projects apart)");
  // AWS: the AFT request's AccountName and AccountEmail must match the LZA workloadAccounts entry.
  if (card.aft.requestedName !== card.account.name) issues.push("AFT AccountName does not match the LZA workload account name");
  if (card.aft.requestedEmail.toLowerCase() !== card.account.email.toLowerCase()) issues.push("AFT AccountEmail does not match the LZA workload account email");
  if (card.disposition !== "RETAIN") issues.push("only the RETAIN disposition is supported by this pilot");
  return issues;
}

/** The digest the owner's authorization names: every execution-affecting card field. */
export const cardDigest = (card: AftLzaCard): string => sha256(canonical(card));

function boundRun(execution: PipelineObservation | undefined, pipeline: string, commit: string | undefined): "BOUND" | "UNRELATED" | "NONE" {
  if (!execution) return "NONE";
  if (execution.pipelineName !== pipeline || !commit || execution.sourceRevision !== commit) return "UNRELATED";
  return "BOUND";
}

/**
 * The next step of the run, from what has been observed. Pure: the same observations always give the same decision, so a
 * restarted process reaches the same point without repeating a write.
 */
export function decideNext(card: AftLzaCard, obs: RunObservations): Decision {
  const issues = validateCard(card);
  if (issues.length > 0) return d("UNRESOLVED", "CARD_INCOMPLETE", issues.join("; "), "Resolve the execution card fields, then run the offline preflight again.");

  if (obs.currentLzaConfigurationDigest !== undefined && obs.currentLzaConfigurationDigest !== card.lza.configurationDigest && !obs.account) {
    return d("REAUTHORIZE", "LZA_CONFIGURATION_CHANGED", "The LZA configuration changed after approval and before the account was confirmed.", "Validate the new configuration and obtain authorization for its digest.");
  }

  // Operation 1: LZA.
  if (!obs.lzaMergedCommit) return d("AWAIT_LZA_SUBMISSION", "LZA_NOT_SUBMITTED", "No merged LZA configuration commit is recorded for this run.", "Person: open, review and merge the approved LZA change in " + card.lza.repository + "@" + card.lza.baseBranch + ", then record the merge commit.", true);
  if (!SHA.test(obs.lzaMergedCommit)) return d("FAILED", "LZA_COMMIT_MALFORMED", "The recorded LZA merge commit is not a full SHA.", "Record the full 40-character merge commit.");
  const lza = boundRun(obs.lzaExecution, card.lza.pipelineName, obs.lzaMergedCommit);
  if (lza === "NONE") return d("OBSERVE_LZA", "LZA_EXECUTION_NOT_FOUND", "No " + card.lza.pipelineName + " execution for " + obs.lzaMergedCommit + " has been observed yet.", "Observe the pipeline again; do not resubmit.");
  if (lza === "UNRELATED") return d("OBSERVE_LZA", "LZA_EXECUTION_UNRELATED", "The observed execution is not " + card.lza.pipelineName + " on the merged commit; it does not advance the run.", "Observe the execution for the merged commit.");
  const lzaExec = obs.lzaExecution!;
  if (lzaExec.evidence !== "OBSERVED" && !obs.account) return d("UNRESOLVED", "LZA_EVIDENCE_SIMULATED", "The LZA execution is simulated, so it cannot gate a live AFT registration.", "Observe the real pipeline execution.");
  if (lzaExec.status === "InProgress") return d("OBSERVE_LZA", "LZA_RUNNING", "LZA execution " + lzaExec.executionId + " is running.", "Keep observing the same execution.");
  if (lzaExec.status === "Failed" || lzaExec.status === "Stopped") return d("FAILED", "LZA_FAILED", "LZA execution " + lzaExec.executionId + " ended " + lzaExec.status + "; AFT registration stays blocked.", "Diagnose the LZA stage that failed; retry it through the LZA pipeline after review. Do not submit to AFT.");
  if (lzaExec.status !== "Succeeded") return d("UNRESOLVED", "LZA_STATUS_UNKNOWN", "LZA execution " + lzaExec.executionId + " status is " + lzaExec.status + ".", "Observe again.");

  // Identity gate between LZA and AFT.
  if (!obs.account) {
    if (obs.accountLookup === "ACCESS_DENIED") return d("UNRESOLVED", "ACCOUNT_NOT_READABLE", "The discovery identity cannot read the account; unreadable is not a mismatch and not a pass.", "Fix the read-only permission, then confirm again.");
    return d("CONFIRM_ACCOUNT", "ACCOUNT_NOT_CONFIRMED", "LZA succeeded; the created account has not been independently observed.", "Read the account by email in the organization; never request it again.");
  }
  const a = obs.account;
  if (a.evidence !== "OBSERVED") return d("UNRESOLVED", "ACCOUNT_EVIDENCE_SIMULATED", "Account identity is simulated.", "Observe the real account.");
  const mismatches: string[] = [];
  if (a.name !== card.account.name) mismatches.push("name " + a.name);
  if (a.email.toLowerCase() !== card.account.email.toLowerCase()) mismatches.push("email");
  if (a.parentOuId !== card.account.ouId) mismatches.push("OU " + a.parentOuId + " (expected " + card.account.ouId + ")");
  if (card.account.accountId && a.accountId !== card.account.accountId) mismatches.push("account id " + a.accountId);
  if (a.status !== "ACTIVE") mismatches.push("status " + a.status);
  if (mismatches.length > 0) return d("FAILED", "ACCOUNT_IDENTITY_MISMATCH", "The observed account does not match the approved entry: " + mismatches.join(", ") + ".", "Stop. Do not register with AFT. Investigate the LZA entry and placement.");

  // Operation 2: AFT, dependency-gated.
  if (obs.currentAftRequestDigest !== undefined && obs.currentAftRequestDigest !== card.aft.requestDigest) {
    return d("REAUTHORIZE", "AFT_REQUEST_CHANGED", "The AFT account request changed after approval. The confirmed account is kept.", "Authorize the new request digest; account creation is not repeated.");
  }
  if (!obs.aftMergedCommit) return d("AWAIT_AFT_SUBMISSION", "AFT_NOT_SUBMITTED", "Account " + a.accountId + " is confirmed; the AFT request is not merged.", "Person: open, review and merge the approved request in " + card.aft.repository + "@" + card.aft.baseBranch + ", then record the merge commit.", true);
  if (!SHA.test(obs.aftMergedCommit)) return d("FAILED", "AFT_COMMIT_MALFORMED", "The recorded AFT merge commit is not a full SHA.", "Record the full merge commit.");
  const aft = boundRun(obs.aftRequestExecution, card.aft.requestPipelineName, obs.aftMergedCommit);
  if (aft !== "BOUND") return d("OBSERVE_AFT", aft === "NONE" ? "AFT_EXECUTION_NOT_FOUND" : "AFT_EXECUTION_UNRELATED", "No " + card.aft.requestPipelineName + " execution bound to the merged request commit yet.", "Observe again; do not resubmit the request.");
  const aftExec = obs.aftRequestExecution!;
  if (aftExec.status === "InProgress") return d("OBSERVE_AFT", "AFT_RUNNING", "AFT request execution " + aftExec.executionId + " is running.", "Keep observing.");
  if (aftExec.status !== "Succeeded") return d("FAILED", "AFT_REQUEST_FAILED", "AFT request execution " + aftExec.executionId + " ended " + aftExec.status + ". The account is kept.", "Diagnose the request pipeline; re-run it after review. Account creation is not repeated.");

  const custom = obs.customizationExecutions ?? [];
  const accountPipeline = a.accountId + "-customizations-pipeline";
  const mine = custom.filter((c) => c.pipelineName === accountPipeline);
  if (mine.length === 0) return d("OBSERVE_CUSTOMIZATION", "CUSTOMIZATION_PIPELINE_NOT_FOUND", "The account's customization pipeline " + accountPipeline + " has not appeared.", "Observe again.");
  const latest = mine[mine.length - 1]!;
  if (latest.status === "InProgress") return d("OBSERVE_CUSTOMIZATION", "CUSTOMIZATION_RUNNING", "Customization " + latest.executionId + " is running.", "Keep observing.");
  if (latest.status !== "Succeeded") return d("RECOVER_CUSTOMIZATION", "CUSTOMIZATION_FAILED", "Customization " + latest.executionId + " ended " + latest.status + ". Account and registration are kept.", "Diagnose, then the person invokes aft-invoke-customizations for account " + a.accountId + " only.", true);

  // Independent verification: every approved Region needs observed controls; pipeline success is not verification.
  const controls = obs.controls ?? [];
  if (controls.length === 0) return d("VERIFY_CONTROLS", "CONTROLS_NOT_OBSERVED", "Native executions succeeded; no control observations yet.", "Run the read-only control checks in every approved Region.");
  const failed = controls.filter((c) => c.result === "FAIL");
  if (failed.length > 0) return d("FAILED", "CONTROL_FAILED", failed.map((c) => c.region + "/" + c.controlId).join(", ") + " failed.", "Diagnose with the owning system; do not mark the run verified.");
  const missingRegions = card.regions.filter((r) => !controls.some((c) => c.region === r));
  const weak = controls.filter((c) => c.evidence !== "OBSERVED" || c.result === "UNKNOWN");
  if (missingRegions.length > 0 || weak.length > 0) {
    return d("UNRESOLVED", "CONTROLS_INCOMPLETE", [missingRegions.length ? "no observations in " + missingRegions.join(", ") : "", weak.length ? weak.length + " simulated or unknown observation(s)" : ""].filter(Boolean).join("; ") + ".", "Observe the remaining controls; unknown never passes.");
  }
  return d("VERIFIED", "VERIFIED", "Account " + a.accountId + " confirmed, registered and customized; controls observed in " + card.regions.join(", ") + ". Disposition RETAIN.", "Assemble the evidence summary.");
}

/** A request to run `aft-invoke-customizations`, checked against the run's one account. */
export type ReinvocationRequest = { accountIds: string[]; includeAll?: boolean; priorExecutionReconciled: boolean; attempt: number };
export const MAX_REINVOCATIONS = 3;

export function checkReinvocation(card: AftLzaCard, obs: RunObservations, request: ReinvocationRequest): { allowed: true; input: Record<string, unknown> } | { allowed: false; code: string; detail: string } {
  const account = obs.account?.accountId;
  if (!account) return { allowed: false, code: "ACCOUNT_NOT_CONFIRMED", detail: "Re-invocation needs the confirmed account id." };
  if (decideNext(card, obs).phase !== "RECOVER_CUSTOMIZATION") return { allowed: false, code: "NOT_IN_RECOVERY", detail: "Re-invocation is a recovery action; the run is not in customization recovery." };
  if (request.includeAll) return { allowed: false, code: "SCOPE_EXPANSION", detail: "include type \"all\" targets every AFT account; this pilot targets one account." };
  if (request.accountIds.length !== 1 || request.accountIds[0] !== account) return { allowed: false, code: "SCOPE_EXPANSION", detail: "Re-invocation must name exactly account " + account + "." };
  if (!request.priorExecutionReconciled) return { allowed: false, code: "RECONCILE_FIRST", detail: "The previous invocation's outcome must be reconciled before another write." };
  if (request.attempt > MAX_REINVOCATIONS) return { allowed: false, code: "RETRY_BUDGET_EXHAUSTED", detail: "Escalate to the recovery owner with the preserved executions." };
  // Step Functions input for aft-invoke-customizations, narrowest selector.
  return { allowed: true, input: { include: [{ type: "accounts", target_value: [account] }] } };
}

export type DriftFinding = { resourceArn: string; owner: "LZA" | "AFT" | "UNKNOWN" | "BOTH"; detail: string };

/** Drift goes to its owner; overlap or unknown ownership is a conflict. Never auto-adopted or auto-repaired. */
export function routeDrift(finding: DriftFinding): { route: "LZA_OWNER" | "AFT_OWNER" | "OWNERSHIP_CONFLICT"; autoRepair: false } {
  if (finding.owner === "LZA") return { route: "LZA_OWNER", autoRepair: false };
  if (finding.owner === "AFT") return { route: "AFT_OWNER", autoRepair: false };
  return { route: "OWNERSHIP_CONFLICT", autoRepair: false };
}

/** The forward run never removes. Removal is its own run (removal.ts, stage aws-aft-lza-removal), in AWS's order: AFT first, then LZA. */
export const REMOVAL = { authorized: false, order: ["AFT", "LZA"] as const } as const;
