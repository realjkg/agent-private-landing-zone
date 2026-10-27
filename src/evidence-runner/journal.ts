import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

import { JournalError as LifecycleJournalError, acquireRunLock as acquireLifecycleLock } from "../lifecycle/journal.js";
import { STAGES, type RunLabel, type StageId, type StepOutcome } from "./types.js";

/**
 * The evidence runner's journal: one JSON line appended before a step runs and one after it finishes, so a rerun knows
 * exactly where an interrupted run stopped. The same contract as the lifecycle runner's journal (PR #281): append-only,
 * bound to one run identity, a torn last line refused rather than repaired. A run with another candidate, configuration,
 * host, label or expected account never continues this one.
 */
export type JournalIdentity = {
  sourceCommit: string;
  configSha256: string;
  targetHardwareId: string;
  label: RunLabel;
  host: string;
  /** SHA-256 of the expected account, tenant and subscription ids (never a credential). */
  identityHash: string;
};
export type JournalLine = JournalIdentity & {
  schemaVersion: 1;
  stage: StageId;
  step: string;
  event: "start" | "finish";
  at: string;
  pid: number;
  outcome?: StepOutcome;
  code?: string;
};
export type StepRecord = { status: "NOT_RUN" } | { status: "FINISHED"; outcome: StepOutcome; code?: string } | { status: "INTERRUPTED"; pid: number };

export type JournalErrorCode = "EVIDENCE_JOURNAL_MISMATCH" | "EVIDENCE_JOURNAL_UNREADABLE" | "EVIDENCE_RUN_IN_PROGRESS" | "EVIDENCE_LOCK_UNREADABLE";
export class JournalError extends Error {
  constructor(readonly code: JournalErrorCode, message: string) { super(message); }
}

const IDENTITY_KEYS: readonly (keyof JournalIdentity)[] = ["sourceCommit", "configSha256", "targetHardwareId", "label", "host", "identityHash"];
const OUTCOMES: readonly StepOutcome[] = ["PASS", "BLOCKED", "FAIL", "SKIPPED"];
const NEW_FOLDER = " Move the old run's folder aside to start a new one; a journal is never repaired or reused.";
const sha64 = /^[0-9a-f]{64}$/;
const sha40 = /^[0-9a-f]{40}$/;

function parseLine(text: string, index: number): JournalLine {
  const bad = (why: string): never => { throw new JournalError("EVIDENCE_JOURNAL_UNREADABLE", "Journal line " + (index + 1) + " " + why + "." + NEW_FOLDER); };
  let value: unknown;
  try { value = JSON.parse(text); } catch { return bad("is not JSON"); }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return bad("is not an object");
  const line = value as Record<string, unknown>;
  const ok = line.schemaVersion === 1 && (STAGES as readonly unknown[]).includes(line.stage) && typeof line.step === "string" && line.step !== "" &&
    (line.event === "start" || line.event === "finish") && typeof line.at === "string" && typeof line.pid === "number" &&
    typeof line.sourceCommit === "string" && sha40.test(line.sourceCommit) && typeof line.configSha256 === "string" && sha64.test(line.configSha256) &&
    typeof line.identityHash === "string" && sha64.test(line.identityHash) && typeof line.targetHardwareId === "string" && line.targetHardwareId !== "" &&
    (line.label === "SYNTHETIC" || line.label === "LIVE") && typeof line.host === "string" && line.host !== "" &&
    (line.event === "start" || OUTCOMES.includes(line.outcome as StepOutcome)) && (line.code === undefined || typeof line.code === "string");
  if (!ok) return bad("does not have the expected fields");
  return line as JournalLine;
}

/** Reads a journal file without binding it to an identity (for `./alz evidence status`). A torn or malformed line is refused. */
export function readJournal(file: string): JournalLine[] {
  if (!existsSync(file)) return [];
  let text: string;
  try { text = readFileSync(file, "utf8"); } catch { throw new JournalError("EVIDENCE_JOURNAL_UNREADABLE", "The journal could not be read." + NEW_FOLDER); }
  if (text === "") return [];
  const rows = text.split("\n");
  if (rows[rows.length - 1] !== "") throw new JournalError("EVIDENCE_JOURNAL_UNREADABLE", "The journal's last line is incomplete (the run that wrote it stopped mid-write)." + NEW_FOLDER);
  rows.pop();
  return rows.map(parseLine);
}

