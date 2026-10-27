import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * The lifecycle runner's journal (docs/operator-guide.md, "Packaged release lifecycle"): one JSON line appended before a
 * step runs and one after it finishes, so a rerun knows exactly where an interrupted run stopped. A journal is bound to
 * one artifact and one source commit; a run against a different artifact refuses to continue it rather than mixing
 * evidence from two candidates. The journal is append-only: nothing here rewrites or deletes a line.
 */
export type JourneyId = "clean-install" | "uninstall" | "partial-install-recovery";
export type StepOutcome = "PASS" | "FAIL" | "BLOCKED";
export type JournalLine = {
  schemaVersion: 1;
  journey: JourneyId;
  step: string;
  /** "start" is written before the step runs; "finish" after, with the outcome. */
  event: "start" | "finish";
  at: string;
  pid: number;
  artifactSha256: string;
  sourceCommit: string;
  outcome?: StepOutcome;
  code?: string;
};

export class JournalError extends Error {
  constructor(readonly code: "LIFECYCLE_JOURNAL_ARTIFACT_MISMATCH" | "LIFECYCLE_JOURNAL_UNREADABLE", message: string) {
    super(message);
  }
}

export type JournalIdentity = { artifactSha256: string; sourceCommit: string };

/** What the journal says about one step: never run, finished with an outcome, or started and never finished (interrupted). */
export type StepRecord = { status: "NOT_RUN" } | { status: "FINISHED"; outcome: StepOutcome; code?: string } | { status: "INTERRUPTED"; pid: number };

const sha64 = /^[0-9a-f]{64}$/;
const sha40 = /^[0-9a-f]{40}$/;

function parseLine(text: string, index: number): JournalLine {
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new JournalError("LIFECYCLE_JOURNAL_UNREADABLE", "Journal line " + (index + 1) + " is not JSON."); }
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new JournalError("LIFECYCLE_JOURNAL_UNREADABLE", "Journal line " + (index + 1) + " is not an object.");
  const line = value as Record<string, unknown>;
  if (line.schemaVersion !== 1 || typeof line.journey !== "string" || typeof line.step !== "string" || (line.event !== "start" && line.event !== "finish") ||
    typeof line.at !== "string" || typeof line.pid !== "number" || typeof line.artifactSha256 !== "string" || !sha64.test(line.artifactSha256) ||
    typeof line.sourceCommit !== "string" || !sha40.test(line.sourceCommit) ||
    (line.event === "finish" && line.outcome !== "PASS" && line.outcome !== "FAIL" && line.outcome !== "BLOCKED")) {
    throw new JournalError("LIFECYCLE_JOURNAL_UNREADABLE", "Journal line " + (index + 1) + " does not have the expected fields.");
  }
  return line as JournalLine;
}

export class Journal {
  private readonly lines: JournalLine[];

  /**
   * Opens the journal at `file` for `identity`. An existing journal written for another artifact or commit is refused; a
   * missing one starts empty. A line that cannot be read fails the whole journal: a torn write is never guessed around.
   */
  constructor(readonly file: string, readonly identity: JournalIdentity) {
    this.lines = [];
    if (!existsSync(file)) return;
    let text: string;
    try { text = readFileSync(file, "utf8"); } catch { throw new JournalError("LIFECYCLE_JOURNAL_UNREADABLE", "The journal could not be read."); }
    const rows = text.split("\n");
    // A trailing partial line (the process died mid-write) is a torn write: refuse rather than guess.
    if (rows.length > 0 && rows[rows.length - 1] !== "") throw new JournalError("LIFECYCLE_JOURNAL_UNREADABLE", "The journal's last line is incomplete.");
    rows.pop();
    this.lines = rows.map(parseLine);
    const other = this.lines.find((line) => line.artifactSha256 !== identity.artifactSha256 || line.sourceCommit !== identity.sourceCommit);
    if (other) {
      throw new JournalError("LIFECYCLE_JOURNAL_ARTIFACT_MISMATCH",
        "The journal belongs to another candidate (artifact " + other.artifactSha256.slice(0, 12) + ", commit " + other.sourceCommit.slice(0, 12) + "). Use a new evidence folder for this one.");
    }
  }

  /** Every line read or written so far, oldest first. */
  entries(): readonly JournalLine[] { return this.lines; }

  private append(line: JournalLine): void {
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    appendFileSync(this.file, JSON.stringify(line) + "\n", { mode: 0o600 });
    this.lines.push(line);
  }

  start(journey: JourneyId, step: string, at: string, pid = process.pid): void {
    this.append({ schemaVersion: 1, journey, step, event: "start", at, pid, ...this.identity });
  }

  finish(journey: JourneyId, step: string, outcome: StepOutcome, at: string, code?: string, pid = process.pid): void {
    this.append({ schemaVersion: 1, journey, step, event: "finish", at, pid, outcome, ...(code ? { code } : {}), ...this.identity });
  }

  /** The latest state of one step: the last finish wins; a start after the last finish means interrupted. */
  record(journey: JourneyId, step: string): StepRecord {
    let result: StepRecord = { status: "NOT_RUN" };
    for (const line of this.lines) {
      if (line.journey !== journey || line.step !== step) continue;
      if (line.event === "start") result = { status: "INTERRUPTED", pid: line.pid };
      else result = { status: "FINISHED", outcome: line.outcome!, ...(line.code ? { code: line.code } : {}) };
    }
    return result;
  }
}
