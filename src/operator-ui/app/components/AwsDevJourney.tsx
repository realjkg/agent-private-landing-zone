import type { JobState, ModelAvailability, OperatorMode } from "../api";
import { beginnerEvidenceLine } from "../../experience-level.js";
import { beginnerStatusLine } from "../beginner-status";
import { unavailableNote } from "./WorkflowForm";

/** One existing LangGraph scenario, never the complete cross-provider matrix. */
export const AWS_DEV_SCENARIO = "terraform-aws-brownfield";

export default function AwsDevJourney(props: {
  modelAvailability: ModelAvailability | null;
  scenarioAvailable: boolean;
  busy: boolean;
  sessionUnavailable: boolean;
  jobState: JobState | null;
  error: string | null;
  showTechnicalDetails: boolean;
  onRecheckModels: () => void;
  onLaunch: (mode: OperatorMode, scenario: string) => void;
}) {
  const ready = props.modelAvailability?.status === "AVAILABLE";
  const disabled = props.busy || props.sessionUnavailable || !props.scenarioAvailable;
  return (
    <section className="panel" aria-labelledby="aws-dev-title">
      <h2 id="aws-dev-title" tabIndex={-1}>Start with AWS DEV</h2>
      <p>Use this workstation for private reasoning and a dedicated AWS development account
        for your first reviewed change. Terraform is the recommended path.</p>
      <ol>
        <li>
          <h3>Check private models</h3>
          <p>LangChain and LangGraph are already included. Reasoning runs through local
            Qwen and Mistral models; a hosted AI account is not needed.</p>
          <p role="status">
            {ready
              ? "The required private models are installed and match the release versions. Inference has not been tested by this check."
              : props.modelAvailability
                ? unavailableNote(props.modelAvailability)
                : "Private-model readiness is unknown. Check again, or start with the offline rehearsal."}
          </p>
          <button type="button" className="link-button" onClick={props.onRecheckModels}
            disabled={props.busy || props.sessionUnavailable}>Check private models again</button>
        </li>
        <li>
          <h3>Rehearse the AWS workflow</h3>
          <p>Practice one AWS Terraform assessment and preview, including the conversational
            LangGraph path. AWS resources and infrastructure previews in this rehearsal are
            simulated. No AWS sign-in is needed.</p>
          <p>
            <button type="button" disabled={disabled || !ready}
              onClick={() => props.onLaunch("matrix-live", AWS_DEV_SCENARIO)}>
              Rehearse with private models
            </button>{" "}
            <button type="button" className="link-button" disabled={disabled}
              onClick={() => props.onLaunch("matrix-offline", AWS_DEV_SCENARIO)}>
              Rehearse offline
            </button>
          </p>
          {!props.scenarioAvailable && <p role="alert">This bundle is missing the AWS Terraform
            scenario. Rebuild the workspace before running the rehearsal.</p>}
          {props.error && <p role="alert">{props.error}</p>}
          <p role="status">{props.sessionUnavailable
            ? "This console lost its local session. Restart the workspace before continuing."
            : beginnerStatusLine(props.jobState, props.showTechnicalDetails)}</p>
          {props.jobState && <details>
            <summary>Latest workspace run and evidence</summary>
            <p>{props.jobState.title}</p>
            <p>{beginnerEvidenceLine(props.jobState.evidenceBasis)}</p>
            {props.showTechnicalDetails && <>
              {props.jobState.output.length > 8000 && <p>Showing the last 8,000 characters.</p>}
              <pre tabIndex={0} aria-label="AWS setup run output">{props.jobState.output.slice(-8000)}</pre>
            </>}
          </details>}
          <p><small>A passed rehearsal does not verify AWS access or authorize deployment.</small></p>
        </li>
        <li>
          <h3>Connect your DEV account and review a change</h3>
          <p>Open Pilot apply and choose <strong>Set up AWS DEV</strong>. Use your organization's
            saved AWS connection to check the dedicated DEV account. Never enter access keys
            or tokens in the setup form.</p>
          <p>Your AWS administrator prepares the separate roles and state storage. The owner
            reviews the DEV contract, cost limit, and approval key before the live pilot.
            Start with the single log-group canary, then verify and clean up what it created.</p>
          <a href="#pilot">Continue to AWS account setup</a>
          <p><small>The pilot checks its own prerequisites and requires a person to unlock it
            and approve the precise change. This guide does not mark those checks complete.</small></p>
        </li>
      </ol>
    </section>
  );
}
