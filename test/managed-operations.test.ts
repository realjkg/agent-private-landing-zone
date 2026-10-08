import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { LocalSovereignChangeLedger } from "../src/change-ledger/local.js";
import { DelegatedAgentAuthority } from "../src/delegation/identity.js";
import { ManagedOperationsCoordinator, sealOperationalPlaybook, type ManagedOperationsProvider } from "../src/managed-operations/operations.js";
import type { ChangeRequest } from "../src/change-ledger/types.js";

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "alz-ops-"));
  const ledger = new LocalSovereignChangeLedger(dir);
  let calls = 0;
  let recoveries = 0;
  let ok = true;
  let eligible = true;
  let approved = true;
  const provider: ManagedOperationsProvider = {
    id: "KUBERNETES", environmentId: "private-01",
    inspect: async () => ({ satisfied: eligible, evidenceRefs: ["evidence://ops/inspect"] }),
    validate: async () => ({ observed: true, evidenceRefs: ["evidence://ops/validate"] }),
    preview: async () => ({ possible: true, evidenceRefs: ["evidence://ops/preview"] }),
    recoveryTest: async () => ({ ready: true, evidenceRefs: ["evidence://ops/recovery-test"] }),
    perform: async ({ signal }) => { assert.equal(signal.aborted, false); calls++; return { ok: true, evidenceRefs: ["evidence://ops/performed"] }; },
    verify: async () => ({ ok, evidenceRefs: ["evidence://ops/verified"] }),
    recover: async () => { recoveries++; return { ok: true, evidenceRefs: ["evidence://ops/rollback"] }; },
  };
  const authority = new DelegatedAgentAuthority(
    { verifySession: async (sessionRef) => ({
      subjectId: "human-1", sessionRef, mfaAssurance: "AAL3", mfaVerifiedAt: "2026-10-08T04:00:00.000Z", verified: true,
    }) },
    { forSubject: async () => [{ roleId: "operator", operation: "RESTART_SERVICE", environmentId: "private-01", resourceId: "service-1" }] },
    { evaluate: async () => ({ allow: approved, decisionId: "policy-123" }) },
    () => "NORMAL", () => Date.parse("2026-10-08T04:00:10.000Z"),
  );
  const playbook = sealOperationalPlaybook({
    playbookId: "restart-approved-service", version: "1.0.0",
    operation: "RESTART_SERVICE", providerId: "KUBERNETES",
    environmentId: "private-01", targetResourceId: "service-1",
    preconditions: ["known-service", "resource-alive"], maxTargets: 1,
    approvalMode: "LOCAL", verificationRequired: true, recovery: "REQUIRED", timeoutMs: 1500,
  });
  const record = (): ChangeRequest => ({
    changeRecordId: "change-1", actionId: "task-1", actionType: playbook.operation,
    authorityClass: "OPERATE", environmentId: playbook.environmentId,
    substrate: playbook.providerId, resourceIds: [playbook.targetResourceId],
    requestorId: "human-1", agentActorId: "agent-1",
    approval: { mode: "LOCAL", state: "APPROVED", reference: "local-approval-1" },
    playbook: { id: playbook.playbookId, version: playbook.version, sha256: playbook.artifactSha256 },
    preconditions: playbook.preconditions, maxTargets: 1,
    execution: { status: "NOT_EXECUTED" }, verification: "NOT_RUN", recovery: "NOT_RUN",
    evidenceRefs: ["evidence://ops/ticket"], relatedChangeRecordIds: [],
    mode: "DISCONNECTED", externalRefs: [],
  });
  const leaseRequest = {
    sessionRef: "human-session-1", agent: { agentId: "agent-1", harnessId: "harness-1" },
    taskId: "task-1", environmentId: "private-01", resourceId: "service-1",
    operation: "RESTART_SERVICE" as const, ttlSeconds: 30, maxExecutions: 1,
  };
  return {
    ledger, authority, provider, playbook, record, leaseRequest,
    coordinator: new ManagedOperationsCoordinator(ledger, authority, provider),
    create: () => ledger.create(record(), "2026-10-08T04:00:00Z"),
    calls: () => calls, recoveries: () => recoveries,
    ready: (v: boolean) => { eligible = v; }, verified: (v: boolean) => { ok = v; },
    policy: (v: boolean) => { approved = v; }, close: () => rmSync(dir, { recursive: true, force: true }),
  };
}
test("record precedes policy lease and bounded ACT; verification and outcome are hash-linked", async () => {
  const h = setup();
  try {
    h.create();
    const result = await h.coordinator.operate({ changeRecordId: "change-1", playbook: h.playbook, leaseRequest: h.leaseRequest });
    assert.equal(result.status, "SUCCEEDED");
    assert.equal(result.verification, "PASS");
    assert.equal(result.record.execution.status, "SUCCEEDED");
    assert.equal(result.record.phase, "OUTCOME");
    assert.equal(result.record.capabilityLeaseId?.startsWith("delegation-"), true);
    assert.equal(result.record.policyDecisionId, "policy-123");
    assert.equal(h.calls(), 1);
    assert.equal(h.recoveries(), 0);
    assert.deepEqual(h.ledger.readVerified().map((x) => x.phase), ["REQUESTED", "STARTED", "OUTCOME"]);
    await assert.rejects(() => h.coordinator.operate({ changeRecordId: "change-1", playbook: h.playbook, leaseRequest: h.leaseRequest }), /CHANGE_RECORD_UNAVAILABLE/);
    assert.equal(h.calls(), 1);
  } finally { h.close(); }
});

