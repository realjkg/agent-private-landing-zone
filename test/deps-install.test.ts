import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, createReadStream, createWriteStream, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import test from "node:test";
import { createZstdCompress } from "node:zlib";

import { appInstallStates, INSTALL_MARKER, installedPath, installState, readInstallMarker, REMOVING_MARKER } from "../src/deps/checks.js";
import { acquireToolLock, InstallError, installTool, pidProvenDead, removeInstalledTool, sweepLeftovers, sweepToolLeftovers, writeInstallMarker } from "../src/deps/install.js";
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
  // The completion marker is the install's last step; it names exactly what was installed and checked.
  const marker = readInstallMarker(join(home, ".alz/tools/ollama/0.40.0"), "ollama", "0.40.0", "ollama");
  assert.ok(marker, "a finished install carries its completion marker");
  assert.deepEqual({ tool: marker!.tool, version: marker!.version, binary: marker!.binary, sha256: marker!.sha256 }, { tool: "ollama", version: "0.40.0", binary: "ollama", sha256: good.sha256 });
  assert.ok(Date.parse(marker!.completedAt) > 0);
  assert.equal(installState(home, "ollama", "0.40.0", "ollama"), "INSTALLED");
  assert.deepEqual(installed.swept, []);
  assert.equal(installed.replaced, undefined);
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
  // The check-only pins of the Bicep path: a version of the wrong shape or another version command is refused.
  for (const [key, field, value] of [["azureCli", "version", "3.0"], ["azureCli", "versionCommand", "az --version"], ["bicep", "version", "1.0"], ["bicep", "versionCommand", "bicep version"]] as const) {
    const pinned = JSON.parse(readFileSync("config/tool-pins.json", "utf8"));
    pinned[key][field] = value;
    writeFileSync(bad, JSON.stringify(pinned));
    assert.throws(() => loadToolPins(bad), new RegExp("TOOL_PIN_INVALID: " + key), key + "." + field);
  }
  assert.equal(pins.azureCli.version, "2.91.0");
  assert.equal(pins.bicep.version, "0.47.16");
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
  writeInstallMarker(removed, { tool: "terraform", version: "1.16.4", binary: "terraform", sha256: "b".repeat(64), completedAt: "2026-10-27T00:00:00.000Z" });
  writeInstallMarker(kept, { tool: "terraform", version: "1.15.0", binary: "terraform", sha256: "c".repeat(64), completedAt: "2026-10-27T00:00:00.000Z" });
  assert.equal(removeInstalledTool(home, "terraform", "1.16.4"), "removed");
  assert.equal(installState(home, "terraform", "1.15.0", "terraform"), "INSTALLED", "the other version keeps its marker");
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

// --- completion states, interruption and the sweep ---------------------------------------------------------------

const PINNED_OLLAMA = "0.40.0";
const toolDir = (home: string) => join(home, ".alz", "tools", "ollama");
const marker = (sha256 = "d".repeat(64)) => ({ tool: "ollama" as const, version: PINNED_OLLAMA, binary: "ollama", sha256, completedAt: "2026-10-27T00:00:00.000Z" });
const DEAD = () => false;
const ALIVE = () => true;
const appInstallStatesOf = (home: string) => appInstallStates(home, "ollama", "ollama");

test("a marker without the program, or the program without a marker, is never an install: unfinished and legacy are told apart", () => {
  const home = join(root, "home-states");
  const folder = join(toolDir(home), PINNED_OLLAMA);
  mkdirSync(folder, { recursive: true });
  writeInstallMarker(folder, marker());
  assert.equal(installState(home, "ollama", PINNED_OLLAMA, "ollama"), "UNFINISHED", "a marker alone is an unfinished folder");
  rmSync(join(folder, INSTALL_MARKER));
  writeFileSync(join(folder, "ollama"), "#!/bin/sh\necho 'ollama version is 0.40.0'\n");
  assert.equal(installState(home, "ollama", PINNED_OLLAMA, "ollama"), "LEGACY", "the program alone was installed before completion checks");
  // A marker that names another tool, version, program or checksum shape is not this install's marker.
  for (const wrong of [{ tool: "terraform" }, { version: "0.39.0" }, { binary: "bin/ollama" }, { sha256: "short" }, { completedAt: "yesterday" }]) {
    writeFileSync(join(folder, INSTALL_MARKER), JSON.stringify({ schemaVersion: 1, ...marker(), ...wrong }));
    assert.equal(installState(home, "ollama", PINNED_OLLAMA, "ollama"), "UNFINISHED", JSON.stringify(wrong));
  }
  writeFileSync(join(folder, INSTALL_MARKER), "not json");
  assert.equal(installState(home, "ollama", PINNED_OLLAMA, "ollama"), "UNFINISHED");
  assert.equal(installState(home, "ollama", "0.39.0", "ollama"), "ABSENT");
});

test("a copy from before completion checks is repaired beside itself and replaced only after the new copy passes its check", async () => {
  const home = join(root, "home-legacy");
  const folder = join(toolDir(home), PINNED_OLLAMA);
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, "ollama"), "#!/bin/sh\necho 'ollama version is 0.40.0 legacy'\n");
  chmodSync(join(folder, "ollama"), 0o755);
  writeFileSync(join(folder, "keepsake"), "from the legacy install");
  // A repair whose new copy reports the wrong version leaves the legacy copy exactly as it was.
  const wrong = (() => {
    const dir = join(root, "src-wrong-version");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "ollama"), "#!/bin/sh\necho 'ollama version is 0.39.9'\n");
    const file = join(root, "wrong-version.tgz");
    execFileSync("tar", ["-czf", file, "-C", dir, "ollama"]);
    return { file, sha256: createHash("sha256").update(readFileSync(file)).digest("hex") };
  })();
  await assert.rejects(
    installTool("ollama", { pins: pinsWith(wrong.sha256), home, platform: "darwin-arm64", download: fetchFrom(wrong.file) }),
    (error: unknown) => error instanceof InstallError && error.code === "INSTALL_VERIFY_FAILED",
  );
  assert.equal(installState(home, "ollama", PINNED_OLLAMA, "ollama"), "LEGACY", "the legacy copy is untouched after a failed repair");
  assert.equal(readFileSync(join(folder, "keepsake"), "utf8"), "from the legacy install");
  assert.deepEqual(readdirSync(toolDir(home)), [PINNED_OLLAMA], "no partial or replaced folder is left");
  // A repair whose new copy passes replaces it, and says what it replaced.
  const good = archive("legacy-repair");
  const installed = await installTool("ollama", { pins: pinsWith(good.sha256), home, platform: "darwin-arm64", download: fetchFrom(good.file) });
  assert.equal(installed.reused, false);
  assert.equal(installed.replaced, "LEGACY");
  assert.equal(installState(home, "ollama", PINNED_OLLAMA, "ollama"), "INSTALLED");
  assert.match(readFileSync(installed.path, "utf8"), /legacy-repair/, "the new copy is in place");
  assert.ok(!existsSync(join(folder, "keepsake")), "the replaced folder is gone");
  assert.deepEqual(readdirSync(toolDir(home)), [PINNED_OLLAMA]);
});

