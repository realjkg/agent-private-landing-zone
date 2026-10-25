import { existsSync } from "node:fs";
import { homedir } from "node:os";

import { type CheckContext, type DepCheck, allRequiredPass, installedPath, runDependencyChecks } from "../deps/checks.js";
import { InstallError, installTool, type InstalledTool, removeInstalledTool } from "../deps/install.js";
import { loadToolPins, DEFAULT_PINS, platformKey, type ToolId, type ToolPins } from "../deps/pins.js";
import { EXIT, processTerminal, type HumanTerminal } from "./teardown-driver.js";

/**
 * `./alz deps`: checks what this app needs, and offers to install the pinned tools one at a time. Every install is a
 * dialog that names the file, its source and its checksum, and needs the exact phrase typed back. Nothing installs
 * without that, and a terminal that cannot answer (no interactive input) only reports. Pilot commands run the same checks
 * first and stop with the plain reason if something they need is missing.
 */
export type DepsDeps = {
  terminal?: HumanTerminal;
  home?: string;
  env?: NodeJS.ProcessEnv;
  platform?: string;
  arch?: string;
  nodeVersion?: string;
  pinsPath?: string;
  probe?: CheckContext["probe"];
  download?: Parameters<typeof installTool>[1]["download"];
  out?: (text: string) => void;
};

/** What `./alz deps` itself needs. The AWS CLI and the isolated service are reported but do not block it. */
const REQUIRED_FOR_DEPS: ReadonlySet<DepCheck["id"]> = new Set(["node", "terraform", "ollama", "git"]);

/** What each pilot command needs before it may start. */
export const REQUIRED_FOR_COMMAND = {
  apply: new Set<DepCheck["id"]>(["node", "terraform"]),
  "models-verify": new Set<DepCheck["id"]>(["node", "ollama"]),
} as const;

const TOOL_NAME: Record<ToolId, string> = { terraform: "Terraform", ollama: "Ollama" };

function context(deps: DepsDeps, pins: ToolPins): CheckContext {
  return {
    pins,
    home: deps.home ?? homedir(),
    env: deps.env ?? process.env,
    platform: deps.platform ?? process.platform,
    arch: deps.arch ?? process.arch,
    nodeVersion: deps.nodeVersion ?? process.versions.node,
    ...(deps.probe ? { probe: deps.probe } : {}),
  };
}

function render(checks: readonly DepCheck[], out: (text: string) => void): void {
  const line = (check: DepCheck) => {
    const status = check.ok ? "OK" : check.required ? "NEEDS ATTENTION" : "NOT NEEDED FOR THE PILOT";
    out(status + "  " + check.label + " — " + check.detail + "\n");
    if (!check.ok && check.fix) out("      " + check.fix + "\n");
  };
  const pilot = checks.filter((check) => !check.id.startsWith("product:"));
  const product = checks.filter((check) => check.id.startsWith("product:"));
  pilot.forEach(line);
  if (product.length > 0) {
    out("\nProduct tools (each is needed only by the feature that uses it; none blocks the pilot)\n");
    product.forEach(line);
  }
}

const FAILURE_TEXT: Record<InstallError["code"], string> = {
  INSTALL_NO_ARTIFACT: "This type of Mac has no pinned download yet. Install it by hand, using the steps shown above.",
  INSTALL_DOWNLOAD_FAILED: "The download did not finish. Check your internet connection, then run ./alz deps again.",
  INSTALL_CHECKSUM_MISMATCH: "The file that arrived did not match the checksum this app expects, so nothing was installed.",
  INSTALL_UNPACK_FAILED: "The download could not be unpacked, so nothing was installed. Run ./alz deps again.",
  INSTALL_BINARY_MISSING: "The download did not contain the expected program, so nothing was installed.",
  INSTALL_REMOVE_REFUSED: "That folder is not an app-installed copy, so nothing was removed.",
};

/** One install dialog: what, where, from where, how it is checked, and the exact phrase that confirms it. */
function dialogFor(check: DepCheck, pins: ToolPins, platform: string, home: string): { phrase: string; text: string } {
  const tool = check.installable as ToolId;
  const pin = pins.tools[tool];
  const artifact = pin.artifacts[platform as keyof typeof pin.artifacts];
  const phrase = "INSTALL " + tool.toUpperCase() + " " + pin.version;
  const host = artifact ? new URL(artifact.url).host : "no pinned source";
  return {
    phrase,
    text: [
      "",
      TOOL_NAME[tool] + " " + pin.version + " is needed and is not installed.",
      "  What: the tested version of " + TOOL_NAME[tool] + ", for this type of Mac.",
      "  Where: " + home + "/.alz/tools/" + tool + "/" + pin.version + " (your user folder; nothing else on this Mac changes).",
      "  From: " + host + ".",
      "  Checked: the download must match SHA-256 " + (artifact?.sha256 ?? "(none)") + " or it is thrown away.",
      "  Needs: no administrator password. Your PATH is not changed.",
      "To install, type exactly:  " + phrase,
      "Anything else skips it. Commands that need it stay blocked until it is installed.",
      "",
    ].join("\n"),
  };
}

