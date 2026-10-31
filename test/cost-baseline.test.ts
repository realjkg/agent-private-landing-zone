import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { fixtureThinker } from "../src/agent/fixture.js";
import { runAgentKernel } from "../src/agent/graph.js";
import type { AgentState } from "../src/agent/types.js";
import {
  AWS_COST_BASELINE_SCENARIO,
  COST_BASELINE_AWS_PROVIDER_VERSION,
  renderAwsCostBaseline,
  reviewCostBaselineProposals,
} from "../src/build/cost-baseline.js";
import {
  APPROVED_PRIVATE_BUILD_SCENARIOS,
  AWS_COST_BASELINE_RESOURCE_ID,
  runRealPrivateModelBuild,
  type ActualCostBaselineValidation,
  type RealPrivateBuildDeps,
} from "../src/build/private-model.js";
import { sha256 } from "../src/build/provenance.js";
import { collectRepositoryEvidence } from "../src/build/repository.js";
import { resolveCostConfig, type CostConfig } from "../src/design/cost.js";
import { AWS_TERRAFORM_SCENARIO } from "../src/qualification/aws-terraform-agent.js";
import type { DeletionUnitStateRef, PlannedTags, ProvenanceTags } from "../src/teardown/types.js";

// Every value here is synthetic. Nothing in this file reads AWS, holds a credential or runs a plan against a cloud.

const FIXTURES = resolve(import.meta.dirname, "fixtures", "cost-baseline");
const UNIT_TAGS: ProvenanceTags = { "alz-managed-by": "alz", "alz-unit": "alzu-0123456789abcdef0123", "alz-build": "build-0001" };

const base = {
  owner: "platform-team",
  notifications: { emails: ["finops@example.com", "ops@example.com"] },
  tags: { "cost-center": "cc-1234", environment: "dev" },
  budget: { amount: "250" },
  review: { reviewBy: "2027-01-31" },
};
const VARIANTS: Record<string, { config: unknown; provenance?: ProvenanceTags }> = {
  defaults: { config: base, provenance: UNIT_TAGS },
  "adopt-existing": { config: { ...base,
    notifications: { route: "EXISTING_SNS_TOPIC", snsTopicArn: "arn:aws:sns:eu-west-1:123456789012:billing-alerts",
      emails: ["cfo@example.com"] },
    export: { mode: "ADOPT_EXISTING", bucketName: "corp-billing-exports", bucketRegion: "eu-west-1", granularity: "HOURLY" },
    analytics: "ON" } },
  "budget-action": { config: { ...base,
    notifications: { route: "EMAIL_DIRECT", emails: ["finops@example.com"] },
    budget: { amount: "1000", currency: "USD", period: "QUARTERLY", actualThresholds: [50, 90], forecastThresholds: [100] },
    budgetAction: { enabled: true, type: "APPLY_IAM_POLICY", thresholdPercent: 100,
      executionRoleArn: "arn:aws:iam::123456789012:role/alz-budget-action",
      policyArn: "arn:aws:iam::123456789012:policy/alz-deny-new-compute", roles: ["workload-deployer"] },
    export: { bucketName: "acme-cost-export", retentionDays: 90 } } },
  "kms-and-tag-activation": { config: { ...base, notifications: { ...base.notifications, encryption: "CUSTOMER_KMS" },
    activateCostAllocationTags: true } },
};
const render = (name: string) => renderAwsCostBaseline(VARIANTS[name].config as CostConfig, VARIANTS[name].provenance);

test("each golden is its own Terraform module, so a scanner never merges alternative baselines", () => {
  // Trivy (and Terraform) treat every .tf file in one directory as one module. Alternative goldens side by side read as
  // one module with duplicate resources, and the scan then misattributes findings (COST-1c, AWS-0086 to AWS-0093).
  assert.deepEqual(readdirSync(FIXTURES).sort(), Object.keys(VARIANTS).sort());
  for (const name of Object.keys(VARIANTS)) {
    assert.deepEqual(readdirSync(join(FIXTURES, name)).filter((file) => /\.tf(?:\.json)?$/.test(file)), ["main.tf"], name);
  }
});

