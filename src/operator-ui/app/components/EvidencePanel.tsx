import type { JobState } from "../api";
import { StatusLed } from "./StatusLed";

/**
 * Execution and evidence surface (Advanced and Expert). Shows the literal
 * status, the workflow's evidence classification, and the bounded sanitized
 * output — exactly what GET /state provides. At Beginner the raw basis and
 * output are cleared (D1's DOM ceiling): the translated proof line on the
 * Beginner surface is the only evidence text shown there.
 */
export function EvidencePanel(props: {
  level: string;
  jobState: JobState | null;
  formError: string | null;
  sessionUnavailable: boolean;
}) {
  const jobState = props.jobState;
  const showRaw = props.level !== "BEGINNER";
  const status: JobState["status"] = jobState?.status ?? "IDLE";
  const basis = jobState
    ? showRaw
      ? jobState.evidenceBasis
      : ""
    : "Choose a workflow to view its evidence classification.";
  const output = showRaw
    ? props.formError ?? jobState?.output ?? "No scenario executed yet."
    : "";
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
