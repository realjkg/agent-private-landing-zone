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
  type EvidenceEnvelope,
} from "../src/evidence/vault.js";
import {
  readControlPlaneRecovery,
  restoreControlPlaneRecovery,
  validateControlPlaneRecoveryBundle,
  writeControlPlaneRecovery,
} from "../src/recovery/control-plane/bundle.js";
import {
  createReleaseManifest,
  sha256Buffer,
} from "../src/release/manifest.js";

type Fixture = {
  key: Buffer;
  originalEvidenceKey:
    string | undefined;
};

function setEvidenceKey():
  Fixture {
  const originalEvidenceKey =
    process.env
      .AGENTIC_EVIDENCE_KEY;
  const key =
    Buffer.alloc(
      32,
      7,
    );

  process.env
    .AGENTIC_EVIDENCE_KEY =
    key.toString("base64");

  return {
    key,
    originalEvidenceKey,
  };
}

function restoreEvidenceKey(
  value:
    string | undefined,
): void {
  if (value === undefined) {
    delete process.env
      .AGENTIC_EVIDENCE_KEY;
  } else {
    process.env
      .AGENTIC_EVIDENCE_KEY =
      value;
  }
}

async function writePath(
  root: string,
  path: string,
  value:
    string | Buffer,
): Promise<void> {
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
    value,
  );
}

