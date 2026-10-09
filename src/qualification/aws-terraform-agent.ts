import { mkdirSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import { runAgentKernel } from "../agent/graph.js";
import type { AgentState } from "../agent/types.js";
import { sha256 } from "../build/provenance.js";
import { loadConfig } from "../config.js";
import {
  getLocalModelMetadata,
  invokeLocalModel,
  STRUCTURED_MODEL_OPTIONS,
} from "../ollama.js";
import { governedUserRequest, wrapUntrustedEvidence } from "../security/prompt-governance.js";

export const AWS_TERRAFORM_SCENARIO = {
  id: "aws-brownfield-terraform-private-agents-v1",
  request: "Build an additive AWS brownfield Terraform preview for a new isolated ALZ audit CloudWatch log group with 30-day retention. Preserve existing Control Tower, AWS Organizations, and customer-owned resources. Produce a reviewed preview candidate only.",
  resourceId: "aws:logs:group:/alz/preview/brownfield-audit",
  logGroupName: "/alz/preview/brownfield-audit",
  retentionDays: 30,
} as const;

export type RestrictedProposal = {
  action: "ADD";
  resourceType: "aws_cloudwatch_log_group";
  name: string;
  retentionDays: number;
  ownership: "NEW_RESOURCE_ONLY";
  evidenceRefs: string[];
};

type ModelMetadata = Awaited<ReturnType<typeof getLocalModelMetadata>>;

export type AwsTerraformAgentDeps = {
  kernel: typeof runAgentKernel;
  metadata: typeof getLocalModelMetadata;
  model: typeof invokeLocalModel;
};

export type AwsTerraformAgentResult = {
  scenario: typeof AWS_TERRAFORM_SCENARIO.id;
  sourceCommit: string;
  mode: "LIVE_LOCAL_MODELS_WITH_SYNTHETIC_AWS_EVIDENCE";
  modelEvidence: Array<{ role: string; tag: string; digest: string }>;
  designHash: string;
  policyHash: string;
  discoveryHash: string;
  modelProposalHash: string;
  artifactHash: string;
  artifactPath: string;
  evidencePath: string;
  status: "REVIEW_REQUIRED";
  terraformValidation: "NOT_RUN" | "PASSED";
  terraformPlan: "NOT_RUN" | "PASSED";
  planEvidenceHash?: string;
  approval: "NOT_GRANTED";
  infrastructureAct: "DISABLED";
  mutationObserved: false;
  assumptions: string[];
};

const defaultDeps: AwsTerraformAgentDeps = {
  kernel: runAgentKernel,
  metadata: getLocalModelMetadata,
  model: invokeLocalModel,
};

function requireCondition(condition: unknown, code: string): asserts condition {
  if (!condition) throw new Error(code);
}

function parseProposal(raw: string, evidenceKeys: Set<string>): RestrictedProposal {
  // The model supplies only an allowlisted resource decision, never executable IaC.
  const object = JSON.parse(raw) as Record<string, unknown>;
  requireCondition(object && typeof object === "object" && !Array.isArray(object),
    "MODEL_PROPOSAL_INVALID_OBJECT");
  const keys = Object.keys(object).sort();
  requireCondition(
    JSON.stringify(keys) === JSON.stringify(
      ["action", "evidenceRefs", "name", "ownership", "resourceType", "retentionDays"].sort()),
    "MODEL_PROPOSAL_UNEXPECTED_FIELDS",
  );
  requireCondition(object.action === "ADD", "MODEL_PROPOSAL_MUTATION_NOT_ADD");
  requireCondition(object.resourceType === "aws_cloudwatch_log_group",
    "MODEL_PROPOSAL_RESOURCE_UNSUPPORTED");
  requireCondition(object.name === AWS_TERRAFORM_SCENARIO.logGroupName,
    "MODEL_PROPOSAL_NAME_MISMATCH");
  requireCondition(object.retentionDays === AWS_TERRAFORM_SCENARIO.retentionDays,
    "MODEL_PROPOSAL_RETENTION_MISMATCH");
  requireCondition(object.ownership === "NEW_RESOURCE_ONLY",
    "MODEL_PROPOSAL_OWNERSHIP_MISMATCH");
  requireCondition(Array.isArray(object.evidenceRefs) && object.evidenceRefs.length > 0 &&
    object.evidenceRefs.every((key) =>
      typeof key === "string" && evidenceKeys.has(key)),
    "MODEL_PROPOSAL_UNGROUNDED_EVIDENCE");
  return object as RestrictedProposal;
}

export function reviewAwsTerraformProposals(
  primaryRaw: string,
  validatorRaw: string,
  evidenceKeys: readonly string[],
): RestrictedProposal {
  const allowed = new Set(evidenceKeys);
  const primary = parseProposal(primaryRaw, allowed);
  const validator = parseProposal(validatorRaw, allowed);
  requireCondition(
    primary.action === validator.action &&
    primary.resourceType === validator.resourceType &&
    primary.name === validator.name &&
    primary.retentionDays === validator.retentionDays &&
    primary.ownership === validator.ownership,
    "MODEL_PROPOSALS_DISAGREE",
  );
  return {
    ...primary,
    evidenceRefs: [...new Set([...primary.evidenceRefs, ...validator.evidenceRefs])].sort(),
  };
}

export function renderAwsTerraformCandidate(proposal: RestrictedProposal): string {
  // Re-validate the caller's value: no untrusted interpolation or arbitrary HCL.
  reviewAwsTerraformProposals(JSON.stringify(proposal), JSON.stringify(proposal),
    proposal.evidenceRefs);
  return [
    "# ALZ REVIEW CANDIDATE — synthetic brownfield evidence; NOT an applied plan.",
    "# Customer-managed Control Tower/Organizations assets are not declared here.",
    'terraform {',
    '  required_version = ">= 1.6.0"',
    '  required_providers {',
    '    aws = {',
    '      source  = "hashicorp/aws"',
    '      version = ">= 5.0, < 7.0"',
    '    }',
    '  }',
    '}',
    '',
    'variable "aws_region" {',
    '  type = string',
    '}',
    '',
    'provider "aws" {',
    '  region = var.aws_region',
    '}',
    '',
    'resource "aws_cloudwatch_log_group" "alz_audit" {',
    `  name              = "${AWS_TERRAFORM_SCENARIO.logGroupName}"`,
    `  retention_in_days = ${AWS_TERRAFORM_SCENARIO.retentionDays}`,
    '',
    '  tags = {',
    '    ManagedBy = "ALZ-preview-candidate"',
    '  }',
    '}',
    '',
  ].join("\n");
}

function assertLocalEndpoint(url: string): void {
  const parsed = new URL(url);
  requireCondition(
    parsed.protocol === "http:" &&
    ["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname),
    "PRIVATE_MODEL_ENDPOINT_MUST_BE_LOOPBACK",
  );
}

function assertAgentState(state: AgentState): asserts state is AgentState & {
  design: NonNullable<AgentState["design"]>;
  environment: NonNullable<AgentState["environment"]>;
  assessment: NonNullable<AgentState["assessment"]>;
} {
  requireCondition(state.provider === "AWS" && state.engine === "TERRAFORM",
    "KERNEL_PROVIDER_ENGINE_MISMATCH");
  requireCondition(state.environment?.classification === "BROWNFIELD" &&
    state.environment.safeBuildMode === "ADDITIVE_ONLY", "BROWNFIELD_EVIDENCE_INSUFFICIENT");
  requireCondition(state.assessment?.status === "OK" &&
    state.assessment.primary && state.assessment.validator,
    "INDEPENDENT_AGENT_ASSESSMENT_NOT_VERIFIED");
  const invocations = state.assessment.modelInvocations ?? [];
  requireCondition(["ROUTER", "PRIMARY", "VALIDATOR", "ADJUDICATOR"]
    .every((role) => invocations.some((x) => x.role === role && x.schemaValid)),
    "ACTUAL_MODEL_PARTICIPATION_NOT_EVIDENCED");
  requireCondition(state.design?.plugin.plugin === "TERRAFORM" &&
    state.design.provider === "AWS" && state.design.status !== "BLOCKED",
    "TERRAFORM_DESIGN_BLOCKED");
  requireCondition(
    state.action?.executed === false &&
    state.observation?.mutationObserved === false &&
    state.orchestration?.actEnabled === false,
    "MUTATION_BOUNDARY_NOT_VERIFIED",
  );
  requireCondition(state.environment.evidence.every((e) => e.source === "mock"),
    "SCENARIO_EXPECTED_SYNTHETIC_EVIDENCE");
  requireCondition(state.environment.resources.every((r) =>
    r.mutationPolicy !== "DELETE_ALLOWED" && r.ownership !== "UNKNOWN"),
    "BROWNFIELD_OWNERSHIP_BLOCKED");
}

export async function qualifyAwsTerraformAgents(
  input: { sourceCommit: string; outputRoot: string },
  deps: AwsTerraformAgentDeps = defaultDeps,
): Promise<AwsTerraformAgentResult> {
  requireCondition(/^[a-f0-9]{40}$/i.test(input.sourceCommit),
    "RELEASE_SOURCE_COMMIT_REQUIRED");
  requireCondition(process.env.AGENT_SKIP_LOCAL_MODEL !== "1",
    "LIVE_MODEL_EXECUTION_DISABLED");
  const cfg = loadConfig();
  assertLocalEndpoint(cfg.ollamaBaseUrl);
  requireCondition(cfg.routerModel.startsWith("qwen3:") &&
    cfg.primaryModel.startsWith("qwen3:") &&
    cfg.validatorModel.startsWith("mistral-nemo:"),
    "EXPECTED_QWEN_MISTRAL_MODELS_REQUIRED");

  const roles = [
    { role: "ROUTER", tag: cfg.routerModel },
    { role: "PRIMARY", tag: cfg.primaryModel },
    { role: "VALIDATOR", tag: cfg.validatorModel },
  ];
  const models: Array<{ role: string; tag: string; digest: string }> = [];
  for (const role of roles) {
    const info: ModelMetadata = await deps.metadata(cfg.ollamaBaseUrl, role.tag);
    requireCondition(/^[0-9a-f]{64}$/i.test(info.digest),
      "MODEL_DIGEST_UNVERIFIED:" + role.role);
    models.push({ ...role, digest: info.digest });
  }

  const state = await deps.kernel({
    request: AWS_TERRAFORM_SCENARIO.request,
    provider: "AWS",
    engine: "TERRAFORM",
    mock: "brownfield",
    approveBuild: false,
  });
  assertAgentState(state);
  const evidenceKeys = state.environment.evidence.map((e) => e.key);
  const evidence = {
    classification: state.environment.classification,
    safeBuildMode: state.environment.safeBuildMode,
    discovered: state.environment.resources.map((r) => ({
      id: r.resourceId, ownership: r.ownership, policy: r.mutationPolicy,
    })),
    evidence: state.environment.evidence,
    designHash: state.design.designHash,
    policyBundleHash: state.design.policies.bundleHash,
    forbiddenChanges: state.design.forbiddenChanges,
    assumptions: state.design.assumptions,
  };

  const messages = (role: "PROPOSER" | "VALIDATOR") => [
    {
      role: "system" as const,
      content: [
        `You are the ALZ AWS Terraform ${role}. Return JSON only, not HCL.`,
        'Allowed shape: {"action":"ADD","resourceType":"aws_cloudwatch_log_group",',
        '"name":"/alz/preview/brownfield-audit","retentionDays":30,',
        '"ownership":"NEW_RESOURCE_ONLY","evidenceRefs":["aws.control_tower"]}.',
        "Choose ONLY this new resource; customer resources remain NO_TOUCH.",
        "All evidenceRefs must be exact keys in the untrusted evidence snapshot.",
        "Unknown customer KMS details remain UNKNOWN. Do not invent them.",
        "Do not add apply/deploy/shell/credentials/approvals or extra fields.",
      ].join("\n"),
    },
    { role: "user" as const, content: governedUserRequest(AWS_TERRAFORM_SCENARIO.request) },
    { role: "user" as const, content: wrapUntrustedEvidence(JSON.stringify(evidence)) },
  ];

  const [primaryRaw, validatorRaw] = await Promise.all([
    deps.model(cfg.ollamaBaseUrl, cfg.primaryModel, messages("PROPOSER"),
      STRUCTURED_MODEL_OPTIONS),
    deps.model(cfg.ollamaBaseUrl, cfg.validatorModel, messages("VALIDATOR"),
      STRUCTURED_MODEL_OPTIONS),
  ]);
  const proposal = reviewAwsTerraformProposals(primaryRaw, validatorRaw, evidenceKeys);
  const terraform = renderAwsTerraformCandidate(proposal);
  const directory = resolve(input.outputRoot, AWS_TERRAFORM_SCENARIO.id + "-" + randomUUID());
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const artifactPath = resolve(directory, "main.tf");
  const evidencePath = resolve(directory, "qualification.json");
  writeFileSync(artifactPath, terraform, { mode: 0o600, flag: "wx" });
  const result: AwsTerraformAgentResult = {
    scenario: AWS_TERRAFORM_SCENARIO.id,
    sourceCommit: input.sourceCommit,
    mode: "LIVE_LOCAL_MODELS_WITH_SYNTHETIC_AWS_EVIDENCE",
    modelEvidence: models,
    designHash: state.design.designHash,
    policyHash: state.design.policies.bundleHash,
    discoveryHash: sha256(JSON.stringify(evidence)),
    modelProposalHash: sha256(JSON.stringify(proposal)),
    artifactHash: sha256(terraform),
    artifactPath,
    evidencePath,
    status: "REVIEW_REQUIRED",
    terraformValidation: "NOT_RUN",
    terraformPlan: "NOT_RUN",
    approval: "NOT_GRANTED",
    infrastructureAct: "DISABLED",
    mutationObserved: false,
    assumptions: [
      ...state.design.assumptions,
      "New ADD entry is a model proposal, not an approved DesignSpec amendment.",
      "Customer KMS key, account/region, and existing Terraform state remain unknown.",
      "Real Terraform init/validate/plan and live AWS account evidence were not run.",
      "A later Terraform plan must confirm zero updates, deletions, or adoption.",
    ],
  };
  writeFileSync(evidencePath, JSON.stringify(result, null, 2) + "\n",
    { mode: 0o600, flag: "wx" });
  return result;
}
