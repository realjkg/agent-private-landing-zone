import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";

import { childEnvironment, launcherOf, type ChildIo, type Spawner } from "./child.js";
import type { EvidenceRunnerConfig } from "./config.js";
import type { Journal, JournalDocument } from "./journal.js";
import type { Preflight } from "./preflight.js";
import type { RunLabel, StageId, StepOutcome } from "./types.js";

/**
 * How a stage runs its steps (docs/evidence-runner.md, "Journal and resume").
 *
 * Each step is journaled: a `start` line before and a `finish` line after, with the child's exit code and the documents its
 * producer wrote. On a rerun a step that finished PASS is skipped and its documents are reused. A step marked `once` (a step
 * that runs the engine against the account, consumes approvals or writes a record that exists once) is never started again by
 * the runner once it has started, whatever its result: the stage stops with `EVIDENCE_STEP_NOT_REPEATED` and the person
 * continues by hand (docs/act-pilot-apply.md, "When an apply fails"). Any other step that did not pass runs again.
 */
export type StepResult = { outcome: StepOutcome; code?: string; detail: string; exitCode?: number; documents?: JournalDocument[] };

/** The person at the terminal: asked only for file paths the runner passes on, never for a product phrase. */
export type StepTerminal = { stdinIsTTY: boolean; stdoutIsTTY: boolean; ask: (question: string) => Promise<string> };

export type StageContext = {
  root: string;
  config: EvidenceRunnerConfig;
  label: RunLabel;
  /** The run's folder (absolute), and the same relative to the repository. */
  runDir: string;
  runDirRel: string;
  journal: Journal;
  preflight: Preflight;
  env: NodeJS.ProcessEnv;
  /** The private folder that stands in for HOME in every child. */
  childHome: string;
  realHome?: string;
  spawn: Spawner;
  terminal: StepTerminal;
  at: () => string;
  out: (line: string) => void;
};

export const sha256File = (path: string): string => createHash("sha256").update(readFileSync(path)).digest("hex");
const rel = (ctx: Pick<StageContext, "root">, path: string): string => relative(ctx.root, path).split("\\").join("/");

/** A stage's folder name: the stage id with its colon replaced, so it is a plain folder name everywhere. */
export const stageFolder = (stage: StageId): string => stage.replace(":", "-");

/**
 * Runs one journaled step. Returns the result, or the earlier result when the step already passed in this run.
 */
export async function step(ctx: StageContext, stage: StageId, name: string, options: { once?: boolean }, run: () => Promise<StepResult>): Promise<StepResult & { reused?: boolean }> {
  const previous = ctx.journal.record(stage, name);
  if (previous.status === "FINISHED" && previous.outcome === "PASS") {
    ctx.out("  ok       " + name + ": already done in this run, not repeated.");
    return { outcome: "PASS", code: previous.code, detail: "Done earlier in this run.", documents: previous.documents, reused: true };
  }
  if (options.once && previous.status !== "NOT_RUN") {
    const how = previous.status === "INTERRUPTED" ? "started and never finished" : "ended " + previous.outcome + (previous.code ? " " + previous.code : "");
    return { outcome: "BLOCKED", code: "EVIDENCE_STEP_NOT_REPEATED",
      detail: name + " " + how + " earlier in this run. The runner never starts a step that can change the account, spend approvals or write a one-time record twice. " +
        "Review its records (./alz apply status), continue by hand as docs/act-pilot-apply.md \"When an apply fails\" says, or start a new run folder." };
  }
  ctx.journal.start(stage, name, ctx.at());
  let result: StepResult;
  try {
    result = await run();
  } catch (error) {
    result = { outcome: "FAIL", code: "EVIDENCE_STEP_ERROR", detail: name + " stopped with an error: " + ((error as Error)?.message ?? "unknown").slice(0, 200) };
  }
  ctx.journal.finish(stage, name, result.outcome, ctx.at(), result.code, { exitCode: result.exitCode, documents: result.documents });
  return result;
}

/** Runs a read-only step every time (journaled the same way): the summary's index and review must be current, never reused. */
export async function freshStep(ctx: StageContext, stage: StageId, name: string, run: () => Promise<StepResult>): Promise<StepResult> {
  ctx.journal.start(stage, name, ctx.at());
  let result: StepResult;
  try { result = await run(); } catch (error) {
    result = { outcome: "FAIL", code: "EVIDENCE_STEP_ERROR", detail: name + " stopped with an error: " + ((error as Error)?.message ?? "unknown").slice(0, 200) };
  }
  ctx.journal.finish(stage, name, result.outcome, ctx.at(), result.code, { exitCode: result.exitCode, documents: result.documents });
  return result;
}

/** A folder's entries before a step: name to a stamp of inode, size and modification time. */
type Snapshot = Map<string, string>;
function snapshot(dir: string): Snapshot {
  const seen: Snapshot = new Map();
  let names: string[];
  try { names = readdirSync(dir); } catch { return seen; }
  for (const name of names) {
    try {
      const stat = lstatSync(join(dir, name));
      if (stat.isFile()) seen.set(name, stat.ino + ":" + stat.size + ":" + stat.mtimeMs);
    } catch { /* gone */ }
  }
  return seen;
}

/**
 * A document a step's producer is expected to write: the folder it writes into (relative to the repository) and the pattern
 * of its file name. Exactly one new or changed file must match after the step, or the step is BLOCKED: the runner never
 * guesses which file a producer meant.
 */
