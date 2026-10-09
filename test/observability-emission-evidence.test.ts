import assert from "node:assert/strict";
import test from "node:test";
import { rmSync } from "node:fs";

import {
  JsonLineEventSink,
  type OperationalEvent,
} from "../src/observability/events.js";
import { ObservabilityBus } from "../src/observability/bus.js";
import { writeEncryptedEvidence } from "../src/evidence/vault.js";

const VALID_KEY = Buffer.alloc(32, 7).toString("base64");

function busWithLines(lines: string[]): ObservabilityBus {
  return new ObservabilityBus({
    sinks: [new JsonLineEventSink((line) => lines.push(line))],
  });
}

function parseLines(lines: string[]): OperationalEvent[] {
  return lines.map((line) => JSON.parse(line) as OperationalEvent);
}

test("successful vault write emits an evidence-lifecycle OK event", async () => {
  const previous = process.env.AGENTIC_EVIDENCE_KEY;
  process.env.AGENTIC_EVIDENCE_KEY = VALID_KEY;

  const lines: string[] = [];
  const bus = busWithLines(lines);

  try {
    const path = await writeEncryptedEvidence(
      "test-purpose",
      "emission-test",
      { value: 1 },
      bus,
    );
    assert.match(path, /\.runs\/evidence\/test-purpose\/emission-test\.evidence$/);
  } finally {
    rmSync(".runs/evidence/test-purpose", {
      recursive: true,
      force: true,
    });
    if (previous === undefined) {
      delete process.env.AGENTIC_EVIDENCE_KEY;
    } else {
      process.env.AGENTIC_EVIDENCE_KEY = previous;
    }
  }

  const event = parseLines(lines).find(
    (candidate) =>
      candidate.signal === "evidence-lifecycle" &&
      candidate.status === "OK",
  );
  assert.ok(event, "expected an evidence-lifecycle OK event");
  assert.equal(event.schemaVersion, 1);
  assert.equal(event.attributes.purpose, "test-purpose");
  assert.equal(event.attributes.filename, "emission-test");
});

test("failed vault write emits an evidence-lifecycle FAILED event and still throws", async () => {
  const previous = process.env.AGENTIC_EVIDENCE_KEY;
  process.env.AGENTIC_EVIDENCE_KEY = Buffer.alloc(8, 1).toString("base64");

  const lines: string[] = [];
  const bus = busWithLines(lines);

  try {
    await assert.rejects(
      writeEncryptedEvidence("test-purpose", "emission-fail", { value: 1 }, bus),
      /EVIDENCE_KEY_INVALID/,
    );
  } finally {
    if (previous === undefined) {
      delete process.env.AGENTIC_EVIDENCE_KEY;
    } else {
      process.env.AGENTIC_EVIDENCE_KEY = previous;
    }
  }

  const event = parseLines(lines).find(
    (candidate) =>
      candidate.signal === "evidence-lifecycle" &&
      candidate.status === "FAILED",
  );
  assert.ok(event, "expected an evidence-lifecycle FAILED event");
  assert.equal(event.schemaVersion, 1);
  assert.equal(event.attributes.purpose, "test-purpose");
});
