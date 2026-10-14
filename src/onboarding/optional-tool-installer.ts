import { spawnSync } from "node:child_process";
import type { HumanTerminal } from "../cli/teardown-driver.js";

/** Exact ALZ dependency IDs, not arbitrary package names or user paths. */
export const OPTIONAL_TOOLS = [
  { id: "product:pulumi", label: "Pulumi", formula: "pulumi", reviewedVersion: "3.267.0", route: "REVIEW" },
  { id: "product:tofu", label: "OpenTofu", formula: "opentofu", reviewedVersion: "1.13.1", route: "BREW" },
  { id: "product:bicep", label: "Bicep", formula: null, reviewedVersion: "0.47.16", route: "MANUAL" },
  { id: "product:cdk", label: "AWS CDK", formula: "aws-cdk", reviewedVersion: "2.1144.0", route: "REVIEW" },
  { id: "product:crossplane", label: "Crossplane CLI", formula: "crossplane", reviewedVersion: "2.5.0", route: "BREW" },
  { id: "product:ansible-playbook", label: "Ansible", formula: "ansible", reviewedVersion: "2.21.5", route: "REVIEW" },
  { id: "product:trivy", label: "Trivy", formula: "trivy", reviewedVersion: "0.75.0", route: "BREW" },
  { id: "product:docker", label: "Docker", formula: null, reviewedVersion: "29.8.2", route: "MANUAL" },
] as const;
export type OptionalToolId = typeof OPTIONAL_TOOLS[number]["id"];
export type OptionalTool = typeof OPTIONAL_TOOLS[number];
export type OptionalInstallVerdict =
  | "INSTALLED_VERIFIED" | "ALREADY_INSTALLED" | "SKIPPED" | "NO_TTY"
  | "UNSUPPORTED_PLATFORM" | "MANUAL_REVIEW" | "BREW_UNAVAILABLE"
  | "FORMULA_VERSION_MISMATCH" | "FORMULA_INVALID" | "INSTALL_FAILED" | "POST_VERIFY_FAILED";
export type InstallResult = { id: OptionalToolId; verdict: OptionalInstallVerdict; installedVersion?: string; commandExecuted: boolean };
export type CommandResult = { status: number; stdout: string; stderr: string };
export type CommandRunner = (path: string, args: readonly string[]) => CommandResult;

