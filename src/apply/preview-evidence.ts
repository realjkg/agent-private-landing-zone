import { previewScenarioOf, type PreviewGateScenario } from "../qualification/release-admission.js";
import { canonicalJson } from "../teardown/manifest.js";
import { sha256 } from "../util/sha256.js";
import { COMMIT, HASH } from "./constants.js";
import { engineOf } from "./engine-spec.js";
import { pilotContractSha256 } from "./contract.js";
import { specOf } from "./provider.js";
import type { ApplyEnvironment, PilotChannel, PilotContract, PlanChange, ProviderId, SealedPlan } from "./types.js";

/**
 * The product-owned producer of a `preview:<scenario>` release gate's evidence (src/qualification/release-admission.ts,
 * mode LIVE_PREVIEW): what a sealed preview (`./alz apply seal`) proves about one exact provider, IaC engine and estate,
 * bound to the product source commit, the engine program that ran and the plan bytes it produced, with nothing applied.
 *
 * It calls the evidence LIVE only when every live condition holds and the person who ran the preview attests, as in
 * `record-live`, that it ran the pinned, qualified engine against the real target. Otherwise it writes the same document
 * labeled SYNTHETIC with the conditions that failed in words, and the live gate refuses it: a fake engine, a test, a
 * rehearsal, an unqualified program, a plan from another commit, or a plan whose estate is not the scenario's never closes
 * the gate, and adding a scenario name or a fixture never does either. The validator derives the label from the conditions,
 * so a synthetic document relabeled by hand is refused.
 *
 * Identifiers and hashes only: no plan value, state, output or credential.
 */
export const PREVIEW_EVIDENCE_VERSION = 1;
export type PreviewLiveConditions = {
  /** The person who ran the preview typed the attestation; without it nothing here is live. */
  attested: boolean;
  /** The sealed plan was made from the product commit that produces this evidence. */
  sourceCommitMatches: boolean;
  /** Real-engine qualification evidence covers the engine program, version and preview adapter that sealed the plan. */
  engineQualified: boolean;
  /** The engine program on this machine is the one that made the preview. */
  engineProgramUnchanged: boolean;
  /** The plan's estate is the scenario's: a brownfield preview touches pre-existing resources, a greenfield one creates only. */
  estateMatchesPlan: boolean;
  /** The host the preview ran on is named, not UNKNOWN. */
  targetHardwareKnown: boolean;
};
export type PreviewGateEvidence = {
  schemaVersion: 1;
  reportKind: "PREVIEW_GATE";
  gateVersion: typeof PREVIEW_EVIDENCE_VERSION;
  gateId: string;
  /** LIVE_PREVIEW only when the label is LIVE; the admission review checks the mode against the gate's. */
  executionMode: "LIVE_PREVIEW" | "SYNTHETIC_PREVIEW";
  /** Derived from `liveConditions`: LIVE when every condition holds, SYNTHETIC otherwise. Never a caller's claim. */
  label: "LIVE" | "SYNTHETIC";
  /** Present exactly when the label is SYNTHETIC, so every live gate's generic check refuses it too. */
  simulation?: true;
  scenario: string;
  provider: ProviderId;
  engine: string;
  estate: PreviewGateScenario["estate"];
  sourceCommit: string;
  targetHardwareId: string;
  /** Derived: true exactly when the label is LIVE. */
  passed: boolean;
  actEnabled: false;
  mutationObserved: false;
  previewExecuted: true;
  infrastructureApplied: false;
  /** SHA-256 of the engine's plan bytes the seal stored: the real tool output this gate is about. */
  toolOutputHash: string;
  artifactSha256: string;
  manifestHash: string;
  releaseIdentity: string;
  engineVersion: string;
  engineProgramSha256: string;
  qualification: SealedPlan["provenance"]["qualification"];
  environment: ApplyEnvironment;
  target: SealedPlan["target"];
  contractSha256: string;
  channel: PilotChannel;
  /** The sealed, redacted change list counted by action: addresses and values never leave the seal. */
  changes: { total: number; create: number; preExistingTouched: number; byAction: Record<string, number> };
  liveConditions: PreviewLiveConditions;
  /** The failed conditions in words; empty exactly when the label is LIVE. */
  reasons: string[];
  attestation: { attestedBy: string; attestedAt: string } | null;
  checks: { name: string; passed: true; evidenceSha256: string }[];
  generatedAt: string;
};

