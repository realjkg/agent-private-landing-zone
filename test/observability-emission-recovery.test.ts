import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

import {
  JsonLineEventSink,
  type OperationalEvent,
} from "../src/observability/events.js";
import { ObservabilityBus } from "../src/observability/bus.js";
import { RecoveryAutomationController } from "../src/recovery/automation.js";
import { parseSecurityBaseline } from "../src/recovery/profile/baseline.js";
import { compileRecoveryTarget } from "../src/recovery/profile/compiler.js";
import {
  recoveryTargetStatus,
  recoveryTestReadiness,
} from "../src/recovery/profile/operator.js";
import type {
  RecoveryCompileContext,
  RecoveryTargetIntent,
} from "../src/recovery/profile/types.js";

// Fixtures mirror test/recovery-profile.test.ts so the compiled target is valid.
const baseline = parseSecurityBaseline(
  readFileSync("config/security-baseline.md", "utf8"),
);

const context: RecoveryCompileContext = {
  engine: "TERRAFORM",
  approvedDesignHash: "a".repeat(64),
  designRef: "fixture:design",
  sourceOfTruthRef: "fixture:git",
  destinationTargetRef: "aws:backup-vault:account:region:vault",
  sourceCommit: "commit-fixture",
};

const developmentIntent: RecoveryTargetIntent = {
  targetId: "payments-dev",
  owner: "platform",
  provider: "AWS",
  scopeId: "123456789012",
  organization: "STARTUP",
  environment: "DEVELOPMENT",
  criticality: "NON_CRITICAL",
  compliancePacks: [],
};

function busWithLines(lines: string[]): ObservabilityBus {
  return new ObservabilityBus({
    sinks: [new JsonLineEventSink((line) => lines.push(line))],
  });
}

function parseLines(lines: string[]): OperationalEvent[] {
  return lines.map((line) => JSON.parse(line) as OperationalEvent);
}

test("blocked recovery target emits recovery-objective-status DEGRADED", () => {
  const lines: string[] = [];
  const bus = busWithLines(lines);
  const compiled = compileRecoveryTarget(developmentIntent, context, baseline);
  const blocked = {
    ...compiled,
    scope: { ...compiled.scope, id: "" },
  };

  const status = recoveryTargetStatus(blocked, bus);
  assert.equal(status.ready, false);

  const event = parseLines(lines).find(
    (candidate) =>
      candidate.signal === "recovery-objective-status" &&
      candidate.status === "DEGRADED",
  );
  assert.ok(event, "expected a recovery-objective-status DEGRADED event");
  assert.equal(event.schemaVersion, 1);
  assert.equal(event.attributes.targetId, "payments-dev");
});

test("ready recovery target emits recovery-objective-status OK", () => {
  const lines: string[] = [];
  const bus = busWithLines(lines);
  const compiled = compileRecoveryTarget(developmentIntent, context, baseline);

  const status = recoveryTargetStatus(compiled, bus);
  assert.equal(status.ready, true);

  const event = parseLines(lines).find(
    (candidate) =>
      candidate.signal === "recovery-objective-status" &&
      candidate.status === "OK",
  );
  assert.ok(event, "expected a recovery-objective-status OK event");
  assert.equal(event.schemaVersion, 1);
  assert.equal(event.attributes.targetId, "payments-dev");
});

test("recovery test preflight emits exactly one OK objective event via delegation", () => {
  const lines: string[] = [];
  const bus = busWithLines(lines);
  const compiled = compileRecoveryTarget(developmentIntent, context, baseline);

  const preflight = recoveryTestReadiness(compiled, bus);
  assert.equal(preflight.ready, true);

  const events = parseLines(lines).filter(
    (candidate) => candidate.signal === "recovery-objective-status",
  );
  assert.equal(events.length, 1);
  assert.equal(events[0].status, "OK");
});

test("controller context failure emits recovery-state BLOCKED", async () => {
  const lines: string[] = [];
  const bus = busWithLines(lines);
  const compiled = compileRecoveryTarget(developmentIntent, context, baseline);

  const controller = new RecoveryAutomationController({
    targets: [compiled],
    contextProvider: async () => {
      throw new Error("context unavailable");
    },
    grantedCapabilities: ["EVIDENCE_READ", "EVIDENCE_WRITE"],
    persistEvidence: false,
    emitter: bus,
  });

  const results = await controller.tick(
    new Date("2026-10-07T04:00:00.000Z"),
  );
  assert.equal(results[0].status, "BLOCKED");

  const event = parseLines(lines).find(
    (candidate) =>
      candidate.signal === "recovery-state" && candidate.status === "BLOCKED",
  );
  assert.ok(event, "expected a recovery-state BLOCKED event");
  assert.equal(event.schemaVersion, 1);
  assert.equal(event.attributes.targetId, "payments-dev");
});
