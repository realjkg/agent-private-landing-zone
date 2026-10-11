import type { Field, OperationSpec, Values } from "../types.js";

// Enterprise libraries family: `./alz enterprise <module>` (see
// docs/enterprise-modules.md). Each entry is an offline, deterministic check of
// pasted JSON or of a built-in catalog. None executes an operation, calls out,
// holds a credential or grants authority; the libraries that need an injected
// identity, provider or policy (delegation, A2A, managed-operation execution)
// have no honest read-only report and stay library-only.

const CHECK = "OFFLINE CHECK OF PASTED JSON — NOTHING EXECUTED, NO CLOUD ACCESS, NO AUTHORITY GRANTED";
const BUILT_IN = "BUILT-IN CATALOG, OFFLINE — NOTHING FETCHED, RUN OR QUALIFIED HERE";

const json = (name: string, label: string, help: string, optional?: boolean): Field =>
  ({ kind: "json", name, label, help, maxBytes: 64 * 1024, ...(optional ? { optional } : {}) });
const text = (name: string, label: string, pattern: string, example: string, optional?: boolean): Field =>
  ({ kind: "text", name, label, pattern, example, maxLength: 40, ...(optional ? { optional } : {}) });
const input = (v: Values, name: string): string[] => (v[name] ? ["--input", String(v[name])] : []);
const flags = (v: Values, ...pairs: [string, string][]): string[] =>
  pairs.flatMap(([name, flag]) => (v[name] ? ["--" + flag, ...(typeof v[name] === "string" ? [String(v[name])] : [])] : []));

const entry = (sub: string, rest: Pick<OperationSpec, "title" | "summary" | "inputs" | "evidenceBasis"> & { args: (v: Values) => string[] }): OperationSpec => {
  const { args, ...spec } = rest;
  return { id: "enterprise-" + sub, family: "enterprise", cli: "./alz enterprise " + sub, safety: "READ_ONLY",
    cliScript: "src/cli/enterprise-" + sub + ".ts", command: { group: "enterprise", sub },
    job: { script: "cli/enterprise-" + sub + ".js", args }, ...spec };
};

const VERSION = "[A-Za-z0-9][A-Za-z0-9._+-]{0,39}";
const SCHEMA = "[0-9]{1,6}";

export const enterpriseOperations: readonly OperationSpec[] = [
  entry("ledger", {
    title: "Verify a change ledger export",
    summary: "Checks the signature, hash chain and evidence manifest of a signed change-ledger export against a public key you trust.",
    evidenceBasis: CHECK,
    inputs: [json("ledger", "Ledger export and key",
      'JSON like {"export": <signed export>, "trustedPublicKeyPem": "<PEM public key>"}. The key must come from you, not from the export\'s source.')],
    args: (v) => input(v, "ledger"),
  }),
  entry("playbook", {
    title: "Validate operational playbooks",
    summary: "Normalizes and hashes one operational playbook or a list, and checks any hash they carry; it never runs one.",
    evidenceBasis: CHECK,
    inputs: [json("playbooks", "Playbook or list of playbooks", "Each needs playbookId, version, operation, providerId, environmentId, targetResourceId, preconditions, maxTargets 1 and the other bounded fields.")],
    args: (v) => input(v, "playbooks"),
  }),
  entry("alert-rules", {
    title: "Validate alert rules",
    summary: "Checks alert rules against the strict schema and lists production signals that have no rule.",
    evidenceBasis: CHECK + "; BLANK CHECKS THE SHIPPED config/alert-rules.yaml",
    inputs: [json("rules", "Alert rules", 'The document as JSON: {"apiVersion", "kind", "rules": [...]}. Leave blank to check the shipped file.', true)],
    args: (v) => input(v, "rules"),
  }),
  entry("release-lifecycle", {
    title: "Plan a release lifecycle",
    summary: "Shows the ordered install, upgrade, config migration, rollback and uninstall steps for the release files, as a plan only.",
    evidenceBasis: "DETERMINISTIC PLAN OF RELEASE FILES ONLY — NOTHING INSTALLED, CHANGED OR REMOVED",
    inputs: [text("targetVersion", "Target version", VERSION, "1.4.0"), text("targetConfigSchema", "Target config schema", SCHEMA, "3"),
      text("currentVersion", "Installed version", VERSION, "1.3.0", true), text("previousVersion", "Previous version for rollback", VERSION, "1.2.0", true),
      text("currentConfigSchema", "Installed config schema", SCHEMA, "2", true), text("uninstallVersion", "Version to uninstall", VERSION, "1.1.0", true)],
    args: (v) => flags(v, ["targetVersion", "target-version"], ["targetConfigSchema", "target-config-schema"], ["currentVersion", "current-version"],
      ["previousVersion", "previous-version"], ["currentConfigSchema", "current-config-schema"], ["uninstallVersion", "uninstall-version"]),
  }),
  entry("models", {
    title: "List model candidates",
    summary: "Lists the model candidates tracked for architecture fit and whether each is in the active catalog or still unqualified.",
    evidenceBasis: BUILT_IN,
    inputs: [{ kind: "enum", name: "role", label: "Role", options: ["ALL", "ROUTER", "PRIMARY_ENGINEER", "VALIDATOR", "SPECIALIST"] },
      { kind: "flag", name: "local", label: "Local substrates only" }, { kind: "flag", name: "laptop24", label: "Fits a 24 GB laptop" }],
    args: (v) => [...(v.role === "ALL" ? [] : flags(v, ["role", "role"])), ...flags(v, ["local", "local"]), ...(v.laptop24 ? ["--laptop-24gb"] : [])],
  }),
  entry("environment", {
    title: "Validate an environment provider",
    summary: "Checks a read-only environment binding against the runtime profile's sovereignty rules, or verifies a signed offline edge manifest.",
    evidenceBasis: CHECK + "; NO REQUEST IS SENT TO THE ENVIRONMENT",
    inputs: [json("environment", "Binding or signed edge manifest",
      'JSON like {"binding": {environmentId, provider, runtimeProfile, deployment, origin, authRef?}} or {"edge": {rawManifest, signatureBase64, trustedPublicKeyPem, runtimeProfile}}. authRef is a reference such as secret://name, never a credential.')],
    args: (v) => input(v, "environment"),
  }),
  entry("knowledge", {
    title: "Show knowledge source status",
    summary: "Lists the registered knowledge sources and whether their baseline snapshots are accepted, or checks a snapshot you paste.",
    evidenceBasis: BUILT_IN + "; A PASTED SNAPSHOT IS CHECKED, NOT INGESTED",
    inputs: [json("snapshot", "Knowledge snapshot", "Optional. A snapshot document to check; leave blank to see the built-in baseline.", true),
      { kind: "flag", name: "privateSovereign", label: "Require a local mirror", help: "Applies the private-sovereign rule that a registry snapshot needs an approved local mirror." }],
    args: (v) => [...input(v, "snapshot"), ...(v.privateSovereign ? ["--private-sovereign"] : [])],
  }),
];
