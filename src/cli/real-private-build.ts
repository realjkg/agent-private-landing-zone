import { spawnSync, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { runAgentKernel } from "../agent/graph.js";
import { runRealPrivateModelBuild, type ActualPrivateBuildValidation } from "../build/private-model.js";
import { sha256 } from "../build/provenance.js";
import { normalizeTerraformPlan } from "../iac/terraform-plan.js";
import { AWS_TERRAFORM_SCENARIO } from "../qualification/aws-terraform-agent.js";

function tool(command: "terraform", args: string[], cwd: string): string {
  const executed = spawnSync(command, args, {
    cwd, encoding: "utf8", shell: false,
    timeout: 120_000,
    maxBuffer: 4_000_000,
    env: { ...process.env, TF_IN_AUTOMATION: "1" },
  });
  if (executed.error || executed.status !== 0) {
    throw new Error("ACTUAL_TERRAFORM_TOOL_FAILURE:" + args[0]);
  }
  return executed.stdout ?? "";
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length !== 1 || args[0] !== "--live-aws-read-only") {
    throw new Error("REAL_PRIVATE_BUILD_REQUIRES_EXPLICIT_LIVE_AWS_MODE");
  }
  if (process.env.ALZ_ALLOW_REAL_PRIVATE_BUILD !== "1" ||
      process.env.ALZ_ALLOW_TERRAFORM_PLAN !== "1" ||
      process.env.AGENT_SKIP_LOCAL_MODEL === "1" ||
      !process.env.TF_VAR_aws_region) {
    throw new Error("REAL_PRIVATE_BUILD_EXPLICIT_TARGET_CONFIG_REQUIRED");
  }
  const sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim();
  if (execFileSync("git", ["status", "--porcelain"], {
    encoding: "utf8",
  }).trim()) throw new Error("SOURCE_WORKTREE_DIRTY");
  const folder = resolve(".runs", "qualification", "real-private-build", randomUUID());
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  const validate = async (hcl: string): Promise<ActualPrivateBuildValidation> => {
    const artifactPath = resolve(folder, "main.tf");
    writeFileSync(artifactPath, hcl, { encoding: "utf8", mode: 0o600, flag: "wx" });
    const version = tool("terraform", ["version", "-json"], folder);
    tool("terraform", ["init", "-backend=false", "-input=false", "-no-color"], folder);
    tool("terraform", ["fmt", "-check", "-recursive"], folder);
    const validation = tool("terraform", ["validate", "-json"], folder);
    const result = JSON.parse(validation) as { valid?: boolean; error_count?: number };
    if (result.valid !== true || result.error_count !== 0) {
      throw new Error("REAL_TERRAFORM_VALIDATE_FAILED");
    }
    tool("terraform", [
      "plan", "-input=false", "-lock=false", "-refresh=false",
      "-out=.agentic-preview.tfplan",
    ], folder);
    const rawPlan = tool("terraform", ["show", "-json", ".agentic-preview.tfplan"], folder);
    const normalized = normalizeTerraformPlan(rawPlan);
    if (normalized.resources.length !== 1 ||
        normalized.resources[0]?.operation !== "CREATE" ||
        normalized.resources[0]?.address !== "aws_cloudwatch_log_group.alz_audit") {
      throw new Error("REAL_TERRAFORM_PLAN_NOT_SINGLE_APPROVED_CREATE");
    }
    const lockFile = readFileSync(resolve(folder, ".terraform.lock.hcl"), "utf8");
    writeFileSync(resolve(folder, "preview-evidence.json"), JSON.stringify({
      sourceCommit, artifactHash: sha256(hcl),
      providerLockHash: sha256(lockFile),
      toolVersionHash: sha256(version),
      validationHash: sha256(validation), rawPlanHash: sha256(rawPlan),
      normalizedChangeSetHash: normalized.evidenceHash,
      target: "aws_cloudwatch_log_group.alz_audit", operation: "CREATE",
      actualTerraformPlan: true, infrastructureApplied: false,
    }, null, 2) + "\n", { encoding: "utf8", mode: 0o600, flag: "wx" });
    return {
      mode: "REAL_TERRAFORM_FMT_VALIDATE_PLAN", infrastructureApplied: false,
      terraformVersion: version.slice(0, 200),
      validatedArtifactHash: sha256(hcl),
      validationOutputHash: sha256(validation),
      realPlanEvidenceHash: sha256(rawPlan),
      normalizedChangeSetHash: normalized.evidenceHash,
      singleCreateOnly: true,
      resourceAddress: "aws_cloudwatch_log_group.alz_audit",
    };
  };
  const state = await runAgentKernel({
    request: AWS_TERRAFORM_SCENARIO.request, provider: "AWS",
    engine: "TERRAFORM",
    realPrivateBuild: (assessed) =>
      runRealPrivateModelBuild(assessed, {
        metadata: (await import("../ollama.js")).getLocalModelMetadata,
        model: (await import("../ollama.js")).invokeLocalModel,
        validate,
        repositoryEvidence: (await import("../build/repository.js")).collectRepositoryEvidence,
      }),
  });
  if (!state.build || state.build.candidate.artifact.generatedBy !==
      "local-qwen-mistral-reviewed-template" ||
      state.build.gate.allowed || state.observation?.mutationObserved !== false) {
    throw new Error("REAL_PRIVATE_BUILD_REVIEW_OR_MUTATION_GATE_FAILED");
  }
  const evidence = {
    sourceCommit, request: AWS_TERRAFORM_SCENARIO.id,
    environmentHash: sha256(JSON.stringify(state.environment)),
    designHash: state.design?.designHash,
    policyHash: state.design?.policies.bundleHash,
    buildEvidence: state.build.candidate.evidence,
    artifact: state.build.candidate.artifact,
    previewSummary: state.build.previewSummary,
    review: "EXTERNAL_APPROVAL_REQUIRED",
    infrastructureAct: "DISABLED",
  };
  writeFileSync(resolve(folder, "qualification.json"),
    JSON.stringify(evidence, null, 2) + "\n", { mode: 0o600, flag: "wx" });
  console.log("Real Qwen/Mistral additive Terraform BUILD review: " +
    state.build.candidate.status);
  console.log("Evidence directory: " + folder);
  console.log("ACT: DISABLED. No Terraform apply.");
}
main().catch((error) => {
  console.error("REAL_PRIVATE_BUILD_BLOCKED: " +
    (error instanceof Error ? error.message.slice(0, 180) : "UNKNOWN"));
  process.exitCode = 1;
});
