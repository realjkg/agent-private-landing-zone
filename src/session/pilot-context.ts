import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Read-only pilot context for the local model (RB3).
 *
 * The person runs every pilot step (`./alz apply prepare`, `seal`, `approve`, `apply`, `observe`, `propose-cleanup`,
 * `cleanup`, `verify-cleanup`, `report`) in a terminal or in the console's Pilot apply wizard. Those steps leave plain
 * JSON records that are written for people to read:
 *
 * - the blueprint: `.runs/pilot/<ENV>/preparation-<tag>.json` (`./alz apply prepare`);
 * - the preview: the review bundle `.runs/evidence/sealed-plan/<artifact>.evidence.review.json` (`./alz apply seal`),
 *   with the sealed plan's redacted change summary;
 * - the run's status, what was observed, the leftovers and why a stage failed: the lifecycle report
 *   `.runs/apply/reports/<artifact>-lifecycle*.json` (`./alz apply report`).
 *
 * This module only reads those files. It imports nothing from src/apply (test/apply-boundary.test.ts), opens no
 * encrypted evidence, holds no key, starts no process and writes nothing. Every value is untrusted data: shapes are
 * checked, strings are bounded and stripped of control characters, and nothing in a record changes what is run.
 * Each answer ends with the exact command or console step for the person; the session never runs it.
 */
export type PilotQuery =
  | "PILOT_BLUEPRINT"
  | "PILOT_PREVIEW"
  | "PILOT_STATUS"
  | "PILOT_OBSERVED"
  | "PILOT_FAILURE"
  | "PILOT_READINESS";

export const PILOT_QUERIES: readonly PilotQuery[] = [
  "PILOT_BLUEPRINT", "PILOT_PREVIEW", "PILOT_STATUS", "PILOT_OBSERVED", "PILOT_FAILURE", "PILOT_READINESS",
];

export type PilotReadCode = "PILOT_RECORD_NOT_FOUND" | "PILOT_RECORD_INVALID" | "PILOT_RUN_AMBIGUOUS";

export type PilotToolResult =
  | {
      ok: true;
      query: PilotQuery;
      /** The record read, relative to the repository root. */
      source: string;
      /** The facts, in the order a person reads them. Built from the record only. */
      lines: string[];
      /** True only when the record itself shows success for what was asked (every lifecycle stage PASS, or observation VERIFIED). */
      succeeded: boolean;
      /** Failing or undecided stages and unresolved items, quoted from the record. */
      failures: string[];
      /** The exact command or console step for the person. Never run by the session. */
      nextStep: string;
    }
  | { ok: false; query: PilotQuery; code: PilotReadCode; message: string; nextStep: string };

export type PilotContextOptions = {
  /** The repository root the records live under. Defaults to this checkout's root. */
  root?: string;
  /** An artifact hash or a prefix of at least 6 hex characters, naming one run. */
  runId?: string;
};

export const DEFAULT_PILOT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

const ENVIRONMENTS = ["DEV", "QA", "PROD"] as const;
const HASH = /^[0-9a-f]{64}$/;
const RUN_ID = /^[0-9a-f]{6,64}$/;
const STAGES = ["execute", "observe", "propose", "cleanup", "leftovers"] as const;
const STAGE_STATUS = new Set(["PASS", "FAIL", "NOT_RUN", "INCONCLUSIVE"]);
const MAX_TEXT = 300;
const MAX_ITEMS = 50;
const MAX_FILE_BYTES = 2 * 1024 * 1024;

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);

/** A bounded, single-line copy of an untrusted string. */
export function cleanText(value: unknown, max: number = MAX_TEXT): string {
  if (typeof value !== "string") return "";
  // eslint-disable-next-line no-control-regex
  const flat = value.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ").trim();
  return flat.length > max ? flat.slice(0, max) + "…" : flat;
}

/** A run id taken from the person's words: "run 3f9a2c…", "artifact …", "plan …". */
export function runIdFromRequest(request: string): string | undefined {
  const match = request.match(/\b(?:run|artifact|plan|sealed plan)\s+([0-9a-f]{6,64})\b/i);
  return match ? match[1].toLowerCase() : undefined;
}

