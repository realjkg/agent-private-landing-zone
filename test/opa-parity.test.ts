import assert from "node:assert/strict";
import test from "node:test";

import {
  evaluateBuiltinSecurityPolicy,
} from "../src/security/policy/builtin.js";
import {
  OPA_PARITY_CASES,
  PINNED_OPA_LINUX_AMD64_SHA256,
  PINNED_OPA_VERSION,
  comparePolicyDecisions,
  parseOpaEvalDecision,
  parseOpaVersion,
  qualifyOpaParity,
} from "../src/qualification/opa-parity.js";

test("OPA production qualification pins an exact release and asset digest", () => {
  assert.equal(
    PINNED_OPA_VERSION,
    "1.21.1",
  );
  assert.match(
    PINNED_OPA_LINUX_AMD64_SHA256,
    /^[0-9a-f]{64}$/,
  );
});

test("OPA version output parses the pinned semantic version", () => {
  assert.equal(
    parseOpaVersion(
      "Version: 1.21.1\nBuild Commit: fixture\n",
    ),
    "1.21.1",
  );

  assert.throws(
    () =>
      parseOpaVersion(
        "unknown",
      ),
    /OPA_VERSION_UNREADABLE/,
  );
});

test("OPA eval output parses a named decision", () => {
  const decision =
    parseOpaEvalDecision(
      JSON.stringify({
        result: [
          {
            expressions: [
              {
                value: {
                  allow: false,
                  reasons: [
                    "blocked",
                  ],
                  obligations: [
                    "review",
                  ],
                },
              },
            ],
          },
        ],
      }),
    );

  assert.deepEqual(
    decision,
    {
      allow: false,
      reasons: [
        "blocked",
      ],
      obligations: [
        "review",
      ],
      source: "OPA",
    },
  );
});

test("strict parity includes allow reasons and obligations", () => {
  const builtin =
    {
      allow: false,
      reasons: [
        "reason",
      ],
      obligations: [
        "obligation",
      ],
      source:
        "BUILTIN" as const,
    };

  assert.equal(
    comparePolicyDecisions(
      builtin,
      {
        ...builtin,
        source: "OPA",
      },
    ).strict,
    true,
  );

  assert.equal(
    comparePolicyDecisions(
      builtin,
      {
        ...builtin,
        reasons: [
          "different",
        ],
        source: "OPA",
      },
    ).strict,
    false,
  );
});

test("complete built-in-equivalent evidence satisfies the parity contract", () => {
  const decisions =
    Object.fromEntries(
      OPA_PARITY_CASES.map(
        (testCase) => [
          testCase.name,
          {
            ...evaluateBuiltinSecurityPolicy(
              testCase.input,
            ),
            source:
              "OPA" as const,
          },
        ],
      ),
    );

  const result =
    qualifyOpaParity({
      version:
        PINNED_OPA_VERSION,
      decisions,
    });

  assert.equal(
    result.passed,
    true,
  );
  assert.ok(
    result.cases.every(
      (item) =>
        item.parity.strict,
    ),
  );
});

test("wrong OPA version or missing evidence fails qualification", () => {
  const versionMismatch =
    qualifyOpaParity({
      version: "1.21.0",
      decisions:
        Object.fromEntries(
          OPA_PARITY_CASES.map(
            (testCase) => [
              testCase.name,
              {
                ...evaluateBuiltinSecurityPolicy(
                  testCase.input,
                ),
                source:
                  "OPA" as const,
              },
            ],
          ),
        ),
    });

  assert.equal(
    versionMismatch.passed,
    false,
  );
  assert.equal(
    versionMismatch.versionMatch,
    false,
  );

  const missing =
    qualifyOpaParity({
      version:
        PINNED_OPA_VERSION,
      decisions: {},
    });

  assert.equal(
    missing.passed,
    false,
  );
});
