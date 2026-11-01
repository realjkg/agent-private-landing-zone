import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import type { ActualCostBaselineValidation, ActualPrivateBuildValidation } from "./private-model.js";
import { sha256 } from "./provenance.js";
import { normalizeTerraformPlan } from "../iac/terraform-plan.js";
import type { ChangeSet } from "../iac/changeset.js";
import { readTerraformPlanTags } from "../teardown/gates.js";

/**
 * The trusted host's Terraform preview driver for `src/cli/real-private-build.ts`, moved here unchanged so both approved
 * scenarios run the one execution path: `init -backend=false`, `fmt -check`, `validate -json`,
 * `plan -refresh=false -lock=false -out` and `show -json`, in a fresh run folder, never `apply`, `destroy` or `import`.
 * The first scenario (the log group) keeps its exact single-create check; the cost baseline requires a create-only plan
 * and reports every created address, which `src/build/private-model.ts` compares with the rendered set.
 *
 * The cost baseline pins hashicorp/aws, so its run folder starts with the reviewed lock
 * (`qualification/aws/act-dev1-canary/.terraform.lock.hcl`): `init` then installs only a package whose hash the lock
 * names. The driver is human-invoked and outside the broker (docs/runner-hardening.md); this module adds no authority.
 */

export type TerraformPreviewOptions = {
  /** The child environment. Default: the caller's, as the driver always ran. `TF_IN_AUTOMATION=1` is always set. */
  env?: NodeJS.ProcessEnv;
  /** The engine program. Default `terraform`, found on PATH. */
  terraform?: string;
};

function tool(args: string[], cwd: string, options: TerraformPreviewOptions): string {
  const executed = spawnSync(options.terraform ?? "terraform", args, {
    cwd, encoding: "utf8", shell: false,
    timeout: 120_000,
    maxBuffer: 4_000_000,
    env: { ...(options.env ?? process.env), TF_IN_AUTOMATION: "1" },
  });
  if (executed.error || executed.status !== 0) {
    throw new Error("ACTUAL_TERRAFORM_TOOL_FAILURE:" + args[0]);
  }
  return executed.stdout ?? "";
}

type PreviewRun = { version: string; validation: string; rawPlan: string; normalized: ChangeSet; lockFile: string };

/** The shared steps. `folder` is a new, empty run folder; `main.tf` (and the lock, when given) are written exclusively. */
function runTerraformPreview(folder: string, hcl: string, lock: string | undefined, options: TerraformPreviewOptions): PreviewRun {
  writeFileSync(resolve(folder, "main.tf"), hcl, { encoding: "utf8", mode: 0o600, flag: "wx" });
  if (lock !== undefined) writeFileSync(resolve(folder, ".terraform.lock.hcl"), lock, { encoding: "utf8", mode: 0o600, flag: "wx" });
  const version = tool(["version", "-json"], folder, options);
  tool(["init", "-backend=false", "-input=false", "-no-color"], folder, options);
  tool(["fmt", "-check", "-recursive"], folder, options);
  const validation = tool(["validate", "-json"], folder, options);
  const result = JSON.parse(validation) as { valid?: boolean; error_count?: number };
  if (result.valid !== true || result.error_count !== 0) {
    throw new Error("REAL_TERRAFORM_VALIDATE_FAILED");
  }
  tool([
    "plan", "-input=false", "-lock=false", "-refresh=false",
    "-out=.agentic-preview.tfplan",
  ], folder, options);
  const rawPlan = tool(["show", "-json", ".agentic-preview.tfplan"], folder, options);
  const normalized = normalizeTerraformPlan(rawPlan);
  const lockFile = readFileSync(resolve(folder, ".terraform.lock.hcl"), "utf8");
  return { version, validation, rawPlan, normalized, lockFile };
}

function writePreviewEvidence(folder: string, fields: Record<string, unknown>): void {
  writeFileSync(resolve(folder, "preview-evidence.json"), JSON.stringify(fields, null, 2) + "\n",
    { encoding: "utf8", mode: 0o600, flag: "wx" });
}

