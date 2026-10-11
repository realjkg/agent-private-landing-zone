import { MAX_JSON_BYTES } from "../schema.js";
import type { Field, Job, OperationSpec, SafetyClass } from "../types.js";

// Qualification and release. The deterministic offline gates run here. Each
// writes its evidence under .runs and needs a clean git checkout, so a dirty
// working tree ends the run with a clear message. Anything that needs live
// models, cloud identity or an interactive terminal is a handoff, and the
// heavyweight gates are kept for the release phase (AGENTS.md).

type Entry = Pick<OperationSpec, "id" | "title" | "summary" | "evidenceBasis" | "cliScript"> &
  Partial<Pick<OperationSpec, "inputs">> & {
    sub: string;
    /** Shown in the cli form as the operator's own arguments. */
    args?: string;
    /** Passed by the dispatcher before the operator's arguments, exactly as the console job passes them. */
    fixed?: readonly string[];
  };

const base = ({ sub, args, fixed, ...entry }: Entry) => ({
  family: "qualification" as const, inputs: [], ...entry,
  cli: "./alz qualify " + sub + (args ? " " + args : ""),
  command: { group: "qualify", sub, ...(fixed ? { args: fixed } : {}) },
});

const run = (safety: SafetyClass, entry: Entry, args: Job["args"]): OperationSpec => ({
  ...base(entry), safety,
  job: { script: "cli/" + entry.cliScript!.slice("src/cli/".length).replace(/\.ts$/, ".js"), args },
});

const handoff = (entry: Entry, reason: string, command: string, env?: readonly string[], viewer?: string): OperationSpec => ({
  ...base(entry), safety: "HANDOFF",
  handoff: { reason, command, ...(env ? { env } : {}), ...(viewer ? { viewer } : {}) },
});

const none = (): string[] => [];
const text = (name: string, label: string, pattern: string, example: string, help?: string): Field =>
  ({ kind: "text", name, label, pattern, maxLength: 64, example, ...(help ? { help } : {}) });
const commit = text("sourceCommit", "Source commit", "[0-9a-f]{7,40}", "6fed61a", "The commit the evidence is bound to.");

const OFFLINE = "DETERMINISTIC FIXTURES — NO MODEL, NO CLOUD, ACT DISABLED — WRITES EVIDENCE UNDER .runs";
const RELEASE_GATE = "Heavyweight qualification runs only at the release gate (AGENTS.md), and ";
const CLOUD = " expects workload identity (no long-lived keys) in your own terminal, which the console never handles.";
const CLEAN = " Needs a clean git checkout.";

