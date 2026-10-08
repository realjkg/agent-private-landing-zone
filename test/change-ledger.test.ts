import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { LocalSovereignChangeLedger, verifySignedLedgerExport } from "../src/change-ledger/local.js";
import { OPTIONAL_ENTERPRISE_INTEGRATIONS, externalReferenceIsAuthority } from "../src/change-ledger/integrations.js";
import type { ChangeRequest } from "../src/change-ledger/types.js";

const stamp = "2026-10-07T23:12:00.000Z";
const sample = (id = "change-1"): ChangeRequest => ({
  changeRecordId: id, actionId: "ops-0001", actionType: "RESTART_SERVICE",
  authorityClass: "OPERATE", environmentId: "private-01", substrate: "KUBERNETES",
  resourceIds: ["app-1"], initiatingRef: "alert-01", requestorId: "human-01",
  agentActorId: "agent-01", approval: { mode: "LOCAL", state: "PENDING" },
  policyDecisionId: "policy-001", capabilityLeaseId: "lease-pending",
  playbook: { id: "restart-approved-service", version: "1.0.0", sha256: "a".repeat(64) },
  preconditions: ["service-health-confirmed"], maxTargets: 1,
  execution: { status: "NOT_EXECUTED" }, verification: "NOT_RUN", recovery: "NOT_RUN",
  evidenceRefs: ["evidence://local/alert-01"], relatedChangeRecordIds: [],
  mode: "DISCONNECTED", externalRefs: [],
});
function local() {
  const dir = mkdtempSync(join(tmpdir(), "alz-ledger-"));
  return { dir, ledger: new LocalSovereignChangeLedger(dir), close: () => rmSync(dir, { recursive: true, force: true }) };
}

test("disconnected ledger persists hash-linked canonical records without external systems", () => {
  const ctx = local();
  try {
    const first = ctx.ledger.create(sample(), stamp);
    assert.equal(first.sequence, 1);
    assert.equal(first.revision, 1);
    assert.equal(first.previousRecordHash, null);
    assert.match(first.recordHash, /^sha256:[a-f0-9]{64}$/);
    assert.equal(first.actAuthorizedByLedger, false);
    assert.equal(first.execution.status, "NOT_EXECUTED");
    const second = ctx.ledger.create(sample("change-2"), stamp);
    assert.equal(second.previousRecordHash, first.recordHash);
    assert.equal(ctx.ledger.verify().count, 2);
    assert.equal(new LocalSovereignChangeLedger(ctx.dir).verify().headHash, second.recordHash);
    assert.equal((statSync(join(ctx.dir, "sovereign-changes.ndjson")).mode & 0o777), 0o600);
  } finally { ctx.close(); }
});

test("reconciliation appends immutable revision retaining original disconnected history", () => {
  const ctx = local();
  try {
    const original = ctx.ledger.create(sample(), stamp);
    const revised = ctx.ledger.reconcile(original.changeRecordId, [
      { system: "JIRA", recordId: "CHANGE-123" },
      { system: "CMDB", recordId: "CI-94" },
    ], "2026-10-08T00:00:00.000Z");
    assert.equal(revised.changeRecordId, original.changeRecordId);
    assert.equal(revised.revision, 2);
    assert.equal(revised.mode, "RECONCILED");
    assert.equal(revised.phase, "RECONCILED");
    assert.equal(revised.supersedesRecordHash, original.recordHash);
    assert.equal(revised.previousRecordHash, original.recordHash);
    assert.equal(revised.externalRefs.length, 2);
    assert.equal(revised.actAuthorizedByLedger, false);
    assert.deepEqual(ctx.ledger.readVerified()[0], original);
    assert.equal(ctx.ledger.verify().count, 2);
  } finally { ctx.close(); }
});

test("signed offline export verifies history and rejects modified evidence", () => {
  const ctx = local();
  try {
    ctx.ledger.create(sample(), stamp);
    const keys = generateKeyPairSync("ed25519");
    const data = ctx.ledger.signedExport(keys.privateKey);
    assert.equal(verifySignedLedgerExport(data, keys.publicKey).count, 1);
    const tampered = structuredClone(data);
    tampered.payload.records[0]!.actionType = "REPLACED";
    assert.throws(() => verifySignedLedgerExport(tampered, keys.publicKey), /EXPORT_SIGNATURE_INVALID/);
    const brokenManifest = structuredClone(data);
    brokenManifest.payload.evidenceRefs = [];
    assert.throws(() => verifySignedLedgerExport(brokenManifest, keys.publicKey), /EXPORT_SIGNATURE_INVALID/);
  } finally { ctx.close(); }
});

test("local tampering is detected before any new append", () => {
  const ctx = local();
  try {
    ctx.ledger.create(sample(), stamp);
    const file = join(ctx.dir, "sovereign-changes.ndjson");
    const raw = readFileSync(file, "utf8");
    writeFileSync(file, raw.replace("RESTART_SERVICE", "DEPLOY_STACK"), "utf8");
    assert.throws(() => ctx.ledger.verify(), /INTEGRITY_FAILED/);
    assert.throws(() => ctx.ledger.create(sample("change-2"), stamp), /INTEGRITY_FAILED/);
  } finally { ctx.close(); }
});

test("disconnected external binding, connected missing ITSM, oversized blast radius, inline secrets and duplicate IDs fail closed", () => {
  const ctx = local();
  try {
    assert.throws(() => ctx.ledger.create({ ...sample(), externalRefs: [{ system: "JIRA", recordId: "ABC-1" }] }, stamp), /DISCONNECTED_CANNOT_BIND_EXTERNAL/);
    assert.throws(() => ctx.ledger.create({ ...sample(), mode: "CONNECTED" }, stamp), /CONNECTED_ITSM_REFERENCE_REQUIRED/);
    assert.throws(() => ctx.ledger.create({ ...sample(), maxTargets: 0 }, stamp), /BLAST_RADIUS_INVALID/);
    assert.throws(() => ctx.ledger.create({ ...sample(), evidenceRefs: ["secret://password"] }, stamp), /EVIDENCE_REF_INVALID/);
    ctx.ledger.create(sample(), stamp);
    assert.throws(() => ctx.ledger.create(sample(), stamp), /DUPLICATE_CANONICAL_ID/);
    assert.throws(() => ctx.ledger.reconcile("change-1", [{ system: "CMDB", recordId: "CI-1" }], stamp), /RECONCILE_ITSM_REFERENCE_REQUIRED/);
  } finally { ctx.close(); }
});

test("ITSM, CMDB and DevOps contracts are optional and cannot grant operating authority", () => {
  assert.deepEqual(OPTIONAL_ENTERPRISE_INTEGRATIONS.map((x) => x.id), [
    "JIRA", "SERVICENOW", "CMDB", "GITHUB", "GITLAB", "JENKINS", "CIRCLECI",
  ]);
  assert.equal(OPTIONAL_ENTERPRISE_INTEGRATIONS.every((x) => x.required === false), true);
  assert.equal(externalReferenceIsAuthority({ system: "SERVICENOW", recordId: "CHG-1" }), false);
});
