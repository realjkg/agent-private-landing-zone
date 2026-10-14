import { useState } from "react";

import { MOCK_AUTH_CHOICES, MOCK_ACT_CHOICES, mockBoundary, type MockAuth, type MockActRequest } from "../../../onboarding/mock-boundary.js";

/** Inert, fully client-side educational visualization. No network/auth/apply APIs. */
export function MockBoundaryLab(props: { platform: string; stage: string }) {
  const [auth, setAuth] = useState<MockAuth>("VALID_FIXTURE");
  const [approval, setApproval] = useState<MockActRequest>("HUMAN_APPROVAL_FIXTURE");
  const verdict = mockBoundary(auth, approval);
  return (
    <details data-testid="mock-boundary-lab">
      <summary>Simulate cloud sign-in and approval safety (no real connections)</summary>
      <p><strong>SYNTHETIC ONLY.</strong> This example simulates {props.platform.toUpperCase()} in {props.stage}. No credentials, network requests, Terraform plans or infrastructure actions are used.</p>
      <label className="field-label" htmlFor="fixture-cloud-auth">Mock cloud sign-in</label>
      <select id="fixture-cloud-auth" value={auth} onChange={(e) => setAuth(e.target.value as MockAuth)}>
        {MOCK_AUTH_CHOICES.map((item) => <option key={item} value={item}>{item.replaceAll("_", " ").toLowerCase()}</option>)}
      </select>
      <label className="field-label" htmlFor="fixture-approval">Mock ACT approval</label>
      <select id="fixture-approval" value={approval} onChange={(e) => setApproval(e.target.value as MockActRequest)}>
        {MOCK_ACT_CHOICES.map((item) => <option key={item} value={item}>{item.replaceAll("_", " ").toLowerCase()}</option>)}
      </select>
      <p role="status" data-testid="mock-boundary-result">
        Auth: {verdict.authResult}. Approval: {verdict.approvalResult}. Infrastructure: {verdict.infrastructureResult}.
      </p>
      <p><small>Evidence: {verdict.evidence}. No account or credential is bound, and no ACT button or permission exists in this simulator.</small></p>
    </details>
  );
}
