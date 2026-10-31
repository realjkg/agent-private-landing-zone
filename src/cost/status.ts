import { awsCostReadArgs, type AwsCostReadTool } from "../tools/aws-cost-reads.js";
import { runGovernedTool } from "../tools/governed.js";
import type { BudgetNotificationKey, ToolContext, ToolRequest } from "../tools/types.js";

/**
 * The read-only AWS cost status (plan item 4; owner direction 2026-10-31, issue #39 comment 6536926009).
 *
 * It reads what the cost baseline deployed (budget, notifications and subscribers, the unit's tags, cost-allocation tag
 * activation, the CUR 2.0 export and its executions) and reports it with every value labeled:
 * - OBSERVED: read from AWS in this call;
 * - ESTIMATE: AWS's own forecast, or a value derived from the clock, with its basis named;
 * - UNKNOWN: not read, with the reason (a denied read, a malformed answer, or a value AWS does not report).
 *
 * Nothing here writes, retries silently or gates ACT. A missing or empty answer is never read as zero spend, a denied read is
 * never a pass, and an export with no delivery yet is WAITING, not healthy. The reader is injected (`CostRead`), so the
 * whole model runs offline against fixtures; `brokerCostRead` runs the same calls through the governed path to the tool broker's exact argv.
 *
 * The Python budget read-back (scripts/act-dev1-readiness.py, budget_inspection) is ported in `readBudget`: the budget's
 * type, limit, notification count and whether an ACTUAL alert exists, extended with subscribers, spend and filters.
 */

export type ValueLabel = "OBSERVED" | "ESTIMATE" | "UNKNOWN";
export type UnknownReason =
  | "ACCESS_DENIED"
  | "THROTTLED"
  | "CREDENTIALS"
  | "READ_BLOCKED"
  | "READ_FAILED"
  | "MALFORMED_RESPONSE"
  /** AWS has no API for this value (for example, whether a Budgets email recipient confirmed). */
  | "NOT_REPORTED_BY_AWS"
  /** The value exists in another service this status does not read (SNS subscription confirmation). */
  | "NOT_READ"
  /** The thing it belongs to was not found, so the value cannot exist yet. */
  | "PARENT_MISSING"
  /** Cost Explorer lists a tag key only after billing has seen it on a resource. */
  | "TAG_KEY_NOT_YET_IN_BILLING"
  /** The caller did not name it (no unit id, no export). */
  | "NOT_REQUESTED"
  /** The optional analytics pack is off. */
  | "NOT_SELECTED"
  /** The analytics pack is selected, and its status is phase 2. */
  | "PHASE_2_NOT_READ";

export type Labeled<T> =
  | { label: "OBSERVED"; value: T }
  | { label: "ESTIMATE"; value: T; basis: string }
  | { label: "UNKNOWN"; reason: UnknownReason };

export type Money = { amount: string; unit: string };
export type BudgetPeriod = "DAILY" | "MONTHLY" | "QUARTERLY" | "ANNUALLY";

export type SubscriberStatus = {
  type: "EMAIL" | "SNS";
  address: string;
  /** Budgets does not report email confirmation; SNS confirmation lives in SNS, which this status does not read. */
  confirmation: Labeled<"CONFIRMED" | "PENDING">;
};

export type NotificationStatus = {
  notificationType: "ACTUAL" | "FORECASTED";
  comparisonOperator: "GREATER_THAN" | "LESS_THAN" | "EQUAL_TO";
  threshold: string;
  thresholdType: "PERCENTAGE" | "ABSOLUTE_VALUE";
  /** OK or ALARM, as Budgets last evaluated it. */
  alarmState: Labeled<"OK" | "ALARM">;
  subscribers: Labeled<SubscriberStatus[]>;
};

export type BudgetStatus = {
  name: string;
  /** PRESENT and MISSING are observed; UNKNOWN means the budget could not be read. */
  state: "PRESENT" | "MISSING" | "UNKNOWN";
  budgetCount: Labeled<number>;
  budgetType: Labeled<string>;
  limit: Labeled<Money>;
  period: Labeled<BudgetPeriod>;
  filters: Labeled<Record<string, string[]>>;
  /** Spend Budgets calculated so far this period. Absent from the answer means UNKNOWN, never zero. */
  actualSpend: Labeled<Money>;
  /** AWS's forecast: an ESTIMATE by definition. */
  forecastedSpend: Labeled<Money>;
  spendUpdatedAt: Labeled<string>;
  notifications: Labeled<NotificationStatus[]>;
  hasActualAlert: Labeled<boolean>;
  hasForecastAlert: Labeled<boolean>;
  /** A budget alerts; it never stops spend. */
  hardSpendCap: false;
};

