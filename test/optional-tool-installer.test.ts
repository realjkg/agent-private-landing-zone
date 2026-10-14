import assert from "node:assert/strict";
import test from "node:test";

import { OPTIONAL_TOOLS, installOptionalTool, type CommandRunner, type OptionalToolId } from "../src/onboarding/optional-tool-installer.js";
import { OPTIONAL_SCENARIOS, replayOptionalJourney, runAllOptionalJourneys } from "../src/onboarding/optional-tool-journeys.js";
import { runGuidedSetup } from "../src/onboarding/terminal.js";
import type { DepCheck } from "../src/deps/checks.js";
import type { HumanTerminal } from "../src/cli/teardown-driver.js";

function terminal(answers: string[], tty = true): HumanTerminal & { lines: string[]; count: number } {
  const lines: string[] = [];
  const t = {
    stdinIsTTY: tty, stdoutIsTTY: tty, lines, count: 0,
    write: (text: string) => { lines.push(text); },
    ask: async (prompt: string) => { t.count++; lines.push(prompt); return answers.shift() ?? "q"; },
  };
  return t;
}

test("all eight optional tools receive an installation journey for every failure branch", async () => {
  const matrix = await runAllOptionalJourneys();
  assert.equal(matrix.toolCount, 8);
  assert.equal(matrix.count, 8 * OPTIONAL_SCENARIOS.length);
  assert.match(matrix.sha256, /^[0-9a-f]{64}$/);
  assert.equal(matrix.count, new Set(matrix.results.map((r) => r.id + "/" + r.scenario)).size);
  assert.ok(matrix.results.every((r) =>
    r.realCommands === 0 && r.realNetworkCalls === 0 && r.realCloudCalls === 0 &&
    r.infrastructureMutations === 0 && r.evidenceBasis === "DISCONNECTED_OPTIONAL_INSTALL_FIXTURE"));
  const repeat = await runAllOptionalJourneys();
  assert.equal(repeat.sha256, matrix.sha256);
  for (const tool of OPTIONAL_TOOLS) {
    const positive = matrix.results.find((result) => result.id === tool.id && result.scenario === "READY")!;
    if (tool.route === "BREW") {
      assert.equal(positive.verdict, "INSTALLED_VERIFIED", tool.id);
      assert.equal(positive.simulatedInstallCalls, 1);
      assert.equal(positive.questionCount, 1);
      assert.deepEqual(positive.commandTrace, [
        "info --json=v2 --formula " + tool.formula,
        "list --versions --formula " + tool.formula,
        "install --formula " + tool.formula,
        "list --versions --formula " + tool.formula,
      ]);
      for (const [scenario, expected] of [
        ["CANCEL", "SKIPPED"], ["BREW_MISSING", "BREW_UNAVAILABLE"],
        ["DRIFT", "FORMULA_VERSION_MISMATCH"], ["MALFORMED", "FORMULA_INVALID"],
        ["WRONG_FORMULA", "FORMULA_INVALID"], ["ALREADY_INSTALLED", "ALREADY_INSTALLED"],
        ["INSTALL_FAILED", "INSTALL_FAILED"], ["POST_VERIFY_FAILED", "POST_VERIFY_FAILED"],
      ] as const) {
        const result = matrix.results.find((v) => v.id === tool.id && v.scenario === scenario)!;
        assert.equal(result.verdict, expected, tool.id + "/" + scenario);
      }
    } else {
      assert.equal(positive.verdict, "MANUAL_REVIEW", tool.id);
      assert.deepEqual(positive.commandTrace, []);
      assert.equal(positive.simulatedInstallCalls, 0);
    }
    const nonTty = matrix.results.find((v) => v.id === tool.id && v.scenario === "NO_TTY")!;
    assert.equal(nonTty.verdict, "NO_TTY");
    assert.equal(nonTty.simulatedInstallCalls, 0);
  }
});

test("Homebrew executable path and user input cannot be promoted to arbitrary shell execution", async () => {
  const item: OptionalToolId = "product:crossplane";
  const t = terminal(["INSTALL CROSSPLANE 2.5.0"]);
  await assert.rejects(() => installOptionalTool(item, {
    terminal: t, brewPath: "/tmp/malicious-brew", platform: "darwin", arch: "arm64",
    runner: () => { throw Error("should never run"); },
  }), /BREW_PATH_NOT_ALLOWLISTED/);
  await assert.rejects(() => installOptionalTool("product:__proto__" as OptionalToolId, {
    terminal: t, platform: "darwin", arch: "arm64",
    runner: () => { throw Error("should never run"); },
  }), /OPTIONAL_TOOL_NOT_CATALOGED/);
  const refused = await installOptionalTool(item, {
    terminal: t, platform: "linux", arch: "arm64",
    runner: () => { throw Error("should never run"); },
  });
  assert.equal(refused.verdict, "UNSUPPORTED_PLATFORM");
});

test("each missing optional tool is selectable from the actual terminal dependency menu", async () => {
  const checks: DepCheck[] = OPTIONAL_TOOLS.map((item) => ({
    id: item.id, label: item.label, required: false, ok: false, detail: "synthetic missing",
  }));
  for (let index = 0; index < OPTIONAL_TOOLS.length; index++) {
    const selected = OPTIONAL_TOOLS[index]!;
    const t = terminal(["3", "5", String(index + 1)]);
    let invoked = 0;
    const result = await runGuidedSetup({
      terminal: t, checks,
      installOptional: async (id) => {
        assert.equal(id, selected.id);
        invoked++;
        return { id, verdict: "SKIPPED", commandExecuted: false };
      },
    });
    assert.equal(invoked, 1, selected.id);
    assert.equal(result.openWorkspace, false);
    assert.match(t.lines.join(""), /SKIPPED/);
  }
});

test("missing engine prompts only for the selected needed optional tool, with explicit consent", async () => {
  const checks: DepCheck[] = [
    { id: "node", label: "Node 26", required: true, ok: true, detail: "fixture Node" },
    { id: "git", label: "Git", required: true, ok: true, detail: "fixture Git" },
    { id: "product:crossplane", label: "crossplane", required: false, ok: false, detail: "fixture missing" },
  ];
  // configure, staging, AWS, Crossplane, synthetic inference, decline install, decline UI
  const declines = terminal(["2", "2", "1", "7", "1", "n", "n"]);
  let invoked = 0;
  const result = await runGuidedSetup({
    terminal: declines, checks,
    installOptional: async () => { invoked++; return { id: "product:crossplane", verdict: "SKIPPED", commandExecuted: false }; },
  });
  assert.equal(invoked, 0);
  assert.equal(result.openWorkspace, false);
  assert.match(declines.lines.join(""), /Optional engine installation skipped/);
  const accepts = terminal(["2", "2", "1", "7", "1", "y", "n"]);
  await runGuidedSetup({
    terminal: accepts, checks,
    installOptional: async (id) => {
      assert.equal(id, "product:crossplane");
      invoked++;
      return { id, verdict: "INSTALLED_VERIFIED", commandExecuted: true, installedVersion: "2.5.0" };
    },
  });
  assert.equal(invoked, 1);
});

test("canceling optional selection never runs the package manager", async () => {
  const checks: DepCheck[] = [{
    id: "product:crossplane", label: "Crossplane", required: false, ok: false, detail: "missing",
  }];
  const t = terminal(["3", "5", "q"]);
  let invoked = 0;
  await runGuidedSetup({
    terminal: t, checks,
    installOptional: async () => { invoked++; throw Error("not permitted"); },
  });
  assert.equal(invoked, 0);
});
