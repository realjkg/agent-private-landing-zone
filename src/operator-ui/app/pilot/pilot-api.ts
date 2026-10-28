// Wire types and fetch helpers for the pilot wizard (the console's guided way to run the pilot apply path).
//
// The shapes below mirror the router in src/cli/ui-channel.ts. They are deliberate duplicates, as in ../api.ts: importing the
// router would pull node modules (and the whole apply path) into the browser bundle, and the boundary tests forbid it. The node
// suite (test/ui-channel.test.ts) asserts the server side of these contracts.
//
// The session token is held in this module's memory only: never in storage, a cookie, the address bar or a log. Reloading the page
// forgets it, and the person pastes it again. It travels in one request header, to the console's own origin.

export type PilotEnvironment = "DEV" | "QA" | "PROD";
export type PilotPath = "UI" | "CLI";
export type PilotStep = "preflight" | "prepare" | "seal" | "approve" | "apply" | "observe" | "propose-cleanup" | "cleanup" | "verify-cleanup";
export type PhraseKind = "TARGET" | "RUN_PROJECT_CODE" | "EMBED_STATE_WRITE" | "ATTEST" | "APPROVE" | "APPLY" | "APPROVE_CLEANUP" | "CLEANUP";

export type PlanChange = { address: string; type: string; action: string; importing?: true; previousAddress?: string };
export type ChangeCounts = { create: number; update: number; replace: number; delete: number; forget: number; other: number };
export type ReviewSummary = {
  environment: PilotEnvironment;
  target: { account: string; backend: string; workspace: string };
  shortId: string;
  /** The product version (source commit) that made the preview; approvers sign it with the change. */
  sourceCommit: string;
  /** Who requested the change (their listed name): part of the change ID every approver signs. In PROD the requester cannot be an approver. */
  requestedBy: string;
  createdAt: string;
  counts: ChangeCounts;
  changes: PlanChange[];
  changesOmitted: number;
  /** Which build tool program made the preview, and whether it was tested on the real cloud (the sealed provenance). */
  preview: { engineVersion: string; programId: string; qualified: boolean; qualifiedAt?: string; reason?: string };
  /** The cleanup marker this change stamps on what it creates (src/cli/ui-channel.ts ReviewSummary.unit); null when the build tool seals none. */
  unit: { unitId: string; tags: Record<string, string>; untagged: string[] } | null;
};
/** Why an item is not ready (src/apply/readiness.ts): absent, present but wrong, not yet proven on the real cloud, not usable here, or stopped on purpose. */
export type ReadinessState = "READY" | "MISSING" | "INVALID" | "UNVERIFIED" | "UNAVAILABLE" | "BLOCKED";
/** Who can make an item ready. */
export type ReadinessParty = "OWNER" | "OPERATOR" | "TOOL";
export type PreflightCheck = { check: string; ok: boolean; state: ReadinessState; responsible?: ReadinessParty; detail?: string; advisory?: true };
/** AUTHORIZED and APPROVED/EXECUTE from the CLI's one decision view (src/apply/readiness.ts `actDecisions`), beside the READY checks. */
export type PilotDecisions = {
  act: "DISABLED" | "PILOT_ENABLED";
  contract: { code?: string; reason?: string; contractSha256?: string; provider?: string; engine?: string };
  authorized: { environment: PilotEnvironment; operations: string[]; authorizationSha256: string }[];
  approved: { environment: PilotEnvironment; requiredApprovals: number }[];
};

/** What `prepare` saved and bound (src/apply/prepare.ts): local files, never proof that anything works in the cloud. */
export type PreparedFiles = {
  files: { request: string; manifest: string; record: string };
  summary: {
    label: "LOCAL_PREPARATION"; provider: string; engine: string; path: "PRIMARY" | "SECONDARY"; environment: PilotEnvironment;
    account: string; region?: string; backend: string; workspace: string; projectRoot: string; fileCount: number;
    providers: { source: string; version: string }[]; engineVersion: string; engineVersionSource: string; policyVersion: string;
    /** Where each input's value comes from: a project file, a named environment variable or a default. Never the value. */
    inputs: { name: string; source: "TFVARS" | "ENVIRONMENT" | "DEFAULT"; from: string }[];
    unitHash: string; manifestHash: string; contractSha256: string;
  };
  gaps: string[];
  next: { step: "qualify" | "seal"; reason: string } | { step: "blocked"; blocker: string; reason: string };
  request: unknown;
  manifest: unknown;
};
/** Why `prepare` stopped, beside the refusal code: whose prerequisite it is, and a supported alternative when a tool is missing. */
export type PrepareStop = { blocker: "OWNER" | "OPERATOR" | "TOOL"; alternative?: string };

