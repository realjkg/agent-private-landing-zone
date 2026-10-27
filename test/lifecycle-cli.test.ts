import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runLifecycleCommand, type LifecycleDeps } from "../src/cli/lifecycle.js";
import type { HumanTerminal } from "../src/cli/teardown-driver.js";
import { appVersions } from "../src/lifecycle/app-install.js";

// `./alz lifecycle` end to end against a fake release archive, in temporary homes and evidence folders. Synthetic: it
// qualifies no platform and touches neither the real ~/.alz nor the network.

const root = mkdtempSync(join(tmpdir(), "alz-lifecycle-cli-"));
test.after(() => rmSync(root, { recursive: true, force: true }));
const COMMIT = "c".repeat(40);

function artifact(label: string): { file: string; sha256: string } {
  const dir = join(root, "src-" + label);
  mkdirSync(dir, { recursive: true });
  // The label is part of the launcher, so two archives made in the same second never have the same bytes.
  writeFileSync(join(dir, "alz"), "#!/bin/sh\necho './alz help (" + label + ")'\n");
  chmodSync(join(dir, "alz"), 0o755);
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "fake", version: "2.0.0" }) + "\n");
  const file = join(root, label + ".tgz");
  execFileSync("tar", ["-czf", file, "-C", dir, "alz", "package.json"]);
  return { file, sha256: createHash("sha256").update(readFileSync(file)).digest("hex") };
}

function terminal(interactive: boolean): HumanTerminal & { shown: string[] } {
  const shown: string[] = [];
  return { stdinIsTTY: interactive, stdoutIsTTY: interactive, shown, write: (text) => { shown.push(text); }, ask: async () => "" };
}

function deps(label: string, lines: string[], extra: Partial<LifecycleDeps> = {}): LifecycleDeps {
  return {
    terminal: terminal(true), out: (text) => { lines.push(text); }, home: join(root, "home-" + label),
    platform: "linux", arch: "x64", osVersion: "Ubuntu 24.04", pidAlive: () => false, exit: () => undefined, ...extra,
  };
}

const args = (journey: string, file: string, evidence: string, more: string[] = []) =>
  [journey, "--artifact", file, "--evidence", evidence, "--host", "disposable-01", "--commit", COMMIT, ...more];

test("usage: a missing or unknown journey, a missing option, a short commit or an UNKNOWN host is refused before anything is touched", async () => {
  const good = artifact("usage");
  const evidence = join(root, "evidence-usage");
  for (const [label, argv] of [
    ["no journey", []],
    ["help", ["help"]],
    ["unknown journey", args("upgrade", good.file, evidence)],
    ["missing evidence", ["all", "--artifact", good.file, "--host", "h", "--commit", COMMIT]],
    ["short commit", ["all", "--artifact", good.file, "--evidence", evidence, "--host", "h", "--commit", "abc"]],
    ["unknown host", ["all", "--artifact", good.file, "--evidence", evidence, "--host", "UNKNOWN", "--commit", COMMIT]],
    ["unknown option", args("all", good.file, evidence, ["--force"])],
    ["dangling option", args("all", good.file, evidence, ["--home"])],
  ] as const) {
    const lines: string[] = [];
    assert.equal(await runLifecycleCommand([...argv], deps("usage", lines)), 1, label);
    assert.match(lines.join(""), /\.\/alz lifecycle <clean-install\|uninstall\|partial-install-recovery\|all>/, label);
    assert.ok(!existsSync(evidence), label + ": nothing written");
    assert.ok(!existsSync(join(root, "home-usage", ".alz")), label + ": nothing installed");
  }
  const lines: string[] = [];
  assert.equal(await runLifecycleCommand(args("all", join(root, "missing.tgz"), evidence), deps("usage", lines)), 1);
  assert.match(lines.join(""), /could not be read/);
});

