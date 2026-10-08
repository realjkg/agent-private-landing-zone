import { createOperationalEvent, type OperationalEvent } from "../observability/events.js";
import type { LandingZoneScope } from "../monitoring/types.js";

export type EconomicsProvider = "PRIVATE_SUBSTRATE" | "AWS" | "AZURE";
export type EconomicsDimension = "PLATFORM" | "GOVERNANCE" | "OBSERVABILITY" | "RESILIENCE";
export type EconomicsCostClass = "BASE" | "AI_OPERATIONS";
export type EconomicsConfidence = "OBSERVED" | "ESTIMATED";
export type EconomicsScope = Exclude<LandingZoneScope, "BOTH">;

export type EconomicsEntry = {
  id: string;
  month: string;
  provider: EconomicsProvider;
  scope: EconomicsScope;
  dimension: EconomicsDimension;
  costClass: EconomicsCostClass;
  confidence: EconomicsConfidence;
  amountCents: number;
  evidenceRef: string;
};

export type EconomicsInput = {
  schemaVersion: 1;
  currency: "USD";
  reportMonth: string;
  asOf: string;
  correlationId: string;
  closedMonths: string[];
  entries: EconomicsEntry[];
  budgets?: { month: string; amountCents: number }[];
  anomaly?: { thresholdBps: number; minDeltaCents: number };
};

export type EconomicsMonth = {
  month: string;
  closed: boolean;
  totalCents: number;
  observedCents: number;
  estimatedCents: number;
  aiOperationsPremiumCents: number;
  aiOperationsShareBps: number;
  byProvider: Record<EconomicsProvider, number>;
  byScope: Record<EconomicsScope, number>;
  byDimension: Record<EconomicsDimension, number>;
};

export type EconomicsAlert = {
  kind: "BUDGET_EXCEEDED" | "FORECAST_OVER_BUDGET" | "COST_ANOMALY";
  month: string;
  observedCents?: number;
  forecastCents?: number;
  budgetCents?: number;
  baselineCents?: number;
  deviationBps?: number;
};

export type EconomicsReport = {
  schemaVersion: 1;
  currency: "USD";
  reportMonth: string;
  correlationId: string;
  months: EconomicsMonth[];
  forecast: null | { month: string; amountCents: number; sampleMonths: string[]; method: "TRAILING_CLOSED_MONTH_AVERAGE" };
  alerts: EconomicsAlert[];
  events: OperationalEvent[];
  advisoryOnly: true;
  dataLimitations: string[];
};

const PROVIDERS: EconomicsProvider[] = ["PRIVATE_SUBSTRATE", "AWS", "AZURE"];
const SCOPES: EconomicsScope[] = ["PLATFORM_LZ", "APPLICATION_LZ"];
const DIMENSIONS: EconomicsDimension[] = ["PLATFORM", "GOVERNANCE", "OBSERVABILITY", "RESILIENCE"];
const CLASSES: EconomicsCostClass[] = ["BASE", "AI_OPERATIONS"];
const CONFIDENCES: EconomicsConfidence[] = ["OBSERVED", "ESTIMATED"];
const MONTH = /^([0-9]{4})-(0[1-9]|1[0-2])$/;
const SAFE_REF = /^evidence:\/\/[a-zA-Z0-9._/-]{1,128}$/;
const SAFE_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,79}$/;

function fail(field: string): never {
  throw new Error("ECONOMICS_INPUT_INVALID: " + field);
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return fail("expected object");
  return value as Record<string, unknown>;
}
function nonnegativeInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) return fail(field);
  return value as number;
}
function validMonth(value: unknown, field: string): string {
  if (typeof value !== "string" || !MONTH.test(value)) return fail(field);
  return value;
}
function includesValue<T extends string>(values: readonly T[], value: unknown, field: string): T {
  if (typeof value !== "string" || !values.includes(value as T)) return fail(field);
  return value as T;
}
function monthIndex(month: string): number {
  return Number(month.slice(0, 4)) * 12 + Number(month.slice(5, 7)) - 1;
}
function sumSafe(values: number[], field: string): number {
  const value = values.reduce((a, b) => a + b, 0);
  if (!Number.isSafeInteger(value)) return fail(field);
  return value;
}
function amountBuckets<T extends string>(keys: T[]): Record<T, number> {
  return Object.fromEntries(keys.map((key) => [key, 0])) as Record<T, number>;
}

