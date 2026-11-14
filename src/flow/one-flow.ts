import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import { evidencePath, loadConfig } from "../evidence-runner/config.js";
import { readJournal, stepRecord, type JournalLine, type StepRecord } from "../evidence-runner/journal.js";
import { contractEnablesPath, contractScope, killSwitchOn } from "../evidence-runner/preflight.js";
import type { StageId } from "../evidence-runner/types.js";
import { resolveSourceCommit, type SourceCommit } from "../util/source-commit.js";

/**
 * The one flow (docs/one-flow.md): the single ordered sequence every operator follows, whatever they type into. The terminal,
 * the browser console and the chat session are three ways into the same eight steps, with the same names, in the same order.
 * Each step has exactly one terminal command; the browser and the chat say what they do for that step, or say plainly that
 * the step is not theirs, so no surface invents a second journey.
 *
 * `readFlow` only reads: files under the checkout and `git rev-parse` / `git status` / `git cat-file`. It never calls a cloud or a
 * model, never runs a step, never writes, and never imports the apply path. A step it cannot judge from local files is not marked done.
 */
export type Surface = "terminal" | "browser" | "chat";
export const SURFACES: readonly Surface[] = ["terminal", "browser", "chat"];

export type StepId = "setup" | "rehearse" | "models" | "authorize" | "describe" | "change" | "cleanup" | "watch";
export type Who = "You" | "Owner" | "Maintainer";

export type FlowStep = {
  id: StepId;
  number: number;
  title: string;
  /** Who acts. In the first DEV run the owner and the requester are the same person (docs/act-pilot-plan.md). */
  who: Who;
  /** One sentence: what the step proves or produces. */
  purpose: string;
  /** Steps that must be DONE before this one can be the next step. */
  needs: readonly StepId[];
  /** The ACT path does not depend on it: a block here does not hold up the steps after it. */
  optional: boolean;
  /** Exactly one action per surface. A surface that does not do the step says so and names the surface that does. */
  actions: Readonly<Record<Surface, string>>;
};

export const SCENARIO = "terraform-aws-brownfield";
export const ACT_PATH = "aws-terraform";
const ACT_STAGE: StageId = `act:${ACT_PATH}`;
const CLEANUP_STAGE: StageId = `cleanup:${ACT_PATH}`;
const CONTRACT = "config/act-pilot-contract.json";
export const LZA_CARD = "config/aft-lza-card.json";
/** The LZA/AFT path rehearses both engines: LZA is CDK/CloudFormation, the AFT customizations are Terraform. */
export const LZA_ENGINE_SCENARIOS = ["cdk-aws-brownfield", "terraform-aws-brownfield"] as const;
const DRIFT_REPORT = ".runs/qualification/aft-lza-drift.json";
/** A drift report older than this is not evidence that the watch is running. The scheduled workflow runs every six hours. */
const DRIFT_REPORT_MAX_AGE_MS = 8 * 60 * 60 * 1000;
const TERMINAL_ONLY = "Not in the browser: run the terminal command. The console shows this step on its Flow card but never runs it.";
const CHAT_READS = "Ask “where am I in the flow?”; the session reads this step's state and names the command. It never runs the step.";

