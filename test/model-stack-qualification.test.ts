import assert from "node:assert/strict";
import test from "node:test";

import type {
  AgentResult,
} from "../src/loop.js";
import {
  qualifyDefaultModelStack,
  type AgentLoopRunner,
} from "../src/models/stack-qualification.js";

function fixture(
  options: {
    verification?: boolean;
    includeValidator?: boolean;
    topRisk?: string;
  } = {},
): AgentResult {
  const verification =
    options.verification ??
    false;

  return {
    requestId: "fixture",
    plan: {
      complexity: verification
        ? "HIGH"
        : "LOW",
      freshDataRequired: false,
      impact: verification
        ? "HIGH"
        : "LOW",
      verificationRequired:
        verification,
    },
    status: "OK",
    primary: {
      topRisk:
        options.topRisk ??
        "Recovery evidence is unknown",
      whyItMatters:
        "Recovery has not been demonstrated.",
      recommendedActions: [
        "Verify recovery evidence.",
      ],
      confidence: "MEDIUM",
      assumptions: [],
    },
    validator:
      options.includeValidator
        ? {
            topRisk:
              "Recovery evidence is unknown",
            whyItMatters:
              "Recovery has not been demonstrated.",
            recommendedActions: [
              "Verify recovery evidence.",
            ],
            confidence: "MEDIUM",
            assumptions: [],
          }
        : undefined,
    durationMs: 1,
  };
}

test("default model stack qualification passes disciplined role behavior", async () => {
  const runner:
    AgentLoopRunner =
    async (request) => {
      if (
        request.includes(
          "high-impact",
        )
      ) {
        return fixture({
          verification: true,
          includeValidator: true,
        });
      }

      return fixture();
    };

  const checks =
    await qualifyDefaultModelStack(
      runner,
    );

  assert.equal(
    checks.every(
      (check) => check.passed,
    ),
    true,
  );
});

test("default model stack qualification fails if validator is skipped", async () => {
  const runner:
    AgentLoopRunner =
    async (request) =>
      fixture({
        verification:
          request.includes(
            "high-impact",
          ),
        includeValidator: false,
      });

  const checks =
    await qualifyDefaultModelStack(
      runner,
    );

  assert.equal(
    checks.find(
      (check) =>
        check.name ===
        "stack independent validation",
    )?.passed,
    false,
  );
});

test("default model stack qualification catches evidence leakage", async () => {
  const runner:
    AgentLoopRunner =
    async (request) => {
      if (
        request.includes(
          "high-impact",
        )
      ) {
        return fixture({
          verification: true,
          includeValidator: true,
        });
      }

      if (
        request.includes(
          "supplied evidence",
        )
      ) {
        return fixture({
          topRisk:
            "STACK_CANARY_SECRET_4419",
        });
      }

      return fixture();
    };

  const checks =
    await qualifyDefaultModelStack(
      runner,
    );

  assert.equal(
    checks.find(
      (check) =>
        check.name ===
        "stack evidence isolation",
    )?.passed,
    false,
  );
});
