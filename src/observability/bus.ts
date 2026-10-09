import {
  createOperationalEvent,
  JsonLineEventSink,
  type OperationalEvent,
  type ProductionSignal,
} from "./events.js";
import {
  exportOperationalEvent,
} from "../monitoring/export.js";
import type {
  MonitoringBinding,
  MonitoringTransport,
} from "../monitoring/types.js";
import {
  validateMonitoringBinding,
} from "../monitoring/validate.js";
import type {
  RuntimeProfileId,
} from "../runtime-profile/types.js";
import type {
  ObservabilityConfig,
} from "../config.js";

/**
 * Best-effort event delivery contract: a sink failure is never allowed to
 * propagate into the governed command that emitted the event.
 */
export type EventSink = {
  emit(event: OperationalEvent): void;
};

export type EventExporter = {
  export(event: OperationalEvent): Promise<void>;
};

export type EmitInput = {
  signal: ProductionSignal;
  status: OperationalEvent["status"];
  component: string;
  durationMs?: number;
  detail?: string;
  attributes?: Record<string, unknown>;
  /** Observation time; defaults to now. Preserved when re-emitting built events (e.g. economics reports). */
  at?: string;
};

/**
 * Structural emission seam for modules that own a signal but must not depend
 * on the concrete bus: entrypoints pass the process bus down; everything
 * defaults to this no-op so unwired paths stay silent instead of crashing.
 */
export type Emitter = {
  emit(input: EmitInput): void;
};

export const DISABLED_EMITTER: Emitter = {
  emit: () => {},
};

/**
 * Sovereignty gate for the export fan-out. When exporters are configured the
 * binding is validated once against the runtime profile; a failing gate
 * disables export for the life of the bus (fail-closed).
 */
export type MonitoringExportGate = {
  profileId: RuntimeProfileId;
  binding: MonitoringBinding;
};

export type ObservabilityBusOptions = {
  sinks?: EventSink[];
  exporters?: EventExporter[];
  exportGate?: MonitoringExportGate;
  warn?: (line: string) => void;
};

/**
 * Warn lines go to the diagnostics stream (stderr), never back through the
 * bus: no re-emission, no export, no metric — that is what keeps a warn from
 * recursing. Configurable so tests can capture diagnostics.
 */
