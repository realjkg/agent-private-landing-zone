import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import type { GatePlan } from "./gates.js";
import type { JournalDocument } from "./journal.js";
import type { StageResult } from "./readonly.js";
import { replaceNoFollow, ensureRealFolder } from "./safe-write.js";
import { freshStep, runChild, sha256File, type StageContext } from "./steps.js";
import { ACT_PATHS, ACT_PATH_SPEC, type StageId } from "./types.js";

/**
 * The summary stage S6 (docs/evidence-runner.md, "Summary").
 *
 * 1. `index`: every document the run's producers wrote, by gate, plus the owner-run evidence found where its producer writes it
 *    (`./alz qualify ci-evidence` under .runs/release/ci, `./alz models verify --production` under .runs/model-qualification),
 *    then the admission manifest: one record per gate with evidence, and for each ACT path with a live record its contract
 *    hash and the commit that carried that contract (`actPilots`, the six-path form of #344).
 * 2. `admission`: the existing review, `./alz qualify admission --manifest …`, as a quiet child. It reads files only.
 *
 * A SYNTHETIC run never submits a producer's document: each record points at a runner document that names the producer's file
 * and is stamped `fixture: true`, which the admission review refuses. So a synthetic summary can only ever say BLOCKED.
 */
type Submission = { id: string; mode: string; sourceCommit: string; targetHardwareId: string; evidencePath: string; evidenceSha256: string };
type Pilot = { provider: string; engine: string; contractSha256: string; contractCommit: string };

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const sha64 = /^[0-9a-f]{64}$/;
const sha40 = /^[0-9a-f]{40}$/;

function readJson(path: string): Record<string, unknown> | undefined {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.size > 8 * 1024 * 1024) return undefined;
    const value = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return isRecord(value) ? value : undefined;
  } catch { return undefined; }
}

function stageDocument(ctx: StageContext, stage: StageId, stepName: string, name: string): JournalDocument | undefined {
  const record = ctx.journal.record(stage, stepName);
  if (record.status !== "FINISHED" || record.outcome !== "PASS") return undefined;
  return record.documents.find((document) => document.name === name);
}

/** The newest file in `dir` whose JSON passes `accept`, by name order (the producers name files by time or gate). */
function ownerEvidence(root: string, dir: string, accept: (value: Record<string, unknown>) => boolean): { path: string; value: Record<string, unknown> } | undefined {
  let names: string[];
  try { names = readdirSync(join(root, dir)).filter((name) => name.endsWith(".json")).sort().reverse(); } catch { return undefined; }
  for (const name of names) {
    const value = readJson(join(root, dir, name));
    if (value && accept(value)) return { path: dir + "/" + name, value };
  }
  return undefined;
}

export type SummaryIndex = {
  records: Submission[]; actPilots: Pilot[]; found: { gate: string; path: string; sha256: string; producer: string }[];
  /** Documents whose bytes no longer hash to what the journal recorded when their step finished (review N2 on #349). */
  changed: { gate: string; path: string }[];
};

/**
 * What the run and the owner-run producers have written for this candidate, as admission records. Reads files only.
 *
 * Every record names the **candidate** as its `sourceCommit`: admission requires each submission to name the release it is for.
 * An ACT path's live record and a recovery record keep their own binding inside the document (they were written at the commit
 * that carries the path's contract), and `actPilots` declares that contract and commit per path, which admission verifies
 * against the document (review B2 on #349; the same rule as #344 N1 for the recovery producer's manifest entry).
 *
 * A document the journal recorded is submitted only while its bytes still hash to what the journal recorded when its step
 * finished; one changed since is listed in `changed` and the index step fails.
 */
