import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Where the product source commit came from: the git checkout it runs in, or the stamp baked into the packaged image. */
export type SourceOrigin = "GIT_CHECKOUT" | "BUILD_STAMP";
export type SourceCommit = { ok: true; commit: string; origin: SourceOrigin } | { ok: false; reason: string };

const COMMIT = /^[0-9a-f]{40}$/;

/**
 * The product commit a pilot seal or apply runs from (docs/act-pilot-apply.md, "Source-bound evidence").
 *
 * A git checkout is the authority when there is one: HEAD, and only while nothing tracked or unignored is changed, so
 * evidence never names a commit the running code differs from. The environment stamp cannot override a checkout. Without
 * a checkout (the packaged image, which ./alz builds only from a clean commit) the image's ALZ_SOURCE_COMMIT is used.
 * Anything else is refused: a commit is never guessed.
 *
 * `committed` names files (repository-relative) whose bytes must be exactly HEAD's whenever they exist in a checkout: the pilot
 * contract, whose committed text is the ACT authorization. That closes what `git status` cannot see (a file marked
 * skip-worktree or assume-unchanged, or an untracked one hidden by .git/info/exclude).
 */
export function resolveSourceCommit(root: string, env: NodeJS.ProcessEnv = process.env, committed: readonly string[] = []): SourceCommit {
  if (existsSync(join(root, ".git"))) {
    const git = (...args: string[]): string | undefined => {
      try {
        return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 10_000 }).trim();
      } catch { return undefined; }
    };
    const commit = git("rev-parse", "--verify", "HEAD^{commit}");
    if (commit === undefined || !COMMIT.test(commit)) return { ok: false, reason: "The git checkout has no readable commit." };
    const status = git("status", "--porcelain");
    if (status === undefined) return { ok: false, reason: "The git checkout's changes could not be read." };
    if (status !== "") return { ok: false, reason: "The checkout has uncommitted changes. Commit or remove them, so the evidence names the code that ran." };
    for (const path of committed) {
      if (!existsSync(join(root, path))) continue;
      let head: Buffer | undefined;
      try { head = execFileSync("git", ["-C", root, "show", "HEAD:" + path], { stdio: ["ignore", "pipe", "ignore"], timeout: 10_000 }); } catch { head = undefined; }
      if (head === undefined || !head.equals(readFileSync(join(root, path)))) {
        return { ok: false, reason: path + " is not exactly the committed file (an uncommitted, hidden or untracked edit). Commit it in a reviewed change, or restore it." };
      }
    }
    return { ok: true, commit, origin: "GIT_CHECKOUT" };
  }
  const stamp = env.ALZ_SOURCE_COMMIT;
  if (typeof stamp === "string" && COMMIT.test(stamp)) return { ok: true, commit: stamp, origin: "BUILD_STAMP" };
  return { ok: false, reason: "There is no git checkout and no build stamp, so the product source commit is unknown." };
}
