import { randomUUID, sign, verify, type KeyLike } from "node:crypto";
import { runtimeProfile } from "../runtime-profile/catalog.js";
import type { RuntimeProfileId } from "../runtime-profile/types.js";

export type A2AIntent = "DISCOVER" | "DIAGNOSE" | "VALIDATE" | "PREVIEW" | "RECOVERY_TEST";
export type A2AEndpoint = {
  environmentId: string;
  harnessId: string;
  sovereigntyDomainId: string;
};
export type A2ATaskEnvelope = {
  schemaVersion: 1;
  envelopeId: string;
  source: A2AEndpoint;
  destination: A2AEndpoint;
  taskId: string;
  intent: A2AIntent;
  evidenceRefs: string[];
  delegationDepth: number;
  maxHops: number;
  issuedAt: string;
  expiresAt: string;
  parentEnvelopeId?: string;
};
export type SignedA2ATaskEnvelope = {
  payload: A2ATaskEnvelope;
  algorithm: "Ed25519";
  signerHarnessId: string;
  signatureBase64: string;
};
export interface A2AReplayStore {
  /** Atomically claim envelopeId once; must be durable across restarts at production destination. */
  claimOnce(envelopeId: string, expiresAt: string): Promise<boolean>;
}
export interface A2ADestinationAuthorizer {
  /** All incoming task and evidence references are untrusted even when signature verifies. */
  authorizeUntrusted(input: {
    source: A2AEndpoint;
    destination: A2AEndpoint;
    taskId: string;
    intent: A2AIntent;
    evidenceRefs: string[];
    untrusted: true;
  }): Promise<{ allow: boolean; localDecisionId?: string }>;
}
export type LocalA2ADestination = {
  endpoint: A2AEndpoint;
  profileId: RuntimeProfileId;
  trustedSourceKeys: Record<string, KeyLike>;
  replayStore: A2AReplayStore;
  authorizer: A2ADestinationAuthorizer;
};
export type A2AAcceptance = {
  accepted: true;
  taskId: string;
  intent: A2AIntent;
  evidenceRefs: string[];
  localDecisionId: string;
  remoteAuthorityGranted: false;
  actForwarded: false;
  untrustedInputs: true;
};

const IDENTIFIER = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,79}$/;
const EVIDENCE = /^evidence:\/\/[a-zA-Z0-9._/-]{1,128}$/;
const INTENTS: readonly A2AIntent[] = ["DISCOVER","DIAGNOSE","VALIDATE","PREVIEW","RECOVERY_TEST"];
const PAYLOAD_KEYS = [
  "schemaVersion", "envelopeId", "source", "destination", "taskId", "intent",
  "evidenceRefs", "delegationDepth", "maxHops", "issuedAt", "expiresAt",
];
function deny(code: string): never { throw new Error("A2A_CONFINEMENT_" + code); }
function assertKeys(value: unknown, expected: string[], optional: string[] = []): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) deny("SCHEMA_DENIED");
  const keys = Object.keys(value);
  if (keys.some((k) => !expected.includes(k) && !optional.includes(k)) ||
    expected.some((k) => !keys.includes(k))) deny("SCHEMA_DENIED");
}
function id(value: unknown): string {
  if (typeof value !== "string" || !IDENTIFIER.test(value)) return deny("ID_INVALID");
  return value;
}
function endpoint(value: A2AEndpoint): A2AEndpoint {
  assertKeys(value, ["environmentId", "harnessId", "sovereigntyDomainId"]);
  return { environmentId: id(value.environmentId), harnessId: id(value.harnessId), sovereigntyDomainId: id(value.sovereigntyDomainId) };
}
function refs(input: unknown): string[] {
  if (!Array.isArray(input) || input.length > 100 || !input.every((v) =>
    typeof v === "string" && EVIDENCE.test(v) && !v.includes(".."))) deny("EVIDENCE_INVALID");
  if (new Set(input).size !== input.length) deny("DUPLICATE_EVIDENCE");
  return input as string[];
}
function canonical(payload: A2ATaskEnvelope): string {
  return JSON.stringify(payload);
}
function strictProfile(profileId: RuntimeProfileId, source: A2AEndpoint, destination: A2AEndpoint): void {
  const profile = runtimeProfile(profileId);
  if (profile.a2a === "DISABLED") deny("PROFILE_DISABLED");
  if (profile.a2a === "SAME_SOVEREIGN_DOMAIN_ONLY" &&
      source.sovereigntyDomainId !== destination.sovereigntyDomainId) deny("CROSS_SOVEREIGNTY_DOMAIN");
}
function validatePayload(input: A2ATaskEnvelope, now: number): A2ATaskEnvelope {
  assertKeys(input, PAYLOAD_KEYS, ["parentEnvelopeId"]);
  if (input.schemaVersion !== 1) deny("VERSION_DENIED");
  id(input.envelopeId); id(input.taskId);
  const source = endpoint(input.source);
  const destination = endpoint(input.destination);
  if (source.harnessId === destination.harnessId && source.environmentId === destination.environmentId) deny("SELF_DELIVERY_DENIED");
  if (!INTENTS.includes(input.intent)) deny("FORWARDED_INTENT_DENIED");
  const evidenceRefs = refs(input.evidenceRefs);
  if (!Number.isSafeInteger(input.delegationDepth) || input.delegationDepth < 0 || input.delegationDepth > 2 ||
    !Number.isSafeInteger(input.maxHops) || input.maxHops < 1 || input.maxHops > 3 ||
    input.delegationDepth >= input.maxHops) deny("HOP_LIMIT_DENIED");
  if (input.parentEnvelopeId !== undefined) id(input.parentEnvelopeId);
  if (input.delegationDepth > 0 && !input.parentEnvelopeId) deny("PARENT_ENVELOPE_REQUIRED");
  const issued = Date.parse(input.issuedAt);
  const expires = Date.parse(input.expiresAt);
  if (!/^\d{4}-\d{2}-\d{2}T/.test(input.issuedAt) || !/^\d{4}-\d{2}-\d{2}T/.test(input.expiresAt) ||
    !Number.isFinite(issued) || !Number.isFinite(expires) || issued > now + 15000 ||
    expires <= now || expires <= issued || expires - issued > 300000) deny("TTL_DENIED");
  return {
    schemaVersion: 1, envelopeId: input.envelopeId, source, destination,
    taskId: input.taskId, intent: input.intent, evidenceRefs,
    delegationDepth: input.delegationDepth, maxHops: input.maxHops,
    issuedAt: input.issuedAt, expiresAt: input.expiresAt,
    ...(input.parentEnvelopeId ? { parentEnvelopeId: input.parentEnvelopeId } : {}),
  };
}
function signerKey(source: A2AEndpoint): string {
  return source.environmentId + "/" + source.harnessId;
}
/** Source-side signing never embeds raw prompts, credentials, MFA state, leases or ACT authority. */
export function signA2ATask(input: {
  source: A2AEndpoint; destination: A2AEndpoint; taskId: string; intent: A2AIntent;
  evidenceRefs: string[]; privateKey: KeyLike; profileId: RuntimeProfileId;
  delegationDepth?: number; maxHops?: number; parentEnvelopeId?: string;
  ttlSeconds?: number; now?: Date;
}): SignedA2ATaskEnvelope {
  const issued = input.now ?? new Date();
  const ttlSeconds = input.ttlSeconds ?? 60;
  if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > 300) deny("TTL_DENIED");
  const source = endpoint(input.source);
  const destination = endpoint(input.destination);
  strictProfile(input.profileId, source, destination);
  const payload = validatePayload({
    schemaVersion: 1, envelopeId: randomUUID(), source, destination,
    taskId: input.taskId, intent: input.intent, evidenceRefs: input.evidenceRefs,
    delegationDepth: input.delegationDepth ?? 0, maxHops: input.maxHops ?? 2,
    issuedAt: issued.toISOString(), expiresAt: new Date(issued.getTime() + ttlSeconds * 1000).toISOString(),
    ...(input.parentEnvelopeId ? { parentEnvelopeId: input.parentEnvelopeId } : {}),
  }, issued.getTime());
  return {
    payload, algorithm: "Ed25519", signerHarnessId: source.harnessId,
    signatureBase64: sign(null, Buffer.from(canonical(payload)), input.privateKey).toString("base64"),
  };
}

