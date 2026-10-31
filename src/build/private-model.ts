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
import {
  AWS_COST_BASELINE_SCENARIO,
  renderAwsCostBaseline,
  reviewCostBaselineProposals,
} from "./cost-baseline.js";
import { CostConfigError, resolveCostConfig, type CostConfig } from "../design/cost.js";
import { governedUserRequest, wrapUntrustedEvidence } from "../security/prompt-governance.js";
import { checkCreateTraceability } from "../teardown/gates.js";
import type { DeletionUnit, DeletionUnitStateRef, PlannedTags } from "../teardown/types.js";
import {
  attestedCreatePlan,
  deletionUnitId,
  provenanceTags,
  recordAttestedDeletionUnit,
} from "../teardown/unit.js";

export type ActualPrivateBuildValidation = {
  terraformVersion: string;
  validatedArtifactHash: string;
  validationOutputHash: string;
  realPlanEvidenceHash: string;
  normalizedChangeSetHash: string;
  singleCreateOnly: boolean;
  resourceAddress: "aws_cloudwatch_log_group.alz_audit";
  /**
   * Per-create tags read from the real plan (`readTerraformPlanTags`).
   * Required when the build opts in to a deletion unit; a driver that cannot
   * report them fails the build closed rather than leaving tags unproven.
   */
  plannedTags?: Array<{ address: string; tags: PlannedTags }>;
  mode: "REAL_TERRAFORM_FMT_VALIDATE_PLAN";
  infrastructureApplied: false;
};
/**
 * The trusted driver's report for the cost-baseline scenario: the same real fmt, validate and plan lineage, for a
 * plan that creates exactly the rendered addresses and changes nothing else.
 */
export type ActualCostBaselineValidation = {
  terraformVersion: string;
  validatedArtifactHash: string;
  validationOutputHash: string;
  realPlanEvidenceHash: string;
  normalizedChangeSetHash: string;
  /** True only when every planned change is a create. */
  createOnly: boolean;
  /** Every address the plan creates. It must equal the rendered set exactly. */
  createdAddresses: string[];
  /** Per-create tags read from the real plan; required for the deletion-unit opt-in, as for the first scenario. */
  plannedTags?: Array<{ address: string; tags: PlannedTags }>;
  mode: "REAL_TERRAFORM_FMT_VALIDATE_PLAN";
  infrastructureApplied: false;
};
/** The requests the private-model build accepts. Any other request is refused before inference. */
export const APPROVED_PRIVATE_BUILD_SCENARIOS = [AWS_TERRAFORM_SCENARIO.id, AWS_COST_BASELINE_SCENARIO.id] as const;
/** Design entry for the cost baseline; a design may propose it, and may not forbid it. */
export const AWS_COST_BASELINE_RESOURCE_ID = "aws:cost-baseline:" + AWS_COST_BASELINE_SCENARIO.id;