export const qualificationOperations: readonly OperationSpec[] = [
  run("WRITES_LOCAL", {
    id: "full-offline-matrix", sub: "offline-matrix", cliScript: "src/cli/full-offline-matrix.ts",
    title: "Full offline provider and engine matrix",
    summary: "Replays every AWS and Azure provider and engine pairing from fixtures, marking unsupported pairs and future plans." + CLEAN,
    evidenceBasis: OFFLINE,
  }, none),
  run("WRITES_LOCAL", {
    id: "prelive-campaign", sub: "prelive", cliScript: "src/cli/prelive-campaign.ts",
    title: "Pre-live campaign",
    summary: "Runs the eight supported workflows, unknown-ownership, provider-compatibility, chaos and pillar checks from fixtures." + CLEAN,
    evidenceBasis: OFFLINE,
  }, none),
  run("WRITES_LOCAL", {
    id: "pulumi-permutations", sub: "pulumi", cliScript: "src/cli/pulumi-permutations.ts",
    title: "Pulumi permutation matrix",
    summary: "Crosses Pulumi providers with greenfield, brownfield and unknown estates, without running Pulumi or any cloud." + CLEAN,
    evidenceBasis: OFFLINE,
  }, none),
  run("WRITES_LOCAL", {
    id: "private-security-redteam", sub: "redteam", cliScript: "src/cli/private-security-redteam.ts",
    title: "Synthetic red-team regression",
    summary: "Replays prompt-injection and privilege-escalation attacks against the deterministic policy boundary, with no real model." + CLEAN,
    evidenceBasis: "SYNTHETIC ATTACK CASES — NO MODEL, NO NETWORK, NO CLOUD — WRITES EVIDENCE UNDER .runs",
  }, none),
  run("SYNTHETIC", {
    id: "opa-qualification", sub: "opa", cliScript: "src/cli/opa-qualification.ts",
    title: "OPA policy parity",
    summary: "Checks that the pinned OPA binary and the Rego policy decide every synthetic case exactly as the built-in policy does.",
    evidenceBasis: "SYNTHETIC POLICY CASES EVALUATED LOCALLY BY THE PINNED OPA BINARY — WRITES NOTHING, ACT DISABLED",
  }, none),
  run("WRITES_LOCAL", {
    id: "release-admission", sub: "admission", args: "--manifest <evidence-index-file>", cliScript: "src/cli/release-admission.ts",
    title: "Production evidence admission",
    summary: "Reviews a pasted evidence index and reports which release gates still lack evidence; it deploys nothing." + CLEAN,
    inputs: [{ kind: "json", name: "manifest", label: "Evidence index JSON", maxBytes: MAX_JSON_BYTES,
      help: "The contents of an evidence index such as .runs/release/evidence-index.json." }],
    evidenceBasis: "LOCAL REVIEW OF PASTED EVIDENCE — NOT AN APPROVAL, ACT DISABLED — WRITES A REPORT UNDER .runs/release",
  }, (values) => ["--manifest", String(values.manifest)]),
  run("READ_ONLY", {
    id: "release-verify", sub: "verify-package", fixed: ["--verify"], cliScript: "src/cli/release-package.ts",
    title: "Verify the release package",
    summary: "Checks this installation's files and SBOM against its release-manifest.json; a source checkout has none.",
    evidenceBasis: "LOCAL READ-ONLY CHECK — no model, no cloud, no infrastructure change",
  }, () => ["--verify"]),
  handoff({
    id: "release-package", sub: "package", cliScript: "src/cli/release-package.ts",
    args: "--root <release-root> --version <version> --source-commit <sha>",
    title: "Generate the release manifest",
    summary: "Hashes a staged release tree and writes release-manifest.json into it.",
    evidenceBasis: "WRITES release-manifest.json into the release root — no cloud, ACT stays disabled",
    inputs: [text("version", "Release version", "[0-9]+\\.[0-9]+\\.[0-9]+(-[0-9A-Za-z.]+)?", "1.0.0"), commit],
  }, "It writes into a staged release tree you choose, and the console never takes a path or writes outside a private directory.",
  "./alz qualify package --root <staged-release-root> --version {version} --source-commit {sourceCommit}",
  undefined, "release-verify"),
  handoff({
    id: "provider-qualification-aws", sub: "provider-aws", cliScript: "src/cli/provider-qualification.ts",
    args: "--provider AWS --source-commit <sha> --aws-stack <name> --aws-template <file>",
    title: "AWS provider qualification",
    summary: "Validates and previews the no-op CloudFormation stack against a real AWS account with read-only access.",
    evidenceBasis: "LIVE CLOUD IDENTITY — READ-ONLY PROVIDER PREVIEW, NO APPLY — WRITES EVIDENCE UNDER .runs/qualification",
    inputs: [commit, text("stack", "Qualification stack name", "[A-Za-z][A-Za-z0-9-]{0,127}", "alz-qualification-noop")],
  }, RELEASE_GATE + "it" + CLOUD,
  "./alz qualify provider-aws --provider AWS --source-commit {sourceCommit} --aws-stack {stack} --aws-template qualification/provider/aws-noop-stack.yaml --output .runs/qualification/provider-aws.json",
  ["AWS_WEB_IDENTITY_TOKEN_FILE", "AWS_ROLE_ARN", "AWS_REGION"]),
  handoff({
    id: "provider-qualification-azure", sub: "provider-azure", cliScript: "src/cli/provider-qualification.ts",
    args: "--provider AZURE --source-commit <sha> --azure-bicep <file> --azure-location <region>",
    title: "Azure provider qualification",
    summary: "Validates and previews the no-op Bicep template against a real Azure subscription with read-only access.",
    evidenceBasis: "LIVE CLOUD IDENTITY — READ-ONLY PROVIDER PREVIEW, NO APPLY — WRITES EVIDENCE UNDER .runs/qualification",
    inputs: [commit, text("location", "Azure location", "[a-z][a-z0-9]{2,31}", "westeurope")],
  }, RELEASE_GATE + "it" + CLOUD + " Sign in with az login first.",
  "./alz qualify provider-azure --provider AZURE --source-commit {sourceCommit} --azure-bicep qualification/provider/azure-noop.bicep --azure-scope subscription --azure-location {location} --output .runs/qualification/provider-azure.json",
  ["AZURE_FEDERATED_TOKEN_FILE"]),
  handoff({
    id: "private-model-adversarial", sub: "adversarial", cliScript: "src/cli/private-model-adversarial.ts",
    args: "--scope first|all",
    title: "Private-model adversarial qualification",
    summary: "Attacks the private Qwen and Mistral models with adversarial prompts and compares each answer with the deterministic policy.",
    evidenceBasis: "REAL LOCAL QWEN/MISTRAL INFERENCE — NO CLOUD, NO TOOL EXECUTION — WRITES EVIDENCE UNDER .runs/qualification",
    inputs: [{ kind: "enum", name: "scope", label: "Scope", options: ["first", "all"], help: "first is a smoke subset; all is the release gate." }],
  }, RELEASE_GATE + "it must run on the target hardware with the named variables set and a clean checkout; the console cannot supply them, and a fixture model is refused.",
  "./alz qualify adversarial --scope {scope}",
  ["ALZ_TARGET_HARDWARE_ID", "RUNNER_NAME", "OLLAMA_BASE_URL"]),
];