/** Destination never inherits human identity, permissions, leases or ACT from the sender. */
export async function acceptA2ATask(
  envelope: SignedA2ATaskEnvelope,
  destination: LocalA2ADestination,
  now: Date = new Date(),
): Promise<A2AAcceptance> {
  assertKeys(envelope, ["payload", "algorithm", "signerHarnessId", "signatureBase64"]);
  if (envelope.algorithm !== "Ed25519") deny("SIGNATURE_ALGORITHM_DENIED");
  const payload = validatePayload(envelope.payload, now.getTime());
  const local = endpoint(destination.endpoint);
  if (payload.destination.environmentId !== local.environmentId ||
    payload.destination.harnessId !== local.harnessId ||
    payload.destination.sovereigntyDomainId !== local.sovereigntyDomainId) deny("DESTINATION_MISMATCH");
  strictProfile(destination.profileId, payload.source, payload.destination);
  if (envelope.signerHarnessId !== payload.source.harnessId) deny("SIGNER_MISMATCH");
  const sourceKey = destination.trustedSourceKeys[signerKey(payload.source)];
  if (!sourceKey || typeof envelope.signatureBase64 !== "string" ||
    !/^[a-zA-Z0-9+/]+={0,2}$/.test(envelope.signatureBase64)) deny("SOURCE_UNTRUSTED");
  let signatureVerified = false;
  try {
    signatureVerified = verify(null, Buffer.from(canonical(payload)), sourceKey,
      Buffer.from(envelope.signatureBase64, "base64"));
  } catch { signatureVerified = false; }
  if (!signatureVerified) deny("SIGNATURE_INVALID");
  let decision: { allow: boolean; localDecisionId?: string };
  try {
    decision = await destination.authorizer.authorizeUntrusted({
      source: payload.source, destination: payload.destination, taskId: payload.taskId,
      intent: payload.intent, evidenceRefs: payload.evidenceRefs, untrusted: true,
    });
  } catch { return deny("DESTINATION_POLICY_UNAVAILABLE"); }
  if (!decision?.allow || typeof decision.localDecisionId !== "string" ||
    !IDENTIFIER.test(decision.localDecisionId)) deny("DESTINATION_POLICY_DENIED");
  if (!destination.replayStore) deny("REPLAY_STORE_REQUIRED");
  let claimed = false;
  try { claimed = await destination.replayStore.claimOnce(payload.envelopeId, payload.expiresAt); }
  catch { return deny("REPLAY_STORE_UNAVAILABLE"); }
  if (!claimed) deny("REPLAY_DENIED");
  return {
    accepted: true, taskId: payload.taskId, intent: payload.intent,
    evidenceRefs: [...payload.evidenceRefs], localDecisionId: decision.localDecisionId,
    remoteAuthorityGranted: false, actForwarded: false, untrustedInputs: true,
  };
}
