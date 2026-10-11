// The operation catalog's types. Browser-safe on purpose: no node imports, so
// the console bundle can share them (and the validator in schema.ts) with the
// server, the docs generator and the parity guard.

export const FAMILIES = ["evidence", "governance", "qualification", "teardown", "enterprise"] as const;
export type Family = (typeof FAMILIES)[number];

export const FAMILY_TITLES: Readonly<Record<Family, string>> = {
  evidence: "Evidence and inspection",
  governance: "Governance and policy",
  qualification: "Qualification",
  teardown: "Teardown review",
  enterprise: "Enterprise libraries",
};

/**
 * What a run can touch. READ_ONLY and SYNTHETIC never leave the machine's
 * fixtures; LOCAL_MODEL calls the loopback model server; WRITES_LOCAL writes
 * only under the repository workspace; HANDOFF is never run by the console.
 */
export const SAFETY_CLASSES = ["READ_ONLY", "SYNTHETIC", "LOCAL_MODEL", "WRITES_LOCAL", "HANDOFF"] as const;
export type SafetyClass = (typeof SAFETY_CLASSES)[number];

type FieldBase = { name: string; label: string; help?: string; optional?: boolean };

export type Field =
  /** One of `options`; absent means the first option. */
  | (FieldBase & { kind: "enum"; options: readonly string[] })
  /** Single line, matched in full by `pattern`; `example` must match it. */
  | (FieldBase & { kind: "text"; pattern: string; maxLength: number; example: string })
  /** Absent means false. */
  | (FieldBase & { kind: "flag" })
  /** Pasted JSON text. A job receives the path of a server-written copy, never the text. */
  | (FieldBase & { kind: "json"; maxBytes: number });

/** Validated input values. A json field holds its text until the server swaps in a file path. */
export type Values = Readonly<Record<string, string | boolean | undefined>>;

export type Job = {
  /** Compiled script under dist/, e.g. "cli/discover.js". */
  script: string;
  /** Pure: turns validated values into the fixed argument list. */
  args: (values: Values) => string[];
  /** The workflow prints a "Recovery verification: <status>" line. */
  reportsRecoveryVerification?: boolean;
};

export type Handoff = {
  /** Why this needs a person at a terminal, in plain words. */
  reason: string;
  /** The exact command; `{field}` is replaced by the validated value (a flag by its --name). */
  command: string;
  /** Environment variable names to set first. Names only: the console never holds values. */
  env?: readonly string[];
  /** Id of a READ_ONLY operation that displays the redacted evidence the command wrote. */
  viewer?: string;
};

export type OperationSpec = {
  id: string;
  title: string;
  /** One plain-language sentence. */
  summary: string;
  family: Family;
  /** The exact form: "./alz ...", "npm run <script>" or "npx tsx src/cli/<file>.ts ...". */
  cli: string;
  safety: SafetyClass;
  inputs: readonly Field[];
  /** The literal honest label shown beside results. */
  evidenceBasis: string;
  /** Runnable classes only. */
  job?: Job;
  /** HANDOFF only. */
  handoff?: Handoff;
  /** The src/cli entry this operation fronts. Required with `command`. */
  cliScript?: string;
  /**
   * `./alz <group> <sub> [args]` runs cliScript; for capabilities with no legacy branch.
   * `args` are fixed arguments placed before the operator's own, so the command and the console job agree.
   */
  command?: { group: string; sub: string; args?: readonly string[] };
  /** package.json scripts this operation covers (checked by the parity guard). */
  npm?: readonly string[];
};

export type OperatorJob = {
  /** The operation id. */
  mode: string;
  script: string;
  args: string[];
  title: string;
  evidenceBasis: string;
  reportsRecoveryVerification?: boolean;
  /** A WRITES_LOCAL operation: the runner refuses it unless a local evidence key already exists. */
  writesLocal?: boolean;
};

/** What GET /operations returns: no script, path or argument builder. */
export type OperationDescriptor = Pick<
  OperationSpec,
  "id" | "title" | "summary" | "family" | "cli" | "safety" | "inputs" | "evidenceBasis" | "handoff"
> & { runnable: boolean };
