import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

import { loadPilotContract, pilotContractPinned, pilotContractSha256 } from "../apply/contract.js";
import type { ApplyEnvironment, EngineId, PilotContract, ProviderId } from "../apply/types.js";
import { PREVIEW_GATE_SCENARIOS, previewGateEvidenceProblems, previewScenarioOf } from "./preview-gate.js";
import { recoveryGateEvidenceProblems } from "./recovery-gate.js";
export { PREVIEW_GATE_SCENARIOS, previewScenarioOf, type PreviewGateScenario } from "./preview-gate.js";
const previewScenarioIds = Object.keys(PREVIEW_GATE_SCENARIOS);
import { PRODUCTION_DEPLOYMENT_CONTRACT, pilotCombinationListed } from "./production-contract.js";

export type ReleaseGateMode =
  | "CI" | "PRIVATE_MODEL" | "LIVE_PROVIDER" | "LIVE_PREVIEW"
  | "ISOLATED_RECOVERY" | "LIFECYCLE" | "SECURITY_SCAN" | "LIVE_METRIC"
  | "LIVE_ACT" | "ACT_RECOVERY" | "INDEPENDENT_REVIEW";
export type ReleaseGate = {
  id: string;
  mode: ReleaseGateMode;
  why: string;
};
/** The operating systems a release is qualified on, one gate each: a Linux pass never stands in for macOS or Windows. */
export const RELEASE_PLATFORMS = ["darwin-arm64", "darwin-x64", "linux-x64", "linux-arm64", "win32-arm64", "win32-x64"] as const;
/** What one platform's lifecycle report must show it actually ran on that host. */
export const PLATFORM_LIFECYCLE_CHECKS = [
  "install", "launch", "uninstall", "repeat-uninstall", "partial-install-recovery", "unusual-paths", "unrelated-files-preserved",
] as const;
/** The pilot paths a release can qualify live, each against its journey row (config/acceptance/journeys.json). */
export const ACT_RELEASE_PATHS: readonly { provider: ProviderId; engine: EngineId }[] = [
  { provider: "AWS", engine: "TERRAFORM" }, { provider: "AZURE", engine: "TERRAFORM" }, { provider: "AWS", engine: "CDK" },
];
export const actGateId = (path: { provider: string; engine: string }): string => "act:" + path.provider.toLowerCase() + "-" + path.engine.toLowerCase();
export const PRODUCTION_RELEASE_GATES: readonly ReleaseGate[] = [
  { id: "source-ci", mode: "CI", why: "Type check and functional regression on exact release source" },
  { id: "release-archive", mode: "CI", why: "Reproducible archive, SBOM, release manifest and provenance" },
  { id: "arm64-final-image", mode: "SECURITY_SCAN", why: "Actual ARM64 runtime image and blocking vulnerability scan" },
  { id: "private-model-runtime", mode: "PRIVATE_MODEL", why: "Target-host Qwen/Mistral models, digests, restart and long-session recovery" },
  { id: "aws-provider", mode: "LIVE_PROVIDER", why: "Live authenticated read-only AWS inventory and governed preview" },
  { id: "azure-provider", mode: "LIVE_PROVIDER", why: "Live authenticated read-only Azure inventory and governed preview" },
  ...previewScenarioIds.map((id) => ({
    id: "preview:" + id,
    mode: "LIVE_PREVIEW" as const,
    why: "Exact provider/IaC scenario with real tool output and no infrastructure mutation",
  })),
  { id: "isolated-recovery", mode: "ISOLATED_RECOVERY", why: "Actual isolated restore with measured recovery objectives" },
  ...["clean-install", "upgrade", "rollback", "uninstall", "configuration-migration"].map((id) => ({
    id: "lifecycle:" + id, mode: "LIFECYCLE" as const,
    why: "Actual lifecycle execution with data integrity and rollback evidence",
  })),
  ...RELEASE_PLATFORMS.map((id) => ({
    id: "platform:" + id, mode: "LIFECYCLE" as const,
    why: "Install, launch, uninstall and recovery on a real disposable " + id + " host",
  })),
  ...ACT_RELEASE_PATHS.map((path) => ({
    id: actGateId(path), mode: "LIVE_ACT" as const,
    why: "Owner-supervised DEV apply on the real account, recorded from its own ledger evidence (./alz apply record-live)",
  })),
  { id: "act-run-recovery", mode: "ACT_RECOVERY", why: "An interrupted real pilot apply reconciled from its ledger, never resumed without new approval" },
  { id: "security-review:independent", mode: "INDEPENDENT_REVIEW", why: "Security review of the candidate by someone who did not write it" },
  ...["operational-excellence", "security", "reliability", "performance", "cost", "sustainability"].map((id) => ({
    id: "pillar:" + id, mode: "LIVE_METRIC" as const,
    why: "Actual deployed-environment measurement, not a synthetic fixture",
  })),
];

