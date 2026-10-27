import { copyFileSync, constants as fsConstants, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";

import { loadReleaseScope } from "../release/status.js";
import type { SourceCommit } from "../util/source-commit.js";
import { EXAMPLE_CONFIG_PATH, insideRoot, loadConfig, type EvidenceRunnerConfig } from "./config.js";
import { gatePlan, type GatePlan, type GateRunnerMode } from "./gates.js";
import { Journal, JournalError, acquireRunLock, readJournal, stepRecord } from "./journal.js";
import { identityHash, ownerInputs, pinState, runPreflight, type IdentityProbe, type Preflight } from "./preflight.js";
import { BUILT_STAGES, DEFAULT_STAGES, EXIT, STAGES, STAGE_SLICE, type RunLabel, type StageId, type StepOutcome } from "./types.js";

/** The terminal the person types the start attestation into. The runner only asks; it never answers for them. */
export type Terminal = { stdinIsTTY: boolean; stdoutIsTTY: boolean; ask: (question: string) => Promise<string> };

export type RunnerDeps = {
  /** The repository root: configuration, pin and release scope are read from here, evidence written under it. */
  root: string;
  env: NodeJS.ProcessEnv;
  terminal: Terminal;
  host: string;
  now: () => Date;
  probe: IdentityProbe;
  source: () => SourceCommit;
  out: (line: string) => void;
  pidAlive?: (pid: number) => boolean;
};

export type RunOptions = { configPath: string; stage?: StageId; dryRun: boolean; synthetic: boolean };

/** Keys no document the runner writes may carry, at any depth: a credential has no place in evidence or a journal. */
const FORBIDDEN_KEY = /token|secret|password|passphrase|authorization|credential|profile|access_?key|session|private_?key|cookie/i;

export class EvidenceWriteError extends Error {
  readonly code = "EVIDENCE_FORBIDDEN_KEY";
}

function forbiddenKeys(value: unknown, path = ""): string[] {
  if (Array.isArray(value)) return value.flatMap((item, index) => forbiddenKeys(item, path + "[" + index + "]"));
  if (typeof value !== "object" || value === null) return [];
  return Object.entries(value).flatMap(([key, item]) => [...(FORBIDDEN_KEY.test(key) ? [path + "." + key] : []), ...forbiddenKeys(item, path + "." + key)]);
}

/**
 * Writes one runner document, mode 0600 in a 0700 folder. Refuses a document with a credential-shaped key. A SYNTHETIC
 * document is stamped `fixture: true` and `label: "SYNTHETIC"`, which the release admission review refuses as evidence.
 */
export function writeRunnerDocument(path: string, label: RunLabel | "UNLABELED", document: Record<string, unknown>): void {
  const stamped = { ...document, label, ...(label === "SYNTHETIC" ? { fixture: true } : {}) };
  const bad = forbiddenKeys(stamped);
  if (bad.length > 0) throw new EvidenceWriteError("Refused to write a document with credential-shaped keys: " + bad.join(", "));
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify(stamped, null, 2) + "\n", { mode: 0o600 });
}

/** Where one candidate's run lives. Synthetic runs never share a folder with live ones. */
export function runDirectory(root: string, config: EvidenceRunnerConfig, synthetic: boolean): string {
  const base = insideRoot(root, config.evidenceDir)!;
  return join(base, ...(synthetic ? ["synthetic"] : []), config.candidateCommit.slice(0, 12));
}

type StagePlan = { stage: StageId; outcome: StepOutcome; code: string; detail: string };

