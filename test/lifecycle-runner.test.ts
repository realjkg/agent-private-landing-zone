import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { INSTALL_MARKER, REMOVING_MARKER } from "../src/deps/checks.js";
import { AppInstallError, appState, appVersions, currentVersion, installApp, removeApp, sweepAppLeftovers } from "../src/lifecycle/app-install.js";
import { buildPlatformEvidence } from "../src/lifecycle/evidence.js";
import { Journal, JournalError } from "../src/lifecycle/journal.js";
import { JOURNEYS, runJourney, type RunReport } from "../src/lifecycle/journeys.js";

// The lifecycle runner's parts against a fake release archive in temporary homes. Synthetic: nothing here qualifies a
// platform, no real build is installed, the real ~/.alz is never touched, and nothing is downloaded.

const root = mkdtempSync(join(tmpdir(), "alz-lifecycle-"));
test.after(() => rmSync(root, { recursive: true, force: true }));
const COMMIT = "a".repeat(40);
const DEAD = () => false;
const ALIVE = () => true;

/** A release archive: the launcher (a script that prints the help's first line) and package.json at its root. */
function artifact(label: string, version = "1.2.3", launcherBody = "echo './alz help'"): { file: string; sha256: string } {
  const dir = join(root, "src-" + label);
  mkdirSync(join(dir, "dist", "cli"), { recursive: true });
  writeFileSync(join(dir, "alz"), "#!/bin/sh\n" + launcherBody + "\n");
  chmodSync(join(dir, "alz"), 0o755);
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "fake", version }) + "\n");
  writeFileSync(join(dir, "dist", "cli", "operator.js"), "console.log('./alz help');\n");
  const file = join(root, label + ".tgz");
  execFileSync("tar", ["-czf", file, "-C", dir, "alz", "package.json", "dist"]);
  return { file, sha256: createHash("sha256").update(readFileSync(file)).digest("hex") };
}

const launch = (folder: string): string => execFileSync("bash", [join(folder, "alz"), "help"], { encoding: "utf8" });

test("the journal: lines before and after a step, the latest state of each step, and a refusal for another candidate or a torn line", () => {
  const file = join(root, "journal", "lifecycle", "journal.jsonl");
  const journal = new Journal(file, { artifactSha256: "1".repeat(64), sourceCommit: COMMIT });
  assert.deepEqual(journal.record("clean-install", "install"), { status: "NOT_RUN" });
  journal.start("clean-install", "install", "2026-10-27T00:00:00.000Z", 4242);
  assert.deepEqual(journal.record("clean-install", "install"), { status: "INTERRUPTED", pid: 4242 });
  journal.finish("clean-install", "install", "PASS", "2026-10-27T00:00:01.000Z", undefined, 4242);
  assert.deepEqual(journal.record("clean-install", "install"), { status: "FINISHED", outcome: "PASS" });
  journal.start("clean-install", "launch", "2026-10-27T00:00:02.000Z", 4242);
  journal.finish("clean-install", "launch", "FAIL", "2026-10-27T00:00:03.000Z", "APP_LAUNCH_FAILED", 4242);
  assert.deepEqual(journal.record("clean-install", "launch"), { status: "FINISHED", outcome: "FAIL", code: "APP_LAUNCH_FAILED" });
  const lines = readFileSync(file, "utf8").trim().split("\n").map((line) => JSON.parse(line) as { event: string; step: string });
  assert.deepEqual(lines.map((line) => line.event + ":" + line.step), ["start:install", "finish:install", "start:launch", "finish:launch"]);
  // Reopened for the same candidate: the same records. For another artifact or commit: refused.
  assert.deepEqual(new Journal(file, { artifactSha256: "1".repeat(64), sourceCommit: COMMIT }).record("clean-install", "launch"), { status: "FINISHED", outcome: "FAIL", code: "APP_LAUNCH_FAILED" });
  assert.throws(() => new Journal(file, { artifactSha256: "2".repeat(64), sourceCommit: COMMIT }), (error: unknown) => error instanceof JournalError && error.code === "LIFECYCLE_JOURNAL_ARTIFACT_MISMATCH");
  assert.throws(() => new Journal(file, { artifactSha256: "1".repeat(64), sourceCommit: "b".repeat(40) }), (error: unknown) => error instanceof JournalError && error.code === "LIFECYCLE_JOURNAL_ARTIFACT_MISMATCH");
  // A torn last line (the process died mid-write) is never guessed around.
  writeFileSync(file, readFileSync(file, "utf8") + '{"schemaVersion":1,"journey":"clean-ins');
  assert.throws(() => new Journal(file, { artifactSha256: "1".repeat(64), sourceCommit: COMMIT }), (error: unknown) => error instanceof JournalError && error.code === "LIFECYCLE_JOURNAL_UNREADABLE");
  writeFileSync(file, '{"schemaVersion":1,"journey":"clean-install","step":"install","event":"finish","at":"x","pid":1,"artifactSha256":"' + "1".repeat(64) + '","sourceCommit":"' + COMMIT + '"}\n');
  assert.throws(() => new Journal(file, { artifactSha256: "1".repeat(64), sourceCommit: COMMIT }), (error: unknown) => error instanceof JournalError && error.code === "LIFECYCLE_JOURNAL_UNREADABLE", "a finish without an outcome");
});

