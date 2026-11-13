import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { ACT_PATH, FLOW, readFlow, type FlowStatus, type StepId, type StepStatus } from "../src/flow/one-flow.js";
import { validConfig } from "./helpers/evidence-fixtures.js";

// SYNTHETIC: throwaway git checkouts under the OS temp folder. Nothing here reaches a cloud, a model or a real account.

const SCENARIO = "terraform-aws-brownfield";
const DRIFT = ".runs/qualification/aft-lza-drift.json";
const MATRIX_FILE = ".runs/qualification/private-agent-matrix/matrix-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.json";

function git(root: string, ...args: string[]): string {
  return execFileSync("git", ["-C", root, "-c", "user.name=test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", ...args], {
    encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

/** A committed checkout. dist/, .runs/ and the owner's run config are ignored, as they are in the repository. */
function checkout(): { root: string; head: () => string } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "alz-one-flow-")));
  git(root, "init", "-q", "-b", "main");
  write(root, ".gitignore", "dist/\n.runs/\nconfig/evidence-runner.json\n");
  write(root, "README.md", "fixture\n");
  commitAll(root, "fixture");
  return { root, head: () => git(root, "rev-parse", "HEAD") };
}

function write(root: string, path: string, text: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
}

function commitAll(root: string, message: string): void {
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", message);
}

function markBuilt(root: string, commit: string): void {
  write(root, "dist/.alz-build-complete", JSON.stringify({ schemaVersion: 1, sourceCommit: commit }));
}

function passingMatrix(root: string, commit: string): void {
  write(root, MATRIX_FILE, JSON.stringify({
    mode: "OFFLINE_FIXTURE", passed: true, sourceCommit: commit, results: [{ id: SCENARIO, converged: true }],
  }));
}

function contract(authorize: Record<string, string[]> = { DEV: ["APPLY", "CLEANUP"] }, killSwitchPath = "config/kill-switch-absent"): string {
  return JSON.stringify({ enabled: true, provider: "AWS", engine: "TERRAFORM", killSwitchPath, authorize }, null, 2) + "\n";
}

function writeRunConfig(root: string, commit: string): void {
  write(root, "config/evidence-runner.json", JSON.stringify(validConfig({ candidateCommit: commit }), null, 2));
}

function journalLine(commit: string, stage: string, event: "start" | "finish", outcome?: string, code?: string): string {
  return JSON.stringify({
    schemaVersion: 1, sourceCommit: commit, configSha256: "0".repeat(64), targetHardwareId: "owner-mac-01", label: "SYNTHETIC",
    host: "host", identityHash: "0".repeat(64), stage, step: stage, event, at: "2026-11-13T10:00:00Z", pid: 1234,
    ...(outcome ? { outcome } : {}), ...(code ? { code } : {}),
  });
}

function writeJournal(root: string, commit: string, lines: string[]): void {
  write(root, ".runs/evidence/" + commit.slice(0, 12) + "/journal.jsonl", lines.join("\n") + "\n");
}

function status(root: string, now?: number): FlowStatus {
  return readFlow({ root, env: {}, ...(now === undefined ? {} : { now }) });
}

function step(flow: FlowStatus, id: StepId): StepStatus {
  const found = flow.steps.find((item) => item.id === id);
  assert.ok(found, "missing step " + id);
  return found;
}

test("a folder that is not a checkout starts at setup and waits for everything after it", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "alz-one-flow-plain-")));
  const flow = status(root);
  assert.equal(flow.kind, "ONE_FLOW_STATUS");
  assert.equal(flow.schemaVersion, 1);
  assert.equal(flow.evidenceBasis, "LOCAL FILES ONLY — NO CLOUD, NO MODEL, NOTHING RUN");
  assert.equal(flow.sourceCommit, "NONE");
  assert.equal(flow.next, "setup");
  assert.equal(step(flow, "setup").code, "NO_CHECKOUT");
  assert.equal(step(flow, "rehearse").state, "WAITING");
  assert.equal(step(flow, "authorize").state, "WAITING");
});

test("a clean checkout with no build is set up next; a build at this commit is done", () => {
  const { root, head } = checkout();
  assert.equal(step(status(root), "setup").code, "NOT_BUILT");
  markBuilt(root, head());
  const flow = status(root);
  assert.equal(step(flow, "setup").state, "DONE");
  assert.equal(flow.next, "rehearse");
  assert.equal(step(flow, "rehearse").code, "NOT_REHEARSED");
  assert.equal(step(flow, "authorize").code, "CONTRACT_NOT_COMMITTED");
  assert.equal(step(flow, "authorize").who, "Owner");
  assert.equal(step(flow, "describe").state, "WAITING");
});

test("a build from another commit is stale, and an uncommitted file stops the setup step", () => {
  const { root, head } = checkout();
  markBuilt(root, "1".repeat(40));
  assert.equal(step(status(root), "setup").code, "BUILD_STALE");
  markBuilt(root, head());
  write(root, "scratch.txt", "uncommitted\n");
  const dirty = step(status(root), "setup");
  assert.equal(dirty.state, "NEXT");
  assert.equal(dirty.code, "CHECKOUT_NOT_CLEAN");
});