export type ResourceTagStatus = { arn: string; present: string[]; missing: string[] };
export type TagStatus = {
  /** NO_RESOURCES_FOUND is not a pass: nothing tagged with the unit was listed. */
  state: "ALL_PRESENT" | "MISSING" | "NO_RESOURCES_FOUND" | "UNKNOWN";
  required: string[];
  /** The tagging API lists resources carrying the unit's tag; a resource without it is not seen here. */
  coverage: "UNIT_TAGGED_RESOURCES_ONLY";
  resources: Labeled<ResourceTagStatus[]>;
};

export type CostAllocationTagStatus = {
  state: "ALL_ACTIVE" | "INACTIVE" | "UNKNOWN";
  tags: { key: string; status: Labeled<"Active" | "Inactive">; lastUpdated: Labeled<string> }[];
};

export type ExecutionState = "DELIVERED" | "IN_PROGRESS" | "FAILED";
export type ExportStatus = {
  /**
   * DELIVERED: the latest delivery succeeded within the freshness window. WAITING: the export exists and nothing has been
   * delivered yet, with no failure. STALE: the last delivery is older than the window. FAILED: the latest finished execution
   * failed, or AWS reports the export UNHEALTHY. MISSING: no such export. UNKNOWN: not read.
   */
  state: "DELIVERED" | "WAITING" | "STALE" | "FAILED" | "MISSING" | "UNKNOWN" | "NOT_REQUESTED";
  arn: Labeled<string>;
  name: Labeled<string>;
  configValid: Labeled<boolean>;
  configProblems: string[];
  destination: Labeled<{ bucket: string; prefix: string; region: string }>;
  health: Labeled<"HEALTHY" | "UNHEALTHY">;
  createdAt: Labeled<string>;
  lastExecution: Labeled<{ id: string; state: ExecutionState; statusCode: string; at: string; reason?: string }>;
  lastDelivery: Labeled<string>;
};

export type FreshnessStatus = {
  state: "FRESH" | "WAITING" | "STALE" | "UNKNOWN";
  /** The billing month this status falls in, from the capture clock (UTC). */
  billingPeriod: Labeled<string>;
  latestDelivery: Labeled<string>;
  staleAfterHours: number;
  /** Phase 2 (the optional analytics pack): present so the panel can show them, never read here. */
  analyticsIngestion: Labeled<string>;
  dashboardRefresh: Labeled<string>;
};

export type CostStatusOverall = "OBSERVED_COMPLETE" | "WAITING" | "STALE" | "ATTENTION" | "INCOMPLETE";

export type CostStatus = {
  kind: "ALZ_COST_STATUS";
  source: "AWS_API_READ_ONLY";
  accountId: string;
  capturedAt: string;
  /** ATTENTION (something missing or failed) outranks STALE, INCOMPLETE (something UNKNOWN), WAITING and OBSERVED_COMPLETE. */
  overall: CostStatusOverall;
  budget: BudgetStatus;
  tags: TagStatus;
  costAllocationTags: CostAllocationTagStatus;
  export: ExportStatus;
  freshness: FreshnessStatus;
  advisory: true;
  actEnabled: false;
};

export type CostStatusRequest = {
  accountId: string;
  budgetName: string;
  requiredTagKeys: readonly string[];
  /** The deletion unit whose resources must carry the required tags. Absent: the tag check is NOT_REQUESTED (UNKNOWN). */
  unitId?: string;
  /** The region the unit's resources are in (the tagging API is regional). Required with `unitId`. */
  region?: string;
  /** The CUR 2.0 export, by ARN or by name. Neither: the export is NOT_REQUESTED. */
  exportArn?: string;
  exportName?: string;
  /** The destination bucket the configuration intends; a different bucket is a config problem. */
  expectedBucket?: string;
  analytics: "off" | "on";
  /** Default 48: delivery is at least daily, so two days without one is stale. */
  staleAfterHours?: number;
};

/** One cost read. It returns the parsed JSON answer, or throws an Error whose message carries the AWS error text. */
export type CostReadRequest = ToolRequest & { tool: AwsCostReadTool };
export type CostRead = (request: CostReadRequest) => Promise<unknown>;

/** The production reader: the governed path to the broker's exact argv, read-only cloud access, and nothing else. */
export function brokerCostRead(context: Omit<ToolContext, "allowCloudRead" | "allowMutation">): CostRead {
  return async (request) => {
    const result = await runGovernedTool(request, { ...context, allowCloudRead: true, allowMutation: false });
    if (Array.isArray(result)) throw new Error("READ_BLOCKED: unexpected multi-result");
    if (result.blocked) throw new Error("READ_BLOCKED: " + (result.reason ?? ""));
    if (!result.ok) throw new Error(result.stderr || "READ_FAILED");
    if (result.truncated) throw new Error("READ_FAILED: truncated");
    return JSON.parse(result.stdout) as unknown;
  };
}