/**
 * The selection screen: every missing pinned tool starts checked, a number toggles one, `a` checks all, `s` skips all,
 * Enter continues with what is checked, and `q` cancels before anything is downloaded. Returns null on cancel.
 */
export async function chooseInstalls(items: readonly DepCheck[], terminal: HumanTerminal): Promise<Set<ToolId> | null> {
  const selected = new Set(items.map((item) => item.installable as ToolId));
  const show = (): void => {
    const lines = items.map((item, index) => {
      const box = selected.has(item.installable as ToolId) ? "[x]" : "[ ]";
      return "  " + box + " " + (index + 1) + "  " + item.label + "  — " + (item.installable === "terraform" ? "needed for the pilot" : "needed for model runs");
    });
    terminal.write(["", "Choose what to install. Each one is still confirmed with its own phrase.", ...lines,
      "Type a number to toggle, a to check all, s to skip all, Enter to continue with the checked items, or q to cancel.", ""].join("\n"));
  };
  show();
  for (let round = 0; round < 50; round += 1) {
    const answer = (await terminal.ask("> ")).trim().toLowerCase();
    if (answer === "") return selected;
    if (answer === "q") return null;
    if (answer === "s") { selected.clear(); return selected; }
    if (answer === "a") { items.forEach((item) => selected.add(item.installable as ToolId)); show(); continue; }
    const index = /^\d+$/.test(answer) ? Number(answer) - 1 : -1;
    if (index < 0 || index >= items.length) {
      terminal.write("That is not a choice. Type a number, a, s, q, or press Enter.\n");
      continue;
    }
    const tool = items[index].installable as ToolId;
    if (selected.has(tool)) selected.delete(tool); else selected.add(tool);
    show();
  }
  return selected;
}

/** A numbered menu. The person picks a number; anything else asks again. `safe` is used if no answer ever comes. */
export async function askChoice(terminal: HumanTerminal, title: string, options: readonly string[], safe: number): Promise<number> {
  terminal.write(["", title, ...options.map((option, index) => "  " + (index + 1) + "  " + option), ""].join("\n"));
  for (let round = 0; round < 20; round += 1) {
    const answer = (await terminal.ask("> ")).trim();
    const choice = /^\d+$/.test(answer) ? Number(answer) : -1;
    if (choice >= 1 && choice <= options.length) return choice;
    terminal.write("That is not a choice. Type one of the numbers above.\n");
  }
  return safe;
}

/** Pinned tools this computer already has in the app's own folder, and so can remove. */
export function removableTools(pins: ToolPins, home: string, platform: string): Array<{ tool: ToolId; version: string; path: string }> {
  const found: Array<{ tool: ToolId; version: string; path: string }> = [];
  for (const tool of ["terraform", "ollama"] as const) {
    const pin = pins.tools[tool];
    const artifact = pin.artifacts[platform as keyof typeof pin.artifacts];
    if (!artifact) continue;
    const path = installedPath(home, tool, pin.version, artifact.binary);
    if (existsSync(path)) found.push({ tool, version: pin.version, path });
  }
  return found;
}

/** The install dialog as a menu: what, where, from where and how it is checked, then a numbered choice. */
function menuDialogFor(check: DepCheck, pins: ToolPins, platform: string, home: string): string {
  const tool = check.installable as ToolId;
  const pin = pins.tools[tool];
  const artifact = pin.artifacts[platform as keyof typeof pin.artifacts];
  const host = artifact ? new URL(artifact.url).host : "no pinned source";
  return [
    "",
    TOOL_NAME[tool] + " " + pin.version + " is needed and is not installed.",
    "  What: the tested version of " + TOOL_NAME[tool] + ", for this computer.",
    "  Where: " + home + "/.alz/tools/" + tool + "/" + pin.version + " (your user folder; nothing else on this computer changes).",
    "  From: " + host + ".",
    "  Checked: the download must match SHA-256 " + (artifact?.sha256 ?? "(none)") + " or it is thrown away.",
    "  Needs: no administrator password. Your PATH is not changed.",
  ].join("\n");
}

