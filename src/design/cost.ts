import { sha256 } from "../util/sha256.js";

/**
 * The `cost` section of the landing-zone build input: one configuration source for the cost baseline
 * (owner direction on #39, 6536926009). The same validated values drive the rendered IaC (src/build/cost-baseline.ts), the
 * provisioning limits that the seal judge enforces (COST-3) and the status panel (COST-5). The trusted host hands it to
 * the build (`RealPrivateBuildDeps.costConfig` in src/build/private-model.ts); no model or chat text supplies it.
 *
 * Safe defaults: notifications only, no budget action, analytics off, no provisioning limits configured. Every field
 * is checked against a closed key set and a strict character set, so a value that reaches the rendered Terraform can
 * never carry an interpolation, a quote or a new line. Validation reports every problem at once, each with its path.
 *
 * This module grants no authority. A budget is an alert, never a hard cap; a budget action runs only when it is
 * explicitly configured here, and its effect is described before deploy (`describeBudgetAction`).
 */

/** The tag keys every cost-attributed resource carries. They match the cost pillar (src/policy/pillars/baseline.ts). */
export const COST_REQUIRED_TAG_KEYS = ["owner", "cost-center", "environment"] as const;

export type CostBudgetPeriod = "MONTHLY" | "QUARTERLY" | "ANNUALLY";
export type CostNotificationRoute = "SNS_TOPIC" | "EMAIL_DIRECT" | "EXISTING_SNS_TOPIC";
export type CostExportGranularity = "DAILY" | "HOURLY";
/**
 * CUSTOMER_KMS (the default for a new topic): a new customer-managed key whose policy lets AWS Budgets publish and SNS
 * deliver; it adds a monthly key charge. NONE: an explicit opt-out that leaves the new topic unencrypted. The
 * AWS-managed `alias/aws/sns` key is never offered, because AWS Budgets cannot publish to a topic encrypted with it.
 * The adopted-topic and direct-email routes create no topic, so they are always NONE here.
 */
export type CostTopicEncryption = "NONE" | "CUSTOMER_KMS";

export type CostNotifications = {
  /**
   * SNS_TOPIC: a new topic, each email subscribed to it (the default). EMAIL_DIRECT: the emails are the budget's
   * subscribers. EXISTING_SNS_TOPIC: an adopted topic, named by ARN, plus optional direct emails.
   */
  route: CostNotificationRoute;
  emails: string[];
  snsTopicArn?: string;
  /** Applies only to the SNS_TOPIC route, which creates the topic; an adopted topic keeps its owner's settings. */
  encryption: CostTopicEncryption;
};

export type CostBudget = {
  name: string;
  /** A decimal amount with two fraction digits, as AWS Budgets takes it ("250.00"). */
  amount: string;
  currency: string;
  period: CostBudgetPeriod;
  /** Percentages of the amount. Actual alerts fire on spend, forecast alerts on the forecast. */
  actualThresholds: number[];
  forecastThresholds: number[];
};

export type CostBudgetActionOff = { enabled: false };
/**
 * Opt-in only. The one supported action attaches a reviewed IAM policy to named principals; with the default MANUAL
 * approval model, AWS waits for a person to approve each run.
 */
export type CostBudgetActionOn = {
  enabled: true;
  type: "APPLY_IAM_POLICY";
  thresholdPercent: number;
  approvalModel: "MANUAL" | "AUTOMATIC";
  executionRoleArn: string;
  policyArn: string;
  roles: string[];
  groups: string[];
  users: string[];
};
export type CostBudgetAction = CostBudgetActionOff | CostBudgetActionOn;

/**
 * Provisioning limits, as data. COST-3 consumes this shape for the seal judge; nothing here enforces it. Empty lists
 * and maps mean "not configured", never "everything allowed".
 */
