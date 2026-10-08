import assert from "node:assert/strict";
import test from "node:test";

import {
  createOperationalEvent,
} from "../src/observability/events.js";
import {
  MONITORING_PROVIDERS,
  coreMonitoringProviders,
  monitoringProvider,
} from "../src/monitoring/catalog.js";
import {
  buildMonitoringRequest,
  exportOperationalEvent,
  renderPrometheusEvent,
} from "../src/monitoring/export.js";
import {
  validateMonitoringBinding,
} from "../src/monitoring/validate.js";
import type {
  MonitoringRequest,
} from "../src/monitoring/types.js";

const EVENT =
  createOperationalEvent({
    at:
      "2026-10-08T01:30:00.000Z",
    signal:
      "provider-discovery-health",
    status: "DEGRADED",
    component:
      "synthetic-monitoring-test",
    durationMs: 42,
    detail:
      "token=super-secret",
    attributes: {
      password:
        "super-secret",
      environment:
        "private-prod-01",
    },
  });

test("PLZ and ALZ core monitoring catalogs include portable and native bindings without optional-backend sprawl", () => {
  const platformIds =
    coreMonitoringProviders(
      "PLATFORM_LZ",
    ).map(
      (provider) => provider.id,
    );
  const appIds =
    coreMonitoringProviders(
      "APPLICATION_LZ",
    ).map(
      (provider) => provider.id,
    );

  for (const id of [
    "OTEL_COLLECTOR",
    "PROMETHEUS",
    "GRAFANA",
    "SPLUNK_HEC",
    "AWS_CLOUDWATCH",
    "AZURE_MONITOR_LOG_ANALYTICS",
  ]) {
    assert.equal(
      platformIds.includes(
        id as never,
      ),
      true,
    );
    assert.equal(
      appIds.includes(
        id as never,
      ),
      true,
    );
  }

  assert.equal(
    platformIds.includes(
      "SYSLOG",
    ),
    true,
  );
  assert.equal(
    platformIds.includes(
      "SNMP",
    ),
    true,
  );
  assert.equal(
    appIds.includes(
      "SYSLOG",
    ),
    false,
  );
  assert.equal(
    appIds.includes(
      "SNMP",
    ),
    false,
  );

  assert.equal(
    appIds.includes(
      "GRAFANA_TEMPO",
    ),
    false,
  );
});

test("private-capable foundation includes OTEL Prometheus Grafana and Splunk", () => {
  for (const id of [
    "OTEL_COLLECTOR",
    "PROMETHEUS",
    "GRAFANA",
    "SPLUNK_HEC",
  ] as const) {
    const provider =
      monitoringProvider(id);

    assert.equal(
      provider.privateCapable,
      true,
    );
    assert.equal(
      provider
        .supportsDisconnected,
      true,
    );
  }

  assert.equal(
    monitoringProvider(
      "AWS_CLOUDWATCH",
    ).privateCapable,
    false,
  );
  assert.equal(
    monitoringProvider(
      "AZURE_MONITOR_LOG_ANALYTICS",
    ).privateCapable,
    false,
  );
});

test("disconnected sovereign profile permits local OTEL and rejects external telemetry", () => {
  const local =
    validateMonitoringBinding(
      "PRIVATE_SOVEREIGN_DISCONNECTED",
      {
        provider:
          "OTEL_COLLECTOR",
        deployment: "LOCAL",
        endpoint:
          "http://otel-collector:4318/v1/logs",
      },
    );

  assert.equal(
    local.allowed,
    true,
  );

  const external =
    validateMonitoringBinding(
      "PRIVATE_SOVEREIGN_DISCONNECTED",
      {
        provider:
          "OTEL_COLLECTOR",
        deployment:
          "EXTERNAL",
        endpoint:
          "https://external.example/v1/logs",
      },
    );

  assert.equal(
    external.allowed,
    false,
  );
});

test("strict private sovereignty rejects cloud-native monitoring backends", () => {
  for (const provider of [
    "AWS_CLOUDWATCH",
    "AZURE_MONITOR_LOG_ANALYTICS",
  ] as const) {
    const result =
      validateMonitoringBinding(
        "PRIVATE_SOVEREIGN_CONNECTED",
        {
          provider,
          deployment:
            "SOVEREIGN_DOMAIN",
        },
      );

    assert.equal(
      result.allowed,
      false,
    );
    assert.match(
      result.reasons.join(" "),
      /not valid inside a strict private-sovereign/,
    );
  }
});

