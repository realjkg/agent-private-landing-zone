import { sha256 } from "./provenance.js";
import {
  COST_REQUIRED_TAG_KEYS,
  costConfigHash,
  describeBudgetAction,
  resolveCostConfig,
  type CostConfig,
} from "../design/cost.js";
import type { ProvenanceTags } from "../teardown/types.js";
import { provenanceTags } from "../teardown/unit.js";

/**
 * The AWS Terraform cost baseline (owner direction on #39, 6536926009, plan item 2). Fixed code renders every line;
 * the only inputs are a resolved `cost` configuration (src/design/cost.ts) and, optionally, the deletion-unit tags.
 * A model may propose values, but they reach this file only after `reviewCostBaselineProposals` has checked that
 * two independent proposals agree with each other and with the owner's configuration.
 *
 * Rendered:
 * - an `aws_budgets_budget` with one notification per actual and forecast threshold (notify-only by default);
 * - the alert route: a new SNS topic with a publish policy for AWS Budgets and email subscriptions, the emails
 *   directly, or an adopted topic;
 * - a CUR 2.0 `aws_bcmdataexports_export`, with a new private bucket and the bucket policy for
 *   bcm-data-exports.amazonaws.com and billingreports.amazonaws.com, or an adopted bucket (no bucket rendered);
 * - `aws_ce_cost_allocation_tag` activation for the required tag keys;
 * - provider `default_tags` carrying the required tags beside the deletion-unit tags.
 *
 * Data Exports and Cost Explorer are served from us-east-1, so those resources use a `billing` provider alias there.
 * The render reports this as a cross-region dependency rather than assuming the home region holds everything.
 * Nothing here reads AWS, holds a credential, runs a plan or applies anything.
 */
export const AWS_COST_BASELINE_SCENARIO = {
  id: "aws-terraform-cost-baseline-v1",
  request: "Build an additive AWS Terraform preview of the ALZ cost baseline: a budget with actual and forecast " +
    "alerts and their notification route, a CUR 2.0 Data Export, cost-allocation tag activation for the required " +
    "tags, and the required tags on every created resource. Produce a reviewed preview candidate only.",
} as const;

/** The hashicorp/aws version the product reviews and the pilot lock admits (src/apply/lockfile.ts). */
export const COST_BASELINE_AWS_PROVIDER_VERSION = "6.68.0";
/** Where the Data Exports and Cost Explorer APIs are served. */
export const COST_BILLING_API_REGION = "us-east-1" as const;

export type CostBaselineCreate = { address: string; type: string; taggable: boolean; region: "HOME" | "us-east-1" | "GLOBAL" };

export type CostBaselineMetadata = {
  scenario: typeof AWS_COST_BASELINE_SCENARIO.id;
  mode: "FIXED_TEMPLATE";
  configHash: string;
  artifactHash: string;
  awsProviderVersion: typeof COST_BASELINE_AWS_PROVIDER_VERSION;
  homeRegion: "var.aws_region";
  creates: CostBaselineCreate[];
  crossRegionDependencies: Array<{ service: string; region: string; addresses: string[]; reason: string }>;
  requiredTags: Record<string, string>;
  costAllocationTagKeys: string[];
  budget: { name: string; amount: string; currency: string; period: string; actualThresholds: number[];
    forecastThresholds: number[]; control: "ALERT_ONLY" | "ALERT_AND_BUDGET_ACTION" };
  budgetAction: { enabled: boolean; effect: string };
  notifications: { route: string; emailRecipients: number; snsTopic: "NEW" | "ADOPTED" | "NONE";
    emailConfirmationRequired: boolean };
  export: { mode: string; exportName: string; bucket: string; prefix: string; granularity: string;
    delivery: "AT_LEAST_DAILY"; retentionDays: number | null };
  analytics: "OFF" | "REQUESTED_SEPARATE_PACK";
  /** Facts the operator must know before a plan or apply. Reported, not resolved, by this renderer. */
  prerequisites: string[];
  review: { reviewBy: string; expiresOn: string | null };
  approval: "NOT_GRANTED";
  infrastructureAct: "DISABLED";
  mutationObserved: false;
};

