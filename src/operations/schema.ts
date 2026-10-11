import {
  FAMILIES,
  SAFETY_CLASSES,
  type Field,
  type OperationDescriptor,
  type OperationSpec,
  type Values,
} from "./types.js";

export const MAX_TEXT_LENGTH = 256;
export const MAX_JSON_BYTES = 64 * 1024;

export type Validation = { ok: true; values: Values } | { ok: false; error: string };

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

/**
 * A run must never reach apply, destroy, an auto-approval or the destroy-preview
 * driver, whoever supplied the word. The driver subcommands are handoff-only.
 */
const FORBIDDEN_ARGUMENT = /destroy|preview-only|apply|auto-approve|preview-run|teardown-driver/i;

/** Job scripts a catalog entry may never run: the drivers, the dispatcher and the console host. */
const FORBIDDEN_JOB_SCRIPT = /^cli\/(teardown-driver|apply|operator|operator-web|session|evidence-migrate)\.js$/;

/**
 * Validates raw inputs against a schema. Refusals are stable codes that never
 * echo the supplied value. Unknown fields are refused, caps are enforced, and
 * a text value can neither carry control characters nor start with "-", so it
 * cannot become an option when a job places it in its argument list.
 */
export function validateInputs(fields: readonly Field[], raw: unknown): Validation {
  const given = raw ?? {};
  if (typeof given !== "object" || Array.isArray(given)) return fail("INPUTS_NOT_OBJECT");
  const supplied = given as Record<string, unknown>;
  const known = new Set(fields.map((field) => field.name));
  if (Object.keys(supplied).some((key) => !known.has(key))) return fail("INPUT_UNKNOWN_FIELD");
  const values: Record<string, string | boolean | undefined> = {};
  for (const field of fields) {
    const value = Object.hasOwn(supplied, field.name) ? supplied[field.name] : undefined;
    const problem = checkField(field, value, values);
    if (problem) return fail(problem + ":" + field.name);
  }
  return { ok: true, values };
}

function checkField(
  field: Field,
  value: unknown,
  out: Record<string, string | boolean | undefined>,
): string | null {
  if (field.kind === "flag") {
    if (value !== undefined && typeof value !== "boolean") return "INPUT_TYPE";
    out[field.name] = value === true;
    return null;
  }
  if (field.kind === "enum") {
    const chosen = value ?? field.options[0];
    if (typeof chosen !== "string") return "INPUT_TYPE";
    if (!field.options.includes(chosen)) return "INPUT_ENUM";
    out[field.name] = chosen;
    return null;
  }
  if (value === undefined || value === "") {
    if (!field.optional) return "INPUT_REQUIRED";
    return null;
  }
  if (typeof value !== "string") return "INPUT_TYPE";
  if (field.kind === "json") {
    if (new TextEncoder().encode(value).length > field.maxBytes) return "INPUT_TOO_LARGE";
    try {
      JSON.parse(value);
    } catch {
      return "INPUT_JSON_INVALID";
    }
    out[field.name] = value;
    return null;
  }
  if (value.length > field.maxLength) return "INPUT_TOO_LONG";
  if (CONTROL_CHARACTERS.test(value) || value.startsWith("-")) return "INPUT_CHARACTERS";
  if (!new RegExp("^(?:" + field.pattern + ")$").test(value)) return "INPUT_PATTERN";
  // Refused here, before any state change, so the browser and the server both answer with a 400.
  if (FORBIDDEN_ARGUMENT.test(value)) return "INPUT_FORBIDDEN";
  out[field.name] = value;
  return null;
}

const fail = (error: string): Validation => ({ ok: false, error });

/** Quote a value for a POSIX shell unless it is plainly safe. */
function shellWord(value: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(value) ? value : "'" + value.replaceAll("'", "'\\''") + "'";
}

/** Fill a handoff command template from validated values. */
export function fillCommand(template: string, fields: readonly Field[], values: Values): string {
  return template
    .replace(/\{([a-zA-Z0-9]+)\}/g, (_, name: string) => {
      const field = fields.find((candidate) => candidate.name === name);
      const value = values[name];
      if (field?.kind === "flag") return value === true ? "--" + name : "";
      return typeof value === "string" ? shellWord(value) : "";
    })
    .replace(/ {2,}/g, " ")
    .trim();
}

export function assertSafeArgv(args: readonly string[], skipPrefix?: string): void {
  for (const arg of args) {
    if (skipPrefix && arg.startsWith(skipPrefix)) continue;
    if (FORBIDDEN_ARGUMENT.test(arg)) throw new Error("OPERATION_ARGV_FORBIDDEN");
  }
}

/** Argument lists for a spread of representative inputs: each enum option and both flag states. */
export function sampleArgvs(spec: OperationSpec): string[][] {
  if (!spec.job) return [];
  const base: Record<string, string | boolean> = {};
  for (const field of spec.inputs) {
    base[field.name] = field.kind === "enum" ? field.options[0]
      : field.kind === "flag" ? false
        : field.kind === "text" ? field.example : "/private/" + field.name + ".json";
  }
  const runs: Record<string, string | boolean>[] = [base];
  for (const field of spec.inputs) {
    if (field.kind === "enum") for (const option of field.options) runs.push({ ...base, [field.name]: option });
    if (field.kind === "flag") runs.push({ ...base, [field.name]: true });
  }
  return runs.map((values) => spec.job!.args(values));
}

const ID = /^[a-z][a-z0-9-]{1,40}$/;
const FIELD_NAME = /^[a-z][a-zA-Z0-9]*$/;
const OPTION = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;
const CLI_FORM = /^(\.\/alz [a-z]|npm run [a-z]|npx tsx src\/cli\/[a-z0-9-]+\.ts)/;