/** `./alz deps`: the report, then numbered menus for installing what is missing or removing a copy the app installed. */
export async function runDepsCommand(args: string[], deps: DepsDeps = {}): Promise<number> {
  const out = deps.out ?? ((text: string) => { process.stdout.write(text); });
  if (args.length > 0) {
    out("./alz deps takes no options. Run ./alz deps and choose from the menu.\n");
    return EXIT.ERROR;
  }
  const terminal = deps.terminal ?? processTerminal();
  const pinsPath = deps.pinsPath ?? DEFAULT_PINS;
  let pins: ToolPins;
  try {
    pins = loadToolPins(pinsPath);
  } catch {
    out("The tool pin file is missing or invalid, so nothing can be checked or installed. Ask the project owner to fix config/tool-pins.json.\n");
    return EXIT.ERROR;
  }
  const ctx = context(deps, pins);
  const home = ctx.home;
  let checks = await runDependencyChecks(ctx, REQUIRED_FOR_DEPS);
  out("Dependency check\n\n");
  render(checks, out);

  const platform = platformKey(ctx.platform, ctx.arch);
  const installable = checks.filter((check) => !check.ok && check.required && check.installable);
  const removable = platform ? removableTools(pins, home, platform) : [];
  if (!terminal.stdinIsTTY || !terminal.stdoutIsTTY) {
    if (allRequiredPass(checks)) {
      out("\nAll required dependencies are ready.\n");
      return EXIT.PASS;
    }
    out("\nRun ./alz deps in a Terminal window to install what is missing. Nothing was installed.\n");
    return EXIT.BLOCKED;
  }
  if (!platform) {
    out("\nAutomatic install is not available for this computer type yet. Use the steps shown above.\n");
    return allRequiredPass(checks) ? EXIT.PASS : EXIT.BLOCKED;
  }
  if (installable.length === 0 && removable.length === 0) {
    out(allRequiredPass(checks) ? "\nAll required dependencies are ready.\n" : "\nSome required dependencies need a manual step. Fix the items marked NEEDS ATTENTION, then run ./alz deps again.\n");
    return allRequiredPass(checks) ? EXIT.PASS : EXIT.BLOCKED;
  }

  const options: string[] = [];
  const actions: Array<"install" | "remove" | "none"> = [];
  if (installable.length > 0) { options.push("Install what is missing"); actions.push("install"); }
  if (removable.length > 0) { options.push("Remove a tool this app installed"); actions.push("remove"); }
  options.push("Do nothing"); actions.push("none");
  const choice = await askChoice(terminal, "What would you like to do?", options, options.length);
  const action = actions[choice - 1];

  if (action === "install") {
    const picks = await chooseInstalls(installable, terminal);
    if (picks === null) {
      out("\nCanceled. Nothing was installed.\n");
      return EXIT.BLOCKED;
    }
    for (const check of installable.filter((item) => picks.has(item.installable!))) {
      terminal.write(menuDialogFor(check, pins, platform, home));
      const decision = await askChoice(terminal, "Install it now?", ["Install it", "Skip it"], 2);
      if (decision !== 1) {
        out("Skipped " + check.label + ". Commands that need it stay blocked until it is installed.\n");
        continue;
      }
      try {
        const installed: InstalledTool = await installTool(check.installable!, { pins, home, platform, ...(deps.download ? { download: deps.download } : {}) });
        out((installed.reused ? "Already installed: " : "Installed: ") + installed.path + "\n");
      } catch (error) {
        const code = error instanceof InstallError ? error.code : "INSTALL_DOWNLOAD_FAILED";
        out(FAILURE_TEXT[code] + "\n");
      }
    }
  } else if (action === "remove") {
    const labels = removable.map((item) => TOOL_NAME[item.tool] + " " + item.version + " (" + item.path + ")");
    const pick = await askChoice(terminal, "Which one should be removed?", [...labels, "Cancel"], labels.length + 1);
    if (pick <= labels.length) {
      const item = removable[pick - 1];
      terminal.write("\n" + TOOL_NAME[item.tool] + " " + item.version + " will be removed from " + item.path + ". Nothing else on this computer changes. You can install it again from this menu.\n");
      const decision = await askChoice(terminal, "Remove it now?", ["Remove it", "Keep it"], 2);
      if (decision === 1) {
        try {
          const outcome = removeInstalledTool(home, item.tool, item.version);
          out(outcome === "removed" ? "Removed: " + item.path + "\n" : "Already removed: " + item.path + "\n");
        } catch (error) {
          const code = error instanceof InstallError ? error.code : "INSTALL_REMOVE_REFUSED";
          out(FAILURE_TEXT[code as InstallError["code"]] + "\n");
        }
      } else {
        out("Kept. Nothing was removed.\n");
      }
    } else {
      out("Nothing was removed.\n");
    }
  } else {
    out("\nNothing was changed.\n");
    return EXIT.PASS;
  }

  checks = await runDependencyChecks(ctx, REQUIRED_FOR_DEPS);
  out("\nDependency check, after your choices\n\n");
  render(checks, out);
  if (allRequiredPass(checks)) {
    out("\nAll required dependencies are ready.\n");
    return EXIT.PASS;
  }
  out("\nSome required dependencies are still missing. Fix the items marked NEEDS ATTENTION, then run ./alz deps again.\n");
  return EXIT.BLOCKED;
}

