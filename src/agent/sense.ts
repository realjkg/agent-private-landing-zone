import { discoverEnvironment } from "../discovery/discover.js";
import {
  assessEnvironment,
} from "../assessment/posture.js";
import type { AgentState } from "./types.js";

export async function sense(
  state: AgentState,
): Promise<AgentState> {
  const environment = await discoverEnvironment({
    provider: state.provider,
    mock: state.mock,
  });

  const postureAssessment =
    assessEnvironment(environment);

  return {
    ...state,
    phase: "SENSING",
    environment,
    postureAssessment,
    events: [
      ...state.events,
      {
        at: new Date().toISOString(),
        phase: "SENSING",
        event: "ENVIRONMENT_SENSED",
        detail:
          `${environment.provider}/${environment.classification}/${environment.safeBuildMode}/security=${postureAssessment.securityStatus}/resiliency=${postureAssessment.resiliency.status}`,
      },
    ],
  };
}
