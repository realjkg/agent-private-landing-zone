import { accessSync, constants, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";

import {
  NETWORK_URL_VARIABLES,
  NETWORK_VARIABLES,
  NEVER_INJECTABLE,
  type ProcessProfile,
} from "./profiles.js";

/**
 * Builds the environment and executable lookup for a governed child process
 * (docs/runner-hardening.md). Pure over its inputs, so every rule is testable.
 */

/** Standard install locations. Anything else is added deliberately with ALZ_TOOL_DIRS. */
export const DEFAULT_TOOL_DIRS: readonly string[] = ["/usr/local/bin", "/usr/bin", "/bin", "/opt/homebrew/bin"];

/** Not secrets, and tools behave badly without them. Everything else must be injected. */
const BASELINE_VARIABLES = ["LANG", "LC_ALL", "TZ"] as const;

const SECRET_NAME = /(SECRET|TOKEN|PASSWORD|PASSPHRASE|CREDENTIAL|SESSION|PRIVATE|ACCESS_KEY)/i;
const IDENTITY = /^[A-Z][A-Z0-9]{1,15}$/;
const MIN_SECRET_LENGTH = 8;

/**
 * Directories executables may be resolved from: the defaults plus the
 * absolute directories in `ALZ_TOOL_DIRS`. A directory that is missing, not a
 * directory, or writable by everyone is dropped, because anyone could plant a
 * binary in it. The inherited `PATH` is never consulted.
 */
export function approvedToolDirs(base: NodeJS.ProcessEnv = process.env): string[] {
  const extra = (base.ALZ_TOOL_DIRS ?? "").split(":").filter(Boolean);
  const dirs: string[] = [];
  for (const dir of [...DEFAULT_TOOL_DIRS, ...extra]) {
    if (!isAbsolute(dir) || dirs.includes(dir)) continue;
    try {
      const stat = statSync(dir);
      if (stat.isDirectory() && (stat.mode & 0o002) === 0) dirs.push(dir);
    } catch {
      // Not present on this machine.
    }
  }
  return dirs;
}

/** The first executable regular file named `name` in `dirs`, as an absolute path. */
export function resolveExecutable(name: string, dirs: readonly string[]): string | undefined {
  if (!/^[A-Za-z0-9._-]+$/.test(name)) return undefined; // no path separators, no traversal
  for (const dir of dirs) {
    const candidate = join(dir, name);
    try {
      if (!statSync(candidate).isFile()) continue;
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Keep looking.
    }
  }
  return undefined;
}

/** Loopback is always approved; everything else must match an exact name or a `*.suffix` pattern. */
export function hostApproved(value: string, patterns: readonly string[]): boolean {
  let host: string;
  try {
    host = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : "http://" + value).hostname.toLowerCase();
  } catch {
    return false;
  }
  host = host.replace(/^\[|\]$/g, "");
  if (["localhost", "127.0.0.1", "::1"].includes(host)) return true;
  return patterns.some((pattern) => {
    const p = pattern.toLowerCase();
    return p.startsWith("*.") ? host.endsWith(p.slice(1)) && host.length > p.length - 1 : host === p;
  });
}

export type ChildEnvironment = {
  env: Record<string, string>;
  /** Injected values that look like secrets; redacted from output and diagnostics. */
  secretValues: string[];
  /** Names (never values) of injected variables that were refused, for an actionable message. */
  refused: string[];
};

export type ChildEnvironmentInput = {
  profile: ProcessProfile;
  /** The runner's own environment, read only for `ALZ_*` injection and the baseline. */
  base: NodeJS.ProcessEnv;
  toolDirs: readonly string[];
  home: string;
  tmp: string;
  /** Which injected identity feeds this child. Defaults to DISCOVERY. */
  identity?: string;
};

/**
 * The child's whole environment. It starts empty. Only these reach it:
 *  - a controlled `PATH`, a private `HOME` and `TMPDIR` (never the operator's),
 *    `CI` and `TF_IN_AUTOMATION`, and the non-secret baseline;
 *  - `ALZ_<IDENTITY>_<VAR>` from the runner's environment, delivered as
 *    `<VAR>`, only when the profile lists `<VAR>`; and
 *  - `ALZ_NETWORK_<VAR>` for proxy and CA settings.
 * URL-valued variables must name an approved host (the profile's, loopback, or
 * `ALZ_APPROVED_HOSTS`).
 */
export function buildChildEnvironment(input: ChildEnvironmentInput): ChildEnvironment {
  const identity = input.identity ?? "DISCOVERY";
  if (!IDENTITY.test(identity)) throw new Error("CHILD_IDENTITY_INVALID");
  const operatorHosts = (input.base.ALZ_APPROVED_HOSTS ?? "").split(",").map((h) => h.trim()).filter(Boolean);
  const hosts = [...input.profile.approvedHosts, ...operatorHosts];
  const env: Record<string, string> = {};
  const secretValues: string[] = [];
  const refused: string[] = [];

  for (const name of BASELINE_VARIABLES) {
    const value = input.base[name];
    if (value !== undefined) env[name] = value;
  }

  const inject = (prefix: string, allowed: (name: string) => boolean, urlNames: readonly string[]) => {
    for (const [key, value] of Object.entries(input.base)) {
      if (!key.startsWith(prefix) || value === undefined) continue;
      const name = key.slice(prefix.length);
      const permitted = name.length > 0 && !NEVER_INJECTABLE.test(name) && allowed(name) &&
        !/[\0\n\r]/.test(value) &&
        (!urlNames.includes(name) || hostApproved(value, hosts));
      if (!permitted) {
        refused.push(key);
        continue;
      }
      env[name] = value;
      if (SECRET_NAME.test(name) && value.length >= MIN_SECRET_LENGTH) secretValues.push(value);
    }
  };

  inject("ALZ_" + identity + "_",
    (name) => input.profile.injectable.includes(name) ||
      input.profile.injectablePrefixes.some((prefix) => name.startsWith(prefix)),
    input.profile.urlVariables);
  inject("ALZ_NETWORK_", (name) => NETWORK_VARIABLES.includes(name), NETWORK_URL_VARIABLES);

  // Set last: nothing injected can override these.
  env.PATH = input.toolDirs.join(":");
  env.HOME = input.home;
  env.TMPDIR = input.tmp;
  env.CI = "1";
  env.TF_IN_AUTOMATION = "1";
  return { env, secretValues, refused: refused.sort() };
}

/** Replaces any injected secret value found in `text`. */
export function redactSecrets(text: string, secrets: readonly string[]): string {
  let result = text;
  for (const secret of secrets) {
    if (secret.length >= MIN_SECRET_LENGTH) result = result.split(secret).join("[REDACTED]");
  }
  return result;
}