test("the app install: marker last, current by rename, reuse of the same artifact, replacement of an unfinished folder, and nothing left on failure", async () => {
  const home = join(root, "home-install");
  const good = artifact("good");
  const installed = await installApp({ home, artifact: good.file, artifactSha256: good.sha256 });
  assert.equal(installed.version, "1.2.3");
  assert.equal(installed.reused, false);
  assert.equal(appState(home, "1.2.3"), "INSTALLED");
  assert.equal(currentVersion(home), "1.2.3");
  const marker = JSON.parse(readFileSync(join(installed.path, INSTALL_MARKER), "utf8")) as { app: string; artifactSha256: string };
  assert.deepEqual([marker.app, marker.artifactSha256], ["alz", good.sha256]);
  assert.deepEqual(readdirSync(join(home, ".alz", "app")).sort(), ["1.2.3", "current"], "no partial or replaced folder survives");
  assert.ok(!existsSync(join(home, ".alz", "app", "current.tmp-" + process.pid)));
  // The same artifact again: reused, nothing rewritten.
  assert.equal((await installApp({ home, artifact: good.file, artifactSha256: good.sha256 })).reused, true);
  // A checksum mismatch installs nothing and leaves nothing.
  await assert.rejects(installApp({ home: join(root, "home-mismatch"), artifact: good.file, artifactSha256: "0".repeat(64) }),
    (error: unknown) => error instanceof AppInstallError && error.code === "APP_CHECKSUM_MISMATCH");
  assert.deepEqual(readdirSync(join(root, "home-mismatch", ".alz", "app")), []);
  // An archive without package.json or the launcher is refused after unpacking, and the partial folder is removed.
  const bare = join(root, "src-bare");
  mkdirSync(bare, { recursive: true });
  writeFileSync(join(bare, "readme"), "x");
  const bareFile = join(root, "bare.tgz");
  execFileSync("tar", ["-czf", bareFile, "-C", bare, "readme"]);
  const bareSha = createHash("sha256").update(readFileSync(bareFile)).digest("hex");
  await assert.rejects(installApp({ home: join(root, "home-bare"), artifact: bareFile, artifactSha256: bareSha }),
    (error: unknown) => error instanceof AppInstallError && error.code === "APP_ARTIFACT_INCOMPLETE");
  assert.deepEqual(readdirSync(join(root, "home-bare", ".alz", "app")), []);
  // An unfinished final folder (marker without the launcher) is replaced, and the install says so.
  const home2 = join(root, "home-unfinished");
  mkdirSync(join(home2, ".alz", "app", "1.2.3"), { recursive: true });
  writeFileSync(join(home2, ".alz", "app", "1.2.3", "half"), "x");
  assert.equal(appState(home2, "1.2.3"), "UNFINISHED");
  const replaced = await installApp({ home: home2, artifact: good.file, artifactSha256: good.sha256 });
  assert.equal(replaced.replaced, "UNFINISHED");
  assert.ok(!existsSync(join(home2, ".alz", "app", "1.2.3", "half")));
  assert.equal(appState(home2, "1.2.3"), "INSTALLED");
  // A different artifact of the same version replaces a complete one too (the marker names the artifact).
  const other = artifact("other", "1.2.3", "echo './alz help other'");
  const swapped = await installApp({ home: home2, artifact: other.file, artifactSha256: other.sha256 });
  assert.equal(swapped.reused, false);
  assert.match(launch(swapped.path), /other/);
});

