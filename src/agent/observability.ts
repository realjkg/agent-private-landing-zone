import type {
  AgentEvent,
  AgentPhase,
  AgentState,
} from "./types.js";

export function appendEvent(
  state: AgentState,
  input: {
    phase: AgentPhase;
    event: string;
    detail?: string;
    durationMs?: number;
  },
): AgentState {
  const event: AgentEvent = {
    at: new Date().toISOString(),
    phase: input.phase,
    event: input.event,
    detail: input.detail,
    durationMs: input.durationMs,
  };

  return {
    ...state,
    events: [...state.events, event],
  };
}

export async function timedStep(
  state: AgentState,
  phase: AgentPhase,
  event: string,
  fn: (current: AgentState) => Promise<AgentState> | AgentState,
): Promise<AgentState> {
  const startedAt = Date.now();
  const next = await fn(state);

  return appendEvent(next, {
    phase,
    event,
    durationMs: Date.now() - startedAt,
  });
}