export type CostBaselineRender = { terraform: string; metadata: CostBaselineMetadata };

/** The only shape a model may propose: a confirmation of the owner's budget values, never HCL. */
export type CostBaselineProposal = {
  action: "ADD";
  scenario: typeof AWS_COST_BASELINE_SCENARIO.id;
  budgetAmount: string;
  currency: string;
  period: string;
  actualThresholds: number[];
  forecastThresholds: number[];
  ownership: "NEW_RESOURCE_ONLY";
  evidenceRefs: string[];
};

const PROPOSAL_KEYS = ["action", "actualThresholds", "budgetAmount", "currency", "evidenceRefs", "forecastThresholds",
  "ownership", "period", "scenario"];

function requireCondition(condition: unknown, code: string): asserts condition {
  if (!condition) throw new Error(code);
}

const sameNumbers = (a: unknown, b: readonly number[]) =>
  Array.isArray(a) && a.length === b.length && a.every((value, index) => value === b[index]);

function parseProposal(raw: string, config: CostConfig, evidenceKeys: Set<string>): CostBaselineProposal {
  let object: unknown;
  try {
    object = JSON.parse(raw);
  } catch {
    throw new Error("MODEL_PROPOSAL_NOT_JSON");
  }
  requireCondition(object && typeof object === "object" && !Array.isArray(object), "MODEL_PROPOSAL_INVALID_OBJECT");
  const value = object as Record<string, unknown>;
  requireCondition(JSON.stringify(Object.keys(value).sort()) === JSON.stringify(PROPOSAL_KEYS),
    "MODEL_PROPOSAL_UNEXPECTED_FIELDS");
  requireCondition(value.action === "ADD", "MODEL_PROPOSAL_MUTATION_NOT_ADD");
  requireCondition(value.scenario === AWS_COST_BASELINE_SCENARIO.id, "MODEL_PROPOSAL_SCENARIO_MISMATCH");
  requireCondition(value.budgetAmount === config.budget.amount, "MODEL_PROPOSAL_BUDGET_AMOUNT_MISMATCH");
  requireCondition(value.currency === config.budget.currency, "MODEL_PROPOSAL_CURRENCY_MISMATCH");
  requireCondition(value.period === config.budget.period, "MODEL_PROPOSAL_PERIOD_MISMATCH");
  requireCondition(sameNumbers(value.actualThresholds, config.budget.actualThresholds),
    "MODEL_PROPOSAL_ACTUAL_THRESHOLDS_MISMATCH");
  requireCondition(sameNumbers(value.forecastThresholds, config.budget.forecastThresholds),
    "MODEL_PROPOSAL_FORECAST_THRESHOLDS_MISMATCH");
  requireCondition(value.ownership === "NEW_RESOURCE_ONLY", "MODEL_PROPOSAL_OWNERSHIP_MISMATCH");
  requireCondition(Array.isArray(value.evidenceRefs) && value.evidenceRefs.length > 0 &&
    value.evidenceRefs.every((key) => typeof key === "string" && evidenceKeys.has(key)),
  "MODEL_PROPOSAL_UNGROUNDED_EVIDENCE");
  return value as CostBaselineProposal;
}

/**
 * Two independent proposals must each match the owner's configuration exactly. A model can confirm the values; it
 * can never change them, add a resource or widen a route.
 */
export function reviewCostBaselineProposals(primaryRaw: string, validatorRaw: string, config: CostConfig,
  evidenceKeys: readonly string[]): CostBaselineProposal {
  const resolved = resolveCostConfig(config);
  const allowed = new Set(evidenceKeys);
  const primary = parseProposal(primaryRaw, resolved, allowed);
  const validator = parseProposal(validatorRaw, resolved, allowed);
  return { ...primary, evidenceRefs: [...new Set([...primary.evidenceRefs, ...validator.evidenceRefs])].sort() };
}

// --- HCL text ------------------------------------------------------------------------------------------------------

const q = (value: string) => '"' + value + '"';
const list = (values: readonly string[]) => "[" + values.map(q).join(", ") + "]";

