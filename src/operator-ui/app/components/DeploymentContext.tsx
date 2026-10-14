import { useState } from "react";

import { PROVIDERS, PROVIDER_HELP, STAGES, STAGE_HELP, type DeploymentStage, type LandingProvider } from "../../../onboarding/plan.js";
import { MockBoundaryLab } from "./MockBoundaryLab";

/** A user-facing planning aid, never an authority, credential, environment binding, or workflow input. */
export function DeploymentContext() {
  const [stage, setStage] = useState<DeploymentStage>("development");
  const [provider, setProvider] = useState<LandingProvider>("aws");
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
        {STAGES.map((value) => <option key={value} value={value}>{value === "staging" ? "Staging / non-production" : value === "development" ? "Development" : "Production"}</option>)}
      </select>
      <label className="field-label" htmlFor="context-provider">Cloud or private platform</label>
      <select id="context-provider" value={provider}
        onChange={(event) => setProvider(event.target.value as LandingProvider)}>
        {PROVIDERS.map((value) => <option key={value} value={value}>{value === "gcp" ? "Google Cloud (GCP)" : value === "private" ? "Private / on-premise" : value.toUpperCase()}</option>)}
      </select>
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