test("without an interactive terminal a live run is refused, an unsupported computer type is refused, and --synthetic may run anywhere", async () => {
  const good = artifact("tty");
  let lines: string[] = [];
  assert.equal(await runLifecycleCommand(args("clean-install", good.file, join(root, "evidence-tty")), deps("tty", lines, { terminal: terminal(false) })), 2);
  assert.match(lines.join(""), /needs a person at an interactive Terminal window on the disposable host\. Nothing was run\./);
  assert.ok(!existsSync(join(root, "home-tty", ".alz")));
  lines = [];
  assert.equal(await runLifecycleCommand(args("clean-install", good.file, join(root, "evidence-plat")), deps("plat", lines, { platform: "freebsd" })), 2);
  assert.match(lines.join(""), /not one the release qualifies on/);
  lines = [];
  const code = await runLifecycleCommand(args("clean-install", good.file, join(root, "evidence-synth-tty"), ["--synthetic"]), deps("synth-tty", lines, { terminal: terminal(false) }));
  assert.equal(code, 0);
  assert.match(lines.join(""), /SYNTHETIC: this run qualifies nothing and its report is never submittable\./);
});

test("all, synthetic: every C1 step passes, the evidence folder holds the journal, the check files, the report and the review, and the rerun skips what passed", async () => {
  const good = artifact("all");
  const evidence = join(root, "evidence-all");
  const lines: string[] = [];
  const code = await runLifecycleCommand(args("all", good.file, evidence, ["--synthetic"]), deps("all", lines));
  const text = lines.join("");
  assert.equal(code, 0, text);
  assert.match(text, /Packaged release lifecycle \(SYNTHETIC\) on linux-x64, artifact [0-9a-f]{12}, commit c{12}/);
  for (const step of ["install: PASS", "launch: PASS", "uninstall: PASS", "repeat-uninstall: PASS", "plant-interruption: PASS", "partial-install-recovery: PASS"]) assert.ok(text.includes(step), step);
  assert.match(text, /Report: .*platform-linux-x64\.json \(SYNTHETIC\)/);
  assert.match(text, /Admission review \(src\/qualification\/release-admission\.ts\): BLOCKED/);
  assert.match(text, /Checks not yet passed for the platform gate: unusual-paths, unrelated-files-preserved/);
  assert.match(text, /Submittable: no \(SYNTHETIC\)\. Nothing was submitted or admitted\./);
  assert.ok(existsSync(join(evidence, "lifecycle", "journal.jsonl")));
  assert.equal(readdirSync(join(evidence, "lifecycle", "checks")).length, 8);
  const report = JSON.parse(readFileSync(join(evidence, "platform-linux-x64.json"), "utf8")) as { label: string; fixture: boolean; checks: { name: string; passed: boolean }[]; producer: string };
  assert.equal(report.label, "SYNTHETIC");
  assert.equal(report.fixture, true);
  assert.deepEqual(report.checks.map((check) => check.name + ":" + check.passed).sort(), ["install:true", "launch:true", "partial-install-recovery:true", "repeat-uninstall:true", "uninstall:true"]);
  assert.match(report.producer, /never submits or admits/);
  const review = JSON.parse(readFileSync(join(evidence, "platform-linux-x64.review.json"), "utf8")) as { submittable: boolean; reviewStatus: string; reviewedBy: string };
  assert.equal(review.submittable, false);
  assert.equal(review.reviewStatus, "BLOCKED");
  assert.match(review.reviewedBy, /release-admission\.ts reviewProductionRelease/);
  assert.deepEqual(appVersions(join(root, "home-all")), [], "the journeys end with nothing installed in the home");
  // The rerun continues the journal: everything is already passed, nothing is reinstalled.
  const again: string[] = [];
  assert.equal(await runLifecycleCommand(args("all", good.file, evidence, ["--synthetic"]), deps("all", again)), 0);
  assert.match(again.join(""), /Continuing the journal at .*journal\.jsonl \(16 lines\)/);
  assert.equal((again.join("").match(/already passed in an earlier run, kept/g) ?? []).length, 8);
  // The same evidence folder with another artifact: refused, with the plain reason.
  const other = artifact("all-other");
  const refused: string[] = [];
  assert.equal(await runLifecycleCommand(args("all", other.file, evidence, ["--synthetic"]), deps("all", refused)), 2);
  assert.match(refused.join(""), /The journal belongs to another candidate/);
});