/** Consecutive single-line attributes, padded the way `terraform fmt` aligns them. */
function attrs(indent: number, pairs: ReadonlyArray<readonly [string, string]>): string[] {
  const width = Math.max(...pairs.map(([key]) => key.length));
  return pairs.map(([key, value]) => " ".repeat(indent) + key.padEnd(width) + " = " + value);
}

function tagMap(indent: number, tags: Readonly<Record<string, string>>): string[] {
  return attrs(indent, Object.entries(tags).map(([key, value]) => [q(key), q(value)] as const));
}

function defaultTagsBlock(tags: Readonly<Record<string, string>>): string[] {
  return ["  default_tags {", "    tags = {", ...tagMap(6, tags), "    }", "  }"];
}

/** The CUR 2.0 columns the export selects: identity, billing period, account, usage, cost, region and tags. */
const CUR2_COLUMNS = [
  "identity_line_item_id", "identity_time_interval", "bill_billing_period_start_date", "bill_payer_account_id",
  "line_item_usage_account_id", "line_item_line_item_type", "line_item_usage_start_date", "line_item_usage_end_date",
  "line_item_product_code", "line_item_usage_type", "line_item_operation", "line_item_resource_id",
  "line_item_usage_amount", "line_item_unblended_cost", "line_item_blended_cost", "line_item_currency_code",
  "pricing_unit", "product_region_code", "resource_tags",
];

function renderBudget(config: CostConfig, topic: string | undefined, emails: readonly string[]): string[] {
  const b = config.budget;
  const lines = [
    'resource "aws_budgets_budget" "cost_baseline" {',
    ...attrs(2, [["name", q(b.name)], ["budget_type", q("COST")], ["limit_amount", q(b.amount)],
      ["limit_unit", q(b.currency)], ["time_unit", q(b.period)]]),
  ];
  const notifications = [
    ...b.actualThresholds.map((threshold) => ["ACTUAL", threshold] as const),
    ...b.forecastThresholds.map((threshold) => ["FORECASTED", threshold] as const),
  ];
  for (const [type, threshold] of notifications) {
    const pairs: Array<readonly [string, string]> = [
      ["comparison_operator", q("GREATER_THAN")], ["threshold", String(threshold)],
      ["threshold_type", q("PERCENTAGE")], ["notification_type", q(type)],
    ];
    if (topic) pairs.push(["subscriber_sns_topic_arns", "[" + topic + "]"]);
    if (emails.length > 0) pairs.push(["subscriber_email_addresses", list(emails)]);
    lines.push("", "  notification {", ...attrs(4, pairs), "  }");
  }
  lines.push("}");
  return lines;
}

function renderSnsTopic(emails: readonly string[]): string[] {
  return [
    'resource "aws_sns_topic" "cost_alerts" {',
    '  name = "alz-cost-alerts"',
    "}",
    "",
    'resource "aws_sns_topic_policy" "cost_alerts" {',
    "  arn = aws_sns_topic.cost_alerts.arn",
    "",
    "  policy = jsonencode({",
    '    Version = "2012-10-17"',
    "    Statement = [",
    "      {",
    ...attrs(8, [["Sid", q("AllowAwsBudgetsToPublish")], ["Effect", q("Allow")],
      ["Principal", '{ Service = "budgets.amazonaws.com" }'], ["Action", q("SNS:Publish")],
      ["Resource", "aws_sns_topic.cost_alerts.arn"]]),
    "        Condition = {",
    "          StringEquals = { \"aws:SourceAccount\" = data.aws_caller_identity.current.account_id }",
    "        }",
    "      },",
    "    ]",
    "  })",
    "}",
    "",
    'resource "aws_sns_topic_subscription" "cost_alerts" {',
    ...attrs(2, [["for_each", "toset(" + list(emails) + ")"], ["topic_arn", "aws_sns_topic.cost_alerts.arn"],
      ["protocol", q("email")], ["endpoint", "each.value"]]),
    "}",
  ];
}

