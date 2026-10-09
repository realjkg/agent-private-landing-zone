import { randomUUID } from "node:crypto";

import type { AgentState } from "../agent/types.js";
import { getLocalModelMetadata, invokeLocalModel, STRUCTURED_MODEL_OPTIONS } from "../ollama.js";
import { loadConfig } from "../config.js";
import { evaluateBuildGate } from "./gate.js";
import { createBuildArtifact, sha256 } from "./provenance.js";
import { collectRepositoryEvidence, type RepositoryEvidence } from "./repository.js";
import type { BuildLoopResult } from "./loop.js";
import type { ScannerResult } from "./types.js";
import {
  AWS_TERRAFORM_SCENARIO,
  renderAwsTerraformCandidate,
  reviewAwsTerraformProposals,
} from "../qualification/aws-terraform-agent.js";
import { governedUserRequest, wrapUntrustedEvidence } from "../security/prompt-governance.js";

export type ActualPrivateBuildValidation = {
  terraformVersion: string;
  validatedArtifactHash: string;
  validationOutputHash: string;
  realPlanEvidenceHash: string;
  normalizedChangeSetHash: string;
  singleCreateOnly: boolean;
  resourceAddress: "aws_cloudwatch_log_group.alz_audit";
  mode: "REAL_TERRAFORM_FMT_VALIDATE_PLAN";
  infrastructureApplied: false;
};
export type RealPrivateBuildDeps = {
  metadata: typeof getLocalModelMetadata;
  model: typeof invokeLocalModel;
  /** Trusted host only: actual sandboxed Terraform fmt, validate, plan and show-json. */
  validate: (hcl: string) => Promise<ActualPrivateBuildValidation>;
  repositoryEvidence: () => RepositoryEvidence;
};
export const defaultPrivateBuildDeps: RealPrivateBuildDeps = {
  metadata: getLocalModelMetadata,
  model: invokeLocalModel,
  validate: async () => { throw new Error("REAL_TERRAFORM_PREVIEW_DRIVER_NOT_CONNECTED"); },
  repositoryEvidence: collectRepositoryEvidence,
};

const hash = /^[a-f0-9]{64}$/i;
function requireBuild(ok: unknown, name: string): asserts ok {
  if (!ok) throw new Error("PRIVATE_BUILD_BLOCKED:" + name);
}

/** Bounded first production path: independent private model semantic proposal,
 * trusted template compilation and ACTUAL IaC-tool preview lineage.
 * No model-written executable IaC or provider mutation is accepted.
 */