type Found = { path: string; mtimeMs: number; value: unknown };

function listJson(directory: string, accept: (name: string) => boolean): Found[] {
  let names: string[];
  try {
    names = readdirSync(directory);
  } catch {
    return [];
  }
  const found: Found[] = [];
  for (const name of names.filter(accept)) {
    const path = join(directory, name);
    try {
      const stat = statSync(path);
      if (!stat.isFile() || stat.size > MAX_FILE_BYTES) continue;
      found.push({ path, mtimeMs: stat.mtimeMs, value: JSON.parse(readFileSync(path, "utf8")) as unknown });
    } catch {
      found.push({ path, mtimeMs: 0, value: undefined });
    }
  }
  return found.sort((a, b) => b.mtimeMs - a.mtimeMs || a.path.localeCompare(b.path));
}

const refusal = (query: PilotQuery, code: PilotReadCode, message: string, nextStep: string): PilotToolResult =>
  ({ ok: false, query, code, message, nextStep });

/** Picks the record for the run asked about, or the newest valid one. */
function pick<T>(query: PilotQuery, found: Found[], parse: (value: unknown) => T | undefined, artifactOf: (record: T) => string,
  options: PilotContextOptions, what: string, howToMake: string): { record: T; path: string } | PilotToolResult {
  if (options.runId !== undefined && !RUN_ID.test(options.runId)) {
    return refusal(query, "PILOT_RECORD_INVALID", "The run id must be 6 to 64 lowercase hex characters of the artifact hash.", howToMake);
  }
  const valid = found.map((item) => ({ item, record: item.value === undefined ? undefined : parse(item.value) }));
  const usable = valid.filter((entry): entry is { item: Found; record: T } => entry.record !== undefined);
  const matching = options.runId ? usable.filter((entry) => artifactOf(entry.record).startsWith(options.runId!)) : usable;
  if (matching.length === 0) {
    const invalid = valid.length - usable.length;
    if (invalid > 0 && usable.length === 0) {
      return refusal(query, "PILOT_RECORD_INVALID", "Found " + invalid + " " + what + " file(s), but none has the expected shape, so none was read.", howToMake);
    }
    return refusal(query, "PILOT_RECORD_NOT_FOUND",
      "No " + what + (options.runId ? " for run " + options.runId : "") + " was found under this checkout.", howToMake);
  }
  const artifacts = new Set(matching.map((entry) => artifactOf(entry.record)));
  if (options.runId && artifacts.size > 1) {
    return refusal(query, "PILOT_RUN_AMBIGUOUS", "Run id " + options.runId + " matches " + artifacts.size + " runs. Give more characters of the artifact hash.", howToMake);
  }
  return { record: matching[0].record, path: matching[0].item.path };
}

// ---------------------------------------------------------------------------------------------------------------------
// Records, as far as the answers read them. Every other key is ignored, never echoed.

type Preparation = {
  provider: string; engine: string; path: string; environment: string; account: string; region?: string; backend: string;
  workspace: string; fileCount: number; engineVersion: string; engineVersionSource: string;
  providers: string[]; inputs: string[]; unitTags: string[]; gaps: string[];
  next: { step: string; reason: string; blocker?: string }; requestFile: string; manifestFile: string; manifestHash: string;
};