test("a download stopped by a signal installs nothing, leaves no download or partial folder, and the rerun starts over", async () => {
  const home = join(root, "home-stopped");
  const good = archive("stopped");
  const stop = new AbortController();
  const stalled = async (_url: string, signal: AbortSignal) => Readable.from((async function* () {
    yield readFileSync(good.file).subarray(0, 10);
    stop.abort();
    if (!signal.aborted) await new Promise<void>((done) => { signal.addEventListener("abort", () => done(), { once: true }); });
  })());
  await assert.rejects(
    installTool("ollama", { pins: pinsWith(good.sha256), home, platform: "darwin-arm64", download: stalled, signal: stop.signal }),
    (error: unknown) => error instanceof InstallError && error.code === "INSTALL_INTERRUPTED" && /nothing was installed/.test(error.message),
  );
  assert.equal(installState(home, "ollama", PINNED_OLLAMA, "ollama"), "ABSENT");
  assert.deepEqual(readdirSync(toolDir(home)), []);
  assert.deepEqual(readdirSync(join(home, ".alz", "tmp")), [], "the unfinished download is removed");
  // A signal that arrives before the download starts is honored too, and an already-stopped signal never downloads.
  let fetches = 0;
  await assert.rejects(
    installTool("ollama", { pins: pinsWith(good.sha256), home, platform: "darwin-arm64", download: async () => { fetches += 1; return Readable.from([]); }, signal: stop.signal }),
    (error: unknown) => error instanceof InstallError && error.code === "INSTALL_INTERRUPTED",
  );
  assert.equal(fetches, 0);
  const rerun = await installTool("ollama", { pins: pinsWith(good.sha256), home, platform: "darwin-arm64", download: fetchFrom(good.file) });
  assert.equal(rerun.reused, false, "the rerun installs from the start");
  assert.equal(installState(home, "ollama", PINNED_OLLAMA, "ollama"), "INSTALLED");
});

test("leftovers of a dead process (a partial folder, a download, a removal in progress) are swept and reported; a live pid is left alone", async () => {
  const home = join(root, "home-sweep");
  const dir = toolDir(home);
  const tmp = join(home, ".alz", "tmp");
  mkdirSync(join(dir, PINNED_OLLAMA), { recursive: true });
  writeFileSync(join(dir, PINNED_OLLAMA, "ollama"), "the final folder, whatever its state, is never a target");
  mkdirSync(join(dir, PINNED_OLLAMA + ".partial-1111"), { recursive: true });
  writeFileSync(join(dir, PINNED_OLLAMA + ".partial-1111", "ollama"), "half unpacked");
  mkdirSync(join(dir, PINNED_OLLAMA + ".replaced-1111"), { recursive: true });
  mkdirSync(join(dir, PINNED_OLLAMA + ".removing-1111"), { recursive: true });
  mkdirSync(join(dir, PINNED_OLLAMA + ".partial-2222"), { recursive: true });
  mkdirSync(join(dir, "0.39.0"), { recursive: true });
  writeFileSync(join(dir, "0.39.0", "ollama"), "an earlier version, never a sweep target");
  writeFileSync(join(dir, "notes.txt"), "a person's file, never a sweep target");
  mkdirSync(tmp, { recursive: true });
  writeFileSync(join(tmp, "ollama-0.40.0-1111.tgz"), "half a download");
  writeFileSync(join(tmp, "ollama-0.40.0-1111.tar.zst.tar"), "half unpacked");
  writeFileSync(join(tmp, "ollama-0.40.0-2222.tgz"), "another run's download");
  writeFileSync(join(tmp, "terraform-1.16.4-1111.zip"), "another tool's download");
  writeFileSync(join(tmp, "unrelated-1111.txt"), "never a sweep target");
  const swept = sweepLeftovers(home, "ollama", { pidAlive: (pid) => pid === 2222 });
  assert.deepEqual(swept.recovered, [], "the final folder is there, so nothing is an interrupted swap");
  assert.deepEqual(swept.removed.map((path) => path.slice(home.length)).sort(), [
    "/.alz/tmp/ollama-0.40.0-1111.tar.zst.tar", "/.alz/tmp/ollama-0.40.0-1111.tgz",
    "/.alz/tools/ollama/0.40.0.partial-1111", "/.alz/tools/ollama/0.40.0.removing-1111", "/.alz/tools/ollama/0.40.0.replaced-1111",
  ]);
  assert.deepEqual(readdirSync(dir).sort(), ["0.39.0", PINNED_OLLAMA, "0.40.0.partial-2222", "notes.txt"]);
  assert.deepEqual(readdirSync(tmp).sort(), ["ollama-0.40.0-2222.tgz", "terraform-1.16.4-1111.zip", "unrelated-1111.txt"]);
  // The install itself sweeps first and reports what it removed.
  rmSync(join(dir, PINNED_OLLAMA), { recursive: true });
  const good = archive("sweep-install");
  mkdirSync(join(dir, PINNED_OLLAMA + ".partial-3333"), { recursive: true });
  const installed = await installTool("ollama", { pins: pinsWith(good.sha256), home, platform: "darwin-arm64", download: fetchFrom(good.file), pidAlive: (pid) => pid === 2222 });
  assert.deepEqual(installed.swept.map((path) => path.slice(home.length)), ["/.alz/tools/ollama/0.40.0.partial-3333"]);
  assert.deepEqual(installed.recovered, []);
  assert.equal(installState(home, "ollama", PINNED_OLLAMA, "ollama"), "INSTALLED");
  assert.ok(existsSync(join(dir, PINNED_OLLAMA + ".partial-2222")), "a folder whose pid is alive is left alone by the install too");
  // The kernel decides by default: this process is alive, and a pid the kernel does not know is dead.
  assert.equal(pidProvenDead(process.pid), false);
  assert.equal(pidProvenDead(0), false);
  assert.equal(pidProvenDead(-1), false);
  assert.equal(pidProvenDead(2 ** 22 + 1), true, "a pid above the kernel's range is proven dead");
  const own = join(dir, PINNED_OLLAMA + ".partial-" + process.pid);
  mkdirSync(own, { recursive: true });
  assert.ok(!sweepLeftovers(home, "ollama").removed.includes(own), "this run's own folder is never swept");
  assert.ok(!sweepLeftovers(home, "ollama", { pidAlive: () => false }).removed.includes(own), "not even when the injected check calls every pid dead");
  assert.ok(existsSync(own));
});