export type CostProvisioningLimits = {
  allowedRegions: string[];
  /** Resource families, such as "ec2" or "rds". */
  resourceFamilies: string[];
  /** Allowed sizes per family, such as { ec2: ["t3.micro"] }. Each key must be a listed family. */
  sizes: Record<string, string[]>;
  /** The most instances of each Terraform resource type, such as { aws_instance: 2 }. */
  quantities: Record<string, number>;
};

export type CostReview = {
  /** YYYY-MM-DD: when the owner reviews the budget, recipients and limits again. */
  reviewBy: string;
  /** YYYY-MM-DD, optional: when this configuration lapses. Never before `reviewBy`. */
  expiresOn?: string;
};

export type CostExportNewBucket = {
  mode: "NEW_BUCKET";
  exportName: string;
  /** Unset: the renderer names the bucket from the account id and region. */
  bucketName?: string;
  prefix: string;
  granularity: CostExportGranularity;
  /** Days before an export object expires in the new bucket. */
  retentionDays: number;
};
export type CostExportAdoptExisting = {
  mode: "ADOPT_EXISTING";
  exportName: string;
  bucketName: string;
  bucketRegion: string;
  prefix: string;
  granularity: CostExportGranularity;
};
export type CostExport = CostExportNewBucket | CostExportAdoptExisting;

export type CostConfig = {
  schema: 1;
  owner: string;
  notifications: CostNotifications;
  /** Sorted by key. Always holds every key in COST_REQUIRED_TAG_KEYS. */
  tags: Record<string, string>;
  budget: CostBudget;
  budgetAction: CostBudgetAction;
  limits: CostProvisioningLimits;
  review: CostReview;
  export: CostExport;
  /**
   * Off by default. AWS activates a cost-allocation tag key only in the Organizations management account or a
   * standalone account, and only after the key has appeared in billing data (up to 24 hours after tagging), so
   * rendering activation into a fresh or member account would fail its first apply partway. Turn it on in a later
   * build, once the keys are listed in the account's cost-allocation tags.
   */
  activateCostAllocationTags: boolean;
  /** OFF by default. ON requests the separate FinOps analytics pack (phase 2); the baseline never depends on it. */
  analytics: "OFF" | "ON";
};

export type CostConfigIssue = { path: string; code: string; message: string };

export class CostConfigError extends Error {
  readonly issues: readonly CostConfigIssue[];
  constructor(issues: readonly CostConfigIssue[]) {
    super("COST_CONFIG_INVALID: " + issues.map((issue) => issue.path + " " + issue.code + " (" + issue.message + ")").join("; "));
    this.name = "CostConfigError";
    this.issues = issues;
  }
}

export const COST_DEFAULTS = {
  budgetName: "alz-cost-baseline",
  currency: "USD",
  period: "MONTHLY" as CostBudgetPeriod,
  actualThresholds: [80, 100],
  forecastThresholds: [100],
  exportName: "alz-cur2",
  prefix: "cur2",
  granularity: "DAILY" as CostExportGranularity,
  /** Thirteen months of monthly comparisons plus a margin. */
  retentionDays: 400,
} as const;

/** AWS Budgets limits: five notifications per budget, ten email subscribers per notification. */
export const AWS_BUDGET_MAX_NOTIFICATIONS = 5;
export const AWS_BUDGET_MAX_EMAILS = 10;
const MAX_EXTRA_TAGS = 20;

