import { homedir } from "node:os";

import { type CheckContext, type DepCheck, allRequiredPass, runDependencyChecks } from "../deps/checks.js";
import { InstallError, installTool, type InstalledTool } from "../deps/install.js";
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

/** `./alz deps`: the full report, then the install dialogs, but only in an interactive Terminal. */
export async function runDepsCommand(args: string[], deps: DepsDeps = {}): Promise<number> {
  const out = deps.out ?? ((text: string) => { process.stdout.write(text); });
  if (args.length > 0) {
    out("./alz deps takes no options. Run ./alz deps and answer the dialogs.\n");
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

  if (allRequiredPass(checks)) {
    out("\nAll required dependencies are ready.\n");
    return EXIT.PASS;
  }
  const platform = platformKey(ctx.platform, ctx.arch);
  const installable = checks.filter((check) => !check.ok && check.required && check.installable);
  if (!terminal.stdinIsTTY || !terminal.stdoutIsTTY) {
    out("\nRun ./alz deps in a Terminal window to install what is missing. Nothing was installed.\n");
    return EXIT.BLOCKED;
  }
  if (!platform) {
    out("\nAutomatic install is available for Macs only, for now. Use the steps shown above.\n");
    return EXIT.BLOCKED;
  }

  for (const check of installable) {
    const dialog = dialogFor(check, pins, platform, home);
    terminal.write(dialog.text);
    const answer = (await terminal.ask("> ")).trim();
    if (answer !== dialog.phrase) {
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

  checks = await runDependencyChecks(ctx, REQUIRED_FOR_DEPS);
  out("\nDependency check, after the dialogs\n\n");
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
