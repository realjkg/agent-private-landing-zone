import { randomBytes } from "node:crypto";

import { readEncryptedEvidence, writeEncryptedEvidence } from "../evidence/vault.js";
import { signRequest } from "./approval.js";
import { canonicalJson, type ArtifactManifest } from "../teardown/manifest.js";
import type { ResolvedTarget } from "../teardown/driver/types.js";
import { COMMIT, ENVIRONMENTS, HASH, INVISIBLE } from "./constants.js";
import { sha256 } from "../util/sha256.js";
import { canaryRefusal } from "./canary.js";
import { codeOf } from "./engine.js";
import { sourceRuleHint } from "./terraform-constructs.js";
import type { EnginePlanInput, EngineSpec } from "./engine-spec.js";
import { PILOT_CHANNELS, type ApplyEnvironment, type ApplyRefusalCode, type PilotChannel, type PreviewProvenance, type SealedPlan, type SealedRequest, type SealedUnit } from "./types.js";

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
  "planSha256" | "manifestHash" | "releaseIdentity" | "environment" | "target" | "channel" | "engineVersion" | "policyVersion" | "authorizationSha256" | "targetSha256" | "contractSha256" | "sourceCommit" | "changes" | "provenance" | "unit" | "requesterId">;

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
    // AUTHORIZED: the contract's authorizing entry, by hash, beside the contract's own hash. Every approval signs both.
    authorizationSha256: fields.authorizationSha256,
    // The run's full target (region and tenant included), so a cleanup or removal can be held to it.
    targetSha256: fields.targetSha256,
    sourceCommit: fields.sourceCommit, changesSha256: sha256(canonicalJson(fields.changes)), provenance: fields.provenance as never, unit: fields.unit as never,
    // Who requested: every approver signs it, and swapping the requester invalidates every approval.
    requesterId: fields.requesterId,
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
  /** The contract's canonical sha256: sealed, so the plan applies only under this contract. */
  contractSha256: string;
  /** The canonical hash of the contract's entry that authorized this APPLY (`authorizeContract`): sealed, so approvals cover it and the apply re-checks it. */
  authorizationSha256: string;
  /** The run's full target (`pilotTargetSha256`): sealed, so approvals cover it and a cleanup is held to it. */
  targetSha256: string;
  /** The product source commit the driver was given by its caller: sealed, so only the same commit applies the plan. */
  sourceCommit: string;
  /** The engine program and its qualification, as the driver observed them before planning: sealed, so approvers see them and only that program applies. */
  provenance: PreviewProvenance;
  /**
   * The requester, already checked by the driver against the contract's allowlist: the id is bound into the artifact hash and
   * the key signs that hash under the REQUEST domain. Absent only for a throwaway plan (qualify), which is never stored.
   */
  requester?: { requesterId: string; privateKeyPem: string };
  now?: () => Date;
};

export type SealFailure = { ok: false; code: "ARTIFACT_INVALID" | "RESOURCE_NOT_IN_CANARY" | "CANARY_ALLOWLIST_MISSING" | "RESOURCE_NOT_IN_LIMITS"; message: string };
/** A stored seal: the encrypted vault file holds the record and the plan bytes. */
export type SealResult = { ok: true; sealed: SealedPlan; path: string } | SealFailure;
/** A qualification run's plan: made and checked, then dropped. Nothing is stored, so nothing can be approved or applied. */
export type ThrowawayPlan = { ok: true; sealed: SealedPlan } | SealFailure;

const HAS_INVISIBLE = new RegExp(INVISIBLE.source);

async function runSeal(input: SealInput): Promise<{ sealed: SealedPlan; planBytes: Buffer }> {
  const { manifest } = input;
  // An engine may await its reads here (D5); a rejection is a throw, judged by `build` like any other.
  const { artifact: planBytes, changes, unit } = await input.engine.plan(input);
  const fields: ArtifactFields = {
    planSha256: sha256(planBytes), manifestHash: manifest.manifestHash, releaseIdentity: releaseIdentityOf(manifest),
    environment: input.environment, target: { ...input.target }, channel: input.channel ?? "CLI", engineVersion: input.engineVersion,
    policyVersion: input.policyVersion, authorizationSha256: input.authorizationSha256, targetSha256: input.targetSha256, contractSha256: input.contractSha256, sourceCommit: input.sourceCommit, changes, provenance: input.provenance, unit,
    requesterId: input.requester?.requesterId ?? "",
  };
  const artifactSha256 = computeArtifactSha256(fields);
  // The requester signs the artifact hash (which binds their id), the environment and a one-time nonce. A throwaway plan has no signature and can never be stored.
  const request = input.requester
    ? signRequest({ schemaVersion: 1, requesterId: input.requester.requesterId, artifactSha256, environment: input.environment, nonce: randomBytes(16).toString("hex") }, input.requester.privateKeyPem)
    : null;
  const sealed: SealedPlan = {
    schemaVersion: 2, artifactSha256, ...fields, request,
    createdAt: (input.now ?? (() => new Date()))().toISOString(),
  };
  return { sealed, planBytes };
}

