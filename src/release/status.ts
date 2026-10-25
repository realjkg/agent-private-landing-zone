import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  ACT_RELEASE_PATHS, actGateId, PRODUCTION_RELEASE_GATES, RELEASE_PLATFORMS,
  type ReleaseAdmissionReport, type ReleaseGateMode,
} from "../qualification/release-admission.js";
import type { RowReport } from "./acceptance.js";

/**
 * The release gate status (config/release/status.json): one entry per production admission gate, saying where that gate
 * stands for the release the owner scoped (config/release/scope.json). It is a record people keep, so every claim in it is
 * checked against what can be proved: a PASS needs the admission review of the frozen candidate to find that gate's
 * evidence, an ACT gate also needs its journey row live, and OUT_OF_SCOPE needs the owner's scope to exclude the gate.
 */
export const GATE_STATUSES = ["NOT_RUN", "RUNNING", "PASS", "FAIL", "BLOCKED", "OUT_OF_SCOPE"] as const;
export type GateStatus = typeof GATE_STATUSES[number];
export const EVIDENCE_MODES = ["SYNTHETIC", "LIVE"] as const;
export type EvidenceMode = typeof EVIDENCE_MODES[number];
export const GATE_OWNERS = ["OWNER", "COORDINATOR", "ENGINEERING", "CI", "INDEPENDENT_REVIEWER"] as const;
export type GateOwner = typeof GATE_OWNERS[number];

export type GateStatusEntry = {
  gate: string;
  /** The candidate commit this entry describes, or null before a candidate is frozen. */
  candidate: string | null;
  owner: GateOwner;
  status: GateStatus;
  /** The kind of evidence cited. SYNTHETIC shows progress; only LIVE evidence can pass a gate. */
  evidenceMode: EvidenceMode | null;
  evidenceRefs: string[];
  testedScope: string;
  /** What makes a PASS stale: any one of these and the gate is run again. */
  invalidatedBy: string[];
  nextAction: string;
};
export type ReleaseStatus = {
  schemaVersion: 1;
  /** The gate the coordinator names as the primary action. Without one the view picks by urgency. */
  primary?: string;
  gates: GateStatusEntry[];
};
export type ReleaseScope = {
  schemaVersion: 1;
  decision: { by: "OWNER"; ref: string; recorded: string };
  /** The frozen release candidate commit, or null while there is none. */
  candidate: string | null;
  /** The admission manifest for the candidate (src/cli/release-admission.ts), or null while there is none. */
  manifest: string | null;
  platforms: string[];
  actPaths: string[];
  journey: "FULL_LIFECYCLE";
  outOfScope: { gate: string; reason: string }[];
};

const COMMIT = /^[0-9a-f]{40}$/;
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown, min = 10): value is string => typeof value === "string" && value.trim().length >= min;
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every((x) => text(x, 1));
const sameSet = (a: readonly string[], b: readonly string[]) => a.length === b.length && new Set(a).size === a.length && b.every((x) => a.includes(x));

/** Gates whose subject the scope names, so the scope cannot exclude them. */
function scopedGate(id: string): boolean {
  return id.startsWith("platform:") || id.startsWith("act:");
}

