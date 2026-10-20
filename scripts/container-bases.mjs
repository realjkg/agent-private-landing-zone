import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const images = ["node:26-bookworm-slim", "node:26-alpine"];
const digestPattern = /^sha256:[a-f0-9]{64}$/;
const indexTypes = new Set([
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
]);
const childTypes = new Set([
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.docker.distribution.manifest.v2+json",
]);

/** Offline integrity and platform checks; publisher trust still requires review. */
export function validateBases(lock, dockerfile, readIndex = readFileSync) {
  if (lock?.schemaVersion !== 1 || !Array.isArray(lock.bases) || lock.bases.length !== 2 ||
      typeof lock.retrievedAt !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(lock.retrievedAt) ||
      !Number.isFinite(Date.parse(lock.retrievedAt)) ||
      new Date(lock.retrievedAt).toISOString().slice(0, 10) !== lock.retrievedAt) {
    throw new Error("BASE_LOCK_INVALID");
  }
  const expected = new Map();
  for (const base of lock.bases) {
    if (!base || !images.includes(base.image) || expected.has(base.image) ||
        base.repository !== "docker.io/library/node" ||
        typeof base.digest !== "string" || !digestPattern.test(base.digest) ||
        !["amd64", "arm64"].every(arch => typeof base.platforms?.[arch] === "string" &&
          digestPattern.test(base.platforms[arch])) ||
        typeof base.evidence !== "string" ||
        !new RegExp("^https://github\\.com/docker-library/repo-info/blob/[a-f0-9]{40}/repos/node/remote/" +
          base.image.split(":")[1] + "\\.md$").test(base.evidence) ||
        base.indexFile !== `config/container-bases/${base.image.split(":")[1]}.index.json`) {
      throw new Error("BASE_LOCK_INVALID");
    }
    // Hash the exact registry bytes before parsing; reformatting changes identity.
    const bytes = readIndex(base.indexFile);
    if (`sha256:${createHash("sha256").update(bytes).digest("hex")}` !== base.digest) {
      throw new Error("BASE_INDEX_DIGEST_MISMATCH");
    }
    const index = JSON.parse(bytes.toString());
    if (index?.schemaVersion !== 2 || !indexTypes.has(index.mediaType) || !Array.isArray(index.manifests)) {
      throw new Error("BASE_INDEX_INVALID");
    }
    for (const arch of ["amd64", "arm64"]) {
      const matches = index.manifests.filter(entry => entry?.platform?.os === "linux" &&
        entry.platform.architecture === arch);
      if (matches.length !== 1 || matches[0].digest !== base.platforms[arch] ||
          !childTypes.has(matches[0].mediaType) ||
          (arch === "arm64" && ![undefined, "v8"].includes(matches[0].platform.variant))) {
        throw new Error("BASE_PLATFORM_MISMATCH");
      }
    }
    expected.set(base.image, base.digest);
  }

  // Intentionally support only the reviewed four-stage layout. New FROM syntax,
  // platform overrides and stages require a lock-validator review as well.
  const stages = [
    ["build", `node:26-bookworm-slim@${expected.get("node:26-bookworm-slim")}`],
    ["test", "build"],
    ["runtime-deps", `node:26-alpine@${expected.get("node:26-alpine")}`],
    ["runtime", `node:26-alpine@${expected.get("node:26-alpine")}`],
  ];
  const fromLines = dockerfile.split(/\r?\n/).map(line => line.trim()).filter(line => /^FROM\b/i.test(line));
  if (fromLines.length !== stages.length) throw new Error("BASE_STAGE_MISSING");
  for (const [i, line] of fromLines.entries()) {
    const match = /^FROM\s+(\S+)\s+AS\s+([a-z-]+)$/i.exec(line);
    if (!match) throw new Error("BASE_FROM_INVALID");
    if (match[1] !== stages[i][1] || match[2].toLowerCase() !== stages[i][0]) {
      throw new Error("BASE_DIGEST_DRIFT");
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  validateBases(JSON.parse(readFileSync("config/container-bases.json", "utf8")), readFileSync("Dockerfile", "utf8"));
  console.log("Base indexes, Linux AMD64/ARM64 children and all Dockerfile stages match the reviewed lock.");
}
