import type {
  AgentResult,
  EngineeringAssessment,
  StatusReporter,
} from "../loop.js";
import { runAgentLoop } from "../loop.js";
import {
  understandingEvidence,
} from "./understand.js";
import type {
  AgentState,
  Thinker,
} from "./types.js";

export const localModelThinker: Thinker = (
  request,
  evidence,
  report = () => {},
) =>
  runAgentLoop(
    request,
    evidence,
    report,
  );

function selectEngineeringAssessment(
  result: AgentResult,
): EngineeringAssessment | undefined {
  return result.primary;
}

export async function think(
  state: AgentState,
  thinker: Thinker = localModelThinker,
  report: StatusReporter = () => {},
): Promise<AgentState> {
  const evidence = understandingEvidence(state);

  const assessment = await thinker(
    state.request,
    evidence,
    report,
  );

  return {
    ...state,
    phase: "THINKING",
    assessment,
    engineeringAssessment:
      selectEngineeringAssessment(assessment),
    events: [
      ...state.events,
      {
        at: new Date().toISOString(),
        phase: "THINKING",
        event: "ENGINEERING_REASONING_COMPLETE",
        detail: assessment.status,
      },
    ],
  };
}
