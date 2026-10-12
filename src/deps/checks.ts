import { execFileSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
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
  const found = own && existsSync(own) ? own : onPath(tool, ctx.env);
  const installable = artifact ? tool : undefined;
  if (!found) {
    return {
      id: tool, label, required, ok: false, installable,
      detail: "not found",
      fix: installable
        ? "Run ./alz deps and choose Install to add it to your user folder."
        : "Install " + TOOL_LABEL[tool] + " " + pin.version + " yourself, then open a new Terminal window.",
    };
  }
  const version = TOOL_VERSION_ARGS[tool];
  const text = versionText(found, version.args) ?? "";
  const reported = version.pattern.exec(text)?.[1];
  if (reported !== pin.version) {
    return {
      id: tool, label, required, ok: false, installable,
      detail: "found " + (reported ?? "an unreadable version") + " at " + found,
      fix: installable
        ? "Run ./alz deps and choose Install to add the tested " + TOOL_LABEL[tool] + " " + pin.version + " to your user folder. It will be used before any other copy."
        : "Install " + TOOL_LABEL[tool] + " " + pin.version + ", the tested version.",
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
    if (!plugin.executable || seen.has(plugin.executable)) continue;
    seen.add(plugin.executable);
    rows.push({ executable: plugin.executable, ...(plugin.testedVersion ? { testedVersion: plugin.testedVersion } : {}),
      why: plugin.id.toLowerCase().replace(/_/g, " ") + " adapter", vendor: plugin.versionSource });
  }
  for (const extra of EXTRA_PRODUCT_TOOLS) {
    if (!seen.has(extra.executable)) rows.push(extra);
  }
  return rows.map((row): DepCheck => {
    const id = ("product:" + row.executable) as `product:${string}`;
    const found = onPath(row.executable, ctx.env);
    const label = row.executable + (row.testedVersion ? " " + row.testedVersion : "");
    if (!found) {
      return { id, label, required: false, ok: false, detail: "not found (needed for " + row.why + ")",
        fix: "Install " + row.executable + (row.testedVersion ? " " + row.testedVersion : "") + " from " + row.vendor + ", then open a new Terminal window." };
    }
    const text = versionText(found, ["--version"]) ?? versionText(found, ["version"]) ?? "";
    const reported = /(\d+\.\d+\.\d+)/.exec(text)?.[1];
    if (row.testedVersion && reported !== row.testedVersion) {
      return { id, label, required: false, ok: false,
        detail: "found " + (reported ?? "an unreadable version") + ", tested with " + row.testedVersion + " (" + row.why + " may still work)",
        fix: "Optional: install " + row.executable + " " + row.testedVersion + " from " + row.vendor + " to match the tested version." };
    }
    return { id, label, required: false, ok: true, detail: (reported ?? "present") + " at " + found };
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
