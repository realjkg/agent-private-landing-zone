import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";

import { allRequiredPass, installedPath, runDependencyChecks, type CheckContext, AWS_CLI_VERSION_PATTERN } from "../src/deps/checks.js";
import { writeInstallMarker } from "../src/deps/install.js";
import { loadToolPins } from "../src/deps/pins.js";
import { blockedByDependencies, runDepsCommand, type DepsDeps } from "../src/cli/deps.js";
import type { HumanTerminal } from "../src/cli/teardown-driver.js";

// The checks and the guided command, with fake tools on a private PATH and a fake home folder. No network, no real
// Ollama, Terraform or service is touched.

const root = mkdtempSync(join(tmpdir(), "alz-deps-cli-"));
test.after(() => rmSync(root, { recursive: true, force: true }));

const pins = loadToolPins();
const NODE = "26.9.0";

function fakeTool(dir: string, name: string, body: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), "#!/bin/sh\n" + body + "\n");
  chmodSync(join(dir, name), 0o755);
}

/** A private PATH holding a correct Terraform and Ollama, a git, and no AWS CLI. */
function pathWith(label: string, tools: Record<string, string>): string {
  const dir = join(root, "bin-" + label);
  for (const [name, body] of Object.entries(tools)) fakeTool(dir, name, body);
  return dir;
}

const GOOD_TOOLS = {
  terraform: "echo 'Terraform v1.16.4'",
  ollama: "echo 'ollama version is 0.40.0'",
  git: "echo 'git version 2.55.0'",
};

function ctx(label: string, over: Partial<CheckContext> = {}): CheckContext {
  // The default PATH is built only when the caller does not supply one, so the two never share a folder.
  return {
    pins, home: join(root, "home-" + label), env: over.env ?? { PATH: pathWith(label, GOOD_TOOLS) },
    platform: "darwin", arch: "arm64", nodeVersion: NODE,
    probe: async () => ({ listening: false, apiOk: false }),
    ...over,
  };
}

const REQUIRED = new Set<never>(["node", "terraform", "ollama", "git"] as never[]) as ReadonlySet<never>;
const byId = (checks: Array<{ id: string }>, id: string) => checks.find((check) => check.id === id)!;

test("the checks pass with the tested tools, and an unlisted Node version is named in plain words", async () => {
  const healthy = await runDependencyChecks(ctx("healthy"), REQUIRED);
  assert.equal(allRequiredPass(healthy), true);
  const wrongNode = await runDependencyChecks(ctx("node", { nodeVersion: "22.1.0" }), REQUIRED);
  const node = byId(wrongNode, "node");
  assert.equal(node.ok, false);
  assert.match(node.fix!, /Install Node 26/);
});

test("a tool that is missing or not the pinned version fails with a fix; the app's own copy is preferred over PATH", async () => {
  const none = await runDependencyChecks(ctx("none", { env: { PATH: pathWith("none", { git: "echo 'git version 2.55.0'" }) } }), REQUIRED);
  assert.equal(byId(none, "terraform").ok, false);
  assert.equal(byId(none, "terraform").installable, "terraform", "pinned macOS tools can be installed by the app");
  assert.match(byId(none, "terraform").fix!, /Run \.\/alz deps/);

  const wrong = await runDependencyChecks(ctx("wrong", { env: { PATH: pathWith("wrong", { ...GOOD_TOOLS, terraform: "echo 'Terraform v1.5.0'" }) } }), REQUIRED);
  assert.match(byId(wrong, "terraform").detail, /found 1\.5\.0/);

  const home = join(root, "home-own");
  const own = installedPath(home, "terraform", "1.16.4", "terraform");
  mkdirSync(join(own, ".."), { recursive: true });
  fakeTool(join(own, ".."), "terraform", "echo 'Terraform v1.16.4'");
  // The program alone, with no completion marker, is a copy from before completion checks: reported, never read as verified.
  const legacy = await runDependencyChecks(ctx("own-legacy", { home, env: { PATH: pathWith("own-legacy", { ...GOOD_TOOLS, terraform: "echo 'Terraform v1.5.0'" }) } }), REQUIRED);
  assert.equal(byId(legacy, "terraform").ok, false, "a copy without a completion marker is never called installed");
  assert.match(byId(legacy, "terraform").detail, /installed before completion checks, not verified/);
  assert.match(byId(legacy, "terraform").fix!, /Run \.\/alz deps and choose Repair/);
  assert.ok(existsSync(own), "the legacy copy is never removed by a check");
  writeInstallMarker(join(own, ".."), { tool: "terraform", version: "1.16.4", binary: "terraform", sha256: "a".repeat(64), completedAt: new Date().toISOString() });
  const preferred = await runDependencyChecks(ctx("own", { home, env: { PATH: pathWith("own", { ...GOOD_TOOLS, terraform: "echo 'Terraform v1.5.0'" }) } }), REQUIRED);
  assert.equal(byId(preferred, "terraform").ok, true, "the app's own checked copy wins over a wrong one on PATH");
});

