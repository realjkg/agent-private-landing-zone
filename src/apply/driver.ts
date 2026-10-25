import { registerCleanup, removeTree } from "../teardown/driver/cleanup.js";
import { checkHumanInvocation, isRecord } from "../teardown/driver/human.js";
import { engineActivation, type QualificationRecord } from "../teardown/driver/qualification.js";
import type { AdapterDescriptor, EngineAdapter, HumanInvocation, ResolvedInputs, ResolvedTarget } from "../teardown/driver/types.js";
import { canonicalJson, validateManifestForRequest, verifyManifest, type ArtifactManifest } from "../teardown/manifest.js";
import { captureProjectFiles, createImmutableSnapshot, type ImmutableSnapshot } from "../teardown/snapshot.js";
import { forbiddenIdentityVariables } from "../tools/identity.js";
import { writeEncryptedEvidence } from "../evidence/vault.js";
import { interceptStopSignals } from "../tools/process.js";
import { createPrivateDirectory } from "../tools/private-workdir.js";
import { consumeApprovals, verifyApprovalSet } from "./approval.js";
import {
  DEFAULT_EVIDENCE_DIR, contractRefusal, isKillSwitchActive, loadPilotContract, loadQualificationRecords, pilotContractSha256, repoPaths, requireNotApplied, requirePromotionEvidence,
  targetForEnvironment, verifyApplyQualification, type Refusal,
} from "./contract.js";
import { COMMIT } from "./constants.js";
import { codeOf } from "./engine.js";
import { acceptsManifest, engineOf, type EngineSpec, type RecoveryFile } from "./engine-spec.js";
import { APPLY_AUTHORITY } from "./evidence.js";
import { attestedClientId, checkApplyIdentities, verifyIdentityTargets } from "./identities.js";
import { channelMismatchMessage } from "./channel.js";
import { finalizeArtifact, releaseReservation, reserveArtifact } from "./ledger.js";
import { openNonceStore, type NonceStore } from "./nonces.js";
import { specOf, type ProviderSpec } from "./provider.js";
import { engineBinaryChange, planWithoutStoring, releaseIdentityOf, sealPlan, verifySealedPlan, type LoadedPlan, type SealResult } from "./seal.js";
import { sha256 } from "../util/sha256.js";
import type { ApplyEnvironment, ApplyEvidence, ApplyOutcome, ApplyRefusalCode, ApplyResult, PilotChannel, PilotContract, PlanChange, PreviewProvenance, SignedApproval } from "./types.js";

/**
 * The human-invoked apply driver (docs/act-pilot-plan.md). The operator
 * authorizes, the driver enforces, and agents never initiate. Each check below
 * fails closed and nothing after it runs; the engine is reached only through
 * `runApply`, and the engine's own execution (`terraform apply`, `execute-change-set`) is the last step of the last stage. This
 * module is imported by the CLI only (src/cli/apply.ts, which the console wizard's
 * adapter src/cli/ui-channel.ts drives): nothing under src/tools, src/agent or
 * src/operations reaches it, and the console's job table never runs an apply.
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
  /** How often the kill switch is read while the engine runs, and how long the engine gets to stop. Tests shorten both. */
  killPollMs?: number;
  killGraceMs?: number;
  /**
   * The product source commit this run comes from, established by the caller (the CLI reads the git checkout, refusing
   * uncommitted changes, or the container's build stamp). The driver starts no process to find it: without a full commit
   * id it seals, qualifies and applies nothing (`SOURCE_UNVERIFIED`), and it applies a plan only from the commit that sealed it.
   */
  sourceCommit?: string;
};
type SealDeps = Pick<ApplyDeps, "qualificationDir" | "contractPath" | "contractPinPath" | "env" | "now" | "scratchParent" | "toolDirs" | "sourceCommit">;

const SOURCE_UNVERIFIED = "The product source commit could not be established, so nothing was run or consumed. Run from a git checkout with every change committed, or from the packaged image built from a commit.";
/** The caller's source commit when it is a full commit id, else undefined. */
const knownSource = (deps: { sourceCommit?: string }): string | undefined =>
  typeof deps.sourceCommit === "string" && COMMIT.test(deps.sourceCommit) ? deps.sourceCommit : undefined;

