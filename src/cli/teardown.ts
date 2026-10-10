import { readFileSync } from "node:fs";

import type { DiscoveredResource, Provider } from "../discovery/types.js";
import { normalizeOpenTofuPlan, normalizeTerraformPlan } from "../iac/terraform-plan.js";
import {
  checkCreateTraceability,
  evaluateDestroyPreview,
  readTerraformPlanTags,
  reportOrphans,
} from "../teardown/gates.js";
import type { DeletionUnit, DeletionUnitStateRef } from "../teardown/types.js";
import { recordDeletionUnit } from "../teardown/unit.js";

// Read-only teardown traceability (docs/teardown-traceability.md). Every
// subcommand reads JSON files and prints a verdict: nothing here runs an
// engine, calls a cloud, or deletes anything. ACT stays DISABLED.

const USAGE = [
  "ALZ traceable teardown (read-only; plans are produced by your own engine run)",
  "  ./alz teardown record --build-id ID --provider AWS|AZURE --state STATE.json",
  "      --design-hash SHA256 --plan CREATE_PLAN.json [--engine TERRAFORM|OPENTOFU]",
  "      [--expires YYYY-MM-DD]                 record the build's deletion unit",
  "  ./alz teardown check-plan --unit UNIT.json --plan CREATE_PLAN.json",
  "                                             creates == unit, every create tagged",
  "  ./alz teardown destroy-preview --unit UNIT.json --plan DESTROY_PLAN.json",
  "                                             deletes only what the unit created",
  "  ./alz teardown orphans --units A.json[,B.json] --resources RESOURCES.json",
  "                                             ALZ-tagged resources no unit accounts for",
  "Plans are `terraform show -json` / `tofu show -json` output.",
  "Exit 0: traceable / ready / nothing to do. Exit 2: BLOCKED or orphans found.",
].join("\n");

function options(args: string[]): Map<string, string> {
  const result = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (!key?.startsWith("--") || value === undefined || value.startsWith("--")) {
      throw new Error("TEARDOWN_ARGUMENT_INVALID: " + (key ?? ""));
    }
    result.set(key.slice(2), value);
  }
  return result;
}

function required(values: Map<string, string>, name: string): string {
  const value = values.get(name);
  if (!value) throw new Error("TEARDOWN_ARGUMENT_REQUIRED: --" + name);
  return value;
}

const readJson = <T>(path: string): T => JSON.parse(readFileSync(path, "utf8")) as T;

function planFor(engine: string, json: string) {
  if (engine === "TERRAFORM") return normalizeTerraformPlan(json);
  if (engine === "OPENTOFU") return normalizeOpenTofuPlan(json);
  throw new Error("TEARDOWN_PLAN_ENGINE_UNSUPPORTED: " + engine +
    " (this CLI reads Terraform/OpenTofu plans; the library covers every unit engine)");
}

function main(argv: string[]): number {
  const [command, ...rest] = argv;
  if (!command || command === "--help" || command === "help") {
    console.log(USAGE);
    return 0;
  }
  const values = options(rest);
  if (command === "record") {
    const engine = values.get("engine") ?? "TERRAFORM";
    const provider = required(values, "provider");
    if (provider !== "AWS" && provider !== "AZURE") {
      throw new Error("TEARDOWN_PROVIDER_INVALID: " + provider);
    }
    const unit = recordDeletionUnit({
      buildId: required(values, "build-id"),
      provider: provider as Provider,
      stateRef: readJson<DeletionUnitStateRef>(required(values, "state")),
      designHash: required(values, "design-hash"),
      createPlan: planFor(engine, readFileSync(required(values, "plan"), "utf8")),
      expires: values.get("expires"),
    });
    console.log(JSON.stringify(unit, null, 2));
    return 0;
  }
  if (command === "check-plan") {
    const unit = readJson<DeletionUnit>(required(values, "unit"));
    const json = readFileSync(required(values, "plan"), "utf8");
    const report = checkCreateTraceability(unit, planFor(unit.engine, json),
      readTerraformPlanTags(json));
    console.log(JSON.stringify(report, null, 2));
    return report.verdict === "TRACEABLE" ? 0 : 2;
  }
  if (command === "destroy-preview") {
    const unit = readJson<DeletionUnit>(required(values, "unit"));
    const preview = evaluateDestroyPreview(unit,
      planFor(unit.engine, readFileSync(required(values, "plan"), "utf8")));
    console.log(JSON.stringify(preview, null, 2));
    return preview.verdict === "BLOCKED" ? 2 : 0;
  }
  if (command === "orphans") {
    const units = required(values, "units").split(",").map((path) => readJson<DeletionUnit>(path));
    const report = reportOrphans(readJson<DiscoveredResource[]>(required(values, "resources")), units);
    console.log(JSON.stringify(report, null, 2));
    return report.orphans === 0 ? 0 : 2;
  }
  throw new Error("TEARDOWN_COMMAND_UNKNOWN: " + command);
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  console.error("Run ./alz teardown --help for usage.");
  process.exitCode = 1;
}
