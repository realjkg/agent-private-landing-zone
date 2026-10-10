import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { canonicalJson, type ArtifactManifest } from "../../manifest.js";
import { captureProjectFiles } from "../../snapshot.js";

/**
 * The writable work copy both project-mode adapters run in, and the check that
 * it still holds exactly what the manifest names. The read-only snapshot is
 * only 0500/0400 and owned by the same user as the project code that runs, so
 * the snapshot is never the working directory: code that runs here can change
 * this copy, and the copy is compared with the manifest after every process.
 *
 * Codes only, no engine output: a code can be shown, a plan or state excerpt
 * cannot.
 */
export const LOCK_FILE = ".terraform.lock.hcl";

const digest = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");

/** Copies regular files and directories; anything else (a link, a device) is a code, not a skip. */
export function copyTree(from: string, to: string): string | undefined {
  mkdirSync(to, { mode: 0o700 });
  for (const name of readdirSync(from).sort()) {
    const source = join(from, name);
    const stat = lstatSync(source);
    if (stat.isDirectory()) {
      const problem = copyTree(source, join(to, name));
      if (problem) return problem;
    } else if (stat.isFile()) writeFileSync(join(to, name), readFileSync(source), { mode: 0o600, flag: "wx" });
    else return "SNAPSHOT_ENTRY_NOT_COPYABLE";
  }
  return undefined;
}

/**
 * Undefined when the directory holds exactly the manifest's files, byte for
 * byte (and, if the manifest names a lock file hash, that lock file). Otherwise
 * a code naming the first differences.
 *
 * `captureProjectFiles` does not walk .terraform, .git, .pulumi, node_modules
 * or .agentic-private, so what an engine installs there is NOT checked here.
 * The Terraform adapter checks module sources separately; see
 * docs/destroy-preview-driver.md, "Not verified".
 */
export function projectDifference(work: string, manifest: ArtifactManifest): string | undefined {
  let actual;
  try { actual = captureProjectFiles(work); } catch { return "PROJECT_FILES_REFUSED"; }
  const sorted = (files: readonly { path: string; sha256: string }[]) =>
    canonicalJson([...files].sort((a, b) => (a.path < b.path ? -1 : 1)));
  if (sorted(actual) !== sorted(manifest.files)) {
    const listed = new Map(manifest.files.map((file) => [file.path, file.sha256]));
    const differing = [...new Set([
      ...actual.filter((file) => listed.get(file.path) !== file.sha256).map((file) => file.path),
      ...manifest.files.filter((file) => !actual.some((a) => a.path === file.path)).map((file) => file.path),
    ])].sort().slice(0, 10);
    return "PROJECT_CHANGED:" + differing.join(",");
  }
  if (manifest.lockFileSha256 !== undefined) {
    let lock: Buffer | undefined;
    try { lock = readFileSync(join(work, LOCK_FILE)); } catch { /* absent */ }
    if (lock === undefined) return "LOCK_FILE_MISSING";
    if (digest(lock) !== manifest.lockFileSha256) return "LOCK_FILE_CHANGED";
  }
  return undefined;
}