test("an offline rehearsal counts only when it passed at this checkout's commit", () => {
  const { root, head } = checkout();
  markBuilt(root, head());
  passingMatrix(root, head());
  assert.equal(step(status(root), "rehearse").state, "DONE");
  passingMatrix(root, "2".repeat(40));
  assert.equal(step(status(root), "rehearse").code, "REHEARSAL_STALE");
});

test("the committed contract is the ACT authority: a DEV list without APPLY is not enough", () => {
  const { root, head } = checkout();
  write(root, "config/act-pilot-contract.json", contract({ DEV: ["CLEANUP"] }));
  commitAll(root, "contract without apply");
  markBuilt(root, head());
  const authorize = step(status(root), "authorize");
  assert.equal(authorize.state, "NEXT");
  assert.equal(authorize.code, "ACT_NOT_AUTHORIZED");
});

test("a kill switch that exists stops ACT even with a full authorize entry", () => {
  const { root, head } = checkout();
  write(root, "config/kill-switch-on", "stop\n");
  write(root, "config/act-pilot-contract.json", contract({ DEV: ["APPLY", "CLEANUP"] }, "config/kill-switch-on"));
  commitAll(root, "contract with kill switch on");
  markBuilt(root, head());
  assert.equal(step(status(root), "authorize").code, "KILL_SWITCH_ON");
});

test("an uncommitted contract does not authorize anything and makes the checkout unclean", () => {
  const { root, head } = checkout();
  markBuilt(root, head());
  write(root, "config/act-pilot-contract.json", contract());
  const flow = status(root);
  // The contract's text is not the committed text, so the checkout is not clean; authorize waits behind setup.
  assert.equal(step(flow, "setup").code, "CHECKOUT_NOT_CLEAN");
  assert.equal(step(flow, "authorize").state, "WAITING");
  assert.notEqual(step(flow, "authorize").state, "DONE");
});

test("the whole ACT path reads DONE from committed and recorded files; watch is only as fresh as its report", () => {
  const { root, head } = checkout();
  write(root, "config/act-pilot-contract.json", contract());
  commitAll(root, "contract");
  const commit = head();
  markBuilt(root, commit);
  passingMatrix(root, commit);
  writeRunConfig(root, commit);
  writeJournal(root, commit, [
    journalLine(commit, "act:" + ACT_PATH, "start"),
    journalLine(commit, "act:" + ACT_PATH, "finish", "PASS"),
    journalLine(commit, "cleanup:" + ACT_PATH, "start"),
    journalLine(commit, "cleanup:" + ACT_PATH, "finish", "PASS"),
  ]);

  const flow = status(root);
  for (const id of ["setup", "rehearse", "authorize", "describe", "change", "cleanup"] as StepId[]) {
    assert.equal(step(flow, id).state, "DONE", id + " should be DONE: " + JSON.stringify(step(flow, id)));
  }
  assert.equal(step(flow, "models").state, "NEXT");
  assert.equal(step(flow, "watch").code, "NO_DRIFT_REPORT");
  assert.equal(flow.next, "models", "with every required step done, the first open step is the optional one");

  write(root, DRIFT, "{}\n");
  const mtime = statSync(join(root, DRIFT)).mtimeMs;
  assert.equal(step(status(root, mtime + 60 * 60 * 1000), "watch").code, "DRIFT_REPORT_FRESH");
  assert.equal(step(status(root, mtime + 13 * 60 * 60 * 1000), "watch").code, "DRIFT_REPORT_STALE");
});

test("a finished ACT run that failed blocks the change step with its code; an interrupted one says so", () => {
  const { root, head } = checkout();
  write(root, "config/act-pilot-contract.json", contract());
  commitAll(root, "contract");
  const commit = head();
  markBuilt(root, commit);
  writeRunConfig(root, commit);
  writeJournal(root, commit, [
    journalLine(commit, "act:" + ACT_PATH, "start"),
    journalLine(commit, "act:" + ACT_PATH, "finish", "FAIL", "APPLY_FAILED"),
  ]);
  const failed = step(status(root), "change");
  assert.equal(failed.state, "BLOCKED");
  assert.equal(failed.code, "LAST_RUN_FAIL:APPLY_FAILED");

  writeJournal(root, commit, [journalLine(commit, "act:" + ACT_PATH, "start")]);
  assert.equal(step(status(root), "change").code, "INTERRUPTED");
});

test("the flow has one step per name in the documented order, and every need is an earlier step", () => {
  const ids = FLOW.map((item) => item.id);
  assert.deepEqual(ids, ["setup", "rehearse", "models", "authorize", "describe", "change", "cleanup", "watch"]);
  assert.deepEqual(FLOW.map((item) => item.number), [1, 2, 3, 4, 5, 6, 7, 8]);
  FLOW.forEach((item, index) => {
    for (const need of item.needs) assert.ok(ids.indexOf(need) < index, item.id + " needs " + need + " before it");
  });
  for (const item of FLOW) {
    assert.ok(item.actions.terminal.length > 0 && item.actions.browser.length > 0 && item.actions.chat.length > 0, item.id);
  }
});
