import {
  fixtureThinker,
} from "./agent/fixture.js";
import {
  runAgentKernel,
} from "./agent/graph.js";
import type {
  MockScenario,
  Provider,
} from "./discovery/types.js";
import type {
  IaCEngine,
} from "./build/types.js";
import {
  formatAgentResponse,
} from "./session/query.js";
import {
  implementedPlugins,
} from "./plugins/validate.js";

function valueAfter(
  name: string,
): string | undefined {
  const args = process.argv.slice(2);
  const index = args.indexOf(name);
  return index >= 0
    ? args[index + 1]
    : undefined;
}

function provider(
  value?: string,
): Provider {
  return value?.toLowerCase() === "azure"
    ? "AZURE"
    : "AWS";
}

function engine(
  value?: string,
): IaCEngine {
  return value?.toLowerCase() === "pulumi"
    ? "PULUMI"
    : "TERRAFORM";
}

function scenario(
  value?: string,
): MockScenario {
  if (
    value === "greenfield" ||
    value === "unknown"
  ) {
    return value;
  }

  return "brownfield";
}

const selectedProvider =
  provider(valueAfter("--provider"));
const selectedEngine =
  engine(valueAfter("--engine"));
const selectedScenario =
  scenario(valueAfter("--scenario"));
const request =
  valueAfter("--request") ??
  "Assess this landing zone, identify the strongest risk, and tell me what should be designed next.";

console.log();
console.log("Agentic Landing Zone");
console.log("────────────────────────────────");
console.log("GOVERNED OPERATOR DEMO");
console.log("────────────────────────────────");
console.log(
  "Scenario  " +
    selectedProvider +
    " / " +
    selectedScenario.toUpperCase(),
);
console.log("IaC       " + selectedEngine);
console.log(
  "Mode      deterministic fixture; no cloud mutation",
);
console.log();

const state = await runAgentKernel({
  request,
  provider: selectedProvider,
  engine: selectedEngine,
  mock: selectedScenario,
  thinker: fixtureThinker,
  progress: (message) => {
    console.log("› " + message);
  },
});

console.log();
console.log(formatAgentResponse(state));

if (state.deltaAssessment) {
  console.log();
  console.log("Delta decisions");
  for (
    const decision of
    state.deltaAssessment.decisions
  ) {
    console.log(
      "  " +
        decision.action.padEnd(10) +
        decision.resourceType +
        " · " +
        decision.reason,
    );
  }
}

console.log();
console.log(
  "Implemented build adapters  " +
    implementedPlugins()
      .map((plugin) => plugin.id)
      .join(", "),
);
console.log(
  "Next boundary               DESIGN",
);
console.log(
  "ACT                         DISABLED",
);
console.log();