test("the isolated service: not running is fine; a listener that is not Ollama, or a missing model, is a plain blocker", async () => {
  const idle = await runDependencyChecks(ctx("idle"), REQUIRED);
  assert.equal(byId(idle, "isolated-service").ok, true);

  const notOllama = await runDependencyChecks(ctx("notollama", { probe: async () => ({ listening: true, apiOk: false }) }), REQUIRED);
  assert.match(byId(notOllama, "isolated-service").fix!, /lsof -i :11435/);

  const partial = await runDependencyChecks(ctx("partial", { probe: async () => ({ listening: true, apiOk: true, models: ["qwen3:1.7b", "qwen3:4b"] }) }), REQUIRED);
  const service = byId(partial, "isolated-service");
  assert.equal(service.ok, false);
  assert.match(service.detail, /mistral-nemo:latest/);
  assert.match(service.fix!, /dry run/i);
});

test("the AWS CLI and Git are reported with exact steps and never installed", async () => {
  const checks = await runDependencyChecks(ctx("awsmissing"), REQUIRED);
  const aws = byId(checks, "aws-cli");
  assert.equal(aws.ok, false);
  assert.equal(aws.installable, undefined, "the AWS CLI is check-only");
  assert.match(aws.fix!, /administrator password/);
  assert.ok(aws.fix!.includes("AWS CLI version " + pins.awsCli.version + ", the tested version"), aws.fix);
  assert.ok(!("installable" in byId(checks, "git")) || byId(checks, "git").installable === undefined);
});

test("the AWS CLI is pinned to a tested version, check only: the pin's own version passes, any other is named with the tested one and the install step, and the version line is read in the vendor's format", async () => {
  const pin = pins.awsCli.version;
  const line = (version: string, rest = "Python/3.13.11 Linux/6.1.0 exe/x86_64") => "echo 'aws-cli/" + version + " " + rest + "'";
  const tested = await runDependencyChecks(ctx("awsok", { env: { PATH: pathWith("awsok", { ...GOOD_TOOLS, aws: line(pin) }) } }), REQUIRED);
  assert.equal(byId(tested, "aws-cli").ok, true);
  assert.equal(byId(tested, "aws-cli").label, "AWS CLI " + pin);
  assert.ok(byId(tested, "aws-cli").detail.startsWith("version " + pin + " at "), byId(tested, "aws-cli").detail);
  const older = await runDependencyChecks(ctx("awsold", { env: { PATH: pathWith("awsold", { ...GOOD_TOOLS, aws: line("2.15.0", "Python/3.11.6 Darwin/23.0.0 exe/arm64") }) } }), REQUIRED);
  assert.equal(byId(older, "aws-cli").ok, false);
  assert.equal(byId(older, "aws-cli").installable, undefined, "still never installed by this app");
  assert.match(byId(older, "aws-cli").detail, /^found 2\.15\.0 at .*, tested /);
  assert.ok(byId(older, "aws-cli").detail.endsWith(", tested " + pin), byId(older, "aws-cli").detail);
  assert.ok(byId(older, "aws-cli").fix!.includes("Install AWS CLI version " + pin), byId(older, "aws-cli").fix);
  // A version 1 CLI prints the same shape with a 1.x version: read, then refused as not the tested version.
  const v1 = await runDependencyChecks(ctx("awsv1", { env: { PATH: pathWith("awsv1", { ...GOOD_TOOLS, aws: line("1.32.0", "Python/3.11.6 Linux/6.1.0 botocore/1.34.0") }) } }), REQUIRED);
  assert.equal(byId(v1, "aws-cli").ok, false);
  assert.match(byId(v1, "aws-cli").detail, /^found 1\.32\.0 at /);
  // The vendor's version line on each platform, and what is not one.
  for (const text of ["aws-cli/2.38.6 Python/3.13.11 Linux/6.1.0 exe/x86_64", "aws-cli/2.38.6 Python/3.13.11 Darwin/24.6.0 exe/arm64", "aws-cli/2.38.6 Python/3.13.11 Windows/10 exe/AMD64 prompt/off", "aws-cli/2.38.6 Python/3.13.11 Linux/6.1.0 source/x86_64"]) {
    assert.equal(AWS_CLI_VERSION_PATTERN.exec(text)?.[1], "2.38.6", text);
  }
  assert.equal(AWS_CLI_VERSION_PATTERN.exec("aws-cli/2.38.6")?.[1], "2.38.6", "the version alone, as the CDK engine reads it");
  for (const text of ["", "aws-cli/2.38 Python/3.13.11", "awscli 2.38.6", "AWS CLI 2.38.6", "Python/3.13.11 aws-cli/2.38.6", "aws-cli/2.38.6.1 Python/3.13.11", "aws-cli/2.38.6-dev0 Python/3.13.11"]) assert.equal(AWS_CLI_VERSION_PATTERN.exec(text), null, text);
});