/**
 * Run before a pilot command. It never installs: it prints one line when everything it needs is ready, or the missing
 * items with their fixes and "run ./alz deps", and returns true when the command must not start.
 */
export async function blockedByDependencies(
  command: keyof typeof REQUIRED_FOR_COMMAND,
  deps: DepsDeps = {},
): Promise<boolean> {
  const out = deps.out ?? ((text: string) => { process.stderr.write(text); });
  let pins: ToolPins;
  try {
    pins = loadToolPins(deps.pinsPath ?? DEFAULT_PINS);
  } catch {
    out("Dependency check: the tool pin file is missing or invalid. Ask the project owner to fix config/tool-pins.json.\n");
    return true;
  }
  const checks = await runDependencyChecks(context(deps, pins), REQUIRED_FOR_COMMAND[command]);
  if (allRequiredPass(checks)) return false;
  const missing = checks.filter((check) => !check.ok && check.required);
  out("This command needs dependencies that are not ready:\n");
  for (const check of missing) out("  - " + check.label + ": " + check.fix + "\n");
  out("Run ./alz deps to fix them in a guided step. Nothing was started.\n");
  return true;
}

/**
 * TTY-only, selected pinned installer for the guided first-run workflow.
 * ALL network/archive behavior is delegated to the existing checksum-verified
 * installer; the terminal must type each tool's exact version phrase.
 * Optional third-party tools without pinned artifacts are never downloaded.
 */
export async function installSelectedPinnedTools(
  selected: readonly ToolId[],
  deps: DepsDeps = {},
): Promise<{ attempted: ToolId[]; installed: ToolId[]; skipped: ToolId[] }> {
  const result = { attempted: [] as ToolId[], installed: [] as ToolId[], skipped: [] as ToolId[] };
  const terminal = deps.terminal ?? processTerminal();
  if (!terminal.stdinIsTTY || !terminal.stdoutIsTTY) {
    terminal.write("A local interactive Terminal is required. No tools were installed.\n");
    return result;
  }
  const platform = platformKey(deps.platform ?? process.platform, deps.arch ?? process.arch);
  if (!platform) {
    terminal.write("Only approved, checksum-pinned macOS tools can be installed here. No tools were installed.\n");
    return result;
  }
  let pins: ToolPins;
  try { pins = loadToolPins(deps.pinsPath ?? DEFAULT_PINS); }
  catch {
    terminal.write("Pinned tool manifest missing or invalid. No tools were installed.\n");
    return result;
  }
  const ctx = context(deps, pins);
  const checks = await runDependencyChecks(ctx, new Set<DepCheck["id"]>(selected));
  const unique = [...new Set(selected)];
  for (const tool of unique) {
    if (tool !== "terraform" && tool !== "ollama") throw new Error("INSTALL_TOOL_NOT_PINNED");
    const check = checks.find((item) => item.id === tool);
    if (!check || check.ok) continue;
    if (check.installable !== tool) {
      terminal.write("No verified installer is available for " + tool + ".\n");
      result.skipped.push(tool);
      continue;
    }
    result.attempted.push(tool);
    const dialog = dialogFor(check, pins, platform, ctx.home);
    terminal.write(dialog.text);
    if ((await terminal.ask("> ")).trim() !== dialog.phrase) {
      terminal.write("Skipped " + tool + ": exact approval was not supplied.\n");
      result.skipped.push(tool);
      continue;
    }
    try {
      const installed = await installTool(tool, {
        pins, home: ctx.home, platform,
        ...(deps.download ? { download: deps.download } : {}),
      });
      // A cached binary might exist at the pinned location but no longer report
      // the pinned version. Never treat "reused" as proof of health.
      const checked = await runDependencyChecks(ctx, new Set<DepCheck["id"]>([tool]));
      if (checked.find((item) => item.id === tool)?.ok !== true) {
        terminal.write("Pinned " + tool + " still failed verification after installation; do not continue.\n");
        result.skipped.push(tool);
        continue;
      }
      terminal.write("Verified pinned " + tool + " installed at " + installed.path + "\n");
      result.installed.push(tool);
    } catch (error) {
      const reason = error instanceof InstallError ? FAILURE_TEXT[error.code] : FAILURE_TEXT.INSTALL_DOWNLOAD_FAILED;
      terminal.write(reason + "\n");
      result.skipped.push(tool);
    }
  }
  return result;
}
