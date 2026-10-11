import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { readEncryptedEvidence, writeEncryptedEvidence } from "../evidence/vault.js";
import { mapTerraformActions } from "../iac/terraform-plan.js";
import { canonicalJson, type ArtifactManifest } from "../teardown/manifest.js";
import { removeTree } from "../teardown/driver/cleanup.js";
import { INIT_ARGV, PREVIEW_PLAN_ARGV, SHOW_ARGV, isAllowedArgv } from "../teardown/driver/adapters/terraform.js";
import type { ResolvedTarget } from "../teardown/driver/types.js";
import { MUTATION_IDENTITY_VARIABLE } from "../tools/identity.js";
import { ENVIRONMENTS, HASH } from "./constants.js";
import { TERRAFORM_APPLY_PROFILE } from "../tools/profiles.js";
import { sha256 } from "../util/sha256.js";
import { assertBackendInContract, codeOf, openSession, prepareWorkspace, stop, type EngineSession } from "./engine.js";
import type { ProviderBlock, ProviderSpec } from "./provider.js";
import type { ApplyEnvironment, ApplyRefusalCode, PilotTarget, PlanChange, SealedPlan } from "./types.js";

/**
 * Sealing (docs/act-pilot-plan.md, authority items 2 and 5). It runs the same
 * pinned init, workspace and plan steps as the preview adapter, but keeps the
 * plan file: the bytes are hashed, encrypted in the evidence vault, and bound
 * with the manifest, release identity, environment and exact target into one
 * artifact hash. Approvers sign that hash; the driver applies exactly those
 * bytes. Sealing never holds STATE_WRITE or APPLY, and `terraform show -json`
 * is read only to extract the redacted change list.
 */
const SEAL_PURPOSE = "sealed-plan";

/** The plan file beside the work directory that `SHOW_ARGV` names: sealing writes it, and an apply re-derives the change list from a decrypted copy of it. */
export const SEAL_PLAN_FILE = "alz-preview.tfplan";

type ArtifactFields = Pick<SealedPlan,
  "planSha256" | "manifestHash" | "releaseIdentity" | "environment" | "target" | "engineVersion" | "policyVersion" | "contractSha256" | "changes">;

/**
 * The artifact hash an approver signs. The one definition; sealing and loading
 * both use it. The change list approvers read is bound by its own hash, so it
 * cannot be edited after the fact without invalidating every approval.
 */
export function computeArtifactSha256(fields: ArtifactFields): string {
  const { account, backend, workspace } = fields.target;
  return sha256(canonicalJson({
    planSha256: fields.planSha256, manifestHash: fields.manifestHash, releaseIdentity: fields.releaseIdentity,
    environment: fields.environment, target: { account, backend, workspace },
    engineVersion: fields.engineVersion, policyVersion: fields.policyVersion, contractSha256: fields.contractSha256,
    changesSha256: sha256(canonicalJson(fields.changes)),
  }));
}

/**
 * Target-independent identity of the qualified release: project files, lock
 * file, engine and provider versions, dependencies and shared inputs. A
 * production manifest is target-bound and differs from the dev manifest, so
 * production is tied to the release by this value and never by manifest hash.
 */
export function releaseIdentityOf(manifest: ArtifactManifest): string {
  return sha256(canonicalJson({
    engine: manifest.engine, engineVersion: manifest.engineVersion, providers: manifest.providers,
    lockFileSha256: manifest.lockFileSha256, files: manifest.files, dependencies: manifest.dependencies,
    inputs: manifest.inputs,
  }));
}

export type SealInput = {
  environment: ApplyEnvironment;
  target: ResolvedTarget;
  /** The driver's validated manifest and its read-only snapshot. */
  manifest: ArtifactManifest;
  snapshotPath: string;
  /** A fresh 0700 directory owned by the driver, which deletes it afterwards. */
  scratchDir: string;
  env: NodeJS.ProcessEnv;
  policyVersion: string;
  /** The engine version the manifest was validated against. */
  engineVersion: string;
  /** The contract's target for this environment: the backend the seal-time init saves and a constant in a provider block must be its. */
  pinned: PilotTarget;
  /** The contract's provider. */
  spec: ProviderSpec;
  /** The pinned contract's canonical sha256: sealed, so the plan applies only under this contract. */
  contractSha256: string;
  toolDirs?: readonly string[];
  now?: () => Date;
};

