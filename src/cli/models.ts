import {
  mkdirSync,
  writeFileSync,
} from "node:fs";
import {
  resolve,
} from "node:path";
import {
  pathToFileURL,
} from "node:url";

import {
  loadConfig,
} from "../config.js";
import {
  MODEL_CATALOG,
  requiredModels,
  type ModelDefinition,
} from "../models/catalog.js";
import {
  qualifyModel,
} from "../models/qualification.js";
import {
  qualifyDefaultModelStack,
} from "../models/stack-qualification.js";
import {
  loadModelDigestPins,
  verifyPinnedModel,
  type ModelDigestPins,
} from "../models/digest-pins.js";
import {
  collectProductionQualificationContext,
  qualifyProductionModelRuntime,
} from "../qualification/model-production.js";
import {
  PROMPT_POLICY_VERSION,
  promptPolicyHash,
} from "../security/prompt-governance.js";


export type ModelTargetOutcome = {
  passed: boolean;
  record: Record<string, unknown>;
  lines: string[];
};

/**
 * One model of `./alz models verify`: its installed digest is checked against the committed release pin first, and a
 * model that is unpinned, different or missing is never qualified. `qualify` is a test seam; production uses qualifyModel.
 */
export async function verifyModelTarget(
  baseUrl: string,
  target: ModelDefinition,
  pins: ModelDigestPins | Error,
  qualify: typeof qualifyModel = qualifyModel,
): Promise<ModelTargetOutcome> {
  const lines: string[] = [];
  let passed = true;
  let record: Record<string, unknown> = {};

  try {
    if (pins instanceof Error) {
      throw pins;
    }
    const { metadata, check } =
      await verifyPinnedModel(
        baseUrl,
        target.model,
        pins,
      );

    if (!check.ok) {
      passed = false;
      lines.push(
        "FAIL " +
          target.model +
          " — " +
          check.code +
          ": " +
          check.message,
      );
      record = {
        model: target.model,
        role: target.role,
        required:
          target.required,
        digest:
          metadata.digest,
        pinnedDigest:
          check.pinned ?? null,
        digestCheck:
          check.code,
        policyVersion:
          PROMPT_POLICY_VERSION,
        policyHash:
          promptPolicyHash(),
        passed: false,
        error:
          check.code +
          ": " +
          check.message,
      };
      return { passed, record, lines };
    }

    const result =
      await qualify(
        baseUrl,
        target.model,
      );

    lines.push(
      (result.passed
        ? "PASS "
        : "FAIL ") +
        target.model +
        " " +
        metadata.digest.slice(
          0,
          12,
        ),
    );

    for (
      const item of
      result.checks
    ) {
      lines.push(
        "  " +
          (item.passed
            ? "✓ "
            : "✗ ") +
          item.name +
          (item.passed
            ? ""
            : " — " +
              item.detail),
      );
    }

    record = {
      model: target.model,
      role: target.role,
      required:
        target.required,
      digest:
        metadata.digest,
      pinnedDigest:
        check.digest,
      digestCheck: "PINNED",
      size:
        metadata.size,
      modifiedAt:
        metadata.modifiedAt,
      policyVersion:
        result.policyVersion,
      policyHash:
        result.policyHash,
      passed:
        result.passed,
      checks:
        result.checks,
    };

    if (!result.passed) {
      passed = false;
    }
  } catch (error) {
    passed = false;
    const detail =
      error instanceof Error
        ? error.message
        : "qualification failed";

    lines.push(
      "FAIL " +
        target.model +
        " — " +
        detail,
    );

    record = {
      model: target.model,
      role: target.role,
      required:
        target.required,
      policyVersion:
        PROMPT_POLICY_VERSION,
      policyHash:
        promptPolicyHash(),
      passed: false,
      error: detail,
    };
  }

  return { passed, record, lines };
}