// --- reading helpers ----------------------------------------------------------------------------

class Malformed extends Error {}
type Read<T> = { ok: true; value: T } | { ok: false; reason: UnknownReason; notFound: boolean };

const ERROR_CLASSES: readonly [RegExp, UnknownReason][] = [
  [/READ_BLOCKED/, "READ_BLOCKED"],
  [/AccessDenied|UnauthorizedOperation|not authorized/i, "ACCESS_DENIED"],
  [/Throttl|TooManyRequests|RequestLimitExceeded/i, "THROTTLED"],
  [/ExpiredToken|InvalidClientTokenId|UnrecognizedClient|Unable to locate credentials/i, "CREDENTIALS"],
];
const NOT_FOUND = /\((?:ResourceNotFoundException|NotFoundException)\)/;

async function attempt<T>(read: CostRead, request: CostReadRequest, parse: (json: unknown) => T): Promise<Read<T>> {
  // Refuse locally exactly what the broker would refuse, so an injected reader cannot be asked for another shape.
  if ("reason" in awsCostReadArgs(request)) return { ok: false, reason: "READ_BLOCKED", notFound: false };
  let json: unknown;
  try {
    json = await read(request);
  } catch (error) {
    if (error instanceof SyntaxError) return { ok: false, reason: "MALFORMED_RESPONSE", notFound: false };
    const message = error instanceof Error ? error.message : String(error);
    const reason = ERROR_CLASSES.find(([pattern]) => pattern.test(message))?.[1] ?? "READ_FAILED";
    return { ok: false, reason, notFound: reason === "READ_FAILED" && NOT_FOUND.test(message) };
  }
  try {
    return { ok: true, value: parse(json) };
  } catch (error) {
    if (error instanceof Malformed) return { ok: false, reason: "MALFORMED_RESPONSE", notFound: false };
    throw error;
  }
}

const obj = (value: unknown): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Malformed();
  return value as Record<string, unknown>;
};
const list = (value: unknown): unknown[] => {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Malformed();
  return value;
};
const str = (value: unknown): string => {
  if (typeof value !== "string") throw new Malformed();
  return value;
};
const optStr = (value: unknown): string | undefined => (value === undefined ? undefined : str(value));
const DECIMAL = /^-?[0-9]+(\.[0-9]+)?$/;
/** The AWS CLI prints Budgets timestamps as ISO strings or epoch seconds; both become ISO. */
const time = (value: unknown): string => {
  if (typeof value === "number" && Number.isFinite(value)) return new Date(value * 1000).toISOString();
  const text = str(value);
  const parsed = Date.parse(text);
  if (Number.isNaN(parsed)) throw new Malformed();
  return new Date(parsed).toISOString();
};
const money = (value: unknown): Money => {
  const m = obj(value);
  const amount = str(m.Amount), unit = str(m.Unit);
  if (!DECIMAL.test(amount) || unit.length === 0) throw new Malformed();
  return { amount, unit };
};

const observed = <T>(value: T): Labeled<T> => ({ label: "OBSERVED", value });
const unknown = <T>(reason: UnknownReason): Labeled<T> => ({ label: "UNKNOWN", reason });
const fromRead = <T>(read: Read<T>): Labeled<T> => (read.ok ? observed(read.value) : unknown(read.reason));

// --- budget -------------------------------------------------------------------------------------

type RawBudget = {
  name: string; type: string; limit?: Money; period?: string; filters: Record<string, string[]>;
  actual?: Money; forecast?: Money; updatedAt?: string;
};
const PERIODS = new Set(["DAILY", "MONTHLY", "QUARTERLY", "ANNUALLY"]);

function parseBudgets(json: unknown): RawBudget[] {
  return list(obj(json).Budgets).map((entry) => {
    const b = obj(entry);
    const filters: Record<string, string[]> = {};
    if (b.CostFilters !== undefined) for (const [key, values] of Object.entries(obj(b.CostFilters))) filters[key] = list(values).map(str);
    const spend = b.CalculatedSpend === undefined ? {} : obj(b.CalculatedSpend);
    return {
      name: str(b.BudgetName), type: str(b.BudgetType),
      limit: b.BudgetLimit === undefined ? undefined : money(b.BudgetLimit),
      period: optStr(b.TimeUnit), filters,
      actual: spend.ActualSpend === undefined ? undefined : money(spend.ActualSpend),
      forecast: spend.ForecastedSpend === undefined ? undefined : money(spend.ForecastedSpend),
      updatedAt: b.LastUpdatedTime === undefined ? undefined : time(b.LastUpdatedTime),
    };
  });
}