export const FLOW: readonly FlowStep[] = [
  {
    id: "setup", number: 1, title: "Set up this computer", who: "You", needs: [], optional: false,
    purpose: "Builds the runtime and the console from a clean, committed checkout.",
    actions: {
      terminal: "./alz bootstrap",
      browser: "Not in the browser: the console starts after this step. Run ./alz bootstrap, then ./alz workspace.",
      chat: "Not in the chat: the session starts after this step. Run ./alz bootstrap, then ./alz session aws terraform.",
    },
  },
  {
    id: "rehearse", number: 2, title: "Rehearse offline", who: "You", needs: ["setup"], optional: false,
    purpose: "Runs the AWS Terraform scenario on fixtures, direct and conversational, with no model and no AWS account.",
    actions: {
      terminal: "./alz matrix --offline-fixture --scenario " + SCENARIO,
      browser: "Flow → Rehearse offline.",
      chat: CHAT_READS,
    },
  },
  {
    id: "models", number: 3, title: "Turn on the private models", who: "You", needs: ["setup"], optional: true,
    purpose: "Pulls qwen3:1.7b, qwen3:4b and mistral-nemo:12b into Ollama, checks them against the committed digests, then rehearses with them.",
    actions: {
      terminal: "./alz models verify && ./alz matrix --live-models --scenario " + SCENARIO,
      browser: "Flow → Check private models again → Rehearse with private models.",
      chat: CHAT_READS,
    },
  },
  {
    id: "authorize", number: 4, title: "Authorize DEV", who: "Owner", needs: ["setup"], optional: false,
    purpose: "The owner bootstraps the DEV account (bootstrap/aws), fills in the pilot contract until it checks COMPLETE, and commits it with its authorize entry.",
    actions: {
      terminal: "./alz apply contract-check --file " + CONTRACT + "   (then the owner commits it; an agent never does)",
      browser: "Pilot apply → Set up AWS DEV checks the account read-only. The contract itself is written and committed by the owner, not in the browser.",
      chat: "Ask “am I ready to seal?”; the session reads the contract's state. It never writes or commits the contract.",
    },
  },
  {
    id: "describe", number: 5, title: "Describe the run", who: "You", needs: ["authorize"], optional: false,
    purpose: "Writes config/evidence-runner.json: the candidate commit, this host, the DEV account and the canary project, then dry-runs the change.",
    actions: {
      terminal: "./alz evidence init   (fill in your identifiers, then: ./alz evidence run --stage act:" + ACT_PATH + " --dry-run)",
      browser: TERMINAL_ONLY,
      chat: CHAT_READS,
    },
  },
  {
    id: "change", number: 6, title: "Make the change", who: "You", needs: ["rehearse", "authorize", "describe"], optional: false,
    purpose: "One guided terminal sequence: contract check, identities, prepare, qualify, preflight, seal, approve, apply, observe. You type every phrase and sign with your own key.",
    actions: {
      terminal: "./alz evidence run --stage act:" + ACT_PATH,
      browser: TERMINAL_ONLY + " (The Pilot apply wizard can apply a change, but it does not run qualify or write the live record, so it does not produce ACT evidence.)",
      chat: "Ask “show the preview” or “status of run <id>”; the session reads the records. It never seals, approves or applies.",
    },
  },
  {
    id: "cleanup", number: 7, title: "Clean up and record", who: "You", needs: ["change"], optional: false,
    purpose: "Proposes and approves the cleanup separately, removes the canary, verifies nothing remains, and writes the live record and lifecycle report.",
    actions: {
      terminal: "./alz evidence run --stage cleanup:" + ACT_PATH,
      browser: TERMINAL_ONLY,
      chat: "Ask “what is left over?”; the session reads the observed resources. It never cleans up.",
    },
  },
  {
    id: "watch", number: 8, title: "Watch for drift", who: "You", needs: ["setup"], optional: true,
    purpose: "Compares Control Tower, LZA and AFT with their baselines, read-only; the aft-lza-drift GitHub Actions workflow runs the same check every six hours.",
    actions: {
      terminal: "./alz qualify aft-lza-drift --card config/<card>.json --output " + DRIFT_REPORT,
      browser: TERMINAL_ONLY + " The scheduled run lives in GitHub Actions (.github/workflows/aft-lza-drift.yml).",
      chat: CHAT_READS,
    },
  },
];

