import assert from "node:assert/strict";
import test from "node:test";

import {
  createOperationalEvent,
  JsonLineEventSink,
  serializeOperationalEvent,
} from "../src/observability/events.js";
import {
  healthSnapshot,
  readinessSnapshot,
} from "../src/observability/health.js";

test("structured operational events redact secret-like fields", () => {
  const event =
    createOperationalEvent({
      signal:
        "policy-denials",
      status: "BLOCKED",
      component:
        "security-policy",
      attributes: {
        policy:
          "builtin",
        token:
          "sensitive-value",
        nested: {
          password:
            "another-sensitive-value",
          harmless:
            "visible",
        },
      },
      at:
        "2026-10-07T00:00:00.000Z",
    });

  const serialized =
    serializeOperationalEvent(
      event,
    );

  assert.equal(
    serialized.includes(
      "sensitive-value",
    ),
    false,
  );
  assert.equal(
    serialized.includes(
      "another-sensitive-value",
    ),
    false,
  );
  assert.match(
    serialized,
    /visible/,
  );
  assert.match(
    serialized,
    /\[REDACTED\]/,
  );
});

test("JSON line sink emits one structured event", () => {
  const lines: string[] = [];
  const sink =
    new JsonLineEventSink(
      (line) =>
        lines.push(line),
    );

  sink.emit(
    createOperationalEvent({
      signal:
        "adapter-failures",
      status: "FAILED",
      component:
        "terraform",
      attributes: {
        adapter:
          "TERRAFORM",
      },
    }),
  );

  assert.equal(
    lines.length,
    1,
  );

  const parsed =
    JSON.parse(
      lines[0],
    ) as {
      schemaVersion: number;
      signal: string;
    };

  assert.equal(
    parsed.schemaVersion,
    1,
  );
  assert.equal(
    parsed.signal,
    "adapter-failures",
  );
});

test("health snapshot is Preview Operate with ACT disabled", () => {
  const health =
    healthSnapshot();

  assert.equal(
    health.healthy,
    true,
  );
  assert.equal(
    health.operatingMode,
    "PREVIEW_OPERATE",
  );
  assert.equal(
    health.actEnabled,
    false,
  );
});

test("readiness requires all production checks and keeps ACT disabled", () => {
  const ready =
    readinessSnapshot([
      {
        name:
          "model-runtime",
        ready: true,
        detail:
          "local runtime ready",
      },
      {
        name:
          "policy",
        ready: true,
        detail:
          "policy evaluator ready",
      },
    ]);

  assert.equal(
    ready.ready,
    true,
  );
  assert.equal(
    ready.actEnabled,
    false,
  );

  const blocked =
    readinessSnapshot([
      {
        name:
          "provider",
        ready: false,
        detail:
          "qualification pending",
      },
    ]);

  assert.equal(
    blocked.ready,
    false,
  );
  assert.equal(
    blocked.actEnabled,
    false,
  );
});