async function main(): Promise<void> {
  const args =
    process.argv.slice(2);
  const command =
    args[0] ?? "list";
  const includeAll =
    args.includes("--all");
  const production =
    args.includes("--production");
  const modelIndex =
    args.indexOf("--model");
  const selectedModel =
    modelIndex >= 0
      ? args[modelIndex + 1]
      : undefined;

  function printCatalog(): void {
    console.log();
    console.log(
      "Agent Private Landing Zone",
    );
    console.log(
      "PRIVATE MODEL CATALOG",
    );
    console.log();

    for (
      const item of
      MODEL_CATALOG
    ) {
      console.log(
        (item.required ? "*" : " ") +
          " " +
          item.model.padEnd(24) +
          item.role.padEnd(11) +
          item.notes,
      );
    }

    console.log();
    console.log(
      "* required for the default local reasoning stack",
    );
  }

  if (command === "list") {
    printCatalog();
  } else if (
    command === "verify"
  ) {
    const cfg = loadConfig();
    const targets =
      selectedModel
        ? MODEL_CATALOG.filter(
            (item) =>
              item.model ===
              selectedModel,
          )
        : includeAll
          ? MODEL_CATALOG
          : requiredModels();

    if (targets.length === 0) {
      throw new Error(
        "Unknown model. Run ./alz models list.",
      );
    }

    const targetNames =
      new Set(
        targets.map(
          (target) => target.model,
        ),
      );
    const requiredNames =
      requiredModels().map(
        (target) => target.model,
      );
    const hasDefaultStack =
      requiredNames.every(
        (model) =>
          targetNames.has(model),
      );

    if (
      production &&
      !hasDefaultStack
    ) {
      throw new Error(
        "--production requires the complete default Qwen/Mistral stack.",
      );
    }

    console.log();
    console.log(
      production
        ? "Private model PRODUCTION qualification"
        : "Private model qualification",
    );
    console.log(
      "Ollama " +
        cfg.ollamaBaseUrl,
    );
    console.log(
      "Prompt policy " +
        PROMPT_POLICY_VERSION +
        " " +
        promptPolicyHash().slice(
          0,
          16,
        ) +
        "…",
    );
    console.log();

    let failed = false;
    const records: unknown[] = [];

    // Exact versions first: a model whose installed digest is not its committed pin is never qualified.
    let pins: ModelDigestPins | undefined;
    let pinsError = "";
    try {
      pins = loadModelDigestPins();
    } catch (error) {
      pinsError =
        error instanceof Error
          ? error.message
          : "MODEL_PINS_INVALID";
    }

    for (
      const target of targets
    ) {
      const outcome =
        await verifyModelTarget(
          cfg.ollamaBaseUrl,
          target,
          pins ?? new Error(pinsError),
        );

      for (const line of outcome.lines) {
        console.log(line);
      }

      records.push(outcome.record);

      if (!outcome.passed) {
        failed = true;
      }
    }

    let stackChecks:
      Awaited<
        ReturnType<
          typeof qualifyDefaultModelStack
        >
      > = [];

    if (hasDefaultStack) {
      console.log();
      console.log(
        "Default stack integration",
      );

      stackChecks =
        await qualifyDefaultModelStack();

      for (
        const item of
        stackChecks
      ) {
        console.log(
          "  " +
            (item.passed
              ? "✓ "
              : "✗ ") +
            item.name +
            (item.passed
              ? ""
              : " — " +
                item.detail),
        );

        if (!item.passed) {
          failed = true;
        }
      }
    }

    let productionQualification:
      Awaited<
        ReturnType<
          typeof qualifyProductionModelRuntime
        >
      > | undefined;

    if (production) {
      console.log();
      console.log(
        "Production target behavior",
      );

      productionQualification =
        await qualifyProductionModelRuntime(
          collectProductionQualificationContext(
            cfg.ollamaBaseUrl,
          ),
        );

      console.log(
        "  target " +
          productionQualification
            .context.host
            .targetHardwareId,
      );
      console.log(
        "  host   " +
          productionQualification
            .context.host
            .platform +
          "/" +
          productionQualification
            .context.host.arch +
          " · " +
          productionQualification
            .context.host
            .cpuCount +
          " CPU · " +
          Math.round(
            productionQualification
              .context.host
              .totalMemoryBytes /
              1024 ** 3,
          ) +
          " GiB",
      );
      console.log(
        "  runner " +
          productionQualification
            .context.host
            .runnerName +
          " / " +
          productionQualification
            .context.host
            .hostname,
      );
      console.log(
        "  hostid " +
          productionQualification
            .context.host
            .hostIdentityHash
            .slice(0, 16) +
          "…",
      );
      console.log(
        "  source " +
          productionQualification
            .context.sourceCommit,
      );

      for (
        const item of
        productionQualification.checks
      ) {
        console.log(
          "  " +
            (item.passed
              ? "✓ "
              : "✗ ") +
            item.name +
            (item.passed
              ? ""
              : " — " +
                item.detail),
        );
      }

      if (
        !productionQualification.passed
      ) {
        failed = true;
      }
    }

    const evidence = {
      generatedAt:
        new Date().toISOString(),
      ollamaBaseUrl:
        cfg.ollamaBaseUrl,
      policyVersion:
        PROMPT_POLICY_VERSION,
      policyHash:
        promptPolicyHash(),
      records,
      stackChecks,
      production:
        productionQualification,
      passed: !failed,
    };

    const directory = resolve(
      ".runs",
      "model-qualification",
    );
    mkdirSync(
      directory,
      {
        recursive: true,
        mode: 0o700,
      },
    );

    const filename =
      new Date()
        .toISOString()
        .replace(/[:.]/g, "-") +
      ".json";
    const output =
      resolve(
        directory,
        filename,
      );

    writeFileSync(
      output,
      JSON.stringify(
        evidence,
        null,
        2,
      ) + "\n",
      {
        encoding: "utf8",
        mode: 0o600,
      },
    );

    console.log();
    console.log(
      "Evidence " + output,
    );

    if (failed) {
      process.exitCode = 1;
    }
  } else {
    throw new Error(
      "Use ./alz models list or ./alz models verify [--production] [--all] [--model MODEL].",
    );
  }
}

if (
  process.argv[1] &&
  import.meta.url ===
    pathToFileURL(
      resolve(process.argv[1]),
    ).href
) {
  await main();
}
