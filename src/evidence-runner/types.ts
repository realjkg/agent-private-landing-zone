/**
 * The owner's local live-evidence runner, `./alz evidence` (docs/evidence-runner.md).
 *
 * The runner orchestrates the existing evidence producers on the owner's own machine. It never produces evidence a
 * producer did not write, never declares a LIVE label (the person types it), never initiates an apply on its own, and never
 * reads, stores or forwards a credential. Every producer runs as a child process (`./alz qualify …`, `./alz apply …`); the
 * runner sequences them, journals each step's exit code and the documents it wrote, and stops at the first refusal.
 */

/** The six DEV ACT release paths (the D4 delivery paths, src/apply/token-delivery.ts `DELIVERY_PATHS`), in release order. */
export const ACT_PATHS = ["aws-terraform", "aws-cdk", "azure-terraform", "azure-bicep", "gcp-terraform", "gcp-api"] as const;
export type ActPathId = (typeof ACT_PATHS)[number];

/** What each ACT path is in the product: its provider and engine as the pilot contract names them. */
export const ACT_PATH_SPEC: Readonly<Record<ActPathId, { provider: "AWS" | "AZURE" | "GCP"; engine: string }>> = {
  "aws-terraform": { provider: "AWS", engine: "TERRAFORM" },
  "aws-cdk": { provider: "AWS", engine: "CDK" },
  "azure-terraform": { provider: "AZURE", engine: "TERRAFORM" },
  "azure-bicep": { provider: "AZURE", engine: "BICEP" },
  "gcp-terraform": { provider: "GCP", engine: "TERRAFORM" },
  "gcp-api": { provider: "GCP", engine: "GCP_API" },
};

/**
 * Paths the runner cannot run, with the reason it prints. None today: GCP API-native has its release gate (act:gcp-gcp_api) and its
 * admission row since INT-2, so it is guided like every other path, behind the same gates (the committed contract's provider, engine
 * and authorize entry, the configuration's act.paths entry, and a person at the terminal).
 */
export const ACT_PATH_NOT_AVAILABLE: Readonly<Partial<Record<ActPathId, string>>> = {};

export type ActStageId = `act:${ActPathId}` | `cleanup:${ActPathId}`;

export type StageId = "preflight" | "aws-readonly" | "azure-readonly" | "gcp-readonly" | ActStageId | "recovery" | "summary";
/** The stages of one run, in order. */
export const STAGES: readonly StageId[] = [
  "preflight", "aws-readonly", "azure-readonly", "gcp-readonly",
  ...ACT_PATHS.map((path): StageId => `act:${path}`),
  ...ACT_PATHS.map((path): StageId => `cleanup:${path}`),
  "recovery", "summary",
];

/** The read-only stages: they run beside no mutation identity. */
export const READONLY_STAGES: readonly StageId[] = ["aws-readonly", "azure-readonly", "gcp-readonly"];

/**
 * The stages `run` selects without `--stage`: the read-only stages and the summary. An ACT, cleanup or recovery stage runs
 * only when named, because it needs the mutation identities the read-only stages refuse to run beside, and a person typing
 * every phrase.
 */
export const DEFAULT_STAGES: readonly StageId[] = ["preflight", "aws-readonly", "azure-readonly", "gcp-readonly", "summary"];

/** The PLAN slice that built each stage (the PLAN on issue #39). */
export function stageSlice(stage: StageId): string {
  if (stage === "preflight") return "S1";
  if (stage === "aws-readonly") return "S2";
  if (stage === "azure-readonly") return "S3";
  if (stage === "gcp-readonly") return "S4";
  if (stage === "summary") return "S6";
  return "S5";
}

export const isActStage = (stage: StageId): stage is `act:${ActPathId}` => stage.startsWith("act:");
export const isCleanupStage = (stage: StageId): stage is `cleanup:${ActPathId}` => stage.startsWith("cleanup:");
export const pathOfStage = (stage: `act:${ActPathId}` | `cleanup:${ActPathId}`): ActPathId => stage.slice(stage.indexOf(":") + 1) as ActPathId;
/** Stages that run `./alz apply` children at the person's terminal. */
export const isGuidedStage = (stage: StageId): boolean => isActStage(stage) || isCleanupStage(stage) || stage === "recovery";

/** A run's label. LIVE only after the person types the attestation at a terminal; never from a flag or a file. */
export type RunLabel = "SYNTHETIC" | "LIVE";

/**
 * PASS: the step did what it is for. BLOCKED: something outside the runner is missing or refused (an owner input, an
 * identity, a refusal by a producer before any action). FAIL: the step ran and failed. SKIPPED: the step does not apply to
 * this run (a provider the configuration does not name).
 */
export type StepOutcome = "PASS" | "BLOCKED" | "FAIL" | "SKIPPED";

/** Exit codes: 0 every selected stage produced its evidence, 2 something was BLOCKED or refused, 1 an error. */
export const EXIT = { OK: 0, ERROR: 1, BLOCKED: 2 } as const;

export type Provider = "aws" | "azure" | "gcp";
export const PROVIDERS: readonly Provider[] = ["aws", "azure", "gcp"];
export const READONLY_STAGE_OF: Readonly<Record<Provider, StageId>> = { aws: "aws-readonly", azure: "azure-readonly", gcp: "gcp-readonly" };
