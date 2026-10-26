import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  AZURE_TERRAFORM_SCENARIO,
  buildAzureTerraformCandidate,
  renderAzureTerraformCandidate,
  reviewAzureTerraformProposals,
  SYNTHETIC_AZURE_EVIDENCE,
} from "../src/build/azure-terraform.js";
import { sha256 } from "../src/build/provenance.js";
import { provenanceTags } from "../src/teardown/unit.js";

// Synthetic journey only: no Azure access, no credential, no plan and no apply. The proposals stand in for two
// independent model answers; the renderer, not the proposal, writes every line of Terraform.

const proposal = (overrides: Record<string, unknown> = {}): string => JSON.stringify({
  action: "ADD",
  resourceType: "azurerm_log_analytics_workspace",
  resourceGroupName: AZURE_TERRAFORM_SCENARIO.resourceGroupName,
  workspaceName: AZURE_TERRAFORM_SCENARIO.workspaceName,
  retentionDays: AZURE_TERRAFORM_SCENARIO.retentionDays,
  ownership: "NEW_RESOURCE_ONLY",
  evidenceRefs: ["synthetic:azure:subscription-inventory"],
  ...overrides,
});

test("two agreeing proposals build a labeled, unapproved candidate whose hash is the Terraform's own hash", () => {
  const candidate = buildAzureTerraformCandidate(proposal(), proposal({ evidenceRefs: ["synthetic:azure:policy-baseline"] }));
  assert.equal(candidate.mode, "SYNTHETIC_AZURE_EVIDENCE");
  assert.equal(candidate.status, "REVIEW_REQUIRED");
  assert.equal(candidate.approval, "NOT_GRANTED");
  assert.equal(candidate.infrastructureAct, "DISABLED");
  assert.equal(candidate.mutationObserved, false);
  assert.equal(candidate.artifactHash, sha256(candidate.terraform));
  assert.match(candidate.terraform, /^# ALZ REVIEW CANDIDATE — synthetic Azure evidence; NOT an applied plan\./);
  assert.match(candidate.terraform, /resource "azurerm_resource_group" "alz_audit"/);
  assert.match(candidate.terraform, /resource "azurerm_log_analytics_workspace" "alz_audit"/);
  assert.match(candidate.terraform, /retention_in_days\s+= 30/);
  assert.doesNotMatch(candidate.terraform, /subscription_id|client_secret|tenant_id/, "no identity is written into the code");
});

test("the same proposals always render the same Terraform, and provenance changes the text and hash", () => {
  const plain = buildAzureTerraformCandidate(proposal(), proposal());
  assert.equal(buildAzureTerraformCandidate(proposal(), proposal()).artifactHash, plain.artifactHash);
  const tags = provenanceTags({ unitId: "unit-azure-audit", buildId: "build-0001" });
  const stamped = buildAzureTerraformCandidate(proposal(), proposal(), tags);
  assert.notEqual(stamped.artifactHash, plain.artifactHash);
  assert.match(stamped.terraform, /"alz-unit"\s+= "unit-azure-audit"/);
  assert.match(stamped.terraform, /"alz-build"\s+= "build-0001"/);
  assert.equal(stamped.terraform.match(/"alz-unit"/g)?.length, 2, "both resources carry the unit tag");
});

test("a proposal that adds a field, changes anything, or cites evidence outside the list is refused by name", () => {
  const cases: Array<[string, string]> = [
    [proposal({ extra: true }), "MODEL_PROPOSAL_UNEXPECTED_FIELDS"],
    [proposal({ action: "REMOVE" }), "MODEL_PROPOSAL_MUTATION_NOT_ADD"],
    [proposal({ resourceType: "azurerm_storage_account" }), "MODEL_PROPOSAL_RESOURCE_UNSUPPORTED"],
    [proposal({ resourceGroupName: "rg-customer" }), "MODEL_PROPOSAL_RESOURCE_GROUP_MISMATCH"],
    [proposal({ workspaceName: "law-other" }), "MODEL_PROPOSAL_NAME_MISMATCH"],
    [proposal({ retentionDays: 90 }), "MODEL_PROPOSAL_RETENTION_MISMATCH"],
    [proposal({ ownership: "EXISTING_RESOURCE" }), "MODEL_PROPOSAL_OWNERSHIP_MISMATCH"],
    [proposal({ evidenceRefs: ["real:azure:subscription"] }), "MODEL_PROPOSAL_UNGROUNDED_EVIDENCE"],
    [proposal({ evidenceRefs: [] }), "MODEL_PROPOSAL_UNGROUNDED_EVIDENCE"],
    ["not json", "MODEL_PROPOSAL_NOT_JSON"],
    ["[]", "MODEL_PROPOSAL_INVALID_OBJECT"],
  ];
  for (const [raw, code] of cases) {
    assert.throws(() => reviewAzureTerraformProposals(raw, proposal()), new RegExp("^Error: " + code + "$"), code);
    assert.throws(() => reviewAzureTerraformProposals(proposal(), raw), new RegExp("^Error: " + code + "$"), code);
  }
});

test("proposals may differ only in cited evidence: any other difference is refused, so one answer alone builds nothing", () => {
  const reviewed = reviewAzureTerraformProposals(proposal(), proposal({ evidenceRefs: ["synthetic:azure:policy-baseline"] }));
  assert.deepEqual(reviewed.evidenceRefs, ["synthetic:azure:policy-baseline", "synthetic:azure:subscription-inventory"],
    "evidence from both answers is kept");
  assert.throws(() => reviewAzureTerraformProposals(proposal(), proposal({ retentionDays: 90 })), /MODEL_PROPOSAL_RETENTION_MISMATCH/);
  assert.throws(() => reviewAzureTerraformProposals(proposal({ workspaceName: "law-x" }), proposal()), /MODEL_PROPOSAL_NAME_MISMATCH/);
});

test("the renderer re-checks its input and refuses tag values that are not tag-safe", () => {
  const reviewed = reviewAzureTerraformProposals(proposal(), proposal());
  assert.throws(() => renderAzureTerraformCandidate({ ...reviewed, workspaceName: 'x" }\nresource "evil" "y" {' }),
    /MODEL_PROPOSAL_NAME_MISMATCH/);
  assert.throws(() => provenanceTags({ unitId: "Unit With Spaces", buildId: "b" }), /UNIT_ID_NOT_TAG_SAFE/);
});

test("the synthetic evidence list is fixed and every entry is marked synthetic", () => {
  assert.ok(SYNTHETIC_AZURE_EVIDENCE.length > 0);
  for (const key of SYNTHETIC_AZURE_EVIDENCE) assert.match(key, /^synthetic:azure:/);
});

test("the build module reads no network, process, file system or credential module", () => {
  const source = readFileSync(resolve(import.meta.dirname, "..", "src", "build", "azure-terraform.ts"), "utf8");
  const imports = [...source.matchAll(/from\s+"([^"]+)"/g)].map((match) => match[1]).sort();
  assert.deepEqual(imports, ["../teardown/types.js", "../teardown/unit.js", "./provenance.js"]);
});

test("the rendered Terraform is already in canonical terraform fmt layout", (t) => {
  const terraform = process.env.ALZ_TERRAFORM_BIN;
  if (!terraform) {
    t.skip("set ALZ_TERRAFORM_BIN to a terraform binary to check the layout; nothing is downloaded by this test");
    return;
  }
  const tags = provenanceTags({ unitId: "unit-azure-audit", buildId: "build-0001", expires: "2026-12-31" });
  for (const text of [buildAzureTerraformCandidate(proposal(), proposal()).terraform,
    buildAzureTerraformCandidate(proposal(), proposal(), tags).terraform]) {
    const formatted = execFileSync(terraform, ["fmt", "-"], { input: text, encoding: "utf8" });
    assert.equal(formatted, text, "terraform fmt would change the rendered file");
  }
});

test("the rendered Terraform passes terraform validate against a supplied, checksum-verified azurerm provider", (t) => {
  const terraform = process.env.ALZ_TERRAFORM_BIN;
  const plugins = process.env.ALZ_AZURERM_PLUGIN_DIR;
  if (!terraform || !plugins) {
    t.skip("set ALZ_TERRAFORM_BIN and ALZ_AZURERM_PLUGIN_DIR (a provider folder verified against HashiCorp's SHA256SUMS); " +
      "this test downloads nothing and contacts no Azure account");
    return;
  }
  const dir = mkdtempSync(join(tmpdir(), "alz-azure-validate-"));
  try {
    const tags = provenanceTags({ unitId: "unit-azure-audit", buildId: "build-0001" });
    writeFileSync(join(dir, "main.tf"), buildAzureTerraformCandidate(proposal(), proposal(), tags).terraform);
    const env = { PATH: process.env.PATH ?? "", HOME: dir, TF_IN_AUTOMATION: "1" };
    execFileSync(terraform, ["init", "-backend=false", "-input=false", "-no-color", "-plugin-dir=" + plugins], { cwd: dir, env, stdio: "pipe" });
    const result = execFileSync(terraform, ["validate", "-no-color"], { cwd: dir, env, encoding: "utf8" });
    assert.match(result, /The configuration is valid/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
