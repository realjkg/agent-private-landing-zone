import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { ACT_PATH, FLOW, LZA_CARD, flowFor, readFlow, type FlowStatus, type StepId, type StepStatus } from "../src/flow/one-flow.js";
import { ACCOUNT, validConfig } from "./helpers/evidence-fixtures.js";

// Throwaway git checkouts under the OS temp folder. Nothing here reaches a cloud, a model or a real account.

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

function journalLine(commit: string, stage: string, event: "start" | "finish", outcome?: string, code?: string, label: "LIVE" | "SYNTHETIC" = "LIVE"): string {
  return JSON.stringify({
    schemaVersion: 1, sourceCommit: commit, configSha256: "0".repeat(64), targetHardwareId: "owner-mac-01", label,
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

// --- The LZA/AFT path: LZA is CDK/CloudFormation, the AFT customizations are Terraform. The runner has no LZA/AFT change stage yet.

const LZA_CARD_TEXT = JSON.stringify({ runId: "pilot-001", lza: { repository: "owner/lza-config" }, aft: { repository: "owner/aft-account-request" } }, null, 2) + "\n";
const CDK_MATRIX = ".runs/qualification/private-agent-matrix/matrix-cccccccc-bbbb-4ccc-8ddd-eeeeeeeeeeee.json";

function passingMatrixFor(root: string, scenario: string, commit: string): void {
  const file = scenario === "cdk-aws-brownfield" ? CDK_MATRIX : MATRIX_FILE;
  write(root, file, JSON.stringify({ mode: "OFFLINE_FIXTURE", passed: true, sourceCommit: commit, results: [{ id: scenario, converged: true }] }));
}

function lzaRunConfig(root: string, commit: string): void {
  write(root, "config/evidence-runner.json", JSON.stringify(validConfig({
    candidateCommit: commit,
    aws: { expectedAccountId: ACCOUNT, region: "us-east-1", qualificationStack: "alz-qualification-noop", aftLzaCard: LZA_CARD },
  }), null, 2));
}

test("the default path is Terraform, and the LZA/AFT path has its own operator actions", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "alz-one-flow-default-")));
  assert.equal(status(root).path, "terraform");
  assert.equal(readFlow({ root, env: {}, path: "lza-aft" }).path, "lza-aft");
  assert.deepEqual(flowFor("terraform"), FLOW);
  const lza = flowFor("lza-aft");
  assert.deepEqual(lza.map((item) => item.id), FLOW.map((item) => item.id), "same eight steps, in the same order");
  const change = lza.find((item) => item.id === "change");
  assert.ok(change?.actions.terminal.includes("aws-aft-lza") && change.actions.terminal.includes("merges nothing"));
  const rehearse = lza.find((item) => item.id === "rehearse");
  assert.ok(rehearse?.actions.terminal.includes("cdk-aws-brownfield") && rehearse.actions.terminal.includes("terraform-aws-brownfield"));
});

test("the LZA rehearsal needs both engines to pass at this commit", () => {
  const { root, head } = checkout();
  markBuilt(root, head());
  passingMatrixFor(root, "terraform-aws-brownfield", head());
  const onlyTerraform = readFlow({ root, env: {}, path: "lza-aft" });
  assert.equal(step(onlyTerraform, "rehearse").state, "NEXT");
  assert.ok(step(onlyTerraform, "rehearse").detail.includes("cdk-aws-brownfield"));
  passingMatrixFor(root, "cdk-aws-brownfield", head());
  assert.equal(step(readFlow({ root, env: {}, path: "lza-aft" }), "rehearse").state, "DONE");
});

