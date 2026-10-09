import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import test from "node:test";

import { actWithExternalLease } from "../src/agent/act.js";
import { fixtureThinker } from "../src/agent/fixture.js";
import { runAgentKernel } from "../src/agent/graph.js";
import {
  actionPayloadHash, canonicalActionLease, type ActionRegistryDeps,
  type ExternalActionLease, type GovernedActionRequest,
} from "../src/actions/registry.js";

const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const now = 1_800_000_000;
const changeSetHash = "d".repeat(64);
function registry() {
  let calls = 0;
  let claimed = false;
  const handler: ActionRegistryDeps["handlers"]["CREATE_RECOVERY_POINT"] = async (request) => {
    calls += 1;
    return {
      operation: request.operation, target: request.target,
      leaseId: "external:case-1", idempotencyKey: request.idempotencyKey,
      providerEvidenceHash: "e".repeat(64),
      recoveryEvidenceHash: "f".repeat(64), completed: true,
    };
  };
  const deps: ActionRegistryDeps = {
    issuer: "external-owner",
    externalPublicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
    policyMode: "BUILTIN", trustedCompromiseState: "VERIFIED", nowSeconds: () => now,
    ledger: {
      mode: "DURABLE_EXTERNAL",
      claimOnce: async () => {
        if (claimed) return false;
        claimed = true; return true;
      },
      appendReceipt: async () => {},
    },
    handlers: {
      CREATE_RECOVERY_POINT: handler, ROTATE_APPROVED_EVIDENCE: handler,
      APPLY_APPROVED_TAGS: handler,
      UPDATE_ONE_PREAUTHORIZED_POLICY_OBJECT: handler,
    },
  };
  return { deps, calls: () => calls };
}
async function caseState() {
  const state = await runAgentKernel({
    request: "Build an additive Terraform preview for AWS brownfield.",
    provider: "AWS", engine: "TERRAFORM", mock: "brownfield",
    thinker: fixtureThinker, approveBuild: true,
  });
  assert.ok(state.build && state.design && state.environment && state.assessment);
  state.mock = undefined;
  state.build.candidate.artifact.generatedBy = "local-qwen-mistral-reviewed-template";
  state.build.candidate.status = "APPROVED";
  state.build.candidate.evidence.approvedArtifactHash =
    state.build.candidate.artifact.contentHash;
  state.build.candidate.evidence.approvedDesignHash = state.design.designHash;
  state.build.previewSummary = JSON.stringify({
    normalizedChangeSetHash: changeSetHash,
  });
  return state;
}
function credentials(request: GovernedActionRequest) {
  const lease: ExternalActionLease = {
    version: 1, issuer: "external-owner", leaseId: "external:case-1",
    operation: request.operation, operationLimit: 1,
    target: request.target,
    policyHash: request.policyHash, designHash: request.designHash,
    changeSetHash: request.changeSetHash,
    payloadHash: actionPayloadHash(request.payload),
    recoveryPointId: request.recoveryPointId,
    idempotencyKey: request.idempotencyKey,
    notBefore: now - 5, expiresAt: now + 60,
  };
  return {
    lease, signature: sign(null, Buffer.from(canonicalActionLease(lease)),
      privateKey).toString("base64url"),
  };
}
test("only the externally signed, exact approved state can reach governed ACT", async () => {
  // Injected fixture state and fake handler validate the boundary, not a cloud action.
  const state = await caseState();
  const request: GovernedActionRequest = {
    operation: "CREATE_RECOVERY_POINT",
    target: "aws:account:111122223333:recovery-object",
    payload: { requested: "one" }, policyHash: state.design!.policies.bundleHash,
    designHash: state.design!.designHash, changeSetHash,
    recoveryPointId: "r:1", idempotencyKey: "request:1",
    compromiseState: "VERIFIED",
  };
  const expected = registry();
  const result = await actWithExternalLease(state, request,
    credentials(request), expected.deps);
  assert.equal(expected.calls(), 1);
  assert.equal(result.state.action?.status, "EXECUTED");
  assert.equal(result.state.action?.executed, true);
  assert.equal(result.state.observation?.verified, false);
  assert.equal(result.state.observation?.mutationObserved, true);
  assert.equal(result.state.observation?.evidence.length, 2);
  await assert.rejects(actWithExternalLease(state, request,
    credentials(request), expected.deps), /LEASE_REPLAYED_OR_CONFLICTED/);
});
test("fake fixture, changed policy or changed ChangeSet are denied before the handler", async () => {
  const state = await caseState();
  const request: GovernedActionRequest = {
    operation: "APPLY_APPROVED_TAGS",
    target: "aws:account:111122223333:single-object",
    payload: { tags: { owner: "team" } },
    policyHash: state.design!.policies.bundleHash,
    designHash: state.design!.designHash, changeSetHash,
    recoveryPointId: "r:1", idempotencyKey: "request:1",
    compromiseState: "VERIFIED",
  };
  for (const altered of [
    { ...state, mock: "brownfield" as const },
    { ...state, build: { ...state.build!, candidate: {
      ...state.build!.candidate,
      artifact: { ...state.build!.candidate.artifact,
        generatedBy: "fixture-generator" },
    } } },
    { ...state, build: { ...state.build!,
      previewSummary: JSON.stringify({ normalizedChangeSetHash: "a".repeat(64) }) } },
  ]) {
    const f = registry();
    await assert.rejects(actWithExternalLease(altered, request,
      credentials(request), f.deps));
    assert.equal(f.calls(), 0);
  }
});
