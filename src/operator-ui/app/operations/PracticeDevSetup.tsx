import { useState } from "react";
import {
  COMMON_DEV_GATES, PRACTICE_ROLES, type PracticeRole,
} from "../../../account-factory/practice-roles.js";
import type { AccountEnvironment } from "../../../account-factory/flow.js";

/** Pure operator guidance: a practice choice or environment choice never grants AWS access. */
export function PracticeDevSetup() {
  const [role, setRole] = useState<PracticeRole>("MODERN_PLATFORMS_DELIVERY");
  const [environment, setEnvironment] = useState<AccountEnvironment>("DEV");
  const [expanded, setExpanded] = useState(false);
  const selected = PRACTICE_ROLES.find(entry => entry.id === role)!;
  return (
    <section className="pilot-setup" aria-label="Customer environment prerequisites">
      <button type="button" className="pilot-secondary" aria-expanded={expanded}
        aria-controls="customer-environment-guide" onClick={() => setExpanded(current => !current)}>
        {expanded ? "Hide environment setup" : "Create a customer environment"}
      </button>
      {expanded && <div id="customer-environment-guide" className="pilot-step">
        <h3>Reuse the customer's AWS Control Tower</h3>
        <p>Modern Platforms and Digital practitioners in Presales or Delivery can create environments
          using the AWS access they already have. The builder discovers the signed-in organization,
          its managed organizational unit and the existing Account Factory. No new ALZ role,
          committee or custom approval workflow is required.</p>
        <label htmlFor="practice-dev-role">Your practice</label>
        <select id="practice-dev-role" value={role}
          onChange={event => setRole(event.target.value as PracticeRole)}>
          {PRACTICE_ROLES.map(entry =>
            <option key={entry.id} value={entry.id}>{entry.label}</option>)}
        </select>
        <label htmlFor="practice-environment">Environment</label>
        <select id="practice-environment" value={environment}
          onChange={event => setEnvironment(event.target.value as AccountEnvironment)}>
          <option value="DEV">DEV</option>
          <option value="QA">QA</option>
          <option value="STAGING">Staging</option>
          <option value="PROD">Production</option>
        </select>
        <p role="status">{selected.focus} Selected environment: {environment}.</p>
        <h4>What you need</h4>
        <ul>{selected.prerequisites.map(item => <li key={item}>{item}</li>)}</ul>
        <h4>How the builder works</h4>
        <ol>{COMMON_DEV_GATES.map(item => <li key={item}>{item}</li>)}</ol>
        <h4>Customer environment details</h4>
        <p>Each environment gets its own member account and customer-specific account ID,
          OU and Control Tower baseline, reused from the signed-in AWS organization.
          The existing management account is never a destination for application workloads.</p>
        <h4>Operations handoff</h4>
        <p>{selected.handoff}</p>
        <p><strong>Next:</strong> run <code>./alz account-factory create adaptcloud-admin</code> from
          a trusted terminal, or use the Account Factory operations below.
          The wizard uses the current AWS SSO profile and asks for one final account-creation confirmation.</p>
        <p role="note">The interface is a guide, not an AWS identity provider. AWS IAM determines
          available access; account creation may incur charges. The browser does not silently
          submit requests. DEV, QA, STAGING and PROD are separate requests;
          Terraform workload ACT remains disabled.</p>
      </div>}
    </section>
  );
}
