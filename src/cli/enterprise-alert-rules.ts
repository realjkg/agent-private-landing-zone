import { readFileSync } from "node:fs";

import { loadAlertRules, parseAlertRules, uncoveredSignals } from "../monitoring/alert-rules.js";
import { option, reason, runReport } from "../enterprise/report.js";

// ./alz enterprise alert-rules [--input FILE]
// Validates alert rules against the strict schema and reports production signals
// with no rule. FILE is YAML (as in config/alert-rules.yaml) or the same document
// as JSON. Without FILE the shipped config/alert-rules.yaml is checked.
const scalar = (value: unknown): string => {
  if (typeof value !== "string" && typeof value !== "number") throw new Error("ALERT_RULES_VALUE_INVALID");
  if (/[\r\n]/.test(String(value))) throw new Error("ALERT_RULES_VALUE_INVALID");
  return String(value);
};

/** The JSON form of the document, written in the flat YAML shape the loader reads; unknown keys are kept so the strict schema rejects them. */
function yamlFor(document: Record<string, unknown>): string {
  const { rules, ...header } = document;
  if (!Array.isArray(rules)) throw new Error("ALERT_RULES_SHAPE_INVALID");
  return [...Object.entries(header).map(([key, value]) => scalar(key) + ": " + scalar(value)), "rules:",
    ...rules.flatMap((rule: Record<string, unknown>) => Object.entries(rule).map(([key, value], index) =>
      (index === 0 ? "  - " : "    ") + scalar(key) + ": " + scalar(value)))].join("\n");
}

await runReport(async (args) => {
  const path = option(args, "input");
  let config;
  try {
    if (path === undefined) config = await loadAlertRules();
    else {
      const raw = readFileSync(path, "utf8");
      let text = raw;
      try {
        text = yamlFor(JSON.parse(raw) as Record<string, unknown>);
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
      }
      config = parseAlertRules(text, "pasted alert rules");
    }
  } catch (error) {
    return { ok: false, lines: ["ALERT RULES REJECTED: " + reason(error)] };
  }
  const uncovered = uncoveredSignals(config.rules);
  const severities = (severity: string) => config.rules.filter((rule) => rule.severity === severity).length;
  return { ok: uncovered.length === 0, lines: [
    uncovered.length === 0 ? "ALERT RULES VALID" : "ALERT RULES VALID BUT INCOMPLETE",
    "Rules: " + config.rules.length + " (" + severities("critical") + " critical, " + severities("warning") + " warning)",
    "Production signals with no rule: " + (uncovered.join(", ") || "none"),
    "Checked only. Nothing was sent to any alerting system.",
  ] };
});
