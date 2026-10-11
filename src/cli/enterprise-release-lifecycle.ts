import { planReleaseLifecycle, validateReleaseLifecyclePlan } from "../release/lifecycle.js";
import { option, reason, runReport } from "../enterprise/report.js";

// ./alz enterprise release-lifecycle --target-version V --target-config-schema N
//   [--current-version V] [--previous-version V] [--current-config-schema N] [--uninstall-version V]
// Shows the ordered install, upgrade, config migration, rollback and uninstall
// steps for the release files on this machine. It plans only: no step is run,
// and every step is verified for integrity with infrastructure ACT disabled.
const number = (args: string[], name: string): number | undefined => {
  const value = option(args, name);
  if (value === undefined) return undefined;
  if (!/^\d{1,6}$/.test(value)) throw new Error("RELEASE_NUMBER_INVALID: --" + name);
  return Number(value);
};

await runReport((args) => {
  const targetVersion = option(args, "target-version");
  const targetConfigSchema = number(args, "target-config-schema");
  if (!targetVersion || targetConfigSchema === undefined) throw new Error("RELEASE_TARGET_REQUIRED");
  let plan;
  try {
    plan = planReleaseLifecycle({
      targetVersion, targetConfigSchema, currentVersion: option(args, "current-version"),
      previousVersion: option(args, "previous-version"), currentConfigSchema: number(args, "current-config-schema"),
      uninstallVersion: option(args, "uninstall-version"),
    });
  } catch (error) {
    return { ok: false, lines: ["RELEASE LIFECYCLE REFUSED: " + reason(error)] };
  }
  const blockers = validateReleaseLifecyclePlan(plan);
  return { ok: blockers.length === 0, lines: [
    blockers.length === 0 ? "RELEASE LIFECYCLE PLAN (release files only; cloud changes not allowed)" : "RELEASE LIFECYCLE BLOCKED",
    ...plan.steps.map((step, index) => (index + 1) + ". " + step.operation + " " +
      [step.fromVersion, step.toVersion].filter(Boolean).join(" -> ") +
      (step.fromConfigSchema === undefined ? "" : " schema " + step.fromConfigSchema + " -> " + step.toConfigSchema) +
      (step.requiresBackup ? " [backup first]" : "") + " [verify integrity]"),
    ...(plan.steps.length === 0 ? ["No step needed: the target is already installed."] : []),
    ...blockers, "Planned only. Nothing was installed, changed or removed.",
  ] };
});