test("governed connected ALZ may bind AWS or Azure native monitoring", () => {
  for (const provider of [
    "AWS_CLOUDWATCH",
    "AZURE_MONITOR_LOG_ANALYTICS",
  ] as const) {
    const result =
      validateMonitoringBinding(
        "GOVERNED_ENTERPRISE_CONNECTED",
        {
          provider,
          deployment:
            "EXTERNAL",
        },
      );

    assert.equal(
      result.allowed,
      true,
    );
  }
});

test("Splunk HEC requires an opaque secret reference and never embeds it in the payload", () => {
  const denied =
    validateMonitoringBinding(
      "PRIVATE_SOVEREIGN_DISCONNECTED",
      {
        provider:
          "SPLUNK_HEC",
        deployment: "LOCAL",
        endpoint:
          "https://splunk.local:8088/services/collector",
        authRef:
          "raw-token-value",
      },
    );

  assert.equal(
    denied.allowed,
    false,
  );

  const request =
    buildMonitoringRequest(
      "PRIVATE_SOVEREIGN_DISCONNECTED",
      {
        provider:
          "SPLUNK_HEC",
        deployment: "LOCAL",
        endpoint:
          "https://splunk.local:8088/services/collector",
        authRef:
          "secret://splunk/hec/alz",
      },
      EVENT,
    );

  assert.equal(
    request.authRef,
    "secret://splunk/hec/alz",
  );
  assert.equal(
    request.body.includes(
      "secret://splunk/hec/alz",
    ),
    false,
  );
  assert.equal(
    request.body.includes(
      "super-secret",
    ),
    false,
  );
  assert.match(
    request.body,
    /REDACTED/,
  );
});

test("OTEL export produces redacted OTLP JSON and uses injected transport only", async () => {
  let captured:
    MonitoringRequest | undefined;

  const result =
    await exportOperationalEvent(
      "PRIVATE_SOVEREIGN_DISCONNECTED",
      {
        provider:
          "OTEL_COLLECTOR",
        deployment: "LOCAL",
        endpoint:
          "http://otel-collector:4318/v1/logs",
      },
      EVENT,
      async (request) => {
        captured = request;
        return {
          ok: true,
          status: 200,
        };
      },
    );

  assert.equal(
    result.ok,
    true,
  );
  assert.ok(captured);
  assert.equal(
    captured.provider,
    "OTEL_COLLECTOR",
  );
  assert.equal(
    captured.body.includes(
      "super-secret",
    ),
    false,
  );
  assert.match(
    captured.body,
    /resourceLogs/,
  );
  assert.match(
    captured.body,
    /REDACTED/,
  );
});

test("Prometheus rendering exposes bounded operational metrics without raw event attributes", () => {
  const output =
    renderPrometheusEvent(
      EVENT,
    );

  assert.match(
    output,
    /alz_operational_event_total/,
  );
  assert.match(
    output,
    /alz_operational_event_duration_milliseconds/,
  );
  assert.match(
    output,
    /provider-discovery-health/,
  );
  assert.equal(
    output.includes(
      "super-secret",
    ),
    false,
  );
  assert.equal(
    output.includes(
      "private-prod-01",
    ),
    false,
  );
});

test("Grafana remains a visualization binding rather than a direct event sink", () => {
  assert.equal(
    monitoringProvider(
      "GRAFANA",
    ).directEventExport,
    false,
  );

  assert.throws(
    () =>
      buildMonitoringRequest(
        "PRIVATE_SOVEREIGN_DISCONNECTED",
        {
          provider:
            "GRAFANA",
          deployment:
            "LOCAL",
        },
        EVENT,
      ),
    /MONITORING_DIRECT_EXPORT_UNSUPPORTED/,
  );
});

test("monitoring catalog has unique provider identifiers", () => {
  const ids =
    MONITORING_PROVIDERS.map(
      (provider) => provider.id,
    );

  assert.equal(
    new Set(ids).size,
    ids.length,
  );
});