export function indexEvidence(ctx: StageContext): SummaryIndex {
  const { config } = ctx;
  const found: SummaryIndex["found"] = [];
  const records: Submission[] = [];
  const actPilots: Pilot[] = [];
  const changed: SummaryIndex["changed"] = [];
  const add = (gate: string, mode: string, targetHardwareId: string, path: string, producer: string, journaled?: string): boolean => {
    let sha256: string;
    try { sha256 = sha256File(join(ctx.root, path)); } catch { changed.push({ gate, path }); return false; }
    if (journaled !== undefined && sha256 !== journaled) { changed.push({ gate, path }); return false; }
    found.push({ gate, path, sha256, producer });
    records.push({ id: gate, mode, sourceCommit: config.candidateCommit, targetHardwareId, evidencePath: path, evidenceSha256: sha256 });
    return true;
  };
  for (const [provider, gate] of [["aws", "aws-provider"], ["azure", "azure-provider"]] as const) {
    const document = stageDocument(ctx, `${provider}-readonly`, "provider-qualification", "provider-" + provider);
    if (document) add(gate, "LIVE_PROVIDER", config.targetHardwareId, document.path, "./alz qualify provider-" + provider, document.sha256);
  }
  for (const path of ACT_PATHS) {
    const document = stageDocument(ctx, `cleanup:${path}`, "record-live", "live-record");
    if (!document) continue;
    const record = readJson(join(ctx.root, document.path));
    const spec = ACT_PATH_SPEC[path];
    if (!record || typeof record.sourceCommit !== "string" || !sha40.test(record.sourceCommit) || typeof record.contractSha256 !== "string" || !sha64.test(record.contractSha256)) continue;
    // The submission names the candidate; the record's own commit is the path's contract commit, declared in actPilots.
    if (add("act:" + spec.provider.toLowerCase() + "-" + spec.engine.toLowerCase(), "LIVE_ACT", config.targetHardwareId, document.path, "./alz apply record-live", document.sha256)) {
      actPilots.push({ provider: spec.provider, engine: spec.engine, contractSha256: record.contractSha256, contractCommit: record.sourceCommit });
    }
  }
  const recovery = stageDocument(ctx, "recovery", "record-recovery", "recovery-record");
  if (recovery) {
    const value = readJson(join(ctx.root, recovery.path));
    if (value && typeof value.sourceCommit === "string") add("act-run-recovery", "ACT_RECOVERY", String(value.targetHardwareId ?? config.targetHardwareId), recovery.path, "./alz apply record-recovery", recovery.sha256);
  }
  for (const gate of ["source-ci", "release-archive"]) {
    const file = ".runs/release/ci/" + gate + "-" + config.candidateCommit.slice(0, 12) + ".json";
    const value = readJson(join(ctx.root, file));
    if (value && value.gateId === gate && value.sourceCommit === config.candidateCommit && typeof value.targetHardwareId === "string") {
      add(gate, "CI", value.targetHardwareId, file, "./alz qualify ci-evidence");
    }
  }
  const model = ownerEvidence(ctx.root, ".runs/model-qualification", (value) => {
    const production = value.production;
    return isRecord(production) && production.passed === true && isRecord(production.context) && production.context.sourceCommit === config.candidateCommit &&
      isRecord(production.context.host) && production.context.host.targetHardwareId === config.targetHardwareId;
  });
  if (model) add("private-model-runtime", "PRIVATE_MODEL", config.targetHardwareId, model.path, "./alz models verify --production");
  // One record per gate: the first found wins, so a gate is never submitted twice.
  const seen = new Set<string>();
  const unique = records.filter((record) => !seen.has(record.id) && seen.add(record.id));
  return { records: unique, actPilots, found, changed };
}

type AdmissionReport = { gates: { id: string; status: string; blockers: string[] }[]; ready: boolean };
function admissionReport(path: string): AdmissionReport | undefined {
  const value = readJson(path);
  if (!value || !Array.isArray(value.gates)) return undefined;
  const gates = value.gates.filter(isRecord).map((gate) => ({
    id: String(gate.id), status: String(gate.status), blockers: Array.isArray(gate.blockers) ? gate.blockers.map(String) : [],
  }));
  return { gates, ready: value.readyForIndependentReleaseReview === true };
}

