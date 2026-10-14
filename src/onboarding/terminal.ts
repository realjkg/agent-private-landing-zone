import { homedir } from "node:os";

import { runDependencyChecks, type DepCheck } from "../deps/checks.js";
import { loadToolPins } from "../deps/pins.js";
import type { HumanTerminal } from "../cli/teardown-driver.js";
import {
  ENGINES, PROVIDERS, STAGES, PROVIDER_HELP, STAGE_HELP, planSetup,
  type LandingEngine, type LandingProvider, type DeploymentStage, type SetupIntent,
} from "./plan.js";

export type SetupOutcome = { openWorkspace: boolean; openBrowser: boolean; selected?: SetupIntent };
export type SetupOptions = {
  terminal: HumanTerminal;
  checks?: readonly DepCheck[];
  /** Injected for deterministic tests; no subprocess/network is launched by this module. */
  collectChecks?: () => Promise<readonly DepCheck[]>;
};

async function menu<T extends string>(
  terminal: HumanTerminal, title: string, options: readonly T[], hints: readonly string[],
): Promise<T | null> {
  terminal.write("\n" + title + "\n");
  for (let i = 0; i < options.length; i++) {
    terminal.write("  " + (i + 1) + ". " + options[i] + (hints[i] ? " — " + hints[i] : "") + "\n");
  }
  terminal.write("  q. Return without making changes\n");
  for (let attempts = 0; attempts < 3; attempts++) {
    const answer = (await terminal.ask("Choice [1]: ")).trim().toLowerCase();
    if (answer === "q") return null;
    const value = answer === "" ? 1 : Number(answer);
    if (Number.isInteger(value) && value >= 1 && value <= options.length) return options[value - 1];
    terminal.write("Choose one of the listed numbers.\n");
  }
  terminal.write("Too many invalid entries; no action taken.\n");
  return null;
}

const loadChecks = async (): Promise<readonly DepCheck[]> => {
  const pins = loadToolPins();
  return runDependencyChecks({
    pins, home: homedir(), env: process.env, platform: process.platform,
    arch: process.arch, nodeVersion: process.versions.node,
  }, new Set(["node", "git"]));
};

export async function runGuidedSetup(options: SetupOptions): Promise<SetupOutcome> {
  const terminal = options.terminal;
  if (!terminal.stdinIsTTY || !terminal.stdoutIsTTY) {
    terminal.write("Interactive setup requires a local Terminal. Run ./alz help for commands.\n");
    return { openWorkspace: false, openBrowser: false };
  }
  terminal.write("\nSOVEREIGN ALZ — Guided start\n");
  terminal.write("Private by default • Preview/Operate only • ACT disabled\n");
  const route = await menu(terminal, "What would you like to do?", ["tour", "configure", "dependencies"] as const, [
    "Open the local visual workspace (recommended)",
    "Choose provider, stage and infrastructure engine; inspect prerequisites",
    "Review required versus optional programs on this Mac",
  ]);
  if (!route) return { openWorkspace: false, openBrowser: false };
  const checks = options.checks ?? await (options.collectChecks ?? loadChecks)();
  if (route === "dependencies") {
    terminal.write("\nInstalled programs\n");
    for (const check of checks) {
      terminal.write("  " + (check.ok ? "OK" : "MISSING") + " " + check.label +
        " — " + (check.required ? "core required" : "optional for selected capabilities") + "\n");
    }
    terminal.write("\nPinned Terraform/Ollama installer: ./alz deps. Nothing installed here.\n");
    return { openWorkspace: false, openBrowser: false };
  }
  let selected: SetupIntent = { stage: "development", provider: "aws", engine: "terraform", localModels: false };
  if (route === "configure") {
    const stage = await menu(terminal, "Target environment (planning only)", STAGES, STAGES.map((s) => STAGE_HELP[s]));
    if (!stage) return { openWorkspace: false, openBrowser: false };
    const provider = await menu(terminal, "Target platform", PROVIDERS, PROVIDERS.map((p) => PROVIDER_HELP[p]));
    if (!provider) return { openWorkspace: false, openBrowser: false };
    const engine = await menu(terminal, "Infrastructure engine", ENGINES, [
      "General-purpose IaC", "Language-based IaC", "Terraform-compatible IaC", "Azure-native",
      "AWS-native", "AWS CDK", "Kubernetes control-plane compositions", "Host configuration",
    ]);
    if (!engine) return { openWorkspace: false, openBrowser: false };
    const inference = await menu(terminal, "Private inference", ["offline", "local-models"] as const, [
      "Synthetic fixtures, no model runtime needed",
      "Optional Qwen/Mistral on local Ollama; no cloud inference",
    ]);
    if (!inference) return { openWorkspace: false, openBrowser: false };
    selected = { stage: stage as DeploymentStage, provider: provider as LandingProvider,
      engine: engine as LandingEngine, localModels: inference === "local-models" };
  }
  const plan = planSetup(selected, checks, { offlineTour: route === "tour" });
  terminal.write("\nYour plan: " + selected.stage + " / " + selected.provider.toUpperCase() +
    " / " + selected.engine.toUpperCase() + "\n");
  terminal.write("  " + plan.notice + "\n");
  terminal.write("Required dependencies for this selection:\n");
  for (const tool of plan.tools.filter((x) => x.status === "REQUIRED")) {
    terminal.write("  " + (tool.installed ? "OK" : "NEEDS ATTENTION") + " " + tool.label + " — " + tool.detail + "\n");
  }
  terminal.write("Optional integrations (never silently installed):\n");
  for (const tool of plan.tools.filter((x) => x.status === "OPTIONAL")) {
    terminal.write("  " + (tool.installed ? "OK" : "OPTIONAL") + " " + tool.label + "\n");
  }
  if (plan.blocked.length) terminal.write("Cannot qualify this plan yet: " + plan.blocked.join("; ") + "\n");
  terminal.write("No installation, cloud login, Terraform plan, or infrastructure change occurred.\n");
  terminal.write("For pinned core installs: ./alz deps. Other engines require separate reviewed installation.\n");
  const launch = (await terminal.ask("Open local workspace on 127.0.0.1? [Y/n]: ")).trim().toLowerCase();
  if (!["", "y", "yes"].includes(launch)) {
    return { openWorkspace: false, openBrowser: false, selected };
  }
  const browser = (await terminal.ask("Also open your Mac browser automatically? [Y/n]: ")).trim().toLowerCase();
  return { openWorkspace: true, openBrowser: ["", "y", "yes"].includes(browser), selected };
}
