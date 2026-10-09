import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fixtureThinker } from "../agent/fixture.js";
import { runAgentKernel } from "../agent/graph.js";
import { runChaosPillarQualification } from "../qualification/chaos-pillars.js";

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
  const sourceCommit = execFileSync("git", ["rev-parse", "--verify", "HEAD"],
    { encoding: "utf8" }).trim();
  const dirty = execFileSync("git", ["status", "--porcelain"],
    { encoding: "utf8" }).trim();
  if (dirty) throw new Error("SOURCE_WORKTREE_DIRTY");
  const state = await runAgentKernel({
    request: "Build a governed AWS brownfield landing zone using Terraform.",
    provider: "AWS", engine: "TERRAFORM", mock: "brownfield",
    thinker: fixtureThinker, approveBuild: false,
  });
  const report = runChaosPillarQualification({ state, sourceCommit });
  const dir = resolve(".runs", "qualification", "chaos-pillars");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const out = resolve(dir, "chaos-" + randomUUID() + ".json");
  writeFileSync(out, JSON.stringify(report, null, 2) + "\n",
    { mode: 0o600, flag: "wx" });
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
main().catch((error) => {
  console.error("CHAOS_BLOCKED: " +
    (error instanceof Error ? error.message.slice(0, 180) : "UNKNOWN"));
  process.exitCode = 1;
});
