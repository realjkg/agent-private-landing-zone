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
import {
  parseBuildEngine,
} from "./build/engine.js";
import type {
  IaCEngine,
} from "./build/types.js";
import {
  formatAgentResponse,
} from "./session/query.js";
import {
  implementedPlugins,
} from "./plugins/validate.js";
import { rehearseDemoAct } from "./demo/lifecycle.js";

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

const pluginNames: Record<string, string> = {
  terraform: "Terraform",
  pulumi: "Pulumi",
  opentofu: "OpenTofu",
  tofu: "OpenTofu",
  bicep: "Bicep",
  cloudformation: "CloudFormation",
  cdk: "AWS CDK",
  crossplane: "Crossplane",
  ansible: "Ansible",
};

function buildSelection(
  value?: string,
): {
  plugin: string;
  engine: IaCEngine;
} {
  const key =
    (value ?? "terraform").toLowerCase();
  const plugin = pluginNames[key];

  if (!plugin) {
    throw new Error(
      "Use terraform, pulumi, opentofu, bicep, cloudformation, cdk, crossplane, or ansible.",
    );
  }

  return {
    plugin,
    engine:
      parseBuildEngine(key),
  };
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
const selection =
  buildSelection(
    valueAfter("--engine"),
  );
const selectedEngine =
  selection.engine;
const selectedScenario =
  scenario(valueAfter("--scenario"));
const request =
  valueAfter("--request") ??
  "Design the safest additive landing-zone delta using " +
  selection.plugin +
  ".";

console.log();
console.log("Agent Private Landing Zone");
console.log("────────────────────────────────");
console.log("GOVERNED OPERATOR DEMO");
console.log("────────────────────────────────");
console.log(
  "Scenario  " +
    selectedProvider +
    " / " +
    selectedScenario.toUpperCase(),
);
console.log(
  "Build path " + selection.plugin,
);
console.log(
  "Runtime   " +
    selectedEngine +
    " adapter",
);
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

if (state.design) {
  console.log();
  console.log("DesignSpec");
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
      state.design.designHash,
  );
}

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
  "Next boundary               " +
    (state.design?.plugin.buildEligible
      ? "BUILD PREVIEW"
      : "PLUGIN ADAPTER / DESIGN REVIEW"),
);
console.log(
  "ACT                         DISABLED",
);
console.log();

console.log("ACT DEMO — IN-MEMORY SIMULATION");
console.log("Scripted approvals and one synthetic canary; no live deployment or teardown.");
try {
  const rehearsal = rehearseDemoAct(state);
  console.log("Discover → Plan → Approve → Build → Verify → Approve cleanup → Destroy → Verify cleanup");
  console.log("Simulated build             " + rehearsal.built.phase);
  console.log("Simulated cleanup           " + (rehearsal.cleaned.cleanupVerified ? "VERIFIED" : "FAILED"));
  console.log("Existing baseline           PRESERVED");
  console.log("Demo resources remaining    " + rehearsal.cleaned.demoResourcesRemaining.length);
  console.log("Synthetic ACT evidence      " + JSON.stringify(rehearsal));
} catch (error) {
  console.log("Simulated ACT               BLOCKED");
  console.log(error instanceof Error ? error.message : "Demo lifecycle unavailable.");
}
console.log("Live infrastructure ACT     DISABLED");
