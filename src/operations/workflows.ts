import { PHASE_E_SCENARIOS } from "../qualification/phase-e.js";
import type { Field, OperationSpec, Values } from "./types.js";

// The four workflows the console has always offered. chooseOperatorJob
// (src/operator-ui/server.ts) is derived from these entries.

const scenario: Field = {
  kind: "enum",
  name: "scenario",
  label: "Scenario",
  options: ["all", ...PHASE_E_SCENARIOS.map((item) => item.id)],
};

const matrixArgs = (flag: string) => (values: Values): string[] => [
  flag,
  ...(values.scenario && values.scenario !== "all" ? ["--scenario", String(values.scenario)] : []),
];

export const WORKFLOW_IDS = ["matrix-offline", "matrix-live", "aws-review", "chaos"] as const;

export const workflowOperations: readonly OperationSpec[] = [
  {
    id: "matrix-offline",
    title: "ALZ eight-adapter scenario matrix (recorded fixtures)",
    summary: "Replays every landing-zone scenario from recorded fixtures, with no model and no cloud.",
    family: "qualification",
    cli: "./alz matrix --offline-fixture",
    safety: "SYNTHETIC",
    inputs: [scenario],
    evidenceBasis: "DETERMINISTIC FIXTURE — NO LOCAL MODEL INFERENCE OR LIVE CLOUD",
    cliScript: "src/cli/private-agent-matrix.ts",
    job: { script: "cli/private-agent-matrix.js", args: matrixArgs("--offline-fixture") },
  },
  {
    id: "matrix-live",
    title: "ALZ eight-adapter scenario matrix (private models)",
    summary: "Has the private Qwen and Mistral models review each scenario's synthetic IaC previews.",
    family: "qualification",
    cli: "./alz matrix --live-models",
    safety: "LOCAL_MODEL",
    inputs: [scenario],
    evidenceBasis: "REAL LOCAL QWEN/MISTRAL REASONING — SYNTHETIC IaC FIXTURE PREVIEWS",
    cliScript: "src/cli/private-agent-matrix.ts",
    job: { script: "cli/private-agent-matrix.js", args: matrixArgs("--live-models") },
  },
  {
    id: "aws-review",
    title: "AWS brownfield Terraform private-agent review",
    summary: "Has the private models review a Terraform proposal against a synthetic AWS inventory.",
    family: "qualification",
    cli: "npx tsx src/cli/qualify-aws-terraform-agent.ts --live-models",
    safety: "LOCAL_MODEL",
    inputs: [],
    evidenceBasis: "REAL LOCAL QWEN/MISTRAL — SYNTHETIC AWS INVENTORY — NO TERRAFORM PLAN",
    cliScript: "src/cli/qualify-aws-terraform-agent.ts",
    job: { script: "cli/qualify-aws-terraform-agent.js", args: () => ["--live-models"] },
  },
  {
    id: "chaos",
    title: "Chaos and Well-Architected pillars",
    summary: "Injects simulated faults and reports whether each one is contained and what recovery proves.",
    family: "qualification",
    cli: "./alz chaos",
    safety: "SYNTHETIC",
    inputs: [],
    evidenceBasis: "SYNTHETIC FAULT INJECTION — no real restore or cloud mutation",
    cliScript: "src/cli/chaos-pillars.ts",
    job: { script: "cli/chaos-pillars.js", args: () => [], reportsRecoveryVerification: true },
  },
];
