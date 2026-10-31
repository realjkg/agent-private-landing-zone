import assert from "node:assert/strict";
import test from "node:test";

import {
  COST_DEFAULTS,
  COST_REQUIRED_TAG_KEYS,
  CostConfigError,
  costConfigHash,
  describeBudgetAction,
  resolveCostConfig,
  validateCostConfig,
} from "../src/design/cost.js";

// Synthetic configuration values only; no account, credential or live endpoint is involved.
const minimal = () => ({
  owner: "platform-team",
  notifications: { emails: ["finops@example.com"] },
  tags: { "cost-center": "cc-1234", environment: "dev" },
  budget: { amount: "250" },
  review: { reviewBy: "2027-01-31" },
});

function issuesOf(input: unknown): string[] {
  const result = validateCostConfig(input);
  assert.equal(result.ok, false, "expected the configuration to be refused");
  return result.ok ? [] : result.issues.map((issue) => issue.path + " " + issue.code);
}

test("a minimal configuration resolves to safe defaults: notify-only, no budget action, analytics off, no limits", () => {
  const config = resolveCostConfig(minimal());
  assert.equal(config.schema, 1);
  assert.deepEqual(config.notifications, { route: "SNS_TOPIC", emails: ["finops@example.com"], encryption: "CUSTOMER_KMS" },
    "a new topic is encrypted with a customer-managed key by default");
  assert.equal(resolveCostConfig({ ...minimal(), notifications: { emails: ["a@example.com"], encryption: "NONE" } })
    .notifications.encryption, "NONE", "the explicit opt-out is kept");
  assert.equal(resolveCostConfig({ ...minimal(), notifications: { route: "EMAIL_DIRECT", emails: ["a@example.com"] } })
    .notifications.encryption, "NONE", "no topic is created, so there is nothing to encrypt");
  assert.equal(config.activateCostAllocationTags, false, "tag activation is opt-in");
  assert.deepEqual(config.tags, { "cost-center": "cc-1234", environment: "dev", owner: "platform-team" },
    "the owner tag defaults to the owner");
  assert.deepEqual(Object.keys(config.tags).sort(), [...COST_REQUIRED_TAG_KEYS].sort());
  assert.deepEqual(config.budget, {
    name: COST_DEFAULTS.budgetName, amount: "250.00", currency: "USD", period: "MONTHLY",
    actualThresholds: [80, 100], forecastThresholds: [100],
  });
  assert.deepEqual(config.budgetAction, { enabled: false });
  assert.deepEqual(config.limits, { allowedRegions: [], resourceFamilies: [], sizes: {}, quantities: {} });
  assert.deepEqual(config.export, {
    mode: "NEW_BUCKET", exportName: "alz-cur2", prefix: "cur2", granularity: "DAILY", retentionDays: 400,
  });
  assert.equal(config.analytics, "OFF");
  assert.deepEqual(config.review, { reviewBy: "2027-01-31" });
  assert.match(describeBudgetAction(config), /alerts only/);
});

test("resolution is idempotent, so the build can re-validate a resolved configuration and bind a stable hash", () => {
  const config = resolveCostConfig({
    ...minimal(),
    export: { mode: "ADOPT_EXISTING", bucketName: "corp-billing-exports", bucketRegion: "eu-west-1" },
    notifications: { route: "EXISTING_SNS_TOPIC", snsTopicArn: "arn:aws:sns:eu-west-1:123456789012:billing" },
  });
  assert.deepEqual(resolveCostConfig(config), config);
  assert.equal(costConfigHash(config), costConfigHash(resolveCostConfig(config)));
  assert.match(costConfigHash(config), /^[a-f0-9]{64}$/);
  assert.notEqual(costConfigHash(config), costConfigHash(resolveCostConfig(minimal())));
});

test("amounts are normalized to two decimals and must be positive", () => {
  for (const [input, expected] of [["250", "250.00"], ["250.5", "250.50"], [99.99, "99.99"], ["007", "7.00"]] as const) {
    assert.equal(resolveCostConfig({ ...minimal(), budget: { amount: input } }).budget.amount, expected);
  }
  for (const amount of ["0", "0.00", "-5", "1e3", "12.345", "", "ten", null]) {
    assert.deepEqual(issuesOf({ ...minimal(), budget: { amount } }), ["budget.amount INVALID"], String(amount));
  }
});