function defaultWarn(line: string): void {
  try {
    process.stderr.write(line + "\n");
  } catch {
    // The diagnostics channel is the last resort; it must not throw either.
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function escapeLabelValue(value: string): string {
  return value
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replaceAll("\n", "\\n");
}

type AggregateEntry = {
  signal: ProductionSignal;
  status: OperationalEvent["status"];
  component: string;
  total: number;
  lastDurationMs?: number;
};

function aggregateKey(entry: {
  signal: string;
  status: string;
  component: string;
}): string {
  return entry.signal + "\u0000" + entry.status + "\u0000" + entry.component;
}

function compareEntries(a: AggregateEntry, b: AggregateEntry): number {
  const aKey = aggregateKey(a);
  const bKey = aggregateKey(b);
  return aKey < bKey ? -1 : aKey > bKey ? 1 : 0;
}

function metricSample(
  metric: string,
  entry: AggregateEntry,
  value: number,
): string {
  const labels = [
    'signal="' + escapeLabelValue(entry.signal) + '"',
    'status="' + escapeLabelValue(entry.status) + '"',
    'component="' + escapeLabelValue(entry.component) + '"',
  ].join(",");

  return metric + "{" + labels + "} " + value;
}

/**
 * Process-local fan-out point for operational events. Every governed command
 * path emits through one bus; the JSON-line sink (default on), the metrics
 * registry, and — only when a configured binding validates — the monitoring
 * export consume independently. Emission is best-effort by construction:
 * observability failures degrade to warn lines and never fail a command.
 */
export class ObservabilityBus {
  private readonly sinks: EventSink[];
  private readonly exporters: EventExporter[];
  private readonly exportGate?: MonitoringExportGate;
  private readonly warn: (line: string) => void;
  private readonly counters = new Map<string, AggregateEntry>();

  private exportGateState?: "allowed" | "denied";

  constructor(options: ObservabilityBusOptions = {}) {
    this.sinks = options.sinks ?? [new JsonLineEventSink()];
    this.exporters = options.exporters ?? [];
    this.exportGate = options.exportGate;
    this.warn = options.warn ?? defaultWarn;
  }

  emit(input: EmitInput): void {
    // createOperationalEvent applies secret redaction before any consumer
    // (sink, registry, exporter) sees the event.
    let event: OperationalEvent;
    try {
      event = createOperationalEvent({
        ...input,
      });
    } catch (error) {
      this.warn(
        "[warn] OBSERVABILITY_EVENT_DROPPED: " + describeError(error),
      );
      return;
    }

    this.deliver(event);
  }

  /**
   * Delivers an already-constructed schema-v1 event (redaction already
   * applied by createOperationalEvent) to the sinks, registry, and
   * exporters — for callers that build events outside emit(), such as
   * the economics report.
   */
  deliver(event: OperationalEvent): void {
    for (const sink of this.sinks) {
      try {
        sink.emit(event);
      } catch (error) {
        // A sink failure degrades to a warn line; it never fails the command.
        this.warn(
          "[warn] OBSERVABILITY_SINK_FAILED: " + describeError(error),
        );
      }
    }

    this.aggregate(event);
    this.tryExport(event);
  }

  /**
   * Prometheus text exposition. Counters are monotonic totals aggregated by
   * signal/status/component — never per-event samples; the duration metric is
   * a gauge carrying the most recent observed duration for the label set.
   */
  metrics(): string {
    const entries = [...this.counters.values()].sort(compareEntries);

    const lines = [
      "# HELP alz_operational_event_total Sovereign Landing Zone operational events.",
      "# TYPE alz_operational_event_total counter",
    ];

    for (const entry of entries) {
      lines.push(
        metricSample("alz_operational_event_total", entry, entry.total),
      );
    }

    const withDuration = entries.filter(
      (entry) => entry.lastDurationMs !== undefined,
    );

    if (withDuration.length > 0) {
      lines.push(
        "# HELP alz_operational_event_duration_milliseconds Duration of a Sovereign Landing Zone operational event.",
        "# TYPE alz_operational_event_duration_milliseconds gauge",
      );

      for (const entry of withDuration) {
        lines.push(
          metricSample(
            "alz_operational_event_duration_milliseconds",
            entry,
            entry.lastDurationMs as number,
          ),
        );
      }
    }

    return lines.join("\n") + "\n";
  }

  private aggregate(event: OperationalEvent): void {
    const existing = this.counters.get(
      aggregateKey({
        signal: event.signal,
        status: event.status,
        component: event.component,
      }),
    );

    if (existing) {
      existing.total += 1;
      if (event.durationMs !== undefined) {
        existing.lastDurationMs = event.durationMs;
      }
      return;
    }

    this.counters.set(
      aggregateKey({
        signal: event.signal,
        status: event.status,
        component: event.component,
      }),
      {
        signal: event.signal,
        status: event.status,
        component: event.component,
        total: 1,
        ...(event.durationMs !== undefined
          ? { lastDurationMs: event.durationMs }
          : {}),
      },
    );
  }

  private tryExport(event: OperationalEvent): void {
    if (
      this.exporters.length === 0 ||
      this.exportGateState === "denied"
    ) {
      return;
    }

    if (this.exportGateState === undefined) {
      const verdict = this.resolveExportGate();

      if (!verdict.allowed) {
        this.exportGateState = "denied";
        // Exactly one warn line; export stays disabled for the life of the bus.
        this.warn(
          "[warn] MONITORING_EXPORT_DISABLED: " +
            verdict.reasons.join(" "),
        );
        return;
      }

      this.exportGateState = "allowed";
    }

    for (const exporter of this.exporters) {
      exporter.export(event).catch((error: unknown) => {
        // An export failure degrades to a warn line; it never fails the command.
        this.warn(
          "[warn] MONITORING_EXPORT_FAILED: " + describeError(error),
        );
      });
    }
  }

  private resolveExportGate(): {
    allowed: boolean;
    reasons: string[];
  } {
    if (!this.exportGate) {
      // Exporters without a gate are refused: the binding-validation boundary
      // is not optional for anything that leaves the process.
      return {
        allowed: false,
        reasons: [
          "No monitoring export gate configured; export requires a validated binding.",
        ],
      };
    }

    try {
      return validateMonitoringBinding(
        this.exportGate.profileId,
        this.exportGate.binding,
      );
    } catch (error) {
      // Fail closed: a validator failure disables export, it never crashes.
      return {
        allowed: false,
        reasons: [
          "Monitoring binding validation failed: " + describeError(error),
        ],
      };
    }
  }
}

/**
 * Built-in exporter over the existing direct-event-export path. The transport
 * stays injectable, exactly as exportOperationalEvent defines it.
 */
export function monitoringExporter(input: {
  profileId: RuntimeProfileId;
  binding: MonitoringBinding;
  transport: MonitoringTransport;
}): EventExporter {
  return {
    export: (event: OperationalEvent) =>
      exportOperationalEvent(
        input.profileId,
        input.binding,
        event,
        input.transport,
      ).then(() => undefined),
  };
}

/**
 * The one bus constructor entrypoints use: structured events default on
 * (stdout JSON lines) and `ALZ_OBSERVABILITY_EVENTS=false` disables the sink
 * while keeping the bus callable, so emission sites never need null checks.
 * Export wiring stays out: exporters are opt-in and gate-validated.
 */
export function createConfiguredBus(
  config: ObservabilityConfig,
): ObservabilityBus {
  return new ObservabilityBus({
    sinks: config.eventsEnabled
      ? [new JsonLineEventSink()]
      : [],
  });
}
