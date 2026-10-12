import type { AdapterDescriptor, ResolvedTarget } from "../teardown/driver/types.js";
import type { ArtifactManifest } from "../teardown/manifest.js";
import type { StoppableProcessOptions, StoppableResult } from "../tools/process.js";
import { stop } from "./engine.js";
import { CDK } from "./engines/cdk.js";
import { TERRAFORM } from "./engines/terraform.js";
import type { ProviderSpec } from "./provider.js";
import type { ApplyEvidence, ApplyIdentity, ApplyOutcome, EngineId, PilotContract, PilotTarget, PlanChange, ProviderId } from "./types.js";

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
};
export type EngineRunInput = EngineContext & { target: ResolvedTarget; engineVersion: string };
/** A read-only snapshot of the project the manifest describes is what sealing starts from. */
export type EnginePlanInput = EngineRunInput & { snapshotPath: string };

/** How an apply ended: an outcome, or a plan its state has outgrown (nothing applied). */
export type ApplyEnd = { outcome: ApplyOutcome } | { stale: true };
/** What the engine left behind that a person recovers from, kept by the driver in the encrypted vault. */
export type RecoveryFile = { name: string; base64: string };
export type StopControl = Pick<StoppableProcessOptions, "stopWhen" | "pollMs" | "graceMs">;

/** One apply (or the qualification run, which stops after `prepare`) in a scratch directory. */
export type EngineApplyRun = {
  /** The engine ready to apply the project at `snapshotPath` as the contract's target; reads the state position the outcome is judged against. Applies nothing. */
  prepare(snapshotPath: string): void;
  /**
   * The change list of the sealed artifact's own bytes, derived again after `prepare`. A throw of PLAN_STALE (what the
   * artifact names can no longer be applied) or ARTIFACT_TAMPERED (it is not what the engine finds) is that refusal.
   */
  rederive(artifact: Buffer): PlanChange[];
  /** Runs exactly the sealed bytes. Resolves once the engine existed; a throw means it never did. */
  execute(artifact: Buffer, control: StopControl): Promise<StoppableResult>;
  /** How the run ended, from the result and the state read after it. */
  settle(applied: StoppableResult): ApplyEnd | Promise<ApplyEnd>;
  recoveryFiles(): RecoveryFile[];
  /** Removes every plaintext secret the run wrote (the artifact, backend configuration). Idempotent. */
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
};

export type EngineSpec = {
  id: EngineId;
  /** The providers the engine is valid with. A contract naming another is not a contract. */
  providers: readonly ProviderId[];
  /**
   * What a contract target holds besides the provider's account fields. Absent: the provider's own backend and a free
   * workspace name (Terraform). `backendOk` judges the `backend` field when the engine has no state backend (CDK: the stack
   * name), and `backendMayRepeat` lets it be the same in every environment because the account already differs.
   * `fields` are extra per-environment fields, each judged by its validator and part of the pinned contract.
   */
  target?: {
    backendOk(value: string): boolean;
    workspaceOk(value: string): boolean;
    backendMayRepeat: boolean;
    fields: Readonly<Record<string, (value: unknown) => boolean>>;
  };
  notices: EngineNotices;
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
  /** SHA-256 of the engine binary a run would execute, or undefined; qualification evidence is for exactly one. */
  binarySha256(toolDirs: readonly string[] | undefined, env: NodeJS.ProcessEnv): string | undefined;
  /** Produces the artifact to seal from the request (bytes the apply runs verbatim) and its redacted change list. */
  plan(input: EnginePlanInput): { artifact: Buffer; changes: PlanChange[] };
  /**
   * The qualification run, when it is not a throwaway seal followed by `openApply().prepare()` (Terraform): the
   * engine's own read-only steps. Throws a code. CDK: version and describe-stacks as each identity, no change set.
   */
  qualify?(input: EnginePlanInput): void;
  /** The change list of artifact bytes, the one extraction sealing and applying share. */
  rederiveChanges(input: EngineContext & { artifact: Buffer }): PlanChange[];
  openApply(input: EngineRunInput): EngineApplyRun;
  /** What a person is told for each way an apply can end unsuccessfully, and when recovery material could not be kept. */
  outcomeMessages: Readonly<Record<Exclude<ApplyOutcome, "SUCCEEDED">, string>>;
  recoveryLostNote: string;
  /** File names the engine leaves in its working directory; scratch holding any is kept for review. */
  recoveryFileNames: readonly string[];
};

const SPECS: Readonly<Record<EngineId, EngineSpec>> = { TERRAFORM, CDK };

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

/** The spec a manifest names, or a stop code when there is none or the manifest is not the kind it accepts. */
export const engineFor = (manifest: Pick<ArtifactManifest, "engine" | "mode">): EngineSpec => {
  const engine = engineSpec(manifest.engine);
  return engine && acceptsManifest(engine, manifest) ? engine : stop("ENGINE_PROJECT_REQUIRED");
};
