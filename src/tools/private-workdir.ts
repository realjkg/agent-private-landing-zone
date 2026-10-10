import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * A protected temporary directory: created `0700`, verified, and removed on
 * request. The runner gives every child its own as `HOME` and `TMPDIR`, and a
 * future destroy-preview driver keeps plan files here. Plan and state output
 * can contain secrets in plaintext (docs/teardown-broker-review.md, G4), so
 * such artifacts never go in a shared directory and never outlive the run.
 */
export type PrivateDirectory = {
  path: string;
  /** Idempotent. Removes the directory and everything in it. */
  remove(): void;
};

export function createPrivateDirectory(
  prefix = "alz-private-",
  parent: string = tmpdir(),
): PrivateDirectory {
  const path = mkdtempSync(join(parent, prefix));
  chmodSync(path, 0o700);
  const mode = statSync(path).mode & 0o777;
  const owner = process.getuid?.();
  if ((mode & 0o077) !== 0 || (owner !== undefined && statSync(path).uid !== owner)) {
    rmSync(path, { recursive: true, force: true });
    throw new Error("PRIVATE_DIRECTORY_NOT_PROTECTED");
  }
  return {
    path,
    remove: () => rmSync(path, { recursive: true, force: true }),
  };
}

/** A `home` and a `tmp` directory inside one private directory, for one child process. */
export function createChildSandbox(): PrivateDirectory & { home: string; tmp: string } {
  const root = createPrivateDirectory("alz-child-");
  const home = join(root.path, "home");
  const tmp = join(root.path, "tmp");
  mkdirSync(home, { mode: 0o700 });
  mkdirSync(tmp, { mode: 0o700 });
  return { ...root, home, tmp };
}
