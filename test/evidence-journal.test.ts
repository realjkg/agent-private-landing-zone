import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { Journal, JournalError, acquireRunLock, readJournal, type JournalIdentity } from "../src/evidence-runner/journal.js";
import { CANDIDATE } from "./helpers/evidence-fixtures.js";

// SYNTHETIC: the evidence runner's append-only journal and its run lock.

const identity: JournalIdentity = {
  sourceCommit: CANDIDATE, configSha256: "a".repeat(64), targetHardwareId: "owner-mac-01", label: "SYNTHETIC", host: "fixture-host", identityHash: "b".repeat(64),
};
const folder = () => mkdtempSync(join(tmpdir(), "alz-evidence-journal-"));
const refusal = (code: string) => (error: unknown) => error instanceof JournalError && error.code === code;

test("start and finish lines record each step; a start without a finish reads as interrupted", () => {
  const file = join(folder(), "journal.jsonl");
  const journal = new Journal(file, identity);
  assert.deepEqual(journal.record("preflight", "preflight"), { status: "NOT_RUN" });
  journal.start("preflight", "preflight", "t0");
  assert.deepEqual(journal.record("preflight", "preflight"), { status: "INTERRUPTED", pid: process.pid });
  journal.finish("preflight", "preflight", "PASS", "t1");
  journal.start("aws-readonly", "aws-readonly", "t2");
  journal.finish("aws-readonly", "aws-readonly", "BLOCKED", "t3", "NOT_BUILT");
  const reopened = new Journal(file, identity);
  assert.deepEqual(reopened.record("preflight", "preflight"), { status: "FINISHED", outcome: "PASS" });
  assert.deepEqual(reopened.record("aws-readonly", "aws-readonly"), { status: "FINISHED", outcome: "BLOCKED", code: "NOT_BUILT" });
  assert.equal(readJournal(file).length, 4);
  assert.equal(statSync(file).mode & 0o777, 0o600);
});

test("a journal of another run is refused, naming what differs", () => {
  const file = join(folder(), "journal.jsonl");
  new Journal(file, identity).start("preflight", "preflight", "t0");
  for (const key of ["sourceCommit", "configSha256", "targetHardwareId", "label", "host", "identityHash"] as const) {
    const other = { ...identity, [key]: key === "label" ? "LIVE" : key === "sourceCommit" ? "f".repeat(40) : key.endsWith("Sha256") || key === "identityHash" ? "c".repeat(64) : "other" };
    assert.throws(() => new Journal(file, other), (error: unknown) => refusal("EVIDENCE_JOURNAL_MISMATCH")(error) && (error as Error).message.includes(key), key);
  }
});

test("a torn last line or a malformed line is refused, never repaired", () => {
  const torn = join(folder(), "journal.jsonl");
  new Journal(torn, identity).start("preflight", "preflight", "t0");
  appendFileSync(torn, "{\"schemaVersion\":1,\"stage\":");
  const before = readFileSync(torn, "utf8");
  assert.throws(() => new Journal(torn, identity), refusal("EVIDENCE_JOURNAL_UNREADABLE"));
  assert.equal(readFileSync(torn, "utf8"), before, "the journal is left as it was");
  const malformed = join(folder(), "journal.jsonl");
  writeFileSync(malformed, JSON.stringify({ schemaVersion: 1, stage: "nowhere", step: "x", event: "start", at: "t", pid: 1, ...identity }) + "\n");
  assert.throws(() => readJournal(malformed), refusal("EVIDENCE_JOURNAL_UNREADABLE"));
});

test("the run lock refuses a live holder and replaces one whose pid is proven dead", () => {
  const lock = join(folder(), "run.lock");
  writeFileSync(lock, JSON.stringify({ pid: 999_999 }) + "\n");
  assert.throws(() => acquireRunLock(lock, () => true), (error: unknown) => refusal("EVIDENCE_RUN_IN_PROGRESS")(error) && (error as Error).message.includes("999999"));
  const release = acquireRunLock(lock, () => false);
  assert.equal((JSON.parse(readFileSync(lock, "utf8")) as { pid: number }).pid, process.pid);
  release();
  assert.equal(existsSync(lock), false);
});

test("two runs that both find a stale lock: only one holds the folder", () => {
  // Run B reads the dead pid; before B takes over, run A takes the stale lock over completely. B must then refuse and
  // leave A's new lock alone (the takeover-token rule shared with the lifecycle runner), never delete it and hold too.
  const dir = folder();
  const lock = join(dir, "run.lock");
  writeFileSync(lock, JSON.stringify({ pid: 4242 }) + "\n");
  let releaseA: (() => void) | undefined;
  const pidAliveForB = (pid: number): boolean => {
    if (pid === 4242 && !releaseA) { releaseA = acquireRunLock(lock, () => false); return false; }
    return true;
  };
  assert.throws(() => acquireRunLock(lock, pidAliveForB), refusal("EVIDENCE_RUN_IN_PROGRESS"), "run B refuses");
  assert.ok(releaseA, "run A took the stale lock over");
  assert.equal((JSON.parse(readFileSync(lock, "utf8")) as { pid: number }).pid, process.pid, "run A's lock is kept");
  assert.deepEqual(readdirSync(dir), ["run.lock"], "no takeover token is left behind");
  releaseA!();
  assert.equal(existsSync(lock), false);
});

test("an empty or torn lock is refused with the file named and how to recover, never as a run to wait for", () => {
  for (const content of ["", "{\"pid\":"]) {
    const lock = join(folder(), "run.lock");
    writeFileSync(lock, content);
    assert.throws(() => acquireRunLock(lock, () => false), (error: unknown) => refusal("EVIDENCE_LOCK_UNREADABLE")(error) &&
      (error as Error).message.includes(lock) && (error as Error).message.includes("remove that file") && !(error as Error).message.includes("Wait for it"));
    assert.equal(readFileSync(lock, "utf8"), content, "the lock is left as it was");
  }
});