test("the LZA card is the owner's: committed, complete, and named in the run config", () => {
  const { root, head } = checkout();
  markBuilt(root, head());
  assert.equal(step(readFlow({ root, env: {}, path: "lza-aft" }), "authorize").code, "CARD_NOT_COMMITTED");

  write(root, LZA_CARD, LZA_CARD_TEXT.replace("owner/lza-config", "REPLACE-WITH-owner/lza-config"));
  commitAll(root, "card with placeholders");
  markBuilt(root, head());
  const incomplete = step(readFlow({ root, env: {}, path: "lza-aft" }), "authorize");
  assert.equal(incomplete.code, "CARD_INCOMPLETE");
  assert.equal(incomplete.who, "Owner");

  write(root, LZA_CARD, LZA_CARD_TEXT);
  commitAll(root, "complete card");
  markBuilt(root, head());
  assert.equal(step(readFlow({ root, env: {}, path: "lza-aft" }), "authorize").code, "CARD_COMMITTED");

  assert.equal(step(readFlow({ root, env: {}, path: "lza-aft" }), "describe").code, "NOT_DESCRIBED");
  writeRunConfig(root, head());
  assert.equal(step(readFlow({ root, env: {}, path: "lza-aft" }), "describe").code, "CARD_NOT_NAMED");
  lzaRunConfig(root, head());
  assert.equal(step(readFlow({ root, env: {}, path: "lza-aft" }), "describe").state, "DONE");
});

test("the LZA/AFT change and cleanup are not judged done without a described run", () => {
  const { root, head } = checkout();
  markBuilt(root, head());
  const flow = readFlow({ root, env: {}, path: "lza-aft" });
  assert.notEqual(step(flow, "change").state, "DONE");
  assert.notEqual(step(flow, "cleanup").state, "DONE");
  assert.notEqual(flow.next, "change");
});

/** A described LZA/AFT checkout at its final commit, ready for the change step. */
function lzaReady(): { root: string; commit: string } {
  const { root, head } = checkout();
  write(root, LZA_CARD, LZA_CARD_TEXT);
  commitAll(root, "owner artifact");
  const commit = head();
  markBuilt(root, commit);
  passingMatrixFor(root, "terraform-aws-brownfield", commit);
  passingMatrixFor(root, "cdk-aws-brownfield", commit);
  lzaRunConfig(root, commit);
  return { root, commit };
}

test("LZA/AFT: the change step is judged from the live aws-aft-lza journal record", () => {
  const { root, commit } = lzaReady();
  let flow = readFlow({ root, env: {}, path: "lza-aft" });
  assert.equal(step(flow, "change").state, "NEXT");
  assert.equal(step(flow, "change").code, "NOT_RUN");

  writeJournal(root, commit, [journalLine(commit, "aws-aft-lza", "start"), journalLine(commit, "aws-aft-lza", "finish", "PASS")]);
  flow = readFlow({ root, env: {}, path: "lza-aft" });
  assert.equal(step(flow, "change").state, "DONE");
  assert.equal(step(flow, "change").code, "VERIFIED");
  assert.equal(step(flow, "cleanup").state, "NEXT", "a forward PASS does not remove anything");
  assert.equal(step(flow, "cleanup").code, "NOT_REMOVED");
});

