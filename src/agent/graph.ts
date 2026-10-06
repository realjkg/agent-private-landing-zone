import { randomUUID } from "node:crypto";

import { runBuildLoop } from "../build/loop.js";
import {
  classifyIntent,
} from "./intent.js";
import { sense } from "./sense.js";
import { understand } from "./understand.js";
import { think } from "./think.js";
import { plan } from "./plan.js";
import { act } from "./act.js";
import { observe } from "./observe.js";
import type {
  AgentKernelOptions,
  AgentState,
} from "./types.js";

export async function runAgentKernel(
  options: AgentKernelOptions,
): Promise<AgentState> {
  let state: AgentState = {
    requestId: randomUUID(),
    request: options.request,
    phase: "RECEIVED",
    intent: classifyIntent(options.request),
    provider: options.provider,
    engine: options.engine,
    mock: options.mock,
    events: [
      {
        at: new Date().toISOString(),
        phase: "RECEIVED",
        event: "REQUEST_RECEIVED",
      },
    ],
  };

  try {
    state = await sense(state);
    state = understand(state);

    if (
      state.intent === "ASSESS" ||
      state.intent === "BUILD" ||
      state.intent === "CHANGE"
    ) {
      if (options.thinker) {
        state = await think(
          state,
          options.thinker,
        );
      } else if (
        process.env.AGENT_SKIP_LOCAL_MODEL !== "1"
      ) {
        state = await think(state);
      }
    }

    state = plan(state);

    const buildRequested =
      state.intent === "BUILD" ||
      state.intent === "CHANGE";

    const buildPermitted =
      state.environment?.classification !== "UNKNOWN" &&
      state.environment?.safeBuildMode !== "READ_ONLY" &&
      state.environment?.safeBuildMode !== "BLOCKED" &&
      state.assessment?.status !== "ABSTAIN" &&
      state.assessment?.status !== "DATA_REQUIRED";

    if (buildRequested && buildPermitted) {
      const build = await runBuildLoop({
        provider: state.provider,
        engine: state.engine,
        mock: state.mock,
        approve: options.approveBuild,
      });

      state = {
        ...state,
        phase:
          build.gate.allowed
            ? "AWAITING_APPROVAL"
            : "BUILDING",
        build,
        events: [
          ...state.events,
          {
            at: new Date().toISOString(),
            phase: "BUILDING",
            event: "BUILD_CANDIDATE_CREATED",
            detail:
              build.gate.allowed
                ? "gate passed in preview-only mode"
                : "gate stopped candidate",
          },
        ],
      };
    }

    state = act(state);
    state = observe(state);

    return state;
  } catch (error) {
    return {
      ...state,
      phase: "FAILED",
      error:
        error instanceof Error
          ? error.message
          : "Unknown agent-kernel error",
      events: [
        ...state.events,
        {
          at: new Date().toISOString(),
          phase: "FAILED",
          event: "AGENT_KERNEL_FAILED",
          detail:
            error instanceof Error
              ? error.message
              : "Unknown error",
        },
      ],
    };
  }
}
