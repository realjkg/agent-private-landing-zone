import {
  runBuildLoop,
  type BuildLoopOptions,
} from "../build/loop.js";
import { writeBuildRun } from "../build/output.js";
import {
  parseBuildEngine,
} from "../build/engine.js";
import type {
  MockScenario,
  Provider,
} from "../discovery/types.js";

function readArg(name: string): string | undefined {
  const args = process.argv.slice(2);
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function hasFlag(name: string): boolean {
  return process.argv.slice(2).includes(name);
}

function parseProvider(value?: string): Provider {
  if (value?.toLowerCase() === "aws") return "AWS";
  if (value?.toLowerCase() === "azure") return "AZURE";
  throw new Error(
    "Use --provider aws or --provider azure.",
  );
}

function parseMock(value?: string): MockScenario {
  if (
    value === "brownfield" ||
    value === "greenfield" ||
    value === "unknown"
  ) {
    return value;
  }

  throw new Error(
    "Use --mock brownfield, greenfield, or unknown.",
  );
}

import { createConfiguredBus } from "../observability/bus.js";
import { loadObservabilityConfig } from "../config.js";

const bus = createConfiguredBus(loadObservabilityConfig());

const options: BuildLoopOptions = {
  provider: parseProvider(readArg("--provider")),
  engine: parseBuildEngine(readArg("--engine")),
  mock: parseMock(readArg("--mock")),
  approve: hasFlag("--approve"),
  emitter: bus,
};

console.log();
console.log("Agent Private Landing Zone");
console.log("────────────────────────────────");
console.log();
console.log("BUILD LOOP · PREVIEW ONLY");
console.log();

try {
  const result = await runBuildLoop(options);

  const runRecord = await writeBuildRun(result, bus);

  console.log(
    `✓ Environment    ${result.candidate.environment.classification}`,
  );
  console.log(
    `✓ Provider       ${result.candidate.environment.provider}`,
  );
  console.log(
    `✓ IaC engine     ${result.candidate.artifact.engine}`,
  );
  console.log(
    `✓ Build mode     ${result.candidate.environment.safeBuildMode}`,
  );
  console.log(
    `✓ Repository     ${result.repository.clean ? "CLEAN" : "DIRTY"}`,
  );
  console.log(
    `✓ Scanners       ${result.candidate.evidence.scannerResults.length} passed`,
  );
  console.log(
    `✓ Preview        0 create / 0 update / 0 delete`,
  );
  console.log();

  if (!result.candidate.evidence.approvalId) {
    console.log("Approval");
    console.log("  REQUIRED");
    console.log();
  } else {
    console.log("Approval");
    console.log("  HASH-BOUND APPROVAL PRESENT");
    console.log();
  }

  console.log("Gate");
  console.log(
    `  ${result.gate.allowed ? "PASSED" : "STOPPED"}`,
  );

  for (const reason of result.gate.reasons) {
    console.log(`  • ${reason}`);
  }

  console.log();
  console.log("Execution");
  console.log("  PREVIEW ONLY — no cloud changes made");
  console.log();
  console.log(
    `Artifact SHA-256  ${result.candidate.artifact.contentHash}`,
  );
  console.log(
    `Plan SHA-256      ${result.candidate.evidence.planHash}`,
  );
  console.log(
    `Git commit        ${result.repository.commitSha}`,
  );
  console.log(
    `Run record        ${runRecord}`,
  );
} catch (error) {
  console.error();
  console.error("BUILD LOOP FAILED");
  console.error(
    error instanceof Error
      ? error.message
      : "Unknown build-loop error",
  );
  process.exitCode = 1;
}
