import {
  AsyncLocalStorage,
} from "node:async_hooks";

import {
  redactDiagnosticValue,
  sanitizeDiagnosticText,
} from "../observability/redaction.js";

export type DebugDiagnosticKind =
  | "POLICY"
  | "TOOL"
  | "ADAPTER"
  | "CHECKPOINT"
  | "SCHEMA"
  | "RECOVERY"
  | "RUNTIME";

export type DebugDiagnosticStatus =
  | "INFO"
  | "OK"
  | "BLOCKED"
  | "FAILED";

export type DebugDiagnosticEvent = {
  at: string;
  runId: string;
  kind: DebugDiagnosticKind;
  component: string;
  status: DebugDiagnosticStatus;
  durationMs?: number;
  decisionId?: string;
  detail?: string;
  attributes: Record<
    string,
    unknown
  >;
};

type DebugDiagnosticContext = {
  runId: string;
  events:
    DebugDiagnosticEvent[];
};

const storage =
  new AsyncLocalStorage<
    DebugDiagnosticContext
  >();

export async function withDebugDiagnosticContext<T>(
  runId: string,
  fn: () => Promise<T>,
): Promise<{
  value: T;
  events: DebugDiagnosticEvent[];
}> {
  const context:
    DebugDiagnosticContext = {
      runId,
      events: [],
    };

  const value =
    await storage.run(
      context,
      fn,
    );

  return {
    value,
    events: [
      ...context.events,
    ],
  };
}

export function currentDebugRunId():
  | string
  | undefined {
  return storage.getStore()
    ?.runId;
}

export function emitDebugDiagnostic(
  input: Omit<
    DebugDiagnosticEvent,
    "at" | "runId" | "attributes"
  > & {
    attributes?: Record<
      string,
      unknown
    >;
  },
): void {
  const context =
    storage.getStore();

  if (!context) {
    return;
  }

  context.events.push({
    at:
      new Date().toISOString(),
    runId: context.runId,
    kind: input.kind,
    component:
      input.component,
    status: input.status,
    ...(input.durationMs !==
    undefined
      ? {
          durationMs:
            input.durationMs,
        }
      : {}),
    ...(input.decisionId
      ? {
          decisionId:
            input.decisionId,
        }
      : {}),
    ...(input.detail
      ? {
          detail:
            sanitizeDiagnosticText(
              input.detail,
            ),
        }
      : {}),
    attributes:
      redactDiagnosticValue(
        input.attributes ?? {},
      ) as Record<
        string,
        unknown
      >,
  });
}
