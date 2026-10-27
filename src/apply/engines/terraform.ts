import { existsSync, lstatSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { mapTerraformActions } from "../../iac/terraform-plan.js";
import {
  LARGE_OUTPUT_BYTES, PREVIEW_PLAN_ARGV, SHOW_ARGV, STATE_PULL_ARGV, VERSION_ARGV, WORKSPACE_SHOW_ARGV, assertModulesAreLocal,
  createTerraformAdapter, isAllowedArgv, workspaceSelectArgv,
} from "../../teardown/driver/adapters/terraform.js";
import { removeTree } from "../../teardown/driver/cleanup.js";
import { copyTree, projectDifference } from "../../teardown/driver/adapters/project-copy.js";
import type { ResolvedTarget } from "../../teardown/driver/types.js";
import { approvedToolDirs, resolveExecutable } from "../../tools/child-env.js";
import { MUTATION_IDENTITY_VARIABLE, ownsIdentityVariable } from "../../tools/identity.js";
import { refusedVariables, runBoundedProcess, runStoppableProcess, type StoppableProcessOptions, type StoppableResult } from "../../tools/process.js";
import { TERRAFORM_APPLY_PROFILE, type ProcessProfile } from "../../tools/profiles.js";
import { sha256 } from "../../util/sha256.js";
import { assertNoBackendOverrideOrState, writeBackendOverride, type BackendType } from "../backend-pin.js";
import { stripInvisible } from "../constants.js";
import { checkedOutput, codeOf, stop, withoutIdentities } from "../engine.js";
import type { EngineApplyRun, EngineCleanupRun, EngineContext, EngineSpec } from "../engine-spec.js";
import type { ProviderBlock, ProviderSpec, ProviderUse } from "../provider.js";
import { isRecord } from "../providers/shared.js";
import { assertNoRefusedPlanConstructs, assertNoRefusedSourceConstructs } from "../terraform-constructs.js";
import {
  APPLY_ADAPTER, APPLY_ARGV, APPLY_BACKEND_CONFIG_FILE, APPLY_INIT_ARGV, CLEANUP_ADAPTER, CLEANUP_APPLY_ARGV, CLEANUP_PLAN_FILE, CLEANUP_SHOW_ARGV, RECOVERY_FILES,
  classifyApply, cleanupPlanArgv, isAllowedApplyArgv, isAllowedCleanupArgv, parseStateSerial,
} from "../terraform.js";
import { APPLY_IDENTITIES, type PilotTarget, type PlanChange, type SealedUnit } from "../types.js";
import type { PilotUnit } from "../unit.js";
import { ALZ_TAG_KEYS } from "../../teardown/unit.js";

/**
 * The Terraform engine spec: init, workspace, `plan -out`, `show -json` for the
 * change list, `apply <planfile>` and nothing else (docs/act-pilot-plan.md,
 * authority items 2 and 5). The argument lists, the qualification digest and the
 * outcome classification are in `../terraform.ts`; this file is how a run uses
 * them. Codes only: engine output can quote plan or state values.
 */

type StepIdentity = "DISCOVERY" | "STATE" | "STATE_WRITE" | "APPLY" | null;

/**
 * What may be rendered into the seal-time backend file when the contract opts in: an allowlist of the STATE_WRITE variables the provider
 * specs' `backendConfig` reads (the principal's client id or role ARN, tenant, subscription, region, and the token file PATH). Any other
 * variable, including one that holds a secret, never reaches the renderer, and a token file's content is never read. The file is rendered
 * by this process and never handed to a child: the seal environment below still holds no STATE_WRITE or APPLY variable.
 */
const STATE_WRITE_SETTINGS = new Set(["ARM_CLIENT_ID", "ARM_TENANT_ID", "ARM_SUBSCRIPTION_ID", "ARM_OIDC_TOKEN_FILE", "AWS_ROLE_ARN", "AWS_WEB_IDENTITY_TOKEN_FILE"]);
const nonSecretStateWrite = (env: NodeJS.ProcessEnv): NodeJS.ProcessEnv => Object.fromEntries(
  Object.entries(env).filter(([key]) => ownsIdentityVariable(key, "STATE_WRITE") && STATE_WRITE_SETTINGS.has(key.slice("ALZ_STATE_WRITE_".length))));

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
  /** The files, the lock file and the module sources, all against the manifest (and, once written, the product's backend override). */
  assertBound(): void;
  /** Writes the product-owned backend override into the work copy and binds it: from then on `assertBound` expects it, byte for byte. */
  pinBackend(type: BackendType): void;
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
  let bound = input.manifest;
  return {
    work,
    step(args, identity, large = false) {
      guard(args);
      const profile = large ? { ...input.profile, maxOutputBytes: LARGE_OUTPUT_BYTES } : input.profile;
      return checkedOutput(runBoundedProcess("terraform_plan", "terraform", [...args], work, options(identity, profile)));
    },
    stoppable(args, identity, profile, control) {
      guard(args);
      return runStoppableProcess("terraform_plan", "terraform", [...args], work, { ...options(identity, profile), ...control });
    },
    refused(identity, profile) {
      return refusedVariables(options(identity, profile));
    },
    assertBound() {
      const difference = projectDifference(work, bound);
      if (difference) stop(difference);
      assertModulesAreLocal(work);
    },
    pinBackend(type) {
      if (bound !== input.manifest) return stop("BACKEND_ALREADY_PINNED");
      const entry = writeBackendOverride(work, type);
      bound = { ...input.manifest, files: [...input.manifest.files, entry] };
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
  /** The backend type the product override pins (`ProviderSpec.backendType`). Every init in the pilot runs with it. */
  backendType: BackendType;
  /** Runs between the version check and init (writes the product's `-backend-config` file). */
  beforeInit?: () => void;
  afterInit?: () => void;
};

/**
 * The one init and workspace sequence: a writable copy of the snapshot that
 * must equal the manifest, the backend pin (docs/act-pilot-backend-pinning.md),
 * the pinned engine version, backend initialization, and the target's
 * workspace. Locking stays on: there is no -lock flag in any argument list.
 * Nothing here changes state.
 */
function prepareWorkspace(session: Session, input: WorkspaceInput): void {
  const copyProblem = copyTree(input.snapshotPath, session.work);
  if (copyProblem) stop(copyProblem);
  // By name, before anything reads the copy: no other override file (it could outrank ours) and no saved state or data
  // directory (init could reuse or migrate it). The data directory init builds is therefore always fresh and empty.
  assertNoBackendOverrideOrState(session.work);
  session.assertBound();
  // No provisioner or ephemeral block in any Terraform file: `show -json` never lists an ephemeral resource or a `removed`
  // block's provisioner, and a plan or an apply would run them (../terraform-constructs.ts).
  assertNoRefusedSourceConstructs(session.work);
  // The project's own backend, cloud or state_store block is replaced: init builds only this type, with only the product's settings.
  session.pinBackend(input.backendType);
  session.assertBound();

  let reported: unknown;
  try { reported = (JSON.parse(session.step(VERSION_ARGV, null)) as { terraform_version?: unknown }).terraform_version; } catch (error) {
    if (codeOf(error) !== "UNEXPECTED") throw error;
    return stop("VERSION_UNREADABLE");
  }
  if (reported !== input.engineVersion) stop("ENGINE_VERSION_MISMATCH");

  input.beforeInit?.();
  try { session.step(input.initArgv, input.stateIdentity); } finally { input.afterInit?.(); }
  session.assertBound();
  if (input.target.workspace !== "default") session.step(workspaceSelectArgv(input.target.workspace), input.stateIdentity);
  if (session.step(WORKSPACE_SHOW_ARGV, input.stateIdentity).trim() !== input.target.workspace) stop("WORKSPACE_MISMATCH");
}

/**
 * The backend binding: the backend init saved must be the contract's, so the project's own backend block cannot aim state somewhere
 * else, and any identity setting it saved must be the STATE_WRITE identity's own in `env`, the environment init's configuration came from.
 */
function assertBackendInContract(work: string, pinned: PilotTarget, spec: ProviderSpec, env: NodeJS.ProcessEnv): void {
  let saved: unknown;
  try {
    const file = join(work, ".terraform", "terraform.tfstate");
    if (!lstatSync(file).isFile() || lstatSync(file).size > 1_048_576) return stop("BACKEND_UNREADABLE");
    saved = JSON.parse(readFileSync(file, "utf8"));
  } catch { return stop("BACKEND_UNREADABLE"); }
  const backend = (saved as { backend?: unknown } | null)?.backend;
  if (!spec.savedBackendMatches(isRecord(backend) ? backend : {}, pinned, env)) stop("BACKEND_NOT_IN_CONTRACT");
}

// --- the change list -----------------------------------------------------------------------------------------

/** The plan file beside the work directory that `SHOW_ARGV` names: sealing writes it, and an apply re-derives the change list from a decrypted copy of it. */
const SEAL_PLAN_FILE = "alz-preview.tfplan";
/** The decrypted plan an apply runs, beside the work directory (`APPLY_ARGV` names it). */
const APPLY_PLAN_FILE = "alz-apply.tfplan";

type Shown = {
  format_version?: unknown; errored?: unknown;
  resource_changes?: { address?: string; type?: string; mode?: unknown; provider_name?: unknown; previous_address?: unknown; change?: { actions?: string[]; importing?: unknown; after?: unknown; after_unknown?: unknown } }[];
  output_changes?: Record<string, { actions?: string[] }>;
  configuration?: { provider_config?: Record<string, ProviderBlock>; root_module?: unknown };
  prior_state?: { values?: { root_module?: unknown } };
  planned_values?: { root_module?: unknown };
};

/** Module nesting the walker follows. Terraform has no practical nesting this deep; past it the plan is refused, never read partially. */
const MAX_MODULE_DEPTH = 64;

/**
 * Every resource and data source the plan names, each with the provider that serves it (`ProviderUse`), for the provider half
 * of the contract binding. Four places are read, because none alone is complete: the configuration tree (every module through
 * `module_calls`; a data source read at plan time appears here even when its read fails and nothing else mentions it), the
 * changes, the prior state and the planned values (both with `child_modules`). A `provider_config_key` resolves through
 * `provider_config`; a key with no block is named by its last segment (`module.net:aws` is `aws`), the way a block without
 * `full_name` is named. Fail closed: a tree nested past `MAX_MODULE_DEPTH` is `PROVIDER_PLAN_TOO_DEEP`, and a tree that is
 * present but not the shape `show -json` documents (a module, a call, a resource or a changes entry that is not an object;
 * `resources`, `child_modules` or `resource_changes` that is not a list; `module_calls` that is not an object) is
 * `PROVIDER_PLAN_UNREADABLE`, because a use that could not be read could be one of the built-in provider. A tree that is
 * absent is simply absent. Addresses and types are read as text only; no value leaves this function.
 */
function providerUsesOf(document: Shown): ProviderUse[] {
  const UNREADABLE = "PROVIDER_PLAN_UNREADABLE";
  const blocks = document.configuration?.provider_config ?? {};
  const byKey = (key: unknown): ProviderUse["provider"] => {
    if (typeof key !== "string") return {};
    const block = blocks[key];
    if (isPlainRecord(block)) return { name: typeof block.name === "string" ? block.name : undefined, full_name: typeof block.full_name === "string" ? block.full_name : undefined };
    return { name: key.slice(key.lastIndexOf(":") + 1).split(".")[0] };
  };
  const uses: ProviderUse[] = [];
  const add = (found: unknown, provider: (entry: Record<string, unknown>) => ProviderUse["provider"]): void => {
    if (!isPlainRecord(found)) return stop(UNREADABLE);
    uses.push({
      address: stripInvisible(typeof found.address === "string" ? found.address : ""), mode: typeof found.mode === "string" ? found.mode : "",
      type: stripInvisible(typeof found.type === "string" ? found.type : ""), provider: provider(found),
    });
  };
  /** A list that is present must be a list; an object that is present must be an object. Absent is an empty list or object. */
  const listOf = (value: unknown): unknown[] => value === undefined ? [] : Array.isArray(value) ? value : stop(UNREADABLE);
  const recordOf = (value: unknown): Record<string, unknown> => value === undefined ? {} : isPlainRecord(value) ? value : stop(UNREADABLE);
  const byName = (entry: Record<string, unknown>): ProviderUse["provider"] => ({ full_name: typeof entry.provider_name === "string" ? entry.provider_name : undefined });
  const configured = (module: unknown, depth: number): void => {
    if (module === undefined) return;
    if (!isPlainRecord(module)) return stop(UNREADABLE);
    if (depth > MAX_MODULE_DEPTH) return stop("PROVIDER_PLAN_TOO_DEEP");
    for (const found of listOf(module.resources)) add(found, (entry) => byKey(entry.provider_config_key));
    for (const call of Object.values(recordOf(module.module_calls))) configured(recordOf(call).module, depth + 1);
  };
  const valued = (module: unknown, depth: number): void => {
    if (module === undefined) return;
    if (!isPlainRecord(module)) return stop(UNREADABLE);
    if (depth > MAX_MODULE_DEPTH) return stop("PROVIDER_PLAN_TOO_DEEP");
    for (const found of listOf(module.resources)) add(found, byName);
    for (const child of listOf(module.child_modules)) valued(child, depth + 1);
  };
  configured(document.configuration?.root_module, 0);
  for (const found of listOf(document.resource_changes)) add(found, byName);
  valued(document.prior_state?.values?.root_module, 0);
  valued(document.planned_values?.root_module, 0);
  return uses;
}

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
  // The walker refuses a tree too deep or malformed first; then no provisioner, action or ephemeral resource (../terraform-constructs.ts); then the provider judge.
  const uses = providerUsesOf(document);
  assertNoRefusedPlanConstructs(document);
  judge.spec.assertProviderConfig(Object.values(document.configuration?.provider_config ?? {}), judge.pinned, judge.env, uses);
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

/**
 * The deletion unit, verified in the plan (src/apply/unit.ts): every resource the plan creates and whose type carries
 * tags must carry exactly the unit's tags, as constants the plan already knows. A missing tag (UNIT_TAG_MISSING), a
 * tag with another unit's value (UNIT_TAG_FOREIGN) or tags the plan cannot show because they are computed at apply time
 * (UNIT_TAG_UNVERIFIABLE) stop the seal. Created resources with no tag attribute are listed as untagged: traceable
 * through the state only. The only values read are the unit's own tag keys; nothing else of `after` leaves this function.
 */
function unitOfPlan(shown: string, judge: Judge, unit: PilotUnit): SealedUnit {
  let document: Shown;
  try { document = JSON.parse(shown); } catch { return stop("PLAN_JSON_INVALID"); }
  const untagged: string[] = [];
  for (const found of Array.isArray(document.resource_changes) ? document.resource_changes : []) {
    if (found?.mode === "data" || !(found?.change?.actions ?? []).includes("create")) continue;
    const address = stripInvisible(found?.address ?? "terraform:unknown");
    const after = isPlainRecord(found?.change?.after) ? found.change!.after as Record<string, unknown> : {};
    const unknown = isPlainRecord(found?.change?.after_unknown) ? found.change!.after_unknown as Record<string, unknown> : {};
    const attribute = judge.spec.tagAttributes.find((name) => Object.hasOwn(after, name) || Object.hasOwn(unknown, name));
    if (attribute === undefined) { untagged.push(address); continue; }
    const tags: unknown = after[attribute];
    if (!isPlainRecord(tags)) return stop(unknown[attribute] !== undefined ? "UNIT_TAG_UNVERIFIABLE" : "UNIT_TAG_MISSING");
    for (const [key, value] of Object.entries(unit.tags)) {
      if (!Object.hasOwn(tags, key)) return stop("UNIT_TAG_MISSING");
      if (tags[key] !== value) return stop(key === ALZ_TAG_KEYS.unit ? "UNIT_TAG_FOREIGN" : "UNIT_TAG_MISSING");
    }
  }
  return { unitId: unit.unitId, tags: { ...unit.tags }, untagged: untagged.sort() };
}
const isPlainRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** Sealing and re-deriving run the preview adapter's argument lists under the apply path's restricted profile: no CLI configuration file, no plugin cache. */
const sealSession = (input: Pick<EngineContext, "scratchDir" | "env" | "toolDirs" | "manifest">): Session => openSession({
  scratchDir: input.scratchDir, env: sealEnvironment(input.env), toolDirs: input.toolDirs, manifest: input.manifest,
  // The one extra shape: init with the product's backend file (`APPLY_INIT_ARGV`), since the pinned backend has no settings of its own. Every other list is the preview adapter's.
  isAllowed: (args) => isAllowedArgv("TERRAFORM", "terraform", args) || sameArgv(args, APPLY_INIT_ARGV),
  profile: TERRAFORM_APPLY_PROFILE,
});
const sameArgv = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((arg, index) => arg === b[index]);

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
        snapshotPath, engineVersion: input.engineVersion, target: input.target, initArgv: APPLY_INIT_ARGV, stateIdentity: "STATE_WRITE", backendType: spec.backendType,
        beforeInit: () => writeFileSync(backendConfigPath, spec.backendConfig(env, pinned), { mode: 0o600, flag: "wx" }),
        afterInit: () => rmSync(backendConfigPath, { force: true }),
      });
      assertBackendInContract(session.work, pinned, spec, env);
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
    recoveryFiles: () => recoveryFilesIn(session.work),
    removeSecrets,
    // The state after the run, as the STATE identity reads it (the same pinned list `settle` used). Held in memory by the caller for identifiers only.
    stateDocument() {
      try { return { source: "TERRAFORM_STATE_PULL", document: session.step(STATE_PULL_ARGV, "STATE", true) }; } catch { return undefined; }
    },
  };
}