/** What a crash leaves at each point of the swap, planted under a dead pid, with the final folder absent. */
function plantSwap(label: string, partialKind: "complete" | "incomplete" | "none"): { home: string; dir: string; final: string } {
  const home = join(root, "home-swap-" + label);
  const dir = toolDir(home);
  mkdirSync(join(dir, PINNED_OLLAMA + ".replaced-1111"), { recursive: true });
  writeFileSync(join(dir, PINNED_OLLAMA + ".replaced-1111", "ollama"), "the earlier copy");
  if (partialKind !== "none") {
    mkdirSync(join(dir, PINNED_OLLAMA + ".partial-1111"), { recursive: true });
    writeFileSync(join(dir, PINNED_OLLAMA + ".partial-1111", "ollama"), "the checked new copy");
    if (partialKind === "complete") writeInstallMarker(join(dir, PINNED_OLLAMA + ".partial-1111"), marker());
  }
  return { home, dir, final: join(dir, PINNED_OLLAMA) };
}

test("a crash between the two renames of a swap is rolled forward when the new copy is complete, and rolled back otherwise: a copy is never lost", () => {
  const forward = plantSwap("forward", "complete");
  let swept = sweepLeftovers(forward.home, "ollama", { pidAlive: DEAD });
  assert.deepEqual(swept.recovered, ["put the checked ollama 0.40.0 copy of an interrupted run (pid 1111) in place"]);
  assert.equal(readFileSync(join(forward.final, "ollama"), "utf8"), "the checked new copy");
  assert.equal(installState(forward.home, "ollama", PINNED_OLLAMA, "ollama"), "INSTALLED");
  assert.deepEqual(swept.removed.map((path) => path.slice(forward.home.length)), ["/.alz/tools/ollama/0.40.0.replaced-1111"]);
  assert.deepEqual(readdirSync(forward.dir), [PINNED_OLLAMA]);

  const back = plantSwap("back", "incomplete");
  swept = sweepLeftovers(back.home, "ollama", { pidAlive: DEAD });
  assert.deepEqual(swept.recovered, ["put the earlier ollama 0.40.0 copy back after an interrupted run (pid 1111)"]);
  assert.equal(readFileSync(join(back.final, "ollama"), "utf8"), "the earlier copy");
  assert.equal(installState(back.home, "ollama", PINNED_OLLAMA, "ollama"), "LEGACY", "the earlier copy comes back exactly as it was");
  assert.deepEqual(swept.removed.map((path) => path.slice(back.home.length)), ["/.alz/tools/ollama/0.40.0.partial-1111"]);
  assert.deepEqual(readdirSync(back.dir), [PINNED_OLLAMA]);

  const only = plantSwap("only", "none");
  swept = sweepLeftovers(only.home, "ollama", { pidAlive: DEAD });
  assert.equal(swept.recovered.length, 1);
  assert.equal(readFileSync(join(only.final, "ollama"), "utf8"), "the earlier copy");
  assert.deepEqual(swept.removed, []);

  // A live pid: the swap may still be running, so nothing is touched, and the copy aside is never removed while the final folder is absent.
  const live = plantSwap("live", "complete");
  swept = sweepLeftovers(live.home, "ollama", { pidAlive: ALIVE });
  assert.deepEqual(swept, { removed: [], recovered: [], refused: [] });
  assert.deepEqual(readdirSync(live.dir).sort(), [PINNED_OLLAMA + ".partial-1111", PINNED_OLLAMA + ".replaced-1111"]);
  // A dead pid's copy aside with the final folder present is a finished swap's leftover, removed as before.
  mkdirSync(join(live.dir, PINNED_OLLAMA), { recursive: true });
  swept = sweepLeftovers(live.home, "ollama", { pidAlive: DEAD });
  assert.deepEqual(swept.recovered, []);
  assert.equal(swept.removed.length, 2);
  assert.deepEqual(readdirSync(live.dir), [PINNED_OLLAMA]);
});

test("when the second rename of a swap fails, the earlier copy goes straight back and nothing is left beside it", async () => {
  const home = join(root, "home-swap-fail");
  const folder = join(toolDir(home), PINNED_OLLAMA);
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, "ollama"), "#!/bin/sh\necho 'ollama version is 0.40.0 legacy'\n");
  const bytes = readFileSync(join(folder, "ollama"));
  const good = archive("swap-fail");
  await assert.rejects(
    installTool("ollama", { pins: pinsWith(good.sha256), home, platform: "darwin-arm64", download: fetchFrom(good.file), betweenRenames: () => { throw new Error("disk gone"); } }),
    (error: unknown) => error instanceof InstallError && error.code === "INSTALL_SWAP_FAILED",
  );
  assert.equal(installState(home, "ollama", PINNED_OLLAMA, "ollama"), "LEGACY");
  assert.deepEqual(readFileSync(join(folder, "ollama")), bytes, "the earlier copy is byte-identical");
  assert.deepEqual(readdirSync(toolDir(home)), [PINNED_OLLAMA], "no partial or replaced folder is left");
});

