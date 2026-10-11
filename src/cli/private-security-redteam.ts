import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import { runPrivateSecurityAdversarialMatrix } from "../qualification/private-security-redteam.js";
import { assertCleanSource, blockedHandler, csvText, evidenceDir, headCommit, writeJsonOnce, writeTextOnce } from "../util/cli-support.js";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === "--help") {
    console.log("ALZ isolated synthetic prompt-injection/privilege regression");
    console.log("node dist/cli/private-security-redteam.js");
    console.log("No real model, OpenAI API/account, cloud action or network connection.");
    return;
  }
  if (args.length) throw new Error("SECURITY_REDTEAM_NO_ARGUMENTS_ALLOWED");
  const sha = headCommit();
  assertCleanSource("SECURITY_REDTEAM_CLEAN_SOURCE_REQUIRED");
  const report = await runPrivateSecurityAdversarialMatrix(sha);
  const directory = evidenceDir("qualification", "private-security");
  const name = randomUUID();
  const json = resolve(directory, "redteam-" + name + ".json");
  const csv = resolve(directory, "redteam-" + name + ".csv");
  const columns = ["id", "category", "expected", "observed", "result",
    "sourceCommit", "evidenceHash"] as const;
  writeJsonOnce(json, report);
  writeTextOnce(csv, csvText(columns, report.cases));
  for (const item of report.cases) {
    console.log(item.result + " " + item.id + " / " + item.observed);
  }
  console.log("Cases: " + report.totals.cases +
    " | PASS: " + report.totals.passed + " | FAILED: " +
    report.totals.failed);
  console.log("Source: " + report.sourceCommit);
  console.log("JSON: " + json + " | CSV: " + csv);
  console.log("External calls=0; real model/cloud/lease issuer: NOT_RUN");
  if (!report.passed) process.exitCode = 1;
}
main().catch(blockedHandler("SECURITY_REDTEAM_BLOCKED: ", 150));
