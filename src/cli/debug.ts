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
  modelInventoryEntry,
  writeDebugTrace,
  type DebugModelInventory,
} from "../debug/report.js";
import {
  runDebugDiagnostic,
} from "../debug/run.js";
import {
  sanitizeDiagnosticText,
} from "../observability/redaction.js";
import {
  getLocalModelMetadata,
} from "../ollama.js";

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
  return value?.toLowerCase() ===
    "azure"
    ? "AZURE"
    : "AWS";
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

function sanitizedStack(
  error: Error,
): string[] {
  if (
    process.env
      .ALZ_DEBUG_SOURCE !==
      "1" ||
    !error.stack
  ) {
    return [];
  }

  return error.stack
    .split("\n")
    .slice(0, 12)
    .map((line) =>
      sanitizeDiagnosticText(
        line,
        320,
      ),
    );
}

async function main(): Promise<void> {
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
  const models =
    await inventory(fixture);
  const report =
    await runDebugDiagnostic({
      request,
      provider:
        selectedProvider,
      engine:
        selectedEngine,
      mock:
        selectedScenario,
      fixture,
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
    "Knowledge  " +
      report.knowledge.state,
  );
  console.log(
    "Grounding  " +
      report.grounding.status +
      " / " +
      report.grounding
        .unsupportedClaimRisk,
  );
  console.log(
    "Schema     " +
      report.reasoning.schema
        .status +
      " · retries " +
      report.reasoning.schema
        .retryCount +
      " · " +
      report.reasoning.schema
        .fallback,
  );
  console.log(
    "Validator  " +
      report.reasoning.validator,
  );
  console.log(
    "Checkpoint " +
      report.checkpoint.status +
      (report.checkpoint
        .threadId
        ? " · " +
          report.checkpoint
            .threadId
        : ""),
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
          " ms · schema PASS" +
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

  const policyAndTool =
    report.diagnostics.filter(
      (event) =>
        event.kind ===
          "POLICY" ||
        event.kind ===
          "TOOL" ||
        event.kind ===
          "ADAPTER" ||
        event.kind ===
          "CHECKPOINT",
    );

  if (
    policyAndTool.length > 0
  ) {
    console.log(
      "Diagnostics",
    );

    for (
      const event of
      policyAndTool
    ) {
      console.log(
        "  " +
          event.kind.padEnd(10) +
          event.component +
          " · " +
          event.status +
          (typeof event.durationMs ===
          "number"
            ? " · " +
              event.durationMs +
              " ms"
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
  if (
    report.checkpoint
      .relativePath
  ) {
    console.log(
      "Checkpoint " +
        report.checkpoint
          .relativePath,
    );
  }
  console.log(
    "No prompts, full model responses, credentials, or chain-of-thought are stored in the debug trace.",
  );

  if (!report.policy.allowed) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  const normalized =
    error instanceof Error
      ? error
      : new Error(
          "Unknown debug runtime failure",
        );

  console.error();
  console.error(
    sanitizeDiagnosticText(
      normalized.message,
    ),
  );

  const stack =
    sanitizedStack(
      normalized,
    );

  if (stack.length > 0) {
    console.error();
    console.error(
      "Sanitized local TypeScript stack:",
    );
    for (const line of stack) {
      console.error(
        "  " + line,
      );
    }
  }

  process.exitCode = 1;
});