export type SealFailure = { ok: false; code: "ARTIFACT_INVALID"; message: string };
/** A stored seal: the encrypted vault file holds the record and the plan bytes. */
export type SealResult = { ok: true; sealed: SealedPlan; path: string } | SealFailure;
/** A qualification run's plan: made and checked, then dropped. Nothing is stored, so nothing can be approved or applied. */
export type ThrowawayPlan = { ok: true; sealed: SealedPlan } | SealFailure;

/** Sealing reads with DISCOVERY and STATE only. The writer and the applier are not even in the runner's environment. */
const sealEnvironment = (env: NodeJS.ProcessEnv): NodeJS.ProcessEnv =>
  Object.fromEntries(Object.entries(env).filter(([key]) => !MUTATION_IDENTITY_VARIABLE.test(key)));

/** Bidi and zero-width control characters: they make an address read as another one. Stripped where the change list is derived, and again wherever one is displayed. */
export const INVISIBLE = /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/g;
const HAS_INVISIBLE = new RegExp(INVISIBLE.source);
export const stripInvisible = (value: string): string => value.replace(INVISIBLE, "");

type Shown = {
  format_version?: unknown; errored?: unknown;
  resource_changes?: { address?: string; type?: string; previous_address?: unknown; change?: { actions?: string[]; importing?: unknown } }[];
  output_changes?: Record<string, { actions?: string[] }>;
  configuration?: { provider_config?: Record<string, ProviderBlock> };
};

/** What the provider half of the contract binding is judged against: the contract's target and provider, and the environment that holds the APPLY role (sealing hides it from its children, not from this check). */
type Judge = Pick<SealInput, "pinned" | "spec" | "env">;

/**
 * The one extraction of the redacted change list (address, type, action, and
 * an import, a move, a forget or an output change; never a value) from
 * `terraform show -json` output. Sealing records it, and an apply derives it
 * again from the decrypted plan to prove the record describes it. It also
 * enforces the provider half of the contract binding.
 */
function changesOf(shown: string, judge: Judge): SealedPlan["changes"] {
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
const readChanges = (session: EngineSession, judge: Judge): SealedPlan["changes"] =>
  changesOf(session.step(SHOW_ARGV, null, true), judge);

/**
 * Derives the change list from the plan bytes themselves, for an apply that
 * has initialized its work directory: the decrypted plan is written, shown
 * with the same pinned argument list and the same restricted profile as
 * sealing (no identity in the environment), and removed. Throws a code.
 */
export function rederiveChanges(input: Pick<SealInput, "scratchDir" | "env" | "toolDirs" | "manifest" | "pinned" | "spec"> & { planBytes: Buffer }): SealedPlan["changes"] {
  const session = sealSession(input);
  const planFile = join(input.scratchDir, SEAL_PLAN_FILE);
  writeFileSync(planFile, input.planBytes, { mode: 0o600, flag: "wx" });
  try {
    return readChanges(session, input);
  } finally {
    rmSync(planFile, { force: true });
  }
}

/** Sealing and re-deriving run the preview adapter's argument lists under the apply path's restricted profile: no CLI configuration file, no plugin cache. */
const sealSession = (input: Pick<SealInput, "scratchDir" | "env" | "toolDirs" | "manifest">): EngineSession => openSession({
  scratchDir: input.scratchDir, env: sealEnvironment(input.env), toolDirs: input.toolDirs, manifest: input.manifest,
  isAllowed: (args) => isAllowedArgv("TERRAFORM", "terraform", args), profile: TERRAFORM_APPLY_PROFILE,
});

function runSeal(input: SealInput): { sealed: SealedPlan; planBytes: Buffer } {
  const { manifest } = input;
  if (manifest.engine !== "TERRAFORM" || manifest.mode !== "PROJECT") return stop("TERRAFORM_PROJECT_REQUIRED");
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

    const planBytes = readFileSync(planFile);
    const changes = readChanges(session, input);

    const fields: ArtifactFields = {
      planSha256: sha256(planBytes), manifestHash: manifest.manifestHash, releaseIdentity: releaseIdentityOf(manifest),
      environment: input.environment, target: { ...input.target }, engineVersion: input.engineVersion,
      policyVersion: input.policyVersion, contractSha256: input.contractSha256, changes,
    };
    const sealed: SealedPlan = {
      schemaVersion: 1, artifactSha256: computeArtifactSha256(fields), ...fields,
      createdAt: (input.now ?? (() => new Date()))().toISOString(),
    };
    return { sealed, planBytes };
  } finally {
    rmSync(planFile, { force: true });
    removeTree(session.work);
  }
}

