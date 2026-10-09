import assert from "node:assert/strict";
import test from "node:test";

import {
  JsonLineEventSink,
  type OperationalEvent,
} from "../src/observability/events.js";
import {
  ObservabilityBus,
} from "../src/observability/bus.js";
import {
  discoverEnvironment,
} from "../src/discovery/discover.js";
import {
  createApiEnvironmentProvider,
} from "../src/environment/read-only.js";
import type {
  EnvironmentBinding,
  EnvironmentReadTransport,
} from "../src/environment/types.js";

function busWithCapturedLines(lines: string[]): ObservabilityBus {
  return new ObservabilityBus({
    sinks: [new JsonLineEventSink((line) => lines.push(line))],
  });
}

function parseLines(lines: string[]): OperationalEvent[] {
  return lines.map((line) => JSON.parse(line) as OperationalEvent);
}

const binding = (provider: EnvironmentBinding["provider"]): EnvironmentBinding => ({
  environmentId: "private-01",
  provider,
  runtimeProfile: "PRIVATE_SOVEREIGN_DISCONNECTED",
  deployment: "LOCAL",
  origin: "https://infra.internal",
  authRef: "secret://infrastructure/read-only",
});

test("fixture discovery emits a schema-v1 provider-discovery-health OK event", async () => {
  const lines: string[] = [];
  const bus = busWithCapturedLines(lines);

  const state = await discoverEnvironment({
    provider: "AWS",
    mock: "brownfield",
    emitter: bus,
  });

  const events = parseLines(lines);
  const discovery = events.filter(
    (event) => event.signal === "provider-discovery-health",
  );

  assert.equal(discovery.length, 1);
  const event = discovery[0]!;
  assert.equal(event.schemaVersion, 1);
  assert.equal(event.status, "OK");
  assert.equal(event.component, "discovery");
  assert.equal(event.attributes.provider, "AWS");
  assert.equal(event.attributes.mock, "brownfield");
  assert.equal(typeof event.durationMs, "number");
  // No raw payloads in attributes: resource count only.
  assert.equal(typeof event.attributes.resources, "number");
  assert.equal(state.provider, "AWS");
});

test("unwired discovery emits nothing (disabled default)", async () => {
  const lines: string[] = [];
  const bus = busWithCapturedLines(lines);

  await discoverEnvironment({
    provider: "AWS",
    mock: "greenfield",
  });

  assert.equal(lines.length, 0);
  assert.ok(
    !bus.metrics().includes("provider_discovery"),
    "no discovery samples expected when unwired",
  );
});

test("environment probe failures emit DEGRADED discovery-health events", async () => {
  const lines: string[] = [];
  const bus = busWithCapturedLines(lines);

  // Every path 403s: probes run, none are observed.
  const provider = createApiEnvironmentProvider(
    binding("KUBERNETES"),
    async () => ({ status: 403, body: "denied" }),
    bus,
  );
  const state = await provider.discover();

  const events = parseLines(lines);
  const degraded = events.filter(
    (event) =>
      event.signal === "provider-discovery-health" &&
      event.status === "DEGRADED",
  );

  assert.ok(degraded.length > 0, "expected at least one DEGRADED probe event");
  for (const event of degraded) {
    assert.equal(event.schemaVersion, 1);
    assert.equal(event.component, "environment-read-only");
    assert.equal(event.attributes.provider, "KUBERNETES");
    assert.equal(event.attributes.environmentId, "private-01");
  }
  assert.equal(state.complete, false);
});

test("environment transport failures emit DEGRADED discovery-health events", async () => {
  const lines: string[] = [];
  const bus = busWithCapturedLines(lines);

  const provider = createApiEnvironmentProvider(
    binding("KUBERNETES"),
    async () => {
      throw new Error("connection refused");
    },
    bus,
  );
  await provider.discover();

  const events = parseLines(lines);
  assert.ok(
    events.some(
      (event) =>
        event.signal === "provider-discovery-health" &&
        event.status === "DEGRADED" &&
        String(event.detail).includes("transport failed"),
    ),
    "expected a transport-failure DEGRADED event",
  );
});
