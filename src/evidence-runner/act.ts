import { lstatSync, readFileSync, renameSync } from "node:fs";
import { basename, join, resolve } from "node:path";

import { insideRoot } from "./config.js";
import type { JournalDocument } from "./journal.js";
import { contractEnablesPath, contractScope } from "./preflight.js";
import type { StageResult } from "./readonly.js";
import { CONTRACT_PATH } from "./source.js";
import { assertRealFolder, ensureRealFolder } from "./safe-write.js";
import { documentOf, freshStep, runChild, sha256File, stageFolder, step, type Collector, type StageContext, type StepResult } from "./steps.js";
import { ACT_PATH_NOT_AVAILABLE, type ActPathId, type StageId } from "./types.js";

/**
 * The guided stages S5 (docs/evidence-runner.md, "The owner run sheet"). The runner sequences the existing `./alz apply`
 * commands in the documented order (docs/act-pilot-apply.md, docs/act-dev-enablement.md), each as a child that shares the
 * person's terminal: every prompt, typed phrase, target confirmation and attestation is the product's own and is answered by
 * the person. The runner writes nothing to a child, passes no flag that forces, skips or pre-answers anything (there is
 * none), captures each exit code and the documents each producer wrote, journals them, and stops at the first step that does
 * not pass. A step that can change the account, consume approvals or write a one-time record is never started twice.
 *
 * `act:<path>`: contract-check, identity-check --phase delivered, prepare, qualify, preflight, seal, approve, apply, observe.
 * `cleanup:<path>`: contract-check, identity-check, preflight, observe, propose-cleanup, approve (cleanup), cleanup, verify-cleanup,
 * report, record-live. The live record
 * comes last because it is written into config/acceptance/evidence, which would make the checkout dirty for every later step;
 * the runner moves it, byte for byte, into the stage's folder under .runs/evidence so the checkout stays clean.
 * `recovery`: record-recovery for an interrupted and a resumed sealed plan the person names.
 *
 * Gates the runner checks before the first child (each child checks them again in full): an interactive terminal, the path is
 * available, the committed contract enables this path's provider and engine and authorizes the operation in DEV, and the
 * configuration names the path's project and requester.
 */
const ENV = "DEV";

/** Where each `./alz apply` producer writes (src/apply defaults, docs/act-pilot-apply.md). */
const WRITES = {
  identity: (path: ActPathId): Collector => ({ name: "identity-delivery", dir: ".runs/apply/identity-delivery", pattern: new RegExp("^delivered-" + path + "-.+\\.json$") }),
  request: { name: "request", dir: ".runs/pilot/" + ENV, pattern: /^request-[0-9a-f]{16}\.json$/ } as Collector,
  manifest: { name: "manifest", dir: ".runs/pilot/" + ENV, pattern: /^manifest-[0-9a-f]{16}\.json$/ } as Collector,
  reviewBundle: { name: "review-bundle", dir: ".runs/apply/evidence", pattern: /\.review\.json$/ } as Collector,
  proposal: { name: "cleanup-proposal", dir: ".runs/apply/cleanup", pattern: /^[0-9a-f]{12}\.cleanup-proposal\.json$/ } as Collector,
  report: { name: "lifecycle-report", dir: ".runs/apply/reports", pattern: /^[0-9a-f]{12}-lifecycle(-[0-9a-f]{12})?\.json$/ } as Collector,
  liveRecord: { name: "live-record", dir: "config/acceptance/evidence", pattern: /-execute-dev-[0-9a-f]{12}\.json$/ } as Collector,
  recovery: { name: "recovery-record", dir: ".runs/release/preview", pattern: /^act-run-recovery-[0-9a-f]{12}\.json$/ } as Collector,
};

const blocked = (code: string, detail: string): StageResult => ({ outcome: "BLOCKED", code, detail });
const stop = (result: StepResult): StageResult => ({ outcome: result.outcome, code: result.code ?? "STEP", detail: result.detail, documents: result.documents });

function terminalGate(ctx: StageContext): StageResult | undefined {
  if (!ctx.terminal.stdinIsTTY || !ctx.terminal.stdoutIsTTY) {
    return blocked("EVIDENCE_TERMINAL_REQUIRED", "A guided stage runs ./alz apply at your terminal, where you answer every prompt yourself. Run it in an interactive terminal.");
  }
  return undefined;
}

