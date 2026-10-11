import { useState } from "react";

import { beginnerEvidenceLine, type ExperienceLevel } from "../../experience-level.js";
import { validateInputs } from "../../../operations/schema.js";
import { requestOperationRun, type JobState, type ModelAvailability, type OperationDescriptor } from "../api";
import { beginnerStatusLine } from "../beginner-status";
import { BLOCK_REASON_NEXT_STEPS } from "../block-reasons";
import { StatusLed } from "../components/StatusLed";
import { unavailableNote } from "../components/WorkflowForm";
import { HandoffCard } from "./HandoffCard";
import { FieldControl, describeRefusal, initialValues, toInputs, type FormValues } from "./OperationFields";

export type OperationCardProps = {
  spec: OperationDescriptor;
  level: ExperienceLevel;
  csrfToken: string;
  jobState: JobState | null;
  /** A run is in flight anywhere in the console: the server allows one at a time. */
  busy: boolean;
  onRefresh: () => Promise<void> | void;
  onOpenViewer: (id: string) => void;
  /** Advisory only (GET /models): the server still validates every run. */
  modelAvailability?: ModelAvailability | null;
};

/** A card shows at most this many trailing characters of a run's output; the evidence panel shows more. */
export const CARD_OUTPUT_LIMIT = 4000;

/**
 * One operation: its summary, a form generated from its schema, and its latest
 * result. Presentation only. The same fields are validated again by the
 * server, which is the authority.
 */
export function OperationCard(props: OperationCardProps) {
  const { spec, level, jobState } = props;
  const [values, setValues] = useState<FormValues>(() => initialValues(spec.inputs));
  const [problem, setProblem] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const mine = jobState?.operation === spec.id ? jobState : null;
  const running = mine?.status === "RUNNING" || sending;
  // The console's own advisory check: a private-model card is offered only when the models can answer.
  const modelsOff = spec.safety === "LOCAL_MODEL" && props.modelAvailability?.status === "UNAVAILABLE";

  const submit = async () => {
    if (props.busy || sending) return;
    const inputs = toInputs(values);
    const checked = validateInputs(spec.inputs, inputs);
    if (!checked.ok) {
      setProblem(describeRefusal(checked.error, spec.inputs));
      return;
    }
    setProblem(null);
    setSending(true);
    const outcome = await requestOperationRun({ operation: spec.id, inputs, token: props.csrfToken });
    if (!outcome.accepted) setProblem(describeRefusal(outcome.error ?? "Request denied", spec.inputs));
    await props.onRefresh();
    setSending(false);
  };

  return (
    <article className="card op-card" id={"op-" + spec.id} aria-labelledby={"op-" + spec.id + "-title"}>
      <h3 id={"op-" + spec.id + "-title"} tabIndex={-1}>{spec.title}</h3>
      <p>{spec.summary}</p>
      {level !== "BEGINNER" && <p><small>CLI: <code>{spec.cli}</code></small></p>}
      {level === "EXPERT" && (
        <p><small>
          {spec.id} · {spec.safety} · inputs: {spec.inputs.length === 0 ? "none" : spec.inputs.map((field) => field.name).join(", ")}
        </small></p>
      )}
      <p><small>{level === "BEGINNER" ? beginnerEvidenceLine(spec.evidenceBasis) : spec.evidenceBasis}</small></p>
      {spec.runnable ? (
        <form onSubmit={(event) => { event.preventDefault(); void submit(); }}>
          {spec.inputs.map((field) => (
            <FieldControl key={field.name} idPrefix={"op-" + spec.id} field={field} value={values[field.name]}
              onChange={(value) => setValues((current) => ({ ...current, [field.name]: value }))} />
          ))}
          {problem && <p role="alert" className="op-problem">{problem}</p>}
          {modelsOff && props.modelAvailability && (
            <p className="op-problem" data-testid="op-models-off"><small>{unavailableNote(props.modelAvailability)}</small></p>
          )}
          {props.busy && !running && !modelsOff && (
            <p id={"op-" + spec.id + "-wait"}><small>Another run is in progress. Wait for it to finish.</small></p>
          )}
          <button type="submit" disabled={props.busy || sending || modelsOff} aria-busy={running}
            aria-describedby={"op-" + spec.id + "-title" + (props.busy && !running ? " op-" + spec.id + "-wait" : "")}
            data-running={running ? "true" : undefined}>
            {running ? "Running…" : "Run"}
          </button>
        </form>
      ) : (
        <HandoffCard spec={spec} level={level} onOpenViewer={props.onOpenViewer} />
      )}
      {mine && <OperationResult spec={spec} level={level} mine={mine} />}
    </article>
  );
}

/**
 * The latest result for this card, at every level: a status sentence, the
 * next step for a known block, and the run's bounded sanitized output. At
 * Beginner the sentences are the shared plain-language ones and the output
 * sits behind a "Show the result text" disclosure, still in the page.
 */
function OperationResult(props: { spec: OperationDescriptor; level: ExperienceLevel; mine: JobState }) {
  const { spec, level, mine } = props;
  const beginner = level === "BEGINNER";
  const finished = mine.status === "PASS" || mine.status === "BLOCKED";
  const output = mine.output.length > CARD_OUTPUT_LIMIT ? mine.output.slice(-CARD_OUTPUT_LIMIT) : mine.output;
  const log = (
    <div className="output op-output" tabIndex={0} role="region" aria-label={"Result of " + spec.title}>
      {output || "No output recorded."}
    </div>
  );
  return (
    <div className="op-result" data-testid="op-result">
      <StatusLed status={mine.status} />
      <p role="status" aria-live="polite">
        {beginner
          ? beginnerStatusLine(mine, true)
          : <>Last run: {mine.status}. <a href="#evidence">See Execution and evidence</a>.</>}
      </p>
      {!beginner && mine.status === "BLOCKED" && mine.blockReason && (
        <p className="run-next-step" data-testid="op-next-step">Next step: {BLOCK_REASON_NEXT_STEPS[mine.blockReason]}</p>
      )}
      {finished && (
        <>
          {output.length < mine.output.length && (
            <p><small>Showing the last {CARD_OUTPUT_LIMIT.toLocaleString("en-US")} of {mine.output.length.toLocaleString("en-US")} characters.</small></p>
          )}
          {beginner ? (
            <details data-testid="op-output">
              <summary>Show the result text</summary>
              {log}
            </details>
          ) : <div data-testid="op-output">{log}</div>}
        </>
      )}
    </div>
  );
}
