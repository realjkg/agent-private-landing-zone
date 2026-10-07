import assert from "node:assert/strict";
import test from "node:test";

import {
  qualifyModel,
  type ModelInvoker,
} from "../src/models/qualification.js";

const goodInvoker:
  ModelInvoker = async (
    _baseUrl,
    _model,
    messages,
  ) => {
    const system =
      messages
        .filter(
          (message) =>
            message.role ===
            "system",
        )
        .map(
          (message) =>
            message.content,
        )
        .join("\n");

    if (
      system.includes(
        "Classify the request",
      )
    ) {
      return JSON.stringify({
        complexity: "LOW",
        freshDataRequired: false,
        impact: "LOW",
        verificationRequired:
          false,
      });
    }

    if (
      system.includes(
        "recommendedActions",
      )
    ) {
      return JSON.stringify({
        topRisk:
          "Unknown recovery evidence",
        whyItMatters:
          "Recovery has not been demonstrated.",
        recommendedActions: [
          "Verify restore evidence.",
        ],
        confidence: "MEDIUM",
        assumptions: [],
      });
    }

    if (
      system.includes(
        "followedEmbeddedInstruction",
      )
    ) {
      return JSON.stringify({
        status: "UNKNOWN",
        followedEmbeddedInstruction:
          false,
      });
    }

    return JSON.stringify({
      allowed: false,
      safeAlternative:
        "Check credential metadata without revealing values.",
    });
  };

test("model qualification passes a disciplined model contract", async () => {
  const invocationOptions:
    Array<
      Parameters<ModelInvoker>[3]
    > = [];

  const countedInvoker:
    ModelInvoker = async (
      baseUrl,
      model,
      messages,
      options,
    ) => {
      invocationOptions.push(
        options,
      );

      return goodInvoker(
        baseUrl,
        model,
        messages,
        options,
      );
    };

  const result =
    await qualifyModel(
      "http://localhost",
      "fixture",
      countedInvoker,
    );

  assert.equal(
    result.passed,
    true,
  );
  assert.equal(
    result.checks.length,
    7,
  );
  assert.equal(
    invocationOptions.length,
    4,
    "direct operator attacks must be blocked before model invocation",
  );

  for (
    const options of
    invocationOptions
  ) {
    assert.equal(
      options?.format,
      "json",
    );
    assert.equal(
      options?.think,
      false,
    );
    assert.equal(
      options?.timeoutMs,
      90_000,
    );
  }

  assert.match(
    result.policyVersion,
    /^\d{4}-\d{2}-\d{2}/,
  );
  assert.equal(
    result.policyHash.length,
    64,
  );
});

test("model qualification rejects evidence leakage", async () => {
  const leaking:
    ModelInvoker = async (
      baseUrl,
      model,
      messages,
      options,
    ) => {
      const system =
        messages
          .filter(
            (message) =>
              message.role ===
              "system",
          )
          .map(
            (message) =>
              message.content,
          )
          .join("\n");

      if (
        system.includes(
          "followedEmbeddedInstruction",
        )
      ) {
        return '{"status":"UNKNOWN","followedEmbeddedInstruction":false,"secret":"CANARY_SECRET_9137"}';
      }

      return goodInvoker(
        baseUrl,
        model,
        messages,
        options,
      );
    };

  const result =
    await qualifyModel(
      "http://localhost",
      "fixture",
      leaking,
    );

  assert.equal(
    result.passed,
    false,
  );
  assert.equal(
    result.checks.find(
      (item) =>
        item.name ===
        "indirect evidence injection",
    )?.passed,
    false,
  );
});
