import assert from "node:assert/strict";
import fs, { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runEvidenceCommand } from "../src/cli/evidence.js";
import { EvidencePathError } from "../src/evidence-runner/config.js";
import { appendNoFollow, replaceNoFollow, sweepStaleTemporaries } from "../src/evidence-runner/safe-write.js";
import { CANDIDATE, fixtureDeps, fixtureRoot, validConfig, writeConfig } from "./helpers/evidence-fixtures.js";

// SYNTHETIC: the runner never writes evidence through a symbolic link (review note N6 on #291), and a release gate
// list that drifts from the registry refuses the run (N7). Temporary folders only; nothing reaches a cloud.

const C12 = CANDIDATE.slice(0, 12);
const outsideFolder = () => realpathSync(mkdtempSync(join(tmpdir(), "alz-evidence-outside-")));
const refused = (error: unknown) => error instanceof EvidencePathError;

/** A repository with a synthetic run folder already in place, and a configuration naming no provider (preflight passes). */
function runRoot(): { root: string; dir: string } {
  const root = fixtureRoot();
  writeConfig(root, validConfig({ aws: undefined, azure: undefined }));
  const dir = join(root, ".runs/evidence/synthetic", C12);
  mkdirSync(dir, { recursive: true });
  return { root, dir };
}

test("a link at preflight.json is refused and the file it points to is untouched", async () => {
  const { root, dir } = runRoot();
  const target = join(outsideFolder(), "victim.json");
  writeFileSync(target, "original");
  symlinkSync(target, join(dir, "preflight.json"));
  const deps = fixtureDeps(root);
  assert.equal(await runEvidenceCommand(["run", "--synthetic"], deps), 2);
  assert.match(deps.lines.join("\n"), /EVIDENCE_PATH_REFUSED: preflight\.json is a symbolic link/);
  assert.equal(readFileSync(target, "utf8"), "original");
});

test("a link at journal.jsonl is refused, never read or appended through", async () => {
  const { root, dir } = runRoot();
  const target = join(outsideFolder(), "victim.jsonl");
  writeFileSync(target, "");
  symlinkSync(target, join(dir, "journal.jsonl"));
  const deps = fixtureDeps(root);
  assert.equal(await runEvidenceCommand(["run", "--synthetic"], deps), 2);
  assert.match(deps.lines.join("\n"), /EVIDENCE_JOURNAL_UNREADABLE: The journal is a symbolic link/);
  assert.equal(readFileSync(target, "utf8"), "");
  assert.throws(() => appendNoFollow(join(dir, "journal.jsonl"), "x\n"), refused, "the writer itself refuses the link (O_NOFOLLOW)");
  assert.equal(readFileSync(target, "utf8"), "");
});

test("a run folder swapped for a link after the post-lock check is refused by the journal writer's own check, before its first line", async () => {
  // Review N6 on #292: this swap happens inside now(), which runs after the post-lock check, so it exercises the check in
  // appendNoFollow, not the post-lock one (the next test swaps inside the lock acquisition for that).
  const { root, dir } = runRoot();
  const outside = outsideFolder();
  let swapped = false;
  // now() is first called for the journal's first line, after the lock: swap the folder there.
  const deps = fixtureDeps(root, {
    now: () => {
      if (!swapped) { swapped = true; renameSync(dir, dir + ".moved"); symlinkSync(outside, dir); }
      return new Date("2026-10-27T00:00:00.000Z");
    },
  });
  assert.equal(await runEvidenceCommand(["run", "--synthetic"], deps), 2);
  assert.ok(swapped);
  assert.match(deps.lines.join("\n"), /EVIDENCE_PATH_REFUSED: .*not a real folder/);
  assert.deepEqual(readdirSync(outside), [], "nothing was written into the folder the link points to");
});

test("a run folder swapped for a link inside the lock acquisition is refused by the post-lock check, and nothing stays in the link's target", async () => {
  const { root, dir } = runRoot();
  const outside = outsideFolder();
  // A stale lock makes the acquisition ask whether its pid is alive: swap the folder there, in the middle of taking the lock.
  writeFileSync(join(dir, "run.lock"), JSON.stringify({ pid: 4242 }) + "\n");
  let swapped = false;
  const deps = fixtureDeps(root, {
    pidAlive: (pid) => {
      if (pid === 4242 && !swapped) { swapped = true; renameSync(dir, dir + ".moved"); symlinkSync(outside, dir); }
      return false;
    },
  });
  assert.equal(await runEvidenceCommand(["run", "--synthetic"], deps), 2);
  assert.ok(swapped);
  assert.match(deps.lines.join("\n"), /EVIDENCE_PATH_REFUSED: .*not a real folder/);
  assert.ok(!deps.lines.join("\n").includes("Stages ("), "no stage started");
  assert.deepEqual(readdirSync(outside), [], "the lock taken through the link was released and nothing else was written there");
  assert.equal(existsSync(join(dir + ".moved", "journal.jsonl")), false, "no journal line was written anywhere");
});

