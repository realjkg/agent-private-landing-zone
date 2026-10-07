import {
  createHash,
} from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  writeFile,
} from "node:fs/promises";
import {
  homedir,
} from "node:os";
import {
  dirname,
  isAbsolute,
  relative,
  resolve,
  sep,
} from "node:path";

import {
  decryptEvidence,
  encryptEvidence,
  ensureEvidenceKey,
  type EvidenceEnvelope,
} from "../../evidence/vault.js";
import {
  PRODUCTION_DEPLOYMENT_CONTRACT,
} from "../../qualification/production-contract.js";
import {
  validateReleaseManifest,
  verifyReleaseArtifact,
  type PreviewOperateReleaseManifest,
} from "../../release/manifest.js";

export type ControlPlaneRecoveryArtifactKind =
  | "RELEASE_MANIFEST"
  | "RELEASE_RUNTIME"
  | "CONFIGURATION"
  | "POLICY"
  | "ENCRYPTED_EVIDENCE"
  | "RECOVERY_AUTOMATION_STATE"
  | "CHECKPOINT_STATE";

export type ControlPlaneRecoveryFile = {
  kind:
    ControlPlaneRecoveryArtifactKind;
  path: string;
  sha256: string;
  bytes: number;
  mode:
    | 0o600
    | 0o700;
  contentBase64: string;
};

export type ControlPlaneRecoveryBundle = {
  schemaVersion: 1;
  createdAt: string;
  contract: {
    id: string;
    version: string;
    operatingMode:
      "PREVIEW_OPERATE";
    actEnabled: false;
  };
  release: {
    productVersion: string;
    sourceCommit: string;
    releaseManifestSha256:
      string;
  };
  keyReference: {
    source: "ENV" | "FILE";
    secretIncluded: false;
  };
  state: {
    encryptedEvidencePresent:
      boolean;
    recoveryAutomationStatePresent:
      boolean;
    checkpointStatePresent:
      boolean;
  };
  files:
    ControlPlaneRecoveryFile[];
  bundleHash: string;
  mutationAttempted: false;
  actEnabled: false;
};

export type ControlPlaneRestoreResult = {
  verified: boolean;
  restoredFiles: number;
  releaseIntegrity: boolean;
  state:
    ControlPlaneRecoveryBundle["state"];
  blockers: string[];
  mutationAttempted: false;
  actEnabled: false;
};

function sha256(
  value: Buffer | string,
): string {
  return createHash("sha256")
    .update(value)
    .digest("hex");
}

function normalizedPath(
  value: string,
): string {
  return value
    .split(sep)
    .join("/");
}

