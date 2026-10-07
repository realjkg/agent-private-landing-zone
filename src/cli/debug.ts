import {
  randomUUID,
} from "node:crypto";

import {
  fixtureThinker,
} from "../agent/fixture.js";
import {
  runAgentKernel,
} from "../agent/graph.js";
import type {
  AgentState,
} from "../agent/types.js";
import {
  parseBuildEngine,
} from "../build/engine.js";
import {
  loadConfig,
} from "../config.js";
import type {
  MockScenario,
  Provider,
} from "../discovery/types.js";
import {
  buildDebugReport,
  modelInventoryEntry,
  writeDebugTrace,
  type DebugModelInventory,
} from "../debug/report.js";
import {
  classifyIntent,
} from "../agent/intent.js";
import {
  createOrchestrationPlan,
} from "../orchestration/plan.js";
import {
  getLocalModelMetadata,
} from "../ollama.js";
import {
  evaluateOperatorRequest,
} from "../session/operator-policy.js";

function readArg(
  name: string,
): string | undefined {
  const args =
    process.argv.slice(2);
  const index =
    args.indexOf(name);

  return index >= 0
    ? args[index + 1]
    : undefined;
}

function provider(
  value?: string,
): Provider {
  if (
    value?.toLowerCase() ===
    "azure"
  ) {
    return "AZURE";
  }

  return "AWS";
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

async function inventory(
  fixture: boolean,
): Promise<
  DebugModelInventory[]
> {
  if (fixture) {
    return [
      {
        role: "ROUTER",
        configuredModel:
          "deterministic-fixture",
        installed: true,
      },
      {
        role: "PRIMARY",
        configuredModel:
          "deterministic-fixture",
        installed: true,
      },
      {
        role: "VALIDATOR",
        configuredModel:
          "deterministic-fixture",
        installed: true,
      },
    ];
  }

  const cfg = loadConfig();
  const targets = [
    {
      role:
        "ROUTER" as const,
      model:
        cfg.routerModel,
    },
    {
      role:
        "PRIMARY" as const,
      model:
        cfg.primaryModel,
    },
    {
      role:
        "VALIDATOR" as const,
      model:
        cfg.validatorModel,
    },
  ];
  const settled =
    await Promise.allSettled(
      targets.map(
        (target) =>
          getLocalModelMetadata(
            cfg.ollamaBaseUrl,
            target.model,
          ),
      ),
    );

  return targets.map(
    (target, index) => {
      const result =
        settled[index];

      return modelInventoryEntry(
        target.role,
        target.model,
        result.status ===
          "fulfilled"
          ? result.value
          : result.reason instanceof
                Error
            ? result.reason
            : new Error(
                "model inventory failed",
              ),
      );
    },
  );
}

function blockedState(input: {
  request: string;
  provider: Provider;
  engine:
    ReturnType<
      typeof parseBuildEngine
    >;
  mock: MockScenario;
  reason: string;
}): AgentState {
  const requestId =
    randomUUID();
  const startedAt =
    new Date().toISOString();
  const intent =
    classifyIntent(
      input.request,
    );
  const orchestration =
    createOrchestrationPlan({
      taskId:
        "task:" + requestId,
      requestId,
      request:
        input.request,
      intent,
      provider:
        input.provider,
      engine: input.engine,
      evidenceRefs: [],
    });

  return {
    requestId,
    request:
      input.request,
    startedAt,
    completedAt:
      startedAt,
    durationMs: 0,
    phase: "BLOCKED",
    intent,
    provider:
      input.provider,
    engine: input.engine,
    orchestration,
    mock: input.mock,
    events: [
      {
        at: startedAt,
        phase: "BLOCKED",
        event:
          "DEBUG_POLICY_BLOCKED",
        detail: input.reason,
      },
    ],
    action: {
      attempted: false,
      executed: false,
      status: "BLOCKED",
      reason: input.reason,
    },
    observation: {
      verified: true,
      mutationObserved: false,
      evidence: [],
    },
  };
}

const args =
  process.argv.slice(2);
const selectedProvider =
  provider(
    readArg("--provider"),
  );
const selectedEngine =
  parseBuildEngine(
    readArg("--engine") ??
      "terraform",
  );
const selectedScenario =
  scenario(
    readArg("--mock"),
  );
const fixture =
  args.includes("--fixture");
const request =
  readArg("--request") ??
  "Review this simulated landing zone for the strongest operational risk.";

const policy =
  evaluateOperatorRequest(
    request,
    false,
  );
const models =
  await inventory(fixture);

let state: AgentState;

if (!policy.allowed) {
  state = blockedState({
    request,
    provider:
      selectedProvider,
    engine:
      selectedEngine,
    mock:
      selectedScenario,
    reason:
      policy.reason,
  });
} else {
  state =
    await runAgentKernel({
      request,
      provider:
        selectedProvider,
      engine:
        selectedEngine,
      mock:
        selectedScenario,
      thinker:
        fixture
          ? fixtureThinker
          : undefined,
      approveBuild: false,
    });
}

const report =
  buildDebugReport({
    state,
    policy,
    models,
  });
const path =
  writeDebugTrace(report);

console.log();
console.log(
  "Agent Private Landing Zone",
);
console.log(
  "DEVELOPER DEBUG · ACT DISABLED",
);
console.log(
  "────────────────────────────────",
);
console.log(
  "Run        " +
    report.runId,
);
console.log(
  "Phase      " +
    report.phase,
);
console.log(
  "Policy     " +
    (report.policy.allowed
      ? "ALLOW"
      : "BLOCKED " +
        (report.policy
          .boundary ??
          "")),
);
console.log(
  "Grounding  " +
    report.grounding.status +
    " / " +
    report.grounding
      .unsupportedClaimRisk,
);
console.log(
  "Validator  " +
    report.reasoning.validator,
);
console.log(
  "Act        DISABLED",
);
console.log(
  "Mutation   " +
    (report.action
      .mutationObserved
      ? "OBSERVED"
      : "not observed"),
);
console.log();

if (
  report.reasoning
    .modelInvocations.length >
  0
) {
  console.log(
    "Model calls",
  );

  for (
    const call of
    report.reasoning
      .modelInvocations
  ) {
    const model =
      report.models.find(
        (candidate) =>
          candidate
            .configuredModel ===
          call.model,
      );

    console.log(
      "  " +
        call.role.padEnd(12) +
        call.model +
        " · " +
        call.durationMs +
        " ms · schema " +
        (call.schemaValid
          ? "PASS"
          : "FAIL") +
        (model?.digest
          ? " · " +
            model.digest.slice(
              0,
              12,
            )
          : ""),
    );
  }

  console.log();
}

console.log(
  "Execution",
);
for (
  const event of
  report.execution
) {
  console.log(
    "  " +
      event.phase.padEnd(18) +
      event.event +
      (typeof event.durationMs ===
      "number"
        ? " · " +
          event.durationMs +
          " ms"
        : ""),
  );
}

if (report.failure) {
  console.log();
  console.log(
    "Failure    " +
      report.failure.category,
  );
  console.log(
    "  " +
      report.failure.message,
  );
}

console.log();
console.log(
  "Trace      " + path,
);
console.log(
  "No prompts, full model responses, credentials, or chain-of-thought are stored in the debug trace.",
);

if (!policy.allowed) {
  process.exitCode = 1;
}