test("every required field is named when it is missing, all at once", () => {
  const issues = issuesOf({ notifications: { emails: [] }, budget: {}, review: {} });
  for (const expected of ["owner REQUIRED", "notifications.emails REQUIRED", "tags.owner REQUIRED",
    "tags.cost-center REQUIRED", "tags.environment REQUIRED", "budget.amount REQUIRED", "review.reviewBy REQUIRED"]) {
    assert.ok(issues.includes(expected), expected + " in " + issues.join(", "));
  }
  assert.deepEqual(issuesOf(undefined), ["cost NOT_AN_OBJECT", "owner REQUIRED", "notifications NOT_AN_OBJECT",
    "notifications.emails REQUIRED", "tags.owner REQUIRED", "tags.cost-center REQUIRED", "tags.environment REQUIRED",
    "budget NOT_AN_OBJECT", "budget.amount REQUIRED", "review NOT_AN_OBJECT", "review.reviewBy REQUIRED"]);
  assert.throws(() => resolveCostConfig({}), (error: unknown) =>
    error instanceof CostConfigError && /^COST_CONFIG_INVALID: owner REQUIRED/.test(error.message));
});

test("unknown fields are refused at every level, so a typo never silently drops a control", () => {
  assert.deepEqual(issuesOf({ ...minimal(), budgetCap: "100" }), ["cost.budgetCap UNKNOWN_FIELD"]);
  assert.deepEqual(issuesOf({ ...minimal(), budget: { amount: "1", hardCap: true } }), ["budget.hardCap UNKNOWN_FIELD"]);
  assert.deepEqual(issuesOf({ ...minimal(), export: { retention: 30 } }), ["export.retention UNKNOWN_FIELD"]);
  assert.deepEqual(issuesOf({ ...minimal(), schema: 2 }), ["cost.schema UNSUPPORTED"]);
});

test("tag keys and values cannot carry HCL syntax, reserved prefixes or empty values", () => {
  const tags = (extra: Record<string, unknown>) => ({ ...minimal(), tags: { ...minimal().tags, ...extra } });
  assert.deepEqual(issuesOf(tags({ team: 'a" }\n' })), ["tags.team INVALID_VALUE"]);
  assert.deepEqual(issuesOf(tags({ team: "${var.x}" })), ["tags.team INVALID_VALUE"]);
  assert.deepEqual(issuesOf(tags({ team: "" })), ["tags.team INVALID_VALUE"]);
  assert.deepEqual(issuesOf(tags({ "aws:createdBy": "x" })), ["tags.aws:createdBy RESERVED_KEY"]);
  assert.deepEqual(issuesOf(tags({ "alz-unit": "forged" })), ["tags.alz-unit RESERVED_KEY"],
    "the deletion-unit tags come only from the unit record");
  assert.deepEqual(issuesOf(tags({ "bad{key": "x" })), ["tags.bad{key INVALID_KEY"]);
  // N4: a prototype key would be silently dropped from a plain object; it is refused instead.
  assert.deepEqual(issuesOf({ ...minimal(), tags: JSON.parse('{"cost-center":"cc-1","environment":"dev","__proto__":"x"}') }),
    ["tags.__proto__ RESERVED_KEY"]);
  assert.deepEqual(issuesOf(tags({ constructor: "x" })), ["tags.constructor RESERVED_KEY"]);
  assert.deepEqual(issuesOf(tags({ prototype: "x" })), ["tags.prototype RESERVED_KEY"]);
  assert.deepEqual(issuesOf({ ...minimal(), owner: "team\"x" }), ["owner INVALID"]);
  const many = Object.fromEntries(Array.from({ length: 21 }, (_, i) => ["extra-" + i, "v"]));
  assert.deepEqual(issuesOf(tags(many)), ["tags TOO_MANY"]);
  const explicitOwner = resolveCostConfig(tags({ owner: "finance", team: "core" }));
  assert.deepEqual(explicitOwner.tags, { "cost-center": "cc-1234", environment: "dev", owner: "finance", team: "core" });
});

