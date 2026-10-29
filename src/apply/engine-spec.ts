import type { AdapterDescriptor, ResolvedTarget } from "../teardown/driver/types.js";
import type { ArtifactManifest } from "../teardown/manifest.js";
import type { StoppableProcessOptions, StoppableResult } from "../tools/process.js";
import { BICEP } from "./engines/bicep.js";
import { CDK } from "./engines/cdk.js";
import { GCP_API } from "./engines/gcp-api.js";
import { TERRAFORM } from "./engines/terraform.js";
import type { ProviderSpec } from "./provider.js";
import type { ApplyEvidence, ApplyIdentity, ApplyOutcome, CleanupEvidence, EngineId, PilotContract, PilotTarget, PlanChange, ProviderId, SealedUnit } from "./types.js";
import type { PilotUnit } from "./unit.js";

/**
 * The one place an engine's specifics live (docs/act-pilot-apply.md, "Engines").
 * The generic apply modules (contract, identities, driver, seal, ledger,
 * approvals, evidence, the CLI) hold each requirement and its single
 * enforcement point and never name a command, a file or an error text of an
 * engine; a spec supplies only the engine's facts and steps, and the contract's
 * `engine` id selects it. A contract naming an engine with no spec here is not a
 * contract. Every step throws a code (`stop`); engine output is never carried.
 */

/** What every engine step is given: a private scratch directory the driver deletes, the environment identities are drawn from, and what the run is bound to. */
export type EngineContext = {
  scratchDir: string;
  env: NodeJS.ProcessEnv;
  toolDirs?: readonly string[];
  /** The driver's validated manifest. */
  manifest: ArtifactManifest;
  /** The contract's target for this environment, and its provider. */
  pinned: PilotTarget;
  spec: ProviderSpec;
  /** The contract's opt-in `embedStateWrite` (`PilotContract`), sealing and qualifying only. Absent or false: the seal-time init is the preview adapter's own. */
  embedStateWrite?: boolean;
};
export type EngineRunInput = EngineContext & {
  target: ResolvedTarget; engineVersion: string;
  /** Cleanup only, CDK: the id (ARN) of the stack the run created, from its blueprint; the cleanup refuses any other stack. */
  runStackId?: string;
};
/**
 * What an apply or cleanup run is opened with: the run input and the sealed plan's unit (`SealedPlan.unit`), which the driver passes
 * to every run. GCP API-native sweeps the unit and checks the topic's labels against it (D10, D16), and refuses UNIT_NOT_GIVEN
 * without it; the other engines ignore it.
 */
export type EngineOpenInput = EngineRunInput & { unit?: SealedUnit };
/** A read-only snapshot of the project the manifest describes is what sealing starts from. */
export type EnginePlanInput = EngineRunInput & {
  snapshotPath: string;
  /** The deletion unit this run must stamp (src/apply/unit.ts); the engine verifies it in the plan when it can read tags, else seals `unit: null`. */
  unit: PilotUnit;
};

/**
 * What an engine knows after a run about the resources it left, for the blueprint (src/observe/blueprint.ts): Terraform's
 * state (`terraform state pull`, read as STATE), or CloudFormation's logical-to-physical mapping of the stack
 * (`describe-stack-resources`, read as DISCOVERY). The driver maps either to identifiers and drops the document.
 */
export type StateDocument = { source: "TERRAFORM_STATE_PULL" | "CLOUDFORMATION_STACK_RESOURCES" | "AZURE_DEPLOYMENT_STACK_RESOURCES" | "GCP_API_TOPIC"; document: string };

/** How an apply ended: an outcome, or a plan its state has outgrown (nothing applied). */
export type ApplyEnd = { outcome: ApplyOutcome } | { stale: true };
/** What the engine left behind that a person recovers from, kept by the driver in the encrypted vault. */
export type RecoveryFile = { name: string; base64: string };
export type StopControl = Pick<StoppableProcessOptions, "stopWhen" | "pollMs" | "graceMs">;

