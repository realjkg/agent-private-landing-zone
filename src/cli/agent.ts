import { runAgentKernel } from "../agent/graph.js";
import type { IaCEngine } from "../build/types.js";
import type {
  MockScenario,
  Provider,
} from "../discovery/types.js";

function readArg(name: string): string | undefined {
  const args = process.argv.slice(2);
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function parseProvider(value?: string): Provider {
  if (value?.toLowerCase() === "aws") return "AWS";
  if (value?.toLowerCase() === "azure") return "AZURE";
  throw new Error(
    "Use --provider aws or --provider azure.",
  );
}

function parseEngine(value?: string): IaCEngine {
  if (value?.toLowerCase() === "terraform") {
    return "TERRAFORM";
  }

  if (value?.toLowerCase() === "pulumi") {
    return "PULUMI";
  }

  throw new Error(
    "Use --engine terraform or --engine pulumi.",
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

const request =
  readArg("--request") ??
  "Review this environment and assess the strongest operational risk.";

console.log();
console.log("Agentic Landing Zone");
console.log("────────────────────────────────");
console.log();
console.log("AGENT KERNEL · ACT DISABLED");
console.log();

const state = await runAgentKernel({
  request,
  provider: parseProvider(readArg("--provider")),
  engine: parseEngine(readArg("--engine")),
  mock: parseMock(readArg("--mock")),
  approveBuild:
    process.argv.includes("--approve"),
});

console.log(`Intent          ${state.intent}`);
console.log(`Phase           ${state.phase}`);
console.log(
  `Environment     ${state.environment?.classification ?? "UNKNOWN"}`,
);
console.log(
  `Safe build mode ${state.environment?.safeBuildMode ?? "UNKNOWN"}`,
);
console.log();

if (state.plan) {
  console.log("Plan");
  console.log(
    `  ${state.plan.steps.join(" → ")}`,
  );

  for (const reason of state.plan.reasons) {
    console.log(`  • ${reason}`);
  }

  console.log();
}

if (state.engineeringAssessment) {
  console.log("Engineering view");
  console.log(
    `  ${state.engineeringAssessment.topRisk}`,
  );
  console.log();
}

if (state.build) {
  console.log("Build");
  console.log(
    `  ${state.build.candidate.artifact.engine} / ${state.build.gate.allowed ? "GATE PASSED" : "GATE STOPPED"}`,
  );
  console.log();
}

console.log("Act");
console.log(
  `  ${state.action?.status ?? "NOT_REQUIRED"}`,
);
console.log(
  `  ${state.action?.reason ?? "No action result."}`,
);
console.log();

console.log("Observe");
console.log(
  `  mutationObserved=${state.observation?.mutationObserved ?? false}`,
);
console.log(
  `  verified=${state.observation?.verified ?? false}`,
);

if (state.error) {
  console.log();
  console.log(`Error  ${state.error}`);
}