const LZA_ACTIONS: Partial<Record<StepId, Readonly<Record<Surface, string>>>> = {
  rehearse: {
    terminal: "./alz matrix --offline-fixture --scenario cdk-aws-brownfield, then --scenario terraform-aws-brownfield (LZA is CDK/CloudFormation; the AFT customizations are Terraform).",
    browser: "Not in the browser for this path yet.",
    chat: CHAT_READS,
  },
  models: {
    terminal: "Not modelled for LZA/AFT yet. Optional; the Terraform path's models cover the AWS scenario.",
    browser: "Not in the browser for this path yet.",
    chat: CHAT_READS,
  },
  authorize: {
    terminal: "Owner: copy config/aft-lza-card.example.json to " + LZA_CARD + ", fill in every value (LZA side: CDK/CloudFormation; AFT customizations: Terraform), and commit it. An agent never fills it in or commits it.",
    browser: "Not in the browser: the card is written and committed by the owner.",
    chat: "Ask “am I ready to seal?”; the session reads the card's state. It never writes or commits the card.",
  },
  describe: {
    terminal: "./alz evidence init, with config.aws.aftLzaCard set to " + LZA_CARD + ". The run config is yours to fill in.",
    browser: TERMINAL_ONLY,
    chat: CHAT_READS,
  },
  change: {
    terminal: "Not runnable yet: no LZA/AFT change stage. ./alz evidence run --stage aws-aft-lza reads the pipelines and asks you for each merge commit; the runner merges nothing.",
    browser: TERMINAL_ONLY,
    chat: "Ask “show the preview” or “status of run <id>”; the session reads the records. It never seals, approves or applies.",
  },
  cleanup: {
    terminal: "Not runnable yet: no LZA/AFT cleanup stage.",
    browser: TERMINAL_ONLY,
    chat: "Ask “what is left over?”; the session reads the observed resources. It never cleans up.",
  },
};

/** The flow's steps for one path: the same eight steps, in the same order, with that path's operator actions. */
export function flowFor(path: FlowPath): readonly FlowStep[] {
  if (path === "terraform") return FLOW;
  return FLOW.map((step) => {
    const actions = LZA_ACTIONS[step.id];
    return actions ? { ...step, actions } : step;
  });
}

export type StepState = "DONE" | "NEXT" | "WAITING" | "BLOCKED";
export type StepStatus = { id: StepId; state: StepState; code: string; detail: string; who: Who };
export type FlowStatus = {
  schemaVersion: 1;
  kind: "ONE_FLOW_STATUS";
  path: FlowPath;
  sourceCommit: string;
  /** The first required step that is NEXT, else the first optional step that is NEXT, or null when nothing is NEXT. */
  next: StepId | null;
  steps: StepStatus[];
  /** Read from local files only: no cloud, no model, no step was run. */
  evidenceBasis: "LOCAL FILES ONLY — NO CLOUD, NO MODEL, NOTHING RUN";
};

/**
 * The operator's choice of path. `terraform`: the ACT pilot on aws-terraform (ACT stages in the runner). `lza-aft`: the LZA/AFT
 * integration (LZA creates the account from its config files, AFT customizes it afterwards). The runner has no LZA/AFT change
 * or cleanup stage yet, so on this path those steps say so instead of being judged done.
 */
export type FlowPath = "terraform" | "lza-aft";
export const FLOW_PATHS: readonly FlowPath[] = ["terraform", "lza-aft"];

type Judged = { state: "DONE" | "NEXT" | "BLOCKED"; code: string; detail: string; who?: Who };
/** `now` is epoch milliseconds; it defaults to the clock and exists so the drift-report age can be tested. */
export type FlowInputs = { root: string; env?: NodeJS.ProcessEnv; now?: number; path?: FlowPath };

function git(root: string, ...args: string[]): string | undefined {
  try {
    return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 10_000 }).trim();
  } catch { return undefined; }
}

function readJson(path: string): unknown {
  try { return JSON.parse(readFileSync(path, "utf8")) as unknown; } catch { return undefined; }
}

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

