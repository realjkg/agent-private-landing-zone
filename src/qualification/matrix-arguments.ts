export type MatrixCliSelection = {
  mode: "OFFLINE_FIXTURE" | "LIVE_PRIVATE_MODELS";
  scenarioId?: string;
};

/** Strict operator argument parser: never discard unrecognized flags or missing values. */
export function parseMatrixCliArgs(
  args: readonly string[],
  knownScenarioIds: readonly string[],
): MatrixCliSelection {
  let mode: MatrixCliSelection["mode"] | undefined;
  let scenarioId: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--offline-fixture" || arg === "--live-models") {
      if (mode) throw new Error("MATRIX_MODE_DUPLICATE_OR_CONFLICTING");
      mode = arg === "--offline-fixture" ? "OFFLINE_FIXTURE" : "LIVE_PRIVATE_MODELS";
    } else if (arg === "--scenario") {
      if (scenarioId) throw new Error("MATRIX_SCENARIO_DUPLICATE");
      const candidate = args[++index];
      if (!candidate || candidate.startsWith("-")) {
        throw new Error("MATRIX_SCENARIO_VALUE_REQUIRED");
      }
      if (!knownScenarioIds.includes(candidate)) {
        throw new Error("UNKNOWN_MATRIX_SCENARIO");
      }
      scenarioId = candidate;
    } else {
      throw new Error("UNKNOWN_MATRIX_ARGUMENT");
    }
  }
  if (!mode) throw new Error("MATRIX_MODE_REQUIRED");
  return { mode, ...(scenarioId ? { scenarioId } : {}) };
}
