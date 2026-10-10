import { chmodSync, lstatSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Cleanup that does not depend on a `finally` block being reached.
 *
 * A plan file, a work copy and a snapshot are plaintext material (docs/teardown-broker-review.md, G4).
 * Every directory the driver creates registers a remover here, and the CLI
 * calls `runCleanups` from its SIGINT, SIGTERM and SIGHUP handlers. A stale
 * sweep at startup removes what a run killed by SIGKILL or a crash left.
 *
 * LIMIT: the engine runs under a blocking child-process call, and Node cannot run a
 * signal handler while the thread is blocked in it. A signal sent to the node
 * process alone is handled when the current engine step ends (at most its
 * timeout), not at once. A Ctrl-C from the terminal reaches the engine too, so
 * the step ends and the handler runs. SIGKILL cannot be handled at all; the
 * sweep covers it on the next run.
 */
const removers = new Set<() => void>();

/** Returns the function that unregisters it. The remover is run at most once. */
export function registerCleanup(remover: () => void): () => void {
  let done = false;
  const once = () => { if (!done) { done = true; remover(); } };
  removers.add(once);
  return () => { removers.delete(once); };
}

/** Runs and clears every registered remover. A failing one does not stop the rest. Returns how many failed. */
export function runCleanups(): number {
  let failed = 0;
  for (const remover of [...removers]) {
    removers.delete(remover);
    try { remover(); } catch { failed += 1; }
  }
  return failed;
}

/** Makes a tree writable first: code that ran in it may have left read-only directories, which rmSync cannot enter. */
export function removeTree(path: string): void {
  const open = (current: string): void => {
    let stat;
    try { stat = lstatSync(current); } catch { return; }
    if (stat.isSymbolicLink()) return;
    try { chmodSync(current, stat.isDirectory() ? 0o700 : 0o600); } catch { /* removal below reports it */ }
    if (stat.isDirectory()) for (const name of readdirSync(current)) open(join(current, name));
  };
  open(path);
  try { rmSync(path, { recursive: true }); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

const STALE_PREFIXES = ["alz-preview-", "alz-snapshot-", "alz-child-"] as const;

/**
 * Removes directories of this account, with the driver's prefixes, that are
 * older than `olderThanMs` (by default one hour, well past the 120 s step
 * timeout). A younger directory may belong to a run in another terminal.
 * Never follows a link, never touches another account's directory.
 */
export function sweepStale(parent: string = tmpdir(), olderThanMs = 60 * 60 * 1000, now = Date.now()): string[] {
  const removed: string[] = [];
  const owner = process.getuid?.();
  let names: string[];
  try { names = readdirSync(parent); } catch { return removed; }
  for (const name of names) {
    if (!STALE_PREFIXES.some((prefix) => name.startsWith(prefix))) continue;
    const path = join(parent, name);
    try {
      const stat = lstatSync(path);
      if (!stat.isDirectory() || stat.isSymbolicLink() || (owner !== undefined && stat.uid !== owner)) continue;
      if (now - statSync(path).mtimeMs < olderThanMs) continue;
      removeTree(path);
      removed.push(name);
    } catch { /* best effort: a directory that cannot be removed is left for the next sweep */ }
  }
  return removed.sort();
}