test("LZA/AFT: the cleanup step is judged from the live aws-aft-lza-removal journal record", () => {
  const { root, commit } = lzaReady();
  const forward = [journalLine(commit, "aws-aft-lza", "start"), journalLine(commit, "aws-aft-lza", "finish", "PASS")];
  writeJournal(root, commit, [...forward, journalLine(commit, "aws-aft-lza-removal", "start"), journalLine(commit, "aws-aft-lza-removal", "finish", "PASS")]);
  let cleanup = step(readFlow({ root, env: {}, path: "lza-aft" }), "cleanup");
  assert.equal(cleanup.state, "DONE");
  assert.equal(cleanup.code, "RETIRED");

  const cases: [string[], string, string][] = [
    [[journalLine(commit, "aws-aft-lza-removal", "start"), journalLine(commit, "aws-aft-lza-removal", "finish", "BLOCKED", "AWAIT_UNMANAGE")], "BLOCKED", "LAST_RUN_BLOCKED:AWAIT_UNMANAGE"],
    [[journalLine(commit, "aws-aft-lza-removal", "start"), journalLine(commit, "aws-aft-lza-removal", "finish", "FAIL", "ACCOUNT_NOT_IN_IGNORED_OU")], "BLOCKED", "LAST_RUN_FAIL:ACCOUNT_NOT_IN_IGNORED_OU"],
    [[journalLine(commit, "aws-aft-lza-removal", "start")], "BLOCKED", "INTERRUPTED"],
    [[journalLine(commit, "aws-aft-lza-removal", "start", undefined, undefined, "SYNTHETIC"), journalLine(commit, "aws-aft-lza-removal", "finish", "PASS", undefined, "SYNTHETIC")], "BLOCKED", "JOURNAL_LABEL_MISMATCH"],
    [[journalLine(commit, "cleanup:" + ACT_PATH, "start"), journalLine(commit, "cleanup:" + ACT_PATH, "finish", "PASS")], "NEXT", "NOT_REMOVED"],
  ];
  for (const [lines, state, code] of cases) {
    writeJournal(root, commit, [...forward, ...lines]);
    cleanup = step(readFlow({ root, env: {}, path: "lza-aft" }), "cleanup");
    assert.equal(cleanup.state, state, code);
    assert.equal(cleanup.code, code);
  }
});

test("LZA/AFT: a blocked, failed or interrupted aws-aft-lza run blocks the change step", () => {
  const { root, commit } = lzaReady();
  const cases: [string[], string][] = [
    [[journalLine(commit, "aws-aft-lza", "start"), journalLine(commit, "aws-aft-lza", "finish", "BLOCKED", "AWAIT_LZA_SUBMISSION")], "LAST_RUN_BLOCKED:AWAIT_LZA_SUBMISSION"],
    [[journalLine(commit, "aws-aft-lza", "start"), journalLine(commit, "aws-aft-lza", "finish", "FAIL", "LZA_PIPELINE_FAILED")], "LAST_RUN_FAIL:LZA_PIPELINE_FAILED"],
    [[journalLine(commit, "aws-aft-lza", "start")], "INTERRUPTED"],
  ];
  for (const [lines, code] of cases) {
    writeJournal(root, commit, lines);
    const change = step(readFlow({ root, env: {}, path: "lza-aft" }), "change");
    assert.equal(change.state, "BLOCKED", code);
    assert.equal(change.code, code);
  }
});

test("LZA/AFT: a PASS for another stage or a non-live PASS does not mark the change done", () => {
  const { root, commit } = lzaReady();
  writeJournal(root, commit, [
    journalLine(commit, "act:" + ACT_PATH, "start"), journalLine(commit, "act:" + ACT_PATH, "finish", "PASS"),
    journalLine(commit, "aws-readonly", "start"), journalLine(commit, "aws-readonly", "finish", "PASS"),
  ]);
  assert.equal(step(readFlow({ root, env: {}, path: "lza-aft" }), "change").code, "NOT_RUN");

  writeJournal(root, commit, [
    journalLine(commit, "aws-aft-lza", "start", undefined, undefined, "SYNTHETIC"),
    journalLine(commit, "aws-aft-lza", "finish", "PASS", undefined, "SYNTHETIC"),
  ]);
  const change = step(readFlow({ root, env: {}, path: "lza-aft" }), "change");
  assert.equal(change.state, "BLOCKED");
  assert.equal(change.code, "JOURNAL_LABEL_MISMATCH");
});

// --- End-to-end walkthroughs, both paths. Nothing here reaches AWS or a model.

function writeNonLiveJournal(root: string, commit: string, lines: string[]): void {
  write(root, ".runs/evidence/synthetic/" + commit.slice(0, 12) + "/journal.jsonl", lines.join("\n") + "\n");
}

