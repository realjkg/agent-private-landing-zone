import { sha256 } from "../build/provenance.js";
import type { PulumiCase } from "./pulumi-permutations.js";

export type PulumiTraceGate =
  | "DIRECT_DESIGN_PREVIEW" | "CONVERSATIONAL_DESIGN_PREVIEW"
  | "UNKNOWN_OWNERSHIP_DIRECT" | "UNKNOWN_OWNERSHIP_CONVERSATIONAL"
  | "SCOPE_CONTRACT" | "NO_MUTATION"
  | "CHAOS_INJECTION" | "WELL_ARCHITECTED_POLICY"
  | "LOCAL_QWEN_MISTRAL" | "PULUMI_CLI_VALIDATE" | "PULUMI_REAL_PREVIEW"
  | "CLOUD_DISCOVERY" | "ACTUAL_RESTORE"
  | "MEASURED_COST" | "MEASURED_PERFORMANCE" | "MEASURED_SUSTAINABILITY";
export type PulumiTracePhase = "OFFLINE_EXECUTED" | "LIVE_NOT_RUN" | "PLAN_REQUIRED";
export type PulumiTraceResult =
  | "PASS" | "BLOCKED" | "CONTAINED" | "NOT_APPLICABLE"
  | "ASSESSED" | "FAILED" | "NOT_RUN" | "PLAN_REQUIRED";

export type PulumiTraceRow = {
  id: string;
  provider: string;
  estate: string;
  dimension: string;
  gate: PulumiTraceGate;
  phase: PulumiTracePhase;
  expected: PulumiTraceResult;
  observed: PulumiTraceResult;
  status: "VERIFIED_OFFLINE" | "FAILED" | "UNVERIFIED" | "PLAN_REQUIRED";
  evidenceMode: "SYNTHETIC_FIXTURE" | "SYNTHETIC_FAULT" |
    "NOT_EXECUTED" | "OUTSIDE_APPROVED_ALZ_PROVIDER_CONTRACT";
  sourceCommit: string;
  sourceTest: string;
  observationHash?: string;
  pillarPosture?: string;
  reason?: string;
  rowHash: string;
};

const pillars = [
  "RECOVERY", "RELIABILITY", "SECURITY", "COST",
  "PERFORMANCE", "SUSTAINABILITY", "OPERATIONAL_EXCELLENCE",
] as const;

const pending = [
  ["LOCAL_QWEN_MISTRAL", "Live model digests, router, primary, validator and adjudicator"],
  ["PULUMI_CLI_VALIDATE", "Actual Pulumi CLI and source/program validation"],
  ["PULUMI_REAL_PREVIEW", "Pulumi provider preview normalized to a ChangeSet"],
  ["CLOUD_DISCOVERY", "Read-only provider inventory and ownership"],
  ["ACTUAL_RESTORE", "Isolated backup/restore with measured RPO/RTO"],
  ["MEASURED_COST", "Measured cost and budget evidence"],
  ["MEASURED_PERFORMANCE", "Measured p95, capacity and SLO evidence"],
  ["MEASURED_SUSTAINABILITY", "Measured utilization and sustainability evidence"],
] as const;

