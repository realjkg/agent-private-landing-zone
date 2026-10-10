import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { chdir } from "node:process";
import { join } from "node:path";
import test from "node:test";

import { collectRepositoryEvidence } from "../src/build/repository.js";
import { sha256File } from "../src/release/manifest.js";

/**
 * The release manifest records digests with sha256File (raw bytes). The
 * doctor's installed-release check must agree with it exactly: hashing the
 * utf8 *string* of a binary artifact (the vendored pixel font was the first
 * one packaged) mangles the bytes and reported a clean install as dirty,
 * which failed `./alz doctor` inside the clean-install smoke.
 */
test("installed-release evidence stays clean for binary artifacts", async () => {
  const install = mkdtempSync(join(tmpdir(), "alz-evidence-"));
  const cwd = process.cwd();
  // WOFF-ish magic plus bytes that are invalid utf8 and do not round-trip
  // through a utf8 decode/encode cycle.
  const binary = Buffer.from([
    0x77, 0x4f, 0x46, 0x4f, 0x00, 0xff, 0xfe, 0x80, 0x01, 0xc2, 0x09,
  ]);
  const lock = '{ "lockfileVersion": 3, "name": "alz-smoke-fixture" }\n';

  writeFileSync(join(install, "font.woff2"), binary);
  writeFileSync(join(install, "package-lock.json"), lock, "utf8");
  writeFileSync(
    join(install, "release-manifest.json"),
    JSON.stringify({
      sourceCommit: "a".repeat(40),
      files: [
        { path: "font.woff2", sha256: await sha256File(join(install, "font.woff2")) },
        {
          path: "package-lock.json",
          sha256: await sha256File(join(install, "package-lock.json")),
        },
      ],
    }),
    "utf8",
  );

  chdir(install);
  try {
    const evidence = collectRepositoryEvidence();
    assert.equal(evidence.clean, true);
    assert.equal(
      evidence.packageLockHash,
      await sha256File(join(install, "package-lock.json")),
    );
  } finally {
    chdir(cwd);
  }
});

test("tampered binary artifacts are still reported dirty", async () => {
  const install = mkdtempSync(join(tmpdir(), "alz-evidence-"));
  const cwd = process.cwd();
  const binary = Buffer.from([0x00, 0xff, 0xfe, 0x80, 0x01]);

  writeFileSync(join(install, "font.woff2"), binary);
  writeFileSync(join(install, "package-lock.json"), "{}\n", "utf8");
  writeFileSync(
    join(install, "release-manifest.json"),
    JSON.stringify({
      sourceCommit: "b".repeat(40),
      files: [
        // Recorded digest matches the ORIGINAL bytes; the file on disk was
        // written identically, so flip one byte after recording.
        { path: "font.woff2", sha256: await sha256File(join(install, "font.woff2")) },
      ],
    }),
    "utf8",
  );
  writeFileSync(join(install, "font.woff2"), Buffer.from([0x01, 0xff, 0xfe, 0x80, 0x01]));

  chdir(install);
  try {
    const evidence = collectRepositoryEvidence();
    assert.equal(evidence.clean, false);
  } finally {
    chdir(cwd);
  }
});
