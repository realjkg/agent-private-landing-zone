import { homedir } from "node:os";

import { installSelectedPinnedTools } from "../cli/deps.js";
import type { ToolId } from "../deps/pins.js";
import { OPTIONAL_TOOLS, installOptionalTool, type OptionalToolId, type InstallResult } from "./optional-tool-installer.js";

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
  /** Test seam. In production the existing approved-pin installer asks for an exact human phrase. */
  installPinned?: (tools: readonly ToolId[], terminal: HumanTerminal) => Promise<{ installed: ToolId[]; skipped: ToolId[] }>;
  /** Injected in tests so no package manager or network can run. */
  installOptional?: (id: OptionalToolId, terminal: HumanTerminal) => Promise<InstallResult>;
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
  let route = await menu(terminal, "What would you like to do?", ["tour", "configure", "dependencies"] as const, [
    "Open the local visual workspace (recommended)",
    "Choose provider, stage and infrastructure engine; inspect prerequisites",
    "Review required versus optional programs on this Mac",
  ]);
  if (!route) return { openWorkspace: false, openBrowser: false };
  const checks = options.checks ?? await (options.collectChecks ?? loadChecks)();
  const optionalInstaller = options.installOptional ?? ((id: OptionalToolId, selectedTerminal: HumanTerminal) =>
    installOptionalTool(id, { terminal: selectedTerminal }));
  const pinnedInstaller = options.installPinned ??
    ((tools: readonly ToolId[], selectedTerminal: HumanTerminal) =>
      installSelectedPinnedTools(tools, { terminal: selectedTerminal }));
  // A dependency report is not a dead end: navigate directly to setup,
  // approve a single supported pinned install, or launch the local UI.
  if (route === "dependencies") {
    terminal.write("\nInstalled programs\n");
    for (const check of checks) {
      terminal.write("  " + (check.ok ? "OK" : "MISSING") + " " + check.label +
        " — " + (["node", "git"].includes(check.id) ? "core required" : "optional for selected capabilities") +
        " — " + check.detail + "\n");
      if (!check.ok && check.fix) terminal.write("    How to fix: " + check.fix + "\n");
    }
    terminal.write("\nOnly approved Terraform/Ollama packages have checksum-pinned automatic installers. Nothing installed here yet.\n");
    const next = await menu(terminal, "Next step", ["configure", "install-pinned", "workspace", "exit", "install-optional"] as const, [
      "Choose environment, cloud and engine to calculate actual prerequisites",
      "Choose one missing pinned Terraform/Ollama tool (human approval required)",
      "Open the local UI; no tools are installed",
      "Exit without changing anything",
      "Review or install a selected optional CLI (Crossplane, OpenTofu, Trivy and others)",
    ]);
    if (!next || next === "exit") return { openWorkspace: false, openBrowser: false };
    if (next === "install-pinned") {
      const available = checks.filter((check) => !check.ok && (check.installable === "terraform" || check.installable === "ollama"));
      if (available.length === 0) {
        terminal.write("No missing checksum-pinned tools. Advanced tools require reviewed manual installation.\n");
      } else {
        const picked = await menu(terminal, "Choose pinned dependency", available.map((item) => item.installable as ToolId),
          available.map((item) => item.label + " — checksum-verified user-folder install"));
        if (!picked) return { openWorkspace: false, openBrowser: false };
        await pinnedInstaller([picked], terminal);
        terminal.write("Run ./alz deps or restart ./alz to verify detected versions.\n");
      }
      return { openWorkspace: false, openBrowser: false };
    }
    if (next === "install-optional") {
      const available = OPTIONAL_TOOLS.filter((tool) => checks.some((check) => check.id === tool.id && !check.ok));
      if (!available.length) {
        terminal.write("No missing optional tools detected. Installed tools are not upgraded automatically.\n");
        return { openWorkspace: false, openBrowser: false };
      }
      const selected = await menu(terminal, "Choose optional CLI to review", available.map((tool) => tool.id),
        available.map((tool) => tool.label + " — " + (tool.route === "BREW" ? "version-reviewed Homebrew formula" : "manual/security review required")));
      if (!selected) return { openWorkspace: false, openBrowser: false };
      const outcome = await optionalInstaller(selected, terminal);
      terminal.write("Optional CLI result: " + outcome.verdict + ". Run ./alz deps to re-check your local tools.\n");
      return { openWorkspace: false, openBrowser: false };
    }
    if (next === "workspace") {
      const consent = (await terminal.ask("Open the local browser automatically? [Y/n]: ")).trim().toLowerCase();
      return { openWorkspace: true, openBrowser: ["", "y", "yes"].includes(consent) };
    }
    route = "configure";
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
  for (const tool of plan.tools.filter((x) => x.status === "REQUIRED" && x.installed !== true && x.fix)) {
    terminal.write("  To resolve " + tool.label + ": " + tool.fix + "\n");
  }
  if (plan.blocked.length) terminal.write("Cannot qualify this plan yet: " + plan.blocked.join("; ") + "\n");
  terminal.write("No installation, cloud login, Terraform plan, or infrastructure change occurred.\n");
  terminal.write("For pinned core installs: ./alz deps. Other engines require separate reviewed installation.\n");
  const missingPinned = plan.tools.filter((x) => x.status === "REQUIRED" &&
    x.installed !== true && (x.id === "terraform" || x.id === "ollama"));
  if (missingPinned.length) {
    const answer = (await terminal.ask("Review and install missing pinned tools now? [y/N]: ")).trim().toLowerCase();
    if (answer === "y" || answer === "yes") {
      await pinnedInstaller(missingPinned.map((x) => x.id as ToolId), terminal);
      terminal.write("Re-run ./alz deps to verify the installation before running the selected engine.\n");
    } else terminal.write("Installation skipped. Missing requirements remain blocked.\n");
  }
  const requiredOptional = plan.tools.filter((item) => item.status === "REQUIRED" &&
    item.installed !== true && OPTIONAL_TOOLS.some((tool) => tool.id === item.id));
  if (requiredOptional.length) {
    const missing = requiredOptional[0]!;
    const answer = (await terminal.ask("Review selected missing optional engine " + missing.label + "? [y/N]: ")).trim().toLowerCase();
    if (answer === "y" || answer === "yes") {
      const outcome = await optionalInstaller(missing.id as OptionalToolId, terminal);
      terminal.write("Installation review: " + outcome.verdict + ". Re-run ./alz deps before using this engine.\n");
    } else terminal.write("Optional engine installation skipped. It remains unqualified.\n");
  }
  const launch = (await terminal.ask("Open local workspace on 127.0.0.1? [Y/n]: ")).trim().toLowerCase();
  if (!["", "y", "yes"].includes(launch)) {
    return { openWorkspace: false, openBrowser: false, selected };
  }
  const browser = (await terminal.ask("Also open your Mac browser automatically? [Y/n]: ")).trim().toLowerCase();
  return { openWorkspace: true, openBrowser: ["", "y", "yes"].includes(browser), selected };
}