function renderBudgetAction(config: CostConfig, topic: string | undefined, emails: readonly string[]): string[] {
  const action = config.budgetAction;
  if (!action.enabled) return [];
  const definition: Array<readonly [string, string]> = [["policy_arn", q(action.policyArn)]];
  if (action.groups.length) definition.push(["groups", list(action.groups)]);
  if (action.roles.length) definition.push(["roles", list(action.roles)]);
  if (action.users.length) definition.push(["users", list(action.users)]);
  const subscribers = topic
    ? [["", ["  subscriber {", ...attrs(4, [["address", topic], ["subscription_type", q("SNS")]]), "  }"]] as const]
    : emails.map((email) => ["", ["  subscriber {", ...attrs(4, [["address", q(email)],
      ["subscription_type", q("EMAIL")]]), "  }"]] as const);
  return [
    "",
    "# Opt-in budget action. Effect: " + describeBudgetAction(config),
    'resource "aws_budgets_budget_action" "cost_baseline" {',
    ...attrs(2, [["budget_name", "aws_budgets_budget.cost_baseline.name"], ["action_type", q(action.type)],
      ["approval_model", q(action.approvalModel)], ["notification_type", q("ACTUAL")],
      ["execution_role_arn", q(action.executionRoleArn)]]),
    "",
    "  action_threshold {",
    ...attrs(4, [["action_threshold_type", q("PERCENTAGE")], ["action_threshold_value", String(action.thresholdPercent)]]),
    "  }",
    "",
    "  definition {",
    "    iam_action_definition {",
    ...attrs(6, definition),
    "    }",
    "  }",
    ...subscribers.flatMap(([, block]) => ["", ...block]),
    "}",
  ];
}

function renderExportBucket(config: CostConfig): string[] {
  const e = config.export;
  if (e.mode !== "NEW_BUCKET") return [];
  const name = e.bucketName ? q(e.bucketName)
    : '"alz-cost-export-${data.aws_caller_identity.current.account_id}-${var.aws_region}"';
  const account = "data.aws_caller_identity.current.account_id";
  return [
    'resource "aws_s3_bucket" "cost_export" {',
    "  bucket = " + name,
    "}",
    "",
    'resource "aws_s3_bucket_public_access_block" "cost_export" {',
    ...attrs(2, [["bucket", "aws_s3_bucket.cost_export.id"], ["block_public_acls", "true"],
      ["block_public_policy", "true"], ["ignore_public_acls", "true"], ["restrict_public_buckets", "true"]]),
    "}",
    "",
    'resource "aws_s3_bucket_ownership_controls" "cost_export" {',
    "  bucket = aws_s3_bucket.cost_export.id",
    "",
    "  rule {",
    '    object_ownership = "BucketOwnerEnforced"',
    "  }",
    "}",
    "",
    'resource "aws_s3_bucket_server_side_encryption_configuration" "cost_export" {',
    "  bucket = aws_s3_bucket.cost_export.id",
    "",
    "  rule {",
    "    apply_server_side_encryption_by_default {",
    '      sse_algorithm = "AES256"',
    "    }",
    "  }",
    "}",
    "",
    'resource "aws_s3_bucket_lifecycle_configuration" "cost_export" {',
    "  bucket = aws_s3_bucket.cost_export.id",
    "",
    "  rule {",
    ...attrs(4, [["id", q("expire-cost-export")], ["status", q("Enabled")]]),
    "",
    "    filter {",
    "      prefix = " + q(e.prefix + "/"),
    "    }",
    "",
    "    expiration {",
    "      days = " + e.retentionDays,
    "    }",
    "  }",
    "}",
    "",
    "# AWS Data Exports writes the CUR 2.0 files and checks this policy; both principals are scoped to this account.",
    'resource "aws_s3_bucket_policy" "cost_export" {',
    "  bucket = aws_s3_bucket.cost_export.id",
    "",
    "  policy = jsonencode({",
    '    Version = "2012-10-17"',
    "    Statement = [",
    "      {",
    ...attrs(8, [["Sid", q("AllowDataExportsDelivery")], ["Effect", q("Allow")]]),
    "        Principal = {",
    '          Service = ["bcm-data-exports.amazonaws.com", "billingreports.amazonaws.com"]',
    "        }",
    '        Action   = ["s3:PutObject", "s3:GetBucketPolicy"]',
    '        Resource = [aws_s3_bucket.cost_export.arn, "${aws_s3_bucket.cost_export.arn}/*"]',
    "        Condition = {",
    "          StringLike = {",
    '            "aws:SourceAccount" = ' + account,
    '            "aws:SourceArn" = [',
    '              "arn:aws:cur:' + COST_BILLING_API_REGION + ':${' + account + '}:definition/*",',
    '              "arn:aws:bcm-data-exports:' + COST_BILLING_API_REGION + ':${' + account + '}:export/*",',
    "            ]",
    "          }",
    "        }",
    "      },",
    "      {",
    ...attrs(8, [["Sid", q("DenyInsecureTransport")], ["Effect", q("Deny")], ["Principal", q("*")],
      ["Action", q("s3:*")], ["Resource", '[aws_s3_bucket.cost_export.arn, "${aws_s3_bucket.cost_export.arn}/*"]']]),
    '        Condition = { Bool = { "aws:SecureTransport" = "false" } }',
    "      },",
    "    ]",
    "  })",
    "",
    "  depends_on = [aws_s3_bucket_public_access_block.cost_export]",
    "}",
    "",
  ];
}

