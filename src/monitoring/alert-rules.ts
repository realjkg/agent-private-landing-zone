import {
  readFile,
} from "node:fs/promises";
import {
  resolve,
} from "node:path";

import {
  z,
} from "zod";

import {
  OPERATIONAL_EVENT_STATUSES,
  PRODUCTION_SIGNALS,
} from "../observability/events.js";
import type {
  OperationalEventStatus,
  ProductionSignal,
} from "../observability/events.js";

export const ALERT_RULES_API_VERSION =
  "alz.io/alert-rules/v1";

export const ALERT_RULES_KIND = "AlertRules";

export const ALERT_SEVERITIES = [
  "critical",
  "warning",
] as const;

export type AlertSeverity =
  (typeof ALERT_SEVERITIES)[number];

export type AlertRule = {
  id: string;
  signal: ProductionSignal;
  forStatus: OperationalEventStatus;
  threshold: number;
  window: string;
  severity: AlertSeverity;
};

export type AlertRulesConfig = {
  apiVersion: typeof ALERT_RULES_API_VERSION;
  kind: typeof ALERT_RULES_KIND;
  rules: AlertRule[];
};

const WINDOW_PATTERN = /^[1-9][0-9]*[smh]$/;

const alertRuleSchema = z.strictObject({
  id: z.string().min(1),
  signal: z.enum(PRODUCTION_SIGNALS),
  forStatus: z.enum(
    OPERATIONAL_EVENT_STATUSES,
  ),
  threshold: z.coerce
    .number()
    .int()
    .min(1),
  window: z.string().regex(WINDOW_PATTERN),
  severity: z.enum(ALERT_SEVERITIES),
});

const alertRulesSchema = z.strictObject({
  apiVersion: z.literal(
    ALERT_RULES_API_VERSION,
  ),
  kind: z.literal(ALERT_RULES_KIND),
  rules: z.array(alertRuleSchema).min(1),
});

function issuePathLabel(
  path: PropertyKey[],
): string {
  let label = "";

  for (const segment of path) {
    if (typeof segment === "number") {
      label += "[" + String(segment) + "]";
      continue;
    }

    label +=
      label === ""
        ? String(segment)
        : "." + String(segment);
  }

  return label;
}

function issueReason(
  issue: z.core.$ZodIssue,
): string {
  const label = issuePathLabel(issue.path);
  const prefix =
    label === "" ? "" : label + " — ";

  if (issue.code === "unrecognized_keys") {
    const keys = issue.keys.map(
      (key) => "\"" + String(key) + "\"",
    );
    return (
      prefix +
      "unrecognized field" +
      (keys.length === 1 ? "" : "s") +
      " " +
      keys.join(", ")
    );
  }

  if (issue.code === "invalid_value") {
    const values = issue.values.map(
      (value) => String(value),
    );
    return (
      prefix +
      "invalid value — expected one of: " +
      values.join(", ")
    );
  }

  return prefix + issue.message;
}

function invalid(
  documentRef: string,
  reasons: string[],
): Error {
  return new Error(
    "ALERT_RULES_INVALID: " +
      documentRef +
      ": " +
      reasons.join("; "),
  );
}