test("a removal killed partway never reads as a copy to keep: the folder is renamed aside first, and the leftover is swept", () => {
  const home = join(root, "home-remove-aside");
  const dir = toolDir(home);
  const folder = join(dir, PINNED_OLLAMA);
  mkdirSync(join(folder, "lib"), { recursive: true });
  writeFileSync(join(folder, "ollama"), "program");
  writeFileSync(join(folder, "lib", "libggml.so"), "library");
  writeInstallMarker(folder, marker());
  assert.equal(removeInstalledTool(home, "ollama", PINNED_OLLAMA), "removed");
  assert.deepEqual(readdirSync(dir), [], "a finished removal leaves nothing");
  // Killed after the rename aside: the final folder is absent (never LEGACY), and the next sweep removes the rest.
  mkdirSync(join(dir, PINNED_OLLAMA + ".removing-1111", "lib"), { recursive: true });
  writeFileSync(join(dir, PINNED_OLLAMA + ".removing-1111", "ollama"), "program");
  assert.equal(installState(home, "ollama", PINNED_OLLAMA, "ollama"), "ABSENT");
  assert.deepEqual(appInstallStatesOf(home), []);
  assert.equal(removeInstalledTool(home, "ollama", PINNED_OLLAMA), "absent", "a repeat removal has nothing left to do");
  assert.deepEqual(sweepLeftovers(home, "ollama", { pidAlive: DEAD }).removed.map((path) => path.slice(home.length)), ["/.alz/tools/ollama/0.40.0.removing-1111"]);
  assert.deepEqual(readdirSync(dir), []);
});

test("a stop during the unpack is reported as a stop, not as a broken archive: zstd honors the signal, and a tar ended by the signal is classified after the handler runs", async () => {
  // zstd: the decompression stream is aborted while it runs.
  const source = join(root, "src-zst-stop");
  mkdirSync(source, { recursive: true });
  writeFileSync(join(source, "ollama"), "#!/bin/sh\necho 'ollama version is 0.40.0'\n" + "x".repeat(200_000));
  const tarFile = join(root, "zst-stop.tar");
  execFileSync("tar", ["-cf", tarFile, "-C", source, "ollama"]);
  const file = join(root, "zst-stop.tar.zst");
  await pipeline(createReadStream(tarFile), createZstdCompress(), createWriteStream(file));
  const sha256 = createHash("sha256").update(readFileSync(file)).digest("hex");
  const pins = loadToolPins();
  pins.tools.ollama.artifacts["darwin-arm64"] = { url: "https://github.com/ollama/ollama/releases/download/v0.40.0/zst-stop.tar.zst", sha256, archive: "tar.zst", binary: "ollama" };
  const home = join(root, "home-zst-stop");
  const stop = new AbortController();
  // The download completes; the stop arrives right after, while the unpack is next.
  const download = async () => { setImmediate(() => stop.abort()); return Readable.from([readFileSync(file)]); };
  await assert.rejects(
    installTool("ollama", { pins, home, platform: "darwin-arm64", download, signal: stop.signal }),
    (error: unknown) => error instanceof InstallError && error.code === "INSTALL_INTERRUPTED",
  );
  assert.deepEqual(readdirSync(toolDir(home)), []);
  assert.deepEqual(readdirSync(join(home, ".alz", "tmp")), []);
  // tar: a fake tar on PATH ends the way a Ctrl-C at the terminal ends the real one (the signal reaches the whole group), and
  // the install's stop handler, here the test's own listener, then aborts.
  const bin = join(root, "bin-fake-tar");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "tar"), "#!/bin/sh\nkill -INT $PPID\nexit 130\n");
  chmodSync(join(bin, "tar"), 0o755);
  const good = archive("tar-stop");
  const second = new AbortController();
  const onSignal = () => { second.abort(); };
  process.on("SIGINT", onSignal);
  const path = process.env.PATH;
  process.env.PATH = bin + ":" + path;
  try {
    await assert.rejects(
      installTool("ollama", { pins: pinsWith(good.sha256), home: join(root, "home-tar-stop"), platform: "darwin-arm64", download: fetchFrom(good.file), signal: second.signal }),
      (error: unknown) => error instanceof InstallError && error.code === "INSTALL_INTERRUPTED",
    );
  } finally {
    process.env.PATH = path;
    process.off("SIGINT", onSignal);
  }
  assert.deepEqual(readdirSync(toolDir(join(root, "home-tar-stop"))), []);
  // The same fake tar with no stop requested is a broken unpack, as before.
  process.env.PATH = bin + ":" + path;
  const plain = new AbortController();
  const ignore = () => undefined;
  process.on("SIGINT", ignore);
  try {
    await assert.rejects(
      installTool("ollama", { pins: pinsWith(good.sha256), home: join(root, "home-tar-broken"), platform: "darwin-arm64", download: fetchFrom(good.file), signal: plain.signal }),
      (error: unknown) => error instanceof InstallError && error.code === "INSTALL_UNPACK_FAILED",
    );
  } finally {
    process.env.PATH = path;
    process.off("SIGINT", ignore);
  }
});

