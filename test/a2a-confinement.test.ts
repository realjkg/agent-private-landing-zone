import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";
import { acceptA2ATask, signA2ATask, type LocalA2ADestination, type SignedA2ATaskEnvelope } from "../src/a2a/confinement.js";

const now = new Date("2026-10-08T04:30:00.000Z");
function suite() {
  const key = generateKeyPairSync("ed25519");
  const source = { environmentId: "private-a", harnessId: "agent-harness-a", sovereigntyDomainId: "domain-1" };
  const target = { environmentId: "private-b", harnessId: "agent-harness-b", sovereigntyDomainId: "domain-1" };
  const used = new Set<string>();
  let allows = true;
  let calls = 0;
  const local: LocalA2ADestination = {
    endpoint: target, profileId: "PRIVATE_SOVEREIGN_CONNECTED",
    trustedSourceKeys: { ["private-a/agent-harness-a"]: key.publicKey },
    replayStore: { claimOnce: async (id) => { if (used.has(id)) return false; used.add(id); return true; } },
    authorizer: { authorizeUntrusted: async (input) => {
      calls++;
      assert.equal(input.untrusted, true);
      return { allow: allows, localDecisionId: "dest-policy-001" };
    } },
  };
  const create = () => signA2ATask({
    source, destination: target, taskId: "task-1", intent: "DIAGNOSE",
    evidenceRefs: ["evidence://ops/trust-1"], privateKey: key.privateKey,
    profileId: "PRIVATE_SOVEREIGN_CONNECTED", now,
  });
  return { source, target, key, local, create, calls: () => calls, policy: (v: boolean) => { allows = v; } };
}
test("valid signed envelope is confined to target and locally authorized as untrusted", async () => {
  const h = suite();
  const envelope = h.create();
  const outcome = await acceptA2ATask(envelope, h.local, now);
  assert.equal(outcome.accepted, true);
  assert.equal(outcome.actForwarded, false);
  assert.equal(outcome.remoteAuthorityGranted, false);
  assert.equal(outcome.untrustedInputs, true);
  assert.equal(outcome.localDecisionId, "dest-policy-001");
  assert.equal(h.calls(), 1);
  assert.equal(JSON.stringify(envelope).includes("lease"), false);
  assert.equal(JSON.stringify(envelope).includes("credential"), false);
});

test("replays, cross-target mismatch, tampering and untrusted signer keys fail closed", async () => {
  const h = suite();
  const e = h.create();
  await acceptA2ATask(e, h.local, now);
  await assert.rejects(() => acceptA2ATask(e, h.local, now), /REPLAY_DENIED/);
  await assert.rejects(() => acceptA2ATask(h.create(), { ...h.local, endpoint: { ...h.target, environmentId: "other" } }, now), /DESTINATION_MISMATCH/);
  const forged = structuredClone(h.create());
  forged.payload.intent = "VALIDATE";
  await assert.rejects(() => acceptA2ATask(forged, h.local, now), /SIGNATURE_INVALID/);
  await assert.rejects(() => acceptA2ATask(h.create(), { ...h.local, trustedSourceKeys: {} }, now), /SOURCE_UNTRUSTED/);
});

test("strict private sovereign profile denies cross-domain A2A and disconnected profile disables A2A", async () => {
  const h = suite();
  assert.throws(() => signA2ATask({
    source: h.source, destination: { ...h.target, sovereigntyDomainId: "domain-2" },
    taskId: "task-1", intent: "DIAGNOSE", evidenceRefs: [],
    privateKey: h.key.privateKey, profileId: "PRIVATE_SOVEREIGN_CONNECTED", now,
  }), /CROSS_SOVEREIGNTY_DOMAIN/);
  assert.throws(() => signA2ATask({
    source: h.source, destination: h.target, taskId: "task-1", intent: "DIAGNOSE",
    evidenceRefs: [], privateKey: h.key.privateKey, profileId: "PRIVATE_SOVEREIGN_DISCONNECTED", now,
  }), /PROFILE_DISABLED/);
  await assert.rejects(() => acceptA2ATask(h.create(), { ...h.local, profileId: "PRIVATE_SOVEREIGN_DISCONNECTED" }, now), /PROFILE_DISABLED/);
});

test("source cannot forward credentials, MFA state, capability lease or ACT intents", async () => {
  const h = suite();
  const e = h.create() as unknown as Record<string, unknown>;
  e.credential = "token";
  await assert.rejects(() => acceptA2ATask(e as unknown as SignedA2ATaskEnvelope, h.local, now), /SCHEMA_DENIED/);
  for (const field of ["lease", "mfa", "act", "password", "agentCredentials"]) {
    const bad = h.create();
    (bad.payload as unknown as Record<string, unknown>)[field] = "should-be-blocked";
    await assert.rejects(() => acceptA2ATask(bad, h.local, now), /SCHEMA_DENIED/);
  }
  for (const intent of ["OPERATE","ACT","terraform apply","pulumi up"] as const) {
    assert.throws(() => signA2ATask({
      source: h.source, destination: h.target, taskId: "task-1",
      intent: intent as "DIAGNOSE", evidenceRefs: [], privateKey: h.key.privateKey,
      profileId: "PRIVATE_SOVEREIGN_CONNECTED", now,
    }), /FORWARDED_INTENT_DENIED/);
  }
});

test("destination local policy cannot be replaced with signed remote approval", async () => {
  const h = suite();
  h.policy(false);
  await assert.rejects(() => acceptA2ATask(h.create(), h.local, now), /DESTINATION_POLICY_DENIED/);
});

test("hop/delegation limit, clock TTL and parent lineage are enforced", async () => {
  const h = suite();
  for (const n of [0, 4, 100]) {
    assert.throws(() => signA2ATask({
      source: h.source, destination: h.target, taskId: "task-1", intent: "DIAGNOSE",
      evidenceRefs: [], privateKey: h.key.privateKey, profileId: "PRIVATE_SOVEREIGN_CONNECTED",
      maxHops: n, now,
    }), /HOP_LIMIT_DENIED/);
  }
  assert.throws(() => signA2ATask({
    source: h.source, destination: h.target, taskId: "task-1", intent: "DIAGNOSE",
    evidenceRefs: [], privateKey: h.key.privateKey, profileId: "PRIVATE_SOVEREIGN_CONNECTED",
    delegationDepth: 1, maxHops: 2, now,
  }), /PARENT_ENVELOPE_REQUIRED/);
  const expired = h.create();
  await assert.rejects(() => acceptA2ATask(expired, h.local, new Date(now.getTime() + 120000)), /TTL_DENIED/);
});
