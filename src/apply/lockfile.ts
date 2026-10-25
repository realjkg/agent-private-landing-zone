/**
 * Reads provider sources and versions from a Terraform dependency lock file (`.terraform.lock.hcl`), so
 * `./alz apply prepare` records what the lock file pins instead of asking the operator. Only the `provider "..."`
 * blocks and their `version = "..."` line are read; anything unexpected is refused rather than guessed.
 */
export type LockedProvider = { source: string; version: string };

const SOURCE = /^[a-z0-9.-]+\/[a-z0-9_-]+\/[a-z0-9_-]+$/;
const VERSION = /^\d+\.\d+\.\d+(?:-[A-Za-z0-9.]+)?$/;

export class LockFileError extends Error {
  constructor(readonly code: "LOCK_FILE_EMPTY" | "LOCK_FILE_UNREADABLE" | "LOCK_FILE_DUPLICATE_PROVIDER", message: string) {
    super(message);
  }
}

/** Every provider block, sorted by source. A block without exactly one well-formed version is refused. */
export function lockedProviders(text: string): LockedProvider[] {
  const found: LockedProvider[] = [];
  const blocks = text.matchAll(/^provider\s+"([^"\n]+)"\s*\{\n([\s\S]*?)^\}/gm);
  for (const [, source, body] of blocks) {
    const versions = [...body.matchAll(/^\s*version\s*=\s*"([^"\n]*)"\s*$/gm)].map((match) => match[1]);
    if (!SOURCE.test(source) || versions.length !== 1 || !VERSION.test(versions[0])) {
      throw new LockFileError("LOCK_FILE_UNREADABLE", "The lock file has a provider entry this app cannot read safely: " + source.slice(0, 120));
    }
    if (found.some((entry) => entry.source === source)) {
      throw new LockFileError("LOCK_FILE_DUPLICATE_PROVIDER", "The lock file names a provider twice: " + source);
    }
    found.push({ source, version: versions[0] });
  }
  if (found.length === 0) throw new LockFileError("LOCK_FILE_EMPTY", "The lock file pins no providers. Run terraform init once in the project and commit the lock file.");
  return found.sort((a, b) => a.source.localeCompare(b.source));
}
