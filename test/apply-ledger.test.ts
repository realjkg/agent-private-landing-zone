import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { APPLY_AUTHORITY } from "../src/apply/evidence.js";
import { finalizeArtifact, releaseReservation, reserveArtifact } from "../src/apply/ledger.js";
import { requireNotApplied } from "../src/apply/contract.js";
import type { ApplyEvidence } from "../src/apply/types.js";
import { readEncryptedEvidence } from "../src/evidence/vault.js";
import { APPLY_ADAPTER } from "../src/apply/terraform.js";
import { DEV_TARGET, H, NOW, decisionsFor } from "./helpers/apply-fixtures.js";

// The ledger's write side, directly: every branch of reserve, release and finalize
// that the driver's own tests do not reach through a full run.

const root = mkdtempSync(join(tmpdir(), "alz-ledger-"));
const KEY = randomBytes(32).toString("base64");
process.env.AGENTIC_EVIDENCE_KEY = KEY;
test.after(() => rmSync(root, { recursive: true, force: true }));

let counter = 0;
const fresh = (): string => {
  const dir = join(root, "evidence-" + ++counter);
  mkdirSync(dir, { recursive: true });
  return dir;
};
const hashOf = (char: string): string => H(char);
const evidenceFor = (artifactSha256: string): ApplyEvidence => ({
  schemaVersion: 1, environment: "DEV", target: DEV_TARGET, artifactSha256, manifestHash: H("1"), releaseIdentity: H("2"), contractSha256: H("3"), targetSha256: H("4"), decisions: decisionsFor(H("3")), sourceCommit: "5ec0de0000000000000000000000000000c0ffee",
  approvals: [{ approverId: "alice", issuedAt: NOW.toISOString() }],
  requester: { requesterId: "carol", nonce: "0".repeat(32) },
  adapter: { adapterVersion: APPLY_ADAPTER.adapterVersion, argvDigest: APPLY_ADAPTER.argvDigest }, toolVersions: { engine: "1.9.5" },
  outcome: "SUCCEEDED", exitCode: 0, startedAt: NOW.toISOString(), finishedAt: NOW.toISOString(), authority: APPLY_AUTHORITY,
});

test("reserve takes the entry exclusively; a second reserve, even for the same run, is refused and changes nothing", async () => {
  const dir = fresh();
  assert.deepEqual(await reserveArtifact(hashOf("a"), dir, NOW), { ok: true });
  const again = await reserveArtifact(hashOf("a"), dir, NOW);
  assert.ok(!again.ok && again.code === "ARTIFACT_ALREADY_APPLIED");
  assert.equal(requireNotApplied(hashOf("a"), dir).ok, false, "a reservation closes the artifact");
  assert.deepEqual(readdirSync(dir), [hashOf("a") + ".apply.evidence"]);
});

test("a value that is not a SHA-256 digest is refused before it can name a path", async () => {
  const dir = fresh();
  for (const bad of ["../escape", "A".repeat(64), "abc", "", hashOf("a") + "/x"]) {
    const result = await reserveArtifact(bad, dir, NOW);
    assert.ok(!result.ok && result.code === "ARTIFACT_INVALID", bad);
  }
  assert.deepEqual(readdirSync(dir), []);
  assert.ok(!existsSync(join(root, "escape.apply.evidence")));
});

test("an unwritable ledger location is an error, not a silent pass", async () => {
  const blocked = join(root, "a-file");
  writeFileSync(blocked, "x");
  await assert.rejects(reserveArtifact(hashOf("b"), join(blocked, "inside"), NOW));
});

