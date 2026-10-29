import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, realpathSync, renameSync, rmSync, writeSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import { EvidencePathError } from "./config.js";

/**
 * How the evidence runner writes a file without being redirected (review notes N1 and N6 on #291).
 *
 * Every folder the runner writes into was built by `evidencePath` on the repository's real path, so a folder is genuine
 * only while its real path is still exactly that path: any symbolic link anywhere on the way, including a folder swapped
 * for a link after an earlier check, makes the two differ. Each write therefore:
 *
 *  1. re-checks the folder (a real directory, and its real path is the expected one) immediately before opening;
 *  2. opens the file with `O_NOFOLLOW`, so a link at the file name itself is refused (`ELOOP`), never followed. A whole
 *     document is written to a new, exclusively created temporary file and renamed over the target, which replaces a
 *     directory entry and never follows one; a link already sitting at the target name is refused first;
 *  3. after writing, checks that the open file is a regular file with one link, that it is the file now at the path
 *     (same device and inode), and that the folder's real path has not changed, and refuses otherwise.
 *
 * Node has no `openat`, so a folder swapped in the instant between step 1 and step 2 cannot be prevented; step 3 detects
 * it and the run stops with `EVIDENCE_PATH_REFUSED` rather than continuing as if the write had landed where it should. A
 * folder swapped between the temporary file's check and the rename makes the rename fail (`ENOENT`), which is reported the
 * same way; the temporary file and anything already written stay in the moved folder, never outside it.
 *
 * Every write checks that all its bytes were written (a short write is refused, review N1 on #292). A temporary file left
 * by a run that was killed between creating it and the rename (`.<name>.tmp-<pid>`, review N4) is removed by the next
 * write into the same folder once its process is gone; a live process's file and anything that is not a plain file are
 * left alone.
 */
export function assertRealFolder(dir: string): void {
  let stat;
  try { stat = lstatSync(dir); } catch { throw new EvidencePathError(dir + " does not exist."); }
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new EvidencePathError(basename(dir) + " is not a real folder; evidence is never written through a symbolic link.");
  let real: string;
  try { real = realpathSync(dir); } catch { throw new EvidencePathError(dir + " could not be resolved."); }
  if (real !== dir) throw new EvidencePathError(dir + " resolves elsewhere (" + real + "); a folder on the evidence path was replaced by a symbolic link.");
}

/** Creates the folder (0700) if needed, then checks it is genuine. */
export function ensureRealFolder(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  assertRealFolder(dir);
}

function verifyWritten(fd: number, path: string): void {
  const opened = fstatSync(fd);
  if (!opened.isFile() || opened.nlink !== 1) throw new EvidencePathError(basename(path) + " is not a plain file with a single link; refused.");
  let current;
  try { current = lstatSync(path); } catch { throw new EvidencePathError(basename(path) + " disappeared while it was written."); }
  if (current.dev !== opened.dev || current.ino !== opened.ino) throw new EvidencePathError(basename(path) + " was replaced while it was written.");
  assertRealFolder(dirname(path));
}

/**
 * `O_NOFOLLOW` is undefined on Windows, where the flag is dropped (review N5 on #292). There the checks after each open are
 * what protect the write: `appendNoFollow` compares device and inode with the path before and after writing, and
 * `replaceNoFollow` refuses a link at the target before it starts and creates the temporary file exclusively (`O_EXCL`).
 */
const NOFOLLOW = constants.O_NOFOLLOW ?? 0;

/** Writes every byte of `text` at the file's current position, or refuses. `writeSync` may write fewer bytes than asked. */
function writeAll(fd: number, path: string, text: string): void {
  const bytes = Buffer.from(text, "utf8");
  let done = 0;
  while (done < bytes.length) {
    const wrote = writeSync(fd, bytes, done, bytes.length - done);
    if (!Number.isInteger(wrote) || wrote <= 0) throw new EvidencePathError(basename(path) + " was written only in part (" + done + " of " + bytes.length + " bytes); refused.");
    done += wrote;
  }
}

/** Whether a process with this pid is running. A permission error means it exists. */
export function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

/** Removes `.<name>.tmp-<pid>` files in `dir` whose process is gone (review N4). Never follows or removes anything else. */
export function sweepStaleTemporaries(dir: string, name: string, alive: (pid: number) => boolean = processAlive): void {
  const prefix = "." + name + ".tmp-";
  let entries: string[];
  try { entries = readdirSync(dir); } catch { return; }
  for (const entry of entries) {
    if (!entry.startsWith(prefix)) continue;
    const pid = Number(entry.slice(prefix.length));
    if (!Number.isInteger(pid) || pid < 1 || pid === process.pid || alive(pid)) continue;
    const path = join(dir, entry);
    let stat;
    try { stat = lstatSync(path); } catch { continue; }
    if (stat.isFile() && !stat.isSymbolicLink()) rmSync(path, { force: true });
  }
}

/** Appends `text` to the file at `path` (created 0600 when missing), never through a link. */
export function appendNoFollow(path: string, text: string): void {
  assertRealFolder(dirname(path));
  let fd: number;
  try { fd = openSync(path, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | NOFOLLOW, 0o600); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ELOOP") throw new EvidencePathError(basename(path) + " is a symbolic link; evidence is never written through one.");
    throw error;
  }
  try {
    verifyWritten(fd, path);
    writeAll(fd, path, text);
    verifyWritten(fd, path);
  } finally {
    closeSync(fd);
  }
}

/** Replaces the file at `path` with `text` (0600), never through a link: exclusive temporary file, then rename. */
export function replaceNoFollow(path: string, text: string): void {
  const dir = dirname(path);
  assertRealFolder(dir);
  try {
    if (lstatSync(path).isSymbolicLink()) throw new EvidencePathError(basename(path) + " is a symbolic link; evidence is never written through one.");
  } catch (error) {
    if (error instanceof EvidencePathError) throw error;
  }
  sweepStaleTemporaries(dir, basename(path));
  const temporary = join(dir, "." + basename(path) + ".tmp-" + process.pid);
  rmSync(temporary, { force: true });
  const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW, 0o600);
  try {
    writeAll(fd, temporary, text);
    if (fstatSync(fd).size !== Buffer.byteLength(text, "utf8")) throw new EvidencePathError(basename(path) + " does not hold every byte that was written; refused.");
    verifyWritten(fd, temporary);
    try { renameSync(temporary, path); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new EvidencePathError(basename(path) + " could not be put in place: its folder was moved or replaced while it was written.");
      throw error;
    }
    verifyWritten(fd, path);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  } finally {
    closeSync(fd);
  }
}

/**
 * Opens a new log file for a child's output (0600, never through a link at its name, never over an existing file), in a
 * folder checked as genuine. The caller closes the descriptor after the child ends.
 */
export function openLogNoFollow(path: string): number {
  ensureRealFolder(dirname(path));
  try {
    return openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW, 0o600);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ELOOP" || code === "EEXIST") throw new EvidencePathError(basename(path) + " already exists or is a link; a log is never written through one or over one.");
    throw error;
  }
}
