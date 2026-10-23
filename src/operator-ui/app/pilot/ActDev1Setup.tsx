import { useState } from "react";
import { checkAwsDevAccount, type AwsAdminStatus } from "./pilot-api";

/** Operator guidance only. Cloud mutation still uses the existing PilotWizard protected apply path. */
const STAGES = [
  { title: "Confirm spending", detail: "An owner approves the maximum cost. Alerts are helpful, but they cannot stop a charge." },
  { title: "Prepare secure access", detail: "An authorized administrator creates the protected storage and separate roles. The system verifies the result." },
  { title: "Verify each sign-in", detail: "Check four independent, short-lived sign-ins. Reused credentials are rejected." },
  { title: "Review your changes", detail: "See every addition, modification and removal with policy and approval status." },
  { title: "Approve and apply", detail: "A person reviews the precise change and confirms it in this console." },
  { title: "Verify and close", detail: "Read back results, record costs and agree on cleanup before closing the change." },
] as const;

export function ActDev1Setup() {
  const [account, setAccount] = useState("");
  const [profile, setProfile] = useState("adaptcloud-admin");
  const [checking, setChecking] = useState(false);
  const [result, setResult] = useState<AwsAdminStatus | null>(null);
  const [error, setError] = useState("");
  const valid = /^[0-9]{12}$/.test(account) && account !== "973471129135" &&
    /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(profile);
  const verify = async () => {
    if (!valid || checking) return;
    setChecking(true); setResult(null); setError("");
    const reply = await checkAwsDevAccount(account, profile);
    if (reply.ok && reply.body.status === "ACCOUNT_VERIFIED" && reply.body.account === account &&
      reply.body.action === "NONE" && reply.body.actEnabled === false) setResult(reply.body);
    else setError("The DEV account could not be verified. Check your AWS sign-in, account number, and Workloads enrollment.");
    setChecking(false);
  };
  return (
    <details className="pilot-setup" aria-label="AWS DEV guided setup">
      <summary>Set up AWS DEV <small>· Guided administrator checks</small></summary>
      <div className="pilot-step">
        <h3>Connect a DEV account</h3>
        <p>Use a saved AWS connection to confirm the right account. This is a read-only check. No cloud resources are created.</p>
        <label htmlFor="dev1-connection">Saved AWS connection</label>
        <input id="dev1-connection" value={profile} autoComplete="off" maxLength={64}
          onChange={(event) => { setProfile(event.target.value); setResult(null); setError(""); }} />
        <p><small>Use the connection already configured by your organization administrator.</small></p>
        <label htmlFor="dev1-account">DEV account number</label>
        <input id="dev1-account" inputMode="numeric" maxLength={12} placeholder="12-digit member account number"
          value={account} onChange={(event) => { setAccount(event.target.value); setResult(null); setError(""); }} />
        <p><button type="button" disabled={!valid || checking} onClick={() => void verify()}>
          {checking ? "Checking account…" : "Check AWS account"}
        </button></p>
        {result && <p role="status">DEV account confirmed in the governed Workloads area. Spending, access and changes still require approval.</p>}
        {error && <p role="alert">{error}</p>}
        <h3>Next steps</h3>
        <ol>
          <li><strong>Connect AWS:</strong> {result ? "Account verified." : "Account not yet verified."}</li>
          {STAGES.map((stage) => (
            <li key={stage.title}><strong>{stage.title}:</strong> {stage.detail} <small>Not yet verified in this setup check.</small></li>
          ))}
        </ol>
        <p role="note">The protected change wizard below handles review, signatures and execution. This setup check does not unlock or bypass those safeguards.</p>
        <details>
          <summary>What if I need help connecting AWS?</summary>
          <p>Ask your organization's AWS administrator for an authorized management connection and a dedicated DEV account. No private keys or access tokens should be pasted into this page.</p>
        </details>
      </div>
    </details>
  );
}