export function scopeProblems(scope: unknown): string[] {
  if (!isRecord(scope) || scope.schemaVersion !== 1) return ["scope: not a schemaVersion 1 object"];
  const problems: string[] = [];
  const decision = scope.decision;
  if (!isRecord(decision) || decision.by !== "OWNER" || !text(decision.ref) || !/^\d{4}-\d{2}-\d{2}$/.test(String(decision.recorded))) {
    problems.push("scope: decision must name the owner, cite where it was made and give the date");
  }
  if (scope.candidate !== null && !(typeof scope.candidate === "string" && COMMIT.test(scope.candidate))) problems.push("scope: candidate must be a full commit or null");
  if (scope.manifest !== null && !text(scope.manifest, 1)) problems.push("scope: manifest must be a repository path or null");
  if (scope.manifest !== null && scope.candidate === null) problems.push("scope: a manifest needs a frozen candidate");
  if (!strings(scope.platforms) || !sameSet(scope.platforms, RELEASE_PLATFORMS)) problems.push("scope: platforms must be exactly " + RELEASE_PLATFORMS.join(", "));
  if (!strings(scope.actPaths) || !sameSet(scope.actPaths, ACT_RELEASE_PATHS.map(actGateId))) problems.push("scope: actPaths must be exactly " + ACT_RELEASE_PATHS.map(actGateId).join(", "));
  if (scope.journey !== "FULL_LIFECYCLE") problems.push("scope: journey must be FULL_LIFECYCLE");
  if (!Array.isArray(scope.outOfScope)) return [...problems, "scope: outOfScope must be a list"];
  const seen = new Set<string>();
  for (const entry of scope.outOfScope as unknown[]) {
    if (!isRecord(entry) || typeof entry.gate !== "string" || !text(entry.reason)) { problems.push("scope: every exclusion names a gate and why"); continue; }
    if (seen.has(entry.gate)) problems.push("scope: " + entry.gate + " is excluded twice");
    seen.add(entry.gate);
    if (!PRODUCTION_RELEASE_GATES.some((gate) => gate.id === entry.gate)) problems.push("scope: " + entry.gate + " is not a release gate");
    if (scopedGate(entry.gate)) problems.push("scope: " + entry.gate + " is in the scope's own platforms or paths, so it cannot be excluded");
  }
  return problems;
}

/** The scope shipped in this repository. Refuses one that does not check, so nothing downstream acts on a bad scope. */
export function loadReleaseScope(root: string): ReleaseScope {
  const scope = JSON.parse(readFileSync(join(root, "config", "release", "scope.json"), "utf8")) as unknown;
  const problems = scopeProblems(scope);
  if (problems.length > 0) throw new Error("RELEASE_SCOPE_INVALID: " + problems.join("; "));
  return scope as ReleaseScope;
}

export function loadReleaseStatus(root: string): unknown {
  return JSON.parse(readFileSync(join(root, "config", "release", "status.json"), "utf8")) as unknown;
}

export type StatusContext = {
  scope: ReleaseScope;
  /** The admission review of the frozen candidate, when the scope names its manifest. */
  admission?: ReleaseAdmissionReport;
  /** The journey matrix rows (checkJourneyMatrix). */
  journeys: RowReport[];
};

