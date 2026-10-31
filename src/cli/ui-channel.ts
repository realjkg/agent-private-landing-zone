import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join, resolve } from "node:path";

import { checkDevAccount, validatedAccountRequest } from "./act-dev1-admin.js";
import { channelMismatchMessage } from "../apply/channel.js";
import { authorizationEntryOf, isKillSwitchActive, loadPilotContract, pilotContractSha256, repoPaths } from "../apply/contract.js";
import { proposalLines, verifyCleanupProposal, type CleanupProposal } from "../apply/cleanup-proposal.js";
import { verifyReviewBundle } from "../apply/seal.js";
import { ENVIRONMENTS, stripInvisible } from "../apply/constants.js";
import type { ApplyEnvironment, PilotLimits, PlanChange, PreviewProvenance, SealedPlan } from "../apply/types.js";
import { costConfigSummary, costPaths, readCostSnapshot, readLocalCostConfig, type CostConfigSummary } from "../cost/local.js";
import type { CostStatus } from "../cost/status.js";
import { deploymentPaths, rememberedReadiness, type CurrentContract, type PathEnvironment, type RememberedReadiness } from "../release/pilot-paths.js";
import { runApplyCommand, type ApplyCliDeps, type ApplyReport } from "./apply.js";
import type { AskExpectation, HumanTerminal, PhraseKind } from "./teardown-driver.js";

// The console's ONE bridge to the pilot apply path (docs/act-pilot-walkthrough.md, docs/act-pilot-plan.md).
//
// A pilot workflow runs wholly in the terminal (channel CLI) or wholly in the console wizard (channel UI), chosen when it is
// started. This module is the UI channel. It adds no authority: it runs the same `runApplyCommand` the terminal runs, with the
// channel set to "UI" by THIS module (the caller, never a user flag), through a terminal whose prompts are dialogs the person
// answers in the browser. Every gate (contract authorization, qualification evidence, approvals, ledger, kill switch, typed phrases) is
// the CLI's, unchanged; a wrong phrase, a timeout or a cancel ends the command before the engine runs.
//
// Only this module may import src/cli/apply.ts from the console side, and only src/operator-ui/server.ts may import this module
// (test/apply-boundary.test.ts). No agent tool, no other src/ module and no browser code can reach it. It starts no process of
// its own: the engine is started only inside the driver, behind the same gates. Pilot POST endpoints exist only in this router.

/** The only commands the console can run, by name. The router builds every argument list; a client sends values, never arguments. */
export const PILOT_STEPS = ["preflight", "prepare", "seal", "approve", "apply", "observe", "propose-cleanup", "cleanup", "verify-cleanup"] as const;
export type PilotStep = typeof PILOT_STEPS[number];

export const PILOT_TOKEN_HEADER = "x-alz-pilot-token";
export const PILOT_BASE = "/pilot";
const MAX_BODY_BYTES = 16 * 1024;
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_ANSWER = 2048;
const MAX_PATH = 1024;
const MAX_APPROVALS = 8;
const MAX_TRANSCRIPT = 40_000;
const MAX_LISTED_CHANGES = 500;
const DEFAULT_DIALOG_TIMEOUT_MS = 10 * 60_000;
// The person's own text, without the characters that make a line read as another one.
const CONTROL = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u2028\u2029]/g;
const SAFE_APPROVER = /^[A-Za-z0-9._@+-]{1,128}$/;
const AWS_CLI_VERSION = /^\d+\.\d+\.\d+$/;

// --- the dialog terminal ------------------------------------------------------------------------------------

export type Dialog = { id: string; kind: PhraseKind; phrase: string; prompt: string };

export type DialogBroker = HumanTerminal & {
  /** The one question waiting for the person, if any. */
  pending(): Dialog | undefined;
  /** Delivers the person's answer to the dialog it was shown for. A stale or unknown id is refused and the dialog keeps waiting. */
  answer(id: string, text: string): boolean;
  /** Ends the waiting dialog with no answer. The command then stops at its own mismatch check, before anything runs. */
  cancel(): boolean;
  /** Everything the command wrote, for the Details disclosure. */
  transcript(): string;
};

/**
 * HumanTerminal by dialogs. `authenticated` is true only for a request that passed the channel's session-token check; with
 * false it reports no terminal and `runApplyCommand` refuses before reading any file. The prompt text the command writes
 * is queued for the browser. `ask` suspends until the browser answers THAT dialog, the timeout passes or the person cancels;
 * the last two answer with an empty line, which can never equal a phrase, so nothing runs and nothing is spent. One dialog
 * waits at a time. A dialog without an exact phrase is never shown, and the phrase is never answered for the person.
 */
