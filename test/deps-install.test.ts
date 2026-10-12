import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";

import { installedPath } from "../src/deps/checks.js";
import { InstallError, installTool } from "../src/deps/install.js";
import { loadToolPins, type ToolPins } from "../src/deps/pins.js";

// Installs run against a local archive the test builds, never the network. A wrong checksum must leave no install behind.

const root = mkdtempSync(join(tmpdir(), "alz-deps-install-"));
test.after(() => rmSync(root, { recursive: true, force: true }));

/** A tgz that holds a fake `ollama` program next to a library, like the real archive. */
function archive(label: string): { file: string; sha256: string } {
  const dir = join(root, "src-" + label);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "ollama"), "#!/bin/sh\necho 'ollama version is 0.40.0 " + label + "'\n");
  writeFileSync(join(dir, "libggml.so"), "library");
  const file = join(root, label + ".tgz");
  execFileSync("tar", ["-czf", file, "-C", dir, "ollama", "libggml.so"]);
  return { file, sha256: createHash("sha256").update(readFileSync(file)).digest("hex") };
}

function pinsWith(sha256: string, url = "https://github.com/ollama/ollama/releases/download/v0.40.0/ollama-darwin.tgz"): ToolPins {
  const pins = loadToolPins();
  pins.tools.ollama.artifacts["darwin-arm64"] = { url, sha256, archive: "tgz", binary: "ollama" };
  return pins;
}

const fetchFrom = (file: string) => async () => Readable.from([readFileSync(file)]);

test("a download that matches its pinned checksum is installed into the user folder and nothing else", async () => {
  const home = join(root, "home-ok");
  const good = archive("good");
  const installed = await installTool("ollama", { pins: pinsWith(good.sha256), home, platform: "darwin-arm64", download: fetchFrom(good.file) });
  assert.equal(installed.reused, false);
  assert.equal(installed.path, installedPath(home, "ollama", "0.40.0", "ollama"));
  assert.ok(existsSync(installed.path));
  assert.ok(existsSync(join(home, ".alz/tools/ollama/0.40.0/libggml.so")), "the library beside the binary is kept");
  // Scratch files are gone, and the partial folder never survives a successful install.
  assert.deepEqual(readdirSync(join(home, ".alz/tools/ollama")), ["0.40.0"]);
  assert.deepEqual(readdirSync(join(home, ".alz/tmp")), []);
  // A second run reuses the install without downloading again.
  let fetches = 0;
  const again = await installTool("ollama", { pins: pinsWith(good.sha256), home, platform: "darwin-arm64", download: async () => { fetches += 1; return Readable.from([]); } });
  assert.equal(again.reused, true);
  assert.equal(fetches, 0);
});

test("a download that does not match its checksum installs nothing, names no path, and leaves no partial folder", async () => {
  const home = join(root, "home-bad");
  const tampered = archive("tampered");
  const pins = pinsWith("0".repeat(64));
  await assert.rejects(
    installTool("ollama", { pins, home, platform: "darwin-arm64", download: fetchFrom(tampered.file) }),
    (error: unknown) => error instanceof InstallError && error.code === "INSTALL_CHECKSUM_MISMATCH" && !/0{64}|\/home-bad/.test(error.message),
  );
  assert.ok(!existsSync(installedPath(home, "ollama", "0.40.0", "ollama")));
  assert.deepEqual(readdirSync(join(home, ".alz/tools/ollama")), [], "no partial or final folder");
  assert.deepEqual(readdirSync(join(home, ".alz/tmp")), [], "the download is deleted");
});