/** Checks every status entry against the gates, the scope, the admission review and the journey matrix. */
export function statusProblems(status: unknown, context: StatusContext): string[] {
  if (!isRecord(status) || status.schemaVersion !== 1 || !Array.isArray(status.gates)) return ["status: not a schemaVersion 1 object with gates"];
  const problems: string[] = [];
  const { scope, admission } = context;
  const excluded = new Set(scope.outOfScope.map((x) => x.gate));
  const entries = status.gates as unknown[];
  const ids = entries.map((x) => isRecord(x) ? x.gate : undefined);
  const order = PRODUCTION_RELEASE_GATES.map((gate) => gate.id);
  if (ids.length !== order.length || ids.some((id, i) => id !== order[i])) {
    problems.push("status: gates must list every release gate once, in the admission order: " + order.join(", "));
  }
  for (const raw of entries) {
    if (!isRecord(raw) || typeof raw.gate !== "string") continue;
    const entry = raw as GateStatusEntry;
    const at = entry.gate + ": ";
    if (!GATE_STATUSES.includes(entry.status)) { problems.push(at + "status must be one of " + GATE_STATUSES.join(", ")); continue; }
    if (!GATE_OWNERS.includes(entry.owner)) problems.push(at + "owner must be one of " + GATE_OWNERS.join(", "));
    if (entry.evidenceMode !== null && !EVIDENCE_MODES.includes(entry.evidenceMode)) problems.push(at + "evidenceMode must be SYNTHETIC, LIVE or null");
    if (!Array.isArray(entry.evidenceRefs) || !entry.evidenceRefs.every((x) => text(x, 1))) problems.push(at + "evidenceRefs must be a list of references");
    else if ((entry.evidenceMode === null) !== (entry.evidenceRefs.length === 0)) problems.push(at + "evidence references and their mode go together");
    if (!text(entry.testedScope)) problems.push(at + "testedScope must say what was or will be tested");
    if (!strings(entry.invalidatedBy) || entry.invalidatedBy.length === 0) problems.push(at + "invalidatedBy must name what makes a pass stale");
    if (entry.status !== "PASS" && entry.status !== "OUT_OF_SCOPE" && !text(entry.nextAction)) problems.push(at + "nextAction must say what happens next");
    if (entry.candidate !== null && !(typeof entry.candidate === "string" && COMMIT.test(entry.candidate))) problems.push(at + "candidate must be a full commit or null");
    if (entry.candidate !== null && entry.candidate !== scope.candidate) problems.push(at + "names a candidate other than the frozen one, so it is stale");

    if ((entry.status === "OUT_OF_SCOPE") !== excluded.has(entry.gate)) {
      problems.push(at + (excluded.has(entry.gate) ? "the owner's scope excludes this gate, so its status is OUT_OF_SCOPE" : "OUT_OF_SCOPE needs the owner's scope to exclude this gate"));
    }
    if (entry.status === "PASS") problems.push(...passProblems(entry, context).map((x) => at + x));
  }
  if (status.primary !== undefined) {
    const named = entries.find((x) => isRecord(x) && x.gate === status.primary) as GateStatusEntry | undefined;
    if (named === undefined || named.status === "PASS" || named.status === "OUT_OF_SCOPE") problems.push("status: primary must name an in-scope gate that has not passed");
  }
  if (admission !== undefined && admission.sourceCommit !== scope.candidate) problems.push("status: the admission review is for another commit than the frozen candidate");
  return problems;
}

/** A PASS is only what the admission review and, for an ACT path, the journey matrix can show for the frozen candidate. */
function passProblems(entry: GateStatusEntry, { scope, admission, journeys }: StatusContext): string[] {
  const problems: string[] = [];
  if (scope.candidate === null || entry.candidate !== scope.candidate) problems.push("PASS needs a frozen candidate, named on the entry");
  if (entry.evidenceMode !== "LIVE") problems.push("PASS needs LIVE evidence; synthetic evidence never passes a release gate");
  const review = admission?.gates.find((gate) => gate.id === entry.gate);
  if (review?.status !== "EVIDENCE_PRESENT") problems.push("PASS needs the admission review of the candidate to find this gate's evidence");
  else if (!entry.evidenceRefs.some((ref) => ref.includes(review.evidenceSha256 ?? "-"))) problems.push("PASS must cite the evidence hash the admission review checked");
  const path = ACT_RELEASE_PATHS.find((x) => actGateId(x) === entry.gate);
  if (path !== undefined) {
    const row = journeys.find((x) => x.cloud === path.provider && x.path === path.engine);
    if (row === undefined || !row.implemented || row.live !== "LIVE_PASS") {
      problems.push("PASS needs the " + path.provider + " " + path.engine + " journey row implemented through cleanup and live (full-lifecycle scope)");
    }
  }
  return problems;
}

const MODE_WORDS: Record<ReleaseGateMode, string> = {
  CI: "CI", PRIVATE_MODEL: "private model", LIVE_PROVIDER: "live provider", LIVE_PREVIEW: "live preview",
  ISOLATED_RECOVERY: "isolated recovery", LIFECYCLE: "lifecycle", SECURITY_SCAN: "security scan", LIVE_METRIC: "live metric",
  LIVE_ACT: "live ACT", ACT_RECOVERY: "ACT recovery", INDEPENDENT_REVIEW: "independent review",
};
/** Without a named primary, the view picks a failure first, then work in progress, then what can run now, then what is blocked. */
const URGENCY: readonly GateStatus[] = ["FAIL", "RUNNING", "NOT_RUN", "BLOCKED"];

