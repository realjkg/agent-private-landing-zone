import { useState } from "react";

import type { ExperienceLevel } from "../../experience-level.js";
import { fillCommand, validateInputs } from "../../../operations/schema.js";
import type { OperationDescriptor } from "../api";
import { FieldControl, initialValues, toInputs, type FormValues } from "./OperationFields";

/**
 * An operation the console never runs. It explains why a person must use a
 * terminal and, from Advanced up, builds the exact command from the form. There
 * is deliberately no run button and no request is ever sent from here.
 */
export function HandoffCard(props: {
  spec: OperationDescriptor;
  level: ExperienceLevel;
  onOpenViewer: (id: string) => void;
}) {
  const { spec, level } = props;
  const handoff = spec.handoff!;
  const [values, setValues] = useState<FormValues>(() => initialValues(spec.inputs));
  const [copied, setCopied] = useState<"yes" | "no" | null>(null);
  const checked = validateInputs(spec.inputs, toInputs(values));
  const command = checked.ok ? fillCommand(handoff.command, spec.inputs, checked.values) : null;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(command ?? "");
      setCopied("yes");
    } catch {
      setCopied("no");
    }
  };

  return (
    <>
      <p className="op-handoff">
        <span className="badge">Run in a terminal</span> {handoff.reason}
      </p>
      {level === "BEGINNER" ? (
        <p><small>Switch to Advanced to see the exact command.</small></p>
      ) : (
        <>
          {spec.inputs.map((field) => (
            <FieldControl key={field.name} idPrefix={"op-" + spec.id} field={field} value={values[field.name]}
              onChange={(value) => setValues((current) => ({ ...current, [field.name]: value }))} />
          ))}
          {handoff.env && handoff.env.length > 0 && (
            <p>
              <small>Set these environment variables first. The console never asks for their values: </small>
              {handoff.env.map((name) => <code key={name}>{name} </code>)}
            </p>
          )}
          {command ? (
            <p>
              <code className="op-command" data-testid="handoff-command">{command}</code>{" "}
              <button type="button" onClick={() => void copy()}>Copy command</button>
              <span role="status" aria-live="polite">
                {copied === "yes" ? " Copied." : copied === "no" ? " Copy failed: select the command and copy it." : ""}
              </span>
            </p>
          ) : (
            <p><small>Complete the fields to see the command.</small></p>
          )}
        </>
      )}
      {handoff.viewer && (
        <p>
          <button type="button" className="link-button" onClick={() => props.onOpenViewer(handoff.viewer!)}>
            Review the evidence it wrote
          </button>
        </p>
      )}
    </>
  );
}