type RawNotification = BudgetNotificationKey & { alarmState?: "OK" | "ALARM" };
const TYPES = new Set(["ACTUAL", "FORECASTED"]);
const COMPARISONS = new Set(["GREATER_THAN", "LESS_THAN", "EQUAL_TO"]);
const THRESHOLD_TYPES = new Set(["PERCENTAGE", "ABSOLUTE_VALUE"]);
/** Budgets returns the threshold as a JSON number; it is carried as the plain decimal Budgets accepts back. */
function threshold(value: unknown): string {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new Malformed();
  const text = String(value);
  if (!/^(0|[1-9][0-9]{0,14})(\.[0-9]{1,6})?$/.test(text)) throw new Malformed();
  return text;
}
function parseNotifications(json: unknown): RawNotification[] {
  return list(obj(json).Notifications).map((entry) => {
    const n = obj(entry);
    const notificationType = str(n.NotificationType), comparisonOperator = str(n.ComparisonOperator);
    const thresholdType = n.ThresholdType === undefined ? "PERCENTAGE" : str(n.ThresholdType);
    if (!TYPES.has(notificationType) || !COMPARISONS.has(comparisonOperator) || !THRESHOLD_TYPES.has(thresholdType)) throw new Malformed();
    const state = optStr(n.NotificationState);
    if (state !== undefined && state !== "OK" && state !== "ALARM") throw new Malformed();
    return {
      notificationType: notificationType as RawNotification["notificationType"],
      comparisonOperator: comparisonOperator as RawNotification["comparisonOperator"],
      threshold: threshold(n.Threshold), thresholdType: thresholdType as RawNotification["thresholdType"],
      ...(state === undefined ? {} : { alarmState: state }),
    };
  });
}
function parseSubscribers(json: unknown): SubscriberStatus[] {
  return list(obj(json).Subscribers).map((entry) => {
    const s = obj(entry);
    const type = str(s.SubscriptionType);
    if (type !== "EMAIL" && type !== "SNS") throw new Malformed();
    return { type, address: str(s.Address), confirmation: unknown(type === "EMAIL" ? "NOT_REPORTED_BY_AWS" : "NOT_READ") };
  });
}

async function readBudget(read: CostRead, request: CostStatusRequest): Promise<BudgetStatus> {
  const name = request.budgetName;
  const blank = (state: BudgetStatus["state"], reason: UnknownReason, count: Labeled<number>): BudgetStatus => ({
    name, state, budgetCount: count, budgetType: unknown(reason), limit: unknown(reason), period: unknown(reason), filters: unknown(reason),
    actualSpend: unknown(reason), forecastedSpend: unknown(reason), spendUpdatedAt: unknown(reason), notifications: unknown(reason),
    hasActualAlert: unknown(reason), hasForecastAlert: unknown(reason), hardSpendCap: false,
  });
  const budgets = await attempt(read, { tool: "aws_budgets_describe_budgets", accountId: request.accountId }, parseBudgets);
  // Budgets answers NotFoundException for an account with no budgets at all: an observed absence, not a failed read.
  if (!budgets.ok && budgets.notFound) return blank("MISSING", "PARENT_MISSING", observed(0));
  if (!budgets.ok) return blank("UNKNOWN", budgets.reason, unknown(budgets.reason));
  const found = budgets.value.find((b) => b.name === name);
  if (!found) return blank("MISSING", "PARENT_MISSING", observed(budgets.value.length));

  const notifications = await attempt(read, { tool: "aws_budgets_describe_notifications", accountId: request.accountId, budgetName: name }, parseNotifications);
  let notificationStatus: Labeled<NotificationStatus[]>;
  if (!notifications.ok) {
    notificationStatus = unknown(notifications.reason);
  } else {
    notificationStatus = observed(await Promise.all(notifications.value.map(async (n): Promise<NotificationStatus> => {
      const key: BudgetNotificationKey = { notificationType: n.notificationType, comparisonOperator: n.comparisonOperator, threshold: n.threshold, thresholdType: n.thresholdType };
      const subscribers = await attempt(read, { tool: "aws_budgets_describe_subscribers", accountId: request.accountId, budgetName: name, notification: key }, parseSubscribers);
      return { ...key, alarmState: n.alarmState ? observed(n.alarmState) : unknown("NOT_REPORTED_BY_AWS"), subscribers: fromRead(subscribers) };
    })));
  }
  const has = (type: "ACTUAL" | "FORECASTED"): Labeled<boolean> =>
    notifications.ok ? observed(notifications.value.some((n) => n.notificationType === type)) : unknown(notifications.reason);
  return {
    name, state: "PRESENT", budgetCount: observed(budgets.value.length),
    budgetType: observed(found.type),
    limit: found.limit ? observed(found.limit) : unknown("NOT_REPORTED_BY_AWS"),
    period: found.period && PERIODS.has(found.period) ? observed(found.period as BudgetPeriod) : unknown(found.period ? "MALFORMED_RESPONSE" : "NOT_REPORTED_BY_AWS"),
    filters: observed(found.filters),
    actualSpend: found.actual ? observed(found.actual) : unknown("NOT_REPORTED_BY_AWS"),
    forecastedSpend: found.forecast ? { label: "ESTIMATE", value: found.forecast, basis: "AWS Budgets forecast (CalculatedSpend.ForecastedSpend)" } : unknown("NOT_REPORTED_BY_AWS"),
    spendUpdatedAt: found.updatedAt ? observed(found.updatedAt) : unknown("NOT_REPORTED_BY_AWS"),
    notifications: notificationStatus,
    hasActualAlert: has("ACTUAL"), hasForecastAlert: has("FORECASTED"),
    hardSpendCap: false,
  };
}