function judgeSetup(root: string, source: SourceCommit, head: string | undefined): Judged {
  if (!head) return { state: "NEXT", code: "NO_CHECKOUT", detail: "No readable git commit here. Clone the repository, then run ./alz bootstrap." };
  if (!source.ok) return { state: "NEXT", code: "CHECKOUT_NOT_CLEAN", detail: source.reason };
  const marker = record(readJson(join(root, "dist", ".alz-build-complete")));
  if (!marker) return { state: "NEXT", code: "NOT_BUILT", detail: "No finished build. Run ./alz bootstrap." };
  if (marker.sourceCommit !== head) {
    return { state: "NEXT", code: "BUILD_STALE", detail: "The build is from " + String(marker.sourceCommit).slice(0, 12) + ", the checkout is at " + head.slice(0, 12) + ". Run ./alz bootstrap." };
  }
  return { state: "DONE", code: "BUILT", detail: "Built from " + head.slice(0, 12) + "." };
}

/** The newest passing private-agent matrix for the AWS scenario in `mode`, if any (`.runs/qualification/private-agent-matrix`). */
function matrixPass(root: string, mode: "OFFLINE_FIXTURE" | "LIVE_PRIVATE_MODELS", scenario: string = SCENARIO): string | undefined {
  const dir = join(root, ".runs", "qualification", "private-agent-matrix");
  let names: string[];
  try { names = readdirSync(dir).filter((name) => /^matrix-[0-9a-f-]+\.json$/.test(name)); } catch { return undefined; }
  for (const name of names) {
    const report = record(readJson(join(dir, name)));
    if (!report || report.mode !== mode || report.passed !== true || !Array.isArray(report.results)) continue;
    const lane = report.results.map(record).find((item) => item?.id === scenario);
    if (lane?.converged === true && typeof report.sourceCommit === "string") return report.sourceCommit;
  }
  return undefined;
}

const NOT_MODELLED_LZA = "The runner has no offline rehearsal for the LZA/AFT path's models: only the offline matrix's engine scenarios exist.";

/** The LZA/AFT path: each engine's offline scenario must pass at this commit (LZA is CDK/CloudFormation, AFT is Terraform). */
function judgeRehearseLza(root: string, head: string | undefined): Judged {
  const missing = LZA_ENGINE_SCENARIOS.filter((scenario) => matrixPass(root, "OFFLINE_FIXTURE", scenario) !== head);
  if (missing.length > 0 || !head) {
    return {
      state: "NEXT", code: "NOT_REHEARSED",
      detail: "No passing offline rehearsal at this commit for " + missing.join(" and ") + ". Run ./alz matrix --offline-fixture --scenario <id> for each (LZA is CDK/CloudFormation; the AFT customizations are Terraform).",
    };
  }
  return { state: "DONE", code: "REHEARSED", detail: "Offline rehearsals passed at " + head.slice(0, 12) + " for both engines: " + LZA_ENGINE_SCENARIOS.join(" and ") + "." };
}

function judgeRehearse(root: string, head: string | undefined, path: FlowPath): Judged {
  if (path === "lza-aft") return judgeRehearseLza(root, head);
  const commit = matrixPass(root, "OFFLINE_FIXTURE");
  if (!commit) {
    return { state: "NEXT", code: "NOT_REHEARSED", detail: "No passing offline rehearsal for " + SCENARIO + " yet. Run ./alz matrix --offline-fixture --scenario " + SCENARIO + "." };
  }
  if (commit !== head) {
    return { state: "NEXT", code: "REHEARSAL_STALE", detail: "The last passing rehearsal is from " + commit.slice(0, 12) + ", not this checkout. Rerun it here." };
  }
  return { state: "DONE", code: "REHEARSED", detail: "Offline rehearsal passed at " + commit.slice(0, 12) + "." };
}

function judgeModels(root: string, head: string | undefined, path: FlowPath): Judged {
  if (path === "lza-aft") return { state: "BLOCKED", code: "NOT_MODELLED", detail: NOT_MODELLED_LZA };
  const commit = matrixPass(root, "LIVE_PRIVATE_MODELS");
  if (commit && commit === head) {
    return { state: "DONE", code: "MODELS_REHEARSED", detail: "Live private-model rehearsal passed at " + commit.slice(0, 12) + " (local models, no AWS)." };
  }
  return {
    state: "NEXT",
    code: "MODELS_NOT_CHECKED",
    detail: "Optional. Run ./alz models verify && ./alz matrix --live-models --scenario " + SCENARIO + " at this commit.",
  };
}