export function createDialogBroker(options: { authenticated: boolean; timeoutMs?: number }): DialogBroker {
  const timeoutMs = options.timeoutMs ?? DEFAULT_DIALOG_TIMEOUT_MS;
  const written: string[] = [];
  let waiting: { dialog: Dialog; settle: (text: string) => void } | undefined;
  const printable = (text: string): string => stripInvisible(text).replace(CONTROL, "?");
  return {
    stdinIsTTY: options.authenticated,
    stdoutIsTTY: options.authenticated,
    write: (text) => { written.push(printable(text)); },
    ask: (prompt: string, expectation?: AskExpectation) => {
      if (!options.authenticated || waiting || !expectation || expectation.phrase === "") return Promise.resolve("");
      const dialog: Dialog = { id: randomUUID(), kind: expectation.kind, phrase: printable(expectation.phrase), prompt };
      return new Promise<string>((done) => {
        const timer = setTimeout(() => { settle(""); }, timeoutMs);
        const settle = (text: string) => { clearTimeout(timer); if (waiting?.dialog.id === dialog.id) waiting = undefined; done(text); };
        waiting = { dialog, settle };
      });
    },
    pending: () => waiting?.dialog,
    answer: (id, text) => {
      if (!waiting || waiting.dialog.id !== id || typeof text !== "string" || text.length > MAX_ANSWER) return false;
      waiting.settle(text);
      return true;
    },
    cancel: () => {
      if (!waiting) return false;
      waiting.settle("");
      return true;
    },
    transcript: () => written.join("").slice(-MAX_TRANSCRIPT),
  };
}

// --- plain summaries -----------------------------------------------------------------------------------------

export type ChangeCounts = { create: number; update: number; replace: number; delete: number; forget: number; other: number };

/** How many resources will be made, changed, replaced, deleted, or dropped from tracking, from the redacted change list. */
export function countChanges(changes: readonly PlanChange[]): ChangeCounts {
  const counts: ChangeCounts = { create: 0, update: 0, replace: 0, delete: 0, forget: 0, other: 0 };
  for (const change of changes) {
    if (change.action === "CREATE") counts.create += 1;
    else if (change.action === "UPDATE") counts.update += 1;
    else if (change.action === "REPLACE" || change.action === "REPLACE_CONDITIONAL") counts.replace += 1;
    else if (change.action === "DELETE") counts.delete += 1;
    else if (change.action === "FORGET") counts.forget += 1;
    else counts.other += 1;
  }
  return counts;
}

export type ReviewSummary = {
  environment: ApplyEnvironment;
  target: { account: string; backend: string; workspace: string };
  /** The first 12 characters people compare; the whole value is in the bundle. */
  shortId: string;
  /** The product source commit that made the preview; approvers sign it with the change. */
  sourceCommit: string;
  /** Who requested the change, by allowlist id: bound into the change ID every approver signs, and verified by the approver's own command. */
  requestedBy: string;
  createdAt: string;
  counts: ChangeCounts;
  changes: PlanChange[];
  changesOmitted: number;
  /** Which engine program made the preview, and whether real-engine qualification evidence covers it (the sealed provenance). */
  preview: { engineVersion: string; programId: string; qualified: boolean; qualifiedAt?: string; reason?: string };
  /** The deletion unit the plan stamps on what it creates, verified in the plan at sealing; null when the engine seals none. */
  unit: { unitId: string; tags: Record<string, string>; untagged: string[] } | null;
};

type Sealed = { environment: ApplyEnvironment; target: ReviewSummary["target"]; artifactSha256: string; sourceCommit: string; requesterId: string; createdAt: string; changes: PlanChange[];
  engineVersion: string; provenance: PreviewProvenance; unit: SealedPlan["unit"] };
const previewOf = ({ engineVersion, provenance: { engineBinarySha256, qualification } }: Sealed): ReviewSummary["preview"] => ({
  engineVersion: stripInvisible(engineVersion), programId: engineBinarySha256.slice(0, 12), qualified: qualification.state === "QUALIFIED",
  ...(qualification.state === "QUALIFIED" ? { qualifiedAt: qualification.qualifiedAt } : { reason: stripInvisible(qualification.reason) }),
});
const summaryOf = (bundle: Sealed): ReviewSummary => ({
  environment: bundle.environment, target: { ...bundle.target }, shortId: bundle.artifactSha256.slice(0, 12), sourceCommit: bundle.sourceCommit, requestedBy: stripInvisible(bundle.requesterId), createdAt: bundle.createdAt,
  counts: countChanges(bundle.changes),
  changes: bundle.changes.slice(0, MAX_LISTED_CHANGES).map((change) => ({ ...change, address: stripInvisible(change.address), type: stripInvisible(change.type) })),
  changesOmitted: Math.max(0, bundle.changes.length - MAX_LISTED_CHANGES),
  preview: previewOf(bundle),
  unit: bundle.unit === null ? null : {
    unitId: stripInvisible(bundle.unit.unitId), tags: Object.fromEntries(Object.entries(bundle.unit.tags).map(([k, v]) => [stripInvisible(k), stripInvisible(String(v))])),
    untagged: bundle.unit.untagged.slice(0, MAX_LISTED_CHANGES).map((a) => stripInvisible(a)),
  },
});