function build(input: SealInput): { sealed: SealedPlan; planBytes: Buffer } | SealFailure {
  try {
    return runSeal(input);
  } catch (error) {
    return {
      ok: false, code: "ARTIFACT_INVALID",
      message: "The plan could not be sealed (" + codeOf(error) + "). Engine output is withheld because plan and state output can hold secrets.",
    };
  }
}

/** Plans the pinned project against the target, keeps the plan encrypted, and returns the record approvers sign. */
export async function sealPlan(input: SealInput): Promise<SealResult> {
  const built = build(input);
  if ("ok" in built) return built;
  const path = await writeEncryptedEvidence(SEAL_PURPOSE, built.sealed.artifactSha256, {
    sealed: built.sealed, planBase64: built.planBytes.toString("base64"),
  });
  return { ok: true, sealed: built.sealed, path };
}

/** The same steps as `sealPlan` for a qualification run, which stores nothing. */
export function planWithoutStoring(input: SealInput): ThrowawayPlan {
  const built = build(input);
  return "ok" in built ? built : { ok: true, sealed: built.sealed };
}

/**
 * What an approver reviews, without the evidence key: the artifact's own fields and the redacted change list. No plan
 * bytes and no values. An approver recomputes the artifact hash from these fields (`verifyReviewBundle`) before signing,
 * so a bundle that was edited cannot get a signature for a different plan.
 */
export type ReviewBundle = Omit<SealedPlan, "schemaVersion"> & { changesSha256: string };

export const reviewBundleOf = (s: SealedPlan): ReviewBundle => ({
  artifactSha256: s.artifactSha256, planSha256: s.planSha256, manifestHash: s.manifestHash, releaseIdentity: s.releaseIdentity,
  environment: s.environment, target: { ...s.target }, engineVersion: s.engineVersion, policyVersion: s.policyVersion,
  contractSha256: s.contractSha256, createdAt: s.createdAt, changes: s.changes, changesSha256: sha256(canonicalJson(s.changes)),
});

const BUNDLE_KEYS = Object.keys(reviewBundleOf({ target: {}, changes: [] } as never)).sort();

export type LoadedPlan = { sealed: SealedPlan; planBytes: Buffer };
type SealFault = { ok: false; code: Extract<ApplyRefusalCode, "ARTIFACT_INVALID" | "ARTIFACT_TAMPERED">; message: string };
type LoadedSeal = ({ ok: true } & LoadedPlan) | SealFault;

const invalid = (message: string): SealFault => ({ ok: false, code: "ARTIFACT_INVALID", message });
const tampered = (): SealFault => ({
  ok: false, code: "ARTIFACT_TAMPERED",
  message: "The sealed plan does not match its own hashes; it was altered after sealing. Seal and approve a new plan.",
});
const text = (v: unknown): boolean => typeof v === "string" && v.length > 0;
const CHANGE_KEYS = ["address", "type", "action", "importing", "previousAddress"];
const wellFormedChange = (c: unknown): boolean => {
  if (!c || typeof c !== "object") return false;
  const f = c as Record<string, unknown>;
  return Object.keys(f).every((key) => CHANGE_KEYS.includes(key)) && ["address", "type", "action"].every((key) => text(f[key])) &&
    (f.importing === undefined || f.importing === true) && (f.previousAddress === undefined || text(f.previousAddress)) &&
    // A hand-edited list that hides characters would be shown differently from what was hashed.
    [f.address, f.type, f.previousAddress].every((value) => value === undefined || !HAS_INVISIBLE.test(value as string));
};

