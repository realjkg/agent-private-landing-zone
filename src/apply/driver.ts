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
import { blueprintFromCloudFormationResources, blueprintFromTerraformStatePull } from "../observe/blueprint.js";
import { consumeApprovals, requesterPublicKey, verifyApprovalSet, verifyRequestSignature } from "./approval.js";
import { canonicalPublicKey } from "./contract.js";
import { buildCleanupProposal, computeProposalSha256, protectedDeletionIn, verifyCleanupProposal, type CleanupProposal } from "./cleanup-proposal.js";
import { pilotUnitOf } from "./unit.js";
import {
  DEFAULT_EVIDENCE_DIR, authorizationChanged, authorizeContract, contractRefusal, isKillSwitchActive, loadPilotContract, loadQualificationRecords, pilotContractSha256, repoPaths, requireNotApplied, requireNotExecuted,
  requirePromotionEvidence, targetForEnvironment, verifyApplyQualification, type Authorization, type Refusal,
} from "./contract.js";
import { COMMIT } from "./constants.js";
import { codeOf, leftBehindOf } from "./engine.js";
import { acceptsManifest, engineOf, type EngineCleanupRun, type EngineSpec, type RecoveryFile, type StateDocument } from "./engine-spec.js";
import { APPLY_AUTHORITY } from "./evidence.js";
import { attestedClientId, checkApplyIdentities, verifyIdentityTargets } from "./identities.js";
import { channelMismatchMessage } from "./channel.js";
import { finalizeArtifact, finalizeCleanup, releaseReservation, reserveArtifact } from "./ledger.js";
import { readAppliedEvidence } from "./live-record.js";
import { readBlueprintRecord, readObservationRecord, recordSha256, writeBlueprintRecord, type BlueprintRecord } from "./run-records.js";
import { openNonceStore, type NonceStore } from "./nonces.js";
import { specOf, type ProviderSpec } from "./provider.js";
import { engineBinaryChange, planWithoutStoring, releaseIdentityOf, sealPlan, verifySealedPlan, type LoadedPlan, type SealResult } from "./seal.js";
import { sha256 } from "../util/sha256.js";
import { isBackendPinRefusal } from "./backend-pin.js";
import type { ApplyEnvironment, ApplyEvidence, ApplyOutcome, ApplyRefusalCode, ApplyResult, CleanupEvidence, CleanupResult, PilotChannel, PilotContract, PlanChange, PreviewProvenance, SealedPlan, SignedApproval } from "./types.js";

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
  /** Where the pilot release contract, which carries the authorization, is read. Default: the repository's (src/apply/contract.ts). */
  contractPath?: string;
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
type SealDeps = Pick<ApplyDeps, "qualificationDir" | "contractPath" | "env" | "now" | "scratchParent" | "toolDirs" | "sourceCommit">;

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
  /**
   * Who requests the change: an allowlisted id and the private key of that very entry (the CLI reads the key file the
   * person names; never the environment). Required to seal; a qualification run has none. The id is bound into the
   * artifact hash and the key signs it, so every approver signs who requested (docs/act-pilot-plan.md, authority item 3).
   */
  requester?: { requesterId: string; privateKeyPem: string };
  manifest: ArtifactManifest;
  projectRoot: string;
  policyVersion: string;
  resolved: ResolvedInputs;
};

const refuse = (code: ApplyRefusalCode, message: string): Refusal => ({ ok: false, code, message });
const sameTarget = (a: ResolvedTarget, b: ResolvedTarget): boolean =>
  a.account === b.account && a.backend === b.backend && a.workspace === b.workspace;

/**
 * Contract enabled, kill switch off, a human, the contract's own target, and AUTHORIZED by the contract for this operation:
 * the first gates, shared by sealing, applying and cleaning up.
 */
