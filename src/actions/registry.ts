import { createPublicKey, createHash, verify as verifySignature } from "node:crypto";

import { evaluateBuiltinSecurityPolicy } from "../security/policy/builtin.js";
import type { CompromiseState, SecurityPolicyDecision } from "../security/policy/types.js";

export const GOVERNED_ACTIONS = [
  "CREATE_RECOVERY_POINT",
  "ROTATE_APPROVED_EVIDENCE",
  "APPLY_APPROVED_TAGS",
  "UPDATE_ONE_PREAUTHORIZED_POLICY_OBJECT",
] as const;
export type GovernedAction = (typeof GOVERNED_ACTIONS)[number];

export type ExternalActionLease = {
  version: 1;
  issuer: string;
  leaseId: string;
  operation: GovernedAction;
  operationLimit: 1;
  target: string;
  policyHash: string;
  designHash: string;
  changeSetHash: string;
  payloadHash: string;
  recoveryPointId: string;
  idempotencyKey: string;
  notBefore: number;
  expiresAt: number;
};

export type SignedActionLease = {
  lease: ExternalActionLease;
  signature: string; // Base64url Ed25519 over canonical lease JSON.
};
export type ActionReceipt = {
  operation: GovernedAction;
  target: string;
  leaseId: string;
  idempotencyKey: string;
  providerEvidenceHash: string;
  recoveryEvidenceHash: string;
  completed: true;
};

export type GovernedActionRequest = {
  operation: GovernedAction;
  target: string;
  payload: unknown;
  policyHash: string;
  designHash: string;
  changeSetHash: string;
  recoveryPointId: string;
  idempotencyKey: string;
  compromiseState: CompromiseState;
  opaRequired: boolean;
};
export type ActionPolicy = {
  evaluate(request: GovernedActionRequest): Promise<SecurityPolicyDecision>;
};
export type ReplayLedger = {
  mode: "DURABLE_EXTERNAL";
  /** Transactional compare-and-claim. FALSE means lease/key already consumed. */
  claimOnce(input: {
    leaseId: string;
    idempotencyKey: string;
    operation: GovernedAction;
    target: string;
    requestHash: string;
  }): Promise<boolean>;
  appendReceipt(receipt: ActionReceipt): Promise<void>;
};
export type AuthorizedHandlers = {
  CREATE_RECOVERY_POINT: (request: GovernedActionRequest) => Promise<ActionReceipt>;
  ROTATE_APPROVED_EVIDENCE: (request: GovernedActionRequest) => Promise<ActionReceipt>;
  APPLY_APPROVED_TAGS: (request: GovernedActionRequest) => Promise<ActionReceipt>;
  UPDATE_ONE_PREAUTHORIZED_POLICY_OBJECT: (request: GovernedActionRequest) => Promise<ActionReceipt>;
};
export type ActionRegistryDeps = {
  issuer: string;
  externalPublicKeyPem: string;
  ledger: ReplayLedger;
  handlers: AuthorizedHandlers;
  localOpa?: ActionPolicy;
  nowSeconds?: () => number;
};

const digest = (input: string) => createHash("sha256").update(input).digest("hex");
const sha = /^[a-f0-9]{64}$/;
const allowed = new Set<string>(GOVERNED_ACTIONS);
function deny(code: string): never { throw new Error("GOVERNED_ACTION_DENIED:" + code); }
function exactHash(value: unknown): value is string {
  return typeof value === "string" && sha.test(value);
}
function validName(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256 &&
    !/[\r\n\0]/.test(value);
}
function leasePayload(lease: ExternalActionLease): string {
  // Explicit ordering prevents accidental permission extension by extra keys.
  return JSON.stringify({
    version: lease.version, issuer: lease.issuer, leaseId: lease.leaseId,
    operation: lease.operation, operationLimit: lease.operationLimit,
    target: lease.target, policyHash: lease.policyHash,
    designHash: lease.designHash, changeSetHash: lease.changeSetHash,
    payloadHash: lease.payloadHash, recoveryPointId: lease.recoveryPointId,
    idempotencyKey: lease.idempotencyKey, notBefore: lease.notBefore,
    expiresAt: lease.expiresAt,
  });
}

export function actionPayloadHash(payload: unknown): string {
  if (payload === null || typeof payload !== "object" ||
    Array.isArray(payload)) deny("PAYLOAD_MUST_BE_STRUCTURED");
  const value = JSON.stringify(payload);
  if (!value || value.length > 8192) deny("PAYLOAD_TOO_LARGE");
  return digest(value);
}

/**
 * The registry has NO direct cloud/CLI path. Only the four trusted,
 * typed handlers may perform the exact mutation, after externally signed
 * authority and local builtin/OPA policy and durable replay checks pass.
 */
