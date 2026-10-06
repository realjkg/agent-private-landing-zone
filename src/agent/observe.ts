import type {
  AgentState,
  ObservationResult,
} from "./types.js";

export function observe(
  state: AgentState,
): AgentState {
  const mutationObserved =
    state.action?.executed === true;

  const evidence: string[] = [
    "Environment state captured.",
    "Agent plan recorded.",
  ];

  if (state.postureAssessment) {
    evidence.push(
      "Posture assessment ID: " +
        state.postureAssessment.assessmentId,
    );
    evidence.push(
      "Security posture: " +
        state.postureAssessment.securityStatus,
    );
    evidence.push(
      "SBOM posture: " +
        state.postureAssessment.sbom.status,
    );
    evidence.push(
      "Resiliency posture: " +
        state.postureAssessment.resiliency.status,
    );
    evidence.push(
      "Recovery configuration hash: " +
        state.postureAssessment.recoverySnapshot.configurationHash,
    );
  }

  if (state.deltaAssessment) {
    evidence.push(
      "Delta decisions: " +
        state.deltaAssessment.decisions.length,
    );
    evidence.push(
      "Delta blockers: " +
        state.deltaAssessment.blockers.length,
    );
  }

  if (state.assessment) {
    evidence.push(
      "Reasoning assessment status: " +
        state.assessment.status,
    );
  }

  if (state.build) {
    evidence.push(
      "Build artifact hash: " +
        state.build.candidate.artifact.contentHash,
    );
    evidence.push(
      "Preview hash: " +
        (state.build.candidate.evidence.planHash ?? "missing"),
    );
    evidence.push(
      "Build gate: " +
        (state.build.gate.allowed ? "PASSED" : "STOPPED"),
    );
  }

  if (state.action) {
    evidence.push(
      "Action status: " + state.action.status,
    );
  }

  const observation: ObservationResult = {
    verified: !mutationObserved,
    mutationObserved,
    evidence,
  };

  const phase =
    state.phase === "BLOCKED"
      ? "BLOCKED"
      : state.phase === "AWAITING_APPROVAL"
        ? "AWAITING_APPROVAL"
        : "COMPLETE";

  return {
    ...state,
    phase,
    observation,
    events: [
      ...state.events,
      {
        at: new Date().toISOString(),
        phase: "OBSERVING",
        event: "EXECUTION_OBSERVED",
        detail:
          mutationObserved
            ? "mutation observed"
            : "no mutation observed",
      },
    ],
  };
}
