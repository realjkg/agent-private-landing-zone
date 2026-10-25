import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
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
  createReleaseManifest,
  sha256Buffer,
  validateReleaseManifest,
  verifyReleaseArtifact,
} from "../src/release/manifest.js";
import {
  planReleaseLifecycle,
  validateReleaseLifecyclePlan,
} from "../src/release/lifecycle.js";

const hash =
  sha256Buffer("fixture");

test("release manifest binds version provenance SBOM and Preview Operate contract", () => {
  const manifest =
    createReleaseManifest({
      productVersion: "1.0.0",
      sourceCommit:
        "a".repeat(40),
      files: [
        {
          path:
            "dist/cli/operator.js",
          sha256: hash,
        },
      ],
      sbomPath:
        "sbom.cdx.json",
      sbomSha256: hash,
    });

  assert.equal(
    manifest.contract
      .operatingMode,
    "PREVIEW_OPERATE",
  );
  assert.equal(
    manifest.contract
      .actEnabled,
    false,
  );
  assert.equal(
    manifest.lifecycle
      .cleanInstall,
    true,
  );
  assert.equal(
    manifest.lifecycle.upgrade,
    true,
  );
  assert.equal(
    manifest.lifecycle.rollback,
    true,
  );
  assert.equal(
    manifest.lifecycle.uninstall,
    true,
  );
  assert.equal(
    manifest.lifecycle
      .configurationMigration,
    true,
  );
  assert.deepEqual(
    validateReleaseManifest(
      manifest,
    ),
    [],
  );
});

test("release manifest rejects invalid provenance and file evidence", () => {
  assert.throws(
    () =>
      createReleaseManifest({
        productVersion:
          "not-a-version",
        sourceCommit:
          "bad",
        files: [],
        sbomPath:
          "sbom.cdx.json",
        sbomSha256: hash,
      }),
    /RELEASE_VERSION_INVALID/,
  );

  assert.throws(
    () =>
      createReleaseManifest({
        productVersion:
          "1.0.0",
        sourceCommit:
          "a".repeat(40),
        files: [
          {
            path:
              "../secret",
            sha256: hash,
          },
        ],
        sbomPath:
          "sbom.cdx.json",
        sbomSha256: hash,
      }),
    /RELEASE_FILE_EVIDENCE_INVALID/,
  );
});

test("clean install lifecycle remains local and non-infrastructure", () => {
  const plan =
    planReleaseLifecycle({
      targetVersion:
        "1.0.0",
      targetConfigSchema: 1,
    });

  assert.deepEqual(
    plan.steps.map(
      (step) =>
        step.operation,
    ),
    [
      "CLEAN_INSTALL",
    ],
  );
  assert.equal(
    plan.releaseFilesystemOnly,
    true,
  );
  assert.equal(
    plan.cloudMutationAllowed,
    false,
  );
  assert.deepEqual(
    validateReleaseLifecyclePlan(
      plan,
    ),
    [],
  );
});

test("upgrade migration rollback and uninstall are explicit lifecycle plans", () => {
  const plan =
    planReleaseLifecycle({
      currentVersion:
        "1.0.0",
      previousVersion:
        "0.9.0",
      targetVersion:
        "1.1.0",
      currentConfigSchema: 1,
      targetConfigSchema: 2,
      uninstallVersion:
        "0.8.0",
    });

  assert.deepEqual(
    plan.steps.map(
      (step) =>
        step.operation,
    ),
    [
      "UPGRADE",
      "MIGRATE_CONFIG",
      "ROLLBACK",
      "UNINSTALL",
    ],
  );

  assert.ok(
    plan.steps.every(
      (step) =>
        step.infrastructureActEnabled ===
          false &&
        step.requiresIntegrityVerification ===
          true,
    ),
  );

  assert.deepEqual(
    validateReleaseLifecyclePlan(
      plan,
    ),
    [],
  );
});

test("active version cannot be selected for uninstall", () => {
  assert.throws(
    () =>
      planReleaseLifecycle({
        currentVersion:
          "1.0.0",
        targetVersion:
          "1.0.0",
        targetConfigSchema: 1,
        uninstallVersion:
          "1.0.0",
      }),
    /RELEASE_UNINSTALL_CURRENT_DENIED/,
  );
});


test("release artifact verification detects missing or tampered staged files", async () => {
  const root =
    await mkdtemp(
      join(
        tmpdir(),
        "alz-release-",
      ),
    );

  try {
    await mkdir(
      join(
        root,
        "dist",
        "cli",
      ),
      {
        recursive: true,
      },
    );

    const operator =
      "console.log('preview operate');\n";
    const sbom =
      "{\"bomFormat\":\"CycloneDX\"}\n";
    const lock =
      "{\"lockfileVersion\":3}\n";

    await writeFile(
      join(
        root,
        "dist",
        "cli",
        "operator.js",
      ),
      operator,
    );
    await writeFile(
      join(
        root,
        "sbom.cdx.json",
      ),
      sbom,
    );
    await writeFile(
      join(
        root,
        "package-lock.json",
      ),
      lock,
    );

    const manifest =
      createReleaseManifest({
        productVersion:
          "1.0.0",
        sourceCommit:
          "a".repeat(40),
        files: [
          {
            path:
              "dist/cli/operator.js",
            sha256:
              sha256Buffer(
                operator,
              ),
          },
          {
            path:
              "package-lock.json",
            sha256:
              sha256Buffer(
                lock,
              ),
          },
          {
            path:
              "sbom.cdx.json",
            sha256:
              sha256Buffer(
                sbom,
              ),
          },
        ],
        sbomPath:
          "sbom.cdx.json",
        sbomSha256:
          sha256Buffer(
            sbom,
          ),
      });

    assert.deepEqual(
      await verifyReleaseArtifact(
        root,
        manifest,
      ),
      [],
    );

    await writeFile(
      join(
        root,
        "dist",
        "cli",
        "operator.js",
      ),
      "tampered\n",
    );

    assert.match(
      (
        await verifyReleaseArtifact(
          root,
          manifest,
        )
      ).join(" "),
      /integrity mismatch/i,
    );

    await rm(
      join(
        root,
        "package-lock.json",
      ),
    );

    assert.match(
      (
        await verifyReleaseArtifact(
          root,
          manifest,
        )
      ).join(" "),
      /missing or unreadable/i,
    );
  } finally {
    await rm(
      root,
      {
        recursive: true,
        force: true,
      },
    );
  }
});
