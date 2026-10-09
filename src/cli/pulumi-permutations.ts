import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { runPulumiPermutations } from "../qualification/pulumi-permutations.js";

function csvField(value: string): string {
  return '"' + value.replaceAll('"', '""') + '"';
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === "--help") {
    console.log("ALZ Pulumi traceable pre-live matrix");
    console.log("Run: node dist/cli/pulumi-permutations.js");
    console.log("Crosses Pulumi advertised providers with greenfield, brownfield, unknown.");
    console.log("AWS/Azure fixture and fault tests run; PRIVATE/K8s require PLAN.");
    console.log("Produces JSON and CSV traceability; does not invoke Pulumi CLI or cloud.");
    return;
  }
  if (args.length !== 0) throw new Error("PULUMI_PRELIVE_NO_FLAGS");
  const sourceCommit = execFileSync("git", ["rev-parse", "--verify", "HEAD"],
    { encoding: "utf8" }).trim();
  if (execFileSync("git", ["status", "--porcelain"],
    { encoding: "utf8" }).trim()) {
    throw new Error("SOURCE_WORKTREE_DIRTY");
  }
  const report = await runPulumiPermutations({
    sourceCommit,
    onProgress: (message) => console.log(message),
  });
  const folder = resolve(".runs", "qualification", "pulumi-permutations");
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  const id = randomUUID();
  const json = resolve(folder, "pulumi-" + id + ".json");
  const csv = resolve(folder, "pulumi-" + id + ".csv");
  const columns = [
    "id", "provider", "estate", "gate", "dimension", "phase",
    "expected", "observed", "status", "evidenceMode",
    "sourceCommit", "sourceTest", "observationHash", "pillarPosture",
    "reason", "rowHash",
  ] as const;
  const csvLines = [
    columns.join(","),
    ...report.traceRows.map((row) => columns.map((column) =>
      csvField(String(row[column] ?? ""))).join(",")),
  ];
  writeFileSync(json, JSON.stringify(report, null, 2) + "\n",
    { mode: 0o600, flag: "wx" });
  writeFileSync(csv, csvLines.join("\n") + "\n",
    { mode: 0o600, flag: "wx" });
  for (const item of report.cases) {
    console.log(item.id + ": " + item.disposition +
      " | direct=" + item.direct + " | conversation=" + item.conversational +
      " | synthetic-chaos=" + item.chaos);
  }
  console.log("Traceability: " + report.traceRowCount + " rows; " +
    report.tracePassed + " verified offline, " +
    report.traceFailed + " failed, " +
    report.traceUnverified + " live NOT_RUN, " +
    report.tracePlanRequired + " PLAN_REQUIRED");
  console.log("JSON evidence: " + json);
  console.log("CSV matrix: " + csv);
  console.log("Source commit: " + sourceCommit + " / evidence sha256: " + report.evidenceHash);
  console.log("Private models, actual Pulumi CLI/provider previews and cloud: NOT_RUN");
  console.log("ACT: DISABLED");
  if (!report.passed) process.exitCode = 1;
}

main().catch((error) => {
  const code = error instanceof Error ? error.message : "UNKNOWN";
  console.error("PULUMI_PRELIVE_BLOCKED: " + code.slice(0, 180));
  console.error("No model inference or infrastructure mutation occurred.");
  process.exitCode = 1;
});
