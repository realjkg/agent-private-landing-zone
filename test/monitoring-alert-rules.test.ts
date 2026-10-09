import assert from "node:assert/strict";
import test from "node:test";

import {
  PRODUCTION_SIGNALS,
} from "../src/observability/events.js";
import {
  loadAlertRules,
  parseAlertRules,
  uncoveredSignals,
} from "../src/monitoring/alert-rules.js";

const VALID_RULE = [
  "id: probe-rule",
  "signal: adapter-failures",
  "forStatus: FAILED",
  "threshold: 1",
  "window: 5m",
  "severity: critical",
];

function documentWithRule(
  ruleLines: string[],
): string {
  const [first, ...rest] = ruleLines;

  return [
    "apiVersion: alz.io/alert-rules/v1",
    "kind: AlertRules",
    "rules:",
    "  - " + first,
    ...rest.map(
      (line) => "    " + line,
    ),
    "",
  ].join("\n");
}

function failureReason(
  raw: string,
): string {
  try {
    parseAlertRules(raw);
  } catch (error) {
    return error instanceof Error
      ? error.message
      : String(error);
  }

  throw new Error(
    "expected parseAlertRules to reject the document",
  );
}

test("config/alert-rules.yaml loads against the typed alert-rules schema", async () => {
  const config =
    await loadAlertRules();

  assert.equal(
    config.apiVersion,
    "alz.io/alert-rules/v1",
  );
  assert.equal(
    config.kind,
    "AlertRules",
  );
  assert.equal(
    config.rules.length,
    12,
  );

  const starterPostures =
    config.rules
      .slice(0, 4)
      .map(
        (rule) =>
          [
            rule.signal,
            rule.forStatus,
            rule.threshold,
            rule.window,
            rule.severity,
          ],
      );

  assert.deepEqual(
    starterPostures,
    [
      [
        "adapter-failures",
        "FAILED",
        1,
        "5m",
        "critical",
      ],
      [
        "model-restarts",
        "DEGRADED",
        2,
        "15m",
        "warning",
      ],
      [
        "policy-denials",
        "BLOCKED",
        5,
        "15m",
        "warning",
      ],
      [
        "recovery-objective-status",
        "DEGRADED",
        1,
        "5m",
        "warning",
      ],
    ],
  );
});

test("every production signal keeps at least one alert rule", async () => {
  const config =
    await loadAlertRules();

  assert.deepEqual(
    uncoveredSignals(config.rules),
    [],
  );
});

test("uncoveredSignals reports only signals without rules", () => {
  const covered = parseAlertRules(
    documentWithRule(VALID_RULE),
  ).rules;

  assert.equal(
    uncoveredSignals(covered)
      .includes("adapter-failures"),
    false,
  );
  assert.equal(
    uncoveredSignals(covered)
      .includes("policy-denials"),
    true,
  );
  assert.equal(
    uncoveredSignals(covered).length,
    PRODUCTION_SIGNALS.length - 1,
  );
});

test("unknown signals, statuses, and fields fail with a precise reason", () => {
  const unknownSignal = failureReason(
    documentWithRule(
      VALID_RULE.map((line) =>
        line.replace(
          "signal: adapter-failures",
          "signal: model-restart",
        ),
      ),
    ),
  );

  assert.match(
    unknownSignal,
    /ALERT_RULES_INVALID/,
  );
  assert.match(
    unknownSignal,
    /rules\[0\]\.signal/,
  );
  assert.match(
    unknownSignal,
    /model-latency/,
  );

  const unknownStatus = failureReason(
    documentWithRule(
      VALID_RULE.map((line) =>
        line.replace(
          "forStatus: FAILED",
          "forStatus: ERROR",
        ),
      ),
    ),
  );

  assert.match(
    unknownStatus,
    /rules\[0\]\.forStatus/,
  );

  const unknownField = failureReason(
    documentWithRule([
      ...VALID_RULE,
      "severities: critical",
    ]),
  );

  assert.match(
    unknownField,
    /unrecognized field "severities"/,
  );
});