/** The owner's LZA/AFT card: committed, and with no REPLACE-WITH placeholders left. A shape check only; the run checks the rest. */
function judgeLzaCard(root: string): Judged {
  const committed = git(root, "cat-file", "-e", "HEAD:" + LZA_CARD) !== undefined;
  if (!committed) {
    return {
      state: "NEXT", code: "CARD_NOT_COMMITTED", who: "Owner",
      detail: "The owner copies config/aft-lza-card.example.json to " + LZA_CARD + ", fills in every value, and commits it. An agent never fills it in or commits it.",
    };
  }
  let text: string;
  try { text = readFileSync(join(root, LZA_CARD), "utf8"); } catch {
    return { state: "NEXT", code: "CARD_NOT_READABLE", detail: "The committed card could not be read.", who: "Owner" };
  }
  if (text.includes("REPLACE-WITH")) {
    return { state: "NEXT", code: "CARD_INCOMPLETE", who: "Owner", detail: "The committed card still has REPLACE-WITH placeholders. The owner fills in every value." };
  }
  return { state: "DONE", code: "CARD_COMMITTED", who: "Owner", detail: "The owner's LZA/AFT card is committed with no placeholders left. This is a shape check only." };
}

function judgeAuthorize(root: string, path: FlowPath): Judged {
  if (path === "lza-aft") return judgeLzaCard(root);
  const scope = contractScope(root);
  // A contract in the working tree only counts once it is committed: the owner's reviewed commit is the switch.
  const committed = git(root, "cat-file", "-e", "HEAD:" + CONTRACT) !== undefined;
  if (!committed) {
    return {
      state: "NEXT", code: "CONTRACT_NOT_COMMITTED", who: "Owner",
      detail: "The owner fills in " + CONTRACT + " until ./alz apply contract-check --file " + CONTRACT + " passes, then commits it. An agent never commits it.",
    };
  }
  const apply = contractEnablesPath(scope, ACT_PATH, "APPLY");
  if (!apply.ok) return { state: "NEXT", code: apply.code, detail: apply.detail, who: "Owner" };
  const cleanup = contractEnablesPath(scope, ACT_PATH, "CLEANUP");
  if (!cleanup.ok) return { state: "NEXT", code: cleanup.code, detail: cleanup.detail, who: "Owner" };
  if (killSwitchOn(root)) {
    return { state: "NEXT", code: "KILL_SWITCH_ON", detail: "The committed contract's kill switch is on, so ACT is stopped. The owner decides when it is lifted.", who: "Owner" };
  }
  return {
    state: "DONE", code: "AUTHORIZED", who: "Owner",
    detail: "The committed contract authorizes APPLY and CLEANUP for " + ACT_PATH + " in DEV. This is a shape check; ./alz apply contract-check is the full one.",
  };
}

function judgeDescribe(root: string, head: string | undefined, path: FlowPath): Judged {
  const loaded = loadConfig(root);
  if (!loaded.ok) return { state: "NEXT", code: "NOT_DESCRIBED", detail: loaded.problems.join(" ") };
  if (path === "lza-aft" && loaded.config.aws?.aftLzaCard !== LZA_CARD) {
    return { state: "NEXT", code: "CARD_NOT_NAMED", detail: "Set config.aws.aftLzaCard to " + LZA_CARD + " in the run config, then rerun ./alz evidence init." };
  }
  if (!head || loaded.config.candidateCommit !== head) {
    return {
      state: "NEXT", code: "CANDIDATE_MISMATCH",
      detail: "The run config names candidate " + loaded.config.candidateCommit.slice(0, 12) + ", the checkout is at " + (head ?? "no commit").slice(0, 12) + ". Run ./alz evidence init at this commit.",
    };
  }
  return { state: "DONE", code: "DESCRIBED", detail: "The run config names this commit, " + head.slice(0, 12) + ", and this host." };
}