export type PreviewEvidenceInput = {
  sealed: SealedPlan;
  gateId: string;
  /** The product commit this producer runs from, or undefined when it could not be established. */
  sourceCommit: string | undefined;
  targetHardwareId: string;
  /** SHA-256 of the engine program on this machine now, or undefined when it cannot be read. */
  engineProgramSha256Now: string | undefined;
  contract: PilotContract;
  /** The person who attests the preview ran against the real target, or null: the evidence is then SYNTHETIC. */
  attestedBy: string | null;
  now: Date;
};
export type PreviewEvidenceRefusal = { ok: false; code: "GATE_UNKNOWN" | "SCENARIO_MISMATCH" | "CONTRACT_MISMATCH"; message: string };

const ENGINE_NAMES: Readonly<Record<string, string>> = { TERRAFORM: "TERRAFORM", CDK: "AWS_CDK" };
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const hashText = (value: unknown): value is string => typeof value === "string" && HASH.test(value);

/** What the plan touched, counted by action, and how many resources existed before it (anything but a create). */
export function countChanges(changes: readonly PlanChange[]): PreviewGateEvidence["changes"] {
  const resources = changes.filter((change) => change.type !== "output");
  const byAction: Record<string, number> = {};
  for (const change of resources) byAction[change.action] = (byAction[change.action] ?? 0) + 1;
  return { total: resources.length, create: byAction.CREATE ?? 0, preExistingTouched: resources.filter((change) => change.action !== "CREATE").length, byAction };
}

const REASONS: Readonly<Record<keyof PreviewLiveConditions, string>> = {
  attested: "no person attested that this preview ran the pinned engine against the real target; a fake engine, a test or a rehearsal writes the same records",
  sourceCommitMatches: "the sealed plan was made from another product commit than the one producing this evidence",
  engineQualified: "no real-engine qualification evidence covers the engine program, version and preview adapter that sealed this plan",
  engineProgramUnchanged: "the engine program on this machine is not the one that made the preview",
  estateMatchesPlan: "the plan's estate is not the scenario's (a brownfield preview touches at least one pre-existing resource; a greenfield preview creates only)",
  targetHardwareKnown: "the host this preview ran on is not named",
};

