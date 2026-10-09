import assert from "node:assert/strict";
import test from "node:test";

import {
  JsonLineEventSink,
  type OperationalEvent,
} from "../src/observability/events.js";
import {
  monitoringExporter,
  ObservabilityBus,
  type EventExporter,
  type EventSink,
  type MonitoringExportGate,
} from "../src/observability/bus.js";
import type {
  MonitoringRequest,
  MonitoringTransport,
} from "../src/monitoring/types.js";

const VALID_GATE: MonitoringExportGate = {
  profileId: "GOVERNED_ENTERPRISE_CONNECTED",
  binding: {
    provider: "OTEL_COLLECTOR",
    deployment: "LOCAL",
    endpoint: "http://127.0.0.1:4318",
  },
};

function capturingSink(lines: string[]): JsonLineEventSink {
  return new JsonLineEventSink((line) => lines.push(line));
}

function countingExporter(calls: OperationalEvent[]): EventExporter {
  return {
    export: (event) => {
      calls.push(event);
      return Promise.resolve();
    },
  };
}

function throwingSink(): EventSink {
  return {
    emit: () => {
      throw new Error("sink exploded");
    },
  };
}

function rejectingExporter(): EventExporter {
  return {
    export: () => Promise.reject(new Error("collector down")),
  };
}