/** The first scenario: exactly one CREATE of `aws_cloudwatch_log_group.alz_audit`. */
export function logGroupPreview(folder: string, hcl: string, sourceCommit: string,
  options: TerraformPreviewOptions = {}): ActualPrivateBuildValidation {
  const run = runTerraformPreview(folder, hcl, undefined, options);
  const { normalized } = run;
  if (normalized.resources.length !== 1 ||
      normalized.resources[0]?.operation !== "CREATE" ||
      normalized.resources[0]?.address !== "aws_cloudwatch_log_group.alz_audit") {
    throw new Error("REAL_TERRAFORM_PLAN_NOT_SINGLE_APPROVED_CREATE");
  }
  writePreviewEvidence(folder, {
    sourceCommit, artifactHash: sha256(hcl),
    providerLockHash: sha256(run.lockFile),
    toolVersionHash: sha256(run.version),
    validationHash: sha256(run.validation), rawPlanHash: sha256(run.rawPlan),
    normalizedChangeSetHash: normalized.evidenceHash,
    target: "aws_cloudwatch_log_group.alz_audit", operation: "CREATE",
    actualTerraformPlan: true, infrastructureApplied: false,
  });
  return {
    mode: "REAL_TERRAFORM_FMT_VALIDATE_PLAN", infrastructureApplied: false,
    terraformVersion: run.version.slice(0, 200),
    validatedArtifactHash: sha256(hcl),
    validationOutputHash: sha256(run.validation),
    realPlanEvidenceHash: sha256(run.rawPlan),
    normalizedChangeSetHash: normalized.evidenceHash,
    singleCreateOnly: true,
    resourceAddress: "aws_cloudwatch_log_group.alz_audit",
    plannedTags: [...readTerraformPlanTags(run.rawPlan)]
      .map(([address, tags]) => ({ address, tags })),
  };
}

/**
 * The cost baseline: every planned change must be a CREATE, and there must be at least one. The created addresses are
 * reported sorted; `runCostBaselineBuild` requires them to equal the rendered set exactly, so an extra, missing or
 * changed resource fails the build closed (`ACTUAL_TERRAFORM_PREVIEW_UNVERIFIED`).
 */
export function costBaselinePreview(folder: string, hcl: string, sourceCommit: string, lock: string,
  options: TerraformPreviewOptions = {}): ActualCostBaselineValidation {
  const run = runTerraformPreview(folder, hcl, lock, options);
  const { normalized } = run;
  if (normalized.resources.length === 0 || normalized.resources.some((item) => item.operation !== "CREATE")) {
    throw new Error("REAL_TERRAFORM_PLAN_NOT_CREATE_ONLY");
  }
  const createdAddresses = normalized.resources.map((item) => item.address).sort();
  writePreviewEvidence(folder, {
    sourceCommit, artifactHash: sha256(hcl),
    reviewedLockHash: sha256(lock),
    providerLockHash: sha256(run.lockFile),
    toolVersionHash: sha256(run.version),
    validationHash: sha256(run.validation), rawPlanHash: sha256(run.rawPlan),
    normalizedChangeSetHash: normalized.evidenceHash,
    targets: createdAddresses, operation: "CREATE",
    actualTerraformPlan: true, infrastructureApplied: false,
  });
  return {
    mode: "REAL_TERRAFORM_FMT_VALIDATE_PLAN", infrastructureApplied: false,
    terraformVersion: run.version.slice(0, 200),
    validatedArtifactHash: sha256(hcl),
    validationOutputHash: sha256(run.validation),
    realPlanEvidenceHash: sha256(run.rawPlan),
    normalizedChangeSetHash: normalized.evidenceHash,
    createOnly: true,
    createdAddresses,
    plannedTags: [...readTerraformPlanTags(run.rawPlan)]
      .map(([address, tags]) => ({ address, tags })),
  };
}
