import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

import { PHASE_E_SCENARIOS } from "../qualification/phase-e.js";
import { PRODUCTION_DEPLOYMENT_CONTRACT } from "../qualification/production-contract.js";

export type ReleaseGateMode =
  | "CI" | "PRIVATE_MODEL" | "LIVE_PROVIDER" | "LIVE_PREVIEW"
  | "ISOLATED_RECOVERY" | "LIFECYCLE" | "SECURITY_SCAN" | "LIVE_METRIC";
export type ReleaseGate = {
  id: string;
  mode: ReleaseGateMode;
  why: string;
};
const previewScenarioIds = [
  ...new Set([
    ...PHASE_E_SCENARIOS.map((scenario) => scenario.id),
    "pulumi-aws-greenfield",
    "pulumi-aws-brownfield",
    "pulumi-azure-brownfield",
  ]),
];
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
  infrastructureAct: "DISABLED";
  records: ReleaseGateSubmission[];
};
export type GateReview = {
  id: string;
  mode: ReleaseGateMode;
  status: "EVIDENCE_PRESENT" | "BLOCKED";
  blockers: string[];
  evidenceSha256?: string;
};
export type ReleaseAdmissionReport = {
  sourceCommit: string;
  readyForIndependentReleaseReview: boolean;
  productionReleaseApproved: false;
  infrastructureAct: "DISABLED";
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
function observedLivePayload(value: unknown, gate: ReleaseGate, commit: string): boolean {
  if (!isObject(value) || value.sourceCommit !== commit) return false;
  if (value.actEnabled !== false || value.mutationObserved === true ||
      value.mock === true || value.fixture === true ||
      value.simulation === true || value.mode === "OFFLINE_FIXTURE_ONLY" ||
      value.mode === "LIVE_LOCAL_MODELS_WITH_SYNTHETIC_AWS_EVIDENCE") return false;
  if (gate.mode === "PRIVATE_MODEL") {
    const production = value.production;
    const records = value.records;
    const stack = value.stackChecks;
    if (!isObject(production) || production.passed !== true ||
        !isObject(production.context) || !isObject(production.context.host) ||
        typeof production.context.host.targetHardwareId !== "string" ||
        production.context.host.targetHardwareId === "UNKNOWN" ||
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
    if (value.ready !== true || value.blockers === undefined ||
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
  // These statements must be produced by real target/CI tools. The checker
  // validates provenance and content, not the honesty of an external machine.
  const report = value as Json;
  if (report.schemaVersion !== 1 || report.gateId !== gate.id ||
      report.executionMode !== gate.mode || report.passed !== true ||
      report.targetHardwareId === "UNKNOWN" ||
      typeof report.targetHardwareId !== "string" ||
      !Array.isArray(report.checks) || report.checks.length === 0 ||
      !report.checks.every((x) => isObject(x) &&
        x.passed === true && typeof x.evidenceSha256 === "string" &&
        sha64.test(x.evidenceSha256))) return false;
  if (gate.mode === "LIVE_PREVIEW") {
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

export async function reviewProductionRelease(input: {
  manifest: ReleaseAdmissionInput;
  root: string;
  expectedCommit: string;
}): Promise<ReleaseAdmissionReport> {
  const { manifest, expectedCommit } = input;
  const blockers: string[] = [];
  if (!sha40.test(expectedCommit) || manifest.sourceCommit !== expectedCommit ||
      manifest.schemaVersion !== 1 || manifest.operatingMode !== "PREVIEW_OPERATE" ||
      manifest.infrastructureAct !== "DISABLED" ||
      PRODUCTION_DEPLOYMENT_CONTRACT.spec.release.actEnabled !== false) {
    blockers.push("RELEASE_MANIFEST_CONTRACT_OR_COMMIT_INVALID");
  }
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
  const gates: GateReview[] = [];
  for (const gate of PRODUCTION_RELEASE_GATES) {
    const record = byId.get(gate.id);
    const reasons: string[] = [];
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
          if (!observedLivePayload(value, gate, expectedCommit)) {
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
    blockers.length === 0 && gates.every((gate) => gate.status === "EVIDENCE_PRESENT");
  return {
    sourceCommit: expectedCommit,
    readyForIndependentReleaseReview,
    productionReleaseApproved: false,
    infrastructureAct: "DISABLED",
    gates,
    blockers: [...blockers, ...gates.filter((gate) =>
      gate.status === "BLOCKED").map((gate) =>
      gate.id + ": " + gate.blockers.join(", "))],
    candidateIdentityHash,
  };
}