/**
 * A step that reads the cloud before any approval is consumed may return a promise (docs/act-pilot-gcp-api-driver.md, D5): an
 * engine that reads over HTTPS awaits its reads there, and the driver awaits every such call where it stands, so the order of
 * the gates is unchanged. The Terraform, CDK and Bicep engines return plain values (`SyncEngineSpec`).
 */
export type MaybePromise<T> = T | Promise<T>;

/** What `plan` returns: the bytes to seal, their redacted change list and the unit they create. */
export type EnginePlan = { artifact: Buffer; changes: PlanChange[]; unit: SealedUnit | null };

/** One apply (or the qualification run, which stops after `prepare`) in a scratch directory. */
export type EngineApplyRun = {
  /** The engine ready to apply the project at `snapshotPath` as the contract's target; reads the state position the outcome is judged against. Applies nothing. */
  prepare(snapshotPath: string): MaybePromise<void>;
  /**
   * The change list of the sealed artifact's own bytes, derived again after `prepare`. A throw (or rejection) of PLAN_STALE (what
   * the artifact names can no longer be applied) or ARTIFACT_TAMPERED (it is not what the engine finds) is that refusal.
   */
  rederive(artifact: Buffer): MaybePromise<PlanChange[]>;
  /**
   * Runs exactly the sealed bytes. Resolves once the engine existed; a throw means it never did, so once the engine may
   * exist (a process spawned, a call made) nothing here throws: whatever goes wrong afterward is a result `settle` judges.
   */
  execute(artifact: Buffer, control: StopControl): Promise<StoppableResult>;
  /** How the run ended, from the result and the state read after it. */
  settle(applied: StoppableResult): MaybePromise<ApplyEnd>;
  /** What the run left to recover from. May be awaited (#355 N3): an engine that reads them over the network does so here. */
  recoveryFiles(): MaybePromise<RecoveryFile[]>;
  /** Removes every plaintext secret the run wrote (the artifact, backend configuration). Idempotent. */
  removeSecrets(): void;
  /**
   * What the engine knows about the resources it left after the run, read with a read-only identity (Terraform: the state
   * as STATE; CDK: the stack's resources as DISCOVERY), for the driver to map addresses to cloud identifiers
   * (src/observe/blueprint.ts) and drop. Undefined when it cannot be read; never thrown, never logged.
   */
  stateDocument?(): MaybePromise<StateDocument | undefined>;
  /**
   * The one property the engine set and read back exactly as sealed, with its sealed value (GCP API-native, D11:
   * `messageStoragePolicy.allowedPersistenceRegions`). Recorded in the evidence of a SUCCEEDED run. Absent: the engine verifies none.
   */
  verifiedProperty?(): { name: string; value: readonly string[] } | undefined;
};

/**
 * One cleanup (docs/act-pilot-plan.md, "Cleanup of pilot-created resources"): the engine destroys exactly the addresses
 * an approved cleanup proposal lists. `prepare` as for an apply; `planDestroy` makes the destroy plan limited to those
 * addresses and returns its redacted change list, which the driver compares with the proposal before any approval is
 * consumed; `execute` runs that plan file and nothing else.
 */
export type EngineCleanupRun = {
  prepare(snapshotPath: string): MaybePromise<void>;
  /** Plans the destroy of exactly `addresses` and returns the change list of that plan. Throws (or rejects with) a code. */
  planDestroy(addresses: readonly string[]): MaybePromise<PlanChange[]>;
  /** Whether this run's own delete removed the resource (GCP API-native, D16): false when it was already absent, undefined when not known. */
  deletedByRun?(): boolean | undefined;
  /** Runs the destroy plan `planDestroy` made. Resolves once the engine existed; a throw means it never did. */
  execute(control: StopControl): Promise<StoppableResult>;
  settle(applied: StoppableResult): MaybePromise<ApplyEnd>;
  recoveryFiles(): MaybePromise<RecoveryFile[]>;
  removeSecrets(): void;
};

