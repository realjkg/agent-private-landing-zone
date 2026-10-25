import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";

import { appInstalledVersions, installedPath, runDependencyChecks } from "../src/deps/checks.js";
import { loadToolPins } from "../src/deps/pins.js";
import { installSelectedPinnedTools, removableTools, runDepsCommand, type DepsDeps } from "../src/cli/deps.js";
import type { HumanTerminal } from "../src/cli/teardown-driver.js";

// The update path: the pin names Terraform 1.16.4 and the app installed 1.15.0 before. Fake archives, a fake home and a
// private PATH; the download is injected, so no network is touched. Synthetic: this does not qualify any real OS.

const root = mkdtempSync(join(tmpdir(), "alz-deps-update-"));
test.after(() => rmSync(root, { recursive: true, force: true }));
const PINNED = "1.16.4";
const OLD = "1.15.0";

function script(path: string, body: string): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, "#!/bin/sh\n" + body + "\n");
  chmodSync(path, 0o755);
}

/** A home where this app installed Terraform 1.15.0 before. */
function homeWithOld(label: string): { home: string; old: string; oldBytes: string } {
  const home = join(root, "home-" + label);
  const old = installedPath(home, "terraform", OLD, "terraform");
  script(old, "echo 'Terraform v" + OLD + "'");
  return { home, old, oldBytes: readFileSync(old, "utf8") };
}

function archive(label: string, reports: string): { sha256: string; body: Buffer } {
  const dir = join(root, "arch-" + label);
  script(join(dir, "terraform"), "echo 'Terraform v" + reports + "'");
  const file = join(root, "arch-" + label + ".tgz");
  execFileSync("tar", ["-czf", file, "-C", dir, "terraform"]);
  const body = readFileSync(file);
  return { sha256: createHash("sha256").update(body).digest("hex"), body };
}

function pinsFile(label: string, sha256: string): string {
  const path = join(root, "pins-" + label + ".json");
  const copy = JSON.parse(readFileSync("config/tool-pins.json", "utf8"));
  assert.equal(copy.tools.terraform.version, PINNED, "the fixture assumes the shipped Terraform pin");
  Object.assign(copy.tools.terraform.artifacts["darwin-arm64"], {
    sha256, archive: "tgz", url: "https://releases.hashicorp.com/terraform/" + PINNED + "/fake.tgz",
  });
  writeFileSync(path, JSON.stringify(copy));
  return path;
}

function terminal(answers: string[]): HumanTerminal & { shown: string[] } {
  const shown: string[] = [];
  return {
    stdinIsTTY: true, stdoutIsTTY: true, shown,
    write: (text: string) => { shown.push(text); },
    ask: async () => answers.shift() ?? "",
  };
}

/** Deps for a run: correct Ollama and git on PATH, and a PATH terraform that reports nothing, so only the app's copy counts. */
function deps(label: string, home: string, term: HumanTerminal, pinsPath: string, download: DepsDeps["download"], lines: string[]): DepsDeps {
  const bin = join(root, "bin-" + label);
  script(join(bin, "ollama"), "echo 'ollama version is 0.40.0'");
  script(join(bin, "git"), "echo 'git version 2.55.0'");
  script(join(bin, "terraform"), "");
  return {
    terminal: term, home, env: { PATH: bin }, platform: "darwin", arch: "arm64", nodeVersion: "26.9.0", pinsPath,
    probe: async () => ({ listening: false, apiOk: false }), out: (text) => { lines.push(text); }, ...(download ? { download } : {}),
  };
}

function logText(home: string): string {
  const dir = join(home, ".alz", "logs");
  return readdirSync(dir).map((name) => readFileSync(join(dir, name), "utf8")).join("");
}

