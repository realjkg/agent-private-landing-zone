import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

// scripts/premerge.sh: the pre-merge command. Real git and bash in throwaway repositories; the affected-QA selector and npm
// are stubs that record how they were called, so this tests the script's routing, not the suites it starts. Synthetic.

const SCRIPT = resolve("scripts", "premerge.sh");
const root = mkdtempSync(join(tmpdir(), "alz-premerge-"));
test.after(() => rmSync(root, { recursive: true, force: true }));
let counter = 0;

const QA_STUB = `import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
const mode = process.argv[2];
appendFileSync(process.env.QA_LOG, mode + "\\n");
if (mode === "plan") {
  const gaps = JSON.parse(process.env.STUB_GAPS || "[]");
  mkdirSync(".runs/qa", { recursive: true });
  writeFileSync(".runs/qa/plan.json", JSON.stringify({ gaps }));
  if (gaps.length) { console.error("QA requires focused coverage:\\n" + gaps.join("\\n")); process.exitCode = 1; }
} else if (mode === "local") {
  console.log("QA scope: 2 affected test files; 3 changed paths.");
  process.exitCode = Number(process.env.STUB_QA_EXIT || 0);
}
`;
const NPM_STUB = `#!/usr/bin/env bash
echo "$*" >> "$NPM_LOG"
case "$2" in
  test:quiet) echo "3000 passed, 0 failed"; exit "\${STUB_SUITE_EXIT:-0}" ;;
  check) exit "\${STUB_CHECK_EXIT:-0}" ;;
esac
`;
const LINES = Array.from({ length: 12 }, (_, i) => "line " + i).join("\n") + "\n";

type Fixture = { dir: string; work: string; head: string; env: NodeJS.ProcessEnv; npmLog: string; qaLog: string; tmp: string };

/** A bare origin, a clone holding the script, and a PR head whose changes overlap main's later commit in one file. */
function fixture(options: { conflict?: boolean } = {}): Fixture {
  const dir = join(root, "case-" + ++counter);
  const origin = join(dir, "origin.git");
  const work = join(dir, "work");
  const bin = join(dir, "bin");
  const tmp = join(dir, "tmp");
  for (const path of [dir, bin, tmp]) mkdirSync(path, { recursive: true });
  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", ["-C", cwd, "-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  git(dir, "init", "-q", "--bare", "-b", "main", origin);
  git(dir, "clone", "-q", origin, work);
  git(work, "checkout", "-q", "-b", "main");
  mkdirSync(join(work, "scripts"));
  copyFileSync(SCRIPT, join(work, "scripts", "premerge.sh"));
  writeFileSync(join(work, "scripts", "qa-affected.mjs"), QA_STUB);
  writeFileSync(join(work, ".gitignore"), ".runs/\nnode_modules\n");
  writeFileSync(join(work, "shared.txt"), LINES);
  git(work, "add", "-A");
  git(work, "commit", "-q", "-m", "base");
  git(work, "push", "-q", "origin", "main");
  git(work, "checkout", "-q", "-b", "feature");
  writeFileSync(join(work, "shared.txt"), LINES.replace("line 11", "line 11 from the head"));
  writeFileSync(join(work, "feature.txt"), "new\n");
  git(work, "add", "-A");
  git(work, "commit", "-q", "-m", "head");
  git(work, "push", "-q", "origin", "feature");
  const head = git(work, "rev-parse", "HEAD");
  git(work, "checkout", "-q", "main");
  writeFileSync(join(work, "shared.txt"), options.conflict ? LINES.replace("line 11", "line 11 from main") : LINES.replace("line 0", "line 0 from main"));
  git(work, "commit", "-q", "-am", "main moves on");
  git(work, "push", "-q", "origin", "main");
  const npmLog = join(dir, "npm.log");
  const qaLog = join(dir, "qa.log");
  writeFileSync(join(bin, "npm"), NPM_STUB);
  chmodSync(join(bin, "npm"), 0o755);
  const freeTable = join(dir, "tcp-free");
  writeFileSync(freeTable, "  sl  local_address rem_address   st\n   0: 0100007F:1F90 00000000:0000 0A\n");
  const env: NodeJS.ProcessEnv = {
    ...process.env, PATH: bin + ":" + process.env.PATH, TMPDIR: tmp, NPM_LOG: npmLog, QA_LOG: qaLog,
    PREMERGE_PROC_TCP: freeTable, PREMERGE_SUITE_PATTERN: "alz-premerge-test-no-such-suite-" + process.pid,
    GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1",
  };
  return { dir, work, head, env, npmLog, qaLog, tmp };
}

function run(f: Fixture, args: string[], env: NodeJS.ProcessEnv = {}) {
  const result = spawnSync("bash", [join(f.work, "scripts", "premerge.sh"), ...args], { cwd: f.work, env: { ...f.env, ...env }, encoding: "utf8" });
  return { status: result.status, out: result.stdout + result.stderr };
}
const lines = (path: string) => existsSync(path) ? readFileSync(path, "utf8").trim().split("\n") : [];

