import { sha256 } from "./provenance.js";
import type { ProvenanceTags } from "../teardown/types.js";
import { provenanceTags } from "../teardown/unit.js";

/**
 * Azure Terraform build, slice 1: one narrow, synthetic scenario that mirrors the AWS audit log group. A proposal can
 * only pick from an allowlist, two independent proposals must agree, and fixed code writes the Terraform. Nothing here
 * reads Azure, holds a credential, runs a plan or applies anything; every result is labeled synthetic.
 */
export const AZURE_TERRAFORM_SCENARIO = {
  id: "azure-greenfield-terraform-audit-workspace-v1",
  request: "Build an additive Azure Terraform preview for an isolated ALZ audit Log Analytics workspace with 30-day " +
    "retention in a new resource group. Produce a reviewed preview candidate only.",
  resourceGroupName: "rg-alz-preview-audit",
  workspaceName: "law-alz-preview-audit",
  sku: "PerGB2018",
  retentionDays: 30,
} as const;

/** The synthetic evidence a proposal may cite. A citation outside this list is refused. */
export const SYNTHETIC_AZURE_EVIDENCE: readonly string[] = [
  "synthetic:azure:subscription-inventory",
  "synthetic:azure:policy-baseline",
  "synthetic:azure:no-existing-audit-workspace",
];

export type AzureRestrictedProposal = {
  action: "ADD";
  resourceType: "azurerm_log_analytics_workspace";
  resourceGroupName: string;
  workspaceName: string;
  retentionDays: number;
  ownership: "NEW_RESOURCE_ONLY";
  evidenceRefs: string[];
};

export type AzureTerraformCandidate = {
  scenario: typeof AZURE_TERRAFORM_SCENARIO.id;
  mode: "SYNTHETIC_AZURE_EVIDENCE";
  proposalHash: string;
  artifactHash: string;
  terraform: string;
  status: "REVIEW_REQUIRED";
  approval: "NOT_GRANTED";
  infrastructureAct: "DISABLED";
  mutationObserved: false;
};

const PROPOSAL_KEYS = ["action", "evidenceRefs", "ownership", "resourceGroupName", "resourceType", "retentionDays", "workspaceName"];

function requireCondition(condition: unknown, code: string): asserts condition {
  if (!condition) throw new Error(code);
}

function parseProposal(raw: string, evidenceKeys: Set<string>): AzureRestrictedProposal {
  let object: unknown;
  try {
    object = JSON.parse(raw);
  } catch {
    throw new Error("MODEL_PROPOSAL_NOT_JSON");
  }
  requireCondition(object && typeof object === "object" && !Array.isArray(object), "MODEL_PROPOSAL_INVALID_OBJECT");
  const value = object as Record<string, unknown>;
  requireCondition(JSON.stringify(Object.keys(value).sort()) === JSON.stringify(PROPOSAL_KEYS), "MODEL_PROPOSAL_UNEXPECTED_FIELDS");
  requireCondition(value.action === "ADD", "MODEL_PROPOSAL_MUTATION_NOT_ADD");
  requireCondition(value.resourceType === "azurerm_log_analytics_workspace", "MODEL_PROPOSAL_RESOURCE_UNSUPPORTED");
  requireCondition(value.resourceGroupName === AZURE_TERRAFORM_SCENARIO.resourceGroupName, "MODEL_PROPOSAL_RESOURCE_GROUP_MISMATCH");
  requireCondition(value.workspaceName === AZURE_TERRAFORM_SCENARIO.workspaceName, "MODEL_PROPOSAL_NAME_MISMATCH");
  requireCondition(value.retentionDays === AZURE_TERRAFORM_SCENARIO.retentionDays, "MODEL_PROPOSAL_RETENTION_MISMATCH");
  requireCondition(value.ownership === "NEW_RESOURCE_ONLY", "MODEL_PROPOSAL_OWNERSHIP_MISMATCH");
  requireCondition(Array.isArray(value.evidenceRefs) && value.evidenceRefs.length > 0 &&
    value.evidenceRefs.every((key) => typeof key === "string" && evidenceKeys.has(key)), "MODEL_PROPOSAL_UNGROUNDED_EVIDENCE");
  return value as AzureRestrictedProposal;
}