/** Builds the gate evidence for one sealed preview, or says why the gate and the plan do not belong together. Reads no cloud and runs no engine. */
export function buildPreviewGateEvidence(input: PreviewEvidenceInput): { ok: true; evidence: PreviewGateEvidence } | PreviewEvidenceRefusal {
  const { sealed, contract } = input;
  const scenario = previewScenarioOf(input.gateId);
  if (!scenario) return { ok: false, code: "GATE_UNKNOWN", message: input.gateId + " is not a preview release gate. Nothing was written." };
  const engine = ENGINE_NAMES[contract.engine] ?? contract.engine;
  if (scenario.provider !== contract.provider || scenario.engine !== engine) {
    return { ok: false, code: "SCENARIO_MISMATCH", message: input.gateId + " is about " + scenario.provider + " " + scenario.engine + "; this sealed plan was made under a " + contract.provider + " " + engine +
      " contract. Evidence of one provider or engine never qualifies another. Nothing was written." };
  }
  if (sealed.contractSha256 !== pilotContractSha256(contract)) return { ok: false, code: "CONTRACT_MISMATCH", message: "The sealed plan was made under another pilot contract than the one pinned now. Nothing was written." };
  const changes = countChanges(sealed.changes);
  const liveConditions: PreviewLiveConditions = {
    attested: input.attestedBy !== null,
    sourceCommitMatches: input.sourceCommit !== undefined && COMMIT.test(input.sourceCommit) && sealed.sourceCommit === input.sourceCommit,
    engineQualified: sealed.provenance.qualification.state === "QUALIFIED",
    engineProgramUnchanged: input.engineProgramSha256Now !== undefined && input.engineProgramSha256Now === sealed.provenance.engineBinarySha256,
    estateMatchesPlan: scenario.estate === "brownfield" ? changes.preExistingTouched > 0 : changes.total > 0 && changes.preExistingTouched === 0,
    targetHardwareKnown: input.targetHardwareId.trim() !== "" && input.targetHardwareId !== "UNKNOWN",
  };
  const reasons = (Object.keys(REASONS) as (keyof PreviewLiveConditions)[]).filter((key) => !liveConditions[key]).map((key) => REASONS[key]);
  const live = reasons.length === 0;
  const qualification = sealed.provenance.qualification;
  const evidence: PreviewGateEvidence = {
    schemaVersion: 1, reportKind: "PREVIEW_GATE", gateVersion: PREVIEW_EVIDENCE_VERSION, gateId: input.gateId, executionMode: live ? "LIVE_PREVIEW" : "SYNTHETIC_PREVIEW", label: live ? "LIVE" : "SYNTHETIC",
    ...(live ? {} : { simulation: true as const }),
    scenario: input.gateId.slice("preview:".length), provider: specOf(contract).id as ProviderId, engine: engineOf(contract).id === "CDK" ? "AWS_CDK" : engineOf(contract).id, estate: scenario.estate,
    sourceCommit: sealed.sourceCommit, targetHardwareId: input.targetHardwareId, passed: live, actEnabled: false, mutationObserved: false, previewExecuted: true, infrastructureApplied: false,
    toolOutputHash: sealed.planSha256, artifactSha256: sealed.artifactSha256, manifestHash: sealed.manifestHash, releaseIdentity: sealed.releaseIdentity, engineVersion: sealed.engineVersion,
    engineProgramSha256: sealed.provenance.engineBinarySha256, qualification: { ...qualification }, environment: sealed.environment, target: { ...sealed.target }, contractSha256: sealed.contractSha256,
    channel: sealed.channel, changes, liveConditions, reasons,
    attestation: input.attestedBy === null ? null : { attestedBy: input.attestedBy, attestedAt: input.now.toISOString() },
    checks: [
      { name: "sealed-artifact", passed: true, evidenceSha256: sealed.artifactSha256 },
      { name: "plan-output", passed: true, evidenceSha256: sealed.planSha256 },
      { name: "project-manifest", passed: true, evidenceSha256: sealed.manifestHash },
      { name: "pilot-contract", passed: true, evidenceSha256: sealed.contractSha256 },
      ...(qualification.state === "QUALIFIED" ? [{ name: "engine-qualification", passed: true as const, evidenceSha256: qualification.evidenceHash }] : []),
    ],
    generatedAt: input.now.toISOString(),
  };
  return { ok: true, evidence };
}

const KEYS = ["schemaVersion", "reportKind", "gateVersion", "gateId", "executionMode", "label", "simulation", "scenario", "provider", "engine", "estate", "sourceCommit", "targetHardwareId", "passed",
  "actEnabled", "mutationObserved", "previewExecuted", "infrastructureApplied", "toolOutputHash", "artifactSha256", "manifestHash", "releaseIdentity", "engineVersion", "engineProgramSha256",
  "qualification", "environment", "target", "contractSha256", "channel", "changes", "liveConditions", "reasons", "attestation", "checks", "generatedAt"];
const CONDITIONS = Object.keys(REASONS).sort().join();
const RAW_KEY = /^(values|attributes|properties|state|plan|stdout|stderr|output|credentials|secret|token|password|signature)$/i;

