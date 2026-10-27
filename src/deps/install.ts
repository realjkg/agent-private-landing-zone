import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, closeSync, createReadStream, createWriteStream, existsSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createZstdDecompress } from "node:zlib";

import { INSTALL_MARKER, type InstallMarker, installedPath, installState, readInstallMarker, realFolder, REMOVING_MARKER, reportedVersion } from "./checks.js";
import { type Artifact, type Platform, type ToolId, type ToolPins } from "./pins.js";

/**
 * Installs one pinned tool into ~/.alz/tools/<tool>/<version>/ (docs/operator-guide.md). The archive is downloaded to a
 * private temporary file, its SHA-256 is checked against the pin, and only then is it unpacked, into a
 * `<version>.partial-<pid>` folder beside the final one. The program there must report the pinned version, and then a
 * completion marker is written as the last step inside that folder. Only after that is the folder put in place, by
 * renames alone: whatever stood at `<version>` before (a copy from before completion checks, or an unfinished install
 * or removal) is renamed aside first and removed last, so no moment leaves a half-removed folder at the final path, and
 * a crash between the two renames is rolled forward (the checked copy is put in place) or back (the earlier copy is put
 * back) by the next run. A mismatch, a failed download, a failed unpack or a stop signal leaves nothing behind that a
 * later check could mistake for a working install; leftovers of a process that died are swept on the next run. No
 * administrator password is used, and nothing is added to the shell's PATH.
 */
export class InstallError extends Error {
  constructor(
    readonly code: "INSTALL_NO_ARTIFACT" | "INSTALL_DOWNLOAD_FAILED" | "INSTALL_CHECKSUM_MISMATCH" | "INSTALL_UNPACK_FAILED"
      | "INSTALL_BINARY_MISSING" | "INSTALL_VERIFY_FAILED" | "INSTALL_SWAP_FAILED" | "INSTALL_INTERRUPTED" | "INSTALL_IN_PROGRESS" | "INSTALL_REMOVE_REFUSED",
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
  /** Test hook only: runs between the two renames of the swap, so a test can make that step fail like a crash would. */
  betweenRenames?: () => void;
  /** Test hook only: runs right before the archive is unpacked, after the download and its checksum, so a test can stop there. */
  onUnpackStart?: () => void;
};

export type InstalledTool = {
  tool: ToolId; version: string; path: string; sha256: string; reused: boolean;
  /** Leftovers of earlier runs whose process is proven dead, removed before this install started. */
  swept: string[];
  /** Interrupted swaps of earlier runs finished before this install started: each line says what was put where. */
  recovered: string[];
  /** Leftovers left alone on purpose before this install started, in plain words (see SweepResult.refused). */
  refused: string[];
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

/**
 * The per-tool install lock, `<scratch>/<tool>.install.lock`, created exclusively and holding this pid. A lock whose pid is
 * proven dead is stale and is replaced; one whose pid may be alive means another `./alz deps` run is installing this tool,
 * and this run does nothing. Released by the run that holds it, only while it still holds it.
 */
function acquireInstallLock(scratch: string, tool: ToolId, pidAlive?: (pid: number) => boolean): () => void {
  const file = join(scratch, tool + ".install.lock");
  const busy = (): never => { throw new InstallError("INSTALL_IN_PROGRESS", "Another ./alz deps run is installing " + tool + " right now, so this run changed nothing. Wait for it to finish."); };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = openSync(file, "wx", 0o600);
      writeSync(fd, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }) + "\n");
      closeSync(fd);
      return () => {
        try {
          const held = JSON.parse(readFileSync(file, "utf8")) as { pid?: unknown };
          if (held.pid === process.pid) unlinkSync(file);
        } catch { /* already gone, or not ours */ }
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let pid: unknown;
      try { pid = (JSON.parse(readFileSync(file, "utf8")) as { pid?: unknown }).pid; } catch { pid = undefined; }
      const dead = typeof pid === "number" && Number.isInteger(pid) && pid >= 1 && pid !== process.pid && (pidAlive ? !pidAlive(pid) : pidProvenDead(pid));
      // An unreadable lock, or one whose pid may be alive, is somebody's: never removed. Only a proven-dead pid's lock is stale.
      if (!dead) busy();
      rmSync(file, { force: true });
    }
  }
  return busy();
}

const aborted = (signal: AbortSignal | undefined): never | void => {
  if (signal?.aborted) throw new InstallError("INSTALL_INTERRUPTED", "The install was stopped before it finished, so nothing was installed. Running it again starts over.");
};

/**
 * Unpacks the archive. The zstd decompression honors the stop signal directly. `tar` and `unzip` run as children in the
 * same process group, so a Ctrl-C at the terminal ends them too; their failure is then reported as the stop it was, not as
 * a broken archive: one turn of the event loop lets the signal handler run before the failure is classified.
 */