// --- the guided command -------------------------------------------------------------------------------------

/** Sends `answers` to each dialog in order. Records what was shown, so a test can check the dialog's words. */
function terminal(interactive: boolean, answers: string[]): HumanTerminal & { shown: string[]; asked: number } {
  const shown: string[] = [];
  const term = {
    stdinIsTTY: interactive, stdoutIsTTY: interactive, shown, asked: 0,
    write: (text: string) => { shown.push(text); },
    ask: async () => { term.asked += 1; return answers.shift() ?? ""; },
  };
  return term;
}

/** A pin file whose Terraform artifact is a fake archive, so an install can really run and really be checked. */
function fakePins(label: string, sha256: string): string {
  const path = join(root, "pins-" + label + ".json");
  const copy = JSON.parse(readFileSync("config/tool-pins.json", "utf8"));
  copy.tools.terraform.artifacts["darwin-arm64"].sha256 = sha256;
  copy.tools.terraform.artifacts["darwin-arm64"].url = "https://releases.hashicorp.com/terraform/1.16.4/fake.tgz";
  copy.tools.terraform.artifacts["darwin-arm64"].archive = "tgz";
  writeFileSync(path, JSON.stringify(copy));
  return path;
}

function fakeArchive(label: string): { sha256: string; body: Buffer } {
  const dir = join(root, "arch-" + label);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "terraform"), "#!/bin/sh\necho 'Terraform v1.16.4'\n");
  const file = join(root, "arch-" + label + ".tgz");
  execFileSync("tar", ["-czf", file, "-C", dir, "terraform"]);
  const body = readFileSync(file);
  return { sha256: createHash("sha256").update(body).digest("hex"), body };
}

const deps = (label: string, term: HumanTerminal, extra: Partial<DepsDeps> = {}): DepsDeps => ({
  terminal: term, home: join(root, "home-cli-" + label), env: { PATH: pathWith("cli-" + label, { ...GOOD_TOOLS, terraform: "" }) },
  platform: "darwin", arch: "arm64", nodeVersion: NODE, out: () => undefined,
  probe: async () => ({ listening: false, apiOk: false }),
  ...extra,
});

test("without an interactive Terminal, ./alz deps only reports: nothing is installed or downloaded", async () => {
  let downloads = 0;
  const term = terminal(false, []);
  const code = await runDepsCommand([], deps("noninteractive", term, { download: async () => { downloads += 1; return Readable.from([]); } }));
  assert.equal(code, 2);
  assert.equal(downloads, 0);
  assert.equal(term.asked, 0, "nothing is asked");
  assert.ok(!existsSync(join(root, "home-cli-noninteractive", ".alz", "tools")), "no tool folder is created");
});

test("choosing Skip at the install menu installs nothing, and the command stays blocked", async () => {
  const archive = fakeArchive("wrong");
  let downloads = 0;
  const term = terminal(true, ["1", "", "2"]);
  const code = await runDepsCommand([], {
    ...deps("wrong", term, { download: async () => { downloads += 1; return Readable.from([archive.body]); } }),
    pinsPath: fakePins("wrong", archive.sha256),
  });
  assert.equal(code, 2);
  assert.equal(downloads, 0, "a skipped dialog downloads nothing");
  assert.ok(!existsSync(installedPath(join(root, "home-cli-wrong"), "terraform", "1.16.4", "terraform")));
  const dialog = term.shown.join("");
  assert.match(dialog, /Install it now\?/);
  assert.match(dialog, /Needs: no administrator password/);
  assert.match(dialog, /Install it\s+2\s+Skip it/);
});

test("choosing Install from the menu installs the verified tool, and the dialog names the file, its source and its checksum", async () => {
  const archive = fakeArchive("right");
  const term = terminal(true, ["1", "", "1"]);
  const lines: string[] = [];
  const code = await runDepsCommand([], {
    ...deps("right", term, {
      out: (text) => { lines.push(text); },
      download: async () => Readable.from([archive.body]),
      env: { PATH: pathWith("cli-right", { ...GOOD_TOOLS, terraform: "" }) },
    }),
    pinsPath: fakePins("right", archive.sha256),
  });
  const home = join(root, "home-cli-right");
  assert.ok(existsSync(installedPath(home, "terraform", "1.16.4", "terraform")), "installed into the user folder");
  assert.match(term.shown.join(""), new RegExp("From: releases\\.hashicorp\\.com|Checked: the download must match SHA-256 " + archive.sha256.slice(0, 0)));
  assert.ok(lines.join("").includes("Installed:"));
  assert.equal(code, 0);
});

