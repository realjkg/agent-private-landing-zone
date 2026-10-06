import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

import { sha256 } from "./provenance.js";

export type RepositoryEvidence = {
  commitSha: string;
  clean: boolean;
  packageLockHash?: string;
};

function runGit(args: string[]): string {
  return execFileSync("git", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

export function collectRepositoryEvidence(): RepositoryEvidence {
  const commitSha = runGit(["rev-parse", "HEAD"]);
  const status = runGit(["status", "--porcelain"]);

  let packageLockHash: string | undefined;

  try {
    packageLockHash = sha256(
      readFileSync("package-lock.json", "utf8"),
    );
  } catch {
    packageLockHash = undefined;
  }

  return {
    commitSha,
    clean: status.length === 0,
    packageLockHash,
  };
}
