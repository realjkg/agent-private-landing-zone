import { EXECUTION_WINDOW } from "./aws-reader.js";
import { AFT_LZA_GATE_ID, cardDigest, type AftLzaCard, type PipelineObservation } from "./workflow.js";

/**
 * Drift detection for the Control Tower + LZA + AFT pilot (docs/aft-lza-act-workflow.md, "Drift").
 *
 * Drift is any difference between what the approved sources say and what AWS reports, from any of these signals:
 *
 * | Kind                   | Signal                                                                    | Owner         |
 * |------------------------|---------------------------------------------------------------------------|---------------|
 * | LANDING_ZONE           | Control Tower landing zone driftStatus                                    | CONTROL_TOWER |
 * | BASELINE               | Enabled baseline driftStatusSummary on the target OU                      | CONTROL_TOWER |
 * | CONTROL                | Enabled control driftStatusSummary on the target OU                       | CONTROL_TOWER |
 * | LZA_STACK              | CloudFormation StackDriftStatus of AWSAccelerator-* stacks, per Region    | LZA           |
 * | ACCOUNT_PLACEMENT      | The account's parent OU against the card                                  | LZA           |
 * | LZA_UNDEPLOYED         | LZA config branch head (GitHub) ≠ last successful pipeline revision       | LZA           |
 * | AFT_UNDEPLOYED         | AFT request branch head (GitHub) ≠ last successful request revision       | AFT           |
 * | AFT_CUSTOMIZATION      | The account's latest customization execution did not succeed             | AFT           |
 *
 * Detection only. Nothing is adopted, re-run or repaired: each finding names the system that owns the fix. A signal that could
 * not be read, or that AWS reports as NOT_CHECKED or UNKNOWN, is UNKNOWN — never IN_SYNC.
 */
export type DriftKind = "LANDING_ZONE" | "BASELINE" | "CONTROL" | "LZA_STACK" | "ACCOUNT_PLACEMENT" | "LZA_UNDEPLOYED" | "AFT_UNDEPLOYED" | "AFT_CUSTOMIZATION";
export type DriftOwner = "CONTROL_TOWER" | "LZA" | "AFT";
export type DriftState = "IN_SYNC" | "DRIFTED" | "UNKNOWN";

export type DriftFindingRow = { kind: DriftKind; owner: DriftOwner; subject: string; region?: string; state: DriftState; detail: string };

/** What AWS and GitHub reported. Absent or `undefined` means the read was not possible. */
export type DriftObservations = {
  landingZone?: { arn: string; driftStatus: string };
  baselines?: Array<{ arn: string; driftStatus: string }>;
  controls?: Array<{ arn: string; driftStatus: string }>;
  lzaStacks?: Array<{ region: string; stackName: string; driftStatus: string }>;
  stackRegionsRead?: string[];
  accountParentOuId?: string;
  accountId?: string;
  accountLookup?: "FOUND" | "NOT_FOUND" | "ACCESS_DENIED";
  lzaBranchHead?: string;
  aftBranchHead?: string;
  /** The AWS identity the reads ran as (sts get-caller-identity). */
  callerArn?: string;
  lzaExecutions?: PipelineObservation[];
  aftExecutions?: PipelineObservation[];
  customizationExecutions?: PipelineObservation[];
};

const state = (status: string | undefined): DriftState => status === "IN_SYNC" ? "IN_SYNC" : status === "DRIFTED" ? "DRIFTED" : "UNKNOWN";
const lastSucceeded = (runs: PipelineObservation[] | undefined) => (runs ?? []).filter((run) => run.status === "Succeeded").at(-1);