test("a checksum mismatch in the menu install is shown in plain words and nothing is installed", async () => {
  const archive = fakeArchive("tamper");
  const term = terminal(true, ["1", "", "1"]);
  const lines: string[] = [];
  const code = await runDepsCommand([], {
    ...deps("tamper", term, {
      out: (text) => { lines.push(text); },
      download: async () => Readable.from([archive.body]),
      env: { PATH: pathWith("cli-tamper", { ...GOOD_TOOLS, terraform: "" }) },
    }),
    pinsPath: fakePins("tamper", "0".repeat(64)),
  });
  assert.equal(code, 2);
  assert.match(lines.join(""), /did not match the checksum this app expects, so nothing was installed/);
  assert.ok(!existsSync(installedPath(join(root, "home-cli-tamper"), "terraform", "1.16.4", "terraform")));
});

test("pilot commands check first: a missing tool blocks with the reason and never installs", async () => {
  const lines: string[] = [];
  const blocked = await blockedByDependencies("apply", {
    ...deps("pilot", terminal(true, []), { out: (text) => { lines.push(text); } }),
    env: { PATH: pathWith("pilot", { git: "echo 'git version 2.55.0'" }) },
  });
  assert.equal(blocked, true);
  assert.match(lines.join(""), /Terraform 1\.16\.4: .*Run \.\/alz deps/s);
  assert.match(lines.join(""), /Nothing was started/);

  const ready = await blockedByDependencies("apply", {
    ...deps("pilot-ready", terminal(true, []), { out: () => undefined }),
    env: { PATH: pathWith("pilot-ready", GOOD_TOOLS) },
  });
  assert.equal(ready, false);
});

test("the product tools come from the plugin catalog, are never required, and a missing one never blocks a pilot command", async () => {
  const { PLUGIN_CATALOG } = await import("../src/plugins/catalog.js");
  const { productChecks } = await import("../src/deps/checks.js");
  const checks = productChecks(ctx("product"));
  const pilot = new Set(["terraform", "ollama", "aws", "git"]);
  for (const plugin of PLUGIN_CATALOG.filter((item) => item.executable && !pilot.has(item.executable))) {
    const row = checks.find((check) => check.id === "product:" + plugin.executable);
    assert.ok(row, "catalog tool listed: " + plugin.executable);
    assert.equal(row!.required, false, plugin.executable);
    if (!row!.ok) assert.match(row!.fix ?? "", /Install /, plugin.executable);
  }
  assert.ok(checks.some((check) => check.id === "product:trivy"));
  assert.ok(!checks.some((check) => ["product:terraform", "product:aws", "product:git"].includes(check.id)), "pilot tools are never repeated");
  assert.ok(checks.every((check) => check.required === false));
  const blocked = await blockedByDependencies("apply", {
    ...deps("product-apply", terminal(true, []), { out: () => undefined }),
    env: { PATH: pathWith("product-apply", GOOD_TOOLS) },
  });
  assert.equal(blocked, false, "a missing product tool does not block the pilot");
});

test("the selection screen preselects every missing tool; Enter continues, a number toggles, s skips all, q cancels", async () => {
  const { chooseInstalls } = await import("../src/cli/deps.js");
  const items = [
    { id: "terraform", label: "Terraform 1.16.4", required: true, ok: false, detail: "", installable: "terraform" },
    { id: "ollama", label: "Ollama 0.40.0", required: true, ok: false, detail: "", installable: "ollama" },
  ] as const;
  const picked = async (answers: string[]) => chooseInstalls([...items] as never, terminal(true, answers));
  assert.deepEqual([...(await picked([""]))!].sort(), ["ollama", "terraform"], "preselected: both checked");
  assert.deepEqual([...(await picked(["1", ""]))!], ["ollama"], "a number unchecks Terraform");
  assert.deepEqual([...(await picked(["1", "1", ""]))!].sort(), ["ollama", "terraform"], "a number toggles back on");
  assert.deepEqual([...(await picked(["s"]))!], [], "s skips all");
  assert.equal(await picked(["q"]), null, "q cancels, with nothing selected");
  const confused = terminal(true, ["banana", "9", ""]);
  assert.deepEqual([...(await chooseInstalls([...items] as never, confused))!].sort(), ["ollama", "terraform"]);
  assert.ok(confused.shown.join("").includes("That is not a choice"), "an invalid answer is explained, not ignored");
});

test("cancel at the selection screen, after choosing install, installs nothing and downloads nothing", async () => {
  const archive = fakeArchive("cancel");
  let downloads = 0;
  const term = terminal(true, ["1", "q"]);
  const code = await runDepsCommand([], {
    ...deps("cancel", term, { download: async () => { downloads += 1; return Readable.from([archive.body]); } }),
    pinsPath: fakePins("cancel", archive.sha256),
  });
  assert.equal(code, 2);
  assert.equal(downloads, 0);
  assert.ok(!existsSync(installedPath(join(root, "home-cli-cancel"), "terraform", "1.16.4", "terraform")));
});

