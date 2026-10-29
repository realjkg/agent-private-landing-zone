import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// scripts/act-identity-runner-hook.sh: the job-started hook the owner installs on each credential-bearing runner instance
// (docs/act-pilot-identity-delivery.md, section 8). It must admit exactly the delivery workflow dispatched on main in the
// owner's repository and fail every other job before a step runs, deciding from its owner-only configuration and the runner's
// own event payload, not from variables a job could set. SYNTHETIC: GitHub's variables and payload are faked here.

const HOOK = "scripts/act-identity-runner-hook.sh";
const REPO = "fixture-owner/fixture-repo";
const WORKFLOW = ".github/workflows/act-identity-delivery.yml";
const scratch = mkdtempSync(join(tmpdir(), "alz-runner-hook-"));
test.after(() => rmSync(scratch, { recursive: true, force: true }));
const dispatch = { ref: "refs/heads/main", workflow: WORKFLOW, repository: { full_name: REPO }, inputs: { path: "aws-terraform", hold_minutes: "30" } };

let counter = 0;
type Install = { hook: string; conf: string; work: string; payload: string };
/** One runner instance: the hook copy and its owner-only configuration, and the work directory with the runner's payload. */
function install(payload: unknown = dispatch, conf?: string): Install {
  const base = join(scratch, "instance-" + ++counter);
  const hookDir = join(base, "hook");
  const work = join(base, "runner", "_work");
  mkdirSync(hookDir, { recursive: true, mode: 0o700 });
  mkdirSync(join(work, "_temp", "_github_workflow"), { recursive: true });
  const hook = join(hookDir, "act-identity-runner-hook.sh");
  copyFileSync(HOOK, hook);
  chmodSync(hook, 0o700);
  const confFile = join(hookDir, "act-identity-runner-hook.conf");
  writeFileSync(confFile, conf ?? "REPOSITORY=" + REPO + "\nRUNNER_WORK=" + work + "\nNODE=" + process.execPath + "\n", { mode: 0o600 });
  const payloadFile = join(work, "_temp", "_github_workflow", "event.json");
  writeFileSync(payloadFile, typeof payload === "string" ? payload : JSON.stringify(payload));
  return { hook, conf: confFile, work, payload: payloadFile };
}
const jobEnv = (at: Install, over: Record<string, string> = {}): Record<string, string> => ({
  PATH: "/usr/bin:/bin", GITHUB_REPOSITORY: REPO, GITHUB_EVENT_NAME: "workflow_dispatch", GITHUB_REF: "refs/heads/main",
  GITHUB_WORKFLOW_REF: REPO + "/" + WORKFLOW + "@refs/heads/main", GITHUB_JOB: "deliver", GITHUB_EVENT_PATH: at.payload, ...over,
});
const run = (at: Install, env: Record<string, string>) => spawnSync("bash", [at.hook], { env, encoding: "utf8" });
const refused = (at: Install, env: Record<string, string>, reason: RegExp, label: string) => {
  const result = run(at, env);
  assert.equal(result.status, 1, label + ": " + result.stdout + result.stderr);
  assert.match(result.stderr, /^ALZ_IDENTITY_RUNNER_REFUSED: /, label);
  assert.match(result.stderr, reason, label);
  assert.equal(result.stdout, "", label);
};

test("the delivery workflow's own jobs, dispatched on main in the owner's repository, are admitted", () => {
  const at = install();
  for (const job of ["deliver", "cleanup"]) {
    const result = run(at, jobEnv(at, { GITHUB_JOB: job }));
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, new RegExp("admitted \\.github/workflows/act-identity-delivery\\.yml \\(job " + job + "\\)"));
  }
  // GITHUB_EVENT_PATH may be absent: the hook reads the payload at its own fixed path.
  assert.equal(run(at, jobEnv(at, { GITHUB_EVENT_PATH: "" })).status, 0);
});

test("any other repository, event, ref, workflow or job is refused before a step runs", () => {
  const at = install();
  for (const [over, reason] of [
    [{ GITHUB_REPOSITORY: "attacker/fork" }, /another repository/],
    [{ GITHUB_EVENT_NAME: "pull_request" }, /not started by workflow_dispatch/],
    [{ GITHUB_EVENT_NAME: "pull_request_target" }, /not started by workflow_dispatch/],
    [{ GITHUB_EVENT_NAME: "push" }, /not started by workflow_dispatch/],
    [{ GITHUB_EVENT_NAME: "issue_comment" }, /not started by workflow_dispatch/],
    [{ GITHUB_REF: "refs/heads/feature" }, /not on main/],
    [{ GITHUB_REF: "refs/pull/7/merge" }, /not on main/],
    [{ GITHUB_REF: "refs/tags/main" }, /not on main/],
    [{ GITHUB_WORKFLOW_REF: REPO + "/" + WORKFLOW + "@refs/heads/feature" }, /not the identity delivery workflow on main/],
    [{ GITHUB_WORKFLOW_REF: REPO + "/.github/workflows/pr-validation.yml@refs/heads/main" }, /not the identity delivery workflow on main/],
    [{ GITHUB_JOB: "build" }, /not one of the delivery workflow jobs/],
    [{ GITHUB_JOB: "" }, /not one of the delivery workflow jobs/],
    [{ GITHUB_EVENT_PATH: join(scratch, "crafted.json") }, /GITHUB_EVENT_PATH is not this runner payload/],
  ] as const) refused(at, jobEnv(at, over), reason as RegExp, JSON.stringify(over));
});

