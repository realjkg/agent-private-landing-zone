import { createHash } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

import { createPrivateDirectory, type PrivateDirectory } from "../tools/private-workdir.js";
import type { ArtifactManifest, ManifestFile } from "./manifest.js";
import { verifyManifest } from "./manifest.js";

/**
 * Immutable-input handling (docs/artifact-binding.md). A preview runs from a
 * private, read-only copy of exactly the files its manifest lists, and the
 * copy is verified from the bytes that were copied, not from the source a
 * second time. A file changing between "hash" and "run" is therefore either
 * caught at copy time or cannot reach the run.
 */
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_TOTAL_BYTES = 64 * 1024 * 1024;

/** Directories and files that are never inputs: state, plans, caches, VCS data. */
const EXCLUDED_DIRECTORIES = new Set([".git", ".terraform", ".pulumi", "node_modules", ".agentic-private"]);
const EXCLUDED_FILE = /(^|\/)(\.agentic-preview\.tfplan|[^/]*\.tfstate(\.backup)?|[^/]*\.tfplan|crash\.log)$/;

/** Standard SHA-256 of the file bytes, so a reviewer can reproduce it with `sha256sum`. */
const digest = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");

export type SnapshotProblem =
  | { code: "SYMLINK" | "NOT_A_REGULAR_FILE" | "TOO_LARGE" | "STATE_OR_PLAN_FILE" | "ESCAPES_ROOT"; path: string }
  | { code: "MISSING" | "CHANGED" | "UNLISTED"; path: string };

function failSnapshot(problems: SnapshotProblem[]): never {
  const summary = problems.map((p) => p.code + ":" + p.path).sort().join(",");
  throw new Error("ARTIFACT_SNAPSHOT_REFUSED:" + summary.slice(0, 600));
}

/** Walks a directory for candidate input files. Reports, never follows, links. */
function walk(root: string, skipCaches = true): { files: string[]; problems: SnapshotProblem[] } {
  const files: string[] = [];
  const problems: SnapshotProblem[] = [];
  const visit = (directory: string) => {
    for (const name of readdirSync(directory).sort()) {
      const full = join(directory, name);
      const path = relative(root, full).split(sep).join("/");
      const stat = lstatSync(full);
      if (stat.isSymbolicLink()) { problems.push({ code: "SYMLINK", path }); continue; }
      if (stat.isDirectory()) {
        if (!skipCaches || !EXCLUDED_DIRECTORIES.has(name)) visit(full);
        continue;
      }
      if (!stat.isFile()) { problems.push({ code: "NOT_A_REGULAR_FILE", path }); continue; }
      if (EXCLUDED_FILE.test(path)) { problems.push({ code: "STATE_OR_PLAN_FILE", path }); continue; }
      if (stat.size > MAX_FILE_BYTES) { problems.push({ code: "TOO_LARGE", path }); continue; }
      files.push(path);
    }
  };
  visit(root);
  return { files, problems };
}

/** Hashes every input file under `root`. Throws if any file is a link, a state or plan file, or too large. */
export function captureProjectFiles(root: string): ManifestFile[] {
  const base = resolve(root);
  const { files, problems } = walk(base);
  if (problems.length > 0) failSnapshot(problems);
  return files.map((path) => ({ path, sha256: digest(readFileSync(join(base, path))) }));
}

export type ImmutableSnapshot = {
  /** The read-only directory the preview runs from. */
  path: string;
  /** Re-checks the snapshot against the manifest; throws on any difference. Call it again right before running. */
  verify(): void;
  remove(): void;
};

/**
 * Copies the manifest's files into a fresh private directory and makes them
 * read-only. The hash is taken from the bytes read for the copy, so a source
 * that changed since the manifest was approved is refused, and the written
 * copy is byte-identical to what was hashed.
 */