/** What the console shows of a cleanup proposal: identifiers and reasons only, as the terminal prints them. */
export type CleanupSummary = {
  proposalSha256: string;
  shortId: string;
  environment: ApplyEnvironment;
  target: ReviewSummary["target"];
  sourceCommit: string;
  artifactShortId: string;
  /** Who requested this cleanup, by allowlist id: bound into the proposal ID every approver signs. In PROD the requester cannot approve it. */
  requestedBy: string;
  requiredApprovals: number;
  deletes: CleanupProposal["deletes"];
  alreadyAbsent: CleanupProposal["alreadyAbsent"];
  excluded: CleanupProposal["excluded"];
  risks: string[];
  lines: string[];
};
const cleanupSummaryOf = (proposal: CleanupProposal): CleanupSummary => ({
  proposalSha256: proposal.proposalSha256, shortId: proposal.proposalSha256.slice(0, 12), environment: proposal.environment, target: { ...proposal.target }, sourceCommit: proposal.sourceCommit,
  artifactShortId: proposal.artifactSha256.slice(0, 12), requestedBy: stripInvisible(proposal.requesterId), requiredApprovals: proposal.authorization.requiredApprovals,
  deletes: proposal.deletes.map((x) => ({ ...x, address: stripInvisible(x.address), type: stripInvisible(x.type) })),
  alreadyAbsent: proposal.alreadyAbsent.map((x) => ({ ...x, address: stripInvisible(x.address) })), excluded: proposal.excluded.map((x) => ({ ...x, address: stripInvisible(x.address) })),
  risks: [...proposal.risks], lines: proposalLines(proposal).map((line) => line.replace(CONTROL, "?")),
});

// --- the router ----------------------------------------------------------------------------------------------

export type RunResult = {
  exit: number;
  /** Set when the command ended by a refusal or an error. */
  code?: string;
  message?: string;
  outcome?: string;
  /** The command's own redacted JSON (preflight checks, the seal result, the signed approval, the apply evidence). */
  data?: unknown;
  summary?: ReviewSummary;
  /** Propose-cleanup only: the proposal as the person reviews it, and where it was saved. */
  cleanup?: CleanupSummary;
  /** Approve only: where the signed approval was saved for the operator. */
  savedPath?: string;
};

type Run = { id: string; step: PilotStep; broker: DialogBroker; done?: RunResult; startedAt: string };
type PilotPath = "UI" | "CLI";

/** What the router may hand `runApplyCommand`: the locations and seams of the CLI, never the terminal, channel or report, which are this module's. */
export type PilotChannelDeps = Omit<ApplyCliDeps, "terminal" | "channel" | "report" | "stdout" | "stderr">;

export type PilotRouterOptions = {
  /** The repository root, against which a relative path from the page is resolved. */
  root: string;
  /** Test seam. Production draws a fresh random token at every start; a token never outlives its process. */
  token?: string;
  dialogTimeoutMs?: number;
  cli?: PilotChannelDeps;
  /** Where a signed approval is saved for the operator. Default: .runs/apply/approvals under the repository. */
  approvalsDir?: string;
  /** The cost configuration and saved cost status GET /pilot/cost reads. Default: config/cost.json and .runs/cost/status.json under `root`. */
  cost?: { configPath?: string; statusPath?: string };
};

/**
 * What GET /pilot/cost returns (the "Cost and visibility" panel; plan item 5). Read-only: the saved status the last `./alz cost status`
 * read (typed, with full addresses for the local operator), the cost configuration as configured, and the provisioning limits the
 * contract's seal judge enforces. Each part that cannot be read is UNKNOWN or UNREADABLE, never a passing value and never an error page.
 */
export type CostVisibility = {
  label: "COST_VISIBILITY";
  readOnly: true;
  advisory: true;
  actEnabled: false;
  /** The terminal command that reads AWS; the console never runs it. */
  command: string;
  status: { state: "NONE" | "UNREADABLE" | "UNKNOWN" } | { state: "OK"; cost: CostStatus };
  config: { state: "NONE" | "UNKNOWN" } | { state: "INVALID"; issues: { path: string; code: string }[] } | { state: "OK"; summary: CostConfigSummary };
  contractLimits: { state: "DISABLED" | "UNKNOWN" } | { state: "OK"; environments: { environment: ApplyEnvironment; limits: PilotLimits | null; canary: boolean }[] };
};

export type PilotRouter = {
  /** Printed to the operator's terminal at console start, never to the page, and never returned by any route. */
  readonly sessionToken: string;
  /** True for a path this router answers. */
  owns(url: string | undefined): boolean;
  handle(req: IncomingMessage, res: ServerResponse, context: { expectedOrigin: string; headers: Record<string, string> }): Promise<void>;
};

const sha = (value: string): Buffer => createHash("sha256").update(value).digest();
/** Constant time for any lengths: both sides are hashed first, so neither the content nor the length of the token leaks by timing. */
const sameToken = (given: string, expected: string): boolean => timingSafeEqual(sha(given), sha(expected));

class Bad extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}

const plainPath = (value: unknown, label: string): string => {
  if (typeof value !== "string" || value === "" || value.length > MAX_PATH || /[\u0000-\u001f\u007f-\u009f]/.test(value) || value.startsWith("--")) {
    throw new Bad(400, "PILOT_REQUEST_INVALID", label + " must be a file location on this computer.");
  }
  return value;
};

function fields(body: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (typeof body !== "object" || body === null || Array.isArray(body) || Object.keys(body).some((key) => !allowed.includes(key))) {
    throw new Bad(400, "PILOT_REQUEST_INVALID", "The request has fields this step does not take.");
  }
  return body as Record<string, unknown>;
}

