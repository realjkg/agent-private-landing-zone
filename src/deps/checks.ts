import { execFileSync } from "node:child_process";
import { lstatSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createConnection } from "node:net";
import { join } from "node:path";

import { PLUGIN_CATALOG } from "../plugins/catalog.js";
import { platformKey, type Platform, type ToolId, type ToolPins } from "./pins.js";

/**
 * Read-only dependency checks for `./alz deps` and the automatic check at pilot entry points. Nothing here installs,
 * starts, pulls or changes anything. A check says what is wrong in plain words, and names the one action that fixes it.
 */
export type DepCheck = {
  /** A fixed id for the pilot checks, or `product:<executable>` for a product tool derived from the plugin catalog. */
  id: "node" | ToolId | "isolated-service" | "aws-cli" | "git" | `product:${string}`;
  label: string;
  /** Needed for the command being run. Optional checks are reported but never block it. */
  required: boolean;
  ok: boolean;
  detail: string;
  /** The one plain sentence that fixes a failure. Absent when the check passed. */
  fix?: string;
  /** Set when `./alz deps` can install this tool itself, after a yes from the person. */
  installable?: ToolId;
};

export type ServiceProbe = { listening: boolean; models?: string[]; apiOk: boolean };

export type CheckContext = {
  pins: ToolPins;
  /** The person's home folder: installs live in ~/.alz/tools. */
  home: string;
  env: NodeJS.ProcessEnv;
  platform: string;
  arch: string;
  nodeVersion: string;
  /** Looks at the isolated service's port. Injected so tests never touch a real service. */
  probe?: (host: string, port: number) => Promise<ServiceProbe>;
};

/** Where `./alz deps` puts a pinned tool. The app's own copy is always looked at before PATH. */
export function installedPath(home: string, tool: ToolId, version: string, binary: string): string {
  return join(home, ".alz", "tools", tool, version, binary);
}

/**
 * The completion marker an install writes as its last step before the version folder is put in place, and the marker a
 * removal writes first. A version folder is an install only with a valid completion marker beside its program; a folder
 * with the program and no marker was installed before completion checks existed (reported, never read as verified and never
 * removed on its own); any other folder is unfinished (an interrupted install or removal) and is replaced or finished, never
 * read as an install.
 */
export const INSTALL_MARKER = ".alz-installed.json";
export const REMOVING_MARKER = ".alz-removing";
export type InstallMarker = { schemaVersion: 1; tool: ToolId; version: string; binary: string; sha256: string; completedAt: string };
export type InstallState = "INSTALLED" | "LEGACY" | "UNFINISHED" | "REMOVING" | "ABSENT";
/** The plain words for a state that is not an install, as every check and menu says them. */
export const INSTALL_STATE_WORDS: Readonly<Record<Exclude<InstallState, "INSTALLED" | "ABSENT">, string>> = {
  LEGACY: "installed before completion checks, not verified",
  UNFINISHED: "an earlier install did not finish",
  REMOVING: "an earlier removal did not finish",
};

/** The real folder at home/<components...>, or undefined when any step below the home is missing, a link or not a folder. */
export function realFolder(home: string, components: readonly string[]): string | undefined {
  let dir = home;
  for (const component of components) {
    dir = join(dir, component);
    try {
      const entry = lstatSync(dir);
      if (entry.isSymbolicLink() || !entry.isDirectory()) return undefined;
    } catch { return undefined; }
  }
  return dir;
}

/** The completion marker in `folder`, when it is valid for this tool, version and program. */
export function readInstallMarker(folder: string, tool: ToolId, version: string, binary: string): InstallMarker | undefined {
  try {
    const value = JSON.parse(readFileSync(join(folder, INSTALL_MARKER), "utf8")) as unknown;
    if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
    const marker = value as Record<string, unknown>;
    if (marker.schemaVersion !== 1 || marker.tool !== tool || marker.version !== version || marker.binary !== binary ||
      typeof marker.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(marker.sha256) || typeof marker.completedAt !== "string" || Number.isNaN(Date.parse(marker.completedAt))) return undefined;
    return marker as InstallMarker;
  } catch { return undefined; }
}

/** What the version folder of `tool` holds, read without following links. */
export function installState(home: string, tool: ToolId, version: string, binary: string): InstallState {
  const folder = realFolder(home, [".alz", "tools", tool, version]);
  if (folder === undefined) return "ABSENT";
  const has = (name: string): boolean => { try { return lstatSync(join(folder, name)).isFile(); } catch { return false; } };
  if (has(REMOVING_MARKER)) return "REMOVING";
  const program = has(binary);
  if (program && readInstallMarker(folder, tool, version, binary) !== undefined) return "INSTALLED";
  if (program && !has(INSTALL_MARKER)) return "LEGACY";
  return "UNFINISHED";
}

