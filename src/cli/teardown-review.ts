import { readFileSync } from "node:fs";

import { normalizeBicepWhatIf } from "../iac/bicep-whatif.js";
import { normalizeCloudFormationChangeSet } from "../iac/cloudformation-changeset.js";
import { normalizePulumiPreview } from "../iac/pulumi-preview.js";
import { normalizeOpenTofuPlan, normalizeTerraformPlan } from "../iac/terraform-plan.js";
import { evaluateDestroyPreview } from "../teardown/gates.js";
import { evidenceAuthorityProblems, evidenceProblems } from "../teardown/driver/evidence.js";
import type { DeletionUnit } from "../teardown/types.js";

// Two read-only reviews for the operator console, which never runs the
// destroy-preview driver (docs/destroy-preview-driver.md) and keeps the word
// "destroy" out of every argument list it builds:
//   verdict  --unit UNIT.json --plan PLAN.json   same check as ./alz teardown destroy-preview
//   evidence --evidence EVIDENCE.json            validate and print what the driver wrote
// This file reads JSON files and prints. It runs no engine and calls no cloud.
// Importing the evidence validator is deliberate: it is a pure function, and the
// driver itself is neither imported nor started. ACT stays DISABLED.

const NORMALIZERS: Record<string, (json: string) => ReturnType<typeof normalizeTerraformPlan>> = {
  TERRAFORM: normalizeTerraformPlan,
  OPENTOFU: normalizeOpenTofuPlan,
  PULUMI: normalizePulumiPreview,
  CLOUDFORMATION: normalizeCloudFormationChangeSet,
  AWS_CDK: normalizeCloudFormationChangeSet,
  BICEP: normalizeBicepWhatIf,
};

function flag(args: string[], name: string): string {
  const index = args.indexOf("--" + name);
  const value = index < 0 ? undefined : args[index + 1];
  if (!value || value.startsWith("--")) throw new Error("TEARDOWN_ARGUMENT_REQUIRED: --" + name);
  return value;
}

function verdict(args: string[]): number {
  const unit = JSON.parse(readFileSync(flag(args, "unit"), "utf8")) as DeletionUnit;
  const normalize = NORMALIZERS[unit.engine];
  if (!normalize) throw new Error("TEARDOWN_PLAN_ENGINE_UNSUPPORTED: " + String(unit.engine));
  const preview = evaluateDestroyPreview(unit, normalize(readFileSync(flag(args, "plan"), "utf8")));
  console.log(JSON.stringify(preview, null, 2));
  return preview.verdict === "BLOCKED" ? 2 : 0;
}

/** Exit 2 (with reasons, never the offending values) unless the document is clean driver evidence. */
function evidence(args: string[]): number {
  const document: unknown = JSON.parse(readFileSync(flag(args, "evidence"), "utf8"));
  const problems = [...evidenceProblems(document), ...evidenceAuthorityProblems(document)];
  if (problems.length > 0) {
    console.log("EVIDENCE REJECTED: not redacted preview evidence. Do not paste raw plan or state output.");
    for (const problem of problems.slice(0, 20)) console.log("  " + problem.slice(0, 200));
    return 2;
  }
  console.log(JSON.stringify(document, null, 2));
  return 0;
}

try {
  const [command, ...rest] = process.argv.slice(2);
  if (command === "verdict") process.exitCode = verdict(rest);
  else if (command === "evidence") process.exitCode = evidence(rest);
  else throw new Error("TEARDOWN_COMMAND_UNKNOWN: " + String(command));
} catch (error) {
  console.error(error instanceof Error ? error.message.split("\n")[0] : "TEARDOWN_REVIEW_FAILED");
  process.exitCode = 1;
}