function admit(deps: Pick<ApplyDeps, "contractPath">, request: { invocation: unknown; environment: ApplyEnvironment; target: ResolvedTarget }, operation: "APPLY" | "CLEANUP"):
  { ok: true; contract: PilotContract; spec: ProviderSpec; authorization: Authorization } | Refusal {
  const contract = loadPilotContract(deps.contractPath);
  if ("reason" in contract) return contractRefusal(contract);
  if (isKillSwitchActive(contract)) {
    return refuse("KILL_SWITCH_ACTIVE", "The kill switch is active. Nothing runs until the owner removes it.");
  }
  const human = checkHumanInvocation(request, "A pilot apply, seal or qualification run");
  if (human) return refuse("HUMAN_INVOCATION_REQUIRED", human.message);
  const pinned = targetForEnvironment(contract, request.environment, request.target);
  if (!pinned.ok) return pinned;
  const authorized = authorizeContract(contract, request.environment, operation);
  return authorized.ok ? { ok: true, contract, spec: specOf(contract), authorization: authorized.authorization } : authorized;
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
  contract: PilotContract, spec: ProviderSpec, environment: ApplyEnvironment, kind: "seal" | "apply" | "qualify" | "cleanup",
  ready?: { qualificationEvidenceHash: string | null },
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
    if (ready) ready.qualificationEvidenceHash = attested.record.evidenceHash;
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
  const admitted = admit(deps, request, "APPLY");
  if (!admitted.ok) return admitted;
  const engine = engineOf(admitted.contract);
  const sourceCommit = knownSource(deps);
  if (!sourceCommit) return refuse("SOURCE_UNVERIFIED", SOURCE_UNVERIFIED);
  // A seal is requested by an allowlisted key, checked before any engine runs: the id must be on the contract's allowlist (any
  // environment: the entry's environments govern approving) and the key handed in must be that entry's own.
  if (kind === "seal") {
    const requester = request.requester;
    if (!requester || typeof requester.requesterId !== "string" || typeof requester.privateKeyPem !== "string") {
      return refuse("REQUESTER_SIGNATURE_MISSING", "A plan is sealed by a requester: give the requester's allowlisted id and key file. Nothing ran.");
    }
    const entry = admitted.contract.approvers.find((a) => a.id === requester.requesterId);
    if (!entry) return refuse("REQUESTER_NOT_ALLOWED", "The requester is not on the contract's allowlist. Nothing ran.");
    const offered = requesterPublicKey(requester.privateKeyPem);
    if (offered === undefined || offered !== canonicalPublicKey(entry.publicKeyPem)) {
      return refuse("REQUESTER_KEY_MISMATCH", "The key given is not the allowlisted key of requester " + entry.id + ". Nothing ran.");
    }
  }

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
      pinned: admitted.contract.targets[request.environment]!, spec: admitted.spec, contractSha256: pilotContractSha256(admitted.contract), authorizationSha256: admitted.authorization.authorizationSha256, sourceCommit, provenance, toolDirs: deps.toolDirs, now: deps.now,
      embedStateWrite: admitted.contract.embedStateWrite === true,
      unit: pilotUnitOf({ provider: admitted.contract.provider, contractSha256: pilotContractSha256(admitted.contract), environment: request.environment, target: request.target }),
      ...(kind === "seal" && request.requester ? { requester: { requesterId: request.requester.requesterId, privateKeyPem: request.requester.privateKeyPem } } : {}),
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
  // The cleanup adapter shares the apply adapter's init, workspace and state steps, which this run exercised; its destroy plan and apply are the same program's.
  return { ok: true, engineVersion: request.resolved.engineVersion, terraformSha256: binarySha256, adapters: [engine.previewAdapter(), engine.applyAdapter, ...(engine.cleanupAdapter ? [engine.cleanupAdapter] : [])] };
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
 * Reads what the engine knows about the resources it left once (Terraform's state, or CloudFormation's logical-to-physical
 * mapping), maps it to identifiers only, and records the blueprint beside the evidence. Never throws: a missing blueprint is
 * a refusal later, not a failed apply now. `place` is the account and region the identifiers are in (an ARN is derived from
 * a CloudFormation physical id for the types the independent reader knows).
 */
async function keepBlueprint(run: { stateDocument?(): StateDocument | undefined }, sealed: Pick<SealedPlan, "changes" | "unit">, evidence: ApplyEvidence, evidenceDir: string, now: Date,
  place: { account: string; region: string | undefined; stack: string }): Promise<void> {
  try {
    const state = run.stateDocument?.();
    if (state === undefined) return;
    const blueprint = state.source === "CLOUDFORMATION_STACK_RESOURCES" ? blueprintFromCloudFormationResources(state.document, sealed.changes, place) : blueprintFromTerraformStatePull(state.document, sealed.changes);
    const record: BlueprintRecord = {
      schemaVersion: 1, kind: "BLUEPRINT", artifactSha256: evidence.artifactSha256, applyEvidenceSha256: sha256(canonicalJson(evidence as never)), environment: evidence.environment,
      target: { ...evidence.target }, sourceCommit: evidence.sourceCommit, contractSha256: evidence.contractSha256, outcome: evidence.outcome, source: state.source, blueprint,
      unitId: sealed.unit?.unitId ?? null, readAt: now.toISOString(),
    };
    await writeBlueprintRecord(record, evidenceDir);
  } catch { /* the state could not be read or mapped: no blueprint, and the cleanup step says so */ }
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
  const admitted = admit(deps, request, "APPLY");
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
  // AUTHORIZED is the one the approvers signed: the same contract and the same authorizing entry, or nothing is consumed.
  const changedPolicy = authorizationChanged(sealed, admitted.authorization);
  if (changedPolicy) return changedPolicy;
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

  // 8. The requester signature verifies against the allowlist, then the authenticated approvals bound to this artifact, environment
  // and target, none from the requester where the environment forbids it (PROD). Verifying consumes nothing.
  const nonces = deps.nonces ?? openNonceStore();
  const requested = verifyRequestSignature({ request: sealed.request, artifactSha256: sealed.artifactSha256, environment: sealed.environment, requesterId: sealed.requesterId, contract });
  if (!requested.ok) return refuse(requested.code, requested.message);
  const verdict = verifyApprovalSet({
    approvals: request.approvals, artifactSha256: sealed.artifactSha256, environment: sealed.environment, target: sealed.target,
    contract, now: now(), nonces, requester: requested,
  });
  if (!verdict.ok) return refuse(verdict.code, verdict.message);

  // 9-10. The apply adapter is qualified by real-engine evidence; the engine's separate identities aimed at this target.
  const ready = { qualificationEvidenceHash: null as string | null };
  const gate = await checkEngineAndIdentities(engine.applyAdapter, deps, sealed.engineVersion, contract, spec, sealed.environment, "apply", ready);
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
      if (/_NOT_IN_CONTRACT$/.test(code) || isBackendPinRefusal(code)) {
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
    // consumed: a signal that arrived during the blocking steps, the contract and the ACT policy, the kill switch, the
    // allowlist and each approval's expiry.
    await yieldToSignals();
    const late = interruptedBeforeEngine();
    if (late) return late;
    const readmitted = admit(deps, request, "APPLY");
    if (!readmitted.ok) return readmitted;
    const lateChange = authorizationChanged(sealed, readmitted.authorization);
    if (lateChange) return lateChange;
    const reconfirmedRequest = verifyRequestSignature({ request: sealed.request, artifactSha256: sealed.artifactSha256, environment: sealed.environment, requesterId: sealed.requesterId, contract: readmitted.contract });
    if (!reconfirmedRequest.ok) return refuse(reconfirmedRequest.code, reconfirmedRequest.message);
    const confirmed = verifyApprovalSet({
      approvals: request.approvals, artifactSha256: sealed.artifactSha256, environment: sealed.environment, target: sealed.target,
      contract: readmitted.contract, now: now(), nonces, requester: reconfirmedRequest,
    });
    if (!confirmed.ok) return refuse(confirmed.code, confirmed.message);

    // 13. Approvals are consumed before the engine runs (the request signature is bound to the artifact, which the ledger applies once).
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
      manifestHash: sealed.manifestHash, releaseIdentity: sealed.releaseIdentity, contractSha256: sealed.contractSha256,
      decisions: {
        authorized: { operation: "APPLY", contractSha256: readmitted.authorization.contractSha256, authorizationSha256: readmitted.authorization.authorizationSha256 },
        ready: { engineBinarySha256: sealed.provenance.engineBinarySha256, qualificationEvidenceHash: ready.qualificationEvidenceHash },
        execute: { requesterId: reconfirmedRequest.requesterId, approverIds: confirmed.approvers.map((a) => a.approverId) },
      },
      sourceCommit: sealed.sourceCommit, approvals: confirmed.approvers,
      requester: { requesterId: reconfirmedRequest.requesterId, nonce: sealed.request!.statement.nonce },
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
    // The blueprint of what the run left: addresses and cloud identifiers from the engine's own state, read as STATE and
    // dropped. It is the observe and cleanup steps' starting point (docs/observe-and-cleanup.md). A state that cannot be
    // read leaves no blueprint, and a later cleanup is then refused for want of one, never guessed.
    await keepBlueprint(run, sealed, evidence, evidenceDir, now(), { account: sealed.target.account, region: (contract.targets[sealed.environment] as { region?: string } | undefined)?.region, stack: sealed.target.backend });
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

// --- cleanup --------------------------------------------------------------------------------------------------

export type CleanupRequest = {
  /** Built from a real terminal prompt by the CLI. An agent cannot produce one. */
  invocation: HumanInvocation;
  environment: ApplyEnvironment;
  target: ResolvedTarget;
  channel?: PilotChannel;
  /** The proposal as the CLI loaded and showed it. The driver verifies its hash again, and derives it again from the records. */
  proposal: unknown;
  /** The sealed plan the cleaned-up apply ran from: its change list is what the proposal's ownership classes were derived from. */
  sealedPlan: LoadedPlan;
  /** The manifest the run was sealed against, and the project it describes: the engine needs the project to init. */
  manifest: ArtifactManifest;
  projectRoot: string;
  approvals: SignedApproval[];
};

const CLEANUP_PURPOSE = "cleanup-recovery";

/**
 * The proposal must be exactly what this run's records derive. The blueprint and the observation are read back from the
 * ledger and must hash to what the proposal names; the proposal is then rebuilt from them, the sealed plan's change list
 * and the reviewed contract (the same ownership classes and protections `buildCleanupProposal` applies, with the identities
 * configured now) and must hash to the proposal handed in. A list that names a resource this run did not create, a
 * protected backend or identity, or a resource of another run, or that leaves one out, is refused before anything is
 * reserved or consumed. A proposal's self-hash alone proves only that its own fields agree with each other.
 */
async function requireProposalDerivedFromRecords(
  proposal: CleanupProposal, applied: ApplyEvidence, changes: readonly PlanChange[], contract: PilotContract, env: NodeJS.ProcessEnv, evidenceDir: string,
): Promise<Refusal | { ok: true; blueprint: BlueprintRecord }> {
  const blueprint = await readBlueprintRecord(proposal.artifactSha256, proposal.applyEvidenceSha256, evidenceDir);
  if (!blueprint || recordSha256(blueprint) !== proposal.blueprintSha256) {
    return refuse("RUN_RECORD_MISSING", "The blueprint this proposal names is not the one recorded for this apply. Observe and propose the cleanup again; nothing was run.");
  }
  const observation = await readObservationRecord(proposal.artifactSha256, proposal.applyEvidenceSha256, evidenceDir);
  if (!observation || recordSha256(observation) !== proposal.observationSha256) {
    return refuse("RUN_RECORD_MISSING", "The observation this proposal names is not the one recorded for this apply. Observe and propose the cleanup again; nothing was run.");
  }
  const rebuilt = buildCleanupProposal({
    applyEvidence: applied, applyEvidenceSha256: proposal.applyEvidenceSha256, blueprint, blueprintSha256: proposal.blueprintSha256, observation, observationSha256: proposal.observationSha256,
    changes, channel: proposal.channel, contract, engineVersion: proposal.engineVersion, env, now: new Date(proposal.createdAt), requesterId: proposal.requesterId,
  });
  if (!rebuilt.ok) return rebuilt;
  if (computeProposalSha256(rebuilt.proposal) !== proposal.proposalSha256) {
    const list = (items: readonly { address: string }[]) => items.map((item) => item.address).sort().join(", ");
    const what = list(rebuilt.proposal.deletes) !== list(proposal.deletes) ? "deletion list" : list(rebuilt.proposal.excluded) !== list(proposal.excluded) ? "list of kept resources" : "content";
    return refuse("PROPOSAL_INVALID", "The proposal's " + what + " is not what this run's records derive (the sealed plan, the blueprint and the observation): it was not made by " +
      "./alz apply propose-cleanup from these records, or the pinned identities changed since. Propose the cleanup again; nothing was run and no approval was consumed.");
  }
  return { ok: true, blueprint };
}

/** What a CDK refusal says once CHANGESET has created the removal change set: it stays in CloudFormation, and no surface here deletes a change set. */
const LEFT_CHANGE_SET = " The removal change set created to plan this is left unexecuted in CloudFormation for a person to clear; nothing here deletes a change set.";

/**
 * Executes an approved cleanup proposal, exactly as approved (docs/act-pilot-plan.md, "Cleanup of pilot-created
 * resources"). In order and fail closed: the pilot contract enables ACT, the kill switch is off, a person invoked it, the
 * target is the contract's, the proposal verifies against its own hash and names this environment, target, contract,
 * channel and the running source commit, the apply it cleans up is recorded as SUCCEEDED and is the one the proposal names,
 * the proposal was not executed before, the cleanup requester's signature verifies under the cleanup request domain against
 * the allowlist, the approvals verify under the cleanup domain (an apply approval never does) with the same requester rule
 * and quorum as an apply (in PROD two distinct approvers, neither the requester, by id or key), the
 * cleanup adapter is qualified by real-engine evidence and the identities are configured, the proposal is reserved in the
 * ledger, the engine plans a destroy of exactly the proposal's addresses, that plan would delete no protected object (a
 * resource group, an identity or authorization object, deployment history, the state backend, a subscription or management
 * group, directly or as a dependent: `protectedDeletionIn`) and its change list is exactly those addresses (anything else, a
 * dependent included, refuses before any approval is consumed), the kill switch and approvals are checked once more, the
 * approvals are consumed, and only then the APPLY identity runs that destroy plan, watched and stoppable. Evidence replaces
 * the reservation whatever the outcome.
 */
export async function runCleanup(request: CleanupRequest, deps: ApplyDeps): Promise<CleanupResult> {
  const now = deps.now ?? (() => new Date());
  const evidenceDir = deps.evidenceDir ?? DEFAULT_EVIDENCE_DIR;
  const env = deps.env ?? process.env;

  if (!isRecord(request)) return refuse("HUMAN_INVOCATION_REQUIRED", "A cleanup is run by a person.");
  const admitted = admit(deps, request, "CLEANUP");
  if (!admitted.ok) return admitted;
  const { contract, spec } = admitted;
  const engine = engineOf(contract);
  if (!engine.cleanupAdapter || !engine.openCleanup || !engine.cleanupMutation) {
    return refuse("CLEANUP_NOT_SUPPORTED", "The contract's engine (" + engine.id + ") has no cleanup path. Its deletion authority needs its own owner decision; nothing was run.");
  }
  const opened = verifyCleanupProposal(request.proposal);
  if (!opened.ok) return opened;
  const { proposal } = opened;
  if (proposal.channel !== (request.channel ?? "CLI")) return refuse("CHANNEL_MISMATCH", channelMismatchMessage(proposal.channel));
  const running = knownSource(deps);
  if (!running) return refuse("SOURCE_UNVERIFIED", SOURCE_UNVERIFIED);
  if (running !== proposal.sourceCommit) {
    return refuse("SOURCE_CHANGED", "This cleanup was proposed from product commit " + proposal.sourceCommit.slice(0, 12) + ", but " + running.slice(0, 12) +
      " is running. Nothing was consumed. Run from that commit, or propose and approve the cleanup again.");
  }
  // The run is bound by its own records (the apply evidence's contract hash and target, below); the cleanup is AUTHORIZED by the
  // current committed contract the proposal bound (owner question N3 of #313's review: revoking APPLY must not strand a cleanup).
  if (proposal.environment !== request.environment || !sameTarget(proposal.target, request.target) ||
    proposal.provider !== contract.provider || proposal.engine !== contract.engine) {
    return refuse("PROPOSAL_INVALID", "The cleanup proposal was made for another environment, target, engine or pilot contract.");
  }
  const changedPolicy = authorizationChanged({ contractSha256: proposal.authorizingContractSha256, authorizationSha256: proposal.authorizationSha256 }, admitted.authorization);
  if (changedPolicy) return changedPolicy;
  if (proposal.deletes.length === 0) return refuse("PROPOSAL_INVALID", "The proposal lists nothing to delete: every resource this run created is already gone. Verify leftovers instead; nothing was run.");
  // The run it cleans up: recorded, successful, and exactly the evidence the proposal hashed.
  const applied = await readAppliedEvidence(proposal.artifactSha256, evidenceDir);
  if (!applied || sha256(canonicalJson(applied as never)) !== proposal.applyEvidenceSha256 || applied.outcome !== "SUCCEEDED") {
    return refuse("RUN_RECORD_MISSING", "The apply this proposal cleans up is not recorded as a successful apply with this evidence. Nothing was run.");
  }
  if (applied.environment !== proposal.environment || !sameTarget(applied.target, proposal.target) || applied.contractSha256 !== proposal.contractSha256) {
    return refuse("PROPOSAL_INVALID", "The apply evidence and the proposal name different environments, targets or contracts.");
  }
  // The sealed plan that apply ran from, verified against its own hashes as runApply does, and the one the proposal names.
  const loadedSeal = verifySealedPlan(request.sealedPlan);
  if (!loadedSeal.ok) return loadedSeal;
  const { sealed } = loadedSeal;
  if (sealed.artifactSha256 !== proposal.artifactSha256 || sealed.manifestHash !== applied.manifestHash || sealed.channel !== proposal.channel) {
    return refuse("PROPOSAL_INVALID", "The sealed plan is not the one the cleaned-up apply ran from. Nothing was run.");
  }
  // The deletion list is derived here from the records, never taken from the proposal file (owner decision 1: the delete
  // is bound in code to what this run created). A proposal that was edited and re-hashed cannot pass this.
  const derived = await requireProposalDerivedFromRecords(proposal, applied, sealed.changes, contract, env, evidenceDir);
  if (!derived.ok) return derived;
  const { blueprint } = derived;
  let manifest: ArtifactManifest;
  try { manifest = verifyManifest(request.manifest); } catch { return refuse("ARTIFACT_INVALID", "The manifest is not valid or not sealed."); }
  if (!acceptsManifest(engine, manifest) || manifest.manifestHash !== applied.manifestHash || !sameTarget(manifest.target, proposal.target) || manifest.engineVersion !== proposal.engineVersion) {
    return refuse("ARTIFACT_TAMPERED", "The manifest is not the one the cleaned-up apply ran against.");
  }
  const fresh = requireNotExecuted(proposal.proposalSha256, evidenceDir);
  if (!fresh.ok) return fresh;

  // The cleanup's requester (owner decision 6440801434, item 1): their signature over the proposal's hash verifies against the allowlist under the
  // cleanup request domain, and the approval set is judged with them as requester, by the same check an apply uses.
  const requested = verifyRequestSignature({
    request: proposal.request, artifactSha256: proposal.proposalSha256, environment: proposal.environment, requesterId: proposal.requesterId, contract, subject: "CLEANUP_REQUEST",
  });
  if (!requested.ok) return refuse(requested.code, requested.message + " Nothing was run or consumed.");
  const nonces = deps.nonces ?? openNonceStore();
  const verdict = verifyApprovalSet({
    approvals: request.approvals, artifactSha256: proposal.proposalSha256, environment: proposal.environment, target: proposal.target, contract, now: now(), nonces, subject: "CLEANUP",
    requester: { requesterId: requested.requesterId, publicKeyCanonical: requested.publicKeyCanonical },
  });
  if (!verdict.ok) return refuse(verdict.code, verdict.message);
  if (verdict.approvers.length < proposal.authorization.requiredApprovals) {
    return refuse("APPROVAL_INSUFFICIENT", verdict.approvers.length + " verified cleanup approval(s); the proposal requires " + proposal.authorization.requiredApprovals + ".");
  }
  const gate = await checkEngineAndIdentities(engine.cleanupAdapter, deps, proposal.engineVersion, contract, spec, proposal.environment, "cleanup");
  if (gate) return gate;

  let holding = false;
  let engineStarted = false;
  let interrupted = false;
  const releaseSignals = interceptStopSignals(() => { interrupted = true; });
  const interruptedBeforeEngine = (): Refusal | undefined => interrupted
    ? refuse("APPLY_FAILED", "The cleanup was interrupted by a signal before the engine started. Nothing was destroyed and no approval was consumed.") : undefined;
  const scratch = createPrivateDirectory("alz-preview-", deps.scratchParent);
  const run: EngineCleanupRun = engine.openCleanup({
    scratchDir: scratch.path, env, toolDirs: deps.toolDirs, manifest, pinned: contract.targets[proposal.environment]!, spec, target: proposal.target, engineVersion: proposal.engineVersion,
  });
  const unregisterSecrets = registerCleanup(run.removeSecrets);
  let snapshot: ImmutableSnapshot | undefined;
  const unregister = registerCleanup(() => { try { snapshot?.remove(); } finally { removeTree(scratch.path); } });
  const addresses = proposal.deletes.map((item) => item.address);
  try {
    const reserved = await reserveArtifact(proposal.proposalSha256, evidenceDir, now(), "cleanup");
    if (!reserved.ok) return reserved;
    holding = true;
    const early = interruptedBeforeEngine();
    if (early) return early;
    try { snapshot = createImmutableSnapshot(request.projectRoot, manifest, deps.scratchParent); } catch {
      return refuse("ARTIFACT_TAMPERED", "The project no longer matches the manifest the apply ran against. Nothing was run.");
    }
    let planned: PlanChange[];
    try {
      run.prepare(snapshot.path);
      planned = run.planDestroy(addresses);
    } catch (error) {
      const code = codeOf(error);
      // A CDK refusal after CHANGESET created the removal change set leaves it in CloudFormation, whatever the code (review 6432294529, N1): said in every such refusal.
      const left = leftBehindOf(error) === "CHANGE_SET" ? LEFT_CHANGE_SET : "";
      if (/_NOT_IN_CONTRACT$/.test(code) || isBackendPinRefusal(code)) {
        return refuse("TARGET_NOT_IN_CONTRACT", "The backend, provider or change set is not the contract's target (" + code + "). Nothing was destroyed and no approval was consumed." + left);
      }
      // A CDK removal that would leave the stack empty, keep a resource under its deletion policy, or break what stays: refused by name (docs/observe-and-cleanup.md, "CloudFormation").
      if (code === "CLEANUP_WOULD_EMPTY_STACK") {
        return refuse("CLEANUP_WOULD_EMPTY_STACK", "Removing every approved resource would leave the stack with no resource, which CloudFormation does not hold. The stack is never deleted by a cleanup: its last resources go with the stack itself, and retiring the stack is the pilot owner's separate, reviewed decision. Nothing was destroyed and no approval was consumed.");
      }
      if (code === "CLEANUP_RETAIN_POLICY") {
        return refuse("CLEANUP_RETAIN_POLICY", "An approved resource has a deletion policy that keeps it when it is removed from the template (written, not a plain word this cleanup can judge, or a database's default snapshot), so the removal would leave something behind, unapproved and untracked. Nothing was destroyed and no approval was consumed. A person decides about that resource by hand.");
      }
      if (code === "CLEANUP_PROTECTED_IDENTITY") {
        return refuse("PROPOSAL_SCOPE_MISMATCH", "The approved list names an identity or access object, which is never deleted by a cleanup. Refused before any change set exists. Nothing was destroyed and no approval was consumed. The protected object is intentionally retained; a person reviews what depends on it.");
      }
      if (code === "CLEANUP_DEPENDENT_REFERENCED") {
        return refuse("CLEANUP_DEPENDENT_REFERENCED", "A resource or output that stays in the stack still refers to an approved resource, so the removal would break or take along something not on the list. Nothing was destroyed and no approval was consumed. Observe the run again and propose a cleanup that includes or excludes the dependent.");
      }
      return refuse("APPLY_FAILED", "The cleanup could not plan the destroy (" + code + "). Nothing was destroyed and no approval was consumed. Engine output is withheld." + left);
    }
    // The policy check: whatever the engine's destroy plan would take along, a protected object (a resource group, an identity or
    // authorization object, deployment history, the state backend, a scope) stops the cleanup here, before any approval is consumed.
    // Residual risk, stated plainly: for CDK the destroy plan is a change set CloudFormation has already created by now, and a refusal
    // here leaves it unexecuted and AVAILABLE in CloudFormation for a person to clear; no surface deletes a change set (docs/observe-and-cleanup.md).
    const leftBehind = contract.engine === "CDK" ? LEFT_CHANGE_SET : "";
    const protectedDeletion = protectedDeletionIn(planned, blueprint.blueprint.entries, contract, env, { account: proposal.target.account, addresses: new Set(proposal.deletes.map((d) => d.address)) });
    if (protectedDeletion) return refuse("PROPOSAL_SCOPE_MISMATCH", protectedDeletion + " Nothing was destroyed and no approval was consumed. The protected object is intentionally retained; a person reviews what depends on it." + leftBehind);
    // The scope check: the destroy plan deletes exactly the approved addresses and does nothing else. A dependent the engine
    // added, a resource it would leave, an update or a create means the state is not what the proposal was made from.
    const scope = cleanupScopeProblem(planned, addresses);
    if (scope) return refuse("PROPOSAL_SCOPE_MISMATCH", scope + " Nothing was destroyed and no approval was consumed. Observe the run again and propose a new cleanup." + leftBehind);
    // The last thing before the approvals are consumed is the signal check: nothing is awaited between it and consumeApprovals,
    // so a stop signal that arrived during the blocking steps above (the engine) is read here and stops the cleanup.
    await yieldToSignals();
    const late = interruptedBeforeEngine();
    if (late) return late;
    const readmitted = admit(deps, request, "CLEANUP");
    if (!readmitted.ok) return readmitted;
    const lateChange = authorizationChanged({ contractSha256: proposal.authorizingContractSha256, authorizationSha256: proposal.authorizationSha256 }, readmitted.authorization);
    if (lateChange) return lateChange;
    // The requester again, against the re-admitted contract, right before the approvals are consumed.
    const reconfirmedRequest = verifyRequestSignature({
      request: proposal.request, artifactSha256: proposal.proposalSha256, environment: proposal.environment, requesterId: proposal.requesterId, contract: readmitted.contract, subject: "CLEANUP_REQUEST",
    });
    if (!reconfirmedRequest.ok) return refuse(reconfirmedRequest.code, reconfirmedRequest.message + " Nothing was destroyed and no approval was consumed.");
    const confirmed = verifyApprovalSet({
      approvals: request.approvals, artifactSha256: proposal.proposalSha256, environment: proposal.environment, target: proposal.target, contract: readmitted.contract, now: now(), nonces, subject: "CLEANUP",
      requester: { requesterId: reconfirmedRequest.requesterId, publicKeyCanonical: reconfirmedRequest.publicKeyCanonical },
    });
    if (!confirmed.ok) return refuse(confirmed.code, confirmed.message);
    const consumed = consumeApprovals(nonces, request.approvals);
    if (!consumed.ok) return refuse(consumed.code, consumed.message);

    const startedAt = now().toISOString();
    let destroyed: Awaited<ReturnType<typeof run.execute>>;
    try {
      destroyed = await run.execute({ stopWhen: () => isKillSwitchActive(readmitted.contract), pollMs: deps.killPollMs, graceMs: deps.killGraceMs });
    } catch (error) {
      return refuse("APPROVALS_SPENT", "The cleanup could not start (" + codeOf(error) + ") after the approvals were consumed. Nothing was destroyed. The approvals are spent: propose and approve the cleanup again.");
    }
    engineStarted = true;
    if (destroyed.notStarted) {
      engineStarted = false;
      return refuse("KILL_SWITCH_AFTER_APPROVALS", "The kill switch became active as the cleanup was about to start. Nothing was destroyed. The approvals were consumed: approve the proposal again.");
    }
    const end = await run.settle(destroyed);
    const outcome: ApplyOutcome = "stale" in end ? "FAILED_NO_CHANGE" : end.outcome;
    const kept = outcome === "SUCCEEDED" ? {} : await keepCleanupRecoveryFiles(run.recoveryFiles(), proposal.proposalSha256);
    const evidence: CleanupEvidence = {
      schemaVersion: 1, kind: "CLEANUP", environment: proposal.environment, target: { ...proposal.target }, proposalSha256: proposal.proposalSha256, artifactSha256: proposal.artifactSha256,
      applyEvidenceSha256: proposal.applyEvidenceSha256, contractSha256: proposal.contractSha256,
      decisions: {
        authorized: { operation: "CLEANUP", contractSha256: readmitted.authorization.contractSha256, authorizationSha256: readmitted.authorization.authorizationSha256 },
        ready: { engineBinarySha256: engine.binarySha256(deps.toolDirs, env) ?? null, qualificationEvidenceHash: null },
        execute: { requesterId: reconfirmedRequest.requesterId, approverIds: confirmed.approvers.map((a) => a.approverId) },
      },
      sourceCommit: proposal.sourceCommit, approvals: confirmed.approvers,
      requester: { requesterId: reconfirmedRequest.requesterId, nonce: (proposal.request as NonNullable<CleanupProposal["request"]>).statement.nonce },
      adapter: { adapterVersion: engine.cleanupAdapter.adapterVersion, argvDigest: engine.cleanupAdapter.argvDigest }, toolVersions: { engine: proposal.engineVersion }, deletes: addresses,
      outcome, exitCode: destroyed.exitCode, startedAt, finishedAt: now().toISOString(),
      authority: { infrastructureAct: "PILOT_ENABLED", mutation: engine.cleanupMutation, executedAs: "APPLY", agentInitiated: false }, ...(kept.recovery ? { recovery: kept.recovery } : {}),
    };
    const lost = kept.lost ? engine.recoveryLostNote : "";
    let written: CleanupResult;
    try { written = await finalizeCleanup(evidence, evidenceDir); } catch { written = refuse("EVIDENCE_REJECTED", "The evidence could not be written"); }
    if (!written.ok) return { ...written, outcome, message: written.message + ". The cleanup ended " + outcome + "; record that by hand. The proposal stays reserved." + lost };
    if (outcome === "SUCCEEDED") return written;
    if ("stale" in end) return { ok: false, code: "PLAN_STALE", outcome, message: "The destroy plan was stale: state changed while the cleanup ran. Nothing was destroyed. Observe the run again and propose a new cleanup." };
    return { ok: false, code: "APPLY_FAILED", outcome, message: CLEANUP_OUTCOME_MESSAGES[outcome as Exclude<ApplyOutcome, "SUCCEEDED">] + lost };
  } finally {
    releaseSignals();
    unregisterSecrets();
    unregister();
    run.removeSecrets();
    try { snapshot?.remove(); } finally { removeTree(scratch.path); }
    if (holding && !engineStarted) await releaseReservation(proposal.proposalSha256, evidenceDir, "cleanup");
  }
}

/** Why a destroy plan is not exactly the approved list: an empty sentence means it is. */
export function cleanupScopeProblem(planned: readonly PlanChange[], approved: readonly string[]): string | undefined {
  const resources = planned.filter((change) => change.type !== "output");
  const wrongAction = resources.filter((change) => change.action !== "DELETE");
  if (wrongAction.length > 0) return "The destroy plan would " + wrongAction[0].action.toLowerCase() + " " + wrongAction[0].address + ", which a cleanup never does.";
  const plannedSet = new Set(resources.map((change) => change.address));
  const approvedSet = new Set(approved);
  const extra = [...plannedSet].filter((address) => !approvedSet.has(address)).sort();
  if (extra.length > 0) return "The destroy plan includes " + extra.length + " resource(s) the proposal does not list (" + extra.slice(0, 3).join(", ") + (extra.length > 3 ? ", ..." : "") + "), a dependent or a changed state.";
  const missing = [...approvedSet].filter((address) => !plannedSet.has(address)).sort();
  if (missing.length > 0) return "The destroy plan leaves out " + missing.length + " approved resource(s) (" + missing.slice(0, 3).join(", ") + (missing.length > 3 ? ", ..." : "") + "): the state no longer holds them as proposed.";
  return undefined;
}

const CLEANUP_OUTCOME_MESSAGES: Readonly<Record<Exclude<ApplyOutcome, "SUCCEEDED">, string>> = {
  FAILED_NO_CHANGE: "The cleanup failed before it changed state. Engine output is withheld because it can hold secrets. This proposal and its approvals are spent: verify leftovers, then propose and approve a new cleanup.",
  PARTIAL_REQUIRES_REVIEW: "The cleanup failed after it started, so some listed resources may be gone and others not. Do not retry. Verify leftovers (it reads the cloud and changes nothing), then a person reviews the state and the resources by hand before any new proposal. " +
    "If Terraform left errored.tfstate or crash.log, they are in the encrypted evidence vault and the evidence names their hash. This proposal and its approvals are spent.",
  KILLED: "The cleanup was told to stop while it ran (the kill switch appeared, the time limit passed, or a stop signal arrived), or it ended on a signal. Some listed resources may be gone and others not, and the state lease may still be held. " +
    "Do not retry. Verify leftovers, then a person reviews the state, the lease and the resources by hand. This proposal and its approvals are spent.",
};

/** As `keepRecoveryFiles`, for a cleanup: under the proposal's hash. */
async function keepCleanupRecoveryFiles(files: RecoveryFile[], proposalSha256: string): Promise<{ recovery?: NonNullable<CleanupEvidence["recovery"]>; lost?: true }> {
  if (files.length === 0) return {};
  const record = { schemaVersion: 1, proposalSha256, files };
  try { await writeEncryptedEvidence(CLEANUP_PURPOSE, proposalSha256, record); } catch { return { lost: true }; }
  return { recovery: { files: files.length, sha256: sha256(canonicalJson(record as never)) } };
}

/** The identity of a proposal as the driver names it in refusals and evidence. */
export const proposalIdOf = (proposal: Pick<CleanupProposal, "proposalSha256">): string => proposal.proposalSha256.slice(0, 12);
export { recordSha256 };
