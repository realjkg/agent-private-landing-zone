import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { createPrivateDirectory } from "../tools/private-workdir.js";
import { OPERATIONS } from "./registry.js";
import { assertSafeArgv, validateInputs } from "./schema.js";
import type { OperationSpec, OperatorJob, Values } from "./types.js";

export type OperationPlan = { spec: OperationSpec; values: Values };

/**
 * Resolve and validate a request. Throws a stable code: UNSUPPORTED_OPERATION,
 * OPERATION_HANDOFF_ONLY, INPUTS_NOT_JSON or an INPUT_* refusal.
 */
export function planOperation(
  id: string,
  inputsText: string | null,
  catalog: readonly OperationSpec[] = OPERATIONS,
): OperationPlan {
  const spec = catalog.find((item) => item.id === id);
  if (!spec) throw new Error("UNSUPPORTED_OPERATION");
  // A handoff is shown, never run: the console has no way to start one.
  if (spec.safety === "HANDOFF" || !spec.job) throw new Error("OPERATION_HANDOFF_ONLY");
  let raw: unknown = {};
  if (inputsText) {
    try {
      raw = JSON.parse(inputsText);
    } catch {
      throw new Error("INPUTS_NOT_JSON");
    }
  }
  const checked = validateInputs(spec.inputs, raw);
  if (!checked.ok) throw new Error(checked.error);
  return { spec, values: checked.values };
}

/**
 * Run a planned operation. Pasted JSON is written by this process, never by
 * the browser, to a private 0700 directory that is removed when the run
 * settles; the job receives only the file path.
 */
export async function runPlanned(
  plan: OperationPlan,
  root: string,
  runner: (job: OperatorJob, root: string) => Promise<string>,
): Promise<string> {
  const { spec } = plan;
  const files = spec.inputs.filter((field) => field.kind === "json" && typeof plan.values[field.name] === "string");
  const directory = files.length > 0 ? createPrivateDirectory("alz-op-") : undefined;
  try {
    const values: Record<string, string | boolean | undefined> = { ...plan.values };
    for (const field of files) {
      const path = join(directory!.path, field.name + ".json");
      writeFileSync(path, JSON.stringify(JSON.parse(String(values[field.name]))), { mode: 0o600 });
      values[field.name] = path;
    }
    const args = spec.job!.args(values);
    assertSafeArgv(args, directory?.path);
    return await runner({
      mode: spec.id,
      script: spec.job!.script,
      args,
      title: spec.title,
      evidenceBasis: spec.evidenceBasis,
      ...(spec.job!.reportsRecoveryVerification ? { reportsRecoveryVerification: true } : {}),
      ...(spec.safety === "WRITES_LOCAL" ? { writesLocal: true } : {}),
    }, root);
  } finally {
    directory?.remove();
  }
}
