import assert from "node:assert/strict";
import test from "node:test";

import { authorizeContract, pilotContractSha256 } from "../src/apply/contract.js";
import { liveRecordOf, readAppliedEvidence } from "../src/apply/live-record.js";
import type { ApplyEvidence, PilotContract } from "../src/apply/types.js";
import { APPLY_AUTHORITY } from "../src/apply/evidence.js";
import { NOW, SOURCE_COMMIT, awsContractJson, decisionsFor } from "./helpers/apply-fixtures.js";

// The execute step's live record (src/apply/live-record.ts): made only from a successful apply under the reviewed contract and its current authorization.

const contract = awsContractJson("/nonexistent/kill") as unknown as PilotContract;
const devAuthorization = (authorizeContract(contract, "DEV", "APPLY") as { ok: true; authorization: { authorizationSha256: string } }).authorization.authorizationSha256;
const evidence = (over: Partial<ApplyEvidence> = {}): ApplyEvidence => ({
  schemaVersion: 1, environment: "DEV", target: { account: "111111111111", backend: "b", workspace: "default" }, artifactSha256: "1".repeat(64),
  manifestHash: "2".repeat(64), releaseIdentity: "3".repeat(64), contractSha256: pilotContractSha256(contract), sourceCommit: SOURCE_COMMIT,
  decisions: decisionsFor(pilotContractSha256(contract), "APPLY", devAuthorization), requester: { requesterId: "carol", nonce: "0".repeat(32) },
  approvals: [{ approverId: "alice", issuedAt: NOW.toISOString() }], adapter: { adapterVersion: "a", argvDigest: "4".repeat(64) },
  toolVersions: { engine: "1.9.5" }, outcome: "SUCCEEDED", exitCode: 0, startedAt: NOW.toISOString(), finishedAt: NOW.toISOString(), authority: APPLY_AUTHORITY,
  ...over,
});

test("a successful apply under the reviewed contract makes a LIVE execute record for the contract's cloud and engine", () => {
  const made = liveRecordOf(evidence(), contract, "operator", NOW);
  assert.equal(made.ok, true);
  const { record } = made as Extract<typeof made, { ok: true }>;
  assert.equal(record.cloud, "AWS");
  assert.equal(record.engine, "TERRAFORM");
  assert.equal(record.sourceCommit, SOURCE_COMMIT);
  assert.match(record.evidenceSha256, /^[0-9a-f]{64}$/);
  assert.equal(record.authorizationSha256, devAuthorization, "the record carries the authorization the apply ran under");
  const later = liveRecordOf(evidence({ finishedAt: "2026-10-12T00:00:00.000Z" }), contract, "operator", NOW);
  assert.ok(later.ok && later.record.evidenceSha256 !== record.evidenceSha256, "the record is bound to its evidence");
});

test("anything but a success, or an apply under another contract, makes no record", () => {
  for (const outcome of ["FAILED_NO_CHANGE", "PARTIAL_REQUIRES_REVIEW", "KILLED"] as const) {
    assert.equal(liveRecordOf(evidence({ outcome }), contract, "operator", NOW).ok, false, outcome);
  }
  assert.equal(liveRecordOf(evidence({ contractSha256: "9".repeat(64) }), contract, "operator", NOW).ok, false);
  // An apply recorded under another authorization entry, or under a contract that no longer authorizes APPLY there, makes none.
  assert.equal(liveRecordOf(evidence({ decisions: decisionsFor(pilotContractSha256(contract), "APPLY", "9".repeat(64)) }), contract, "operator", NOW).ok, false);
  const narrowed = { ...contract, authorize: { DEV: ["CLEANUP"] } } as PilotContract;
  assert.equal(liveRecordOf(evidence({ contractSha256: pilotContractSha256(narrowed) }), narrowed, "operator", NOW).ok, false);
});

test("evidence is read only for a well-formed artifact id that has finished evidence", async () => {
  assert.equal(await readAppliedEvidence("../../etc/passwd", "/nonexistent"), undefined);
  assert.equal(await readAppliedEvidence("1".repeat(64), "/nonexistent"), undefined);
});