test("release removes only a reservation: never evidence, never an entry that is not this artifact's", async () => {
  const dir = fresh();
  await reserveArtifact(hashOf("c"), dir, NOW);
  await releaseReservation(hashOf("c"), dir);
  assert.deepEqual(readdirSync(dir), [], "the reservation is given back");
  await releaseReservation(hashOf("c"), dir); // nothing there: no error

  await reserveArtifact(hashOf("d"), dir, NOW);
  assert.ok((await finalizeArtifact(evidenceFor(hashOf("d")), dir)).ok);
  await releaseReservation(hashOf("d"), dir);
  assert.equal((await readEncryptedEvidence<ApplyEvidence>(join(dir, hashOf("d") + ".apply.evidence"))).outcome, "SUCCEEDED", "evidence stays");

  writeFileSync(join(dir, hashOf("e") + ".apply.evidence"), "not an encrypted record");
  await releaseReservation(hashOf("e"), dir);
  assert.ok(existsSync(join(dir, hashOf("e") + ".apply.evidence")), "an entry that cannot be shown to be our reservation stays");
});

test("finalize replaces the reservation in one rename and leaves no staging file", async () => {
  const dir = fresh();
  await reserveArtifact(hashOf("f"), dir, NOW);
  const done = await finalizeArtifact(evidenceFor(hashOf("f")), dir);
  assert.ok(done.ok);
  assert.deepEqual(readdirSync(dir), [hashOf("f") + ".apply.evidence"]);
  const stored = await readEncryptedEvidence<ApplyEvidence & { state?: string }>(join(dir, hashOf("f") + ".apply.evidence"));
  assert.equal(stored.state, undefined, "the reservation is gone");
});

test("finalize refuses evidence that is not evidence, and an artifact this run does not hold", async () => {
  const dir = fresh();
  await reserveArtifact(hashOf("1"), dir, NOW);
  const malformed = { ...evidenceFor(hashOf("1")), stdout: "raw output" } as unknown as ApplyEvidence;
  const rejected = await finalizeArtifact(malformed, dir);
  assert.ok(!rejected.ok && rejected.code === "EVIDENCE_REJECTED" && /stdout/.test(rejected.message));
  const unreserved = await finalizeArtifact(evidenceFor(hashOf("2")), dir);
  assert.ok(!unreserved.ok && unreserved.code === "EVIDENCE_REJECTED" && /not reserved/.test(unreserved.message));
  const once = await finalizeArtifact(evidenceFor(hashOf("1")), dir);
  assert.ok(once.ok);
  const twice = await finalizeArtifact(evidenceFor(hashOf("1")), dir);
  assert.ok(!twice.ok, "evidence is final: it is not a reservation any more");
  assert.deepEqual(readdirSync(dir).sort(), [hashOf("1") + ".apply.evidence"]);
});

test("with an evidence key other accounts can read, nothing is reserved and nothing is finalized", async () => {
  const dir = fresh();
  await reserveArtifact(hashOf("3"), dir, NOW);
  const keyFile = join(root, "loose.key");
  writeFileSync(keyFile, KEY + "\n");
  chmodSync(keyFile, 0o644);
  const saved = { key: process.env.AGENTIC_EVIDENCE_KEY, file: process.env.AGENTIC_EVIDENCE_KEY_FILE };
  delete process.env.AGENTIC_EVIDENCE_KEY;
  process.env.AGENTIC_EVIDENCE_KEY_FILE = keyFile;
  try {
    const reserve = await reserveArtifact(hashOf("4"), dir, NOW);
    assert.ok(!reserve.ok && reserve.code === "EVIDENCE_REJECTED" && /permissions/.test(reserve.message));
    const finalize = await finalizeArtifact(evidenceFor(hashOf("3")), dir);
    assert.ok(!finalize.ok && finalize.code === "EVIDENCE_REJECTED" && /permissions/.test(finalize.message));
  } finally {
    process.env.AGENTIC_EVIDENCE_KEY = saved.key;
    if (saved.file === undefined) delete process.env.AGENTIC_EVIDENCE_KEY_FILE; else process.env.AGENTIC_EVIDENCE_KEY_FILE = saved.file;
  }
  assert.deepEqual(readdirSync(dir), [hashOf("3") + ".apply.evidence"], "only the earlier reservation exists");
});