test("the sweep never follows a link, never reads outside ~/.alz/tools and ~/.alz/tmp, and never removes a final version folder", () => {
  const home = join(root, "home-sweep-links");
  const dir = toolDir(home);
  const tmp = join(home, ".alz", "tmp");
  mkdirSync(dir, { recursive: true });
  mkdirSync(tmp, { recursive: true });
  const outside = join(root, "sweep-outside");
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(outside, "keep"), "not ours");
  symlinkSync(outside, join(dir, PINNED_OLLAMA + ".partial-1111"));
  symlinkSync(join(outside, "keep"), join(tmp, "ollama-0.40.0-1111.tgz"));
  mkdirSync(join(dir, PINNED_OLLAMA), { recursive: true });
  writeFileSync(join(dir, PINNED_OLLAMA, "ollama"), "a final version folder, whatever its state");
  assert.deepEqual(sweepLeftovers(home, "ollama", { pidAlive: DEAD }), { removed: [], recovered: [], refused: [] });
  assert.ok(existsSync(join(outside, "keep")), "the link target is untouched");
  assert.ok(existsSync(join(dir, PINNED_OLLAMA, "ollama")));
  // A linked tools folder, or a linked tool folder, is skipped as a whole.
  const linkedHome = join(root, "home-sweep-linked-tools");
  mkdirSync(join(linkedHome, ".alz"), { recursive: true });
  const elsewhere = join(root, "sweep-elsewhere");
  mkdirSync(join(elsewhere, "ollama", PINNED_OLLAMA + ".partial-1111"), { recursive: true });
  writeFileSync(join(elsewhere, "ollama", PINNED_OLLAMA + ".partial-1111", "keep"), "not ours");
  symlinkSync(elsewhere, join(linkedHome, ".alz", "tools"));
  symlinkSync(elsewhere, join(linkedHome, ".alz", "tmp"));
  assert.deepEqual(sweepLeftovers(linkedHome, "ollama", { pidAlive: DEAD }), { removed: [], recovered: [], refused: [] });
  assert.ok(existsSync(join(elsewhere, "ollama", PINNED_OLLAMA + ".partial-1111", "keep")));
  assert.deepEqual(sweepLeftovers(join(root, "no-such-home"), "ollama", { pidAlive: DEAD }), { removed: [], recovered: [], refused: [] }, "a missing home sweeps nothing");
});

test("an interrupted removal reads as unfinished, never as installed, and repeating the removal completes it", () => {
  const home = join(root, "home-half-removed");
  const folder = join(toolDir(home), PINNED_OLLAMA);
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, "ollama"), "#!/bin/sh\necho 'ollama version is 0.40.0'\n");
  writeInstallMarker(folder, marker());
  assert.equal(installState(home, "ollama", PINNED_OLLAMA, "ollama"), "INSTALLED");
  // What an interrupted removal leaves: its marker written first, the completion marker gone, the program still there.
  writeFileSync(join(folder, REMOVING_MARKER), "2026-10-27T00:00:00.000Z\n");
  rmSync(join(folder, INSTALL_MARKER));
  assert.equal(installState(home, "ollama", PINNED_OLLAMA, "ollama"), "REMOVING");
  // Even with the completion marker still there, the removal marker wins: the removal had started.
  writeInstallMarker(folder, marker());
  assert.equal(installState(home, "ollama", PINNED_OLLAMA, "ollama"), "REMOVING");
  assert.equal(removeInstalledTool(home, "ollama", PINNED_OLLAMA), "removed");
  assert.ok(!existsSync(folder));
  assert.deepEqual(readdirSync(toolDir(home)), [], "nothing is left aside after a finished removal");
  assert.equal(removeInstalledTool(home, "ollama", PINNED_OLLAMA), "absent");
  // A folder with the program and nothing else (the old half-removed shape) is replaced by an install, never reused.
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, "libggml.so"), "library only");
  assert.equal(installState(home, "ollama", PINNED_OLLAMA, "ollama"), "UNFINISHED");
});

test("an update installs beside the earlier version, which keeps its own marker and files", async () => {
  const home = join(root, "home-beside");
  const old = join(toolDir(home), "0.39.0");
  mkdirSync(old, { recursive: true });
  writeFileSync(join(old, "ollama"), "earlier version");
  writeInstallMarker(old, { ...marker(), version: "0.39.0" });
  const good = archive("beside");
  const installed = await installTool("ollama", { pins: pinsWith(good.sha256), home, platform: "darwin-arm64", download: fetchFrom(good.file) });
  assert.equal(installed.replaced, undefined, "nothing stood at the pinned version's folder");
  assert.deepEqual(readdirSync(toolDir(home)).sort(), ["0.39.0", PINNED_OLLAMA]);
  assert.equal(readFileSync(join(old, "ollama"), "utf8"), "earlier version");
  assert.equal(installState(home, "ollama", "0.39.0", "ollama"), "INSTALLED");
  assert.equal(installState(home, "ollama", PINNED_OLLAMA, "ollama"), "INSTALLED");
});

test("the recovery checks: a marker-only partial copy rolls back, a complete partial copy of another pid is never adopted, and a copy aside behind a link at the final path is kept", () => {
  // A partial copy with the marker but without the program it names is not complete: the earlier copy comes back.
  const markerOnly = plantSwap("marker-only", "incomplete");
  writeInstallMarker(join(markerOnly.dir, PINNED_OLLAMA + ".partial-1111"), marker());
  rmSync(join(markerOnly.dir, PINNED_OLLAMA + ".partial-1111", "ollama"));
  let swept = sweepLeftovers(markerOnly.home, "ollama", { pidAlive: DEAD });
  assert.deepEqual(swept.recovered, ["put the earlier ollama 0.40.0 copy back after an interrupted run (pid 1111)"]);
  assert.equal(readFileSync(join(markerOnly.final, "ollama"), "utf8"), "the earlier copy");
  assert.deepEqual(readdirSync(markerOnly.dir), [PINNED_OLLAMA]);
  // A complete partial copy left by another run (another pid) is not this swap's new copy: the earlier copy comes back, and
  // that partial copy is removed as the dead leftover it is.
  const otherPid = plantSwap("other-pid", "none");
  mkdirSync(join(otherPid.dir, PINNED_OLLAMA + ".partial-2222"), { recursive: true });
  writeFileSync(join(otherPid.dir, PINNED_OLLAMA + ".partial-2222", "ollama"), "another run's checked copy");
  writeInstallMarker(join(otherPid.dir, PINNED_OLLAMA + ".partial-2222"), marker());
  swept = sweepLeftovers(otherPid.home, "ollama", { pidAlive: DEAD });
  assert.deepEqual(swept.recovered, ["put the earlier ollama 0.40.0 copy back after an interrupted run (pid 1111)"]);
  assert.equal(readFileSync(join(otherPid.final, "ollama"), "utf8"), "the earlier copy", "never adopted from another pid");
  assert.deepEqual(swept.removed.map((path) => path.slice(otherPid.home.length)), ["/.alz/tools/ollama/0.40.0.partial-2222"]);
  // A dangling link (or any non-folder) at the final path: nothing is renamed over it, the copy aside is kept, and the sweep
  // says so in plain words instead of throwing.
  const linked = plantSwap("linked-final", "complete");
  symlinkSync(join(root, "nowhere-" + Date.now()), linked.final);
  swept = sweepLeftovers(linked.home, "ollama", { pidAlive: DEAD });
  assert.deepEqual(swept.recovered, []);
  assert.deepEqual(swept.removed.map((path) => path.slice(linked.home.length)), ["/.alz/tools/ollama/0.40.0.partial-1111"], "only the partial copy goes; the copy aside stays");
  assert.equal(swept.refused.length, 1);
  assert.match(swept.refused[0]!, /something that is not a folder \(a link or a file\) stands at .*0\.40\.0, so the earlier ollama 0\.40\.0 copy beside it was left alone; remove it by hand/);
  assert.ok(existsSync(join(linked.dir, PINNED_OLLAMA + ".replaced-1111", "ollama")), "the earlier copy is still aside");
  assert.ok(lstatSync(linked.final).isSymbolicLink(), "the link is untouched");
  // A regular file at the final path is treated the same way.
  const filed = plantSwap("file-final", "none");
  writeFileSync(filed.final, "a file where the folder belongs");
  swept = sweepLeftovers(filed.home, "ollama", { pidAlive: DEAD });
  assert.equal(swept.refused.length, 1);
  assert.ok(existsSync(join(filed.dir, PINNED_OLLAMA + ".replaced-1111", "ollama")));
  assert.equal(readFileSync(filed.final, "utf8"), "a file where the folder belongs");
});

