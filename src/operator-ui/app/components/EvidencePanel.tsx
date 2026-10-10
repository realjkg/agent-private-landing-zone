import { forwardRef } from "react";

import type { JobState } from "../api";
import { StatusLed } from "./StatusLed";

/**
 * Execution and evidence surface (Advanced and Expert only — the App renders
 * this nowhere at Beginner, keeping the D1 ceiling literal). Shows the literal
 * status, the workflow's evidence classification, and the bounded sanitized
 * output — exactly what GET /state provides.
 *
 * The completed-run summary line sits at the top of the panel: what ran plus
 * the literal verification result. The workflow title comes from the server's
 * JobState; the scenario id is client knowledge only (the server response
 * never carries it), so it renders only when the console actually knows it —
 * absent after a reload, never guessed.
 */
export interface EvidencePanelProps {
  jobState: JobState | null;
  formError: string | null;
  sessionUnavailable: boolean;
  /** Scenario id of the last accepted run, or null when unknown. */
  runScenario?: string | null;
}

export const EvidencePanel = forwardRef<HTMLElement, EvidencePanelProps>(
  function EvidencePanel(props, ref) {
    const jobState = props.jobState;
    const status: JobState["status"] = jobState?.status ?? "IDLE";
    const basis = jobState
      ? jobState.evidenceBasis
      : "Choose a workflow to view its evidence classification.";
    const output = props.formError ?? jobState?.output ?? "No scenario executed yet.";
    return (
      <section className="panel advanced-only" id="evidence" ref={ref}>
        <h2>Execution and evidence</h2>
        {jobState && (jobState.status === "PASS" || jobState.status === "BLOCKED") && (
          <p className="run-summary" data-testid="run-summary" role="status" aria-live="polite">
            Completed — {jobState.title} · verification {jobState.status}
            {props.runScenario && props.runScenario !== "all"
              ? ` · scenario ${props.runScenario}`
              : ""}
          </p>
        )}
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
  },
);