/** What Terraform left in its working directory for a person to recover from. */
function recoveryFilesIn(work: string): { name: string; base64: string }[] {
  const files: { name: string; base64: string }[] = [];
  for (const name of RECOVERY_FILES) {
    try {
      if (lstatSync(join(work, name)).isFile()) files.push({ name, base64: readFileSync(join(work, name)).toString("base64") });
    } catch { /* not there */ }
  }
  return files;
}

// --- cleanup -------------------------------------------------------------------------------------------------

/**
 * A cleanup (docs/act-pilot-plan.md, "Cleanup of pilot-created resources"): init and workspace as for an apply (STATE_WRITE
 * owns the backend, the state serial is read as STATE), then a destroy plan limited to the approved addresses as
 * DISCOVERY (provider reads), shown with no identity to derive the change list the driver compares with the proposal, and
 * applied as APPLY. The destroy plan is written by Terraform into the scratch directory and removed with it; nothing of
 * the project is changed. Every list is the cleanup adapter's own (`isAllowedCleanupArgv`).
 */
function openCleanup(input: EngineContext & { target: ResolvedTarget; engineVersion: string }): EngineCleanupRun {
  const { scratchDir, env, pinned, spec } = input;
  const session = openSession({
    scratchDir, env, toolDirs: input.toolDirs, manifest: input.manifest, isAllowed: (args) => isAllowedCleanupArgv("terraform", args), profile: TERRAFORM_APPLY_PROFILE,
  });
  const planPath = join(scratchDir, CLEANUP_PLAN_FILE);
  const backendConfigPath = join(scratchDir, APPLY_BACKEND_CONFIG_FILE);
  let serialBefore: string | undefined;
  let planned = false;
  const removeSecrets = (): void => {
    for (const path of [planPath, backendConfigPath]) rmSync(path, { force: true });
  };
  return {
    prepare(snapshotPath) {
      prepareWorkspace(session, {
        snapshotPath, engineVersion: input.engineVersion, target: input.target, initArgv: APPLY_INIT_ARGV, stateIdentity: "STATE_WRITE", backendType: spec.backendType,
        beforeInit: () => writeFileSync(backendConfigPath, spec.backendConfig(env, pinned), { mode: 0o600, flag: "wx" }),
        afterInit: () => rmSync(backendConfigPath, { force: true }),
      });
      assertBackendInContract(session.work, pinned, spec, env);
      serialBefore = parseStateSerial(session.step(STATE_PULL_ARGV, "STATE", true)) ?? stop("STATE_SERIAL_UNREADABLE");
      if (session.refused("APPLY", APPLY_PROFILE).length > 0) stop("ENVIRONMENT_REFUSED");
    },
    planDestroy(addresses) {
      if (serialBefore === undefined) return stop("ENGINE_NOT_PREPARED");
      let argv: readonly string[];
      try { argv = cleanupPlanArgv(addresses); } catch { return stop("CLEANUP_ADDRESSES_INVALID"); }
      rmSync(planPath, { force: true });
      session.step(argv, "DISCOVERY");
      session.assertBound();
      if (!existsSync(planPath)) stop("PLAN_FILE_MISSING");
      planned = true;
      // The same redacted extraction as sealing, with the same provider-config judgment; the plan file stays for `execute`.
      const shown = session.step(CLEANUP_SHOW_ARGV, null, true);
      return changesOf(shown, input);
    },
    async execute(control) {
      if (!planned || !existsSync(planPath)) return stop("ENGINE_NOT_PREPARED");
      const applied = await session.stoppable(CLEANUP_APPLY_ARGV, "APPLY", APPLY_PROFILE, { ...control, forwardSignals: true, onStop: removeSecrets });
      rmSync(planPath, { force: true });
      return applied;
    },
    settle(applied) {
      if (serialBefore === undefined) return stop("ENGINE_NOT_PREPARED");
      let serialAfter: string | undefined;
      try { serialAfter = parseStateSerial(session.step(STATE_PULL_ARGV, "STATE", true)); } catch { serialAfter = undefined; }
      return classifyApply({ exitCode: applied.exitCode, stderr: applied.stderr, serialBefore, serialAfter, stopped: applied.stopped });
    },
    recoveryFiles: () => recoveryFilesIn(session.work),
    removeSecrets,
  };
}

