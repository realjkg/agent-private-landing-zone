import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { OPERATIONS } from "../src/operations/registry.js";
import { assertSafeArgv, sampleArgvs } from "../src/operations/schema.js";
import type { OperationSpec } from "../src/operations/types.js";
import { getToolSecurityPosture } from "../src/tools/broker.js";

// The parity guard: everything an operator can call from the command line has
// exactly one catalog entry, so the console cannot fall behind the CLI. Adding
// a ./alz command, a package.json script or a src/cli entry point without a
// catalog entry makes this test fail, naming what is missing.

const EXEMPT_COMMANDS: Readonly<Record<string, string>> = {
  bootstrap: "handled by the ./alz shell wrapper (npm ci and builds) before the CLI starts",
  workspace: "starts the console itself",
  help: "prints the command list",
  "--help": "prints the command list", "-h": "prints the command list",
  "prompt-guide": "alias of ./alz prompts",
};
const EXEMPT_SCRIPTS: Readonly<Record<string, string>> = {
  operator: "alias of the ./alz dispatcher",
  test: "developer test run", "test:quiet": "developer test runner with full logs", "test:node": "developer test run", "test:ui": "developer test run",
  build: "developer build", "build:ui": "developer build", "build:runtime": "developer build step: the compile alone, without the completion marker",
  "build:complete": "developer build step: writes the dist/ completion marker ./alz checks", check: "developer type-check and build",
  verify: "release-wide developer gate (the ./alz verify entry covers operator verification)",
  "ci:actions-pinned": "CI workflow pin check", "deps:review": "developer install-script listing",
  "docs:ops": "developer generator for the operations table in docs/operator-console.md",
  "docs:release": "developer generator for the release view in docs/release-status.md",
};
const EXEMPT_ENTRY_POINTS: Readonly<Record<string, string>> = {
  "operator.ts": "the ./alz dispatcher itself",
  "operator-web.ts": "hosts the console (./alz workspace)",
  "act-dev1-admin.ts": "a library the console's ui-channel adapter imports for the ACT-DEV-1 account check, not a command",
  "ui-channel.ts": "the console's pilot wizard adapter: a module the console server mounts, not a command (the pilot's catalog entry is ./alz apply)",
};