/** Structural problems in a catalog; empty means well formed. */
export function validateCatalog(specs: readonly OperationSpec[]): string[] {
  const problems: string[] = [];
  const ids = new Set<string>();
  const commands = new Set<string>();
  for (const spec of specs) {
    const at = (message: string) => problems.push(spec.id + ": " + message);
    if (!ID.test(spec.id)) at("bad id");
    if (ids.has(spec.id)) at("duplicate id");
    ids.add(spec.id);
    if (!FAMILIES.includes(spec.family)) at("unknown family");
    if (!SAFETY_CLASSES.includes(spec.safety)) at("unknown safety class");
    if (!spec.title.trim() || spec.title.length > 80) at("title must be 1-80 characters");
    if (!spec.summary.trim() || spec.summary.length > 200 || /\n/.test(spec.summary)) {
      at("summary must be one sentence of at most 200 characters");
    }
    if (!CLI_FORM.test(spec.cli)) at("cli must start with ./alz, npm run or npx tsx src/cli/");
    if (!spec.evidenceBasis.trim()) at("evidenceBasis is required");
    if (spec.cliScript !== undefined && !/^src\/cli\/[a-z0-9-]+\.ts$/.test(spec.cliScript)) {
      at("cliScript must be src/cli/<file>.ts");
    }
    if (spec.safety === "HANDOFF") {
      if (spec.job) at("a HANDOFF operation must not have a job");
      if (!spec.handoff?.reason.trim() || !spec.handoff.command.trim()) at("HANDOFF needs a reason and a command");
      for (const name of spec.handoff?.env ?? []) if (!/^[A-Z][A-Z0-9_]*$/.test(name)) at("bad env name");
    } else {
      if (spec.handoff) at("only a HANDOFF operation has a handoff");
      if (!spec.job) at("a runnable operation needs a job");
      else if (!/^cli\/[a-z0-9-]+\.js$/.test(spec.job.script)) at("job script must be cli/<file>.js");
      else if (FORBIDDEN_JOB_SCRIPT.test(spec.job.script)) at("job script " + spec.job.script + " may not be run by the console");
    }
    if (spec.command) {
      const key = spec.command.group + " " + spec.command.sub;
      if (!/^[a-z][a-z-]*$/.test(spec.command.group) || !/^[a-z][a-z0-9-]*$/.test(spec.command.sub) ||
        spec.command.sub === "list") at("bad command");
      if (commands.has(key)) at("duplicate command " + key);
      commands.add(key);
      if (!spec.cliScript) at("command needs a cliScript");
    }
    const names = new Set<string>();
    for (const field of spec.inputs) {
      if (!FIELD_NAME.test(field.name)) at("bad field name " + field.name);
      if (names.has(field.name)) at("duplicate field " + field.name);
      names.add(field.name);
      if (!field.label.trim()) at("field " + field.name + " needs a label");
      if (field.kind === "enum" && (field.options.length === 0 || !field.options.every((o) => OPTION.test(o)))) {
        at("field " + field.name + " has bad options");
      }
      if (field.kind === "json" && !(field.maxBytes > 0 && field.maxBytes <= MAX_JSON_BYTES)) {
        at("field " + field.name + " maxBytes must be 1-" + MAX_JSON_BYTES);
      }
      if (field.kind === "text") {
        if (!(field.maxLength > 0 && field.maxLength <= MAX_TEXT_LENGTH)) at("field " + field.name + " bad maxLength");
        else if (!validateInputs([{ ...field, optional: false }], { [field.name]: field.example }).ok) {
          at("field " + field.name + " example does not satisfy its own schema");
        }
      }
    }
    for (const [, name] of (spec.handoff?.command ?? "").matchAll(/\{([a-zA-Z0-9]+)\}/g)) {
      const field = spec.inputs.find((candidate) => candidate.name === name);
      if (!field || field.kind === "json") at("handoff command placeholder {" + name + "} has no usable field");
    }
    try {
      for (const args of sampleArgvs(spec)) assertSafeArgv(args);
    } catch {
      at("job argument list contains a forbidden word");
    }
  }
  for (const spec of specs) {
    const viewer = spec.handoff?.viewer;
    if (viewer && specs.find((candidate) => candidate.id === viewer)?.safety !== "READ_ONLY") {
      problems.push(spec.id + ": handoff viewer must be a READ_ONLY operation");
    }
  }
  return problems;
}

export function describeOperation(spec: OperationSpec): OperationDescriptor {
  const { id, title, summary, family, cli, safety, inputs, evidenceBasis, handoff } = spec;
  return { id, title, summary, family, cli, safety, inputs, evidenceBasis, runnable: safety !== "HANDOFF",
    ...(handoff ? { handoff } : {}) };
}

/**
 * The largest POST /run body any catalog entry can legally produce. The inputs
 * travel as JSON text inside a form-encoded body: a quote in pasted JSON becomes
 * \" in the JSON text and %5C%22 in the form, so a byte can cost up to 6 characters
 * (12 for a text character that is a four-byte code point). Field names, the
 * operation id, the token and separators ride on top.
 */
export function maxRequestBytes(specs: readonly OperationSpec[]): number {
  const SLACK = 4096;
  const perField = (field: Field): number => {
    const overhead = field.name.length * 6 + 24;
    if (field.kind === "json") return field.maxBytes * 6 + overhead;
    if (field.kind === "text") return field.maxLength * 12 + overhead;
    if (field.kind === "enum") return Math.max(...field.options.map((option) => option.length)) * 6 + overhead;
    return 16 + overhead;
  };
  return specs.reduce((most, spec) => Math.max(most, spec.inputs.reduce((sum, field) => sum + perField(field), 0)), 0) + SLACK;
}
