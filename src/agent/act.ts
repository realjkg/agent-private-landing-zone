import type {
  ActionResult,
  AgentState,
} from "./types.js";

export function act(
  state: AgentState,
): AgentState {
  let result: ActionResult;
  let phase = state.phase;

  if (state.intent === "CHANGE") {
    result = {
      attempted: true,
      executed: false,
      status: "DISABLED",
      reason:
        "ACT_DISABLED: real cloud mutation is not enabled in this iteration.",
    };
    phase = "BLOCKED";
  } else if (state.phase === "AWAITING_APPROVAL") {
    result = {
      attempted: false,
      executed: false,
      status: "AWAITING_APPROVAL",
      reason:
        "Hash-bound human approval is required before any future action.",
    };
    phase = "AWAITING_APPROVAL";
  } else if (state.phase === "BLOCKED") {
    result = {
      attempted: false,
      executed: false,
      status: "BLOCKED",
      reason:
        "A deterministic policy or evidence gate blocked progression.",
    };
    phase = "BLOCKED";
  } else {
    result = {
      attempted: false,
      executed: false,
      status: "NOT_REQUIRED",
      reason: "No mutation was requested.",
    };
    phase = "ACTING";
  }

  return {
    ...state,
    phase,
    action: result,
    events: [
      ...state.events,
      {
        at: new Date().toISOString(),
        phase,
        event: "ACTION_EVALUATED",
        detail: result.reason,
      },
    ],
  };
}