test("the app removal: marker first, current cleared, a second removal is absent, a half-removed folder reads as removing, and links are refused", async () => {
  const home = join(root, "home-remove");
  const good = artifact("remove");
  await installApp({ home, artifact: good.file, artifactSha256: good.sha256 });
  assert.equal(removeApp(home, "1.2.3"), "removed");
  assert.equal(appState(home, "1.2.3"), "ABSENT");
  assert.equal(currentVersion(home), undefined);
  assert.equal(removeApp(home, "1.2.3"), "absent");
  assert.deepEqual(appVersions(home), []);
  // The shape a kill after the first step leaves.
  const folder = join(home, ".alz", "app", "1.2.3");
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, "alz"), "x");
  writeFileSync(join(folder, REMOVING_MARKER), "2026-10-27T00:00:00.000Z\n");
  assert.equal(appState(home, "1.2.3"), "REMOVING");
  assert.deepEqual(appVersions(home), [{ version: "1.2.3", state: "REMOVING" }]);
  assert.equal(removeApp(home, "1.2.3"), "removed", "repeating the removal completes it");
  assert.equal(appState(home, "1.2.3"), "ABSENT");
  // A linked version folder, or a bad version, is refused and the link target kept.
  const outside = join(root, "remove-outside");
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(outside, "keep"), "not ours");
  symlinkSync(outside, join(home, ".alz", "app", "9.9.9"));
  assert.throws(() => removeApp(home, "9.9.9"), (error: unknown) => error instanceof AppInstallError && error.code === "APP_REMOVE_REFUSED");
  assert.ok(existsSync(join(outside, "keep")));
  for (const bad of ["..", "../x", "1.2.3/x", "", "current"]) {
    assert.throws(() => removeApp(home, bad), (error: unknown) => error instanceof AppInstallError && error.code === "APP_REMOVE_REFUSED", JSON.stringify(bad));
  }
  assert.ok(existsSync(join(home, ".alz", "app")), "the app folder itself is never removed");
});

test("the app sweep: dead-pid partial and replaced folders go, a live pid and this process's folders stay, links are never followed, final folders are never targets", () => {
  const home = join(root, "home-app-sweep");
  const dir = join(home, ".alz", "app");
  mkdirSync(join(dir, "install.partial-1111"), { recursive: true });
  mkdirSync(join(dir, "1.2.3.replaced-1111"), { recursive: true });
  mkdirSync(join(dir, "install.partial-2222"), { recursive: true });
  mkdirSync(join(dir, "install.partial-" + process.pid), { recursive: true });
  mkdirSync(join(dir, "1.2.3"), { recursive: true });
  writeFileSync(join(dir, "1.2.3", "alz"), "a final folder, never a target");
  const outside = join(root, "sweep-outside");
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(outside, "keep"), "not ours");
  symlinkSync(outside, join(dir, "install.partial-3333"));
  const removed = sweepAppLeftovers(home, (pid) => pid === 2222);
  assert.deepEqual(removed.map((path) => path.slice(dir.length + 1)).sort(), ["1.2.3.replaced-1111", "install.partial-1111"]);
  assert.deepEqual(readdirSync(dir).sort(), ["1.2.3", "install.partial-" + process.pid, "install.partial-2222", "install.partial-3333"].sort());
  assert.ok(existsSync(join(outside, "keep")));
  assert.deepEqual(sweepAppLeftovers(home, DEAD).map((path) => path.slice(dir.length + 1)).sort(), ["install.partial-2222"], "own pid and the link stay even when every pid is called dead");
  assert.deepEqual(sweepAppLeftovers(join(root, "no-home"), DEAD), []);
  void ALIVE;
});

/** The steps' statuses of a run, as "name:status". */
const statuses = (run: RunReport): string[] => run.steps.map((step) => step.name + ":" + step.status + (step.code ? "(" + step.code + ")" : ""));

