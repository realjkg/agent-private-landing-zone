import assert from "node:assert/strict";
import test from "node:test";
import { DelegatedAgentAuthority, type LeaseRequest, type HumanIdentityAttestation } from "../src/delegation/identity.js";

const request = (): LeaseRequest => ({
  sessionRef: "session-1", agent: { agentId: "agent-1", harnessId: "harness-1" },
  taskId: "task-1", environmentId: "private-01", resourceId: "service-1",
  operation: "DIAGNOSTIC", ttlSeconds: 60, maxExecutions: 2,
});
function harness() {
  let now = Date.parse("2026-10-08T04:00:00Z");
  let state: "NORMAL" | "SUSPECTED" = "NORMAL";
  let mfa: HumanIdentityAttestation["mfaAssurance"] = "AAL2";
  let entitled = true;
  let policyAllow = true;
  let decision = "policy-1";
  let verificationCount = 0;
  const provider = new DelegatedAgentAuthority(
    { verifySession: async (ref) => {
      verificationCount++;
      return { subjectId: "human-1", sessionRef: ref, mfaAssurance: mfa, mfaVerifiedAt: new Date(now - 1000).toISOString(), verified: true };
    } },
    { forSubject: async () => entitled ? [
      { roleId: "operator", operation: "DIAGNOSTIC", environmentId: "private-01", resourceId: "service-1" },
      { roleId: "maintainer", operation: "RESTART_SERVICE", environmentId: "private-01", resourceId: "service-1" },
    ] : [] },
    { evaluate: async () => ({ allow: policyAllow, decisionId: policyAllow ? decision : undefined }) },
    () => state, () => now,
  );
  return {
    provider, now: () => now, advance: (ms: number) => { now += ms; },
    mfa: (v: typeof mfa) => { mfa = v; },
    state: (v: typeof state) => { state = v; },
    entitled: (v: boolean) => { entitled = v; },
    policy: (v: boolean) => { policyAllow = v; },
    decision: (v: string) => { decision = v; },
    count: () => verificationCount,
  };
}

test("human and agent remain distinct with individually bounded MFA/RBAC/policy task lease", async () => {
  const h = harness();
  const lease = await h.provider.issue(request());
  assert.equal(lease.humanSubjectId, "human-1");
  assert.equal(lease.agentActorId, "agent-1");
  assert.equal(lease.harnessId, "harness-1");
  assert.equal(lease.maxExecutions, 2);
  const once = await h.provider.consume({ ...request(), leaseId: lease.leaseId });
  assert.equal(once.executions, 1);
  const twice = await h.provider.consume({ ...request(), leaseId: lease.leaseId });
  assert.equal(twice.executions, 2);
  await assert.rejects(() => h.provider.consume({ ...request(), leaseId: lease.leaseId }), /LEASE_EXHAUSTED/);
  assert.equal(h.count(), 3);
  assert.equal(h.provider.inspect(lease.leaseId)?.active, false);
});

test("typed scope and separate actor are rechecked every execution", async () => {
  const h = harness();
  const lease = await h.provider.issue(request());
  for (const mismatch of [
    { resourceId: "service-2" }, { environmentId: "other" }, { taskId: "unrelated" },
    { agent: { agentId: "agent-2", harnessId: "harness-1" } }, { operation: "RESTART_SERVICE" as const },
  ]) {
    await assert.rejects(() => h.provider.consume({ ...request(), leaseId: lease.leaseId, ...mismatch }), /LEASE_SCOPE_DENIED/);
  }
  assert.equal(h.provider.inspect(lease.leaseId)?.executions, 0);
});

test("MFA freshness, AAL3 for remediation, and explicit trusted RBAC prevent escalation", async () => {
  const h = harness();
  await assert.rejects(() => h.provider.issue({ ...request(), operation: "RESTART_SERVICE" }), /HUMAN_MFA_REQUIRED/);
  h.mfa("AAL3");
  const lease = await h.provider.issue({ ...request(), operation: "RESTART_SERVICE" });
  assert.equal(lease.operation, "RESTART_SERVICE");
  h.entitled(false);
  await assert.rejects(() => h.provider.consume({ ...request(), operation: "RESTART_SERVICE", leaseId: lease.leaseId }), /RBAC_DENIED/);
});

test("compromise policy and deterministic policy can deny regardless of MFA or role", async () => {
  const h = harness();
  h.policy(false);
  await assert.rejects(() => h.provider.issue(request()), /DETERMINISTIC_POLICY_DENIED/);
  h.policy(true);
  h.state("SUSPECTED");
  h.mfa("AAL3");
  await assert.rejects(() => h.provider.issue({ ...request(), operation: "RESTART_SERVICE" }), /SECURITY_POLICY_DENIED/);
});

test("lease TTL, revocation and bounded counters are fail closed", async () => {
  const h = harness();
  const lease = await h.provider.issue(request());
  h.advance(61000);
  await assert.rejects(() => h.provider.consume({ ...request(), leaseId: lease.leaseId }), /LEASE_EXPIRED/);
  const fresh = await h.provider.issue(request());
  assert.equal(h.provider.revoke(fresh.leaseId), true);
  await assert.rejects(() => h.provider.consume({ ...request(), leaseId: fresh.leaseId }), /LEASE_NOT_ACTIVE/);
  for (const ttlSeconds of [0, -1, 601]) {
    await assert.rejects(() => h.provider.issue({ ...request(), ttlSeconds }), /LEASE_BOUNDS_INVALID/);
  }
  for (const maxExecutions of [0, 6, 2000]) {
    await assert.rejects(() => h.provider.issue({ ...request(), maxExecutions }), /LEASE_BOUNDS_INVALID/);
  }
});

test("generic IaC apply/deploy, arbitrary shell and global ACT cannot acquire a typed lease", async () => {
  const h = harness();
  for (const operation of ["terraform apply", "pulumi up", "cdk deploy", "generic shell", "ACT=true"]) {
    await assert.rejects(() => h.provider.issue({ ...request(), operation: operation as "DIAGNOSTIC" }), /OPERATION_FORBIDDEN/);
  }
});

test("no raw credentials, MFA challenge or secret bytes are present in serialized lease", async () => {
  const h = harness();
  const lease = await h.provider.issue(request());
  const body = JSON.stringify(lease);
  assert.equal(body.includes("mfaVerifiedAt"), false);
  assert.equal(body.includes("session-1"), false);
  assert.equal(body.includes("password"), false);
  assert.equal(body.includes("token"), false);
  assert.equal(body.includes("mfaAssurance"), false);
});
