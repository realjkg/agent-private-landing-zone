import { resolve } from "node:path";
import { randomUUID } from "node:crypto";

import { PHASE_E_SCENARIOS } from "../qualification/phase-e.js";
import { runPrivateAgentMatrix } from "../qualification/private-agent-matrix.js";
import { parseMatrixCliArgs } from "../qualification/matrix-arguments.js";
import { assertCleanSource, evidenceDir, headCommit, writeJsonOnce } from "../util/cli-support.js";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length === 0 || (args.length === 1 && args[0] === "--help")) {
    console.log([
      "Sovereign ALZ — existing 8-scenario functional matrix",
      "Run: ./alz matrix --offline-fixture (tests deterministic workflows; no models)",
      "Run: ./alz matrix --live-models (requires installed local Qwen/Mistral; each scenario executes model calls)",
      "Optional: --scenario <exact scenario ID>; default is ALL eight existing scenarios",
      "LIVE mode uses synthetic discovery and fixture-generated IaC; actual model inference only.",
      "No AWS/Azure mutations, no external model providers, no apply.",
      "Evidence written under .runs/qualification/private-agent-matrix/.",
    ].join("\n"));
    if (!args.includes("--help")) process.exitCode = 2;
    return;
  }
  const selection = parseMatrixCliArgs(
    args, PHASE_E_SCENARIOS.map((scenario) => scenario.id),
  );
  const selected = selection.scenarioId
    ? PHASE_E_SCENARIOS.filter((scenario) => scenario.id === selection.scenarioId)
    : PHASE_E_SCENARIOS;
  const sha = headCommit();
  assertCleanSource();
  const mode = selection.mode;
  const result = await runPrivateAgentMatrix({
    sourceCommit: sha,
    mode,
    scenarios: selected,
    onProgress: (message) => console.log(message),
  });
  const path = resolve(evidenceDir("qualification", "private-agent-matrix"), "matrix-" + randomUUID() + ".json");
  writeJsonOnce(path, result);
  for (const lane of result.results) {
    console.log(lane.id + ": " +
      (lane.converged ? "PARITY PASS" : "BLOCKED / DIVERGED") +
      " | direct=" + lane.direct.status +
      " | conversation=" + lane.conversational.status);
  }
  console.log("Source commit: " + sha);
  console.log("Evidence: " + path);
  console.log("Mode: " + mode + " / ACT DISABLED");
  console.log("Model-authored IaC: NOT QUALIFIED; fixture preview only.");
  if (!result.passed) process.exitCode = 1;
}

main().catch((error) => {
  const value = error instanceof Error ? error.message : "UNEXPECTED_ERROR";
  console.error("MATRIX_BLOCKED: " + value.slice(0, 180));
  console.error("No infrastructure apply was attempted.");
  process.exitCode = 1;
});