export function createImmutableSnapshot(
  sourceRoot: string,
  approved: ArtifactManifest,
  parent?: string,
): ImmutableSnapshot {
  const manifest = verifyManifest(approved);
  if (manifest.mode !== "PROJECT") throw new Error("ARTIFACT_SNAPSHOT_REFUSED:NO_PROJECT_INPUTS_IN_STATE_DERIVED_MODE");
  const base = resolve(sourceRoot);
  const target: PrivateDirectory = createPrivateDirectory("alz-snapshot-", parent);
  const root = join(target.path, "input");
  try {
    mkdirSync(root, { mode: 0o700 });
    const problems: SnapshotProblem[] = [];
    let total = 0;
    for (const file of manifest.files) {
      const from = resolve(base, file.path);
      const inside = relative(base, from);
      if (inside === "" || inside.startsWith("..") || resolve(base, inside) !== from) {
        problems.push({ code: "ESCAPES_ROOT", path: file.path });
        continue;
      }
      let stat;
      try { stat = lstatSync(from); } catch { problems.push({ code: "MISSING", path: file.path }); continue; }
      if (stat.isSymbolicLink()) { problems.push({ code: "SYMLINK", path: file.path }); continue; }
      if (!stat.isFile()) { problems.push({ code: "NOT_A_REGULAR_FILE", path: file.path }); continue; }
      if (EXCLUDED_FILE.test(file.path)) { problems.push({ code: "STATE_OR_PLAN_FILE", path: file.path }); continue; }
      if (stat.size > MAX_FILE_BYTES || (total += stat.size) > MAX_TOTAL_BYTES) {
        problems.push({ code: "TOO_LARGE", path: file.path });
        continue;
      }
      const bytes = readFileSync(from);
      if (digest(bytes) !== file.sha256) { problems.push({ code: "CHANGED", path: file.path }); continue; }
      const to = join(root, file.path);
      mkdirSync(dirname(to), { recursive: true, mode: 0o700 });
      writeFileSync(to, bytes, { mode: 0o400, flag: "wx" });
    }
    if (problems.length > 0) failSnapshot(problems);
    lockReadOnly(root);
    const snapshot: ImmutableSnapshot = {
      path: root,
      verify: () => verifySnapshotDirectory(root, manifest),
      remove: () => {
        makeWritable(target.path);
        target.remove();
      },
    };
    snapshot.verify();
    return snapshot;
  } catch (error) {
    makeWritable(target.path);
    target.remove();
    throw error;
  }
}

/** Throws unless `directory` holds exactly the manifest's files with exactly their hashes. */
export function verifySnapshotDirectory(directory: string, manifest: ArtifactManifest): void {
  const base = resolve(directory);
  // A snapshot hides nothing: even a cache-named directory inside it counts as unlisted content.
  const { files, problems } = walk(base, false);
  const listed = new Map(manifest.files.map((file) => [file.path, file.sha256]));
  for (const path of files) {
    if (!listed.has(path)) problems.push({ code: "UNLISTED", path });
  }
  for (const [path, expected] of listed) {
    if (!files.includes(path)) { problems.push({ code: "MISSING", path }); continue; }
    if (digest(readFileSync(join(base, path))) !== expected) problems.push({ code: "CHANGED", path });
  }
  if (problems.length > 0) failSnapshot(problems);
}

/** Reports how a working directory differs from a manifest, for a reviewer. Does not repair anything. */
export function compareProject(root: string, manifest: ArtifactManifest): { added: string[]; removed: string[]; changed: string[] } {
  const base = resolve(root);
  const { files } = walk(base);
  const listed = new Map(manifest.files.map((file) => [file.path, file.sha256]));
  const changed: string[] = [];
  for (const path of files) {
    const expected = listed.get(path);
    if (expected !== undefined && digest(readFileSync(join(base, path))) !== expected) changed.push(path);
  }
  return {
    added: files.filter((path) => !listed.has(path)),
    removed: [...listed.keys()].filter((path) => !files.includes(path)),
    changed,
  };
}

function lockReadOnly(root: string): void {
  const visit = (directory: string) => {
    for (const name of readdirSync(directory)) {
      const full = join(directory, name);
      if (lstatSync(full).isDirectory()) visit(full);
    }
    chmodSync(directory, 0o500);
  };
  visit(root);
}

function makeWritable(root: string): void {
  try {
    const visit = (directory: string) => {
      chmodSync(directory, 0o700);
      for (const name of readdirSync(directory)) {
        const full = join(directory, name);
        const stat = lstatSync(full);
        if (stat.isDirectory()) visit(full);
        else if (!stat.isSymbolicLink()) chmodSync(full, 0o600);
      }
    };
    visit(root);
  } catch {
    // Best effort: removal below reports what could not be cleaned.
  }
}
