import { closeSync, constants, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, writeSync } from "node:fs";
import { join } from "node:path";

/**
 * A durable write-ahead journal for the run's external actions (LZA submission, AFT submission, each re-invocation).
 *
 * Intent is recorded with an exclusive create before the person is told to act. A second process — or the same run after a
 * crash — that finds the intent gets RECONCILE, never EXECUTE_ONCE, so an action that may already have happened is looked up,
 * not repeated. A receipt (native ids, merge commit) confirms it. Plain files: works on every supported Node and host, needs no
 * service, and keeps no credential (receipts hold identifiers only).
 */
export type EffectDisposition = "EXECUTE_ONCE" | "RECONCILE" | "REUSE";
export type Receipt = Record<string, string>;
type Intent = { actionId: string; digest: string; at: string };

const SAFE = /^[A-Za-z0-9._:-]{1,128}$/;
const SECRETISH = /(token|secret|password|credential|session)/i;

export class OperationStore {
  constructor(private readonly dir: string, private readonly now: () => string = () => new Date().toISOString()) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const stat = lstatSync(dir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("OPERATION_STORE_NOT_A_DIRECTORY");
    if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) throw new Error("OPERATION_STORE_PERMISSIONS: " + dir + " must not be group or world accessible");
  }

  private file(actionId: string, kind: "intent" | "receipt"): string {
    if (!SAFE.test(actionId)) throw new Error("INVALID_ACTION_ID");
    return join(this.dir, actionId.replace(/:/g, "_") + "." + kind + ".json");
  }

  private read<T>(path: string): T | undefined {
    try { return JSON.parse(readFileSync(path, "utf8")) as T; } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw new Error("OPERATION_STORE_CORRUPT: " + path);
    }
  }

  private syncDir(): void {
    if (process.platform === "win32") return;
    const fd = openSync(this.dir, constants.O_RDONLY);
    try { fsyncSync(fd); } finally { closeSync(fd); }
  }

  beginEffect(actionId: string, digest: string): EffectDisposition {
    const receipt = this.read<{ digest: string }>(this.file(actionId, "receipt"));
    if (receipt) { if (receipt.digest !== digest) throw new Error("ACTION_CONTENT_CONFLICT"); return "REUSE"; }
    const path = this.file(actionId, "intent");
    let fd: number;
    try { fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const intent = this.read<Intent>(path);
      if (!intent) return "RECONCILE"; // being written by another process right now
      if (intent.digest !== digest) throw new Error("ACTION_CONTENT_CONFLICT");
      return "RECONCILE";
    }
    try { writeSync(fd, JSON.stringify({ actionId, digest, at: this.now() } satisfies Intent)); fsyncSync(fd); } finally { closeSync(fd); }
    this.syncDir();
    return "EXECUTE_ONCE";
  }

  /** After the person's action returned, or after reconciliation found and verified it. */
  confirmEffect(actionId: string, digest: string, receipt: Receipt): void {
    const intent = this.read<Intent>(this.file(actionId, "intent"));
    if (!intent) throw new Error("NO_INTENT_RECORDED");
    if (intent.digest !== digest) throw new Error("ACTION_CONTENT_CONFLICT");
    for (const key of Object.keys(receipt)) if (SECRETISH.test(key)) throw new Error("RECEIPT_MUST_NOT_HOLD_SECRETS: " + key);
    const existing = this.read<{ digest: string; receipt: Receipt }>(this.file(actionId, "receipt"));
    if (existing) { if (JSON.stringify(existing.receipt) !== JSON.stringify(receipt)) throw new Error("RECEIPT_CONFLICT"); return; }
    const target = this.file(actionId, "receipt");
    const tmp = target + "." + process.pid + ".tmp";
    const fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    try { writeSync(fd, JSON.stringify({ actionId, digest, receipt, at: this.now() })); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(tmp, target);
    this.syncDir();
  }

  hasIntent(actionId: string): boolean {
    return this.read<Intent>(this.file(actionId, "intent")) !== undefined;
  }

  receipt(actionId: string): Receipt | undefined {
    return this.read<{ receipt: Receipt }>(this.file(actionId, "receipt"))?.receipt;
  }
}
