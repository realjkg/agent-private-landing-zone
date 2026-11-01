import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { getLocalModelMetadata, invokeLocalModel } from "../ollama.js";
import { collectRepositoryEvidence } from "../build/repository.js";

import { runAgentKernel } from "../agent/graph.js";
import { runRealPrivateModelBuild } from "../build/private-model.js";
import { sha256 } from "../build/provenance.js";
import { AWS_COST_BASELINE_SCENARIO } from "../build/cost-baseline.js";
import { reviewedAwsLock, writeCostBaselineProject } from "../build/cost-project.js";
import { costBaselinePreview, logGroupPreview } from "../build/terraform-preview.js";
import { readLocalCostConfig } from "../cost/local.js";
import type { CostConfig } from "../design/cost.js";
import type { DeletionUnitStateRef } from "../teardown/types.js";
import { AWS_TERRAFORM_SCENARIO } from "../qualification/aws-terraform-agent.js";

/**
 * `--live-aws-read-only` runs the first scenario (one log group). `--live-aws-read-only --scenario cost-baseline` runs the
 * cost baseline from `config/cost.json` (docs/cost-baseline-deploy.md) and, only once every gate passed, writes it as a
 * pilot project in the run folder. Any other argument list is refused.
 */
function scenarioOf(args: string[]): "LOG_GROUP" | "COST_BASELINE" {
  if (args.length === 1 && args[0] === "--live-aws-read-only") return "LOG_GROUP";
  if (args.length === 3 && args[0] === "--live-aws-read-only" && args[1] === "--scenario" && args[2] === "cost-baseline") return "COST_BASELINE";
  throw new Error("REAL_PRIVATE_BUILD_REQUIRES_EXPLICIT_LIVE_AWS_MODE");
}

function localCostConfig(): CostConfig {
  const local = readLocalCostConfig();
  if (local.state === "NONE") throw new Error("COST_CONFIG_MISSING: create config/cost.json from config/cost.example.json");
  if (local.state === "INVALID") {
    throw new Error("COST_CONFIG_INVALID: " + local.issues.map((issue) => issue.path + " " + issue.code).join("; ").slice(0, 120));
  }
  return local.config;
}

async function main(): Promise<void> {
  const scenario = scenarioOf(process.argv.slice(2));
  if (process.env.ALZ_ALLOW_REAL_PRIVATE_BUILD !== "1" ||
      process.env.ALZ_ALLOW_TERRAFORM_PLAN !== "1" ||
      process.env.AGENT_SKIP_LOCAL_MODEL === "1" ||
      !process.env.TF_VAR_aws_region) {
    throw new Error("REAL_PRIVATE_BUILD_EXPLICIT_TARGET_CONFIG_REQUIRED");
  }
  // Read before any model or engine runs: a missing or invalid configuration costs no inference.
  const costConfig = scenario === "COST_BASELINE" ? localCostConfig() : undefined;
  const sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim();
  if (execFileSync("git", ["status", "--porcelain"], {
    encoding: "utf8",
  }).trim()) throw new Error("SOURCE_WORKTREE_DIRTY");
  // Opt-in traceable teardown (docs/teardown-traceability.md): a JSON state
  // reference naming the container this build would create into. Unset keeps
  // the qualified candidate unchanged.
  const unitStatePath = process.env.ALZ_DELETION_UNIT_STATE;
  const deletionUnitState = unitStatePath
    ? JSON.parse(readFileSync(unitStatePath, "utf8")) as DeletionUnitStateRef
    : undefined;
  const folder = resolve(".runs", "qualification", "real-private-build", randomUUID());
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  const request = scenario === "COST_BASELINE" ? AWS_COST_BASELINE_SCENARIO : AWS_TERRAFORM_SCENARIO;
  const lock = scenario === "COST_BASELINE" ? reviewedAwsLock() : undefined;
  const state = await runAgentKernel({
    request: request.request, provider: "AWS",
    engine: "TERRAFORM",
    realPrivateBuild: (assessed) =>
      runRealPrivateModelBuild(assessed, {
        metadata: getLocalModelMetadata,
        model: invokeLocalModel,
        validate: async (hcl) => logGroupPreview(folder, hcl, sourceCommit),
        ...(lock !== undefined
          ? { validateCostBaseline: async (hcl: string) => costBaselinePreview(folder, hcl, sourceCommit, lock), costConfig }
          : {}),
        repositoryEvidence: collectRepositoryEvidence,
        deletionUnitState,
        deletionUnitExpires: process.env.ALZ_DELETION_UNIT_EXPIRES,
      }),
  });
  if (!state.build || state.build.candidate.artifact.generatedBy !==
      "local-qwen-mistral-reviewed-template" ||
      state.build.gate.allowed || state.observation?.mutationObserved !== false) {
    throw new Error("REAL_PRIVATE_BUILD_REVIEW_OR_MUTATION_GATE_FAILED");
  }
  const evidence = {
    sourceCommit, request: request.id,
    environmentHash: sha256(JSON.stringify(state.environment)),
    designHash: state.design?.designHash,
    policyHash: state.design?.policies.bundleHash,
    buildEvidence: state.build.candidate.evidence,
    artifact: state.build.candidate.artifact,
    previewSummary: state.build.previewSummary,
    deletionUnit: state.build.deletionUnit,
    review: "EXTERNAL_APPROVAL_REQUIRED",
    infrastructureAct: "DISABLED",
  };
  writeFileSync(resolve(folder, "qualification.json"),
    JSON.stringify(evidence, null, 2) + "\n", { mode: 0o600, flag: "wx" });
  // Only after every gate passed: the same configuration as a pilot project for ./alz apply prepare (still no apply).
  const project = costConfig === undefined ? undefined : writeCostBaselineProject({
    config: costConfig, projectRoot: resolve(folder, "project"), region: process.env.TF_VAR_aws_region,
    previewArtifactSha256: state.build.candidate.artifact.contentHash, lock,
  });
  console.log("Real Qwen/Mistral additive Terraform BUILD review: " +
    state.build.candidate.status);
  console.log("Evidence directory: " + folder);
  if (project) console.log("Pilot project (next: ./alz apply prepare --environment DEV --project <it>): " + project.projectRoot);
  console.log("ACT: DISABLED. No Terraform apply.");
}
main().catch((error) => {
  console.error("REAL_PRIVATE_BUILD_BLOCKED: " +
    (error instanceof Error ? error.message.slice(0, 180) : "UNKNOWN"));
  process.exitCode = 1;
});