test("the runner's own payload decides, whatever the job's variables say", () => {
  for (const [payload, label] of [
    ["{", "not JSON"],
    [{ ...dispatch, ref: "refs/heads/feature" }, "branch ref"],
    [{ ...dispatch, workflow: ".github/workflows/other.yml" }, "other workflow"],
    [{ ...dispatch, repository: { full_name: "attacker/fork" } }, "other repository"],
    [{ ...dispatch, inputs: undefined }, "no inputs: not a dispatch"],
    [{ pull_request: { number: 7 }, repository: { full_name: REPO } }, "a pull request payload"],
  ] as const) {
    const at = install(payload);
    refused(at, jobEnv(at), /event payload is not/, label);
  }
  const missing = install();
  rmSync(missing.payload);
  refused(missing, jobEnv(missing), /event payload is missing/, "missing payload");
  const linked = install();
  const elsewhere = join(scratch, "elsewhere.json");
  writeFileSync(elsewhere, JSON.stringify(dispatch));
  rmSync(linked.payload);
  symlinkSync(elsewhere, linked.payload);
  refused(linked, jobEnv(linked), /event payload is not a regular file/, "symlinked payload");
});

test("job-settable variables cannot steer the payload check (the reviewer's NODE_OPTIONS probe), nor PATH", () => {
  const at = install({ ...dispatch, ref: "refs/heads/feature" });
  refused(at, jobEnv(at, { NODE_OPTIONS: "--import=data:text/javascript,process.exit(0)" }), /event payload is not a dispatch/, "NODE_OPTIONS");
  refused(at, jobEnv(at, { NODE_OPTIONS: "--require=/nonexistent", NODE_PATH: scratch }), /event payload is not a dispatch/, "NODE_PATH");
  // A node first on PATH that admits everything is never run: the hook uses the configured absolute binary in an empty environment.
  const fakeBin = join(scratch, "fake-bin");
  mkdirSync(fakeBin, { recursive: true });
  writeFileSync(join(fakeBin, "node"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  refused(at, jobEnv(at, { PATH: fakeBin + ":/usr/bin:/bin" }), /event payload is not a dispatch/, "PATH");
});

test("a missing, open or incomplete configuration fails closed", () => {
  const noConf = install();
  rmSync(noConf.conf);
  refused(noConf, jobEnv(noConf), /act-identity-runner-hook\.conf is missing/, "missing conf");
  const open = install();
  chmodSync(open.conf, 0o644);
  refused(open, jobEnv(open), /act-identity-runner-hook\.conf is not owner-only/, "open conf");
  const writableHook = install();
  chmodSync(writableHook.hook, 0o777);
  refused(writableHook, jobEnv(writableHook), /the hook is not owner-only/, "group-writable hook");
  for (const [conf, reason] of [
    ["REPOSITORY=" + REPO + "\nNODE=" + process.execPath + "\n", /no absolute RUNNER_WORK/],
    ["RUNNER_WORK=/x/_work\nNODE=" + process.execPath + "\n", /no REPOSITORY/],
    ["REPOSITORY=" + REPO + "\nRUNNER_WORK=/x/_work\n", /no absolute NODE/],
    ["REPOSITORY=" + REPO + "\nREPOSITORY=" + REPO + "\nRUNNER_WORK=/x/_work\nNODE=" + process.execPath + "\n", /unknown or repeated line/],
    ["REPOSITORY=" + REPO + "\nRUNNER_WORK=/x/_work\nNODE=" + process.execPath + "\nEXTRA=1\n", /unknown or repeated line/],
  ] as const) {
    const at = install(dispatch, conf);
    refused(at, jobEnv(at, { GITHUB_EVENT_PATH: "" }), reason as RegExp, conf);
  }
  // Another instance's work directory: its payload is not where this configuration says, so the job is refused.
  const other = install();
  const wrongWork = install(dispatch, "REPOSITORY=" + REPO + "\nRUNNER_WORK=" + other.work + "/elsewhere\nNODE=" + process.execPath + "\n");
  refused(wrongWork, jobEnv(wrongWork, { GITHUB_EVENT_PATH: "" }), /event payload is missing/, "wrong work directory");
});
