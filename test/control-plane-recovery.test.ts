import assert from "node:assert/strict";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import {
  tmpdir,
} from "node:os";
import {
  join,
} from "node:path";
import test from "node:test";

import {
  encryptEvidence,
} from "../src/evidence/vault.js";
import {
  captureControlPlaneRecovery,
  restoreControlPlaneRecovery,
  verifyControlPlaneRecoverySnapshot,
} from "../src/recovery/control-plane/index.js";
import {
  createReleaseManifest,
  sha256Buffer,
} from "../src/release/manifest.js";

async function releaseFixture(
  root: string,
): Promise<{
  evidenceKey: Buffer;
}> {
  const contents:
    Record<string, string> = {
      "dist/cli/operator.js":
        "console.log('preview operate');\n",
      "config/base.json":
        "{\"mode\":\"preview-operate\"}\n",
      "policy/security.rego":
        "package alz.security\n",
      "package.json":
        "{\"name\":\"agent-private-landing-zone\",\"version\":\"1.0.0\"}\n",
      "package-lock.json":
        "{\"lockfileVersion\":3}\n",
      "sbom.cdx.json":
        "{\"bomFormat\":\"CycloneDX\"}\n",
      "alz":
        "#!/usr/bin/env bash\n",
    };

  for (const [
    path,
    content,
  ] of Object.entries(
    contents,
  )) {
    const target =
      join(root, path);
    await mkdir(
      join(
        target,
        "..",
      ),
      {
        recursive: true,
      },
    );
    await writeFile(
      target,
      content,
    );
  }

  await chmod(
    join(
      root,
      "alz",
    ),
    0o755,
  );

  const manifest =
    createReleaseManifest({
      productVersion:
        "1.0.0",
      sourceCommit:
        "a".repeat(40),
      files:
        Object.entries(
          contents,
        ).map(
          ([
            path,
            content,
          ]) => ({
            path,
            sha256:
              sha256Buffer(
                content,
              ),
          }),
        ),
      sbomPath:
        "sbom.cdx.json",
      sbomSha256:
        sha256Buffer(
          contents[
            "sbom.cdx.json"
          ],
        ),
    });

  await writeFile(
    join(
      root,
      "release-manifest.json",
    ),
    JSON.stringify(
      manifest,
      null,
      2,
    ) + "\n",
  );

  await mkdir(
    join(
      root,
      "config",
    ),
    {
      recursive: true,
    },
  );
  await writeFile(
    join(
      root,
      "config",
      "recovery-targets.json",
    ),
    "{\"targets\":[]}\n",
  );

  const evidenceKey =
    Buffer.alloc(
      32,
      7,
    );
  const envelope =
    encryptEvidence(
      "session",
      {
        threadId:
          "control-plane-test",
      },
      evidenceKey,
    );

  await mkdir(
    join(
      root,
      ".runs",
      "evidence",
      "session",
    ),
    {
      recursive: true,
    },
  );
  await writeFile(
    join(
      root,
      ".runs",
      "evidence",
      "session",
      "turn.evidence",
    ),
    JSON.stringify(
      envelope,
    ) + "\n",
  );

  await mkdir(
    join(
      root,
      ".runs",
      "checkpoints",
    ),
    {
      recursive: true,
    },
  );
  await writeFile(
    join(
      root,
      ".runs",
      "checkpoints",
      "session.sqlite",
    ),
    "quiesced-checkpoint\n",
  );

  return {
    evidenceKey,
  };
}

