import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, createReadStream, createWriteStream, existsSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createZstdDecompress } from "node:zlib";

import { installedPath } from "./checks.js";
import { type Artifact, type Platform, type ToolId, type ToolPins } from "./pins.js";

/**
 * Installs one pinned tool into ~/.alz/tools/<tool>/<version>/ (docs/operator-guide.md). The archive is downloaded to a
 * private temporary file, its SHA-256 is checked against the pin, and only then is it unpacked. A mismatch, a failed
 * download or a failed unpack leaves nothing behind that a later check could mistake for a working install. No
 * administrator password is used, and nothing is added to the shell's PATH.
 */
export class InstallError extends Error {
  constructor(readonly code: "INSTALL_NO_ARTIFACT" | "INSTALL_DOWNLOAD_FAILED" | "INSTALL_CHECKSUM_MISMATCH" | "INSTALL_UNPACK_FAILED" | "INSTALL_BINARY_MISSING", message: string) {
    super(message);
  }
}

export type InstallOptions = {
  pins: ToolPins;
  home: string;
  platform: Platform;
  /** Downloads a URL. Defaults to fetch; tests pass a local source, never the network. */
  download?: (url: string) => Promise<Readable>;
  /** A private scratch directory for the download. Created with mode 0700 if absent. */
  scratch?: string;
};

export type InstalledTool = { tool: ToolId; version: string; path: string; sha256: string; reused: boolean };

async function defaultDownload(url: string): Promise<Readable> {
  const response = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(10 * 60_000) });
  if (!response.ok || !response.body) throw new InstallError("INSTALL_DOWNLOAD_FAILED", "The download did not succeed (HTTP " + response.status + ").");
  return Readable.fromWeb(response.body as never);
}

/** Streams a download to `file`, returning its SHA-256. Nothing is held in memory beyond one chunk. */
async function fetchTo(file: string, source: Readable): Promise<string> {
  const hash = createHash("sha256");
  const digest = new Transform({
    transform(chunk: Buffer, _encoding, done) {
      hash.update(chunk);
      done(null, chunk);
    },
  });
  await pipeline(source, digest, createWriteStream(file, { mode: 0o600 }));
  return hash.digest("hex");
}

async function unpack(archive: Artifact["archive"], file: string, into: string): Promise<void> {
  try {
    if (archive === "tgz") {
      execFileSync("tar", ["-xzf", file, "-C", into], { stdio: "ignore" });
    } else if (archive === "tar.zst") {
      // Node decompresses the zstd stream; the plain tar that follows ships with macOS, Linux and Windows 10 and later.
      const tarFile = file + ".tar";
      try {
        await pipeline(createReadStream(file), createZstdDecompress(), createWriteStream(tarFile, { mode: 0o600 }));
        execFileSync("tar", ["-xf", tarFile, "-C", into], { stdio: "ignore" });
      } finally {
        rmSync(tarFile, { force: true });
      }
    } else if (process.platform === "win32") {
      // Windows has no unzip; its built-in tar reads zip archives.
      execFileSync("tar", ["-xf", file, "-C", into], { stdio: "ignore" });
    } else {
      execFileSync("unzip", ["-q", "-o", file, "-d", into], { stdio: "ignore" });
    }
  } catch {
    throw new InstallError("INSTALL_UNPACK_FAILED", "The archive could not be unpacked.");
  }
}

/** Installs `tool` at its pinned version, or returns the existing install when it is already present and intact. */
export async function installTool(tool: ToolId, opts: InstallOptions): Promise<InstalledTool> {
  const pin = opts.pins.tools[tool];
  const artifact = pin.artifacts[opts.platform];
  if (!artifact) throw new InstallError("INSTALL_NO_ARTIFACT", "No pinned " + tool + " download exists for this computer type.");
  const finalBinary = installedPath(opts.home, tool, pin.version, artifact.binary);
  if (existsSync(finalBinary)) {
    return { tool, version: pin.version, path: finalBinary, sha256: artifact.sha256, reused: true };
  }

  const toolRoot = join(opts.home, ".alz", "tools", tool);
  const scratch = opts.scratch ?? join(opts.home, ".alz", "tmp");
  mkdirSync(scratch, { recursive: true, mode: 0o700 });
  mkdirSync(toolRoot, { recursive: true, mode: 0o700 });
  const archiveFile = join(scratch, tool + "-" + pin.version + "-" + process.pid + "." + artifact.archive);
  const partial = join(toolRoot, pin.version + ".partial-" + process.pid);
  const finalDir = join(toolRoot, pin.version);

  try {
    let sha256: string;
    try {
      sha256 = await fetchTo(archiveFile, await (opts.download ?? defaultDownload)(artifact.url));
    } catch (error) {
      if (error instanceof InstallError) throw error;
      throw new InstallError("INSTALL_DOWNLOAD_FAILED", "The download did not finish. Check your connection and try again.");
    }
    if (sha256 !== artifact.sha256) {
      throw new InstallError("INSTALL_CHECKSUM_MISMATCH",
        "The download does not match the pinned checksum, so nothing was installed. Do not retry on another network without asking the project owner.");
    }
    mkdirSync(partial, { recursive: true, mode: 0o700 });
    await unpack(artifact.archive, archiveFile, partial);
    const partialBinary = join(partial, artifact.binary);
    if (!existsSync(partialBinary) || !statSync(partialBinary).isFile()) {
      throw new InstallError("INSTALL_BINARY_MISSING", "The archive did not contain " + artifact.binary + ".");
    }
    chmodSync(partialBinary, 0o755);
    rmSync(finalDir, { recursive: true, force: true });
    renameSync(partial, finalDir);
    return { tool, version: pin.version, path: finalBinary, sha256, reused: false };
  } finally {
    rmSync(archiveFile, { force: true });
    rmSync(partial, { recursive: true, force: true });
  }
}