/** Command words of a help or catalog line, cut at the first placeholder or option; `a|b` expands to several keys. */
export function commandKeys(line: string): string[] {
  const words: string[] = [];
  for (const token of line.trim().replace(/^(\.\/alz|npm run|npx tsx)\s+/, "").split(/\s+/)) {
    // A flag is part of the key only right after a single command word (./alz matrix --live-models).
    if (/^[[<("]/.test(token) || (token.startsWith("-") && words.length !== 1)) break;
    words.push(token);
  }
  return words.reduce<string[]>((keys, word) =>
    word.includes("|") ? word.split("|").flatMap((alt) => keys.map((key) => (key + " " + alt).trim()))
      : keys.map((key) => (key + " " + word).trim()), [""]);
}

type Inputs = {
  helpLines: string[];
  scripts: string[];
  entryPoints: string[];
  catalog: readonly OperationSpec[];
  fileExists: (path: string) => boolean;
  /** Every `command === "x"` literal in src/cli/operator.ts (the dispatcher's real branches). */
  operatorCommands?: string[];
};

export function findProblems(input: Inputs): string[] {
  const problems: string[] = [];
  const helpEntries = input.helpLines.filter((line) => line.startsWith("  ./alz "));
  const groupLines = helpEntries.filter((line) => /\[list\|<subcommand>\]/.test(line));
  const helpKeys = helpEntries.filter((line) => !groupLines.includes(line))
    .flatMap((line) => commandKeys(line.replace(/\s*\([^)]*\)\s*$/, "")));
  const groups = new Set(groupLines.map((line) => commandKeys(line)[0]));
  const alzKey = (spec: OperationSpec) => spec.cli.startsWith("./alz ") ? commandKeys(spec.cli)[0] : undefined;

  for (const key of helpKeys) {
    if (EXEMPT_COMMANDS[key]) continue;
    const owners = input.catalog.filter((spec) => alzKey(spec) === key);
    if (owners.length !== 1) problems.push(`help command "${key}" maps to ${owners.length} catalog entries (need exactly 1)`);
  }
  for (const word of input.operatorCommands ?? []) {
    const known = helpKeys.some((key) => key.split(" ")[0] === word) || groups.has(word) ||
      input.catalog.some((spec) => alzKey(spec)?.split(" ")[0] === word);
    if (!known && !EXEMPT_COMMANDS[word]) problems.push(`operator.ts dispatches "${word}", which has no help line, catalog entry or exemption`);
  }
  for (const group of groups) {
    if (!input.catalog.some((spec) => spec.command?.group === group)) problems.push(`help group "${group}" has no catalog entry`);
  }
  for (const spec of input.catalog) {
    const at = (message: string) => problems.push(`${spec.id}: ${message}`);
    const key = alzKey(spec);
    // A fixed flag on a cli form (./alz debug --fixture) must be one the help line for that command documents.
    const [word, ...flagWords] = (key ?? "").split(" ");
    const flagDocumented = flagWords.length > 0 && helpKeys.includes(word) &&
      flagWords.every((flag) => helpEntries.some((line) => line.startsWith("  ./alz " + word + " ") && line.includes(flag)));
    if (key !== undefined && !helpKeys.includes(key) && !flagDocumented && !(spec.command && groups.has(spec.command.group))) {
      at(`cli "${spec.cli}" is not in the ./alz help text`);
    }
    for (const script of spec.npm ?? []) if (!input.scripts.includes(script)) at(`npm "${script}" is not a package.json script`);
    if (spec.cli.startsWith("npm run ") && !input.scripts.includes(spec.cli.split(/\s+/)[2])) at(`cli "${spec.cli}" is not a package.json script`);
    if (spec.cli.startsWith("npx tsx ") && !input.fileExists(spec.cli.split(/\s+/)[2])) at(`cli "${spec.cli}" names a missing file`);
    if (spec.command) {
      if (helpKeys.some((helpKey) => helpKey.split(" ")[0] === spec.command!.group)) at(`group "${spec.command.group}" shadows a legacy command`);
      if (!groups.has(spec.command.group)) at(`group "${spec.command.group}" is not listed in ./alz help`);
    }
    if (spec.job) {
      const source = "src/" + spec.job.script.replace(/\.js$/, ".ts");
      if (!input.fileExists(source)) at(`job script ${spec.job.script} has no ${source}`);
    }
    if (spec.safety === "HANDOFF" && (!spec.handoff?.reason.trim() || !spec.handoff.command.trim())) at("a handoff needs a reason and a command template");
    if (spec.safety === "HANDOFF" && spec.job) at("a handoff must not have a job");
    try {
      for (const args of sampleArgvs(spec)) assertSafeArgv(args);
    } catch {
      at("job argv can contain destroy, preview-only, apply or auto-approve");
    }
  }
  for (const script of input.scripts) {
    if (EXEMPT_SCRIPTS[script]) continue;
    const owners = input.catalog.filter((spec) => spec.npm?.includes(script) || spec.cli === "npm run " + script ||
      spec.cli.startsWith("npm run " + script + " "));
    if (owners.length !== 1) problems.push(`package.json script "${script}" maps to ${owners.length} catalog entries (need exactly 1)`);
  }
  for (const file of input.entryPoints) {
    if (EXEMPT_ENTRY_POINTS[file]) continue;
    const covered = input.catalog.some((spec) => spec.cliScript === "src/cli/" + file ||
      spec.job?.script === "cli/" + file.replace(/\.ts$/, ".js") || spec.cli.includes("src/cli/" + file));
    if (!covered) problems.push(`src/cli/${file} has no catalog entry`);
  }
  return problems;
}

const helpText = spawnSync(process.execPath, ["--import", "tsx", "src/cli/operator.ts", "help"], { encoding: "utf8" }).stdout;
const packageScripts = Object.keys((JSON.parse(readFileSync("package.json", "utf8")) as { scripts: object }).scripts);
const realInputs = (): Inputs => ({
  helpLines: helpText.split("\n"),
  scripts: packageScripts,
  entryPoints: readdirSync("src/cli").filter((file) => file.endsWith(".ts")),
  operatorCommands: [...readFileSync("src/cli/operator.ts", "utf8").matchAll(/command\s*===\s*"([^"]+)"/g)].map((match) => match[1]),
  catalog: OPERATIONS,
  fileExists: existsSync,
});

test("every ./alz command, operator script and src/cli entry point has exactly one catalog entry", () => {
  assert.match(helpText, /Operator commands/, "could not read the ./alz help text");
  assert.deepEqual(findProblems(realInputs()), []);
});

test("command keys cut at placeholders and expand alternatives", () => {
  assert.deepEqual(commandKeys("./alz inspect [aws|azure]"), ["inspect"]);
  assert.deepEqual(commandKeys("./alz target init <target-id> <owner>"), ["target init"]);
  assert.deepEqual(commandKeys("./alz teardown record|check-plan|orphans"), ["teardown record", "teardown check-plan", "teardown orphans"]);
  assert.deepEqual(commandKeys("./alz matrix --live-models [--scenario ID]"), ["matrix --live-models"]);
  assert.deepEqual(commandKeys("./alz health [--serve]"), ["health"]);
});

const spec = (overrides: Partial<OperationSpec>): OperationSpec => ({
  id: "probe", title: "Probe", summary: "A probe.", family: "evidence", cli: "./alz probe", safety: "READ_ONLY",
  inputs: [], evidenceBasis: "FIXTURE", job: { script: "cli/health.js", args: () => [] }, ...overrides,
});
const synthetic = (overrides: Partial<Inputs>): Inputs => ({
  helpLines: ["  ./alz probe"], scripts: ["probe:run"], entryPoints: ["probe.ts"], fileExists: () => true,
  catalog: [spec({ npm: ["probe:run"], cliScript: "src/cli/probe.ts" })], ...overrides,
});

test("the guard fails when a command, script or entry point is added without a catalog entry", () => {
  assert.deepEqual(findProblems(synthetic({})), []);
  assert.match(findProblems(synthetic({ helpLines: ["  ./alz probe", "  ./alz newcmd [x]"] })).join(), /"newcmd" maps to 0/);
  assert.match(findProblems(synthetic({ scripts: ["probe:run", "new:script"] })).join(), /"new:script" maps to 0/);
  assert.match(findProblems(synthetic({ entryPoints: ["probe.ts", "new-entry.ts"] })).join(), /new-entry\.ts has no catalog entry/);
  assert.match(findProblems(synthetic({ helpLines: ["  ./alz probe", "  ./alz probe --again"] })).join(), /"probe" maps to 2|"probe --again" maps to 0/);
});

test("the guard fails on an undocumented dispatcher branch or an npm script that does not exist", () => {
  assert.deepEqual(findProblems(synthetic({ operatorCommands: ["probe", "help"] })), []);
  assert.match(findProblems(synthetic({ operatorCommands: ["probe", "sneaky"] })).join(), /dispatches "sneaky"/);
  const ghost = synthetic({ catalog: [spec({ npm: ["probe:run", "ghost:script"], cliScript: "src/cli/probe.ts" })] });
  assert.match(findProblems(ghost).join(), /npm "ghost:script" is not a package.json script/);
  // The real dispatcher is scanned: the literal pattern must find real branches.
  assert.ok((realInputs().operatorCommands ?? []).includes("teardown"));
});

test("the guard checks a fixed flag in a cli form against the help line", () => {
  const withFlag = (cli: string, help: string[]) => findProblems(synthetic({
    helpLines: help, catalog: [spec({ npm: ["probe:run"], cliScript: "src/cli/probe.ts" }),
      spec({ id: "probe-flagged", cli, cliScript: "src/cli/probe.ts" })] })).join();
  assert.equal(withFlag("./alz probe --fixture", ["  ./alz probe [aws|azure] [--fixture]"]), "");
  assert.match(withFlag("./alz probe --bogus", ["  ./alz probe [aws|azure] [--fixture]"]), /not in the .\/alz help text/);
});

test("the guard fails on an invented cli form, a missing source, a bad handoff or a dangerous argv", () => {
  const withSpec = (overrides: Partial<OperationSpec>) => findProblems(synthetic({
    catalog: [spec({ npm: ["probe:run"], cliScript: "src/cli/probe.ts", ...overrides })] })).join();
  assert.match(withSpec({ cli: "./alz ghost" }), /not in the .\/alz help text/);
  assert.match(withSpec({ cli: "npm run ghost" }), /not a package.json script/);
  assert.match(synthetic({ fileExists: () => false }).catalog.length ? findProblems(synthetic({ fileExists: () => false })).join() : "", /has no src\/cli\/health\.ts/);
  assert.match(withSpec({ safety: "HANDOFF", job: undefined, handoff: { reason: "", command: "" } }), /needs a reason and a command/);
  assert.match(withSpec({ job: { script: "cli/health.js", args: () => ["--destroy"] } }), /destroy, preview-only/);
  assert.match(withSpec({ job: { script: "cli/health.js", args: () => ["--preview-only"] } }), /destroy, preview-only/);
  assert.match(withSpec({ job: { script: "cli/health.js", args: () => ["apply"] } }), /destroy, preview-only/);
  assert.match(withSpec({ job: { script: "cli/health.js", args: () => ["--auto-approve"] } }), /destroy, preview-only/);
  assert.match(withSpec({ command: { group: "probe", sub: "x" } }), /shadows a legacy command|not listed/);
});

test("the broker allowlist and the driver exclusion hold", () => {
  const posture = getToolSecurityPosture();
  assert.equal(posture.allowedTools.length, 49);
  // The two additions are read-only Control Tower operation status tools; the eight after them are the read-only cost
  // status reads (src/tools/aws-cost-reads.ts).
  assert.ok(posture.allowedTools.includes("aws_controltower_list_landing_zone_operations"));
  assert.ok(posture.allowedTools.includes("aws_controltower_get_landing_zone_operation"));
  assert.deepEqual(posture.mutationTools, []);
  assert.equal(posture.arbitraryShell, false);
  // No console-side or broker module imports the destroy-preview driver.
  for (const directory of ["src/tools", "src/operator-ui", "src/operations"]) {
    const walk = (path: string): string[] => readdirSync(path, { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory() ? walk(path + "/" + entry.name) : [path + "/" + entry.name]);
    for (const file of walk(directory).filter((name) => /\.tsx?$/.test(name))) {
      assert.doesNotMatch(readFileSync(file, "utf8"), /from\s+["'][^"']*teardown\/driver|from\s+["'][^"']*teardown-driver/, file);
    }
  }
});

/**
 * The build scripts' completion-marker contract, run with the real package.json scripts against a temporary checkout copy with
 * fake tsc, vite, tsx and git on PATH, so nothing real is built and the result does not depend on where the temp folder is.
 */
function scriptsRoot(label: string): { root: string; bin: string; npm: (script: string) => ReturnType<typeof spawnSync> } {
  const root = mkdtempSync(join(tmpdir(), "alz-build-scripts-" + label + "-"));
  const pkg = JSON.parse(readFileSync("package.json", "utf8")) as { scripts: Record<string, string> };
  const scripts = Object.fromEntries(["build", "build:runtime", "build:complete", "build:ui"].map((name) => [name, pkg.scripts[name]]));
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "fake", version: "0.0.0", scripts }));
  const bin = join(root, "fake-bin");
  mkdirSync(bin, { recursive: true });
  const tool = (name: string, body: string) => { writeFileSync(join(bin, name), "#!/bin/sh\n" + body + "\n"); chmodSync(join(bin, name), 0o755); };
  tool("git", 'echo "${FAKE_COMMIT:-c0ffee}"');
  tool("tsc", "mkdir -p dist/cli; echo compiled > dist/cli/operator.js; exit 0");
  tool("vite", "mkdir -p dist/operator-ui; echo ui > dist/operator-ui/index.html; exit 0");
  tool("tsx", "exit 0");
  // The fake bin comes first, so its tools shadow the real ones; npm itself comes from this test's own PATH.
  const env = { ...process.env, PATH: bin + ":" + (process.env.PATH ?? ""), HOME: root };
  return { root, bin, npm: (script) => spawnSync("npm", ["run", script], { cwd: root, encoding: "utf8", env }) };
}
const markerOf = (root: string): unknown => existsSync(join(root, "dist", ".alz-build-complete")) ? JSON.parse(readFileSync(join(root, "dist", ".alz-build-complete"), "utf8")) : undefined;

test("npm run build removes any old completion marker before compiling and writes one only after tsc succeeds; a failing compile leaves none", () => {
  const { root, bin, npm } = scriptsRoot("build");
  try {
    mkdirSync(join(root, "dist"), { recursive: true });
    writeFileSync(join(root, "dist", ".alz-build-complete"), JSON.stringify({ schemaVersion: 1, sourceCommit: "stale" }) + "\n");
    writeFileSync(join(bin, "tsc"), "#!/bin/sh\nmkdir -p dist; echo partial > dist/partial.js; exit 2\n");
    const failed = npm("build");
    assert.notEqual(failed.status, 0, failed.stdout + failed.stderr);
    assert.ok(existsSync(join(root, "dist", "partial.js")), "the failing compile still emitted");
    assert.equal(markerOf(root), undefined, "the stale marker is gone and no new one was written");
    writeFileSync(join(bin, "tsc"), "#!/bin/sh\nexit 0\n");
    const ok = npm("build");
    assert.equal(ok.status, 0, ok.stdout + ok.stderr);
    assert.deepEqual(markerOf(root), { schemaVersion: 1, sourceCommit: "c0ffee" }, "the marker names the checkout's commit (the fake git's), with no timestamp");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("npm run build:ui keeps a current completion marker across the UI build, restores it only after vite and prerender succeed, and a failing UI build leaves none", () => {
  const { root, bin, npm } = scriptsRoot("ui");
  try {
    assert.equal(npm("build").status, 0);
    assert.deepEqual(markerOf(root), { schemaVersion: 1, sourceCommit: "c0ffee" });
    // build, then build:ui: the marker is kept, byte for byte.
    const before = readFileSync(join(root, "dist", ".alz-build-complete"));
    const ui = npm("build:ui");
    assert.equal(ui.status, 0, ui.stdout + ui.stderr);
    assert.deepEqual(readFileSync(join(root, "dist", ".alz-build-complete")), before, "the same marker is back after the UI build");
    assert.ok(!existsSync(join(root, "dist", ".alz-build-ui.keep")), "the UI build's note to itself is gone");
    // build:ui with no marker (the Docker stage runs check before build) writes none.
    rmSync(join(root, "dist", ".alz-build-complete"));
    assert.equal(npm("build:ui").status, 0);
    assert.equal(markerOf(root), undefined);
    // A marker for another commit than the checkout's is not kept: the UI build cannot vouch for a stale runtime.
    writeFileSync(join(root, "dist", ".alz-build-complete"), JSON.stringify({ schemaVersion: 1, sourceCommit: "older" }) + "\n");
    assert.equal(npm("build:ui").status, 0);
    assert.equal(markerOf(root), undefined, "a stale marker is dropped, not restored");
    // A failing vite after a good build leaves no marker, and a failing prerender leaves none either.
    assert.equal(npm("build").status, 0);
    writeFileSync(join(bin, "vite"), "#!/bin/sh\nexit 3\n");
    assert.notEqual(npm("build:ui").status, 0);
    assert.equal(markerOf(root), undefined, "a failing vite leaves no marker");
    assert.equal(npm("build").status, 0);
    writeFileSync(join(bin, "vite"), "#!/bin/sh\nexit 0\n");
    writeFileSync(join(bin, "tsx"), "#!/bin/sh\nexit 4\n");
    assert.notEqual(npm("build:ui").status, 0);
    assert.equal(markerOf(root), undefined, "a failing prerender leaves no marker");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a failed UI build's leftover note never revives a marker and npm run build removes it; with no readable HEAD, build:ui keeps any well-formed marker, and with one it drops an unknown marker", () => {
  const { root, bin, npm } = scriptsRoot("keep");
  const keep = join(root, "dist", ".alz-build-ui.keep");
  try {
    assert.equal(npm("build").status, 0);
    // A failing vite leaves the UI build's note behind, with no marker.
    writeFileSync(join(bin, "vite"), "#!/bin/sh\nexit 3\n");
    assert.notEqual(npm("build:ui").status, 0);
    assert.equal(markerOf(root), undefined);
    assert.equal(readFileSync(keep, "utf8"), "c0ffee", "the failed UI build left its note");
    // The next UI build overwrites the note before reading it, so the leftover never brings a marker back.
    writeFileSync(join(bin, "vite"), "#!/bin/sh\nexit 0\n");
    assert.equal(npm("build:ui").status, 0);
    assert.equal(markerOf(root), undefined, "a leftover note does not revive a marker");
    assert.ok(!existsSync(keep));
    // npm run build removes a leftover note too, so a dist/ staged after a good build never carries one.
    writeFileSync(join(bin, "vite"), "#!/bin/sh\nexit 3\n");
    assert.equal(npm("build").status, 0);
    assert.notEqual(npm("build:ui").status, 0);
    assert.ok(existsSync(keep));
    writeFileSync(join(bin, "vite"), "#!/bin/sh\nexit 0\n");
    assert.equal(npm("build").status, 0);
    assert.ok(!existsSync(keep), "npm run build removes the failed UI build's note");
    assert.deepEqual(markerOf(root), { schemaVersion: 1, sourceCommit: "c0ffee" });
    // With HEAD known, a marker that says "unknown" is not a build of this commit: dropped (the launcher refuses it too).
    writeFileSync(join(root, "dist", ".alz-build-complete"), JSON.stringify({ schemaVersion: 1, sourceCommit: "unknown" }) + "\n");
    assert.equal(npm("build:ui").status, 0);
    assert.equal(markerOf(root), undefined, "an unknown marker is dropped when HEAD is known");
    // With no readable HEAD (no checkout, as in the Docker build stage), any well-formed marker is kept as it was.
    writeFileSync(join(bin, "git"), "#!/bin/sh\nexit 128\n");
    for (const commit of ["older", "unknown"]) {
      writeFileSync(join(root, "dist", ".alz-build-complete"), JSON.stringify({ schemaVersion: 1, sourceCommit: commit }) + "\n");
      assert.equal(npm("build:ui").status, 0);
      assert.deepEqual(markerOf(root), { schemaVersion: 1, sourceCommit: commit }, commit + ": kept when HEAD is unknown");
    }
    rmSync(join(root, "dist", ".alz-build-complete"));
    assert.equal(npm("build:ui").status, 0);
    assert.equal(markerOf(root), undefined, "with no marker, none is written");
    assert.equal(npm("build").status, 0);
    assert.deepEqual(markerOf(root), { schemaVersion: 1, sourceCommit: "unknown" }, "with no readable HEAD, the build's own marker says unknown");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
