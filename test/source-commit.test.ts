import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { resolveSourceCommit } from "../src/util/source-commit.js";

// The product commit a pilot seal or apply names (src/util/source-commit.ts). Real git, in throwaway repositories.

const root = mkdtempSync(join(tmpdir(), "alz-source-"));
test.after(() => rmSync(root, { recursive: true, force: true }));
const STAMP = "5ec0de0000000000000000000000000000c0ffee";
let counter = 0;

function repository(): { dir: string; head: string } {
  const dir = join(root, "repo-" + ++counter);
  mkdirSync(dir);
  const git = (...args: string[]) => execFileSync("git", ["-C", dir, "-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", ...args], { encoding: "utf8" }).trim();
  git("init", "-q");
  writeFileSync(join(dir, ".gitignore"), ".runs/\n");
  writeFileSync(join(dir, "app.ts"), "export const x = 1;\n");
  git("add", "-A");
  git("commit", "-q", "-m", "fixture");
  return { dir, head: git("rev-parse", "HEAD") };
}

test("a clean checkout names its HEAD commit, and the image stamp cannot override it", () => {
  const { dir, head } = repository();
  assert.deepEqual(resolveSourceCommit(dir, { ALZ_SOURCE_COMMIT: STAMP }), { ok: true, commit: head, origin: "GIT_CHECKOUT" });
  // Ignored run output does not make the checkout dirty.
  mkdirSync(join(dir, ".runs"));
  writeFileSync(join(dir, ".runs", "evidence.json"), "{}");
  assert.equal(resolveSourceCommit(dir, {}).ok, true);
});

test("uncommitted changes, staged or not, and new unignored files are refused, never named after HEAD", () => {
  const edited = repository();
  writeFileSync(join(edited.dir, "app.ts"), "export const x = 2;\n");
  const refused = resolveSourceCommit(edited.dir, { ALZ_SOURCE_COMMIT: STAMP });
  assert.equal(refused.ok, false);
  assert.match(refused.ok ? "" : refused.reason, /uncommitted changes/);
  const added = repository();
  writeFileSync(join(added.dir, "new.ts"), "export const y = 1;\n");
  assert.equal(resolveSourceCommit(added.dir, {}).ok, false);
});

test("without a checkout only a full build stamp is used; anything else is refused, not guessed", () => {
  const plain = join(root, "image");
  mkdirSync(plain);
  assert.deepEqual(resolveSourceCommit(plain, { ALZ_SOURCE_COMMIT: STAMP }), { ok: true, commit: STAMP, origin: "BUILD_STAMP" });
  for (const stamp of [undefined, "", "HEAD", STAMP.slice(0, 12), STAMP.toUpperCase(), STAMP + "0"]) {
    assert.equal(resolveSourceCommit(plain, stamp === undefined ? {} : { ALZ_SOURCE_COMMIT: stamp }).ok, false, String(stamp));
  }
});

test("a checkout with no commit yet is refused", () => {
  const dir = join(root, "empty");
  mkdirSync(dir);
  execFileSync("git", ["-C", dir, "init", "-q"]);
  assert.equal(resolveSourceCommit(dir, { ALZ_SOURCE_COMMIT: STAMP }).ok, false);
});

test("the committed contract is the authorization: an uncommitted edit adding REMOVE is refused, also when git status cannot see it", () => {
  const CONTRACT = "config/act-pilot-contract.json";
  const committed = JSON.stringify({ enabled: true, authorize: { DEV: ["APPLY", "CLEANUP"] } });
  const edited = JSON.stringify({ enabled: true, authorize: { DEV: ["APPLY", "CLEANUP", "REMOVE"] } });
  const withContract = () => {
    const repo = repository();
    const git = (...args: string[]) => execFileSync("git", ["-C", repo.dir, "-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", ...args], { encoding: "utf8" }).trim();
    mkdirSync(join(repo.dir, "config"));
    writeFileSync(join(repo.dir, CONTRACT), committed);
    git("add", "-A");
    git("commit", "-q", "-m", "contract");
    return { ...repo, git };
  };
  // Committed and unchanged, or absent: the checkout is the commit.
  const clean = withContract();
  assert.equal(resolveSourceCommit(clean.dir, {}, [CONTRACT]).ok, true);
  assert.equal(resolveSourceCommit(repository().dir, {}, [CONTRACT]).ok, true, "no contract at all is not an edit");
  // A plain uncommitted edit: git status sees it.
  const plain = withContract();
  writeFileSync(join(plain.dir, CONTRACT), edited);
  assert.equal(resolveSourceCommit(plain.dir, {}, [CONTRACT]).ok, false);
  // Hidden from git status: skip-worktree, assume-unchanged, or an untracked contract excluded locally.
  for (const flag of ["--skip-worktree", "--assume-unchanged"]) {
    const hidden = withContract();
    hidden.git("update-index", flag, CONTRACT);
    writeFileSync(join(hidden.dir, CONTRACT), edited);
    assert.equal(resolveSourceCommit(hidden.dir, {}).ok, true, flag + ": git status alone reads this as clean");
    const refused = resolveSourceCommit(hidden.dir, {}, [CONTRACT]);
    assert.equal(refused.ok, false, flag);
    assert.match(refused.ok ? "" : refused.reason, /not exactly the committed file/);
  }
  const excluded = repository();
  writeFileSync(join(excluded.dir, ".git", "info", "exclude"), "config/\n");
  mkdirSync(join(excluded.dir, "config"));
  writeFileSync(join(excluded.dir, CONTRACT), edited);
  assert.equal(resolveSourceCommit(excluded.dir, {}).ok, true, "an excluded untracked file reads as clean to git status");
  assert.equal(resolveSourceCommit(excluded.dir, {}, [CONTRACT]).ok, false, "but it is not the committed contract");
});