export type RealPrivateBuildDeps = {
  metadata: typeof getLocalModelMetadata;
  model: typeof invokeLocalModel;
  /** Trusted host only: actual sandboxed Terraform fmt, validate, plan and show-json. */
  validate: (hcl: string) => Promise<ActualPrivateBuildValidation>;
  /** Trusted host only: the same real preview for the cost-baseline scenario. Unset fails that scenario closed. */
  validateCostBaseline?: (hcl: string) => Promise<ActualCostBaselineValidation>;
  /**
   * Trusted host only: the `cost` section of the landing-zone build input (src/design/cost.ts), re-validated here.
   * Required by the cost-baseline scenario and ignored by every other one; no model or chat text supplies it.
   */
  costConfig?: unknown;
  repositoryEvidence: () => RepositoryEvidence;
  /**
   * Opt in to traceable teardown: the trusted host names the engine state
   * container this build will create into. The unit's provenance tags are
   * stamped into the candidate and the unit is recorded on the result. Unset
   * leaves the candidate, its hash and the result exactly as before.
   */
  deletionUnitState?: DeletionUnitStateRef;
  /** Optional YYYY-MM-DD expiry tag for short-lived builds (reported, never enforced). */
  deletionUnitExpires?: string;
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

/**
 * The live preconditions every approved scenario shares: real (never fixture) brownfield discovery with known
 * ownership, an unblocked Terraform design that proposes only `resourceId` and does not forbid it, the private
 * loopback Qwen/Mistral profile with every role attested, and digests for both proposing models.
 */
async function requireLivePreconditions(state: AgentState, deps: RealPrivateBuildDeps, resourceId: string) {
  const env = state.environment, design = state.design, assessment = state.assessment;
  requireBuild(env && design && assessment?.status === "OK" &&
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
      value !== resourceId) &&
    design.additions.every((value) =>
      value === resourceId) &&
    state.action === undefined, "LIVE_DESIGN_OR_OWNERSHIP_NOT_APPROVED");
  // Cheap and before any model call: a wrong state reference must not cost inference.
  requireBuild(deps.deletionUnitState === undefined ||
    deps.deletionUnitState.engine === "TERRAFORM", "TEARDOWN_STATE_REF_ENGINE");
  const cfg = loadConfig(), url = new URL(cfg.ollamaBaseUrl);
  requireBuild(url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) &&
    cfg.routerModel.startsWith("qwen3:") &&
    cfg.primaryModel.startsWith("qwen3:") &&
    cfg.validatorModel.startsWith("mistral-nemo:") &&
    process.env.AGENT_SKIP_LOCAL_MODEL !== "1", "PRIVATE_MODEL_PROFILE_INVALID");
  const calls = assessment.modelInvocations ?? [];
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
  return { env, design, assessment, cfg, tagged };
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
    (state.request === AWS_TERRAFORM_SCENARIO.request || state.request === AWS_COST_BASELINE_SCENARIO.request),
    "UNAPPROVED_SCENARIO");
  if (state.request === AWS_COST_BASELINE_SCENARIO.request) return runCostBaselineBuild(state, deps);
  const { env, design, assessment, cfg, tagged } =
    await requireLivePreconditions(state, deps, AWS_TERRAFORM_SCENARIO.resourceId);
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
  const buildId = "build-" + randomUUID();
  const expectedTags = deps.deletionUnitState
    ? provenanceTags({
      unitId: deletionUnitId(buildId, deps.deletionUnitState),
      buildId,
      expires: deps.deletionUnitExpires,
    })
    : undefined;
  const hcl = renderAwsTerraformCandidate(reviewed, expectedTags);
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
  let deletionUnit: DeletionUnit | undefined;
  if (deps.deletionUnitState) {
    requireBuild(actual.plannedTags !== undefined, "TEARDOWN_PLAN_TAGS_NOT_REPORTED");
    const creates = [{ address: actual.resourceAddress, type: "aws_cloudwatch_log_group" }];
    deletionUnit = recordAttestedDeletionUnit({
      buildId, provider: "AWS", stateRef: deps.deletionUnitState,
      designHash: design.designHash, engine: "TERRAFORM", creates,
      attestedChangeSetHash: actual.normalizedChangeSetHash,
      expires: deps.deletionUnitExpires,
    });
    requireBuild(JSON.stringify(deletionUnit.tags) === JSON.stringify(expectedTags),
      "TEARDOWN_UNIT_TAGS_DIVERGED");
    const traceability = checkCreateTraceability(deletionUnit,
      attestedCreatePlan("TERRAFORM", creates, actual.normalizedChangeSetHash),
      new Map(actual.plannedTags!.map((item) => [item.address, item.tags] as const)));
    requireBuild(traceability.verdict === "TRACEABLE" &&
      traceability.tagCoverage === "VERIFIED" &&
      traceability.tagged.includes(actual.resourceAddress),
    "TEARDOWN_TRACEABILITY:" + traceability.reasons.join(";").slice(0, 300));
  }
  const scannerResults: ScannerResult[] = [{
    scanner: "terraform-real-fmt-validate-plan", passed: true,
    findings: [], evidenceHash: actual.validationOutputHash,
  }];
  const candidate = {
    id: buildId, status: "READY_FOR_APPROVAL" as const,
    environment: env, artifact,
    evidence: {
      discoverySnapshotHash: sha256(JSON.stringify(env)),
      assessmentId: assessment.requestId,
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
      ...(deletionUnit
        ? { deletionUnitId: deletionUnit.unitId, deletionUnitHash: deletionUnit.unitHash }
        : {}),
    }),
    executionMode: "PREVIEW_ONLY",
    ...(deletionUnit ? { deletionUnit } : {}),
  };
}

