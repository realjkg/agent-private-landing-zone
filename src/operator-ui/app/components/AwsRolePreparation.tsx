import { useState } from "react";

/**
 * Customer-portable, local PLAN intake. An ARN is a reference, never a credential.
 * Does not assume a role, contact AWS, create IAM resources or authorize ACT.
 */
const ACCOUNT = /^[0-9]{12}$/;
const IDENTIFIER = /^[a-z][a-z0-9-]{2,40}$/;
const IDENTITIES = ["discovery", "state", "state-write", "apply"] as const;
const BUDGET_CEILING = 80;

export function AwsRolePreparation() {
  const [account, setAccount] = useState("");
  const [identifier, setIdentifier] = useState("adaptcloud-dev");
  const issuer = "token.actions.githubusercontent.com";
  const [repo, setRepo] = useState("realjkg/agent-private-landing-zone");
  const [copied, setCopied] = useState(false);
  const valid = ACCOUNT.test(account) && IDENTIFIER.test(identifier) &&
    issuer === "token.actions.githubusercontent.com" &&
    /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo);
  // Avoid deriving authority from a string. The plan is a proposed contract for review, not a trust policy grant.
  const roleNames = {
    environmentBootstrap: `${identifier}-bootstrap`,
    ...Object.fromEntries(IDENTITIES.map((identity) => [identity, `${identifier}-${identity}`])),
  };
  const plan = {
    schemaVersion: 1,
    kind: "SOVEREIGN_ALZ_AWS_ROLE_PREPARATION",
    mode: "PLAN_ONLY",
    infrastructureAct: "DISABLED",
    accountId: account,
    landingZoneId: identifier,
    region: "SELECT_BEFORE_QUALIFICATION",
    engine: "TERRAFORM",
    cumulativeCloudCreditLimitUsd: BUDGET_CEILING,
    organizationRoleTemplates: ["sovereign-alz-org-discovery", "sovereign-alz-org-bootstrap"],
    roles: Object.fromEntries(Object.entries(roleNames).map(([key, name]) =>
      [key, { name, proposedArn: `arn:aws:iam::${account}:role/${name}`, status: "NOT_CREATED" }])),
    oidc: {
      issuer: ["https:", "", issuer].join("/"),
      audience: "sts.amazonaws.com",
      githubRepo: repo,
      // Subject format must be observed from a real token before trust is configured.
      subjects: null,
      status: "REQUIRES_VERIFIED_SUBJECT_EVIDENCE",
    },
    requirements: [
      "Verify the active STS account matches the intended account.",
      "Use a separate DEV member account; never bootstrap workloads in the organization management account.",
      "Organization roles are separate from DEV execution roles; no shared cross-customer IAM principals.",
      "Organization discovery is read-only. Account creation needs an independently authorized action.",
      "Use the existing bootstrap/aws Terraform module and distinct OIDC subjects for four execution identities.",
      "Approve least-privilege APPLY policy, backend isolation, state writer and approver identities.",
      "Verify AWS credit eligibility and cumulative spending before allowing any chargeable operation.",
      "Only a human may initiate a governed pilot apply after contract pin, qualification and approvals.",
    ],
  };
  const serialized = JSON.stringify(plan, null, 2);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(serialized);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };
  return (
    <section className="panel" aria-label="AWS role preparation" id="aws-role-preparation">
      <h2>Prepare AWS landing-zone roles</h2>
      <p>Prepare an account-specific role plan. For connected checks and guided approvals, open Pilot apply. No infrastructure changes happen here.</p>
      <label className="field-label" htmlFor="alz-role-account">DEV AWS account ID</label>
      <input
        id="alz-role-account" value={account} onChange={(e) => { setAccount(e.target.value); setCopied(false); }}
        placeholder="12-digit DEV member account ID" inputMode="numeric" maxLength={12}
      />
      <label className="field-label" htmlFor="alz-role-identifier">Landing-zone identifier</label>
      <input id="alz-role-identifier" value={identifier} maxLength={40}
        onChange={(e) => { setIdentifier(e.target.value); setCopied(false); }} />
      <label className="field-label" htmlFor="alz-role-repository">Authorized GitHub repository</label>
      <input id="alz-role-repository" value={repo} onChange={(e) => { setRepo(e.target.value); setCopied(false); }} />
      <p><small>Terraform first. Proposed roles: organization discovery/bootstrap templates, DEV bootstrap, and separate DEV discovery, state, state-write and apply. CDK follows separate qualification.</small></p>
      {valid ? (
        <>
          <p role="status">Role names are ready for review. Sign-in identities must be verified from real evidence; no roles have been created.</p>
          <details>
            <summary>Review generated role plan</summary>
            <textarea aria-label="Generated AWS role plan" readOnly value={serialized} rows={12} />
          </details>
          <button type="button" onClick={() => void copy()}>{copied ? "Plan copied" : "Copy role-preparation plan"}</button>
        </>
      ) : (
        <p role="status">Enter a 12-digit DEV member account, a lowercase identifier (3–40 characters), and the authorized GitHub owner/repository.</p>
      )}
      <p><a href="#pilot">Open guided AWS setup and approvals</a></p>
      <p><small>Budget ceiling: $80 cumulative cloud credits. PLAN only; next: confirm DEV account, authenticate operator, review the existing bootstrap/aws Terraform plan and trust policies. This screen cannot enable ACT.</small></p>
    </section>
  );
}