/** What the CLI tells a person before each step; the engine's own steps and identities are what they are told about. */
export type EngineNotices = {
  sealHeading: string;
  sealReads: string;
  qualifyHeading: string;
  qualifyReads: string;
  /** Present when the engine runs project code on this machine (Terraform providers and modules): shown, and the person must type the phrase. Absent: the engine runs none. */
  projectCode?: string;
  /** What the person checks in the cloud's logs before attesting the two principals (`attests`), given as their client ids. */
  attestation(provider: ProviderSpec, first: string, second: string): string[];
  applyNote: string;
  /** What the CLI tells a person before a cleanup, when the engine's cleanup is not a Terraform destroy. */
  cleanupNote?: string;
};

export type EngineSpec = {
  id: EngineId;
  /** The program the engine runs, looked up in approved tool directories only (the preflight reports whether it is installed). */
  executables: readonly string[];
  /** The providers the engine is valid with. A contract naming another is not a contract. */
  providers: readonly ProviderId[];
  /**
   * What a contract target holds besides the provider's account fields. Absent: the provider's own backend and a free
   * workspace name (Terraform). `backendOk` judges the `backend` field when the engine has no state backend (CDK: the stack
   * name), and `backendMayRepeat` lets it be the same in every environment because the account already differs.
   * `fields` are extra per-environment fields, each judged by its validator and part of the reviewed contract.
   */
  target?: {
    backendOk(value: string): boolean;
    workspaceOk(value: string): boolean;
    backendMayRepeat: boolean;
    fields: Readonly<Record<string, (value: unknown) => boolean>>;
    /**
     * The `fields` that say where the run's resources are (Bicep: the resource group its stack lives in), so they join the run's
     * target hash (`pilotTargetSha256`) and a cleanup or removal refuses a contract that moved them. Absent: none (CDK's
     * `capabilities` limit what a change set may do, not where it is).
     */
    locationFields?: readonly string[];
  };
  notices: EngineNotices;
  /**
   * Whether a value is one exact resource type in this engine's own naming, for the target's canary allowlist (owner decision
   * E1, `PilotCanary`; docs/act-pilot-apply.md, "Canary allowlist"): a pattern of plain names, so a wildcard or a pattern is never
   * a type. Absent: the engine takes no canary allowlist yet, so a contract naming one is refused and no APPLY is authorized for it.
   */
  canaryTypeOk?(value: string): boolean;
  /**
   * The largest count one canary entry may allow, when the engine creates fewer than the general bound: GCP_API creates exactly one
   * topic per run (D8), so its canary is refused at load unless the count is 1 (#358 review N4). Absent: the general bound.
   */
  canaryCountMax?: number;
  /** Whether the engine has a state backend whose settings the plan can embed, so a contract may set `embedStateWrite`. Absent: it has none (CDK). */
  embedsStateWrite?: boolean;
  /** The manifest mode sealing and applying accept; the manifest's engine must be this spec's. */
  manifestMode: ArtifactManifest["mode"];
  /** What the evidence says the engine did (`authority.mutation`). */
  mutation: ApplyEvidence["authority"]["mutation"];
  /** The principals a run needs, all configured and separate (the mutating ones also name the target, `identities.ts`). Any other identity configured is refused. */
  identities: readonly ApplyIdentity[];
  /** The two identities whose principals qualification attests: the one that prepares (state writer, change set creator), then the one that applies. */
  attests: readonly [ApplyIdentity, ApplyIdentity];
  /** The adapters qualification pins: the preview surface sealing runs, and the apply surface. They never activate each other. */
  previewAdapter(): AdapterDescriptor;
  applyAdapter: AdapterDescriptor;
  /** The cleanup surface (a destroy limited to approved addresses), qualified on its own. Absent: the engine has no cleanup path yet, and a cleanup is refused. */
  cleanupAdapter?: AdapterDescriptor;
  /** SHA-256 of the engine binary a run would execute, or undefined; qualification evidence is for exactly one. */
  binarySha256(toolDirs: readonly string[] | undefined, env: NodeJS.ProcessEnv): string | undefined;
  /** Produces the artifact to seal from the request (bytes the apply runs verbatim) and its redacted change list. */
  plan(input: EnginePlanInput): MaybePromise<EnginePlan>;
  /**
   * The qualification run, when it is not a throwaway seal followed by `openApply().prepare()` (Terraform): the
   * engine's own read-only steps. Throws (or rejects with) a code. CDK: version and describe-stacks as each identity, no change set.
   */
  qualify?(input: EnginePlanInput): MaybePromise<void>;
  openApply(input: EngineOpenInput): EngineApplyRun;
  /** The cleanup run for this engine, present only with `cleanupAdapter`. */
  openCleanup?(input: EngineOpenInput): EngineCleanupRun;
  /** What the evidence says a cleanup did (`CleanupEvidence.authority.mutation`), present only with `cleanupAdapter`. */
  cleanupMutation?: CleanupEvidence["authority"]["mutation"];
  /** What a person is told for each way an apply can end unsuccessfully, and when recovery material could not be kept. */
  outcomeMessages: Readonly<Record<Exclude<ApplyOutcome, "SUCCEEDED">, string>>;
  recoveryLostNote: string;
  /** File names the engine leaves in its working directory; scratch holding any is kept for review. */
  recoveryFileNames: readonly string[];
};

