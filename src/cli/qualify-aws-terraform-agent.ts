import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { sha256 } from "../build/provenance.js";
import { dirname } from "node:path";

import { getIaCAdapter } from "../iac/index.js";
import { normalizeTerraformPlan } from "../iac/terraform-plan.js";
import {
  qualifyAwsTerraformAgents,
  type AwsTerraformAgentResult,
} from "../qualification/aws-terraform-agent.js";

function checked(command: string, args: string[], cwd: string): string {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    shell: false,
    timeout: 120_000,
    env: { ...process.env, TF_IN_AUTOMATION: "1" },
  });
  if (result.error || result.status !== 0) {
    throw new Error("TOOL_FAILED:" + command + " " + args.join(" ") +
      " (exit=" + result.status + "): " +
      " (details withheld; inspect sanitized local tooling logs)");
  }
  return result.stdout ?? "";
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes("--help") || !args.includes("--live-models")) {
    console.log([
      "AWS brownfield → Terraform private-agent functional qualification",
      "",
      "Build first: npm ci && npm run build",
      "Run: node dist/cli/qualify-aws-terraform-agent.js --live-models",
      "Optional: --terraform-validate (actual local terraform init/fmt/validate)",
      "Optional: --terraform-plan (requires --terraform-validate and ALZ_ALLOW_TERRAFORM_PLAN=1)",
      "",
      "This always invokes actual loopback Ollama Qwen/Mistral models.",
      "Discovery is SYNTHETIC. ACT is disabled. No Terraform apply.",
      "No results will be labelled live AWS discovery or deployment.",
    ].join("\n"));
    if (!args.includes("--help")) process.exitCode = 2;
    return;
  }
  const allowed = new Set(["--live-models", "--terraform-validate", "--terraform-plan"]);
  if (args.some((arg) => !allowed.has(arg))) throw new Error("UNKNOWN_QUALIFICATION_ARGUMENT");
  const validate = args.includes("--terraform-validate");
  const plan = args.includes("--terraform-plan");
  if (plan && (!validate || process.env.ALZ_ALLOW_TERRAFORM_PLAN !== "1")) {
    throw new Error("TERRAFORM_PLAN_REQUIRES_EXPLICIT_OPT_IN");
  }
  const sourceCommit = execFileSync("git", ["rev-parse", "--verify", "HEAD"],
    { encoding: "utf8" }).trim();
  const dirty = execFileSync("git", ["status", "--porcelain"],
    { encoding: "utf8" }).trim();
  if (dirty) throw new Error("SOURCE_WORKTREE_DIRTY: qualify from a clean commit");
  const result = await qualifyAwsTerraformAgents({
    sourceCommit,
    outputRoot: ".runs/qualification",
  });
  const save = (evidence: AwsTerraformAgentResult) => writeFileSync(
    evidence.evidencePath, JSON.stringify(evidence, null, 2) + "\n",
    { mode: 0o600 },
  );
  console.log("Private Qwen/Mistral model review: completed");
  console.log("AWS discovery evidence: synthetic fixture");
  console.log("Terraform candidate: " + result.artifactPath);
  console.log("Artifact SHA256: " + result.artifactHash);
  console.log("Review status: " + result.status + " / approval NOT_GRANTED / ACT DISABLED");
  if (!validate) {
    console.log("Terraform CLI validation and plan: NOT RUN (select flags to qualify)");
    console.log("Evidence: " + result.evidencePath);
    return;
  }

  const cwd = dirname(result.artifactPath);
  const adapter = getIaCAdapter("TERRAFORM");
  const context = { cwd, allowCloudRead: false, allowMutation: false as const };
  try {
    checked("terraform", ["init", "-backend=false", "-input=false", "-no-color"], cwd);
    result.providerLockHash = sha256(
      readFileSync(cwd + "/.terraform.lock.hcl", "utf8"));
    const version = adapter.version(context);
    if (!version.ok) throw new Error("TERRAFORM_VERSION_FAILED");
    result.terraformVersion = version.stdout.slice(0, 500);
    const checks = adapter.validate(context);
    if (!checks.every((check) => check.ok)) {
      throw new Error("TERRAFORM_FMT_OR_VALIDATE_FAILED");
    }
    const validation = checks.find((check) => check.tool === "terraform_validate");
    if (!validation) throw new Error("TERRAFORM_VALIDATE_RESULT_MISSING");
    const parsed = JSON.parse(validation.stdout) as { valid?: boolean; error_count?: number };
    if (parsed.valid !== true || parsed.error_count !== 0) {
      throw new Error("TERRAFORM_VALIDATE_NOT_VALID");
    }
    result.terraformValidation = "PASSED";
    save(result);
    console.log("Terraform fmt/validate: PASSED (actual local CLI; not a cloud plan)");
  } catch (error) {
    result.terraformValidation = "FAILED";
    result.failedGate = error instanceof Error ? error.message.slice(0, 160) : "TERRAFORM_UNKNOWN";
    save(result);
    throw error;
  }

  if (plan) {
    try {
      if (!process.env.TF_VAR_aws_region) {
        throw new Error("TF_VAR_aws_region_REQUIRED_FOR_PLAN");
      }
      // Explicit operator opt-in; adapter executes terraform plan only (never apply).
      const planned = adapter.preview({ ...context, allowCloudRead: true });
      if (!planned.ok) throw new Error("TERRAFORM_PREVIEW_PLAN_FAILED");
      const raw = checked("terraform", ["show", "-json", ".agentic-preview.tfplan"], cwd);
      const normalized = normalizeTerraformPlan(raw);
      const operations = normalized.resources;
      if (operations.length !== 1 ||
          operations[0]?.operation !== "CREATE" ||
          operations[0]?.address !== "aws_cloudwatch_log_group.alz_audit") {
        throw new Error("TERRAFORM_PLAN_NOT_EXACT_SINGLE_ADDITION");
      }
      result.planEvidenceHash = normalized.evidenceHash;
      result.terraformPlan = "PASSED";
      save(result);
      console.log("Actual Terraform plan: one CREATE, no update/delete.");
      console.log("NOTE: discovery remains synthetic; live brownfield ownership is NOT established.");
    } catch (error) {
      result.terraformPlan = "FAILED";
      result.failedGate = error instanceof Error ? error.message.slice(0, 160) : "PLAN_UNKNOWN";
      save(result);
      throw error;
    }
  }
  console.log("Evidence: " + result.evidencePath);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : "unknown";
  console.error("QUALIFICATION_BLOCKED: " + message);
  console.error("No Terraform apply or infrastructure ACT was executed.");
  process.exitCode = 1;
});
