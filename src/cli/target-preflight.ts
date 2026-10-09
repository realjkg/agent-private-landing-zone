import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { probeTargetPreflight } from "../qualification/target-preflight.js";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === "--help") {
    console.log("ALZ private target preflight: no model inference or cloud operation.");
    console.log("Usage: target-preflight --target-hardware-id ID --output PATH");
    console.log("Requires RUNNER_NAME, GITHUB_SHA and OLLAMA_BASE_URL on target host.");
    return;
  }
  const get = (key: string): string | undefined => {
    const i = args.indexOf(key);
    return i >= 0 ? args[i + 1] : undefined;
  };
  if (args.length !== 4 || !get("--target-hardware-id") ||
      !get("--output") ||
      args.some((item, i) => i % 2 === 0 &&
        !["--target-hardware-id", "--output"].includes(item))) {
    throw new Error("PREFLIGHT_ARGUMENTS_INVALID");
  }
  const sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim();
  if (process.env.GITHUB_SHA && process.env.GITHUB_SHA !== sourceCommit) {
    throw new Error("PREFLIGHT_CHECKOUT_SHA_MISMATCH");
  }
  const report = await probeTargetPreflight({
    sourceCommit,
    targetHardwareId: get("--target-hardware-id")!,
    runnerName: process.env.RUNNER_NAME ?? "UNKNOWN",
    baseUrl: process.env.OLLAMA_BASE_URL ?? "INVALID",
    skipLocalModel: process.env.AGENT_SKIP_LOCAL_MODEL === "1",
  });
  const filename = resolve(get("--output")!);
  mkdirSync(dirname(filename), { recursive: true, mode: 0o700 });
  writeFileSync(filename, JSON.stringify(report, null, 2) + "\n", {
    mode: 0o600,
  });
  for (const row of report.checks) {
    console.log((row.passed ? "PASS " : "BLOCKED ") + row.id +
      " — " + row.detail);
  }
  console.log("Private model metadata preflight: " +
    (report.passed ? "PASS" : "BLOCKED") + " | " + filename);
  console.log("Actual inference, cloud/provider preview: NOT_RUN; ACT DISABLED");
  if (!report.passed) process.exitCode = 1;
}
main().catch((error) => {
  console.error("PREFLIGHT_BLOCKED: " +
    (error instanceof Error ? error.message.slice(0, 150) : "UNKNOWN"));
  process.exitCode = 1;
});
