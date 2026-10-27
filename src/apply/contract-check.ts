import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { ENVIRONMENTS } from "./constants.js";
import { inspectPilotContract, repoPaths } from "./contract.js";
import { engineSpec } from "./engine-spec.js";
import { providerSpec } from "./provider.js";
import type { ApplyEnvironment } from "./types.js";

/**
 * The owner-input kit's offline check of a DRAFT pilot contract (`./alz apply contract-check --file DRAFT.json`;
 * docs/act-pilot-aws-terraform-g0.md). It answers one question for the person filling in the contract: which owner
 * inputs are still missing, still the shipped example's placeholder, or not accepted, each named in plain words.
 *
 * It reads the draft and the shipped example contracts (to recognize values copied from them) and nothing else: no
 * pin, no identity variable, no tool directory, no cloud, no network. It never enables ACT and never writes the pin; a
 * complete draft still needs the owner's reviewed commit of the contract and its pin (docs/act-pilot-apply.md, "The
 * contract and its pin"). The shape verdict is the contract validator's own (`inspectPilotContract`,
 * src/apply/contract.ts). The kit is stricter than the validator in exactly two ways: it requires enough approvers
 * allowed for PROD to reach `requiredApprovals.PROD` (the validator checks the number, not the list), and it refuses
 * values copied from the shipped examples (the fake account ids, the `examplefake` buckets, and an example's region,
 * workspace or kill switch path copied verbatim). It also requires `enabled` to be written as a boolean, as the loader
 * does (`inspectPilotContract` overrides it, so the validator alone would not notice).
 */

export type ContractCheckStatus = "PRESENT" | "MISSING" | "PLACEHOLDER" | "EXAMPLE" | "INVALID";
export type ContractCheckItem = {
  /** The contract field, as a path (`targets.DEV.backend`, `approvers[1].publicKeyPem`). */
  field: string;
  /** The owner input it carries, in plain words. */
  input: string;
  status: ContractCheckStatus;
  detail?: string;
};
export type ContractCheckReport = {
  provider: string | null;
  engine: string | null;
  /** The `enabled` flag as the draft writes it. A draft normally says false; the reviewed pin commit is where it becomes true. */
  enabledAsWritten: boolean | null;
  /** The environments the draft puts in scope: the DEV-only pilot or the DEV, QA, PROD chain. */
  scope: ApplyEnvironment[];
  /** The contract validator's verdict on the draft as if it were enabled: the one definition of a valid contract. */
  shape: { ok: true } | { ok: false; reason: string };
  inputs: ContractCheckItem[];
  /** Owner inputs that are not contract fields, and where each one is checked or recorded instead. */
  outsideContract: { input: string; where: string }[];
  /** Every input PRESENT and the shape valid. Completeness is information: it enables nothing. */
  complete: boolean;
  guarantees: readonly string[];
};

export const CONTRACT_CHECK_GUARANTEES: readonly string[] = [
  "This check read the draft file and the shipped example contracts (to recognize copied example values) and nothing else: no pin, no credential, no identity variable, no cloud and no network.",
  "It never enables ACT and never writes config/act-pilot-contract.sha256. ACT stays disabled until the owner's reviewed commit of the contract and its pin.",
  "A complete draft is information for the owner, not approval: seal and apply run their own gates.",
];

const PLACEHOLDER = /REPLACE-WITH/i;
/** The shipped examples' deliberately fake values: a repeated single character as an account identifier, and the `examplefake` buckets. */
const REPEATED_CHARACTER = /^(.)\1+$/;
const EXAMPLE_BACKEND = /^examplefake/i;
const EXAMPLE_KEY = "EXAMPLE";

/**
 * The values a person copies from a shipped example without deciding them: every region, workspace and kill switch
 * path the `config/act-pilot-contract*.example.json` files carry. Read from the repository, so the check follows the
 * examples; an unreadable example contributes nothing (the check then relies on the placeholder and fake-id rules).
 */