/** Two independent proposals must describe the same addition; their evidence citations are merged. */
export function reviewAzureTerraformProposals(primaryRaw: string, validatorRaw: string,
  evidenceKeys: readonly string[] = SYNTHETIC_AZURE_EVIDENCE): AzureRestrictedProposal {
  const allowed = new Set(evidenceKeys);
  const primary = parseProposal(primaryRaw, allowed);
  const validator = parseProposal(validatorRaw, allowed);
  requireCondition(
    primary.action === validator.action &&
    primary.resourceType === validator.resourceType &&
    primary.resourceGroupName === validator.resourceGroupName &&
    primary.workspaceName === validator.workspaceName &&
    primary.retentionDays === validator.retentionDays &&
    primary.ownership === validator.ownership,
    "MODEL_PROPOSALS_DISAGREE",
  );
  return { ...primary, evidenceRefs: [...new Set([...primary.evidenceRefs, ...validator.evidenceRefs])].sort() };
}

/**
 * The tag map, padded the way `terraform fmt` aligns it. Provenance values are re-validated, so nothing but tag-safe
 * text reaches the HCL. This mirrors the AWS renderer, whose formatter is private to that module.
 */
function renderTagBlock(provenance?: ProvenanceTags): string[] {
  const entries: Array<[string, string]> = [["ManagedBy", '"ALZ-preview-candidate"']];
  if (provenance) {
    const checked = provenanceTags({
      unitId: provenance["alz-unit"],
      buildId: provenance["alz-build"],
      expires: provenance["alz-expires"],
    });
    for (const [key, value] of Object.entries(checked)) entries.push(['"' + key + '"', '"' + value + '"']);
  }
  const width = Math.max(...entries.map(([key]) => key.length));
  return entries.map(([key, value]) => "    " + key.padEnd(width) + " = " + value);
}

/** Fixed Terraform for the reviewed proposal. Without `provenance` the text, and so its hash, never changes. */
export function renderAzureTerraformCandidate(proposal: AzureRestrictedProposal, provenance?: ProvenanceTags): string {
  // Re-validate the caller's value: no untrusted interpolation or arbitrary HCL.
  reviewAzureTerraformProposals(JSON.stringify(proposal), JSON.stringify(proposal), proposal.evidenceRefs);
  const tags = renderTagBlock(provenance);
  const s = AZURE_TERRAFORM_SCENARIO;
  return [
    "# ALZ REVIEW CANDIDATE — synthetic Azure evidence; NOT an applied plan.",
    "# Existing subscriptions, management groups and policy assignments are not declared here.",
    "terraform {",
    '  required_version = ">= 1.6.0"',
    "  required_providers {",
    "    azurerm = {",
    '      source  = "hashicorp/azurerm"',
    '      version = ">= 4.0, < 5.0"',
    "    }",
    "  }",
    "}",
    "",
    'variable "location" {',
    "  type = string",
    "}",
    "",
    'provider "azurerm" {',
    "  features {}",
    "}",
    "",
    'resource "azurerm_resource_group" "alz_audit" {',
    `  name     = "${s.resourceGroupName}"`,
    "  location = var.location",
    "",
    "  tags = {",
    ...tags,
    "  }",
    "}",
    "",
    'resource "azurerm_log_analytics_workspace" "alz_audit" {',
    `  name                = "${s.workspaceName}"`,
    "  location            = azurerm_resource_group.alz_audit.location",
    "  resource_group_name = azurerm_resource_group.alz_audit.name",
    `  sku                 = "${s.sku}"`,
    `  retention_in_days   = ${s.retentionDays}`,
    "",
    "  tags = {",
    ...tags,
    "  }",
    "}",
    "",
  ].join("\n");
}

/** The whole synthetic journey: review two proposals, render, hash, and return a labeled, non-approved candidate. */
export function buildAzureTerraformCandidate(primaryRaw: string, validatorRaw: string,
  provenance?: ProvenanceTags): AzureTerraformCandidate {
  const proposal = reviewAzureTerraformProposals(primaryRaw, validatorRaw);
  const terraform = renderAzureTerraformCandidate(proposal, provenance);
  return {
    scenario: AZURE_TERRAFORM_SCENARIO.id,
    mode: "SYNTHETIC_AZURE_EVIDENCE",
    proposalHash: sha256(JSON.stringify(proposal)),
    artifactHash: sha256(terraform),
    terraform,
    status: "REVIEW_REQUIRED",
    approval: "NOT_GRANTED",
    infrastructureAct: "DISABLED",
    mutationObserved: false,
  };
}
