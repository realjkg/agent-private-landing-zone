import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { INSTALL_MARKER, realFolder, REMOVING_MARKER } from "../deps/checks.js";
import { pidProvenDead } from "../deps/install.js";

/**
 * The packaged app under `~/.alz/app/<version>/`, installed, launched and removed with the same discipline as the pinned
 * tools (src/deps/install.ts): the archive's SHA-256 is checked first, it is unpacked into `install.partial-<pid>` beside
 * the final folder, the completion marker is written last, and the folder is put in place by renames alone. "Installed"
 * needs the marker beside the launcher; a removal writes its own marker first so an interrupted one reads as unfinished
 * and a repeat completes it. Leftovers of a dead process are swept, never a final version folder, never through a link,
 * and nothing outside `~/.alz/app` is read. The `current` file names the version `./alz` should run; it is a file, not a
 * link, replaced by rename.
 */
export class AppInstallError extends Error {
  constructor(
    readonly code: "APP_ARTIFACT_UNREADABLE" | "APP_CHECKSUM_MISMATCH" | "APP_UNPACK_FAILED" | "APP_ARTIFACT_INCOMPLETE" | "APP_ROOT_NOT_A_FOLDER" | "APP_REMOVE_REFUSED",
    message: string,
  ) {
    super(message);
  }
}

export type AppState = "INSTALLED" | "UNFINISHED" | "REMOVING" | "ABSENT";
export type AppMarker = { schemaVersion: 1; app: "alz"; version: string; artifactSha256: string; completedAt: string };
export type InstalledApp = { version: string; path: string; artifactSha256: string; reused: boolean; swept: string[]; replaced?: Exclude<AppState, "ABSENT" | "INSTALLED"> };

/** The launcher every packaged release ships at its root; its presence beside the marker is what "installed" means. */
export const APP_LAUNCHER = "alz";
const VERSION = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]{1,64})?$/;
const LEFTOVER = /^(?:install\.partial|\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]{1,64})?\.replaced)-(\d+)$/;

export const appRoot = (home: string): string => join(home, ".alz", "app");
export const appFolder = (home: string, version: string): string => join(appRoot(home), version);

/** The SHA-256 of a file, streamed. */
export async function fileSha256(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

export function readAppMarker(folder: string): AppMarker | undefined {
  try {
    const value = JSON.parse(readFileSync(join(folder, INSTALL_MARKER), "utf8")) as unknown;
    if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
    const marker = value as Record<string, unknown>;
    if (marker.schemaVersion !== 1 || marker.app !== "alz" || typeof marker.version !== "string" || !VERSION.test(marker.version) ||
      typeof marker.artifactSha256 !== "string" || !/^[0-9a-f]{64}$/.test(marker.artifactSha256) ||
      typeof marker.completedAt !== "string" || Number.isNaN(Date.parse(marker.completedAt))) return undefined;
    return marker as AppMarker;
  } catch { return undefined; }
}

/** What `~/.alz/app/<version>` holds, read without following links. */
export function appState(home: string, version: string): AppState {
  const folder = realFolder(home, [".alz", "app", version]);
  if (folder === undefined) return "ABSENT";
  const has = (name: string): boolean => { try { return lstatSync(join(folder, name)).isFile(); } catch { return false; } };
  if (has(REMOVING_MARKER)) return "REMOVING";
  const marker = readAppMarker(folder);
  return has(APP_LAUNCHER) && marker !== undefined && marker.version === version ? "INSTALLED" : "UNFINISHED";
}

/** The version name the `current` file holds, whatever state that version is in: a real file (never a link) holding one valid name. */
export function currentName(home: string): string | undefined {
  const root = realFolder(home, [".alz", "app"]);
  if (root === undefined) return undefined;
  try {
    const entry = lstatSync(join(root, "current"));
    if (!entry.isFile()) return undefined;
    const version = readFileSync(join(root, "current"), "utf8").trim();
    return VERSION.test(version) ? version : undefined;
  } catch { return undefined; }
}

/** The version the `current` file names, when it names an installed one. */
export function currentVersion(home: string): string | undefined {
  const version = currentName(home);
  return version !== undefined && appState(home, version) === "INSTALLED" ? version : undefined;
}

/** Every version-named folder under `~/.alz/app` with its state, newest name first. */
export function appVersions(home: string): { version: string; state: Exclude<AppState, "ABSENT"> }[] {
  const root = realFolder(home, [".alz", "app"]);
  if (root === undefined) return [];
  return readdirSync(root).filter((name) => VERSION.test(name))
    .map((version) => ({ version, state: appState(home, version) }))
    .filter((item): item is { version: string; state: Exclude<AppState, "ABSENT"> } => item.state !== "ABSENT")
    .sort((a, b) => b.version.localeCompare(a.version, "en-US", { numeric: true }));
}

/**
 * Removes `install.partial-<pid>` and `<version>.replaced-<pid>` folders under `~/.alz/app` whose pid is proven dead.
 * Only real folders are touched, each checked to resolve exactly under the real app folder. Returns the paths removed.
 */
export function sweepAppLeftovers(home: string, pidAlive?: (pid: number) => boolean): string[] {
  const root = realFolder(home, [".alz", "app"]);
  if (root === undefined) return [];
  const dead = (pid: number): boolean => Number.isInteger(pid) && pid >= 1 && pid !== process.pid && (pidAlive ? !pidAlive(pid) : pidProvenDead(pid));
  const anchor = realpathSync(root);
  const removed: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const pid = LEFTOVER.exec(entry.name)?.[1];
    if (pid === undefined || entry.isSymbolicLink() || !entry.isDirectory() || !dead(Number(pid))) continue;
    const path = join(root, entry.name);
    if (realpathSync(path) !== join(anchor, entry.name)) continue;
    rmSync(path, { recursive: true, force: true });
    removed.push(path);
  }
  return removed;
}

