import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import {
  runPrivateModelAdversarialQualification, type AdversarialScope,
} from "../qualification/private-model-adversarial.js";
import { assertCleanSource, blockedHandler, csvText, evidenceDir, headCommit, writeJsonOnce, writeTextOnce } from "../util/cli-support.js";

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
  const sha = headCommit();
  if (process.env.GITHUB_SHA && process.env.GITHUB_SHA !== sha) {
    throw new Error("PRIVATE_ADVERSARIAL_CHECKOUT_SHA_MISMATCH");
  }
  assertCleanSource("PRIVATE_ADVERSARIAL_CLEAN_SOURCE_REQUIRED");

  const report = await runPrivateModelAdversarialQualification({
    sourceCommit: sha, scope: args[1] as AdversarialScope,
    targetHardwareId: process.env.ALZ_TARGET_HARDWARE_ID ?? "UNKNOWN",
    runnerName: process.env.RUNNER_NAME ?? "UNKNOWN",
    baseUrl: process.env.OLLAMA_BASE_URL ?? "INVALID",
  });
  const folder = evidenceDir("qualification", "private-model-adversarial");
  const id = randomUUID();
  const path = resolve(folder, "private-adversarial-" + id + ".json");
  const csv = resolve(folder, "private-adversarial-" + id + ".csv");
  writeJsonOnce(path, report);
  const cols = [
    "id", "model", "modelDigest", "expected", "observed",
    "gate", "baseline", "baselineEvidenceHash", "attackHash",
    "modelOutputHash", "errorCode", "evidenceHash",
  ] as const;
  writeTextOnce(csv, csvText(cols, report.results));
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
main().catch(blockedHandler("PRIVATE_MODEL_ADVERSARIAL_BLOCKED: ", 180));