export async function runRealPrivateModelBuild(
  state: AgentState,
  deps: RealPrivateBuildDeps = defaultPrivateBuildDeps,
): Promise<BuildLoopResult> {
  requireBuild(state.mock === undefined && state.provider === "AWS" &&
    state.engine === "TERRAFORM" &&
    state.request === AWS_TERRAFORM_SCENARIO.request,
    "UNAPPROVED_SCENARIO");
  const env = state.environment, design = state.design;
  requireBuild(env && design && state.assessment?.status === "OK" &&
    env.provider === "AWS" && env.classification === "BROWNFIELD" &&
    env.safeBuildMode === "ADDITIVE_ONLY" &&
    !env.warnings.some((warning) => warning.startsWith("DISCOVERY_PARTIAL")) &&
    env.evidence.length > 0 &&
    env.evidence.some((item) => item.key === "aws.identity" &&
      item.source === "aws-cli") &&
    env.evidence.every((item) => item.source !== "mock") &&
    env.resources.length > 0 &&
    env.resources.every((item) =>
      item.ownership !== "UNKNOWN" && item.mutationPolicy !== "DELETE_ALLOWED") &&
    design.status !== "BLOCKED" && design.plugin.plugin === "TERRAFORM" &&
    design.provider === "AWS" &&
    design.forbiddenChanges.every((value) =>
      value !== AWS_TERRAFORM_SCENARIO.resourceId) &&
    design.additions.every((value) =>
      value === AWS_TERRAFORM_SCENARIO.resourceId) &&
    state.action === undefined, "LIVE_DESIGN_OR_OWNERSHIP_NOT_APPROVED");
  const cfg = loadConfig(), url = new URL(cfg.ollamaBaseUrl);
  requireBuild(url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) &&
    cfg.routerModel.startsWith("qwen3:") &&
    cfg.primaryModel.startsWith("qwen3:") &&
    cfg.validatorModel.startsWith("mistral-nemo:") &&
    process.env.AGENT_SKIP_LOCAL_MODEL !== "1", "PRIVATE_MODEL_PROFILE_INVALID");
  const calls = state.assessment.modelInvocations ?? [];
  for (const [role, tag] of [
    ["ROUTER", cfg.routerModel], ["PRIMARY", cfg.primaryModel],
    ["VALIDATOR", cfg.validatorModel], ["ADJUDICATOR", cfg.routerModel],
  ] as const) requireBuild(calls.some((call) =>
    call.role === role && call.model === tag && call.schemaValid),
    "MODEL_ROLE_UNATTESTED:" + role);
  const tagged = await Promise.all(
    [cfg.primaryModel, cfg.validatorModel].map((tag) =>
      deps.metadata(cfg.ollamaBaseUrl, tag)));
  requireBuild(tagged.every((item) => hash.test(item.digest) &&
    item.size > 0), "MODEL_DIGEST_UNATTESTED");
  const keys = env.evidence.map((item) => item.key);
  const facts = {
    provider: env.provider, classification: env.classification,
    ownership: env.resources.map((item) => ({
      id: item.resourceId, ownership: item.ownership, rule: item.mutationPolicy,
    })),
    evidence: env.evidence,
    designHash: design.designHash, policyHash: design.policies.bundleHash,
    approvedAdditions: design.additions, forbiddenChanges: design.forbiddenChanges,
  };
  const messages = (role: "PROPOSER" | "VALIDATOR") => [
    { role: "system" as const,
      content: "Act as the independent AWS Terraform " + role +
        ". Return one JSON object ONLY: action ADD, resourceType aws_cloudwatch_log_group, " +
        "name /alz/preview/brownfield-audit, retentionDays 30, ownership NEW_RESOURCE_ONLY, " +
        "evidenceRefs exact keys from evidence. Never return HCL/shell/permissions/extra keys." },
    { role: "user" as const, content: governedUserRequest(state.request) },
    { role: "user" as const, content: wrapUntrustedEvidence(JSON.stringify(facts)) },
  ];
  const [primary, validator] = await Promise.all([
    deps.model(cfg.ollamaBaseUrl, cfg.primaryModel, messages("PROPOSER"),
      STRUCTURED_MODEL_OPTIONS),
    deps.model(cfg.ollamaBaseUrl, cfg.validatorModel, messages("VALIDATOR"),
      STRUCTURED_MODEL_OPTIONS),
  ]);
  const reviewed = reviewAwsTerraformProposals(primary, validator, keys);
  const hcl = renderAwsTerraformCandidate(reviewed);
  const artifact = createBuildArtifact({
    engine: "TERRAFORM", provider: "AWS", path: "generated/main.tf",
    content: hcl, generatedBy: "local-qwen-mistral-reviewed-template",
  });
  const actual = await deps.validate(hcl);
  requireBuild(actual.mode === "REAL_TERRAFORM_FMT_VALIDATE_PLAN" &&
    actual.infrastructureApplied === false &&
    actual.singleCreateOnly === true &&
    actual.resourceAddress === "aws_cloudwatch_log_group.alz_audit" &&
    actual.validatedArtifactHash === artifact.contentHash &&
    [actual.validationOutputHash, actual.realPlanEvidenceHash,
      actual.normalizedChangeSetHash].every((value) => hash.test(value)),
    "ACTUAL_TERRAFORM_PREVIEW_UNVERIFIED");
  const scannerResults: ScannerResult[] = [{
    scanner: "terraform-real-fmt-validate-plan", passed: true,
    findings: [], evidenceHash: actual.validationOutputHash,
  }];
  const candidate = {
    id: "build-" + randomUUID(), status: "READY_FOR_APPROVAL" as const,
    environment: env, artifact,
    evidence: {
      discoverySnapshotHash: sha256(JSON.stringify(env)),
      assessmentId: state.assessment.requestId,
      designId: design.designId, designHash: design.designHash,
      policyBundleId: design.policies.bundleId,
      policyBundleHash: design.policies.bundleHash,
      scannerResults,
      planHash: actual.realPlanEvidenceHash,
    },
    repairAttempt: 0, maxRepairAttempts: 0,
  };
  const gate = evaluateBuildGate(candidate, true);
  const repository = deps.repositoryEvidence();
  if (!repository.clean || !repository.packageLockHash) {
    gate.allowed = false;
    gate.reasons.push("Source repository / dependency provenance not clean");
  }
  requireBuild(!gate.allowed && gate.reasons.every((message) =>
    message.includes("Human approval") ||
    message.includes("provenance not clean")),
    "NONAPPROVAL_GATE_FAILED");
  return {
    candidate, repository, gate,
    previewSummary: JSON.stringify({
      evidenceMode: "REAL_PRIVATE_MODEL_AND_REAL_TERRAFORM_PREVIEW",
      provider: "AWS", engine: "TERRAFORM",
      operation: "CREATE", count: 1, updates: 0, deletes: 0,
      normalizedChangeSetHash: actual.normalizedChangeSetHash,
      designAmendment: design.additions.includes(AWS_TERRAFORM_SCENARIO.resourceId)
        ? "ALREADY_PROPOSED" : "EXTERNAL_APPROVAL_REQUIRED",
      validationOutputHash: actual.validationOutputHash,
      modelDigestHashes: tagged.map((x) => x.digest),
    }),
    executionMode: "PREVIEW_ONLY",
  };
}
