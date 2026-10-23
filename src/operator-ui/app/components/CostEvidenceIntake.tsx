import { useState } from "react";

/** Operator-led evidence intake. No network calls or infrastructure mutation. */
export function CostEvidenceIntake() {
  const [profile, setProfile] = useState("kubernetes");
  const [sources, setSources] = useState<string[]>(["rvtools", "focus"]);
  const [allocation, setAllocation] = useState("unknown");
  const [finance, setFinance] = useState<string[]>(["cloud", "hardware", "licensing", "facilities"]);
  const [telemetry, setTelemetry] = useState("reuse");
  const [notes, setNotes] = useState("");
  const [exported, setExported] = useState(false);
  const sourceOptions = [
    ["rvtools", "RVTools VMware inventory"],
    ["focus", "FOCUS / cloud billing export"],
    ["assets", "Hardware, licensing and operating expenses"],
    ["opencost", "OpenCost Kubernetes metrics"],
  ] as const;
  const manifest = {
    schemaVersion: 1, kind: "SOVEREIGN_ALZ_COST_EVIDENCE_INTAKE",
    mode: "PLAN_ONLY", infrastructureAct: "DISABLED",
    profile, costObservability: {
      dashboard: "grafana", metrics: "prometheus", telemetry: "opentelemetry",
      sources, liveInfrastructureTelemetry: telemetry !== "none",
      integrationPreference: telemetry,
    },
    financialEvidence: { allocationBasis: allocation, requiredCategories: finance, verifiedActualCosts: false },
    operatorNotes: notes.trim(),
    missingEvidence: [
      ...(sources.length === 0 ? ["Select at least one evidence source"] : []),
      ...(allocation === "unknown" ? ["Cost allocation basis remains unknown"] : []),
      ...(finance.length < 4 ? ["Full financial assessment requires cloud, hardware, licensing and facilities evidence"] : []),
      ...(telemetry === "reuse" ? ["Existing compatible telemetry endpoints need verification"] : []),
    ],
    excluded: ["DrMigrate", "FinOps Ratio"],
  };
  return (
    <section className="panel" aria-labelledby="cost-evidence-title">
      <h2 id="cost-evidence-title">Cost evidence and observability</h2>
      <p>Set up a single Grafana cost view. Answer what is known; unknowns remain open until evidence is collected. This only prepares a plan.</p>
      <label htmlFor="alz-cost-profile">Where are the workloads running?</label>
      <select id="alz-cost-profile" value={profile} onChange={(event) => setProfile(event.target.value)}>
        <option value="kubernetes">Kubernetes application landing zone</option>
        <option value="cloud">VM, serverless or managed cloud services</option>
        <option value="private">Private cloud / on-premises</option>
      </select>
      <fieldset>
        <legend>Which cost evidence can you supply?</legend>
        {sourceOptions.map(([value, title]) => (
          <label key={value} style={{ display: "block", marginBlock: "0.5rem" }}>
            <input type="checkbox" checked={sources.includes(value)} onChange={(event) => {
              setSources(current => event.target.checked ? [...current, value] : current.filter(item => item !== value));
              setExported(false);
            }} /> {title}
          </label>
        ))}
      </fieldset>
      <fieldset><legend>Which financial categories should the assessment request?</legend>
        {(["cloud", "hardware", "licensing", "facilities"] as const).map((category) => <label key={category} style={{ display: "block" }}>
          <input type="checkbox" checked={finance.includes(category)} onChange={(event) => setFinance(current => event.target.checked ? [...current,category] : current.filter(item => item !== category))}/>{" "}{category === "facilities" ? "Power and facilities" : category === "cloud" ? "Cloud resource costs" : category === "hardware" ? "Hardware acquisition and depreciation" : "Licensing and support"}
        </label>)}
      </fieldset>
      <label htmlFor="alz-allocation">How are infrastructure costs assigned to applications?</label>
      <select id="alz-allocation" value={allocation} onChange={(event) => setAllocation(event.target.value)}>
        <option value="unknown">Unknown — request evidence</option>
        <option value="tags">Cloud tags / resource owner</option>
        <option value="vm">VM / host / cluster allocation</option>
        <option value="rates">Approved private-cloud rate card</option>
      </select>
      <label htmlFor="alz-telemetry">Is monitoring already installed?</label>
      <select id="alz-telemetry" value={telemetry} onChange={(event) => setTelemetry(event.target.value)}>
        <option value="reuse">Check for compatible Grafana, Prometheus and OTel</option>
        <option value="existing">Yes — reuse the existing stack</option>
        <option value="none">No live telemetry for this intake</option>
      </select>
      <label htmlFor="alz-cost-notes">What else should the assessment know?</label>
      <textarea id="alz-cost-notes" rows={2} value={notes} onChange={(event) => setNotes(event.target.value)}
        placeholder="Known gaps, cost ownership, licensing, power, contract terms…" />
      <p role="status">{manifest.missingEvidence.length ? manifest.missingEvidence.join("; ") : "All intake selections provided; evidence still needs verification."}</p>
      <button type="button" onClick={() => {
        const blob = new Blob([JSON.stringify(manifest, null, 2)], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement("a");
        anchor.href = url; anchor.download = "alz-cost-evidence-plan.json"; anchor.click();
        URL.revokeObjectURL(url);
        setExported(true);
      }}>Export plan-only intake</button>
      {exported && <p role="status">Plan exported locally. No cloud changes were requested.</p>}
    </section>
  );
}
