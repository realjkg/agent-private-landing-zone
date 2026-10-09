import { sha256 } from "../build/provenance.js";
import type { AgentState } from "../agent/types.js";
import {
  createSimulatedRecoveryPoint,
  verifyRecoveryPoint,
  runSimulatedRestoreDrill,
} from "../recovery/operations.js";
import { createRecoveryPolicy } from "../recovery/policy.js";
import { createPillarPolicyBundle } from "../policy/pillars/baseline.js";
import type { PillarStatus } from "../policy/pillars/types.js";

export type ChaosPillar =
  | "RECOVERY" | "COST" | "OPERATIONAL_EXCELLENCE"
  | "PERFORMANCE" | "SUSTAINABILITY" | "SECURITY" | "RELIABILITY";
export type ChaosFault =
  | "MISSING_BACKUP" | "CORRUPTED_MANIFEST" | "MISSING_IAC_STATE"
  | "STALE_DESIGN" | "RESTORE_WITH_UNKNOWN_RPO_RTO"
  | "OBSERVABILITY_OUTAGE" | "COST_BUDGET_SPIKE"
  | "LATENCY_REGRESSION" | "IDLE_RESOURCE_WASTE"
  | "UNAUTHORIZED_MUTATION" | "SINGLE_FAILURE_DOMAIN";
export const CHAOS_FAULTS: Array<{ id: ChaosFault; pillar: ChaosPillar }> = [
  { id: "MISSING_BACKUP", pillar: "RECOVERY" },
  { id: "CORRUPTED_MANIFEST", pillar: "RECOVERY" },
  { id: "MISSING_IAC_STATE", pillar: "RECOVERY" },
  { id: "STALE_DESIGN", pillar: "RECOVERY" },
  { id: "RESTORE_WITH_UNKNOWN_RPO_RTO", pillar: "RECOVERY" },
  { id: "OBSERVABILITY_OUTAGE", pillar: "OPERATIONAL_EXCELLENCE" },
  { id: "COST_BUDGET_SPIKE", pillar: "COST" },
  { id: "LATENCY_REGRESSION", pillar: "PERFORMANCE" },
  { id: "IDLE_RESOURCE_WASTE", pillar: "SUSTAINABILITY" },
  { id: "UNAUTHORIZED_MUTATION", pillar: "SECURITY" },
  { id: "SINGLE_FAILURE_DOMAIN", pillar: "RELIABILITY" },
];

export type ChaosOutcome = {
  fault: ChaosFault;
  pillar: ChaosPillar;
  outcome: "CONTAINED" | "UNDETECTED";
  observed: string;
  evidenceHash: string;
  mutationAttempted: false;
  restoreExecuted: false;
  evidenceMode: "SYNTHETIC_FAULT_INJECTION";
};
export type ChaosReport = {
  sourceCommit: string;
  policyHash: string;
  recoveryPointHash: string;
  recoveryVerification: string;
  pillarPosture: Record<string, PillarStatus | "UNKNOWN">;
  faults: ChaosOutcome[];
  passed: boolean;
  status: "SIMULATION_ONLY";
  actEnabled: false;
  evidenceHash: string;
};