function pathGates(ctx: StageContext, path: ActPathId, operation: "APPLY" | "CLEANUP"): StageResult | undefined {
  const notAvailable = ACT_PATH_NOT_AVAILABLE[path];
  if (notAvailable) return blocked("NOT_AVAILABLE", notAvailable);
  const enabled = contractEnablesPath(contractScope(ctx.root), path, operation);
  if (!enabled.ok) return blocked(enabled.code, enabled.detail);
  if (!ctx.config.act?.paths[path]) {
    return blocked("OWNER_INPUT_ACT_TARGETS", "The configuration has no act.paths." + path + " (project folder and requester id); add it with your own identifiers.");
  }
  return terminalGate(ctx);
}

/** Asks for a file the person names (a key file stays where it is; only its path is passed on, never stored or journaled). */
async function askFile(ctx: StageContext, question: string): Promise<string | undefined> {
  const answer = (await ctx.terminal.ask(question)).trim();
  if (answer === "") return undefined;
  const full = resolve(answer);
  try {
    const stat = lstatSync(full);
    return stat.isFile() && !stat.isSymbolicLink() ? full : undefined;
  } catch { return undefined; }
}

/**
 * One guided step. `ask` names the files the person must point to before it starts; it is asked only when the step will
 * really run, before its journal `start`, so an empty answer leaves the step unstarted (and a no-repeat step repeatable).
 * A `fresh` step is a read-only gate (contract-check, identity-check, preflight): it runs again on every invocation of the
 * stage, never reused from an earlier one, so a resumed stage is gated on the contract, tokens and readiness of now
 * (review N3 on #349).
 */
type GuidedStep = { name: string; once?: boolean; fresh?: boolean; ask?: readonly string[]; run: (files: string[]) => Promise<StepResult> };

async function runSteps(ctx: StageContext, stage: StageId, steps: readonly GuidedStep[]): Promise<StepResult | undefined> {
  for (const item of steps) {
    const record = ctx.journal.record(stage, item.name);
    const willRun = record.status === "NOT_RUN" || (!item.once && !(record.status === "FINISHED" && record.outcome === "PASS"));
    const files: string[] = [];
    if (willRun) {
      for (const question of item.ask ?? []) {
        const file = await askFile(ctx, "  " + question + " (its path is passed to ./alz apply, never stored): ");
        if (!file) return { outcome: "BLOCKED", code: "EVIDENCE_FILE_REQUIRED", detail: "No readable file was named for: " + question + ". The step " + item.name + " did not start." };
        files.push(file);
      }
    }
    const result = item.fresh ? await freshStep(ctx, stage, item.name, () => item.run(files)) : await step(ctx, stage, item.name, { once: item.once }, () => item.run(files));
    if (result.outcome !== "PASS") return result;
  }
  return undefined;
}

/**
 * Asks for the approval files the approvers saved. `./alz apply approve` prints a signed approval (no secret) at the terminal;
 * the person saves it under .runs/ (git-ignored, so the checkout stays clean) and names the files here.
 */
async function askApprovals(ctx: StageContext, what: string): Promise<{ ok: true; documents: JournalDocument[] } | { ok: false; detail: string }> {
  ctx.out("  Save each signed " + what + " approval printed by ./alz apply approve as a file under .runs/ (for example .runs/approvals/" + what + "-1.json).");
  const documents: JournalDocument[] = [];
  for (let index = 1; index <= 8; index += 1) {
    const answer = (await ctx.terminal.ask("  " + what + " approval file " + index + " (empty when done): ")).trim();
    if (answer === "") break;
    const full = insideRoot(ctx.root, answer);
    const relative = full ? full.slice(ctx.root.length + 1).split("\\").join("/") : "";
    if (!full || !relative.startsWith(".runs/")) return { ok: false, detail: answer.slice(0, 80) + " is not a file under .runs/ in this repository." };
    try {
      const stat = lstatSync(full);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024) return { ok: false, detail: relative + " is not a plain file of at most 64 KiB." };
      const parsed = JSON.parse(readFileSync(full, "utf8")) as unknown;
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return { ok: false, detail: relative + " is not a JSON object." };
    } catch { return { ok: false, detail: relative + " is missing or not JSON." }; }
    documents.push({ name: "approval-" + index, path: relative, sha256: sha256File(full) });
  }
  if (documents.length === 0) return { ok: false, detail: "No approval file was named; the apply needs the contract's required approvals." };
  return { ok: true, documents };
}