function undeployed(kind: "LZA_UNDEPLOYED" | "AFT_UNDEPLOYED", owner: DriftOwner, subject: string, head: string | undefined, runs: PipelineObservation[] | undefined): DriftFindingRow {
  if (!head) return { kind, owner, subject, state: "UNKNOWN", detail: "The branch head could not be read from GitHub." };
  if (runs === undefined) return { kind, owner, subject, state: "UNKNOWN", detail: "The pipeline executions could not be read." };
  const deployed = lastSucceeded(runs);
  if (!deployed) return runs.length >= EXECUTION_WINDOW
    ? { kind, owner, subject, state: "UNKNOWN", detail: "None of the last " + runs.length + " executions succeeded; older history was not read." }
    : { kind, owner, subject, state: "DRIFTED", detail: "No successful execution exists for branch head " + head.slice(0, 12) + "." };
  const running = runs.some((run) => run.status === "InProgress" && run.sourceRevision === head);
  if (deployed.sourceRevision === head) return { kind, owner, subject, state: "IN_SYNC", detail: "Branch head " + head.slice(0, 12) + " is deployed by execution " + deployed.executionId + "." };
  return { kind, owner, subject, state: running ? "UNKNOWN" : "DRIFTED",
    detail: "Branch head " + head.slice(0, 12) + " differs from the last deployed revision " + deployed.sourceRevision.slice(0, 12) + (running ? "; an execution for the head is running." : ".") };
}

export function detectDrift(card: AftLzaCard, obs: DriftObservations): DriftFindingRow[] {
  const rows: DriftFindingRow[] = [];
  rows.push(obs.landingZone
    ? { kind: "LANDING_ZONE", owner: "CONTROL_TOWER", subject: obs.landingZone.arn, state: state(obs.landingZone.driftStatus), detail: "Control Tower reports " + obs.landingZone.driftStatus + "." }
    : { kind: "LANDING_ZONE", owner: "CONTROL_TOWER", subject: "landing-zone", state: "UNKNOWN", detail: "The landing zone could not be read." });

  for (const [kind, list] of [["BASELINE", obs.baselines], ["CONTROL", obs.controls]] as const) {
    if (list === undefined) rows.push({ kind, owner: "CONTROL_TOWER", subject: card.account.ouId, state: "UNKNOWN", detail: "Enabled " + kind.toLowerCase() + "s on the OU could not be read." });
    else if (kind === "BASELINE" && list.length === 0) rows.push({ kind, owner: "CONTROL_TOWER", subject: card.account.ouId, state: "UNKNOWN", detail: "No baseline is enabled on the OU; a registered Control Tower OU always has one, so its registration must be checked." });
    else for (const item of list) rows.push({ kind, owner: "CONTROL_TOWER", subject: item.arn, state: state(item.driftStatus), detail: "Control Tower reports " + item.driftStatus + "." });
  }

  for (const region of card.regions) {
    if (!(obs.stackRegionsRead ?? []).includes(region)) { rows.push({ kind: "LZA_STACK", owner: "LZA", subject: "AWSAccelerator-*", region, state: "UNKNOWN", detail: "LZA stacks in " + region + " could not be read." }); continue; }
    const stacks = (obs.lzaStacks ?? []).filter((stack) => stack.region === region);
    if (stacks.length === 0) rows.push({ kind: "LZA_STACK", owner: "LZA", subject: "AWSAccelerator-*", region, state: "UNKNOWN", detail: "No AWSAccelerator-* stacks were found in " + region + "." });
    for (const stack of stacks) {
      rows.push({ kind: "LZA_STACK", owner: "LZA", subject: stack.stackName, region, state: state(stack.driftStatus),
        detail: stack.driftStatus === "NOT_CHECKED" ? "Drift detection has never run on this stack; its owner runs it." : "CloudFormation reports " + stack.driftStatus + "." });
    }
  }

  if (obs.accountId) {
    rows.push(obs.accountParentOuId === undefined
      ? { kind: "ACCOUNT_PLACEMENT", owner: "LZA", subject: obs.accountId, state: "UNKNOWN", detail: "The account's parent could not be read." }
      : { kind: "ACCOUNT_PLACEMENT", owner: "LZA", subject: obs.accountId, state: obs.accountParentOuId === card.account.ouId ? "IN_SYNC" : "DRIFTED",
        detail: obs.accountParentOuId === card.account.ouId ? "In " + card.account.ouId + "." : "In " + obs.accountParentOuId + ", approved " + card.account.ouId + "." });
  } else {
    rows.push({ kind: "ACCOUNT_PLACEMENT", owner: "LZA", subject: card.account.email, state: "UNKNOWN",
      detail: obs.accountLookup === "NOT_FOUND" ? "No single account has the approved email; the account owner confirms whether it was renamed, moved out of the organization or closed." : "The account could not be read." });
  }

  rows.push(undeployed("LZA_UNDEPLOYED", "LZA", card.lza.repository + "@" + card.lza.baseBranch, obs.lzaBranchHead, obs.lzaExecutions));
  rows.push(undeployed("AFT_UNDEPLOYED", "AFT", card.aft.repository + "@" + card.aft.baseBranch, obs.aftBranchHead, obs.aftExecutions));

  const latest = obs.customizationExecutions?.at(-1);
  rows.push(obs.customizationExecutions === undefined || !obs.accountId
    ? { kind: "AFT_CUSTOMIZATION", owner: "AFT", subject: (obs.accountId ?? "account") + "-customizations-pipeline", state: "UNKNOWN", detail: "The customization pipeline could not be read." }
    : { kind: "AFT_CUSTOMIZATION", owner: "AFT", subject: obs.accountId + "-customizations-pipeline", state: latest?.status === "Succeeded" ? "IN_SYNC" : latest?.status === "InProgress" ? "UNKNOWN" : "DRIFTED",
      detail: latest ? "Latest execution " + latest.executionId + " is " + latest.status + "." : "No customization execution exists." });
  return rows;
}

