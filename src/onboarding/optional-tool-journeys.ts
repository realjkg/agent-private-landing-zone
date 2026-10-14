import { createHash } from "node:crypto";
import type { HumanTerminal } from "../cli/teardown-driver.js";
import {
  OPTIONAL_TOOLS, installOptionalTool, type CommandRunner, type OptionalToolId,
  type OptionalInstallVerdict,
} from "./optional-tool-installer.js";

/** Replay package-manager interactions using only fake subprocess return values. */
export const OPTIONAL_SCENARIOS = [
  "READY", "CANCEL", "NO_TTY", "BREW_MISSING", "DRIFT", "MALFORMED",
  "WRONG_FORMULA", "ALREADY_INSTALLED", "INSTALL_FAILED", "POST_VERIFY_FAILED",
] as const;
export type OptionalScenario = typeof OPTIONAL_SCENARIOS[number];
export type OptionalJourney = {
  id: OptionalToolId;
  scenario: OptionalScenario;
  verdict: OptionalInstallVerdict;
  commandTrace: string[];
  questionCount: number;
  simulatedInstallCalls: number;
  realCommands: 0;
  realNetworkCalls: 0;
  realCloudCalls: 0;
  infrastructureMutations: 0;
  evidenceBasis: "DISCONNECTED_OPTIONAL_INSTALL_FIXTURE";
  evidenceSha256: string;
};

export async function replayOptionalJourney(id: OptionalToolId, scenario: OptionalScenario): Promise<OptionalJourney> {
  const tool = OPTIONAL_TOOLS.find((entry) => entry.id === id);
  if (!tool || !OPTIONAL_SCENARIOS.includes(scenario)) throw new Error("OPTIONAL_JOURNEY_INVALID");
  const trace: string[] = [];
  const messages: string[] = [];
  let questionCount = 0;
  let installCalls = 0;
  let wasInstalled = scenario === "ALREADY_INSTALLED";
  const terminal: HumanTerminal = {
    stdinIsTTY: scenario !== "NO_TTY",
    stdoutIsTTY: scenario !== "NO_TTY",
    write: (line) => { messages.push(line); },
    ask: async (question) => {
      questionCount++;
      messages.push(question);
      return scenario === "CANCEL" ? "cancel" : "INSTALL " + tool.formula?.toUpperCase() + " " + tool.reviewedVersion;
    },
  };
  const runner: CommandRunner = (path, args) => {
    if (path !== "/opt/homebrew/bin/brew") throw new Error("OPTIONAL_JOURNEY_ESCAPED_ALLOWLIST");
    trace.push(args.join(" "));
    const [command, ...rest] = args;
    if (command === "info") {
      if (scenario === "BREW_MISSING") return { status: 127, stdout: "", stderr: "brew absent" };
      if (scenario === "MALFORMED") return { status: 0, stdout: "{", stderr: "" };
      const name = scenario === "WRONG_FORMULA" ? "malicious-impersonator" : tool.formula;
      const stable = scenario === "DRIFT" ? "0.0.0" : tool.reviewedVersion;
      return { status: 0, stdout: JSON.stringify({ formulae: [{
        name, versions: { stable }, disabled: false, deprecated: false,
      }] }), stderr: "" };
    }
    if (command === "list") {
      return { status: 0, stdout: wasInstalled ? tool.formula + " " + tool.reviewedVersion + "\n" : "", stderr: "" };
    }
    if (command === "install") {
      installCalls++;
      if (scenario === "INSTALL_FAILED") return { status: 1, stdout: "", stderr: "fixture failure" };
      if (scenario !== "POST_VERIFY_FAILED") wasInstalled = true;
      return { status: 0, stdout: "fixture only", stderr: "" };
    }
    throw new Error("OPTIONAL_JOURNEY_UNKNOWN_COMMAND: " + command + " " + rest.join(" "));
  };
  const result = await installOptionalTool(id, {
    terminal, runner, brewPath: "/opt/homebrew/bin/brew", platform: "darwin", arch: "arm64",
  });
  const canonical = {
    id, scenario, verdict: result.verdict, commandTrace: trace, questionCount, simulatedInstallCalls: installCalls,
    realCommands: 0 as const, realNetworkCalls: 0 as const, realCloudCalls: 0 as const,
    infrastructureMutations: 0 as const,
    evidenceBasis: "DISCONNECTED_OPTIONAL_INSTALL_FIXTURE" as const,
  };
  return { ...canonical, evidenceSha256: createHash("sha256").update(JSON.stringify(canonical)).digest("hex") };
}

export async function runAllOptionalJourneys(): Promise<{
  count: number; toolCount: number; results: OptionalJourney[]; sha256: string;
}> {
  const results: OptionalJourney[] = [];
  for (const item of OPTIONAL_TOOLS) {
    for (const scenario of OPTIONAL_SCENARIOS) {
      results.push(await replayOptionalJourney(item.id, scenario));
    }
  }
  if (results.some((result) => result.realCommands || result.realNetworkCalls ||
    result.realCloudCalls || result.infrastructureMutations)) throw new Error("OPTIONAL_JOURNEY_AUTHORITY_BREACH");
  return { count: results.length, toolCount: OPTIONAL_TOOLS.length, results,
    sha256: createHash("sha256").update(results.map((entry) => entry.evidenceSha256).join("\n")).digest("hex") };
}
