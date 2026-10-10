import { readFileSync } from "node:fs";

import type { DiscoveredResource, Provider } from "../discovery/types.js";
import { normalizeBicepWhatIf } from "../iac/bicep-whatif.js";
import { normalizeCloudFormationChangeSet } from "../iac/cloudformation-changeset.js";
import { normalizePulumiPreview } from "../iac/pulumi-preview.js";
import { normalizeOpenTofuPlan, normalizeTerraformPlan } from "../iac/terraform-plan.js";
import {
  checkCreateTraceability,
  evaluateDestroyPreview,
  readTerraformPlanTags,
  reportOrphans,
} from "../teardown/gates.js";
import {
  parseAwsTaggedResources,
  parseAzureTaggedResources,
  readBicepWhatIfTags,
  readCloudFormationChangeSetTags,
  readPulumiPreviewTags,
  type TagReaderOptions,
  type TaggedInventory,
} from "../teardown/readers.js";
import type { DeletionUnit, DeletionUnitStateRef, PlannedTags } from "../teardown/types.js";
import { recordDeletionUnit } from "../teardown/unit.js";

// Read-only teardown traceability (docs/teardown-traceability.md). Every
// subcommand reads JSON files and prints a verdict: nothing here runs an
// engine, calls a cloud, or deletes anything. ACT stays DISABLED.

const USAGE = [
  "ALZ traceable teardown (read-only; plans are produced by your own engine run)",
  "  ./alz teardown record --build-id ID --provider AWS|AZURE --state STATE.json",
  "      --design-hash SHA256 --plan CREATE_PLAN.json [--engine ENGINE]",
  "      [--expires YYYY-MM-DD]                 record the build's deletion unit",
  "  ./alz teardown check-plan --unit UNIT.json --plan CREATE_PLAN.json",
  "      [--untaggable-types TYPE,TYPE]         creates == unit, every create tagged",
  "  ./alz teardown destroy-preview --unit UNIT.json --plan DESTROY_PLAN.json",
  "                                             deletes only what the unit created",
  "  ./alz teardown orphans --units A.json[,B.json]",
  "      (--resources RESOURCES.json | --aws-tagged GET_RESOURCES.json | --azure-tagged RESOURCE_LIST.json)",
  "                                             ALZ-tagged resources no unit accounts for",
  "ENGINE: TERRAFORM (default) | OPENTOFU | PULUMI | CLOUDFORMATION | BICEP. Plans are:",
  "  Terraform/OpenTofu: `terraform|tofu show -json PLAN`",
  "  Pulumi:             `pulumi preview --json` (destroy: `--destroy --json`)",
  "  CloudFormation:     `aws cloudformation describe-change-set` of a change set created with",
  "                      --include-property-values (without it tags are NOT REPORTED, so BLOCKED)",
  "  Bicep:              `az deployment <scope> what-if --no-pretty-print`",
  "--untaggable-types is a reviewed allowlist of resource types with no tags (Pulumi type token,",
  "  CloudFormation ResourceType, Azure resource type). Terraform plans need none.",
  "Inventories: `aws resourcegroupstaggingapi get-resources` / `az resource list` output.",
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
  if (engine === "PULUMI") return normalizePulumiPreview(json);
  if (engine === "CLOUDFORMATION") return normalizeCloudFormationChangeSet(json);
  if (engine === "BICEP") return normalizeBicepWhatIf(json);
  throw new Error("TEARDOWN_PLAN_ENGINE_UNSUPPORTED: " + engine +
    " (AWS_CDK, Crossplane and Ansible have no plan reader here)");
}

function tagsFor(engine: string, json: string, options: TagReaderOptions): Map<string, PlannedTags> {
  if (engine === "TERRAFORM" || engine === "OPENTOFU") return readTerraformPlanTags(json);
  if (engine === "PULUMI") return readPulumiPreviewTags(json, options);
  if (engine === "CLOUDFORMATION") return readCloudFormationChangeSetTags(json, options);
  if (engine === "BICEP") return readBicepWhatIfTags(json, options);
  throw new Error("TEARDOWN_PLAN_ENGINE_UNSUPPORTED: " + engine);
}

function inventoryFor(values: Map<string, string>): TaggedInventory {
  const sources = (["resources", "aws-tagged", "azure-tagged"] as const)
    .filter((name) => values.has(name));
  if (sources.length !== 1) {
    throw new Error("TEARDOWN_ARGUMENT_REQUIRED: exactly one of --resources, --aws-tagged, --azure-tagged");
  }
  const path = values.get(sources[0])!;
  if (sources[0] === "aws-tagged") return parseAwsTaggedResources(readFileSync(path, "utf8"));
  if (sources[0] === "azure-tagged") return parseAzureTaggedResources(readFileSync(path, "utf8"));
  return { resources: readJson<DiscoveredResource[]>(path), complete: true };
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
    const untaggable = values.get("untaggable-types");
    const report = checkCreateTraceability(unit, planFor(unit.engine, json),
      tagsFor(unit.engine, json, {
        untaggableTypes: untaggable ? new Set(untaggable.split(",").filter(Boolean)) : undefined,
      }));
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
    const inventory = inventoryFor(values);
    const report = reportOrphans(inventory.resources, units);
    // A paginated listing cannot prove there are no orphans, so it never exits clean.
    console.log(JSON.stringify({ inventoryComplete: inventory.complete, ...report }, null, 2));
    return report.orphans === 0 && inventory.complete ? 0 : 2;
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
