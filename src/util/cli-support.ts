import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const git = (...args: string[]): string =>
  execFileSync("git", args, { encoding: "utf8" }).trim();

export function headCommit(): string {
  return git("rev-parse", "--verify", "HEAD");
}

export function assertCleanSource(code = "SOURCE_WORKTREE_DIRTY"): void {
  if (git("status", "--porcelain")) throw new Error(code);
}

export function csvField(value: string): string {
  return '"' + value.replaceAll('"', '""') + '"';
}

export function csvText<T>(columns: readonly (keyof T & string)[], rows: readonly T[]): string {
  return [
    columns.join(","),
    ...rows.map((row) => columns.map((column) => csvField(String(row[column] ?? ""))).join(",")),
  ].join("\n") + "\n";
}

/** Creates `.runs/<segments...>` (mode 0700) and returns its absolute path. */
export function evidenceDir(...segments: string[]): string {
  const dir = resolve(".runs", ...segments);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

/** Exclusive-create (mode 0600) JSON evidence file. */
export function writeJsonOnce(path: string, value: unknown): void {
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n", {
    encoding: "utf8", mode: 0o600, flag: "wx",
  });
}

export function writeTextOnce(path: string, text: string): void {
  writeFileSync(path, text, { encoding: "utf8", mode: 0o600, flag: "wx" });
}

/** Standard launcher failure handler: `<prefix><message sliced>` plus optional notes. */
export function blockedHandler(prefix: string, max: number, ...notes: string[]) {
  return (error: unknown): void => {
    console.error(prefix + (error instanceof Error ? error.message.slice(0, max) : "UNKNOWN"));
    for (const note of notes) console.error(note);
    process.exitCode = 1;
  };
}