function safePath(
  root: string,
  value: string,
): string | undefined {
  if (
    !value ||
    isAbsolute(value) ||
    value.includes("\0")
  ) {
    return undefined;
  }

  const target =
    resolve(root, value);
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

function artifactKind(
  path: string,
): ControlPlaneRecoveryArtifactKind {
  if (
    path ===
    "release-manifest.json"
  ) {
    return "RELEASE_MANIFEST";
  }

  if (
    path.startsWith(
      "config/",
    )
  ) {
    return "CONFIGURATION";
  }

  if (
    path.startsWith(
      "policy/",
    )
  ) {
    return "POLICY";
  }

  if (
    path.startsWith(
      ".runs/evidence/recovery-automation/",
    )
  ) {
    return "RECOVERY_AUTOMATION_STATE";
  }

  if (
    path.startsWith(
      ".runs/evidence/",
    )
  ) {
    return "ENCRYPTED_EVIDENCE";
  }

  if (
    path.startsWith(
      ".runs/state/",
    )
  ) {
    return "CHECKPOINT_STATE";
  }

  return "RELEASE_RUNTIME";
}

function prohibitedRecoveryPath(
  path: string,
): boolean {
  return (
    /(^|\/)(evidence\.key|credentials|id_rsa|id_ed25519)(\/|$)/i.test(
      path,
    ) ||
    /(^|\/)\.env(?:\.|$)/i.test(
      path,
    )
  );
}

async function collectFile(
  root: string,
  path: string,
): Promise<
  ControlPlaneRecoveryFile
> {
  const target =
    safePath(root, path);

  if (!target) {
    throw new Error(
      "CONTROL_PLANE_RECOVERY_PATH_INVALID: " +
        path,
    );
  }

  if (
    prohibitedRecoveryPath(
      path,
    )
  ) {
    throw new Error(
      "CONTROL_PLANE_RECOVERY_SECRET_PATH_PROHIBITED: " +
        path,
    );
  }

  const metadata =
    await lstat(target);

  if (
    metadata.isSymbolicLink() ||
    !metadata.isFile()
  ) {
    throw new Error(
      "CONTROL_PLANE_RECOVERY_FILE_INVALID: " +
        path,
    );
  }

  const content =
    await readFile(target);

  return {
    kind:
      artifactKind(path),
    path:
      normalizedPath(path),
    sha256:
      sha256(content),
    bytes:
      content.length,
    mode:
      (metadata.mode &
        0o111) !==
      0
        ? 0o700
        : 0o600,
    contentBase64:
      content.toString(
        "base64",
      ),
  };
}

async function walkFiles(
  root: string,
  relativeRoot: string,
): Promise<string[]> {
  const directory =
    safePath(
      root,
      relativeRoot,
    );

  if (!directory) {
    return [];
  }

  let entries;

  try {
    entries =
      await readdir(
        directory,
        {
          withFileTypes: true,
        },
      );
  } catch (error) {
    const code =
      error &&
      typeof error ===
        "object" &&
      "code" in error
        ? String(
            error.code,
          )
        : "";

    if (code === "ENOENT") {
      return [];
    }

    throw error;
  }

  const files:
    string[] = [];

  for (const entry of
    entries) {
    const relativePath =
      normalizedPath(
        relative(
          root,
          resolve(
            directory,
            entry.name,
          ),
        ),
      );

    if (
      entry.isSymbolicLink()
    ) {
      throw new Error(
        "CONTROL_PLANE_RECOVERY_SYMLINK_PROHIBITED: " +
          relativePath,
      );
    }

    if (
      entry.isDirectory()
    ) {
      files.push(
        ...(await walkFiles(
          root,
          relativePath,
        )),
      );
      continue;
    }

    if (entry.isFile()) {
      files.push(
        relativePath,
      );
    }
  }

  return files.sort();
}

function bundleCore(
  value:
    Omit<
      ControlPlaneRecoveryBundle,
      "bundleHash"
    >,
) {
  return value;
}

function bundleHash(
  value:
    Omit<
      ControlPlaneRecoveryBundle,
      "bundleHash"
    >,
): string {
  return sha256(
    JSON.stringify(
      bundleCore(value),
    ),
  );
}

function releaseManifestFromFile(
  file:
    ControlPlaneRecoveryFile,
): PreviewOperateReleaseManifest {
  return JSON.parse(
    Buffer.from(
      file.contentBase64,
      "base64",
    ).toString("utf8"),
  ) as
    PreviewOperateReleaseManifest;
}

export function validateControlPlaneRecoveryBundle(
  bundle:
    ControlPlaneRecoveryBundle,
): string[] {
  const blockers:
    string[] = [];

  if (
    bundle.schemaVersion !==
      1 ||
    bundle.contract.id !==
      PRODUCTION_DEPLOYMENT_CONTRACT
        .metadata.id ||
    bundle.contract.version !==
      PRODUCTION_DEPLOYMENT_CONTRACT
        .metadata.version ||
    bundle.contract.operatingMode !==
      "PREVIEW_OPERATE" ||
    bundle.contract.actEnabled !==
      false ||
    bundle.actEnabled !==
      false ||
    bundle.mutationAttempted !==
      false
  ) {
    blockers.push(
      "Control-plane recovery contract does not match the accepted Preview/Operate boundary.",
    );
  }

  if (
    bundle.keyReference
      .secretIncluded !== false
  ) {
    blockers.push(
      "Control-plane recovery bundle must never include evidence key material.",
    );
  }

  const paths =
    bundle.files.map(
      (file) => file.path,
    );

  if (
    new Set(paths).size !==
      paths.length
  ) {
    blockers.push(
      "Control-plane recovery bundle contains duplicate file paths.",
    );
  }

  for (const file of
    bundle.files) {
    if (
      file.path.startsWith(
        "/",
      ) ||
      file.path.includes(
        "..",
      ) ||
      prohibitedRecoveryPath(
        file.path,
      )
    ) {
      blockers.push(
        "Control-plane recovery bundle contains an unsafe file path: " +
          file.path,
      );
      continue;
    }

    const content =
      Buffer.from(
        file.contentBase64,
        "base64",
      );

    if (
      sha256(content) !==
        file.sha256 ||
      content.length !==
        file.bytes
    ) {
      blockers.push(
        "Control-plane recovery file integrity mismatch: " +
          file.path,
      );
    }
  }

  const releaseFile =
    bundle.files.find(
      (file) =>
        file.kind ===
        "RELEASE_MANIFEST",
    );

  if (!releaseFile) {
    blockers.push(
      "Control-plane recovery bundle is missing release-manifest.json.",
    );
  } else {
    try {
      const manifest =
        releaseManifestFromFile(
          releaseFile,
        );
      const releaseBlockers =
        validateReleaseManifest(
          manifest,
        );

      blockers.push(
        ...releaseBlockers.map(
          (blocker) =>
            "Recovered release manifest: " +
            blocker,
        ),
      );

      if (
        manifest.productVersion !==
          bundle.release
            .productVersion ||
        manifest.sourceCommit !==
          bundle.release
            .sourceCommit ||
        sha256(
          Buffer.from(
            releaseFile
              .contentBase64,
            "base64",
          ),
        ) !==
          bundle.release
            .releaseManifestSha256
      ) {
        blockers.push(
          "Recovered release identity does not match the control-plane bundle.",
        );
      }
    } catch {
      blockers.push(
        "Recovered release manifest is not valid JSON.",
      );
    }
  }

  const {
    bundleHash:
      ignoredHash,
    ...withoutHash
  } = bundle;

  void ignoredHash;

  if (
    bundleHash(
      withoutHash,
    ) !==
    bundle.bundleHash
  ) {
    blockers.push(
      "Control-plane recovery bundle hash does not match.",
    );
  }

  return [
    ...new Set(
      blockers,
    ),
  ];
}

export async function createControlPlaneRecoveryBundle(
  sourceRoot: string,
): Promise<
  ControlPlaneRecoveryBundle
> {
  const root =
    resolve(sourceRoot);
  const releasePath =
    resolve(
      root,
      "release-manifest.json",
    );
  const releaseRaw =
    await readFile(
      releasePath,
      "utf8",
    );
  const releaseManifest =
    JSON.parse(
      releaseRaw,
    ) as
      PreviewOperateReleaseManifest;
  const releaseBlockers =
    validateReleaseManifest(
      releaseManifest,
    );

  if (
    releaseBlockers.length >
    0
  ) {
    throw new Error(
      "CONTROL_PLANE_RELEASE_MANIFEST_BLOCKED: " +
        releaseBlockers.join(
          " ",
        ),
    );
  }

  const artifactBlockers =
    await verifyReleaseArtifact(
      root,
      releaseManifest,
    );

  if (
    artifactBlockers.length >
    0
  ) {
    throw new Error(
      "CONTROL_PLANE_RELEASE_INTEGRITY_BLOCKED: " +
        artifactBlockers.join(
          " ",
        ),
    );
  }

  const releasePaths = [
    ...releaseManifest.files.map(
      (file) => file.path,
    ),
    "release-manifest.json",
  ];

  const statePaths = [
    ...(await walkFiles(
      root,
      ".runs/evidence",
    )),
    ...(await walkFiles(
      root,
      ".runs/state",
    )),
  ];

  const paths = [
    ...new Set([
      ...releasePaths,
      ...statePaths,
    ]),
  ].sort();

  const files:
    ControlPlaneRecoveryFile[] =
      [];

  for (const path of paths) {
    files.push(
      await collectFile(
        root,
        path,
      ),
    );
  }

  const {
    info,
  } =
    await ensureEvidenceKey();

  if (
    !info.securePermissions
  ) {
    throw new Error(
      "CONTROL_PLANE_EVIDENCE_KEY_PERMISSIONS_INSECURE",
    );
  }

  const releaseFile =
    files.find(
      (file) =>
        file.kind ===
        "RELEASE_MANIFEST",
    );

  if (!releaseFile) {
    throw new Error(
      "CONTROL_PLANE_RELEASE_MANIFEST_MISSING",
    );
  }

  const withoutHash:
    Omit<
      ControlPlaneRecoveryBundle,
      "bundleHash"
    > = {
      schemaVersion: 1,
      createdAt:
        new Date()
          .toISOString(),
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
      release: {
        productVersion:
          releaseManifest
            .productVersion,
        sourceCommit:
          releaseManifest
            .sourceCommit,
        releaseManifestSha256:
          releaseFile.sha256,
      },
      keyReference: {
        source:
          info.source,
        secretIncluded:
          false,
      },
      state: {
        encryptedEvidencePresent:
          files.some(
            (file) =>
              file.kind ===
              "ENCRYPTED_EVIDENCE",
          ),
        recoveryAutomationStatePresent:
          files.some(
            (file) =>
              file.kind ===
              "RECOVERY_AUTOMATION_STATE",
          ),
        checkpointStatePresent:
          files.some(
            (file) =>
              file.kind ===
              "CHECKPOINT_STATE",
          ),
      },
      files,
      mutationAttempted:
        false,
      actEnabled: false,
    };

  return {
    ...withoutHash,
    bundleHash:
      bundleHash(
        withoutHash,
      ),
  };
}

export async function writeControlPlaneRecovery(
  sourceRoot: string,
  outputPath: string,
): Promise<{
  path: string;
  bundle:
    ControlPlaneRecoveryBundle;
}> {
  const bundle =
    await createControlPlaneRecoveryBundle(
      sourceRoot,
    );
  const {
    key,
    info,
  } =
    await ensureEvidenceKey();

  if (
    !info.securePermissions
  ) {
    throw new Error(
      "CONTROL_PLANE_EVIDENCE_KEY_PERMISSIONS_INSECURE",
    );
  }

  const envelope =
    encryptEvidence(
      "control-plane-recovery",
      bundle,
      key,
    );
  const path =
    resolve(outputPath);

  await mkdir(
    dirname(path),
    {
      recursive: true,
      mode: 0o700,
    },
  );

  await writeFile(
    path,
    JSON.stringify(
      envelope,
    ) + "\n",
    {
      encoding: "utf8",
      mode: 0o600,
    },
  );

  return {
    path,
    bundle,
  };
}

export async function readControlPlaneRecovery(
  path: string,
): Promise<
  ControlPlaneRecoveryBundle
> {
  const raw =
    await readFile(
      resolve(path),
      "utf8",
    );
  const envelope =
    JSON.parse(
      raw,
    ) as EvidenceEnvelope;
  const {
    key,
    info,
  } =
    await ensureEvidenceKey();

  if (
    !info.securePermissions
  ) {
    throw new Error(
      "CONTROL_PLANE_EVIDENCE_KEY_PERMISSIONS_INSECURE",
    );
  }

  const bundle =
    decryptEvidence<
      ControlPlaneRecoveryBundle
    >(
      envelope,
      key,
    );
  const blockers =
    validateControlPlaneRecoveryBundle(
      bundle,
    );

  if (
    blockers.length > 0
  ) {
    throw new Error(
      "CONTROL_PLANE_RECOVERY_BUNDLE_BLOCKED: " +
        blockers.join(
          " ",
        ),
    );
  }

  return bundle;
}

async function assertEmptyRestoreRoot(
  value: string,
): Promise<string> {
  const root =
    resolve(value);
  const unsafe =
    new Set([
      resolve("/"),
      resolve(homedir()),
      resolve(
        process.cwd(),
      ),
    ]);

  if (unsafe.has(root)) {
    throw new Error(
      "CONTROL_PLANE_RESTORE_ROOT_UNSAFE",
    );
  }

  try {
    const entries =
      await readdir(root);

    if (
      entries.length > 0
    ) {
      throw new Error(
        "CONTROL_PLANE_RESTORE_ROOT_NOT_EMPTY",
      );
    }
  } catch (error) {
    const code =
      error &&
      typeof error ===
        "object" &&
      "code" in error
        ? String(
            error.code,
          )
        : "";

    if (
      code !== "ENOENT"
    ) {
      throw error;
    }

    await mkdir(
      root,
      {
        recursive: true,
        mode: 0o700,
      },
    );
  }

  return root;
}

export async function restoreControlPlaneRecovery(input: {
  evidencePath: string;
  restoreRoot: string;
}): Promise<
  ControlPlaneRestoreResult
> {
  const bundle =
    await readControlPlaneRecovery(
      input.evidencePath,
    );
  const root =
    await assertEmptyRestoreRoot(
      input.restoreRoot,
    );

  for (const file of
    bundle.files) {
    const target =
      safePath(
        root,
        file.path,
      );

    if (!target) {
      throw new Error(
        "CONTROL_PLANE_RESTORE_PATH_INVALID: " +
          file.path,
      );
    }

    await mkdir(
      dirname(target),
      {
        recursive: true,
        mode: 0o700,
      },
    );

    await writeFile(
      target,
      Buffer.from(
        file.contentBase64,
        "base64",
      ),
      {
        mode:
          file.mode,
      },
    );
  }

  const blockers:
    string[] = [];

  for (const file of
    bundle.files) {
    const target =
      safePath(
        root,
        file.path,
      );

    if (!target) {
      blockers.push(
        "Restored path is unsafe: " +
          file.path,
      );
      continue;
    }

    try {
      const restored =
        await readFile(
          target,
        );

      if (
        sha256(
          restored,
        ) !==
        file.sha256
      ) {
        blockers.push(
          "Restored file integrity mismatch: " +
            file.path,
        );
      }
    } catch {
      blockers.push(
        "Restored file is missing: " +
          file.path,
      );
    }
  }

  let releaseIntegrity =
    false;

  try {
    const manifest =
      JSON.parse(
        await readFile(
          resolve(
            root,
            "release-manifest.json",
          ),
          "utf8",
        ),
      ) as
        PreviewOperateReleaseManifest;
    const releaseBlockers =
      await verifyReleaseArtifact(
        root,
        manifest,
      );

    releaseIntegrity =
      releaseBlockers.length ===
      0;
    blockers.push(
      ...releaseBlockers.map(
        (blocker) =>
          "Restored release: " +
          blocker,
      ),
    );
  } catch {
    blockers.push(
      "Restored release manifest could not be verified.",
    );
  }

  return {
    verified:
      blockers.length === 0 &&
      releaseIntegrity,
    restoredFiles:
      bundle.files.length,
    releaseIntegrity,
    state:
      bundle.state,
    blockers: [
      ...new Set(
        blockers,
      ),
    ],
    mutationAttempted:
      false,
    actEnabled: false,
  };
}