/** What the console shows of a cleanup proposal (src/cli/ui-channel.ts CleanupSummary): names, identifiers and reasons only. */
export type CleanupSummary = {
  proposalSha256: string;
  shortId: string;
  environment: PilotEnvironment;
  target: { account: string; backend: string; workspace: string };
  sourceCommit: string;
  artifactShortId: string;
  /** Who requested this cleanup (their listed name): part of the proposal ID every approver signs. In PROD the requester cannot approve it. */
  requestedBy: string;
  requiredApprovals: number;
  deletes: { address: string; type: string; identifier: string | null; ownership: string; observed: string; risk?: string }[];
  alreadyAbsent: { address: string; type: string; identifier: string | null }[];
  excluded: { address: string; type: string; identifier: string | null; ownership: string; reason: string; retainedBy: string }[];
  risks: string[];
  lines: string[];
};
/** One thing the independent check looked at (src/apply/run-records.ts ObservedResource). */
export type ObservedResource = { address: string; type: string; identifier: string | null; origin: string; result: string; reason?: string };
export type ObservationData = { verdict: string; inventory: string; observedAt: string; resources: ObservedResource[]; missingFromState: string[]; unexpected: string[] };
/** One thing the leftover check looked at (src/apply/run-records.ts LeftoverResource). */
export type LeftoverResource = { address: string; type: string; identifier: string | null; disposition: string; basis: string; reason?: string; owner?: string };
/** The leftover record as the command reports it; `cleanupEvidenceSha256` is null when no cleanup has run for the proposal. */
export type LeftoversData = { disposition: "COMPLETE" | "KNOWN_ADDRESSES_CONFIRMED" | "INCOMPLETE"; sweep: string; nextAction: string; resources: LeftoverResource[]; observedAt: string; cleanupEvidenceSha256?: string | null };

export type RunResult = {
  exit: number;
  code?: string;
  message?: string;
  outcome?: string;
  data?: unknown;
  summary?: ReviewSummary;
  cleanup?: CleanupSummary;
  savedPath?: string;
};
export type PilotRun = {
  id: string;
  step: PilotStep;
  status: "RUNNING" | "WAITING" | "DONE";
  startedAt: string;
  transcript: string;
  dialog?: { id: string; kind: PhraseKind; phrase: string };
  result?: RunResult;
};
export type PilotState =
  | { unlocked: false }
  | { unlocked: true; path: PilotPath | null; busy: boolean; run: PilotRun | null };

/** What a call came back with: the new state, or a refusal with a code and the router's plain sentence. */
export type PilotReply<T = PilotState> = { ok: true; body: T } | { ok: false; code: string; message: string };

let sessionToken = "";
export const setPilotToken = (token: string): void => { sessionToken = token.trim(); };
export const hasPilotToken = (): boolean => sessionToken !== "";
export const forgetPilotToken = (): void => { sessionToken = ""; };

const TOKEN_HEADER = "X-ALZ-Pilot-Token";