test("the rendered baselines match their reviewed golden files byte for byte", () => {
  for (const name of Object.keys(VARIANTS)) {
    const golden = readFileSync(join(FIXTURES, name, "main.tf"), "utf8");
    assert.equal(render(name).terraform, golden, name + " drifted from test/fixtures/cost-baseline/" + name + "/main.tf");
  }
  const metadata = JSON.parse(readFileSync(join(FIXTURES, "defaults", "metadata.json"), "utf8"));
  assert.deepEqual(render("defaults").metadata, metadata);
});

test("the default baseline: notify-only budget, SNS route, new private export bucket, default tags, no tag activation", () => {
  const { terraform, metadata } = render("defaults");
  assert.equal(metadata.artifactHash, sha256(terraform));
  assert.equal(metadata.awsProviderVersion, "6.68.0");
  assert.match(terraform, new RegExp('version = "' + COST_BASELINE_AWS_PROVIDER_VERSION + '"'));
  assert.equal(terraform.match(/notification \{/g)?.length, 3, "two actual and one forecast notification");
  assert.equal(terraform.match(/notification_type\s+= "FORECASTED"/g)?.length, 1);
  assert.doesNotMatch(terraform, /aws_budgets_budget_action/, "no budget action unless configured");
  assert.match(terraform, /resource "aws_sns_topic_policy" "cost_alerts"/);
  assert.match(terraform, /budgets\.amazonaws\.com/);
  assert.match(terraform, /bcm-data-exports\.amazonaws\.com", "billingreports\.amazonaws\.com/);
  assert.match(terraform, /arn:aws:bcm-data-exports:us-east-1:\$\{data\.aws_caller_identity\.current\.account_id\}:export\/\*/);
  assert.match(terraform, /aws:SecureTransport/);
  assert.match(terraform, /TIME_GRANULARITY\s+= "DAILY"/);
  assert.match(terraform, /days = 400/);
  assert.equal(terraform.match(/default_tags \{/g)?.length, 2, "both providers carry the tags");
  for (const line of ['"alz-unit"       = "alzu-0123456789abcdef0123"', '"cost-center"    = "cc-1234"', '"owner"          = "platform-team"']) {
    assert.equal(terraform.split(line).length - 1, 2, line);
  }
  assert.equal(terraform.match(/provider = aws\.billing/g)?.length, 1, "the export uses us-east-1");
  assert.deepEqual(metadata.crossRegionDependencies.map((d) => [d.service, d.region, d.addresses]), [
    ["bcm-data-exports", "us-east-1", ["aws_bcmdataexports_export.cur2"]],
  ]);
  // N1: activation fails in a fresh or member account, so the default never renders it, and says when to enable it.
  assert.doesNotMatch(terraform, /aws_ce_cost_allocation_tag/);
  assert.equal(metadata.costAllocationTagActivation.rendered, false);
  assert.deepEqual(metadata.costAllocationTagActivation.keys, ["cost-center", "environment", "owner"]);
  assert.match(metadata.costAllocationTagActivation.when, /management account or a standalone account/);
  assert.match(metadata.costAllocationTagActivation.when, /turn it on in a later build/);
  assert.ok(metadata.creates.every((item) => item.type !== "aws_ce_cost_allocation_tag"));
  // N7: a member account can export its own data; only tag activation is limited to the management account.
  assert.ok(metadata.prerequisites.some((item) => /member account covers only that account's own cost and usage/.test(item)));
  assert.ok(!metadata.prerequisites.some((item) => /export run in the AWS Organizations management/.test(item)));
  // The new topic is unencrypted by default (owner decision 2026-10-31; Trivy AWS-0095 is ignored for this golden only),
  // and the metadata says how to opt in.
  assert.equal(metadata.notifications.encryption, "NONE");
  assert.doesNotMatch(terraform, /aws_kms_key|kms_master_key_id/);
  assert.ok(metadata.prerequisites.some((item) => /not encrypted .*set notifications\.encryption to CUSTOMER_KMS/.test(item)));
  // The export bucket stays SSE-S3 (see .trivyignore.yaml, AWS-0132), and says so where it is rendered.
  assert.match(terraform, /# SSE-S3, as in the AWS Cloud Intelligence Dashboards data-exports destination bucket\./);
  // N6: per-baseline names, and the bucket is never force-destroyed.
  assert.match(metadata.naming.suffix, /^[a-f0-9]{8}$/);
  assert.match(terraform, new RegExp('name = "alz-cost-alerts-' + metadata.naming.suffix + '"'));
  assert.match(terraform, new RegExp('bucket        = "alz-cost-export-' + metadata.naming.suffix + '-\\$\\{'));
  assert.match(terraform, /force_destroy = false/);
  assert.equal(metadata.teardown.exportBucketForceDestroy, false);
  assert.equal(metadata.naming.topicName, "alz-cost-alerts-" + metadata.naming.suffix);
  assert.equal(metadata.budget.control, "ALERT_ONLY");
  assert.equal(metadata.export.delivery, "AT_LEAST_DAILY");
  assert.equal(metadata.analytics, "OFF");
  assert.equal(metadata.notifications.emailConfirmationRequired, true);
  assert.equal(metadata.infrastructureAct, "DISABLED");
  assert.match(terraform, /^# A budget sends alerts; it is not a hard cap\./m, "the control is named accurately");
});

test("adopting an existing bucket renders no bucket, and an adopted topic renders no topic", () => {
  const { terraform, metadata } = render("adopt-existing");
  assert.doesNotMatch(terraform, /resource "aws_s3_bucket/);
  assert.doesNotMatch(terraform, /resource "aws_sns_topic/);
  assert.match(terraform, /s3_bucket\s+= "corp-billing-exports"/);
  assert.match(terraform, /s3_region\s+= "eu-west-1"/);
  assert.match(terraform, /TIME_GRANULARITY\s+= "HOURLY"/);
  assert.match(terraform, /subscriber_sns_topic_arns\s+= \["arn:aws:sns:eu-west-1:123456789012:billing-alerts"\]/);
  assert.match(terraform, /subscriber_email_addresses\s+= \["cfo@example\.com"\]/);
  assert.equal(metadata.export.retentionDays, null);
  assert.equal(metadata.analytics, "REQUESTED_SEPARATE_PACK");
  assert.ok(metadata.prerequisites.some((item) => /adopted bucket's policy/.test(item)));
  assert.ok(metadata.prerequisites.some((item) => /adopted SNS topic's policy/.test(item)));
  assert.ok(metadata.creates.every((item) => !item.type.startsWith("aws_s3_") && !item.type.startsWith("aws_sns_")));
  // N3: on this route the emails are direct budget subscribers, so nobody confirms an SNS subscription.
  assert.equal(metadata.notifications.emailConfirmationRequired, false);
  assert.ok(!metadata.prerequisites.some((item) => /confirm the SNS subscription/.test(item)));
  assert.equal(metadata.notifications.encryption, "OWNER_MANAGED");
  assert.equal(metadata.naming.topicName, null);
  assert.equal(metadata.naming.bucketName, "corp-billing-exports");
});

test("an explicit encryption NONE renders the same unencrypted topic as the default, and no key", () => {
  const { terraform, metadata } = renderAwsCostBaseline(resolveCostConfig({ ...base,
    notifications: { ...base.notifications, encryption: "NONE" } }));
  assert.equal(terraform, renderAwsCostBaseline(resolveCostConfig(base)).terraform);
  assert.doesNotMatch(terraform, /aws_kms_key|kms_master_key_id/);
  assert.equal(metadata.notifications.encryption, "NONE");
  assert.equal(metadata.teardown.kmsKeyDeletionWindowDays, null);
  assert.ok(metadata.creates.every((item) => item.type !== "aws_kms_key"));
});

test("KMS encryption and opt-in tag activation render the key, its policy, and the us-east-1 activation", () => {
  const { terraform, metadata } = render("kms-and-tag-activation");
  assert.match(terraform, /resource "aws_kms_key" "cost_alerts"/);
  assert.match(terraform, /enable_key_rotation\s+= true/);
  assert.match(terraform, /kms_master_key_id = aws_kms_key\.cost_alerts\.arn/);
  assert.match(terraform, /Principal = \{ Service = "budgets\.amazonaws\.com" \}\n\s+Action\s+= \["kms:GenerateDataKey\*", "kms:Decrypt"\]/);
  assert.doesNotMatch(terraform, /sns\.amazonaws\.com/, "only the publisher needs the key");
  assert.match(terraform, /ArnLike\s+= \{ "aws:SourceArn" = "arn:aws:budgets::\$\{data\.aws_caller_identity\.current\.account_id\}:\*" \}/);
  assert.ok(metadata.prerequisites.some((item) => /new customer-managed KMS key, which carries a monthly key charge/.test(item)));
  assert.doesNotMatch(terraform, /alias\/aws\/sns/);
  assert.equal(metadata.notifications.encryption, "CUSTOMER_KMS");
  assert.equal(metadata.teardown.kmsKeyDeletionWindowDays, 30);
  assert.ok(metadata.creates.some((item) => item.address === "aws_kms_key.cost_alerts" && item.taggable));
  assert.equal(terraform.match(/provider = aws\.billing/g)?.length, 2);
  assert.match(terraform, /resource "aws_ce_cost_allocation_tag" "required"/);
  assert.equal(metadata.costAllocationTagActivation.rendered, true);
  assert.deepEqual(metadata.crossRegionDependencies.map((d) => d.service), ["bcm-data-exports", "ce"]);
});

test("the name suffix follows the budget and export names, not the amounts, so edits never rename resources", () => {
  const suffix = (config: unknown) => renderAwsCostBaseline(resolveCostConfig(config)).metadata.naming.suffix;
  assert.equal(suffix(base), suffix({ ...base, budget: { amount: "999", actualThresholds: [50] } }));
  assert.equal(suffix(base), renderAwsCostBaseline(resolveCostConfig(base), UNIT_TAGS).metadata.naming.suffix);
  assert.notEqual(suffix(base), suffix({ ...base, budget: { amount: "250", name: "team-b-budget" } }));
  assert.notEqual(suffix(base), suffix({ ...base, export: { exportName: "team-b-cur2" } }));
});

test("an opted-in budget action is rendered with its effect shown, and manual approval by default", () => {
  const { terraform, metadata } = render("budget-action");
  assert.match(terraform, /resource "aws_budgets_budget_action" "cost_baseline"/);
  assert.match(terraform, /approval_model\s+= "MANUAL"/);
  assert.match(terraform, /# Opt-in budget action\. Effect: When actual spend reaches 100% of 1000\.00 USD \(quarterly\)/);
  assert.match(terraform, /subscription_type = "EMAIL"/);
  assert.equal(metadata.budget.control, "ALERT_AND_BUDGET_ACTION");
  assert.match(metadata.budgetAction.effect, /after a person approves/);
  assert.match(terraform, /bucket        = "acme-cost-export"/);
  assert.match(terraform, /days = 90/);
});

test("without deletion-unit tags the default tags hold only the cost tags; the renderer re-validates its input", () => {
  const { terraform } = renderAwsCostBaseline(resolveCostConfig(base));
  assert.doesNotMatch(terraform, /alz-unit/);
  const forged = { ...resolveCostConfig(base), tags: { ...resolveCostConfig(base).tags, team: '"} provisioner' } };
  assert.throws(() => renderAwsCostBaseline(forged), /COST_CONFIG_INVALID: tags\.team INVALID_VALUE/);
  const badAmount = { ...resolveCostConfig(base), budget: { ...resolveCostConfig(base).budget, amount: "${var.x}" } };
  assert.throws(() => renderAwsCostBaseline(badAmount), /COST_CONFIG_INVALID: budget\.amount INVALID/);
  assert.throws(() => renderAwsCostBaseline(resolveCostConfig(base), { ...UNIT_TAGS, "alz-unit": 'x" }' }),
    /DELETION_UNIT_INVALID:UNIT_ID_NOT_TAG_SAFE/);
});

// --- Proposals ----------------------------------------------------------------------------------------------------

const EVIDENCE = ["aws.identity", "aws.organizations"];
const proposalFor = (config: CostConfig, extra: Record<string, unknown> = {}) => JSON.stringify({
  action: "ADD", scenario: AWS_COST_BASELINE_SCENARIO.id, budgetAmount: config.budget.amount,
  currency: config.budget.currency, period: config.budget.period, actualThresholds: config.budget.actualThresholds,
  forecastThresholds: config.budget.forecastThresholds, ownership: "NEW_RESOURCE_ONLY", evidenceRefs: ["aws.identity"],
  ...extra,
});

test("a model can confirm the owner's values but never change them, add fields or cite unknown evidence", () => {
  const config = resolveCostConfig(base);
  const ok = reviewCostBaselineProposals(proposalFor(config), proposalFor(config, { evidenceRefs: ["aws.organizations"] }),
    config, EVIDENCE);
  assert.deepEqual(ok.evidenceRefs, ["aws.identity", "aws.organizations"]);
  for (const [extra, code] of [
    [{ budgetAmount: "9999.00" }, "MODEL_PROPOSAL_BUDGET_AMOUNT_MISMATCH"],
    [{ actualThresholds: [100] }, "MODEL_PROPOSAL_ACTUAL_THRESHOLDS_MISMATCH"],
    [{ forecastThresholds: [] }, "MODEL_PROPOSAL_FORECAST_THRESHOLDS_MISMATCH"],
    [{ period: "ANNUALLY" }, "MODEL_PROPOSAL_PERIOD_MISMATCH"],
    [{ currency: "EUR" }, "MODEL_PROPOSAL_CURRENCY_MISMATCH"],
    [{ action: "DELETE" }, "MODEL_PROPOSAL_MUTATION_NOT_ADD"],
    [{ scenario: "aws-brownfield-terraform-private-agents-v1" }, "MODEL_PROPOSAL_SCENARIO_MISMATCH"],
    [{ hcl: "resource {}" }, "MODEL_PROPOSAL_UNEXPECTED_FIELDS"],
    [{ evidenceRefs: ["aws.invented"] }, "MODEL_PROPOSAL_UNGROUNDED_EVIDENCE"],
  ] as const) {
    assert.throws(() => reviewCostBaselineProposals(proposalFor(config), proposalFor(config, extra), config, EVIDENCE),
      new RegExp(code));
  }
  assert.throws(() => reviewCostBaselineProposals("not json", proposalFor(config), config, EVIDENCE), /MODEL_PROPOSAL_NOT_JSON/);
});

// --- Registration in the private-model build gate -----------------------------------------------------------------

async function reviewedState(request: string): Promise<AgentState> {
  const state = await runAgentKernel({ request, provider: "AWS", engine: "TERRAFORM", mock: "brownfield",
    thinker: fixtureThinker });
  assert.ok(state.environment && state.design && state.assessment);
  state.mock = undefined;
  state.action = undefined;
  state.environment.evidence = [
    { key: "aws.identity", value: "authenticated", source: "aws-cli" },
    { key: "aws.organizations", value: "present", source: "aws-cli" },
  ];
  state.environment.warnings = [];
  state.design.additions = [AWS_COST_BASELINE_RESOURCE_ID];
  state.assessment.modelInvocations = ["ROUTER", "PRIMARY", "VALIDATOR", "ADJUDICATOR"].map((role) => ({
    role: role as "ROUTER" | "PRIMARY" | "VALIDATOR" | "ADJUDICATOR",
    model: role === "VALIDATOR" ? "mistral-nemo:12b" : role === "PRIMARY" ? "qwen3:4b" : "qwen3:1.7b",
    durationMs: 0, structuredOutput: true as const, schemaValid: true as const,
  }));
  return state;
}

function costDeps(options: { proposal?: (config: CostConfig) => string; createdAddresses?: (expected: string[]) => string[];
  createOnly?: boolean; plannedTags?: (expected: string[], hcl: string) => ActualCostBaselineValidation["plannedTags"] } = {}):
  RealPrivateBuildDeps & { calls: { model: number; validate: number } } {
  const calls = { model: 0, validate: 0 };
  const config = resolveCostConfig(base);
  return {
    calls,
    costConfig: base,
    metadata: async (_url, model) => ({ model, digest: "a".repeat(64), size: 1024 }),
    model: async () => { calls.model += 1; return (options.proposal ?? proposalFor)(config); },
    repositoryEvidence: collectRepositoryEvidence,
    validate: async () => { throw new Error("MUST_NOT_RUN_LOG_GROUP_DRIVER"); },
    validateCostBaseline: async (hcl) => {
      calls.validate += 1;
      const expected = renderAwsCostBaseline(config).metadata.creates.map((item) => item.address);
      return {
        mode: "REAL_TERRAFORM_FMT_VALIDATE_PLAN", infrastructureApplied: false, terraformVersion: "1.16.4",
        validatedArtifactHash: sha256(hcl), validationOutputHash: "b".repeat(64), realPlanEvidenceHash: "c".repeat(64),
        normalizedChangeSetHash: "d".repeat(64), createOnly: options.createOnly ?? true,
        createdAddresses: options.createdAddresses ? options.createdAddresses(expected) : expected,
        ...(options.plannedTags ? { plannedTags: options.plannedTags(expected, hcl) } : {}),
      };
    },
  };
}

test("the cost baseline is a registered scenario; any other request is still refused before inference", async () => {
  assert.deepEqual([...APPROVED_PRIVATE_BUILD_SCENARIOS], [AWS_TERRAFORM_SCENARIO.id, AWS_COST_BASELINE_SCENARIO.id]);
  const state = await reviewedState(AWS_COST_BASELINE_SCENARIO.request);
  const deps = costDeps();
  const built = await runRealPrivateModelBuild(state, deps);
  assert.equal(built.executionMode, "PREVIEW_ONLY");
  assert.equal(built.gate.allowed, false, "human approval is still required");
  assert.equal(built.candidate.artifact.path, "generated/cost-baseline/main.tf");
  assert.equal(built.candidate.artifact.contentHash, sha256(renderAwsCostBaseline(resolveCostConfig(base)).terraform));
  const summary = JSON.parse(built.previewSummary);
  assert.equal(summary.scenario, AWS_COST_BASELINE_SCENARIO.id);
  assert.equal(summary.budgetControl, "ALERT_ONLY");
  assert.deepEqual(summary.crossRegionDependencies, ["bcm-data-exports@us-east-1"]);
  assert.equal(summary.costConfigHash, renderAwsCostBaseline(resolveCostConfig(base)).metadata.configHash);
  assert.equal(summary.designAmendment, "ALREADY_PROPOSED");
  assert.deepEqual(deps.calls, { model: 2, validate: 1 });

  for (const request of ["Deploy arbitrary roles and users", AWS_COST_BASELINE_SCENARIO.request + " Also open port 22."]) {
    const refused = costDeps();
    await assert.rejects(runRealPrivateModelBuild({ ...state, request }, refused), /UNAPPROVED_SCENARIO/);
    assert.deepEqual(refused.calls, { model: 0, validate: 0 });
  }
  await assert.rejects(runRealPrivateModelBuild({ ...state, mock: "brownfield" }, costDeps()), /UNAPPROVED_SCENARIO/);
  await assert.rejects(runRealPrivateModelBuild({ ...state, engine: "PULUMI" }, costDeps()), /UNAPPROVED_SCENARIO/);
});

test("the cost scenario fails closed before inference without a valid configuration, an approved design or a driver", async () => {
  const cases: Array<[string, () => Promise<AgentState>, RealPrivateBuildDeps & { calls: { model: number } }]> = [
    ["COST_CONFIG_MISSING", () => reviewedState(AWS_COST_BASELINE_SCENARIO.request),
      { ...costDeps(), costConfig: undefined }],
    ["COST_CONFIG_INVALID:COST_CONFIG_INVALID: tags.environment REQUIRED", () => reviewedState(
      AWS_COST_BASELINE_SCENARIO.request), { ...costDeps(), costConfig: { ...base, tags: { "cost-center": "cc-1234" } } }],
    ["LIVE_DESIGN_OR_OWNERSHIP_NOT_APPROVED", async () => {
      const state = await reviewedState(AWS_COST_BASELINE_SCENARIO.request);
      state.design!.forbiddenChanges = [AWS_COST_BASELINE_RESOURCE_ID];
      return state;
    }, costDeps()],
    ["LIVE_DESIGN_OR_OWNERSHIP_NOT_APPROVED", async () => {
      const state = await reviewedState(AWS_COST_BASELINE_SCENARIO.request);
      state.design!.additions = [AWS_TERRAFORM_SCENARIO.resourceId];
      return state;
    }, costDeps()],
    ["COST_BASELINE_PREVIEW_DRIVER_NOT_CONNECTED", () => reviewedState(AWS_COST_BASELINE_SCENARIO.request),
      { ...costDeps(), validateCostBaseline: undefined }],
  ];
  for (const [code, state, deps] of cases) {
    await assert.rejects(runRealPrivateModelBuild(await state(), deps), (error: Error) =>
      error.message.startsWith("PRIVATE_BUILD_BLOCKED:" + code), code);
    assert.equal(deps.calls.model, 0, code + " must not cost inference");
  }
});

test("a disagreeing model or a driver that reports anything but the rendered creates is refused", async () => {
  const state = () => reviewedState(AWS_COST_BASELINE_SCENARIO.request);
  const disagree = costDeps({ proposal: (config) => proposalFor(config, { budgetAmount: "1.00" }) });
  await assert.rejects(runRealPrivateModelBuild(await state(), disagree), /MODEL_PROPOSAL_BUDGET_AMOUNT_MISMATCH/);
  assert.equal(disagree.calls.validate, 0);
  for (const deps of [
    costDeps({ createOnly: false }),
    costDeps({ createdAddresses: (expected) => [...expected, "aws_iam_role.extra"] }),
    costDeps({ createdAddresses: (expected) => expected.slice(1) }),
  ]) {
    await assert.rejects(runRealPrivateModelBuild(await state(), deps), /ACTUAL_TERRAFORM_PREVIEW_UNVERIFIED/);
  }
});

const S3_STATE: DeletionUnitStateRef = {
  engine: "TERRAFORM", backend: "s3", location: "s3://alz-state/builds/cost/terraform.tfstate", workspace: "default",
};
const UNTAGGABLE = new Set(["aws_sns_topic_policy", "aws_sns_topic_subscription", "aws_s3_bucket_public_access_block",
  "aws_s3_bucket_ownership_controls", "aws_s3_bucket_server_side_encryption_configuration",
  "aws_s3_bucket_lifecycle_configuration", "aws_s3_bucket_policy", "aws_ce_cost_allocation_tag"]);

/** Tags as the provider's default_tags apply them, shaped like a plan reader's output. */
function plannedFromHcl(expected: string[], hcl: string, drop?: string): Array<{ address: string; tags: PlannedTags }> {
  const block = /default_tags \{\n\s+tags = \{\n([\s\S]*?)\n\s+\}/.exec(hcl)?.[1] ?? "";
  const tags = Object.fromEntries(block.split("\n").map((line) => /^\s+"([^"]+)"\s+= "([^"]*)"$/.exec(line))
    .filter((match): match is RegExpExecArray => match !== null).map((match) => [match[1], match[2]]));
  return expected.map((address) => {
    const type = address.split(".")[0];
    if (UNTAGGABLE.has(type)) return { address, tags: { kind: "UNTAGGABLE" as const } };
    const own = { ...tags };
    if (address === drop) delete own["alz-unit"];
    return { address, tags: { kind: "TAGGED" as const, tags: own } };
  });
}

test("the deletion-unit opt-in stamps the unit tags into default_tags and proves every taggable create carries them", async () => {
  const state = await reviewedState(AWS_COST_BASELINE_SCENARIO.request);
  const sink: { hcl?: string } = {};
  const deps = { ...costDeps({ plannedTags: (expected, hcl) => { sink.hcl = hcl; return plannedFromHcl(expected, hcl); } }),
    deletionUnitState: S3_STATE };
  const built = await runRealPrivateModelBuild(state, deps);
  assert.ok(built.deletionUnit && sink.hcl);
  assert.equal(built.candidate.artifact.contentHash, sha256(sink.hcl));
  assert.equal(sink.hcl.split('"alz-unit"       = "' + built.deletionUnit.unitId + '"').length - 1, 2,
    "both providers' default_tags carry the unit tag");
  assert.ok(built.deletionUnit.plannedCreates.includes("aws_bcmdataexports_export.cur2"));
  assert.equal(JSON.parse(built.previewSummary).deletionUnitId, built.deletionUnit.unitId);

  const untagged = { ...costDeps({ plannedTags: (expected, hcl) => plannedFromHcl(expected, hcl, "aws_s3_bucket.cost_export") }),
    deletionUnitState: S3_STATE };
  await assert.rejects(runRealPrivateModelBuild(await reviewedState(AWS_COST_BASELINE_SCENARIO.request), untagged),
    /TEARDOWN_TRACEABILITY:UNTAGGED_CREATE: aws_s3_bucket\.cost_export/);
  const unreported = { ...costDeps(), deletionUnitState: S3_STATE };
  await assert.rejects(runRealPrivateModelBuild(await reviewedState(AWS_COST_BASELINE_SCENARIO.request), unreported),
    /TEARDOWN_PLAN_TAGS_NOT_REPORTED/);
});

// --- Real Terraform, offline, against a supplied provider ---------------------------------------------------------

test("the rendered baselines are already in canonical terraform fmt layout", (t) => {
  const terraform = process.env.ALZ_TERRAFORM_BIN;
  if (!terraform) {
    t.skip("set ALZ_TERRAFORM_BIN to a terraform binary to check the layout; nothing is downloaded by this test");
    return;
  }
  for (const name of Object.keys(VARIANTS)) {
    const text = render(name).terraform;
    assert.equal(execFileSync(terraform, ["fmt", "-"], { input: text, encoding: "utf8" }), text, name);
  }
});

test("the rendered baselines pass terraform validate against a supplied, checksum-verified hashicorp/aws " +
  COST_BASELINE_AWS_PROVIDER_VERSION, (t) => {
  const terraform = process.env.ALZ_TERRAFORM_BIN;
  const plugins = process.env.ALZ_AWS_PLUGIN_DIR;
  if (!terraform || !plugins) {
    t.skip("set ALZ_TERRAFORM_BIN and ALZ_AWS_PLUGIN_DIR (a provider folder verified against HashiCorp's SHA256SUMS); " +
      "nothing is downloaded by this test");
    return;
  }
  for (const name of Object.keys(VARIANTS)) {
    const dir = mkdtempSync(join(tmpdir(), "alz-cost-validate-"));
    try {
      const env = { ...process.env, CHECKPOINT_DISABLE: "1", TF_IN_AUTOMATION: "1" };
      writeFileSync(join(dir, "main.tf"), render(name).terraform);
      execFileSync(terraform, ["init", "-backend=false", "-input=false", "-no-color", "-plugin-dir=" + plugins],
        { cwd: dir, env, stdio: "pipe" });
      const result = execFileSync(terraform, ["validate", "-no-color"], { cwd: dir, env, encoding: "utf8" });
      assert.match(result, /Success! The configuration is valid\./, name);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});
