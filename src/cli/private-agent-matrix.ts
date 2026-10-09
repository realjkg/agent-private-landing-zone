import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";

import { PHASE_E_SCENARIOS } from "../qualification/phase-e.js";
import { runPrivateAgentMatrix } from "../qualification/private-agent-matrix.js";
import { parseMatrixCliArgs } from "../qualification/matrix-arguments.js";

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
  const sha = execFileSync("git", ["rev-parse", "--verify", "HEAD"], {
    encoding: "utf8",
  }).trim();
  const dirty = execFileSync("git", ["status", "--porcelain"], {
    encoding: "utf8",
  }).trim();
  if (dirty) throw new Error("SOURCE_WORKTREE_DIRTY");
  const mode = selection.mode;
  const result = await runPrivateAgentMatrix({
    sourceCommit: sha,
    mode,
    scenarios: selected,
    onProgress: (message) => console.log(message),
  });
  const dir = resolve(".runs", "qualification", "private-agent-matrix");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = resolve(dir, "matrix-" + randomUUID() + ".json");
  writeFileSync(path, JSON.stringify(result, null, 2) + "\n", {
    mode: 0o600, flag: "wx",
  });
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