// --- tags -----------------------------------------------------------------------------------------

function parseTagged(json: unknown): { arn: string; keys: Set<string> }[] {
  const body = obj(json);
  // The AWS CLI follows the pagination itself; a token left in the answer means the listing is not complete.
  if (typeof body.PaginationToken === "string" && body.PaginationToken !== "") throw new Malformed();
  return list(body.ResourceTagMappingList).map((entry) => {
    const r = obj(entry);
    const keys = new Set(list(r.Tags).map((tag) => str(obj(tag).Key)));
    return { arn: str(r.ResourceARN), keys };
  });
}

async function readTags(read: CostRead, request: CostStatusRequest): Promise<TagStatus> {
  const required = [...request.requiredTagKeys];
  const base = { required, coverage: "UNIT_TAGGED_RESOURCES_ONLY" as const };
  if (request.unitId === undefined || request.region === undefined) return { ...base, state: "UNKNOWN", resources: unknown("NOT_REQUESTED") };
  const tagged = await attempt(read, { tool: "aws_tagging_get_resources", unitId: request.unitId, region: request.region }, parseTagged);
  if (!tagged.ok) return { ...base, state: "UNKNOWN", resources: unknown(tagged.reason) };
  const resources = tagged.value.map(({ arn, keys }) => ({ arn, present: required.filter((k) => keys.has(k)), missing: required.filter((k) => !keys.has(k)) }));
  const state = resources.length === 0 ? "NO_RESOURCES_FOUND" : resources.some((r) => r.missing.length > 0) ? "MISSING" : "ALL_PRESENT";
  return { ...base, state, resources: observed(resources) };
}

// --- cost-allocation tags ---------------------------------------------------------------------------

function parseAllocationTags(json: unknown): Map<string, { status: "Active" | "Inactive"; updated?: string }> {
  const out = new Map<string, { status: "Active" | "Inactive"; updated?: string }>();
  const body = obj(json);
  if (typeof body.NextToken === "string" && body.NextToken !== "") throw new Malformed();
  for (const entry of list(body.CostAllocationTags)) {
    const t = obj(entry);
    const status = str(t.Status);
    if (status !== "Active" && status !== "Inactive") throw new Malformed();
    out.set(str(t.TagKey), { status, ...(t.LastUpdatedDate === undefined ? {} : { updated: time(t.LastUpdatedDate) }) });
  }
  return out;
}

async function readAllocationTags(read: CostRead, request: CostStatusRequest): Promise<CostAllocationTagStatus> {
  const listed = await attempt(read, { tool: "aws_ce_list_cost_allocation_tags" }, parseAllocationTags);
  const tags = request.requiredTagKeys.map((key) => {
    if (!listed.ok) return { key, status: unknown<"Active" | "Inactive">(listed.reason), lastUpdated: unknown<string>(listed.reason) };
    const entry = listed.value.get(key);
    if (!entry) return { key, status: unknown<"Active" | "Inactive">("TAG_KEY_NOT_YET_IN_BILLING"), lastUpdated: unknown<string>("TAG_KEY_NOT_YET_IN_BILLING") };
    return { key, status: observed(entry.status), lastUpdated: entry.updated ? observed(entry.updated) : unknown<string>("NOT_REPORTED_BY_AWS") };
  });
  const state = tags.some((t) => t.status.label === "OBSERVED" && t.status.value === "Inactive") ? "INACTIVE"
    : tags.length > 0 && tags.every((t) => t.status.label === "OBSERVED" && t.status.value === "Active") ? "ALL_ACTIVE" : "UNKNOWN";
  return { state, tags };
}

// --- export -----------------------------------------------------------------------------------------