function scalarValue(raw: string): string {
  return raw.replace(
    /^["']|["']$/g,
    "",
  );
}

function entryKey(line: string): {
  key: string;
  rawValue?: string;
} | undefined {
  const entry = line.match(
    /^([A-Za-z][A-Za-z0-9]*):(?:\s*(.*))?$/,
  );

  if (!entry) {
    return undefined;
  }

  return {
    key: entry[1],
    rawValue: entry[2],
  };
}

/**
 * Parses the constrained YAML subset the alert-rules
 * config is restricted to: top-level `key: value` scalars
 * plus one list of flat maps. No anchors, nesting, or
 * flow syntax — unknown shapes fail with a line number
 * instead of being coerced.
 */
function parseRuleDocument(
  raw: string,
  documentRef: string,
): Record<string, unknown> {
  const lines = raw.split("\n");
  const document: Record<string, unknown> = {};
  let items: Record<string, unknown>[] | undefined;
  let item: Record<string, unknown> | undefined;
  let listKey: string | undefined;

  lines.forEach(
    (sourceLine, index) => {
      const line = sourceLine.trimEnd();
      const trimmed = line.trim();

      if (!trimmed || trimmed.startsWith("#")) {
        return;
      }

      const location =
        documentRef + " line " + (index + 1);

      const itemOpen = line.match(
        /^\s*-\s*(.*)$/,
      );

      if (itemOpen) {
        if (!items || !listKey) {
          throw new Error(
            "ALERT_RULES_INVALID: " +
              location +
              ": list item outside a list.",
          );
        }

        const rest = itemOpen[1].trim();

        if (rest) {
          const first = entryKey(rest);

          if (!first || first.rawValue === undefined) {
            throw new Error(
              "ALERT_RULES_INVALID: " +
                location +
                ": unsupported rule entry syntax.",
            );
          }

          item = {};
          items.push(item);
          item[first.key] =
            scalarValue(first.rawValue.trim());
          return;
        }

        item = {};
        items.push(item);
        return;
      }

      const indented = /^\s/.test(line);
      const entry = entryKey(trimmed);

      if (!entry) {
        throw new Error(
          "ALERT_RULES_INVALID: " +
            location +
            ": unsupported syntax.",
        );
      }

      if (indented) {
        if (!item) {
          throw new Error(
            "ALERT_RULES_INVALID: " +
              location +
              ": indented key outside a list item.",
          );
        }

        if (entry.rawValue === undefined) {
          throw new Error(
            "ALERT_RULES_INVALID: " +
              location +
              ": nested lists are not supported.",
          );
        }

        if (entry.key in item) {
          throw new Error(
            "ALERT_RULES_INVALID: " +
              location +
              ": duplicate field \"" +
              entry.key +
              "\" in rule.",
          );
        }

        item[entry.key] =
          scalarValue(entry.rawValue.trim());
        return;
      }

      if (document[entry.key] !== undefined) {
        throw new Error(
          "ALERT_RULES_INVALID: " +
            location +
            ": duplicate key \"" +
            entry.key +
            "\".",
        );
      }

      if (entry.rawValue === undefined) {
        listKey = entry.key;
        items = [];
        item = undefined;
        document[entry.key] = items;
        return;
      }

      listKey = undefined;
      item = undefined;
      document[entry.key] =
        scalarValue(entry.rawValue.trim());
    },
  );

  return document;
}

export function parseAlertRules(
  raw: string,
  documentRef = "config/alert-rules.yaml",
): AlertRulesConfig {
  const document = parseRuleDocument(
    raw,
    documentRef,
  );

  let parsed: AlertRulesConfig;

  try {
    parsed = alertRulesSchema.parse(document);
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw invalid(
        documentRef,
        error.issues.map((issue) =>
          issueReason(issue),
        ),
      );
    }

    throw error;
  }

  const seen = new Set<string>();

  for (const rule of parsed.rules) {
    if (seen.has(rule.id)) {
      throw invalid(documentRef, [
        "duplicate rule id \"" + rule.id + "\"",
      ]);
    }

    seen.add(rule.id);
  }

  return parsed;
}

export function uncoveredSignals(
  rules: AlertRule[],
): ProductionSignal[] {
  const covered = new Set(
    rules.map((rule) => rule.signal),
  );

  return PRODUCTION_SIGNALS.filter(
    (signal) => !covered.has(signal),
  );
}

export async function loadAlertRules(
  path = "config/alert-rules.yaml",
): Promise<AlertRulesConfig> {
  const resolved = resolve(path);
  const raw = await readFile(resolved, "utf8");

  return parseAlertRules(raw, path);
}