function renderExport(config: CostConfig): string[] {
  const e = config.export;
  const bucket = e.mode === "NEW_BUCKET" ? "aws_s3_bucket.cost_export.bucket" : q(e.bucketName);
  const region = e.mode === "NEW_BUCKET" ? "var.aws_region" : q(e.bucketRegion);
  return [
    "# CUR 2.0. Hourly granularity is line-item detail; AWS delivers the export at least once a day, not hourly.",
    'resource "aws_bcmdataexports_export" "cur2" {',
    "  provider = aws.billing",
    "",
    "  export {",
    "    name = " + q(e.exportName),
    "",
    "    data_query {",
    '      query_statement = "SELECT ' + CUR2_COLUMNS.join(", ") + ' FROM COST_AND_USAGE_REPORT"',
    "      table_configurations = {",
    "        COST_AND_USAGE_REPORT = {",
    ...attrs(10, [["TIME_GRANULARITY", q(e.granularity)], ["INCLUDE_RESOURCES", q("TRUE")],
      ["INCLUDE_MANUAL_DISCOUNT_COMPATIBILITY", q("FALSE")], ["INCLUDE_SPLIT_COST_ALLOCATION_DATA", q("FALSE")]]),
    "        }",
    "      }",
    "    }",
    "",
    "    destination_configurations {",
    "      s3_destination {",
    ...attrs(8, [["s3_bucket", bucket], ["s3_prefix", q(e.prefix)], ["s3_region", region]]),
    "",
    "        s3_output_configurations {",
    ...attrs(10, [["overwrite", q("OVERWRITE_REPORT")], ["format", q("PARQUET")], ["compression", q("PARQUET")],
      ["output_type", q("CUSTOM")]]),
    "        }",
    "      }",
    "    }",
    "",
    "    refresh_cadence {",
    '      frequency = "SYNCHRONOUS"',
    "    }",
    "  }",
    ...(e.mode === "NEW_BUCKET" ? ["", "  depends_on = [aws_s3_bucket_policy.cost_export]"] : []),
    "}",
  ];
}

function renderCostAllocationTags(keys: readonly string[]): string[] {
  return [
    "# Activation needs the key to appear in billing data first, which can take up to 24 hours after tagging.",
    'resource "aws_ce_cost_allocation_tag" "required" {',
    "  provider = aws.billing",
    ...attrs(2, [["for_each", "toset(" + list(keys) + ")"], ["tag_key", "each.value"], ["status", q("Active")]]),
    "}",
  ];
}

function checkedProvenance(provenance?: ProvenanceTags): Record<string, string> {
  if (!provenance) return {};
  // Re-validate: nothing but tag-safe values may reach the HCL text.
  return { ...provenanceTags({ unitId: provenance["alz-unit"], buildId: provenance["alz-build"],
    expires: provenance["alz-expires"] }) };
}

