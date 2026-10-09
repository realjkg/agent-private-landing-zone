import assert from "node:assert/strict";
import test from "node:test";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import {
  JsonLineEventSink,
  type OperationalEvent,
} from "../src/observability/events.js";
import {
  ObservabilityBus,
} from "../src/observability/bus.js";
import {
  invokeLocalModel,
  MODEL_LATENCY_DEGRADED_MS,
} from "../src/ollama.js";

function busWithCapturedLines(lines: string[]): ObservabilityBus {
  return new ObservabilityBus({
    sinks: [new JsonLineEventSink((line) => lines.push(line))],
  });
}

function parseLines(lines: string[]): OperationalEvent[] {
  return lines.map((line) => JSON.parse(line) as OperationalEvent);
}

async function withOllamaStub(
  handler: (req: unknown, res: { writeHead: (code: number, headers?: Record<string, string>) => void; end: (body?: string) => void }) => void,
  run: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const server: Server = createServer((req, res) => {
    handler(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test("fast local model call emits a schema-v1 model-latency OK event", async () => {
  const lines: string[] = [];
  const bus = busWithCapturedLines(lines);

  await withOllamaStub(
    (_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ message: { content: "ok" } }));
    },
    async (baseUrl) => {
      const content = await invokeLocalModel(
        baseUrl,
        "test-model",
        [{ role: "user", content: "hi" }],
        { latencyDegradedMs: 60_000 },
        bus,
      );
      assert.equal(content, "ok");
    },
  );

  const events = parseLines(lines);
  const latency = events.find(
    (event) =>
      event.signal === "model-latency" && event.status === "OK",
  );
  assert.ok(latency, "expected a model-latency OK event");
  assert.equal(latency.schemaVersion, 1);
  assert.equal(latency.component, "model-invocation");
  assert.equal(latency.attributes.model, "test-model");
  assert.equal(typeof latency.durationMs, "number");
});

test("slow local model call emits a model-latency DEGRADED event", async () => {
  const lines: string[] = [];
  const bus = busWithCapturedLines(lines);

  await withOllamaStub(
    (_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ message: { content: "ok" } }));
    },
    async (baseUrl) => {
      await invokeLocalModel(
        baseUrl,
        "test-model",
        [{ role: "user", content: "hi" }],
        { latencyDegradedMs: 0 },
        bus,
      );
    },
  );

  const events = parseLines(lines);
  const latency = events.find(
    (event) =>
      event.signal === "model-latency" && event.status === "DEGRADED",
  );
  assert.ok(latency, "expected a model-latency DEGRADED event");
  assert.equal(latency.schemaVersion, 1);
});

test("failing model call emits a model-latency FAILED event and still throws", async () => {
  const lines: string[] = [];
  const bus = busWithCapturedLines(lines);

  await withOllamaStub(
    (_req, res) => {
      res.writeHead(500, { "content-type": "text/plain" });
      res.end("boom");
    },
    async (baseUrl) => {
      await assert.rejects(
        invokeLocalModel(baseUrl, "test-model", [{ role: "user", content: "hi" }], {}, bus),
        /Ollama request failed/,
      );
    },
  );

  const events = parseLines(lines);
  const latency = events.find(
    (event) =>
      event.signal === "model-latency" && event.status === "FAILED",
  );
  assert.ok(latency, "expected a model-latency FAILED event");
  assert.equal(latency.schemaVersion, 1);
  assert.equal(latency.attributes.model, "test-model");
});

test("the shipped soft latency threshold is the documented 30 seconds", () => {
  assert.equal(MODEL_LATENCY_DEGRADED_MS, 30_000);
});
