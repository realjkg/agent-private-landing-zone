import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The pinned tools `./alz deps` checks and, on request, installs (config/tool-pins.json). Every installed artifact is
 * named here with its exact URL and SHA-256; nothing else is ever downloaded.
 */
export type ToolId = "terraform" | "ollama";
export type Platform = "darwin-arm64" | "darwin-x64" | "linux-x64" | "linux-arm64" | "win32-x64" | "win32-arm64";
export type Artifact = { url: string; sha256: string; archive: "zip" | "tgz" | "tar.zst"; binary: string };
export type ToolPin = { version: string; checksumSource: string; tested: string[]; artifacts: Partial<Record<Platform, Artifact>> };
/** A check-only pin: a tested version `./alz deps` compares against and never installs (no artifact, no checksum). */
export type CheckOnlyPin = { version: string; versionCommand: string; tested: string[] };
export type ToolPins = {
  schemaVersion: 1;
  tools: Record<ToolId, ToolPin>;
  node: { major: number };
  isolatedOllama: { host: string; port: number; models: string[] };
  /** The AWS CLI v2 the CDK path is tested with: check only (the vendor's installer needs an administrator password on macOS). */
  awsCli: CheckOnlyPin;
};

const HEX64 = /^[0-9a-f]{64}$/;
const HTTPS = /^https:\/\/[a-z0-9.-]+\//;

export const DEFAULT_PINS = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "config", "tool-pins.json");

/** Reads and checks the pin file. Any malformed entry throws, so nothing is installed from a half-valid file. */
export function loadToolPins(path: string = DEFAULT_PINS): ToolPins {
  const raw = JSON.parse(readFileSync(path, "utf8")) as ToolPins;
  if (raw.schemaVersion !== 1) throw new Error("TOOL_PINS_SCHEMA");
  for (const tool of ["terraform", "ollama"] as const) {
    const pin = raw.tools?.[tool];
    if (!pin || !/^\d+\.\d+\.\d+$/.test(pin.version)) throw new Error("TOOL_PIN_INVALID: " + tool);
    for (const [platform, artifact] of Object.entries(pin.artifacts)) {
      if (!artifact || !HTTPS.test(artifact.url) || !HEX64.test(artifact.sha256) || !["zip", "tgz", "tar.zst"].includes(artifact.archive) || !artifact.binary) {
        throw new Error("TOOL_PIN_INVALID: " + tool + " " + platform);
      }
    }
  }
  if (raw.node?.major !== 26) throw new Error("TOOL_PIN_INVALID: node");
  if (!/^2\.\d+\.\d+$/.test(raw.awsCli?.version ?? "") || raw.awsCli.versionCommand !== "aws --version" || !Array.isArray(raw.awsCli.tested)) throw new Error("TOOL_PIN_INVALID: awsCli");
  return raw;
}

const PLATFORM_KEYS: Record<string, Platform> = {
  "darwin-arm64": "darwin-arm64",
  "darwin-x64": "darwin-x64",
  "linux-arm64": "linux-arm64",
  "linux-x64": "linux-x64",
  "win32-arm64": "win32-arm64",
  "win32-x64": "win32-x64",
};

/** The platform key a pin is looked up by, or undefined where ./alz deps installs nothing automatically. */
export function platformKey(platform: string = process.platform, arch: string = process.arch): Platform | undefined {
  return PLATFORM_KEYS[platform + "-" + arch];
}
