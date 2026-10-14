import { buildEngineNames } from "../../build/engine.js";
import { AGENT_BUILDER_TARGET_CONNECTORS } from "../../integration-sim/catalog.js";
import type { Field, OperationSpec, Values } from "../types.js";

// Evidence and build family: the offline design, discovery, build-preview and
// agent flows, which read recorded fixtures only. Anything that needs a
// terminal, live cloud access or local Terraform is a HANDOFF.

const provider: Field = { kind: "enum", name: "provider", label: "Provider", options: ["aws", "azure"] };
const engine: Field = { kind: "enum", name: "engine", label: "IaC engine", options: buildEngineNames };
const mock: Field = {
  kind: "enum", name: "mock", label: "Environment scenario", options: ["brownfield", "greenfield", "unknown"],
  help: "A recorded fixture environment; nothing is read from a cloud account.",
};
const approve: Field = {
  kind: "flag", name: "approve", label: "Simulate an approval",
  help: "Adds a hash-bound approval to the preview. The run stays preview-only.",
};
const verbose: Field = { kind: "flag", name: "verbose", label: "Verbose trace" };
const request: Field = {
  kind: "text", name: "request", label: "Request", optional: true, maxLength: 200, example: "Review this environment and assess the strongest operational risk.",
  pattern: "[A-Za-z0-9 .,;:'()/_-]+", help: "Plain words only. Words such as apply or destroy are refused.",
};

const value = (values: Values, name: string): string[] => ["--" + name, String(values[name])];
const flags = (values: Values, ...names: string[]): string[] => names.filter((name) => values[name]).map((name) => "--" + name);
const requestArgs = (values: Values): string[] => (values.request ? value(values, "request") : []);

const FIXTURE = "DETERMINISTIC FIXTURE — NO LOCAL MODEL INFERENCE OR LIVE CLOUD";
const RECORD = " — WRITES AN ENCRYPTED RECORD UNDER .runs";
const MODELS = "REAL LOCAL QWEN/MISTRAL REASONING — FIXTURE ENVIRONMENT, NO LIVE CLOUD";
const TERMINAL = "Runs in a terminal on a clean checkout, so the console only shows the command.";

const demo: OperationSpec = {
  id: "demo", title: "Governed design demo", family: "evidence", cli: "./alz demo", safety: "SYNTHETIC",
  summary: "Walks a fixture environment through the governed design flow with a deterministic reasoner.",
  inputs: [provider, engine, mock], evidenceBasis: FIXTURE, npm: ["demo"],
  job: { script: "cli/demo.js", args: (v) => [...value(v, "provider"), ...value(v, "engine"), "--scenario", String(v.mock)] },
};

const agentArgs = (v: Values) => [...value(v, "provider"), ...value(v, "engine"), ...value(v, "mock"), ...requestArgs(v), ...flags(v, "approve", "verbose")];

