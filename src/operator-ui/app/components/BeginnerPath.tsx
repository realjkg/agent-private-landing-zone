import { beginnerEvidenceLine } from "../../experience-level.js";
import type { JobState, OperatorMode } from "../api";
import { beginnerStatusLine } from "../beginner-status";

/**
 * The single recommended path a first-time operator sees: two plain-language
 * actions and a proof line. Raw classifications and terminal output never
 * render here — evidence is shown through its beginner translation only.
 */
export function BeginnerPath(props: {
  jobState: JobState | null;
  busy: boolean;
  sessionUnavailable: boolean;
  onLaunch: (mode: OperatorMode) => void;
}) {
  const job = props.jobState;
  const statusLine = beginnerStatusLine(job);
  // NOT_RUN renders the shared beginner translation as the initial proof line.
  const proofLine = props.jobState
    ? beginnerEvidenceLine(props.jobState.evidenceBasis)
    : beginnerEvidenceLine("NOT_RUN");
  return (
    <section className="panel beginner-only" aria-label="Recommended next steps">
      <h2 id="home-title" tabIndex={-1}>What would you like to do?</h2>
      <p className="beginner-status" role="status" aria-live="polite">
        {props.sessionUnavailable
          ? "This console lost its local session — close it and start it again."
          : statusLine}
      </p>
      <div className="beginner-cards">
        <button
          type="button"
          className="card primary"
          disabled={props.busy}
          onClick={() => props.onLaunch("matrix-offline")}
        >
          <strong>
            Explore governed scenarios<span className="badge">Recommended</span>
          </strong>
          <small>See how this protected workspace works. Nothing is changed anywhere.</small>
        </button>
        <button
          type="button"
          className="card"
          disabled={props.busy}
          onClick={() => props.onLaunch("chaos")}
        >
          <strong>Check resilience &amp; backups</strong>
          <small>Practice backup and recovery checks safely.</small>
        </button>
      </div>
      <p className="beginner-proof" role="status" aria-live="polite">
        {proofLine}
      </p>
      <p>
        <small>
          Live-model choices require installed models on this machine. AWS evidence is
          synthetic. These workflows never plan or change real infrastructure. Real changes
          happen only in the Pilot apply area, by a person.
        </small>
      </p>
      <p>
        <small>
          Deeper analysis with private models on this machine is available at the Advanced level.
        </small>
      </p>
      <p>
        <a href="#operations">Browse all operations</a>
        <small> — every other check this workspace can run or explain, grouped by topic.</small>
      </p>
    </section>
  );
}
