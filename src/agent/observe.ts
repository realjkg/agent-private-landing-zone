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

  if (state.build) {
    evidence.push(
      `Build artifact hash: ${state.build.candidate.artifact.contentHash}`,
    );
    evidence.push(
      `Preview hash: ${state.build.candidate.evidence.planHash ?? "missing"}`,
    );
  }

  if (state.action) {
    evidence.push(
      `Action status: ${state.action.status}`,
    );
  }

  const observation: ObservationResult = {
    verified: !mutationObserved,
    mutationObserved,
    evidence,
  };

  return {
    ...state,
    phase:
      state.phase === "BLOCKED"
        ? "BLOCKED"
        : "COMPLETE",
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