test("notification routes: SNS topic and direct email need recipients, an adopted topic needs its ARN", () => {
  assert.deepEqual(issuesOf({ ...minimal(), notifications: { route: "EMAIL_DIRECT" } }),
    ["notifications.emails REQUIRED"]);
  assert.deepEqual(issuesOf({ ...minimal(), notifications: { route: "EXISTING_SNS_TOPIC" } }),
    ["notifications.snsTopicArn REQUIRED"]);
  assert.deepEqual(issuesOf({ ...minimal(), notifications: { emails: ["a@example.com"], snsTopicArn: "arn:aws:sns:x" } }),
    ["notifications.snsTopicArn INVALID"]);
  assert.deepEqual(issuesOf({ ...minimal(), notifications: { route: "SNS_TOPIC", emails: ["a@example.com"],
    snsTopicArn: "arn:aws:sns:eu-west-1:123456789012:t" } }), ["notifications.snsTopicArn NOT_ALLOWED"]);
  assert.deepEqual(issuesOf({ ...minimal(), notifications: { emails: ["not-an-email"] } }),
    ["notifications.emails[0] INVALID"]);
  assert.deepEqual(issuesOf({ ...minimal(), notifications: { emails: ["a@example.com", "a@example.com"] } }),
    ["notifications.emails[1] DUPLICATE"]);
  const eleven = Array.from({ length: 11 }, (_, i) => "r" + i + "@example.com");
  assert.deepEqual(issuesOf({ ...minimal(), notifications: { emails: eleven } }), ["notifications.emails TOO_MANY"]);
  const adopted = resolveCostConfig({ ...minimal(),
    notifications: { snsTopicArn: "arn:aws:sns:eu-west-1:123456789012:billing" } });
  assert.deepEqual(adopted.notifications,
    { route: "EXISTING_SNS_TOPIC", emails: [], snsTopicArn: "arn:aws:sns:eu-west-1:123456789012:billing", encryption: "NONE" });
  assert.equal(resolveCostConfig({ ...minimal(), notifications: { emails: ["a@example.com"], encryption: "CUSTOMER_KMS" } })
    .notifications.encryption, "CUSTOMER_KMS");
  assert.deepEqual(issuesOf({ ...minimal(), notifications: { route: "EMAIL_DIRECT", emails: ["a@example.com"],
    encryption: "CUSTOMER_KMS" } }), ["notifications.encryption NOT_ALLOWED"]);
  assert.deepEqual(issuesOf({ ...minimal(), notifications: { emails: ["a@example.com"], encryption: "AWS_MANAGED" } }),
    ["notifications.encryption INVALID"], "the AWS-managed SNS key cannot be used by AWS Budgets");
});

test("thresholds are percentages, sorted, unique, and within the AWS limit of five notifications per budget", () => {
  const budget = (extra: Record<string, unknown>) => ({ ...minimal(), budget: { amount: "100", ...extra } });
  assert.deepEqual(resolveCostConfig(budget({ actualThresholds: [100, 50, 80.5] })).budget.actualThresholds, [50, 80.5, 100]);
  assert.deepEqual(issuesOf(budget({ actualThresholds: [0] })), ["budget.actualThresholds[0] INVALID"]);
  assert.deepEqual(issuesOf(budget({ actualThresholds: [1001] })), ["budget.actualThresholds[0] INVALID"]);
  assert.deepEqual(issuesOf(budget({ actualThresholds: [10.123] })), ["budget.actualThresholds[0] INVALID"]);
  assert.deepEqual(issuesOf(budget({ actualThresholds: [80, 80] })), ["budget.actualThresholds[1] DUPLICATE"]);
  assert.deepEqual(issuesOf(budget({ actualThresholds: [10, 20, 30, 40], forecastThresholds: [90, 100] })),
    ["budget TOO_MANY_ALERTS"]);
  assert.deepEqual(issuesOf(budget({ actualThresholds: [], forecastThresholds: [] })), ["budget NO_ALERTS"]);
  assert.deepEqual(issuesOf(budget({ period: "WEEKLY" })), ["budget.period INVALID"]);
  assert.deepEqual(issuesOf(budget({ currency: "usd" })), ["budget.currency INVALID"]);
  assert.deepEqual(issuesOf(budget({ name: "bad:name" })), ["budget.name INVALID"]);
});