type RawExport = {
  arn: string; name: string; query: string; refresh?: string; format?: string; overwrite?: string;
  bucket?: string; prefix?: string; region?: string; health?: string; reason?: string; createdAt?: string;
};
function parseExport(json: unknown): RawExport {
  const body = obj(json);
  const e = obj(body.Export);
  const query = obj(e.DataQuery);
  const destination = e.DestinationConfigurations === undefined ? undefined : obj(obj(e.DestinationConfigurations).S3Destination);
  const output = destination?.S3OutputConfigurations === undefined ? undefined : obj(destination.S3OutputConfigurations);
  const status = body.ExportStatus === undefined ? undefined : obj(body.ExportStatus);
  return {
    arn: str(e.ExportArn), name: str(e.Name), query: str(query.QueryStatement),
    refresh: e.RefreshCadence === undefined ? undefined : optStr(obj(e.RefreshCadence).Frequency),
    format: optStr(output?.Format), overwrite: optStr(output?.Overwrite),
    bucket: optStr(destination?.S3Bucket), prefix: optStr(destination?.S3Prefix), region: optStr(destination?.S3Region),
    health: optStr(status?.StatusCode), reason: optStr(status?.StatusReason),
    createdAt: status?.CreatedAt === undefined ? undefined : time(status.CreatedAt),
  };
}
function parseExportList(json: unknown): { arn: string; name: string }[] {
  const body = obj(json);
  if (typeof body.NextToken === "string" && body.NextToken !== "") throw new Malformed();
  return list(body.Exports).map((entry) => { const e = obj(entry); return { arn: str(e.ExportArn), name: str(e.ExportName) }; });
}
const IN_PROGRESS = new Set(["INITIATION_IN_PROCESS", "QUERY_QUEUED", "QUERY_IN_PROCESS", "DELIVERY_IN_PROCESS"]);
const FAILED = new Set(["QUERY_FAILURE", "DELIVERY_FAILURE"]);
type RawExecution = { id: string; statusCode: string; state: ExecutionState; at: string; completedAt?: string; reason?: string };
function parseExecutions(json: unknown): RawExecution[] {
  const body = obj(json);
  if (typeof body.NextToken === "string" && body.NextToken !== "") throw new Malformed();
  return list(body.Executions).map((entry) => {
    const x = obj(entry);
    const status = obj(x.ExecutionStatus);
    const statusCode = str(status.StatusCode);
    const state: ExecutionState = statusCode === "DELIVERY_SUCCESS" ? "DELIVERED" : IN_PROGRESS.has(statusCode) ? "IN_PROGRESS" : FAILED.has(statusCode) ? "FAILED" : (() => { throw new Malformed(); })();
    const completedAt = status.CompletedAt === undefined ? undefined : time(status.CompletedAt);
    const at = completedAt ?? time(status.LastUpdatedAt ?? status.CreatedAt);
    return { id: str(x.ExecutionId), statusCode, state, at, ...(completedAt ? { completedAt } : {}), ...(status.StatusReason === undefined ? {} : { reason: str(status.StatusReason) }) };
  });
}

/** The checks a CUR 2.0 export from the cost baseline must pass. Each failure is named. */
function exportProblems(raw: RawExport, expectedBucket: string | undefined): string[] {
  const problems: string[] = [];
  if (!/\bFROM\s+COST_AND_USAGE_REPORT\b/i.test(raw.query)) problems.push("QUERY_NOT_CUR_2_0");
  if (raw.refresh !== "SYNCHRONOUS") problems.push("REFRESH_NOT_SYNCHRONOUS");
  if (!raw.bucket) problems.push("NO_S3_DESTINATION");
  if (expectedBucket !== undefined && raw.bucket !== undefined && raw.bucket !== expectedBucket) problems.push("DESTINATION_BUCKET_DIFFERS");
  if (raw.format !== undefined && raw.format !== "PARQUET" && raw.format !== "TEXT_OR_CSV") problems.push("UNSUPPORTED_FORMAT");
  return problems;
}

