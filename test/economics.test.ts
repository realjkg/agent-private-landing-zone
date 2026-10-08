import assert from "node:assert/strict";
import test from "node:test";
import { analyzeOperatingEconomics, parseEconomicsInput } from "../src/economics/report.js";
import { buildMonitoringRequest, renderPrometheusEvent } from "../src/monitoring/export.js";

const make = (month: string, amountCents: number, id: string, overrides: Record<string, unknown> = {}) => ({
  id, month, amountCents, provider: "PRIVATE_SUBSTRATE", scope: "PLATFORM_LZ",
  dimension: "PLATFORM", costClass: "BASE", confidence: "OBSERVED", evidenceRef: "evidence://billing/" + id, ...overrides,
});
const sample = () => ({
  schemaVersion: 1, currency: "USD", asOf: "2026-10-07T22:00:00.000Z", correlationId: "eco-qualification-001",
  reportMonth: "2026-09", closedMonths: ["2026-07", "2026-08", "2026-09"],
  entries: [
    make("2026-07", 100000, "july"),
    make("2026-08", 120000, "august"),
    make("2026-09", 100000, "sep-private", { dimension: "PLATFORM" }),
    make("2026-09", 35000, "sep-azure", { provider: "AZURE", scope: "APPLICATION_LZ", dimension: "GOVERNANCE" }),
    make("2026-09", 25000, "sep-aws", { provider: "AWS", scope: "APPLICATION_LZ", dimension: "OBSERVABILITY", costClass: "AI_OPERATIONS" }),
  ],
  budgets: [{ month: "2026-09", amountCents: 150000 }],
  anomaly: { thresholdBps: 2500, minDeltaCents: 10000 },
});

test("monthly economics allocates PLZ and ALZ with private substrate and optional cloud spend", () => {
  const report = analyzeOperatingEconomics(sample());
  const month = report.months.at(-1)!;
  assert.equal(month.totalCents, 160000);
  assert.equal(month.observedCents, 160000);
  assert.equal(month.estimatedCents, 0);
  assert.equal(month.aiOperationsPremiumCents, 25000);
  assert.equal(month.aiOperationsShareBps, 1563);
  assert.equal(month.byProvider.PRIVATE_SUBSTRATE, 100000);
  assert.equal(month.byProvider.AZURE, 35000);
  assert.equal(month.byProvider.AWS, 25000);
  assert.equal(month.byScope.PLATFORM_LZ, 100000);
  assert.equal(month.byScope.APPLICATION_LZ, 60000);
  assert.equal(month.byDimension.GOVERNANCE, 35000);
  assert.equal(month.byDimension.OBSERVABILITY, 25000);
  assert.equal(report.advisoryOnly, true);
});

test("deterministic closed-month forecast, budget and anomaly alerts are evidence correlated", () => {
  const report = analyzeOperatingEconomics(sample());
  assert.deepEqual(report.forecast?.sampleMonths, ["2026-07", "2026-08"]);
  assert.equal(report.forecast?.amountCents, 110000);
  assert.deepEqual(report.alerts.map((a) => a.kind), ["BUDGET_EXCEEDED", "COST_ANOMALY"]);
  assert.equal(report.events.length, 3);
  const otel = buildMonitoringRequest("PRIVATE_SOVEREIGN_DISCONNECTED", {
    provider: "OTEL_COLLECTOR", deployment: "LOCAL", endpoint: "http://otel:4318/v1/logs",
  }, report.events[0]!);
  assert.match(otel.body, /eco-qualification-001/);
  assert.match(otel.body, /economics-budget/);
  const splunk = buildMonitoringRequest("PRIVATE_SOVEREIGN_DISCONNECTED", {
    provider: "SPLUNK_HEC", deployment: "LOCAL", endpoint: "https://splunk.local:8088/services/collector", authRef: "secret://splunk/hec",
  }, report.events[1]!);
  assert.match(splunk.body, /economics-anomaly/);
  assert.equal(splunk.body.includes("secret:\/\/splunk\/hec"), false);
  const metrics = renderPrometheusEvent(report.events[0]!);
  assert.match(metrics, /alz_operational_event_total/);
  assert.equal(metrics.includes("eco-qualification-001"), false);
});

test("open or estimated periods do not trigger misleading anomaly comparisons", () => {
  const input = sample();
  input.closedMonths.pop();
  input.entries[4]!.confidence = "ESTIMATED";
  const report = analyzeOperatingEconomics(input);
  assert.equal(report.forecast?.amountCents, 110000);
  assert.equal(report.alerts.some((a) => a.kind === "COST_ANOMALY"), false);
  assert.equal(report.months.at(-1)?.estimatedCents, 25000);
  assert.match(report.dataLimitations.join(" "), /partial/);
});

test("missing consecutive closed observed historical months fails closed to unavailable forecast", () => {
  const input = sample();
  input.closedMonths = ["2026-07", "2026-09"];
  const report = analyzeOperatingEconomics(input);
  assert.equal(report.forecast, null);
  assert.equal(report.alerts.some((a) => a.kind === "COST_ANOMALY"), false);
});

test("invalid amounts, duplicates, unsafe evidence and unsupported provider are rejected", () => {
  const base = sample();
  for (const change of [
    (x: ReturnType<typeof sample>) => { x.entries[0]!.amountCents = -1; },
    (x: ReturnType<typeof sample>) => { x.entries[1]!.id = x.entries[0]!.id; },
    (x: ReturnType<typeof sample>) => { x.entries[0]!.evidenceRef = "secret://leak"; },
    (x: ReturnType<typeof sample>) => { x.entries[0]!.provider = "UNVERIFIED_PROVIDER"; },
    (x: ReturnType<typeof sample>) => { x.correlationId = "Bearer token"; },
    (x: ReturnType<typeof sample>) => { x.reportMonth = "2026-13"; },
  ]) {
    const x = structuredClone(base);
    change(x);
    assert.throws(() => parseEconomicsInput(x), /ECONOMICS_INPUT_INVALID/);
  }
});

test("no cost entry or evidence is silently treated as zero priced", () => {
  const input = sample();
  input.entries = [];
  assert.throws(() => analyzeOperatingEconomics(input), /ECONOMICS_INPUT_INVALID/);
});
