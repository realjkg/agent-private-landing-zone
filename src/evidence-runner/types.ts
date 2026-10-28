/**
 * The owner's local live-evidence runner, `./alz evidence` (docs/evidence-runner.md).
 *
 * The runner orchestrates the existing evidence producers on the owner's own machine. It never produces evidence a
 * producer did not write, never declares a LIVE label (the person types it), never initiates an apply, and never reads,
 * stores or forwards a credential. Slice S1 is the skeleton: configuration, journal, preflight, status and dry run. Every
 * later stage reports NOT_BUILT with the slice that adds it, so this slice can never claim evidence it did not produce.
 */

/** The stages of one run, in order. */
export const STAGES = ["preflight", "aws-readonly", "azure-readonly", "gcp-readonly", "act", "recovery", "cleanup", "summary"] as const;
export type StageId = (typeof STAGES)[number];

/** The stages `run` selects without `--stage`. Recovery and cleanup run only when named, cleanup never as part of a whole run. */
export const DEFAULT_STAGES: readonly StageId[] = ["preflight", "aws-readonly", "azure-readonly", "gcp-readonly", "act", "summary"];

/** The PLAN slice that builds each stage (the PLAN on issue #39). Preflight is this slice. */
export const STAGE_SLICE: Readonly<Record<StageId, string>> = {
  preflight: "S1",
  "aws-readonly": "S2",
  "azure-readonly": "S3",
  "gcp-readonly": "S4",
  act: "S5",
  recovery: "S5",
  cleanup: "S5",
  summary: "S6",
};

/** The stages this build implements. Anything else reports NOT_BUILT. */
export const BUILT_STAGES: ReadonlySet<StageId> = new Set<StageId>(["preflight"]);

/** A run's label. LIVE only after the person types the attestation at a terminal; never from a flag or a file. */
export type RunLabel = "SYNTHETIC" | "LIVE";

/**
 * PASS: the step did what it is for. BLOCKED: something outside the runner is missing (an owner input, a slice not
 * built yet, a refused identity). FAIL: the step ran and failed. SKIPPED: the step does not apply to this run (a provider
 * the configuration does not name, the ACT stage while ACT is disabled).
 */
export type StepOutcome = "PASS" | "BLOCKED" | "FAIL" | "SKIPPED";

/** Exit codes: 0 every selected stage produced its evidence, 2 something was BLOCKED or refused, 1 an error. */
export const EXIT = { OK: 0, ERROR: 1, BLOCKED: 2 } as const;

export type Provider = "aws" | "azure";
export const PROVIDERS: readonly Provider[] = ["aws", "azure"];