const documentPath = (ctx: StageContext, stage: StageId, stepName: string, name: string): string | undefined => documentOf(ctx, stage, stepName, name)?.path;

/** `act:<path>`: from the contract check to the observation of what the apply created. */
export async function actStage(ctx: StageContext, path: ActPathId): Promise<StageResult> {
  const stage: StageId = `act:${path}`;
  const gate = pathGates(ctx, path, "APPLY");
  if (gate) return gate;
  const target = ctx.config.act!.paths[path]!;
  const steps: GuidedStep[] = [
    { name: "contract-check", fresh: true, run: () => runChild(ctx, stage, { args: ["apply", "contract-check", "--file", CONTRACT_PATH], io: "TERMINAL" }) },
    { name: "identity-check", fresh: true, run: () => runChild(ctx, stage, { args: ["apply", "identity-check", "--path", path, "--repository", ctx.config.act!.repository, "--phase", "delivered"], io: "TERMINAL", collectors: [WRITES.identity(path)] }) },
    { name: "prepare", run: () => runChild(ctx, stage, { args: ["apply", "prepare", "--environment", ENV, "--project", target.project], io: "TERMINAL", collectors: [WRITES.request, WRITES.manifest] }) },
    { name: "qualify", run: () => runChild(ctx, stage, { args: ["apply", "qualify", ...requestArgs(ctx, stage)], io: "TERMINAL" }) },
    { name: "preflight", fresh: true, run: () => runChild(ctx, stage, { args: ["apply", "preflight", "--environment", ENV, "--contract", CONTRACT_PATH], io: "TERMINAL" }) },
    {
      name: "seal", once: true, ask: ["Requester key file for " + target.requesterId], run: async ([key]) => {
        const sealed = await runChild(ctx, stage, { args: ["apply", "seal", ...requestArgs(ctx, stage), "--requester", target.requesterId, "--key", key], io: "TERMINAL", collectors: [WRITES.reviewBundle] });
        if (sealed.outcome !== "PASS") return sealed;
        const bundle = sealed.documents![0];
        const plan = bundle.path.slice(0, -".review.json".length);
        try { return { ...sealed, documents: [bundle, { name: "sealed-plan", path: plan, sha256: sha256File(join(ctx.root, plan)) }] }; } catch {
          return { outcome: "BLOCKED", code: "EVIDENCE_DOCUMENT_NOT_FOUND", exitCode: 0, documents: [bundle], detail: "The review bundle has no sealed plan beside it (" + plan + ")." };
        }
      },
    },
    { name: "approve", run: () => approveStep(ctx, stage, target.approverId, documentPath(ctx, stage, "seal", "review-bundle")!, "apply") },
    {
      name: "apply", once: true, run: () => runChild(ctx, stage, {
        args: ["apply", "apply", ...requestArgs(ctx, stage), "--sealed", documentPath(ctx, stage, "seal", "sealed-plan")!, ...approvalArgs(ctx, stage, "approve")], io: "TERMINAL",
      }),
    },
    { name: "observe", run: () => runChild(ctx, stage, { args: ["apply", "observe", "--sealed", documentPath(ctx, stage, "seal", "sealed-plan")!], io: "TERMINAL" }) },
  ];
  const failed = await runSteps(ctx, stage, steps);
  if (failed) return stop(failed);
  return { outcome: "PASS", code: "APPLIED_AND_OBSERVED",
    detail: "The DEV apply ran and was observed. What it created stays until you run --stage cleanup:" + path + ", which also records the live acceptance (record-live) last." };
}

function requestArgs(ctx: StageContext, stage: StageId): string[] {
  const source: StageId = stage.startsWith("cleanup:") ? `act:${stage.slice("cleanup:".length) as ActPathId}` : stage;
  return ["--request", documentPath(ctx, source, "prepare", "request")!, "--manifest", documentPath(ctx, source, "prepare", "manifest")!];
}