// Character sets. None admits a quote, a backslash, `$`, `%`, `{` or a line break, so no value can become HCL syntax.
const TAG_KEY = /^[A-Za-z0-9 _.:/=+@-]{1,128}$/;
const TAG_VALUE = /^[A-Za-z0-9 _.:/=+@-]{1,256}$/;
const EMAIL = /^[A-Za-z0-9._+-]{1,64}@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,24}$/;
const SNS_ARN = /^arn:aws:sns:[a-z]{2}(?:-[a-z]+)+-\d:\d{12}:[A-Za-z0-9_-]{1,256}$/;
const ROLE_ARN = /^arn:aws:iam::\d{12}:role\/[A-Za-z0-9+=,.@_/-]{1,512}$/;
const POLICY_ARN = /^arn:aws:iam::(?:aws|\d{12}):policy\/[A-Za-z0-9+=,.@_/-]{1,512}$/;
const IAM_NAME = /^[A-Za-z0-9+=,.@_-]{1,128}$/;
const REGION = /^[a-z]{2}(?:-[a-z]+)+-\d$/;
const BUDGET_NAME = /^[A-Za-z0-9_.-]{1,100}$/;
const EXPORT_NAME = /^[A-Za-z0-9_-]{1,128}$/;
const PREFIX = /^[a-z0-9](?:[a-z0-9/_.-]{0,126}[a-z0-9])?$/;
const BUCKET = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;
/** Names S3 reserves (prefixes and suffixes for access points, aliases, directory and table buckets). */
const BUCKET_RESERVED = [/^xn--/, /^sthree-/, /^amzn-s3-demo-/, /-s3alias$/, /--ol-s3$/, /--x-s3$/, /--table-s3$/];
/** Keys that name an object's prototype machinery; as a plain-object key they can be silently dropped. */
const PROTOTYPE_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const CURRENCY = /^[A-Z]{3}$/;
const AMOUNT = /^(\d{1,12})(?:\.(\d{1,2}))?$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const FAMILY = /^[a-z][a-z0-9-]{0,62}$/;
const SIZE = /^[a-z0-9][a-z0-9.-]{0,62}$/;
const RESOURCE_TYPE = /^[a-z][a-z0-9]*_[a-z0-9_]{1,126}$/;

type Raw = Record<string, unknown>;

class Collector {
  readonly issues: CostConfigIssue[] = [];
  add(path: string, code: string, message: string): void {
    this.issues.push({ path, code, message });
  }
  /** An object with a closed key set; unknown keys are reported. Absent values read as an empty object. */
  object(value: unknown, path: string, keys: readonly string[], required = false): Raw {
    if (value === undefined && !required) return {};
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      this.add(path, "NOT_AN_OBJECT", "expected an object");
      return {};
    }
    for (const key of Object.keys(value)) {
      if (!keys.includes(key)) this.add(path + "." + key, "UNKNOWN_FIELD", "not a field of " + path);
    }
    return value as Raw;
  }
  string(value: unknown, path: string, pattern: RegExp, hint: string, fallback?: string): string | undefined {
    if (value === undefined) {
      if (fallback === undefined) this.add(path, "REQUIRED", hint);
      return fallback;
    }
    if (typeof value !== "string" || !pattern.test(value)) {
      this.add(path, "INVALID", hint);
      return undefined;
    }
    return value;
  }
  optionalString(value: unknown, path: string, pattern: RegExp, hint: string): string | undefined {
    return value === undefined ? undefined : this.string(value, path, pattern, hint);
  }
  oneOf<T extends string>(value: unknown, path: string, allowed: readonly T[], fallback?: T): T | undefined {
    if (value === undefined) {
      if (fallback === undefined) this.add(path, "REQUIRED", "one of " + allowed.join(", "));
      return fallback;
    }
    if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
      this.add(path, "INVALID", "one of " + allowed.join(", "));
      return undefined;
    }
    return value as T;
  }
  strings(value: unknown, path: string, pattern: RegExp, hint: string, max: number): string[] {
    if (value === undefined) return [];
    if (!Array.isArray(value)) {
      this.add(path, "NOT_A_LIST", "expected a list");
      return [];
    }
    if (value.length > max) this.add(path, "TOO_MANY", "at most " + max);
    const out: string[] = [];
    value.forEach((item, index) => {
      if (typeof item !== "string" || !pattern.test(item)) this.add(path + "[" + index + "]", "INVALID", hint);
      else if (out.includes(item)) this.add(path + "[" + index + "]", "DUPLICATE", "listed twice");
      else out.push(item);
    });
    return out.sort();
  }
  percent(value: unknown, path: string): number | undefined {
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > 1000 ||
      Math.abs(Math.round(value * 100) - value * 100) > 1e-9) {
      this.add(path, "INVALID", "a percentage above 0 and at most 1000, with at most two decimals");
      return undefined;
    }
    return value;
  }
  percents(value: unknown, path: string, fallback: readonly number[]): number[] {
    if (value === undefined) return [...fallback];
    if (!Array.isArray(value)) {
      this.add(path, "NOT_A_LIST", "expected a list of percentages");
      return [];
    }
    const out: number[] = [];
    value.forEach((item, index) => {
      const percent = this.percent(item, path + "[" + index + "]");
      if (percent === undefined) return;
      if (out.includes(percent)) this.add(path + "[" + index + "]", "DUPLICATE", "listed twice");
      else out.push(percent);
    });
    return out.sort((a, b) => a - b);
  }
  integer(value: unknown, path: string, min: number, max: number, fallback?: number): number | undefined {
    if (value === undefined) {
      if (fallback === undefined) this.add(path, "REQUIRED", "a whole number from " + min + " to " + max);
      return fallback;
    }
    if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
      this.add(path, "INVALID", "a whole number from " + min + " to " + max);
      return undefined;
    }
    return value;
  }
  date(value: unknown, path: string, required: boolean): string | undefined {
    if (value === undefined) {
      if (required) this.add(path, "REQUIRED", "a YYYY-MM-DD date");
      return undefined;
    }
    const parsed = typeof value === "string" && ISO_DATE.test(value) ? new Date(value + "T00:00:00Z") : undefined;
    if (!parsed || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
      this.add(path, "INVALID", "a real YYYY-MM-DD date");
      return undefined;
    }
    return value;
  }
}