/**
 * Every reason a document is not valid preview-gate evidence. Empty means it is. The label, mode, `passed`, `simulation` and
 * `reasons` are recomputed from `liveConditions`, the scenario fields from the gate id, and a document that claims more than
 * its conditions show is refused: a relabeled synthetic preview never reads as live.
 */
export function previewGateEvidenceProblems(value: unknown, expected: { sourceCommit?: string; gateId?: string } = {}): string[] {
  if (!isRecord(value)) return ["preview evidence: expected an object"];
  const problems: string[] = [];
  for (const key of Object.keys(value)) if (!KEYS.includes(key)) problems.push("preview evidence." + key + (RAW_KEY.test(key) ? ": raw plan, output or secret field" : ": not part of the evidence"));
  for (const key of KEYS) if (key !== "simulation" && !Object.hasOwn(value, key)) problems.push("preview evidence." + key + ": missing");
  if (problems.length > 0) return problems;
  if (value.schemaVersion !== 1 || value.reportKind !== "PREVIEW_GATE" || value.gateVersion !== PREVIEW_EVIDENCE_VERSION) problems.push("preview evidence: not a schemaVersion 1 PREVIEW_GATE document of gate version " + PREVIEW_EVIDENCE_VERSION);
  const scenario = typeof value.gateId === "string" ? previewScenarioOf(value.gateId) : undefined;
  if (!scenario) problems.push("preview evidence.gateId: not a preview release gate");
  else if (value.scenario !== (value.gateId as string).slice("preview:".length) || value.provider !== scenario.provider || value.engine !== scenario.engine || value.estate !== scenario.estate) {
    problems.push("preview evidence: scenario, provider, engine or estate does not match the gate");
  }
  if (expected.gateId !== undefined && value.gateId !== expected.gateId) problems.push("preview evidence.gateId: not the expected gate");
  if (typeof value.sourceCommit !== "string" || !COMMIT.test(value.sourceCommit)) problems.push("preview evidence.sourceCommit: not a commit id");
  if (expected.sourceCommit !== undefined && value.sourceCommit !== expected.sourceCommit) problems.push("preview evidence.sourceCommit: not the expected source commit");
  if (typeof value.targetHardwareId !== "string" || value.targetHardwareId.trim() === "") problems.push("preview evidence.targetHardwareId: malformed");
  const conditions = value.liveConditions;
  if (!isRecord(conditions) || Object.keys(conditions).sort().join() !== CONDITIONS || !Object.values(conditions).every((x) => typeof x === "boolean")) {
    problems.push("preview evidence.liveConditions: exactly " + CONDITIONS.replaceAll(",", ", ") + ", each a boolean");
  } else {
    const live = Object.values(conditions).every((x) => x === true);
    if (value.label !== (live ? "LIVE" : "SYNTHETIC")) problems.push("preview evidence.label: not derived from liveConditions (a declaration never counts)");
    if (value.executionMode !== (live ? "LIVE_PREVIEW" : "SYNTHETIC_PREVIEW")) problems.push("preview evidence.executionMode: not derived from the label");
    if (value.passed !== live) problems.push("preview evidence.passed: not derived from the label");
    if ((value.simulation === true) !== !live || (value.simulation !== undefined && value.simulation !== true)) problems.push("preview evidence.simulation: present exactly when the label is SYNTHETIC");
    if (!Array.isArray(value.reasons) || !value.reasons.every((x) => typeof x === "string") || (value.reasons.length === 0) !== live) problems.push("preview evidence.reasons: the failed conditions in words, empty exactly when LIVE");
    if (conditions.targetHardwareKnown === true && value.targetHardwareId === "UNKNOWN") problems.push("preview evidence.liveConditions.targetHardwareKnown: the host is UNKNOWN");
    const attestation = value.attestation;
    if ((attestation !== null) !== conditions.attested || (attestation !== null && (!isRecord(attestation) || typeof attestation.attestedBy !== "string" || attestation.attestedBy === "" || typeof attestation.attestedAt !== "string"))) {
      problems.push("preview evidence.attestation: present with a name exactly when attested");
    }
    const qualification = value.qualification;
    if (!isRecord(qualification) || (qualification.state !== "QUALIFIED" && qualification.state !== "UNQUALIFIED") || (qualification.state === "QUALIFIED") !== conditions.engineQualified ||
      (qualification.state === "QUALIFIED" && !hashText(qualification.evidenceHash))) problems.push("preview evidence.qualification: QUALIFIED with its evidence hash exactly when engineQualified");
  }
  if (value.actEnabled !== false || value.mutationObserved !== false || value.previewExecuted !== true || value.infrastructureApplied !== false) problems.push("preview evidence: a preview applies nothing");
  if (![value.toolOutputHash, value.artifactSha256, value.manifestHash, value.releaseIdentity, value.engineProgramSha256, value.contractSha256].every(hashText)) problems.push("preview evidence: a hash is not a SHA-256 digest");
  if (typeof value.engineVersion !== "string" || value.engineVersion === "") problems.push("preview evidence.engineVersion: malformed");
  if (!["DEV", "QA", "PROD"].includes(value.environment as string) || !["CLI", "UI"].includes(value.channel as string)) problems.push("preview evidence: environment or channel is unknown");
  const target = value.target;
  if (!isRecord(target) || Object.keys(target).sort().join() !== "account,backend,workspace" || !["account", "backend", "workspace"].every((key) => typeof target[key] === "string" && target[key] !== "")) problems.push("preview evidence.target: malformed");
  const changes = value.changes;
  if (!isRecord(changes) || Object.keys(changes).sort().join() !== "byAction,create,preExistingTouched,total" || !isRecord(changes.byAction) ||
    !Object.values(changes.byAction).every((n) => typeof n === "number" && Number.isInteger(n) && n >= 0) || typeof changes.total !== "number" || typeof changes.create !== "number" || typeof changes.preExistingTouched !== "number" ||
    (Object.values(changes.byAction) as number[]).reduce((a, b) => a + b, 0) !== changes.total || (changes.byAction.CREATE ?? 0) !== changes.create || changes.total - changes.create !== changes.preExistingTouched) {
    problems.push("preview evidence.changes: counts by action that add up");
  }
  if (!Array.isArray(value.checks) || value.checks.length === 0 || !value.checks.every((c) => isRecord(c) && Object.keys(c).sort().join() === "evidenceSha256,name,passed" && typeof c.name === "string" && c.passed === true && hashText(c.evidenceSha256))) {
    problems.push("preview evidence.checks: each names what it checked and the hash it rests on");
  }
  if (typeof value.generatedAt !== "string" || Number.isNaN(Date.parse(value.generatedAt))) problems.push("preview evidence.generatedAt: malformed");
  return problems;
}

/** The canonical digest of a written evidence document: what the admission manifest's record cites. */
export const previewEvidenceSha256 = (bytes: string | Buffer): string => sha256(typeof bytes === "string" ? Buffer.from(bytes) : bytes);

/** The admission manifest record for one written evidence file (src/qualification/release-admission.ts `ReleaseGateSubmission`). */
export function admissionRecordOf(evidence: PreviewGateEvidence, evidencePath: string, bytes: string): { id: string; mode: "LIVE_PREVIEW"; sourceCommit: string; targetHardwareId: string; evidencePath: string; evidenceSha256: string } {
  return { id: evidence.gateId, mode: "LIVE_PREVIEW", sourceCommit: evidence.sourceCommit, targetHardwareId: evidence.targetHardwareId, evidencePath, evidenceSha256: previewEvidenceSha256(bytes) };
}

/** The canonical digest of the evidence itself, independent of how the file was formatted. */
export const previewEvidenceIdentity = (evidence: PreviewGateEvidence): string => sha256(canonicalJson(evidence as never));
