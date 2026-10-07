import assert from "node:assert/strict";
import test from "node:test";

import {
  runAgentLoop,
} from "../src/loop.js";

test("reasoning loop emits metadata-only per-model diagnostics", async () => {
  const originalFetch =
    globalThis.fetch;
  let calls = 0;

  globalThis.fetch = (async () => {
    calls += 1;

    const content =
      calls === 1
        ? JSON.stringify({
            complexity: "LOW",
            freshDataRequired:
              false,
            impact: "LOW",
            verificationRequired:
              false,
          })
        : JSON.stringify({
            topRisk:
              "Recovery evidence is unknown",
            whyItMatters:
              "Recovery has not been demonstrated.",
            recommendedActions: [
              "Verify recovery evidence.",
            ],
            confidence:
              "MEDIUM",
            assumptions: [],
          });

    return new Response(
      JSON.stringify({
        message: {
          content,
        },
      }),
      {
        status: 200,
        headers: {
          "content-type":
            "application/json",
        },
      },
    );
  }) as typeof fetch;

  try {
    const result =
      await runAgentLoop(
        "Review a hypothetical private landing-zone architecture for operational risk.",
      );

    assert.equal(
      result.status,
      "OK",
    );
    assert.deepEqual(
      result.modelInvocations
        ?.map(
          (item) =>
            item.role,
        ),
      [
        "ROUTER",
        "PRIMARY",
      ],
    );

    for (
      const item of
      result.modelInvocations ??
      []
    ) {
      assert.equal(
        typeof item.durationMs,
        "number",
      );
      assert.equal(
        item.structuredOutput,
        true,
      );
      assert.equal(
        item.schemaValid,
        true,
      );
      assert.equal(
        "prompt" in item,
        false,
      );
      assert.equal(
        "response" in item,
        false,
      );
    }
  } finally {
    globalThis.fetch =
      originalFetch;
  }
});