test("invalid thresholds and windows fail with a precise reason", () => {
  for (const threshold of [
    "threshold: 0",
    "threshold: 1.5",
    "threshold: high",
  ]) {
    const reason = failureReason(
      documentWithRule(
        VALID_RULE.map((line) =>
          line.startsWith("threshold:")
            ? threshold
            : line,
        ),
      ),
    );

    assert.match(
      reason,
      /rules\[0\]\.threshold/,
    );
  }

  const badWindow = failureReason(
    documentWithRule(
      VALID_RULE.map((line) =>
        line.replace("window: 5m", "window: 5x"),
      ),
    ),
  );

  assert.match(
    badWindow,
    /rules\[0\]\.window/,
  );
});

test("documents that are not AlertRules fail with a precise reason", () => {
  const badApiVersion = failureReason(
    documentWithRule(VALID_RULE).replace(
      "alz.io/alert-rules/v1",
      "alz.io/alert-rules/v2",
    ),
  );

  assert.match(badApiVersion, /apiVersion/);
  assert.match(
    badApiVersion,
    /alz\.io\/alert-rules\/v1/,
  );

  const badKind = failureReason(
    documentWithRule(VALID_RULE).replace(
      "kind: AlertRules",
      "kind: ConfigMap",
    ),
  );

  assert.match(badKind, /\bkind\b/);

  const missingRules = failureReason(
    [
      "apiVersion: alz.io/alert-rules/v1",
      "kind: AlertRules",
      "",
    ].join("\n"),
  );

  assert.match(missingRules, /\brules\b/);

  const emptyRules = failureReason(
    [
      "apiVersion: alz.io/alert-rules/v1",
      "kind: AlertRules",
      "rules:",
      "",
    ].join("\n"),
  );

  assert.match(emptyRules, /\brules\b/);
});

test("structural mistakes fail with a line number and precise reason", () => {
  const unsupportedSyntax = failureReason(
    [
      "apiVersion: alz.io/alert-rules/v1",
      "kind: AlertRules",
      "not a mapping line",
      "",
    ].join("\n"),
  );

  assert.match(
    unsupportedSyntax,
    /unsupported syntax/,
  );
  assert.match(
    unsupportedSyntax,
    /line 3/,
  );

  const duplicateKey = failureReason(
    [
      "apiVersion: alz.io/alert-rules/v1",
      "kind: AlertRules",
      "kind: AlertRules",
      "rules:",
      "",
    ].join("\n"),
  );

  assert.match(
    duplicateKey,
    /duplicate key "kind"/,
  );

  const duplicateRuleId = failureReason(
    [
      "apiVersion: alz.io/alert-rules/v1",
      "kind: AlertRules",
      "rules:",
      "  - " + VALID_RULE[0],
      ...VALID_RULE.slice(1).map(
        (line) => "    " + line,
      ),
      "  - " + VALID_RULE[0],
      ...VALID_RULE.slice(1).map(
        (line) => "    " + line,
      ),
      "",
    ].join("\n"),
  );

  assert.match(
    duplicateRuleId,
    /duplicate rule id "probe-rule"/,
  );

  const orphanKey = failureReason(
    [
      "apiVersion: alz.io/alert-rules/v1",
      "kind: AlertRules",
      "rules:",
      "    signal: adapter-failures",
      "",
    ].join("\n"),
  );

  assert.match(
    orphanKey,
    /indented key outside a list item/,
  );

  const nestedList = failureReason(
    [
      "apiVersion: alz.io/alert-rules/v1",
      "kind: AlertRules",
      "rules:",
      "  - " + VALID_RULE[0],
      ...VALID_RULE.slice(1).map(
        (line) => "    " + line,
      ),
      "    tags:",
      "      - experimental",
      "",
    ].join("\n"),
  );

  assert.match(
    nestedList,
    /nested lists are not supported/,
  );
});