type RunJournal = { ok: true; lines: JournalLine[]; path: string } | { ok: false; code: string; detail: string; blocked: boolean };

/** The run journal for the candidate in config/evidence-runner.json. Read only; a missing journal is an empty one. */
function runJournal(root: string): RunJournal {
  const loaded = loadConfig(root);
  if (!loaded.ok) return { ok: false, code: "NOT_DESCRIBED", detail: loaded.problems.join(" "), blocked: false };
  let path: string;
  try {
    path = evidencePath(root, loaded.config.evidenceDir, loaded.config.candidateCommit.slice(0, 12), "journal.jsonl");
  } catch (error) {
    return { ok: false, code: "JOURNAL_PATH", detail: error instanceof Error ? error.message : "The journal path is not usable.", blocked: true };
  }
  try {
    return { ok: true, lines: readJournal(path), path };
  } catch (error) {
    return { ok: false, code: "JOURNAL_UNREADABLE", detail: error instanceof Error ? error.message : "The journal could not be read.", blocked: true };
  }
}

/** Judges one run stage from its journal: DONE only when its last finish is a PASS. */
function judgeStage(root: string, stage: StageId, done: { code: string; detail: string }, missing: { code: string; detail: string }): Judged {
  const journal = runJournal(root);
  if (!journal.ok) return { state: journal.blocked ? "BLOCKED" : "NEXT", code: journal.code, detail: journal.detail };
  const where = relative(root, journal.path);
  const live = journal.lines.filter((line) => line.label === "LIVE");
  const unlabelled = journal.lines.some((line) => line.stage === stage && line.label !== "LIVE");
  if (unlabelled && !live.some((line) => line.stage === stage)) {
    return {
      state: "BLOCKED", code: "JOURNAL_LABEL_MISMATCH",
      detail: "The journal at " + where + " has no record for this stage that counts. Read it, then rerun the stage.",
    };
  }
  const rec: StepRecord = stepRecord(live, stage, stage);
  if (rec.status === "FINISHED" && rec.outcome === "PASS") return { state: "DONE", ...done };
  if (rec.status === "FINISHED") {
    const reason = rec.code ? " (" + rec.code + ")" : "";
    return {
      state: "BLOCKED", code: "LAST_RUN_" + rec.outcome + (rec.code ? ":" + rec.code : ""),
      detail: "The last run of " + stage + " ended " + rec.outcome + reason + ". Read its journal at " + where + " before rerunning it.",
    };
  }
  if (rec.status === "INTERRUPTED") {
    return {
      state: "BLOCKED", code: "INTERRUPTED",
      detail: "A run of " + stage + " stopped mid-step. Its journal at " + where + " is the record; rerun the stage to continue it.",
    };
  }
  return { state: "NEXT", ...missing };
}

const AFT_LZA_STAGE: StageId = "aws-aft-lza";
const NO_LZA_CLEANUP = "The runner has no LZA/AFT cleanup stage: removing the AFT registration and then the LZA account entry is not modelled. The pilot keeps the account (disposition RETAIN, docs/aft-lza-act-workflow.md).";

function judgeChange(root: string, path: FlowPath): Judged {
  if (path === "lza-aft") {
    return judgeStage(
      root, AFT_LZA_STAGE,
      { code: "VERIFIED", detail: "The aws-aft-lza stage ran live and the journal records it PASS: LZA created the account, AFT registered it, its customizations ran and the controls were verified." },
      { code: "NOT_RUN", detail: "No live aws-aft-lza run recorded yet. Run ./alz evidence run --stage " + AFT_LZA_STAGE + "; you merge each change and type its merge commit." },
    );
  }
  return judgeStage(
    root, ACT_STAGE,
    { code: "APPLIED", detail: "The DEV apply ran and was observed; the journal records it PASS. Cleanup is the next step." },
    { code: "NOT_APPLIED", detail: "No DEV apply recorded yet. Run ./alz evidence run --stage " + ACT_STAGE + "; you type every phrase." },
  );
}

