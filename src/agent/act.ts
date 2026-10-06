import type {
  ActionResult,
  AgentState,
} from "./types.js";

export function act(
  state: AgentState,
): AgentState {
  const result: ActionResult = {
    attempted: state.intent === "CHANGE",
    executed: false,
    status:
      state.intent === "CHANGE"
        ? "DISABLED"
        : "NOT_REQUIRED",
    reason:
      state.intent === "CHANGE"
        ? "ACT_DISABLED: real cloud mutation is not enabled in this iteration."
        : "No mutation was requested.",
  };

  return {
    ...state,
    phase:
      result.status === "DISABLED"
        ? "BLOCKED"
        : "ACTING",
    action: result,
    events: [
      ...state.events,
      {
        at: new Date().toISOString(),
        phase:
          result.status === "DISABLED"
            ? "BLOCKED"
            : "ACTING",
        event: "ACTION_EVALUATED",
        detail: result.reason,
      },
    ],
  };
}
