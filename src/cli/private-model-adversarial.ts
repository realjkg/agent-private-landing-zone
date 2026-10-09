import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  runPrivateModelAdversarialQualification, type AdversarialScope,
} from "../qualification/private-model-adversarial.js";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === "--help") {
    console.log("Local private Qwen/Mistral adversarial qualification (no cloud/tool execution)");
    console.log("Usage: node dist/cli/private-model-adversarial.js --scope first|all");
    console.log("Requires ALZ_TARGET_HARDWARE_ID, RUNNER_NAME, OLLAMA_BASE_URL (HTTP loopback)");
    console.log("No OpenAI API, cloud credentials, provider write, ACT or model downloads.");
    return;
  }
  if (args.length !== 2 || args[0] !== "--scope" ||
      (args[1] !== "first" && args[1] !== "all")) {
    throw new Error("PRIVATE_ADVERSARIAL_SCOPE_FIRST_OR_ALL_REQUIRED");
  }
  if (process.env.AGENT_SKIP_LOCAL_MODEL === "1") {
    throw new Error("PRIVATE_ADVERSARIAL_FIXTURE_MODEL_FORBIDDEN");
  }
  const sha = execFileSync("git", ["rev-parse", "--verify", "HEAD"], {
    encoding: "utf8",
  }).trim();
  if (process.env.GITHUB_SHA && process.env.GITHUB_SHA !== sha) {
    throw new Error("PRIVATE_ADVERSARIAL_CHECKOUT_SHA_MISMATCH");
  }
  if (execFileSync("git", ["status", "--porcelain"], {
    encoding: "utf8",
  }).trim()) throw new Error("PRIVATE_ADVERSARIAL_CLEAN_SOURCE_REQUIRED");

  const report = await runPrivateModelAdversarialQualification({
    sourceCommit: sha, scope: args[1] as AdversarialScope,
    targetHardwareId: process.env.ALZ_TARGET_HARDWARE_ID ?? "UNKNOWN",
    runnerName: process.env.RUNNER_NAME ?? "UNKNOWN",
    baseUrl: process.env.OLLAMA_BASE_URL ?? "INVALID",
  });
  const folder = resolve(".runs", "qualification", "private-model-adversarial");
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  const id = randomUUID();
  const path = resolve(folder, "private-adversarial-" + id + ".json");
  const csv = resolve(folder, "private-adversarial-" + id + ".csv");
  writeFileSync(path, JSON.stringify(report, null, 2) + "\n",
    { encoding: "utf8", mode: 0o600, flag: "wx" });
  const cols = [
    "id", "model", "modelDigest", "expected", "observed",
    "gate", "baseline", "baselineEvidenceHash", "attackHash",
    "modelOutputHash", "errorCode", "evidenceHash",
  ] as const;
  const quote = (value: string) => '"' + value.replaceAll('"', '""') + '"';
  writeFileSync(csv, [
    cols.join(","),
    ...report.results.map((result) =>
      cols.map((key) => quote(String(result[key] ?? ""))).join(",")),
  ].join("\n") + "\n", { encoding: "utf8", mode: 0o600, flag: "wx" });
  for (const result of report.results) {
    console.log(result.gate + " " + result.model + " " + result.id +
      " / observed=" + result.observed + " / deterministic=" + result.baseline);
  }
  console.log("Source: " + sha + " | evidence: " + report.evidenceHash);
  console.log("Model calls: " + report.recordedCalls + "/" + report.plannedCalls);
  console.log("Results JSON: " + path);
  console.log("Results CSV: " + csv);
  console.log("No actual provider read/write or external lease issuer; ACT DISABLED");
  if (!report.passed) process.exitCode = 1;
}
main().catch((error) => {
  console.error("PRIVATE_MODEL_ADVERSARIAL_BLOCKED: " +
    (error instanceof Error ? error.message.slice(0, 180) : "UNKNOWN"));
  process.exitCode = 1;
});