async function releaseFixture(
  root: string,
  key: Buffer,
): Promise<void> {
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
    value,
  ] of Object.entries(
    contents,
  )) {
    await writePath(
      root,
      path,
      value,
    );
  }

  await chmod(
    join(root, "alz"),
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
            value,
          ]) => ({
            path,
            sha256:
              sha256Buffer(
                value,
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

  await writePath(
    root,
    "release-manifest.json",
    JSON.stringify(
      manifest,
      null,
      2,
    ) + "\n",
  );

  await writePath(
    root,
    "config/recovery-targets.json",
    "{\"targets\":[]}\n",
  );

  const sessionEnvelope =
    encryptEvidence(
      "session",
      {
        threadId:
          "control-plane-test",
        actEnabled: false,
      },
      key,
    );

  await writePath(
    root,
    ".runs/evidence/session/turn.evidence",
    JSON.stringify(
      sessionEnvelope,
    ) + "\n",
  );

  const recoveryEnvelope =
    encryptEvidence(
      "recovery-automation",
      {
        targetId:
          "control-plane-test",
        status: "HEALTHY",
        actEnabled: false,
      },
      key,
    );

  await writePath(
    root,
    ".runs/evidence/recovery-automation/state.evidence",
    JSON.stringify(
      recoveryEnvelope,
    ) + "\n",
  );

  await writePath(
    root,
    ".runs/checkpoints/session.sqlite",
    Buffer.from(
      "quiesced-checkpoint\n",
      "utf8",
    ),
  );
}

test("control-plane recovery is encrypted, excludes the evidence key, and restores release plus state", async () => {
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
  const evidence =
    join(
      base,
      "control-plane.evidence",
    );
  const restored =
    join(
      base,
      "restored",
    );
  const fixture =
    setEvidenceKey();

  try {
    await mkdir(root);
    await releaseFixture(
      root,
      fixture.key,
    );

    const captured =
      await writeControlPlaneRecovery(
        root,
        evidence,
      );

    assert.equal(
      captured.bundle
        .actEnabled,
      false,
    );
    assert.equal(
      captured.bundle
        .mutationAttempted,
      false,
    );
    assert.equal(
      captured.bundle
        .keyReference
        .secretIncluded,
      false,
    );
    assert.deepEqual(
      captured.bundle.state,
      {
        encryptedEvidencePresent:
          true,
        recoveryAutomationStatePresent:
          true,
        checkpointStatePresent:
          true,
      },
    );
    assert.deepEqual(
      validateControlPlaneRecoveryBundle(
        captured.bundle,
      ),
      [],
    );

    assert.ok(
      captured.bundle.files.some(
        (file) =>
          file.path ===
            "config/recovery-targets.json" &&
          file.kind ===
            "CONFIGURATION",
      ),
    );
    assert.ok(
      captured.bundle.files.some(
        (file) =>
          file.kind ===
          "RECOVERY_AUTOMATION_STATE",
      ),
    );
    assert.ok(
      captured.bundle.files.some(
        (file) =>
          file.kind ===
          "CHECKPOINT_STATE",
      ),
    );
    assert.ok(
      !captured.bundle.files.some(
        (file) =>
          /evidence\.key/i.test(
            file.path,
          ),
      ),
    );

    const raw =
      await readFile(
        evidence,
        "utf8",
      );
    const envelope =
      JSON.parse(
        raw,
      ) as EvidenceEnvelope;

    assert.equal(
      envelope.algorithm,
      "aes-256-gcm",
    );
    assert.equal(
      raw.includes(
        "recovery-targets.json",
      ),
      false,
    );
    assert.equal(
      raw.includes(
        fixture.key.toString(
          "base64",
        ),
      ),
      false,
    );

    const verified =
      await readControlPlaneRecovery(
        evidence,
      );

    assert.equal(
      verified.bundleHash,
      captured.bundle
        .bundleHash,
    );

    const result =
      await restoreControlPlaneRecovery({
        evidencePath:
          evidence,
        restoreRoot:
          restored,
      });

    assert.equal(
      result.verified,
      true,
    );
    assert.equal(
      result.releaseIntegrity,
      true,
    );
    assert.equal(
      result.actEnabled,
      false,
    );
    assert.equal(
      result.mutationAttempted,
      false,
    );
    assert.deepEqual(
      result.state,
      captured.bundle.state,
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
    restoreEvidenceKey(
      fixture
        .originalEvidenceKey,
    );
    await rm(
      base,
      {
        recursive: true,
        force: true,
      },
    );
  }
});

test("control-plane recovery fails closed with the wrong customer evidence key", async () => {
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
  const evidence =
    join(
      base,
      "control-plane.evidence",
    );
  const fixture =
    setEvidenceKey();

  try {
    await mkdir(root);
    await releaseFixture(
      root,
      fixture.key,
    );
    await writeControlPlaneRecovery(
      root,
      evidence,
    );

    process.env
      .AGENTIC_EVIDENCE_KEY =
      Buffer.alloc(
        32,
        9,
      ).toString(
        "base64",
      );

    await assert.rejects(
      () =>
        readControlPlaneRecovery(
          evidence,
        ),
    );
  } finally {
    restoreEvidenceKey(
      fixture
        .originalEvidenceKey,
    );
    await rm(
      base,
      {
        recursive: true,
        force: true,
      },
    );
  }
});

test("control-plane recovery detects tampered encrypted bundle", async () => {
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
  const evidence =
    join(
      base,
      "control-plane.evidence",
    );
  const fixture =
    setEvidenceKey();

  try {
    await mkdir(root);
    await releaseFixture(
      root,
      fixture.key,
    );
    await writeControlPlaneRecovery(
      root,
      evidence,
    );

    const envelope =
      JSON.parse(
        await readFile(
          evidence,
          "utf8",
        ),
      ) as EvidenceEnvelope;

    const first =
      envelope.ciphertext
        .slice(0, 1);
    envelope.ciphertext =
      (first === "A"
        ? "B"
        : "A") +
      envelope.ciphertext
        .slice(1);

    await writeFile(
      evidence,
      JSON.stringify(
        envelope,
      ) + "\n",
    );

    await assert.rejects(
      () =>
        readControlPlaneRecovery(
          evidence,
        ),
    );
  } finally {
    restoreEvidenceKey(
      fixture
        .originalEvidenceKey,
    );
    await rm(
      base,
      {
        recursive: true,
        force: true,
      },
    );
  }
});

test("control-plane capture blocks a tampered release before recovery evidence is created", async () => {
  const base =
    await mkdtemp(
      join(
        tmpdir(),
        "alz-control-plane-release-",
      ),
    );
  const root =
    join(
      base,
      "release",
    );
  const evidence =
    join(
      base,
      "control-plane.evidence",
    );
  const fixture =
    setEvidenceKey();

  try {
    await mkdir(root);
    await releaseFixture(
      root,
      fixture.key,
    );

    await writeFile(
      join(
        root,
        "config",
        "base.json",
      ),
      "tampered\n",
    );

    await assert.rejects(
      () =>
        writeControlPlaneRecovery(
          root,
          evidence,
        ),
      /RELEASE_INTEGRITY_BLOCKED/,
    );
  } finally {
    restoreEvidenceKey(
      fixture
        .originalEvidenceKey,
    );
    await rm(
      base,
      {
        recursive: true,
        force: true,
      },
    );
  }
});

test("control-plane restore refuses a non-isolated target", async () => {
  const base =
    await mkdtemp(
      join(
        tmpdir(),
        "alz-control-plane-isolation-",
      ),
    );
  const root =
    join(
      base,
      "release",
    );
  const evidence =
    join(
      base,
      "control-plane.evidence",
    );
  const fixture =
    setEvidenceKey();

  try {
    await mkdir(root);
    await releaseFixture(
      root,
      fixture.key,
    );
    await writeControlPlaneRecovery(
      root,
      evidence,
    );

    await assert.rejects(
      () =>
        restoreControlPlaneRecovery({
          evidencePath:
            evidence,
          restoreRoot:
            process.cwd(),
        }),
      /RESTORE_ROOT_UNSAFE/,
    );
  } finally {
    restoreEvidenceKey(
      fixture
        .originalEvidenceKey,
    );
    await rm(
      base,
      {
        recursive: true,
        force: true,
      },
    );
  }
});