async function build(input: SealInput): Promise<{ sealed: SealedPlan; planBytes: Buffer } | SealFailure> {
  try {
    return await runSeal(input);
  } catch (error) {
    const canary = canaryRefusal(error, "Nothing was sealed.");
    if (canary) return { ok: false, ...canary };
    return {
      ok: false, code: "ARTIFACT_INVALID",
      message: "The plan could not be sealed (" + codeOf(error) + ")." + sourceRuleHint(codeOf(error)) + " Engine output is withheld because plan and state output can hold secrets.",
    };
  }
}

/** Plans the pinned project against the target, keeps the plan encrypted, and returns the record approvers sign. */
export async function sealPlan(input: SealInput): Promise<SealResult> {
  if (!input.requester) return { ok: false, code: "ARTIFACT_INVALID", message: "A plan is sealed by a requester with an allowlisted key; none was given, so nothing was stored." };
  const built = await build(input);
  if ("ok" in built) return built;
  const path = await writeEncryptedEvidence(SEAL_PURPOSE, built.sealed.artifactSha256, {
    sealed: built.sealed, planBase64: built.planBytes.toString("base64"),
  });
  return { ok: true, sealed: built.sealed, path };
}

/** The same steps as `sealPlan` for a qualification run, which stores nothing. */
export async function planWithoutStoring(input: SealInput): Promise<ThrowawayPlan> {
  const built = await build(input);
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
  authorizationSha256: s.authorizationSha256, targetSha256: s.targetSha256, contractSha256: s.contractSha256, sourceCommit: s.sourceCommit, createdAt: s.createdAt, changes: s.changes, changesSha256: sha256(canonicalJson(s.changes)),
  provenance: s.provenance, unit: s.unit, requesterId: s.requesterId, request: s.request,
});

export const REQUESTER_ID = /^[A-Za-z0-9._@+-]{1,64}$/;
const REQUEST_NONCE = /^[a-f0-9]{32}$/;
/**
 * A requester signature with exactly its fields, naming this record's own artifact, environment and requester. Whether it
 * verifies against the allowlist is the driver's and the approver's check (`verifyRequestSignature`), which needs the contract.
 */
export function wellFormedRequest(value: unknown): value is SealedRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const r = value as Record<string, unknown>;
  const st = r.statement as Record<string, unknown> | undefined;
  return Object.keys(r).sort().join() === "signatureBase64,statement" && text(r.signatureBase64) && !!st && typeof st === "object" && !Array.isArray(st) &&
    Object.keys(st).sort().join() === "artifactSha256,environment,nonce,requesterId,schemaVersion" && st.schemaVersion === 1 &&
    typeof st.artifactSha256 === "string" && typeof st.environment === "string" && typeof st.requesterId === "string" && typeof st.nonce === "string" && REQUEST_NONCE.test(st.nonce);
}
/** The request names this record's own artifact, environment and requester; anything else was edited after sealing. */
const requestBound = (request: SealedRequest, s: Pick<SealedPlan, "artifactSha256" | "environment" | "requesterId">): boolean =>
  request.statement.artifactSha256 === s.artifactSha256 && request.statement.environment === s.environment && request.statement.requesterId === s.requesterId;

const TAG_SAFE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
/** The sealed unit with exactly its fields, or null for an engine without a tag reader. */
function wellFormedUnit(value: unknown): value is SealedUnit | null {
  if (value === null) return true;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const u = value as Record<string, unknown>;
  return Object.keys(u).sort().join() === "tags,unitId,untagged" && typeof u.unitId === "string" && TAG_SAFE.test(u.unitId) &&
    !!u.tags && typeof u.tags === "object" && !Array.isArray(u.tags) && Object.entries(u.tags as Record<string, unknown>).every(([k, v]) => TAG_SAFE.test(k) && typeof v === "string" && TAG_SAFE.test(v)) &&
    Array.isArray(u.untagged) && u.untagged.every((a) => text(a) && !HAS_INVISIBLE.test(a as string));
}

const BUNDLE_KEYS = Object.keys(reviewBundleOf({ target: {}, changes: [] } as never)).sort();

