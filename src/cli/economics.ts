import { readFileSync } from "node:fs";
import { resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { analyzeOperatingEconomics } from "../economics/report.js";
import { createConfiguredBus } from "../observability/bus.js";
import { loadObservabilityConfig } from "../config.js";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const [command, file, format] = process.argv.slice(2);

try {
  if (command !== "report" || !file || (format !== undefined && format !== "--json")) {
    throw new Error("Usage: ./alz economics report <input.json> [--json]");
  }
  const path = resolve(root, file);
  if (path !== root && !path.startsWith(root + sep)) {
    throw new Error("Economics input must be inside the accelerator workspace.");
  }
  const report = analyzeOperatingEconomics(JSON.parse(readFileSync(path, "utf8")) as unknown);

  // Economics events ride the same bus as every other contract signal:
  // delivered to the configured sinks (stdout JSON lines by default),
  // best-effort, before the human/JSON report is printed.
  const bus = createConfiguredBus(loadObservabilityConfig());
  for (const event of report.events) {
    bus.deliver(event);
  }
  if (format === "--json") {
    console.log(JSON.stringify(report, null, 2));
  } else {
    const current = report.months.find((m) => m.month === report.reportMonth)!;
    console.log("Sovereign Landing Zone — Operating Economics (" + report.reportMonth + ")");
    console.log("Run cost: $" + (current.totalCents / 100).toFixed(2) + " USD (" + (current.closed ? "closed" : "open") + ")");
    console.log("Observed: $" + (current.observedCents / 100).toFixed(2) + "; estimated: $" + (current.estimatedCents / 100).toFixed(2));
    console.log("AI Operations premium: $" + (current.aiOperationsPremiumCents / 100).toFixed(2) + " (" + (current.aiOperationsShareBps / 100).toFixed(2) + "% of total)");
    for (const scope of Object.keys(current.byScope)) console.log(scope + ": $" + (current.byScope[scope as keyof typeof current.byScope] / 100).toFixed(2));
    for (const dimension of Object.keys(current.byDimension)) console.log(dimension + ": $" + (current.byDimension[dimension as keyof typeof current.byDimension] / 100).toFixed(2));
    for (const provider of Object.keys(current.byProvider)) console.log(provider + ": $" + (current.byProvider[provider as keyof typeof current.byProvider] / 100).toFixed(2));
    console.log("Forecast: " + (report.forecast ? "$" + (report.forecast.amountCents / 100).toFixed(2) : "unavailable"));
    for (const alert of report.alerts) console.log("ALERT " + alert.kind);
    for (const note of report.dataLimitations) console.log("Note: " + note);
    console.log("Advisory only. No infrastructure or cost-changing actions were executed.");
  }
} catch (error) {
  console.error("ECONOMICS_REPORT_FAILED: " + (error instanceof Error ? error.message : "unknown error"));
  process.exitCode = 1;
}
