import { readEncryptedEvidence, writeEncryptedEvidence } from "../evidence/vault.js";
import { canonicalJson, type ArtifactManifest } from "../teardown/manifest.js";
import type { ResolvedTarget } from "../teardown/driver/types.js";
import { ENVIRONMENTS, HASH, INVISIBLE } from "./constants.js";
import { sha256 } from "../util/sha256.js";
import { codeOf } from "./engine.js";
import type { EnginePlanInput, EngineSpec } from "./engine-spec.js";
import { PILOT_CHANNELS, type ApplyEnvironment, type ApplyRefusalCode, type PilotChannel, type SealedPlan } from "./types.js";

/**
 * Sealing (docs/act-pilot-plan.md, authority items 2 and 5). The engine spec
 * (`engine-spec.ts`) produces the artifact the apply will run, from the
 * request, and its redacted change list; this module keeps those bytes: they
 * are hashed, encrypted in the evidence vault, and bound with the manifest,
 * release identity, environment and exact target into one artifact hash.
 * Approvers sign that hash; the driver applies exactly those bytes.
 */
const SEAL_PURPOSE = "sealed-plan";

type ArtifactFields = Pick<SealedPlan,
  "planSha256" | "manifestHash" | "releaseIdentity" | "environment" | "target" | "channel" | "engineVersion" | "policyVersion" | "contractSha256" | "changes">;

/**
 * The artifact hash an approver signs. The one definition; sealing and loading
 * both use it. The change list approvers read is bound by its own hash, so it
 * cannot be edited after the fact without invalidating every approval.
 */
export function computeArtifactSha256(fields: ArtifactFields): string {
  const { account, backend, workspace } = fields.target;
  return sha256(canonicalJson({
    planSha256: fields.planSha256, manifestHash: fields.manifestHash, releaseIdentity: fields.releaseIdentity,
    environment: fields.environment, target: { account, backend, workspace }, channel: fields.channel,
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

/** What the engine plans from (the driver's validated manifest and its read-only snapshot, a scratch directory it deletes, the contract's target and provider), and what the seal binds besides. */
export type SealInput = EnginePlanInput & {
  /** The contract's engine, chosen once by the driver. */
  engine: EngineSpec;
  environment: ApplyEnvironment;
  /** Who is sealing: the caller says (the terminal CLI or the console adapter), never a flag. Default `CLI`. */
  channel?: PilotChannel;
  policyVersion: string;
  /** The pinned contract's canonical sha256: sealed, so the plan applies only under this contract. */
  contractSha256: string;
  now?: () => Date;
};

export type SealFailure = { ok: false; code: "ARTIFACT_INVALID"; message: string };
/** A stored seal: the encrypted vault file holds the record and the plan bytes. */
export type SealResult = { ok: true; sealed: SealedPlan; path: string } | SealFailure;
/** A qualification run's plan: made and checked, then dropped. Nothing is stored, so nothing can be approved or applied. */
export type ThrowawayPlan = { ok: true; sealed: SealedPlan } | SealFailure;

const HAS_INVISIBLE = new RegExp(INVISIBLE.source);

function runSeal(input: SealInput): { sealed: SealedPlan; planBytes: Buffer } {
  const { manifest } = input;
  const { artifact: planBytes, changes } = input.engine.plan(input);
  const fields: ArtifactFields = {
    planSha256: sha256(planBytes), manifestHash: manifest.manifestHash, releaseIdentity: releaseIdentityOf(manifest),
    environment: input.environment, target: { ...input.target }, channel: input.channel ?? "CLI", engineVersion: input.engineVersion,
    policyVersion: input.policyVersion, contractSha256: input.contractSha256, changes,
  };
  const sealed: SealedPlan = {
    schemaVersion: 1, artifactSha256: computeArtifactSha256(fields), ...fields,
    createdAt: (input.now ?? (() => new Date()))().toISOString(),
  };
  return { sealed, planBytes };
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
  environment: s.environment, target: { ...s.target }, channel: s.channel, engineVersion: s.engineVersion, policyVersion: s.policyVersion,
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
    !ENVIRONMENTS.includes(s.environment) || !PILOT_CHANNELS.includes(s.channel) || !s.target || typeof s.target !== "object" ||
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
  if (Object.keys(b).sort().join() !== BUNDLE_KEYS.join() || !ENVIRONMENTS.includes(b.environment as ApplyEnvironment) || !PILOT_CHANNELS.includes(b.channel as PilotChannel) ||
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
