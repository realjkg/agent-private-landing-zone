import {
  execFileSync,
} from "node:child_process";
import {
  readFileSync,
} from "node:fs";
import {
  isAbsolute,
  relative,
  resolve,
} from "node:path";

import {
  sha256Buffer,
} from "../release/manifest.js";

export type RepositoryEvidence = {
  commitSha: string;
  clean: boolean;
  packageLockHash?: string;
};

type InstalledReleaseManifest = {
  sourceCommit?: string;
  files?: Array<{
    path?: string;
    sha256?: string;
  }>;
};

function runGit(
  args: string[],
): string {
  return execFileSync(
    "git",
    args,
    {
      encoding: "utf8",
      stdio: [
        "ignore",
        "pipe",
        "pipe",
      ],
    },
  ).trim();
}

function readLockHash():
  | string
  | undefined {
  try {
    // Binary-safe and identical to the digest the release manifest
    // records: hashing the utf8 *string* diverges from sha256File for
    // non-text artifacts (e.g. the vendored pixel font), which made the
    // doctor's repository control report a clean install as dirty.
    return sha256Buffer(
      readFileSync(
        "package-lock.json",
      ),
    );
  } catch {
    return undefined;
  }
}

function safeArtifactPath(
  root: string,
  path: string,
): string | undefined {
  if (
    !path ||
    isAbsolute(path) ||
    path.includes("..")
  ) {
    return undefined;
  }

  const target =
    resolve(root, path);
  const relation =
    relative(root, target);

  if (
    relation === "" ||
    relation === "." ||
    relation.startsWith("..") ||
    isAbsolute(relation)
  ) {
    return undefined;
  }

  return target;
}

function collectInstalledReleaseEvidence():
  | RepositoryEvidence
  | undefined {
  let manifest:
    InstalledReleaseManifest;

  try {
    manifest =
      JSON.parse(
        readFileSync(
          "release-manifest.json",
          "utf8",
        ),
      ) as InstalledReleaseManifest;
  } catch {
    return undefined;
  }

  if (
    !manifest.sourceCommit ||
    !/^[0-9a-f]{40}$/.test(
      manifest.sourceCommit,
    ) ||
    !Array.isArray(
      manifest.files,
    )
  ) {
    return undefined;
  }

  const root =
    resolve(
      process.cwd(),
    );
  let intact = true;

  for (const file of
    manifest.files) {
    if (
      typeof file.path !==
        "string" ||
      typeof file.sha256 !==
        "string"
    ) {
      intact = false;
      continue;
    }

    const target =
      safeArtifactPath(
        root,
        file.path,
      );

    if (!target) {
      intact = false;
      continue;
    }

    try {
      // Must agree with the manifest's sha256File: hash the raw bytes,
      // never a utf8-decoded string (binary artifacts in the release
      // tree — fonts, images — do not round-trip through utf8).
      const actual =
        sha256Buffer(
          readFileSync(
            target,
          ),
        );

      if (
        actual !==
          file.sha256
      ) {
        intact = false;
      }
    } catch {
      intact = false;
    }
  }

  const packageLockHash =
    readLockHash();
  const expectedLock =
    manifest.files.find(
      (file) =>
        file.path ===
        "package-lock.json",
    )?.sha256;

  if (
    !packageLockHash ||
    expectedLock !==
      packageLockHash
  ) {
    intact = false;
  }

  return {
    commitSha:
      manifest.sourceCommit,
    clean: intact,
    packageLockHash,
  };
}

export function collectRepositoryEvidence():
  RepositoryEvidence {
  const packageLockHash =
    readLockHash();

  try {
    const commitSha =
      runGit([
        "rev-parse",
        "HEAD",
      ]);
    const status =
      runGit([
        "status",
        "--porcelain",
      ]);

    return {
      commitSha,
      clean:
        status.length === 0,
      packageLockHash,
    };
  } catch {
    const release =
      collectInstalledReleaseEvidence();

    if (release) {
      return release;
    }

    return {
      commitSha:
        "UNKNOWN",
      clean: false,
      packageLockHash,
    };
  }
}