async function readExport(read: CostRead, request: CostStatusRequest, now: Date, staleMs: number): Promise<ExportStatus> {
  const empty = (state: ExportStatus["state"], reason: UnknownReason): ExportStatus => ({
    state, arn: unknown(reason), name: unknown(reason), configValid: unknown(reason), configProblems: [], destination: unknown(reason),
    health: unknown(reason), createdAt: unknown(reason), lastExecution: unknown(reason), lastDelivery: unknown(reason),
  });
  let arn = request.exportArn;
  if (arn === undefined) {
    if (request.exportName === undefined) return empty("NOT_REQUESTED", "NOT_REQUESTED");
    const exports = await attempt(read, { tool: "aws_bcm_list_exports" }, parseExportList);
    if (!exports.ok) return empty("UNKNOWN", exports.reason);
    const match = exports.value.filter((e) => e.name === request.exportName);
    if (match.length === 0) return empty("MISSING", "PARENT_MISSING");
    if (match.length > 1) return empty("UNKNOWN", "MALFORMED_RESPONSE");
    arn = match[0]!.arn;
  }
  const got = await attempt(read, { tool: "aws_bcm_get_export", exportArn: arn }, parseExport);
  if (!got.ok) return got.notFound ? empty("MISSING", "PARENT_MISSING") : empty("UNKNOWN", got.reason);
  const raw = got.value;
  if (raw.arn !== arn) return empty("UNKNOWN", "MALFORMED_RESPONSE");
  const problems = exportProblems(raw, request.expectedBucket);
  const health = raw.health === "HEALTHY" || raw.health === "UNHEALTHY" ? observed(raw.health as "HEALTHY" | "UNHEALTHY") : unknown<"HEALTHY" | "UNHEALTHY">(raw.health ? "MALFORMED_RESPONSE" : "NOT_REPORTED_BY_AWS");
  const executions = await attempt(read, { tool: "aws_bcm_list_executions", exportArn: arn }, parseExecutions);
  const base = {
    arn: observed(raw.arn), name: observed(raw.name), configValid: observed(problems.length === 0), configProblems: problems,
    destination: raw.bucket ? observed({ bucket: raw.bucket, prefix: raw.prefix ?? "", region: raw.region ?? "" }) : unknown<{ bucket: string; prefix: string; region: string }>("NOT_REPORTED_BY_AWS"),
    health, createdAt: raw.createdAt ? observed(raw.createdAt) : unknown<string>("NOT_REPORTED_BY_AWS"),
  };
  if (!executions.ok) return { ...base, state: "UNKNOWN", lastExecution: unknown(executions.reason), lastDelivery: unknown(executions.reason) };
  const sorted = [...executions.value].sort((a, b) => b.at.localeCompare(a.at));
  const latest = sorted[0];
  const delivered = sorted.find((x) => x.state === "DELIVERED");
  const lastExecution = latest ? observed({ id: latest.id, state: latest.state, statusCode: latest.statusCode, at: latest.at, ...(latest.reason ? { reason: latest.reason } : {}) }) : unknown<never>("PARENT_MISSING");
  // No delivery yet is an explicit WAITING (until a failure says otherwise), never "zero spend" and never DELIVERED.
  const lastDelivery: Labeled<string> = delivered ? observed(delivered.completedAt ?? delivered.at) : unknown("PARENT_MISSING");
  const latestFinished = sorted.find((x) => x.state !== "IN_PROGRESS");
  let state: ExportStatus["state"];
  if ((health.label === "OBSERVED" && health.value === "UNHEALTHY") || latestFinished?.state === "FAILED") state = "FAILED";
  else if (!delivered) state = "WAITING";
  else if (now.getTime() - Date.parse(delivered.completedAt ?? delivered.at) > staleMs) state = "STALE";
  else state = "DELIVERED";
  return { ...base, state, lastExecution, lastDelivery };
}

// --- the status ---------------------------------------------------------------------------------------

function freshnessOf(exp: ExportStatus, now: Date, request: CostStatusRequest, staleAfterHours: number): FreshnessStatus {
  const month = now.toISOString().slice(0, 7);
  const analytics: Labeled<string> = unknown(request.analytics === "on" ? "PHASE_2_NOT_READ" : "NOT_SELECTED");
  const state: FreshnessStatus["state"] = exp.state === "DELIVERED" ? "FRESH" : exp.state === "STALE" ? "STALE" : exp.state === "WAITING" ? "WAITING" : "UNKNOWN";
  return {
    state, billingPeriod: { label: "ESTIMATE", value: month, basis: "the UTC calendar month of capture; AWS bills by calendar month" },
    latestDelivery: exp.lastDelivery, staleAfterHours, analyticsIngestion: analytics, dashboardRefresh: analytics,
  };
}

function overallOf(s: Omit<CostStatus, "overall">): CostStatusOverall {
  const attention = s.budget.state === "MISSING" || s.tags.state === "MISSING" || s.tags.state === "NO_RESOURCES_FOUND" ||
    s.costAllocationTags.state === "INACTIVE" || s.export.state === "MISSING" || s.export.state === "FAILED" ||
    (s.export.configValid.label === "OBSERVED" && !s.export.configValid.value) ||
    (s.budget.hasActualAlert.label === "OBSERVED" && !s.budget.hasActualAlert.value) ||
    // An alert with no recipient reaches nobody.
    (s.budget.notifications.label === "OBSERVED" && s.budget.notifications.value.some((n) => n.subscribers.label === "OBSERVED" && n.subscribers.value.length === 0));
  if (attention) return "ATTENTION";
  if (s.export.state === "STALE") return "STALE";
  const incomplete = s.budget.state === "UNKNOWN" || s.tags.state === "UNKNOWN" || s.costAllocationTags.state === "UNKNOWN" ||
    s.export.state === "UNKNOWN" || s.export.state === "NOT_REQUESTED" || s.budget.notifications.label === "UNKNOWN" ||
    (s.budget.notifications.label === "OBSERVED" && s.budget.notifications.value.some((n) => n.subscribers.label === "UNKNOWN"));
  if (incomplete) return "INCOMPLETE";
  if (s.export.state === "WAITING") return "WAITING";
  return "OBSERVED_COMPLETE";
}