/** No temporary worktree or directory survives a run, whatever its outcome. */
function assertCleaned(f: Fixture): void {
  const worktrees = execFileSync("git", ["-C", f.work, "worktree", "list", "--porcelain"], { encoding: "utf8" }).split("\n").filter((l) => l.startsWith("worktree "));
  assert.deepEqual(worktrees, ["worktree " + f.work], "only the checkout itself remains");
  assert.deepEqual(readdirSync(f.tmp), [], "the temporary directory is removed");
}

test("a clean head: test-merged onto main, overlap reported, affected QA and npm run check run, worktree removed", () => {
  const f = fixture();
  const { status, out } = run(f, [f.head]);
  assert.equal(status, 0, out);
  assert.match(out, /overlap with main since the merge base:\n {2}shared\.txt\n/);
  assert.doesNotMatch(out, /feature\.txt\n/, "a file only the head changed is not overlap");
  assert.match(out, /premerge: test merge [0-9a-f]{40}/);
  assert.deepEqual(lines(f.qaLog), ["plan", "local"]);
  assert.deepEqual(lines(f.npmLog), ["run check"], "no full suite under the cap");
  assert.match(out, /RESULT head=[0-9a-f]{40} base=[0-9a-f]{40} qa=PASS check=PASS/);
  assert.ok(existsSync(join(f.work, ".runs", "premerge", f.head, "qa.log")), "logs are kept");
  assertCleaned(f);
});

test("over the selector cap: the full quiet suite runs instead, then npm run check", () => {
  const f = fixture();
  const { status, out } = run(f, [f.head], { STUB_GAPS: JSON.stringify(["Affected test count 52 exceeds 45. Split the change or qualify it through an explicit release gate."]) });
  assert.equal(status, 0, out);
  assert.deepEqual(lines(f.qaLog), ["plan"], "the affected run is not attempted over the cap");
  assert.deepEqual(lines(f.npmLog), ["run test:quiet", "run check"]);
  assert.match(out, /qa=FULL_SUITE_PASS check=PASS/);
  assertCleaned(f);
});

test("over the cap with port 11435 in use: no full suite starts, exit 3", () => {
  const f = fixture();
  const busy = join(f.dir, "tcp-busy");
  writeFileSync(busy, "  sl  local_address rem_address   st\n   0: 0100007F:2CAB 00000000:0000 0A\n");
  const { status, out } = run(f, [f.head], { PREMERGE_PROC_TCP: busy, STUB_GAPS: JSON.stringify(["Affected test count 60 exceeds 45. Split it."]) });
  assert.equal(status, 3, out);
  assert.match(out, /port 11435 is in use/);
  assert.match(out, /FULL_SUITE_BUSY/);
  assert.deepEqual(lines(f.npmLog), [], "neither the suite nor the check ran");
  assertCleaned(f);
});

test("a coverage gap blocks: no full-suite fallback, exit 1", () => {
  const f = fixture();
  const { status, out } = run(f, [f.head], { STUB_GAPS: JSON.stringify(["src/x.ts has no importing test. Add a focused test.", "Affected test count 50 exceeds 45. Split it."]) });
  assert.equal(status, 1, out);
  assert.match(out, /coverage gaps \(blocking\)/);
  assert.match(out, /src\/x\.ts has no importing test/);
  assert.ok(!lines(f.npmLog).includes("run test:quiet"), "a real gap is never masked by the full suite");
  assert.match(out, /qa=FAIL/);
  assertCleaned(f);
});

test("a failing affected QA or check fails the run", () => {
  const f = fixture();
  assert.equal(run(f, [f.head], { STUB_QA_EXIT: "1" }).status, 1);
  const check = run(f, [f.head], { STUB_CHECK_EXIT: "2" });
  assert.equal(check.status, 1);
  assert.match(check.out, /qa=PASS check=FAIL/);
  assertCleaned(f);
});

test("a head that conflicts with main reports MERGE_CONFLICT and runs nothing", () => {
  const f = fixture({ conflict: true });
  const { status, out } = run(f, [f.head]);
  assert.equal(status, 1, out);
  assert.match(out, /MERGE_CONFLICT\n {2}shared\.txt/);
  assert.deepEqual(lines(f.qaLog), []);
  assert.deepEqual(lines(f.npmLog), []);
  assertCleaned(f);
});

test("usage: exactly one full commit SHA, and it must be a fetched commit", () => {
  const f = fixture();
  for (const args of [[], [f.head.slice(0, 7)], ["main"], [f.head, "extra"], [f.head.toUpperCase()]]) {
    const { status, out } = run(f, args);
    assert.equal(status, 2, args.join(" ") + ": " + out);
    assert.match(out, /usage: scripts\/premerge\.sh <head-sha>/);
  }
  const unknown = run(f, ["0".repeat(40)]);
  assert.equal(unknown.status, 1);
  assert.match(unknown.out, /is not a commit fetched from origin/);
  assertCleaned(f);
});
