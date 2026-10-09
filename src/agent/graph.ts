import { sha256 } from "../build/provenance.js";
import { randomUUID } from "node:crypto";

import { runBuildLoop } from "../build/loop.js";
import { createDesignSpec } from "../design/create.js";
import {
  createOrchestrationPlan,
} from "../orchestration/plan.js";
import {
  hasIaCAdapter,
} from "../iac/index.js";
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
  const progress =
    options.progress ?? (() => {});

  const requestId =
    options.requestId ??
    randomUUID();
  const intent =
    classifyIntent(options.request);
  const orchestration =
    createOrchestrationPlan({
      taskId: "task:" + requestId,
      requestId,
      request: options.request,
      intent,
      provider: options.provider,
      engine: options.engine,
      evidenceRefs: [],
    });

  let state: AgentState = {
    requestId,
    request: options.request,
    startedAt,
    phase: "RECEIVED",
    intent,
    provider: options.provider,
    engine: options.engine,
    orchestration,
    mock: options.mock,
    events: [
      {
        at: startedAt,
        phase: "RECEIVED",
        event: "REQUEST_RECEIVED",
      },
      {
        at: startedAt,
        phase: "RECEIVED",
        event: "ORCHESTRATION_PLANNED",
        detail:
          orchestration.assignments
            .map(
              (assignment) =>
                assignment.role,
            )
            .join(" → ") ||
          "No specialist routing required.",
      },
    ],
  };

  try {
    progress("Sensing environment…");

    state = await timedStep(
      state,
      "SENSING",
      "SENSE_COMPLETE",
      sense,
    );

    progress("Understanding environment and safety boundaries…");

    state = await timedStep(
      state,
      "UNDERSTANDING",
      "UNDERSTAND_COMPLETE",
      (current) => understand(current),
    );

    const reasoningRequired =
      state.intent === "ASSESS" ||
      state.intent === "DESIGN" ||
      state.intent === "BUILD" ||
      state.intent === "CHANGE";

    if (reasoningRequired) {
      progress("Reasoning about the request…");

      const reportReasoning = (
        status: string,
        detail?: string,
      ): void => {
        if (status === "ROUTING") {
          progress(
            "Routing with local supervisor" +
              (detail ? " (" + detail + ")" : "") +
              "…",
          );
        } else if (status === "POLICY") {
          progress(
            "Applying deterministic policy controls…",
          );
        } else if (status === "PRIMARY") {
          progress(
            "Reasoning with primary local model" +
              (detail ? " (" + detail + ")" : "") +
              "…",
          );
        } else if (status === "VALIDATING") {
          progress(
            "Validating with independent local model" +
              (detail ? " (" + detail + ")" : "") +
              "…",
          );
        } else if (status === "ADJUDICATING") {
          progress(
            "Reconciling independent assessments…",
          );
        } else if (status === "DATA_REQUIRED") {
          progress(
            "Additional environment evidence is required.",
          );
        } else if (status === "ABSTAIN") {
          progress(
            "Independent assessments disagree; stopping safely.",
          );
        } else if (status === "COMPLETE") {
          progress("Reasoning complete.");
        } else if (status === "ERROR") {
          progress("Reasoning failed safely.");
        }
      };

      if (options.thinker) {
        state = await timedStep(
          state,
          "THINKING",
          "THINK_COMPLETE",
          (current) =>
            think(
              current,
              options.thinker,
              reportReasoning,
            ),
        );
      } else if (
        process.env.AGENT_SKIP_LOCAL_MODEL !== "1"
      ) {
        state = await timedStep(
          state,
          "THINKING",
          "THINK_COMPLETE",
          (current) =>
            think(
              current,
              undefined,
              reportReasoning,
            ),
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

    progress("Planning safe next steps…");

    state = await timedStep(
      state,
      "PLANNING",
      "PLAN_COMPLETE",
      (current) => plan(current),
    );

    const designRequested =
      state.intent === "DESIGN" ||
      state.intent === "BUILD" ||
      state.intent === "CHANGE";

    if (designRequested) {
      if (
        !state.environment ||
        !state.postureAssessment ||
        !state.deltaAssessment ||
        !state.understanding
      ) {
        throw new Error(
          "DESIGN_STATE_ERROR: discovery, posture, delta, and understanding are required.",
        );
      }

      progress("Creating evidence-linked DesignSpec…");

      const design = createDesignSpec({
        environment: state.environment,
        assessment: state.postureAssessment,
        delta: state.deltaAssessment,
        objective: state.request,
        constraints: state.understanding.constraints,
        engine: state.engine,
      });

      state = appendEvent(
        {
          ...state,
          phase: "DESIGNING",
          design,
        },
        {
          phase: "DESIGNING",
          event: "DESIGN_CREATED",
          detail:
            design.plugin.plugin +
            "/" +
            design.status +
            "/" +
            design.designHash.slice(0, 12),
        },
      );
    }

    const buildRequested =
      state.intent === "BUILD" ||
      state.intent === "CHANGE";

    const assessmentReady =
      state.assessment?.status === "OK";

    const environmentBuildable =
      state.environment?.classification !== "UNKNOWN" &&
      state.environment?.safeBuildMode !== "READ_ONLY" &&
      state.environment?.safeBuildMode !== "BLOCKED";

    const realDesignBoundary =
      state.mock === undefined && !options.realPrivateBuild;

    const designBuildable =
      state.design !== undefined &&
      state.design.status !== "BLOCKED" &&
      state.design.plugin.buildEligible &&
      hasIaCAdapter(
        state.design.plugin.plugin,
      );

    const buildPermitted =
      buildRequested &&
      assessmentReady &&
      environmentBuildable &&
      designBuildable &&
      !realDesignBoundary;

    if (buildRequested && !buildPermitted) {
      progress(
        "Build request blocked by safety prerequisites.",
      );

      state = {
        ...appendEvent(state, {
          phase: "BLOCKED",
          event: "BUILD_BLOCKED",
          detail:
            !assessmentReady
              ? "A successful assessment is required before Build."
              : !environmentBuildable
                ? "Environment policy does not permit Build."
                : !state.design
                  ? "Build requires an evidence-linked DesignSpec."
                  : state.design.status === "BLOCKED"
                    ? "DesignSpec is BLOCKED."
                    : !state.design.plugin.buildEligible
                      ? "Selected plug-in " + state.design.plugin.plugin + " is design-visible but its Build adapter is not implemented yet."
                      : realDesignBoundary
                  ? "Real Build is intentionally stopped at the Design boundary until an approved DesignSpec is implemented."
                  : "Build prerequisites are not satisfied.",
        }),
        phase: "BLOCKED",
      };
    }

    if (buildPermitted) {
      const design = state.design;

      if (!design) {
        throw new Error(
          "DESIGN_REQUIRED: Build cannot proceed without DesignSpec.",
        );
      }

      progress(
        "Preparing preview-only infrastructure candidate…",
      );

      const buildStarted = Date.now();

      const build = !state.mock && options.realPrivateBuild
        ? await options.realPrivateBuild(state)
        : await runBuildLoop({
            provider: state.provider,
            engine: design.plugin.plugin,
            mock: state.mock,
            approve: options.approveBuild,
            design,
          });

      // A real-mode callback must not launder fixture output or claim a plan
      // without matching live environment/DesignSpec/policy lineage.
      if (!state.mock && (
        build.candidate.artifact.generatedBy !==
          "local-qwen-mistral-reviewed-template" ||
        build.candidate.artifact.engine !== design.plugin.plugin ||
        build.candidate.artifact.provider !== state.provider ||
        build.candidate.evidence.discoverySnapshotHash !==
          sha256(JSON.stringify(state.environment)) ||
        build.candidate.evidence.designHash !== design.designHash ||
        build.candidate.evidence.policyBundleHash !== design.policies.bundleHash ||
        build.candidate.evidence.scannerResults.some((scanner) =>
          scanner.scanner.startsWith("fixture-")) ||
        build.candidate.evidence.scannerResults.length === 0 ||
        build.candidate.status !== "READY_FOR_APPROVAL" ||
        build.gate.allowed ||
        build.executionMode !== "PREVIEW_ONLY"
      )) {
        throw new Error("PRIVATE_BUILD_EVIDENCE_OR_TRUST_BOUNDARY_INVALID");
      }

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

    progress(
      "Checking approval and action boundary…",
    );

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

    progress(
      "Observing execution state and verifying no mutation…",
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
    progress("Stopped safely due to an execution error.");

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
