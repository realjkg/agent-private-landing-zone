import {
  createHash,
} from "node:crypto";
import {
  readFile,
} from "node:fs/promises";
import {
  isAbsolute,
  relative,
  resolve,
} from "node:path";

import {
  PRODUCTION_DEPLOYMENT_CONTRACT,
} from "../qualification/production-contract.js";

export type ReleaseFileEvidence = {
  path: string;
  sha256: string;
};

export type PreviewOperateReleaseManifest = {
  schemaVersion: 1;
  product:
    "agent-private-landing-zone";
  productVersion: string;
  sourceCommit: string;
  contract: {
    id: string;
    version: string;
    operatingMode:
      "PREVIEW_OPERATE";
    actEnabled: false;
  };
  configSchemaVersion: 1;
  files: ReleaseFileEvidence[];
  sbom: {
    format: "CycloneDX";
    path: string;
    sha256: string;
  };
  lifecycle: {
    cleanInstall: true;
    upgrade: true;
    rollback: true;
    uninstall: true;
    configurationMigration:
      true;
  };
};

export function sha256Buffer(
  value: Buffer | string,
): string {
  return createHash("sha256")
    .update(value)
    .digest("hex");
}

export async function sha256File(
  path: string,
): Promise<string> {
  return sha256Buffer(
    await readFile(path),
  );
}

function validVersion(
  value: string,
): boolean {
  return /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(
    value,
  );
}

function validCommit(
  value: string,
): boolean {
  return /^[0-9a-f]{40}$/.test(
    value,
  );
}

function validHash(
  value: string,
): boolean {
  return /^[0-9a-f]{64}$/.test(
    value,
  );
}

function safeRelativePath(
  root: string,
  path: string,
): string | undefined {
  if (
    !path ||
    isAbsolute(path) ||
    path.includes("\0")
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

export function createReleaseManifest(input: {
  productVersion: string;
  sourceCommit: string;
  files: ReleaseFileEvidence[];
  sbomPath: string;
  sbomSha256: string;
}): PreviewOperateReleaseManifest {
  if (
    !validVersion(
      input.productVersion,
    )
  ) {
    throw new Error(
      "RELEASE_VERSION_INVALID",
    );
  }

  if (
    !validCommit(
      input.sourceCommit,
    )
  ) {
    throw new Error(
      "RELEASE_SOURCE_COMMIT_INVALID",
    );
  }

  if (
    !validHash(
      input.sbomSha256,
    )
  ) {
    throw new Error(
      "RELEASE_SBOM_HASH_INVALID",
    );
  }

  for (const file of input.files) {
    if (
      file.path.startsWith("/") ||
      file.path.includes("..") ||
      !validHash(file.sha256)
    ) {
      throw new Error(
        "RELEASE_FILE_EVIDENCE_INVALID",
      );
    }
  }

  return {
    schemaVersion: 1,
    product:
      "agent-private-landing-zone",
    productVersion:
      input.productVersion,
    sourceCommit:
      input.sourceCommit,
    contract: {
      id:
        PRODUCTION_DEPLOYMENT_CONTRACT
          .metadata.id,
      version:
        PRODUCTION_DEPLOYMENT_CONTRACT
          .metadata.version,
      operatingMode:
        "PREVIEW_OPERATE",
      actEnabled: false,
    },
    configSchemaVersion: 1,
    files: [...input.files]
      .sort(
        (a, b) =>
          a.path.localeCompare(
            b.path,
          ),
      ),
    sbom: {
      format: "CycloneDX",
      path: input.sbomPath,
      sha256:
        input.sbomSha256,
    },
    lifecycle: {
      cleanInstall: true,
      upgrade: true,
      rollback: true,
      uninstall: true,
      configurationMigration:
        true,
    },
  };
}

export function validateReleaseManifest(
  value:
    PreviewOperateReleaseManifest,
): string[] {
  const blockers: string[] = [];

  if (
    value.schemaVersion !== 1 ||
    value.product !==
      "agent-private-landing-zone"
  ) {
    blockers.push(
      "Release manifest schema or product identity is invalid.",
    );
  }

  if (
    value.contract.id !==
    PRODUCTION_DEPLOYMENT_CONTRACT
      .metadata.id ||
    value.contract.version !==
    PRODUCTION_DEPLOYMENT_CONTRACT
      .metadata.version ||
    value.contract.operatingMode !==
      "PREVIEW_OPERATE" ||
    value.contract.actEnabled !==
      false
  ) {
    blockers.push(
      "Release contract does not match the accepted ProductionDeploymentContract.",
    );
  }

  if (
    !validVersion(
      value.productVersion,
    ) ||
    !validCommit(
      value.sourceCommit,
    )
  ) {
    blockers.push(
      "Release provenance is invalid.",
    );
  }

  if (
    !validHash(
      value.sbom.sha256,
    ) ||
    value.files.some(
      (file) =>
        !validHash(
          file.sha256,
        ),
    )
  ) {
    blockers.push(
      "Release integrity evidence is invalid.",
    );
  }

  const paths =
    value.files.map(
      (file) => file.path,
    );

  if (
    new Set(paths).size !==
      paths.length ||
    paths.some(
      (path) =>
        path.startsWith("/") ||
        path.includes(".."),
    ) ||
    value.sbom.path.startsWith("/") ||
    value.sbom.path.includes("..")
  ) {
    blockers.push(
      "Release manifest contains unsafe or duplicate file paths.",
    );
  }

  if (
    !value.lifecycle.cleanInstall ||
    !value.lifecycle.upgrade ||
    !value.lifecycle.rollback ||
    !value.lifecycle.uninstall ||
    !value.lifecycle
      .configurationMigration
  ) {
    blockers.push(
      "Release lifecycle contract is incomplete.",
    );
  }

  return blockers;
}

export async function verifyReleaseArtifact(
  root: string,
  manifest:
    PreviewOperateReleaseManifest,
): Promise<string[]> {
  const blockers =
    validateReleaseManifest(
      manifest,
    );

  const resolvedRoot =
    resolve(root);

  for (const file of
    manifest.files) {
    const target =
      safeRelativePath(
        resolvedRoot,
        file.path,
      );

    if (!target) {
      blockers.push(
        "Release file path is outside the artifact root: " +
          file.path,
      );
      continue;
    }

    try {
      const actual =
        await sha256File(
          target,
        );

      if (
        actual !== file.sha256
      ) {
        blockers.push(
          "Release file integrity mismatch: " +
            file.path,
        );
      }
    } catch {
      blockers.push(
        "Release file is missing or unreadable: " +
          file.path,
      );
    }
  }

  const sbomTarget =
    safeRelativePath(
      resolvedRoot,
      manifest.sbom.path,
    );

  if (!sbomTarget) {
    blockers.push(
      "SBOM path is outside the artifact root.",
    );
  } else {
    try {
      const actual =
        await sha256File(
          sbomTarget,
        );

      if (
        actual !==
          manifest.sbom.sha256
      ) {
        blockers.push(
          "SBOM integrity mismatch.",
        );
      }
    } catch {
      blockers.push(
        "SBOM is missing or unreadable.",
      );
    }
  }

  return [
    ...new Set(
      blockers,
    ),
  ];
}