/** Every version-named folder of `tool` the app's folder holds, newest first, with what each is. */
export function appInstallStates(home: string, tool: ToolId, binary: string): { version: string; state: Exclude<InstallState, "ABSENT"> }[] {
  const dir = realFolder(home, [".alz", "tools", tool]);
  if (dir === undefined) return [];
  const parts = (version: string) => version.split(".").map(Number);
  return readdirSync(dir).filter((name) => /^\d+\.\d+\.\d+$/.test(name))
    .map((version) => ({ version, state: installState(home, tool, version, binary) }))
    .filter((item): item is { version: string; state: Exclude<InstallState, "ABSENT"> } => item.state !== "ABSENT")
    .sort((a, b) => { const [x, y] = [parts(a.version), parts(b.version)]; return (y[0]! - x[0]!) || (y[1]! - x[1]!) || (y[2]! - x[2]!); });
}

/** Reads the version `binary` reports, through the same command every check uses, or undefined when it cannot run or does not say. */
export function reportedVersion(tool: ToolId, binary: string): string | undefined {
  const version = TOOL_VERSION_ARGS[tool];
  return version.pattern.exec(versionText(binary, version.args) ?? "")?.[1];
}

/**
 * The versions of `tool` this app installed, newest first: `~/.alz/tools/<tool>/<version>` folders that hold the program,
 * installed (with a completion marker) or installed before completion checks existed. Only real folders count (no link on
 * the way from the home folder), named like a pinned version, so an unfinished `<version>.partial-<pid>` folder, an
 * interrupted install or removal, or anything a person put there is never mistaken for an install.
 */
export function appInstalledVersions(home: string, tool: ToolId, binary: string): string[] {
  return appInstallStates(home, tool, binary).filter((item) => item.state === "INSTALLED" || item.state === "LEGACY").map((item) => item.version);
}

/** The first executable named `name` on PATH, but never inside the app's own folder (that copy is checked separately). */
function onPath(name: string, env: NodeJS.ProcessEnv): string | undefined {
  for (const dir of (env.PATH ?? "").split(":").filter(Boolean)) {
    const candidate = join(dir, name);
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // Not in this directory.
    }
  }
  return undefined;
}

/** Runs `<binary> <args>` with a short timeout and returns its text, or undefined when it cannot run. */
function versionText(binary: string, args: string[]): string | undefined {
  try {
    return execFileSync(binary, args, { encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "pipe"] });
  } catch {
    return undefined;
  }
}

const TOOL_VERSION_ARGS: Record<ToolId, { args: string[]; pattern: RegExp }> = {
  terraform: { args: ["version"], pattern: /Terraform v(\d+\.\d+\.\d+)/ },
  ollama: { args: ["--version"], pattern: /(\d+\.\d+\.\d+)/ },
};

const TOOL_LABEL: Record<ToolId, string> = { terraform: "Terraform", ollama: "Ollama" };

function toolCheck(tool: ToolId, ctx: CheckContext, required: boolean, platform: Platform | undefined): DepCheck {
  const pin = ctx.pins.tools[tool];
  const artifact = platform ? pin.artifacts[platform] : undefined;
  const label = TOOL_LABEL[tool] + " " + pin.version;
  const own = artifact ? installedPath(ctx.home, tool, pin.version, artifact.binary) : undefined;
  const ownState = artifact ? installState(ctx.home, tool, pin.version, artifact.binary) : "ABSENT";
  const installable = artifact ? tool : undefined;
  const previous = artifact ? appInstalledVersions(ctx.home, tool, artifact.binary).filter((version) => version !== pin.version) : [];
  const update = previous.length > 0
    ? "Run ./alz deps and choose Update to replace the app's " + TOOL_LABEL[tool] + " " + previous[0] + " with the tested " + pin.version + "."
    : undefined;
  // The app's own folder for the pinned version, when it is there but not a finished, checked install: said plainly, with the one
  // step that repairs it. A legacy copy is never read as verified and never removed on its own; an unfinished one is replaced.
  if (ownState === "LEGACY") {
    return {
      id: tool, label, required, ok: false, installable, detail: INSTALL_STATE_WORDS.LEGACY + " (" + own + ")",
      fix: "Run ./alz deps and choose Repair: it installs the tested " + TOOL_LABEL[tool] + " " + pin.version + " beside this copy and switches to it only after the check passes.",
    };
  }
  if (ownState === "UNFINISHED" || ownState === "REMOVING") {
    return {
      id: tool, label, required, ok: false, installable, detail: INSTALL_STATE_WORDS[ownState] + " (" + own + ")",
      fix: ownState === "REMOVING" ? "Run ./alz deps and choose Remove to finish removing it, or Install to replace it."
        : "Run ./alz deps and choose Install: it replaces the unfinished folder with a checked copy.",
    };
  }
  const found = own && ownState === "INSTALLED" ? own : onPath(tool, ctx.env);
  if (!found) {
    return {
      id: tool, label, required, ok: false, installable,
      detail: previous.length > 0 ? "not found; this app installed " + previous.join(", ") + " before" : "not found",
      fix: update ?? (installable
        ? "Run ./alz deps and choose Install to add it to your user folder."
        : "Install " + TOOL_LABEL[tool] + " " + pin.version + " yourself, then open a new Terminal window."),
    };
  }
  const version = TOOL_VERSION_ARGS[tool];
  const text = versionText(found, version.args) ?? "";
  const reported = version.pattern.exec(text)?.[1];
  if (reported !== pin.version) {
    return {
      id: tool, label, required, ok: false, installable,
      detail: "found " + (reported ?? "an unreadable version") + " at " + found,
      fix: update ?? (installable
        ? "Run ./alz deps and choose Install to add the tested " + TOOL_LABEL[tool] + " " + pin.version + " to your user folder. It will be used before any other copy."
        : "Install " + TOOL_LABEL[tool] + " " + pin.version + ", the tested version."),
    };
  }
  return { id: tool, label, required, ok: true, detail: "installed at " + found };
}