function normalizeAmount(value: unknown, c: Collector): string | undefined {
  const text = typeof value === "number" && Number.isFinite(value) ? String(value) : value;
  if (value === undefined) {
    c.add("budget.amount", "REQUIRED", "the budget amount, such as \"250\" or \"250.50\"");
    return undefined;
  }
  const match = typeof text === "string" ? AMOUNT.exec(text) : null;
  if (!match) {
    c.add("budget.amount", "INVALID", "a positive decimal amount with at most two fraction digits");
    return undefined;
  }
  const whole = match[1].replace(/^0+(?=\d)/, "");
  const fraction = (match[2] ?? "").padEnd(2, "0");
  if (/^0+$/.test(whole + fraction)) {
    c.add("budget.amount", "INVALID", "the amount must be above zero");
    return undefined;
  }
  return whole + "." + fraction;
}

function validateTags(raw: unknown, owner: string | undefined, ownerGiven: boolean, c: Collector): Record<string, string> {
  const input = c.object(raw, "tags", Object.keys(raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {}));
  const tags: Record<string, string> = {};
  for (const [key, value] of Object.entries(input)) {
    const path = "tags." + key;
    if (!TAG_KEY.test(key)) c.add(path, "INVALID_KEY", "letters, digits, spaces and _ . : / = + - @, at most 128");
    else if (/^aws:/i.test(key)) c.add(path, "RESERVED_KEY", "the aws: prefix belongs to AWS");
    else if (/^alz-/i.test(key)) c.add(path, "RESERVED_KEY", "the alz- prefix is the deletion-unit tag scheme");
    else if (PROTOTYPE_KEYS.has(key)) c.add(path, "RESERVED_KEY", "a prototype key is never a tag");
    else if (typeof value !== "string" || !TAG_VALUE.test(value)) {
      c.add(path, "INVALID_VALUE", "a non-empty value of letters, digits, spaces and _ . : / = + - @, at most 256");
    } else tags[key] = value;
  }
  if (tags.owner === undefined && input.owner === undefined && owner !== undefined) tags.owner = owner;
  for (const key of COST_REQUIRED_TAG_KEYS) {
    // An invalid owner is reported once, at `owner`, not again as a missing owner tag.
    if (tags[key] === undefined && input[key] === undefined && !(key === "owner" && ownerGiven)) {
      c.add("tags." + key, "REQUIRED", "every cost-attributed resource carries " + COST_REQUIRED_TAG_KEYS.join(", "));
    }
  }
  const extra = Object.keys(tags).filter((key) => !(COST_REQUIRED_TAG_KEYS as readonly string[]).includes(key));
  if (extra.length > MAX_EXTRA_TAGS) c.add("tags", "TOO_MANY", "at most " + MAX_EXTRA_TAGS + " tags beyond the required ones");
  return Object.fromEntries(Object.entries(tags).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

function validateNotifications(raw: unknown, c: Collector): CostNotifications | undefined {
  const input = c.object(raw, "notifications", ["route", "emails", "snsTopicArn", "encryption"], true);
  const snsTopicArn = c.optionalString(input.snsTopicArn, "notifications.snsTopicArn", SNS_ARN,
    "an SNS topic ARN in the aws partition");
  const route = c.oneOf<CostNotificationRoute>(input.route, "notifications.route",
    ["SNS_TOPIC", "EMAIL_DIRECT", "EXISTING_SNS_TOPIC"], input.snsTopicArn !== undefined ? "EXISTING_SNS_TOPIC" : "SNS_TOPIC");
  const emails = c.strings(input.emails, "notifications.emails", EMAIL, "an email address", AWS_BUDGET_MAX_EMAILS);
  if (route === "EXISTING_SNS_TOPIC") {
    if (input.snsTopicArn === undefined) c.add("notifications.snsTopicArn", "REQUIRED", "the adopted topic's ARN");
  } else {
    if (input.snsTopicArn !== undefined) {
      c.add("notifications.snsTopicArn", "NOT_ALLOWED", "only the EXISTING_SNS_TOPIC route names a topic");
    }
    if (Array.isArray(input.emails) ? input.emails.length === 0 : true) {
      c.add("notifications.emails", "REQUIRED", "at least one recipient for the " + (route ?? "chosen") + " route");
    }
  }
  const encryption = c.oneOf<CostTopicEncryption>(input.encryption, "notifications.encryption",
    ["NONE", "CUSTOMER_KMS"], route === "SNS_TOPIC" ? "CUSTOMER_KMS" : "NONE");
  if (encryption === "CUSTOMER_KMS" && route !== "SNS_TOPIC") {
    c.add("notifications.encryption", "NOT_ALLOWED", "only the SNS_TOPIC route creates a topic to encrypt");
  }
  if (!route || !encryption) return undefined;
  return { route, emails, ...(snsTopicArn && route === "EXISTING_SNS_TOPIC" ? { snsTopicArn } : {}), encryption };
}

function validateBudget(raw: unknown, c: Collector): CostBudget | undefined {
  const input = c.object(raw, "budget",
    ["name", "amount", "currency", "period", "actualThresholds", "forecastThresholds"], true);
  const name = c.string(input.name, "budget.name", BUDGET_NAME, "letters, digits and _ . -, at most 100",
    COST_DEFAULTS.budgetName);
  const amount = normalizeAmount(input.amount, c);
  const currency = c.string(input.currency, "budget.currency", CURRENCY, "a three-letter currency code",
    COST_DEFAULTS.currency);
  const period = c.oneOf<CostBudgetPeriod>(input.period, "budget.period", ["MONTHLY", "QUARTERLY", "ANNUALLY"],
    COST_DEFAULTS.period);
  const actualThresholds = c.percents(input.actualThresholds, "budget.actualThresholds", COST_DEFAULTS.actualThresholds);
  const forecastThresholds = c.percents(input.forecastThresholds, "budget.forecastThresholds",
    COST_DEFAULTS.forecastThresholds);
  if (actualThresholds.length + forecastThresholds.length === 0) {
    c.add("budget", "NO_ALERTS", "at least one actual or forecast threshold");
  }
  if (actualThresholds.length + forecastThresholds.length > AWS_BUDGET_MAX_NOTIFICATIONS) {
    c.add("budget", "TOO_MANY_ALERTS", "AWS Budgets allows " + AWS_BUDGET_MAX_NOTIFICATIONS +
      " notifications per budget, actual and forecast together");
  }
  if (!name || !amount || !currency || !period) return undefined;
  return { name, amount, currency, period, actualThresholds, forecastThresholds };
}

function validateBudgetAction(raw: unknown, c: Collector): CostBudgetAction {
  if (raw === undefined) return { enabled: false };
  const input = c.object(raw, "budgetAction", ["enabled", "type", "thresholdPercent", "approvalModel",
    "executionRoleArn", "policyArn", "roles", "groups", "users"], true);
  if (input.enabled === false) {
    const extra = Object.keys(input).filter((key) => key !== "enabled");
    if (extra.length > 0) c.add("budgetAction", "NOT_ALLOWED", "a disabled budget action takes no other fields");
    return { enabled: false };
  }
  if (input.enabled !== true) {
    c.add("budgetAction.enabled", "REQUIRED", "true or false; a budget action is never implied");
    return { enabled: false };
  }
  const type = c.oneOf<"APPLY_IAM_POLICY">(input.type, "budgetAction.type", ["APPLY_IAM_POLICY"]);
  const thresholdPercent = input.thresholdPercent === undefined
    ? (c.add("budgetAction.thresholdPercent", "REQUIRED", "the actual-spend percentage that starts the action"), undefined)
    : c.percent(input.thresholdPercent, "budgetAction.thresholdPercent");
  const approvalModel = c.oneOf<"MANUAL" | "AUTOMATIC">(input.approvalModel, "budgetAction.approvalModel",
    ["MANUAL", "AUTOMATIC"], "MANUAL");
  const executionRoleArn = c.string(input.executionRoleArn, "budgetAction.executionRoleArn", ROLE_ARN,
    "the IAM role ARN AWS Budgets assumes to run the action");
  const policyArn = c.string(input.policyArn, "budgetAction.policyArn", POLICY_ARN, "the IAM policy ARN to attach");
  const roles = c.strings(input.roles, "budgetAction.roles", IAM_NAME, "an IAM role name", 100);
  const groups = c.strings(input.groups, "budgetAction.groups", IAM_NAME, "an IAM group name", 100);
  const users = c.strings(input.users, "budgetAction.users", IAM_NAME, "an IAM user name", 100);
  if (roles.length + groups.length + users.length === 0) {
    c.add("budgetAction", "NO_TARGET", "name at least one role, group or user the policy is attached to");
  }
  if (!type || thresholdPercent === undefined || !approvalModel || !executionRoleArn || !policyArn) return { enabled: false };
  return { enabled: true, type, thresholdPercent, approvalModel, executionRoleArn, policyArn, roles, groups, users };
}

function validateLimits(raw: unknown, c: Collector): CostProvisioningLimits {
  const input = c.object(raw, "limits", ["allowedRegions", "resourceFamilies", "sizes", "quantities"]);
  const allowedRegions = c.strings(input.allowedRegions, "limits.allowedRegions", REGION, "an AWS region id", 40);
  const resourceFamilies = c.strings(input.resourceFamilies, "limits.resourceFamilies", FAMILY,
    "a lowercase family name such as ec2", 100);
  const sizesIn = c.object(input.sizes, "limits.sizes",
    Object.keys(input.sizes && typeof input.sizes === "object" && !Array.isArray(input.sizes) ? input.sizes : {}));
  const sizes: Record<string, string[]> = {};
  for (const family of Object.keys(sizesIn).sort()) {
    if (!FAMILY.test(family)) c.add("limits.sizes." + family, "INVALID_KEY", "a lowercase family name");
    else if (!resourceFamilies.includes(family)) {
      c.add("limits.sizes." + family, "UNLISTED_FAMILY", "list the family in limits.resourceFamilies first");
    } else sizes[family] = c.strings(sizesIn[family], "limits.sizes." + family, SIZE, "a size such as t3.micro", 200);
  }
  const quantitiesIn = c.object(input.quantities, "limits.quantities",
    Object.keys(input.quantities && typeof input.quantities === "object" && !Array.isArray(input.quantities)
      ? input.quantities : {}));
  const quantities: Record<string, number> = {};
  for (const type of Object.keys(quantitiesIn).sort()) {
    if (!RESOURCE_TYPE.test(type)) {
      c.add("limits.quantities." + type, "INVALID_KEY", "a Terraform resource type such as aws_instance");
      continue;
    }
    const count = c.integer(quantitiesIn[type], "limits.quantities." + type, 0, 10000);
    if (count !== undefined) quantities[type] = count;
  }
  return { allowedRegions, resourceFamilies, sizes, quantities };
}

function validateReview(raw: unknown, c: Collector): CostReview | undefined {
  const input = c.object(raw, "review", ["reviewBy", "expiresOn"], true);
  const reviewBy = c.date(input.reviewBy, "review.reviewBy", true);
  const expiresOn = c.date(input.expiresOn, "review.expiresOn", false);
  if (reviewBy && expiresOn && expiresOn < reviewBy) {
    c.add("review.expiresOn", "BEFORE_REVIEW", "the configuration cannot lapse before its review date");
  }
  if (!reviewBy || (input.expiresOn !== undefined && !expiresOn)) return undefined;
  return { reviewBy, ...(expiresOn ? { expiresOn } : {}) };
}

function validateExport(raw: unknown, c: Collector): CostExport | undefined {
  const input = c.object(raw, "export",
    ["mode", "exportName", "bucketName", "bucketRegion", "prefix", "granularity", "retentionDays"]);
  const mode = c.oneOf<CostExport["mode"]>(input.mode, "export.mode", ["NEW_BUCKET", "ADOPT_EXISTING"], "NEW_BUCKET");
  const exportName = c.string(input.exportName, "export.exportName", EXPORT_NAME,
    "letters, digits, _ and -, at most 128", COST_DEFAULTS.exportName);
  const prefix = c.string(input.prefix, "export.prefix", PREFIX,
    "lowercase letters, digits and / _ . -, no leading or trailing separator", COST_DEFAULTS.prefix);
  const granularity = c.oneOf<CostExportGranularity>(input.granularity, "export.granularity", ["DAILY", "HOURLY"],
    COST_DEFAULTS.granularity);
  const bucketHint = "an S3 bucket name: 3 to 63 lowercase letters, digits and -, with no dots (they break " +
    "virtual-hosted TLS) and none of the names S3 reserves (xn--, sthree-, amzn-s3-demo-, -s3alias, --ol-s3, --x-s3, " +
    "--table-s3)";
  const bucketName = input.bucketName === undefined ? undefined
    : c.string(input.bucketName, "export.bucketName", BUCKET, bucketHint);
  if (bucketName && BUCKET_RESERVED.some((pattern) => pattern.test(bucketName))) {
    c.add("export.bucketName", "RESERVED", bucketHint);
  }
  if (mode === "ADOPT_EXISTING") {
    if (input.bucketName === undefined) c.add("export.bucketName", "REQUIRED", "the existing bucket to adopt");
    const bucketRegion = c.string(input.bucketRegion, "export.bucketRegion", REGION, "the existing bucket's region");
    if (input.retentionDays !== undefined) {
      c.add("export.retentionDays", "NOT_ALLOWED", "an adopted bucket keeps its owner's lifecycle rules");
    }
    if (!exportName || !prefix || !granularity || !bucketName || !bucketRegion) return undefined;
    return { mode, exportName, bucketName, bucketRegion, prefix, granularity };
  }
  if (input.bucketRegion !== undefined) {
    c.add("export.bucketRegion", "NOT_ALLOWED", "a new bucket is created in the landing zone's home region");
  }
  const retentionDays = c.integer(input.retentionDays, "export.retentionDays", 1, 3650, COST_DEFAULTS.retentionDays);
  if (!mode || !exportName || !prefix || !granularity || retentionDays === undefined ||
    (input.bucketName !== undefined && !bucketName)) return undefined;
  return { mode, exportName, ...(bucketName ? { bucketName } : {}), prefix, granularity, retentionDays };
}

/** Every problem in `input`, or the resolved configuration with its defaults filled in. Idempotent on its output. */
export function validateCostConfig(input: unknown):
  { ok: true; config: CostConfig } | { ok: false; issues: CostConfigIssue[] } {
  const c = new Collector();
  const root = c.object(input, "cost", ["schema", "owner", "notifications", "tags", "budget", "budgetAction",
    "limits", "review", "export", "activateCostAllocationTags", "analytics"], true);
  if (root.schema !== undefined && root.schema !== 1) c.add("cost.schema", "UNSUPPORTED", "schema 1 only");
  const owner = c.string(root.owner, "owner", TAG_VALUE,
    "the accountable owner (a team or an email), letters, digits, spaces and _ . : / = + - @");
  const notifications = validateNotifications(root.notifications, c);
  const tags = validateTags(root.tags, owner, root.owner !== undefined, c);
  const budget = validateBudget(root.budget, c);
  const budgetAction = validateBudgetAction(root.budgetAction, c);
  const limits = validateLimits(root.limits, c);
  const review = validateReview(root.review, c);
  const exported = validateExport(root.export, c);
  const analytics = c.oneOf<"OFF" | "ON">(root.analytics, "analytics", ["OFF", "ON"], "OFF");
  const activate = root.activateCostAllocationTags;
  if (activate !== undefined && typeof activate !== "boolean") {
    c.add("activateCostAllocationTags", "INVALID", "true or false; off unless the keys already appear in billing data");
  }
  const activateCostAllocationTags = activate === true;
  if (c.issues.length > 0 || !owner || !notifications || !budget || !review || !exported || !analytics) {
    if (c.issues.length === 0) c.add("cost", "INVALID", "the configuration is incomplete");
    return { ok: false, issues: c.issues };
  }
  return {
    ok: true,
    config: { schema: 1, owner, notifications, tags, budget, budgetAction, limits, review, export: exported,
      activateCostAllocationTags, analytics },
  };
}

/** The resolved configuration, or a CostConfigError naming every problem. */
export function resolveCostConfig(input: unknown): CostConfig {
  const result = validateCostConfig(input);
  if (!result.ok) throw new CostConfigError(result.issues);
  return result.config;
}

/** A stable hash of a resolved configuration; the build binds it into its evidence. */
export function costConfigHash(config: CostConfig): string {
  return sha256(JSON.stringify(resolveCostConfig(config)));
}

/** The budget action's effect in one plain sentence, shown before deploy. A disabled action says so. */
export function describeBudgetAction(config: CostConfig): string {
  const action = config.budgetAction;
  if (!action.enabled) return "No budget action: the budget sends alerts only and never changes resources or permissions.";
  const targets = [
    action.roles.length ? "roles " + action.roles.join(", ") : "",
    action.groups.length ? "groups " + action.groups.join(", ") : "",
    action.users.length ? "users " + action.users.join(", ") : "",
  ].filter(Boolean).join("; ");
  return "When actual spend reaches " + action.thresholdPercent + "% of " + config.budget.amount + " " +
    config.budget.currency + " (" + config.budget.period.toLowerCase() + "), AWS Budgets attaches " + action.policyArn +
    " to " + targets + (action.approvalModel === "MANUAL"
      ? ", after a person approves the action in AWS Budgets."
      : ", automatically and without a person's approval.") +
    " This restricts permissions; it does not stop running resources or cap spend.";
}
