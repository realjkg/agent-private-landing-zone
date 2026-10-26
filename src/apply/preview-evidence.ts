import { LIVE_CONDITION_REASONS, previewScenarioOf, PREVIEW_EVIDENCE_VERSION, unauthorizedPreviewActions, type PreviewGateEvidence, type PreviewLiveConditions } from "../qualification/preview-gate.js";
import { canonicalJson } from "../teardown/manifest.js";
import { sha256 } from "../util/sha256.js";
import { COMMIT } from "./constants.js";
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
export { PREVIEW_EVIDENCE_VERSION, previewGateEvidenceProblems, type PreviewGateEvidence, type PreviewLiveConditions } from "../qualification/preview-gate.js";
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
export type PreviewEvidenceRefusal = { ok: false; code: "GATE_UNKNOWN" | "SCENARIO_MISMATCH" | "CONTRACT_MISMATCH" | "CHANGES_UNAUTHORIZED"; message: string };

const ENGINE_NAMES: Readonly<Record<string, string>> = { TERRAFORM: "TERRAFORM", CDK: "AWS_CDK" };

/** What the plan touched, counted by action, and how many resources existed before it (anything but a create). */
export function countChanges(changes: readonly PlanChange[]): PreviewGateEvidence["changes"] {
  const resources = changes.filter((change) => change.type !== "output");
  const byAction: Record<string, number> = {};
  for (const change of resources) byAction[change.action] = (byAction[change.action] ?? 0) + 1;
  return { total: resources.length, create: byAction.CREATE ?? 0, preExistingTouched: resources.filter((change) => change.action !== "CREATE").length, byAction };
}

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
  // The documented rule (docs/production-release-admission.md, gate 4): a change set with a delete, a replacement or an unreviewed
  // action is not preview-gate evidence at all, LIVE or SYNTHETIC; it is refused before any attestation is asked for, and the
  // validator refuses the same document at admission (src/qualification/preview-gate.ts, PREVIEW_GATE_ACTIONS).
  const unauthorized = unauthorizedPreviewActions(changes.byAction);
  if (unauthorized.length > 0) {
    return { ok: false, code: "CHANGES_UNAUTHORIZED", message: "The sealed change set holds an action a preview gate never admits (" + unauthorized.join(", ") +
      "): a delete, a replacement or an unreviewed action is not evidence for " + input.gateId + ", whatever a person attests. Nothing was written." };
  }
  const liveConditions: PreviewLiveConditions = {
    attested: input.attestedBy !== null,
    sourceCommitMatches: input.sourceCommit !== undefined && COMMIT.test(input.sourceCommit) && sealed.sourceCommit === input.sourceCommit,
    engineQualified: sealed.provenance.qualification.state === "QUALIFIED",
    engineProgramUnchanged: input.engineProgramSha256Now !== undefined && input.engineProgramSha256Now === sealed.provenance.engineBinarySha256,
    estateMatchesPlan: scenario.estate === "brownfield" ? changes.preExistingTouched > 0 : changes.total > 0 && changes.preExistingTouched === 0,
    targetHardwareKnown: input.targetHardwareId.trim() !== "" && input.targetHardwareId !== "UNKNOWN",
  };
  const reasons = (Object.keys(LIVE_CONDITION_REASONS) as (keyof PreviewLiveConditions)[]).filter((key) => !liveConditions[key]).map((key) => LIVE_CONDITION_REASONS[key]);
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

/** The canonical digest of a written evidence document: what the admission manifest's record cites. */
export const previewEvidenceSha256 = (bytes: string | Buffer): string => sha256(typeof bytes === "string" ? Buffer.from(bytes) : bytes);

/** The admission manifest record for one written evidence file (src/qualification/release-admission.ts `ReleaseGateSubmission`). */
export function admissionRecordOf(evidence: PreviewGateEvidence, evidencePath: string, bytes: string): { id: string; mode: "LIVE_PREVIEW"; sourceCommit: string; targetHardwareId: string; evidencePath: string; evidenceSha256: string } {
  return { id: evidence.gateId, mode: "LIVE_PREVIEW", sourceCommit: evidence.sourceCommit, targetHardwareId: evidence.targetHardwareId, evidencePath, evidenceSha256: previewEvidenceSha256(bytes) };
}

/** The canonical digest of the evidence itself, independent of how the file was formatted. */
export const previewEvidenceIdentity = (evidence: PreviewGateEvidence): string => sha256(canonicalJson(evidence as never));
