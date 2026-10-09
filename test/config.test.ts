import assert from "node:assert/strict";
import test from "node:test";

import {
  loadConfig,
  loadObservabilityConfig,
} from "../src/config.js";

function captureWarn(): {
  warnings: string[];
  warn: (line: string) => void;
} {
  const warnings: string[] = [];
  return {
    warnings,
    warn: (line) => warnings.push(line),
  };
}

test("loadConfig keeps model defaults", () => {
  const config = loadConfig();

  assert.equal(config.ollamaBaseUrl, "http://127.0.0.1:11434");
  assert.equal(config.disagreementThreshold, 0.35);
});

test("observability config defaults to events on, loopback health, no export", () => {
  const { warnings, warn } = captureWarn();

  const config = loadObservabilityConfig({}, warn);

  assert.deepEqual(config, {
    eventsEnabled: true,
    healthHost: "127.0.0.1",
  });
  assert.equal(warnings.length, 0);
});

test("ALZ_OBSERVABILITY_EVENTS parses true/false case-insensitively", () => {
  const off = loadObservabilityConfig({ ALZ_OBSERVABILITY_EVENTS: "false" });
  const on = loadObservabilityConfig({ ALZ_OBSERVABILITY_EVENTS: "TRUE" });

  assert.equal(off.eventsEnabled, false);
  assert.equal(on.eventsEnabled, true);
});

test("invalid ALZ_OBSERVABILITY_EVENTS fails toward the default-on posture with one warn", () => {
  const { warnings, warn } = captureWarn();

  const config = loadObservabilityConfig(
    { ALZ_OBSERVABILITY_EVENTS: "banana" },
    warn,
  );

  assert.equal(config.eventsEnabled, true);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /OBSERVABILITY_CONFIG_INVALID/);
  assert.match(warnings[0], /ALZ_OBSERVABILITY_EVENTS/);
});

test("loopback-only health host is fixed; conflicting values are refused", () => {
  const { warnings, warn } = captureWarn();

  const config = loadObservabilityConfig(
    { ALZ_HEALTH_HOST: "0.0.0.0" },
    warn,
  );

  assert.equal(config.healthHost, "127.0.0.1");
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /ALZ_HEALTH_HOST/);

  const compliant = loadObservabilityConfig(
    { ALZ_HEALTH_HOST: "127.0.0.1" },
    warn,
  );
  assert.equal(compliant.healthHost, "127.0.0.1");
});

test("ALZ_HEALTH_PORT accepts valid TCP ports and drops invalid ones", () => {
  const { warnings, warn } = captureWarn();

  const valid = loadObservabilityConfig(
    { ALZ_HEALTH_PORT: "8099" },
    warn,
  );
  const ephemeral = loadObservabilityConfig(
    { ALZ_HEALTH_PORT: "0" },
    warn,
  );
  const unset = loadObservabilityConfig({ ALZ_HEALTH_PORT: "" }, warn);
  const garbage = loadObservabilityConfig(
    { ALZ_HEALTH_PORT: "not-a-port" },
    warn,
  );
  const outOfRange = loadObservabilityConfig(
    { ALZ_HEALTH_PORT: "70000" },
    warn,
  );

  assert.equal(valid.healthPort, 8099);
  assert.equal(ephemeral.healthPort, 0);
  assert.equal(unset.healthPort, undefined);
  assert.equal(garbage.healthPort, undefined);
  assert.equal(outOfRange.healthPort, undefined);
  assert.equal(warnings.length, 2);
  assert.match(warnings.join("\n"), /ALZ_HEALTH_PORT/);
});

test("a valid monitoring binding parses through with opaque auth refs only", () => {
  const otel = loadObservabilityConfig({
    ALZ_MONITORING_PROVIDER: "OTEL_COLLECTOR",
    ALZ_MONITORING_DEPLOYMENT: "LOCAL",
    ALZ_MONITORING_ENDPOINT: "http://127.0.0.1:4318",
  });

  assert.deepEqual(otel.monitoringBinding, {
    provider: "OTEL_COLLECTOR",
    deployment: "LOCAL",
    endpoint: "http://127.0.0.1:4318",
  });

  const splunk = loadObservabilityConfig({
    ALZ_MONITORING_PROVIDER: "SPLUNK_HEC",
    ALZ_MONITORING_DEPLOYMENT: "SOVEREIGN_DOMAIN",
    ALZ_MONITORING_ENDPOINT: "http://127.0.0.1:8088",
    ALZ_MONITORING_AUTH_REF: "vault://monitoring/hec-token",
  });

  assert.equal(splunk.monitoringBinding?.authRef, "vault://monitoring/hec-token");
});

test("invalid monitoring bindings fail closed: dropped with exactly one warn", () => {
  const cases: Array<Record<string, string>> = [
    // Provider outside the direct-event-export surface.
    {
      ALZ_MONITORING_PROVIDER: "PROMETHEUS",
      ALZ_MONITORING_DEPLOYMENT: "LOCAL",
      ALZ_MONITORING_ENDPOINT: "http://127.0.0.1:9090",
    },
    // Deployment outside the union.
    {
      ALZ_MONITORING_PROVIDER: "OTEL_COLLECTOR",
      ALZ_MONITORING_DEPLOYMENT: "MOON",
      ALZ_MONITORING_ENDPOINT: "http://127.0.0.1:4318",
    },
    // Missing endpoint: both configurable providers export directly.
    {
      ALZ_MONITORING_PROVIDER: "OTEL_COLLECTOR",
      ALZ_MONITORING_DEPLOYMENT: "LOCAL",
    },
    // Raw credentials are refused; only opaque references pass.
    {
      ALZ_MONITORING_PROVIDER: "SPLUNK_HEC",
      ALZ_MONITORING_DEPLOYMENT: "LOCAL",
      ALZ_MONITORING_ENDPOINT: "http://127.0.0.1:8088",
      ALZ_MONITORING_AUTH_REF: "sk-raw-credential-value",
    },
    // Partial configuration without a provider.
    { ALZ_MONITORING_ENDPOINT: "http://127.0.0.1:4318" },
  ];

  for (const env of cases) {
    const { warnings, warn } = captureWarn();

    const config = loadObservabilityConfig(env, warn);

    assert.equal(config.monitoringBinding, undefined);
    assert.equal(
      warnings.length,
      1,
      "expected exactly one warn for " + JSON.stringify(env),
    );
    assert.match(warnings[0], /OBSERVABILITY_CONFIG_INVALID/);
    assert.match(warnings[0], /monitoring export binding disabled/);
    // Warn lines must not echo endpoint or credential values. Non-secret
    // enums (provider, deployment) are echoed on purpose for diagnosis.
    for (const [name, value] of Object.entries(env)) {
      if (
        name === "ALZ_MONITORING_ENDPOINT" ||
        name === "ALZ_MONITORING_AUTH_REF"
      ) {
        assert.equal(
          warnings[0].includes(value),
          false,
          "warn echoed env value: " + value,
        );
      }
    }
  }
});

test("dropping a bad binding leaves the default-on event stream untouched", () => {
  const { warnings, warn } = captureWarn();

  const config = loadObservabilityConfig(
    {
      ALZ_MONITORING_PROVIDER: "PROMETHEUS",
      ALZ_MONITORING_DEPLOYMENT: "EXTERNAL",
    },
    warn,
  );

  assert.equal(config.eventsEnabled, true);
  assert.equal(config.healthHost, "127.0.0.1");
  assert.equal(config.monitoringBinding, undefined);
  assert.equal(warnings.length, 1);
});
