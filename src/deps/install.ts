import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, createReadStream, createWriteStream, existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createZstdDecompress } from "node:zlib";

import { INSTALL_MARKER, type InstallMarker, installedPath, installState, realFolder, REMOVING_MARKER, reportedVersion } from "./checks.js";
import { type Artifact, type Platform, type ToolId, type ToolPins } from "./pins.js";

/**
 * Installs one pinned tool into ~/.alz/tools/<tool>/<version>/ (docs/operator-guide.md). The archive is downloaded to a
 * private temporary file, its SHA-256 is checked against the pin, and only then is it unpacked, into a
 * `<version>.partial-<pid>` folder beside the final one. The program there must report the pinned version, and then a
 * completion marker is written as the last step inside that folder. Only after that is the folder put in place, by
 * renames alone: whatever stood at `<version>` before (a copy from before completion checks, or an unfinished install
 * or removal) is renamed aside first and removed last, so no moment leaves a half-removed folder at the final path.
 * A mismatch, a failed download, a failed unpack or a stop signal leaves nothing behind that a later check could mistake
 * for a working install; leftovers of a process that died are swept on the next run. No administrator password is
 * used, and nothing is added to the shell's PATH.
 */
export class InstallError extends Error {
  constructor(
    readonly code: "INSTALL_NO_ARTIFACT" | "INSTALL_DOWNLOAD_FAILED" | "INSTALL_CHECKSUM_MISMATCH" | "INSTALL_UNPACK_FAILED"
      | "INSTALL_BINARY_MISSING" | "INSTALL_VERIFY_FAILED" | "INSTALL_INTERRUPTED" | "INSTALL_REMOVE_REFUSED",
    message: string,
  ) {
    super(message);
  }
}

export type InstallOptions = {
  pins: ToolPins;
  home: string;
  platform: Platform;
  /** Downloads a URL. Defaults to fetch; tests pass a local source, never the network. */
  download?: (url: string, signal: AbortSignal) => Promise<Readable>;
  /** A private scratch directory for the download. Created with mode 0700 if absent. */
  scratch?: string;
  /** Aborted by the caller on a stop signal: the download stops, the cleanup runs and nothing is installed. */
  signal?: AbortSignal;
  /** Decides whether a pid is still running; the default asks the kernel. Tests inject it, so no real process is ever read. */
  pidAlive?: (pid: number) => boolean;
};

export type InstalledTool = {
  tool: ToolId; version: string; path: string; sha256: string; reused: boolean;
  /** Leftovers of earlier runs whose process is proven dead, removed before this install started. */
  swept: string[];
  /** What stood at the final folder before this install replaced it: a copy from before completion checks, or an unfinished install or removal. */
  replaced?: "LEGACY" | "UNFINISHED" | "REMOVING";
};

async function defaultDownload(url: string, signal: AbortSignal): Promise<Readable> {
  const response = await fetch(url, { redirect: "follow", signal: AbortSignal.any([signal, AbortSignal.timeout(10 * 60_000)]) });
  if (!response.ok || !response.body) throw new InstallError("INSTALL_DOWNLOAD_FAILED", "The download did not succeed (HTTP " + response.status + ").");
  return Readable.fromWeb(response.body as never);
}

/** Streams a download to `file`, returning its SHA-256. Nothing is held in memory beyond one chunk. */
async function fetchTo(file: string, source: Readable, signal: AbortSignal): Promise<string> {
  const hash = createHash("sha256");
  const digest = new Transform({
    transform(chunk: Buffer, _encoding, done) {
      hash.update(chunk);
      done(null, chunk);
    },
  });
  await pipeline(source, digest, createWriteStream(file, { mode: 0o600 }), { signal });
  return hash.digest("hex");
}

async function unpack(archive: Artifact["archive"], file: string, into: string): Promise<void> {
  try {
    if (archive === "tgz") {
      execFileSync("tar", ["-xzf", file, "-C", into], { stdio: "ignore" });
    } else if (archive === "tar.zst") {
      // Node decompresses the zstd stream; the plain tar that follows ships with macOS, Linux and Windows 10 and later.
      const tarFile = file + ".tar";
      try {
        await pipeline(createReadStream(file), createZstdDecompress(), createWriteStream(tarFile, { mode: 0o600 }));
        execFileSync("tar", ["-xf", tarFile, "-C", into], { stdio: "ignore" });
      } finally {
        rmSync(tarFile, { force: true });
      }
    } else if (process.platform === "win32") {
      // Windows has no unzip; its built-in tar reads zip archives.
      execFileSync("tar", ["-xf", file, "-C", into], { stdio: "ignore" });
    } else {
      execFileSync("unzip", ["-q", "-o", file, "-d", into], { stdio: "ignore" });
    }
  } catch {
    throw new InstallError("INSTALL_UNPACK_FAILED", "The archive could not be unpacked.");
  }
}

