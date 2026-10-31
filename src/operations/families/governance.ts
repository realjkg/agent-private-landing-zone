import { MAX_JSON_BYTES } from "../schema.js";
import type { Field, OperationSpec, SafetyClass, Values } from "../types.js";

// Governance and policy: target intent, recovery readiness, control-plane
// recovery, economics, health and the self-checks. Runnable entries are
// offline and read-only; anything that writes outside a private directory,
// needs the evidence key, a network or a person at a terminal is a handoff.

const json = (name: string, label: string, help: string, maxBytes = MAX_JSON_BYTES): Field =>
  ({ kind: "json", name, label, help, maxBytes });
const path = (name: string, label: string, example: string): Field =>
  ({ kind: "text", name, label, pattern: "[A-Za-z0-9_./][A-Za-z0-9_./-]*", maxLength: 200, example });

type Entry = Pick<OperationSpec, "id" | "title" | "summary" | "cli" | "evidenceBasis"> &
  Partial<Pick<OperationSpec, "inputs" | "npm" | "cliScript">>;
const entry = (safety: SafetyClass, spec: Entry, rest: Pick<OperationSpec, "job" | "handoff">): OperationSpec =>
  ({ family: "governance", inputs: [], safety, ...spec, ...rest });

const read = (spec: Entry, script: string, args: (values: Values) => string[]): OperationSpec =>
  entry("READ_ONLY", spec, { job: { script: "cli/" + script + ".js", args } });
const view = (spec: Entry, kind: string, field: string): OperationSpec =>
  read(spec, "governance-file", (values) => [kind, String(values[field])]);
const handoff = (spec: Entry, reason: string, command: string, env?: readonly string[], viewer?: string): OperationSpec =>
  entry("HANDOFF", spec, { handoff: { reason, command, ...(env ? { env } : {}), ...(viewer ? { viewer } : {}) } });

const NO_CHANGE = "LOCAL READ-ONLY CHECK — no model, no cloud, no infrastructure change";
const KEY = ["AGENTIC_EVIDENCE_KEY_FILE"] as const;
const KEY_REASON = "It reads or writes an encrypted bundle on disk and needs the local evidence key, which the console never handles.";
const KEY_CREATE_REASON = "On a fresh machine the security preflight creates the local evidence key in your home directory, which the console must not do.";
const PILOT_ENV = ["DISCOVERY", "STATE", "STATE_WRITE", "APPLY"].flatMap((identity) =>
  ["CLIENT_ID", "TENANT_ID", "SUBSCRIPTION_ID", "USE_OIDC", "OIDC_TOKEN_FILE"].map((name) => "ALZ_" + identity + "_ARM_" + name));
const evidence = path("evidence", "Encrypted bundle path", ".runs/evidence/control-plane.bundle");