function createsOf(config: CostConfig, keys: readonly string[]): CostBaselineCreate[] {
  const creates: CostBaselineCreate[] = [
    { address: "aws_budgets_budget.cost_baseline", type: "aws_budgets_budget", taggable: true, region: "GLOBAL" },
  ];
  if (config.notifications.route === "SNS_TOPIC") {
    creates.push(
      { address: "aws_sns_topic.cost_alerts", type: "aws_sns_topic", taggable: true, region: "HOME" },
      { address: "aws_sns_topic_policy.cost_alerts", type: "aws_sns_topic_policy", taggable: false, region: "HOME" },
      ...config.notifications.emails.map((email) => ({ address: 'aws_sns_topic_subscription.cost_alerts["' + email + '"]',
        type: "aws_sns_topic_subscription", taggable: false, region: "HOME" as const })),
    );
  }
  if (config.budgetAction.enabled) {
    creates.push({ address: "aws_budgets_budget_action.cost_baseline", type: "aws_budgets_budget_action",
      taggable: true, region: "GLOBAL" });
  }
  if (config.export.mode === "NEW_BUCKET") {
    for (const [type, taggable] of [["aws_s3_bucket", true], ["aws_s3_bucket_public_access_block", false],
      ["aws_s3_bucket_ownership_controls", false], ["aws_s3_bucket_server_side_encryption_configuration", false],
      ["aws_s3_bucket_lifecycle_configuration", false], ["aws_s3_bucket_policy", false]] as const) {
      creates.push({ address: type + ".cost_export", type, taggable, region: "HOME" as const });
    }
  }
  creates.push({ address: "aws_bcmdataexports_export.cur2", type: "aws_bcmdataexports_export", taggable: true,
    region: COST_BILLING_API_REGION });
  creates.push(...keys.map((key) => ({ address: 'aws_ce_cost_allocation_tag.required["' + key + '"]',
    type: "aws_ce_cost_allocation_tag", taggable: false, region: COST_BILLING_API_REGION })));
  return creates.sort((a, b) => (a.address < b.address ? -1 : a.address > b.address ? 1 : 0));
}

/**
 * Fixed Terraform for one resolved cost configuration. Without `provenance` the default tags hold only the
 * required cost tags; with it they also hold the deletion-unit tags (src/apply/unit.ts, src/teardown/unit.ts).
 */
