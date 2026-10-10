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
 * the literal verification result. The scenario id is client knowledge only
 * (GET /state never carries it), so it renders only when the console actually
 * knows it — absent after a reload, never guessed.
 *
 * Before any run, the guided empty state (below) replaces the bare
 * "IDLE / NOT_RUN / No scenario executed yet." display: it says what a run
 * produces and where results land, in plain words. Honest by construction —
 * it promises only what this panel actually shows, nothing more.
 */
const EMPTY_STATE_PRODUCE = [
  "The workflow executes on this machine and reports its progress here.",
  "Every run states its evidence basis — what produced the result and what it never touched.",
  "Results land in this panel only: a sanitized output summary on this screen, records kept locally.",
] as const;

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
    const output = props.formError ?? jobState?.output ?? "";
    // Guided empty state: nothing has run, nothing failed, and the session
    // is healthy. Any real signal (error, unavailable session, a run) takes
    // the literal display instead.
    const empty = !props.sessionUnavailable && !props.formError && status === "IDLE";
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
        {empty ? (
          <div className="empty-state" data-testid="evidence-empty">
            <p className="empty-title">No run yet — here is what one produces.</p>
            <ul className="empty-steps">
              {EMPTY_STATE_PRODUCE.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </div>
        ) : (
          <>
            <StatusLed status={props.sessionUnavailable ? "UNAVAILABLE" : status} />
            <p className="evidence-basis" aria-live="polite">
              {basis}
            </p>
            <div className="line" />
            <div className="output" aria-live="polite">
              {output || "No output recorded."}
            </div>
          </>
        )}
      </section>
    );
  },
);