export type ReleaseGateSubmission = {
  id: string;
  mode: ReleaseGateMode;
  sourceCommit: string;
  targetHardwareId: string;
  evidencePath: string;
  evidenceSha256: string;
};
export type ReleaseAdmissionInput = {
  schemaVersion: 1;
  sourceCommit: string;
  operatingMode: "PREVIEW_OPERATE";
  /** DISABLED, or PILOT for a release admitted under an enabled pilot contract (see `actPilot`). Nothing else. */
  infrastructureAct: "DISABLED" | "PILOT";
  /** Required with PILOT, forbidden otherwise: the one pilot scope, bound to the contract by hash. */
  actPilot?: ActPilotScope;
  records: ReleaseGateSubmission[];
};
export type ActPilotScope = { provider: ProviderId; engine: EngineId; contractSha256: string };
export type GateReview = {
  id: string;
  mode: ReleaseGateMode;
  /** OUT_OF_SCOPE only for a gate the owner's release scope excludes (config/release/scope.json). */
  status: "EVIDENCE_PRESENT" | "BLOCKED" | "OUT_OF_SCOPE";
  blockers: string[];
  evidenceSha256?: string;
};
export type ReleaseAdmissionReport = {
  sourceCommit: string;
  readyForIndependentReleaseReview: boolean;
  productionReleaseApproved: false;
  /** ACT is disabled globally. The pilot contract is its only exception, reported in `actPilot`. */
  infrastructureAct: "DISABLED";
  actPilot: ActPilotScope | null;
  gates: GateReview[];
  blockers: string[];
  candidateIdentityHash: string;
};

