import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  BRAND_FINGERPRINT,
  BRAND_PROVENANCE,
  matchesBrandProvenance,
} from "../src/brand/identity.js";
import { sha256Buffer } from "../src/release/manifest.js";
import { RELEASE_BRAND_FILE_NAME } from "../src/cli/release-package.js";

const repository = fileURLToPath(new URL("../", import.meta.url));
const tsx = resolve(repository, "node_modules/.bin/tsx");
const cli = resolve(repository, "src/cli/release-package.ts");

test("brand fingerprint identifies author, upstream repository, MIT software and owner-declared mark", () => {
  assert.equal(RELEASE_BRAND_FILE_NAME, "brand-provenance.json");
  assert.equal(BRAND_PROVENANCE.originalAuthor, "JK Gonzalez");
  assert.equal(BRAND_PROVENANCE.productMark, "Sovereign ALZ®");
  assert.equal(BRAND_PROVENANCE.copyrightHolder, "Adapt Cloud");
  assert.equal(BRAND_PROVENANCE.softwareLicense, "MIT");
  assert.equal(BRAND_PROVENANCE.fingerprintSha256, BRAND_FINGERPRINT);
  assert.match(BRAND_FINGERPRINT, /^[a-f0-9]{64}$/);
  assert.equal(matchesBrandProvenance(BRAND_PROVENANCE), true);
  assert.equal(matchesBrandProvenance({
    ...BRAND_PROVENANCE,
    originalAuthor: "Changed",
  }), false);
  assert.equal(matchesBrandProvenance({
    ...BRAND_PROVENANCE,
    fingerprintSha256: "0".repeat(64),
  }), false);
});

test("new preview release embeds hash-bound provenance; tampering blocks verification", async () => {
  const root = await mkdtemp(join(tmpdir(), "alz-brand-"));
  try {
    await writeFile(join(root, "sbom.cdx.json"), '{"bomFormat":"CycloneDX"}\n');
    const argumentsFor = ["--root", root];
    const generated = spawnSync(tsx, [
      cli, ...argumentsFor, "--version", "1.0.0",
      "--source-commit", "a".repeat(40),
    ], { cwd: repository, encoding: "utf8", timeout: 30000 });
    assert.equal(generated.status, 0, generated.stderr || generated.stdout);

    const brand = await readFile(join(root, RELEASE_BRAND_FILE_NAME), "utf8");
    // The public mark is readable by the unprivileged production image user.
    assert.equal((await stat(join(root, RELEASE_BRAND_FILE_NAME))).mode & 0o777, 0o644);
    assert.deepEqual(JSON.parse(brand), BRAND_PROVENANCE);
    assert.equal(brand.endsWith("\n"), true);
    const manifest = JSON.parse(await readFile(join(root, "release-manifest.json"), "utf8"));
    assert.equal(manifest.contract.actEnabled, false);
    assert.equal(
      manifest.files.find((item: {path: string; sha256: string}) =>
        item.path === RELEASE_BRAND_FILE_NAME)?.sha256,
      sha256Buffer(brand),
    );

    await writeFile(join(root, "brand-provenance.json"), "tampered\n");
    const verified = spawnSync(tsx, [cli, ...argumentsFor, "--verify"], {
      cwd: repository, encoding: "utf8", timeout: 30000,
    });
    assert.notEqual(verified.status, 0);
    assert.match(verified.stderr, /integrity mismatch.*brand-provenance/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
