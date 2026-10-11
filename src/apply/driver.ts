import { lstatSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { createTerraformAdapter, LARGE_OUTPUT_BYTES, STATE_PULL_ARGV } from "../teardown/driver/adapters/terraform.js";
import { registerCleanup, removeTree } from "../teardown/driver/cleanup.js";
import { checkHumanInvocation, isRecord } from "../teardown/driver/human.js";
import { engineActivation } from "../teardown/driver/qualification.js";
import type { AdapterDescriptor, EngineAdapter, HumanInvocation, ResolvedInputs, ResolvedTarget } from "../teardown/driver/types.js";
import { canonicalJson, validateManifestForRequest, verifyManifest, type ArtifactManifest } from "../teardown/manifest.js";
import { captureProjectFiles, createImmutableSnapshot, type ImmutableSnapshot } from "../teardown/snapshot.js";
import { forbiddenIdentityVariables, identityVariables } from "../tools/identity.js";
import { GUID, SAFE_VALUE } from "./constants.js";
import { writeEncryptedEvidence } from "../evidence/vault.js";
import { interceptStopSignals } from "../tools/process.js";
import { createPrivateDirectory } from "../tools/private-workdir.js";
import { TERRAFORM_APPLY_PROFILE } from "../tools/profiles.js";
import { consumeApprovals, verifyApprovalSet } from "./approval.js";
import {
  DEFAULT_EVIDENCE_DIR, contractRefusal, isKillSwitchActive, loadPilotContract, loadQualificationRecords, repoPaths, requireNotApplied, requirePromotionEvidence,
  targetForEnvironment, terraformBinarySha256, verifyApplyQualification, type Refusal,
} from "./contract.js";
import { codeOf, openSession, prepareWorkspace, stop, type EngineSession } from "./engine.js";
import { APPLY_AUTHORITY } from "./evidence.js";
import { attestedClientId, checkApplyIdentities, verifyIdentityTargets } from "./identities.js";
import { finalizeArtifact, releaseReservation, reserveArtifact } from "./ledger.js";
import { openNonceStore, type NonceStore } from "./nonces.js";
import { SEAL_PLAN_FILE, planWithoutStoring, releaseIdentityOf, rederiveChanges, sealPlan, verifySealedPlan, type LoadedPlan, type SealResult, type ThrowawayPlan } from "./seal.js";
import { APPLY_ADAPTER, APPLY_ARGV, APPLY_BACKEND_CONFIG_FILE, APPLY_INIT_ARGV, RECOVERY_FILES, classifyApply, isAllowedApplyArgv, parseStateSerial } from "./terraform.js";
import { sha256 } from "../util/sha256.js";
import type { ApplyEnvironment, ApplyEvidence, ApplyOutcome, ApplyRefusalCode, ApplyResult, PilotContract, PilotTarget, SealedPlan, SignedApproval } from "./types.js";

/**
 * The human-invoked apply driver (docs/act-pilot-plan.md). The operator
 * authorizes, the driver enforces, and agents never initiate. Each check below
 * fails closed and nothing after it runs; the engine is reached only through
 * `runApply`, and `terraform apply` is the last step of the last stage. This
 * module is imported by the CLI only: nothing under src/tools, src/agent or
 * src/operator-ui reaches it, and the console never runs an apply.
 */
export type ApplyDeps = {
  /** Where qualification evidence is read. Defaults to the repository's vault. Apply needs a record for the apply adapter, sealing one for the preview adapter. */
  qualificationDir?: string;
  /** Where the pilot release contract and its committed pin are read. Default: the repository's (src/apply/contract.ts). */
  contractPath?: string;
  contractPinPath?: string;
  /** The apply ledger and encrypted evidence. */
  evidenceDir?: string;
  nonces?: NonceStore;
  /** The environment `ALZ_<IDENTITY>_<VARIABLE>` is read from. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  scratchParent?: string;
  /** Approved executable directories. Defaults to the runner's. Tests point this at a fake. */
  toolDirs?: readonly string[];
  /** How often the kill switch is read while the engine runs, and how long terraform gets to stop after SIGINT. Tests shorten both. */
  killPollMs?: number;
  killGraceMs?: number;
};
type SealDeps = Pick<ApplyDeps, "qualificationDir" | "contractPath" | "contractPinPath" | "env" | "now" | "scratchParent" | "toolDirs">;

export type ApplyRequest = {
  /** Built from a real terminal prompt by the CLI. An agent cannot produce one. */
  invocation: HumanInvocation;
  environment: ApplyEnvironment;
  target: ResolvedTarget;
  /** The sealed plan the CLI already loaded and showed. The driver verifies its hashes again; a caller's earlier check is not trusted. */
  sealedPlan: LoadedPlan;
  /** The manifest the plan was sealed against, and the project it describes. Both are re-bound to the sealed plan. */
  manifest: ArtifactManifest;
  projectRoot: string;
  approvals: SignedApproval[];
};

export type SealRequest = {
  invocation: HumanInvocation;
  environment: ApplyEnvironment;
  target: ResolvedTarget;
  manifest: ArtifactManifest;
  projectRoot: string;
  policyVersion: string;
  resolved: ResolvedInputs;
};

const refuse = (code: ApplyRefusalCode, message: string): Refusal => ({ ok: false, code, message });
const sameTarget = (a: ResolvedTarget, b: ResolvedTarget): boolean =>
  a.account === b.account && a.backend === b.backend && a.workspace === b.workspace;

/** Contract enabled, kill switch off, a human, and the contract's own target: the first four gates, shared by sealing and applying. */
function admit(deps: Pick<ApplyDeps, "contractPath" | "contractPinPath">, request: { invocation: unknown; environment: ApplyEnvironment; target: ResolvedTarget }):
  { ok: true; contract: PilotContract } | Refusal {
  const contract = loadPilotContract(deps.contractPath, deps.contractPinPath);
  if ("reason" in contract) return contractRefusal(contract);
  if (isKillSwitchActive(contract)) {
    return refuse("KILL_SWITCH_ACTIVE", "The kill switch is active. Nothing runs until the owner removes it.");
  }
  const human = checkHumanInvocation(request, "A pilot apply, seal or qualification run");
  if (human) return refuse("HUMAN_INVOCATION_REQUIRED", human.message);
  const pinned = targetForEnvironment(contract, request.environment, request.target);
  return pinned.ok ? { ok: true, contract } : pinned;
}

/**
 * The engine qualification and the identity checks, in the order sealing and
 * applying share. This is the one place identities are judged: all four
 * configured and separate, none for an identity this system never reads, and
 * every credential naming the contract's tenant and subscription. For an
 * apply, the adapter's qualification record must also be backed by real-engine
 * evidence in the vault. `engineActivation` reads only an adapter's engine,
 * version and argv digest, which a descriptor carries.
 */
async function checkEngineAndIdentities(
  adapter: AdapterDescriptor, deps: SealDeps, engineVersion: string,
  contract: PilotContract, environment: ApplyEnvironment, kind: "seal" | "apply" | "qualify",
): Promise<Refusal | undefined> {
  // Qualifying is how a record comes to exist, so it is the one run that needs none. Identities and targets are judged the same.
  if (kind !== "qualify") {
    const vault = deps.qualificationDir ?? repoPaths().qualifications;
    const activation = engineActivation("TERRAFORM", await loadQualificationRecords(vault), [adapter as unknown as EngineAdapter], engineVersion);
    if (!activation.enabled) return refuse("ENGINE_NOT_QUALIFIED", activation.reason);
    if (kind === "apply") {
      const attested = await verifyApplyQualification(activation.record, vault,
        { adapterVersion: adapter.adapterVersion, argvDigest: adapter.argvDigest, engineVersion },
        {
          dev: contract.targets.DEV, now: (deps.now ?? (() => new Date()))(), terraformSha256: terraformBinarySha256(deps.toolDirs, deps.env ?? process.env),
          stateWriteClientId: attestedClientId(deps.env ?? process.env, "STATE_WRITE"), applyClientId: attestedClientId(deps.env ?? process.env, "APPLY"),
        });
      if (!attested.ok) return attested;
    }
  }
  const env = deps.env ?? process.env;
  const identities = checkApplyIdentities(env);
  if (!identities.ok) return refuse(identities.code, identities.message);
  const forbidden = forbiddenIdentityVariables(env);
  if (forbidden.length > 0) {
    return refuse("IDENTITY_NOT_CONFIGURED", "Variables for an identity this system never reads are set (" + forbidden.join(", ") +
      "). Remove them; nothing will use them, and the four identities are the only credentials a run accepts.");
  }
  const targets = verifyIdentityTargets(contract, environment, env);
  return targets.ok ? undefined : refuse(targets.code, targets.message);
}

// --- sealing -----------------------------------------------------------------------------------------------

/**
 * The entry the CLI uses to turn a preview into a sealed plan: the same gates
 * as an apply (contract, kill switch, a human, the contract's target), the
 * manifest bound to the project and the resolved inputs, a qualified preview
 * adapter and configured identities. The plan stays encrypted in the vault.
 */
export async function sealPreview(request: SealRequest, deps: SealDeps): Promise<SealResult | Refusal> {
  return planAgainstTarget(request, deps, "seal");
}

/** The gates sealing and qualifying share, then one plan of the pinned project in a private scratch directory. Sealing stores the plan; qualifying drops it. */
function planAgainstTarget(request: SealRequest, deps: SealDeps, kind: "seal"): Promise<SealResult | Refusal>;
function planAgainstTarget(request: SealRequest, deps: SealDeps, kind: "qualify"): Promise<ThrowawayPlan | Refusal>;
async function planAgainstTarget(request: SealRequest, deps: SealDeps, kind: "seal" | "qualify"): Promise<SealResult | ThrowawayPlan | Refusal> {
  const admitted = admit(deps, request);
  if (!admitted.ok) return admitted;

  let manifest: ArtifactManifest;
  try { manifest = verifyManifest(request.manifest); } catch { return refuse("ARTIFACT_INVALID", "The manifest is not valid or not sealed."); }
  if (manifest.engine !== "TERRAFORM" || manifest.mode !== "PROJECT") return refuse("ARTIFACT_INVALID", "The pilot seals a Terraform project manifest.");
  try {
    const binding = validateManifestForRequest(manifest, {
      engine: "TERRAFORM", mode: "PROJECT", target: { ...request.target }, unitHash: manifest.unitHash, engineVersion: request.resolved.engineVersion,
      providers: request.resolved.providers, lockFileSha256: request.resolved.lockFileSha256, files: captureProjectFiles(request.projectRoot),
      dependencies: request.resolved.dependencies, inputs: request.resolved.inputs, policyVersion: request.policyVersion,
    });
    if (!binding.ok) return refuse("ARTIFACT_INVALID", binding.message);
  } catch {
    return refuse("ARTIFACT_INVALID", "The project cannot be bound to the manifest.");
  }

  const gate = await checkEngineAndIdentities(createTerraformAdapter("TERRAFORM"), deps, manifest.engineVersion, admitted.contract, request.environment, kind);
  if (gate) return gate;

  // The directory prefix is the one the stale-directory sweep knows.
  const scratch = createPrivateDirectory("alz-preview-", deps.scratchParent);
  let snapshot: ImmutableSnapshot | undefined;
  const unregister = registerCleanup(() => { try { snapshot?.remove(); } finally { removeTree(scratch.path); } });
  try {
    try { snapshot = createImmutableSnapshot(request.projectRoot, manifest, deps.scratchParent); } catch {
      return refuse("ARTIFACT_INVALID", "The project cannot be snapshotted; it no longer matches the manifest.");
    }
    const input = {
      environment: request.environment, target: { ...request.target }, manifest, snapshotPath: snapshot.path, scratchDir: scratch.path,
      env: deps.env ?? process.env, policyVersion: request.policyVersion, engineVersion: manifest.engineVersion,
      pinned: admitted.contract.targets[request.environment], toolDirs: deps.toolDirs, now: deps.now,
    };
    const sealed = kind === "seal" ? await sealPlan(input) : planWithoutStoring(input);
    if (kind === "seal" || !sealed.ok) return sealed;
    // The apply adapter's own surface, up to the point where only `terraform apply` is left. Nothing is applied.
    const session = openSession({
      scratchDir: scratch.path, env: deps.env ?? process.env, toolDirs: deps.toolDirs, manifest,
      isAllowed: (args) => isAllowedApplyArgv("terraform", args), profile: TERRAFORM_APPLY_PROFILE,
    });
    const backendConfigPath = join(scratch.path, APPLY_BACKEND_CONFIG_FILE);
    const unregisterSecrets = registerCleanup(() => rmSync(backendConfigPath, { force: true }));
    try {
      prepareApplyEngine(session, snapshot.path, manifest.engineVersion, request.target, admitted.contract.targets[request.environment], deps.env ?? process.env, backendConfigPath);
    } finally {
      unregisterSecrets();
      rmSync(backendConfigPath, { force: true });
      removeTree(session.work);
    }
    return sealed;
  } catch (error) {
    return refuse("ARTIFACT_INVALID", kind === "qualify"
      ? "The qualification run failed (" + codeOf(error) + "). Engine output is withheld because it can hold secrets."
      : "The plan could not be sealed. Engine output is withheld because plan and state output can hold secrets.");
  } finally {
    unregister();
    try { snapshot?.remove(); } finally { removeTree(scratch.path); }
  }
}

/**
 * The real-engine qualification run (`./alz apply qualify`), DEV only: the
 * seal's steps with a throwaway plan that is never stored, then the apply
 * adapter's init with the STATE_WRITE backend configuration, workspace and
 * state serial. It applies nothing. It returns the adapters it exercised; the
 * CLI writes their evidence after the person attests identity separation,
 * which only cloud-side logs can show.
 */
export async function qualifyApply(request: SealRequest, deps: SealDeps):
  Promise<{ ok: true; engineVersion: string; terraformSha256: string; adapters: AdapterDescriptor[] } | Refusal> {
  if (request.environment !== "DEV") return refuse("ARTIFACT_INVALID", "Qualification runs against the DEV target only.");
  const result = await planAgainstTarget(request, deps, "qualify");
  if (!result.ok) return result;
  const terraformSha256 = terraformBinarySha256(deps.toolDirs, deps.env ?? process.env);
  if (terraformSha256 === undefined) return refuse("ARTIFACT_INVALID", "The terraform binary that ran could not be read to record its hash.");
  return { ok: true, engineVersion: request.resolved.engineVersion, terraformSha256, adapters: [createTerraformAdapter("TERRAFORM"), APPLY_ADAPTER] };
}

/** The backend binding: the storage account, container and key init saved must be the contract's `<storage-account>/<container>/<key>`, so the project's own backend block cannot aim state somewhere else. */
function assertBackendInContract(work: string, pinned: PilotTarget): void {
  let saved: unknown;
  try {
    const file = join(work, ".terraform", "terraform.tfstate");
    if (!lstatSync(file).isFile() || lstatSync(file).size > 1_048_576) return stop("BACKEND_UNREADABLE");
    saved = JSON.parse(readFileSync(file, "utf8"));
  } catch { return stop("BACKEND_UNREADABLE"); }
  const backend = isRecord(saved) && isRecord(saved.backend) ? saved.backend : {};
  const config = isRecord(backend.config) ? backend.config : {};
  const parts = [config.storage_account_name, config.container_name, config.key];
  if (backend.type !== "azurerm" || !parts.every((part) => typeof part === "string") || parts.join("/") !== pinned.backend) stop("BACKEND_NOT_IN_CONTRACT");
}

/**
 * The apply's workspace: init as STATE_WRITE with the partial backend
 * configuration (written 0600, removed as soon as init ends), the target's
 * workspace, and the state serial read as STATE. Throws a code if anything is
 * off, and refuses to go on if the runner would drop a variable of the APPLY
 * identity, because an apply cannot be undone.
 */
function prepareApplyEngine(
  session: EngineSession, snapshotPath: string, engineVersion: string, target: ResolvedTarget, pinned: PilotTarget, env: NodeJS.ProcessEnv, backendConfigPath: string,
): string {
  prepareWorkspace(session, {
    snapshotPath, engineVersion, target, initArgv: APPLY_INIT_ARGV, stateIdentity: "STATE_WRITE",
    beforeInit: () => writeFileSync(backendConfigPath, backendConfig(env), { mode: 0o600, flag: "wx" }),
    afterInit: () => rmSync(backendConfigPath, { force: true }),
  });
  assertBackendInContract(session.work, pinned);
  const serial = parseStateSerial(session.step(STATE_PULL_ARGV, "STATE", true)) ?? stop("STATE_SERIAL_UNREADABLE");
  if (session.refused("APPLY", APPLY_PROFILE).length > 0) stop("ENVIRONMENT_REFUSED");
  return serial;
}

// --- applying ----------------------------------------------------------------------------------------------

/**
 * A real apply outlives the runner's two-minute default, and killing one
 * partway is the worst outcome, so it gets its own reviewed limits. Its output
 * is held in memory only, classified by exit code and state serial, and dropped.
 * Every step uses the apply profile: no CLI configuration file or plugin cache
 * can redirect where providers are installed from.
 */
const APPLY_PROFILE = { ...TERRAFORM_APPLY_PROFILE, timeoutMs: 30 * 60_000, maxOutputBytes: LARGE_OUTPUT_BYTES };
const PLAN_FILE = "alz-apply.tfplan";
const RECOVERY_PURPOSE = "apply-recovery";
const yieldToSignals = (): Promise<void> => new Promise((done) => { setTimeout(() => { setImmediate(done); }, 0); });

/**
 * Moves the files Terraform leaves behind after a failed apply into the
 * encrypted vault before the scratch directory goes: they can be the only record of what it did.
 * The evidence carries their count and the hash of the stored record, never contents. The same-uid operator
 * holds the evidence key (docs/act-pilot-apply.md), so this protects the files at rest from other accounts and
 * from backups, not from the operator. Returns what to record, or why nothing was kept.
 */
async function keepRecoveryFiles(work: string, artifactSha256: string): Promise<{ recovery?: NonNullable<ApplyEvidence["recovery"]>; lost?: true }> {
  const files: { name: string; base64: string }[] = [];
  for (const name of RECOVERY_FILES) {
    try {
      if (lstatSync(join(work, name)).isFile()) files.push({ name, base64: readFileSync(join(work, name)).toString("base64") });
    } catch { /* not there */ }
  }
  if (files.length === 0) return {};
  const record = { schemaVersion: 1, artifactSha256, files };
  try {
    await writeEncryptedEvidence(RECOVERY_PURPOSE, artifactSha256, record);
  } catch {
    return { lost: true };
  }
  return { recovery: { files: files.length, sha256: sha256(canonicalJson(record as never)) } };
}

const MESSAGES: Record<Exclude<ApplyOutcome, "SUCCEEDED">, string> = {
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
};

const TOKEN_FILE = /^\/[A-Za-z0-9._/-]{1,512}$/;

/**
 * The partial backend configuration init saves: the STATE_WRITE principal's
 * client id, tenant, subscription and token file path. Never a secret value, and
 * every value is checked against a strict pattern before it is written into
 * HCL. The apply process then needs only the APPLY identity for the provider.
 */
function backendConfig(env: NodeJS.ProcessEnv): string {
  const variables = identityVariables(env, "STATE_WRITE");
  const pick = (name: string, ok: RegExp): string => {
    const value = variables.get(name);
    return value !== undefined && ok.test(value) ? value : stop("STATE_WRITE_BACKEND_CONFIG_INVALID");
  };
  return [
    "use_oidc = true",
    `client_id = "${pick("ARM_CLIENT_ID", SAFE_VALUE)}"`,
    `tenant_id = "${pick("ARM_TENANT_ID", GUID)}"`,
    `subscription_id = "${pick("ARM_SUBSCRIPTION_ID", GUID)}"`,
    `oidc_token_file_path = "${pick("ARM_OIDC_TOKEN_FILE", TOKEN_FILE)}"`,
    "",
  ].join("\n");
}

/**
 * Applies a sealed plan, exactly as approved. In order and fail closed: the
 * pilot contract enables ACT, the kill switch is off, a person invoked it, the
 * target is the contract's, the sealed plan verifies, it was not applied
 * before, production was promoted from a successful DEV apply of the same
 * release, the approvals verify, the apply adapter is qualified by real-engine
 * evidence, the four identities are configured, separate and aimed at the
 * contract's tenant and subscription, the artifact is reserved in the ledger,
 * the kill switch is checked once more, the approvals are consumed, and only
 * then `terraform apply <planfile>`, which is watched and stoppable while it
 * runs.
 */
export async function runApply(request: ApplyRequest, deps: ApplyDeps): Promise<ApplyResult> {
  const now = deps.now ?? (() => new Date());
  const evidenceDir = deps.evidenceDir ?? DEFAULT_EVIDENCE_DIR;
  const env = deps.env ?? process.env;

  // 1-4. Contract, kill switch, a human, the contract's target.
  if (!isRecord(request)) return refuse("HUMAN_INVOCATION_REQUIRED", "An apply is run by a person.");
  const admitted = admit(deps, request);
  if (!admitted.ok) return admitted;
  const { contract } = admitted;

  // 5. The sealed plan hashes to its artifact, and is the plan for this environment, target and manifest.
  const loaded = verifySealedPlan(request.sealedPlan);
  if (!loaded.ok) return loaded;
  const { sealed, planBytes } = loaded;
  if (sealed.environment !== request.environment || !sameTarget(sealed.target, request.target)) {
    return refuse("ARTIFACT_INVALID", "The sealed plan was sealed for another environment or target.");
  }
  let manifest: ArtifactManifest;
  try { manifest = verifyManifest(request.manifest); } catch { return refuse("ARTIFACT_INVALID", "The manifest is not valid or not sealed."); }
  if (manifest.engine !== "TERRAFORM" || manifest.mode !== "PROJECT" || manifest.manifestHash !== sealed.manifestHash ||
    releaseIdentityOf(manifest) !== sealed.releaseIdentity || !sameTarget(manifest.target, sealed.target) ||
    manifest.engineVersion !== sealed.engineVersion || manifest.policyVersion !== sealed.policyVersion) {
    return refuse("ARTIFACT_TAMPERED", "The manifest is not the one this plan was sealed against. Seal and approve a new plan.");
  }

  // 6. Once. 7. Production promotes the qualified release.
  const fresh = requireNotApplied(sealed.artifactSha256, evidenceDir);
  if (!fresh.ok) return fresh;
  const promoted = await requirePromotionEvidence(request.environment, sealed.releaseIdentity, evidenceDir);
  if (!promoted.ok) return promoted;

  // 8. Authenticated approvals bound to this artifact, environment and target. Verifying consumes nothing.
  const nonces = deps.nonces ?? openNonceStore();
  const verdict = verifyApprovalSet({
    approvals: request.approvals, artifactSha256: sealed.artifactSha256, environment: sealed.environment, target: sealed.target,
    contract, now: now(), nonces,
  });
  if (!verdict.ok) return refuse(verdict.code, verdict.message);

  // 9-10. The apply adapter is qualified by real-engine evidence; four separate identities aimed at this target.
  const gate = await checkEngineAndIdentities(APPLY_ADAPTER, deps, sealed.engineVersion, contract, sealed.environment, "apply");
  if (gate) return gate;

  let holding = false;
  let engineStarted = false;
  // From here a stop signal is this run's to handle: it ends the engine gracefully, escalates, and finalizes the
  // evidence and the ledger. Exiting from a signal handler instead would orphan the engine and strand the reservation.
  let interrupted = false;
  const releaseSignals = interceptStopSignals(() => { interrupted = true; });
  const interruptedBeforeEngine = (): Refusal | undefined => interrupted
    ? refuse("APPLY_FAILED", "The apply was interrupted by a signal before the engine started. Nothing was applied and no approval was consumed.")
    : undefined;
  // The plaintext plan and the backend configuration are removed first, and by their own remover, so a signal
  // handler that fails halfway through the tree removal cannot leave them behind. (A SIGKILL cannot be handled;
  // the next run's stale-directory sweep removes the scratch directory.)
  const scratch = createPrivateDirectory("alz-preview-", deps.scratchParent);
  const planPath = join(scratch.path, PLAN_FILE);
  const backendConfigPath = join(scratch.path, APPLY_BACKEND_CONFIG_FILE);
  const removeSecrets = (): void => {
    for (const path of [planPath, backendConfigPath, join(scratch.path, SEAL_PLAN_FILE)]) rmSync(path, { force: true });
  };
  const unregisterSecrets = registerCleanup(removeSecrets);
  let snapshot: ImmutableSnapshot | undefined;
  const unregister = registerCleanup(() => { try { snapshot?.remove(); } finally { removeTree(scratch.path); } });
  try {
    // 11. Reserve the artifact before the engine exists. Two runs with different approvals cannot both pass this create.
    const reserved = await reserveArtifact(sealed.artifactSha256, evidenceDir, now());
    if (!reserved.ok) return reserved;
    holding = true;
    const early = interruptedBeforeEngine();
    if (early) return early;

    // The project as sealed, read-only, then a writable copy for init. Nothing here changes state.
    try { snapshot = createImmutableSnapshot(request.projectRoot, manifest, deps.scratchParent); } catch {
      return refuse("ARTIFACT_TAMPERED", "The project no longer matches the manifest the plan was sealed against. Seal and approve a new plan.");
    }
    const session = openSession({
      scratchDir: scratch.path, env, toolDirs: deps.toolDirs, manifest, isAllowed: (args) => isAllowedApplyArgv("terraform", args),
      profile: TERRAFORM_APPLY_PROFILE,
    });

    let serialBefore: string;
    let derived: SealedPlan["changes"];
    try {
      serialBefore = prepareApplyEngine(session, snapshot.path, sealed.engineVersion, sealed.target, contract.targets[sealed.environment], env, backendConfigPath);
      // The change list the approvers read must describe this plan: derive it again from the decrypted bytes, as sealing did.
      derived = rederiveChanges({ scratchDir: scratch.path, env, toolDirs: deps.toolDirs, manifest, planBytes, pinned: contract.targets[sealed.environment] });
    } catch (error) {
      const code = codeOf(error);
      if (/_NOT_IN_CONTRACT$/.test(code)) {
        return refuse("TARGET_NOT_IN_CONTRACT", "The backend or provider the project configures is not the contract's target (" + code +
          "). Nothing was applied and no approval was consumed. Engine output is withheld.");
      }
      return refuse("APPLY_FAILED", "The apply could not start (" + code + "). Nothing was applied and no approval was consumed. Engine output is withheld.");
    }
    if (canonicalJson(derived as never) !== canonicalJson(sealed.changes as never)) {
      return refuse("ARTIFACT_TAMPERED", "The change list in the sealed record is not the change list of its plan file. " +
        "Nothing was applied and no approval was consumed. Seal and approve a new plan.");
    }

    // 12. Everything that can change while the engine is prepared is read again immediately before the approvals are
    // consumed: a signal that arrived during the blocking steps, the contract and its pin, the kill switch, the
    // allowlist and each approval's expiry.
    await yieldToSignals();
    const late = interruptedBeforeEngine();
    if (late) return late;
    const readmitted = admit(deps, request);
    if (!readmitted.ok) return readmitted;
    const confirmed = verifyApprovalSet({
      approvals: request.approvals, artifactSha256: sealed.artifactSha256, environment: sealed.environment, target: sealed.target,
      contract: readmitted.contract, now: now(), nonces,
    });
    if (!confirmed.ok) return refuse(confirmed.code, confirmed.message);

    // 13. Approvals are consumed before the engine runs.
    const consumed = consumeApprovals(nonces, request.approvals);
    if (!consumed.ok) return refuse(consumed.code, consumed.message);

    // 14. Apply exactly the sealed plan file. The runner reads the kill switch right before it spawns and then every second.
    // From here the approvals are spent: a failure before the engine exists is a defined refusal, never "nothing was spent".
    const unstarted = (error: unknown): Refusal => refuse("APPROVALS_SPENT", "The apply could not start (" + codeOf(error) + ") after the approvals were consumed. " +
      "Nothing was applied. The approvals are spent and the sealed plan was given back: obtain new approvals for it. Engine output is withheld.");
    const startedAt = now().toISOString();
    let applied: Awaited<ReturnType<EngineSession["stoppable"]>>;
    try {
      writeFileSync(planPath, planBytes, { mode: 0o600, flag: "wx" });
      engineStarted = true;
      applied = await session.stoppable(APPLY_ARGV, "APPLY", APPLY_PROFILE, {
        stopWhen: () => isKillSwitchActive(readmitted.contract), pollMs: deps.killPollMs, graceMs: deps.killGraceMs, forwardSignals: true,
        // The plaintext plan goes the moment a stop is asked for, not after the grace period.
        onStop: removeSecrets,
      });
    } catch (error) {
      // The runner's promise only resolves once the child exists, so a throw means no engine ran.
      engineStarted = false;
      return unstarted(error);
    }
    rmSync(planPath, { force: true });
    if (applied.notStarted) {
      engineStarted = false;
      return refuse("KILL_SWITCH_AFTER_APPROVALS", "The kill switch became active as the apply was about to start. Nothing was applied. " +
        "The approvals were consumed: obtain new approvals for this sealed plan.");
    }
    let serialAfter: string | undefined;
    try { serialAfter = parseStateSerial(session.step(STATE_PULL_ARGV, "STATE", true)); } catch { serialAfter = undefined; }
    const end = classifyApply({ exitCode: applied.exitCode, stderr: applied.stderr, serialBefore, serialAfter, stopped: applied.stopped });
    const outcome: ApplyOutcome = "stale" in end ? "FAILED_NO_CHANGE" : end.outcome;
    const kept = outcome === "SUCCEEDED" ? {} : await keepRecoveryFiles(session.work, sealed.artifactSha256);

    // 15. Evidence replaces the reservation, whatever the outcome.
    const evidence: ApplyEvidence = {
      schemaVersion: 1, environment: sealed.environment, target: { ...sealed.target }, artifactSha256: sealed.artifactSha256,
      manifestHash: sealed.manifestHash, releaseIdentity: sealed.releaseIdentity, approvals: confirmed.approvers,
      adapter: { adapterVersion: APPLY_ADAPTER.adapterVersion, argvDigest: APPLY_ADAPTER.argvDigest },
      toolVersions: { engine: sealed.engineVersion }, outcome, exitCode: applied.exitCode, startedAt, finishedAt: now().toISOString(),
      authority: APPLY_AUTHORITY, ...(kept.recovery ? { recovery: kept.recovery } : {}),
    };
    const lost = kept.lost ? " Terraform left errored.tfstate or crash.log, and they could not be saved to the vault; they were removed with the scratch directory." : "";
    let written: ApplyResult;
    try { written = await finalizeArtifact(evidence, evidenceDir); } catch {
      written = refuse("EVIDENCE_REJECTED", "The evidence could not be written");
    }
    if (!written.ok) {
      return { ...written, outcome, message: written.message + ". The apply ended " + outcome + "; record that by hand, because no evidence exists for it. The artifact stays reserved." + lost };
    }
    if (outcome === "SUCCEEDED") return written;
    if ("stale" in end) {
      return { ok: false, code: "PLAN_STALE", outcome, message: "The saved plan is stale: state changed after it was sealed. Nothing was applied. Seal a new preview and obtain new approvals." };
    }
    return { ok: false, code: "APPLY_FAILED", outcome, message: MESSAGES[outcome as Exclude<ApplyOutcome, "SUCCEEDED">] + lost };
  } finally {
    // The decrypted plan, the work copy (provider binaries, configuration) and the snapshot go before anything returns.
    releaseSignals();
    unregisterSecrets();
    unregister();
    removeSecrets();
    try { snapshot?.remove(); } finally { removeTree(scratch.path); }
    // The engine never ran and the reservation is ours: give the artifact back. Once it has run, the reservation stays until evidence replaces it.
    if (holding && !engineStarted) await releaseReservation(sealed.artifactSha256, evidenceDir);
  }
}
