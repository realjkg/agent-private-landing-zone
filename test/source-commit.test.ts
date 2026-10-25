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
  const git = (...args: string[]) => execFileSync("git", ["-C", dir, "-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", ...args], { encoding: "utf8" }).trim();
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