test("a budget action is off unless explicitly enabled, and an enabled one is complete and described", () => {
  assert.deepEqual(resolveCostConfig({ ...minimal(), budgetAction: { enabled: false } }).budgetAction, { enabled: false });
  assert.deepEqual(issuesOf({ ...minimal(), budgetAction: {} }), ["budgetAction.enabled REQUIRED"]);
  assert.deepEqual(issuesOf({ ...minimal(), budgetAction: { enabled: "yes" } }), ["budgetAction.enabled REQUIRED"]);
  assert.deepEqual(issuesOf({ ...minimal(), budgetAction: { enabled: false, policyArn: "x" } }),
    ["budgetAction NOT_ALLOWED"]);
  const missing = issuesOf({ ...minimal(), budgetAction: { enabled: true } });
  assert.deepEqual(missing, ["budgetAction.type REQUIRED", "budgetAction.thresholdPercent REQUIRED",
    "budgetAction.executionRoleArn REQUIRED", "budgetAction.policyArn REQUIRED", "budgetAction NO_TARGET"]);
  assert.deepEqual(issuesOf({ ...minimal(), budgetAction: { enabled: true, type: "STOP_EC2_INSTANCES" } }).slice(0, 1),
    ["budgetAction.type INVALID"]);
  const config = resolveCostConfig({ ...minimal(), budgetAction: {
    enabled: true, type: "APPLY_IAM_POLICY", thresholdPercent: 100,
    executionRoleArn: "arn:aws:iam::123456789012:role/alz-budget-action",
    policyArn: "arn:aws:iam::123456789012:policy/alz-deny-new-compute", roles: ["workload-deployer"],
  } });
  assert.equal(config.budgetAction.enabled && config.budgetAction.approvalModel, "MANUAL", "manual approval by default");
  const effect = describeBudgetAction(config);
  assert.match(effect, /100% of 250\.00 USD \(monthly\)/);
  assert.match(effect, /attaches arn:aws:iam::123456789012:policy\/alz-deny-new-compute to roles workload-deployer/);
  assert.match(effect, /after a person approves/);
  assert.match(effect, /does not stop running resources or cap spend/);
  assert.doesNotMatch(effect, /hard cap/i);
});

test("provisioning limits are typed data for the seal judge, with sizes only for listed families", () => {
  const config = resolveCostConfig({ ...minimal(), limits: {
    allowedRegions: ["eu-west-1", "eu-central-1"], resourceFamilies: ["ec2", "rds"],
    sizes: { ec2: ["t3.small", "t3.micro"] }, quantities: { aws_instance: 2, aws_db_instance: 0 },
  } });
  assert.deepEqual(config.limits, {
    allowedRegions: ["eu-central-1", "eu-west-1"], resourceFamilies: ["ec2", "rds"],
    sizes: { ec2: ["t3.micro", "t3.small"] }, quantities: { aws_db_instance: 0, aws_instance: 2 },
  });
  assert.deepEqual(issuesOf({ ...minimal(), limits: { sizes: { ec2: ["t3.micro"] } } }),
    ["limits.sizes.ec2 UNLISTED_FAMILY"]);
  assert.deepEqual(issuesOf({ ...minimal(), limits: { allowedRegions: ["mars-1"] } }),
    ["limits.allowedRegions[0] INVALID"]);
  assert.deepEqual(issuesOf({ ...minimal(), limits: { quantities: { "aws instance": 1 } } }),
    ["limits.quantities.aws instance INVALID_KEY"]);
  assert.deepEqual(issuesOf({ ...minimal(), limits: { quantities: { aws_instance: 1.5 } } }),
    ["limits.quantities.aws_instance INVALID"]);
  assert.deepEqual(issuesOf({ ...minimal(), limits: { quantities: { aws_instance: -1 } } }),
    ["limits.quantities.aws_instance INVALID"]);
});

