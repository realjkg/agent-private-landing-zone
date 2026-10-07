import {
  createHash,
} from "node:crypto";
import {
  readFile,
} from "node:fs/promises";

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