function approvalArgs(ctx: StageContext, stage: StageId, stepName: string): string[] {
  const record = ctx.journal.record(stage, stepName);
  if (record.status !== "FINISHED") return [];
  return record.documents.filter((document) => document.name.startsWith("approval-")).flatMap((document) => ["--approval", document.path]);
}

/**
 * The approval step: when the configuration names an approver who approves at this terminal, `./alz apply approve` runs here
 * (the approver types the APPROVE phrase); then the person names the saved approval files. Approvers on other machines run
 * the same command there and send the file.
 */
async function approveStep(ctx: StageContext, stage: StageId, approverId: string | undefined, bundle: string, what: "apply" | "cleanup"): Promise<StepResult> {
  if (approverId) {
    const key = await askFile(ctx, "  Approver key file for " + approverId + " (its path is passed to ./alz apply approve, never stored), or empty if the approvers sign elsewhere: ");
    if (key) {
      const signed = await runChild(ctx, stage, { args: ["apply", "approve", "--bundle", bundle, "--key", key, "--approver", approverId], io: "TERMINAL" });
      if (signed.outcome !== "PASS") return signed;
    }
  } else {
    ctx.out("  Each approver runs: ./alz apply approve --bundle " + bundle + " --key <their key> --approver <their id>");
  }
  const approvals = await askApprovals(ctx, what);
  if (!approvals.ok) return { outcome: "BLOCKED", code: "EVIDENCE_APPROVAL_REQUIRED", detail: approvals.detail };
  return { outcome: "PASS", code: "APPROVALS_NAMED", detail: approvals.documents.length + " approval file(s) named.", documents: approvals.documents };
}

/** `cleanup:<path>`: the cleanup of what `act:<path>` created, its verification, the lifecycle report and the live record. */
export async function cleanupStage(ctx: StageContext, path: ActPathId): Promise<StageResult> {
  const stage: StageId = `cleanup:${path}`;
  const actStageId: StageId = `act:${path}`;
  const gate = pathGates(ctx, path, "CLEANUP");
  if (gate) return gate;
  const done = ctx.journal.record(actStageId, actStageId);
  if (done.status !== "FINISHED" || done.outcome !== "PASS") {
    return blocked("ACT_STAGE_NOT_DONE", "Run --stage act:" + path + " to the end first: the cleanup works on the sealed plan, request and manifest that stage recorded.");
  }
  const target = ctx.config.act!.paths[path]!;
  const sealed = documentPath(ctx, actStageId, "seal", "sealed-plan")!;
  const proposal = () => documentPath(ctx, stage, "propose-cleanup", "cleanup-proposal")!;
  const steps: GuidedStep[] = [
    // The same read-only gates as the act stage, again now: the contract, the delivered identities and readiness.
    { name: "contract-check", fresh: true, run: () => runChild(ctx, stage, { args: ["apply", "contract-check", "--file", CONTRACT_PATH], io: "TERMINAL" }) },
    { name: "identity-check", fresh: true, run: () => runChild(ctx, stage, { args: ["apply", "identity-check", "--path", path, "--repository", ctx.config.act!.repository, "--phase", "delivered"], io: "TERMINAL", collectors: [WRITES.identity(path)] }) },
    { name: "preflight", fresh: true, run: () => runChild(ctx, stage, { args: ["apply", "preflight", "--environment", ENV, "--contract", CONTRACT_PATH], io: "TERMINAL" }) },
    { name: "observe", run: () => runChild(ctx, stage, { args: ["apply", "observe", "--sealed", sealed], io: "TERMINAL" }) },
    {
      name: "propose-cleanup", ask: ["Cleanup requester key file for " + target.requesterId],
      run: ([key]) => runChild(ctx, stage, { args: ["apply", "propose-cleanup", "--sealed", sealed, "--requester", target.requesterId, "--key", key], io: "TERMINAL", collectors: [WRITES.proposal] }),
    },
    { name: "approve-cleanup", run: () => approveStep(ctx, stage, target.approverId, proposal(), "cleanup") },
    {
      name: "cleanup", once: true, run: () => runChild(ctx, stage, {
        args: ["apply", "cleanup", "--proposal", proposal(), ...requestArgs(ctx, stage), "--sealed", sealed, ...approvalArgs(ctx, stage, "approve-cleanup")], io: "TERMINAL",
      }),
    },
    { name: "verify-cleanup", run: () => runChild(ctx, stage, { args: ["apply", "verify-cleanup", "--proposal", proposal()], io: "TERMINAL" }) },
    { name: "report", run: () => runChild(ctx, stage, { args: ["apply", "report", "--sealed", sealed, "--proposal", proposal()], io: "TERMINAL", collectors: [WRITES.report] }) },
    { name: "record-live", once: true, run: async () => keepLiveRecord(ctx, stage, await runChild(ctx, stage, { args: ["apply", "record-live", "--sealed", sealed], io: "TERMINAL", collectors: [WRITES.liveRecord] })) },
  ];
  const failed = await runSteps(ctx, stage, steps);
  if (failed) return stop(failed);
  return { outcome: "PASS", code: "CLEANED_AND_RECORDED", detail: "Cleanup ran and was verified, the lifecycle report was written, and the live record is kept with this run." };
}

