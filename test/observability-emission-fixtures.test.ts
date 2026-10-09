import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { resolve } from "node:path";

import {
  OPERATIONAL_EVENT_STATUSES,
  PRODUCTION_SIGNALS,
  type OperationalEvent,
} from "../src/observability/events.js";

const root = process.cwd();
const tsx = resolve(root, "node_modules", ".bin", "tsx");

function runFixture(args: string[]): string[] {
  const result = spawnSync(tsx, args, {
    cwd: root,
    encoding: "utf8",
    shell: false,
  });

  assert.equal(
    result.status,
    0,
    "fixture command failed: " + result.stderr,
  );

  return result.stdout
    .split("\n")
    .filter((line) => line.startsWith('{"schemaVersion"'))
    .map((line) => JSON.parse(line) as OperationalEvent);
}

function assertValidSchemaV1(events: OperationalEvent[]): void {
  assert.ok(events.length > 0, "expected emitted operational events");

  for (const event of events) {
    assert.equal(event.schemaVersion, 1);
    assert.ok(
      (PRODUCTION_SIGNALS as readonly string[]).includes(event.signal),
      "unknown signal: " + event.signal,
    );
    assert.ok(
      (OPERATIONAL_EVENT_STATUSES as readonly string[]).includes(
        event.status,
      ),
      "unknown status: " + event.status,
    );
    assert.ok(!Number.isNaN(Date.parse(event.at)));
    assert.equal(typeof event.component, "string");
  }
}

test("discover:aws emits schema-v1 events for every signal its path touches", () => {
  const events = runFixture([
    "src/cli/discover.ts",
    "--provider",
    "aws",
    "--mock",
    "brownfield",
  ]);

  assertValidSchemaV1(events);

  const discovery = events.find(
    (event) =>
      event.signal === "provider-discovery-health" && event.status === "OK",
  );
  assert.ok(discovery, "expected provider-discovery-health OK");

  const evidence = events.find(
    (event) =>
      event.signal === "evidence-lifecycle" && event.status === "OK",
  );
  assert.ok(evidence, "expected evidence-lifecycle OK for the run records");
});

test("build:aws:terraform emits schema-v1 events including the real build-gate refusal", () => {
  const events = runFixture([
    "src/cli/build-loop.ts",
    "--provider",
    "aws",
    "--engine",
    "terraform",
    "--mock",
    "brownfield",
  ]);

  assertValidSchemaV1(events);

  const discovery = events.find(
    (event) =>
      event.signal === "provider-discovery-health" && event.status === "OK",
  );
  assert.ok(discovery, "expected provider-discovery-health OK");

  const denial = events.find(
    (event) =>
      event.signal === "policy-denials" &&
      event.status === "BLOCKED" &&
      event.component === "build-gate",
  );
  assert.ok(
    denial,
    "expected a build-gate policy-denials BLOCKED event (unapproved fixture build)",
  );

  const evidence = events.find(
    (event) =>
      event.signal === "evidence-lifecycle" && event.status === "OK",
  );
  assert.ok(evidence, "expected evidence-lifecycle OK for the build record");
});

test("agent:assess emits schema-v1 events for its path", () => {
  const events = runFixture([
    "src/cli/agent.ts",
    "--provider",
    "aws",
    "--engine",
    "terraform",
    "--mock",
    "brownfield",
    "--fixture",
    "--request",
    "Review this environment and assess the strongest operational risk.",
  ]);

  assertValidSchemaV1(events);

  const evidence = events.find(
    (event) =>
      event.signal === "evidence-lifecycle" && event.status === "OK",
  );
  assert.ok(evidence, "expected evidence-lifecycle OK for the agent run record");
});