test("guided installer: no TTY, a skip or no clear choice, and checksum mismatch never install a tool", async () => {
  const { installSelectedPinnedTools } = await import("../src/cli/deps.js");
  const archive = fakeArchive("guided-tampered");
  const pinsPath = fakePins("guided-tampered", "0".repeat(64));
  let downloaded = 0;
  const download = async () => { downloaded++; return Readable.from([archive.body]); };
  const nonTTY = await installSelectedPinnedTools(["terraform"], {
    ...deps("guided-nontty", terminal(false, []), { download }), pinsPath,
  });
  assert.deepEqual(nonTTY.installed, []);
  assert.equal(downloaded, 0);
  const reject = await installSelectedPinnedTools(["terraform"], {
    ...deps("guided-reject", terminal(true, ["2"]), { download }), pinsPath,
  });
  assert.deepEqual(reject.installed, []);
  assert.deepEqual(reject.skipped, ["terraform"]);
  assert.equal(downloaded, 0);
  // Typing something that is not a choice never installs: the menu asks again, and with no clear answer it skips.
  const unclear = await installSelectedPinnedTools(["terraform"], {
    ...deps("guided-unclear", terminal(true, ["INSTALL TERRAFORM 1.16.4", "yes"]), { download }), pinsPath,
  });
  assert.deepEqual(unclear.installed, []);
  assert.deepEqual(unclear.skipped, ["terraform"]);
  assert.equal(downloaded, 0);
  const tamper = await installSelectedPinnedTools(["terraform"], {
    ...deps("guided-tamper", terminal(true, ["1"]), { download }), pinsPath,
  });
  assert.deepEqual(tamper.installed, []);
  assert.deepEqual(tamper.skipped, ["terraform"]);
  assert.equal(downloaded, 1);
  assert.equal(existsSync(installedPath(join(root, "home-cli-guided-tamper"), "terraform", "1.16.4", "terraform")), false);
});

test("guided installer: explicit tool selection installs only checksum-verified artifact in isolated home", async () => {
  const { installSelectedPinnedTools } = await import("../src/cli/deps.js");
  const archive = fakeArchive("guided-verified");
  const pinsPath = fakePins("guided-verified", archive.sha256);
  let downloaded = 0;
  const term = terminal(true, ["1"]);
  const outcome = await installSelectedPinnedTools(["terraform"], {
    ...deps("guided-verified", term, {
      download: async () => { downloaded++; return Readable.from([archive.body]); },
    }), pinsPath,
  });
  assert.deepEqual(outcome.installed, ["terraform"]);
  assert.deepEqual(outcome.skipped, []);
  assert.equal(downloaded, 1);
  assert.equal(existsSync(installedPath(join(root, "home-cli-guided-verified"), "terraform", "1.16.4", "terraform")), true);
  assert.match(term.shown.join(""), /SHA-256/);
  await assert.rejects(() => installSelectedPinnedTools(["crossplane" as never], {
    ...deps("guided-unsupported", terminal(true, [])), pinsPath,
  }), /INSTALL_TOOL_NOT_PINNED/);
});

test("guided installer never calls a cached but wrong-version binary ready: it offers a repair, and a failed repair leaves that copy as it was", async () => {
  const { installSelectedPinnedTools } = await import("../src/cli/deps.js");
  const home = join(root, "home-cli-guided-cached-bad");
  const installed = installedPath(home, "terraform", "1.16.4", "terraform");
  fakeTool(join(installed, ".."), "terraform", "echo 'Terraform v0.0.1'");
  const before = readFileSync(installed, "utf8");
  let downloaded = 0;
  const term = terminal(true, ["1"]);
  const result = await installSelectedPinnedTools(["terraform"], {
    ...deps("guided-cached-bad", term, {
      download: async () => { downloaded++; return Readable.from([]); },
    }),
  });
  assert.deepEqual(result.installed, [], "a cached copy without a completion marker is never treated as a valid install");
  assert.deepEqual(result.skipped, ["terraform"]);
  assert.equal(downloaded, 1, "the repair downloads the pinned version beside the unverified copy");
  const shown = term.shown.join("");
  assert.match(shown, /installed before completion checks, not verified/);
  assert.match(shown, /Repair it now\?\n\s+1\s+Repair it\n\s+2\s+Skip it/);
  assert.match(shown, /did not match the checksum this app expects, so nothing was installed/);
  assert.equal(readFileSync(installed, "utf8"), before, "the unverified copy is untouched when the repair fails");
  assert.deepEqual(readdirSync(join(installed, "..", "..")), ["1.16.4"], "no partial or replaced folder is left beside it");
});

