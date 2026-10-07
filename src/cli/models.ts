import {
  loadConfig,
} from "../config.js";
import {
  MODEL_CATALOG,
  requiredModels,
} from "../models/catalog.js";
import {
  qualifyModel,
} from "../models/qualification.js";

const args =
  process.argv.slice(2);
const command =
  args[0] ?? "list";
const includeAll =
  args.includes("--all");
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

  console.log();
  console.log(
    "Private model qualification",
  );
  console.log(
    "Ollama " +
      cfg.ollamaBaseUrl,
  );
  console.log();

  let failed = false;

  for (
    const target of targets
  ) {
    const result =
      await qualifyModel(
        cfg.ollamaBaseUrl,
        target.model,
      );

    console.log(
      (result.passed
        ? "PASS "
        : "FAIL ") +
        target.model,
    );

    for (
      const item of
      result.checks
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

    if (!result.passed) {
      failed = true;
    }
  }

  if (failed) {
    process.exitCode = 1;
  }
} else {
  throw new Error(
    "Use ./alz models list or ./alz models verify [--all] [--model MODEL].",
  );
}
