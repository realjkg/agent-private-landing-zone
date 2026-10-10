import assert from "node:assert/strict";
import test from "node:test";

import { healthReport } from "../src/cli/health.js";
import {
  healthSnapshot,
  readinessSnapshot,
  startHealthServer,
} from "../src/observability/health.js";
import { startObservabilityRuntime } from "../src/observability/runtime.js";

async function drainMicrotasks(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

test("GET /healthz returns 200 with the health snapshot", async () => {
  const runtime = await startObservabilityRuntime({ serve: true });

  try {
    assert.ok(runtime.health);
    const response = await fetch(runtime.healthAddress + "/healthz");

    assert.equal(response.status, 200);
    assert.match(
      response.headers.get("content-type") ?? "",
      /application\/json/,
    );
    assert.deepEqual(await response.json(), healthSnapshot());
  } finally {
    await runtime.close();
  }
});

test("GET /readyz returns 200 on passing checks and 503 on a failing check", async () => {
  let providerReady = true;
  const runtime = await startObservabilityRuntime({
    serve: true,
    readinessChecks: () => [
      {
        name: "provider",
        ready: providerReady,
        detail: providerReady ? "qualified" : "qualification pending",
      },
    ],
  });

  try {
    assert.ok(runtime.health);

    const ready = await fetch(runtime.healthAddress + "/readyz");
    assert.equal(ready.status, 200);
    const readyBody = (await ready.json()) as { ready: boolean };
    assert.equal(readyBody.ready, true);

    providerReady = false;
    const blocked = await fetch(runtime.healthAddress + "/readyz");
    assert.equal(blocked.status, 503);
    const blockedBody = (await blocked.json()) as {
      ready: boolean;
      checks: { name: string; ready: boolean }[];
    };
    assert.equal(blockedBody.ready, false);
    assert.ok(
      blockedBody.checks.some(
        (check) => check.name === "provider" && !check.ready,
      ),
    );
  } finally {
    await runtime.close();
  }
});

test("GET /readyz enforces the contract's observability block through the readiness seam", async () => {
  const runtime = await startObservabilityRuntime({
    serve: true,
    warn: () => {},
  });

  try {
    assert.ok(runtime.health);

    // The wired runtime reports its own live evidence: satisfied → 200.
    const response = await fetch(runtime.healthAddress + "/readyz");
    assert.equal(response.status, 200);
    const body = (await response.json()) as {
      ready: boolean;
      checks: { name: string; ready: boolean; detail: string }[];
    };
    assert.equal(body.ready, true);
    const contractCheck = body.checks.find(
      (check) =>
        check.name === "production-contract-observability",
    );
    assert.ok(contractCheck);
    assert.equal(contractCheck.ready, true);
    assert.match(
      contractCheck.detail,
      /verified against runtime behavior/,
    );

    // The same seam with an unmet claim flips the verdict to NOT READY —
    // the contract block is enforced as behavior, not config presence.
    const unmet = readinessSnapshot(
      [{ name: "runtime", ready: true, detail: "up" }],
      { ...runtime.evidence(), structuredLogsActive: false },
    );
    assert.equal(unmet.ready, false);
    const unmetCheck = unmet.checks.find(
      (check) =>
        check.name === "production-contract-observability",
    );
    assert.ok(unmetCheck);
    assert.equal(unmetCheck.ready, false);
    assert.match(unmetCheck.detail, /structured event sink is not active/);
  } finally {
    await runtime.close();
  }
});

test("GET /metrics serves the bus registry as Prometheus text with monotonic counters", async () => {
  const runtime = await startObservabilityRuntime({ serve: true });

  try {
    assert.ok(runtime.health);

    runtime.bus.emit({
      signal: "policy-denials",
      status: "BLOCKED",
      component: "security-policy",
    });

    const first = await fetch(runtime.healthAddress + "/metrics");
    assert.equal(first.status, 200);
    assert.match(
      first.headers.get("content-type") ?? "",
      /text\/plain/,
    );
    const firstBody = await first.text();
    assert.match(
      firstBody,
      /alz_operational_event_total\{signal="policy-denials",status="BLOCKED",component="security-policy"\} 1/,
    );
    assert.match(firstBody, /# TYPE alz_operational_event_total counter/);

    runtime.bus.emit({
      signal: "policy-denials",
      status: "BLOCKED",
      component: "security-policy",
    });

    const second = await fetch(runtime.healthAddress + "/metrics");
    const secondBody = await second.text();
    assert.match(
      secondBody,
      /alz_operational_event_total\{signal="policy-denials",status="BLOCKED",component="security-policy"\} 2/,
    );

    // Monotonic across scrapes: the label set stays a single aggregated
    // sample; no per-event lines accumulate.
    const sampleCount = (body: string): number =>
      body
        .split("\n")
        .filter((line) =>
          line.startsWith("alz_operational_event_total{"),
        ).length;
    assert.equal(sampleCount(firstBody), 1);
    assert.equal(sampleCount(secondBody), 1);
  } finally {
    await runtime.close();
  }
});

test("non-GET methods return 405 and unknown routes return 404", async () => {
  const runtime = await startObservabilityRuntime({ serve: true });

  try {
    assert.ok(runtime.health);

    const post = await fetch(runtime.healthAddress + "/healthz", {
      method: "POST",
    });
    assert.equal(post.status, 405);

    const missing = await fetch(runtime.healthAddress + "/nope");
    assert.equal(missing.status, 404);
  } finally {
    await runtime.close();
  }
});

test("non-loopback bind is refused at the server boundary (regression)", async () => {
  // Config-level refusal (ALZ_HEALTH_HOST normalization) is tested in
  // config.test.ts; this pins the server guard beneath it.
  await assert.rejects(
    startHealthServer({
      readiness: () =>
        readinessSnapshot([
          { name: "runtime", ready: true, detail: "up" },
        ]),
      metrics: () => "",
      host: "0.0.0.0",
    }),
    /HEALTH_ENDPOINT_BIND_DENIED/,
  );

  await assert.rejects(
    startHealthServer({
      readiness: () =>
        readinessSnapshot([
          { name: "runtime", ready: true, detail: "up" },
        ]),
      metrics: () => "",
      host: "::",
    }),
    /HEALTH_ENDPOINT_BIND_DENIED/,
  );
});

test("a taken port warns once and never crashes the host runtime", async () => {
  const first = await startObservabilityRuntime({ serve: true, port: 0 });
  assert.ok(first.health);

  const takenPort = Number(
    new URL(first.healthAddress).port,
  );
  const warnings: string[] = [];
  const second = await startObservabilityRuntime({
    serve: true,
    port: takenPort,
    warn: (line) => warnings.push(line),
  });

  try {
    assert.equal(second.health, undefined);
    assert.equal(second.healthAddress, undefined);
    assert.equal(
      warnings.filter((line) =>
        line.startsWith("[warn] OBSERVABILITY_HEALTH_SERVER_DISABLED"),
      ).length,
      1,
    );

    // The doors are down and the evidence says so honestly.
    const evidence = second.evidence();
    assert.equal(evidence.healthEndpointServing, false);
    assert.equal(evidence.readinessEndpointServing, false);
    assert.equal(evidence.metricsEndpointServing, false);

    const snapshot = second.readiness();
    assert.equal(snapshot.ready, false);
    const contractCheck = snapshot.checks.find(
      (check) =>
        check.name === "production-contract-observability",
    );
    assert.ok(contractCheck);
    assert.equal(contractCheck.ready, false);
  } finally {
    await first.close();
    await second.close();
  }
});

test("a serving runtime reports satisfied contract evidence", async () => {
  const runtime = await startObservabilityRuntime({ serve: true });

  try {
    const evidence = runtime.evidence();
    assert.equal(evidence.busWired, true);
    assert.equal(evidence.structuredLogsActive, true);
    assert.equal(evidence.secretRedactionActive, true);
    assert.equal(evidence.healthEndpointServing, true);
    assert.equal(evidence.readinessEndpointServing, true);
    assert.equal(evidence.metricsEndpointServing, true);

    const snapshot = runtime.readiness();
    assert.equal(snapshot.ready, true);
    assert.equal(snapshot.actEnabled, false);
  } finally {
    await runtime.close();
  }
});

test("one-shot runtimes do not claim endpoint evidence and stay ready", async () => {
  const runtime = await startObservabilityRuntime();

  try {
    const evidence = runtime.evidence();
    assert.equal(evidence.healthEndpointServing, undefined);
    assert.equal(evidence.readinessEndpointServing, undefined);
    assert.equal(evidence.metricsEndpointServing, undefined);

    const report = healthReport(runtime);
    assert.equal(report.ready, true);
    assert.match(report.lines.join("\n"), /readiness: READY/);
    assert.match(report.lines.join("\n"), /structured events: on/);
    assert.match(report.lines.join("\n"), /monitoring export: not configured/);
  } finally {
    await runtime.close();
  }
});

test("health report fails and names the gap when structured events are off", async () => {
  const previous = process.env.ALZ_OBSERVABILITY_EVENTS;
  process.env.ALZ_OBSERVABILITY_EVENTS = "false";

  try {
    const runtime = await startObservabilityRuntime();
    const report = healthReport(runtime);

    assert.equal(report.ready, false);
    const text = report.lines.join("\n");
    assert.match(text, /readiness: NOT READY/);
    assert.match(text, /✗ production-contract-observability/);
    assert.match(text, /structured event sink is not active/);
    assert.match(text, /structured events: OFF/);

    await runtime.close();
  } finally {
    if (previous === undefined) {
      delete process.env.ALZ_OBSERVABILITY_EVENTS;
    } else {
      process.env.ALZ_OBSERVABILITY_EVENTS = previous;
    }
    await drainMicrotasks();
  }
});
