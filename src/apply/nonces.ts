import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs";
import { join } from "node:path";

import { repoPaths } from "./contract.js";

/**
 * Consumed approval nonces: an append-only 0600 JSONL file. Every read and
 * write fails closed. An unreadable, malformed or loosely permissioned store
 * throws, so an approval is never accepted when replay cannot be ruled out.
 * Consumption takes an exclusive-create lock file; a held or stale lock also
 * fails closed and is cleared by the operator, never by the code.
 */
export class NonceStoreError extends Error {}

export type NonceStore = {
  /** True when the nonce was consumed. Throws NonceStoreError when that cannot be determined. */
  has(nonce: string): boolean;
  /** Records every nonce or none. Returns false, recording nothing, if any was already consumed or repeated. */
  consumeAll(entries: { nonce: string; approverId: string; artifactSha256: string }[]): boolean;
};

const FILE = "consumed-nonces.jsonl";
const LOCK = "consumed-nonces.lock";

export function openNonceStore(dir: string = repoPaths().nonces): NonceStore {
  const file = join(dir, FILE);
  const lock = join(dir, LOCK);

  const load = (): Set<string> => {
    if (!existsSync(file)) return new Set();
    try {
      const fd = openSync(file, "r");
      try {
        if ((fstatSync(fd).mode & 0o077) !== 0) throw new NonceStoreError("nonce store permissions are too open");
        const seen = new Set<string>();
        for (const line of readFileSync(fd, "utf8").split("\n")) {
          if (!line) continue;
          const record = JSON.parse(line) as { nonce?: unknown };
          if (typeof record.nonce !== "string") throw new NonceStoreError("nonce store record is malformed");
          seen.add(record.nonce);
        }
        return seen;
      } finally {
        closeSync(fd);
      }
    } catch (error) {
      throw error instanceof NonceStoreError ? error : new NonceStoreError("nonce store is unreadable");
    }
  };

  return {
    has: (nonce) => load().has(nonce),
    consumeAll(entries) {
      try {
        mkdirSync(dir, { recursive: true, mode: 0o700 });
      } catch {
        throw new NonceStoreError("nonce store directory is unavailable");
      }
      let lockFd: number;
      try {
        lockFd = openSync(lock, "wx", 0o600);
      } catch {
        throw new NonceStoreError("nonce store is locked or unavailable");
      }
      try {
        const seen = load();
        const incoming = new Set<string>();
        for (const { nonce } of entries) {
          if (seen.has(nonce) || incoming.has(nonce)) return false;
          incoming.add(nonce);
        }
        const consumedAt = new Date().toISOString();
        const text = entries.map((e) => JSON.stringify({ ...e, consumedAt }) + "\n").join("");
        const fd = openSync(file, "a", 0o600);
        try {
          writeSync(fd, text);
        } finally {
          closeSync(fd);
        }
        return true;
      } finally {
        closeSync(lockFd);
        unlinkSync(lock);
      }
    },
  };
}
