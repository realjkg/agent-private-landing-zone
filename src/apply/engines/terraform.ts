import { existsSync, lstatSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { mapTerraformActions } from "../../iac/terraform-plan.js";
import {
  INIT_ARGV, LARGE_OUTPUT_BYTES, PREVIEW_PLAN_ARGV, SHOW_ARGV, STATE_PULL_ARGV, VERSION_ARGV, WORKSPACE_SHOW_ARGV, assertModulesAreLocal,
  createTerraformAdapter, isAllowedArgv, workspaceSelectArgv,
} from "../../teardown/driver/adapters/terraform.js";
import { removeTree } from "../../teardown/driver/cleanup.js";
import { copyTree, projectDifference } from "../../teardown/driver/adapters/project-copy.js";
import type { ResolvedTarget } from "../../teardown/driver/types.js";
import { approvedToolDirs, resolveExecutable } from "../../tools/child-env.js";
import { ANY_IDENTITY_VARIABLE, MUTATION_IDENTITY_VARIABLE } from "../../tools/identity.js";
import { refusedVariables, runBoundedProcess, runStoppableProcess, type StoppableProcessOptions, type StoppableResult } from "../../tools/process.js";
import { TERRAFORM_APPLY_PROFILE, type ProcessProfile } from "../../tools/profiles.js";
import type { ToolResult } from "../../tools/types.js";
import { sha256 } from "../../util/sha256.js";
import { assertBackendBlock, type BackendBlockRule } from "../backend-block.js";
import { stripInvisible } from "../constants.js";
import { codeOf, stop } from "../engine.js";
import type { EngineApplyRun, EngineContext, EngineSpec } from "../engine-spec.js";
import type { ProviderBlock, ProviderSpec } from "../provider.js";
import { isRecord } from "../providers/shared.js";
import {
  APPLY_ADAPTER, APPLY_ARGV, APPLY_BACKEND_CONFIG_FILE, APPLY_INIT_ARGV, RECOVERY_FILES, classifyApply, isAllowedApplyArgv, parseStateSerial,
} from "../terraform.js";
import type { PilotTarget, PlanChange } from "../types.js";

/**
 * The Terraform engine spec: init, workspace, `plan -out`, `show -json` for the
 * change list, `apply <planfile>` and nothing else (docs/act-pilot-plan.md,
 * authority items 2 and 5). The argument lists, the qualification digest and the
 * outcome classification are in `../terraform.ts`; this file is how a run uses
 * them. Codes only: engine output can quote plan or state values.
 */

type StepIdentity = "DISCOVERY" | "STATE" | "STATE_WRITE" | "APPLY" | null;

/** A step that needs no credentials is given none. */
const withoutIdentities = (env: NodeJS.ProcessEnv): NodeJS.ProcessEnv =>
  Object.fromEntries(Object.entries(env).filter(([key]) => !ANY_IDENTITY_VARIABLE.test(key)));

/** Sealing reads with DISCOVERY and STATE only. The writer and the applier are not even in the runner's environment. */
const sealEnvironment = (env: NodeJS.ProcessEnv): NodeJS.ProcessEnv =>
  Object.fromEntries(Object.entries(env).filter(([key]) => !MUTATION_IDENTITY_VARIABLE.test(key)));

type Session = {
  work: string;
  /** Runs one allowlisted step and returns its stdout. Any refusal, truncation or non-zero exit stops with a code. */
  step(args: readonly string[], identity: StepIdentity, large?: boolean): string;
  /** A step that can be stopped while it runs. Returns the raw result; the caller classifies it. */
  stoppable(args: readonly string[], identity: StepIdentity, profile: ProcessProfile, control: Pick<StoppableProcessOptions, "stopWhen" | "pollMs" | "graceMs" | "forwardSignals" | "onStop">): Promise<StoppableResult>;
  /** Identity variables the runner would refuse to hand this step, so a step that cannot be undone is never started with a partial identity. */
  refused(identity: StepIdentity, profile: ProcessProfile): string[];
  /** The files, the lock file and the module sources, all against the manifest. */
  assertBound(): void;
};

type SessionInput = Pick<EngineContext, "scratchDir" | "env" | "toolDirs" | "manifest"> & {
  isAllowed: (args: readonly string[]) => boolean;
  profile: ProcessProfile;
};

/** The one way the pilot reaches Terraform: an allowlisted argument list, one identity (or none), the runner's own limits, and the project checked against the manifest after every process. */
function openSession(input: SessionInput): Session {
  const work = join(input.scratchDir, "work");
  const options = (identity: StepIdentity, profile: ProcessProfile) => ({
    profile, env: identity === null ? withoutIdentities(input.env) : input.env, toolDirs: input.toolDirs,
    identity: identity ?? "DISCOVERY", root: input.scratchDir, suppressDetail: true,
  });
  const guard = (args: readonly string[]): void => { if (!input.isAllowed(args)) stop("ARGV_NOT_ALLOWED"); };
  const check = (result: ToolResult): string => {
    // A credential the runner refused (a newline, an unapproved host) would otherwise mean a run with no identity.
    if (result.refusedEnvironment?.length) return stop("ENVIRONMENT_REFUSED");
    if (result.truncated) return stop("OUTPUT_TRUNCATED");
    if (!result.ok) return stop(result.exitCode === null ? "NOT_RUN" : "EXIT_" + result.exitCode);
    return result.stdout;
  };
  return {
    work,
    step(args, identity, large = false) {
      guard(args);
      const profile = large ? { ...input.profile, maxOutputBytes: LARGE_OUTPUT_BYTES } : input.profile;
      return check(runBoundedProcess("terraform_plan", "terraform", [...args], work, options(identity, profile)));
    },
    stoppable(args, identity, profile, control) {
      guard(args);
      return runStoppableProcess("terraform_plan", "terraform", [...args], work, { ...options(identity, profile), ...control });
    },
    refused(identity, profile) {
      return refusedVariables(options(identity, profile));
    },
    assertBound() {
      const difference = projectDifference(work, input.manifest);
      if (difference) stop(difference);
      assertModulesAreLocal(work);
    },
  };
}

type WorkspaceInput = {
  snapshotPath: string;
  engineVersion: string;
  target: ResolvedTarget;
  initArgv: readonly string[];
  /** The identity that owns the backend: STATE to read for a preview, STATE_WRITE to write for an apply. */
  stateIdentity: "STATE" | "STATE_WRITE";
  /** The provider's rule for the project's own backend block, judged before init reads it (`ProviderSpec.backendBlock`). */
  backendBlock?: BackendBlockRule;
  /** Runs between the version check and init (the apply writes its backend configuration here). */
  beforeInit?: () => void;
  afterInit?: () => void;
};

/**
 * The one init and workspace sequence: a writable copy of the snapshot that
 * must equal the manifest, the pinned engine version, backend initialization,
 * and the target's workspace. Locking stays on: there is no -lock flag in any
 * argument list. Nothing here changes state.
 */
function prepareWorkspace(session: Session, input: WorkspaceInput): void {
  const copyProblem = copyTree(input.snapshotPath, session.work);
  if (copyProblem) stop(copyProblem);
  // init builds .terraform itself; one that arrived with the snapshot could hold modules or providers nobody reviewed.
  if (existsSync(join(session.work, ".terraform"))) stop("PRE_EXISTING_TERRAFORM_DIRECTORY");
  session.assertBound();

  let reported: unknown;
  try { reported = (JSON.parse(session.step(VERSION_ARGV, null)) as { terraform_version?: unknown }).terraform_version; } catch (error) {
    if (codeOf(error) !== "UNEXPECTED") throw error;
    return stop("VERSION_UNREADABLE");
  }
  if (reported !== input.engineVersion) stop("ENGINE_VERSION_MISMATCH");

  if (input.backendBlock) assertBackendBlock(session.work, input.backendBlock);
  input.beforeInit?.();
  try { session.step(input.initArgv, input.stateIdentity); } finally { input.afterInit?.(); }
  session.assertBound();
  if (input.target.workspace !== "default") session.step(workspaceSelectArgv(input.target.workspace), input.stateIdentity);
  if (session.step(WORKSPACE_SHOW_ARGV, input.stateIdentity).trim() !== input.target.workspace) stop("WORKSPACE_MISMATCH");
}

/** The backend binding: the backend init saved must be the contract's, so the project's own backend block cannot aim state somewhere else. */
function assertBackendInContract(work: string, pinned: PilotTarget, spec: ProviderSpec): void {
  let saved: unknown;
  try {
    const file = join(work, ".terraform", "terraform.tfstate");
    if (!lstatSync(file).isFile() || lstatSync(file).size > 1_048_576) return stop("BACKEND_UNREADABLE");
    saved = JSON.parse(readFileSync(file, "utf8"));
  } catch { return stop("BACKEND_UNREADABLE"); }
  const backend = (saved as { backend?: unknown } | null)?.backend;
  if (!spec.savedBackendMatches(isRecord(backend) ? backend : {}, pinned)) stop("BACKEND_NOT_IN_CONTRACT");
}

// --- the change list -----------------------------------------------------------------------------------------

/** The plan file beside the work directory that `SHOW_ARGV` names: sealing writes it, and an apply re-derives the change list from a decrypted copy of it. */
const SEAL_PLAN_FILE = "alz-preview.tfplan";
/** The decrypted plan an apply runs, beside the work directory (`APPLY_ARGV` names it). */
const APPLY_PLAN_FILE = "alz-apply.tfplan";

type Shown = {
  format_version?: unknown; errored?: unknown;
  resource_changes?: { address?: string; type?: string; previous_address?: unknown; change?: { actions?: string[]; importing?: unknown } }[];
  output_changes?: Record<string, { actions?: string[] }>;
  configuration?: { provider_config?: Record<string, ProviderBlock> };
};

/** What the provider half of the contract binding is judged against: the contract's target and provider, and the environment that holds the APPLY role (sealing hides it from its children, not from this check). */
type Judge = Pick<EngineContext, "pinned" | "spec" | "env">;

/**
 * The one extraction of the redacted change list (address, type, action, and
 * an import, a move, a forget or an output change; never a value) from
 * `terraform show -json` output. Sealing records it, and an apply derives it
 * again from the decrypted plan to prove the record describes it. It also
 * enforces the provider half of the contract binding.
 */
function changesOf(shown: string, judge: Judge): PlanChange[] {
  let document: Shown;
  try { document = JSON.parse(shown); } catch { return stop("PLAN_JSON_INVALID"); }
  if (typeof document?.format_version !== "string" || document.errored === true) return stop("PLAN_JSON_UNUSABLE");
  judge.spec.assertProviderConfig(Object.values(document.configuration?.provider_config ?? {}), judge.pinned, judge.env);
  const resources = (Array.isArray(document.resource_changes) ? document.resource_changes : []).map((found, index): PlanChange => {
    const actions = found?.change?.actions ?? [];
    const previous = found?.previous_address;
    return {
      address: stripInvisible(found?.address ?? "terraform:unknown:" + index), type: stripInvisible(found?.type ?? "unknown"),
      action: actions.includes("forget") ? "FORGET" : mapTerraformActions(actions),
      ...(found?.change?.importing ? { importing: true as const } : {}),
      ...(typeof previous === "string" && previous !== "" ? { previousAddress: stripInvisible(previous) } : {}),
    };
  }).sort((a, b) => (a.address < b.address ? -1 : a.address > b.address ? 1 : 0));
  const outputs = Object.entries(document.output_changes ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([name, change]): PlanChange => ({ address: "output." + stripInvisible(name), type: "output", action: mapTerraformActions(change?.actions ?? []) }))
    .filter((change) => change.action !== "SAME");
  return [...resources, ...outputs];
}

/** The pinned `show` of the plan file at `../alz-preview.tfplan`, in an initialized work directory, with no identity at all. */
const readChanges = (session: Session, judge: Judge): PlanChange[] => changesOf(session.step(SHOW_ARGV, null, true), judge);

/** Sealing and re-deriving run the preview adapter's argument lists under the apply path's restricted profile: no CLI configuration file, no plugin cache. */
const sealSession = (input: Pick<EngineContext, "scratchDir" | "env" | "toolDirs" | "manifest">): Session => openSession({
  scratchDir: input.scratchDir, env: sealEnvironment(input.env), toolDirs: input.toolDirs, manifest: input.manifest,
  isAllowed: (args) => isAllowedArgv("TERRAFORM", "terraform", args), profile: TERRAFORM_APPLY_PROFILE,
});

/**
 * Derives the change list from the plan bytes themselves, for an apply that
 * has initialized its work directory: the decrypted plan is written, shown
 * with the same pinned argument list and the same restricted profile as
 * sealing (no identity in the environment), and removed. Throws a code.
 */
function rederiveChanges(input: EngineContext & { artifact: Buffer }): PlanChange[] {
  const session = sealSession(input);
  const planFile = join(input.scratchDir, SEAL_PLAN_FILE);
  writeFileSync(planFile, input.artifact, { mode: 0o600, flag: "wx" });
  try {
    return readChanges(session, input);
  } finally {
    rmSync(planFile, { force: true });
  }
}

// --- applying ------------------------------------------------------------------------------------------------

/**
 * A real apply outlives the runner's two-minute default, and killing one
 * partway is the worst outcome, so it gets its own reviewed limits. Its output
 * is held in memory only, classified by exit code and state serial, and dropped.
 * Every step uses the apply profile: no CLI configuration file or plugin cache
 * can redirect where providers are installed from.
 */
const APPLY_PROFILE = { ...TERRAFORM_APPLY_PROFILE, timeoutMs: 30 * 60_000, maxOutputBytes: LARGE_OUTPUT_BYTES };

function openApply(input: EngineContext & { target: ResolvedTarget; engineVersion: string }): EngineApplyRun {
  const { scratchDir, env, pinned, spec } = input;
  const session = openSession({
    scratchDir, env, toolDirs: input.toolDirs, manifest: input.manifest, isAllowed: (args) => isAllowedApplyArgv("terraform", args), profile: TERRAFORM_APPLY_PROFILE,
  });
  const planPath = join(scratchDir, APPLY_PLAN_FILE);
  const backendConfigPath = join(scratchDir, APPLY_BACKEND_CONFIG_FILE);
  let serialBefore: string | undefined;
  const removeSecrets = (): void => {
    for (const path of [planPath, backendConfigPath, join(scratchDir, SEAL_PLAN_FILE)]) rmSync(path, { force: true });
  };
  return {
    // Init as STATE_WRITE with the partial backend configuration (written 0600, removed as soon as init ends), the
    // target's workspace, and the state serial read as STATE. Refuses to go on if the runner would drop a variable of
    // the APPLY identity, because an apply cannot be undone.
    prepare(snapshotPath) {
      prepareWorkspace(session, {
        snapshotPath, engineVersion: input.engineVersion, target: input.target, initArgv: APPLY_INIT_ARGV, stateIdentity: "STATE_WRITE", backendBlock: spec.backendBlock,
        beforeInit: () => writeFileSync(backendConfigPath, spec.backendConfig(env, pinned), { mode: 0o600, flag: "wx" }),
        afterInit: () => rmSync(backendConfigPath, { force: true }),
      });
      assertBackendInContract(session.work, pinned, spec);
      serialBefore = parseStateSerial(session.step(STATE_PULL_ARGV, "STATE", true)) ?? stop("STATE_SERIAL_UNREADABLE");
      if (session.refused("APPLY", APPLY_PROFILE).length > 0) stop("ENVIRONMENT_REFUSED");
    },
    // The change list the approvers read must describe this plan: derive it again from the decrypted bytes, as sealing did.
    rederive: (artifact) => rederiveChanges({ ...input, artifact }),
    async execute(artifact, control) {
      writeFileSync(planPath, artifact, { mode: 0o600, flag: "wx" });
      // The plaintext plan goes the moment a stop is asked for, not after the grace period.
      const applied = await session.stoppable(APPLY_ARGV, "APPLY", APPLY_PROFILE, { ...control, forwardSignals: true, onStop: removeSecrets });
      rmSync(planPath, { force: true });
      return applied;
    },
    settle(applied) {
      if (serialBefore === undefined) return stop("ENGINE_NOT_PREPARED");
      let serialAfter: string | undefined;
      try { serialAfter = parseStateSerial(session.step(STATE_PULL_ARGV, "STATE", true)); } catch { serialAfter = undefined; }
      return classifyApply({ exitCode: applied.exitCode, stderr: applied.stderr, serialBefore, serialAfter, stopped: applied.stopped });
    },
    recoveryFiles() {
      const files: { name: string; base64: string }[] = [];
      for (const name of RECOVERY_FILES) {
        try {
          if (lstatSync(join(session.work, name)).isFile()) files.push({ name, base64: readFileSync(join(session.work, name)).toString("base64") });
        } catch { /* not there */ }
      }
      return files;
    },
    removeSecrets,
  };
}

export const TERRAFORM: EngineSpec = {
  id: "TERRAFORM",
  mutation: "TERRAFORM_APPLY_OF_SEALED_PLAN",
  providers: ["AZURE", "AWS"],
  notices: {
    sealHeading: "SEAL A PREVIEW (this plans against the target and changes no infrastructure; the plan is kept encrypted)",
    sealReads: "  reads           state with the STATE identity, then plans with the DISCOVERY identity",
    qualifyHeading: "QUALIFY THE APPLY ADAPTER (needs the real Terraform engine; against DEV it runs version, init, workspace, a throwaway plan and the state read, and applies nothing)",
    qualifyReads: "  runs            init and workspace as STATE_WRITE, the state serial as STATE, the plan as DISCOVERY",
    projectCode: "THIS RUNS PROJECT CODE (providers and modules) with the DISCOVERY identity on this machine.",
    attestation: (provider, stateWrite, apply) => [
      "  state and backend access was by   STATE_WRITE  " + stateWrite,
      "  provider (resource) access is by  APPLY        " + apply,
      "  the plan leaves these backend settings to the apply process (APPLY's environment): " + provider.filledAtApply.join(", "),
      "Only if the logs show that, and the APPLY client never touched the state, type (anything else writes nothing):",
    ],
    applyNote: "It applies exactly this plan file, never a new one, with locking on and the APPLY identity.",
  },
  manifestMode: "PROJECT",
  identities: ["DISCOVERY", "STATE", "STATE_WRITE", "APPLY"],
  attests: ["STATE_WRITE", "APPLY"],
  previewAdapter: () => createTerraformAdapter("TERRAFORM"),
  applyAdapter: APPLY_ADAPTER,
  /**
   * SHA-256 of the terraform binary a run would execute: the same lookup the
   * runner does (approved tool directories only). Undefined when there is none.
   * The same-uid operator who can replace the binary after this read is inside the
   * trust boundary (docs/act-pilot-apply.md); this refuses an honest upgrade.
   */
  binarySha256(toolDirs, env) {
    const path = resolveExecutable("terraform", toolDirs ?? approvedToolDirs(env));
    try { return path ? sha256(readFileSync(path)) : undefined; } catch { return undefined; }
  },
  // The same pinned init, workspace and plan steps as the preview adapter, keeping the plan file. Sealing never holds
  // STATE_WRITE or APPLY, and `terraform show -json` is read only to extract the redacted change list.
  plan(input) {
    const planFile = join(input.scratchDir, SEAL_PLAN_FILE);
    const session = sealSession(input);
    try {
      prepareWorkspace(session, {
        snapshotPath: input.snapshotPath, engineVersion: input.engineVersion, target: input.target,
        initArgv: INIT_ARGV, stateIdentity: "STATE", backendBlock: input.spec.backendBlock,
      });
      // The plan embeds the backend this init saved (docs/act-pilot-simulation.md), so it is judged here as well as at apply.
      assertBackendInContract(session.work, input.pinned, input.spec);
      session.assertBound();
      session.step(PREVIEW_PLAN_ARGV, "DISCOVERY");
      session.assertBound();
      return { artifact: readFileSync(planFile), changes: readChanges(session, input) };
    } finally {
      rmSync(planFile, { force: true });
      removeTree(session.work);
    }
  },
  rederiveChanges,
  openApply,
  outcomeMessages: {
    FAILED_NO_CHANGE: "The apply failed before it changed state. The engine's output is withheld because it can hold secrets. " +
      "This sealed plan and its approvals are spent: seal a new preview and obtain new approvals to try again.",
    PARTIAL_REQUIRES_REVIEW: "The apply failed after it started, so resources may be partly applied (Terraform reports every error with the same " +
      "exit code, and state can be left unwritten). Do not retry. A person must review the state and the cloud resources by hand before any new preview. " +
      "If Terraform left errored.tfstate or crash.log, they are in the encrypted evidence vault and the evidence names their hash. " +
      "This sealed plan and its approvals are spent, and the engine's output is withheld because it can hold secrets.",
    KILLED: "The apply was told to stop while it ran (the kill switch appeared, the time limit passed, or this command received SIGINT, SIGTERM, SIGHUP or SIGQUIT), " +
      "or it ended on a signal. Terraform was sent its graceful interrupt and, if it had not stopped after the grace period, was killed. " +
      "Resources may be partly applied and the state lease may still be held. Do not retry. A person must review the state, the lease and the " +
      "cloud resources by hand before any new preview. This sealed plan and its approvals are spent.",
  },
  recoveryLostNote: " Terraform left errored.tfstate or crash.log, and they could not be saved to the vault; they were removed with the scratch directory.",
  recoveryFileNames: RECOVERY_FILES,
};