const sha40 = /^[0-9a-f]{40}$/;
const sha64 = /^[0-9a-f]{64}$/;
type Json = Record<string, unknown>;
function isObject(value: unknown): value is Json {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function digest(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}
/** What a PILOT release binds a live ACT or recovery record to: the pinned contract's hash and its required approvals per environment. Null for a release with no pilot scope. */
type PilotBinding = { contractSha256: string; requiredApprovals: PilotContract["requiredApprovals"] } | null;

function observedLivePayload(value: unknown, gate: ReleaseGate, record: ReleaseGateSubmission, commit: string, pilot: PilotBinding): boolean {
  if (!isObject(value)) return false;
  if (value.mutationObserved === true ||
      value.mock === true || value.fixture === true ||
      value.simulation === true || value.mode === "OFFLINE_FIXTURE_ONLY" ||
      value.mode === "LIVE_LOCAL_MODELS_WITH_SYNTHETIC_AWS_EVIDENCE") return false;
  if (gate.mode === "PRIVATE_MODEL") {
    const production = value.production;
    const records = value.records;
    const stack = value.stackChecks;
    if (!isObject(production) || production.passed !== true ||
        !isObject(production.context) || !isObject(production.context.host) ||
        production.context.sourceCommit !== commit ||
        production.context.host.targetHardwareId !== record.targetHardwareId ||
        !isObject(production.session) ||
        production.session.mutationObserved !== false ||
        !Array.isArray(production.checks) || production.checks.length === 0 ||
        !production.checks.every((x) => isObject(x) && x.passed === true) ||
        !Array.isArray(records) || records.length < 3 ||
        !Array.isArray(stack) || stack.length === 0 ||
        !stack.every((x) => isObject(x) && x.passed === true)) return false;
    const models = new Set<string>();
    for (const x of records) {
      if (!isObject(x) || x.passed !== true ||
          typeof x.model !== "string" ||
          typeof x.digest !== "string" || !sha64.test(x.digest)) return false;
      models.add(x.model);
    }
    return value.passed === true &&
      ["qwen3:1.7b", "qwen3:4b", "mistral-nemo:latest"].every((m) => models.has(m));
  }
  if (gate.mode === "LIVE_PROVIDER") {
    if (value.sourceCommit !== commit || value.actEnabled !== false ||
        value.ready !== true || value.blockers === undefined ||
        !Array.isArray(value.blockers) || value.blockers.length !== 0 ||
        !isObject(value.discovery) || !isObject(value.validation) ||
        !isObject(value.preview)) return false;
    const provider = gate.id === "aws-provider" ? "AWS" : "AZURE";
    return value.provider === provider &&
      value.validation.passed === true &&
      typeof value.discovery.snapshotSha256 === "string" &&
      sha64.test(value.discovery.snapshotSha256) &&
      Array.isArray(value.discovery.evidenceSources) &&
      !value.discovery.evidenceSources.includes("mock") &&
      typeof value.preview.outputSha256 === "string" &&
      sha64.test(value.preview.outputSha256);
  }
  if (gate.mode === "LIVE_ACT") {
    // The live record `./alz apply record-live` writes from the apply's own ledger evidence (src/apply/live-record.ts).
    const path = ACT_RELEASE_PATHS.find((x) => actGateId(x) === gate.id);
    // Under a PILOT release the record must name the pinned contract the release is bound to (#269 review N2): a record of an apply
    // under another contract is not this release's live evidence.
    return path !== undefined && value.schemaVersion === 1 && value.label === "LIVE" && value.step === "execute" &&
      value.cloud === path.provider && value.engine === path.engine && value.sourceCommit === commit &&
      value.outcome === "SUCCEEDED" && typeof value.attestedBy === "string" && value.attestedBy.trim() !== "" &&
      [value.artifactSha256, value.evidenceSha256, value.contractSha256].every((x) => typeof x === "string" && sha64.test(x)) &&
      (pilot === null || value.contractSha256 === pilot.contractSha256);
  }
  // These statements must be produced by real target/CI tools. The checker
  // validates provenance and content, not the honesty of an external machine.
  const report = value as Json;
  // A recovery report is about a pilot apply, so it is the one report that may say ACT ran.
  if (report.sourceCommit !== commit || (gate.mode !== "ACT_RECOVERY" && report.actEnabled !== false) ||
      report.targetHardwareId !== record.targetHardwareId ||
      report.schemaVersion !== 1 || report.gateId !== gate.id ||
      report.executionMode !== gate.mode || report.passed !== true ||
      report.targetHardwareId === "UNKNOWN" ||
      typeof report.targetHardwareId !== "string" ||
      !Array.isArray(report.checks) || report.checks.length === 0 ||
      !report.checks.every((x) => isObject(x) &&
        x.passed === true && typeof x.evidenceSha256 === "string" &&
        sha64.test(x.evidenceSha256))) return false;
  if (gate.mode === "LIVE_PREVIEW") {
    // The evidence is a valid preview-gate document of this gate and this commit (src/qualification/preview-gate.ts: the exact
    // scenario, provider, engine and estate; exactly the six live conditions, all true, with the label, mode, `passed`,
    // `simulation`, `reasons`, attestation and qualification derived from them), and it calls itself LIVE. A document that lacks
    // the conditions, has an empty or partial set, or was relabeled by hand with its conditions flipped and its reasons, null
    // attestation or UNQUALIFIED provenance left behind, is refused here, not only by the producer's own validator.
    if (previewGateEvidenceProblems(report, { sourceCommit: commit, gateId: gate.id }).length > 0 || report.label !== "LIVE") return false;
    return report.previewExecuted === true &&
      report.toolOutputHash !== undefined &&
      typeof report.toolOutputHash === "string" &&
      sha64.test(report.toolOutputHash) &&
      report.infrastructureApplied === false;
  }
  if (gate.mode === "ISOLATED_RECOVERY") {
    return report.restoreExecuted === true &&
      typeof report.observedRpoSeconds === "number" &&
      typeof report.observedRtoSeconds === "number" &&
      Number.isFinite(report.observedRpoSeconds) &&
      Number.isFinite(report.observedRtoSeconds) &&
      report.observedRpoSeconds >= 0 && report.observedRtoSeconds >= 0;
  }
  if (gate.mode === "SECURITY_SCAN") {
    return report.imageDigest !== undefined &&
      typeof report.imageDigest === "string" &&
      /^sha256:[0-9a-f]{64}$/.test(report.imageDigest) &&
      report.criticalFindings === 0 && report.highFindings === 0;
  }
  if (gate.mode === "LIVE_METRIC") {
    return report.measurementsAreSynthetic === false &&
      isObject(report.measurements) &&
      Object.keys(report.measurements).length > 0;
  }
  if (gate.mode === "ACT_RECOVERY") {
    // The evidence is a valid recovery-gate document of this commit (src/qualification/recovery-gate.ts): the four gate fields,
    // the conditions, the label and `passed` are recomputed from the cited ledger records, so a hand-written document, or one
    // relabeled over records that show no interruption or an approval carried over, is refused here as well as by the producer.
    // Under a PILOT release the record must name the pinned contract and the approval count that contract requires for the record's
    // environment (#269 review N2): a PROD record claiming one approval under a contract that requires two is refused.
    return recoveryGateEvidenceProblems(report, { sourceCommit: commit }).length === 0 &&
      typeof report.interruptedArtifactSha256 === "string" && sha64.test(report.interruptedArtifactSha256) &&
      (report.interruptedOutcome === "PARTIAL_REQUIRES_REVIEW" || report.interruptedOutcome === "KILLED") &&
      report.reconciledFromLedger === true && report.resumedWithoutApproval === false &&
      (pilot === null || (report.contractSha256 === pilot.contractSha256 && report.requiredApprovals === pilot.requiredApprovals[report.environment as ApplyEnvironment]));
  }
  if (gate.mode === "INDEPENDENT_REVIEW") {
    return typeof report.reviewer === "string" && report.reviewer.trim() !== "" &&
      report.reviewerIsAuthor === false && report.blockingFindingsOpen === 0;
  }
  if (gate.id.startsWith("platform:")) {
    const names = new Set((report.checks as Json[]).map((x) => x.name));
    return report.platform === gate.id.slice("platform:".length) && typeof report.osVersion === "string" &&
      report.osVersion.trim() !== "" && typeof report.artifactSha256 === "string" && sha64.test(report.artifactSha256) &&
      PLATFORM_LIFECYCLE_CHECKS.every((name) => names.has(name));
  }
  return gate.mode === "LIFECYCLE" || gate.mode === "CI";
}

async function readEvidence(root: string, path: string): Promise<Buffer> {
  if (!path || isAbsolute(path) || path.includes("\0")) {
    throw new Error("EVIDENCE_PATH_NOT_RELATIVE");
  }
  const resolvedRoot = await realpath(root);
  const candidate = await realpath(resolve(resolvedRoot, path));
  const rel = relative(resolvedRoot, candidate);
  if (!rel || rel === ".." || rel.startsWith(".." + sep) || isAbsolute(rel)) {
    throw new Error("EVIDENCE_PATH_ESCAPES_ROOT");
  }
  return readFile(candidate);
}

/**
 * The pilot exception: a release declares PILOT only together with an enabled
 * pilot contract that the committed pin names (the loader checks the same pin),
 * and names it (and the one pilot scope) by hash. An enabled contract beside a
 * release that does not declare the pilot is rejected, and so is a stray
 * actPilot object on any release that is not PILOT, so neither the contract file
 * nor the manifest can quietly enable ACT for an ordinary release.
 */
function reviewPilot(manifest: ReleaseAdmissionInput, contract: PilotContract | undefined, pinPath: string | undefined): { scope: ActPilotScope | null; blockers: string[] } {
  if (manifest.infrastructureAct !== "PILOT") {
    return {
      scope: null,
      blockers: [
        ...(contract ? ["ACT_PILOT_CONTRACT_ENABLED_FOR_NON_PILOT_RELEASE"] : []),
        ...(Object.hasOwn(manifest, "actPilot") ? ["ACT_PILOT_SCOPE_ON_NON_PILOT_RELEASE"] : []),
      ],
    };
  }
  if (!contract) return { scope: null, blockers: ["ACT_PILOT_CONTRACT_MISSING_OR_DISABLED"] };
  if (!pilotContractPinned(contract, pinPath)) return { scope: null, blockers: ["ACT_PILOT_CONTRACT_NOT_PINNED"] };
  if (!pilotCombinationListed(contract.provider, contract.engine)) return { scope: null, blockers: ["ACT_PILOT_COMBINATION_NOT_ALLOWED"] };
  const claimed = manifest.actPilot as unknown;
  const bound = isObject(claimed) && Object.keys(claimed).length === 3 && claimed.provider === contract.provider &&
    claimed.engine === contract.engine && claimed.contractSha256 === pilotContractSha256(contract);
  return bound ? { scope: claimed as ActPilotScope, blockers: [] } : { scope: null, blockers: ["ACT_PILOT_SCOPE_MISMATCH"] };
}

export async function reviewProductionRelease(input: {
  manifest: ReleaseAdmissionInput;
  root: string;
  expectedCommit: string;
  /** The loaded pilot contract (loadPilotContract). Absent, or not enabled, means there is no pilot. */
  pilotContract?: PilotContract | { enabled: false };
  /** The committed pin the contract must match. Defaults to config/act-pilot-contract.sha256 in the repository. */
  pilotPinPath?: string;
  /** Gates the owner's release scope excludes (config/release/scope.json). They are reported, and do not block; a record for one is refused. */
  outOfScope?: readonly string[];
}): Promise<ReleaseAdmissionReport> {
  const { manifest, expectedCommit } = input;
  const blockers: string[] = [];
  if (!sha40.test(expectedCommit) || manifest.sourceCommit !== expectedCommit ||
      manifest.schemaVersion !== 1 || manifest.operatingMode !== "PREVIEW_OPERATE" ||
      (manifest.infrastructureAct !== "DISABLED" && manifest.infrastructureAct !== "PILOT") ||
      PRODUCTION_DEPLOYMENT_CONTRACT.spec.release.actEnabled !== false) {
    blockers.push("RELEASE_MANIFEST_CONTRACT_OR_COMMIT_INVALID");
  }
  const pilot = reviewPilot(manifest, input.pilotContract?.enabled === true ? input.pilotContract : undefined, input.pilotPinPath);
  blockers.push(...pilot.blockers);
  const binding: PilotBinding = pilot.scope && input.pilotContract?.enabled === true ? { contractSha256: pilot.scope.contractSha256, requiredApprovals: input.pilotContract.requiredApprovals } : null;
  if (!Array.isArray(manifest.records)) {
    blockers.push("RELEASE_RECORDS_REQUIRED");
  }
  const byId = new Map<string, ReleaseGateSubmission>();
  for (const record of Array.isArray(manifest.records) ? manifest.records : []) {
    if (!isObject(record) || typeof record.id !== "string") {
      blockers.push("RELEASE_RECORD_MALFORMED");
      continue;
    }
    if (byId.has(record.id)) blockers.push("RELEASE_RECORD_DUPLICATE:" + record.id);
    if (!PRODUCTION_RELEASE_GATES.some((gate) => gate.id === record.id)) {
      blockers.push("RELEASE_RECORD_UNKNOWN_GATE:" + record.id);
    }
    byId.set(record.id, record as ReleaseGateSubmission);
  }
  const excluded = new Set(input.outOfScope ?? []);
  for (const id of excluded) {
    if (!PRODUCTION_RELEASE_GATES.some((gate) => gate.id === id)) blockers.push("RELEASE_SCOPE_UNKNOWN_GATE:" + id);
  }
  const gates: GateReview[] = [];
  for (const gate of PRODUCTION_RELEASE_GATES) {
    const record = byId.get(gate.id);
    const reasons: string[] = [];
    if (excluded.has(gate.id)) {
      if (record) blockers.push("RELEASE_RECORD_FOR_OUT_OF_SCOPE_GATE:" + gate.id);
      gates.push({ id: gate.id, mode: gate.mode, status: "OUT_OF_SCOPE", blockers: [] });
      continue;
    }
    if (!record) {
      reasons.push("NOT_RUN: no source-bound evidence record");
    } else if (record.mode !== gate.mode ||
        record.sourceCommit !== expectedCommit ||
        !record.targetHardwareId ||
        record.targetHardwareId === "UNKNOWN" ||
        !sha64.test(record.evidenceSha256)) {
      reasons.push("EVIDENCE_IDENTITY_MISMATCH");
    } else {
      try {
        const bytes = await readEvidence(input.root, record.evidencePath);
        if (digest(bytes) !== record.evidenceSha256) {
          reasons.push("EVIDENCE_DIGEST_MISMATCH");
        } else {
          const value = JSON.parse(bytes.toString("utf8")) as unknown;
          if (!observedLivePayload(value, gate, record, expectedCommit, binding)) {
            reasons.push("EVIDENCE_GATE_CONTRACT_FAILED");
          }
        }
      } catch {
        reasons.push("EVIDENCE_MISSING_INVALID_OR_OUTSIDE_ROOT");
      }
    }
    gates.push({ id: gate.id, mode: gate.mode,
      status: reasons.length ? "BLOCKED" : "EVIDENCE_PRESENT",
      blockers: reasons,
      ...(record ? { evidenceSha256: record.evidenceSha256 } : {}),
    });
  }
  const candidateIdentityHash = digest(JSON.stringify({
    sourceCommit: expectedCommit,
    gates: gates.map((gate) => [gate.id, gate.status, gate.evidenceSha256]),
  }));
  const readyForIndependentReleaseReview =
    blockers.length === 0 && gates.every((gate) => gate.status !== "BLOCKED");
  return {
    sourceCommit: expectedCommit,
    readyForIndependentReleaseReview,
    productionReleaseApproved: false,
    infrastructureAct: "DISABLED",
    actPilot: pilot.scope,
    gates,
    blockers: [...blockers, ...gates.filter((gate) =>
      gate.status === "BLOCKED").map((gate) =>
      gate.id + ": " + gate.blockers.join(", "))],
    candidateIdentityHash,
  };
}

/**
 * The admission review of a release from this repository: the pilot contract and pin it ships (config/act-pilot-contract.json),
 * and the gates the owner's scope excludes. The one entry both the admission CLI and the release status view use.
 */
export function reviewRepositoryRelease(input: { manifest: ReleaseAdmissionInput; root: string; expectedCommit: string; outOfScope: readonly string[] }): Promise<ReleaseAdmissionReport> {
  // ACT is off unless the release declares PILOT and the shipped contract is valid, enabled and pinned.
  return reviewProductionRelease({ ...input, pilotContract: loadPilotContract() });
}