function writeFileByRename(path: string, text: string): void {
  writeFileSync(path + ".tmp-" + process.pid, text, { mode: 0o600 });
  renameSync(path + ".tmp-" + process.pid, path);
}

export type InstallAppOptions = {
  home: string;
  /** The release archive (a .tgz holding `alz` and `package.json` at its root) and the SHA-256 it must have. */
  artifact: string;
  artifactSha256: string;
  pidAlive?: (pid: number) => boolean;
  now?: () => Date;
};

/**
 * Installs the release archive as `~/.alz/app/<version>` (the version is the archive's package.json version), or returns the
 * existing install when it is complete and was made from the same artifact. Anything else at that path is replaced only
 * after the new copy is complete. `current` is pointed at the version last.
 */
export async function installApp(opts: InstallAppOptions): Promise<InstalledApp> {
  const root = appRoot(opts.home);
  // Nothing is written through a link: `~/.alz` and `~/.alz/app` must each be a real folder or not exist yet. Checked before
  // the folders are created, so nothing is made inside a link's target, and again after, before anything is unpacked.
  const notAFolder = (): never => { throw new AppInstallError("APP_ROOT_NOT_A_FOLDER", "The app folder under the user folder (~/.alz or ~/.alz/app) is a link or not a folder, so nothing was installed. Remove it by hand first."); };
  let dir = opts.home;
  for (const component of [".alz", "app"]) {
    dir = join(dir, component);
    let entry: ReturnType<typeof lstatSync>;
    try { entry = lstatSync(dir); } catch { break; }
    if (entry.isSymbolicLink() || !entry.isDirectory()) notAFolder();
  }
  mkdirSync(root, { recursive: true, mode: 0o700 });
  if (realFolder(opts.home, [".alz", "app"]) === undefined) notAFolder();
  const swept = sweepAppLeftovers(opts.home, opts.pidAlive);
  let sha256: string;
  try { sha256 = await fileSha256(opts.artifact); } catch { throw new AppInstallError("APP_ARTIFACT_UNREADABLE", "The release archive could not be read."); }
  if (sha256 !== opts.artifactSha256) throw new AppInstallError("APP_CHECKSUM_MISMATCH", "The release archive does not match the expected checksum, so nothing was installed.");
  const partial = join(root, "install.partial-" + process.pid);
  try {
    mkdirSync(partial, { recursive: true, mode: 0o700 });
    try { execFileSync("tar", ["-xzf", opts.artifact, "-C", partial], { stdio: "ignore" }); } catch { throw new AppInstallError("APP_UNPACK_FAILED", "The release archive could not be unpacked."); }
    let version: string;
    try {
      const pkg = JSON.parse(readFileSync(join(partial, "package.json"), "utf8")) as { version?: unknown };
      if (typeof pkg.version !== "string" || !VERSION.test(pkg.version)) throw new Error("version");
      version = pkg.version;
      if (!lstatSync(join(partial, APP_LAUNCHER)).isFile()) throw new Error("launcher");
    } catch {
      throw new AppInstallError("APP_ARTIFACT_INCOMPLETE", "The release archive does not hold a package.json with a version and the alz launcher at its root.");
    }
    const finalDir = appFolder(opts.home, version);
    const before = appState(opts.home, version);
    if (before === "INSTALLED" && readAppMarker(finalDir)?.artifactSha256 === sha256) {
      writeFileByRename(join(root, "current"), version + "\n");
      return { version, path: finalDir, artifactSha256: sha256, reused: true, swept };
    }
    const marker: AppMarker = { schemaVersion: 1, app: "alz", version, artifactSha256: sha256, completedAt: (opts.now?.() ?? new Date()).toISOString() };
    writeFileSync(join(partial, INSTALL_MARKER), JSON.stringify(marker, null, 2) + "\n", { mode: 0o600 });
    const replaced = join(root, version + ".replaced-" + process.pid);
    if (before !== "ABSENT") renameSync(finalDir, replaced);
    renameSync(partial, finalDir);
    rmSync(replaced, { recursive: true, force: true });
    writeFileByRename(join(root, "current"), version + "\n");
    return { version, path: finalDir, artifactSha256: sha256, reused: false, swept, ...(before !== "ABSENT" && before !== "INSTALLED" ? { replaced: before } : {}) };
  } finally {
    rmSync(partial, { recursive: true, force: true });
  }
}