export const evidenceOperations: readonly OperationSpec[] = [
  demo,
  {
    id: "demo-gcp-offline", title: "GCP offline landing-zone walkthrough",
    family: "evidence", cli: "./alz demo gcp terraform", safety: "SYNTHETIC",
    summary: "Replays an isolated GCP inventory fixture across read-only discovery, design review and the disabled mutation gate.",
    inputs: [mock],
    evidenceBasis: "GCP CLOUD ASSET INVENTORY SYNTHETIC FIXTURE — NO AUTH, LIVE CLOUD, MODEL, TERRAFORM PLAN OR ACT",
    job: { script: "cli/gcp-offline-demo.js", args: (v) => [String(v.mock)] },
  },
  { ...demo, id: "design", title: "Design specification", cli: "./alz design", npm: undefined,
    summary: "Produces the same fixture DesignSpec flow as the demo; the command keeps both names." },
  {
    id: "inspect", title: "Inspect a live environment", family: "evidence", cli: "./alz inspect", safety: "HANDOFF",
    summary: "Discovers resources in your own cloud account with read-only access.",
    inputs: [provider], evidenceBasis: "LIVE READ-ONLY CLOUD DISCOVERY — YOUR OWN CREDENTIALS" + RECORD,
    cliScript: "src/cli/discover.ts", npm: ["discover:aws:live", "discover:azure:live"],
    handoff: {
      reason: "Needs your cloud credentials, which the console never holds. Sign in with the provider CLI first.",
      command: "./alz inspect {provider}", env: ["AWS_PROFILE", "AWS_REGION", "AZURE_SUBSCRIPTION_ID"],
    },
  },
  {
    id: "discover", title: "Discover a fixture environment", family: "evidence", cli: "npm run discover:aws", safety: "WRITES_LOCAL",
    summary: "Classifies a recorded environment and assesses its security, inventory and recovery posture.",
    inputs: [provider, mock, { kind: "flag", name: "resources", label: "List resources" }, verbose],
    evidenceBasis: "SYNTHETIC FIXTURE DISCOVERY — NO CLOUD ACCESS" + RECORD,
    npm: ["discover", "discover:azure", "discover:unknown", "discover:verbose"],
    job: { script: "cli/discover.js", args: (v) => [...value(v, "provider"), ...value(v, "mock"), ...flags(v, "resources", "verbose")] },
  },
  {
    id: "session", title: "Conversational session (live read-only)", family: "evidence", cli: "./alz session", safety: "HANDOFF",
    summary: "Chats with the private models about your own environment, with live read-only discovery.",
    inputs: [provider, engine], evidenceBasis: "REAL LOCAL QWEN/MISTRAL — LIVE READ-ONLY CLOUD DISCOVERY — ENCRYPTED EVIDENCE",
    cliScript: "src/cli/session.ts", npm: ["session", "session:azure"],
    handoff: {
      reason: "An interactive prompt needs a terminal, and live discovery needs your own cloud credentials.",
      command: "./alz session {provider} {engine}", env: ["AWS_PROFILE", "AWS_REGION", "AZURE_SUBSCRIPTION_ID"],
    },
  },
  {
    id: "session-fixture", title: "Conversational session (fixture)", family: "evidence", cli: "npm run session:fixture", safety: "HANDOFF",
    summary: "Chats with a deterministic reasoner about a recorded environment.",
    inputs: [provider, engine, mock], evidenceBasis: "DETERMINISTIC FIXTURE — NO LOCAL MODEL INFERENCE OR LIVE CLOUD — ENCRYPTED EVIDENCE",
    cliScript: "src/cli/session.ts", npm: ["session:pulumi"],
    handoff: {
      reason: "An interactive prompt needs a terminal; the console never feeds it input.",
      command: "npx tsx src/cli/session.ts --provider {provider} --engine {engine} --mock {mock} --fixture",
    },
  },
  {
    id: "debug", title: "Debug trace (fixture)", family: "evidence", cli: "./alz debug --fixture", safety: "SYNTHETIC",
    summary: "Traces policy, grounding and checkpoints for one fixture request, with no model call.",
    inputs: [provider, engine, mock, request], evidenceBasis: FIXTURE + " — WRITES A REDACTED TRACE UNDER .runs",
    job: { script: "cli/debug.js", args: (v) => [...value(v, "provider"), ...value(v, "engine"), ...value(v, "mock"), "--fixture", ...requestArgs(v)] },
  },
  {
    id: "debug-live", title: "Debug trace (private models)", family: "evidence", cli: "./alz debug", safety: "LOCAL_MODEL",
    summary: "Traces policy, grounding and model calls for one fixture request using the private models.",
    inputs: [provider, engine, mock, request], evidenceBasis: MODELS + " — WRITES A REDACTED TRACE UNDER .runs",
    job: { script: "cli/debug.js", args: (v) => [...value(v, "provider"), ...value(v, "engine"), ...value(v, "mock"), ...requestArgs(v)] },
  },
  {
    id: "build-loop", title: "Build loop preview", family: "evidence", cli: "npm run build:loop", safety: "WRITES_LOCAL",
    summary: "Generates an infrastructure-as-code candidate for a fixture environment and stops at a preview.",
    inputs: [provider, engine, mock, approve], evidenceBasis: "SYNTHETIC FIXTURE — PREVIEW ONLY, NO CLOUD CHANGES" + RECORD,
    npm: ["build:aws:terraform", "build:azure:pulumi", "build:unknown", "build:approved"],
    job: { script: "cli/build-loop.js", args: (v) => [...value(v, "provider"), ...value(v, "engine"), ...value(v, "mock"), ...flags(v, "approve")] },
  },
  {
    id: "agent", title: "Agent kernel (fixture reasoner)", family: "evidence", cli: "npm run agent:assess", safety: "WRITES_LOCAL",
    summary: "Runs the full agent kernel on a fixture environment with a deterministic reasoner; ACT is disabled.",
    inputs: [provider, engine, mock, request, approve, verbose], evidenceBasis: FIXTURE + RECORD,
    npm: ["agent:build", "agent:change", "agent:unknown", "agent:verbose"],
    job: { script: "cli/agent.js", args: (v) => [...agentArgs(v), "--fixture"] },
  },
  {
    id: "agent-live", title: "Agent kernel (private models)", family: "evidence", cli: "npm run agent", safety: "LOCAL_MODEL",
    summary: "Runs the full agent kernel on a fixture environment using the private models; ACT is disabled.",
    inputs: [provider, engine, mock, request, approve, verbose], evidenceBasis: MODELS + RECORD,
    job: { script: "cli/agent.js", args: agentArgs },
  },
  {
    id: "agent-builder-sim", title: "Agent-builder connector matrix", family: "evidence", cli: "npm run matrix:agent-builder", safety: "SYNTHETIC",
    summary: "Replays the simulated connector lanes on loopback, checking record hashes and that nothing is mutated.",
    inputs: [
      { kind: "enum", name: "connector", label: "Connector", options: ["all", ...AGENT_BUILDER_TARGET_CONNECTORS.map((item) => item.id)] },
      { kind: "enum", name: "mode", label: "Traceability mode", options: ["all", "DISCONNECTED", "CONNECTED", "RECONCILED"] },
    ],
    evidenceBasis: "SIMULATED TEST DOUBLES — LOOPBACK ONLY, NO EGRESS, NO INFRASTRUCTURE MUTATION",
    job: { script: "cli/agent-builder-sim.js", args: (v) => ["connector", "mode"].flatMap((name) => v[name] === "all" ? [] : value(v, name)) },
  },
  {
    id: "real-private-build", title: "Real private build review", family: "evidence", cli: "npx tsx src/cli/real-private-build.ts --live-aws-read-only",
    safety: "HANDOFF", summary: "Has the private models write one Terraform resource and checks it with a real Terraform plan; nothing is applied.",
    inputs: [], evidenceBasis: "REAL LOCAL QWEN/MISTRAL — REAL TERRAFORM FMT, VALIDATE AND PLAN — NO APPLY" + RECORD,
    cliScript: "src/cli/real-private-build.ts",
    handoff: {
      reason: "Needs Terraform, the local models and your AWS read access, then writes plan evidence. Also set TF_VAR_aws_region (the catalog lists only upper-case names). " + TERMINAL,
      command: "npx tsx src/cli/real-private-build.ts --live-aws-read-only",
      env: ["ALZ_ALLOW_REAL_PRIVATE_BUILD", "ALZ_ALLOW_TERRAFORM_PLAN", "AWS_PROFILE"],
    },
  },
  ...[
    { id: "qualify-terraform-validate", flag: "--terraform-validate", env: [] as string[],
      title: "Terraform validation of the reviewed candidate",
      summary: "Runs real terraform init, fmt and validate on the candidate the private models reviewed." },
    { id: "qualify-terraform-plan", flag: "--terraform-validate --terraform-plan", env: ["ALZ_ALLOW_TERRAFORM_PLAN", "AWS_PROFILE"],
      title: "Terraform plan of the reviewed candidate",
      summary: "Runs a real Terraform plan on the reviewed candidate and requires exactly one addition." },
  ].map(({ id, flag, env, title, summary }): OperationSpec => ({
    id, title, summary, family: "evidence", safety: "HANDOFF", inputs: [],
    cli: "npx tsx src/cli/qualify-aws-terraform-agent.ts --live-models " + flag,
    evidenceBasis: "REAL LOCAL QWEN/MISTRAL — SYNTHETIC AWS INVENTORY — REAL TERRAFORM CLI, NO APPLY" + RECORD,
    cliScript: "src/cli/qualify-aws-terraform-agent.ts",
    handoff: {
      reason: "Needs Terraform and provider downloads, and refuses a dirty worktree" + (env.length ? "; also set TF_VAR_aws_region. " : ". ") + TERMINAL,
      command: "npx tsx src/cli/qualify-aws-terraform-agent.ts --live-models " + flag, ...(env.length ? { env } : {}),
    },
  })),
];
