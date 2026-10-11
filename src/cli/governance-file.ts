import { readFileSync } from "node:fs";

import { analyzeOperatingEconomics } from "../economics/report.js";
import { explainRecoveryIntent, parseRecoveryTargetIntent, recoveryTargetStatus, recoveryTestReadiness } from "../recovery/profile/operator.js";
import { parseRecoveryTargets } from "../recovery/target-loader.js";

// Read-only views over one JSON file the console server wrote to a private
// directory: ./alz target check|explain, recovery status|test and economics
// report, which cannot take a path outside the repository.
const [kind, file] = process.argv.slice(2);
const NOTE = "No infrastructure changes were made.";

try {
  if (!file) throw new Error("Usage: governance-file <target-check|target-explain|recovery-status|recovery-test|economics> <file>");
  const value = JSON.parse(readFileSync(file, "utf8")) as unknown;
  if (kind === "target-check") {
    parseRecoveryTargetIntent(value);
    console.log("Target intent is valid.\n" + NOTE);
  } else if (kind === "target-explain") {
    console.log(explainRecoveryIntent(parseRecoveryTargetIntent(value)) + "\n\n" + NOTE);
  } else if (kind === "recovery-status" || kind === "recovery-test") {
    const check = kind === "recovery-status" ? recoveryTargetStatus : recoveryTestReadiness;
    for (const target of parseRecoveryTargets(value)) {
      const result = check(target);
      console.log("\n" + result.lines.join("\n"));
      if (kind === "recovery-test" && !result.ready) process.exitCode = 1;
    }
  } else if (kind === "economics") {
    console.log(JSON.stringify(analyzeOperatingEconomics(value), null, 2));
    console.log("Advisory only. No infrastructure or cost-changing actions were executed.");
  } else {
    throw new Error("Unknown view.");
  }
} catch (error) {
  // Schema failures list "path: problem" instead of the raw issue JSON.
  const issues = (error as { issues?: { path: PropertyKey[]; message: string }[] }).issues;
  const detail = Array.isArray(issues) ? issues.map((issue) => issue.path.join(".") + ": " + issue.message).join("; ")
    : error instanceof Error ? error.message : "unknown error";
  console.error("GOVERNANCE_VIEW_FAILED: " + detail.slice(0, 400));
  process.exitCode = 1;
}
