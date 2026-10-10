import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { registerCleanup, removeTree, runCleanups, sweepStale } from "../src/teardown/driver/cleanup.js";

// docs/destroy-preview-driver.md, "Cleanup". A plan file, a work copy and a
// snapshot must not outlive the run, including a run that is signalled.

const root = mkdtempSync(join(tmpdir(), "alz-cleanup-test-"));
test.after(() => { try { removeTree(root); } catch { /* best effort */ } });
let counter = 0;
const fresh = (label: string) => {
  const dir = join(root, label + "-" + ++counter);
  mkdirSync(dir, { recursive: true });
  return dir;
};

test("a registered remover runs once, a failing one does not stop the rest, and an unregistered one never runs", () => {
  const ran: string[] = [];
  registerCleanup(() => { ran.push("a"); });
  registerCleanup(() => { throw new Error("cannot remove"); });
  registerCleanup(() => { ran.push("c"); });
  registerCleanup(() => { ran.push("never"); })();
  assert.equal(runCleanups(), 1);
  assert.deepEqual(ran, ["a", "c"]);
  assert.equal(runCleanups(), 0, "cleared: nothing runs twice");
  assert.deepEqual(ran, ["a", "c"]);
});

test("removeTree removes a tree that code left read-only", () => {
  const dir = fresh("tree");
  mkdirSync(join(dir, "ro", "deeper"), { recursive: true });
  writeFileSync(join(dir, "ro", "deeper", "plan"), "x");
  chmodSync(join(dir, "ro", "deeper", "plan"), 0o400);
  chmodSync(join(dir, "ro", "deeper"), 0o500);
  chmodSync(join(dir, "ro"), 0o500);
  chmodSync(dir, 0o500);
  removeTree(dir);
  assert.equal(existsSync(dir), false);
  removeTree(dir);
});

test("removeTree does not follow a link out of the tree", () => {
  const outside = fresh("outside");
  writeFileSync(join(outside, "keep"), "x");
  chmodSync(join(outside, "keep"), 0o444);
  const dir = fresh("tree");
  symlinkSync(outside, join(dir, "link"));
  removeTree(dir);
  assert.equal(existsSync(dir), false);
  assert.equal(existsSync(join(outside, "keep")), true);
  assert.equal(statSync(join(outside, "keep")).mode & 0o777, 0o444, "the link target was not touched");
});

test("the stale sweep removes only this account's old directories with the driver's prefixes", () => {
  const parent = fresh("sweep");
  const old = new Date(Date.now() - 3 * 60 * 60 * 1000);
  const make = (name: string, aged: boolean) => {
    const dir = join(parent, name);
    mkdirSync(join(dir, "inner"), { recursive: true });
    writeFileSync(join(dir, "inner", "alz-preview.tfplan"), "x");
    chmodSync(join(dir, "inner"), 0o500);
    if (aged) utimesSync(dir, old, old);
    return dir;
  };
  make("alz-preview-old", true);
  make("alz-snapshot-old", true);
  make("alz-child-old", true);
  const young = make("alz-preview-young", false);
  const other = make("unrelated-old", true);
  writeFileSync(join(parent, "alz-preview-file"), "x");
  utimesSync(join(parent, "alz-preview-file"), old, old);
  const target = fresh("link-target");
  symlinkSync(target, join(parent, "alz-snapshot-link"));

  assert.deepEqual(sweepStale(parent), ["alz-child-old", "alz-preview-old", "alz-snapshot-old"]);
  assert.deepEqual(readdirSync(parent).sort(), ["alz-preview-file", "alz-preview-young", "alz-snapshot-link", "unrelated-old"]);
  assert.equal(existsSync(young) && existsSync(other) && existsSync(target), true);
  assert.deepEqual(sweepStale(join(parent, "missing")), []);
});

// --- A signal ------------------------------------------------------------------------------

test("a SIGTERM sent while an engine step runs ends in cleanup and exit 143, not in an abrupt death", async () => {
  const dir = join(fresh("signal"), "alz-preview-run");
  const script = join(fresh("script"), "run.ts");
  const cli = resolve("src/cli/teardown-driver.ts");
  const cleanup = resolve("src/teardown/driver/cleanup.ts");
  writeFileSync(script, `
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { installSignalCleanup } from ${JSON.stringify(cli)};
import { registerCleanup, removeTree } from ${JSON.stringify(cleanup)};
const dir = process.argv[2];
mkdirSync(dir);
writeFileSync(dir + "/alz-preview.tfplan", "plaintext plan");
registerCleanup(() => removeTree(dir));
installSignalCleanup();
process.stdout.write("ready\\n");
// A blocking engine step, like the runner's spawnSync.
spawnSync(process.execPath, ["-e", "setTimeout(() => {}, 1500)"]);
setTimeout(() => {}, 10000);
`);
  const child = spawn(process.execPath, ["--import", "tsx", script, dir], { cwd: resolve("."), stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", (chunk) => { output += String(chunk); });
  await new Promise<void>((done, fail) => {
    const timer = setTimeout(() => fail(new Error("the script never became ready")), 20000);
    child.stdout.on("data", () => { if (output.includes("ready")) { clearTimeout(timer); done(); } });
  });
  assert.equal(existsSync(join(dir, "alz-preview.tfplan")), true, "the plan file exists while the step runs");
  child.kill("SIGTERM");
  const [code, signal] = await new Promise<[number | null, string | null]>((done) => child.on("close", (c, s) => done([c, s])));
  assert.equal(signal, null, "not killed by the signal");
  assert.equal(code, 143);
  assert.equal(existsSync(dir), false, "the plan file and its directory are gone");
});