/** True only when the kernel says no such process. Permission denied, or any other answer, means alive: pids get reused. */
export function pidProvenDead(pid: number): boolean {
  if (!Number.isInteger(pid) || pid < 1 || pid === process.pid) return false;
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
}

/** The leftover folders of a run under the tool folder: an unpack in progress, or the copy renamed aside during a swap. */
const LEFTOVER_FOLDER = /^\d+\.\d+\.\d+\.(?:partial|replaced)-(\d+)$/;
/** A download in progress under the scratch folder, and the plain tar a zstd archive is unpacked through. */
const leftoverArchive = (tool: ToolId): RegExp => new RegExp("^" + tool + "-\\d+\\.\\d+\\.\\d+-(\\d+)\\.[A-Za-z0-9.]+$");

/**
 * Removes what an earlier run of this tool's install left behind when its process died: `<version>.partial-<pid>` and
 * `<version>.replaced-<pid>` folders under `~/.alz/tools/<tool>` and `<tool>-<version>-<pid>.<ext>` files under the
 * scratch folder. A pid is left alone unless the kernel says it is dead, so a concurrent install is never disturbed. Only
 * real folders and files are touched (a link anywhere on the way, or a linked entry, is skipped), nothing outside those two
 * folders is read, and a final `<version>` folder is never a target. Returns the paths removed.
 */
export function sweepLeftovers(home: string, tool: ToolId, opts: { scratch?: string; pidAlive?: (pid: number) => boolean } = {}): string[] {
  const dead = (pid: string): boolean => (opts.pidAlive ? !opts.pidAlive(Number(pid)) && Number.isInteger(Number(pid)) && Number(pid) >= 1 : pidProvenDead(Number(pid)));
  const removed: string[] = [];
  const toolDir = realFolder(home, [".alz", "tools", tool]);
  if (toolDir !== undefined) {
    const anchor = realpathSync(toolDir);
    for (const entry of readdirSync(toolDir, { withFileTypes: true })) {
      const pid = LEFTOVER_FOLDER.exec(entry.name)?.[1];
      if (pid === undefined || entry.isSymbolicLink() || !entry.isDirectory() || !dead(pid)) continue;
      const path = join(toolDir, entry.name);
      if (realpathSync(path) !== join(anchor, entry.name)) continue;
      rmSync(path, { recursive: true, force: true });
      removed.push(path);
    }
  }
  const realDir = (path: string): string | undefined => {
    try { const entry = lstatSync(path); return entry.isDirectory() && !entry.isSymbolicLink() ? path : undefined; } catch { return undefined; }
  };
  const scratch = opts.scratch === undefined ? realFolder(home, [".alz", "tmp"]) : realDir(opts.scratch);
  if (scratch !== undefined) {
    const pattern = leftoverArchive(tool);
    for (const entry of readdirSync(scratch, { withFileTypes: true })) {
      const pid = pattern.exec(entry.name)?.[1];
      if (pid === undefined || entry.isSymbolicLink() || !entry.isFile() || !dead(pid)) continue;
      const path = join(scratch, entry.name);
      unlinkSync(path);
      removed.push(path);
    }
  }
  return removed;
}