export function renderAwsCostBaseline(input: CostConfig, provenance?: ProvenanceTags): CostBaselineRender {
  // Re-validate the caller's value: nothing unchecked reaches the HCL text.
  const config = resolveCostConfig(input);
  const unitTags = checkedProvenance(provenance);
  const defaultTags = Object.fromEntries(Object.entries({ ...config.tags, ...unitTags })
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  const keys = [...COST_REQUIRED_TAG_KEYS].sort();
  const n = config.notifications;
  const topic = n.route === "SNS_TOPIC" ? "aws_sns_topic.cost_alerts.arn"
    : n.route === "EXISTING_SNS_TOPIC" ? q(n.snsTopicArn!) : undefined;
  const directEmails = n.route === "SNS_TOPIC" ? [] : n.emails;
  const lines = [
    "# ALZ REVIEW CANDIDATE — AWS cost baseline rendered by fixed code; NOT an applied plan.",
    "# A budget sends alerts; it is not a hard cap. A budget action exists only when the owner configured one.",
    "terraform {",
    '  required_version = ">= 1.6.0"',
    "  required_providers {",
    "    aws = {",
    '      source  = "hashicorp/aws"',
    '      version = "' + COST_BASELINE_AWS_PROVIDER_VERSION + '"',
    "    }",
    "  }",
    "}",
    "",
    'variable "aws_region" {',
    "  type = string",
    "}",
    "",
    'provider "aws" {',
    "  region = var.aws_region",
    "",
    ...defaultTagsBlock(defaultTags),
    "}",
    "",
    "# Cross-region dependency: AWS Data Exports and Cost Explorer are served from " + COST_BILLING_API_REGION + ".",
    'provider "aws" {',
    ...attrs(2, [["alias", q("billing")], ["region", q(COST_BILLING_API_REGION)]]),
    "",
    ...defaultTagsBlock(defaultTags),
    "}",
    "",
    'data "aws_caller_identity" "current" {}',
    "",
    ...renderBudget(config, topic, directEmails),
    ...renderBudgetAction(config, topic, directEmails),
    "",
    ...(n.route === "SNS_TOPIC" ? [...renderSnsTopic(n.emails), ""] : []),
    ...renderExportBucket(config),
    ...renderExport(config),
    "",
    ...renderCostAllocationTags(keys),
    "",
  ];
  const terraform = lines.join("\n");
  const creates = createsOf(config, keys);
  const e = config.export;
  const prerequisites = [
    "Cost-allocation tag activation and the CUR 2.0 export run in the AWS Organizations management (payer) account " +
      "or a standalone account; a member account cannot activate cost-allocation tags.",
    "A tag key can be activated only after it appears in billing data, up to 24 hours after a resource is tagged.",
    "The first CUR 2.0 delivery can take up to 24 hours; until then the export is WAITING, never zero spend.",
  ];
  if (n.route !== "EMAIL_DIRECT" && n.emails.length > 0) {
    prerequisites.push("Each email recipient must confirm the SNS subscription before alerts reach them.");
  }
  if (n.route === "EXISTING_SNS_TOPIC") {
    prerequisites.push("The adopted SNS topic's policy must allow budgets.amazonaws.com to publish.");
  }
  if (e.mode === "ADOPT_EXISTING") {
    prerequisites.push("The adopted bucket's policy must allow bcm-data-exports.amazonaws.com and " +
      "billingreports.amazonaws.com to write; its lifecycle rules govern retention.");
  }
  if (config.budget.currency !== "USD") {
    prerequisites.push("AWS Budgets accepts a currency other than USD only when it is the account's billing currency.");
  }
  const metadata: CostBaselineMetadata = {
    scenario: AWS_COST_BASELINE_SCENARIO.id,
    mode: "FIXED_TEMPLATE",
    configHash: costConfigHash(config),
    artifactHash: sha256(terraform),
    awsProviderVersion: COST_BASELINE_AWS_PROVIDER_VERSION,
    homeRegion: "var.aws_region",
    creates,
    crossRegionDependencies: [
      { service: "bcm-data-exports", region: COST_BILLING_API_REGION,
        addresses: creates.filter((c) => c.type === "aws_bcmdataexports_export").map((c) => c.address),
        reason: "AWS Data Exports is served only from " + COST_BILLING_API_REGION + "; the files land in the " +
          "destination bucket's region." },
      { service: "ce", region: COST_BILLING_API_REGION,
        addresses: creates.filter((c) => c.type === "aws_ce_cost_allocation_tag").map((c) => c.address),
        reason: "Cost Explorer cost-allocation tags are managed through " + COST_BILLING_API_REGION + "." },
    ],
    requiredTags: config.tags,
    costAllocationTagKeys: keys,
    budget: { name: config.budget.name, amount: config.budget.amount, currency: config.budget.currency,
      period: config.budget.period, actualThresholds: config.budget.actualThresholds,
      forecastThresholds: config.budget.forecastThresholds,
      control: config.budgetAction.enabled ? "ALERT_AND_BUDGET_ACTION" : "ALERT_ONLY" },
    budgetAction: { enabled: config.budgetAction.enabled, effect: describeBudgetAction(config) },
    notifications: { route: n.route, emailRecipients: n.emails.length,
      snsTopic: n.route === "SNS_TOPIC" ? "NEW" : n.route === "EXISTING_SNS_TOPIC" ? "ADOPTED" : "NONE",
      emailConfirmationRequired: n.route !== "EMAIL_DIRECT" && n.emails.length > 0 },
    export: { mode: e.mode, exportName: e.exportName,
      bucket: e.mode === "ADOPT_EXISTING" ? e.bucketName
        : e.bucketName ?? "alz-cost-export-<account-id>-<home-region>",
      prefix: e.prefix, granularity: e.granularity, delivery: "AT_LEAST_DAILY",
      retentionDays: e.mode === "NEW_BUCKET" ? e.retentionDays : null },
    analytics: config.analytics === "ON" ? "REQUESTED_SEPARATE_PACK" : "OFF",
    prerequisites,
    review: { reviewBy: config.review.reviewBy, expiresOn: config.review.expiresOn ?? null },
    approval: "NOT_GRANTED",
    infrastructureAct: "DISABLED",
    mutationObserved: false,
  };
  return { terraform, metadata };
}
