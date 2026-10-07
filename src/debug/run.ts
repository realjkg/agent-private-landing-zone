import {
  randomUUID,
} from "node:crypto";
import {
  mkdirSync,
  readdirSync,
  statSync,
  unlinkSync,
} from "node:fs";
import {
  resolve,
} from "node:path";

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
  createSessionGraph,
} from "../session/graph.js";
import {
  evaluateOperatorRequest,
} from "../session/operator-policy.js";
import {
  emitDebugDiagnostic,
  withDebugDiagnosticContext,
} from "./context.js";
import {
  buildDebugReport,
  type DebugCheckpointDiagnostic,
  type DebugModelInventory,
  type DebugReport,
} from "./report.js";

export type DebugKernelRunner = (
  options: AgentKernelOptions,
) => Promise<AgentState>;

function blockedState(input: {
  requestId: string;
  request: string;
  provider: Provider;
  engine: IaCEngine;
  mock: MockScenario;
  reason: string;
}): AgentState {
  const startedAt =
    new Date().toISOString();
  const intent =
    classifyIntent(
      input.request,
    );
  const orchestration =
    createOrchestrationPlan({
      taskId:
        "task:" +
        input.requestId,
      requestId:
        input.requestId,
      request:
        input.request,
      intent,
      provider:
        input.provider,
      engine: input.engine,
      evidenceRefs: [],
    });

  return {
    requestId:
      input.requestId,
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

function pruneCheckpoints(
  directory: string,
): void {
  const maxFiles = 50;
  const maxAgeMs =
    7 * 24 * 60 * 60 * 1000;
  const now = Date.now();

  const files =
    readdirSync(
      directory,
    )
      .filter(
        (name) =>
          name.endsWith(
            ".sqlite",
          ) ||
          name.endsWith(
            ".sqlite-shm",
          ) ||
          name.endsWith(
            ".sqlite-wal",
          ),
      )
      .map((name) => {
        const path =
          resolve(
            directory,
            name,
          );
        return {
          path,
          mtimeMs:
            statSync(path)
              .mtimeMs,
        };
      })
      .sort(
        (a, b) =>
          b.mtimeMs -
          a.mtimeMs,
      );

  for (
    let index = 0;
    index < files.length;
    index += 1
  ) {
    const file =
      files[index];

    if (
      index >= maxFiles ||
      now - file.mtimeMs >
        maxAgeMs
    ) {
      unlinkSync(
        file.path,
      );
    }
  }
}

async function probeCheckpoint(
  runId: string,
): Promise<
  DebugCheckpointDiagnostic
> {
  const directory = resolve(
    ".runs",
    "debug",
    "checkpoints",
  );
  mkdirSync(
    directory,
    {
      recursive: true,
      mode: 0o700,
    },
  );
  pruneCheckpoints(
    directory,
  );

  const dbPath = resolve(
    directory,
    runId + ".sqlite",
  );
  const relativePath =
    ".runs/debug/checkpoints/" +
    runId +
    ".sqlite";
  const config = {
    configurable: {
      thread_id: runId,
    },
  };
  const baseInput = {
    provider:
      "AWS" as const,
    engine:
      "TERRAFORM" as const,
    mock:
      "brownfield" as const,
    approveBuild: false,
    fixture: true,
  };

  try {
    const first =
      createSessionGraph(
        dbPath,
        () => {},
        async () => [],
      ).graph;
    const firstResult =
      await first.invoke(
        {
          ...baseInput,
          request:
            "What is the current state?",
        },
        config,
      );
    const historyBefore =
      firstResult.history
        ?.length ?? 0;

    const reopened =
      createSessionGraph(
        dbPath,
        () => {},
        async () => [],
      ).graph;
    const secondResult =
      await reopened.invoke(
        {
          ...baseInput,
          request:
            "Summarize the current state.",
        },
        config,
      );
    const historyAfter =
      secondResult.history
        ?.length ?? 0;
    const continued =
      historyBefore > 0 &&
      historyAfter >
        historyBefore;

    emitDebugDiagnostic({
      kind: "CHECKPOINT",
      component:
        "langgraph-session",
      status: continued
        ? "OK"
        : "FAILED",
      detail: continued
        ? "SQLite checkpoint reopened and prior session history continued."
        : "SQLite checkpoint did not demonstrate history continuation.",
      attributes: {
        backend: "SQLITE",
        threadId: runId,
        relativePath,
        historyBefore,
        historyAfter,
      },
    });

    return {
      status: continued
        ? "OK"
        : "FAILED",
      backend: "SQLITE",
      threadId: runId,
      relativePath,
      historyBefore,
      historyAfter,
      continued,
    };
  } catch (error) {
    const detail =
      error instanceof Error
        ? error.message
        : "checkpoint probe failed";

    emitDebugDiagnostic({
      kind: "CHECKPOINT",
      component:
        "langgraph-session",
      status: "FAILED",
      detail,
      attributes: {
        backend: "SQLITE",
        threadId: runId,
        relativePath,
      },
    });

    return {
      status: "FAILED",
      backend: "SQLITE",
      threadId: runId,
      relativePath,
      historyBefore: 0,
      historyAfter: 0,
      continued: false,
      detail,
    };
  }
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
  const runId =
    randomUUID();

  const captured =
    await withDebugDiagnosticContext(
      runId,
      async () => {
        const policy =
          evaluateOperatorRequest(
            input.request,
            false,
          );

        emitDebugDiagnostic({
          kind: "POLICY",
          component:
            "operator-policy",
          status: policy.allowed
            ? "OK"
            : "BLOCKED",
          detail: policy.allowed
            ? "Operator request passed deterministic policy."
            : policy.reason,
          attributes:
            policy.allowed
              ? {
                  allowed: true,
                }
              : {
                  allowed: false,
                  boundary:
                    policy.boundary,
                  safeAlternative:
                    policy.safeAlternative,
                },
        });

        if (!policy.allowed) {
          return {
            policy,
            checkpoint: {
              status:
                "NOT_RUN",
              backend:
                "NONE",
              historyBefore: 0,
              historyAfter: 0,
              continued: false,
            } satisfies DebugCheckpointDiagnostic,
            state:
              blockedState({
                requestId: runId,
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
          };
        }

        const checkpoint =
          input.runKernel
            ? {
                status:
                  "NOT_RUN" as const,
                backend:
                  "NONE" as const,
                historyBefore: 0,
                historyAfter: 0,
                continued: false,
              }
            : await probeCheckpoint(
                runId,
              );

        const kernel =
          input.runKernel ??
          runAgentKernel;
        const state =
          await kernel({
            requestId: runId,
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

        if (
          /INVALID_MODEL_OUTPUT|INVALID_ROUTER_OUTPUT|SCHEMA|JSON/i.test(
            state.error ?? "",
          )
        ) {
          emitDebugDiagnostic({
            kind: "SCHEMA",
            component:
              "model-structured-output",
            status: "FAILED",
            detail:
              state.error,
            attributes: {
              retryCount: 0,
              fallback:
                "FAIL_CLOSED",
            },
          });
        } else if (
          state.assessment
        ) {
          emitDebugDiagnostic({
            kind: "SCHEMA",
            component:
              "model-structured-output",
            status: "OK",
            attributes: {
              retryCount: 0,
              fallback:
                "FAIL_CLOSED",
            },
          });
        }

        return {
          policy,
          checkpoint,
          state,
        };
      },
    );

  return buildDebugReport({
    state:
      captured.value.state,
    policy:
      captured.value.policy,
    models: input.models,
    checkpoint:
      captured.value
        .checkpoint,
    diagnostics:
      captured.events,
  });
}
