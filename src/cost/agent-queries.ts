import { runGovernedTool } from "../tools/governed.js";
import type { ToolRequest, ToolResult } from "../tools/types.js";
import { operatorReadCredentials, type OperatorReadCredentials } from "./operator-credentials.js";

const RESOURCE_TYPES = {
  kms: ["kms:key"],
  ec2: ["ec2:volume", "ec2:snapshot", "ec2:natgateway", "ec2:elastic-ip", "ec2:vpc-endpoint"],
} as const;

type CostQuery = {
  start: string;
  end: string;
  granularity: "DAILY" | "MONTHLY";
  groupBy: Array<"SERVICE" | "REGION" | "USAGE_TYPE">;
  services?: string[];
  region?: string;
};

function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function monthStart(year: number, month: number): Date {
  return new Date(Date.UTC(year, month, 1));
}

/** Convert a plain cost question into a narrow Cost Explorer request; never accept arbitrary AWS CLI arguments. */
export function parseCostQuestion(question: string, now = new Date()): CostQuery {
  const value = question.toLowerCase();
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  let start: Date;
  let end = today;
  let monthly = false;
  const monthNames = "january february march april may june july august september october november december".split(" ");
  const namedMonth = new RegExp("\\b(" + monthNames.join("|") + ")(?:\\s+(20\\d{2}))?\\b", "i").exec(value);
  const numericMonth = /\b(20\d{2})-(0[1-9]|1[0-2])\b/.exec(value);
  const relativeDays = /\blast\s+(7|14|30|60|90)\s+days?\b/.exec(value);
  if (/\blast month\b/.test(value)) {
    start = monthStart(today.getUTCFullYear(), today.getUTCMonth() - 1);
    end = monthStart(today.getUTCFullYear(), today.getUTCMonth());
    monthly = true;
  } else if (/\bthis month\b|\bmonth to date\b/.test(value)) {
    start = monthStart(today.getUTCFullYear(), today.getUTCMonth());
    monthly = true;
  } else if (namedMonth || numericMonth) {
    const month = namedMonth ? monthNames.indexOf(namedMonth[1].toLowerCase()) : Number(numericMonth?.[2]) - 1;
    const year = Number(namedMonth?.[2] ?? numericMonth?.[1] ?? today.getUTCFullYear());
    start = monthStart(year, month);
    end = monthStart(year, month + 1);
    monthly = true;
  } else if (relativeDays) {
    start = new Date(today.valueOf() - Number(relativeDays[1]) * 86400000);
    monthly = Number(relativeDays[1]) > 30;
  } else {
    // Default to the last complete month, which is the least ambiguous billing period.
    start = monthStart(today.getUTCFullYear(), today.getUTCMonth() - 1);
    end = monthStart(today.getUTCFullYear(), today.getUTCMonth());
    monthly = true;
  }

  const services: string[] = [];
  if (/\b(kms|key management service)\b/.test(value)) services.push("AWS Key Management Service");
  if (/\b(ec2|ebs|elastic compute|nat gateway|vpc endpoint|snapshot)\b/.test(value)) services.push("EC2 - Other");
  const groupBy: CostQuery["groupBy"] = /\b(usage type|usage types|usage breakdown|detailed breakdown)\b/.test(value)
    ? ["SERVICE", "USAGE_TYPE"]
    : /\b(by|per|across) regions?\b|\bregional breakdown\b/.test(value)
      ? ["SERVICE", "REGION"]
      : ["SERVICE"];
  const region = requestedResourceRegion(question);
  return {
    start: isoDay(start), end: isoDay(end), granularity: monthly ? "MONTHLY" : "DAILY", groupBy,
    ...(services.length ? { services } : {}),
    ...(region ? { region } : {}),
  };
}

function runRead(request: ToolRequest, credentials: OperatorReadCredentials): Promise<ToolResult | ToolResult[]> {
  return runGovernedTool(request, {
    cwd: process.cwd(), allowCloudRead: true, allowMutation: false,
    credentialEnvironment: credentials.env,
  });
}

