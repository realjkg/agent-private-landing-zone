import {
  randomUUID,
} from "node:crypto";

import {
  fixtureThinker,
} from "../agent/fixture.js";
import {
  runAgentKernel,
} from "../agent/graph.js";
import {
  classifyIntent,
} from "../agent/intent.js";
import type {
  AgentKernelOptions,
  AgentState,
} from "../agent/types.js";
import type {
  IaCEngine,
} from "../build/types.js";
import type {
  MockScenario,
  Provider,
} from "../discovery/types.js";
import {
  createOrchestrationPlan,
} from "../orchestration/plan.js";
import {
  evaluateOperatorRequest,
} from "../session/operator-policy.js";
import {
  buildDebugReport,
  type DebugModelInventory,
  type DebugReport,
} from "./report.js";

export type DebugKernelRunner = (
  options: AgentKernelOptions,
) => Promise<AgentState>;

function blockedState(input: {
  request: string;
  provider: Provider;
  engine: IaCEngine;
  mock: MockScenario;
  reason: string;
}): AgentState {
  const requestId =
    randomUUID();
  const startedAt =
    new Date().toISOString();
  const intent =
    classifyIntent(
      input.request,
    );
  const orchestration =
    createOrchestrationPlan({
      taskId:
        "task:" + requestId,
      requestId,
      request:
        input.request,
      intent,
      provider:
        input.provider,
      engine: input.engine,
      evidenceRefs: [],
    });

  return {
    requestId,
    request:
      input.request,
    startedAt,
    completedAt:
      startedAt,
    durationMs: 0,
    phase: "BLOCKED",
    intent,
    provider:
      input.provider,
    engine: input.engine,
    orchestration,
    mock: input.mock,
    events: [
      {
        at: startedAt,
        phase: "BLOCKED",
        event:
          "DEBUG_POLICY_BLOCKED",
        detail: input.reason,
      },
    ],
    action: {
      attempted: false,
      executed: false,
      status: "BLOCKED",
      reason: input.reason,
    },
    observation: {
      verified: true,
      mutationObserved: false,
      evidence: [],
    },
  };
}

export async function runDebugDiagnostic(input: {
  request: string;
  provider: Provider;
  engine: IaCEngine;
  mock: MockScenario;
  fixture: boolean;
  models: DebugModelInventory[];
  runKernel?: DebugKernelRunner;
}): Promise<DebugReport> {
  const policy =
    evaluateOperatorRequest(
      input.request,
      false,
    );

  if (!policy.allowed) {
    return buildDebugReport({
      state: blockedState({
        request:
          input.request,
        provider:
          input.provider,
        engine:
          input.engine,
        mock:
          input.mock,
        reason:
          policy.reason,
      }),
      policy,
      models: input.models,
    });
  }

  const kernel =
    input.runKernel ??
    runAgentKernel;
  const state =
    await kernel({
      request:
        input.request,
      provider:
        input.provider,
      engine:
        input.engine,
      mock:
        input.mock,
      thinker:
        input.fixture
          ? fixtureThinker
          : undefined,
      approveBuild: false,
    });

  return buildDebugReport({
    state,
    policy,
    models: input.models,
  });
}