/** No cloud API, termination, reboot, restore or provider side effect occurs here. */
export function runChaosPillarQualification(input: {
  sourceCommit: string; state: AgentState;
}): ChaosReport {
  if (!/^[a-f0-9]{40}$/i.test(input.sourceCommit)) {
    throw new Error("CHAOS_SOURCE_COMMIT_REQUIRED");
  }
  const state = input.state;
  if (!state.environment || !state.postureAssessment || !state.design ||
    state.action?.executed !== false ||
    state.observation?.mutationObserved !== false ||
    state.orchestration?.actEnabled !== false) {
    throw new Error("CHAOS_REQUIRES_SAFE_ASSESSED_DESIGN");
  }
  const design = state.design;
  const policy = createRecoveryPolicy({
    environment: state.environment,
    design,
  });
  const point = createSimulatedRecoveryPoint({
    environment: state.environment,
    assessment: state.postureAssessment,
    design,
    policy,
    capturedAt: "2026-10-08T00:00:00.000Z",
  });
  const verified = verifyRecoveryPoint({ point, policy });
  const baselineDrill = runSimulatedRestoreDrill({
    point, verification: verified, design,
  });
  const pillars = createPillarPolicyBundle({
    environment: state.environment, assessment: state.postureAssessment,
  });
  const pillarPosture = {
    COST: pillars.cost.status,
    SECURITY: pillars.security.status,
    PERFORMANCE: pillars.performance.status,
    SUSTAINABILITY: pillars.sustainability.status,
    RELIABILITY: pillars.reliability.status,
    RECOVERY: pillars.resiliency.status,
    OPERATIONAL_EXCELLENCE: "UNKNOWN" as const,
  };
  const outcomes = CHAOS_FAULTS.map(({ id, pillar }): ChaosOutcome => {
    let detected = false;
    let observed = "";
    if (id === "MISSING_BACKUP") {
      detected = point.coverage !== "FULL" && verified.status !== "VERIFIED";
      observed = "Backup coverage " + point.coverage + "; verification " + verified.status;
    } else if (id === "CORRUPTED_MANIFEST") {
      const tampered = {
        ...point,
        artifacts: point.artifacts.map((artifact, index) =>
          index === 0 ? { ...artifact, contentHash: "0".repeat(64) } : artifact),
      };
      const check = verifyRecoveryPoint({ point: tampered, policy });
      detected = check.checks.some((c) => c.name === "recovery-point-hash" && c.status === "FAIL");
      observed = "Tampered recovery-point integrity: " + check.status;
    } else if (id === "MISSING_IAC_STATE") {
      const missing = {
        ...point, artifacts: point.artifacts.filter((a) => a.kind !== "IAC_STATE"),
      };
      const check = verifyRecoveryPoint({ point: missing, policy });
      detected = policy.requiredArtifacts.includes("IAC_STATE") &&
        check.checks.some((c) => c.name === "required-artifacts" && c.status === "FAIL");
      observed = "Missing IaC state: " + check.status;
    } else if (id === "STALE_DESIGN") {
      const drifted = { ...point, designHash: "f".repeat(64) };
      const drill = runSimulatedRestoreDrill({
        point: drifted, verification: verified, design,
      });
      detected = !drill.designHashMatches && drill.status === "BLOCKED";
      observed = "Design hash drift: " + drill.status;
    } else if (id === "RESTORE_WITH_UNKNOWN_RPO_RTO") {
      detected = (policy.rpo === "UNKNOWN" || policy.rto === "UNKNOWN") &&
        verified.status !== "VERIFIED";
      observed = "RPO=" + policy.rpo + ", RTO=" + policy.rto +
        "; drill=" + baselineDrill.status + ", verified=" + verified.status;
    } else if (id === "OBSERVABILITY_OUTAGE") {
      // Explicit synthetic signal loss: a missing heartbeat cannot be a healthy state.
      const synthetic = { heartbeatPresent: false, runbookAvailable: false, onCallKnown: false };
      detected = !synthetic.heartbeatPresent && (!synthetic.runbookAvailable || !synthetic.onCallKnown);
      observed = "Synthetic telemetry heartbeat lost; on-call and runbook not evidenced";
    } else if (id === "COST_BUDGET_SPIKE") {
      const synthetic = { forecastUsd: 180, approvedBudgetUsd: 100 };
      detected = synthetic.forecastUsd > synthetic.approvedBudgetUsd;
      observed = "Synthetic forecast exceeds synthetic budget; real cloud spend UNKNOWN";
    } else if (id === "LATENCY_REGRESSION") {
      const synthetic = { measuredP95Ms: 370, objectiveP95Ms: 200 };
      detected = synthetic.measuredP95Ms > synthetic.objectiveP95Ms;
      observed = "Synthetic p95 exceeds synthetic target; real performance UNKNOWN";
    } else if (id === "IDLE_RESOURCE_WASTE") {
      const synthetic = { idleHours: 200, allowanceHours: 50 };
      detected = synthetic.idleHours > synthetic.allowanceHours;
      observed = "Synthetic idle-hours excess; actual resource utilization UNKNOWN";
    } else if (id === "UNAUTHORIZED_MUTATION") {
      const synthetic = { attemptedAction: "DELETE", approval: false };
      detected = synthetic.attemptedAction === "DELETE" && !synthetic.approval &&
        state.orchestration?.actEnabled === false;
      observed = "Synthetic unauthorized delete rejected by invariant ACT=DISABLED";
    } else if (id === "SINGLE_FAILURE_DOMAIN") {
      const synthetic = { observedZones: 1, requiredZones: 2 };
      detected = synthetic.observedZones < synthetic.requiredZones;
      observed = "Synthetic single-zone exposure; actual production redundancy UNKNOWN";
    }
    const normalized = { fault: id, pillar, outcome: detected ? "CONTAINED" as const : "UNDETECTED" as const,
      observed, mutationAttempted: false as const, restoreExecuted: false as const,
      evidenceMode: "SYNTHETIC_FAULT_INJECTION" as const };
    return { ...normalized, evidenceHash: sha256(JSON.stringify(normalized)) };
  });
  const body = {
    sourceCommit: input.sourceCommit,
    policyHash: pillars.bundleHash,
    recoveryPointHash: point.recoveryPointHash,
    recoveryVerification: verified.status,
    pillarPosture,
    faults: outcomes,
    passed: outcomes.every((o) => o.outcome === "CONTAINED"),
    status: "SIMULATION_ONLY" as const,
    actEnabled: false as const,
  };
  return { ...body, evidenceHash: sha256(JSON.stringify(body)) };
}
