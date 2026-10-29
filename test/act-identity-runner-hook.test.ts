import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

// scripts/act-identity-runner-hook.sh: the job-started hook the owner installs on the credential-bearing runner
// (docs/act-pilot-identity-delivery.md). It must admit exactly the delivery workflow dispatched on main in the owner's repository
// and fail every other job before a step runs. SYNTHETIC: GitHub's default variables and event payload are faked here.

const HOOK = "scripts/act-identity-runner-hook.sh";
const REPO = "fixture-owner/fixture-repo";
const WORKFLOW = ".github/workflows/act-identity-delivery.yml";
const dir = mkdtempSync(join(tmpdir(), "alz-runner-hook-"));
test.after(() => rmSync(dir, { recursive: true, force: true }));
let counter = 0;
const payload = (value: unknown): string => {
  const file = join(dir, "event-" + ++counter + ".json");
  writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value));
  return file;
};
const dispatch = { ref: "refs/heads/main", workflow: WORKFLOW, repository: { full_name: REPO }, inputs: { path: "aws-terraform", hold_minutes: "30" } };
const admitted = (): Record<string, string> => ({
  PATH: dirname(process.execPath) + ":/usr/bin:/bin", ALZ_IDENTITY_RUNNER_REPOSITORY: REPO, GITHUB_REPOSITORY: REPO, GITHUB_EVENT_NAME: "workflow_dispatch",
  GITHUB_REF: "refs/heads/main", GITHUB_WORKFLOW_REF: REPO + "/" + WORKFLOW + "@refs/heads/main", GITHUB_JOB: "deliver", GITHUB_RUN_ID: "4242",
  GITHUB_EVENT_PATH: payload(dispatch),
});
const run = (env: Record<string, string>) => spawnSync("bash", [HOOK], { env, encoding: "utf8" });

test("the delivery workflow's own jobs, dispatched on main in the owner's repository, are admitted", () => {
  for (const job of ["deliver", "cleanup"]) {
    const result = run({ ...admitted(), GITHUB_JOB: job });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, new RegExp("admitted \\.github/workflows/act-identity-delivery\\.yml \\(job " + job + ", run 4242\\)"));
  }
});

test("any other repository, event, ref, workflow or job is refused before a step runs", () => {
  for (const [over, reason] of [
    [{ ALZ_IDENTITY_RUNNER_REPOSITORY: "" }, /ALZ_IDENTITY_RUNNER_REPOSITORY is not set/],
    [{ ALZ_IDENTITY_RUNNER_REPOSITORY: "fixture-owner/*" }, /ALZ_IDENTITY_RUNNER_REPOSITORY is not set/],
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
    [{ GITHUB_JOB: "build" }, /not one of the delivery workflow's jobs/],
    [{ GITHUB_JOB: "" }, /not one of the delivery workflow's jobs/],
    [{ GITHUB_EVENT_PATH: "" }, /event payload is missing/],
    [{ GITHUB_EVENT_PATH: join(dir, "absent.json") }, /event payload is missing/],
    [{ GITHUB_EVENT_PATH: payload("{") }, /event payload is not a dispatch/],
    [{ GITHUB_EVENT_PATH: payload({ ...dispatch, ref: "refs/heads/feature" }) }, /event payload is not a dispatch/],
    [{ GITHUB_EVENT_PATH: payload({ ...dispatch, workflow: ".github/workflows/other.yml" }) }, /event payload is not a dispatch/],
    [{ GITHUB_EVENT_PATH: payload({ ...dispatch, repository: { full_name: "attacker/fork" } }) }, /event payload is not a dispatch/],
    [{ GITHUB_EVENT_PATH: payload({ pull_request: { number: 7 }, repository: { full_name: REPO } }) }, /event payload is not a dispatch/],
  ] as const) {
    const result = run({ ...admitted(), ...over });
    assert.equal(result.status, 1, JSON.stringify(over));
    assert.match(result.stderr, /^ALZ_IDENTITY_RUNNER_REFUSED: /, JSON.stringify(over));
    assert.match(result.stderr, reason as RegExp, JSON.stringify(over));
    assert.equal(result.stdout, "");
  }
  const link = join(dir, "linked.json");
  symlinkSync(payload(dispatch), link);
  assert.equal(run({ ...admitted(), GITHUB_EVENT_PATH: link }).status, 1, "a symbolic link is not the runner's own payload");
});
