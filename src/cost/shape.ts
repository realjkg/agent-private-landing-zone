import type { CostStatus } from "./status.js";

/**
 * The one deep shape check for a saved or served cost status (review 6539995646, B2). Browser-safe on purpose: no node imports,
 * so the console (src/operator-ui/app/pilot/pilot-api.ts) and the local reader (src/cost/local.ts) share it. Every field a reader
 * dereferences is checked, with its label and value type; anything else is not a status. A hand-edited, truncated or older-format
 * file is therefore UNREADABLE, never a status that passes.
 */

/** The version `./alz cost status` writes around the status (src/cost/local.ts). Any other value is refused. */
export const COST_SNAPSHOT_SCHEMA_VERSION = 1;

type Check = (value: unknown) => boolean;
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const str: Check = (v) => typeof v === "string";
const bool: Check = (v) => typeof v === "boolean";
const num: Check = (v) => typeof v === "number" && Number.isFinite(v);
const oneOf = (...values: string[]): Check => (v) => typeof v === "string" && values.includes(v);
const list = (item: Check): Check => (v) => Array.isArray(v) && v.length <= 10_000 && v.every(item);
const shape = (fields: Record<string, Check>): Check => (v) => isObject(v) && Object.entries(fields).every(([key, check]) => check(v[key]));
const money = shape({ amount: str, unit: str });
const strings = list(str);
const labeled = (value: Check): Check => (v) => isObject(v) && (
  (v.label === "OBSERVED" && value(v.value)) ||
  (v.label === "ESTIMATE" && value(v.value) && str(v.basis)) ||
  (v.label === "UNKNOWN" && str(v.reason)));

const subscriber = shape({ type: oneOf("EMAIL", "SNS"), address: str, confirmation: labeled(oneOf("CONFIRMED", "PENDING")) });
const notification = shape({
  notificationType: oneOf("ACTUAL", "FORECASTED"), comparisonOperator: str, threshold: str, thresholdType: oneOf("PERCENTAGE", "ABSOLUTE_VALUE"),
  alarmState: labeled(oneOf("OK", "ALARM")), subscribers: labeled(list(subscriber)),
});
const budget = shape({
  name: str, state: oneOf("PRESENT", "MISSING", "UNKNOWN"), budgetCount: labeled(num), budgetType: labeled(str), limit: labeled(money),
  period: labeled(str), filters: labeled((v) => isObject(v) && Object.values(v).every(strings)), actualSpend: labeled(money),
  forecastedSpend: labeled(money), budgetUpdatedAt: labeled(str), spendCalculatedAt: labeled(str), notifications: labeled(list(notification)),
  hasActualAlert: labeled(bool), hasForecastAlert: labeled(bool), hardSpendCap: (v) => v === false,
});
const tags = shape({
  state: oneOf("ALL_PRESENT", "MISSING", "NO_RESOURCES_FOUND", "UNKNOWN"), required: strings, coverage: oneOf("UNIT_TAGGED_RESOURCES_ONLY"),
  resources: labeled(list(shape({ arn: str, present: strings, missing: strings }))),
});
const allocation = shape({ state: oneOf("ALL_ACTIVE", "INACTIVE", "UNKNOWN"), tags: list(shape({ key: str, status: labeled(oneOf("Active", "Inactive")), lastUpdated: labeled(str) })) });
const exported = shape({
  state: oneOf("DELIVERED", "WAITING", "STALE", "FAILED", "MISSING", "UNKNOWN", "NOT_REQUESTED"), arn: labeled(str), name: labeled(str),
  configValid: labeled(bool), configProblems: strings, destination: labeled(shape({ bucket: str, prefix: str, region: str })),
  health: labeled(oneOf("HEALTHY", "UNHEALTHY")), createdAt: labeled(str),
  lastExecution: labeled(shape({ id: str, state: oneOf("DELIVERED", "IN_PROGRESS", "FAILED"), statusCode: str, at: str })), lastDelivery: labeled(str),
});
const freshness = shape({
  state: oneOf("FRESH", "WAITING", "STALE", "UNKNOWN"), billingPeriod: labeled(str), latestDelivery: labeled(str),
  staleAfterHours: (v) => num(v) && (v as number) > 0, analyticsIngestion: labeled(str), dashboardRefresh: labeled(str),
});
const status = shape({
  kind: oneOf("ALZ_COST_STATUS"), source: oneOf("AWS_API_READ_ONLY"), accountId: (v) => typeof v === "string" && /^[0-9]{12}$/.test(v),
  capturedAt: (v) => typeof v === "string" && Number.isFinite(Date.parse(v)),
  overall: oneOf("OBSERVED_COMPLETE", "WAITING", "STALE", "ATTENTION", "INCOMPLETE"),
  budget, tags, costAllocationTags: allocation, export: exported, freshness,
  advisory: (v) => v === true, actEnabled: (v) => v === false,
});

/** True only for a value with every field of the cost status, labeled and typed as the status model writes it. */
export function isCostStatus(value: unknown): value is CostStatus {
  try { return status(value); } catch { return false; }
}