export type DriftReport = {
  schemaVersion: 1;
  kind: "aft-lza-drift";
  gate: typeof AFT_LZA_GATE_ID;
  runId: string;
  cardDigest: string;
  observedAt: string;
  evidenceLabel: "LIVE_READ_ONLY" | "SYNTHETIC";
  /** The AWS identity the reads ran as; absent when it could not be read. */
  callerArn?: string;
  verdict: DriftState;
  counts: Record<DriftState, number>;
  findings: DriftFindingRow[];
  /** Which owner acts on each drifted finding. Detection never repairs. */
  routes: Record<DriftOwner, number>;
  autoRepair: false;
  deploymentAuthorized: false;
};

export function driftReport(card: AftLzaCard, obs: DriftObservations, at: string, label: DriftReport["evidenceLabel"]): DriftReport {
  const findings = detectDrift(card, obs);
  const counts: Record<DriftState, number> = { IN_SYNC: 0, DRIFTED: 0, UNKNOWN: 0 };
  const routes: Record<DriftOwner, number> = { CONTROL_TOWER: 0, LZA: 0, AFT: 0 };
  for (const f of findings) { counts[f.state]++; if (f.state === "DRIFTED") routes[f.owner]++; }
  const verdict: DriftState = counts.DRIFTED > 0 ? "DRIFTED" : counts.UNKNOWN > 0 ? "UNKNOWN" : "IN_SYNC";
  return { schemaVersion: 1, kind: "aft-lza-drift", gate: AFT_LZA_GATE_ID, runId: card.runId, cardDigest: cardDigest(card), observedAt: at, evidenceLabel: label, ...(obs.callerArn ? { callerArn: obs.callerArn } : {}),
    verdict, counts, findings, routes, autoRepair: false, deploymentAuthorized: false };
}

/** Exit codes for CI: 0 in sync, 3 drifted, 2 unknown (a signal could not be read), 1 error. */
export const DRIFT_EXIT: Readonly<Record<DriftState, number>> = { IN_SYNC: 0, DRIFTED: 3, UNKNOWN: 2 };

