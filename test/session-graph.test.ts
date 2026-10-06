import assert from "node:assert/strict";
import test from "node:test";

import { createSessionGraph } from "../src/session/graph.js";

test("LangGraph session persists state by thread id", async () => {
  const { graph } =
    createSessionGraph(":memory:");

  const config = {
    configurable: {
      thread_id: "test-thread",
    },
  };

  const first = await graph.invoke(
    {
      request:
        "Review this environment and assess operational risk.",
      provider: "AWS",
      engine: "TERRAFORM",
      mock: "brownfield",
      approveBuild: false,
      fixture: true,
    },
    config,
  );

  assert.equal(
    first.agentState?.environment?.classification,
    "BROWNFIELD",
  );
  assert.match(
    first.response ?? "",
    /strongest operational risk/i,
  );

  const second = await graph.invoke(
    {
      request: "what did you find?",
      provider: "AWS",
      engine: "TERRAFORM",
      mock: "brownfield",
      approveBuild: false,
      fixture: true,
    },
    config,
  );

  assert.match(
    second.response ?? "",
    /BROWNFIELD/,
  );
  assert.ok(
    (second.history?.length ?? 0) >= 2,
  );
});

test("session can switch IaC engine conversationally", async () => {
  const { graph } =
    createSessionGraph(":memory:");

  const config = {
    configurable: {
      thread_id: "switch-thread",
    },
  };

  const result = await graph.invoke(
    {
      request: "use Pulumi instead",
      provider: "AWS",
      engine: "TERRAFORM",
      mock: "brownfield",
      approveBuild: false,
      fixture: true,
    },
    config,
  );

  assert.equal(
    result.engine,
    "PULUMI",
  );
  assert.match(
    result.response ?? "",
    /switched.*PULUMI/i,
  );
});


test("conversational session emits safe progress telemetry", async () => {
  const progress: string[] = [];
  const { graph } =
    createSessionGraph(
      ":memory:",
      (message) => {
        progress.push(message);
      },
    );

  const config = {
    configurable: {
      thread_id:
        "progress-thread",
    },
  };

  await graph.invoke(
    {
      request:
        "Assess this environment.",
      provider: "AWS",
      engine: "TERRAFORM",
      mock: "brownfield",
      approveBuild: false,
      fixture: true,
    },
    config,
  );

  assert.ok(
    progress.some(
      (message) =>
        /Sensing environment/.test(
          message,
        ),
    ),
  );
  assert.ok(
    progress.some(
      (message) =>
        /Reasoning about the request/.test(
          message,
        ),
    ),
  );
  assert.equal(
    progress.some(
      (message) =>
        /chain-of-thought/i.test(
          message,
        ),
    ),
    false,
  );
});
