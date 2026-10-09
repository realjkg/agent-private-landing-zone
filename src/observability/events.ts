import {
  redactDiagnosticValue,
  sanitizeDiagnosticText,
} from "./redaction.js";
export const PRODUCTION_SIGNALS = [
  "model-latency",
  "model-restarts",
  "adapter-failures",
  "policy-denials",
  "provider-discovery-health",
  "recovery-state",
  "recovery-objective-status",
  "evidence-lifecycle",
  "economics-budget",
  "economics-anomaly",
  "economics-forecast",
] as const;

export type ProductionSignal =
  (typeof PRODUCTION_SIGNALS)[number];

export const OPERATIONAL_EVENT_STATUSES = [
  "OK",
  "DEGRADED",
  "BLOCKED",
  "FAILED",
] as const;

export type OperationalEventStatus =
  (typeof OPERATIONAL_EVENT_STATUSES)[number];

export type OperationalEvent = {
  schemaVersion: 1;
  at: string;
  signal: ProductionSignal;
  status: OperationalEventStatus;
  component: string;
  durationMs?: number;
  detail?: string;
  attributes: Record<
    string,
    unknown
  >;
};

export function createOperationalEvent(input: {
  signal: ProductionSignal;
  status:
    OperationalEvent["status"];
  component: string;
  durationMs?: number;
  detail?: string;
  attributes?: Record<
    string,
    unknown
  >;
  at?: string;
}): OperationalEvent {
  return {
    schemaVersion: 1,
    at:
      input.at ??
      new Date().toISOString(),
    signal: input.signal,
    status: input.status,
    component:
      input.component,
    ...(input.durationMs !==
    undefined
      ? {
          durationMs:
            input.durationMs,
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
  };
}

export function serializeOperationalEvent(
  event: OperationalEvent,
): string {
  return JSON.stringify(
    createOperationalEvent({
      signal:
        event.signal,
      status:
        event.status,
      component:
        event.component,
      durationMs:
        event.durationMs,
      detail:
        event.detail,
      attributes:
        event.attributes,
      at: event.at,
    }),
  );
}

export type OperationalEventWriter = (
  line: string,
) => void;

export class JsonLineEventSink {
  constructor(
    private readonly writer:
      OperationalEventWriter =
        (line) =>
          process.stdout.write(
            line + "\n",
          ),
  ) {}

  emit(
    event: OperationalEvent,
  ): void {
    this.writer(
      serializeOperationalEvent(
        event,
      ),
    );
  }
}