export function shippedExampleValues(configDir: string = join(repoPaths().root, "config")): { region: Set<string>; workspace: Set<string>; killSwitchPath: Set<string> } {
  const values = { region: new Set<string>(), workspace: new Set<string>(), killSwitchPath: new Set<string>() };
  let names: string[] = [];
  try { names = readdirSync(configDir).filter((name) => /^act-pilot-contract.*\.example\.json$/.test(name)); } catch { return values; }
  for (const name of names) {
    try {
      const example = JSON.parse(readFileSync(join(configDir, name), "utf8")) as Record<string, unknown>;
      if (typeof example.killSwitchPath === "string") values.killSwitchPath.add(example.killSwitchPath);
      for (const target of Object.values(isRecordLike(example.targets) ? example.targets : {})) {
        if (!isRecordLike(target)) continue;
        if (typeof target.region === "string") values.region.add(target.region);
        if (typeof target.workspace === "string") values.workspace.add(target.workspace);
      }
    } catch { /* an unreadable example contributes nothing */ }
  }
  return values;
}
const isRecordLike = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

/** The validator names the failing field first (`targets.DEV.accountId: invalid`); the kit item for that field carries the reason. */
function failingField(reason: string): string | undefined {
  const match = /^([A-Za-z0-9_.[\]]+): /.exec(reason);
  return match?.[1];
}

type Kind = "account" | "backend" | "region" | "workspace" | "killSwitchPath";
type Walk = { items: ContractCheckItem[]; add: (field: string, input: string, value: unknown, kind?: Kind) => void };

function walker(examples: ReturnType<typeof shippedExampleValues>): Walk {
  const items: ContractCheckItem[] = [];
  const add: Walk["add"] = (field, input, value, kind) => {
    let status: ContractCheckStatus = "PRESENT";
    let detail: string | undefined;
    if (value === undefined || value === null || value === "" || (Array.isArray(value) && value.length === 0)) {
      status = "MISSING";
    } else if (typeof value === "string" && PLACEHOLDER.test(value)) {
      status = "PLACEHOLDER";
      detail = "still the shipped example's REPLACE-WITH placeholder";
    } else if (kind === "account" && typeof value === "string" && REPEATED_CHARACTER.test(value)) {
      status = "EXAMPLE";
      detail = "a repeated single character is the shipped example's fake identifier, not an account";
    } else if (kind === "backend" && typeof value === "string" && EXAMPLE_BACKEND.test(value)) {
      status = "EXAMPLE";
      detail = "the shipped example's examplefake bucket, not a state bucket the owner provisioned";
    } else if ((kind === "region" || kind === "workspace" || kind === "killSwitchPath") && typeof value === "string" && examples[kind].has(value)) {
      status = "EXAMPLE";
      detail = "copied verbatim from a shipped example; the owner decides this value (change it, or keep it as a reviewed decision recorded in the pin commit)";
    }
    items.push({ field, input, status, ...(detail ? { detail } : {}) });
  };
  return { items, add };
}

/** The environments a draft puts in scope, as the validator reads `enabledEnvironments`: exactly ["DEV"], or every environment. */
function scopeOf(raw: Record<string, unknown>): ApplyEnvironment[] {
  const scoped = raw.enabledEnvironments;
  return Array.isArray(scoped) && scoped.length === 1 && scoped[0] === "DEV" ? ["DEV"] : [...ENVIRONMENTS];
}

/**
 * The owner inputs a draft carries, each by its contract field, and the validator's verdict. `raw` is the parsed draft;
 * anything that is not an object is reported as an invalid shape with no inputs.
 */