export type ApplyRequest = {
  /** Built from a real terminal prompt by the CLI. An agent cannot produce one. */
  invocation: HumanInvocation;
  environment: ApplyEnvironment;
  target: ResolvedTarget;
  /** Who is invoking: the terminal CLI or the console adapter. The caller sets it (default `CLI`); a plan sealed in the other channel is refused with `CHANNEL_MISMATCH` before anything is consumed. */
  channel?: PilotChannel;
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
  /** Sealed into the plan and its hash (default `CLI`). The caller sets it, never a user flag. */
  channel?: PilotChannel;
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
  { ok: true; contract: PilotContract; spec: ProviderSpec } | Refusal {
  const contract = loadPilotContract(deps.contractPath, deps.contractPinPath);
  if ("reason" in contract) return contractRefusal(contract);
  if (isKillSwitchActive(contract)) {
    return refuse("KILL_SWITCH_ACTIVE", "The kill switch is active. Nothing runs until the owner removes it.");
  }
  const human = checkHumanInvocation(request, "A pilot apply, seal or qualification run");
  if (human) return refuse("HUMAN_INVOCATION_REQUIRED", human.message);
  const pinned = targetForEnvironment(contract, request.environment, request.target);
  return pinned.ok ? { ok: true, contract, spec: specOf(contract) } : pinned;
}

/**
 * The engine qualification and the identity checks, in the order sealing and
 * applying share. This is the one place identities are judged: all the engine's
 * configured and separate, none for an identity this system never reads, and
 * every credential naming the contract's account. For an
 * apply, the adapter's qualification record must also be backed by real-engine
 * evidence in the vault. `engineActivation` reads only an adapter's engine,
 * version and argv digest, which a descriptor carries.
 */
/**
 * Whether real-engine qualification evidence in the vault covers this adapter, engine version and engine program for
 * the contract's target: the apply's gate, and what a seal records about its preview. The one definition of both.
 */
async function backedQualification(
  adapter: AdapterDescriptor, deps: SealDeps, engineVersion: string, binarySha256: string | undefined,
  contract: PilotContract, spec: ProviderSpec, environment: ApplyEnvironment,
): Promise<{ ok: true; record: QualificationRecord } | Refusal> {
  const engine = engineOf(contract);
  const env = deps.env ?? process.env;
  const vault = deps.qualificationDir ?? repoPaths().qualifications;
  const activation = engineActivation(engine.id, await loadQualificationRecords(spec, vault), [adapter as unknown as EngineAdapter], engineVersion);
  if (!activation.enabled) return refuse("ENGINE_NOT_QUALIFIED", activation.reason);
  const attested = await verifyApplyQualification(activation.record, vault,
    { adapterVersion: adapter.adapterVersion, argvDigest: adapter.argvDigest, engineVersion },
    {
      dev: contract.targets.DEV, now: (deps.now ?? (() => new Date()))(), terraformSha256: binarySha256,
      stateWriteClientId: attestedClientId(env, engine.attests[0], spec), applyClientId: attestedClientId(env, engine.attests[1], spec),
      principalsPerEnvironment: spec.principalPerEnvironment && environment !== "DEV",
    }, spec);
  return attested.ok ? { ok: true, record: activation.record } : attested;
}

async function checkEngineAndIdentities(
  adapter: AdapterDescriptor, deps: SealDeps, engineVersion: string,
  contract: PilotContract, spec: ProviderSpec, environment: ApplyEnvironment, kind: "seal" | "apply" | "qualify",
): Promise<Refusal | undefined> {
  const engine = engineOf(contract);
  // Qualifying is how a record comes to exist, so it is the one run that needs none. Identities and targets are judged the same.
  if (kind === "seal") {
    const vault = deps.qualificationDir ?? repoPaths().qualifications;
    const activation = engineActivation(engine.id, await loadQualificationRecords(spec, vault), [adapter as unknown as EngineAdapter], engineVersion);
    if (!activation.enabled) return refuse("ENGINE_NOT_QUALIFIED", activation.reason);
  } else if (kind === "apply") {
    const attested = await backedQualification(adapter, deps, engineVersion, engine.binarySha256(deps.toolDirs, deps.env ?? process.env), contract, spec, environment);
    if (!attested.ok) return attested;
  }
  const env = deps.env ?? process.env;
  const identities = checkApplyIdentities(env, spec, engine.identities);
  if (!identities.ok) return refuse(identities.code, identities.message);
  const forbidden = forbiddenIdentityVariables(env);
  if (forbidden.length > 0) {
    return refuse("IDENTITY_NOT_CONFIGURED", "Variables for an identity this system never reads are set (" + forbidden.join(", ") +
      "). Remove them; nothing will use them, and the engine's identities are the only credentials a run accepts.");
  }
  const targets = verifyIdentityTargets(contract, environment, env, spec, engine.identities);
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
function planAgainstTarget(request: SealRequest, deps: SealDeps, kind: "qualify"): Promise<{ ok: true; engine: EngineSpec } | Refusal>;
async function planAgainstTarget(request: SealRequest, deps: SealDeps, kind: "seal" | "qualify"): Promise<SealResult | { ok: true; engine: EngineSpec } | Refusal> {
  const admitted = admit(deps, request);
  if (!admitted.ok) return admitted;
  const engine = engineOf(admitted.contract);
  const sourceCommit = knownSource(deps);
  if (!sourceCommit) return refuse("SOURCE_UNVERIFIED", SOURCE_UNVERIFIED);

  let manifest: ArtifactManifest;
  try { manifest = verifyManifest(request.manifest); } catch { return refuse("ARTIFACT_INVALID", "The manifest is not valid or not sealed."); }
  if (!acceptsManifest(engine, manifest)) return refuse("ARTIFACT_INVALID", "The pilot seals a project manifest of the contract's engine.");
  try {
    const binding = validateManifestForRequest(manifest, {
      engine: engine.id, mode: engine.manifestMode, target: { ...request.target }, unitHash: manifest.unitHash, engineVersion: request.resolved.engineVersion,
      providers: request.resolved.providers, lockFileSha256: request.resolved.lockFileSha256, files: captureProjectFiles(request.projectRoot),
      dependencies: request.resolved.dependencies, inputs: request.resolved.inputs, policyVersion: request.policyVersion,
    });
    if (!binding.ok) return refuse("ARTIFACT_INVALID", binding.message);
  } catch {
    return refuse("ARTIFACT_INVALID", "The project cannot be bound to the manifest.");
  }

  const gate = await checkEngineAndIdentities(engine.previewAdapter(), deps, manifest.engineVersion, admitted.contract, admitted.spec, request.environment, kind);
  if (gate) return gate;

  // Which program makes this preview, and whether qualification evidence stands behind it: read once, before planning, and sealed.
  const engineBinarySha256 = engine.binarySha256(deps.toolDirs, deps.env ?? process.env);
  if (engineBinarySha256 === undefined) return refuse("ARTIFACT_INVALID", "The engine program cannot be found or read, so the preview cannot record which program made it.");
  const backed = await backedQualification(engine.previewAdapter(), deps, manifest.engineVersion, engineBinarySha256, admitted.contract, admitted.spec, request.environment);
  const provenance: PreviewProvenance = {
    engineBinarySha256,
    qualification: backed.ok
      ? { state: "QUALIFIED", evidenceHash: backed.record.evidenceHash, qualifiedAt: backed.record.qualifiedAt }
      : { state: "UNQUALIFIED", reason: backed.message },
  };

  // The directory prefix is the one the stale-directory sweep knows.
  const scratch = createPrivateDirectory("alz-preview-", deps.scratchParent);
  let snapshot: ImmutableSnapshot | undefined;
  const unregister = registerCleanup(() => { try { snapshot?.remove(); } finally { removeTree(scratch.path); } });
  try {
    try { snapshot = createImmutableSnapshot(request.projectRoot, manifest, deps.scratchParent); } catch {
      return refuse("ARTIFACT_INVALID", "The project cannot be snapshotted; it no longer matches the manifest.");
    }
    const input = {
      engine, environment: request.environment, target: { ...request.target }, manifest, snapshotPath: snapshot.path, scratchDir: scratch.path,
      channel: request.channel ?? "CLI", env: deps.env ?? process.env, policyVersion: request.policyVersion, engineVersion: manifest.engineVersion,
      pinned: admitted.contract.targets[request.environment]!, spec: admitted.spec, contractSha256: pilotContractSha256(admitted.contract), sourceCommit, provenance, toolDirs: deps.toolDirs, now: deps.now,
      embedStateWrite: admitted.contract.embedStateWrite === true,
    };
    // An engine with its own qualification run (CDK: read-only steps, no change set) does that and nothing else.
    if (kind === "qualify" && engine.qualify) {
      engine.qualify(input);
      return { ok: true, engine };
    }
    if (kind === "seal") return await sealPlan(input);
    const throwaway = planWithoutStoring(input);
    if (!throwaway.ok) return throwaway;
    // The apply adapter's own surface, up to the point where only the apply itself is left. Nothing is applied.
    const run = engine.openApply({
      scratchDir: scratch.path, env: deps.env ?? process.env, toolDirs: deps.toolDirs, manifest, pinned: input.pinned, spec: admitted.spec,
      target: request.target, engineVersion: manifest.engineVersion,
    });
    const unregisterSecrets = registerCleanup(run.removeSecrets);
    try {
      run.prepare(snapshot.path);
    } finally {
      unregisterSecrets();
      run.removeSecrets();
    }
    return { ok: true, engine };
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
 * adapter's preparation (for Terraform: init with the STATE_WRITE backend
 * configuration, workspace and state serial). It applies nothing. It returns the adapters it exercised; the
 * CLI writes their evidence after the person attests identity separation,
 * which only cloud-side logs can show.
 */
export async function qualifyApply(request: SealRequest, deps: SealDeps):
  Promise<{ ok: true; engineVersion: string; terraformSha256: string; adapters: AdapterDescriptor[] } | Refusal> {
  if (request.environment !== "DEV") return refuse("ARTIFACT_INVALID", "Qualification runs against the DEV target only.");
  const result = await planAgainstTarget(request, deps, "qualify");
  if (!result.ok) return result;
  const { engine } = result;
  const binarySha256 = engine.binarySha256(deps.toolDirs, deps.env ?? process.env);
  if (binarySha256 === undefined) return refuse("ARTIFACT_INVALID", "The engine binary that ran could not be read to record its hash.");
  return { ok: true, engineVersion: request.resolved.engineVersion, terraformSha256: binarySha256, adapters: [engine.previewAdapter(), engine.applyAdapter] };
}

// --- applying ----------------------------------------------------------------------------------------------

const RECOVERY_PURPOSE = "apply-recovery";
const yieldToSignals = (): Promise<void> => new Promise((done) => { setTimeout(() => { setImmediate(done); }, 0); });

/**
 * Moves the files the engine leaves behind after a failed apply into the
 * encrypted vault before the scratch directory goes: they can be the only record of what it did.
 * The evidence carries their count and the hash of the stored record, never contents. The same-uid operator
 * holds the evidence key (docs/act-pilot-apply.md), so this protects the files at rest from other accounts and
 * from backups, not from the operator. Returns what to record, or why nothing was kept.
 */
async function keepRecoveryFiles(files: RecoveryFile[], artifactSha256: string): Promise<{ recovery?: NonNullable<ApplyEvidence["recovery"]>; lost?: true }> {
  if (files.length === 0) return {};
  const record = { schemaVersion: 1, artifactSha256, files };
  try {
    await writeEncryptedEvidence(RECOVERY_PURPOSE, artifactSha256, record);
  } catch {
    return { lost: true };
  }
  return { recovery: { files: files.length, sha256: sha256(canonicalJson(record as never)) } };
}

/**
 * Applies a sealed plan, exactly as approved. In order and fail closed: the
 * pilot contract enables ACT, the kill switch is off, a person invoked it, the
 * target is the contract's, the sealed plan verifies, it was not applied
 * before, production was promoted from a successful DEV apply of the same
 * release, the approvals verify, the apply adapter is qualified by real-engine
 * evidence, the engine's identities are configured, separate and aimed at the
 * contract's account, the artifact is reserved in the ledger,
 * the kill switch is checked once more, the approvals are consumed, and only
 * then the engine applies the sealed artifact, watched and stoppable while it
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
  const { contract, spec } = admitted;
  const engine = engineOf(contract);

  // 5. The sealed plan hashes to its artifact, and is the plan for this environment, target and manifest.
  const loaded = verifySealedPlan(request.sealedPlan);
  if (!loaded.ok) return loaded;
  const { sealed, planBytes } = loaded;
  if (sealed.channel !== (request.channel ?? "CLI")) return refuse("CHANNEL_MISMATCH", channelMismatchMessage(sealed.channel));
  const running = knownSource(deps);
  if (!running) return refuse("SOURCE_UNVERIFIED", SOURCE_UNVERIFIED);
  if (running !== sealed.sourceCommit) {
    return refuse("SOURCE_CHANGED", "This plan was sealed from product commit " + sealed.sourceCommit.slice(0, 12) + ", but " + running.slice(0, 12) +
      " is running. Nothing was consumed. Apply from the commit that sealed it, or seal and approve a new plan.");
  }
  // The program that made the preview approvers signed, and no other. Checked before anything is reserved or consumed.
  const changedBinary = engineBinaryChange(sealed, engine.binarySha256(deps.toolDirs, env));
  if (changedBinary) return changedBinary;
  if (sealed.environment !== request.environment || !sameTarget(sealed.target, request.target) || sealed.contractSha256 !== pilotContractSha256(contract)) {
    return refuse("ARTIFACT_INVALID", "The sealed plan was sealed for another environment or target, or under another pilot contract.");
  }
  let manifest: ArtifactManifest;
  try { manifest = verifyManifest(request.manifest); } catch { return refuse("ARTIFACT_INVALID", "The manifest is not valid or not sealed."); }
  if (!acceptsManifest(engine, manifest) || manifest.manifestHash !== sealed.manifestHash ||
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

  // 9-10. The apply adapter is qualified by real-engine evidence; the engine's separate identities aimed at this target.
  const gate = await checkEngineAndIdentities(engine.applyAdapter, deps, sealed.engineVersion, contract, spec, sealed.environment, "apply");
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
  const run = engine.openApply({
    scratchDir: scratch.path, env, toolDirs: deps.toolDirs, manifest, pinned: contract.targets[sealed.environment]!, spec,
    target: sealed.target, engineVersion: sealed.engineVersion,
  });
  const unregisterSecrets = registerCleanup(run.removeSecrets);
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
    let derived: PlanChange[];
    try {
      run.prepare(snapshot.path);
      // The change list the approvers read must describe this plan: derive it again from the decrypted bytes, as sealing did.
      derived = run.rederive(planBytes);
    } catch (error) {
      const code = codeOf(error);
      // The sealed change set is no longer the one to run, or is not the one that was sealed: refused before any approval is consumed.
      if (code === "PLAN_STALE" || code === "ARTIFACT_TAMPERED") {
        return refuse(code, code === "PLAN_STALE"
          ? "The sealed plan is stale: what it was sealed against has changed. Nothing was applied and no approval was consumed. Seal a new preview and obtain new approvals."
          : "What the sealed plan names is not what the engine finds. Nothing was applied and no approval was consumed. Seal and approve a new plan.");
      }
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

    // 14. Apply exactly the sealed artifact. The runner reads the kill switch right before it spawns and then every second.
    // From here the approvals are spent: a failure before the engine exists is a defined refusal, never "nothing was spent".
    const unstarted = (error: unknown): Refusal => refuse("APPROVALS_SPENT", "The apply could not start (" + codeOf(error) + ") after the approvals were consumed. " +
      "Nothing was applied. The approvals are spent and the sealed plan was given back: obtain new approvals for it. Engine output is withheld.");
    const startedAt = now().toISOString();
    let applied: Awaited<ReturnType<typeof run.execute>>;
    try {
      applied = await run.execute(planBytes, { stopWhen: () => isKillSwitchActive(readmitted.contract), pollMs: deps.killPollMs, graceMs: deps.killGraceMs });
    } catch (error) {
      // An engine's execute throws only before the engine can exist (`EngineApplyRun.execute`), so a throw means nothing ran.
      return unstarted(error);
    }
    engineStarted = true;
    if (applied.notStarted) {
      engineStarted = false;
      return refuse("KILL_SWITCH_AFTER_APPROVALS", "The kill switch became active as the apply was about to start. Nothing was applied. " +
        "The approvals were consumed: obtain new approvals for this sealed plan.");
    }
    const end = await run.settle(applied);
    const outcome: ApplyOutcome = "stale" in end ? "FAILED_NO_CHANGE" : end.outcome;
    const kept = outcome === "SUCCEEDED" ? {} : await keepRecoveryFiles(run.recoveryFiles(), sealed.artifactSha256);

    // 15. Evidence replaces the reservation, whatever the outcome.
    const evidence: ApplyEvidence = {
      schemaVersion: 1, environment: sealed.environment, target: { ...sealed.target }, artifactSha256: sealed.artifactSha256,
      manifestHash: sealed.manifestHash, releaseIdentity: sealed.releaseIdentity, contractSha256: sealed.contractSha256, sourceCommit: sealed.sourceCommit, approvals: confirmed.approvers,
      adapter: { adapterVersion: engine.applyAdapter.adapterVersion, argvDigest: engine.applyAdapter.argvDigest },
      toolVersions: { engine: sealed.engineVersion }, outcome, exitCode: applied.exitCode, startedAt, finishedAt: now().toISOString(),
      authority: { ...APPLY_AUTHORITY, mutation: engine.mutation }, ...(kept.recovery ? { recovery: kept.recovery } : {}),
    };
    const lost = kept.lost ? engine.recoveryLostNote : "";
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
    return { ok: false, code: "APPLY_FAILED", outcome, message: engine.outcomeMessages[outcome as Exclude<ApplyOutcome, "SUCCEEDED">] + lost };
  } finally {
    // The decrypted plan, the work copy (provider binaries, configuration) and the snapshot go before anything returns.
    releaseSignals();
    unregisterSecrets();
    unregister();
    run.removeSecrets();
    try { snapshot?.remove(); } finally { removeTree(scratch.path); }
    // The engine never ran and the reservation is ours: give the artifact back. Once it has run, the reservation stays until evidence replaces it.
    if (holding && !engineStarted) await releaseReservation(sealed.artifactSha256, evidenceDir);
  }
}
