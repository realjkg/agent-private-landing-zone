import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { resolveSourceCommit, type SourceCommit } from "../util/source-commit.js";

/**
 * The runner's own read-only git questions: the checkout's commit and cleanliness, and which files differ between the
 * candidate and HEAD. `git` runs with a minimal environment (PATH and locale only), so not even git receives the operator's
 * session variables (docs/evidence-runner.md, "Identities"). Without a checkout, the image's build stamp is used as
 * everywhere else (src/util/source-commit.ts).
 */
const COMMIT = /^[0-9a-f]{40}$/;
/** The pilot contract: its committed text is the ACT authorization, so its bytes must be HEAD's (as `./alz apply` requires). */
export const CONTRACT_PATH = "config/act-pilot-contract.json";

export type GitReader = (args: string[]) => Buffer | undefined;

export function gitReader(root: string, env: NodeJS.ProcessEnv): GitReader {
  const minimal: Record<string, string> = { GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1" };
  for (const name of ["PATH", "LANG", "LC_ALL"]) if (env[name]) minimal[name] = env[name]!;
  return (args) => {
    try {
      return execFileSync("git", ["-C", root, ...args], { env: minimal, stdio: ["ignore", "pipe", "ignore"], timeout: 15_000, maxBuffer: 16 * 1024 * 1024 });
    } catch { return undefined; }
  };
}

/** HEAD, refused when anything tracked or unignored is changed, or the contract differs from its committed bytes. */
export function sourceCommitOf(root: string, git: GitReader, env: NodeJS.ProcessEnv): SourceCommit {
  if (!existsSync(join(root, ".git"))) return resolveSourceCommit(root, env);
  const commit = git(["rev-parse", "--verify", "HEAD^{commit}"])?.toString("utf8").trim();
  if (commit === undefined || !COMMIT.test(commit)) return { ok: false, reason: "The git checkout has no readable commit." };
  const status = git(["status", "--porcelain"]);
  if (status === undefined) return { ok: false, reason: "The git checkout's changes could not be read." };
  if (status.length > 0) return { ok: false, reason: "The checkout has uncommitted changes. Commit or remove them, so the evidence names the code that ran." };
  if (existsSync(join(root, CONTRACT_PATH))) {
    const head = git(["show", "HEAD:" + CONTRACT_PATH]);
    if (head === undefined || !head.equals(readFileSync(join(root, CONTRACT_PATH)))) {
      return { ok: false, reason: CONTRACT_PATH + " is not exactly the committed file (an uncommitted, hidden or untracked edit). Commit it in a reviewed change, or restore it." };
    }
  }
  return { ok: true, commit, origin: "GIT_CHECKOUT" };
}

/** The repository paths that differ between two commits, or undefined when git cannot tell (a missing commit, no checkout). */
export function changedPathsOf(git: GitReader, from: string, to: string): string[] | undefined {
  if (!COMMIT.test(from) || !COMMIT.test(to)) return undefined;
  const out = git(["diff", "--no-renames", "--name-only", from, to, "--"]);
  if (out === undefined) return undefined;
  return out.toString("utf8").split("\n").filter((line) => line !== "").sort();
}