/** An apply run whose reads finish before each step returns (the Terraform, CDK and Bicep engines spawn processes synchronously). */
export type SyncEngineApplyRun = Omit<EngineApplyRun, "prepare" | "rederive" | "recoveryFiles" | "stateDocument"> & {
  prepare(snapshotPath: string): void;
  rederive(artifact: Buffer): PlanChange[];
  recoveryFiles(): RecoveryFile[];
  stateDocument?(): StateDocument | undefined;
};
/** A cleanup run whose reads finish before each step returns. */
export type SyncEngineCleanupRun = Omit<EngineCleanupRun, "prepare" | "planDestroy" | "recoveryFiles"> & {
  prepare(snapshotPath: string): void;
  planDestroy(addresses: readonly string[]): PlanChange[];
  recoveryFiles(): RecoveryFile[];
};
/**
 * An engine whose steps return plain values. It is an `EngineSpec` (the driver awaits each step, and awaiting a value is the
 * value), and its own tests call its steps directly, without awaiting.
 */
export type SyncEngineSpec = Omit<EngineSpec, "plan" | "qualify" | "openApply" | "openCleanup"> & {
  plan(input: EnginePlanInput): EnginePlan;
  qualify?(input: EnginePlanInput): void;
  openApply(input: EngineOpenInput): SyncEngineApplyRun;
  openCleanup?(input: EngineOpenInput): SyncEngineCleanupRun;
};

const SPECS: Readonly<Record<EngineId, EngineSpec>> = { TERRAFORM, CDK, BICEP, GCP_API };

/** The spec for a contract's `engine`, or undefined for anything that is not an implemented engine id. */
export const engineSpec = (id: unknown): EngineSpec | undefined =>
  typeof id === "string" && Object.hasOwn(SPECS, id) ? SPECS[id as EngineId] : undefined;

/** The spec of a loaded contract, whose `engine` validation already guaranteed. */
export const engineOf = (contract: Pick<PilotContract, "engine">): EngineSpec => SPECS[contract.engine];

export const ENGINE_IDS: readonly EngineId[] = Object.keys(SPECS) as EngineId[];
export const RECOVERY_FILE_NAMES: readonly string[] = Object.values(SPECS).flatMap((spec) => spec.recoveryFileNames);

/** The one check that a manifest is of the kind this engine seals and applies. */
export const acceptsManifest = (engine: EngineSpec, manifest: Pick<ArtifactManifest, "engine" | "mode">): boolean =>
  manifest.engine === engine.id && manifest.mode === engine.manifestMode;