export function checkDraftContract(raw: unknown, examples: ReturnType<typeof shippedExampleValues> = shippedExampleValues()): ContractCheckReport {
  const inspected = inspectPilotContract(raw);
  const shape: ContractCheckReport["shape"] = inspected.ok ? { ok: true } : { ok: false, reason: inspected.reason };
  const empty = (provider: string | null, engine: string | null): ContractCheckReport => ({
    provider, engine, enabledAsWritten: null, scope: [...ENVIRONMENTS], shape, inputs: [], outsideContract: [], complete: false, guarantees: CONTRACT_CHECK_GUARANTEES,
  });
  if (!isRecord(raw)) return empty(null, null);

  const { items, add } = walker(examples);
  const provider = typeof raw.provider === "string" ? raw.provider : null;
  const engine = typeof raw.engine === "string" ? raw.engine : null;
  const spec = providerSpec(raw.provider);
  const engineOf = engineSpec(raw.engine);
  const scope = scopeOf(raw);

  if (Object.hasOwn(raw, EXAMPLE_KEY)) {
    items.push({ field: EXAMPLE_KEY, input: "the shipped example's own marker", status: "PLACEHOLDER", detail: "remove this field: it marks the file as the example, and the contract validator refuses it as an unknown field" });
  }
  // The loader refuses a missing or non-boolean `enabled` (src/apply/contract.ts); inspectPilotContract overrides it, so it is judged here.
  items.push(typeof raw.enabled === "boolean"
    ? { field: "enabled", input: "the enabled flag, written explicitly (false in a draft; true only in the owner's reviewed pin commit)", status: "PRESENT" }
    : { field: "enabled", input: "the enabled flag, written explicitly (false in a draft; true only in the owner's reviewed pin commit)", status: raw.enabled === undefined ? "MISSING" : "INVALID", detail: "the contract loader refuses a contract whose enabled flag is not exactly true or false" });
  add("provider", "the chosen provider (G0 decision)", provider);
  add("engine", "the chosen engine (G0 decision)", engine);
  add("policyVersion", "the reviewed policy version, which prepare copies into every request and manifest (the pin accepts its absence; prepare then stops with an owner prerequisite)", raw.policyVersion);
  add("enabledEnvironments", "the pilot scope: exactly [\"DEV\"] for the DEV-only pilot, or absent for the DEV, QA, PROD chain", raw.enabledEnvironments === undefined ? "absent (DEV, QA, PROD chain)" : raw.enabledEnvironments);

  const targets = isRecord(raw.targets) ? raw.targets : {};
  const approvals = isRecord(raw.requiredApprovals) ? raw.requiredApprovals : {};
  const noun = spec?.targetNoun ?? "account fields";
  for (const env of scope) {
    const target = isRecord(targets[env]) ? targets[env] as Record<string, unknown> : {};
    for (const field of Object.keys(spec?.accountFields ?? {})) {
      add("targets." + env + "." + field, "the " + env + " target's " + field + " (the " + noun + " the " + env + " environment runs in)", target[field], field === "region" ? "region" : "account");
    }
    add("targets." + env + ".backend", "the " + env + " state backend the owner provisioned, written as the contract's backend string (versioning on; one per environment)", target.backend, "backend");
    add("targets." + env + ".workspace", "the " + env + " workspace", target.workspace, "workspace");
    add("requiredApprovals." + env, "how many distinct verified approvals a " + env + " apply needs" + (env === "PROD" ? " (at least 2: the second production approver)" : ""), approvals[env]);
  }
  add("maxApprovalAgeMinutes", "how long a signed approval stays usable, in minutes", raw.maxApprovalAgeMinutes);

  const approvers = Array.isArray(raw.approvers) ? raw.approvers : [];
  if (approvers.length === 0) {
    add("approvers", "the approver allowlist: each approver's id, Ed25519 public key and environments (people are named by the owner, never by this tool)", undefined);
  }
  approvers.forEach((entry, index) => {
    const at = "approvers[" + index + "]";
    const record = isRecord(entry) ? entry : {};
    add(at + ".id", "approver " + (index + 1) + ": the id the approver signs as (a name or role the owner assigned)", record.id);
    add(at + ".publicKeyPem", "approver " + (index + 1) + ": the approver's Ed25519 public key in PEM (the private key stays with the approver)", record.publicKeyPem);
    add(at + ".environments", "approver " + (index + 1) + ": the environments this approver may sign for", record.environments);
  });
  if (scope.includes("PROD")) {
    const needed = typeof approvals.PROD === "number" ? approvals.PROD : 2;
    const prodApprovers = approvers.filter((entry) => isRecord(entry) && Array.isArray(entry.environments) && entry.environments.includes("PROD")).length;
    items.push({
      field: "approvers (PROD quorum)", input: "enough approvers allowed for PROD to reach requiredApprovals.PROD (the second production approver)",
      status: prodApprovers >= needed ? "PRESENT" : "MISSING",
      detail: prodApprovers + " approver(s) may sign for PROD; " + needed + " distinct approval(s) are required. The plan also says the requester cannot be one of them (docs/act-pilot-plan.md, authority item 3): not yet enforced in code, and required before G4",
    });
  }
  add("killSwitchPath", "the kill switch file path the pilot owner controls", raw.killSwitchPath, "killSwitchPath");
  if (raw.embedStateWrite !== undefined) add("embedStateWrite", "whether the seal-time init embeds STATE_WRITE's non-secret settings (optional; default off)", raw.embedStateWrite);

  // The validator's first refusal, attached to its field; a refusal that names no listed field is reported on the shape alone.
  if (!shape.ok) {
    const field = failingField(shape.reason);
    const item = field ? items.find((x) => x.field === field) : undefined;
    if (item && item.status === "PRESENT") { item.status = "INVALID"; item.detail = shape.reason; }
  }

  const identities = engineOf?.identities ?? [];
  const identityList = identities.length > 0 ? identities.join(", ") : "each identity the engine needs";
  const outsideContract = [
    { input: "the federated identities (" + identityList + "): one principal each, with its token file on the execution host, as ALZ_<IDENTITY>_* variables", where: "./alz apply preflight --environment <ENV> (configured, distinct, fallback-free, aimed at the contract's " + (spec?.accountNoun ?? "account") + "); ./alz apply qualify attests them from the cloud logs" },
    { input: "the identity provider trust that lets only each identity's token assume its principal", where: "the owner's bootstrap (docs/act-pilot-bootstrap.md) and the qualification attestation; not a contract field" },
    { input: "the least-privilege scope of each principal, the budget, the retention and the tags", where: "the owner's bootstrap and policy decisions (docs/act-pilot-bootstrap.md, docs/act-dev-1.md); the deletion-unit tags are declared in the project's provider configuration and verified at seal (docs/act-pilot-plan.md, \"Deletion unit\")" },
    { input: "the execution host", where: "named in the G0 package (docs/act-pilot-aws-terraform-g0.md) and in the owner's live records (./alz apply record-live, ./alz apply preview-evidence --target-hardware-id)" },
    { input: "the pilot scope (what the one change creates) and the cleanup owner", where: "the G0 package; the sealed plan's change list is what approvers sign, and cleanup is proposed from the run's own records (./alz apply propose-cleanup)" },
    { input: "the second production approver, when PROD is in scope", where: "the approvers list above, and requiredApprovals.PROD of at least 2; verified at apply as two distinct signatures. That neither is the requester's is the plan's rule, not yet enforced in code, and required before G4" },
  ];
  const complete = shape.ok && items.every((item) => item.status === "PRESENT");
  return {
    provider, engine, enabledAsWritten: typeof raw.enabled === "boolean" ? raw.enabled : null, scope, shape, inputs: items, outsideContract, complete,
    guarantees: CONTRACT_CHECK_GUARANTEES,
  };
}