function readJsonFile(path: string): unknown {
  try {
    if (lstatSync(path).size > MAX_FILE_BYTES) return undefined;
    return JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch { return undefined; }
}

export function createPilotRouter(options: PilotRouterOptions): PilotRouter {
  const token = options.token ?? randomBytes(32).toString("hex");
  const approvalsDir = options.approvalsDir ?? join(repoPaths().root, ".runs/apply/approvals");
  let chosen: PilotPath | null = null;
  let run: Run | undefined;
  // The last readiness check per environment, exactly as `preflight` returned it: what GET /pilot/paths reports for the contract's
  // path. Remembered, never assessed here; an environment with no check reads "not checked", never ready.
  const readinessByEnvironment = new Map<PathEnvironment, RememberedReadiness>();
  const rememberReadiness = (result: RunResult): void => {
    const remembered = rememberedReadiness(result.data, new Date().toISOString());
    if (remembered) readinessByEnvironment.set(remembered.environment, remembered);
  };
  /**
   * The contract as it is now, read-only, for GET /pilot/paths: the same fields `actDecisions` (src/apply/readiness.ts) reports
   * without an environment (hash, provider, engine, authorize entries, approval quorum, kill switch), from the same contract file
   * `preflight` reads. Read again on every request, so a remembered readiness result is shown only while it still describes it.
   */
  const currentContract = (): CurrentContract => {
    const loaded = loadPilotContract(options.cli?.contractPath ?? repoPaths().contract);
    if ("reason" in loaded) return { act: "DISABLED", reason: loaded.reason };
    const entries = ENVIRONMENTS.flatMap((environment) => { const entry = authorizationEntryOf(loaded, environment); return entry ? [{ environment, entry }] : []; });
    return {
      act: "PILOT_ENABLED", contractSha256: pilotContractSha256(loaded), provider: loaded.provider, engine: loaded.engine, killSwitch: isKillSwitchActive(loaded),
      authorized: entries.map(({ environment, entry }) => ({ environment, operations: [...entry.operations] })),
      approved: entries.map(({ environment }) => ({ environment, requiredApprovals: loaded.requiredApprovals[environment] ?? 0 })),
    };
  };
  const costFiles = { ...costPaths(options.root), ...(options.cost?.configPath ? { config: options.cost.configPath } : {}), ...(options.cost?.statusPath ? { status: options.cost.statusPath } : {}) };
  const costVisibility = (): CostVisibility => {
    let status: CostVisibility["status"];
    try { const snapshot = readCostSnapshot(costFiles.status); status = snapshot.state === "OK" ? { state: "OK", cost: snapshot.status } : snapshot; }
    catch { status = { state: "UNKNOWN" }; }
    let config: CostVisibility["config"];
    try { const local = readLocalCostConfig(costFiles.config); config = local.state === "OK" ? { state: "OK", summary: costConfigSummary(local.config) } : local; }
    catch { config = { state: "UNKNOWN" }; }
    let contractLimits: CostVisibility["contractLimits"];
    try {
      const loaded = loadPilotContract(options.cli?.contractPath ?? repoPaths().contract);
      contractLimits = "reason" in loaded ? { state: "DISABLED" } : { state: "OK", environments: ENVIRONMENTS.flatMap((environment) => {
        const target = loaded.targets[environment];
        return target ? [{ environment, limits: target.limits ? structuredClone(target.limits) : null, canary: target.canary !== undefined }] : [];
      }) };
    } catch { contractLimits = { state: "UNKNOWN" }; }
    return { label: "COST_VISIBILITY", readOnly: true, advisory: true, actEnabled: false, command: "./alz cost status --account <account>", status, config, contractLimits };
  };
  const absolute = (path: string): string => resolve(options.root, path);
  const running = (): boolean => run !== undefined && run.done === undefined;

  const send = (res: ServerResponse, headers: Record<string, string>, status: number, body: unknown): void => {
    res.writeHead(status, { ...headers, "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  };

  const stateOf = () => {
    const dialog = run && !run.done ? run.broker.pending() : undefined;
    return {
      unlocked: true as const, path: chosen, busy: running(),
      run: run ? {
        id: run.id, step: run.step, status: run.done ? "DONE" as const : dialog ? "WAITING" as const : "RUNNING" as const,
        startedAt: run.startedAt, transcript: run.broker.transcript(),
        ...(dialog ? { dialog: { id: dialog.id, kind: dialog.kind, phrase: dialog.phrase } } : {}),
        ...(run.done ? { result: run.done } : {}),
      } : null,
    };
  };

  function finishedBy(step: PilotStep, exit: number, report: ApplyReport | undefined, stdout: string): RunResult {
    const result: RunResult = { exit };
    if (report) { result.code = report.code; result.message = stripInvisible(report.message).replace(CONTROL, "?"); }
    if (report?.outcome) result.outcome = report.outcome;
    if (exit !== 0 && !report) result.code = "APPLY_UNEXPECTED_ERROR";
    // Prepare prints a readable review; its structured result travels in the report instead.
    if (report?.data !== undefined) result.data = report.data;
    else if (stdout.trim() !== "") {
      try { result.data = JSON.parse(stdout) as unknown; } catch { /* no structured output */ }
    }
    if (exit === 0 && step === "propose-cleanup" && typeof result.data === "object" && result.data !== null) {
      const data = result.data as { path?: string; proposal?: unknown };
      const opened = verifyCleanupProposal(data.proposal);
      if (opened.ok) result.cleanup = cleanupSummaryOf(opened.proposal);
      if (typeof data.path === "string") data.path = absolute(data.path);
    }
    if (exit === 0 && step === "seal" && typeof result.data === "object" && result.data !== null) {
      const data = result.data as Partial<Omit<Sealed, "createdAt">> & { sealedPlanPath?: string; reviewBundlePath?: string };
      // The page shows these locations for the person to note, so they are absolute, whatever directory the command used.
      if (typeof data.sealedPlanPath === "string") data.sealedPlanPath = absolute(data.sealedPlanPath);
      if (typeof data.reviewBundlePath === "string") data.reviewBundlePath = absolute(data.reviewBundlePath);
      if (data.environment && data.target && typeof data.artifactSha256 === "string" && typeof data.sourceCommit === "string" && typeof data.requesterId === "string" && Array.isArray(data.changes) &&
        typeof data.engineVersion === "string" && data.provenance && (data.unit === null || (typeof data.unit === "object" && data.unit !== null))) {
        result.summary = summaryOf({
          environment: data.environment, target: data.target, artifactSha256: data.artifactSha256, sourceCommit: data.sourceCommit, requesterId: data.requesterId, createdAt: "", changes: data.changes,
          engineVersion: data.engineVersion, provenance: data.provenance, unit: data.unit as SealedPlan["unit"],
        });
      }
    }
    return result;
  }

  /** Starts one named command. The only place `runApplyCommand` is called, and the only channel it is told is "UI". */
  function start(step: PilotStep, args: string[], after?: (result: RunResult, stdout: string) => void, cleanup?: () => void): void {
    const broker = createDialogBroker({ authenticated: true, timeoutMs: options.dialogTimeoutMs });
    const stdout: string[] = [];
    let report: ApplyReport | undefined;
    const record: Run = { id: randomUUID(), step, broker, startedAt: new Date().toISOString() };
    run = record;
    const finish = (exit: number): void => {
      try { cleanup?.(); } catch { /* a leftover private temporary file is swept with the system temporary directory */ }
      const result = finishedBy(step, exit, report, stdout.join(""));
      try { after?.(result, stdout.join("")); } catch { result.code ??= "APPLY_UNEXPECTED_ERROR"; }
      record.done = result;
    };
    runApplyCommand(args, {
      ...options.cli, terminal: broker, channel: "UI",
      stdout: (text) => { stdout.push(text); },
      stderr: (text) => { broker.write(text); },
      report: (event) => { report = event; },
    }).then(finish, () => { report = { code: "APPLY_UNEXPECTED_ERROR", message: "APPLY_UNEXPECTED_ERROR" }; finish(1); });
  }

  function requirePath(): void {
    if (chosen === null) throw new Bad(409, "PILOT_PATH_NOT_CHOSEN", "Choose how this change will run (the command line or this console) before anything else.");
    if (chosen === "CLI") throw new Bad(409, "PILOT_PATH_CLI", "This change was set to run on the command line, so the console buttons are off. Use the commands shown in step 1, or start over.");
    if (running()) throw new Bad(409, "PILOT_RUN_ACTIVE", "Something is already running. Wait for it to finish, or cancel its question.");
  }

  const environmentOf = (value: unknown): ApplyEnvironment => {
    if (!(ENVIRONMENTS as readonly unknown[]).includes(value)) throw new Bad(400, "PILOT_REQUEST_INVALID", "Choose DEV, QA or PROD.");
    return value as ApplyEnvironment;
  };

  /** A request file for another environment than the one picked on screen is stopped before any command runs. */
  function checkRequestEnvironment(path: string, environment: ApplyEnvironment): void {
    const file = readJsonFile(path);
    if (typeof file === "object" && file !== null && "environment" in file && (file as { environment: unknown }).environment !== environment) {
      throw new Bad(422, "PILOT_ENVIRONMENT_MISMATCH", "The request file is for " + String((file as { environment: unknown }).environment).slice(0, 8) +
        ", but you picked " + environment + ". Pick the environment the request file is for, or choose another request file.");
    }
  }

  /**
   * The wizard asks for one request file. `apply` takes a request with only environment, target and projectRoot, so when the
   * file is the seal request (those three plus policyVersion and resolved) the router writes the three fields to a private
   * temporary file for this one run. Anything else is passed through untouched so the command reports its own error.
   */
  function applyRequestFor(path: string): { path: string; remove: () => void } {
    const file = readJsonFile(path);
    const asIs = { path, remove: () => undefined };
    if (typeof file !== "object" || file === null || Array.isArray(file)) return asIs;
    const keys = Object.keys(file);
    const extra = keys.filter((key) => !["environment", "target", "projectRoot"].includes(key));
    if (extra.length === 0 || extra.some((key) => !["policyVersion", "resolved"].includes(key)) || !["environment", "target", "projectRoot"].every((key) => keys.includes(key))) return asIs;
    const { environment, target, projectRoot } = file as Record<string, unknown>;
    const directory = mkdtempSync(join(tmpdir(), "alz-ui-request-"));
    const derived = join(directory, "apply-request.json");
    writeFileSync(derived, JSON.stringify({ environment, target, projectRoot }), { mode: 0o600 });
    return { path: derived, remove: () => { rmSync(directory, { recursive: true, force: true }); } };
  }

  function review(bundlePath: string): { ok: true; summary: ReviewSummary } | { ok: false; code: string; message: string } {
    const file = readJsonFile(absolute(bundlePath));
    if (file === undefined) return { ok: false, code: "APPLY_INPUT_INVALID", message: "The review file cannot be read as a review file." };
    const opened = verifyReviewBundle(file);
    if (!opened.ok) return { ok: false, code: opened.code, message: opened.message };
    if (opened.bundle.channel !== "UI") return { ok: false, code: "CHANNEL_MISMATCH", message: channelMismatchMessage(opened.bundle.channel) };
    return { ok: true, summary: summaryOf(opened.bundle) };
  }

  function reviewCleanup(proposalPath: string): { ok: true; cleanup: CleanupSummary } | { ok: false; code: string; message: string } {
    const file = readJsonFile(absolute(proposalPath));
    if (file === undefined) return { ok: false, code: "APPLY_INPUT_INVALID", message: "The cleanup proposal file cannot be read as a proposal." };
    const opened = verifyCleanupProposal(file);
    if (!opened.ok) return { ok: false, code: opened.code, message: opened.message };
    if (opened.proposal.channel !== "UI") return { ok: false, code: "CHANNEL_MISMATCH", message: channelMismatchMessage(opened.proposal.channel) };
    return { ok: true, cleanup: cleanupSummaryOf(opened.proposal) };
  }

  function saveApproval(result: RunResult, stdout: string): void {
    if (result.exit !== 0) return;
    const parsed = JSON.parse(stdout) as { statement?: { artifactSha256?: string; approverId?: string; nonce?: string } };
    const statement = parsed.statement;
    if (!statement || typeof statement.artifactSha256 !== "string" || typeof statement.approverId !== "string" || !SAFE_APPROVER.test(statement.approverId)) {
      throw new Error("APPROVAL_UNREADABLE");
    }
    mkdirSync(approvalsDir, { recursive: true, mode: 0o700 });
    const path = join(approvalsDir, statement.artifactSha256.slice(0, 12) + "-" + statement.approverId + "-" + String(statement.nonce).slice(0, 8) + ".json");
    writeFileSync(path, JSON.stringify(parsed, null, 2) + "\n", { mode: 0o600 });
    result.savedPath = path;
  }

  async function readBody(req: IncomingMessage): Promise<unknown> {
    let size = 0;
    const chunks: Buffer[] = [];
    for await (const chunk of req as AsyncIterable<Buffer>) {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) throw new Bad(413, "PILOT_REQUEST_TOO_LARGE", "That request is too large.");
      chunks.push(chunk);
    }
    try { return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown; } catch { throw new Bad(400, "PILOT_REQUEST_INVALID", "The request could not be read."); }
  }

  async function route(req: IncomingMessage, res: ServerResponse, context: { expectedOrigin: string; headers: Record<string, string> }): Promise<void> {
    const url = req.url ?? "";
    const tokenGiven = req.headers[PILOT_TOKEN_HEADER];
    const authenticated = typeof tokenGiven === "string" && sameToken(tokenGiven, token);

    if (req.method === "GET" && url === PILOT_BASE + "/state") {
      // Before the token is pasted the page learns nothing but that it is locked.
      send(res, context.headers, 200, authenticated ? stateOf() : { unlocked: false });
      return;
    }
    if (req.method === "GET" && url === PILOT_BASE + "/paths") {
      // Read-only: the deployment paths from the release records, with the readiness checks already run. It starts nothing and
      // changes nothing; ordering and display are the page's. The session token is required, as for every pilot route with data.
      if (!authenticated) throw new Bad(401, "PILOT_TOKEN_REQUIRED", "The session token is missing or wrong. Paste the token printed in the terminal where you started the console.");
      let report: ReturnType<typeof deploymentPaths>;
      try { report = deploymentPaths(options.root, [...readinessByEnvironment.values()], currentContract()); }
      catch { throw new Bad(503, "PILOT_PATHS_UNAVAILABLE", "The release records for the deployment paths cannot be read on this computer."); }
      send(res, context.headers, 200, report);
      return;
    }
    if (req.method === "GET" && url === PILOT_BASE + "/cost") {
      // Read-only: two local files and the contract, never a cloud call. The session token is required, as for every pilot route with data.
      if (!authenticated) throw new Bad(401, "PILOT_TOKEN_REQUIRED", "The session token is missing or wrong. Paste the token printed in the terminal where you started the console.");
      send(res, context.headers, 200, costVisibility());
      return;
    }
    if (req.method !== "POST") throw new Bad(405, "PILOT_METHOD_NOT_ALLOWED", "That is not allowed here.");
    // Every pilot POST: same origin (and a browser always sends one), JSON, the session token, a size limit. No CORS header is ever sent.
    if (req.headers.origin !== context.expectedOrigin) throw new Bad(403, "PILOT_ORIGIN_REQUIRED", "This request did not come from the console page.");
    if (!(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) throw new Bad(415, "PILOT_JSON_REQUIRED", "The request must be sent as JSON.");
    if (!authenticated) throw new Bad(401, "PILOT_TOKEN_REQUIRED", "The session token is missing or wrong. Paste the token printed in the terminal where you started the console.");
    const body = await readBody(req);

    switch (url.slice(PILOT_BASE.length)) {
      case "/aws-readiness": {
        const input = fields(body, ["account", "profile"]);
        if (running()) throw new Bad(409, "PILOT_RUN_ACTIVE", "Finish the current change before checking another AWS account.");
        let request: { account: string; profile: string };
        try { request = validatedAccountRequest(input); }
        catch { throw new Bad(400, "AWS_SETUP_INPUT_INVALID", "Enter a separate 12-digit DEV account and a saved AWS connection name."); }
        try {
          const result = await checkDevAccount(request);
          send(res, context.headers, 200, result);
        } catch {
          // Never echo stderr, credentials, account metadata or a token in API errors.
          throw new Bad(422, "AWS_ACCOUNT_NOT_VERIFIED", "This AWS account could not be verified. Check the saved connection, DEV account, Workloads area, and governance status.");
        }
        return;
      }
      case "/path": {
        const { path } = fields(body, ["path"]);
        if (path !== "UI" && path !== "CLI") throw new Bad(400, "PILOT_REQUEST_INVALID", "Choose the command line or this console.");
        if (running()) throw new Bad(409, "PILOT_RUN_ACTIVE", "Something is already running.");
        if (chosen !== null && chosen !== path) throw new Bad(409, "PILOT_PATH_LOCKED", "This change already runs on the other path, and one change never mixes both. Start over to begin a new change.");
        chosen = path;
        send(res, context.headers, 200, stateOf());
        return;
      }
      case "/reset": {
        fields(body, []);
        if (running()) throw new Bad(409, "PILOT_RUN_ACTIVE", "Something is still running. Wait for it, or cancel its question first.");
        chosen = null;
        run = undefined;
        send(res, context.headers, 200, stateOf());
        return;
      }
      case "/preflight": {
        const input = fields(body, ["environment"]);
        requirePath();
        start("preflight", ["preflight", "--environment", environmentOf(input.environment)], rememberReadiness);
        send(res, context.headers, 202, stateOf());
        return;
      }
      case "/prepare": {
        // Local files only: the command writes the request and manifest from the reviewed contract and the project folder,
        // runs no engine and enables nothing. The one value a person may add is the AWS CLI version, when no record has it.
        const input = fields(body, ["environment", "projectPath", "awsCliVersion"]);
        requirePath();
        const environment = environmentOf(input.environment);
        const projectPath = absolute(plainPath(input.projectPath, "The project folder"));
        const version = input.awsCliVersion;
        if (version !== undefined && (typeof version !== "string" || !AWS_CLI_VERSION.test(version))) {
          throw new Bad(400, "PILOT_REQUEST_INVALID", "Enter the AWS CLI version as three numbers, for example 2.27.10.");
        }
        start("prepare", ["prepare", "--environment", environment, "--project", projectPath, ...(version ? ["--aws-cli-version", version] : [])]);
        send(res, context.headers, 202, stateOf());
        return;
      }
      case "/review": {
        const input = fields(body, ["bundlePath"]);
        if (chosen === "CLI") throw new Bad(409, "PILOT_PATH_CLI", "This change was set to run on the command line, so the console buttons are off.");
        if (chosen === null) throw new Bad(409, "PILOT_PATH_NOT_CHOSEN", "Choose how this change will run (the command line or this console) before anything else.");
        send(res, context.headers, 200, review(plainPath(input.bundlePath, "The review file")));
        return;
      }
      case "/seal": {
        // The requester signs the sealed request with their own allowlisted key: a name and a key file on this machine, as for an approval.
        const input = fields(body, ["environment", "requestPath", "manifestPath", "requesterId", "keyPath"]);
        requirePath();
        const environment = environmentOf(input.environment);
        if (typeof input.requesterId !== "string" || !SAFE_APPROVER.test(input.requesterId)) {
          throw new Bad(400, "PILOT_REQUEST_INVALID", "Your requester name may use letters, digits, dots, dashes and @ only.");
        }
        const requestPath = absolute(plainPath(input.requestPath, "The request file"));
        const manifestPath = absolute(plainPath(input.manifestPath, "The manifest file"));
        const keyPath = absolute(plainPath(input.keyPath, "Your key file"));
        checkRequestEnvironment(requestPath, environment);
        start("seal", ["seal", "--request", requestPath, "--manifest", manifestPath, "--requester", input.requesterId, "--key", keyPath]);
        send(res, context.headers, 202, stateOf());
        return;
      }
      case "/approve": {
        const input = fields(body, ["bundlePath", "keyPath", "approverId"]);
        requirePath();
        if (typeof input.approverId !== "string" || !SAFE_APPROVER.test(input.approverId)) {
          throw new Bad(400, "PILOT_REQUEST_INVALID", "Your approver name may use letters, digits, dots, dashes and @ only.");
        }
        const bundlePath = absolute(plainPath(input.bundlePath, "The review file"));
        const keyPath = absolute(plainPath(input.keyPath, "Your key file"));
        start("approve", ["approve", "--bundle", bundlePath, "--key", keyPath, "--approver", input.approverId], saveApproval);
        send(res, context.headers, 202, stateOf());
        return;
      }
      case "/apply": {
        const input = fields(body, ["environment", "requestPath", "manifestPath", "sealedPath", "approvalPaths"]);
        requirePath();
        const environment = environmentOf(input.environment);
        if (!Array.isArray(input.approvalPaths) || input.approvalPaths.length < 1 || input.approvalPaths.length > MAX_APPROVALS) {
          throw new Bad(400, "PILOT_REQUEST_INVALID", "Add at least one approval file.");
        }
        const requestPath = absolute(plainPath(input.requestPath, "The request file"));
        const manifestPath = absolute(plainPath(input.manifestPath, "The manifest file"));
        const sealedPath = absolute(plainPath(input.sealedPath, "The sealed plan file"));
        const approvals = (input.approvalPaths as unknown[]).map((item) => absolute(plainPath(item, "An approval file")));
        checkRequestEnvironment(requestPath, environment);
        const forApply = applyRequestFor(requestPath);
        start("apply", ["apply", "--request", forApply.path, "--manifest", manifestPath, "--sealed", sealedPath, ...approvals.flatMap((path) => ["--approval", path])], undefined, forApply.remove);
        send(res, context.headers, 202, stateOf());
        return;
      }
      case "/observe": {
        // Read-only: the run's identifiers against the cloud, as DISCOVERY. Repeating it observes again; it never applies again.
        const input = fields(body, ["sealedPath"]);
        requirePath();
        start("observe", ["observe", "--sealed", absolute(plainPath(input.sealedPath, "The prepared change file"))]);
        send(res, context.headers, 202, stateOf());
        return;
      }
      case "/propose-cleanup": {
        // The cleanup's requester signs the proposal with their own allowlisted key, as at /seal: a name and a key file on this machine.
        const input = fields(body, ["sealedPath", "requesterId", "keyPath"]);
        requirePath();
        if (typeof input.requesterId !== "string" || !SAFE_APPROVER.test(input.requesterId)) {
          throw new Bad(400, "PILOT_REQUEST_INVALID", "Your requester name may use letters, digits, dots, dashes and @ only.");
        }
        const sealedPath = absolute(plainPath(input.sealedPath, "The prepared change file"));
        const keyPath = absolute(plainPath(input.keyPath, "Your key file"));
        start("propose-cleanup", ["propose-cleanup", "--sealed", sealedPath, "--requester", input.requesterId, "--key", keyPath]);
        send(res, context.headers, 202, stateOf());
        return;
      }
      case "/review-cleanup": {
        const input = fields(body, ["proposalPath"]);
        if (chosen === "CLI") throw new Bad(409, "PILOT_PATH_CLI", "This change was set to run on the command line, so the console buttons are off.");
        if (chosen === null) throw new Bad(409, "PILOT_PATH_NOT_CHOSEN", "Choose how this change will run (the command line or this console) before anything else.");
        send(res, context.headers, 200, reviewCleanup(plainPath(input.proposalPath, "The cleanup proposal file")));
        return;
      }
      case "/cleanup": {
        const input = fields(body, ["environment", "requestPath", "manifestPath", "sealedPath", "proposalPath", "approvalPaths"]);
        requirePath();
        const environment = environmentOf(input.environment);
        if (!Array.isArray(input.approvalPaths) || input.approvalPaths.length < 1 || input.approvalPaths.length > MAX_APPROVALS) {
          throw new Bad(400, "PILOT_REQUEST_INVALID", "Add at least one cleanup approval file.");
        }
        const requestPath = absolute(plainPath(input.requestPath, "The request file"));
        const manifestPath = absolute(plainPath(input.manifestPath, "The manifest file"));
        const sealedPath = absolute(plainPath(input.sealedPath, "The prepared change file"));
        const proposalPath = absolute(plainPath(input.proposalPath, "The cleanup proposal file"));
        const approvals = (input.approvalPaths as unknown[]).map((item) => absolute(plainPath(item, "An approval file")));
        checkRequestEnvironment(requestPath, environment);
        const forCleanup = applyRequestFor(requestPath);
        start("cleanup", ["cleanup", "--proposal", proposalPath, "--request", forCleanup.path, "--manifest", manifestPath, "--sealed", sealedPath, ...approvals.flatMap((path) => ["--approval", path])], undefined, forCleanup.remove);
        send(res, context.headers, 202, stateOf());
        return;
      }
      case "/verify-cleanup": {
        const input = fields(body, ["proposalPath"]);
        requirePath();
        start("verify-cleanup", ["verify-cleanup", "--proposal", absolute(plainPath(input.proposalPath, "The cleanup proposal file"))]);
        send(res, context.headers, 202, stateOf());
        return;
      }
      case "/answer": {
        const input = fields(body, ["dialogId", "answer"]);
        if (!run || run.done || typeof input.dialogId !== "string" || typeof input.answer !== "string" || !run.broker.answer(input.dialogId, input.answer)) {
          throw new Bad(409, "PILOT_NO_SUCH_QUESTION", "That question is no longer waiting. Look at the screen for the current one.");
        }
        send(res, context.headers, 200, stateOf());
        return;
      }
      case "/cancel": {
        fields(body, []);
        if (!run || run.done || !run.broker.cancel()) throw new Bad(409, "PILOT_NOTHING_TO_CANCEL", "No question is waiting, so there is nothing to cancel.");
        send(res, context.headers, 200, stateOf());
        return;
      }
      default:
        throw new Bad(404, "NOT_FOUND", "Not found.");
    }
  }

  return {
    sessionToken: token,
    owns: (url) => url === PILOT_BASE || (url?.startsWith(PILOT_BASE + "/") ?? false),
    handle: async (req, res, context) => {
      try {
        await route(req, res, context);
      } catch (error) {
        if (error instanceof Bad) send(res, context.headers, error.status, { error: error.code, message: error.message });
        else send(res, context.headers, 500, { error: "PILOT_FAILED", message: "The console could not complete that. Nothing was run." });
      }
    },
  };
}