/**
 * The cost-baseline scenario (src/build/cost-baseline.ts): the same live preconditions and private two-model review,
 * where the models may only confirm the owner's `cost` configuration and fixed code renders the Terraform. The trusted
 * driver must show a create-only plan of exactly the rendered addresses.
 */
async function runCostBaselineBuild(state: AgentState, deps: RealPrivateBuildDeps): Promise<BuildLoopResult> {
  const { env, design, assessment, cfg, tagged } =
    await requireLivePreconditions(state, deps, AWS_COST_BASELINE_RESOURCE_ID);
  let config: CostConfig;
  try {
    requireBuild(deps.costConfig !== undefined, "COST_CONFIG_MISSING");
    config = resolveCostConfig(deps.costConfig);
  } catch (error) {
    if (error instanceof CostConfigError) {
      throw new Error("PRIVATE_BUILD_BLOCKED:COST_CONFIG_INVALID:" + error.message.slice(0, 300));
    }
    throw error;
  }
  requireBuild(deps.validateCostBaseline !== undefined, "COST_BASELINE_PREVIEW_DRIVER_NOT_CONNECTED");
  const keys = env.evidence.map((item) => item.key);
  const facts = {
    provider: env.provider, classification: env.classification,
    ownership: env.resources.map((item) => ({
      id: item.resourceId, ownership: item.ownership, rule: item.mutationPolicy,
    })),
    evidence: env.evidence,
    designHash: design.designHash, policyHash: design.policies.bundleHash,
    cost: { budget: config.budget, analytics: config.analytics, budgetAction: config.budgetAction.enabled },
  };
  const messages = (role: "PROPOSER" | "VALIDATOR") => [
    { role: "system" as const,
      content: "Act as the independent AWS Terraform " + role + " for the ALZ cost baseline. Return one JSON object " +
        "ONLY: action ADD, scenario " + AWS_COST_BASELINE_SCENARIO.id + ", budgetAmount, currency, period, " +
        "actualThresholds and forecastThresholds copied exactly from the cost facts, ownership NEW_RESOURCE_ONLY, " +
        "evidenceRefs exact keys from evidence. Never return HCL/shell/permissions/extra keys." },
    { role: "user" as const, content: governedUserRequest(state.request) },
    { role: "user" as const, content: wrapUntrustedEvidence(JSON.stringify(facts)) },
  ];
  const [primary, validator] = await Promise.all([
    deps.model(cfg.ollamaBaseUrl, cfg.primaryModel, messages("PROPOSER"), STRUCTURED_MODEL_OPTIONS),
    deps.model(cfg.ollamaBaseUrl, cfg.validatorModel, messages("VALIDATOR"), STRUCTURED_MODEL_OPTIONS),
  ]);
  reviewCostBaselineProposals(primary, validator, config, keys);
  const buildId = "build-" + randomUUID();
  const expectedTags = deps.deletionUnitState
    ? provenanceTags({
      unitId: deletionUnitId(buildId, deps.deletionUnitState),
      buildId,
      expires: deps.deletionUnitExpires,
    })
    : undefined;
  const rendered = renderAwsCostBaseline(config, expectedTags);
  const artifact = createBuildArtifact({
    engine: "TERRAFORM", provider: "AWS", path: "generated/cost-baseline/main.tf",
    content: rendered.terraform, generatedBy: "local-qwen-mistral-reviewed-template",
  });
  const expected = rendered.metadata.creates.map((item) => item.address);
  const actual = await deps.validateCostBaseline!(rendered.terraform);
  requireBuild(actual.mode === "REAL_TERRAFORM_FMT_VALIDATE_PLAN" &&
    actual.infrastructureApplied === false &&
    actual.createOnly === true &&
    Array.isArray(actual.createdAddresses) &&
    JSON.stringify([...actual.createdAddresses].sort()) === JSON.stringify(expected) &&
    actual.validatedArtifactHash === artifact.contentHash &&
    [actual.validationOutputHash, actual.realPlanEvidenceHash,
      actual.normalizedChangeSetHash].every((value) => hash.test(value)),
  "ACTUAL_TERRAFORM_PREVIEW_UNVERIFIED");
  let deletionUnit: DeletionUnit | undefined;
  if (deps.deletionUnitState) {
    requireBuild(actual.plannedTags !== undefined, "TEARDOWN_PLAN_TAGS_NOT_REPORTED");
    const creates = rendered.metadata.creates.map(({ address, type }) => ({ address, type }));
    deletionUnit = recordAttestedDeletionUnit({
      buildId, provider: "AWS", stateRef: deps.deletionUnitState,
      designHash: design.designHash, engine: "TERRAFORM", creates,
      attestedChangeSetHash: actual.normalizedChangeSetHash,
      expires: deps.deletionUnitExpires,
    });
    requireBuild(JSON.stringify(deletionUnit.tags) === JSON.stringify(expectedTags),
      "TEARDOWN_UNIT_TAGS_DIVERGED");
    const traceability = checkCreateTraceability(deletionUnit,
      attestedCreatePlan("TERRAFORM", creates, actual.normalizedChangeSetHash),
      new Map(actual.plannedTags!.map((item) => [item.address, item.tags] as const)));
    const taggable = rendered.metadata.creates.filter((item) => item.taggable).map((item) => item.address);
    requireBuild(traceability.verdict === "TRACEABLE" &&
      traceability.tagCoverage === "VERIFIED" &&
      taggable.every((address) => traceability.tagged.includes(address)),
    "TEARDOWN_TRACEABILITY:" + traceability.reasons.join(";").slice(0, 300));
  }
  const scannerResults: ScannerResult[] = [{
    scanner: "terraform-real-fmt-validate-plan", passed: true,
    findings: [], evidenceHash: actual.validationOutputHash,
  }];
  const candidate = {
    id: buildId, status: "READY_FOR_APPROVAL" as const,
    environment: env, artifact,
    evidence: {
      discoverySnapshotHash: sha256(JSON.stringify(env)),
      assessmentId: assessment.requestId,
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
  const meta = rendered.metadata;
  return {
    candidate, repository, gate,
    previewSummary: JSON.stringify({
      evidenceMode: "REAL_PRIVATE_MODEL_AND_REAL_TERRAFORM_PREVIEW",
      scenario: AWS_COST_BASELINE_SCENARIO.id,
      provider: "AWS", engine: "TERRAFORM",
      operation: "CREATE", count: expected.length, updates: 0, deletes: 0,
      normalizedChangeSetHash: actual.normalizedChangeSetHash,
      costConfigHash: meta.configHash,
      budgetControl: meta.budget.control,
      budgetActionEffect: meta.budgetAction.effect,
      crossRegionDependencies: meta.crossRegionDependencies.map(({ service, region }) => service + "@" + region),
      analytics: meta.analytics,
      designAmendment: design.additions.includes(AWS_COST_BASELINE_RESOURCE_ID)
        ? "ALREADY_PROPOSED" : "EXTERNAL_APPROVAL_REQUIRED",
      validationOutputHash: actual.validationOutputHash,
      modelDigestHashes: tagged.map((x) => x.digest),
      ...(deletionUnit
        ? { deletionUnitId: deletionUnit.unitId, deletionUnitHash: deletionUnit.unitHash }
        : {}),
    }),
    executionMode: "PREVIEW_ONLY",
    ...(deletionUnit ? { deletionUnit } : {}),
  };
}