/** The points inside a removal, in order; a test stops the process at each one to prove a rerun finishes what was started. */
export type RemovalPoint = "marked" | "unmarked" | "moved-aside" | "current-cleared" | "removed";

/** Deletes the `current` file when it names `version`. */
function clearCurrent(home: string, version: string): void {
  if (currentName(home) !== version) return;
  try { unlinkSync(join(realpathSync(home), ".alz", "app", "current")); } catch { /* already gone */ }
}

/**
 * Removes `~/.alz/app/<version>`, which must be the version the `current` file names: the removal marker first, the completion
 * marker second, then the folder is renamed aside to `<version>.replaced-<pid>` (so the version reads ABSENT at once), the
 * `current` file is cleared, and the renamed copy is deleted last. A process killed at any point leaves either the version
 * REMOVING and still named by `current` (a repeat finishes it), the version ABSENT with `current` still naming it (a repeat
 * clears `current` and says "absent"), or a `.replaced-<pid>` copy that the dead-pid sweep removes. Refuses a version that is not
 * one safe path component, a link anywhere on the way, a folder that does not resolve under the real app folder, a version
 * `current` does not name, and a folder that is neither this runner's install nor a removal it started.
 */
export function removeApp(home: string, version: string, opts: { at?: (point: RemovalPoint) => void } = {}): "removed" | "absent" {
  const refuse = (): never => { throw new AppInstallError("APP_REMOVE_REFUSED", "That folder is not an installed copy of the app, so nothing was removed."); };
  if (!VERSION.test(version)) refuse();
  const components = [".alz", "app", version];
  let path = home;
  for (const [index, component] of components.entries()) {
    path = join(path, component);
    let entry: ReturnType<typeof lstatSync>;
    try { entry = lstatSync(path); } catch {
      // The version folder is gone: a removal killed after it moved the folder aside leaves `current` naming nothing.
      if (index === components.length - 1) clearCurrent(home, version);
      return "absent";
    }
    if (entry.isSymbolicLink() || !entry.isDirectory()) refuse();
  }
  const expected = join(realpathSync(home), ...components);
  if (realpathSync(path) !== expected) refuse();
  // Only the version `current` names, and only a copy this runner installed (its marker) or a removal it already started.
  if (currentName(home) !== version) refuse();
  const state = appState(home, version);
  if (state !== "INSTALLED" && state !== "REMOVING") refuse();
  writeFileSync(join(expected, REMOVING_MARKER), new Date().toISOString() + "\n", { mode: 0o600 });
  opts.at?.("marked");
  rmSync(join(expected, INSTALL_MARKER), { force: true });
  opts.at?.("unmarked");
  const aside = join(realpathSync(home), ".alz", "app", version + ".replaced-" + process.pid);
  rmSync(aside, { recursive: true, force: true });
  renameSync(expected, aside);
  opts.at?.("moved-aside");
  clearCurrent(home, version);
  opts.at?.("current-cleared");
  rmSync(aside, { recursive: true, force: true });
  opts.at?.("removed");
  return "removed";
}
