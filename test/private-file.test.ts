import assert from "node:assert/strict";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { PrivateFileError, writePrivateFileAtomic } from "../src/tools/private-file.js";

// #362 review N2: the apply CLI's private documents (review bundle, proposals, lifecycle report, observation summary) are written
// atomically, 0600 on every write, and never through a link. SYNTHETIC: temporary folders only.
const root = mkdtempSync(join(tmpdir(), "alz-private-file-"));
test.after(() => rmSync(root, { recursive: true, force: true }));
let counter = 0;
const fresh = (): string => { const dir = join(root, "d" + (counter += 1)); mkdirSync(dir); return dir; };
const mode = (path: string): number => statSync(path).mode & 0o777;

test("a new private file is 0600, its folder is created 0700, and no temporary file is left", () => {
  const dir = join(fresh(), "reports");
  const path = join(dir, "aaaaaaaaaaaa-observation.json");
  writePrivateFileAtomic(path, "{\"verdict\":\"VERIFIED\"}\n");
  assert.equal(readFileSync(path, "utf8"), "{\"verdict\":\"VERIFIED\"}\n");
  assert.equal(mode(path), 0o600);
  assert.equal(mode(dir), 0o700);
  assert.deepEqual(readdirSync(dir), ["aaaaaaaaaaaa-observation.json"]);
});

test("a rewrite replaces the file atomically (a new inode) and sets 0600 again, whatever mode the earlier file had", () => {
  const dir = fresh();
  const path = join(dir, "report.json");
  writeFileSync(path, "old\n", { mode: 0o644 });
  chmodSync(path, 0o644);
  const before = lstatSync(path);
  writePrivateFileAtomic(path, Buffer.from("new\n"));
  const after = lstatSync(path);
  assert.equal(readFileSync(path, "utf8"), "new\n");
  assert.equal(mode(path), 0o600);
  assert.notEqual(after.ino, before.ino, "renamed over, never written in place");
  assert.deepEqual(readdirSync(dir), ["report.json"]);
});

test("a symbolic link or a folder at the target name is refused, nothing is written through it, and no temporary file is left", () => {
  const dir = fresh();
  const outside = join(fresh(), "elsewhere.json");
  writeFileSync(outside, "untouched\n");
  const link = join(dir, "proposal.json");
  symlinkSync(outside, link);
  assert.throws(() => writePrivateFileAtomic(link, "attacker\n"), (error: unknown) => error instanceof PrivateFileError && /not a regular file/.test(error.message));
  assert.equal(readFileSync(outside, "utf8"), "untouched\n", "the link's target is never written");
  assert.equal(readlinkSync(link), outside, "the link itself is left as it was");
  const dangling = join(dir, "dangling.json");
  symlinkSync(join(dir, "missing.json"), dangling);
  assert.throws(() => writePrivateFileAtomic(dangling, "x\n"), PrivateFileError);
  assert.throws(() => lstatSync(join(dir, "missing.json")), "a dangling link is never followed to create its target");
  mkdirSync(join(dir, "folder.json"));
  assert.throws(() => writePrivateFileAtomic(join(dir, "folder.json"), "x\n"), PrivateFileError);
  assert.deepEqual(readdirSync(dir).sort(), ["dangling.json", "folder.json", "proposal.json"]);
});

test("a failure part-way leaves the target as it was and removes the temporary file", () => {
  const dir = fresh();
  const path = join(dir, "bundle.json");
  writeFileSync(path, "kept\n", { mode: 0o600 });
  let temporaries: string[] = [];
  assert.throws(() => writePrivateFileAtomic(path, "new\n", { beforeRename: () => { temporaries = readdirSync(dir).filter((n) => n !== "bundle.json"); throw new Error("stopped before the rename"); } }), /stopped before the rename/);
  assert.equal(temporaries.length, 1, "the new bytes were in a temporary file");
  assert.match(temporaries[0], /^\.bundle\.json\.tmp-\d+-[0-9a-f]{12}$/);
  assert.equal(readFileSync(path, "utf8"), "kept\n");
  assert.deepEqual(readdirSync(dir), ["bundle.json"]);
});
