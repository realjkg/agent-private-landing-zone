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
export type PreflightCheck = { check: string; ok: boolean; state: ReadinessState; responsible?: ReadinessParty; detail?: string };

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
  requiredApprovals: number;
  deletes: { address: string; type: string; identifier: string | null; ownership: string; observed: string; risk?: string }[];
  alreadyAbsent: { address: string; type: string; identifier: string | null }[];
  excluded: { address: string; type: string; identifier: string | null; ownership: string; reason: string }[];
  risks: string[];
  lines: string[];
};
/** One thing the independent check looked at (src/apply/run-records.ts ObservedResource). */
export type ObservedResource = { address: string; type: string; identifier: string | null; origin: string; result: string; reason?: string };
export type ObservationData = { verdict: string; inventory: string; observedAt: string; resources: ObservedResource[]; missingFromState: string[]; unexpected: string[] };
/** One thing the leftover check looked at (src/apply/run-records.ts LeftoverResource). */
export type LeftoverResource = { address: string; type: string; identifier: string | null; disposition: string; basis: string; reason?: string; owner?: string };
export type LeftoversData = { disposition: "COMPLETE" | "INCOMPLETE"; sweep: string; nextAction: string; resources: LeftoverResource[]; observedAt: string };

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
export const startSeal = (input: { environment: PilotEnvironment; requestPath: string; manifestPath: string }): Promise<PilotReply> => send<PilotState>("POST", "/seal", input);
export const startApprove = (input: { bundlePath: string; keyPath: string; approverId: string }): Promise<PilotReply> => send<PilotState>("POST", "/approve", input);
export const startApply = (input: { environment: PilotEnvironment; requestPath: string; manifestPath: string; sealedPath: string; approvalPaths: string[] }): Promise<PilotReply> => send<PilotState>("POST", "/apply", input);
export const answerDialog = (dialogId: string, answer: string): Promise<PilotReply> => send<PilotState>("POST", "/answer", { dialogId, answer });
export const cancelDialog = (): Promise<PilotReply> => send<PilotState>("POST", "/cancel", {});

export type ReviewReply = { ok: true; summary: ReviewSummary } | { ok: false; code: string; message: string };
export const loadReview = (bundlePath: string): Promise<PilotReply<ReviewReply>> => send<ReviewReply>("POST", "/review", { bundlePath });
export type CleanupReviewReply = { ok: true; cleanup: CleanupSummary } | { ok: false; code: string; message: string };
export const loadCleanupReview = (proposalPath: string): Promise<PilotReply<CleanupReviewReply>> => send<CleanupReviewReply>("POST", "/review-cleanup", { proposalPath });
export const startObserve = (sealedPath: string): Promise<PilotReply> => send<PilotState>("POST", "/observe", { sealedPath });
export const startProposeCleanup = (sealedPath: string): Promise<PilotReply> => send<PilotState>("POST", "/propose-cleanup", { sealedPath });
export const startCleanup = (input: { environment: PilotEnvironment; requestPath: string; manifestPath: string; proposalPath: string; approvalPaths: string[] }): Promise<PilotReply> => send<PilotState>("POST", "/cleanup", input);
export const startVerifyCleanup = (proposalPath: string): Promise<PilotReply> => send<PilotState>("POST", "/verify-cleanup", { proposalPath });