/**
 * Check-only tools: reported with exact steps, never installed. The AWS CLI's macOS installer needs an administrator
 * password and its checksum is not pinned here; Git is the operator's own.
 */
function presenceCheck(id: "aws-cli" | "git", label: string, args: string[], pattern: RegExp, required: boolean, fix: string, env: NodeJS.ProcessEnv): DepCheck {
  const found = onPath(id === "aws-cli" ? "aws" : "git", env);
  const reported = found ? pattern.exec(versionText(found, args) ?? "")?.[1] : undefined;
  if (!reported) return { id, label, required, ok: false, detail: found ? "found, but its version could not be read" : "not found", fix };
  return { id, label, required, ok: true, detail: "version " + reported + " at " + found };
}

/** Looks at the isolated service's port: nothing listening is fine, a listener that is not Ollama is a blocker. */
async function serviceCheck(ctx: CheckContext, required: boolean): Promise<DepCheck> {
  const { host, port, models } = ctx.pins.isolatedOllama;
  const probe = ctx.probe ?? defaultProbe;
  const state = await probe(host, port);
  const label = "Isolated Ollama service (port " + port + ")";
  if (!state.listening) {
    return { id: "isolated-service", label, required, ok: true, detail: "not running, which is fine until you start it" };
  }
  if (!state.apiOk || !state.models) {
    return {
      id: "isolated-service", label, required, ok: false,
      detail: "something other than Ollama is using port " + port,
      fix: "Find it with: lsof -i :" + port + "  then stop that program, or pick another port for this check.",
    };
  }
  const missing = models.filter((model) => !state.models!.includes(model));
  if (missing.length > 0) {
    return {
      id: "isolated-service", label, required, ok: false,
      detail: "missing model: " + missing.join(", "),
      fix: "On this Mac only (dry run), add the missing model: OLLAMA_HOST=" + host + ":" + port + " ollama pull " + missing[0] + ". Target hardware never downloads models.",
    };
  }
  return { id: "isolated-service", label, required, ok: true, detail: "running, with all " + models.length + " models" };
}

function defaultProbe(host: string, port: number): Promise<ServiceProbe> {
  return new Promise((resolve) => {
    const socket = createConnection({ host, port, timeout: 1500 });
    socket.once("error", () => { socket.destroy(); resolve({ listening: false, apiOk: false }); });
    socket.once("timeout", () => { socket.destroy(); resolve({ listening: false, apiOk: false }); });
    socket.once("connect", () => {
      socket.destroy();
      fetch("http://" + host + ":" + port + "/api/tags", { signal: AbortSignal.timeout(3000) })
        .then(async (response) => {
          const body = (await response.json()) as { models?: Array<{ name?: string }> };
          const names = (body.models ?? []).map((item) => item.name ?? "");
          resolve({ listening: true, apiOk: true, models: names });
        })
        .catch(() => resolve({ listening: true, apiOk: false }));
    });
  });
}

/** Programs the pilot checks already report on their own rows; the product list never repeats them. */
const PILOT_EXECUTABLES: ReadonlySet<string> = new Set(["terraform", "ollama", "aws", "git"]);