/** Validate trusted inputs before calculation. All amounts are non-negative USD cents, never provider rate guesses. */
export function parseEconomicsInput(value: unknown): EconomicsInput {
  const raw = record(value);
  if (raw.schemaVersion !== 1 || raw.currency !== "USD") fail("schemaVersion/currency");
  const reportMonth = validMonth(raw.reportMonth, "reportMonth");
  const asOf = raw.asOf;
  if (typeof asOf !== "string" || !/^\d{4}-\d{2}-\d{2}T/.test(asOf) || !Number.isFinite(Date.parse(asOf))) fail("asOf");
  const correlationId = raw.correlationId;
  if (typeof correlationId !== "string" || !SAFE_ID.test(correlationId)) fail("correlationId");
  if (!Array.isArray(raw.entries) || raw.entries.length === 0 || raw.entries.length > 10000) fail("entries");
  if (!Array.isArray(raw.closedMonths)) fail("closedMonths");
  const closedMonths = raw.closedMonths.map((v: unknown) => validMonth(v, "closedMonths"));
  if (new Set(closedMonths).size !== closedMonths.length) fail("duplicate closedMonths");
  if (closedMonths.some((m: string) => m > reportMonth)) fail("future closedMonths");
  const ids = new Set<string>();
  const entries = raw.entries.map((v: unknown, i: number): EconomicsEntry => {
    const e = record(v);
    const id = e.id;
    if (typeof id !== "string" || !SAFE_ID.test(id) || ids.has(id)) fail("entries[" + i + "].id");
    ids.add(id);
    const month = validMonth(e.month, "entries.month");
    if (month > reportMonth) fail("entries.futureMonth");
    if (typeof e.evidenceRef !== "string" || !SAFE_REF.test(e.evidenceRef) || e.evidenceRef.includes("..")) fail("entries.evidenceRef");
    return {
      id,
      month,
      provider: includesValue(PROVIDERS, e.provider, "entries.provider"),
      scope: includesValue(SCOPES, e.scope, "entries.scope"),
      dimension: includesValue(DIMENSIONS, e.dimension, "entries.dimension"),
      costClass: includesValue(CLASSES, e.costClass, "entries.costClass"),
      confidence: includesValue(CONFIDENCES, e.confidence, "entries.confidence"),
      amountCents: nonnegativeInteger(e.amountCents, "entries.amountCents"),
      evidenceRef: e.evidenceRef,
    };
  });
  if (!entries.some((e) => e.month === reportMonth)) fail("reportMonth must have source entries");
  if (closedMonths.some((m: string) => !entries.some((e) => e.month === m))) fail("closedMonths without evidence");
  let budgets: EconomicsInput["budgets"];
  if (raw.budgets !== undefined) {
    if (!Array.isArray(raw.budgets) || raw.budgets.length > 100) fail("budgets");
    const budgetMonths = new Set<string>();
    budgets = raw.budgets.map((value: unknown) => {
      const b = record(value);
      const month = validMonth(b.month, "budgets.month");
      if (budgetMonths.has(month)) fail("duplicate budget month");
      budgetMonths.add(month);
      return { month, amountCents: nonnegativeInteger(b.amountCents, "budgets.amountCents") };
    });
  }
  let anomaly: EconomicsInput["anomaly"];
  if (raw.anomaly !== undefined) {
    const a = record(raw.anomaly);
    anomaly = {
      thresholdBps: nonnegativeInteger(a.thresholdBps, "anomaly.thresholdBps"),
      minDeltaCents: nonnegativeInteger(a.minDeltaCents, "anomaly.minDeltaCents"),
    };
    if (anomaly.thresholdBps > 100000) fail("anomaly.thresholdBps");
  }
  return { schemaVersion: 1, currency: "USD", reportMonth, asOf, correlationId, closedMonths, entries, ...(budgets ? { budgets } : {}), ...(anomaly ? { anomaly } : {}) };
}

