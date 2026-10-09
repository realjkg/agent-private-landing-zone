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
  validatePluginCatalog,
} from "../src/plugins/validate.js";
import {
  executeGovernedTool,
} from "../src/tools/governed.js";
import {
  BuiltinSecurityPolicyEvaluator,
} from "../src/security/policy/builtin.js";

function busWithCapturedLines(lines: string[]): ObservabilityBus {
  return new ObservabilityBus({
    sinks: [new JsonLineEventSink((line) => lines.push(line))],
  });
}

function parseLines(lines: string[]): OperationalEvent[] {
  return lines.map((line) => JSON.parse(line) as OperationalEvent);
}

test("plugin catalog validation failures emit schema-v1 adapter-failures FAILED events", () => {
  const lines: string[] = [];
  const bus = busWithCapturedLines(lines);

  // A review date far past the 90-day window forces real validation errors
  // in the shipped catalog without mutating it.
  const errors = validatePluginCatalog(
    new Date("2030-01-01T00:00:00Z"),
    bus,
  );

  assert.ok(errors.length > 0, "expected stale-review errors");
  const events = parseLines(lines);
  const failures = events.filter(
    (event) =>
      event.signal === "adapter-failures" &&
      event.status === "FAILED" &&
      event.component === "plugin-catalog",
  );
  assert.equal(failures.length, errors.length);
  for (const event of failures) {
    assert.equal(event.schemaVersion, 1);
    assert.match(
      String(event.detail),
      /compatibility review is stale/,
    );
  }
});

test("failed governed adapter command emits a schema-v1 adapter-failures FAILED event", async () => {
  const lines: string[] = [];
  const bus = busWithCapturedLines(lines);

  // The aws CLI is not authenticated in CI, so the governed cloud read runs
  // and fails: a real adapter failure (ok: false, not a policy refusal).
  const result = await executeGovernedTool(
    {
      tool: "aws_sts_identity",
      provider: "AWS",
    },
    {
      cwd: process.cwd(),
      allowCloudRead: true,
      allowMutation: false,
    },
    {
      evaluator: new BuiltinSecurityPolicyEvaluator(),
      compromiseState: "NORMAL",
      classification: "INTERNAL",
      allowedEgressHosts: ["aws-control-plane"],
      emitter: bus,
    },
  );

  assert.equal(Array.isArray(result), false);
  if (!Array.isArray(result)) {
    assert.equal(result.ok, false);
    assert.notEqual(result.blocked, true);
  }

  const events = parseLines(lines);
  const failure = events.find(
    (event) =>
      event.signal === "adapter-failures" &&
      event.status === "FAILED" &&
      event.component === "governed-tool",
  );
  assert.ok(failure, "expected a governed-tool adapter failure event");
  assert.equal(failure.schemaVersion, 1);
  assert.equal(failure.attributes.tool, "aws_sts_identity");
});

test("governed policy refusals do not emit adapter-failures", async () => {
  const lines: string[] = [];
  const bus = busWithCapturedLines(lines);

  const result = await executeGovernedTool(
    {
      tool: "aws_sts_identity",
      provider: "AWS",
    },
    {
      cwd: process.cwd(),
      allowCloudRead: true,
      allowMutation: false,
    },
    {
      evaluator: new BuiltinSecurityPolicyEvaluator(),
      compromiseState: "SUSPECTED",
      classification: "INTERNAL",
      allowedEgressHosts: ["aws-control-plane"],
      emitter: bus,
    },
  );

  assert.equal(Array.isArray(result), false);
  if (!Array.isArray(result)) {
    assert.equal(result.blocked, true);
  }

  const events = parseLines(lines);
  assert.ok(
    !events.some((event) => event.signal === "adapter-failures"),
    "policy refusals must not double-report as adapter failures",
  );
});