test("review dates are real dates and the configuration cannot lapse before its review", () => {
  assert.deepEqual(issuesOf({ ...minimal(), review: { reviewBy: "2027-02-30" } }), ["review.reviewBy INVALID"]);
  assert.deepEqual(issuesOf({ ...minimal(), review: { reviewBy: "2027-13-45" } }), ["review.reviewBy INVALID"]);
  assert.deepEqual(issuesOf({ ...minimal(), review: { reviewBy: "next month" } }), ["review.reviewBy INVALID"]);
  assert.deepEqual(issuesOf({ ...minimal(), review: { reviewBy: "2027-03-01", expiresOn: "2027-02-01" } }),
    ["review.expiresOn BEFORE_REVIEW"]);
  assert.deepEqual(resolveCostConfig({ ...minimal(), review: { reviewBy: "2027-03-01", expiresOn: "2027-06-30" } }).review,
    { reviewBy: "2027-03-01", expiresOn: "2027-06-30" });
});

test("the export creates a new bucket by default or adopts an existing one by name, never both", () => {
  assert.deepEqual(issuesOf({ ...minimal(), export: { mode: "ADOPT_EXISTING" } }),
    ["export.bucketName REQUIRED", "export.bucketRegion REQUIRED"]);
  assert.deepEqual(issuesOf({ ...minimal(), export: { mode: "ADOPT_EXISTING", bucketName: "corp-billing",
    bucketRegion: "eu-west-1", retentionDays: 30 } }), ["export.retentionDays NOT_ALLOWED"]);
  assert.deepEqual(issuesOf({ ...minimal(), export: { bucketRegion: "eu-west-1" } }), ["export.bucketRegion NOT_ALLOWED"]);
  for (const bucketName of ["Bad_Bucket", "ab", "a..b", "192.168.1.1", "-lead", "acme.cost.export"]) {
    assert.deepEqual(issuesOf({ ...minimal(), export: { bucketName } }), ["export.bucketName INVALID"], bucketName);
  }
  // N5: names S3 reserves are refused up front, for a new and an adopted bucket alike.
  for (const bucketName of ["xn--cost", "sthree-cost", "amzn-s3-demo-cost", "cost-s3alias", "cost--ol-s3", "cost--x-s3",
    "cost--table-s3"]) {
    assert.deepEqual(issuesOf({ ...minimal(), export: { bucketName } }), ["export.bucketName RESERVED"], bucketName);
    assert.deepEqual(issuesOf({ ...minimal(), export: { mode: "ADOPT_EXISTING", bucketName, bucketRegion: "eu-west-1" } }),
      ["export.bucketName RESERVED"], bucketName);
  }
  assert.deepEqual(issuesOf({ ...minimal(), export: { retentionDays: 0 } }), ["export.retentionDays INVALID"]);
  assert.deepEqual(issuesOf({ ...minimal(), export: { granularity: "MINUTE" } }), ["export.granularity INVALID"]);
  assert.deepEqual(issuesOf({ ...minimal(), export: { prefix: "/cur2/" } }), ["export.prefix INVALID"]);
  const named = resolveCostConfig({ ...minimal(), export: { bucketName: "acme-cur2", granularity: "HOURLY", retentionDays: 90 } });
  assert.deepEqual(named.export, { mode: "NEW_BUCKET", exportName: "alz-cur2", bucketName: "acme-cur2", prefix: "cur2",
    granularity: "HOURLY", retentionDays: 90 });
});

test("cost-allocation tag activation is off by default and only a boolean", () => {
  assert.equal(resolveCostConfig({ ...minimal(), activateCostAllocationTags: true }).activateCostAllocationTags, true);
  assert.deepEqual(issuesOf({ ...minimal(), activateCostAllocationTags: "yes" }), ["activateCostAllocationTags INVALID"]);
});

test("analytics is off by default and only OFF or ON", () => {
  assert.equal(resolveCostConfig({ ...minimal(), analytics: "ON" }).analytics, "ON");
  assert.deepEqual(issuesOf({ ...minimal(), analytics: true }), ["analytics INVALID"]);
});