/** The latest state of one step in `lines`: the last finish wins; a start after the last finish means interrupted. */
export function stepRecord(lines: readonly JournalLine[], stage: StageId, step: string): StepRecord {
  let result: StepRecord = { status: "NOT_RUN" };
  for (const line of lines) {
    if (line.stage !== stage || line.step !== step) continue;
    result = line.event === "start" ? { status: "INTERRUPTED", pid: line.pid } : { status: "FINISHED", outcome: line.outcome!, ...(line.code ? { code: line.code } : {}) };
  }
  return result;
}

export class Journal {
  private readonly lines: JournalLine[];

  /** Opens the journal at `file` for `identity`. A journal of another run is refused; a missing one starts empty. */
  constructor(readonly file: string, readonly identity: JournalIdentity) {
    this.lines = readJournal(file);
    const other = this.lines.find((line) => IDENTITY_KEYS.some((key) => line[key] !== identity[key]));
    if (other) {
      const differs = IDENTITY_KEYS.filter((key) => other[key] !== identity[key]);
      throw new JournalError("EVIDENCE_JOURNAL_MISMATCH",
        "The journal belongs to another run: it differs in " + differs.join(", ") + " (that run: " + other.label + ", commit " +
        other.sourceCommit.slice(0, 12) + ", host " + other.host + ")." + NEW_FOLDER);
    }
  }

  entries(): readonly JournalLine[] { return this.lines; }

  private append(line: JournalLine): void {
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    appendFileSync(this.file, JSON.stringify(line) + "\n", { mode: 0o600 });
    this.lines.push(line);
  }

  start(stage: StageId, step: string, at: string, pid = process.pid): void {
    this.append({ schemaVersion: 1, stage, step, event: "start", at, pid, ...this.identity });
  }

  finish(stage: StageId, step: string, outcome: StepOutcome, at: string, code?: string, pid = process.pid): void {
    this.append({ schemaVersion: 1, stage, step, event: "finish", at, pid, outcome, ...(code ? { code } : {}), ...this.identity });
  }

  record(stage: StageId, step: string): StepRecord { return stepRecord(this.lines, stage, step); }
}

/**
 * One run per evidence folder at a time: `run.lock`, holding the pid. This reuses the lifecycle runner's lock
 * (`src/lifecycle/journal.ts`, `acquireRunLock`) rather than a copy of it, so both runners share one takeover rule: a lock
 * whose pid is proven dead is replaced only by the run that creates the exclusive `run.lock.takeover-<pid>` token and
 * then reads the same dead pid again, so two runs that both saw a stale lock can never both hold the folder.
 *
 * A refusal is reported in the evidence runner's terms. A lock with no readable pid (a run stopped between creating the
 * file and writing it) is never guessed stale; the refusal names the file and how to recover instead of asking the
 * person to wait for a run that does not exist.
 */
export function acquireRunLock(file: string, pidAlive?: (pid: number) => boolean): () => void {
  try {
    return acquireLifecycleLock(file, pidAlive);
  } catch (error) {
    if (!(error instanceof LifecycleJournalError) || error.code !== "LIFECYCLE_RUN_IN_PROGRESS") throw error;
    let pid: unknown;
    try { pid = (JSON.parse(readFileSync(file, "utf8")) as { pid?: unknown }).pid; } catch { pid = undefined; }
    if (typeof pid === "number" && Number.isInteger(pid) && pid >= 1) {
      throw new JournalError("EVIDENCE_RUN_IN_PROGRESS", "Another evidence run (pid " + pid + ") is using this folder right now, so this run changed nothing. Wait for it to finish.");
    }
    throw new JournalError("EVIDENCE_LOCK_UNREADABLE",
      "The run lock " + file + " names no process (a run stopped while taking it), so this run changed nothing. If no ./alz evidence run is active on this host, remove that file and rerun.");
  }
}
