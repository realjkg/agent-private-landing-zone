import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import {
  chmod,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import {
  relative,
  resolve,
  sep,
} from "node:path";

import { BRAND_PROVENANCE } from "../brand/identity.js";

export const RELEASE_BRAND_FILE_NAME = "brand-provenance.json";

import {
  createReleaseManifest,
  sha256File,
  validateReleaseManifest,
  verifyReleaseArtifact,
  type ReleaseFileEvidence,
  type PreviewOperateReleaseManifest,
} from "../release/manifest.js";

function readArg(
  name: string,
): string | undefined {
  const args =
    process.argv.slice(2);
  const index =
    args.indexOf(name);

  return index >= 0
    ? args[index + 1]
    : undefined;
}

function hasFlag(
  name: string,
): boolean {
  return process.argv
    .slice(2)
    .includes(name);
}

async function collectFiles(
  root: string,
  directory = root,
): Promise<string[]> {
  const entries =
    await readdir(
      directory,
      {
        withFileTypes: true,
      },
    );

  const output:
    string[] = [];

  for (const entry of entries) {
    if (
      entry.name ===
        "release-manifest.json" ||
      entry.name ===
        "node_modules"
    ) {
      continue;
    }

    const absolute =
      resolve(
        directory,
        entry.name,
      );

    if (entry.isDirectory()) {
      output.push(
        ...(await collectFiles(
          root,
          absolute,
        )),
      );
      continue;
    }

    if (!entry.isFile()) {
      continue;
    }

    const path =
      relative(
        root,
        absolute,
      ).split(sep).join("/");

    output.push(path);
  }

  return output.sort();
}

async function readManifest(
  root: string,
): Promise<
  PreviewOperateReleaseManifest
> {
  const raw =
    await readFile(
      resolve(
        root,
        "release-manifest.json",
      ),
      "utf8",
    );

  return JSON.parse(
    raw,
  ) as PreviewOperateReleaseManifest;
}

async function verify(
  root: string,
): Promise<void> {
  const manifest =
    await readManifest(root);
  const blockers =
    await verifyReleaseArtifact(
      root,
      manifest,
    );

  if (
    blockers.length > 0
  ) {
    for (const blocker of
      blockers) {
      console.error(
        "! " + blocker,
      );
    }

    process.exitCode = 1;
    return;
  }

  console.log(
    "✓ release manifest valid",
  );
  console.log(
    "✓ artifact file integrity verified",
  );
  console.log(
    "✓ SBOM integrity verified",
  );
  console.log(
    "✓ ACT remains disabled",
  );
}

async function generate(
  root: string,
  version: string,
  sourceCommit: string,
): Promise<void> {
  // A branded release contains a byte-identical origin declaration.
  // Publish it before enumerating files so the existing signed/source-bound
  // release manifest also checks its SHA-256. No change to schema v1.
  const tempBrandPath = resolve(root, ".brand-origin-" + randomUUID() + ".tmp");
  try {
    await writeFile(
      tempBrandPath,
      JSON.stringify(BRAND_PROVENANCE, null, 2) + "\n",
      { encoding: "utf8", mode: 0o600, flag: "wx" },
    );
    // Atomic replacement does not follow a preexisting output symlink.
    const brandDestination = resolve(root, RELEASE_BRAND_FILE_NAME);
    await rename(tempBrandPath, brandDestination);
    // The declaration is public metadata, not a secret. The hardened Docker
    // image verifies its release as an unprivileged 'node' user.
    await chmod(brandDestination, 0o644);
  } finally {
    await rm(tempBrandPath, { force: true });
  }

  const files =
    await collectFiles(root);

  const evidence:
    ReleaseFileEvidence[] = [];

  for (const path of files) {
    evidence.push({
      path,
      sha256:
        await sha256File(
          resolve(
            root,
            path,
          ),
        ),
    });
  }

  const sbomPath =
    "sbom.cdx.json";
  const sbom =
    evidence.find(
      (item) =>
        item.path ===
        sbomPath,
    );

  if (!sbom) {
    throw new Error(
      "RELEASE_SBOM_MISSING",
    );
  }

  const manifest =
    createReleaseManifest({
      productVersion:
        version,
      sourceCommit,
      files: evidence,
      sbomPath,
      sbomSha256:
        sbom.sha256,
    });

  const blockers =
    validateReleaseManifest(
      manifest,
    );

  if (
    blockers.length > 0
  ) {
    throw new Error(
      "RELEASE_MANIFEST_BLOCKED: " +
        blockers.join(" "),
    );
  }

  await writeFile(
    resolve(
      root,
      "release-manifest.json",
    ),
    JSON.stringify(
      manifest,
      null,
      2,
    ) + "\n",
    {
      encoding: "utf8",
      mode: 0o600,
    },
  );

  console.log(
    "Release manifest generated for " +
      version +
      " from " +
      sourceCommit +
      ".",
  );

  await verify(root);
}

export async function runReleasePackage(): Promise<void> {
const root =
  resolve(
    readArg("--root") ??
      ".",
  );

try {
  if (hasFlag("--verify")) {
    await verify(root);
  } else {
    const version =
      readArg("--version");
    const sourceCommit =
      readArg(
        "--source-commit",
      );

    if (
      !version ||
      !sourceCommit
    ) {
      throw new Error(
        "RELEASE_ARGUMENTS_REQUIRED: provide --version and --source-commit.",
      );
    }

    await generate(
      root,
      version,
      sourceCommit,
    );
  }
} catch (error) {
  console.error(
    error instanceof Error
      ? error.message
      : "Release packaging failed.",
  );
  process.exitCode = 1;
}

}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void runReleasePackage();
}