function parsePreparation(value: unknown): Preparation | undefined {
  if (!isObject(value) || value.label !== "LOCAL_PREPARATION") return undefined;
  if (!ENVIRONMENTS.includes(value.environment as never) || typeof value.provider !== "string" || typeof value.engine !== "string") return undefined;
  if (typeof value.manifestHash !== "string" || !HASH.test(value.manifestHash)) return undefined;
  const next = value.next;
  if (!isObject(next) || !["qualify", "seal", "blocked"].includes(next.step as string) || typeof next.reason !== "string") return undefined;
  const providers = Array.isArray(value.providers) ? value.providers.filter(isObject).slice(0, MAX_ITEMS)
    .map((item) => cleanText(item.source, 120) + " " + cleanText(item.version, 40)) : [];
  const inputs = Array.isArray(value.inputs) ? value.inputs.filter(isObject).slice(0, MAX_ITEMS)
    .map((item) => cleanText(item.name, 120) + " (" + cleanText(item.source, 20) + ")") : [];
  const unit = isObject(value.unit) && isObject(value.unit.tags) ? value.unit.tags : {};
  return {
    provider: cleanText(value.provider, 20), engine: cleanText(value.engine, 20), path: cleanText(value.path, 20),
    environment: value.environment as string, account: cleanText(value.account, 120), region: typeof value.region === "string" ? cleanText(value.region, 40) : undefined,
    backend: cleanText(value.backend, 200), workspace: cleanText(value.workspace, 120),
    fileCount: typeof value.fileCount === "number" ? value.fileCount : 0,
    engineVersion: cleanText(value.engineVersion, 40), engineVersionSource: cleanText(value.engineVersionSource, 40),
    providers, inputs, unitTags: Object.keys(unit).slice(0, MAX_ITEMS).map((key) => cleanText(key, 80) + "=" + cleanText(unit[key], 120)),
    gaps: Array.isArray(value.gaps) ? value.gaps.slice(0, 10).map((gap) => cleanText(gap)) : [],
    next: { step: next.step as string, reason: cleanText(next.reason), ...(typeof next.blocker === "string" ? { blocker: cleanText(next.blocker, 20) } : {}) },
    requestFile: cleanText(value.requestFile, 400), manifestFile: cleanText(value.manifestFile, 400), manifestHash: value.manifestHash,
  };
}

type Bundle = {
  artifactSha256: string; environment: string; target: string; sourceCommit: string; requesterId: string; channel: string; createdAt: string;
  changes: { address: string; type: string; action: string; note: string }[];
};

function parseBundle(value: unknown): Bundle | undefined {
  if (!isObject(value) || typeof value.artifactSha256 !== "string" || !HASH.test(value.artifactSha256)) return undefined;
  if (!ENVIRONMENTS.includes(value.environment as never) || !Array.isArray(value.changes) || typeof value.changesSha256 !== "string") return undefined;
  const target = isObject(value.target) ? value.target : {};
  const changes = value.changes.filter(isObject).map((change) => ({
    address: cleanText(change.address, 200), type: cleanText(change.type, 120), action: cleanText(change.action, 40),
    note: change.importing === true ? " (import)" : typeof change.previousAddress === "string" ? " (moved from " + cleanText(change.previousAddress, 200) + ")" : "",
  }));
  if (changes.length !== value.changes.length) return undefined;
  return {
    artifactSha256: value.artifactSha256, environment: value.environment as string,
    target: ["account", "backend", "workspace"].map((key) => key + " " + cleanText(target[key], 200)).join(", "),
    sourceCommit: cleanText(value.sourceCommit, 40), requesterId: cleanText(value.requesterId, 64), channel: cleanText(value.channel, 8),
    createdAt: cleanText(value.createdAt, 40), changes,
  };
}

type Stage = { status: string; mode: string; detail: string };
type Report = {
  artifactSha256: string; environment: string; provider: string; engine: string; mode: string; passed: boolean;
  stages: Record<(typeof STAGES)[number], Stage>; unresolved: string[]; statement: string; proposalSha256: string | null;
  observation: { verdict: string; resources: { address: string; type: string; identifier: string; result: string }[] } | null;
  dispositions: { disposition: string; resources: { address: string; disposition: string; basis: string }[] } | null;
};

