import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import { runOfflineCoverage } from "../qualification/full-offline-matrix.js";
import { assertCleanSource, blockedHandler, csvText, evidenceDir, headCommit, writeJsonOnce, writeTextOnce } from "../util/cli-support.js";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === "--help") {
    console.log("Sovereign ALZ — full AWS/Azure offline provider+engine matrix");
    console.log("node dist/cli/full-offline-matrix.js [no arguments]");
    console.log("Unsupported pairs N/A; private/kubernetes/edge PLAN_REQUIRED.");
    console.log("Every runnable scenario tests direct/conversational, chaos and pillars.");
    console.log("All cloud, model and actual CLI previews remain NOT_RUN.");
    return;
  }
  if (args.length !== 0) throw new Error("OFFLINE_MATRIX_ARGUMENTS_NOT_ALLOWED");
  const sha = headCommit();
  assertCleanSource();
  const report = await runOfflineCoverage({
    sourceCommit: sha,
    onProgress: (id) => console.log("SCENARIO " + id),
  });
  const folder = evidenceDir("qualification", "full-offline-matrix");
  const suffix = randomUUID();
  const json = resolve(folder, "matrix-" + suffix + ".json");
  const csv = resolve(folder, "matrix-" + suffix + ".csv");
  const columns = [
    "id", "caseId", "gate", "expected", "observed", "status",
    "evidenceMode", "sourceCommit", "evidenceHash", "pillarPosture", "rowHash",
  ] as const;
  writeJsonOnce(json, report);
  writeTextOnce(csv, csvText(columns, report.rows));
  console.log("Cases=" + report.count.cases +
    " | offline passes=" + report.count.offlineVerified +
    " | failed=" + report.count.failed +
    " | N/A provider pairs=" + report.count.notApplicable +
    " | future PLAN=" + report.count.planRequired);
  console.log("Source=" + sha + " / SHA256=" + report.evidenceHash);
  console.log("Trace CSV=" + csv);
  console.log("Trace JSON=" + json);
  console.log("Actual private models, provider previews, physical restore: NOT_RUN");
  console.log("Infrastructure ACT: DISABLED");
  if (!report.passed) process.exitCode = 1;
}

main().catch(blockedHandler("OFFLINE_MATRIX_BLOCKED:", 180));