/** The compact release view (docs/release-status.md), from a status that has already been checked. */
export function renderReleaseStatus(status: ReleaseStatus, scope: ReleaseScope): string {
  const mode = new Map(PRODUCTION_RELEASE_GATES.map((gate) => [gate.id, MODE_WORDS[gate.mode]]));
  const cell = (value: string) => value.replaceAll("|", "\\|").replaceAll("\n", " ");
  const inScope = status.gates.filter((x) => x.status !== "OUT_OF_SCOPE");
  const ready = inScope.filter((x) => x.status === "PASS");
  const attention = inScope.filter((x) => x.status === "FAIL" || x.status === "BLOCKED" || x.status === "RUNNING");
  const notQualified = inScope.filter((x) => x.status === "NOT_RUN");
  const excluded = status.gates.filter((x) => x.status === "OUT_OF_SCOPE");
  const reasons = new Map(scope.outOfScope.map((x) => [x.gate, x.reason]));
  const primary = inScope.find((x) => x.gate === status.primary && x.status !== "PASS") ??
    URGENCY.map((s) => inScope.find((x) => x.status === s)).find((x) => x !== undefined);
  const synthetic = (x: GateStatusEntry) => x.evidenceMode === "SYNTHETIC" ? " Synthetic progress only: " + x.evidenceRefs.join(", ") + "." : "";
  const table = (rows: GateStatusEntry[], withStatus: boolean) => rows.length === 0 ? ["None."] : [
    "| Gate | Kind |" + (withStatus ? " Status |" : "") + " Owner | Next action |",
    "| --- | --- |" + (withStatus ? " --- |" : "") + " --- | --- |",
    ...rows.map((x) => "| `" + x.gate + "` | " + mode.get(x.gate) + " |" + (withStatus ? " " + x.status + " |" : "") + " " + x.owner + " | " + cell(x.nextAction + synthetic(x)) + " |"),
  ];
  return [
    "# Release status",
    "",
    "<!-- Generated by `npm run docs:release` from config/release/scope.json and config/release/status.json. Do not edit by hand. -->",
    "",
    "**Candidate:** " + (scope.candidate === null ? "none frozen yet." : "`" + scope.candidate + "`."),
    "",
    "**Golden release:** " + (ready.length === inScope.length && inScope.length > 0 ? "every in-scope gate passes; independent release review and the owner decide." : "not ready. " + ready.length + " of " + inScope.length + " in-scope gates pass."),
    "",
    "**Scope:** " + scope.platforms.join(", ") + "; ACT paths " + scope.actPaths.join(", ") + "; full lifecycle. Decided by the owner (" + scope.decision.ref + ", recorded " + scope.decision.recorded + ").",
    "",
    "## Ready (" + ready.length + ")",
    "",
    ...(ready.length === 0 ? ["None."] : ready.map((x) => "- `" + x.gate + "`: " + x.testedScope + " (" + x.evidenceRefs.join(", ") + ")")),
    "",
    "## Needs attention (" + attention.length + ")",
    "",
    ...table(attention, true),
    "",
    "## Not qualified (" + notQualified.length + ")",
    "",
    ...table(notQualified, false),
    "",
    "## Out of scope (" + excluded.length + ")",
    "",
    ...(excluded.length === 0 ? ["None."] : excluded.map((x) => "- `" + x.gate + "`: " + reasons.get(x.gate))),
    "",
    "## Primary action",
    "",
    primary === undefined ? "None. Hand the candidate to independent release review." : "`" + primary.gate + "` (" + primary.owner + "): " + primary.nextAction,
    "",
  ].join("\n");
}
