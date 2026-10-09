import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { runPreliveCampaign } from "../qualification/prelive-campaign.js";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === "--help") {
    console.log([
      "Sovereign ALZ — pre-live functional, chaos, cost and pillar campaign",
      "Run: node dist/cli/prelive-campaign.js",
      "Runs only deterministic fixtures: 8 supported workflows, UNKNOWN ownership,",
      "provider compatibility and applicable simulated recovery/pillar faults.",
      "No cloud credentials, local models, Terraform plan, mutation or actual restore.",
      "Evidence under .runs/qualification/prelive-campaign.",
    ].join("\n"));
    return;
  }
  if (args.length) throw new Error("PRELIVE_ACCEPTS_NO_ADDITIONAL_ARGUMENTS");
  const sourceCommit = execFileSync("git", ["rev-parse", "--verify", "HEAD"],
    { encoding: "utf8" }).trim();
  if (execFileSync("git", ["status", "--porcelain"],
    { encoding: "utf8" }).trim()) {
    throw new Error("SOURCE_WORKTREE_DIRTY");
  }
  const report = await runPreliveCampaign({
    sourceCommit, onProgress: (msg) => console.log(msg),
  });
  const folder = resolve(".runs", "qualification", "prelive-campaign");
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  const file = resolve(folder, "prelive-" + randomUUID() + ".json");
  writeFileSync(file, JSON.stringify(report, null, 2) + "\n",
    { mode: 0o600, flag: "wx" });
  for (const item of report.results) {
    console.log(
      item.id + ": baseline=" + item.baseline +
      " unknown=" + item.unknownOwnership +
      " incompatible=" + item.alternateProvider.result +
      " chaos=" + item.chaosStatus +
      " applicable=" + item.applicableFaults +
      " n/a=" + item.notApplicableFaults,
    );
  }
  console.log("Evidence: " + file);
  console.log("Source commit: " + sourceCommit);
  console.log("Elapsed locally (not cloud benchmark): " + report.overallElapsedMs + " ms");
  console.log("Private models, cloud plans, real recovery: NOT RUN");
  console.log("ACT: DISABLED / status: " + report.outcome);
  if (!report.passed) process.exitCode = 1;
}

main().catch((error) => {
  const code = error instanceof Error ? error.message : "UNKNOWN";
  console.error("PRELIVE_BLOCKED: " + code.slice(0, 180));
  console.error("No cloud changes or model inference were attempted.");
  process.exitCode = 1;
});