function firstResult(result: ToolResult | ToolResult[]): ToolResult {
  return Array.isArray(result) ? result[0] : result;
}

function parseOutput<T>(result: ToolResult): T | undefined {
  if (!result.ok) return undefined;
  try { return JSON.parse(result.stdout) as T; } catch { return undefined; }
}

function accountOf(credentials: OperatorReadCredentials): Promise<{ accountId?: string; problem?: string }> {
  return runRead({ tool: "aws_sts_identity" }, credentials).then((raw) => {
    const result = firstResult(raw);
    const identity = parseOutput<{ Account?: string }>(result);
    if (!identity?.Account || !/^\d{12}$/.test(identity.Account)) return { problem: "AWS identity is unavailable. Sign in with the intended AWS profile and try again." };
    return { accountId: identity.Account };
  }).catch(() => ({ problem: "AWS identity is unavailable. Sign in with the intended AWS profile and try again." }));
}

function blockedMessage(result: ToolResult): string {
  if (result.blocked) return "The local security policy refused this AWS read. No changes were made.";
  if (/AccessDenied|UnauthorizedOperation|not authorized/i.test(result.stderr)) {
    const permission = result.tool === "aws_ce_get_cost_and_usage" ? "ce:GetCostAndUsage" : "tag:GetResources";
    return "AWS denied this read. The active identity needs " + permission + " for the current account. No changes were made.";
  }
  return "AWS did not return the requested data. Check Cost Explorer or Resource Groups Tagging API read permission, the AWS region, and the profile session. No changes were made.";
}

type CostResponse = {
  ResultsByTime?: Array<{
    TimePeriod?: { Start?: string; End?: string };
    Groups?: Array<{ Keys?: string[]; Metrics?: { UnblendedCost?: { Amount?: string; Unit?: string } } }>;
    Total?: { UnblendedCost?: { Amount?: string; Unit?: string } };
  }>;
};

/** Natural-language cost report against the authenticated account only. */
export async function queryAwsCosts(question: string, now = new Date()): Promise<string> {
  if (/\b(all accounts|organization-wide|across accounts|every account)\b/i.test(question)) {
    return "This cost command is scoped to the currently authenticated AWS account. Organization-wide queries need an explicit billing-view authorization.";
  }
  const query = parseCostQuestion(question, now);
  const durationDays = (Date.parse(query.end + "T00:00:00Z") - Date.parse(query.start + "T00:00:00Z")) / 86400000;
  if (durationDays < 1 || durationDays > 366) return "Cost Explorer queries must cover between 1 and 366 days.";
  const currentDay = isoDay(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())));
  if (query.start >= currentDay || query.end > currentDay) return "That date range has no completed billing days yet. Choose a past month or completed date range.";
  const auth = operatorReadCredentials();
  if (!auth.ok) return auth.message;
  const identity = await accountOf(auth.credentials);
  if (!identity.accountId) return identity.problem!;
  const raw = await runRead({
    tool: "aws_ce_get_cost_and_usage", accountId: identity.accountId,
    costStartDate: query.start, costEndDate: query.end, costGranularity: query.granularity,
    costGroupBy: query.groupBy, ...(query.services ? { costServices: query.services } : {}), ...(query.region ? { costRegion: query.region } : {}),
  }, auth.credentials).catch(() => undefined);
  if (!raw) return "Cost Explorer could not be reached. Check network access and retry. No changes were made.";
  const result = firstResult(raw);
  if (!result.ok) return blockedMessage(result);
  const answer = parseOutput<CostResponse>(result);
  if (!answer?.ResultsByTime) return "Cost Explorer returned an unreadable response. No changes were made.";
  const lines = ["AWS Cost Explorer (read-only)", "Account: " + identity.accountId, "Period: " + query.start + " through " + query.end + " (end date exclusive)"];
  let rows = 0;
  for (const period of answer.ResultsByTime) {
    for (const group of period.Groups ?? []) {
      if (rows >= 50) continue;
      const amount = group.Metrics?.UnblendedCost?.Amount;
      if (amount === undefined || !Number.isFinite(Number(amount))) continue;
      const labels = group.Keys ?? [];
      const label = labels.length ? labels.join(" / ") : "Total";
      lines.push(label + ": " + Number(amount).toFixed(2) + " " + (group.Metrics?.UnblendedCost?.Unit ?? "USD"));
      rows++;
    }
    if (!period.Groups?.length && period.Total?.UnblendedCost?.Amount !== undefined) {
      lines.push("Total: " + Number(period.Total.UnblendedCost.Amount).toFixed(2) + " " + (period.Total.UnblendedCost.Unit ?? "USD"));
      rows++;
    }
  }
  if (rows >= 50) lines.push("Showing the first 50 rows; narrow the date range or services for more detail.");
  if (!rows) lines.push("No cost rows were returned for this period; billing data can lag, so this does not prove zero spend.");
  lines.push("Cost Explorer does not identify the individual resource behind every charge. Ask for tagged resource inventory to inspect supported KMS and EC2 resources.");
  lines.push("Read-only: no AWS resources changed.");
  return lines.join("\n");
}