test("the check names the earlier app-installed version and says Update; the menu offers the update", async () => {
  const { home } = homeWithOld("check");
  const pins = loadToolPins();
  const checks = await runDependencyChecks({
    pins, home, env: { PATH: "" }, platform: "darwin", arch: "arm64", nodeVersion: "26.9.0",
    probe: async () => ({ listening: false, apiOk: false }),
  }, new Set(["terraform"]));
  const terraform = checks.find((check) => check.id === "terraform")!;
  assert.equal(terraform.ok, false, "the earlier version never satisfies the pin");
  assert.match(terraform.detail, new RegExp("this app installed " + OLD.replaceAll(".", "\\.") + " before"));
  assert.match(terraform.fix!, /choose Update to replace the app's Terraform 1\.15\.0 with the tested 1\.16\.4/);
});

test("update, keep: the new version is installed and checked first, and the earlier one stays when the person keeps it", async () => {
  const { home, old, oldBytes } = homeWithOld("keep");
  const fake = archive("keep", PINNED);
  const term = terminal(["1", "", "1", "2"]);
  const lines: string[] = [];
  const code = await runDepsCommand([], deps("keep", home, term, pinsFile("keep", fake.sha256), async () => Readable.from([fake.body]), lines));
  assert.equal(code, 0);
  const shown = term.shown.join("");
  assert.match(shown, /1\s+Update to the tested versions/);
  assert.match(shown, /Previous: 1\.15\.0 stays exactly as it is until 1\.16\.4 is installed and checked/);
  assert.match(shown, /Update it now\?\n\s+1\s+Update it\n\s+2\s+Skip it/);
  assert.match(shown, /Remove Terraform 1\.15\.0\?\n\s+1\s+Remove it\n\s+2\s+Keep it/);
  assert.ok(existsSync(installedPath(home, "terraform", PINNED, "terraform")));
  assert.equal(readFileSync(old, "utf8"), oldBytes, "the kept version is untouched");
  assert.deepEqual(appInstalledVersions(home, "terraform", "terraform"), [PINNED, OLD]);
  assert.deepEqual(removableTools(loadToolPins(), home, "darwin-arm64").map((item) => item.version), [PINNED, OLD], "both copies can be removed later");
  const log = logText(home);
  assert.match(log, /update terraform 1\.15\.0 to 1\.16\.4/);
  assert.match(log, /install terraform 1\.16\.4 installed verified/);
  assert.match(log, /keep-previous terraform 1\.15\.0/);
  assert.doesNotMatch(log, /https?:\/\/|\/home|\.alz\/tools|alz-deps-update-/, "no URLs or paths in the log");
});

test("update, remove: after the check passes, choosing Remove deletes only the earlier version", async () => {
  const { home, old } = homeWithOld("remove");
  const fake = archive("remove", PINNED);
  const term = terminal(["1", "", "1", "1"]);
  const lines: string[] = [];
  const code = await runDepsCommand([], deps("remove", home, term, pinsFile("remove", fake.sha256), async () => Readable.from([fake.body]), lines));
  assert.equal(code, 0);
  assert.equal(existsSync(old), false);
  assert.ok(existsSync(installedPath(home, "terraform", PINNED, "terraform")));
  assert.match(term.shown.join(""), /Removed Terraform 1\.15\.0\./);
  assert.match(logText(home), /remove terraform 1\.15\.0 removed/);
});

test("a failed update (checksum, download or version check) leaves the earlier version untouched and says so plainly", async () => {
  const good = archive("fail-good", PINNED);
  const cases: Array<{ label: string; sha256: string; download: DepsDeps["download"]; says: RegExp }> = [
    { label: "checksum", sha256: "0".repeat(64), download: async () => Readable.from([good.body]), says: /did not match the checksum/ },
    { label: "download", sha256: good.sha256, download: async () => { throw new Error("offline"); }, says: /download did not finish/ },
    (() => {
      const wrong = archive("fail-version", "0.0.1");
      return { label: "version", sha256: wrong.sha256, download: async () => Readable.from([wrong.body]), says: /still failed verification after installation, so it is not used\. The new copy was removed again\./ };
    })(),
  ];
  for (const item of cases) {
    const { home, old, oldBytes } = homeWithOld("fail-" + item.label);
    const term = terminal(["1", "", "1"]);
    const lines: string[] = [];
    const code = await runDepsCommand([], deps("fail-" + item.label, home, term, pinsFile("fail-" + item.label, item.sha256), item.download, lines));
    const text = lines.join("");
    assert.equal(code, 2, item.label);
    assert.match(text, item.says, item.label);
    assert.match(text, /Terraform 1\.15\.0, installed before, is unchanged\. This version of the app uses only the tested 1\.16\.4/, item.label);
    assert.equal(readFileSync(old, "utf8"), oldBytes, item.label + ": earlier version byte-identical");
    assert.match(execFileSync(old, { encoding: "utf8" }), /Terraform v1\.15\.0/, item.label + ": earlier version still runs");
    assert.equal(existsSync(join(home, ".alz", "tools", "terraform", PINNED)), false, item.label + ": no half-installed new version");
    assert.doesNotMatch(term.shown.join(""), /Remove Terraform 1\.15\.0\?/, item.label + ": removal is never offered after a failure");
  }
});

test("an interrupted earlier update (stale .partial folder and download) never counts as a version, and the rerun recovers", async () => {
  const { home, old } = homeWithOld("interrupted");
  const stalePartial = join(home, ".alz", "tools", "terraform", PINNED + ".partial-99999");
  script(join(stalePartial, "terraform"), "echo 'Terraform v" + PINNED + "'");
  mkdirSync(join(home, ".alz", "tmp"), { recursive: true });
  writeFileSync(join(home, ".alz", "tmp", "terraform-" + PINNED + "-99999.tgz"), "half a download");
  assert.deepEqual(appInstalledVersions(home, "terraform", "terraform"), [OLD], "an unfinished folder is not an install");
  const fake = archive("interrupted", PINNED);
  const term = terminal(["1", "", "1", "2"]);
  const code = await runDepsCommand([], deps("interrupted", home, term, pinsFile("interrupted", fake.sha256), async () => Readable.from([fake.body]), []));
  assert.equal(code, 0);
  assert.match(execFileSync(installedPath(home, "terraform", PINNED, "terraform"), { encoding: "utf8" }), /Terraform v1\.16\.4/);
  assert.ok(existsSync(old));
  assert.deepEqual(removableTools(loadToolPins(), home, "darwin-arm64").map((item) => item.version), [PINNED, OLD]);
});

test("a linked tool folder or a linked version folder is never offered as an earlier version or for removal", async () => {
  const outside = join(root, "outside-tools");
  script(join(outside, OLD, "terraform"), "echo 'Terraform v" + OLD + "'");
  const linkedTool = join(root, "home-linked-tool");
  mkdirSync(join(linkedTool, ".alz", "tools"), { recursive: true });
  symlinkSync(outside, join(linkedTool, ".alz", "tools", "terraform"));
  assert.deepEqual(appInstalledVersions(linkedTool, "terraform", "terraform"), []);
  const linkedVersion = join(root, "home-linked-version");
  mkdirSync(join(linkedVersion, ".alz", "tools", "terraform"), { recursive: true });
  symlinkSync(join(outside, OLD), join(linkedVersion, ".alz", "tools", "terraform", OLD));
  assert.deepEqual(appInstalledVersions(linkedVersion, "terraform", "terraform"), []);
  assert.deepEqual(removableTools(loadToolPins(), linkedVersion, "darwin-arm64"), []);
  assert.ok(existsSync(join(outside, OLD, "terraform")), "nothing outside the app folder was touched");
});

test("menu answers only: typed words at the update question never download, and the guided installer offers the same update", async () => {
  const { home, old } = homeWithOld("typed");
  const fake = archive("typed", PINNED);
  let downloads = 0;
  const download = async () => { downloads += 1; return Readable.from([fake.body]); };
  const pinsPath = pinsFile("typed", fake.sha256);
  const typed = terminal(["1", "", "UPDATE TERRAFORM", "yes"]);
  assert.equal(await runDepsCommand([], deps("typed", home, typed, pinsPath, download, [])), 2);
  assert.equal(downloads, 0, "no clear menu choice means skip");
  assert.match(typed.shown.join(""), /That is not a choice/);

  const guided = terminal(["1", "2"]);
  const outcome = await installSelectedPinnedTools(["terraform"], deps("typed-guided", home, guided, pinsPath, download, []));
  assert.deepEqual(outcome.installed, ["terraform"]);
  assert.equal(downloads, 1);
  assert.match(guided.shown.join(""), /Update it now\?/);
  assert.match(guided.shown.join(""), /Kept Terraform 1\.15\.0\./);
  assert.ok(existsSync(old));
});
