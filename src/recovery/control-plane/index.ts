import {
  copyFile,
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import {
  tmpdir,
} from "node:os";
import {
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";

import {
  decryptEvidence,
  type EvidenceEnvelope,
} from "../../evidence/vault.js";
import {
  sha256File,
  verifyReleaseArtifact,
  type PreviewOperateReleaseManifest,
} from "../../release/manifest.js";

export type ControlPlaneRecoveryCategory =
  | "RELEASE"
  | "CONFIG"
  | "POLICY"
  | "ENCRYPTED_EVIDENCE"
  | "CHECKPOINT";

export type ControlPlaneRecoveryFile = {
  path: string;
  sha256: string;
  mode: number;
  category:
    ControlPlaneRecoveryCategory;
};

export type ControlPlaneRecoveryManifest = {
  schemaVersion: 1;
  kind:
    "ControlPlaneRecoveryPoint";
  createdAt: string;
  source: {
    productVersion: string;
    sourceCommit: string;
    releaseManifestSha256:
      string;
  };
  files:
    ControlPlaneRecoveryFile[];
  checkpointMode:
    | "NONE"
    | "QUIESCED_FILE_COPY";
  externalEvidenceKey: {
    required: boolean;
    included: false;
  };
  restore: {
    isolatedVerificationRequired:
      true;
    cloudMutationAllowed: false;
    actEnabled: false;
  };
};

export type ControlPlaneRestoreResult = {
  ready: boolean;
  filesRestored: number;
  releaseVerified: boolean;
  evidenceVerified?:
    boolean;
  blockers: string[];
  actEnabled: false;
};

function insideOrEqual(
  parent: string,
  child: string,
): boolean {
  const relation =
    relative(
      resolve(parent),
      resolve(child),
    );

  return (
    relation === "" ||
    (
      relation !== ".." &&
      !relation.startsWith(
        ".." + sep,
      ) &&
      !isAbsolute(
        relation,
      )
    )
  );
}

function portablePath(
  root: string,
  absolute: string,
): string {
  return relative(
    resolve(root),
    resolve(absolute),
  )
    .split(sep)
    .join("/");
}

function safeTarget(
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

  if (
    !insideOrEqual(
      root,
      target,
    ) ||
    resolve(root) ===
      target
  ) {
    return undefined;
  }

  return target;
}

async function exists(
  path: string,
): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    const code =
      error &&
      typeof error ===
        "object" &&
      "code" in error
        ? String(error.code)
        : "";

    if (code === "ENOENT") {
      return false;
    }

    throw error;
  }
}

async function collectDirectory(
  root: string,
  path: string,
  output: Set<string>,
): Promise<void> {
  const target =
    safeTarget(
      root,
      path,
    );

  if (!target) {
    throw new Error(
      "CONTROL_PLANE_PATH_INVALID: " +
        path,
    );
  }

  if (
    !(await exists(target))
  ) {
    return;
  }

  const entries =
    await readdir(
      target,
      {
        withFileTypes: true,
      },
    );

  for (const entry of
    entries) {
    const absolute =
      join(
        target,
        entry.name,
      );
    const relativePath =
      portablePath(
        root,
        absolute,
      );

    if (
      entry.isSymbolicLink()
    ) {
      throw new Error(
        "CONTROL_PLANE_SYMLINK_UNSUPPORTED: " +
          relativePath,
      );
    }

    if (entry.isDirectory()) {
      await collectDirectory(
        root,
        relativePath,
        output,
      );
    } else if (
      entry.isFile()
    ) {
      output.add(
        relativePath,
      );
    }
  }
}