/** The report as a person reads it at the terminal: one line per input, then what is outside the contract and what this check never does. */
export function contractCheckLines(report: ContractCheckReport, file: string): string[] {
  const pad = (status: string): string => status.padEnd(12);
  const lines = [
    "", "DRAFT CONTRACT CHECK (offline; enables nothing, writes nothing)",
    "  file            " + file,
    "  provider        " + (report.provider ?? "missing") + "   engine  " + (report.engine ?? "missing") + "   scope  " + report.scope.join(", "),
    "  enabled         " + (report.enabledAsWritten === null ? "missing" : String(report.enabledAsWritten)) + " as written (a draft stays false; the reviewed pin commit is where it becomes true)",
    "  shape           " + (report.shape.ok ? "valid (the contract validator accepts it as if it were enabled)" : "not accepted: " + report.shape.reason),
    "", "OWNER INPUTS",
    ...report.inputs.map((item) => "  " + pad(item.status) + item.field + ": " + item.input + (item.detail ? " [" + item.detail + "]" : "")),
    "", "NOT IN THE CONTRACT (supplied elsewhere)",
    ...report.outsideContract.map((item) => "  " + item.input + ": " + item.where),
    "",
    report.complete
      ? "COMPLETE: every input is present and the shape is valid. Next: the owner reviews the values, runs ./alz apply pin, and commits the contract and its pin in one reviewed change. Nothing here did that."
      : "INCOMPLETE: " + report.inputs.filter((item) => item.status !== "PRESENT").length + " input(s) above are not ready. Fill them in and run this check again.",
    ...report.guarantees.map((line) => "  " + line),
    "",
  ];
  return lines;
}
