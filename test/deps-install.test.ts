import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, createReadStream, createWriteStream, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import test from "node:test";
import { createZstdCompress } from "node:zlib";

import { installedPath } from "../src/deps/checks.js";
import { InstallError, installTool, removeInstalledTool } from "../src/deps/install.js";
import { loadToolPins, platformKey, type ToolPins } from "../src/deps/pins.js";

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

test("platforms without a pinned download are refused, and the shipped pins name exactly the six supported platforms", async () => {
  const pins = loadToolPins();
  await assert.rejects(
    installTool("ollama", { pins, home: root, platform: "sunos-x64" as never, download: fetchFrom("/nonexistent") }),
    (error: unknown) => error instanceof InstallError && error.code === "INSTALL_NO_ARTIFACT",
  );
  for (const tool of ["terraform", "ollama"] as const) {
    assert.deepEqual(Object.keys(pins.tools[tool].artifacts).sort(),
      ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64", "win32-arm64", "win32-x64"], tool);
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
  // Linux and Windows values are the vendors' published SHA256SUMS entries for the same versions.
  assert.equal(pins.tools.terraform.artifacts["linux-x64"]!.sha256, "dc94af0eef1147718ad7c8daea792ed199e3e0492eec180d0adafa2a65a879df");
  assert.equal(pins.tools.terraform.artifacts["linux-arm64"]!.sha256, "8263f301cb1a24489a4adeed147bf28504053f77237b3ea97a0ef2972659de30");
  assert.equal(pins.tools.terraform.artifacts["win32-x64"]!.sha256, "5c736ed6b0f13e98bc5029fe159574cca33634c3477466c56442c28b513a7054");
  assert.equal(pins.tools.terraform.artifacts["win32-arm64"]!.sha256, "ee984c4416d5592debc6e314f931adb222ca445b8ab23ce756c777225389e9f6");
  assert.equal(pins.tools.ollama.artifacts["linux-x64"]!.sha256, "c94aa4156b3d13e64ebc2efe5ea53f015384c882be776e6695cfb37fb180d5ad");
  assert.equal(pins.tools.ollama.artifacts["linux-arm64"]!.sha256, "4d27cb1d8f46176a3c0ce10aea2a16e4ad73dfe1599f2ed13468f29e5b8aba0d");
  assert.equal(pins.tools.ollama.artifacts["win32-x64"]!.sha256, "3623e256762ca89bd6fa99b0cc4106401919ce9df926411673e632e3ea287bb5");
  assert.equal(pins.tools.ollama.artifacts["win32-arm64"]!.sha256, "18eec8eeb6a1193b998b09c9aed2668b1b360663edf31ccf061c07a09f7bcb25");
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

test("platform keys cover macOS, Linux and Windows on x64 and arm64, and nothing else", () => {
  assert.equal(platformKey("darwin", "arm64"), "darwin-arm64");
  assert.equal(platformKey("linux", "x64"), "linux-x64");
  assert.equal(platformKey("linux", "arm64"), "linux-arm64");
  assert.equal(platformKey("win32", "x64"), "win32-x64");
  assert.equal(platformKey("win32", "arm64"), "win32-arm64");
  assert.equal(platformKey("freebsd", "x64"), undefined);
  assert.equal(platformKey("linux", "ia32"), undefined);
});

test("a tar.zst archive installs through Node's zstd support, and its binary keeps its folder", async () => {
  const source = join(root, "src-zst");
  mkdirSync(join(source, "bin"), { recursive: true });
  writeFileSync(join(source, "bin", "ollama"), "#!/bin/sh\necho 'ollama version is 0.40.0 zst'\n");
  chmodSync(join(source, "bin", "ollama"), 0o755);
  const tarFile = join(root, "zst.tar");
  execFileSync("tar", ["-cf", tarFile, "-C", source, "bin"]);
  const file = join(root, "zst.tar.zst");
  await pipeline(createReadStream(tarFile), createZstdCompress(), createWriteStream(file));
  const sha256 = createHash("sha256").update(readFileSync(file)).digest("hex");

  const pins = loadToolPins();
  pins.tools.ollama.artifacts["darwin-arm64"] = {
    url: "https://github.com/ollama/ollama/releases/download/v0.40.0/zst-fixture.tar.zst", sha256, archive: "tar.zst", binary: "bin/ollama",
  };
  const home = join(root, "zst-home");
  const installed = await installTool("ollama", { pins, home, platform: "darwin-arm64", download: fetchFrom(file) });
  assert.equal(installed.reused, false);
  assert.ok(existsSync(installed.path), "the binary is in the install folder");
  assert.ok(!existsSync(file + ".tar"), "the intermediate tar is removed");
});

test("uninstall removes one pinned version folder, leaves other versions alone, and a second removal does nothing", () => {
  const home = join(root, "home-uninstall");
  const removed = join(home, ".alz", "tools", "terraform", "1.16.4");
  const kept = join(home, ".alz", "tools", "terraform", "1.15.0");
  mkdirSync(removed, { recursive: true });
  mkdirSync(kept, { recursive: true });
  writeFileSync(join(removed, "terraform"), "installed");
  writeFileSync(join(kept, "terraform"), "other version");
  assert.equal(removeInstalledTool(home, "terraform", "1.16.4"), "removed");
  assert.ok(!existsSync(removed), "the pinned version folder is gone");
  assert.ok(existsSync(join(kept, "terraform")), "other versions are untouched");
  assert.equal(removeInstalledTool(home, "terraform", "1.16.4"), "absent", "a second removal changes nothing");
});

test("uninstall refuses a version folder that is a link out of the tool folder, and touches nothing outside it", () => {
  const home = join(root, "home-link");
  const toolRoot = join(home, ".alz", "tools", "ollama");
  mkdirSync(toolRoot, { recursive: true });
  const outside = join(root, "outside-target");
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(outside, "keep"), "not ours");
  symlinkSync(outside, join(toolRoot, "0.40.0"));
  assert.throws(
    () => removeInstalledTool(home, "ollama", "0.40.0"),
    (error: unknown) => error instanceof InstallError && error.code === "INSTALL_REMOVE_REFUSED",
  );
  assert.ok(existsSync(join(outside, "keep")), "the file the link points at is untouched");
});

test("uninstall refuses when .alz or tools is a link, and the folder the link points at keeps every file", () => {
  for (const linked of [".alz", "tools"] as const) {
    const home = join(root, "home-ancestor-" + linked.replace(".", ""));
    const outside = join(root, "outside-" + linked.replace(".", ""));
    // The external tree looks exactly like an install, so only the link check stands between it and the deletion.
    const external = linked === ".alz" ? join(outside, "tools", "terraform", "1.16.4") : join(outside, "terraform", "1.16.4");
    mkdirSync(external, { recursive: true });
    writeFileSync(join(external, "keep"), "not ours");
    mkdirSync(home, { recursive: true });
    if (linked === ".alz") symlinkSync(outside, join(home, ".alz"));
    else { mkdirSync(join(home, ".alz"), { recursive: true }); symlinkSync(outside, join(home, ".alz", "tools")); }
    assert.throws(() => removeInstalledTool(home, "terraform", "1.16.4"),
      (error: unknown) => error instanceof InstallError && error.code === "INSTALL_REMOVE_REFUSED", linked);
    assert.ok(existsSync(join(external, "keep")), "the external folder is untouched through a linked " + linked);
  }
});

test("uninstall refuses a version or tool that is not one safe path component, before touching the disk", () => {
  const home = join(root, "home-components");
  const victim = join(root, "victim");
  mkdirSync(join(victim, "keep-dir"), { recursive: true });
  mkdirSync(join(home, ".alz", "tools", "terraform"), { recursive: true });
  for (const version of ["..", ".", "../../victim", "/abs", "a/b", "a\\b", "", " 1.0", ".hidden", "1".repeat(65)]) {
    assert.throws(() => removeInstalledTool(home, "terraform", version),
      (error: unknown) => error instanceof InstallError && error.code === "INSTALL_REMOVE_REFUSED", JSON.stringify(version));
  }
  assert.throws(() => removeInstalledTool(home, "../victim" as never, "keep-dir"),
    (error: unknown) => error instanceof InstallError && error.code === "INSTALL_REMOVE_REFUSED");
  assert.ok(existsSync(join(victim, "keep-dir")));
  assert.ok(existsSync(join(home, ".alz", "tools", "terraform")), "the tool folder itself is never removed");
});

test("uninstall refuses a file where a folder belongs, and still works under a home reached through a link", () => {
  const home = join(root, "home-file");
  mkdirSync(join(home, ".alz", "tools", "terraform"), { recursive: true });
  writeFileSync(join(home, ".alz", "tools", "terraform", "1.16.4"), "a file, not an install");
  assert.throws(() => removeInstalledTool(home, "terraform", "1.16.4"),
    (error: unknown) => error instanceof InstallError && error.code === "INSTALL_REMOVE_REFUSED");
  // A home folder that is itself a link (macOS /var, some Linux /home layouts) is the anchor, not a component on the way.
  const realHome = join(root, "real-home");
  mkdirSync(join(realHome, ".alz", "tools", "ollama", "0.40.0"), { recursive: true });
  const linkedHome = join(root, "linked-home");
  symlinkSync(realHome, linkedHome);
  assert.equal(removeInstalledTool(linkedHome, "ollama", "0.40.0"), "removed");
  assert.ok(!existsSync(join(realHome, ".alz", "tools", "ollama", "0.40.0")));
  assert.ok(existsSync(join(realHome, ".alz", "tools", "ollama")));
});
