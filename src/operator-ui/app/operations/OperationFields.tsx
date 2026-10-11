import type { Field } from "../../../operations/types.js";

export type FormValues = Record<string, string | boolean>;

/** The values a fresh form starts with: first enum option, flags off, text empty. */
export function initialValues(fields: readonly Field[]): FormValues {
  return Object.fromEntries(fields.map((field) => [
    field.name,
    field.kind === "enum" ? field.options[0] : field.kind === "flag" ? false : "",
  ]));
}

/** Drop empty text so an optional field is absent, as the server expects. */
export function toInputs(values: FormValues): FormValues {
  return Object.fromEntries(Object.entries(values).filter(([, value]) => value !== ""));
}

const REFUSALS: Readonly<Record<string, string>> = {
  INPUT_REQUIRED: "is required",
  INPUT_TOO_LONG: "is too long",
  INPUT_TOO_LARGE: "is larger than the size limit",
  INPUT_JSON_INVALID: "is not valid JSON",
  INPUT_PATTERN: "is not in the expected format",
  INPUT_CHARACTERS: "contains characters that are not allowed",
  INPUT_ENUM: "is not one of the choices",
  INPUT_TYPE: "has the wrong type",
  INPUT_FORBIDDEN: "contains a word that is never allowed here, such as apply, destroy or auto-approve",
};

/** Stable server codes that name no field, each with a sentence an operator can act on. */
const SERVER_REFUSALS: Readonly<Record<string, string>> = {
  REQUEST_TOO_LARGE: "The request is larger than the console accepts. Shorten the pasted text and try again.",
  WORKFLOW_ALREADY_RUNNING: "Another run is still in progress. Wait for it to finish, then try again.",
  OPERATION_ARGV_FORBIDDEN: "A value contains a word that is never allowed here, such as apply, destroy or auto-approve.",
  UNSUPPORTED_OPERATION: "The console does not know this operation. Reload the page.",
  OPERATION_HANDOFF_ONLY: "This operation is a guided handoff. Run its command in your own terminal.",
  INPUTS_NOT_JSON: "The form could not be read. Reload the page and try again.",
  MODEL_ENDPOINT_NOT_LOOPBACK: "The private model address (OLLAMA_BASE_URL) must be an http address on this machine. Fix it and restart the console.",
  CSRF_TOKEN_REQUIRED: "The page is out of date. Reload it and try again.",
};

/** Turn a validation or server refusal code into a sentence naming the field. */
export function describeRefusal(code: string, fields: readonly Field[]): string {
  const [kind, name] = code.split(":");
  const label = fields.find((field) => field.name === name)?.label;
  if (REFUSALS[kind] && label) return label + " " + REFUSALS[kind] + ".";
  return SERVER_REFUSALS[code] ?? code;
}

/** One control per schema field; the schema alone decides what is rendered. */
export function FieldControl(props: {
  idPrefix: string;
  field: Field;
  value: string | boolean;
  disabled?: boolean;
  onChange: (value: string | boolean) => void;
}) {
  const { field, value } = props;
  const id = props.idPrefix + "-" + field.name;
  const hint = field.help ? id + "-hint" : undefined;
  const note = field.help && <small id={hint}>{field.help}</small>;
  if (field.kind === "flag") {
    return (
      <p>
        <label htmlFor={id}>
          <input id={id} type="checkbox" checked={value === true} aria-describedby={hint}
            disabled={props.disabled} onChange={(event) => props.onChange(event.target.checked)} />{" "}
          {field.label}
        </label>
        {note}
      </p>
    );
  }
  return (
    <>
      <label className="field-label" htmlFor={id}>{field.label}</label>
      {field.kind === "enum" && (
        <select id={id} value={String(value)} aria-describedby={hint} disabled={props.disabled}
          onChange={(event) => props.onChange(event.target.value)}>
          {field.options.map((option) => (
            <option key={option} value={option}>{option.replaceAll("-", " ")}</option>
          ))}
        </select>
      )}
      {field.kind === "text" && (
        <input id={id} type="text" className="op-input" value={String(value)} maxLength={field.maxLength}
          placeholder={field.example} aria-required={!field.optional} aria-describedby={hint}
          autoComplete="off" spellCheck={false} disabled={props.disabled}
          onChange={(event) => props.onChange(event.target.value)} />
      )}
      {field.kind === "json" && (
        <>
          <textarea id={id} className="op-input" rows={6} value={String(value)} aria-required={!field.optional}
            aria-describedby={hint} autoComplete="off" spellCheck={false} disabled={props.disabled}
            onChange={(event) => props.onChange(event.target.value)} />
          <small>Pasted JSON, up to {field.maxBytes} bytes. It is validated and kept in a private folder only for the run.</small>
        </>
      )}
      {note}
    </>
  );
}
