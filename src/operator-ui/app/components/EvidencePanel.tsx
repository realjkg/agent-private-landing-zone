import type { JobState } from "../api";
import { StatusLed } from "./StatusLed";

/**
 * Execution and evidence surface (Advanced and Expert only — the App renders
 * this nowhere at Beginner, keeping the D1 ceiling literal). Shows the literal
 * status, the workflow's evidence classification, and the bounded sanitized
 * output — exactly what GET /state provides.
 */
export function EvidencePanel(props: {
  jobState: JobState | null;
  formError: string | null;
  sessionUnavailable: boolean;
}) {
  const jobState = props.jobState;
  const status: JobState["status"] = jobState?.status ?? "IDLE";
  const basis = jobState
    ? jobState.evidenceBasis
    : "Choose a workflow to view its evidence classification.";
  const output = props.formError ?? jobState?.output ?? "No scenario executed yet.";
  return (
    <section className="panel advanced-only">
      <h2>Execution and evidence</h2>
      <StatusLed status={props.sessionUnavailable ? "UNAVAILABLE" : status} />
      <p className="evidence-basis" aria-live="polite">
        {basis}
      </p>
      <div className="line" />
      <div className="output" aria-live="polite">
        {output}
      </div>
    </section>
  );
}