test("a live run on a disposable host: the report is LIVE, the C1 checks leave it not yet submittable, and the real launcher is run from the installed copy", async () => {
  const good = artifact("live");
  const evidence = join(root, "evidence-live");
  const lines: string[] = [];
  const code = await runLifecycleCommand(args("clean-install", good.file, evidence), deps("live", lines));
  assert.equal(code, 0, lines.join(""));
  const report = JSON.parse(readFileSync(join(evidence, "platform-linux-x64.json"), "utf8")) as { label: string; fixture?: boolean; checks: { name: string }[] };
  assert.equal(report.label, "LIVE");
  assert.equal(report.fixture, undefined);
  assert.deepEqual(report.checks.map((check) => check.name), ["install", "launch"]);
  assert.match(lines.join(""), /Submittable: no\. Nothing was submitted or admitted\./);
  assert.deepEqual(appVersions(join(root, "home-live")), [{ version: "2.0.0", state: "INSTALLED" }], "clean-install leaves the app installed");
});

test("a stop signal ends the run after the current step; the journal keeps it, the rerun continues, and a second signal leaves at once", async () => {
  const good = artifact("stop");
  const evidence = join(root, "evidence-stop");
  const exits: number[] = [];
  const lines: string[] = [];
  const code = await runLifecycleCommand(args("all", good.file, evidence, ["--synthetic"]), deps("stop", lines, {
    launch: (folder) => { process.kill(process.pid, "SIGINT"); return execFileSync("bash", [join(folder, "alz"), "help"], { encoding: "utf8" }); },
    exit: (exitCode) => { exits.push(exitCode); },
  }));
  // The signal is delivered after the launch step returns, so the journey's next step (none in clean-install) and the next journey are not started.
  assert.equal(code, 2);
  const text = lines.join("");
  assert.match(text, /Stopping after the current step\. The journal keeps what finished; running the same command again continues from there\./);
  assert.match(text, /Stopped\. Run the same command again to continue\./);
  assert.ok(text.includes("install: PASS") && text.includes("launch: PASS"));
  assert.ok(!text.includes("uninstall: PASS"), "the uninstall journey was not started");
  assert.deepEqual(exits, []);
  assert.equal(process.listenerCount("SIGINT"), 0, "the handler is released");
  const journal = readFileSync(join(evidence, "lifecycle", "journal.jsonl"), "utf8").trim().split("\n");
  assert.equal(journal.length, 4, "two lines per finished step, none for unstarted ones");
  // The rerun continues: the two finished steps are kept, the remaining journeys run.
  const again: string[] = [];
  assert.equal(await runLifecycleCommand(args("all", good.file, evidence, ["--synthetic"]), deps("stop", again)), 0);
  assert.equal((again.join("").match(/already passed in an earlier run, kept/g) ?? []).length, 2);
  assert.ok(again.join("").includes("repeat-uninstall: PASS"));
  // A second signal while a run is in progress ends the process through the injected exit.
  const twice: string[] = [];
  const outcome = await runLifecycleCommand(args("clean-install", good.file, join(root, "evidence-twice"), ["--synthetic"]), deps("twice", twice, {
    launch: (folder) => { process.kill(process.pid, "SIGINT"); process.kill(process.pid, "SIGINT"); return execFileSync("bash", [join(folder, "alz"), "help"], { encoding: "utf8" }); },
    exit: (exitCode) => { exits.push(exitCode); },
  }));
  assert.equal(outcome, 2);
  assert.deepEqual(exits.length > 0 ? [exits[0]] : exits, exits.length > 0 ? [2] : [], "coalesced signals count once; a second delivery exits with the blocked code");
});
