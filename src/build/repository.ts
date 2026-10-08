import {
  execFileSync,
} from "node:child_process";
import {
  readFileSync,
  lstatSync,
  readdirSync,
} from "node:fs";
import {
  isAbsolute,
  relative,
  resolve,
} from "node:path";

import {
  sha256,
} from "./provenance.js";
import {
  validateReleaseManifest,
  sha256Buffer,
  type PreviewOperateReleaseManifest,
} from "../release/manifest.js";

export type RepositoryEvidence = {
  commitSha: string;
  clean: boolean;
  packageLockHash?: string;
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
    return sha256(
      readFileSync(
        "package-lock.json",
        "utf8",
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
  try {
    const manifest = JSON.parse(
      readFileSync("release-manifest.json", "utf8"),
    ) as PreviewOperateReleaseManifest;
    if (validateReleaseManifest(manifest).length > 0) return undefined;

    const root = resolve(process.cwd());
    const recorded = new Map(manifest.files.map(file => [file.path, file.sha256]));
    let intact = true;
    for (const file of manifest.files) {
      const target = safeArtifactPath(root, file.path);
      if (!target) { intact = false; continue; }
      // Symlinks (including parent directories) are not immutable artifacts.
      let cursor = root;
      for (const part of file.path.split("/")) {
        cursor = resolve(cursor, part);
        if (lstatSync(cursor).isSymbolicLink()) return undefined;
      }
      if (!lstatSync(target).isFile() ||
          sha256Buffer(readFileSync(target)) !== file.sha256) intact = false;
    }

    // Missing manifest entries must not make tampered executable code invisible.
    const requireCovered = (directory: string): void => {
      const metadata = lstatSync(resolve(root, directory));
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
        intact = false;
        return;
      }
      for (const entry of readdirSync(resolve(root, directory), { withFileTypes: true })) {
        const path = directory + "/" + entry.name;
        if (entry.isDirectory()) requireCovered(path);
        else if (!entry.isFile() || !recorded.has(path)) intact = false;
      }
    };
    requireCovered("dist");
    requireCovered("config");
    for (const path of ["package.json", "package-lock.json", "dist/cli/operator.js", manifest.sbom.path]) {
      if (!recorded.has(path)) intact = false;
    }
    const packageLockHash = readLockHash();
    if (!packageLockHash || recorded.get("package-lock.json") !== packageLockHash ||
        recorded.get(manifest.sbom.path) !== manifest.sbom.sha256) intact = false;
    const pkg = JSON.parse(readFileSync("package.json", "utf8"));
    if (pkg.name !== manifest.product || pkg.version !== manifest.productVersion) intact = false;
    const sbom = JSON.parse(readFileSync(manifest.sbom.path, "utf8"));
    if (sbom.bomFormat !== "CycloneDX" || !Array.isArray(sbom.components) ||
        typeof sbom.specVersion !== "string") intact = false;

    return { commitSha: manifest.sourceCommit, clean: intact, packageLockHash };
  } catch {
    return undefined;
  }
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