test("one install of a tool at a time: a second run finds the lock and changes nothing, a dead run's lock is replaced, and the lock is released in every outcome", async () => {
  const home = join(root, "home-lock");
  const good = archive("lock");
  const tmp = join(home, ".alz", "tmp");
  mkdirSync(tmp, { recursive: true });
  const lock = join(tmp, "ollama.install.lock");
  // Another run's lock, whose pid may be alive: this run stops before any download, and the lock is left as it was.
  writeFileSync(lock, JSON.stringify({ pid: 4242, startedAt: "2026-10-27T00:00:00.000Z" }) + "\n");
  let fetches = 0;
  await assert.rejects(
    installTool("ollama", { pins: pinsWith(good.sha256), home, platform: "darwin-arm64", download: async () => { fetches += 1; return Readable.from([]); }, pidAlive: (pid) => pid === 4242 }),
    (error: unknown) => error instanceof InstallError && error.code === "INSTALL_IN_PROGRESS" &&
      /^Another \.\/alz deps run \(pid 4242\) is installing or removing ollama right now, so this run changed nothing\. Wait for it to finish, then run \.\/alz deps again\. If no other \.\/alz deps run is open in any window, the run that took the lock has ended and its process number now belongs to another program: delete \S+\/\.alz\/tmp\/ollama\.install\.lock, then run \.\/alz deps again\.$/.test(error.message),
  );
  assert.equal(fetches, 0);
  assert.equal(readFileSync(lock, "utf8").trim(), JSON.stringify({ pid: 4242, startedAt: "2026-10-27T00:00:00.000Z" }), "the other run's lock is untouched");
  assert.ok(!existsSync(join(home, ".alz", "tools", "ollama")), "nothing was swept or installed under the lock: the tool folder was never created");
  // An unreadable lock (torn, or empty: a run stopped between creating it and writing its pid) is somebody's too. It never
  // clears by itself, so the message names the lock and says how to clear it safely instead of "wait".
  for (const content of ["not json", "", '{"pid": 12']) {
    writeFileSync(lock, content);
    await assert.rejects(installTool("ollama", { pins: pinsWith(good.sha256), home, platform: "darwin-arm64", download: fetchFrom(good.file), pidAlive: DEAD }),
      (error: unknown) => error instanceof InstallError && error.code === "INSTALL_IN_PROGRESS" &&
        /^The ollama install lock \S+\/\.alz\/tmp\/ollama\.install\.lock is empty or unreadable, so this run changed nothing\..* If no other \.\/alz deps run is open in any window, delete \S+ollama\.install\.lock, then run \.\/alz deps again\.$/.test(error.message));
    assert.equal(readFileSync(lock, "utf8"), content, JSON.stringify(content) + ": the lock is never removed");
  }
  // A dead run's lock is stale: it is replaced and the install goes ahead; afterwards the lock is gone.
  writeFileSync(lock, JSON.stringify({ pid: 4242, startedAt: "2026-10-27T00:00:00.000Z" }) + "\n");
  const installed = await installTool("ollama", { pins: pinsWith(good.sha256), home, platform: "darwin-arm64", download: fetchFrom(good.file), pidAlive: DEAD });
  assert.equal(installed.reused, false);
  assert.ok(!existsSync(lock), "the lock is released after a finished install");
  assert.deepEqual(readdirSync(tmp), [], "no download and no lock are left");
  // Released after a failure too, and never released for another run: a lock this run does not own stays.
  await assert.rejects(installTool("ollama", { pins: pinsWith("0".repeat(64)), home: join(root, "home-lock-fail"), platform: "darwin-arm64", download: fetchFrom(good.file) }),
    (error: unknown) => error instanceof InstallError && error.code === "INSTALL_CHECKSUM_MISMATCH");
  assert.ok(!existsSync(join(root, "home-lock-fail", ".alz", "tmp", "ollama.install.lock")), "the lock is released after a failed install");
  // While this process holds the lock (its own pid), a second call in the same process is refused: the pid is alive.
  writeFileSync(lock, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }) + "\n");
  await assert.rejects(installTool("ollama", { pins: pinsWith(good.sha256), home, platform: "darwin-arm64", download: fetchFrom(good.file) }),
    (error: unknown) => error instanceof InstallError && error.code === "INSTALL_IN_PROGRESS");
  rmSync(lock);
});

