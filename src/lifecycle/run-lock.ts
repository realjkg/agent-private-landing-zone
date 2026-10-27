import { closeSync, mkdirSync, openSync, readFileSync, rmSync, unlinkSync, writeSync } from "node:fs";
import { dirname } from "node:path";

// The exclusive pid lock shared by the lifecycle runner and the pinned-tool installer. It imports neither of them, so
// neither module imports the other.

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

/**
 * Why acquireRunLock did not take a lock: HELD, its pid may be alive (or is this process); UNREADABLE, the lock is empty, torn
 * or names no pid; TAKEOVER, another run holds the takeover token for this stale lock; CONTENDED, the lock changed hands on
 * every attempt.
 */
export type RunLockBusy = { kind: "HELD"; pid: number } | { kind: "UNREADABLE" } | { kind: "TAKEOVER"; token: string } | { kind: "CONTENDED" };

/**
 * One holder at a time for `file`, created exclusively and holding this pid. A lock whose pid is proven dead is stale and
 * replaced; one whose pid may be alive (or that cannot be read) means another run holds it, and `busy` is called with why;
 * it must throw. Released by the run that holds it, only while it still holds it. Taking over a stale lock is itself
 * exclusive: only the run that creates `<lock>.takeover-<dead pid>` may delete a lock, and only after reading it again under
 * that token and finding the same dead pid, so two runs that both saw the stale lock can never delete each other's new one.
 * Used by the lifecycle runner's evidence-folder lock (journal.ts) and the pinned-tool installer's per-tool lock (install.ts).
 */
export function acquireRunLock(file: string, pidAlive: ((pid: number) => boolean) | undefined, busy: (why: RunLockBusy) => never): () => void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 3; attempt += 1) {
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
      if (typeof pid !== "number" || !Number.isInteger(pid) || pid < 1) return busy({ kind: "UNREADABLE" });
      const dead = pid !== process.pid && (pidAlive ? !pidAlive(pid) : pidProvenDead(pid));
      if (!dead) return busy({ kind: "HELD", pid });
      const token = file + ".takeover-" + String(pid);
      let tokenFd: number;
      try { tokenFd = openSync(token, "wx", 0o600); } catch (tokenError) {
        if ((tokenError as NodeJS.ErrnoException).code === "EEXIST") return busy({ kind: "TAKEOVER", token });
        throw tokenError;
      }
      try {
        writeSync(tokenFd, JSON.stringify({ pid: process.pid }) + "\n");
        closeSync(tokenFd);
        let still: unknown;
        try { still = (JSON.parse(readFileSync(file, "utf8")) as { pid?: unknown }).pid; } catch { still = undefined; }
        // Another run may have replaced the stale lock already; then the next attempt meets that run's lock instead.
        if (still === pid) rmSync(file, { force: true });
      } finally {
        rmSync(token, { force: true });
      }
    }
  }
  return busy({ kind: "CONTENDED" });
}