/**
 * `record-live` writes into config/acceptance/evidence, which makes the checkout dirty for the summary and every later step.
 * The runner moves the record, unchanged, into this stage's folder, checks its hash is the same, and journals the new place.
 * The owner commits a copy and cites it in config/acceptance/journeys.json as before (docs/act-pilot-apply.md).
 */
function keepLiveRecord(ctx: StageContext, stage: StageId, result: StepResult): StepResult {
  if (result.outcome !== "PASS" || !result.documents?.[0]) return result;
  const written = result.documents[0];
  const dir = join(ctx.runDir, stageFolder(stage));
  ensureRealFolder(dir);
  const destination = join(dir, basename(written.path));
  try {
    lstatSync(destination);
    return { ...result, outcome: "BLOCKED", code: "EVIDENCE_DOCUMENT_EXISTS", detail: destination + " already exists; the live record at " + written.path + " was left where it is." };
  } catch { /* free */ }
  assertRealFolder(dir);
  renameSync(join(ctx.root, written.path), destination);
  const moved = { name: written.name, path: ctx.runDirRel + "/" + stageFolder(stage) + "/" + basename(written.path), sha256: sha256File(destination) };
  if (moved.sha256 !== written.sha256) return { ...result, outcome: "FAIL", code: "EVIDENCE_DOCUMENT_CHANGED", documents: [moved], detail: "The live record changed while it was moved." };
  ctx.out("  kept     " + written.path + " moved unchanged to " + moved.path + " (sha256 " + moved.sha256.slice(0, 12) + "); commit a copy and cite it in config/acceptance/journeys.json as before.");
  return { ...result, documents: [moved] };
}

/** `recovery`: the act-run-recovery record for an interrupted plan and the plan that resumed it under new approvals. */
export async function recoveryStage(ctx: StageContext): Promise<StageResult> {
  const stage: StageId = "recovery";
  if (contractScope(ctx.root).state === "EMPTY") return blocked("ACT_DISABLED", "No committed contract authorizes ACT; a recovery record exists only for a real pilot apply.");
  const terminal = terminalGate(ctx);
  if (terminal) return terminal;
  const failed = await runSteps(ctx, stage, [{
    name: "record-recovery", once: true, ask: ["Sealed plan of the interrupted apply", "Sealed plan of the apply that followed it under new approvals"],
    run: ([interrupted, resumed]) => runChild(ctx, stage, {
      args: ["apply", "record-recovery", "--sealed", interrupted, "--resumed", resumed, "--target-hardware-id", ctx.config.targetHardwareId], io: "TERMINAL", collectors: [WRITES.recovery],
    }),
  }]);
  if (failed) return stop(failed);
  const record = ctx.journal.record(stage, "record-recovery");
  return { outcome: "PASS", code: "RECOVERY_RECORDED", detail: "./alz apply record-recovery wrote the act-run-recovery evidence.", documents: record.status === "FINISHED" ? record.documents : [] };
}