async function drainQueue(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

function parseLines(lines: string[]): OperationalEvent[] {
  return lines.map((line) => JSON.parse(line) as OperationalEvent);
}

test("default bus emits one redacted JSON line per event and aggregates metrics", () => {
  const lines: string[] = [];
  const warnings: string[] = [];
  const bus = new ObservabilityBus({
    sinks: [capturingSink(lines)],
    warn: (line) => warnings.push(line),
  });

  bus.emit({
    signal: "policy-denials",
    status: "BLOCKED",
    component: "security-policy",
    attributes: { policy: "builtin" },
  });

  const events = parseLines(lines);
  assert.equal(events.length, 1);
  assert.equal(events[0].schemaVersion, 1);
  assert.equal(events[0].signal, "policy-denials");
  assert.equal(warnings.length, 0);
  assert.match(
    bus.metrics(),
    /alz_operational_event_total\{signal="policy-denials",status="BLOCKED",component="security-policy"\} 1/,
  );
});

test("emit never throws when every sink and exporter fails", async () => {
  const warnings: string[] = [];
  const bus = new ObservabilityBus({
    sinks: [throwingSink()],
    exporters: [rejectingExporter()],
    exportGate: VALID_GATE,
    warn: (line) => warnings.push(line),
  });

  // The governed-command guarantee: this call must not throw.
  bus.emit({
    signal: "adapter-failures",
    status: "FAILED",
    component: "terraform",
  });

  await drainQueue();

  assert.match(
    warnings.join("\n"),
    /OBSERVABILITY_SINK_FAILED: sink exploded/,
  );
  assert.match(
    warnings.join("\n"),
    /MONITORING_EXPORT_FAILED: collector down/,
  );

  // The registry still counted the event even though the sink died.
  assert.match(
    bus.metrics(),
    /alz_operational_event_total\{signal="adapter-failures",status="FAILED",component="terraform"\} 1/,
  );
});

test("hostile attributes and details are redacted before any consumer sees the event", async () => {
  const lines: string[] = [];
  const exported: OperationalEvent[] = [];
  const bus = new ObservabilityBus({
    sinks: [capturingSink(lines)],
    exporters: [countingExporter(exported)],
    exportGate: VALID_GATE,
    warn: () => {},
  });

  bus.emit({
    signal: "model-latency",
    status: "DEGRADED",
    component: "model-runtime",
    detail:
      "Authorization: Bearer abc.def.ghi; token=xyz789 " +
      "-----BEGIN PRIVATE KEY----- MIIEvQabc -----END PRIVATE KEY-----",
    attributes: {
      token: "super-secret-token-value",
      apiKey: "sk-abc123",
      nested: {
        password: "hunter2-secret",
        harmless: "visible",
      },
    },
  });

  await drainQueue();

  const serialized = lines.join("\n");
  for (const secret of [
    "super-secret-token-value",
    "sk-abc123",
    "hunter2-secret",
    "abc.def.ghi",
    "xyz789",
    "MIIEvQabc",
  ]) {
    assert.equal(
      serialized.includes(secret),
      false,
      "leaked secret: " + secret,
    );
  }
  assert.match(serialized, /\[REDACTED\]/);
  assert.match(serialized, /\[REDACTED PRIVATE KEY\]/);
  assert.match(serialized, /visible/);

  // The exporter received the same already-redacted event object.
  assert.equal(exported.length, 1);
  assert.equal(
    JSON.stringify(exported[0].attributes).includes(
      "super-secret-token-value",
    ),
    false,
  );
});

test("counters are monotonic totals keyed by signal/status/component", () => {
  const lines: string[] = [];
  const bus = new ObservabilityBus({
    sinks: [capturingSink(lines)],
    warn: () => {},
  });

  bus.emit({
    signal: "model-latency",
    status: "OK",
    component: "model-runtime",
  });
  bus.emit({
    signal: "model-latency",
    status: "OK",
    component: "model-runtime",
  });
  bus.emit({
    signal: "model-latency",
    status: "OK",
    component: "model-runtime",
    durationMs: 42,
  });
  bus.emit({
    signal: "policy-denials",
    status: "BLOCKED",
    component: "security-policy",
    durationMs: 84,
  });

  const metrics = bus.metrics();

  // Aggregated monotonic counters, not per-event samples.
  assert.match(
    metrics,
    /alz_operational_event_total\{signal="model-latency",status="OK",component="model-runtime"\} 3/,
  );
  assert.match(
    metrics,
    /alz_operational_event_total\{signal="policy-denials",status="BLOCKED",component="security-policy"\} 1/,
  );

  // Duration gauge: most recent observed sample per label set.
  assert.match(
    metrics,
    /alz_operational_event_duration_milliseconds\{signal="model-latency",status="OK",component="model-runtime"\} 42/,
  );
  assert.match(
    metrics,
    /alz_operational_event_duration_milliseconds\{signal="policy-denials",status="BLOCKED",component="security-policy"\} 84/,
  );

  assert.match(metrics, /# TYPE alz_operational_event_total counter/);
  assert.match(
    metrics,
    /# TYPE alz_operational_event_duration_milliseconds gauge/,
  );
  assert.equal(metrics.endsWith("\n"), true);
});

test("metrics on an empty bus renders headers only", () => {
  const bus = new ObservabilityBus({ warn: () => {} });

  const metrics = bus.metrics();

  assert.match(metrics, /# HELP alz_operational_event_total /);
  assert.match(metrics, /# TYPE alz_operational_event_total counter/);
  assert.equal(metrics.includes("alz_operational_event_duration_milliseconds"), false);
});

test("invalid binding disables export fail-closed with exactly one warn and no crash", async () => {
  const warnings: string[] = [];
  const exported: OperationalEvent[] = [];
  const bus = new ObservabilityBus({
    sinks: [capturingSink([])],
    exporters: [countingExporter(exported)],
    exportGate: {
      profileId: "PRIVATE_SOVEREIGN_DISCONNECTED",
      binding: {
        provider: "AWS_CLOUDWATCH",
        deployment: "EXTERNAL",
        endpoint: "https://cloudwatch.example.invalid",
      },
    },
    warn: (line) => warnings.push(line),
  });

  bus.emit({
    signal: "provider-discovery-health",
    status: "FAILED",
    component: "discovery",
  });
  bus.emit({
    signal: "provider-discovery-health",
    status: "FAILED",
    component: "discovery",
  });
  bus.emit({
    signal: "provider-discovery-health",
    status: "FAILED",
    component: "discovery",
  });

  await drainQueue();

  assert.equal(exported.length, 0);
  assert.equal(
    warnings.filter((line) =>
      line.startsWith("[warn] MONITORING_EXPORT_DISABLED"),
    ).length,
    1,
  );
  assert.equal(
    warnings.some((line) =>
      line.startsWith("[warn] MONITORING_EXPORT_FAILED"),
    ),
    false,
  );
  // Structured events keep flowing even though export is disabled.
  assert.match(
    bus.metrics(),
    /alz_operational_event_total\{signal="provider-discovery-health",status="FAILED",component="discovery"\} 3/,
  );
});

test("exporters without a gate are refused fail-closed", async () => {
  const warnings: string[] = [];
  const exported: OperationalEvent[] = [];
  const bus = new ObservabilityBus({
    sinks: [capturingSink([])],
    exporters: [countingExporter(exported)],
    warn: (line) => warnings.push(line),
  });

  bus.emit({
    signal: "recovery-state",
    status: "OK",
    component: "recovery",
  });

  await drainQueue();

  assert.equal(exported.length, 0);
  assert.equal(
    warnings.filter((line) =>
      line.startsWith("[warn] MONITORING_EXPORT_DISABLED"),
    ).length,
    1,
  );
  assert.match(
    warnings[0],
    /No monitoring export gate configured/,
  );
});

test("valid gate exports every event through the injected exporter", async () => {
  const exported: OperationalEvent[] = [];
  const splunkDenied: string[] = [];
  const bus = new ObservabilityBus({
    sinks: [capturingSink([])],
    exporters: [countingExporter(exported)],
    exportGate: VALID_GATE,
    warn: () => {},
  });

  bus.emit({
    signal: "evidence-lifecycle",
    status: "OK",
    component: "evidence-vault",
    durationMs: 12,
  });
  bus.emit({
    signal: "evidence-lifecycle",
    status: "FAILED",
    component: "evidence-vault",
  });

  await drainQueue();

  assert.equal(exported.length, 2);
  assert.equal(exported[0].signal, "evidence-lifecycle");
  assert.equal(exported[1].status, "FAILED");

  // Same gate profile, but Splunk HEC without an auth reference is denied.
  const splunkBus = new ObservabilityBus({
    sinks: [capturingSink([])],
    exporters: [countingExporter([])],
    exportGate: {
      profileId: "GOVERNED_ENTERPRISE_CONNECTED",
      binding: {
        provider: "SPLUNK_HEC",
        deployment: "LOCAL",
        endpoint: "http://127.0.0.1:8088",
      },
    },
    warn: (line) => splunkDenied.push(line),
  });

  splunkBus.emit({
    signal: "recovery-state",
    status: "OK",
    component: "recovery",
  });

  await drainQueue();

  assert.equal(
    splunkDenied.filter((line) =>
      line.startsWith("[warn] MONITORING_EXPORT_DISABLED"),
    ).length,
    1,
  );
  assert.match(splunkDenied[0], /opaque authentication reference/);
});

test("monitoringExporter bridges to exportOperationalEvent with an injectable transport", async () => {
  const requests: MonitoringRequest[] = [];
  const transport: MonitoringTransport = (request) => {
    requests.push(request);
    return Promise.resolve({ ok: true, status: 200 });
  };

  const exporter = monitoringExporter({
    profileId: VALID_GATE.profileId,
    binding: VALID_GATE.binding,
    transport,
  });

  await exporter.export({
    schemaVersion: 1,
    at: "2026-10-09T00:00:00.000Z",
    signal: "evidence-lifecycle",
    status: "OK",
    component: "evidence-vault",
    attributes: {},
  });

  assert.equal(requests.length, 1);
  assert.equal(requests[0].provider, "OTEL_COLLECTOR");
  assert.equal(requests[0].endpoint, "http://127.0.0.1:4318");
  const body = JSON.parse(requests[0].body) as {
    resourceLogs: unknown[];
  };
  assert.equal(body.resourceLogs.length, 1);

  // A failed transport result rejects the exporter contract; the bus is the
  // layer that degrades that rejection into a warn line.
  const failing = monitoringExporter({
    profileId: VALID_GATE.profileId,
    binding: VALID_GATE.binding,
    transport: () => Promise.resolve({ ok: false, status: 503 }),
  });

  await assert.rejects(
    failing.export({
      schemaVersion: 1,
      at: "2026-10-09T00:00:00.000Z",
      signal: "evidence-lifecycle",
      status: "OK",
      component: "evidence-vault",
      attributes: {},
    }),
    /MONITORING_EXPORT_FAILED/,
  );
});
