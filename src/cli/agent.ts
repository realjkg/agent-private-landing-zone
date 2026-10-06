import { fixtureThinker } from "../agent/fixture.js";
import { runAgentKernel } from "../agent/graph.js";
import {
  phaseDurations,
  writeAgentRun,
} from "../agent/output.js";
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

const args = process.argv.slice(2);
const request =
  readArg("--request") ??
  "Review this environment and assess the strongest operational risk.";
const fixture = args.includes("--fixture");
const verbose = args.includes("--verbose");

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
  thinker: fixture ? fixtureThinker : undefined,
  approveBuild: args.includes("--approve"),
});

const runRecord = await writeAgentRun(state);

console.log("Intent          " + state.intent);
console.log("Phase           " + state.phase);
console.log(
  "Environment     " +
    (state.environment?.classification ?? "UNKNOWN"),
);
console.log(
  "Safe build mode " +
    (state.environment?.safeBuildMode ?? "UNKNOWN"),
);
console.log();

if (state.postureAssessment) {
  console.log("Posture");
  console.log(
    "  Security   " +
      state.postureAssessment.securityStatus,
  );
  console.log(
    "  SBOM       " +
      state.postureAssessment.sbom.status +
      " / " +
      state.postureAssessment.sbom.componentCount +
      " components",
  );
  console.log(
    "  Resiliency " +
      state.postureAssessment.resiliency.status +
      " / restore " +
      state.postureAssessment.resiliency.restoreEvidence,
  );
  console.log(
    "  Recovery   " +
      state.postureAssessment.recoverySnapshot.configurationHash.slice(
        0,
        16,
      ) +
      "…",
  );
  console.log();
}

if (state.deltaAssessment) {
  console.log("Delta");
  console.log(
    "  Decisions  " +
      state.deltaAssessment.decisions.length,
  );
  console.log(
    "  Blockers   " +
      state.deltaAssessment.blockers.length,
  );
  console.log(
    "  Design     " +
      (state.deltaAssessment.designRequired
        ? "REQUIRED"
        : "NOT_REQUIRED"),
  );
  console.log();
}

if (state.design) {
  console.log("Design");
  console.log(
    "  Status     " +
      state.design.status,
  );
  console.log(
    "  Plug-in    " +
      state.design.plugin.plugin +
      " / " +
      state.design.plugin.status,
  );
  console.log(
    "  Evidence   " +
      state.design.plugin.evidencePath,
  );
  console.log(
    "  SHA-256    " +
      state.design.designHash.slice(0, 16) +
      "…",
  );
  console.log();
}

if (state.plan) {
  console.log("Plan");
  console.log(
    "  " + state.plan.steps.join(" → "),
  );

  for (const reason of state.plan.reasons) {
    console.log("  • " + reason);
  }

  console.log();
}

if (state.engineeringAssessment) {
  console.log("Engineering view");
  console.log(
    "  " + state.engineeringAssessment.topRisk,
  );
  console.log();
}

if (state.build) {
  console.log("Build");
  console.log(
    "  " +
      state.build.candidate.artifact.engine +
      " · " +
      (state.build.gate.allowed
        ? "GATE PASSED"
        : "GATE STOPPED"),
  );
  console.log(
    "  Artifact " +
      state.build.candidate.artifact.contentHash.slice(0, 16) +
      "…",
  );
  console.log();
}

console.log("Act");
console.log(
  "  " + (state.action?.status ?? "NOT_REQUIRED"),
);
console.log(
  "  " +
    (state.action?.reason ?? "No action result."),
);
console.log();

console.log("Observe");
console.log(
  "  mutationObserved=" +
    (state.observation?.mutationObserved ?? false),
);
console.log(
  "  verified=" +
    (state.observation?.verified ?? false),
);
console.log();

console.log("Observability");
for (const timing of phaseDurations(state)) {
  console.log(
    "  " +
      timing.phase.padEnd(18) +
      " " +
      timing.durationMs +
      " ms",
  );
}
console.log(
  "  TOTAL              " +
    (state.durationMs ?? 0) +
    " ms",
);
console.log();

console.log("Request ID  " + state.requestId);
console.log("Run record  " + runRecord);

if (state.error) {
  console.log();
  console.log("Error       " + state.error);
}

if (verbose) {
  console.log();
  console.log("────────────────────────────────");
  console.log("Execution trace");
  console.log();

  for (const event of state.events) {
    const duration =
      typeof event.durationMs === "number"
        ? " · " + event.durationMs + " ms"
        : "";

    console.log(
      event.at +
        "  " +
        event.phase.padEnd(18) +
        " " +
        event.event +
        duration,
    );

    if (event.detail) {
      console.log("  " + event.detail);
    }
  }
}