function tagValue(key: string, value: string): string {
  return /secret|token|password|credential|private.?key/i.test(key) ? "[redacted]" : value;
}

type TagInventory = { ResourceTagMappingList?: Array<{ ResourceARN?: string; Tags?: Array<{ Key?: string; Value?: string }> }> };

export function requestedResourceRegion(question: string, configuredRegion?: string): string | undefined {
  const requested = /\b([a-z]{2}(?:-[a-z]+)+-[0-9])\b/i.exec(question)?.[1]?.toLowerCase();
  return requested ?? configuredRegion;
}

/** Read the current AWS region's tagged KMS and EC2 cost-driver resources; untagged resources are not included by this API. */
export async function discoverCostResourceTags(question: string): Promise<string> {
  const auth = operatorReadCredentials();
  if (!auth.ok) return auth.message;
  const identity = await accountOf(auth.credentials);
  if (!identity.accountId) return identity.problem!;
  const region = requestedResourceRegion(question, auth.credentials.region);
  if (!region) return "Set a default AWS region on the active profile before listing regional resource tags.";
  const value = question.toLowerCase();
  const types = [
    ...(/\b(kms|key management)\b/.test(value) ? RESOURCE_TYPES.kms : []),
    ...(/\b(ec2|ebs|snapshot|nat gateway|vpc endpoint)\b/.test(value) ? RESOURCE_TYPES.ec2 : []),
  ];
  const selected = types.length ? [...new Set(types)] : [...RESOURCE_TYPES.kms, ...RESOURCE_TYPES.ec2];
  const raw = await runRead({ tool: "aws_tagging_get_resources_by_type", resourceTypes: selected, region }, auth.credentials).catch(() => undefined);
  if (!raw) return "Resource tag discovery could not reach AWS. Check network access and retry. No changes were made.";
  const result = firstResult(raw);
  if (!result.ok) return blockedMessage(result);
  const inventory = parseOutput<TagInventory>(result);
  if (!inventory?.ResourceTagMappingList) return "AWS returned an unreadable tag inventory. No changes were made.";
  const rows = inventory.ResourceTagMappingList.slice(0, 50).map((resource) => {
    const tags = (resource.Tags ?? []).map((tag) => (tag.Key ?? "") + "=" + tagValue(tag.Key ?? "", tag.Value ?? "")).join(", ") || "no tags reported";
    return (resource.ResourceARN ?? "resource ARN unavailable") + " — " + tags;
  });
  const lines = ["Tagged KMS and EC2 cost-driver resources (read-only)", "Account: " + identity.accountId, "Region: " + region];
  if (rows.length) lines.push(...rows);
  else lines.push("No tagged resources of the requested types were returned in " + region + ".");
  if (inventory.ResourceTagMappingList.length > rows.length) lines.push("Showing first 50 tagged resources.");
  lines.push("This API does not return never-tagged resources. No AWS resources changed.");
  return lines.join("\n");
}
