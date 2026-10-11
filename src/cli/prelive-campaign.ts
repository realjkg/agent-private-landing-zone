import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import { runPreliveCampaign } from "../qualification/prelive-campaign.js";
import { assertCleanSource, blockedHandler, evidenceDir, headCommit, writeJsonOnce } from "../util/cli-support.js";

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
  const sourceCommit = headCommit();
  assertCleanSource();
  const report = await runPreliveCampaign({
    sourceCommit, onProgress: (msg) => console.log(msg),
  });
  const file = resolve(evidenceDir("qualification", "prelive-campaign"), "prelive-" + randomUUID() + ".json");
  writeJsonOnce(file, report);
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

main().catch(blockedHandler("PRELIVE_BLOCKED: ", 180,
  "No cloud changes or model inference were attempted."));