test("a stop that arrives before the unpack never reaches the archive: with zstd the decompression stream itself is stopped, so tar is never run", async () => {
  const source = join(root, "src-zst-abort");
  mkdirSync(source, { recursive: true });
  writeFileSync(join(source, "ollama"), "#!/bin/sh\necho 'ollama version is 0.40.0'\n");
  const tarFile = join(root, "zst-abort.tar");
  execFileSync("tar", ["-cf", tarFile, "-C", source, "ollama"]);
  const file = join(root, "zst-abort.tar.zst");
  await pipeline(createReadStream(tarFile), createZstdCompress(), createWriteStream(file));
  const sha256 = createHash("sha256").update(readFileSync(file)).digest("hex");
  const pins = loadToolPins();
  pins.tools.ollama.artifacts["darwin-arm64"] = { url: "https://github.com/ollama/ollama/releases/download/v0.40.0/zst-abort.tar.zst", sha256, archive: "tar.zst", binary: "ollama" };
  // A fake tar on PATH that records every call: with the signal honored by the zstd pipeline, the stop ends the decompression
  // before the plain tar exists, so tar never runs. Without it, the decompression would finish and tar would be called.
  const bin = join(root, "bin-recording-tar");
  mkdirSync(bin, { recursive: true });
  const calls = join(root, "tar-calls.log");
  writeFileSync(join(bin, "tar"), "#!/bin/sh\necho \"$*\" >> " + JSON.stringify(calls) + "\nexit 0\n");
  chmodSync(join(bin, "tar"), 0o755);
  const stop = new AbortController();
  const path = process.env.PATH;
  process.env.PATH = bin + ":" + path;
  try {
    await assert.rejects(
      installTool("ollama", { pins, home: join(root, "home-zst-abort"), platform: "darwin-arm64", download: fetchFrom(file), signal: stop.signal, onUnpackStart: () => { stop.abort(); } }),
      (error: unknown) => error instanceof InstallError && error.code === "INSTALL_INTERRUPTED",
    );
  } finally {
    process.env.PATH = path;
  }
  assert.ok(!existsSync(calls), "tar was never run: the stopped decompression produced nothing to extract");
  assert.deepEqual(readdirSync(join(root, "home-zst-abort", ".alz", "tools", "ollama")), []);
  assert.deepEqual(readdirSync(join(root, "home-zst-abort", ".alz", "tmp")), [], "no download, no plain tar and no lock are left");
});

test("a removal that stops after the folder is renamed aside leaves the final path absent, never a copy to keep", () => {
  const home = join(root, "home-remove-hook");
  const folder = join(toolDir(home), PINNED_OLLAMA);
  mkdirSync(join(folder, "lib"), { recursive: true });
  writeFileSync(join(folder, "ollama"), "program");
  writeFileSync(join(folder, "lib", "libggml.so"), "library");
  writeInstallMarker(folder, marker());
  assert.throws(() => removeInstalledTool(home, "ollama", PINNED_OLLAMA, { afterRenameAside: () => { throw new Error("killed here"); } }), /killed here/);
  assert.equal(installState(home, "ollama", PINNED_OLLAMA, "ollama"), "ABSENT", "the final path is empty once the folder is aside");
  assert.deepEqual(readdirSync(toolDir(home)), [PINNED_OLLAMA + ".removing-" + process.pid], "the folder waits aside under this pid");
  assert.ok(existsSync(join(toolDir(home), PINNED_OLLAMA + ".removing-" + process.pid, "ollama")), "renamed, not deleted in place");
  assert.equal(removeInstalledTool(home, "ollama", PINNED_OLLAMA), "absent");
  // The folder aside carries this process's pid, which is alive, so no sweep (even one told every pid is dead) touches it; a
  // later run, once this pid is proven dead, removes it as the sweep test shows for pid 1111.
  assert.deepEqual(sweepLeftovers(home, "ollama", { pidAlive: DEAD }).removed, []);
  assert.deepEqual(readdirSync(toolDir(home)), [PINNED_OLLAMA + ".removing-" + process.pid]);
});

test("two reruns that both see the same dead pid's lock: exactly one takes it over, and the other never deletes the new lock", () => {
  const home = join(root, "home-takeover-race");
  const tmp = join(home, ".alz", "tmp");
  mkdirSync(tmp, { recursive: true });
  const lock = join(tmp, "ollama.install.lock");
  writeFileSync(lock, JSON.stringify({ pid: 99999, startedAt: "2026-10-27T00:00:00.000Z" }) + "\n");
  // Run B reads the dead pid; its pid check is the scheduling point at which run A takes the stale lock over completely.
  // Then B goes on with what it read. Without the takeover token and the re-read under it, B would delete A's new lock and
  // both would hold it.
  let releaseA: (() => void) | undefined;
  let lockOfA = "";
  const pausingB = (pid: number): boolean => {
    if (releaseA === undefined) {
      releaseA = acquireToolLock(home, "ollama", { pidAlive: (other) => other !== 99999 });
      lockOfA = readFileSync(lock, "utf8");
    }
    return pid !== 99999;
  };
  assert.throws(() => acquireToolLock(home, "ollama", { pidAlive: pausingB }),
    (error: unknown) => error instanceof InstallError && error.code === "INSTALL_IN_PROGRESS", "run B does not get the lock");
  assert.ok(releaseA, "run A took the stale lock over");
  assert.equal(readFileSync(lock, "utf8"), lockOfA, "run A's lock is exactly as A wrote it");
  assert.deepEqual(readdirSync(tmp), ["ollama.install.lock"], "no takeover token is left behind");
  releaseA!();
  assert.ok(!existsSync(lock));
  // A takeover token left by a run that died mid-takeover is named, so it can be cleared by hand instead of waited on forever.
  writeFileSync(lock, JSON.stringify({ pid: 99999 }) + "\n");
  writeFileSync(lock + ".takeover-99999", JSON.stringify({ pid: 88888 }) + "\n");
  assert.throws(() => acquireToolLock(home, "ollama", { pidAlive: DEAD }),
    (error: unknown) => error instanceof InstallError && error.code === "INSTALL_IN_PROGRESS" &&
      /^Another \.\/alz deps run is replacing a stale ollama install lock right now, so this run changed nothing\. Run \.\/alz deps again in a moment\. If no other \.\/alz deps run is open in any window, delete \S+ollama\.install\.lock\.takeover-99999, then run \.\/alz deps again\.$/.test((error as Error).message));
  assert.ok(existsSync(lock), "the stale lock is not removed without the token");
});