function realRunner(path: string, args: readonly string[]): CommandResult {
  const result = spawnSync(path, [...args], {
    shell: false, encoding: "utf8", timeout: 180_000, maxBuffer: 64 * 1024,
    env: { ...process.env, HOMEBREW_NO_AUTO_UPDATE: "1", HOMEBREW_NO_INSTALL_CLEANUP: "1" },
  });
  return { status: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

export type OptionalInstallOptions = {
  terminal: HumanTerminal;
  /** Only absolute Homebrew locations reviewed for the Mac; never ambient PATH. */
  brewPath?: string;
  platform?: string;
  arch?: string;
  runner?: CommandRunner;
};

/**
 * Homebrew is an external package manager, not an ALZ checksum-pinned artifact.
 * Refuse installs unless a reviewed local formula version matches the adapter
 * qualification baseline, on a TTY with a unique human-typed confirmation.
 * Bicep/Azure tap, Ansible, Docker, CDK and Pulumi remain in review/manual mode.
 */
export async function installOptionalTool(id: OptionalToolId, options: OptionalInstallOptions): Promise<InstallResult> {
  const descriptor: OptionalTool | undefined = OPTIONAL_TOOLS.find((entry) => entry.id === id);
  if (!descriptor) throw new Error("OPTIONAL_TOOL_NOT_CATALOGED");
  const terminal = options.terminal;
  const base = { id, commandExecuted: false } as const;
  if (!terminal.stdinIsTTY || !terminal.stdoutIsTTY) return { ...base, verdict: "NO_TTY" };
  if ((options.platform ?? process.platform) !== "darwin" || !["arm64", "x64"].includes(options.arch ?? process.arch)) {
    terminal.write("Automatic optional installation is limited to reviewed macOS hardware.\n");
    return { ...base, verdict: "UNSUPPORTED_PLATFORM" };
  }
  if (descriptor.route !== "BREW") {
    terminal.write(descriptor.label + ": " +
      (descriptor.route === "MANUAL" ? "Needs a separate verified installer and runtime review." :
      "The upstream package/release and adapter-tested version require reconciliation.") +
      " No commands executed.\n");
    return { ...base, verdict: "MANUAL_REVIEW" };
  }
  const brew = options.brewPath ?? (process.arch === "arm64" ? "/opt/homebrew/bin/brew" : "/usr/local/bin/brew");
  if (!["/opt/homebrew/bin/brew", "/usr/local/bin/brew"].includes(brew)) throw new Error("BREW_PATH_NOT_ALLOWLISTED");
  const runner = options.runner ?? realRunner;
  const formula = descriptor.formula;
  const info = runner(brew, ["info", "--json=v2", "--formula", formula]);
  if (info.status !== 0) return { ...base, verdict: "BREW_UNAVAILABLE" };
  let parsed: unknown;
  try { parsed = JSON.parse(info.stdout); }
  catch { return { ...base, verdict: "FORMULA_INVALID" }; }
  const root = parsed as { formulae?: Array<{ name?: string; versions?: { stable?: string }; disabled?: boolean; deprecated?: boolean }> };
  const entry = root?.formulae?.[0];
  if (!entry || root.formulae?.length !== 1 || entry.name !== formula || !/^[0-9]+\.[0-9]+\.[0-9]+$/.test(entry.versions?.stable ?? "") ||
    entry.disabled === true || entry.deprecated === true) return { ...base, verdict: "FORMULA_INVALID" };
  if (entry.versions?.stable !== descriptor.reviewedVersion) {
    terminal.write(descriptor.label + ": Homebrew formula is " + entry.versions?.stable +
      "; reviewed ALZ baseline is " + descriptor.reviewedVersion + ". Install blocked until review.\n");
    return { ...base, verdict: "FORMULA_VERSION_MISMATCH" };
  }
  const list = runner(brew, ["list", "--versions", "--formula", formula]);
  const installed = list.status === 0 && list.stdout.trim().split(/\s+/)[0] === formula
    ? list.stdout.trim().split(/\s+/).slice(1) : [];
  if (installed.includes(descriptor.reviewedVersion)) {
    terminal.write(descriptor.label + ": reviewed formula already installed.\n");
    return { ...base, verdict: "ALREADY_INSTALLED", installedVersion: descriptor.reviewedVersion };
  }
  if (installed.length > 0) {
    terminal.write(descriptor.label + ": another version is installed. No upgrades or replacements are automatic.\n");
    return { ...base, verdict: "FORMULA_VERSION_MISMATCH" };
  }
  const phrase = "INSTALL " + formula.toUpperCase() + " " + descriptor.reviewedVersion;
  terminal.write("\nReviewed optional package: " + descriptor.label + "\n");
  terminal.write("Source: official Homebrew formula " + formula + " (formula release " + descriptor.reviewedVersion + ")\n");
  terminal.write("Effect: installs a third-party CLI through Homebrew; Homebrew executes its own reviewed formula and dependencies.\n");
  terminal.write("It is NOT a repository SHA-256-pinned standalone archive and does NOT install cloud controllers or authorize ACT.\n");
  terminal.write("Type exactly " + phrase + " to continue; anything else cancels.\n");
  if ((await terminal.ask("> ")) !== phrase) return { ...base, verdict: "SKIPPED" };
  const executed = runner(brew, ["install", "--formula", formula]);
  if (executed.status !== 0) {
    terminal.write(descriptor.label + " installation failed; review Homebrew's output before retrying.\n");
    return { id, verdict: "INSTALL_FAILED", commandExecuted: true };
  }
  const verified = runner(brew, ["list", "--versions", "--formula", formula]);
  const tokens = verified.stdout.trim().split(/\s+/);
  if (verified.status !== 0 || tokens[0] !== formula || !tokens.slice(1).includes(descriptor.reviewedVersion)) {
    terminal.write(descriptor.label + " cannot be verified at the reviewed version. It is not ready.\n");
    return { id, verdict: "POST_VERIFY_FAILED", commandExecuted: true };
  }
  terminal.write(descriptor.label + " installed with the reviewed formula version. Adapter/controller behavior is not qualified.\n");
  return { id, verdict: "INSTALLED_VERIFIED", installedVersion: descriptor.reviewedVersion, commandExecuted: true };
}