async function readReleaseManifest(
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

async function readRecoveryManifest(
  snapshot: string,
): Promise<
  ControlPlaneRecoveryManifest
> {
  const raw =
    await readFile(
      resolve(
        snapshot,
        "control-plane-recovery.json",
      ),
      "utf8",
    );
  const parsed =
    JSON.parse(
      raw,
    ) as
      Partial<ControlPlaneRecoveryManifest>;

  if (
    parsed.schemaVersion !==
      1 ||
    parsed.kind !==
      "ControlPlaneRecoveryPoint" ||
    !parsed.source ||
    !Array.isArray(
      parsed.files,
    ) ||
    !parsed.externalEvidenceKey ||
    !parsed.restore
  ) {
    throw new Error(
      "CONTROL_PLANE_RECOVERY_MANIFEST_INVALID",
    );
  }

  return parsed as
    ControlPlaneRecoveryManifest;
}

function categoryFor(
  path: string,
  checkpoints: Set<string>,
): ControlPlaneRecoveryCategory {
  if (
    checkpoints.has(path) ||
    path.startsWith(
      ".runs/checkpoints/",
    )
  ) {
    return "CHECKPOINT";
  }

  if (
    path.startsWith(
      ".runs/evidence/",
    )
  ) {
    return "ENCRYPTED_EVIDENCE";
  }

  if (
    path === "config" ||
    path.startsWith(
      "config/",
    )
  ) {
    return "CONFIG";
  }

  if (
    path === "policy" ||
    path.startsWith(
      "policy/",
    )
  ) {
    return "POLICY";
  }

  return "RELEASE";
}

export async function captureControlPlaneRecovery(
  input: {
    root: string;
    destination: string;
    checkpointPaths?: string[];
  },
): Promise<
  ControlPlaneRecoveryManifest
> {
  const root =
    resolve(input.root);
  const destination =
    resolve(
      input.destination,
    );

  if (
    insideOrEqual(
      root,
      destination,
    )
  ) {
    throw new Error(
      "CONTROL_PLANE_DESTINATION_INSIDE_SOURCE",
    );
  }

  const releaseManifest =
    await readReleaseManifest(
      root,
    );
  const releaseBlockers =
    await verifyReleaseArtifact(
      root,
      releaseManifest,
    );

  if (
    releaseBlockers.length >
    0
  ) {
    throw new Error(
      "CONTROL_PLANE_RELEASE_INVALID: " +
        releaseBlockers.join(
          " ",
        ),
    );
  }

  const paths =
    new Set<string>(
      releaseManifest.files
        .map(
          (file) =>
            file.path,
        ),
    );
  paths.add(
    "release-manifest.json",
  );

  for (const directory of [
    "config",
    "policy",
    ".runs/evidence",
    ".runs/checkpoints",
  ]) {
    await collectDirectory(
      root,
      directory,
      paths,
    );
  }

  const checkpoints =
    new Set<string>();

  for (
    const checkpoint of
    input.checkpointPaths ??
    []
  ) {
    const target =
      safeTarget(
        root,
        checkpoint,
      );

    if (!target) {
      throw new Error(
        "CONTROL_PLANE_CHECKPOINT_PATH_INVALID: " +
          checkpoint,
      );
    }

    const metadata =
      await lstat(target);

    if (
      metadata.isSymbolicLink() ||
      !metadata.isFile()
    ) {
      throw new Error(
        "CONTROL_PLANE_CHECKPOINT_MUST_BE_QUIESCED_FILE: " +
          checkpoint,
      );
    }

    const path =
      portablePath(
        root,
        target,
      );
    checkpoints.add(path);
    paths.add(path);
  }

  await mkdir(
    dirname(destination),
    {
      recursive: true,
      mode: 0o700,
    },
  );
  await mkdir(
    destination,
    {
      mode: 0o700,
    },
  );

  const payload =
    resolve(
      destination,
      "payload",
    );
  await mkdir(
    payload,
    {
      mode: 0o700,
    },
  );

  const files:
    ControlPlaneRecoveryFile[] =
    [];

  for (const path of
    [...paths].sort()) {
    const source =
      safeTarget(
        root,
        path,
      );

    if (!source) {
      throw new Error(
        "CONTROL_PLANE_SOURCE_PATH_INVALID: " +
          path,
      );
    }

    const metadata =
      await lstat(source);

    if (
      metadata.isSymbolicLink() ||
      !metadata.isFile()
    ) {
      throw new Error(
        "CONTROL_PLANE_SOURCE_FILE_INVALID: " +
          path,
      );
    }

    const target =
      safeTarget(
        payload,
        path,
      );

    if (!target) {
      throw new Error(
        "CONTROL_PLANE_PAYLOAD_PATH_INVALID: " +
          path,
      );
    }

    await mkdir(
      dirname(target),
      {
        recursive: true,
        mode: 0o700,
      },
    );
    await copyFile(
      source,
      target,
    );

    const mode =
      metadata.mode &
      0o777;
    await chmod(
      target,
      mode,
    );

    files.push({
      path,
      sha256:
        await sha256File(
          target,
        ),
      mode,
      category:
        categoryFor(
          path,
          checkpoints,
        ),
    });
  }

  const evidencePresent =
    files.some(
      (file) =>
        file.category ===
          "ENCRYPTED_EVIDENCE" &&
        file.path.endsWith(
          ".evidence",
        ),
    );
  const checkpointPresent =
    files.some(
      (file) =>
        file.category ===
        "CHECKPOINT",
    );

  const manifest:
    ControlPlaneRecoveryManifest =
    {
      schemaVersion: 1,
      kind:
        "ControlPlaneRecoveryPoint",
      createdAt:
        new Date()
          .toISOString(),
      source: {
        productVersion:
          releaseManifest
            .productVersion,
        sourceCommit:
          releaseManifest
            .sourceCommit,
        releaseManifestSha256:
          await sha256File(
            resolve(
              root,
              "release-manifest.json",
            ),
          ),
      },
      files,
      checkpointMode:
        checkpointPresent
          ? "QUIESCED_FILE_COPY"
          : "NONE",
      externalEvidenceKey: {
        required:
          evidencePresent,
        included: false,
      },
      restore: {
        isolatedVerificationRequired:
          true,
        cloudMutationAllowed:
          false,
        actEnabled: false,
      },
    };

  await writeFile(
    resolve(
      destination,
      "control-plane-recovery.json",
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

  return manifest;
}

export async function verifyControlPlaneRecoverySnapshot(
  snapshot: string,
): Promise<string[]> {
  const blockers:
    string[] = [];
  let manifest:
    ControlPlaneRecoveryManifest;

  try {
    manifest =
      await readRecoveryManifest(
        snapshot,
      );
  } catch {
    return [
      "Control-plane recovery manifest is missing or invalid.",
    ];
  }

  if (
    manifest.restore
      .actEnabled !== false ||
    manifest.restore
      .cloudMutationAllowed !==
      false ||
    manifest.restore
      .isolatedVerificationRequired !==
      true
  ) {
    blockers.push(
      "Control-plane recovery authority boundary is invalid.",
    );
  }

  if (
    manifest.externalEvidenceKey
      .included !== false
  ) {
    blockers.push(
      "Control-plane recovery must not package the customer evidence key.",
    );
  }

  const paths =
    manifest.files.map(
      (file) =>
        file.path,
    );

  if (
    new Set(paths).size !==
    paths.length
  ) {
    blockers.push(
      "Control-plane recovery contains duplicate paths.",
    );
  }

  for (const category of [
    "RELEASE",
    "CONFIG",
    "POLICY",
  ] as const) {
    if (
      !manifest.files.some(
        (file) =>
          file.category ===
          category,
      )
    ) {
      blockers.push(
        "Control-plane recovery is missing " +
          category +
          " files.",
      );
    }
  }

  if (
    manifest.files.some(
      (file) =>
        file.path.endsWith(
          "evidence.key",
        ),
    )
  ) {
    blockers.push(
      "Control-plane recovery contains an evidence key file.",
    );
  }

  const hasEvidence =
    manifest.files.some(
      (file) =>
        file.category ===
          "ENCRYPTED_EVIDENCE" &&
        file.path.endsWith(
          ".evidence",
        ),
    );

  if (
    manifest.externalEvidenceKey
      .required !== hasEvidence
  ) {
    blockers.push(
      "External evidence-key requirement does not match encrypted evidence content.",
    );
  }

  const hasCheckpoint =
    manifest.files.some(
      (file) =>
        file.category ===
        "CHECKPOINT",
    );

  if (
    (
      hasCheckpoint &&
      manifest.checkpointMode !==
        "QUIESCED_FILE_COPY"
    ) ||
    (
      !hasCheckpoint &&
      manifest.checkpointMode !==
        "NONE"
    )
  ) {
    blockers.push(
      "Checkpoint recovery mode does not match snapshot contents.",
    );
  }

  const payload =
    resolve(
      snapshot,
      "payload",
    );

  for (const file of
    manifest.files) {
    const target =
      safeTarget(
        payload,
        file.path,
      );

    if (!target) {
      blockers.push(
        "Unsafe control-plane recovery path: " +
          file.path,
      );
      continue;
    }

    try {
      const metadata =
        await lstat(target);

      if (
        metadata.isSymbolicLink() ||
        !metadata.isFile()
      ) {
        blockers.push(
          "Recovery payload entry is not a regular file: " +
            file.path,
        );
        continue;
      }

      const actual =
        await sha256File(
          target,
        );

      if (
        actual !==
        file.sha256
      ) {
        blockers.push(
          "Recovery payload integrity mismatch: " +
            file.path,
        );
      }
    } catch {
      blockers.push(
        "Recovery payload file is missing: " +
          file.path,
      );
    }
  }

  try {
    const releaseManifestHash =
      await sha256File(
        resolve(
          payload,
          "release-manifest.json",
        ),
      );

    if (
      releaseManifestHash !==
      manifest.source
        .releaseManifestSha256
    ) {
      blockers.push(
        "Release manifest integrity does not match the captured control-plane source.",
      );
    }
  } catch {
    blockers.push(
      "Captured release manifest is missing.",
    );
  }

  return [
    ...new Set(
      blockers,
    ),
  ];
}

async function verifyRestoredFiles(
  root: string,
  manifest:
    ControlPlaneRecoveryManifest,
): Promise<string[]> {
  const blockers:
    string[] = [];

  for (const file of
    manifest.files) {
    const target =
      safeTarget(
        root,
        file.path,
      );

    if (!target) {
      blockers.push(
        "Unsafe restored path: " +
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
        actual !==
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

  return blockers;
}

export async function restoreControlPlaneRecovery(
  input: {
    snapshot: string;
    target: string;
    verifyEncryptedEvidence?:
      boolean;
    evidenceKey?: Buffer;
  },
): Promise<
  ControlPlaneRestoreResult
> {
  const snapshot =
    resolve(input.snapshot);
  const target =
    resolve(input.target);
  const blockers =
    await verifyControlPlaneRecoverySnapshot(
      snapshot,
    );

  if (
    blockers.length > 0
  ) {
    return {
      ready: false,
      filesRestored: 0,
      releaseVerified:
        false,
      blockers,
      actEnabled: false,
    };
  }

  if (
    insideOrEqual(
      snapshot,
      target,
    )
  ) {
    return {
      ready: false,
      filesRestored: 0,
      releaseVerified:
        false,
      blockers: [
        "Restore target must be isolated from the recovery snapshot.",
      ],
      actEnabled: false,
    };
  }

  if (await exists(target)) {
    return {
      ready: false,
      filesRestored: 0,
      releaseVerified:
        false,
      blockers: [
        "Restore target already exists.",
      ],
      actEnabled: false,
    };
  }

  const manifest =
    await readRecoveryManifest(
      snapshot,
    );
  const payload =
    resolve(
      snapshot,
      "payload",
    );

  await mkdir(
    dirname(target),
    {
      recursive: true,
      mode: 0o700,
    },
  );
  await mkdir(
    target,
    {
      mode: 0o700,
    },
  );

  for (const file of
    manifest.files) {
    const source =
      safeTarget(
        payload,
        file.path,
      );
    const destination =
      safeTarget(
        target,
        file.path,
      );

    if (
      !source ||
      !destination
    ) {
      blockers.push(
        "Restore path validation failed for " +
          file.path,
      );
      continue;
    }

    await mkdir(
      dirname(
        destination,
      ),
      {
        recursive: true,
        mode: 0o700,
      },
    );
    await copyFile(
      source,
      destination,
    );
    await chmod(
      destination,
      file.mode,
    );
  }

  blockers.push(
    ...(await verifyRestoredFiles(
      target,
      manifest,
    )),
  );

  let releaseVerified =
    false;

  try {
    const releaseManifest =
      await readReleaseManifest(
        target,
      );
    const releaseBlockers =
      await verifyReleaseArtifact(
        target,
        releaseManifest,
      );

    releaseVerified =
      releaseBlockers.length ===
      0;
    blockers.push(
      ...releaseBlockers,
    );
  } catch {
    blockers.push(
      "Restored release manifest could not be verified.",
    );
  }

  let evidenceVerified:
    boolean | undefined;
  const evidenceFiles =
    manifest.files.filter(
      (file) =>
        file.category ===
          "ENCRYPTED_EVIDENCE" &&
        file.path.endsWith(
          ".evidence",
        ),
    );

  if (
    input.verifyEncryptedEvidence
  ) {
    evidenceVerified =
      true;

    if (
      evidenceFiles.length > 0 &&
      (
        !input.evidenceKey ||
        input.evidenceKey
          .length !== 32
      )
    ) {
      evidenceVerified =
        false;
      blockers.push(
        "Encrypted evidence verification requires the externally supplied 32-byte evidence key.",
      );
    } else {
      for (const file of
        evidenceFiles) {
        try {
          const raw =
            await readFile(
              resolve(
                target,
                file.path,
              ),
              "utf8",
            );
          const envelope =
            JSON.parse(
              raw,
            ) as
              EvidenceEnvelope;

          decryptEvidence<unknown>(
            envelope,
            input.evidenceKey as Buffer,
          );
        } catch {
          evidenceVerified =
            false;
          blockers.push(
            "Restored encrypted evidence failed authentication: " +
              file.path,
          );
        }
      }
    }
  }

  const uniqueBlockers = [
    ...new Set(
      blockers,
    ),
  ];

  return {
    ready:
      uniqueBlockers.length ===
        0 &&
      releaseVerified &&
      (
        input.verifyEncryptedEvidence !==
          true ||
        evidenceVerified ===
          true
      ),
    filesRestored:
      manifest.files.length,
    releaseVerified,
    ...(evidenceVerified ===
    undefined
      ? {}
      : {
          evidenceVerified,
        }),
    blockers:
      uniqueBlockers,
    actEnabled: false,
  };
}

export async function drillControlPlaneRecovery(
  input: {
    snapshot: string;
    verifyEncryptedEvidence?:
      boolean;
    evidenceKey?: Buffer;
  },
): Promise<
  ControlPlaneRestoreResult
> {
  const directory =
    await mkdtemp(
      join(
        tmpdir(),
        "alz-control-plane-drill-",
      ),
    );
  const target =
    resolve(
      directory,
      "restored",
    );

  try {
    return await restoreControlPlaneRecovery({
      snapshot:
        input.snapshot,
      target,
      verifyEncryptedEvidence:
        input.verifyEncryptedEvidence,
      evidenceKey:
        input.evidenceKey,
    });
  } finally {
    await rm(
      directory,
      {
        recursive: true,
        force: true,
      },
    );
  }
}