test("a removal takes the tool's lock: it waits for no one, changes nothing while another run holds it, and leaves no lock behind", async () => {
  const home = join(root, "home-remove-lock");
  const good = archive("remove-lock");
  await installTool("ollama", { pins: pinsWith(good.sha256), home, platform: "darwin-arm64", download: fetchFrom(good.file) });
  const lock = join(home, ".alz", "tmp", "ollama.install.lock");
  writeFileSync(lock, JSON.stringify({ pid: 4242 }) + "\n");
  assert.throws(() => removeInstalledTool(home, "ollama", "0.40.0", { pidAlive: (pid) => pid === 4242 }),
    (error: unknown) => error instanceof InstallError && error.code === "INSTALL_IN_PROGRESS");
  assert.equal(installState(home, "ollama", "0.40.0", "ollama"), "INSTALLED", "the copy another run may be reusing is untouched");
  rmSync(lock);
  // While the removal holds the lock, an install of the same tool is refused.
  let refused = false;
  assert.equal(removeInstalledTool(home, "ollama", "0.40.0", { afterRenameAside: () => {
    assert.throws(() => acquireToolLock(home, "ollama"), (error: unknown) => error instanceof InstallError && error.code === "INSTALL_IN_PROGRESS");
    refused = true;
  } }), "removed");
  assert.ok(refused);
  assert.ok(!existsSync(lock), "the removal released the lock");
  // Nothing of the app's there at all: "absent", and no ~/.alz is created for a lock.
  const empty = join(root, "home-remove-nothing");
  assert.equal(removeInstalledTool(empty, "ollama", "0.40.0"), "absent");
  assert.ok(!existsSync(join(empty, ".alz")));
});

test("the post-install check runs under the tool's lock: a new copy that fails it is removed before the lock is released, and a reused copy is never removed", async () => {
  const home = join(root, "home-verify-lock");
  const good = archive("verify-lock");
  const lock = join(home, ".alz", "tmp", "ollama.install.lock");
  let heldDuringCheck = false;
  const failed = await installTool("ollama", { pins: pinsWith(good.sha256), home, platform: "darwin-arm64", download: fetchFrom(good.file), verify: async () => {
    heldDuringCheck = (JSON.parse(readFileSync(lock, "utf8")) as { pid: number }).pid === process.pid;
    return false;
  } });
  assert.ok(heldDuringCheck, "the check runs while this run holds the lock");
  assert.equal(failed.verified, false);
  assert.equal(failed.reused, false);
  assert.equal(installState(home, "ollama", "0.40.0", "ollama"), "ABSENT", "the new copy that failed its check was removed under the lock");
  assert.ok(!existsSync(lock));
  const ok = await installTool("ollama", { pins: pinsWith(good.sha256), home, platform: "darwin-arm64", download: fetchFrom(good.file), verify: async () => true });
  assert.equal(ok.verified, true);
  const reused = await installTool("ollama", { pins: pinsWith(good.sha256), home, platform: "darwin-arm64", download: fetchFrom(good.file), verify: async () => false });
  assert.equal(reused.reused, true);
  assert.equal(reused.verified, false);
  assert.equal(installState(home, "ollama", "0.40.0", "ollama"), "INSTALLED", "a reused copy is never removed by the install");
});

test("a copy that vanishes from the final path during an install is reported as a failed swap, never as a failed download", async () => {
  const home = join(root, "home-swap-vanished");
  const good = archive("swap-vanished");
  const finalDir = join(home, ".alz", "tools", "ollama", "0.40.0");
  mkdirSync(finalDir, { recursive: true });
  writeFileSync(join(finalDir, "ollama"), "#!/bin/sh\necho 'ollama version is 0.40.0'\n");
  chmodSync(join(finalDir, "ollama"), 0o755);
  assert.equal(installState(home, "ollama", "0.40.0", "ollama"), "LEGACY");
  await assert.rejects(installTool("ollama", { pins: pinsWith(good.sha256), home, platform: "darwin-arm64", download: fetchFrom(good.file),
    onUnpackStart: () => { rmSync(finalDir, { recursive: true, force: true }); } }),
  (error: unknown) => error instanceof InstallError && error.code === "INSTALL_SWAP_FAILED" && /changed while this run was installing/.test((error as Error).message));
  assert.deepEqual(readdirSync(join(home, ".alz", "tools", "ollama")), [], "no partial copy is left");
});

test("the report's sweep takes the tool's lock, and creates nothing when there is nothing to sweep", () => {
  const home = join(root, "home-sweep-lock");
  assert.deepEqual(sweepToolLeftovers(home, "ollama", { pidAlive: DEAD }), { removed: [], recovered: [], refused: [] });
  assert.ok(!existsSync(join(home, ".alz")), "no folder is created for the lock");
  const toolDir = join(home, ".alz", "tools", "ollama");
  mkdirSync(join(toolDir, "0.40.0.partial-77777"), { recursive: true });
  const lock = join(home, ".alz", "tmp", "ollama.install.lock");
  mkdirSync(join(home, ".alz", "tmp"), { recursive: true });
  writeFileSync(lock, JSON.stringify({ pid: 4242 }) + "\n");
  assert.throws(() => sweepToolLeftovers(home, "ollama", { pidAlive: (pid) => pid === 4242 }),
    (error: unknown) => error instanceof InstallError && error.code === "INSTALL_IN_PROGRESS");
  assert.ok(existsSync(join(toolDir, "0.40.0.partial-77777")), "nothing is swept while another run holds the lock");
  rmSync(lock);
  assert.deepEqual(sweepToolLeftovers(home, "ollama", { pidAlive: (pid) => pid !== 77777 }).removed, [join(toolDir, "0.40.0.partial-77777")]);
  assert.ok(!existsSync(lock), "the sweep released the lock");
});
