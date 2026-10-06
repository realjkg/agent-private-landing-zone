import {
  intentRequestsMutation,
} from "./intent.js";
import type {
  AgentState,
  AgentUnderstanding,
} from "./types.js";

export function understand(
  state: AgentState,
): AgentState {
  if (!state.environment) {
    throw new Error(
      "AGENT_STATE_ERROR: environment is required before understanding",
    );
  }

  const mutationRequested = intentRequestsMutation(
    state.intent,
  );

  const constraints: string[] = [];

  if (state.environment.classification === "UNKNOWN") {
    constraints.push(
      "Environment is UNKNOWN; mutation is prohibited.",
    );
  }

  if (
    state.environment.safeBuildMode === "READ_ONLY" ||
    state.environment.safeBuildMode === "BLOCKED"
  ) {
    constraints.push(
      `Safe build mode is ${state.environment.safeBuildMode}.`,
    );
  }

  if (
    state.environment.classification === "BROWNFIELD"
  ) {
    constraints.push(
      "Brownfield changes must preserve existing ownership and remain additive-only.",
    );
  }

  constraints.push(
    "Existing customer or externally managed resources are not automatically adopted.",
  );
  constraints.push(
    "Delete authority is never granted by discovery.",
  );

  const understanding: AgentUnderstanding = {
    environmentKnown:
      state.environment.classification !== "UNKNOWN",
    environmentType: state.environment.classification,
    safeBuildMode: state.environment.safeBuildMode,
    requiresEvidence:
      state.environment.classification === "UNKNOWN",
    mutationRequested,
    approvalRequired:
      mutationRequested ||
      state.intent === "BUILD",
    constraints,
  };

  return {
    ...state,
    phase: "UNDERSTANDING",
    understanding,
    events: [
      ...state.events,
      {
        at: new Date().toISOString(),
        phase: "UNDERSTANDING",
        event: "CONTEXT_NORMALIZED",
        detail:
          `${understanding.environmentType}/approval=${understanding.approvalRequired}`,
      },
    ],
  };
}

export function understandingEvidence(
  state: AgentState,
): string {
  if (!state.environment || !state.understanding) {
    throw new Error(
      "AGENT_STATE_ERROR: environment and understanding required",
    );
  }

  return JSON.stringify(
    {
      provider: state.environment.provider,
      classification:
        state.environment.classification,
      controlPlane:
        state.environment.controlPlane,
      safeBuildMode:
        state.environment.safeBuildMode,
      ownershipSummary:
        state.environment.ownershipSummary,
      conflicts:
        state.environment.conflicts,
      warnings:
        state.environment.warnings,
      constraints:
        state.understanding.constraints,
    },
    null,
    2,
  );
}
