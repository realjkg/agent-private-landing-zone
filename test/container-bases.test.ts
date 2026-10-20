import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { validateBases } from "../scripts/container-bases.mjs";

const lock = JSON.parse(readFileSync("config/container-bases.json", "utf8"));
const dockerfile = readFileSync("Dockerfile", "utf8");
const badDigest = `sha256:${"0".repeat(64)}`;

test("reviewed Dockerfile resolves both native platforms from the retained registry indexes", () => {
  validateBases(lock, dockerfile);
});

for (const [name, mutate] of [
  ["missing lock", () => null],
  ["wrong schema", value => { value.schemaVersion = 2; return value; }],
  ["missing image", value => { value.bases.pop(); return value; }],
  ["duplicate image", value => { value.bases[1] = value.bases[0]; return value; }],
  ["missing entry", value => { value.bases[0] = null; return value; }],
  ["changed repository", value => { value.bases[0].repository = "example.com/library/node"; return value; }],
  ["changed image", value => { value.bases[0].image = "node:latest"; return value; }],
  ["invalid digest", value => { value.bases[0].digest = "sha256:bad"; return value; }],
  ["missing ARM64 digest", value => { delete value.bases[0].platforms.arm64; return value; }],
  ["mutable evidence", value => { value.bases[0].evidence = value.bases[0].evidence.replace(/blob\/[a-f0-9]{40}/, "blob/master"); return value; }],
  ["wrong evidence image", value => { value.bases[0].evidence = value.bases[1].evidence; return value; }],
  ["snapshot path traversal", value => { value.bases[0].indexFile = "../../other.json"; return value; }],
  ["invalid retrieval date", value => { value.retrievedAt = "2026-02-30"; return value; }],
] as const satisfies ReadonlyArray<readonly [string, (value: any) => any]>) {
  test(`base lock rejects ${name}`, () => {
    assert.throws(() => validateBases(mutate(structuredClone(lock)), dockerfile), /BASE_LOCK_INVALID/);
  });
}

test("retained index bytes cannot be changed or reformatted without failing the digest", () => {
  assert.throws(() => validateBases(lock, dockerfile, path => Buffer.concat([
    readFileSync(path), Buffer.from("\n"),
  ])), /BASE_INDEX_DIGEST_MISMATCH/);
});

test("swapped child architecture digests fail even when the index digest is correct", () => {
  const changed = structuredClone(lock);
  const platforms = changed.bases[0].platforms;
  [platforms.amd64, platforms.arm64] = [platforms.arm64, platforms.amd64];
  assert.throws(() => validateBases(changed, dockerfile), /BASE_PLATFORM_MISMATCH/);
});

for (const [name, mutate, error] of [
  ["missing Linux ARM64", index => { index.manifests = index.manifests.filter(entry => entry.platform.architecture !== "arm64"); }, /BASE_PLATFORM_MISMATCH/],
  ["duplicate Linux AMD64", index => { index.manifests.push(index.manifests.find(entry => entry.platform.architecture === "amd64")); }, /BASE_PLATFORM_MISMATCH/],
  ["wrong operating system", index => { index.manifests.find(entry => entry.platform.architecture === "arm64").platform.os = "windows"; }, /BASE_PLATFORM_MISMATCH/],
  ["wrong architecture variant", index => { index.manifests.find(entry => entry.platform.architecture === "arm64").platform.variant = "v9"; }, /BASE_PLATFORM_MISMATCH/],
  ["wrong child digest", index => { index.manifests.find(entry => entry.platform.architecture === "arm64").digest = badDigest; }, /BASE_PLATFORM_MISMATCH/],
  ["wrong child type", index => { index.manifests.find(entry => entry.platform.architecture === "arm64").mediaType = "application/octet-stream"; }, /BASE_PLATFORM_MISMATCH/],
  ["non-index manifest", index => { index.mediaType = "application/vnd.oci.image.manifest.v1+json"; }, /BASE_INDEX_INVALID/],
] as const satisfies ReadonlyArray<readonly [string, (value: any) => void, RegExp]>) {
  test(`index rejects ${name} after successful hash verification`, () => {
    const changed = structuredClone(lock);
    const base = changed.bases[0];
    const index = JSON.parse(readFileSync(base.indexFile, "utf8"));
    mutate(index);
    const bytes = Buffer.from(JSON.stringify(index));
    const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
    const changedDockerfile = dockerfile.replace(base.digest, digest);
    base.digest = digest;
    assert.throws(() => validateBases(changed, changedDockerfile,
      path => path === base.indexFile ? bytes : readFileSync(path)), error);
  });
}

for (const [name, changed] of [
  ["tag-only build", dockerfile.replace(`@${lock.bases[0].digest}`, "")],
  ["wrong runtime digest", dockerfile.replaceAll(lock.bases[1].digest, badDigest)],
  ["extra unpinned stage", `${dockerfile}\n  FROM node:latest AS other\n`],
  ["missing stage", dockerfile.replace(/^FROM build AS test\n/m, "")],
  ["duplicate stage alias", dockerfile.replace("AS runtime-deps", "AS build")],
  ["platform override", dockerfile.replace("FROM node:", "FROM --platform=linux/amd64 node:")],
  ["build argument substitution", dockerfile.replace("FROM node:26-bookworm-slim", "FROM ${BASE_IMAGE}")],
  ["continued FROM instruction", dockerfile.replace("FROM node:", "FROM \\\nnode:")],
  ["external test image", dockerfile.replace("FROM build AS test", "FROM node:26 AS test")],
] as const) {
  test(`Dockerfile rejects ${name}`, () => {
    assert.throws(() => validateBases(lock, changed), /BASE_(DIGEST_DRIFT|STAGE_MISSING|FROM_INVALID)/);
  });
}

test("Dockerfile whitespace and instruction casing do not hide an external base", () => {
  validateBases(lock, dockerfile.replaceAll("FROM ", "  from\t"));
  assert.throws(() => validateBases(lock, dockerfile.replace("FROM node:", "  from\tnode:")
    .replace(`@${lock.bases[0].digest}`, "")), /BASE_DIGEST_DRIFT/);
});