test("a short write is completed, and a write that makes no progress is refused: no truncated file is renamed into place (review N1)", () => {
  const dir = outsideFolder();
  const real = fs.writeSync;
  const patch = (replacement: typeof fs.writeSync) => { fs.writeSync = replacement; syncBuiltinESMExports(); };
  try {
    // At most five bytes per call, as a short write would give.
    patch(((fd: number, buffer: Buffer, offset: number, length: number) => real(fd, buffer, offset, Math.min(5, length))) as unknown as typeof fs.writeSync);
    replaceNoFollow(join(dir, "doc.json"), "{\"hello\":\"world\"}\n");
    appendNoFollow(join(dir, "journal.jsonl"), "one whole line\n");
    patch((() => 0) as unknown as typeof fs.writeSync);
    assert.throws(() => replaceNoFollow(join(dir, "stuck.json"), "{}\n"), (error: unknown) => refused(error) && /written only in part/.test((error as Error).message));
    assert.throws(() => appendNoFollow(join(dir, "journal.jsonl"), "x\n"), refused);
  } finally {
    patch(real);
  }
  assert.equal(readFileSync(join(dir, "doc.json"), "utf8"), "{\"hello\":\"world\"}\n");
  assert.equal(readFileSync(join(dir, "journal.jsonl"), "utf8"), "one whole line\n");
  assert.deepEqual(readdirSync(dir).sort(), ["doc.json", "journal.jsonl"], "no stuck.json and no temporary file");
});

test("a folder moved between the temporary file's check and the rename is EVIDENCE_PATH_REFUSED, not a raw ENOENT (review N3)", () => {
  const dir = outsideFolder();
  const real = fs.renameSync;
  fs.renameSync = (() => { throw Object.assign(new Error("ENOENT: no such file or directory, rename"), { code: "ENOENT" }); }) as typeof fs.renameSync;
  syncBuiltinESMExports();
  try {
    assert.throws(() => replaceNoFollow(join(dir, "doc.json"), "{}\n"), (error: unknown) => refused(error) && /its folder was moved or replaced/.test((error as Error).message));
  } finally {
    fs.renameSync = real;
    syncBuiltinESMExports();
  }
  assert.deepEqual(readdirSync(dir), [], "the temporary file is removed");
});

test("a temporary file left by a killed run is swept by the next write; a live run's, a directory or another name is left alone (review N4)", () => {
  const dir = outsideFolder();
  writeFileSync(join(dir, ".doc.json.tmp-999999"), "stale");
  writeFileSync(join(dir, ".doc.json.tmp-" + process.ppid), "a live process's");
  mkdirSync(join(dir, ".doc.json.tmp-999998"));
  writeFileSync(join(dir, ".other.json.tmp-999997"), "another document's");
  const alive = (pid: number) => pid === process.ppid;
  sweepStaleTemporaries(dir, "doc.json", alive);
  assert.deepEqual(readdirSync(dir).sort(), [".doc.json.tmp-" + process.ppid, ".doc.json.tmp-999998", ".other.json.tmp-999997"].sort());
  writeFileSync(join(dir, ".doc.json.tmp-999999"), "stale again");
  replaceNoFollow(join(dir, "doc.json"), "{}\n");
  assert.ok(!readdirSync(dir).includes(".doc.json.tmp-999999"), "replaceNoFollow sweeps before it writes");
});