async function send<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<PilotReply<T>> {
  try {
    const response = await fetch("/pilot" + path, {
      method, cache: "no-store",
      headers: { [TOKEN_HEADER]: sessionToken, ...(method === "POST" ? { "Content-Type": "application/json" } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const parsed = (await response.json().catch(() => null)) as (T & { error?: string; message?: string }) | null;
    if (response.ok && parsed !== null) return { ok: true, body: parsed };
    return { ok: false, code: parsed?.error ?? "PILOT_UNREACHABLE", message: parsed?.message ?? "" };
  } catch {
    return { ok: false, code: "PILOT_UNREACHABLE", message: "" };
  }
}

export type AwsAdminStatus = {
  status: "ACCOUNT_VERIFIED";
  account: string;
  checks: { name: string; status: "VERIFIED" | "NOT_CHECKED"; next: string }[];
  action: "NONE";
  actEnabled: false;
};
/** Read-only management connection check, protected by the same pilot session. */
export const checkAwsDevAccount = (account: string, profile: string): Promise<PilotReply<AwsAdminStatus>> =>
  send<AwsAdminStatus>("POST", "/aws-readiness", { account, profile });

export const fetchPilotState = (): Promise<PilotReply> => send<PilotState>("GET", "/state");
export const choosePath = (path: PilotPath): Promise<PilotReply> => send<PilotState>("POST", "/path", { path });
export const startOver = (): Promise<PilotReply> => send<PilotState>("POST", "/reset", {});
export const startPreflight = (environment: PilotEnvironment): Promise<PilotReply> => send<PilotState>("POST", "/preflight", { environment });
export const startPrepare = (input: { environment: PilotEnvironment; projectPath: string; awsCliVersion?: string }): Promise<PilotReply> => send<PilotState>("POST", "/prepare", input);
export const startSeal = (input: { environment: PilotEnvironment; requestPath: string; manifestPath: string; requesterId: string; keyPath: string }): Promise<PilotReply> => send<PilotState>("POST", "/seal", input);
export const startApprove = (input: { bundlePath: string; keyPath: string; approverId: string }): Promise<PilotReply> => send<PilotState>("POST", "/approve", input);
export const startApply = (input: { environment: PilotEnvironment; requestPath: string; manifestPath: string; sealedPath: string; approvalPaths: string[] }): Promise<PilotReply> => send<PilotState>("POST", "/apply", input);
export const answerDialog = (dialogId: string, answer: string): Promise<PilotReply> => send<PilotState>("POST", "/answer", { dialogId, answer });
export const cancelDialog = (): Promise<PilotReply> => send<PilotState>("POST", "/cancel", {});

export type ReviewReply = { ok: true; summary: ReviewSummary } | { ok: false; code: string; message: string };
export const loadReview = (bundlePath: string): Promise<PilotReply<ReviewReply>> => send<ReviewReply>("POST", "/review", { bundlePath });
export type CleanupReviewReply = { ok: true; cleanup: CleanupSummary } | { ok: false; code: string; message: string };
export const loadCleanupReview = (proposalPath: string): Promise<PilotReply<CleanupReviewReply>> => send<CleanupReviewReply>("POST", "/review-cleanup", { proposalPath });
export const startObserve = (sealedPath: string): Promise<PilotReply> => send<PilotState>("POST", "/observe", { sealedPath });
export const startProposeCleanup = (input: { sealedPath: string; requesterId: string; keyPath: string }): Promise<PilotReply> => send<PilotState>("POST", "/propose-cleanup", input);
export const startCleanup = (input: { environment: PilotEnvironment; requestPath: string; manifestPath: string; sealedPath: string; proposalPath: string; approvalPaths: string[] }): Promise<PilotReply> => send<PilotState>("POST", "/cleanup", input);
export const startVerifyCleanup = (proposalPath: string): Promise<PilotReply> => send<PilotState>("POST", "/verify-cleanup", { proposalPath });

// --- deployment paths (GET /pilot/paths; src/release/pilot-paths.ts) ------------------------------------------------------------

/** Who or what a path's blocker waits on (src/release/pilot-paths.ts PathParty). */
export type PathParty = "OWNER" | "OPERATOR" | "SEQUENCED" | "ENGINEERING" | "QUALIFICATION" | "RELEASE_SCOPE" | "UNKNOWN";
export type PathBlocker = { party: PathParty; source: string; text: string };
/** The three decisions for one environment of the contract's path. `ready` is null when no readiness check has run for it. */
export type EnvironmentDecision = {
  environment: PilotEnvironment;
  authorized: boolean;
  operations: string[];
  ready: boolean | null;
  notReady: { check: string; responsible?: string }[];
  approved: boolean;
  requiredApprovals: number;
  checkedAt: string | null;
};
export type DeploymentPath = {
  cloud: string;
  engine: string;
  label: string;
  inRelease: boolean;
  liveStatus: string;
  journeyStatus: string;
  implemented: boolean;
  actGate: { id: string; status: string; owner: string; nextAction: string } | null;
  blockers: PathBlocker[];
  isContractPath: boolean;
  decisions?: EnvironmentDecision[];
};
export type PathsContract =
  | { state: "UNKNOWN" }
  | { state: "DISABLED"; reason: string }
  | { state: "ENABLED"; provider: string; engine: string; contractSha256: string; killSwitch: boolean };
export type PathsReport = { label: "RELEASE_RECORDS"; contract: PathsContract; environments: EnvironmentDecision[]; paths: DeploymentPath[] };

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const isDecision = (value: unknown): value is EnvironmentDecision => isObject(value) && (value.environment === "DEV" || value.environment === "QA" || value.environment === "PROD") &&
  typeof value.authorized === "boolean" && (value.ready === null || typeof value.ready === "boolean") && typeof value.approved === "boolean" &&
  Array.isArray(value.operations) && Array.isArray(value.notReady) && typeof value.requiredApprovals === "number";
const isPath = (value: unknown): value is DeploymentPath => isObject(value) && typeof value.cloud === "string" && typeof value.engine === "string" &&
  typeof value.label === "string" && typeof value.inRelease === "boolean" && typeof value.implemented === "boolean" && typeof value.isContractPath === "boolean" &&
  typeof value.liveStatus === "string" && typeof value.journeyStatus === "string" &&
  Array.isArray(value.blockers) && value.blockers.every((b) => isObject(b) && typeof b.party === "string" && typeof b.text === "string") &&
  (value.decisions === undefined || (Array.isArray(value.decisions) && value.decisions.every(isDecision)));

/** True only for a reply with the paths report's shape. Anything else is treated as unavailable, never as readiness. */
export function isPathsReport(value: unknown): value is PathsReport {
  return isObject(value) && value.label === "RELEASE_RECORDS" && isObject(value.contract) && typeof value.contract.state === "string" &&
    Array.isArray(value.environments) && value.environments.every(isDecision) && Array.isArray(value.paths) && value.paths.every(isPath);
}

/** Read-only: the deployment paths and the readiness checks already run. It starts nothing. */
export async function fetchPilotPaths(): Promise<PilotReply<PathsReport>> {
  const reply = await send<unknown>("GET", "/paths");
  if (!reply.ok) return reply;
  return isPathsReport(reply.body) ? { ok: true, body: reply.body } : { ok: false, code: "PILOT_PATHS_UNREADABLE", message: "" };
}
