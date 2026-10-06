import type {
  AgentPlan,
  AgentState,
} from "./types.js";

export function plan(
  state: AgentState,
): AgentState {
  if (!state.environment || !state.understanding) {
    throw new Error(
      "AGENT_STATE_ERROR: sense and understand must run before plan",
    );
  }

  const steps: AgentPlan["steps"] = [
    "DISCOVER",
  ];
  const reasons: string[] = [];

  if (
    state.intent === "ASSESS" ||
    state.intent === "DESIGN" ||
    state.intent === "BUILD" ||
    state.intent === "CHANGE"
  ) {
    steps.push("ASSESS");
  }

  if (
    state.intent === "DESIGN" ||
    state.intent === "BUILD" ||
    state.intent === "CHANGE"
  ) {
    steps.push("DESIGN");
  }

  if (
    state.intent === "BUILD" ||
    state.intent === "CHANGE"
  ) {
    steps.push(
      "BUILD",
      "VALIDATE",
      "APPROVE",
    );
  }

  if (state.intent === "CHANGE") {
    steps.push("ACT");
  }

  if (state.intent === "ANSWER") {
    steps.push("ANSWER");
  }

  steps.push("OBSERVE");

  let mutationAllowed = false;

  if (state.intent === "CHANGE") {
    reasons.push(
      "ACT is intentionally disabled in this accelerator iteration.",
    );
  }

  if (
    state.environment.classification === "UNKNOWN"
  ) {
    reasons.push(
      "UNKNOWN environment prevents build or mutation.",
    );
  }

  if (
    state.environment.safeBuildMode === "READ_ONLY" ||
    state.environment.safeBuildMode === "BLOCKED"
  ) {
    reasons.push(
      `Environment safe mode is ${state.environment.safeBuildMode}.`,
    );
  }

  if (
    state.assessment?.status === "ABSTAIN" ||
    state.assessment?.status === "DATA_REQUIRED"
  ) {
    reasons.push(
      `Assessment status is ${state.assessment.status}.`,
    );
  }

  const result: AgentPlan = {
    intent: state.intent,
    steps,
    mutationAllowed,
    requiresApproval:
      state.understanding.approvalRequired,
    reasons,
  };

  return {
    ...state,
    phase: "PLANNING",
    plan: result,
    events: [
      ...state.events,
      {
        at: new Date().toISOString(),
        phase: "PLANNING",
        event: "PLAN_CREATED",
        detail: steps.join(" → "),
      },
    ],
  };
}