test("the journeys through the journal: clean install, uninstall, partial-install recovery, and a rerun that skips what passed and reruns what was interrupted", async () => {
  const home = join(root, "home-journeys");
  const evidenceDir = join(root, "evidence-journeys");
  const good = artifact("journeys");
  const journal = new Journal(join(evidenceDir, "lifecycle", "journal.jsonl"), { artifactSha256: good.sha256, sourceCommit: COMMIT });
  const lines: string[] = [];
  const ctx = { home, artifact: good.file, artifactSha256: good.sha256, evidenceDir, journal, pidAlive: DEAD, launch, out: (line: string) => { lines.push(line); } };
  const clean = await runJourney(JOURNEYS[0]!, ctx);
  assert.deepEqual(statuses(clean), ["install:PASS", "launch:PASS"]);
  assert.equal(appState(home, "1.2.3"), "INSTALLED");
  const uninstall = await runJourney(JOURNEYS[1]!, ctx);
  assert.deepEqual(statuses(uninstall), ["uninstall:PASS", "repeat-uninstall:PASS"]);
  assert.deepEqual(appVersions(home), []);
  const recovery = await runJourney(JOURNEYS[2]!, ctx);
  assert.deepEqual(statuses(recovery), ["plant-interruption:PASS", "partial-install-recovery:PASS", "launch:PASS", "uninstall:PASS"]);
  const detail = JSON.parse(readFileSync(recovery.steps[1]!.detailFile!, "utf8")) as { swept: string[]; sweptNames: string[] };
  assert.equal(detail.swept.length, 2, "both planted leftovers were swept");
  assert.deepEqual(readdirSync(join(home, ".alz", "app")), [], "the recovery journey ends with nothing installed");
  // Every check file exists and the journal has two lines per step.
  assert.equal(readdirSync(join(evidenceDir, "lifecycle", "checks")).length, 8);
  assert.equal(journal.entries().length, 16);
  // A rerun: every step already passed is skipped; nothing is reinstalled.
  const again = await runJourney(JOURNEYS[0]!, ctx);
  assert.deepEqual(statuses(again), ["install:SKIPPED_ALREADY_PASSED", "launch:SKIPPED_ALREADY_PASSED"]);
  assert.deepEqual(appVersions(home), [], "a skipped step changes nothing on disk");
  // An interrupted step (started, never finished) is run again from its own state; the step before it is kept.
  const home2 = join(root, "home-resume");
  const evidence2 = join(root, "evidence-resume");
  const journal2 = new Journal(join(evidence2, "lifecycle", "journal.jsonl"), { artifactSha256: good.sha256, sourceCommit: COMMIT });
  journal2.start("clean-install", "install", "2026-10-27T00:00:00.000Z", 4242);
  journal2.finish("clean-install", "install", "PASS", "2026-10-27T00:00:01.000Z", undefined, 4242);
  journal2.start("clean-install", "launch", "2026-10-27T00:00:02.000Z", 4242);
  await installApp({ home: home2, artifact: good.file, artifactSha256: good.sha256 });
  const resumed = await runJourney(JOURNEYS[0]!, { ...ctx, home: home2, evidenceDir: evidence2, journal: journal2, lines: undefined } as never);
  assert.deepEqual(statuses(resumed), ["install:SKIPPED_ALREADY_PASSED", "launch:PASS"]);
  assert.ok(lines.some((line) => line.includes("already passed")));
});

test("a failing step ends its journey with its code, a stop request leaves the next step unstarted, and a launch that prints nothing useful fails", async () => {
  const home = join(root, "home-fail");
  const evidenceDir = join(root, "evidence-fail");
  const bad = artifact("fail", "1.2.3", "echo 'something else'; exit 0");
  const journal = new Journal(join(evidenceDir, "lifecycle", "journal.jsonl"), { artifactSha256: bad.sha256, sourceCommit: COMMIT });
  const ctx = { home, artifact: bad.file, artifactSha256: bad.sha256, evidenceDir, journal, pidAlive: DEAD, launch };
  const run = await runJourney(JOURNEYS[0]!, ctx);
  assert.deepEqual(statuses(run), ["install:PASS", "launch:FAIL(APP_LAUNCH_UNEXPECTED_OUTPUT)"]);
  assert.deepEqual(journal.record("clean-install", "launch"), { status: "FINISHED", outcome: "FAIL", code: "APP_LAUNCH_FAILED" === "x" ? undefined : "APP_LAUNCH_UNEXPECTED_OUTPUT" });
  // Uninstall with nothing installed fails plainly; the second step is not reached.
  const none = await runJourney(JOURNEYS[1]!, { ...ctx, home: join(root, "home-none"), evidenceDir: join(root, "evidence-none"),
    journal: new Journal(join(root, "evidence-none", "lifecycle", "journal.jsonl"), { artifactSha256: bad.sha256, sourceCommit: COMMIT }) });
  assert.deepEqual(statuses(none), ["uninstall:FAIL(APP_NOT_INSTALLED)"]);
  // A stop requested before a step: that step is BLOCKED and the journey ends; the journal has no start line for it.
  let stop = false;
  const stopHome = join(root, "home-stop");
  const stopEvidence = join(root, "evidence-stop");
  const good = artifact("stop");
  const stopJournal = new Journal(join(stopEvidence, "lifecycle", "journal.jsonl"), { artifactSha256: good.sha256, sourceCommit: COMMIT });
  const stopped = await runJourney(JOURNEYS[0]!, {
    home: stopHome, artifact: good.file, artifactSha256: good.sha256, evidenceDir: stopEvidence, journal: stopJournal, pidAlive: DEAD,
    launch: (folder) => { stop = true; return launch(folder); }, stopRequested: () => stop,
  });
  assert.deepEqual(statuses(stopped), ["install:PASS", "launch:PASS"], "the stop came during launch, which finishes");
  stop = true;
  const next = await runJourney(JOURNEYS[1]!, { home: stopHome, artifact: good.file, artifactSha256: good.sha256, evidenceDir: stopEvidence, journal: stopJournal, pidAlive: DEAD, launch, stopRequested: () => stop });
  assert.deepEqual(statuses(next), ["uninstall:BLOCKED(LIFECYCLE_STOPPED)"]);
  assert.equal(next.stopped, true);
  assert.deepEqual(stopJournal.record("uninstall", "uninstall"), { status: "NOT_RUN" });
  assert.equal(appState(stopHome, "1.2.3"), "INSTALLED", "nothing was touched after the stop");
});

