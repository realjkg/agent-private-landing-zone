/**
 * Read-only feedback for a developer working without cloud/model credentials.
 * Never launches tests, Terraform, Homebrew, Ollama, cloud tools, or ACT.
 * Operator-supplied check states are NOT proof of passing GitHub Actions.
 */
import { execFileSync } from "node:child_process";
import {
  DEVELOPMENT_CHECKS, reviewDevelopmentReadiness,
  type DevelopmentCheckInput, type DevelopmentCheckId, type DevelopmentCheckState,
} from "../src/qualification/development-readiness.js";

const argumentsList = process.argv.slice(2);
if (argumentsList.length === 1 && argumentsList[0] === "--help") {
  console.log("Sovereign ALZ — offline development posture (NOT release admission)");
  console.log("./node_modules/.bin/tsx scripts/development-readiness.ts [--check id=pass|fail|not-run] [--json]");
  console.log("Allowed checks: " + DEVELOPMENT_CHECKS.map((x) => x.id).join(", "));
  console.log("No cloud accounts, private models, artifact downloads or ACT are contacted.");
} else {
  try {
    const submitted: DevelopmentCheckInput[] = [];
    let json = false;
    for (let i = 0; i < argumentsList.length; i++) {
      const arg = argumentsList[i];
      if (arg === "--json") {
        if (json) throw new Error("DUPLICATE_JSON_SWITCH");
        json = true;
      } else if (arg === "--check") {
        const value = argumentsList[++i];
        if (!value) throw new Error("DEVELOPMENT_CHECK_VALUE_REQUIRED");
        const match = /^([a-z-]+)=(pass|fail|not-run)$/.exec(value);
        if (!match) throw new Error("DEVELOPMENT_CHECK_FORMAT_INVALID");
        const inputStatus: Record<string, DevelopmentCheckState> = {
          pass: "REPORTED_PASS", fail: "REPORTED_FAIL", "not-run": "NOT_RUN",
        };
        submitted.push({ id: match[1] as DevelopmentCheckId, status: inputStatus[match[2]!]! });
      } else throw new Error("DEVELOPMENT_ARGUMENT_UNKNOWN:" + arg);
    }
    const source = execFileSync("git", ["rev-parse", "HEAD"], {
      encoding: "utf8", timeout: 5000, maxBuffer: 256,
    }).trim();
    const report = reviewDevelopmentReadiness(source, submitted);
    if (json) console.log(JSON.stringify(report, null, 2));
    else {
      console.log("SOVEREIGN ALZ — OFFLINE DEVELOPMENT READINESS");
      console.log("Source:       " + report.sourceCommit);
      console.log("Mode:         " + report.mode);
      console.log("Coding:       ALLOWED (including while live evidence is unavailable)");
      console.log("Local checks: " + report.localFeedback + " (self-reported; CI independently required)");
      for (const check of report.checks) console.log("  " + check.id.padEnd(26) + check.status);
      console.log("Release-only: " + report.releaseGates.length + " source-bound gates DEFERRED, NOT PASSED");
      console.log("PR merge:     NOT APPROVED; repository CI/checks still required");
      console.log("Production:   NOT APPROVED; real target evidence remains required");
      console.log("ACT:          DISABLED");
      console.log("Evidence SHA: " + report.developmentReportSha256);
    }
  } catch (error) {
    console.error("DEVELOPMENT_REPORT_REJECTED: " + (error instanceof Error ? error.message : "UNKNOWN"));
    process.exitCode = 2;
  }
}