const ACCOUNT = /^[0-9]{12}$/;

/** Read the cost status. Read-only: every call is one of the broker's cost reads. */
export async function readCostStatus(request: CostStatusRequest, read: CostRead, now: Date = new Date()): Promise<CostStatus> {
  if (!ACCOUNT.test(request.accountId)) throw new Error("COST_STATUS_ACCOUNT_INVALID");
  if ((request.unitId === undefined) !== (request.region === undefined)) throw new Error("COST_STATUS_UNIT_NEEDS_REGION");
  // The same patterns the broker applies, checked once up front so a bad value is a refused request, not an UNKNOWN status.
  const refused = (probe: CostReadRequest): boolean => "reason" in awsCostReadArgs(probe);
  if (refused({ tool: "aws_budgets_describe_notifications", accountId: request.accountId, budgetName: request.budgetName })) throw new Error("COST_STATUS_BUDGET_NAME_INVALID");
  if (request.exportArn !== undefined && refused({ tool: "aws_bcm_get_export", exportArn: request.exportArn })) throw new Error("COST_STATUS_EXPORT_ARN_INVALID");
  if (request.unitId !== undefined && refused({ tool: "aws_tagging_get_resources", unitId: request.unitId, region: request.region })) throw new Error("COST_STATUS_UNIT_INVALID");
  const staleAfterHours = request.staleAfterHours ?? 48;
  if (!Number.isFinite(staleAfterHours) || staleAfterHours <= 0) throw new Error("COST_STATUS_STALE_WINDOW_INVALID");
  const [budget, tags, costAllocationTags, exp] = await Promise.all([
    readBudget(read, request), readTags(read, request), readAllocationTags(read, request),
    readExport(read, request, now, staleAfterHours * 3_600_000),
  ]);
  const partial = {
    kind: "ALZ_COST_STATUS" as const, source: "AWS_API_READ_ONLY" as const, accountId: request.accountId, capturedAt: now.toISOString(),
    budget, tags, costAllocationTags, export: exp, freshness: freshnessOf(exp, now, request, staleAfterHours),
    advisory: true as const, actEnabled: false as const,
  };
  return { ...partial, overall: overallOf(partial) };
}

// --- concise text -----------------------------------------------------------------------------------

const show = <T>(value: Labeled<T>, format: (v: T) => string): string =>
  value.label === "UNKNOWN" ? "UNKNOWN (" + value.reason + ")" : format(value.value) + (value.label === "ESTIMATE" ? " [ESTIMATE]" : "");
const amount = (m: Money): string => m.amount + " " + m.unit;

/** A few lines for a terminal or a log. The UI reads the typed status instead. */
export function costStatusLines(status: CostStatus): string[] {
  const b = status.budget;
  const subscribers = b.notifications.label === "OBSERVED"
    ? b.notifications.value.flatMap((n) => (n.subscribers.label === "OBSERVED" ? n.subscribers.value : [])).length : 0;
  const allocation = status.costAllocationTags.tags.map((t) => t.key + "=" + show(t.status, (v) => v)).join(", ") || "none required";
  const missingTags = status.tags.resources.label === "OBSERVED" ? status.tags.resources.value.filter((r) => r.missing.length > 0).length : 0;
  return [
    "Cost status: " + status.overall + " (read-only, advisory; a budget alerts and never caps spend)",
    "  Budget " + b.name + ": " + b.state + ", limit " + show(b.limit, amount) + " " + show(b.period, (p) => p) +
      ", spend " + show(b.actualSpend, amount) + ", forecast " + show(b.forecastedSpend, amount),
    "  Alerts: " + show(b.notifications, (n) => String(n.length)) + " (actual " + show(b.hasActualAlert, String) + ", forecast " +
      show(b.hasForecastAlert, String) + "), " + subscribers + " recipients, confirmation UNKNOWN",
    "  Tags: " + status.tags.state + (missingTags ? " (" + missingTags + " resources missing required tags)" : ""),
    "  Cost-allocation tags: " + status.costAllocationTags.state + " (" + allocation + ")",
    "  Export: " + status.export.state + ", last delivery " + show(status.export.lastDelivery, (v) => v) +
      (status.export.configProblems.length ? ", problems " + status.export.configProblems.join(" ") : ""),
    "  Freshness: " + status.freshness.state + ", billing period " + show(status.freshness.billingPeriod, (v) => v) +
      ", analytics " + show(status.freshness.analyticsIngestion, (v) => v),
  ];
}
