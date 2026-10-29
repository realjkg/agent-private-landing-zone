import { randomBytes } from "node:crypto";
import { closeSync, constants, fchmodSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, renameSync, rmSync, writeSync } from "node:fs";
import { basename, dirname, join } from "node:path";

/** `O_NOFOLLOW` is undefined on Windows; there the exclusive create and the checks below are what protect the write. */
const NOFOLLOW = constants.O_NOFOLLOW ?? 0;

/** Why a private file was not written: the target or the file being written is not what it must be. Nothing was replaced. */
export class PrivateFileError extends Error {
  readonly code = "PRIVATE_FILE_REFUSED";
}

/**
 * Writes a whole private document (0600) atomically, never through a link (#362 review N2). The folder is created 0700 when missing.
 * A symbolic link, or anything that is not a regular file, at the target name is refused before anything is written. The bytes go to
 * a new temporary file beside the target, opened with `O_CREAT | O_EXCL | O_NOFOLLOW` (so it is new, ours, and never a followed
 * link), written in full, flushed and set to 0600 on the open file, then renamed over the target: a rename replaces the directory
 * entry and never follows one, and a reader sees the old document or the new one, never a partial one. Every rewrite gets 0600,
 * whatever mode an earlier file had. On any failure the temporary file is removed and the target is left as it was. `seams` is for
 * tests only (a failure just before the rename).
 *
 * The layer is `src/tools` so the apply CLI can use it: `src/apply` and the CLI never import the evidence runner, which has its own
 * stricter writer for its evidence folders (`src/evidence-runner/safe-write.ts`).
 */
export function writePrivateFileAtomic(path: string, content: string | Buffer, seams: { beforeRename?: () => void } = {}): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  let existing;
  try { existing = lstatSync(path); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  if (existing && (existing.isSymbolicLink() || !existing.isFile())) {
    throw new PrivateFileError(basename(path) + " is not a regular file (a symbolic link or something else is at its name); nothing was written.");
  }
  const temporary = join(dir, "." + basename(path) + ".tmp-" + process.pid + "-" + randomBytes(6).toString("hex"));
  const bytes = typeof content === "string" ? Buffer.from(content, "utf8") : content;
  let fd: number | undefined;
  let renamed = false;
  try {
    fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW, 0o600);
    let written = 0;
    while (written < bytes.length) {
      const count = writeSync(fd, bytes, written, bytes.length - written);
      if (count <= 0) throw new PrivateFileError(basename(path) + ": a write made no progress; nothing was replaced.");
      written += count;
    }
    fchmodSync(fd, 0o600);
    fsyncSync(fd);
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.nlink !== 1) throw new PrivateFileError(basename(path) + ": the temporary file is not a plain file with one link; nothing was replaced.");
    seams.beforeRename?.();
    renameSync(temporary, path);
    renamed = true;
    const now = lstatSync(path);
    if (now.dev !== opened.dev || now.ino !== opened.ino) throw new PrivateFileError(basename(path) + " was replaced while it was written.");
  } finally {
    if (fd !== undefined) closeSync(fd);
    if (!renamed) rmSync(temporary, { force: true });
  }
}