export type Collector = { name: string; dir: string; pattern: RegExp };

function collect(ctx: StageContext, collectors: readonly Collector[], before: readonly Snapshot[]): { ok: true; documents: JournalDocument[] } | { ok: false; code: string; detail: string } {
  const documents: JournalDocument[] = [];
  for (const [index, collector] of collectors.entries()) {
    const dir = join(ctx.root, collector.dir);
    const after = snapshot(dir);
    const fresh = [...after.entries()].filter(([name, stamp]) => collector.pattern.test(name) && before[index].get(name) !== stamp).map(([name]) => name).sort();
    if (fresh.length !== 1) {
      return { ok: false, code: fresh.length === 0 ? "EVIDENCE_DOCUMENT_NOT_FOUND" : "EVIDENCE_DOCUMENT_AMBIGUOUS",
        detail: "Expected one new " + collector.name + " in " + collector.dir + " and found " + (fresh.length === 0 ? "none" : fresh.length + " (" + fresh.slice(0, 3).join(", ") + ")") + "; the runner never guesses which file a producer meant." };
    }
    const path = join(dir, fresh[0]);
    documents.push({ name: collector.name, path: rel(ctx, path), sha256: sha256File(path) });
  }
  return { ok: true, documents };
}

export type ChildStep = {
  /** Arguments after `./alz`. */
  args: string[];
  io: "TERMINAL" | "LOGGED";
  logName?: string;
  readonlyProducer?: boolean;
  collectors?: readonly Collector[];
  /** The exit codes after which the collectors look for the producer's documents (default: 0 only). */
  collectOn?: readonly number[];
};

/** What a producer's exit code means. `./alz apply`: 0 done, 1 error (nothing spent), 2 refused before any action, 3 spent. */
export function outcomeOfExit(exitCode: number | null): { outcome: StepOutcome; code: string } {
  if (exitCode === 0) return { outcome: "PASS", code: "CHILD_PASSED" };
  if (exitCode === 2) return { outcome: "BLOCKED", code: "CHILD_REFUSED" };
  if (exitCode === 3) return { outcome: "FAIL", code: "CHILD_SPENT" };
  if (exitCode === null) return { outcome: "FAIL", code: "CHILD_INTERRUPTED" };
  return { outcome: "FAIL", code: "CHILD_FAILED" };
}

/**
 * Runs `./alz <args>` as a child with the governed environment (`child.ts`). A TERMINAL child shares the person's terminal on
 * all three streams: every prompt is the product's and is answered by the person; the runner writes nothing to the child.
 */
export async function runChild(ctx: StageContext, stage: StageId, request: ChildStep): Promise<StepResult> {
  const built = childEnvironment(ctx.env, { home: ctx.childHome, realHome: ctx.realHome, readonlyProducer: request.readonlyProducer });
  if (!built.ok) {
    return { outcome: "BLOCKED", code: "STATIC_SECRET_REFUSED",
      detail: "Unset " + built.refused.join(", ") + ": the runner forwards federated references (token files, role ARNs, ids), never a static secret, to any child." };
  }
  const collectors = request.collectors ?? [];
  const before = collectors.map((collector) => snapshot(join(ctx.root, collector.dir)));
  const io: ChildIo = request.io === "TERMINAL" ? { kind: "TERMINAL" }
    : { kind: "LOGGED", logFile: join(ctx.runDir, "logs", stageFolder(stage) + "." + (request.logName ?? request.args.slice(0, 2).join("-")) + "." + Date.now() + ".log") };
  ctx.out("  run      ./alz " + request.args.join(" ") + (request.io === "TERMINAL" ? "   (its prompts are answered by you)" : ""));
  const result = await ctx.spawn({ command: launcherOf(ctx.root), args: request.args, cwd: ctx.root, env: built.env, io });
  const exitCode = result.error ? null : result.exitCode;
  const exit = outcomeOfExit(exitCode);
  const logNote = io.kind === "LOGGED" ? " Log: " + rel(ctx, io.logFile) + "." : "";
  if (exit.outcome !== "PASS") {
    const kept = exitCode !== null && (request.collectOn ?? [0]).includes(exitCode) ? collect(ctx, collectors, before) : undefined;
    return { outcome: exit.outcome, code: exit.code, ...(exitCode !== null ? { exitCode } : {}), ...(kept?.ok ? { documents: kept.documents } : {}),
      detail: "./alz " + request.args.slice(0, 2).join(" ") + (result.error ? " could not start (" + result.error.slice(0, 120) + ")" : exitCode === null ? " was stopped (" + (result.signal ?? "signal") + ")" : " exited " + exitCode) + "." + logNote };
  }
  const found = collect(ctx, collectors, before);
  if (!found.ok) return { outcome: "BLOCKED", code: found.code, detail: found.detail + logNote, exitCode: 0 };
  return { outcome: "PASS", code: exit.code, exitCode: 0, documents: found.documents, detail: "./alz " + request.args.slice(0, 2).join(" ") + " passed." + logNote };
}

/** The documents a finished step recorded, by name. */
export function documentOf(ctx: StageContext, stage: StageId, stepName: string, name: string): JournalDocument | undefined {
  const record = ctx.journal.record(stage, stepName);
  return record.status === "FINISHED" ? record.documents.find((document) => document.name === name) : undefined;
}