export function buildPulumiTraceMatrix(input: {
  sourceCommit: string;
  cases: readonly PulumiCase[];
}): PulumiTraceRow[] {
  if (!/^[a-f0-9]{40}$/i.test(input.sourceCommit)) {
    throw new Error("PULUMI_TRACE_REQUIRES_COMMIT");
  }
  const result: PulumiTraceRow[] = [];
  const add = (draft: Omit<PulumiTraceRow, "id" | "status" | "rowHash">) => {
    const id = [
      "PULUMI", draft.provider, draft.estate,
      draft.gate, draft.dimension,
    ].join(":").toUpperCase();
    const status: PulumiTraceRow["status"] = draft.phase === "PLAN_REQUIRED"
      ? "PLAN_REQUIRED"
      : draft.phase === "LIVE_NOT_RUN" ? "UNVERIFIED"
      : draft.expected === draft.observed ? "VERIFIED_OFFLINE" : "FAILED";
    const row = { ...draft, id, status };
    result.push({ ...row, rowHash: sha256(JSON.stringify(row)) });
  };
  for (const item of input.cases) {
    const shared = {
      provider: item.provider, estate: item.estate,
      sourceCommit: input.sourceCommit,
      sourceTest: "test/pulumi-permutations.test.ts",
    };
    if (item.disposition === "PLAN_REQUIRED") {
      add({ ...shared, dimension: "PROVIDER_SCOPE", gate: "SCOPE_CONTRACT",
        phase: "PLAN_REQUIRED", expected: "PLAN_REQUIRED", observed: "NOT_RUN",
        evidenceMode: "OUTSIDE_APPROVED_ALZ_PROVIDER_CONTRACT",
        reason: item.reason });
      continue;
    }
    if (item.estate === "unknown") {
      for (const [gate, observed] of [
        ["UNKNOWN_OWNERSHIP_DIRECT", item.direct],
        ["UNKNOWN_OWNERSHIP_CONVERSATIONAL", item.conversational],
      ] as const) {
        add({ ...shared, dimension: "UNKNOWN_ESTATE", gate,
          phase: "OFFLINE_EXECUTED", expected: "BLOCKED",
          observed: observed === "BLOCKED" ? "BLOCKED" : "FAILED",
          evidenceMode: "SYNTHETIC_FIXTURE",
          observationHash: item.evidenceHash,
          reason: "No Build artifact; no ACT or mutation" });
      }
      continue;
    }
    for (const [gate, observed, digest] of [
      ["DIRECT_DESIGN_PREVIEW", item.direct, item.directDesignHash],
      ["CONVERSATIONAL_DESIGN_PREVIEW", item.conversational, item.conversationalDesignHash],
    ] as const) {
      add({ ...shared, dimension: "DESIGN_AND_BUILD_PREVIEW", gate,
        phase: "OFFLINE_EXECUTED", expected: "PASS",
        observed: observed === "PASS" && item.disposition === "PASS" ? "PASS" : "FAILED",
        evidenceMode: "SYNTHETIC_FIXTURE",
        observationHash: digest && item.policyHash && item.artifactHash && item.previewHash
          ? sha256(JSON.stringify({
            designHash: digest, designContentHash: item.designContentHash,
            policyHash: item.policyHash, artifactHash: item.artifactHash,
            previewHash: item.previewHash,
          })) : undefined,
        reason: "Fixture-generated IaC only; not a provider plan" });
    }
    add({ ...shared, dimension: "OBSERVED_INVARIANT", gate: "NO_MUTATION",
      phase: "OFFLINE_EXECUTED", expected: "PASS",
      observed: item.mutationObserved === false ? "PASS" : "FAILED",
      evidenceMode: "SYNTHETIC_FIXTURE",
      observationHash: item.evidenceHash,
      reason: "Infrastructure ACT disabled" });
    for (const fault of item.chaosFaults) {
      const expected = fault.outcome === "NOT_APPLICABLE"
        ? "NOT_APPLICABLE" as const : "CONTAINED" as const;
      add({ ...shared, dimension: fault.fault, gate: "CHAOS_INJECTION",
        phase: "OFFLINE_EXECUTED", expected,
        observed: fault.outcome === "UNDETECTED" ? "FAILED" : fault.outcome,
        evidenceMode: "SYNTHETIC_FAULT",
        observationHash: fault.evidenceHash });
    }
    for (const pillar of pillars) {
      const posture = item.pillarPosture[pillar];
      add({ ...shared, dimension: pillar, gate: "WELL_ARCHITECTED_POLICY",
        phase: "OFFLINE_EXECUTED", expected: "ASSESSED",
        observed: posture ? "ASSESSED" : "FAILED",
        evidenceMode: "SYNTHETIC_FIXTURE",
        pillarPosture: posture,
        observationHash: posture ? item.policyHash : undefined,
        reason: "Policy assessed; no measured real-world pillar outcome" });
    }
    for (const [gate, reason] of pending) {
      add({ ...shared, dimension: "LIVE_ACCEPTANCE", gate,
        phase: "LIVE_NOT_RUN", expected: "PASS", observed: "NOT_RUN",
        evidenceMode: "NOT_EXECUTED", reason });
    }
  }
  const ids = result.map((row) => row.id);
  if (new Set(ids).size !== ids.length) {
    throw new Error("PULUMI_TRACE_DUPLICATE_IDS");
  }
  return result;
}
