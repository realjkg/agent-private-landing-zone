import { randomUUID } from "node:crypto";

import { runBuildLoop } from "../build/loop.js";
import { act } from "./act.js";
import { classifyIntent } from "./intent.js";
import {
  appendEvent,
  timedStep,
} from "./observability.js";
import { observe } from "./observe.js";
import { plan } from "./plan.js";
import { sense } from "./sense.js";
import { think } from "./think.js";
import { understand } from "./understand.js";
import type {
  AgentKernelOptions,
  AgentState,
} from "./types.js";

export async function runAgentKernel(
  options: AgentKernelOptions,
): Promise<AgentState> {
  const startedMs = Date.now();
  const startedAt = new Date().toISOString();

  let state: AgentState = {
    requestId: randomUUID(),
    request: options.request,
    startedAt,
    phase: "RECEIVED",
    intent: classifyIntent(options.request),
    provider: options.provider,
    engine: options.engine,
    mock: options.mock,
    events: [
      {
        at: startedAt,
        phase: "RECEIVED",
        event: "REQUEST_RECEIVED",
      },
    ],
  };

  try {
    state = await timedStep(
      state,
      "SENSING",
      "SENSE_COMPLETE",
      sense,
    );

    state = await timedStep(
      state,
      "UNDERSTANDING",
      "UNDERSTAND_COMPLETE",
      (current) => understand(current),
    );

    const reasoningRequired =
      state.intent === "ASSESS" ||
      state.intent === "BUILD" ||
      state.intent === "CHANGE";

    if (reasoningRequired) {
      if (options.thinker) {
        state = await timedStep(
          state,
          "THINKING",
          "THINK_COMPLETE",
          (current) =>
            think(current, options.thinker),
        );
      } else if (
        process.env.AGENT_SKIP_LOCAL_MODEL !== "1"
      ) {
        state = await timedStep(
          state,
          "THINKING",
          "THINK_COMPLETE",
          think,
        );
      } else {
        state = appendEvent(state, {
          phase: "THINKING",
          event: "THINK_SKIPPED",
          detail:
            "Local model execution disabled; build/change cannot proceed without assessment.",
        });
      }
    }

    state = await timedStep(
      state,
      "PLANNING",
      "PLAN_COMPLETE",
      (current) => plan(current),
    );

    const buildRequested =
      state.intent === "BUILD" ||
      state.intent === "CHANGE";

    const assessmentReady =
      state.assessment?.status === "OK";

    const environmentBuildable =
      state.environment?.classification !== "UNKNOWN" &&
      state.environment?.safeBuildMode !== "READ_ONLY" &&
      state.environment?.safeBuildMode !== "BLOCKED";

    const buildPermitted =
      buildRequested &&
      assessmentReady &&
      environmentBuildable;

    if (buildRequested && !buildPermitted) {
      state = {
        ...appendEvent(state, {
          phase: "BLOCKED",
          event: "BUILD_BLOCKED",
          detail:
            !assessmentReady
              ? "A successful assessment is required before Build."
              : "Environment policy does not permit Build.",
        }),
        phase: "BLOCKED",
      };
    }

    if (buildPermitted) {
      const buildStarted = Date.now();

      const build = await runBuildLoop({
        provider: state.provider,
        engine: state.engine,
        mock: state.mock,
        approve: options.approveBuild,
      });

      const approvalPending =
        !build.candidate.evidence.approvalId &&
        build.gate.reasons.length === 1 &&
        build.gate.reasons[0].includes(
          "Human approval",
        );

      const nextPhase =
        approvalPending
          ? "AWAITING_APPROVAL"
          : build.gate.allowed
            ? "BUILDING"
            : "BLOCKED";

      state = {
        ...state,
        phase: nextPhase,
        build,
      };

      state = appendEvent(state, {
        phase: nextPhase,
        event: "BUILD_CANDIDATE_CREATED",
        detail:
          approvalPending
            ? "candidate is valid and awaiting hash-bound approval"
            : build.gate.allowed
              ? "build gate passed in preview-only mode"
              : "build gate stopped candidate",
        durationMs: Date.now() - buildStarted,
      });
    }

    state = await timedStep(
      state,
      state.phase === "AWAITING_APPROVAL"
        ? "AWAITING_APPROVAL"
        : state.phase === "BLOCKED"
          ? "BLOCKED"
          : "ACTING",
      "ACT_EVALUATED",
      (current) => act(current),
    );

    state = await timedStep(
      state,
      "OBSERVING",
      "OBSERVE_COMPLETE",
      (current) => observe(current),
    );

    const completedAt = new Date().toISOString();

    return {
      ...state,
      completedAt,
      durationMs: Date.now() - startedMs,
    };
  } catch (error) {
    const completedAt = new Date().toISOString();

    return appendEvent(
      {
        ...state,
        phase: "FAILED",
        completedAt,
        durationMs: Date.now() - startedMs,
        error:
          error instanceof Error
            ? error.message
            : "Unknown agent-kernel error",
      },
      {
        phase: "FAILED",
        event: "AGENT_KERNEL_FAILED",
        detail:
          error instanceof Error
            ? error.message
            : "Unknown error",
      },
    );
  }
}
