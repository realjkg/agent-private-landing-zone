import { discoverEnvironment } from "../discovery/discover.js";
import type { AgentState } from "./types.js";

export async function sense(
  state: AgentState,
): Promise<AgentState> {
  const environment = await discoverEnvironment({
    provider: state.provider,
    mock: state.mock,
  });

  return {
    ...state,
    phase: "SENSING",
    environment,
    events: [
      ...state.events,
      {
        at: new Date().toISOString(),
        phase: "SENSING",
        event: "ENVIRONMENT_SENSED",
        detail:
          `${environment.provider}/${environment.classification}/${environment.safeBuildMode}`,
      },
    ],
  };
}