export async function executeGovernedAction(
  request: GovernedActionRequest,
  signed: SignedActionLease,
  deps: ActionRegistryDeps,
): Promise<ActionReceipt> {
  const lease = signed?.lease;
  if (!lease || !allowed.has(request.operation) ||
      !allowed.has(lease.operation) || request.operation !== lease.operation ||
      lease.version !== 1 || lease.operationLimit !== 1) deny("OPERATION_NOT_ALLOWLISTED");
  if (lease.issuer !== deps.issuer || !validName(lease.issuer) ||
      !validName(lease.leaseId) || !validName(lease.target) ||
      !validName(lease.idempotencyKey) || !validName(lease.recoveryPointId) ||
      !validName(request.target) || !validName(request.recoveryPointId) ||
      !validName(request.idempotencyKey) ||
      request.target !== lease.target ||
      request.idempotencyKey !== lease.idempotencyKey ||
      request.recoveryPointId !== lease.recoveryPointId) deny("EXACT_SCOPE_MISMATCH");
  if (![lease.policyHash, lease.designHash, lease.changeSetHash,
      lease.payloadHash, request.policyHash, request.designHash,
      request.changeSetHash].every(exactHash) ||
      lease.policyHash !== request.policyHash ||
      lease.designHash !== request.designHash ||
      lease.changeSetHash !== request.changeSetHash ||
      lease.payloadHash !== actionPayloadHash(request.payload)) deny("APPROVED_HASH_MISMATCH");
  const now = deps.nowSeconds?.() ?? Math.floor(Date.now() / 1000);
  if (!Number.isSafeInteger(lease.notBefore) ||
      !Number.isSafeInteger(lease.expiresAt) ||
      lease.expiresAt <= lease.notBefore ||
      lease.expiresAt - lease.notBefore > 300 ||
      now < lease.notBefore || now >= lease.expiresAt) deny("LEASE_NOT_CURRENT");
  if (request.compromiseState !== "NORMAL" &&
      request.compromiseState !== "VERIFIED") deny("COMPROMISE_LIFECYCLE_BLOCKS_ACTION");
  if (!deps.externalPublicKeyPem || typeof signed.signature !== "string") {
    deny("EXTERNAL_SIGNATURE_REQUIRED");
  }
  try {
    const publicKey = createPublicKey(deps.externalPublicKeyPem);
    if (publicKey.asymmetricKeyType !== "ed25519" ||
        !verifySignature(null, Buffer.from(leasePayload(lease)),
          publicKey, Buffer.from(signed.signature, "base64url"))) {
      deny("INVALID_EXTERNAL_SIGNATURE");
    }
  } catch {
    deny("INVALID_EXTERNAL_SIGNATURE");
  }
  const builtin = evaluateBuiltinSecurityPolicy({
    kind: "CAPABILITY", compromiseState: request.compromiseState,
    requested: ["EVIDENCE_READ", "EVIDENCE_WRITE"],
  });
  if (!builtin.allow || builtin.source !== "BUILTIN") deny("BUILTIN_POLICY_DENIED");
  if (request.opaRequired) {
    if (!deps.localOpa) deny("LOCAL_OPA_REQUIRED");
    const local = await deps.localOpa.evaluate(request);
    if (!local.allow || local.source !== "OPA") deny("LOCAL_OPA_DENIED");
  }
  if (deps.ledger.mode !== "DURABLE_EXTERNAL") deny("DURABLE_REPLAY_LEDGER_REQUIRED");
  const requestHash = digest(JSON.stringify({
    lease: leasePayload(lease), operation: request.operation, target: request.target,
  }));
  const claimed = await deps.ledger.claimOnce({
    leaseId: lease.leaseId, idempotencyKey: lease.idempotencyKey,
    operation: lease.operation, target: lease.target, requestHash,
  });
  if (!claimed) deny("LEASE_REPLAYED_OR_CONFLICTED");
  // Missing runtime handlers must fail closed AFTER claim to prevent reuse.
  const handler = deps.handlers[request.operation];
  if (typeof handler !== "function") deny("HANDLER_NOT_REGISTERED");
  const receipt = await handler(request);
  if (receipt.completed !== true || receipt.operation !== request.operation ||
      receipt.target !== request.target || receipt.leaseId !== lease.leaseId ||
      receipt.idempotencyKey !== request.idempotencyKey ||
      !exactHash(receipt.providerEvidenceHash) ||
      !exactHash(receipt.recoveryEvidenceHash)) deny("UNTRUSTED_ACTION_RECEIPT");
  await deps.ledger.appendReceipt(receipt);
  return receipt;
}