/** What each later stage will do in this build. Nothing here runs a provider tool or a child process. */
function planStage(stage: StageId, config: EvidenceRunnerConfig, pin: "EMPTY" | "PRESENT"): StagePlan {
  const notBuilt = (detail: string): StagePlan => ({ stage, outcome: "BLOCKED", code: "NOT_BUILT", detail: "Slice " + STAGE_SLICE[stage] + " builds this stage. " + detail });
  switch (stage) {
    case "preflight":
      return { stage, outcome: "PASS", code: "PREFLIGHT", detail: "Checked above." };
    case "aws-readonly":
      return config.aws ? notBuilt("It will verify the account, check the no-op stack read-only, and run the AWS provider qualification under the federated identity.")
        : { stage, outcome: "SKIPPED", code: "NOT_CONFIGURED", detail: "No aws block in the configuration." };
    case "azure-readonly":
      return config.azure ? notBuilt("It will verify the tenant and subscription and run the Azure provider qualification under the federated identity.")
        : { stage, outcome: "SKIPPED", code: "NOT_CONFIGURED", detail: "No azure block in the configuration." };
    case "gcp-readonly":
      return { stage, outcome: "SKIPPED", code: "GCP_HELD", detail: "GCP joins in slice S4, after the GCP lane's PLAN lands." };
    case "act":
    case "recovery":
    case "cleanup":
      return pin === "EMPTY"
        ? { stage, outcome: "SKIPPED", code: "SKIPPED_ACT_DISABLED", detail: "The pilot pin is empty: ACT is disabled." }
        : notBuilt("A person at this terminal will run each existing ./alz apply step and type every phrase.");
    case "summary":
      return notBuilt("It will index the evidence and run the release admission review.");
  }
}

const mark = (status: string): string => status === "PASS" ? "ok     " : status === "BLOCKED" ? "BLOCKED" : status === "FAIL" ? "FAIL   " : status === "SKIPPED" ? "skipped" : "info   ";

function printPreflight(out: (line: string) => void, preflight: Preflight): void {
  for (const check of [...preflight.checks, ...preflight.identities]) out("  " + mark(check.status) + "  " + check.id + ": " + check.code + " — " + check.detail);
  for (const input of preflight.ownerInputs) out("  " + (input.status === "BLOCKED" ? "OWNER  " : "info   ") + "  " + input.id + ": " + input.code + " — " + input.detail);
}

function gateCounts(plan: readonly GatePlan[]): string {
  const modes: GateRunnerMode[] = ["AUTO", "GUIDED", "OWNER", "NO_PRODUCER", "OUT_OF_SCOPE"];
  return modes.map((mode) => plan.filter((gate) => gate.mode === mode).length + " " + mode).join(", ");
}

function selectedStages(options: RunOptions): StageId[] {
  return options.stage ? (options.stage === "preflight" ? ["preflight"] : ["preflight", options.stage]) : [...DEFAULT_STAGES];
}

const LIVE_PHRASE = (config: EvidenceRunnerConfig) => "EVIDENCE LIVE " + config.targetHardwareId;

/** Asks the person to label the run. LIVE only from the exact typed phrase at an interactive terminal. */
async function attest(config: EvidenceRunnerConfig, options: RunOptions, deps: RunnerDeps): Promise<RunLabel | { refused: string }> {
  if (options.synthetic) return "SYNTHETIC";
  if (!deps.terminal.stdinIsTTY || !deps.terminal.stdoutIsTTY) {
    return { refused: "EVIDENCE_TERMINAL_REQUIRED: the start attestation is typed by a person at an interactive terminal. Run it there, or pass --synthetic." };
  }
  const answer = (await deps.terminal.ask("Type " + LIVE_PHRASE(config) + " to label this run LIVE, or SYNTHETIC: ")).trim();
  if (answer === LIVE_PHRASE(config)) return "LIVE";
  if (answer === "SYNTHETIC") return "SYNTHETIC";
  return { refused: "EVIDENCE_ATTESTATION_REFUSED: the answer was neither phrase, so nothing was labeled or written." };
}

