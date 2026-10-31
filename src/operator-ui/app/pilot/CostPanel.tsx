import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

import { fetchCostVisibility, type CostConfigView, type CostLabeled, type CostMoney, type CostOverall, type CostStatusView, type CostVisibility } from "./pilot-api";

// The "Cost and visibility" panel (plan item 5; owner direction 2026-10-31, issue #39 comment 6536926009). Read-only and advisory:
// it shows what the last `./alz cost status` read from AWS, beside the cost configuration and the provisioning limits. It reads
// no cloud itself, has no button that changes anything, and never presents a budget as a cap. Every value carries its label as
// text (OBSERVED, ESTIMATE, UNKNOWN), and "no data yet" is always said in words, never shown as zero.

export const COST_PANEL_ID = "cost-visibility";

type Load = { status: "loading" } | { status: "error" } | { status: "ready"; data: CostVisibility };

const REASONS: Readonly<Record<string, string>> = {
  ACCESS_DENIED: "access denied", THROTTLED: "AWS was busy (throttled)", CREDENTIALS: "the AWS sign-in was missing or expired",
  READ_BLOCKED: "the read was blocked by policy", READ_FAILED: "the read failed", MALFORMED_RESPONSE: "AWS's answer could not be read",
  NOT_REPORTED_BY_AWS: "AWS does not report this", NOT_READ: "not read by this status", PARENT_MISSING: "not found, so it cannot exist yet",
  NOT_REQUESTED: "not requested", NOT_SELECTED: "the analytics pack is not selected", PHASE_2_NOT_READ: "read by the analytics pack (phase 2)",
};

export const OVERALL_WORDS: Readonly<Record<CostOverall, string>> = {
  OBSERVED_COMPLETE: "Read from AWS and complete.",
  WAITING: "Waiting: deployed, and AWS has not reported spend or delivered the first cost export yet. No data yet is not zero spend.",
  STALE: "Stale: the cost export has stopped delivering, so the cost data is out of date.",
  ATTENTION: "Needs attention: something below is missing or failed.",
  INCOMPLETE: "Incomplete: some reads did not answer. Those values are UNKNOWN, not passing.",
};

const money = (m: CostMoney): string => m.amount + " " + m.unit;
const time = (iso: string): string => iso.length >= 16 ? iso.slice(0, 10) + " " + iso.slice(11, 16) + " UTC" : iso;

/** One labeled value. The label is always text; an unknown value says why, and spend never reads as zero when it is unknown. */
export function Labeled<T>(props: { value: CostLabeled<T>; format: (value: T) => string; unknownAs?: string }): ReactNode {
  const v = props.value;
  if (v.label === "UNKNOWN") {
    return <span className="cost-value" data-label="UNKNOWN">{props.unknownAs ?? "Unknown"} ({REASONS[v.reason] ?? v.reason}) <span className="cost-label">[UNKNOWN]</span></span>;
  }
  return (
    <span className="cost-value" data-label={v.label}>
      {props.format(v.value)} <span className="cost-label">[{v.label}]</span>
      {v.label === "ESTIMATE" && <small> {v.basis}</small>}
    </span>
  );
}

function Row(props: { term: string; children: ReactNode }) {
  return <><dt>{props.term}</dt><dd>{props.children}</dd></>;
}

function Group(props: { id: string; title: string; children: ReactNode }) {
  return (
    <section className="cost-group" aria-labelledby={props.id}>
      <h3 id={props.id}>{props.title}</h3>
      {props.children}
    </section>
  );
}

const NO_STATUS = "No data yet: nothing has been read from AWS on this computer. This is not zero spend.";

function BudgetGroup(props: { cost: CostStatusView | null; config: CostConfigView | null }) {
  const { cost, config } = props;
  const b = cost?.budget;
  return (
    <Group id="cost-budget" title="Budget">
      <p className="cost-note">A budget tracks spend and sends alerts. It is not a hard cap: it never stops spend or resources.</p>
      <dl>
        {config && <Row term="Configured">{config.budget.amount} {config.budget.currency} per {config.budget.period.toLowerCase()} period, budget "{config.budget.name}" <span className="cost-label">[CONFIGURED]</span></Row>}
        {b ? <>
          <Row term="In AWS">{b.state === "PRESENT" ? "Found" : b.state === "MISSING" ? "Not found in the account" : "Unknown: the budget could not be read"}</Row>
          <Row term="Amount and period"><Labeled value={b.limit} format={money} /> · <Labeled value={b.period} format={(p) => p.toLowerCase()} /></Row>
          <Row term="Actual spend this period"><Labeled value={b.actualSpend} format={money} unknownAs="No data yet, not zero" /></Row>
          <Row term="Forecast"><Labeled value={b.forecastedSpend} format={money} unknownAs="No forecast yet" /></Row>
        </> : <Row term="In AWS">{NO_STATUS}</Row>}
        <Row term="Budget action">{config?.budgetAction.enabled
          ? <>Configured ({config.budgetAction.approvalModel === "MANUAL" ? "a person approves each run in AWS Budgets" : "runs automatically"}): {config.budgetAction.effect}</>
          : config ? "None configured: alerts only." : "Not known: no cost configuration on this computer."}</Row>
      </dl>
    </Group>
  );
}