function judgeCleanup(root: string, path: FlowPath): Judged {
  if (path === "lza-aft") return { state: "BLOCKED", code: "NO_LZA_CLEANUP_STAGE", detail: NO_LZA_CLEANUP };
  return judgeStage(
    root, CLEANUP_STAGE,
    { code: "CLEANED", detail: "The cleanup ran and the journal records it PASS: the canary is removed and the live record is written." },
    { code: "NOT_CLEANED", detail: "Cleanup is not recorded yet. Run ./alz evidence run --stage " + CLEANUP_STAGE + "." },
  );
}

function judgeWatch(root: string, now: number): Judged {
  const path = join(root, DRIFT_REPORT);
  const run = "./alz qualify aft-lza-drift --card config/<card>.json --output " + DRIFT_REPORT;
  if (!existsSync(path)) {
    return { state: "NEXT", code: "NO_DRIFT_REPORT", detail: "No local drift report yet. Run " + run + ". The GitHub Actions schedule is not visible from local files." };
  }
  const ageMs = now - statSync(path).mtimeMs;
  if (ageMs > DRIFT_REPORT_MAX_AGE_MS) {
    return { state: "NEXT", code: "DRIFT_REPORT_STALE", detail: "The local drift report is " + Math.floor(ageMs / 3_600_000) + " hours old. Run " + run + " again." };
  }
  return {
    state: "DONE", code: "DRIFT_REPORT_FRESH",
    detail: "A local drift report from the last 8 hours exists. It does not show that the scheduled GitHub Actions run passed.",
  };
}

export function readFlow(input: FlowInputs): FlowStatus {
  const root = input.root;
  const path: FlowPath = input.path ?? "terraform";
  const now = input.now ?? Date.now();
  const head = git(root, "rev-parse", "--verify", "HEAD^{commit}");
  const source = resolveSourceCommit(root, input.env ?? process.env, [CONTRACT]);

  const judged: Record<StepId, Judged> = {
    setup: judgeSetup(root, source, head),
    rehearse: judgeRehearse(root, head, path),
    models: judgeModels(root, head, path),
    authorize: judgeAuthorize(root, path),
    describe: judgeDescribe(root, head, path),
    change: judgeChange(root, path),
    cleanup: judgeCleanup(root, path),
    watch: judgeWatch(root, now),
  };

  const done = new Set<StepId>();
  const steps: StepStatus[] = FLOW.map((step) => {
    const j = judged[step.id];
    const who = j.who ?? step.who;
    if (j.state === "DONE") {
      done.add(step.id);
      return { id: step.id, state: "DONE", code: j.code, detail: j.detail, who };
    }
    const unmet = step.needs.filter((need) => !done.has(need));
    // A recorded block is shown even while an earlier step is open: it is the fact the operator must act on.
    if (unmet.length > 0 && j.state !== "BLOCKED") {
      const titles = unmet.map((need) => FLOW.find((item) => item.id === need)?.title ?? need).join(", ");
      return { id: step.id, state: "WAITING", code: "WAITING_FOR_" + unmet.join("_").toUpperCase(), detail: "Waiting for: " + titles + ".", who: step.who };
    }
    return { id: step.id, state: j.state, code: j.code, detail: j.detail, who };
  });

  const optional = new Set(FLOW.filter((step) => step.optional).map((step) => step.id));
  const next =
    steps.find((s) => s.state === "NEXT" && !optional.has(s.id))?.id ??
    steps.find((s) => s.state === "NEXT")?.id ??
    null;

  return {
    schemaVersion: 1,
    kind: "ONE_FLOW_STATUS",
    path,
    sourceCommit: source.ok ? source.commit : (head ?? "NONE"),
    next,
    steps,
    evidenceBasis: "LOCAL FILES ONLY — NO CLOUD, NO MODEL, NOTHING RUN",
  };
}
