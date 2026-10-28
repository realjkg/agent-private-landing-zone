import type { ApplyEnvironment, PilotChannel, ProviderId, SealedPlan } from "../apply/types.js";
import { COMMIT, HASH } from "../apply/constants.js";
import { PHASE_E_SCENARIOS } from "./phase-e.js";

/**
 * The preview release gates' contract, shared by the producer (src/apply/preview-evidence.ts) and the admission review
 * (src/qualification/release-admission.ts): what each `preview:<id>` gate is about, the shape of its evidence, and the
 * validator that derives the evidence's label from its live conditions. One module, so the review enforces exactly what
 * the producer promises and neither imports the other.
 */
/**
 * What each `preview:<id>` gate is about, so its evidence is bound to the exact provider, IaC engine and estate: the Phase E
 * scenarios (src/qualification/phase-e.ts) and the Pulumi permutations that have no Phase E lane. Terraform evidence never
 * qualifies the CDK gate, an AWS preview never the Azure one, a greenfield plan never a brownfield gate.
 */
/**
 * `provider` may also be "GCP" (path 5; owner approval 6433121154 on issue #39): GCP Terraform is admitted in code for DEV only, so a
 * GCP contract can seal a plan this gate's evidence is made from (`buildPreviewGateEvidence` refuses any other provider's plan as
 * SCENARIO_MISMATCH). It is not a Phase E scenario: Phase E has no GCP discovery yet (PLAN S5).
 */
export type PreviewGateScenario = { provider: ProviderId | "GCP"; engine: string; estate: "brownfield" | "greenfield" };
const ESTATES: readonly PreviewGateScenario["estate"][] = ["brownfield", "greenfield"];
const PROVIDERS: readonly ProviderId[] = ["AWS", "AZURE"];
/** A Phase E scenario's estate and provider, checked: a scenario with any other mock or provider is not a preview gate and throws, so nothing binds silently. */
export function previewGateScenarioOf(scenario: { id: string; provider: string; engine: string; mock: string }): PreviewGateScenario {
  if (!(ESTATES as readonly string[]).includes(scenario.mock)) throw new Error("PREVIEW_GATE_ESTATE_UNKNOWN: " + scenario.id + " has mock " + scenario.mock + "; a preview gate is brownfield or greenfield");
  if (!(PROVIDERS as readonly string[]).includes(scenario.provider)) throw new Error("PREVIEW_GATE_PROVIDER_UNKNOWN: " + scenario.id + " names provider " + scenario.provider);
  return { provider: scenario.provider as ProviderId, engine: scenario.engine, estate: scenario.mock as PreviewGateScenario["estate"] };
}
export const PREVIEW_GATE_SCENARIOS: Readonly<Record<string, PreviewGateScenario>> = {
  ...Object.fromEntries(PHASE_E_SCENARIOS.map((scenario) => [scenario.id, previewGateScenarioOf(scenario)])),
  "pulumi-aws-greenfield": { provider: "AWS", engine: "PULUMI", estate: "greenfield" },
  "pulumi-aws-brownfield": { provider: "AWS", engine: "PULUMI", estate: "brownfield" },
  "pulumi-azure-brownfield": { provider: "AZURE", engine: "PULUMI", estate: "brownfield" },
  "terraform-gcp-brownfield": { provider: "GCP", engine: "TERRAFORM", estate: "brownfield" },
};
/** The scenario a `preview:<id>` gate is about, or undefined for any other gate id. */
export const previewScenarioOf = (gateId: string): PreviewGateScenario | undefined => gateId.startsWith("preview:") ? PREVIEW_GATE_SCENARIOS[gateId.slice("preview:".length)] : undefined;

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

export const LIVE_CONDITION_REASONS: Readonly<Record<keyof PreviewLiveConditions, string>> = {
  attested: "no person attested that this preview ran the pinned engine against the real target; a fake engine, a test or a rehearsal writes the same records",
  sourceCommitMatches: "the sealed plan was made from another product commit than the one producing this evidence",
  engineQualified: "no real-engine qualification evidence covers the engine program, version and preview adapter that sealed this plan",
  engineProgramUnchanged: "the engine program on this machine is not the one that made the preview",
  estateMatchesPlan: "the plan's estate is not the scenario's (a brownfield preview touches at least one pre-existing resource; a greenfield preview creates only)",
  targetHardwareKnown: "the host this preview ran on is not named",
};

/**
 * The change actions a preview gate's change set may hold (docs/production-release-admission.md, gate 4: "no unauthorized updates,
 * adoption, delete, replacement or infrastructure apply"). A create, an update or an adoption (import) of a resource, a data read
 * and a no-op are what a reviewed preview is about; a delete, a replacement (unconditional or conditional), a forget (a resource
 * dropped from state unreviewed), a dynamic or unknown action, or anything else never is, whatever the label says. The list is
 * closed: an action not named here is refused, so a new engine vocabulary fails closed until it is reviewed here.
 */
export const PREVIEW_GATE_ACTIONS: readonly string[] = Object.freeze(["CREATE", "UPDATE", "IMPORT", "READ", "SAME"]);
/** The actions in a counted change list that a preview gate never admits, with their counts, as "DELETE: 2"; empty when every action is admitted. */
export function unauthorizedPreviewActions(byAction: Readonly<Record<string, number>>): string[] {
  return Object.entries(byAction).filter(([action, count]) => count > 0 && !PREVIEW_GATE_ACTIONS.includes(action)).map(([action, count]) => action + ": " + count).sort();
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const hashText = (value: unknown): value is string => typeof value === "string" && HASH.test(value);
const KEYS = ["schemaVersion", "reportKind", "gateVersion", "gateId", "executionMode", "label", "simulation", "scenario", "provider", "engine", "estate", "sourceCommit", "targetHardwareId", "passed",
  "actEnabled", "mutationObserved", "previewExecuted", "infrastructureApplied", "toolOutputHash", "artifactSha256", "manifestHash", "releaseIdentity", "engineVersion", "engineProgramSha256",
  "qualification", "environment", "target", "contractSha256", "channel", "changes", "liveConditions", "reasons", "attestation", "checks", "generatedAt"];
const CONDITIONS = Object.keys(LIVE_CONDITION_REASONS).sort().join();
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
  } else {
    // The documented rule, enforced on the evidence itself so a document relabeled by hand never reads as admissible: a delete,
    // a replacement or an unreviewed action in the change set is refused whatever the label and the conditions say.
    const unauthorized = unauthorizedPreviewActions(changes.byAction as Record<string, number>);
    if (unauthorized.length > 0) problems.push("preview evidence.changes: a delete, a replacement or an unreviewed action is never admitted (" + unauthorized.join(", ") + ")");
  }
  if (!Array.isArray(value.checks) || value.checks.length === 0 || !value.checks.every((c) => isRecord(c) && Object.keys(c).sort().join() === "evidenceSha256,name,passed" && typeof c.name === "string" && c.passed === true && hashText(c.evidenceSha256))) {
    problems.push("preview evidence.checks: each names what it checked and the hash it rests on");
  }
  if (typeof value.generatedAt !== "string" || Number.isNaN(Date.parse(value.generatedAt))) problems.push("preview evidence.generatedAt: malformed");
  return problems;
}