/** No network calls, mutation, pricing assumptions or hidden model decisions. */
export function analyzeOperatingEconomics(raw: unknown): EconomicsReport {
  const input = parseEconomicsInput(raw);
  const closed = new Set(input.closedMonths);
  const monthIds = [...new Set(input.entries.map((e) => e.month))].sort();
  const months: EconomicsMonth[] = monthIds.map((month) => {
    const entries = input.entries.filter((e) => e.month === month);
    const totalCents = sumSafe(entries.map((e) => e.amountCents), "monthly total overflow");
    const observedCents = sumSafe(entries.filter((e) => e.confidence === "OBSERVED").map((e) => e.amountCents), "observed total overflow");
    const aiOperationsPremiumCents = sumSafe(entries.filter((e) => e.costClass === "AI_OPERATIONS").map((e) => e.amountCents), "AI operations total overflow");
    const byProvider = amountBuckets(PROVIDERS);
    const byScope = amountBuckets(SCOPES);
    const byDimension = amountBuckets(DIMENSIONS);
    for (const e of entries) {
      byProvider[e.provider] += e.amountCents;
      byScope[e.scope] += e.amountCents;
      byDimension[e.dimension] += e.amountCents;
    }
    return {
      month, closed: closed.has(month), totalCents, observedCents,
      estimatedCents: totalCents - observedCents,
      aiOperationsPremiumCents,
      aiOperationsShareBps: totalCents === 0 ? 0 : Math.round(aiOperationsPremiumCents * 10000 / totalCents),
      byProvider, byScope, byDimension,
    };
  });
  const report = months.find((m) => m.month === input.reportMonth)!;
  const historical = months.filter((m) => m.month < input.reportMonth && m.closed && m.estimatedCents === 0).reverse();
  const sample: EconomicsMonth[] = [];
  let expectedIndex = monthIndex(input.reportMonth) - 1;
  for (const month of historical) {
    if (monthIndex(month.month) !== expectedIndex || sample.length === 3) break;
    sample.push(month);
    expectedIndex--;
  }
  const forecast = sample.length >= 2
    ? { month: input.reportMonth, amountCents: Math.round(sumSafe(sample.map((m) => m.observedCents), "forecast overflow") / sample.length), sampleMonths: sample.map((m) => m.month).reverse(), method: "TRAILING_CLOSED_MONTH_AVERAGE" as const }
    : null;
  const alerts: EconomicsAlert[] = [];
  const budget = input.budgets?.find((b) => b.month === input.reportMonth);
  if (budget && report.observedCents > budget.amountCents) {
    alerts.push({ kind: "BUDGET_EXCEEDED", month: report.month, observedCents: report.observedCents, budgetCents: budget.amountCents });
  }
  if (budget && forecast && forecast.amountCents > budget.amountCents) {
    alerts.push({ kind: "FORECAST_OVER_BUDGET", month: report.month, forecastCents: forecast.amountCents, budgetCents: budget.amountCents });
  }
  const threshold = input.anomaly ?? { thresholdBps: 2500, minDeltaCents: 10000 };
  if (forecast && report.closed && report.estimatedCents === 0 && forecast.amountCents > 0) {
    const difference = Math.abs(report.observedCents - forecast.amountCents);
    const deviationBps = Math.round(difference * 10000 / forecast.amountCents);
    if (difference >= threshold.minDeltaCents && deviationBps >= threshold.thresholdBps) {
      alerts.push({ kind: "COST_ANOMALY", month: report.month, observedCents: report.observedCents, baselineCents: forecast.amountCents, deviationBps });
    }
  }
  const events = alerts.map((alert): OperationalEvent => createOperationalEvent({
    at: input.asOf,
    signal: alert.kind === "COST_ANOMALY" ? "economics-anomaly" : "economics-budget",
    status: "DEGRADED",
    component: "lz-operating-economics",
    detail: alert.kind,
    attributes: { correlationId: input.correlationId, ...alert },
  }));
  if (forecast) {
    events.push(createOperationalEvent({
      at: input.asOf,
      signal: "economics-forecast",
      status: "OK",
      component: "lz-operating-economics",
      attributes: { correlationId: input.correlationId, month: input.reportMonth, forecastCents: forecast.amountCents, sampleMonths: forecast.sampleMonths.length },
    }));
  }
  const dataLimitations = [
    "Costs are supplied by evidence-backed collectors; no live provider billing API was invoked.",
    "AI Operations premium is recorded incremental AI Operations spend, not a hypothetical avoided-cost benefit.",
  ];
  if (!report.closed) dataLimitations.push("Report month is open; observed spend is partial and anomaly comparison is suppressed.");
  if (report.estimatedCents > 0) dataLimitations.push("Report month includes estimates; reconcile against observed invoices.");
  if (!forecast) dataLimitations.push("Forecast unavailable: requires two immediately preceding complete closed months with observed-only costs.");
  return { schemaVersion: 1, currency: "USD", reportMonth: input.reportMonth, correlationId: input.correlationId, months, forecast, alerts, events, advisoryOnly: true, dataLimitations };
}