test("control-plane recovery captures release config policy encrypted evidence and checkpoint without the evidence key", async () => {
  const base =
    await mkdtemp(
      join(
        tmpdir(),
        "alz-control-plane-",
      ),
    );
  const root =
    join(
      base,
      "release",
    );
  const snapshot =
    join(
      base,
      "snapshot",
    );
  const restored =
    join(
      base,
      "restored",
    );

  try {
    await mkdir(root);
    const {
      evidenceKey,
    } =
      await releaseFixture(
        root,
      );

    const manifest =
      await captureControlPlaneRecovery({
        root,
        destination:
          snapshot,
        checkpointPaths: [
          ".runs/checkpoints/session.sqlite",
        ],
      });

    assert.equal(
      manifest.restore
        .actEnabled,
      false,
    );
    assert.equal(
      manifest.restore
        .cloudMutationAllowed,
      false,
    );
    assert.equal(
      manifest.externalEvidenceKey
        .included,
      false,
    );
    assert.equal(
      manifest.externalEvidenceKey
        .required,
      true,
    );
    assert.equal(
      manifest.checkpointMode,
      "QUIESCED_FILE_COPY",
    );
    assert.ok(
      manifest.files.some(
        (file) =>
          file.category ===
            "ENCRYPTED_EVIDENCE",
      ),
    );
    assert.ok(
      manifest.files.some(
        (file) =>
          file.category ===
            "CHECKPOINT",
      ),
    );
    assert.ok(
      !manifest.files.some(
        (file) =>
          file.path.endsWith(
            "evidence.key",
          ),
      ),
    );

    assert.deepEqual(
      await verifyControlPlaneRecoverySnapshot(
        snapshot,
      ),
      [],
    );

    const result =
      await restoreControlPlaneRecovery({
        snapshot,
        target:
          restored,
        verifyEncryptedEvidence:
          true,
        evidenceKey,
      });

    assert.equal(
      result.ready,
      true,
    );
    assert.equal(
      result.releaseVerified,
      true,
    );
    assert.equal(
      result.evidenceVerified,
      true,
    );
    assert.equal(
      result.actEnabled,
      false,
    );

    assert.equal(
      await readFile(
        join(
          restored,
          "config",
          "recovery-targets.json",
        ),
        "utf8",
      ),
      "{\"targets\":[]}\n",
    );
    assert.equal(
      await readFile(
        join(
          restored,
          ".runs",
          "checkpoints",
          "session.sqlite",
        ),
        "utf8",
      ),
      "quiesced-checkpoint\n",
    );
  } finally {
    await rm(
      base,
      {
        recursive: true,
        force: true,
      },
    );
  }
});

test("control-plane recovery detects tampered payload before restore", async () => {
  const base =
    await mkdtemp(
      join(
        tmpdir(),
        "alz-control-plane-tamper-",
      ),
    );
  const root =
    join(
      base,
      "release",
    );
  const snapshot =
    join(
      base,
      "snapshot",
    );

  try {
    await mkdir(root);
    await releaseFixture(
      root,
    );
    await captureControlPlaneRecovery({
      root,
      destination:
        snapshot,
    });

    await writeFile(
      join(
        snapshot,
        "payload",
        "config",
        "base.json",
      ),
      "tampered\n",
    );

    assert.match(
      (
        await verifyControlPlaneRecoverySnapshot(
          snapshot,
        )
      ).join(" "),
      /integrity mismatch/i,
    );
  } finally {
    await rm(
      base,
      {
        recursive: true,
        force: true,
      },
    );
  }
});

test("control-plane restore refuses encrypted evidence verification with the wrong external key", async () => {
  const base =
    await mkdtemp(
      join(
        tmpdir(),
        "alz-control-plane-key-",
      ),
    );
  const root =
    join(
      base,
      "release",
    );
  const snapshot =
    join(
      base,
      "snapshot",
    );
  const restored =
    join(
      base,
      "restored",
    );

  try {
    await mkdir(root);
    await releaseFixture(
      root,
    );
    await captureControlPlaneRecovery({
      root,
      destination:
        snapshot,
    });

    const result =
      await restoreControlPlaneRecovery({
        snapshot,
        target:
          restored,
        verifyEncryptedEvidence:
          true,
        evidenceKey:
          Buffer.alloc(
            32,
            9,
          ),
      });

    assert.equal(
      result.ready,
      false,
    );
    assert.equal(
      result.evidenceVerified,
      false,
    );
    assert.match(
      result.blockers.join(
        " ",
      ),
      /failed authentication/i,
    );
  } finally {
    await rm(
      base,
      {
        recursive: true,
        force: true,
      },
    );
  }
});

test("control-plane capture refuses a destination inside the source release", async () => {
  const base =
    await mkdtemp(
      join(
        tmpdir(),
        "alz-control-plane-path-",
      ),
    );
  const root =
    join(
      base,
      "release",
    );

  try {
    await mkdir(root);
    await releaseFixture(
      root,
    );

    await assert.rejects(
      () =>
        captureControlPlaneRecovery({
          root,
          destination:
            join(
              root,
              "snapshot",
            ),
        }),
      /DESTINATION_INSIDE_SOURCE/,
    );
  } finally {
    await rm(
      base,
      {
        recursive: true,
        force: true,
      },
    );
  }
});