/** A download that sends one chunk, then waits until it is stopped, like a stalled connection. */
function stalledDownload(onStart: () => void): DepsDeps["download"] {
  return async (_url, signal) => Readable.from((async function* () {
    yield Buffer.from("partial");
    onStart();
    await new Promise<void>((done) => { signal.addEventListener("abort", () => done(), { once: true }); });
  })());
}

test("a cached copy with its completion marker whose program reports the wrong version is never ready: no download, a plain message, and the copy is kept", async () => {
  const { installSelectedPinnedTools } = await import("../src/cli/deps.js");
  const home = join(root, "home-cli-marked-wrong");
  const installed = installedPath(home, "terraform", "1.16.4", "terraform");
  fakeTool(join(installed, ".."), "terraform", "echo 'Terraform v0.0.1'");
  writeInstallMarker(join(installed, ".."), { tool: "terraform", version: "1.16.4", binary: "terraform", sha256: "a".repeat(64), completedAt: new Date().toISOString() });
  const before = readFileSync(installed, "utf8");
  let downloaded = 0;
  const term = terminal(true, ["1"]);
  const result = await installSelectedPinnedTools(["terraform"], {
    ...deps("marked-wrong", term, { download: async () => { downloaded++; return Readable.from([]); } }),
  });
  assert.deepEqual(result.installed, [], "a marked copy that reports the wrong version is never ready");
  assert.deepEqual(result.skipped, ["terraform"]);
  assert.equal(downloaded, 0, "no download for a copy that is already installed");
  assert.match(term.shown.join(""), /still failed verification after installation, so it is not used\. Remove it from the \.\/alz deps menu, then install it again\./);
  assert.equal(readFileSync(installed, "utf8"), before, "the copy is kept, not removed on its own");
  assert.ok(existsSync(join(installed, "..", ".alz-installed.json")), "its marker is kept too");
});

test("a stop during one install ends the remaining selected installs instead of asking about the next tool", async () => {
  const { installSelectedPinnedTools } = await import("../src/cli/deps.js");
  const archive = fakeArchive("stop-rest");
  const home = join(root, "home-cli-stop-rest");
  const term = terminal(true, ["1", "1"]);
  const exits: number[] = [];
  const result = await installSelectedPinnedTools(["terraform", "ollama"], {
    ...deps("stop-rest", term, {
      home, env: { PATH: pathWith("stop-rest", { git: "echo 'git version 2.55.0'", terraform: "", ollama: "" }) },
      download: stalledDownload(() => { process.kill(process.pid, "SIGINT"); }),
      exit: (code) => { exits.push(code); },
    }),
    pinsPath: fakePins("stop-rest", archive.sha256),
  });
  assert.deepEqual(result.installed, []);
  assert.deepEqual(result.skipped, ["terraform", "ollama"], "the tool after the stopped one is skipped, not asked about");
  assert.equal(term.asked, 1, "only the first tool's menu was asked");
  assert.match(term.shown.join(""), /The remaining installs were not started\./);
  assert.deepEqual(exits, []);
  assert.ok(!existsSync(join(home, ".alz", "tools", "ollama")), "the second tool's install never started");
  // The same through ./alz deps: the second selected tool is not asked about either.
  const menu = terminal(true, ["1", "", "1"]);
  const lines: string[] = [];
  const code = await runDepsCommand([], {
    ...deps("stop-rest-menu", menu, {
      home: join(root, "home-cli-stop-rest-menu"), env: { PATH: pathWith("stop-rest-menu", { git: "echo 'git version 2.55.0'", terraform: "", ollama: "" }) },
      out: (text) => { lines.push(text); }, download: stalledDownload(() => { process.kill(process.pid, "SIGINT"); }), exit: () => undefined,
    }),
    pinsPath: fakePins("stop-rest-menu", archive.sha256),
  });
  assert.equal(code, 2);
  assert.equal(menu.asked, 3, "the action, the selection and the first tool's question; the second tool is never asked");
  assert.match(lines.join(""), /The remaining installs were not started\./);
});

test("each ./alz deps run leaves a private diagnostic log of its steps, with no paths, URLs or downloads in it", async () => {
  const archive = fakeArchive("logged");
  const term = terminal(true, ["1", "", "1"]);
  const home = join(root, "home-cli-logged");
  await runDepsCommand([], {
    ...deps("logged", term, {
      out: () => {},
      download: async () => Readable.from([archive.body]),
      env: { PATH: pathWith("cli-logged", { ...GOOD_TOOLS, terraform: "" }) },
    }),
    pinsPath: fakePins("logged", archive.sha256),
  });
  const logDir = join(home, ".alz", "logs");
  const files = readdirSync(logDir).filter((name) => name.startsWith("deps-") && name.endsWith(".log"));
  assert.equal(files.length, 1, "one log file for the run");
  assert.equal(statSync(join(logDir, files[0])).mode & 0o777, 0o600, "the log is private");
  const text = readFileSync(join(logDir, files[0]), "utf8");
  assert.match(text, /check .*Terraform 1\.16\.4=missing/);
  assert.match(text, /menu install/);
  assert.match(text, /install terraform 1\.16\.4 installed/);
  assert.match(text, /after /);
  assert.doesNotMatch(text, /https?:\/\/|\/home|\.alz\/tools/, "no URLs or paths in the log");
});