/** One Markdown table cell: backslashes first, then the characters that would end the cell, start code, or inject markup. */
export const cell = (value: string): string => value.replace(/[\r\n]+/g, " ").replace(/[\\|`*_<>[\]]/g, (ch) => "\\" + ch);

/** A short Markdown summary for a GitHub job summary or issue. Identifiers only; no credential is ever in a report. */
export function driftMarkdown(report: DriftReport): string {
  const lines = [
    "## AFT/LZA drift: " + report.verdict,
    "",
    "Run " + cell(report.runId) + ", card " + report.cardDigest.slice(0, 12) + ", observed " + cell(report.observedAt) + " (" + report.evidenceLabel + (report.callerArn ? ", as " + cell(report.callerArn) : "") + ").",
    "",
    "| State | Kind | Owner | Subject | Region | Detail |",
    "|---|---|---|---|---|---|",
    ...report.findings.filter((f) => f.state !== "IN_SYNC").map((f) => "| " + [f.state, f.kind, f.owner, cell(f.subject), cell(f.region ?? ""), cell(f.detail)].join(" | ") + " |"),
    "",
    report.counts.IN_SYNC + " in sync, " + report.counts.DRIFTED + " drifted, " + report.counts.UNKNOWN + " unknown. Detection only: each owner remediates through its own pipeline.",
  ];
  return lines.join("\n") + "\n";
}

/** The readers drift detection needs; the AWS reader and the GitHub reader in production, fakes in tests. */
export interface DriftReaders {
  aws: {
    callerArn?(): Promise<string | undefined>;
    landingZone(region: string): Promise<{ arn: string; driftStatus: string } | undefined>;
    ouArn(ouId: string): Promise<string | undefined>;
    enabledOnOu(ouArn: string, region: string): Promise<{ baselines?: Array<{ arn: string; driftStatus: string }>; controls?: Array<{ arn: string; driftStatus: string }> }>;
    lzaStacks(region: string): Promise<Array<{ region: string; stackName: string; driftStatus: string }> | undefined>;
    findAccountByEmail(email: string): Promise<{ lookup: "FOUND"; account: { accountId: string; parentOuId: string } } | { lookup: "NOT_FOUND" | "ACCESS_DENIED" }>;
    pipelineExecutions(pipelineName: string, region: string): Promise<PipelineObservation[]>;
  };
  github: { branchHead(repository: string, branch: string): Promise<string | undefined> };
}

/** Reads every signal; a read that throws becomes UNKNOWN for its signal instead of stopping the whole report. */
export async function collectDrift(card: AftLzaCard, readers: DriftReaders): Promise<DriftObservations> {
  const soft = async <T>(read: () => Promise<T>): Promise<T | undefined> => { try { return await read(); } catch { return undefined; } };
  const obs: DriftObservations = {};
  const { aws, github } = readers;
  if (aws.callerArn) obs.callerArn = await soft(() => aws.callerArn!());
  obs.landingZone = await soft(() => aws.landingZone(card.homeRegion));
  const ouArn = await soft(() => aws.ouArn(card.account.ouId));
  if (ouArn) Object.assign(obs, (await soft(() => aws.enabledOnOu(ouArn, card.homeRegion))) ?? {});
  obs.stackRegionsRead = [];
  obs.lzaStacks = [];
  for (const region of card.regions) {
    const stacks = await soft(() => aws.lzaStacks(region));
    if (stacks) { obs.stackRegionsRead.push(region); obs.lzaStacks.push(...stacks); }
  }
  const account = await soft(() => aws.findAccountByEmail(card.account.email));
  obs.accountLookup = account?.lookup;
  if (account?.lookup === "FOUND") { obs.accountId = account.account.accountId; obs.accountParentOuId = account.account.parentOuId || undefined; }
  obs.lzaBranchHead = await soft(() => github.branchHead(card.lza.repository, card.lza.baseBranch));
  obs.aftBranchHead = await soft(() => github.branchHead(card.aft.repository, card.aft.baseBranch));
  obs.lzaExecutions = await soft(() => aws.pipelineExecutions(card.lza.pipelineName, card.homeRegion));
  obs.aftExecutions = await soft(() => aws.pipelineExecutions(card.aft.requestPipelineName, card.homeRegion));
  if (obs.accountId) obs.customizationExecutions = await soft(() => aws.pipelineExecutions(obs.accountId + "-customizations-pipeline", card.homeRegion));
  return obs;
}
