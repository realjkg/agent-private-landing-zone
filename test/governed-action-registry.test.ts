import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import test from "node:test";

import {
  GOVERNED_ACTIONS, actionPayloadHash, canonicalActionLease,
  executeGovernedAction,
  type ActionReceipt, type ActionRegistryDeps,
  type ExternalActionLease, type GovernedAction,
  type GovernedActionRequest, type SignedActionLease,
} from "../src/actions/registry.js";

const keypair = generateKeyPairSync("ed25519");
const pem = keypair.publicKey.export({ type: "spki", format: "pem" }).toString();
const now = 1_800_000_000;
const H = "a".repeat(64), D = "b".repeat(64), C = "c".repeat(64);
function base(operation: GovernedAction): GovernedActionRequest {
  return {
    operation, target: "aws:account:111122223333:single-resource",
    payload: { name: "single-resource", operation },
    policyHash: H, designHash: D, changeSetHash: C,
    recoveryPointId: "recovery:capture-123",
    idempotencyKey: "request:abcd-1234", compromiseState: "VERIFIED",
  };
}
function signed(request: GovernedActionRequest, edits: Partial<ExternalActionLease> = {}): SignedActionLease {
  const lease: ExternalActionLease = {
    version: 1, issuer: "external-owner",
    leaseId: "external:ticket-1", operation: request.operation,
    operationLimit: 1, target: request.target, policyHash: request.policyHash,
    designHash: request.designHash, changeSetHash: request.changeSetHash,
    payloadHash: actionPayloadHash(request.payload),
    recoveryPointId: request.recoveryPointId, idempotencyKey: request.idempotencyKey,
    notBefore: now - 15, expiresAt: now + 60, ...edits,
  };
  return {
    lease,
    signature: sign(null, Buffer.from(canonicalActionLease(lease)),
      keypair.privateKey).toString("base64url"),
  };
}
function fixtures(): { deps: ActionRegistryDeps; receipts: ActionReceipt[]; claims: string[] } {
  const claims: string[] = [], receipts: ActionReceipt[] = [];
  const handle = async (request: GovernedActionRequest): Promise<ActionReceipt> => ({
    operation: request.operation, target: request.target, leaseId: "external:ticket-1",
    idempotencyKey: request.idempotencyKey, completed: true,
    providerEvidenceHash: H, recoveryEvidenceHash: D,
  });
  const handlers = Object.fromEntries(GOVERNED_ACTIONS.map((name) =>
    [name, handle])) as ActionRegistryDeps["handlers"];
  return {
    deps: {
      issuer: "external-owner", externalPublicKeyPem: pem,
      policyMode: "BUILTIN",
      handlers, nowSeconds: () => now,
      ledger: {
        mode: "DURABLE_EXTERNAL",
        claimOnce: async ({ leaseId, idempotencyKey }) => {
          const id = leaseId + ":" + idempotencyKey;
          if (claims.includes(id)) return false;
          claims.push(id); return true;
        },
        appendReceipt: async (receipt) => { receipts.push(receipt); },
      },
    },
    claims, receipts,
  };
}
test("each of four exact allowlisted operations requires external authority and emits recovery-linked receipt", async () => {
  for (const operation of GOVERNED_ACTIONS) {
    const request = base(operation);
    const f = fixtures();
    const receipt = await executeGovernedAction(request, signed(request), f.deps);
    assert.equal(receipt.completed, true);
    assert.equal(receipt.operation, operation);
    assert.equal(receipt.target, request.target);
    assert.equal(f.receipts.length, 1);
    assert.equal(f.claims.length, 1);
    await assert.rejects(executeGovernedAction(request, signed(request), f.deps),
      /LEASE_REPLAYED_OR_CONFLICTED/);
  }
});
test("the issuer—not the agent—pins target, lease age, hashes and one operation", async () => {
  const request = base("APPLY_APPROVED_TAGS");
  for (const edits of [
    { operationLimit: 2 as 1 }, { expiresAt: now + 500 },
    { notBefore: now + 1 }, { expiresAt: now - 1 },
    { target: "aws:account:another-target" },
    { changeSetHash: H }, { payloadHash: D },
  ]) {
    const f = fixtures();
    await assert.rejects(executeGovernedAction(request, signed(request, edits), f.deps));
    assert.equal(f.claims.length, 0, JSON.stringify(edits));
  }
  const f = fixtures();
  const unsigned = signed(request);
  unsigned.signature = "not-the-signature";
  await assert.rejects(executeGovernedAction(request, unsigned, f.deps),
    /INVALID_EXTERNAL_SIGNATURE/);
  assert.equal(f.claims.length, 0);
});
test("compromise lifecycle and local OPA are enforceable externally, never request-selectable", async () => {
  for (const compromiseState of ["SUSPECTED", "CONTAINED", "RECOVERY"] as const) {
    const request = { ...base("ROTATE_APPROVED_EVIDENCE"), compromiseState };
    const f = fixtures();
    await assert.rejects(executeGovernedAction(request, signed(request), f.deps),
      /COMPROMISE_LIFECYCLE_BLOCKS_ACTION/);
    assert.equal(f.claims.length, 0);
  }
  const request = base("CREATE_RECOVERY_POINT");
  const f = fixtures();
  f.deps.policyMode = "LOCAL_OPA";
  await assert.rejects(executeGovernedAction(request, signed(request), f.deps),
    /LOCAL_OPA_REQUIRED/);
  f.deps.localOpa = { evaluate: async () =>
    ({ source: "OPA", allow: false, obligations: [], reasons: ["denied"] }) };
  await assert.rejects(executeGovernedAction(request, signed(request), f.deps),
    /LOCAL_OPA_DENIED/);
  assert.equal(f.claims.length, 0);
  f.deps.localOpa = { evaluate: async () =>
    ({ source: "OPA", allow: true, obligations: [], reasons: [] }) };
  assert.equal((await executeGovernedAction(request, signed(request), f.deps)).completed, true);
});
test("an exact signed lease does not allow broad/cloud IaC commands or unregistered operations", async () => {
  const request = { ...base("CREATE_RECOVERY_POINT"),
    operation: "TERRAFORM_APPLY" as GovernedAction };
  const f = fixtures();
  await assert.rejects(executeGovernedAction(request, signed(request), f.deps),
    /OPERATION_NOT_ALLOWLISTED/);
  assert.equal(f.claims.length, 0);
});
test("one claimed lease fails closed if handler is absent or returns untrusted recovery evidence", async () => {
  const request = base("UPDATE_ONE_PREAUTHORIZED_POLICY_OBJECT");
  const f = fixtures();
  f.deps.handlers.UPDATE_ONE_PREAUTHORIZED_POLICY_OBJECT = async (req) => ({
    operation: req.operation, target: "another-resource",
    leaseId: "external:ticket-1", idempotencyKey: req.idempotencyKey,
    providerEvidenceHash: H, recoveryEvidenceHash: "", completed: true,
  });
  await assert.rejects(executeGovernedAction(request, signed(request), f.deps),
    /UNTRUSTED_ACTION_RECEIPT/);
  assert.equal(f.claims.length, 1);
  assert.equal(f.receipts.length, 0);
  await assert.rejects(executeGovernedAction(request, signed(request), f.deps),
    /LEASE_REPLAYED_OR_CONFLICTED/);
});
