import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { runPrivateSecurityAdversarialMatrix } from "../qualification/private-security-redteam.js";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === "--help") {
    console.log("ALZ isolated synthetic prompt-injection/privilege regression");
    console.log("node dist/cli/private-security-redteam.js");
    console.log("No real model, OpenAI API/account, cloud action or network connection.");
    return;
  }
  if (args.length) throw new Error("SECURITY_REDTEAM_NO_ARGUMENTS_ALLOWED");
  const sha = execFileSync("git", ["rev-parse", "--verify", "HEAD"], {
    encoding: "utf8",
  }).trim();
  const dirty = execFileSync("git", ["status", "--porcelain"], {
    encoding: "utf8",
  }).trim();
  if (dirty) throw new Error("SECURITY_REDTEAM_CLEAN_SOURCE_REQUIRED");
  const report = await runPrivateSecurityAdversarialMatrix(sha);
  const directory = resolve(".runs", "qualification", "private-security");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const name = randomUUID();
  const json = resolve(directory, "redteam-" + name + ".json");
  const csv = resolve(directory, "redteam-" + name + ".csv");
  const columns = ["id", "category", "expected", "observed", "result",
    "sourceCommit", "evidenceHash"] as const;
  const quote = (value: string) => '"' + value.replaceAll('"', '""') + '"';
  const csvData = [
    columns.join(","),
    ...report.cases.map((item) => columns.map((column) =>
      quote(String(item[column]))).join(",")),
  ].join("\n") + "\n";
  writeFileSync(json, JSON.stringify(report, null, 2) + "\n",
    { encoding: "utf8", mode: 0o600, flag: "wx" });
  writeFileSync(csv, csvData,
    { encoding: "utf8", mode: 0o600, flag: "wx" });
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
main().catch((error) => {
  console.error("SECURITY_REDTEAM_BLOCKED: " +
    (error instanceof Error ? error.message.slice(0, 150) : "UNKNOWN"));
  process.exitCode = 1;
});
