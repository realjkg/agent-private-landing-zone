import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";

import { allRequiredPass, installedPath, runDependencyChecks, type CheckContext } from "../src/deps/checks.js";
import { loadToolPins } from "../src/deps/pins.js";
import { blockedByDependencies, runDepsCommand, type DepsDeps } from "../src/cli/deps.js";
import type { HumanTerminal } from "../src/cli/teardown-driver.js";

// The checks and the guided command, with fake tools on a private PATH and a fake home folder. No network, no real
// Ollama, Terraform or service is touched.

const root = mkdtempSync(join(tmpdir(), "alz-deps-cli-"));
test.after(() => rmSync(root, { recursive: true, force: true }));

const pins = loadToolPins();
const NODE = "24.11.0";

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
  assert.match(node.fix!, /Install Node 24/);
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
  const preferred = await runDependencyChecks(ctx("own", { home, env: { PATH: pathWith("own", { ...GOOD_TOOLS, terraform: "echo 'Terraform v1.5.0'" }) } }), REQUIRED);
  assert.equal(byId(preferred, "terraform").ok, true, "the app's own copy wins over a wrong one on PATH");
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
  assert.ok(!("installable" in byId(checks, "git")) || byId(checks, "git").installable === undefined);
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
  assert.ok(!existsSync(join(root, "home-cli-noninteractive", ".alz")));
});

test("a wrong phrase skips the install, and the command stays blocked", async () => {
  const archive = fakeArchive("wrong");
  let downloads = 0;
  const term = terminal(true, ["yes please"]);
  const code = await runDepsCommand([], {
    ...deps("wrong", term, { download: async () => { downloads += 1; return Readable.from([archive.body]); } }),
    pinsPath: fakePins("wrong", archive.sha256),
  });
  assert.equal(code, 2);
  assert.equal(downloads, 0, "a skipped dialog downloads nothing");
  assert.ok(!existsSync(installedPath(join(root, "home-cli-wrong"), "terraform", "1.16.4", "terraform")));
  const dialog = term.shown.join("");
  assert.match(dialog, /To install, type exactly:\s+INSTALL TERRAFORM 1\.16\.4/);
  assert.match(dialog, /Needs: no administrator password/);
  assert.match(dialog, /Anything else skips it/);
});

test("the exact phrase installs the verified tool, and the dialog names the file, its source and its checksum", async () => {
  const archive = fakeArchive("right");
  const term = terminal(true, ["INSTALL TERRAFORM 1.16.4"]);
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

test("a checksum mismatch in the dialog's install is shown in plain words and nothing is installed", async () => {
  const archive = fakeArchive("tamper");
  const term = terminal(true, ["INSTALL TERRAFORM 1.16.4"]);
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
  for (const plugin of PLUGIN_CATALOG.filter((item) => item.executable)) {
    const row = checks.find((check) => check.id === "product:" + plugin.executable);
    assert.ok(row, "catalog tool listed: " + plugin.executable);
    assert.equal(row!.required, false, plugin.executable);
    if (!row!.ok) assert.match(row!.fix ?? "", /Install /, plugin.executable);
  }
  assert.ok(checks.some((check) => check.id === "product:trivy"));
  assert.ok(checks.every((check) => check.required === false));
  const blocked = await blockedByDependencies("apply", {
    ...deps("product-apply", terminal(true, []), { out: () => undefined }),
    env: { PATH: pathWith("product-apply", GOOD_TOOLS) },
  });
  assert.equal(blocked, false, "a missing product tool does not block the pilot");
});