test("a refused dry-run plan write exits 2 with its code, never 1 (review N2)", async () => {
  const { root } = runRoot();
  const planDir = join(root, ".runs/evidence/dry-run", C12);
  mkdirSync(planDir, { recursive: true });
  const target = join(outsideFolder(), "victim.json");
  writeFileSync(target, "original");
  symlinkSync(target, join(planDir, "dry-run.json"));
  const deps = fixtureDeps(root);
  assert.equal(await runEvidenceCommand(["run", "--dry-run", "--stage", "preflight"], deps), 2);
  assert.match(deps.lines.join("\n"), /EVIDENCE_PATH_REFUSED: dry-run\.json is a symbolic link/);
  assert.equal(readFileSync(target, "utf8"), "original");
  const linkedFolder = runRoot();
  mkdirSync(join(linkedFolder.root, ".runs/evidence"), { recursive: true });
  symlinkSync(outsideFolder(), join(linkedFolder.root, ".runs/evidence/dry-run"));
  const folderDeps = fixtureDeps(linkedFolder.root);
  assert.equal(await runEvidenceCommand(["run", "--dry-run"], folderDeps), 2);
  assert.match(folderDeps.lines.join("\n"), /EVIDENCE_PATH_REFUSED: .*dry-run is a symbolic link/);
});

test("the writers refuse a hard-linked file and leave no temporary file behind", () => {
  const dir = outsideFolder();
  const other = join(outsideFolder(), "other.jsonl");
  writeFileSync(other, "");
  linkSync(other, join(dir, "journal.jsonl"));
  assert.throws(() => appendNoFollow(join(dir, "journal.jsonl"), "x\n"), refused);
  assert.equal(readFileSync(other, "utf8"), "");
  replaceNoFollow(join(dir, "doc.json"), "{}\n");
  replaceNoFollow(join(dir, "doc.json"), "{\"again\":true}\n");
  assert.equal(readFileSync(join(dir, "doc.json"), "utf8"), "{\"again\":true}\n");
  assert.equal(statSync(join(dir, "doc.json")).mode & 0o777, 0o600);
  assert.deepEqual(readdirSync(dir).sort(), ["doc.json", "journal.jsonl"]);
  assert.throws(() => replaceNoFollow(join(dir, "missing-folder", "doc.json"), "{}"), refused);
});

test("a status.json that drops, adds or reorders a gate refuses run and status, naming the ids", async () => {
  const cases: [string, (gates: { gate: string }[]) => { gate: string }[], RegExp][] = [
    ["missing", (gates) => gates.filter((entry) => entry.gate !== "pillar:cost"), /missing: pillar:cost/],
    ["extra", (gates) => [...gates, { ...gates[0], gate: "made-up-gate" }], /unknown: made-up-gate/],
    ["twice", (gates) => [...gates, gates[1]], /listed twice: release-archive/],
    ["order", (gates) => [gates[1], gates[0], ...gates.slice(2)], /another order/],
  ];
  for (const [name, change, message] of cases) {
    const { root } = runRoot();
    const file = join(root, "config/release/status.json");
    const status = JSON.parse(readFileSync(file, "utf8")) as { gates: { gate: string }[] };
    writeFileSync(file, JSON.stringify({ ...status, gates: change(status.gates) }));
    for (const argv of [["run", "--synthetic"], ["run", "--dry-run"], ["status"]]) {
      const deps = fixtureDeps(root);
      assert.equal(await runEvidenceCommand(argv, deps), 2, name + " " + argv.join(" "));
      assert.match(deps.lines.join("\n"), /EVIDENCE_RELEASE_GATES_MISMATCH/, name);
      assert.match(deps.lines.join("\n"), message, name);
    }
  }
  const { root } = runRoot();
  const scopeFile = join(root, "config/release/scope.json");
  const scope = JSON.parse(readFileSync(scopeFile, "utf8")) as { outOfScope: unknown[] };
  writeFileSync(scopeFile, JSON.stringify({ ...scope, outOfScope: [...scope.outOfScope, { gate: "no-such-gate", reason: "x" }] }));
  const deps = fixtureDeps(root);
  assert.equal(await runEvidenceCommand(["status"], deps), 2);
  assert.match(deps.lines.join("\n"), /excludes gates that do not exist: no-such-gate/);
});

test("a dry run of the preflight alone exits 0 when the preflight passes, as documented", async () => {
  const { root } = runRoot();
  const deps = fixtureDeps(root);
  assert.equal(await runEvidenceCommand(["run", "--dry-run", "--stage", "preflight"], deps), 0);
  assert.equal(await runEvidenceCommand(["run", "--dry-run"], fixtureDeps(root)), 2, "a dry run that plans later stages exits 2 in this build");
  assert.match(readFileSync("docs/evidence-runner.md", "utf8"), /A dry run of `--stage preflight` alone exits `0` when the preflight passes/);
});