function AlertsGroup(props: { cost: CostStatusView | null; config: CostConfigView | null }) {
  const { cost, config } = props;
  const n = cost?.budget.notifications;
  return (
    <Group id="cost-alerts" title="Alerts and recipients">
      <dl>
        {config && <Row term="Configured thresholds">actual {config.budget.actualThresholds.map((t) => t + "%").join(", ") || "none"}; forecast {config.budget.forecastThresholds.map((t) => t + "%").join(", ") || "none"} <span className="cost-label">[CONFIGURED]</span></Row>}
        {config && <Row term="Configured recipients">{[...config.notifications.emails, ...(config.notifications.snsTopicArn ? [config.notifications.snsTopicArn] : [])].join(", ") || "none"} ({config.notifications.route.replace(/_/g, " ").toLowerCase()}) <span className="cost-label">[CONFIGURED]</span></Row>}
        {!n && <Row term="In AWS">{NO_STATUS}</Row>}
        {n?.label === "UNKNOWN" && <Row term="In AWS"><Labeled value={n} format={() => ""} /></Row>}
      </dl>
      {n && n.label !== "UNKNOWN" && (n.value.length === 0 ? <p>No alerts were found on the budget.</p> : (
        <table className="cost-table">
          <caption>Alerts read from AWS <span className="cost-label">[{n.label}]</span></caption>
          <thead><tr><th scope="col">Alert</th><th scope="col">Last state</th><th scope="col">Recipients and confirmation</th></tr></thead>
          <tbody>
            {n.value.map((alert, index) => (
              <tr key={index}>
                <th scope="row">{alert.notificationType === "ACTUAL" ? "Actual spend" : "Forecast"} over {alert.threshold}{alert.thresholdType === "PERCENTAGE" ? "%" : " (amount)"}</th>
                <td><Labeled value={alert.alarmState} format={(s) => s === "ALARM" ? "In alarm" : "OK"} /></td>
                <td>{alert.subscribers.label === "UNKNOWN" ? <Labeled value={alert.subscribers} format={() => ""} />
                  : alert.subscribers.value.length === 0 ? "No recipient: this alert reaches nobody."
                  : <ul>{alert.subscribers.value.map((s) => (
                    <li key={s.type + s.address}>{s.type === "EMAIL" ? "Email" : "SNS topic"} {s.address}: confirmation <Labeled value={s.confirmation} format={(c) => c.toLowerCase()} /></li>
                  ))}</ul>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ))}
    </Group>
  );
}

function TagsGroup(props: { cost: CostStatusView | null; config: CostConfigView | null }) {
  const { cost, config } = props;
  const words: Record<string, string> = { ALL_PRESENT: "Every listed resource has every required tag.", MISSING: "Some resources are missing required tags.",
    NO_RESOURCES_FOUND: "No resources with this unit's tag were found. That is not a pass.", UNKNOWN: "Unknown: the tags could not be read, or no unit was named." };
  const resources = cost?.tags.resources;
  const missing = resources?.label === "OBSERVED" ? resources.value.filter((r) => r.missing.length > 0) : [];
  return (
    <Group id="cost-tags" title="Required tags and cost allocation">
      <dl>
        <Row term="Required tags">{(cost?.tags.required ?? (config ? Object.keys(config.tags) : [])).join(", ") || "Not known"}</Row>
        <Row term="On resources">{cost ? words[cost.tags.state] : NO_STATUS}</Row>
        {missing.length > 0 && <Row term="Missing">
          <ul>{missing.map((r) => <li key={r.arn}>{r.arn}: missing {r.missing.join(", ")}</li>)}</ul>
        </Row>}
        {config && <Row term="Cost-allocation activation">{config.costAllocationTagActivation === "REQUESTED" ? "Requested in the configuration" : "Not requested in the configuration (activate once the keys appear in billing data)"} <span className="cost-label">[CONFIGURED]</span></Row>}
        <Row term="Cost-allocation tags in AWS">{!cost ? NO_STATUS : cost.costAllocationTags.state === "UNKNOWN" ? "Unknown: not read" : cost.costAllocationTags.tags.length === 0 ? "None required" : (
          <ul>{cost.costAllocationTags.tags.map((t) => <li key={t.key}>{t.key}: <Labeled value={t.status} format={(s) => s.toLowerCase()} /></li>)}</ul>
        )}</Row>
      </dl>
    </Group>
  );
}

function ExportGroup(props: { cost: CostStatusView | null; config: CostConfigView | null }) {
  const { cost, config } = props;
  const e = cost?.export;
  const words: Record<string, string> = { DELIVERED: "Delivered recently", WAITING: "Waiting for the first delivery (no data yet, not zero)", STALE: "Stale: no recent delivery",
    FAILED: "Failed", MISSING: "Not found", UNKNOWN: "Unknown: not read", NOT_REQUESTED: "Not requested" };
  return (
    <Group id="cost-export" title="Cost export (CUR 2.0)">
      <dl>
        {config && <Row term="Configured">"{config.export.exportName}" to {config.export.bucket ?? "a new bucket named at build"}/{config.export.prefix}, {config.export.granularity.toLowerCase()}{config.export.retentionDays !== null ? ", kept " + config.export.retentionDays + " days" : ""} <span className="cost-label">[CONFIGURED]</span></Row>}
        {e ? <>
          <Row term="State">{words[e.state] ?? e.state}</Row>
          <Row term="Configuration in AWS"><Labeled value={e.configValid} format={(ok) => ok ? "As intended" : "Not as intended"} />{e.configProblems.length > 0 && <> ({e.configProblems.join(", ")})</>}</Row>
          <Row term="Destination"><Labeled value={e.destination} format={(d) => d.bucket + "/" + d.prefix + " in " + d.region} /></Row>
          <Row term="Last delivery"><Labeled value={e.lastDelivery} format={time} unknownAs="No delivery yet" /></Row>
          <Row term="Last run"><Labeled value={e.lastExecution} format={(x) => x.state.toLowerCase() + " at " + time(x.at) + (x.reason ? " (" + x.reason + ")" : "")} unknownAs="No run yet" /></Row>
        </> : <Row term="State">{NO_STATUS}</Row>}
      </dl>
    </Group>
  );
}

function LimitsGroup(props: { data: CostVisibility; config: CostConfigView | null }) {
  const { config } = props;
  const contract = props.data.contractLimits;
  const l = config?.limits;
  const listed = l && (l.allowedRegions.length || l.resourceFamilies.length || Object.keys(l.quantities).length || Object.keys(l.sizes).length);
  return (
    <Group id="cost-limits" title="Provisioning limits">
      <dl>
        <Row term="In the cost configuration">{!config ? "Not known: no cost configuration on this computer." : !listed ? "None configured." : (
          <ul>
            {l!.allowedRegions.length > 0 && <li>Regions: {l!.allowedRegions.join(", ")}</li>}
            {l!.resourceFamilies.length > 0 && <li>Families: {l!.resourceFamilies.join(", ")}</li>}
            {Object.entries(l!.sizes).map(([family, sizes]) => <li key={"s" + family}>{family} sizes: {sizes.join(", ")}</li>)}
            {Object.entries(l!.quantities).map(([type, max]) => <li key={"q" + type}>{type}: at most {max}</li>)}
          </ul>
        )}</Row>
        <Row term="Enforced when a change is sealed">{contract.state !== "OK" ? (contract.state === "DISABLED" ? "No enabled pilot contract, so nothing is enforced here yet."
          : "Unknown: the pilot contract could not be read.") : (
          <ul>{contract.environments.map((env) => (
            <li key={env.environment}>{env.environment}: {env.limits
              ? env.limits.resources.map((r) => r.type + " at most " + r.max + (r.sizes?.length ? " (" + r.sizes.join(", ") + ")" : "")).join("; ") + (env.limits.regions?.length ? "; regions " + env.limits.regions.join(", ") : "")
              : env.canary ? "canary allowlist only" : "no limits block"}</li>
          ))}</ul>
        )}</Row>
      </dl>
    </Group>
  );
}

function OwnershipGroup(props: { config: CostConfigView | null }) {
  const { config } = props;
  return (
    <Group id="cost-ownership" title="Ownership">
      {config ? (
        <dl>
          <Row term="Owner">{config.owner}</Row>
          <Row term="Tags written on every resource">{Object.entries(config.tags).map(([k, v]) => k + "=" + v).join(", ")}</Row>
          <Row term="Review by">{config.review.reviewBy}{config.review.expiresOn ? "; expires " + config.review.expiresOn : ""}</Row>
        </dl>
      ) : <p>Not known: no cost configuration on this computer.</p>}
    </Group>
  );
}

function FreshnessGroup(props: { cost: CostStatusView | null }) {
  const f = props.cost?.freshness;
  const words: Record<string, string> = { FRESH: "Fresh", WAITING: "Waiting for the first data (not zero)", STALE: "Stale", UNKNOWN: "Unknown" };
  return (
    <Group id="cost-freshness" title="Freshness">
      {f ? (
        <dl>
          <Row term="State">{words[f.state]} (stale after {f.staleAfterHours} hours without a delivery)</Row>
          <Row term="Billing period"><Labeled value={f.billingPeriod} format={(p) => p} /></Row>
          <Row term="Latest delivery"><Labeled value={f.latestDelivery} format={time} unknownAs="No delivery yet" /></Row>
          <Row term="Analytics ingestion"><Labeled value={f.analyticsIngestion} format={time} /></Row>
          <Row term="Dashboard refresh"><Labeled value={f.dashboardRefresh} format={time} /></Row>
        </dl>
      ) : <p>{NO_STATUS}</p>}
      <p className="cost-note">Hourly granularity is not hourly delivery: AWS delivers the export at least once a day.</p>
    </Group>
  );
}

/** Read-only: loads GET /pilot/cost once, and again only when the person asks. Nothing it shows is a live AWS read. */
export function CostPanel() {
  const [load, setLoad] = useState<Load>({ status: "loading" });
  const alive = useRef(true);
  const latest = useRef(0);
  const reload = useCallback(() => {
    const mine = ++latest.current;
    setLoad({ status: "loading" });
    void fetchCostVisibility().then((reply) => {
      if (!alive.current || mine !== latest.current) return;
      setLoad(reply.ok ? { status: "ready", data: reply.body } : { status: "error" });
    });
  }, []);
  useEffect(() => { alive.current = true; reload(); return () => { alive.current = false; }; }, [reload]);

  const data = load.status === "ready" ? load.data : null;
  const cost = data?.status.state === "OK" ? data.status.cost : null;
  const config = data?.config.state === "OK" ? data.config.summary : null;
  return (
    <section className="panel cost-panel" aria-labelledby="cost-visibility-title" aria-busy={load.status === "loading"}>
      <h2 id="cost-visibility-title" tabIndex={-1} data-panel={COST_PANEL_ID}>Cost and visibility</h2>
      <p>Read-only and advisory. This shows the budget, alerts, tags, cost export and limits as last read from AWS by <code>./alz cost status</code> in a terminal. It never stops a change, and the console never reads AWS itself.</p>
      <p><button type="button" className="pilot-secondary" onClick={reload} disabled={load.status === "loading"}>Show the latest saved read</button></p>
      {load.status === "loading" && <p role="status">Loading the saved cost status…</p>}
      {load.status === "error" && <p role="note" className="cost-error">The cost status could not be loaded from the console. Nothing here is shown as passing. Try again, or run <code>./alz cost status</code> in a terminal.</p>}
      {data && <>
        <div role="status" className="cost-summary">
          {cost ? <>
            <p><strong>Overall: {cost.overall.replace(/_/g, " ")}.</strong> {OVERALL_WORDS[cost.overall] ?? "Unknown state."}</p>
            <p>Read from AWS account {cost.accountId} at {time(cost.capturedAt)}. This is the last saved read, not a live one.</p>
          </> : data.status.state === "NONE" ? <>
            <p><strong>Overall: NO DATA YET.</strong> {NO_STATUS}</p>
            <p>Run <code>{data.command}</code> in a terminal with your AWS sign-in, then show the latest saved read.</p>
          </> : <p><strong>Overall: UNKNOWN.</strong> The saved cost status cannot be read, so nothing is shown as passing. Run <code>{data.command}</code> again.</p>}
          {data.config.state === "NONE" && <p>No cost configuration on this computer (config/cost.json), so configured values are not shown.</p>}
          {data.config.state === "INVALID" && <p>The cost configuration has problems at {data.config.issues.map((i) => i.path).join(", ")}, so configured values are not shown.</p>}
          {data.config.state === "UNKNOWN" && <p>The cost configuration could not be read, so configured values are not shown.</p>}
        </div>
        <BudgetGroup cost={cost} config={config} />
        <AlertsGroup cost={cost} config={config} />
        <TagsGroup cost={cost} config={config} />
        <ExportGroup cost={cost} config={config} />
        <LimitsGroup data={data} config={config} />
        <OwnershipGroup config={config} />
        <FreshnessGroup cost={cost} />
      </>}
    </section>
  );
}

/** Moves keyboard focus to the panel's heading (the setup checklist points here). */
export function focusCostPanel(): void {
  const heading = document.getElementById("cost-visibility-title");
  heading?.scrollIntoView?.({ block: "start" });
  heading?.focus();
}
