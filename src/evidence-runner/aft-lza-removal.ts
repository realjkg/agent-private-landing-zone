import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { AwsCliReader } from "../aft-lza/aws-reader.js";
import { OperationStore } from "../aft-lza/operation-store.js";
import { advanceRemoval, offeredAction, recordRemoval } from "../aft-lza/removal-run.js";
import { validateRemovalCard, type RemovalCard } from "../aft-lza/removal.js";
import type { AftLzaReader } from "../aft-lza/run.js";
import { awsExec } from "./aft-lza.js";
import { childEnvironment } from "./child.js";
import { ensureRealFolder } from "./safe-write.js";
import { sha256File, stageFolder, step, type StageContext } from "./steps.js";
import type { StageResult } from "./readonly.js";

/**
 * Stage `aws-aft-lza-removal`: takes the pilot's account out of AFT, Control Tower and LZA management, in that order, run only
 * when named with `--stage aws-aft-lza-removal`. Like `aws-aft-lza`, it reads under the federated DISCOVERY identity, journals
 * each step before asking the person to do it, and performs no write itself. It never closes the account.
 */
export const AFT_LZA_REMOVAL_STAGE = "aws-aft-lza-removal" as const;

export function loadRemovalCard(root: string, path: string): { ok: true; card: RemovalCard } | { ok: false; detail: string } {
  let card: RemovalCard;
  try { card = JSON.parse(readFileSync(join(root, path), "utf8")) as RemovalCard; } catch { return { ok: false, detail: path + " is missing or not JSON" }; }
  const issues = validateRemovalCard(card);
  return issues.length === 0 ? { ok: true, card } : { ok: false, detail: issues.join("; ") };
}

const PROMPT = {
  aft: "Merge commit after you merged the AFT removal (Enter to stop here): ",
  unmanage: "Account id after you unmanaged it in Control Tower (Enter to stop here): ",
  lza: "Merge commit after you merged the LZA ignored-OU change (Enter to stop here): ",
} as const;

export async function aftLzaRemovalStage(ctx: StageContext, reader?: AftLzaReader): Promise<StageResult> {
  const cardPath = ctx.config.aws?.aftLzaRemovalCard;
  if (!cardPath) return { outcome: "SKIPPED", code: "NOT_CONFIGURED", detail: "config.aws.aftLzaRemovalCard names no removal card." };
  const identity = ctx.preflight.identities.find((check) => check.provider === "aws");
  if (!identity || identity.status !== "PASS") return { outcome: "BLOCKED", code: identity?.code ?? "AWS_IDENTITY", detail: identity?.detail ?? "No AWS DISCOVERY identity." };
  const loaded = loadRemovalCard(ctx.root, cardPath);
  if (!loaded.ok) return { outcome: "BLOCKED", code: "OWNER_INPUT_REMOVAL_CARD", detail: loaded.detail };
  const card = loaded.card;
  if (card.homeRegion !== ctx.config.aws!.region) return { outcome: "BLOCKED", code: "REGION_MISMATCH", detail: "config.aws.region is not the removal card's home Region." };

  let effective = reader;
  if (!effective) {
    const env = childEnvironment(ctx.env, { home: ctx.childHome, realHome: ctx.realHome, readonlyProducer: true });
    if (!env.ok) return { outcome: "BLOCKED", code: "STATIC_SECRET_IN_ENVIRONMENT", detail: "Refused variables: " + env.refused.join(", ") };
    effective = new AwsCliReader(awsExec(env.env), []);
  }
  const store = new OperationStore(join(ctx.root, ctx.config.evidenceDir, "aft-lza", card.runId, "removal"));
  const label = ctx.label === "LIVE" ? "LIVE_READ_ONLY" as const : "SYNTHETIC" as const;
  const folder = join(ctx.runDir, stageFolder(AFT_LZA_REMOVAL_STAGE));
  ensureRealFolder(folder);
  const document = join(folder, "decision.json");

  const observed = await step(ctx, AFT_LZA_REMOVAL_STAGE, "aft-lza-removal-observe", {}, async () => {
    let report = await advanceRemoval(card, store, effective!, label);
    const offered = offeredAction(report.decision);
    if (offered) {
      ctx.out("  next     " + report.decision.nextAction);
      if (ctx.terminal.stdinIsTTY && ctx.terminal.stdoutIsTTY) {
        const answer = (await ctx.terminal.ask(PROMPT[offered])).trim();
        if (answer) { recordRemoval(store, card, offered, answer); report = await advanceRemoval(card, store, effective!, label); }
      }
    }
    writeFileSync(document, JSON.stringify(report, null, 2) + "\n", { mode: 0o600, flag: "w" });
    const docs = [{ name: "aft-lza-removal-decision", path: ctx.runDirRel + "/" + AFT_LZA_REMOVAL_STAGE + "/decision.json", sha256: sha256File(document) }];
    const phase = report.decision.phase;
    const outcome = phase === "RETIRED" ? "PASS" : phase === "FAILED" ? "FAIL" : "BLOCKED";
    return { outcome, code: report.decision.code, detail: report.decision.detail + " Next: " + report.decision.nextAction, documents: docs };
  });
  return { outcome: observed.outcome, code: observed.code ?? "AFT_LZA_REMOVAL", detail: observed.detail, documents: observed.documents };
}
