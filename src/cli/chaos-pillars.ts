import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { fixtureThinker } from "../agent/fixture.js";
import { runAgentKernel } from "../agent/graph.js";
import { runChaosPillarQualification } from "../qualification/chaos-pillars.js";
import { assertCleanSource, blockedHandler, evidenceDir, headCommit, writeJsonOnce } from "../util/cli-support.js";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length > 0 && !(args.length === 1 && args[0] === "--help")) {
    throw new Error("CHAOS_ACCEPTS_NO_CLOUD_OR_MUTATION_ARGUMENTS");
  }
  if (args[0] === "--help") {
    console.log("ALZ safe chaos simulations: ./alz chaos");
    console.log("Injects 11 synthetic recovery/operational/pillar failures in memory.");
    console.log("Never restarts cloud services, alters backups, or performs real restore.");
    return;
  }
  const sourceCommit = headCommit();
  assertCleanSource();
  const state = await runAgentKernel({
    request: "Build a governed AWS brownfield landing zone using Terraform.",
    provider: "AWS", engine: "TERRAFORM", mock: "brownfield",
    thinker: fixtureThinker, approveBuild: false,
  });
  const report = runChaosPillarQualification({ state, sourceCommit });
  const out = resolve(evidenceDir("qualification", "chaos-pillars"), "chaos-" + randomUUID() + ".json");
  writeJsonOnce(out, report);
  console.log("Safe ALZ chaos/pillars (synthetic fault injection)");
  for (const item of report.faults) {
    console.log(item.pillar + " / " + item.fault + ": " + item.outcome);
  }
  console.log("Source commit: " + sourceCommit);
  console.log("Recovery verification: " + report.recoveryVerification);
  console.log("Evidence: " + out);
  console.log("Restore: NOT RUN; cloud changes: NONE; ACT: DISABLED");
  if (!report.passed) process.exitCode = 1;
}
main().catch(blockedHandler("CHAOS_BLOCKED: ", 180));