export async function summaryStage(ctx: StageContext, plan: readonly GatePlan[], writeDocument: (path: string, document: Record<string, unknown>) => void): Promise<StageResult> {
  const stage: StageId = "summary";
  const dir = join(ctx.runDir, "summary");
  const dirRel = ctx.runDirRel + "/summary";
  const indexed = await freshStep(ctx, stage, "index", async () => {
    const index = indexEvidence(ctx);
    if (index.changed.length > 0) {
      return { outcome: "FAIL", code: "EVIDENCE_DOCUMENT_CHANGED",
        detail: "These documents no longer match the hash journaled when their step finished, so nothing was submitted: " + index.changed.map((entry) => entry.gate + " " + entry.path).join(", ") + "." };
    }
    ensureRealFolder(dir);
    let records = index.records;
    if (ctx.label === "SYNTHETIC") {
      // A synthetic run never submits a producer's document: each record names a fixture-stamped runner document instead.
      records = index.records.map((record) => {
        const file = "synthetic-" + record.id.replace(/[^a-z0-9-]/g, "-") + ".json";
        writeDocument(join(dir, file), { schemaVersion: 1, kind: "EVIDENCE_RUNNER_SYNTHETIC_SUBMISSION", gate: record.id, producerDocument: record.evidencePath, producerSha256: record.evidenceSha256 });
        return { ...record, evidencePath: dirRel + "/" + file, evidenceSha256: sha256File(join(dir, file)) };
      });
    }
    const manifest = {
      schemaVersion: 1, sourceCommit: ctx.config.candidateCommit, operatingMode: "PREVIEW_OPERATE",
      infrastructureAct: index.actPilots.length > 0 ? "PILOT" : "DISABLED", ...(index.actPilots.length > 0 ? { actPilots: index.actPilots } : {}), records,
    };
    // The manifest is admission's input, written as admission reads it (no label fields); the index beside it is the runner's record.
    const manifestText = JSON.stringify(manifest, null, 2) + "\n";
    replaceNoFollow(join(dir, "admission-manifest.json"), manifestText);
    const covered = new Set(records.map((record) => record.id));
    writeDocument(join(dir, "evidence-index.json"), {
      schemaVersion: 1, kind: "EVIDENCE_RUNNER_INDEX", candidateCommit: ctx.config.candidateCommit, targetHardwareId: ctx.config.targetHardwareId,
      found: index.found, actPilots: index.actPilots,
      missing: plan.filter((gate) => gate.mode !== "OUT_OF_SCOPE" && !covered.has(gate.id)).map((gate) => ({ gate: gate.id, mode: gate.mode, how: gate.note })),
      manifestSha256: createHash("sha256").update(manifestText).digest("hex"),
    });
    return {
      outcome: "PASS", code: "INDEXED", detail: index.found.length + " evidence document(s) indexed for " + covered.size + " gate(s).",
      documents: [{ name: "admission-manifest", path: dirRel + "/admission-manifest.json", sha256: sha256File(join(dir, "admission-manifest.json")) },
        { name: "evidence-index", path: dirRel + "/evidence-index.json", sha256: sha256File(join(dir, "evidence-index.json")) }],
    };
  });
  if (indexed.outcome !== "PASS") return { outcome: indexed.outcome, code: indexed.code ?? "INDEX", detail: indexed.detail };
  // The review always runs again: it reads files only, and its verdict must be the current one.
  ctx.journal.start(stage, "admission", ctx.at());
  const reviewed = await runChild(ctx, stage, {
    args: ["qualify", "admission", "--manifest", dirRel + "/admission-manifest.json"], io: "LOGGED", logName: "admission",
    collectors: [{ name: "admission-report", dir: ".runs/release", pattern: /^admission-[0-9a-f-]{36}\.json$/ }],
    // The admission CLI exits 1 for a BLOCKED release and still writes its report.
    collectOn: [0, 1],
  });
  const report = reviewed.documents?.[0];
  const parsed = report ? admissionReport(join(ctx.root, report.path)) : undefined;
  if (!report || !parsed) {
    ctx.journal.finish(stage, "admission", "FAIL", ctx.at(), "ADMISSION_NOT_RUN", { exitCode: reviewed.exitCode });
    return { outcome: "FAIL", code: "ADMISSION_NOT_RUN", detail: "The admission review wrote no report. " + reviewed.detail };
  }
  ctx.out("Gates (release admission review, read-only)");
  const notes = new Map(plan.map((gate) => [gate.id, gate]));
  for (const gate of parsed.gates) {
    const owner = gate.status === "BLOCKED" ? notes.get(gate.id) : undefined;
    ctx.out("  " + gate.status.padEnd(16) + " " + gate.id + (gate.blockers.length ? " (" + gate.blockers.slice(0, 3).join(", ") + ")" : "") +
      (owner ? " — " + owner.mode + ": " + owner.note : ""));
  }
  const ready = parsed.ready && reviewed.exitCode === 0;
  ctx.journal.finish(stage, "admission", ready ? "PASS" : "BLOCKED", ctx.at(), ready ? "READY_FOR_INDEPENDENT_REVIEW" : "RELEASE_BLOCKED", { exitCode: reviewed.exitCode, documents: [report] });
  return ready
    ? { outcome: "PASS", code: "READY_FOR_INDEPENDENT_REVIEW", detail: "Evidence is structurally present for every gate; independent review and the owner's approval are still required. Report: " + report.path, documents: [report] }
    : { outcome: "BLOCKED", code: "RELEASE_BLOCKED", detail: "The admission review says BLOCKED; the gates above say what is missing. Report: " + report.path, documents: [report] };
}
