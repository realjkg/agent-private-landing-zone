import { useEffect, useState } from "react";

import { PROVIDERS, PROVIDER_HELP, STAGES, STAGE_HELP, type DeploymentStage, type LandingProvider } from "../../../onboarding/plan.js";
import { fetchPilotPaths, hasPilotToken, type PathsReport, type PilotEnvironment } from "../pilot/pilot-api";
import { orderByReadiness, orderEnvironments } from "../pilot/readiness-order";
import { MockBoundaryLab } from "./MockBoundaryLab";

const STAGE_ENVIRONMENT: Readonly<Record<DeploymentStage, PilotEnvironment>> = { development: "DEV", staging: "QA", production: "PROD" };

/**
 * The same readiness-first ordering as the Pilot apply area's Deployment paths, when that list is available (the pilot session is
 * unlocked on this page). Clouds follow their readiest path; a platform with no path keeps its place after them. Environments
 * follow the reviewed path's decisions when they are known. Otherwise today's order, unchanged.
 */
export function readinessOrder(report: PathsReport | null): { stages: DeploymentStage[]; providers: LandingProvider[] } {
  if (report === null) return { stages: [...STAGES], providers: [...PROVIDERS] };
  const clouds = orderByReadiness(report.paths).map((path) => path.cloud.toLowerCase());
  const providers = [...PROVIDERS].sort((a, b) => {
    const rank = (p: string) => { const i = clouds.indexOf(p); return i === -1 ? clouds.length + PROVIDERS.indexOf(p as LandingProvider) : i; };
    return rank(a) - rank(b);
  });
  const environments = report.contract.state === "UNKNOWN" ? null : report.environments;
  const order = orderEnvironments(environments).map((choice) => choice.environment);
  const stages = [...STAGES].sort((a, b) => order.indexOf(STAGE_ENVIRONMENT[a]) - order.indexOf(STAGE_ENVIRONMENT[b]));
  return { stages, providers };
}

/** A user-facing planning aid, never an authority, credential, environment binding, or workflow input. */
export function DeploymentContext() {
  const [stage, setStage] = useState<DeploymentStage>("development");
  const [provider, setProvider] = useState<LandingProvider>("aws");
  const [paths, setPaths] = useState<PathsReport | null>(null);
  useEffect(() => {
    // Read-only, and only with the pilot session already unlocked on this page; without it the order stays as it is.
    if (!hasPilotToken()) return undefined;
    let live = true;
    void fetchPilotPaths().then((reply) => { if (live && reply.ok) setPaths(reply.body); });
    return () => { live = false; };
  }, []);
  const order = readinessOrder(paths);
  const stagePrompt = stage === "production"
    ? "Production requires dedicated identity, an approved inventory baseline, independent review, verified recovery and formal promotion."
    : stage === "staging"
      ? "Staging needs its own isolated credentials and evidence; a development PASS cannot be promoted automatically."
      : "Development is a sandbox. Start with recorded examples and read-only assessments.";
  return (
    <section className="panel" aria-labelledby="context-title" id="environment-context">
      <h2 id="context-title">Where are you planning to use this?</h2>
      <p>Choose a target for guidance. This is a planning view; it does not connect to or select a real cloud account.</p>
      <label className="field-label" htmlFor="context-stage">Environment</label>
      <select id="context-stage" value={stage}
        onChange={(event) => setStage(event.target.value as DeploymentStage)}>
        {order.stages.map((value) => <option key={value} value={value}>{value === "staging" ? "Staging / non-production" : value === "development" ? "Development" : "Production"}</option>)}
      </select>
      <label className="field-label" htmlFor="context-provider">Cloud or private platform</label>
      <select id="context-provider" value={provider}
        onChange={(event) => setProvider(event.target.value as LandingProvider)}>
        {order.providers.map((value) => <option key={value} value={value}>{value === "gcp" ? "Google Cloud (GCP)" : value === "private" ? "Private / on-premise" : value.toUpperCase()}</option>)}
      </select>
      <p role="note" className="context-readiness" data-readiness={paths ? "known" : "unknown"}><small>{paths
        ? "Listed with the readiest first, from the Pilot apply area's deployment paths."
        : "Readiness unknown: shown in the default order. Unlock the Pilot apply area to list the readiest first."}</small></p>
      <p role="status">{stagePrompt}</p>
      <details>
        <summary>Why does environment choice matter?</summary>
        <p>{STAGE_HELP[stage]}</p>
        <p>{PROVIDER_HELP[provider]}</p>
        <p>All three environments need distinct inventories, access scopes, controls and evidence. Promotion and ACT are unavailable here. Nothing you select on this screen changes server permissions.</p>
      </details>
      {provider === "gcp" && <p><small>The GCP walkthrough uses synthetic Cloud Asset Inventory records; live GCP onboarding is not qualified.</small></p>}
      <MockBoundaryLab platform={provider} stage={stage} />
    </section>
  );
}