test("a stop signal during an install stops the download, removes what was started and says a rerun starts over; a second signal leaves at once", async () => {
  const archive = fakeArchive("signal");
  const home = join(root, "home-cli-signal");
  const term = terminal(true, ["1", "", "1"]);
  const lines: string[] = [];
  const exits: number[] = [];
  const code = await runDepsCommand([], {
    ...deps("signal", term, {
      out: (text) => { lines.push(text); },
      download: stalledDownload(() => { process.kill(process.pid, "SIGINT"); }),
      exit: (exitCode) => { exits.push(exitCode); },
    }),
    pinsPath: fakePins("signal", archive.sha256),
  });
  assert.equal(code, 2);
  assert.match(term.shown.join(""), /Stopping the Terraform install\. Nothing is installed; the unfinished download is being removed\. Running \.\/alz deps again starts over\. Press Ctrl-C again to leave at once\./);
  assert.match(lines.join(""), /Stopped\. Nothing was installed, and the unfinished download was removed\. Run \.\/alz deps again to start the install over\./);
  assert.deepEqual(exits, [], "one signal never ends the process on its own");
  assert.ok(!existsSync(installedPath(home, "terraform", "1.16.4", "terraform")));
  assert.deepEqual(readdirSync(join(home, ".alz", "tools", "terraform")), [], "no partial folder survives the stop");
  assert.deepEqual(readdirSync(join(home, ".alz", "tmp")), [], "the unfinished download is removed");
  assert.equal(process.listenerCount("SIGINT"), 0, "the install's signal handler is released afterwards");
  assert.match(readFileSync(join(home, ".alz", "logs", readdirSync(join(home, ".alz", "logs"))[0]), "utf8"), /install terraform 1\.16\.4 failed INSTALL_INTERRUPTED/);
});

test("the stop guard: the first signal says what happens and stops the download, the second leaves at once, and release gives the signals back", async () => {
  const { installStopGuard } = await import("../src/cli/deps.js");
  const term = terminal(true, []);
  const exits: number[] = [];
  const before = process.listenerCount("SIGINT");
  const guard = installStopGuard("ollama", term, (code) => { exits.push(code); });
  assert.equal(process.listenerCount("SIGINT"), before + 1);
  assert.equal(guard.signal.aborted, false);
  guard.onSignal();
  assert.equal(guard.signal.aborted, true, "the first signal stops the download");
  assert.deepEqual(exits, [], "the first signal never ends the process");
  assert.match(term.shown.join(""), /Stopping the Ollama install\. Nothing is installed; the unfinished download is being removed\. Running \.\/alz deps again starts over\. Press Ctrl-C again to leave at once\./);
  guard.onSignal();
  assert.deepEqual(exits, [2], "the second signal ends the process with the blocked code");
  guard.release();
  guard.release();
  assert.equal(process.listenerCount("SIGINT"), before, "released once, whatever the outcome");
});

test("the ./alz deps report sweeps leftovers whose process is dead, says so, and leaves a folder whose pid may be alive", async () => {
  const home = join(root, "home-cli-sweep");
  const toolDir = join(home, ".alz", "tools", "terraform");
  const dead = join(toolDir, "1.16.4.partial-4242");
  const live = join(toolDir, "1.16.4.partial-4343");
  mkdirSync(dead, { recursive: true });
  mkdirSync(live, { recursive: true });
  mkdirSync(join(home, ".alz", "tmp"), { recursive: true });
  writeFileSync(join(home, ".alz", "tmp", "terraform-1.16.4-4242.zip"), "half");
  const lines: string[] = [];
  const code = await runDepsCommand([], deps("sweep", terminal(false, []), {
    home, out: (text) => { lines.push(text); }, pidAlive: (pid) => pid === 4343,
    env: { PATH: pathWith("sweep-good", GOOD_TOOLS) },
  }));
  assert.equal(code, 0);
  const text = lines.join("");
  assert.match(text, /Removed a leftover of an earlier run that did not finish: .*1\.16\.4\.partial-4242/);
  assert.match(text, /Removed a leftover of an earlier run that did not finish: .*terraform-1\.16\.4-4242\.zip/);
  assert.doesNotMatch(text, /partial-4343/);
  assert.ok(!existsSync(dead) && existsSync(live), "only the dead pid's folder is removed");
  assert.deepEqual(readdirSync(join(home, ".alz", "tmp")), []);
});

