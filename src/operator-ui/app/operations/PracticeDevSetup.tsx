import { useState } from "react";

import {
  COMMON_DEV_GATES, PRACTICE_ROLES, type PracticeRole,
} from "../../../account-factory/practice-roles.js";

/**
 * Customer-facing DEV journey briefing within the existing ALZ console.
 * The role selector is descriptive, not an authorization token.
 * Execution remains the separate human-reviewed Account Factory handoff.
 */
export function PracticeDevSetup() {
  const [role, setRole] = useState<PracticeRole>("MODERN_PLATFORMS_DELIVERY");
  const [expanded, setExpanded] = useState(false);
  const selected = PRACTICE_ROLES.find((entry) => entry.id === role)!;
  return (
    <section className="pilot-setup" aria-label="Customer DEV environment prerequisites">
      <button type="button" className="pilot-secondary" aria-expanded={expanded}
        aria-controls="customer-dev-guide" onClick={() => setExpanded((current) => !current)}>
        {expanded ? "Hide customer DEV guide" : "Start a customer DEV environment"}
      </button>
      {expanded && <div id="customer-dev-guide" className="pilot-step">
        <h3>Establish a governed customer DEV environment</h3>
        <p>Modern Platforms and Digital practitioners in either Presales or Delivery can lead this workflow
          <strong> when their individual customer authorization and account-specific approvals are verified</strong>.
          Selecting a role here never grants AWS access.</p>
        <label htmlFor="practice-dev-role">Your practice and role</label>
        <select id="practice-dev-role" value={role}
          onChange={(event) => setRole(event.target.value as PracticeRole)}>
          {PRACTICE_ROLES.map((entry) => <option value={entry.id} key={entry.id}>{entry.label}</option>)}
        </select>
        <p role="status">{selected.focus}</p>
        <h4>Before you can provision DEV</h4>
        <ol>
          {selected.prerequisites.map((item) => <li key={item}>{item}</li>)}
        </ol>
        <h4>Required for every customer and practice</h4>
        <ul>{COMMON_DEV_GATES.map((item) => <li key={item}>{item}</li>)}</ul>
        <h4>What makes this customer's DEV distinct?</h4>
        <p>Its customer-owned account, approved architecture, Workloads organizational unit,
          Control Tower guardrails, exact AWS identity, location, cost authority and independently
          verified account evidence. No model or Presales label can override those boundaries.</p>
        <h4>Operational handoff</h4>
        <p>{selected.handoff}</p>
        <p><strong>Next:</strong> use the Account Factory operations below to verify your administrator
          session, prepare the exact customer-specific plan, obtain approval, submit and verify.
          These cards currently provide terminal handoffs; they do not create an account from this page.</p>
        <p role="note">Not verified by this guide: customer permissions, financial consent, IAM Identity Center
          membership, Service Catalog launch privileges, or actual account creation.
          QA/PROD remain separate gated environments; workload ACT stays disabled.</p>
      </div>}
    </section>
  );
}