async function unpack(archive: Artifact["archive"], file: string, into: string, signal: AbortSignal): Promise<void> {
  try {
    if (archive === "tgz") {
      execFileSync("tar", ["-xzf", file, "-C", into], { stdio: "ignore" });
    } else if (archive === "tar.zst") {
      // Node decompresses the zstd stream; the plain tar that follows ships with macOS, Linux and Windows 10 and later.
      const tarFile = file + ".tar";
      try {
        await pipeline(createReadStream(file), createZstdDecompress(), createWriteStream(tarFile, { mode: 0o600 }), { signal });
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
    // Two turns: the first lands in this loop iteration's check phase, the second in the next one's, after its poll phase has
    // read the signal the child's end delivered while this process was blocked in the child.
    for (let turn = 0; turn < 2; turn += 1) await new Promise<void>((done) => { setImmediate(done); });
    aborted(signal);
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

/** The leftover folders of a run under the tool folder: an unpack in progress, the copy renamed aside during a swap, or a removal in progress. */
const LEFTOVER_FOLDER = /^(\d+\.\d+\.\d+)\.(partial|replaced|removing)-(\d+)$/;
/** A download in progress under the scratch folder, and the plain tar a zstd archive is unpacked through. */
const leftoverArchive = (tool: ToolId): RegExp => new RegExp("^" + tool + "-\\d+\\.\\d+\\.\\d+-(\\d+)\\.[A-Za-z0-9.]+$");

export type SweepResult = {
  /** Paths removed. */
  removed: string[];
  /** Interrupted swaps finished, one line each: the checked copy put in place (rolled forward) or the earlier copy put back (rolled back). */
  recovered: string[];
  /** Leftovers left alone on purpose, one plain line each: something that is not a folder (a link, a file) stands at the final path, so nothing beside it is touched. */
  refused: string[];
};

/** What stands at `path` without following links: nothing, a real folder, or something else (a link, dangling or not, or a file). */
function entryKind(path: string): "ABSENT" | "FOLDER" | "OTHER" {
  try {
    const entry = lstatSync(path);
    return entry.isDirectory() && !entry.isSymbolicLink() ? "FOLDER" : "OTHER";
  } catch { return "ABSENT"; }
}

/** The marker in `folder` when it is a complete install of `tool` `version`: the marker names the program and the program is there. */
function completeCopy(folder: string, tool: ToolId, version: string): InstallMarker | undefined {
  let binary: unknown;
  try { binary = (JSON.parse(readFileSync(join(folder, INSTALL_MARKER), "utf8")) as Record<string, unknown>).binary; } catch { return undefined; }
  if (typeof binary !== "string" || binary === "" || binary.split(/[\\/]/).some((part) => part === "" || part === "." || part === "..")) return undefined;
  const marker = readInstallMarker(folder, tool, version, binary);
  try { return marker !== undefined && lstatSync(join(folder, binary)).isFile() ? marker : undefined; } catch { return undefined; }
}

/**
 * Removes what an earlier run of this tool's install or removal left behind when its process died: `<version>.partial-<pid>`,
 * `<version>.replaced-<pid>` and `<version>.removing-<pid>` folders under `~/.alz/tools/<tool>` and `<tool>-<version>-<pid>.<ext>`
 * files under the scratch folder. A pid is left alone unless the kernel says it is dead (this process's own pid is always
 * alive, whatever is injected), so a concurrent install is never disturbed. An interrupted swap (the final folder absent,
 * an earlier copy renamed aside) is finished rather than deleted: the checked partial copy is put in place when it is
 * complete, otherwise the earlier copy is put back, so a copy is never lost. Only real folders and files are touched (a
 * link anywhere on the way, or a linked entry, is skipped), nothing outside those two folders is read, and a final
 * `<version>` folder is never a target.
 */
export function sweepLeftovers(home: string, tool: ToolId, opts: { scratch?: string; pidAlive?: (pid: number) => boolean } = {}): SweepResult {
  const dead = (text: string): boolean => {
    const pid = Number(text);
    if (!Number.isInteger(pid) || pid < 1 || pid === process.pid) return false;
    return opts.pidAlive ? !opts.pidAlive(pid) : pidProvenDead(pid);
  };
  const result: SweepResult = { removed: [], recovered: [], refused: [] };
  const toolDir = realFolder(home, [".alz", "tools", tool]);
  if (toolDir !== undefined) {
    const anchor = realpathSync(toolDir);
    const leftovers: { name: string; version: string; kind: string; pid: string; path: string }[] = [];
    for (const entry of readdirSync(toolDir, { withFileTypes: true })) {
      const match = LEFTOVER_FOLDER.exec(entry.name);
      if (!match || entry.isSymbolicLink() || !entry.isDirectory() || !dead(match[3]!)) continue;
      const path = join(toolDir, entry.name);
      if (realpathSync(path) !== join(anchor, entry.name)) continue;
      leftovers.push({ name: entry.name, version: match[1]!, kind: match[2]!, pid: match[3]!, path });
    }
    // An interrupted swap: the final folder is absent and an earlier copy sits aside. Roll forward when the same run's partial
    // copy is complete, otherwise roll back. Either way the final path is filled by one rename before anything is removed.
    for (const aside of leftovers.filter((item) => item.kind === "replaced")) {
      const finalDir = join(toolDir, aside.version);
      const atFinal = entryKind(finalDir);
      if (atFinal === "FOLDER") continue;
      if (atFinal === "OTHER") {
        // A link (dangling or not) or a file at the final path: never renamed over, never followed, and the copy aside stays.
        result.refused.push("something that is not a folder (a link or a file) stands at " + finalDir + ", so the earlier " + tool + " " + aside.version + " copy beside it was left alone; remove it by hand, then run ./alz deps again");
        continue;
      }
      const partial = leftovers.find((item) => item.kind === "partial" && item.version === aside.version && item.pid === aside.pid);
      if (partial && completeCopy(partial.path, tool, aside.version) !== undefined) {
        renameSync(partial.path, finalDir);
        result.recovered.push("put the checked " + tool + " " + aside.version + " copy of an interrupted run (pid " + aside.pid + ") in place");
      } else {
        renameSync(aside.path, finalDir);
        result.recovered.push("put the earlier " + tool + " " + aside.version + " copy back after an interrupted run (pid " + aside.pid + ")");
      }
    }
    for (const item of leftovers) {
      if (!existsSync(item.path)) continue;
      if (item.kind === "replaced" && entryKind(join(toolDir, item.version)) !== "FOLDER") continue;
      rmSync(item.path, { recursive: true, force: true });
      result.removed.push(item.path);
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
      result.removed.push(path);
    }
  }
  return result;
}

/** Writes the completion marker into `folder`. The marker is the last file an install writes before the folder is put in place. */
export function writeInstallMarker(folder: string, marker: Omit<InstallMarker, "schemaVersion">): void {
  const value: InstallMarker = { schemaVersion: 1, ...marker };
  writeFileSync(join(folder, INSTALL_MARKER), JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
}

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
  const scratch = opts.scratch ?? join(opts.home, ".alz", "tmp");
  mkdirSync(scratch, { recursive: true, mode: 0o700 });
  // One install of a tool at a time: the lock is taken before the sweep and the state are read, so two runs never swap at once.
  const unlock = acquireInstallLock(scratch, tool, opts.pidAlive);
  try {
    return await installLocked(tool, opts, pin.version, artifact, finalBinary, scratch, sweepOptions);
  } finally {
    unlock();
  }
}

async function installLocked(tool: ToolId, opts: InstallOptions, version: string, artifact: Artifact, finalBinary: string, scratch: string,
  sweepOptions: { scratch?: string; pidAlive?: (pid: number) => boolean }): Promise<InstalledTool> {
  const pin = { version };
  const { removed: swept, recovered, refused } = sweepLeftovers(opts.home, tool, sweepOptions);
  const before = installState(opts.home, tool, pin.version, artifact.binary);
  if (before === "INSTALLED") {
    return { tool, version: pin.version, path: finalBinary, sha256: artifact.sha256, reused: true, swept, recovered, refused };
  }

  const toolRoot = join(opts.home, ".alz", "tools", tool);
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
    opts.onUnpackStart?.();
    await unpack(artifact.archive, archiveFile, partial, signal);
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
    // The swap is two renames. Between them the final path is empty, never half-removed; a crash there leaves only suffixed
    // folders, which the next run rolls forward or back once this pid is dead. If the second rename fails, the earlier copy
    // goes straight back.
    if (before !== "ABSENT") renameSync(finalDir, replaced);
    try {
      opts.betweenRenames?.();
      renameSync(partial, finalDir);
    } catch {
      if (before !== "ABSENT" && !existsSync(finalDir)) renameSync(replaced, finalDir);
      throw new InstallError("INSTALL_SWAP_FAILED", "The checked copy could not be put in place, so nothing changed; the earlier copy was kept.");
    }
    rmSync(replaced, { recursive: true, force: true });
    return { tool, version: pin.version, path: finalBinary, sha256, reused: false, swept, recovered, refused, ...(before !== "ABSENT" ? { replaced: before } : {}) };
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
 * that folder under the resolved home. The removal marker is written first, the completion marker removed second, then
 * the folder is renamed aside to `<version>.removing-<pid>` and deleted there: an interrupted removal reads as unfinished
 * (the marker) or as absent with a leftover the next run sweeps, never as a copy to keep, and running the removal again
 * completes it. Returns "absent" when the version is not there, so a second removal of a finished one does nothing.
 */
export function removeInstalledTool(home: string, tool: ToolId, version: string, hooks: { /** Test hook only: runs after the folder is renamed aside and before it is deleted. */ afterRenameAside?: () => void } = {}): "removed" | "absent" {
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
  const aside = join(dirname(expected), version + ".removing-" + process.pid);
  renameSync(expected, aside);
  hooks.afterRenameAside?.();
  rmSync(aside, { recursive: true, force: true });
  return "removed";
}