export const governanceOperations: readonly OperationSpec[] = [
  handoff({
    id: "act-pilot-apply", cliScript: "src/cli/apply.ts", title: "Pilot apply (human-authorized)",
    summary: "Qualifies the engine, seals a preview, signs an approval, applies the sealed plan or shows status, under the pilot contract only.",
    cli: "./alz apply <qualify|seal|approve|apply|status>",
    evidenceBasis: "HUMAN-AUTHORIZED APPLY OF A SEALED PLAN — PILOT CONTRACT ONLY, ACT DISABLED OTHERWISE — ENCRYPTED EVIDENCE",
    inputs: [{ kind: "enum", name: "step", label: "Step", options: ["qualify", "seal", "approve", "apply", "status"],
      help: "Each step takes its own flags; run ./alz apply with no step to see them." }],
  }, "It needs a person: either at an interactive terminal, or in the console's guided Pilot apply wizard (open Pilot apply in the menu and paste the session token printed in the terminal where the console started). " +
    "Either way the person types the exact phrases, approvers sign with their own Ed25519 key files, and the apply driver enforces the pilot contract, the kill switch and the approvals. " +
    "One change runs wholly in one of the two, never both. This card only shows the terminal command; the operations job table never runs an apply. " +
    "Set four separate identities with the ALZ_DISCOVERY_, ALZ_STATE_, ALZ_STATE_WRITE_ and ALZ_APPLY_ prefixes in the environment that runs it; none falls back to another.",
  "./alz apply {step}", [...PILOT_ENV, ...KEY]),
  handoff({
    id: "target-init", title: "Create a recovery target intent",
    summary: "Records seven plain answers as a recovery intent file in config/recovery-intents.",
    cli: "./alz target init <target-id> <owner> <aws|azure> <scope-id> <startup|enterprise> <development|production> <non-critical|business|critical> [--compliance=PACK@1,...]",
    evidenceBasis: "WRITES config/recovery-intents/<target-id>.json — no cloud, no infrastructure change",
    inputs: [
      { kind: "text", name: "targetId", label: "Target id", pattern: "[a-z0-9][a-z0-9._-]{2,63}", maxLength: 64, example: "aws-platform-primary" },
      { kind: "text", name: "owner", label: "Owner", pattern: "[A-Za-z0-9][A-Za-z0-9._@-]{0,63}", maxLength: 64, example: "platform-operations" },
      { kind: "enum", name: "provider", label: "Provider", options: ["aws", "azure"] },
      { kind: "text", name: "scopeId", label: "Scope id", pattern: "[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}", maxLength: 128, example: "o-example" },
      { kind: "enum", name: "organization", label: "Organization", options: ["startup", "enterprise"] },
      { kind: "enum", name: "environment", label: "Environment", options: ["development", "production"] },
      { kind: "enum", name: "criticality", label: "Criticality", options: ["non-critical", "business", "critical"] },
      { kind: "text", name: "compliance", label: "Compliance packs", optional: true, help: "Comma-separated PACK@version.",
        pattern: "[A-Za-z0-9_]+@[0-9]+(,[A-Za-z0-9_]+@[0-9]+)*", maxLength: 200, example: "SOC2@1,HIPAA@1" },
    ],
  }, "It writes a file into the repository's config directory, and the console only runs jobs that write nothing there.",
  "./alz target init {targetId} {owner} {provider} {scopeId} {organization} {environment} {criticality} --compliance={compliance}",
  undefined, "target-explain"),
  view({
    id: "target-check", title: "Check a recovery target intent",
    summary: "Validates a pasted recovery intent file against the intent schema.",
    cli: "./alz target check <intent-file>", evidenceBasis: NO_CHANGE,
    inputs: [json("intent", "Intent JSON", "The contents of a file made by target init.", 4096)],
  }, "target-check", "intent"),
  view({
    id: "target-explain", title: "Explain a recovery target intent",
    summary: "Shows the continuity defaults a recovery intent file would derive, in plain language.",
    cli: "./alz target explain <intent-file>", evidenceBasis: NO_CHANGE,
    inputs: [json("intent", "Intent JSON", "The contents of a file made by target init.", 4096)],
  }, "target-explain", "intent"),
  view({
    id: "recovery-status", title: "Recovery target status",
    summary: "Reports whether each pasted recovery target is valid and ready, or blocked and why.",
    cli: "./alz recovery status [target-file]", evidenceBasis: NO_CHANGE,
    inputs: [json("targets", "Recovery targets JSON", "A list like config/recovery-targets.example.json.")],
  }, "recovery-status", "targets"),
  view({
    id: "recovery-test", title: "Recovery test readiness",
    summary: "Reports whether each pasted recovery target is ready for an isolated restore test.",
    cli: "./alz recovery test [target-file]", evidenceBasis: NO_CHANGE,
    inputs: [json("targets", "Recovery targets JSON", "A list like config/recovery-targets.example.json.")],
  }, "recovery-test", "targets"),
  handoff({
    id: "control-plane-capture", cliScript: "src/cli/control-plane-recovery.ts", title: "Capture control-plane recovery evidence",
    summary: "Seals a release tree into an encrypted control-plane recovery bundle.",
    cli: "./alz control-plane capture --root <release-root> --evidence <encrypted-bundle>",
    evidenceBasis: "WRITES an encrypted bundle — key material is excluded, ACT stays disabled",
    inputs: [path("root", "Release root", "."), evidence],
  }, "It writes an encrypted bundle and needs the local evidence key, which the console never handles.",
  "./alz control-plane capture --root {root} --evidence {evidence}", KEY),
  handoff({
    id: "control-plane-verify", cliScript: "src/cli/control-plane-recovery.ts", title: "Verify control-plane recovery evidence",
    summary: "Decrypts an encrypted recovery bundle and checks its release identity and hashes.",
    cli: "./alz control-plane verify --evidence <encrypted-bundle>",
    evidenceBasis: "READS an encrypted bundle — key material is excluded, ACT stays disabled",
    inputs: [evidence],
  }, KEY_REASON, "./alz control-plane verify --evidence {evidence}", KEY),
  handoff({
    id: "control-plane-drill", cliScript: "src/cli/control-plane-recovery.ts", title: "Control-plane restore drill",
    summary: "Restores a recovery bundle into a throwaway directory to prove it works, then deletes the copy.",
    cli: "./alz control-plane drill --evidence <encrypted-bundle>",
    evidenceBasis: "ISOLATED RESTORE DRILL — temporary local directory only, ACT stays disabled",
    inputs: [evidence],
  }, KEY_REASON, "./alz control-plane drill --evidence {evidence}", KEY),
  handoff({
    id: "control-plane-restore", cliScript: "src/cli/control-plane-recovery.ts", title: "Restore the control plane",
    summary: "Restores a recovery bundle into an empty, isolated directory and verifies the release.",
    cli: "./alz control-plane restore --evidence <encrypted-bundle> --restore-root <empty-isolated-path>",
    evidenceBasis: "WRITES restored files to the chosen empty directory — ACT stays disabled",
    inputs: [evidence, path("restoreRoot", "Restore root", "/var/tmp/alz-restore")],
  }, "It writes restored files to a directory you choose and needs the local evidence key.",
  "./alz control-plane restore --evidence {evidence} --restore-root {restoreRoot}", KEY),
  view({
    id: "economics-report", cliScript: "src/cli/economics.ts", title: "Operating economics report",
    summary: "Analyzes pasted monthly cost entries and prints run cost, forecast and alerts as JSON.",
    cli: "./alz economics report <input.json> [--json]",
    evidenceBasis: "ADVISORY — computed only from the pasted entries; no billing or cloud access",
    inputs: [json("input", "Economics input JSON", "Shaped like config/economics.example.json.")],
  }, "economics", "input"),
  {
    id: "cost-status", family: "governance", safety: "HANDOFF", title: "Cost and visibility status",
    summary: "Reads the budget, alerts, required tags, cost-allocation tags and cost export from AWS, read-only, and saves them for the Cost and visibility panel.",
    cli: "./alz cost status --account <12-digit account> [--unit <unit> --region <region>] [--export-arn <arn>]",
    evidenceBasis: "LIVE AWS READ-ONLY — budget, alerts, tags and cost export; advisory, a budget alerts and never caps spend; no change, ACT stays disabled",
    cliScript: "src/cli/cost.ts", command: { group: "cost", sub: "status", args: ["status"] },
    inputs: [{ kind: "text", name: "account", label: "AWS account", pattern: "[0-9]{12}", maxLength: 12, example: "111111111111",
      help: "The account the cost baseline was deployed to." }],
    handoff: { reason: "It reads AWS with the sign-in in your own terminal, which the console never holds. The Pilot apply area's Cost and visibility panel then shows what it read.",
      command: "./alz cost status --account {account}", env: ["AWS_PROFILE"] },
  },
  read({
    id: "health", title: "Runtime health and readiness",
    summary: "Prints a one-shot health snapshot, readiness checks and the effective observability settings.",
    cli: "./alz health [--serve]", evidenceBasis: "LOCAL PROCESS SNAPSHOT — one shot, no listener started, no cloud",
  }, "health", () => []),
  handoff({
    id: "doctor", title: "Operator self-check",
    summary: "Runs the security preflight, plug-in compatibility and toolbox self-checks in order.",
    cli: "./alz doctor", evidenceBasis: NO_CHANGE,
  }, KEY_CREATE_REASON, "./alz doctor", undefined, "plugins"),
  handoff({
    id: "deps", title: "Dependency check and guided installs", cliScript: "src/cli/deps.ts",
    summary: "Checks Node, Terraform, Ollama, the model service and product tools, and offers menus to install, update or remove the pinned Terraform and Ollama.",
    cli: "./alz deps", evidenceBasis: "LOCAL CHECK — installs or updates only after you choose \"Install it\" or \"Update it\" for each tool, into your user folder; an earlier version stays until the new one is checked; no cloud, no infrastructure change",
  }, "Installs need a person at an interactive Terminal window, choosing from a menu for each tool, which the console never has.", "./alz deps"),
  handoff({
    id: "lifecycle", title: "Packaged release lifecycle runner", cliScript: "src/cli/lifecycle.ts",
    summary: "Runs the packaged release's lifecycle journeys on a disposable host, journaled and resumable, and writes the platform gate report with the admission review's verdict.",
    cli: "./alz lifecycle <clean-install|uninstall|partial-install-recovery|all> --artifact FILE.tgz --evidence DIR --host ID --commit SHA [--home DIR] [--synthetic]",
    evidenceBasis: "LOCAL LIFECYCLE EVIDENCE — installs and removes the app under the user folder of a disposable host only; the report is judged by the release admission review and is never submitted or admitted here; --synthetic is labeled and never submittable; no cloud, no infrastructure change",
  }, "It installs and removes the packaged app on a disposable host and needs a person at that host's Terminal; the console never runs it, and it never submits evidence.", "./alz lifecycle all --artifact FILE.tgz --evidence DIR --host ID --commit SHA"),
  handoff({
    id: "security-check", title: "Security preflight", cliScript: "src/cli/security.ts",
    summary: "Checks the local session security controls and states whether a secured session may start.",
    cli: "npm run security:check", evidenceBasis: NO_CHANGE,
  }, KEY_CREATE_REASON, "npm run security:check"),
  read({
    id: "toolbox-check", title: "Toolbox self-check",
    summary: "Reports which IaC and cloud CLIs are installed, and that cloud access and mutation stay disabled.",
    cli: "npm run toolbox:check", evidenceBasis: NO_CHANGE,
  }, "toolbox", () => []),
  read({
    id: "plugins", title: "Plug-in compatibility",
    summary: "Validates the plug-in catalog and lists each plug-in's status and tested version.",
    cli: "./alz plugins", npm: ["plugins:check"], evidenceBasis: NO_CHANGE,
  }, "plugins", () => []),
  read({
    id: "prompts", title: "Prompt guide",
    summary: "Shows which requests the agent answers, which it blocks, and where to get help.",
    cli: "./alz prompts", evidenceBasis: "STATIC OPERATOR HELP TEXT",
  }, "prompts", () => []),
  read({
    id: "models-list", title: "Private model catalog",
    summary: "Lists the private models, their roles and which are required for the default stack.",
    cli: "./alz models list", npm: ["models"], evidenceBasis: "STATIC MODEL CATALOG — no model is called",
  }, "models", () => ["list"]),
  { ...entry("LOCAL_MODEL", {
    id: "models-verify", title: "Qualify private models",
    summary: "Runs the qualification checks against the loopback model server and saves the result under .runs.",
    cli: "./alz models verify [--all] [--model MODEL]", npm: ["models:verify"],
    evidenceBasis: "REAL LOCAL MODEL CHECKS — loopback Ollama only; writes .runs/model-qualification",
    inputs: [
      { kind: "flag", name: "all", label: "Every catalog model", help: "Default is the required Qwen and Mistral models." },
      { kind: "text", name: "model", label: "One model", optional: true, pattern: "[A-Za-z0-9][A-Za-z0-9._:/-]*", maxLength: 80, example: "qwen3:8b" },
    ],
  }, { job: { script: "cli/models.js", args: (values) => ["verify", ...(values.all ? ["--all"] : []),
    ...(values.model ? ["--model", String(values.model)] : [])] } }) },
  handoff({
    id: "evidence-migrate", cliScript: "src/cli/evidence-migrate.ts", title: "Migrate legacy evidence",
    summary: "Encrypts plaintext legacy evidence records and removes the plaintext originals.",
    cli: "npm run evidence:migrate", evidenceBasis: "REWRITES evidence files in place — no cloud, no infrastructure change",
  }, "It encrypts records and deletes the plaintext originals, so it must be a deliberate step at a terminal.",
  "npm run evidence:migrate", KEY),
  handoff({
    id: "operator-verify", title: "Full operator verification",
    summary: "Runs the type-check, the whole test suite, the security checks, four discovery scenarios and an npm audit.",
    cli: "./alz verify", evidenceBasis: "FULL SOURCE QUALIFICATION — long-running, contacts the npm registry",
  }, "It runs for minutes, rebuilds from source and contacts the npm registry.", "./alz verify"),
  handoff({
    id: "sbom", title: "Generate the SBOM",
    summary: "Writes a CycloneDX software bill of materials from the lockfile.",
    cli: "./alz sbom", evidenceBasis: "WRITES .runs/sbom/agent-private-landing-zone.cdx.json — lockfile only",
  }, "It runs npm and writes into the repository's .runs directory.", "./alz sbom"),
  handoff({
    id: "scan", title: "Dependency and misconfiguration scan",
    summary: "Audits dependencies for high-severity issues and runs Trivy when it is installed.",
    cli: "./alz scan", evidenceBasis: "DEPENDENCY AUDIT — contacts the npm registry; Trivy scan only when installed",
  }, "It contacts the npm registry and may run Trivy over the whole repository.", "./alz scan"),
  handoff({
    id: "target-preflight", title: "Private target preflight",
    summary: "Probes the private model host's metadata and writes a preflight report, with no inference.",
    cli: "npx tsx src/cli/target-preflight.ts --target-hardware-id <id> --output <path>",
    evidenceBasis: "MODEL METADATA ONLY — no inference, no cloud; writes the report you name",
    inputs: [
      { kind: "text", name: "hardwareId", label: "Target hardware id", pattern: "[A-Za-z0-9][A-Za-z0-9._-]{0,63}", maxLength: 64, example: "gpu-node-01" },
      path("output", "Report path", ".runs/preflight/target.json"),
    ],
  }, "It must run on the target host, reads that host's git checkout and writes the report file you name.",
  "npx tsx src/cli/target-preflight.ts --target-hardware-id {hardwareId} --output {output}",
  ["RUNNER_NAME", "OLLAMA_BASE_URL", "GITHUB_SHA"]),
];