/**
 * Proves a sealed record and its plan bytes still hash to the artifact an
 * approver signed. The one verification: loading a file and applying an
 * already-loaded plan (the CLI reads once and hands the object over) both
 * end here, so the apply never trusts a caller's earlier check.
 */
export function verifySealedPlan(value: unknown): LoadedSeal {
  const { sealed: s, planBytes } = (value && typeof value === "object" ? value : {}) as Partial<LoadedPlan>;
  if (!s || typeof s !== "object" || !Buffer.isBuffer(planBytes) || s.schemaVersion !== 1 ||
    !ENVIRONMENTS.includes(s.environment) || !s.target || typeof s.target !== "object" ||
    !Array.isArray(s.changes) || !s.changes.every(wellFormedChange) ||
    ![s.artifactSha256, s.planSha256, s.manifestHash, s.releaseIdentity, s.contractSha256].every((h) => typeof h === "string" && HASH.test(h))) {
    return invalid("The sealed plan record is malformed.");
  }
  let recomputed: string;
  try { recomputed = computeArtifactSha256(s); } catch { return tampered(); }
  if (sha256(planBytes) !== s.planSha256 || recomputed !== s.artifactSha256) return tampered();
  return { ok: true, sealed: s, planBytes };
}

/** Checks a review bundle against its own hashes and returns it. The one verification an approver relies on. */
export function verifyReviewBundle(value: unknown): { ok: true; bundle: ReviewBundle } | SealFault {
  const b = (value && typeof value === "object" && !Array.isArray(value) ? value : {}) as Partial<ReviewBundle>;
  const t = (b.target ?? {}) as Partial<ResolvedTarget>;
  if (Object.keys(b).sort().join() !== BUNDLE_KEYS.join() || !ENVIRONMENTS.includes(b.environment as ApplyEnvironment) ||
    !["account", "backend", "workspace"].every((key) => text((t as Record<string, unknown>)[key])) ||
    !Array.isArray(b.changes) || !b.changes.every(wellFormedChange) || !text(b.engineVersion) || !text(b.policyVersion) || !text(b.createdAt) ||
    ![b.artifactSha256, b.planSha256, b.manifestHash, b.releaseIdentity, b.contractSha256, b.changesSha256].every((h) => typeof h === "string" && HASH.test(h))) {
    return invalid("The review bundle is malformed.");
  }
  const bundle = b as ReviewBundle;
  if (sha256(canonicalJson(bundle.changes)) !== bundle.changesSha256 || computeArtifactSha256(bundle) !== bundle.artifactSha256) {
    return { ok: false, code: "ARTIFACT_TAMPERED", message: "The review bundle does not match its own hashes; it was altered after sealing. Ask for a new bundle from the operator." };
  }
  return { ok: true, bundle };
}

/** Decrypts a sealed plan and verifies it. */
export async function loadSealedPlan(path: string): Promise<LoadedSeal> {
  let inner: { sealed?: SealedPlan; planBase64?: unknown };
  try {
    inner = await readEncryptedEvidence(path);
  } catch (error) {
    const e = error as NodeJS.ErrnoException;
    if (e.code === "ENOENT" || e.code === "EISDIR" || error instanceof SyntaxError || /^EVIDENCE_KEY/.test(e.message)) {
      return invalid("The sealed plan cannot be read.");
    }
    return tampered();
  }
  if (typeof inner?.planBase64 !== "string") return invalid("The sealed plan record is malformed.");
  return verifySealedPlan({ sealed: inner.sealed, planBytes: Buffer.from(inner.planBase64, "base64") });
}