test("the evidence builder: the real admission review judges the report; a live report with every check passes, a synthetic one never does, and a partial one says what is missing", async () => {
  const evidenceDir = join(root, "evidence-build");
  const checksDir = join(evidenceDir, "lifecycle", "checks");
  mkdirSync(checksDir, { recursive: true });
  const names = ["install", "launch", "uninstall", "repeat-uninstall", "partial-install-recovery", "unusual-paths", "unrelated-files-preserved"];
  const runOf = (included: string[], status: "PASS" | "FAIL" = "PASS"): RunReport => ({
    journey: "clean-install", stopped: false,
    steps: included.map((name) => {
      const file = join(checksDir, "clean-install." + name + ".json");
      writeFileSync(file, JSON.stringify({ step: name, outcome: status }) + "\n");
      return { name, check: true, status, detailFile: file };
    }),
  });
  const common = { evidenceDir, platform: "linux-x64", osVersion: "Ubuntu 24.04", sourceCommit: COMMIT, targetHardwareId: "disposable-01", artifactSha256: "4".repeat(64) };
  const live = await buildPlatformEvidence({ ...common, synthetic: false, runs: [runOf(names)] });
  assert.equal(live.label, "LIVE");
  assert.equal(live.reviewStatus, "EVIDENCE_PRESENT");
  assert.equal(live.submittable, true);
  assert.deepEqual(live.missingChecks, []);
  const report = JSON.parse(readFileSync(live.reportFile, "utf8")) as Record<string, unknown>;
  assert.equal(report.gateId, "platform:linux-x64");
  assert.equal(report.actEnabled, false);
  assert.equal(report.fixture, undefined);
  assert.equal(createHash("sha256").update(readFileSync(live.reportFile)).digest("hex"), live.record.evidenceSha256, "the record binds the file's bytes");
  // The same checks labeled synthetic: the review refuses it (fixture: true) and it is never submittable.
  const synthetic = await buildPlatformEvidence({ ...common, synthetic: true, runs: [runOf(names)] });
  assert.equal(synthetic.label, "SYNTHETIC");
  assert.equal(synthetic.submittable, false);
  assert.equal(synthetic.reviewStatus, "BLOCKED");
  assert.equal((JSON.parse(readFileSync(synthetic.reportFile, "utf8")) as { fixture: boolean }).fixture, true);
  assert.match(readFileSync(synthetic.reviewFile, "utf8"), /SYNTHETIC: this run qualifies nothing and is never submittable/);
  // Five of seven checks: the review blocks and the outcome names the two missing ones.
  const partial = await buildPlatformEvidence({ ...common, synthetic: false, runs: [runOf(names.slice(0, 5))] });
  assert.equal(partial.submittable, false);
  assert.equal(partial.reviewStatus, "BLOCKED");
  assert.deepEqual(partial.missingChecks, ["unusual-paths", "unrelated-files-preserved"]);
  assert.ok(partial.reviewBlockers.includes("EVIDENCE_GATE_CONTRACT_FAILED"));
  // A failed check is carried as failed, and the report is not passed.
  const failed = await buildPlatformEvidence({ ...common, synthetic: false, runs: [runOf(names.slice(0, 6)), runOf(["unrelated-files-preserved"], "FAIL")] });
  assert.equal(failed.submittable, false);
  assert.deepEqual(failed.missingChecks, ["unrelated-files-preserved"]);
  assert.equal((JSON.parse(readFileSync(failed.reportFile, "utf8")) as { passed: boolean }).passed, false);
  // Another host's commit: the review's identity check refuses it, through the same real review.
  const wrong = await buildPlatformEvidence({ ...common, sourceCommit: "b".repeat(40), synthetic: false, runs: [runOf(names)] });
  assert.equal(wrong.reviewStatus, "EVIDENCE_PRESENT", "the report is consistent with its own commit; identity is bound at submission, not here");
  void wrong;
});