for (const path of ["terraform", "lza-aft"] as const) {
  test(path + ": a walkthrough reaches the change step, and a non-live record does not count for it", () => {
    const { root, head } = checkout();
    // 1. The owner's artifact is committed first, so every later artifact names the final commit.
    if (path === "terraform") {
      write(root, "config/act-pilot-contract.json", contract());
    } else {
      write(root, LZA_CARD, LZA_CARD_TEXT);
    }
    commitAll(root, "owner artifact");
    const commit = head();

    // 2. Build at the final commit: the next open step is the rehearsal.
    markBuilt(root, commit);
    let flow = readFlow({ root, env: {}, path });
    assert.equal(flow.path, path);
    assert.equal(flow.next, "rehearse");

    // 3. Rehearsal. Terraform needs one scenario; LZA/AFT needs both engines.
    passingMatrixFor(root, "terraform-aws-brownfield", commit);
    flow = readFlow({ root, env: {}, path });
    if (path === "lza-aft") {
      assert.equal(step(flow, "rehearse").state, "NEXT");
      passingMatrixFor(root, "cdk-aws-brownfield", commit);
      flow = readFlow({ root, env: {}, path });
    }
    assert.equal(step(flow, "rehearse").state, "DONE");

    // 4. Describe the run at this commit. The run config is the owner's, and it is ignored by git.
    if (path === "terraform") writeRunConfig(root, commit);
    else lzaRunConfig(root, commit);
    flow = readFlow({ root, env: {}, path });
    assert.equal(step(flow, "authorize").state, "DONE");
    assert.equal(step(flow, "describe").state, "DONE");
    assert.equal(step(flow, "change").state, "NEXT");
    assert.equal(step(flow, "change").code, path === "terraform" ? "NOT_APPLIED" : "NOT_RUN");
    assert.equal(flow.next, "change");
    const changeStage = path === "terraform" ? "act:" + ACT_PATH : "aws-aft-lza";

    // 5. A non-live record is written to the other folder. The flow does not read that folder for done-state.
    writeNonLiveJournal(root, commit, [
      journalLine(commit, changeStage, "start", undefined, undefined, "SYNTHETIC"),
      journalLine(commit, changeStage, "finish", "PASS", undefined, "SYNTHETIC"),
      journalLine(commit, "cleanup:" + ACT_PATH, "start", undefined, undefined, "SYNTHETIC"),
      journalLine(commit, "cleanup:" + ACT_PATH, "finish", "PASS", undefined, "SYNTHETIC"),
    ]);
    flow = readFlow({ root, env: {}, path });
    assert.notEqual(step(flow, "change").state, "DONE");
    assert.notEqual(step(flow, "cleanup").state, "DONE");

    // 6. A non-live record in the live journal does not count.
    writeJournal(root, commit, [
      journalLine(commit, changeStage, "start", undefined, undefined, "SYNTHETIC"),
      journalLine(commit, changeStage, "finish", "PASS", undefined, "SYNTHETIC"),
    ]);
    flow = readFlow({ root, env: {}, path });
    assert.equal(step(flow, "change").state, "BLOCKED");
    assert.equal(step(flow, "change").code, "JOURNAL_LABEL_MISMATCH");
    assert.notEqual(step(flow, "cleanup").state, "DONE");
  });
}

test("a live PASS for the change and cleanup is the only thing that marks them done (Terraform)", () => {
  const { root, head } = checkout();
  write(root, "config/act-pilot-contract.json", contract());
  commitAll(root, "owner artifact");
  const commit = head();
  markBuilt(root, commit);
  passingMatrixFor(root, "terraform-aws-brownfield", commit);
  writeRunConfig(root, commit);
  writeJournal(root, commit, [
    journalLine(commit, "act:" + ACT_PATH, "start"),
    journalLine(commit, "act:" + ACT_PATH, "finish", "PASS"),
    journalLine(commit, "cleanup:" + ACT_PATH, "start"),
    journalLine(commit, "cleanup:" + ACT_PATH, "finish", "PASS"),
  ]);
  const flow = readFlow({ root, env: {}, path: "terraform" });
  assert.equal(step(flow, "change").state, "DONE");
  assert.equal(step(flow, "cleanup").state, "DONE");
});