/** Writes the completion marker into `folder`. The marker is the last file an install writes before the folder is put in place. */
export function writeInstallMarker(folder: string, marker: Omit<InstallMarker, "schemaVersion">): void {
  const value: InstallMarker = { schemaVersion: 1, ...marker };
  writeFileSync(join(folder, INSTALL_MARKER), JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
}

const aborted = (signal: AbortSignal | undefined): never | void => {
  if (signal?.aborted) throw new InstallError("INSTALL_INTERRUPTED", "The install was stopped before it finished, so nothing was installed. Running it again starts over.");
};

/**
 * Installs `tool` at its pinned version, or returns the existing install when it is complete: the program beside its
 * completion marker. Any other folder at the final path is replaced, and only after the new copy is checked.
 */
export async function installTool(tool: ToolId, opts: InstallOptions): Promise<InstalledTool> {
  const pin = opts.pins.tools[tool];
  const artifact = pin.artifacts[opts.platform];
  if (!artifact) throw new InstallError("INSTALL_NO_ARTIFACT", "No pinned " + tool + " download exists for this computer type.");
  const finalBinary = installedPath(opts.home, tool, pin.version, artifact.binary);
  const sweepOptions = { ...(opts.scratch !== undefined ? { scratch: opts.scratch } : {}), ...(opts.pidAlive ? { pidAlive: opts.pidAlive } : {}) };
  const swept = sweepLeftovers(opts.home, tool, sweepOptions);
  const before = installState(opts.home, tool, pin.version, artifact.binary);
  if (before === "INSTALLED") {
    return { tool, version: pin.version, path: finalBinary, sha256: artifact.sha256, reused: true, swept };
  }

  const toolRoot = join(opts.home, ".alz", "tools", tool);
  const scratch = opts.scratch ?? join(opts.home, ".alz", "tmp");
  mkdirSync(scratch, { recursive: true, mode: 0o700 });
  mkdirSync(toolRoot, { recursive: true, mode: 0o700 });
  const archiveFile = join(scratch, tool + "-" + pin.version + "-" + process.pid + "." + artifact.archive);
  const partial = join(toolRoot, pin.version + ".partial-" + process.pid);
  const replaced = join(toolRoot, pin.version + ".replaced-" + process.pid);
  const finalDir = join(toolRoot, pin.version);
  const signal = opts.signal ?? new AbortController().signal;

  try {
    aborted(signal);
    let sha256: string;
    try {
      sha256 = await fetchTo(archiveFile, await (opts.download ?? defaultDownload)(artifact.url, signal), signal);
    } catch (error) {
      aborted(signal);
      if (error instanceof InstallError) throw error;
      throw new InstallError("INSTALL_DOWNLOAD_FAILED", "The download did not finish. Check your connection and try again.");
    }
    if (sha256 !== artifact.sha256) {
      throw new InstallError("INSTALL_CHECKSUM_MISMATCH",
        "The download does not match the pinned checksum, so nothing was installed. Do not retry on another network without asking the project owner.");
    }
    aborted(signal);
    mkdirSync(partial, { recursive: true, mode: 0o700 });
    await unpack(artifact.archive, archiveFile, partial);
    aborted(signal);
    const partialBinary = join(partial, artifact.binary);
    if (!existsSync(partialBinary) || !statSync(partialBinary).isFile()) {
      throw new InstallError("INSTALL_BINARY_MISSING", "The archive did not contain " + artifact.binary + ".");
    }
    chmodSync(partialBinary, 0o755);
    // The new copy is checked where it was unpacked, before anything at the final path is touched.
    if (reportedVersion(tool, partialBinary) !== pin.version) {
      throw new InstallError("INSTALL_VERIFY_FAILED", "The unpacked program does not report the pinned version, so it is not used and the copy was removed again.");
    }
    aborted(signal);
    writeInstallMarker(partial, { tool, version: pin.version, binary: artifact.binary, sha256, completedAt: new Date().toISOString() });
    // The swap is two renames. Between them the final path is empty, never half-removed; a crash leaves only suffixed
    // folders, which the next run sweeps once this pid is dead.
    if (before !== "ABSENT") renameSync(finalDir, replaced);
    renameSync(partial, finalDir);
    rmSync(replaced, { recursive: true, force: true });
    return { tool, version: pin.version, path: finalBinary, sha256, reused: false, swept, ...(before !== "ABSENT" ? { replaced: before } : {}) };
  } finally {
    rmSync(archiveFile, { force: true });
    rmSync(partial, { recursive: true, force: true });
  }
}

const TOOL_IDS: readonly ToolId[] = ["terraform", "ollama"];
/** One path component a pinned version can be: it starts with a letter or digit, so it is never "." or "..", and holds no separator. */
const VERSION_COMPONENT = /^[0-9A-Za-z][0-9A-Za-z._+-]{0,63}$/;

/**
 * Removes one pinned version of a tool from the app's own folder. Only `~/.alz/tools/<tool>/<version>` is deleted, and
 * only when the tool is one the app installs, the version is a single safe path component, every folder from the home
 * folder down (`.alz`, `tools`, the tool, the version) is a real folder and not a link, and the resolved path is exactly
 * that folder under the resolved home. The removal marker is written first and the completion marker removed second, so
 * an interrupted removal reads as unfinished (never as installed) and running the removal again completes it. Returns
 * "absent" when the version is not there, so a second removal of a finished one does nothing.
 */
export function removeInstalledTool(home: string, tool: ToolId, version: string): "removed" | "absent" {
  const refuse = (): never => {
    throw new InstallError("INSTALL_REMOVE_REFUSED", "That folder is not an app-installed copy, so nothing was removed.");
  };
  if (!TOOL_IDS.includes(tool) || typeof version !== "string" || !VERSION_COMPONENT.test(version)) refuse();
  const components = [".alz", "tools", tool, version];
  let path = home;
  for (const component of components) {
    path = join(path, component);
    let entry: ReturnType<typeof lstatSync>;
    try { entry = lstatSync(path); } catch { return "absent"; }
    // A link anywhere on the way could point the deletion outside the app's folder; a file where a folder belongs is not ours.
    if (entry.isSymbolicLink() || !entry.isDirectory()) refuse();
  }
  const expected = join(realpathSync(home), ...components);
  if (realpathSync(path) !== expected) refuse();
  writeFileSync(join(expected, REMOVING_MARKER), new Date().toISOString() + "\n", { mode: 0o600 });
  rmSync(join(expected, INSTALL_MARKER), { force: true });
  rmSync(expected, { recursive: true, force: true });
  return "removed";
}