test("an unfinished install or removal in the app's folder is reported, offered as a repair and as a removal, and never read as installed", async () => {
  const home = join(root, "home-cli-unfinished");
  const folder = join(home, ".alz", "tools", "terraform", "1.16.4");
  fakeTool(folder, "terraform", "echo 'Terraform v1.16.4'");
  writeFileSync(join(folder, ".alz-removing"), "2026-10-27T00:00:00.000Z\n");
  const lines: string[] = [];
  const term = terminal(true, ["3"]);
  const code = await runDepsCommand([], deps("unfinished", term, { home, out: (text) => { lines.push(text); }, env: { PATH: pathWith("cli-unfinished", { ...GOOD_TOOLS, terraform: "" }) } }));
  assert.equal(code, 0, "Do nothing leaves it");
  assert.match(lines.join(""), /NEEDS ATTENTION\s+Terraform 1\.16\.4 — an earlier removal did not finish/);
  assert.match(lines.join(""), /choose Remove to finish removing it, or Install to replace it/);
  assert.match(term.shown.join(""), /1\s+Repair the app's own copies\n\s+2\s+Remove a tool this app installed\n\s+3\s+Do nothing/);
  assert.ok(existsSync(join(folder, "terraform")), "Do nothing changes nothing");
  // Choosing Remove finishes the interrupted removal.
  const again = terminal(true, ["2", "1", "1"]);
  assert.equal(await runDepsCommand([], deps("unfinished-remove", again, { home, env: { PATH: pathWith("cli-unfinished-remove", { ...GOOD_TOOLS, terraform: "" }) } })), 2);
  assert.match(again.shown.join(""), /Terraform 1\.16\.4 \(.*\) — an earlier removal did not finish/);
  assert.ok(!existsSync(folder), "the repeated removal completes it");
});

test("the ./alz deps report says in plain words when a leftover is left alone or cannot be checked, instead of ending with an error", async () => {
  const home = join(root, "home-cli-refused");
  const toolDir = join(home, ".alz", "tools", "terraform");
  mkdirSync(join(toolDir, "1.16.4.replaced-4242"), { recursive: true });
  writeFileSync(join(toolDir, "1.16.4.replaced-4242", "terraform"), "the earlier copy");
  symlinkSync(join(root, "nowhere-cli-" + Date.now()), join(toolDir, "1.16.4"));
  const lines: string[] = [];
  const code = await runDepsCommand([], deps("refused", terminal(false, []), {
    home, out: (text) => { lines.push(text); }, pidAlive: () => false, env: { PATH: pathWith("refused-good", GOOD_TOOLS) },
  }));
  assert.equal(code, 0, lines.join(""));
  assert.match(lines.join(""), /Left alone: something that is not a folder \(a link or a file\) stands at .*1\.16\.4, so the earlier terraform 1\.16\.4 copy beside it was left alone; remove it by hand, then run \.\/alz deps again\./);
  assert.ok(existsSync(join(toolDir, "1.16.4.replaced-4242", "terraform")), "the copy aside is kept");
  assert.ok(lstatSync(join(toolDir, "1.16.4")).isSymbolicLink(), "the link is untouched");
  // A second ./alz deps run while another is installing the same tool: the install is refused with the plain reason, and the
  // other run's lock stays.
  const archive = fakeArchive("locked");
  const lockHome = join(root, "home-cli-locked");
  mkdirSync(join(lockHome, ".alz", "tmp"), { recursive: true });
  writeFileSync(join(lockHome, ".alz", "tmp", "terraform.install.lock"), JSON.stringify({ pid: 4343, startedAt: "2026-10-27T00:00:00.000Z" }) + "\n");
  const out: string[] = [];
  let downloads = 0;
  const locked = await runDepsCommand([], {
    ...deps("locked", terminal(true, ["1", "", "1"]), { home: lockHome, out: (text) => { out.push(text); }, pidAlive: (pid) => pid === 4343, download: async () => { downloads += 1; return Readable.from([archive.body]); } }),
    pinsPath: fakePins("locked", archive.sha256),
  });
  assert.equal(locked, 2);
  assert.equal(downloads, 0);
  assert.match(out.join(""), /Another \.\/alz deps run \(pid 4343\) is installing or removing terraform right now, so this run changed nothing\. Wait for it to finish, then run \.\/alz deps again\. If no other \.\/alz deps run is open in any window, .*: delete \S+\/\.alz\/tmp\/terraform\.install\.lock, then run \.\/alz deps again\./);
  // The report's own sweep takes the same lock, so it does not touch the tool's leftovers while the other run holds it.
  assert.match(out.join(""), /^Did not check the leftovers of earlier Terraform runs\. Another \.\/alz deps run \(pid 4343\)/m);
  assert.ok(existsSync(join(lockHome, ".alz", "tmp", "terraform.install.lock")), "the other run's lock stays");
  assert.ok(!existsSync(installedPath(lockHome, "terraform", "1.16.4", "terraform")));
});