/** A provenance block with exactly its fields: a program hash, and either qualification evidence or the reason there is none. */
function wellFormedProvenance(value: unknown): value is PreviewProvenance {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const p = value as Record<string, unknown>;
  const q = p.qualification as Record<string, unknown> | undefined;
  if (Object.keys(p).sort().join() !== "engineBinarySha256,qualification" || typeof p.engineBinarySha256 !== "string" || !HASH.test(p.engineBinarySha256) ||
    !q || typeof q !== "object" || Array.isArray(q)) return false;
  if (q.state === "QUALIFIED") {
    return Object.keys(q).sort().join() === "evidenceHash,qualifiedAt,state" && typeof q.evidenceHash === "string" && HASH.test(q.evidenceHash) &&
      typeof q.qualifiedAt === "string" && !Number.isNaN(Date.parse(q.qualifiedAt));
  }
  return q.state === "UNQUALIFIED" && Object.keys(q).sort().join() === "reason,state" && text(q.reason) && !HAS_INVISIBLE.test(q.reason as string);
}

/**
 * The apply runs only with the engine program that made the preview approvers signed. `binarySha256` is the program
 * this machine would run now (undefined when there is none). The CLI asks before the typed phrase, and the driver again.
 */
export function engineBinaryChange(sealed: Pick<SealedPlan, "provenance">, binarySha256: string | undefined):
  { ok: false; code: Extract<ApplyRefusalCode, "ENGINE_BINARY_CHANGED">; message: string } | undefined {
  if (binarySha256 === sealed.provenance.engineBinarySha256) return undefined;
  return {
    ok: false, code: "ENGINE_BINARY_CHANGED",
    message: (binarySha256 === undefined ? "The engine program cannot be found or read on this machine" : "The engine program on this machine (" + binarySha256.slice(0, 12) +
      ") is not the one that made this preview (" + sealed.provenance.engineBinarySha256.slice(0, 12) + ")") +
      ". Nothing was consumed. Put that program back, or seal and approve a new plan with this one.",
  };
}

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
  if (!s || typeof s !== "object" || !Buffer.isBuffer(planBytes)) return invalid("The sealed plan record is malformed.");
  // A record sealed before the requester signed (schema 1) is refused everywhere: every environment needs a requester (owner decision, #39).
  if (s.schemaVersion !== 2) return invalid("The sealed plan was made before requester signatures existed (or is malformed). Seal and approve a new plan.");
  if (!ENVIRONMENTS.includes(s.environment) || !PILOT_CHANNELS.includes(s.channel) || !s.target || typeof s.target !== "object" ||
    !Array.isArray(s.changes) || !s.changes.every(wellFormedChange) ||
    ![s.artifactSha256, s.planSha256, s.manifestHash, s.releaseIdentity, s.contractSha256, s.authorizationSha256, s.targetSha256].every((h) => typeof h === "string" && HASH.test(h)) ||
    typeof s.sourceCommit !== "string" || !COMMIT.test(s.sourceCommit) || !wellFormedProvenance(s.provenance) || !wellFormedUnit(s.unit) ||
    typeof s.requesterId !== "string" || !REQUESTER_ID.test(s.requesterId) || !wellFormedRequest(s.request)) {
    return invalid("The sealed plan record is malformed.");
  }
  let recomputed: string;
  try { recomputed = computeArtifactSha256(s); } catch { return tampered(); }
  if (sha256(planBytes) !== s.planSha256 || recomputed !== s.artifactSha256 || !requestBound(s.request, s)) return tampered();
  return { ok: true, sealed: s, planBytes };
}

/** Checks a review bundle against its own hashes and returns it. The one verification an approver relies on. */
export function verifyReviewBundle(value: unknown): { ok: true; bundle: ReviewBundle } | SealFault {
  const b = (value && typeof value === "object" && !Array.isArray(value) ? value : {}) as Partial<ReviewBundle>;
  const t = (b.target ?? {}) as Partial<ResolvedTarget>;
  if (Object.keys(b).sort().join() !== BUNDLE_KEYS.join() || !ENVIRONMENTS.includes(b.environment as ApplyEnvironment) || !PILOT_CHANNELS.includes(b.channel as PilotChannel) ||
    !["account", "backend", "workspace"].every((key) => text((t as Record<string, unknown>)[key])) ||
    !Array.isArray(b.changes) || !b.changes.every(wellFormedChange) || !text(b.engineVersion) || !text(b.policyVersion) || !text(b.createdAt) ||
    ![b.artifactSha256, b.planSha256, b.manifestHash, b.releaseIdentity, b.contractSha256, b.authorizationSha256, b.targetSha256, b.changesSha256].every((h) => typeof h === "string" && HASH.test(h)) ||
    typeof b.sourceCommit !== "string" || !COMMIT.test(b.sourceCommit) || !wellFormedProvenance(b.provenance) || !wellFormedUnit(b.unit) ||
    typeof b.requesterId !== "string" || !REQUESTER_ID.test(b.requesterId) || !wellFormedRequest(b.request)) {
    return invalid("The review bundle is malformed.");
  }
  const bundle = b as ReviewBundle;
  if (sha256(canonicalJson(bundle.changes)) !== bundle.changesSha256 || computeArtifactSha256(bundle) !== bundle.artifactSha256 || !requestBound(bundle.request!, bundle)) {
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