/** `./alz evidence run`: preflight, then each selected stage, journaled. In this build every stage after preflight reports what will build it. */
export async function evidenceRun(options: RunOptions, deps: RunnerDeps): Promise<number> {
  const { out } = deps;
  const loaded = loadConfig(deps.root, options.configPath);
  if (!loaded.ok) {
    out("Evidence runner: the configuration was refused.");
    for (const problem of loaded.problems) out("  " + problem);
    return EXIT.BLOCKED;
  }
  const { config, sha256: configSha256 } = loaded;
  const outOfScope = new Set(loadReleaseScope(deps.root).outOfScope.map((entry) => entry.gate));
  const gates = gatePlan(outOfScope);
  out("Evidence runner — candidate " + config.candidateCommit.slice(0, 12) + " on " + config.targetHardwareId + (options.dryRun ? " (dry run)" : "") + ". ACT stays disabled.");
  out("Preflight");
  const preflight = await runPreflight({ root: deps.root, env: deps.env, config, source: deps.source(), probe: deps.probe });
  printPreflight(out, preflight);
  const stages = selectedStages(options).map((stage) => planStage(stage, config, preflight.pin));
  out("Gates: " + gateCounts(gates) + ".");

  if (options.dryRun) {
    const dir = runDirectory(deps.root, config, options.synthetic);
    const file = join(dir, "dry-run.json");
    writeRunnerDocument(file, options.synthetic ? "SYNTHETIC" : "UNLABELED", {
      schemaVersion: 1, kind: "EVIDENCE_RUNNER_DRY_RUN", evidence: false, candidateCommit: config.candidateCommit, configSha256,
      targetHardwareId: config.targetHardwareId, host: deps.host, at: deps.now().toISOString(), preflight, stages, gates,
    });
    out("Plan");
    for (const stage of stages.slice(1)) out("  " + mark(stage.outcome) + "  " + stage.stage + ": " + stage.code + " — " + stage.detail);
    out("Dry run: nothing ran and no evidence was written. Plan: " + relative(deps.root, file));
    return preflight.blocked || stages.some((stage) => stage.outcome === "BLOCKED") ? EXIT.BLOCKED : EXIT.OK;
  }
  if (preflight.blocked) {
    out("BLOCKED: preflight refused the run. Nothing was written. Fix the lines marked BLOCKED, then rerun.");
    return EXIT.BLOCKED;
  }
  const label = await attest(config, options, deps);
  if (typeof label !== "string") { out(label.refused); return EXIT.BLOCKED; }

  const dir = runDirectory(deps.root, config, label === "SYNTHETIC");
  let release: (() => void) | undefined;
  try {
    release = acquireRunLock(join(dir, "run.lock"), deps.pidAlive);
    const journal = new Journal(join(dir, "journal.jsonl"), {
      sourceCommit: config.candidateCommit, configSha256, targetHardwareId: config.targetHardwareId, label, host: deps.host, identityHash: identityHash(config),
    });
    const at = () => deps.now().toISOString();
    // Preflight runs every time: the identities and the pin are re-checked before any stage.
    journal.start("preflight", "preflight", at());
    writeRunnerDocument(join(dir, "preflight.json"), label, {
      schemaVersion: 1, kind: "EVIDENCE_RUNNER_PREFLIGHT", sourceCommit: config.candidateCommit, configSha256, targetHardwareId: config.targetHardwareId,
      host: deps.host, at: at(), checks: preflight.checks, identities: preflight.identities, ownerInputs: preflight.ownerInputs,
    });
    journal.finish("preflight", "preflight", "PASS", at());
    out("Stages (" + label + ")");
    let blocked = false;
    for (const stage of stages.slice(1)) {
      const previous = journal.record(stage.stage, stage.stage);
      if (previous.status === "FINISHED" && previous.outcome === "PASS") { out("  ok       " + stage.stage + ": already produced in this run, skipped."); continue; }
      journal.start(stage.stage, stage.stage, at());
      journal.finish(stage.stage, stage.stage, stage.outcome, at(), stage.code);
      out("  " + mark(stage.outcome) + "  " + stage.stage + ": " + stage.code + " — " + stage.detail);
      if (stage.outcome === "BLOCKED" || stage.outcome === "FAIL") blocked = true;
    }
    out((blocked ? "BLOCKED" : "DONE") + ": journal " + relative(deps.root, join(dir, "journal.jsonl")) + ". ./alz evidence status shows where the run stands.");
    return blocked ? EXIT.BLOCKED : EXIT.OK;
  } catch (error) {
    if (error instanceof JournalError || error instanceof EvidenceWriteError) { out(error.code + ": " + error.message); return EXIT.BLOCKED; }
    throw error;
  } finally {
    release?.();
  }
}