function parseReport(value: unknown): Report | undefined {
  if (!isObject(value) || value.reportKind !== "ACT_LIFECYCLE" || typeof value.artifactSha256 !== "string" || !HASH.test(value.artifactSha256)) return undefined;
  if (!ENVIRONMENTS.includes(value.environment as never) || typeof value.passed !== "boolean" || !isObject(value.stages)) return undefined;
  const stages = {} as Report["stages"];
  for (const name of STAGES) {
    const stage = value.stages[name];
    if (!isObject(stage) || !STAGE_STATUS.has(stage.status as string) || typeof stage.detail !== "string") return undefined;
    stages[name] = { status: stage.status as string, mode: cleanText(stage.mode, 12), detail: cleanText(stage.detail) };
  }
  // A report that says it passed while a stage did not is not read at all (the product's own validator refuses it too).
  if (value.passed !== STAGES.every((name) => stages[name].status === "PASS")) return undefined;
  const observation = isObject(value.observation) && Array.isArray(value.observation.resources)
    ? { verdict: cleanText(value.observation.verdict, 20), resources: value.observation.resources.filter(isObject).map((resource) => ({
        address: cleanText(resource.address, 200), type: cleanText(resource.type, 120),
        identifier: resource.identifier === null ? "" : cleanText(resource.identifier, 300), result: cleanText(resource.result, 40) })) }
    : null;
  const dispositions = isObject(value.dispositions) && Array.isArray(value.dispositions.resources)
    ? { disposition: cleanText(value.dispositions.disposition, 40), resources: value.dispositions.resources.filter(isObject).map((resource) => ({
        address: cleanText(resource.address, 200), disposition: cleanText(resource.disposition, 40), basis: cleanText(resource.basis, 60) })) }
    : null;
  return {
    artifactSha256: value.artifactSha256, environment: value.environment as string, provider: cleanText(value.provider, 20),
    engine: cleanText(value.engine, 20), mode: cleanText(value.mode, 12), passed: value.passed, stages,
    unresolved: Array.isArray(value.unresolved) ? value.unresolved.slice(0, 20).map((item) => cleanText(item)) : [],
    statement: isObject(value.acceptance) ? cleanText(value.acceptance.statement) : "",
    proposalSha256: typeof value.proposalSha256 === "string" && HASH.test(value.proposalSha256) ? value.proposalSha256 : null,
    observation, dispositions,
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// The exact steps for the person. The session prints them; it never runs them.

const sealedPlanOf = (artifact: string) => ".runs/evidence/sealed-plan/" + artifact + ".evidence";
const PREPARE_STEP = "./alz apply prepare --environment DEV --project PROJECT_DIR (a person at the terminal, or the console's Pilot apply wizard)";
const SEAL_STEP = "./alz apply seal --request REQUEST.json --manifest MANIFEST.json --requester YOUR_ID --key YOUR_REQUESTER_KEY.pem";
const REPORT_STEP = "./alz apply report --sealed SEALED_PLAN [--proposal PROPOSAL.json]";

function nextStepForStages(report: Report): string {
  const sealed = sealedPlanOf(report.artifactSha256);
  const { execute, observe, propose, cleanup, leftovers } = report.stages;
  if (execute.status !== "PASS") return "A person reviews the failed apply before anything else: ./alz apply status --environment " + report.environment + " --sealed " + sealed;
  if (observe.status !== "PASS") return "./alz apply observe --sealed " + sealed + ", then ./alz apply report --sealed " + sealed;
  if (propose.status !== "PASS") return "./alz apply propose-cleanup --sealed " + sealed + " --requester YOUR_ID --key YOUR_REQUESTER_KEY.pem; approvers review and sign it";
  if (cleanup.status !== "PASS") return "./alz apply cleanup --proposal PROPOSAL.json --request REQUEST.json --manifest MANIFEST.json --sealed " + sealed + " --approval APPROVAL.json (a person runs it)";
  if (leftovers.status !== "PASS") return "./alz apply verify-cleanup --proposal PROPOSAL.json, then ./alz apply report --sealed " + sealed + " --proposal PROPOSAL.json";
  return "Nothing more to run for this run. Retiring the environment stays a separate, reviewed owner action.";
}

// ---------------------------------------------------------------------------------------------------------------------

/** Reads the record a read-only pilot query needs and states its facts. Never writes, runs or signs anything. */
export function readPilotContext(query: PilotQuery, options: PilotContextOptions = {}): PilotToolResult {
  const root = options.root ?? DEFAULT_PILOT_ROOT;
  const shown = (path: string) => relative(root, path) || basename(path);

  if (query === "PILOT_BLUEPRINT" || query === "PILOT_READINESS") {
    const found = ENVIRONMENTS.flatMap((environment) =>
      listJson(join(root, ".runs", "pilot", environment), (name) => /^preparation-[0-9a-f]{16}\.json$/.test(name)));
    // A preparation is named by its manifest, not its run, so a run id does not select one.
    const picked = pick(query, found, parsePreparation, (record) => record.manifestHash, { ...options, runId: undefined }, "pilot preparation", PREPARE_STEP);
    if ("ok" in picked) return picked;
    const prep = picked.record;
    const nextStep = prep.next.step === "seal"
      ? SEAL_STEP.replace("REQUEST.json", prep.requestFile || "REQUEST.json").replace("MANIFEST.json", prep.manifestFile || "MANIFEST.json")
      : prep.next.step === "qualify"
        ? "./alz apply qualify --request " + (prep.requestFile || "REQUEST.json") + " --manifest " + (prep.manifestFile || "MANIFEST.json") + " (the owner watches the cloud logs in DEV)"
        : "Owner step (" + (prep.next.blocker ?? "OWNER") + "): " + prep.next.reason;
    if (query === "PILOT_READINESS") {
      return {
        ok: true, query, source: shown(picked.path), succeeded: false, failures: prep.next.step === "blocked" ? ["blocked: " + prep.next.reason] : [],
        lines: [
          "Readiness from the latest preparation (" + prep.environment + ", " + prep.provider + " " + prep.engine + "): next step " + prep.next.step + ". " + prep.next.reason,
          "Authorized, Ready and Approved are decided by ./alz apply preflight --environment " + prep.environment + " when a person runs it; that output is not saved, so I do not restate it.",
        ],
        nextStep: "./alz apply preflight --environment " + prep.environment + ", then: " + nextStep,
      };
    }
    return {
      ok: true, query, source: shown(picked.path), succeeded: false, failures: [],
      lines: [
        "Blueprint (local preparation, not cloud evidence): " + prep.provider + " " + prep.engine + " (" + prep.path + " path), environment " + prep.environment + ".",
        "Target: account " + prep.account + (prep.region ? ", region " + prep.region : "") + ", backend " + prep.backend + ", workspace " + prep.workspace + ".",
        "Project: " + prep.fileCount + " file(s), manifest " + prep.manifestHash.slice(0, 16) + "…; engine " + prep.engineVersion + " (" + prep.engineVersionSource + ").",
        "Providers: " + (prep.providers.join(", ") || "none listed") + ".",
        "Inputs (names and sources only, never values): " + (prep.inputs.join(", ") || "none") + ".",
        "Deletion-unit tags the plan must carry: " + (prep.unitTags.join(", ") || "none") + ".",
        ...prep.gaps.map((gap) => "Known limit: " + gap),
        "Next step from the preparation: " + prep.next.step + ". " + prep.next.reason,
      ],
      nextStep,
    };
  }

  if (query === "PILOT_PREVIEW") {
    const found = listJson(join(root, ".runs", "evidence", "sealed-plan"), (name) => /^[0-9a-f]{64}\.evidence\.review\.json$/.test(name));
    const picked = pick(query, found, parseBundle, (record) => record.artifactSha256, options, "review bundle (sealed preview)", SEAL_STEP);
    if ("ok" in picked) return picked;
    const bundle = picked.record;
    const counts = new Map<string, number>();
    for (const change of bundle.changes) counts.set(change.action, (counts.get(change.action) ?? 0) + 1);
    return {
      ok: true, query, source: shown(picked.path), succeeded: false, failures: [],
      lines: [
        "Sealed preview for run " + bundle.artifactSha256.slice(0, 12) + " (" + bundle.environment + "; " + bundle.target + "), sealed " + bundle.createdAt +
          " from commit " + bundle.sourceCommit.slice(0, 12) + " by requester " + bundle.requesterId + " (channel " + bundle.channel + ").",
        "Changes: " + bundle.changes.length + (counts.size ? " (" + [...counts].map(([action, count]) => count + " " + action).join(", ") + ")" : "") + ". Redacted: addresses, types and actions only, never values.",
        ...bundle.changes.slice(0, MAX_ITEMS).map((change) => "  " + change.action + " " + change.type + " " + change.address + change.note),
        ...(bundle.changes.length > MAX_ITEMS ? ["  … and " + (bundle.changes.length - MAX_ITEMS) + " more in " + shown(picked.path)] : []),
        "Nothing has been applied by sealing. Approval and apply are separate human steps.",
      ],
      nextStep: "Each approver reviews this bundle and signs it: ./alz apply approve --bundle " + shown(picked.path) + " --key YOUR_APPROVER_KEY.pem --approver YOUR_ID",
    };
  }

  const found = listJson(join(root, ".runs", "apply", "reports"), (name) => /^[0-9a-f]{12}-lifecycle(-[0-9a-f]{12})?\.json$/.test(name));
  const picked = pick(query, found, parseReport, (record) => record.artifactSha256, options, "lifecycle report", REPORT_STEP);
  if ("ok" in picked) return picked;
  const report = picked.record;
  const stageLines = STAGES.map((name) => name + ": " + report.stages[name].status + " (" + report.stages[name].mode + ") — " + report.stages[name].detail);
  const failing = STAGES.filter((name) => report.stages[name].status === "FAIL" || report.stages[name].status === "INCONCLUSIVE")
    .map((name) => name + ": " + report.stages[name].status + " — " + report.stages[name].detail);
  const failures = [...failing, ...report.unresolved.map((item) => "unresolved: " + item)];
  const header = "Run " + report.artifactSha256.slice(0, 12) + " (" + report.environment + ", " + report.provider + " " + report.engine + "), evidence mode " + report.mode + ".";
  const nextStep = nextStepForStages(report);

  if (query === "PILOT_STATUS") {
    return {
      ok: true, query, source: shown(picked.path), succeeded: report.passed, failures, nextStep,
      lines: [header, ...stageLines, report.passed ? "Every stage passed in this report." : "Not every stage passed in this report.",
        ...report.unresolved.map((item) => "Unresolved: " + item), ...(report.statement ? ["Acceptance: " + report.statement] : [])],
    };
  }
  if (query === "PILOT_OBSERVED") {
    const observation = report.observation;
    const leftovers = report.dispositions;
    return {
      ok: true, query, source: shown(picked.path), succeeded: observation?.verdict === "VERIFIED", failures, nextStep,
      lines: [
        header,
        observation
          ? "Independent observation: " + observation.verdict + ", " + observation.resources.length + " resource(s)."
          : "The run has not been observed, so nothing is confirmed as built.",
        ...(observation?.resources.slice(0, MAX_ITEMS).map((resource) => "  " + resource.result + " " + resource.type + " " + resource.address +
          (resource.identifier ? " (" + resource.identifier + ")" : "")) ?? []),
        ...(leftovers
          ? ["Leftovers after cleanup: " + leftovers.disposition + ".",
            ...leftovers.resources.slice(0, MAX_ITEMS).map((resource) => "  " + resource.disposition + " " + resource.address + " (basis " + resource.basis + ")")]
          : ["Leftovers: not verified for this run."]),
        ...(report.statement ? ["Acceptance: " + report.statement] : []),
      ],
    };
  }
  // PILOT_FAILURE
  return {
    ok: true, query, source: shown(picked.path), succeeded: report.passed, failures, nextStep,
    lines: [header, ...(failures.length > 0 ? failures.map((item) => "  " + item) : ["No stage failed or is undecided in this report, and nothing is unresolved."])],
  };
}