export const TERRAFORM: EngineSpec = {
  id: "TERRAFORM",
  executables: ["terraform"],
  embedsStateWrite: true,
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
  identities: APPLY_IDENTITIES,
  attests: ["STATE_WRITE", "APPLY"],
  previewAdapter: () => createTerraformAdapter("TERRAFORM"),
  applyAdapter: APPLY_ADAPTER,
  cleanupAdapter: CLEANUP_ADAPTER,
  cleanupMutation: "TERRAFORM_DESTROY_OF_APPROVED_PROPOSAL",
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
    const embed = input.embedStateWrite === true;
    const backendConfigPath = join(input.scratchDir, APPLY_BACKEND_CONFIG_FILE);
    const session = sealSession(input);
    try {
      prepareWorkspace(session, {
        snapshotPath: input.snapshotPath, engineVersion: input.engineVersion, target: input.target,
        stateIdentity: "STATE", backendType: input.spec.backendType, initArgv: APPLY_INIT_ARGV,
        // The contract's backend location (written 0600, removed as soon as init ends), and on opt-in STATE_WRITE's non-secret settings too, so the plan embeds them.
        beforeInit: () => writeFileSync(backendConfigPath, embed
          ? input.spec.backendConfig(nonSecretStateWrite(input.env), input.pinned)
          : input.spec.backendLocation(input.pinned), { mode: 0o600, flag: "wx" }),
        afterInit: () => rmSync(backendConfigPath, { force: true }),
      });
      // The plan embeds the backend this init saved (docs/act-pilot-simulation.md), so it is judged here as well as at apply.
      assertBackendInContract(session.work, input.pinned, input.spec, nonSecretStateWrite(input.env));
      session.assertBound();
      session.step(PREVIEW_PLAN_ARGV, "DISCOVERY");
      session.assertBound();
      const shown = session.step(SHOW_ARGV, null, true);
      return { artifact: readFileSync(planFile), changes: changesOf(shown, input), unit: unitOfPlan(shown, input, input.unit) };
    } finally {
      rmSync(planFile, { force: true });
      rmSync(backendConfigPath, { force: true });
      removeTree(session.work);
    }
  },
  openApply,
  openCleanup,
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