/** `./alz evidence status`: what the journal says, what comes next, and what only the owner can supply. Reads only. */
export async function evidenceStatus(options: Pick<RunOptions, "configPath" | "synthetic">, deps: RunnerDeps): Promise<number> {
  const { out } = deps;
  const loaded = loadConfig(deps.root, options.configPath);
  if (!loaded.ok) {
    out("Evidence runner: the configuration was refused.");
    for (const problem of loaded.problems) out("  " + problem);
    return EXIT.BLOCKED;
  }
  const { config } = loaded;
  const file = join(runDirectory(deps.root, config, options.synthetic), "journal.jsonl");
  let lines;
  try { lines = readJournal(file); } catch (error) {
    if (error instanceof JournalError) { out(error.code + ": " + error.message); return EXIT.BLOCKED; }
    throw error;
  }
  out("Evidence runner status — candidate " + config.candidateCommit.slice(0, 12) + (options.synthetic ? " (synthetic runs)" : "") + ".");
  if (lines.length === 0) out("  No run has been journaled yet. Start with ./alz evidence run --dry-run.");
  else out("  Journal: " + relative(deps.root, file) + " (" + lines[0].label + ", host " + lines[0].host + ").");
  let next: StageId | undefined;
  for (const stage of STAGES) {
    const record = stepRecord(lines, stage, stage);
    const text = record.status === "NOT_RUN" ? "not run" : record.status === "INTERRUPTED" ? "INTERRUPTED (started, never finished)" : record.outcome + (record.code ? " " + record.code : "");
    out("  " + stage.padEnd(15) + text);
    if (!next && DEFAULT_STAGES.includes(stage) && !(record.status === "FINISHED" && (record.outcome === "PASS" || record.outcome === "SKIPPED"))) next = stage;
  }
  out("  Next: " + (next ? next + " (slice " + STAGE_SLICE[next] + (BUILT_STAGES.has(next) ? ", built" : ", not built yet") + ")" : "nothing; every default stage is done"));
  out("Owner inputs");
  for (const input of ownerInputs(config, pinState(deps.root))) out("  " + input.code + " — " + input.detail);
  out("Gates");
  const outOfScope = new Set(loadReleaseScope(deps.root).outOfScope.map((entry) => entry.gate));
  for (const gate of gatePlan(outOfScope)) out("  " + gate.mode.padEnd(12) + " " + gate.id + (gate.slice ? " (" + gate.slice + ")" : "") + " — " + gate.note);
  return EXIT.OK;
}

/** `./alz evidence init`: copies the example configuration for the owner to fill in. Never overwrites. */
export function evidenceInit(options: Pick<RunOptions, "configPath">, deps: Pick<RunnerDeps, "root" | "out">): number {
  const target = insideRoot(deps.root, options.configPath);
  if (!target) { deps.out("--config: must be a file inside the repository."); return EXIT.BLOCKED; }
  const example = join(deps.root, EXAMPLE_CONFIG_PATH);
  if (!existsSync(example)) { deps.out(EXAMPLE_CONFIG_PATH + " is missing from this checkout."); return EXIT.ERROR; }
  try {
    copyFileSync(example, target, fsConstants.COPYFILE_EXCL);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      deps.out(relative(deps.root, target) + " already exists and was left as it is. Edit it, or remove it and run init again.");
      return EXIT.BLOCKED;
    }
    throw error;
  }
  deps.out("Wrote " + relative(deps.root, target) + ". Replace every REPLACE-WITH value with your own identifiers (no credentials), then run ./alz evidence run --dry-run.");
  return EXIT.OK;
}