test("a failed download, a missing program and a bad archive each stop with a plain code and install nothing", async () => {
  const good = archive("errors");
  const cases: Array<[string, () => Promise<Readable>, string]> = [
    ["failed download", async () => { throw new Error("network down"); }, "INSTALL_DOWNLOAD_FAILED"],
    ["archive without the program", async () => {
      const dir = join(root, "src-empty");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "readme"), "x");
      const file = join(root, "empty.tgz");
      execFileSync("tar", ["-czf", file, "-C", dir, "readme"]);
      return Readable.from([readFileSync(file)]);
    }, "INSTALL_CHECKSUM_MISMATCH"],
    ["not an archive", async () => Readable.from([Buffer.from("not an archive")]), "INSTALL_CHECKSUM_MISMATCH"],
  ];
  for (const [label, download, code] of cases) {
    const home = join(root, "home-" + label.replace(/\W+/g, "-"));
    await assert.rejects(
      installTool("ollama", { pins: pinsWith(good.sha256), home, platform: "darwin-arm64", download }),
      (error: unknown) => error instanceof InstallError && error.code === code,
      label,
    );
    assert.ok(!existsSync(installedPath(home, "ollama", "0.40.0", "ollama")), label);
  }
});

test("a pinned checksum is the only one accepted: a correct archive with the wrong pin is refused", async () => {
  const home = join(root, "home-wrongpin");
  const real = archive("wrongpin");
  const other = archive("otherpin");
  await assert.rejects(
    installTool("ollama", { pins: pinsWith(other.sha256), home, platform: "darwin-arm64", download: fetchFrom(real.file) }),
    (error: unknown) => error instanceof InstallError && error.code === "INSTALL_CHECKSUM_MISMATCH",
  );
  assert.ok(!existsSync(installedPath(home, "ollama", "0.40.0", "ollama")));
});

test("platforms without a pinned download are refused, and the shipped pins name exactly the two Mac types", async () => {
  const pins = loadToolPins();
  await assert.rejects(
    installTool("ollama", { pins, home: root, platform: "linux-x64" as never, download: fetchFrom("/nonexistent") }),
    (error: unknown) => error instanceof InstallError && error.code === "INSTALL_NO_ARTIFACT",
  );
  for (const tool of ["terraform", "ollama"] as const) {
    assert.deepEqual(Object.keys(pins.tools[tool].artifacts).sort(), ["darwin-arm64", "darwin-x64"], tool);
    for (const artifact of Object.values(pins.tools[tool].artifacts)) {
      assert.match(artifact!.sha256, /^[0-9a-f]{64}$/);
      assert.ok(artifact!.url.startsWith("https://"));
    }
  }
  assert.equal(pins.tools.terraform.version, "1.16.4");
  assert.equal(pins.tools.ollama.version, "0.40.0");
});

test("the shipped pins match the vendors' published checksums, and a malformed pin file is rejected", () => {
  const pins = loadToolPins();
  assert.equal(pins.tools.terraform.artifacts["darwin-arm64"]!.sha256, "42cfdf97ad722f79085fe2279b06d4b8680172de3534b22eeddd9a0fbbe7b8f1");
  assert.equal(pins.tools.terraform.artifacts["darwin-x64"]!.sha256, "2ee4b62064086e4b24b0d6cf2e61718fbaf0556feba990f708a5e32557554b3b");
  assert.equal(pins.tools.ollama.artifacts["darwin-arm64"]!.sha256, "b490b4925a95c5f3dfcd889e566cf3dcd727848d59057fb00b03f1d6630326dc");
  const bad = join(root, "bad-pins.json");
  const good = JSON.parse(readFileSync("config/tool-pins.json", "utf8"));
  good.tools.ollama.artifacts["darwin-arm64"].sha256 = "not-a-hash";
  writeFileSync(bad, JSON.stringify(good));
  assert.throws(() => loadToolPins(bad), /TOOL_PIN_INVALID: ollama darwin-arm64/);
  good.tools.ollama.artifacts["darwin-arm64"].sha256 = "b490b4925a95c5f3dfcd889e566cf3dcd727848d59057fb00b03f1d6630326dc";
  good.tools.ollama.artifacts["darwin-arm64"].url = "http://example.invalid/ollama.tgz";
  writeFileSync(bad, JSON.stringify(good));
  assert.throws(() => loadToolPins(bad), /TOOL_PIN_INVALID/);
  chmodSync(bad, 0o600);
});