test("verification failure invokes required bounded recovery and records FAILED not success", async () => {
  const h = setup();
  try {
    h.create(); h.verified(false);
    const result = await h.coordinator.operate({ changeRecordId: "change-1", playbook: h.playbook, leaseRequest: h.leaseRequest });
    assert.equal(result.status, "FAILED");
    assert.equal(result.verification, "FAIL");
    assert.equal(result.recovery, "SUCCEEDED");
    assert.equal(h.calls(), 1);
    assert.equal(h.recoveries(), 1);
    assert.equal(h.ledger.verify().count, 3);
  } finally { h.close(); }
});

test("missing change record, pending approval, bad preconditions or denied policy never call perform", async () => {
  const h = setup();
  try {
    const args = { changeRecordId: "change-1", playbook: h.playbook, leaseRequest: h.leaseRequest };
    await assert.rejects(() => h.coordinator.operate(args), /CHANGE_RECORD_UNAVAILABLE/);
    h.ledger.create({ ...h.record(), approval: { mode: "LOCAL", state: "PENDING" } }, "2026-10-08T04:00:00Z");
    await assert.rejects(() => h.coordinator.operate(args), /CHANGE_APPROVAL_SCOPE_DENIED/);
    assert.equal(h.calls(), 0);
  } finally { h.close(); }
  const g = setup();
  try {
    g.create(); const args = { changeRecordId: "change-1", playbook: g.playbook, leaseRequest: g.leaseRequest };
    g.ready(false);
    await assert.rejects(() => g.coordinator.operate(args), /PRECONDITIONS_DENIED/);
    g.ready(true); g.policy(false);
    await assert.rejects(() => g.coordinator.operate(args), /DETERMINISTIC_POLICY_DENIED/);
    assert.equal(g.calls(), 0);
    assert.deepEqual(g.ledger.readVerified().map((x) => x.phase), ["REQUESTED"]);
  } finally { g.close(); }
});

test("tampered playbook, mismatched target or unsupported generic action fail before any ACT", async () => {
  const h = setup();
  try {
    h.create();
    const args = { changeRecordId: "change-1", playbook: h.playbook, leaseRequest: h.leaseRequest };
    await assert.rejects(() => h.coordinator.operate({ ...args, playbook: { ...h.playbook, timeoutMs: 9000 } }), /PLAYBOOK_INTEGRITY_DENIED/);
    await assert.rejects(() => h.coordinator.operate({ ...args, leaseRequest: { ...h.leaseRequest, resourceId: "other" } }), /CHANGE_APPROVAL_SCOPE_DENIED/);
    for (const action of ["terraform apply", "pulumi up", "cdk deploy", "generic shell", "ACT=true"]) {
      assert.throws(() => sealOperationalPlaybook({ ...h.playbook, operation: action as "RESTART_SERVICE" }), /PLAYBOOK_UNBOUNDED/);
    }
    assert.equal(h.calls(), 0);
  } finally { h.close(); }
});

test("diagnostics, validation, preview and recovery-test are non-mutating", async () => {
  const h = setup();
  try {
    for (const action of ["DIAGNOSTIC","VALIDATE","PREVIEW","RECOVERY_TEST"] as const) {
      const r = await h.coordinator.diagnose(action, "service-1");
      assert.equal(r.possible, true);
      assert.ok(r.evidenceRefs.length);
    }
    assert.equal(h.calls(), 0);
  } finally { h.close(); }
});
