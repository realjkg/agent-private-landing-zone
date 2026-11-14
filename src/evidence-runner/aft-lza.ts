import { execFile } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { AwsCliReader, type AwsExec } from "../aft-lza/aws-reader.js";
import { OperationStore } from "../aft-lza/operation-store.js";
import { advance, recordMerge, type AftLzaReader } from "../aft-lza/run.js";
import { validateCard, type AftLzaCard } from "../aft-lza/workflow.js";
import { childEnvironment } from "./child.js";
import { ensureRealFolder } from "./safe-write.js";
import { sha256File, stageFolder, step, type StageContext } from "./steps.js";
import type { StageResult } from "./readonly.js";

/**
 * Stage `aws-aft-lza` (docs/aft-lza-act-workflow.md): the AFT/LZA pilot, run only when named with `--stage aws-aft-lza`.
 *
 * Each run reads where the pilot stands (pipelines, account identity, controls) under the federated DISCOVERY identity, decides
 * the next step, and writes one decision document. When the next step is a write (merging the approved LZA change, then the AFT
 * request), the runner journals the intent and asks the person at the terminal for the merge commit after they have done it.
 * The runner itself never merges, starts a pipeline or invokes a Step Function. The operation journal lives under the evidence
 * folder, outside the run folder, so the next run resumes it instead of offering a write again.
 */
export const AFT_LZA_STAGE = "aws-aft-lza" as const;

export const awsExec = (env: Record<string, string>): AwsExec => (args) => new Promise((done) => {
  execFile("aws", args, { env, maxBuffer: 16 * 1024 * 1024, shell: false, windowsHide: true }, (error, stdout, stderr) => {
    done({ code: error ? (typeof (error as NodeJS.ErrnoException).code === "number" ? Number((error as NodeJS.ErrnoException).code) : 1) : 0, stdout, stderr });
  });
});

export function loadCard(root: string, path: string): { ok: true; card: AftLzaCard } | { ok: false; detail: string } {
  let card: AftLzaCard;
  try { card = JSON.parse(readFileSync(join(root, path), "utf8")) as AftLzaCard; } catch { return { ok: false, detail: path + " is missing or not JSON" }; }
  const issues = validateCard(card);
  return issues.length === 0 ? { ok: true, card } : { ok: false, detail: issues.join("; ") };
}

export async function aftLzaStage(ctx: StageContext, reader?: AftLzaReader): Promise<StageResult> {
  const cardPath = ctx.config.aws?.aftLzaCard;
  if (!cardPath) return { outcome: "SKIPPED", code: "NOT_CONFIGURED", detail: "config.aws.aftLzaCard names no execution card." };
  const identity = ctx.preflight.identities.find((check) => check.provider === "aws");
  if (!identity || identity.status !== "PASS") return { outcome: "BLOCKED", code: identity?.code ?? "AWS_IDENTITY", detail: identity?.detail ?? "No AWS DISCOVERY identity." };
  const loaded = loadCard(ctx.root, cardPath);
  if (!loaded.ok) return { outcome: "BLOCKED", code: "OWNER_INPUT_AFT_LZA_CARD", detail: loaded.detail };
  const card = loaded.card;
  if (!card.regions.includes(ctx.config.aws!.region) && card.homeRegion !== ctx.config.aws!.region) return { outcome: "BLOCKED", code: "REGION_MISMATCH", detail: "config.aws.region is not the card's home Region or a governed Region." };

  let effective = reader;
  if (!effective) {
    const env = childEnvironment(ctx.env, { home: ctx.childHome, realHome: ctx.realHome, readonlyProducer: true });
    if (!env.ok) return { outcome: "BLOCKED", code: "STATIC_SECRET_IN_ENVIRONMENT", detail: "Refused variables: " + env.refused.join(", ") };
    effective = new AwsCliReader(awsExec(env.env), []);
  }
  const store = new OperationStore(join(ctx.root, ctx.config.evidenceDir, "aft-lza", card.runId, "operations"));
  const label = ctx.label === "LIVE" ? "LIVE_READ_ONLY" as const : "SYNTHETIC" as const;
  const folder = join(ctx.runDir, stageFolder(AFT_LZA_STAGE));
  ensureRealFolder(folder);
  const document = join(folder, "decision.json");

  const observed = await step(ctx, AFT_LZA_STAGE, "aft-lza-observe", {}, async () => {
    let report = await advance(card, store, effective!, {}, label);
    const offered = report.decision.phase === "AWAIT_LZA_SUBMISSION" ? "lza" : report.decision.phase === "AWAIT_AFT_SUBMISSION" ? "aft" : undefined;
    if (offered) {
      ctx.out("  next     " + report.decision.nextAction);
      if (ctx.terminal.stdinIsTTY && ctx.terminal.stdoutIsTTY) {
        const answer = (await ctx.terminal.ask("Merge commit after you merged it (Enter to stop here): ")).trim();
        if (answer) { recordMerge(store, card, offered, answer); report = await advance(card, store, effective!, {}, label); }
      }
    }
    writeFileSync(document, JSON.stringify(report, null, 2) + "\n", { mode: 0o600, flag: "w" });
    const docs = [{ name: "aft-lza-decision", path: ctx.runDirRel + "/" + AFT_LZA_STAGE + "/decision.json", sha256: sha256File(document) }];
    const phase = report.decision.phase;
    const outcome = phase === "VERIFIED" ? "PASS" : phase === "FAILED" ? "FAIL" : "BLOCKED";
    return { outcome, code: report.decision.code, detail: report.decision.detail + " Next: " + report.decision.nextAction, documents: docs };
  });
  return { outcome: observed.outcome, code: observed.code ?? "AFT_LZA", detail: observed.detail, documents: observed.documents };
}
