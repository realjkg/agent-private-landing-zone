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

  const second = await graph.invoke(
    {
      request: ":environment",
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