/** The first x.y.z in a catalog version, or undefined for a date-style API version such as 2010-05-15 (never compared). */
const semver = (text: string | undefined): string | undefined => (text ? /(\d+\.\d+\.\d+)/.exec(text)?.[1] : undefined);

/** Product tools from the plugin catalog, plus the scan and container tools. Never required by the pilot. */
const EXTRA_PRODUCT_TOOLS: ReadonlyArray<{ executable: string; testedVersion?: string; why: string; vendor: string }> = [
  { executable: "trivy", why: "./alz scan", vendor: "https://trivy.dev (Homebrew: brew install trivy)" },
  { executable: "docker", why: "the optional container scripts (scripts/alz-docker.sh)", vendor: "https://docs.docker.com/desktop/setup/install/mac-install/" },
];

/**
 * Product tools: needed by the feature that uses them, never by the pilot. Derived from the plugin catalog so a new
 * adapter appears here by itself. Each is presence-checked and, where a tested version is recorded, version-compared.
 */
export function productChecks(ctx: CheckContext): DepCheck[] {
  const seen = new Set<string>();
  const rows: Array<{ executable: string; testedVersion?: string; why: string; vendor: string }> = [];
  for (const plugin of PLUGIN_CATALOG) {
    if (!plugin.executable || seen.has(plugin.executable) || PILOT_EXECUTABLES.has(plugin.executable)) continue;
    seen.add(plugin.executable);
    rows.push({ executable: plugin.executable, ...(plugin.testedVersion ? { testedVersion: plugin.testedVersion } : {}),
      why: plugin.id.toLowerCase().replace(/_/g, " ") + " adapter", vendor: plugin.versionSource });
  }
  for (const extra of EXTRA_PRODUCT_TOOLS) {
    if (!seen.has(extra.executable) && !PILOT_EXECUTABLES.has(extra.executable)) rows.push(extra);
  }
  return rows.map((row): DepCheck => {
    const id = ("product:" + row.executable) as `product:${string}`;
    const tested = semver(row.testedVersion);
    const found = onPath(row.executable, ctx.env);
    if (!found) {
      return { id, label: row.executable, required: false, ok: false, detail: "not found (needed for " + row.why + ")",
        fix: "Install " + row.executable + " from " + row.vendor + ", then open a new Terminal window." };
    }
    const text = versionText(found, ["--version"]) ?? versionText(found, ["version"]) ?? "";
    const reported = semver(text);
    if (tested && reported !== tested) {
      return { id, label: row.executable, required: false, ok: false,
        detail: "found " + (reported ?? "an unreadable version") + ", tested with " + tested + " (" + row.why + " may still work)",
        fix: "Optional: install " + row.executable + " " + tested + " from " + row.vendor + " to match the tested version." };
    }
    return { id, label: row.executable, required: false, ok: true, detail: (reported ?? "present") + " at " + found };
  });
}

/** Every check the app knows about, in the order a person should fix them. */
export async function runDependencyChecks(ctx: CheckContext, required: ReadonlySet<DepCheck["id"]>): Promise<DepCheck[]> {
  const platform = platformKey(ctx.platform, ctx.arch);
  const pinnedNode = ctx.pins.node.major;
  const nodeOk = Number(ctx.nodeVersion.split(".")[0]) === pinnedNode;
  const checks: DepCheck[] = [
    {
      id: "node", label: "Node " + pinnedNode, required: required.has("node"), ok: nodeOk,
      detail: nodeOk ? "running Node " + ctx.nodeVersion : "running Node " + ctx.nodeVersion + ", needs " + pinnedNode + ".x",
      ...(nodeOk ? {} : { fix: "Install Node " + pinnedNode + " from nodejs.org, then open a new Terminal window." }),
    },
    toolCheck("terraform", ctx, required.has("terraform"), platform),
    toolCheck("ollama", ctx, required.has("ollama"), platform),
    await serviceCheck(ctx, required.has("isolated-service")),
    presenceCheck("aws-cli", "AWS CLI 2", ["--version"], /aws-cli\/(\d+\.\d+\.\d+)/, required.has("aws-cli"),
      "Install AWS CLI version 2 from docs.aws.amazon.com (macOS installer; it asks for your administrator password), then open a new Terminal window.", ctx.env),
    presenceCheck("git", "Git", ["--version"], /git version (\d+\.\d+\.\d+)/, required.has("git"),
      "Install Git (run xcode-select --install in Terminal), then open a new Terminal window.", ctx.env),
  ];
  return [...checks, ...productChecks(ctx)];
}

/** True when every required check passed. Optional checks never decide it. */
export function allRequiredPass(checks: readonly DepCheck[]): boolean {
  return checks.every((check) => !check.required || check.ok);
}
