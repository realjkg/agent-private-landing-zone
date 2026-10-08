import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createReleaseManifest, sha256Buffer, validateReleaseManifest } from "../src/release/manifest.js";
import { createSessionGraph } from "../src/session/graph.js";

const repositoryUrl = new URL("../src/build/repository.ts", import.meta.url).href;
const securityUrl = new URL("../src/cli/security.ts", import.meta.url);
const loader = import.meta.resolve("tsx");

async function artifact() {
  const root = await mkdtemp(join(tmpdir(), "alz-docker-runtime-"));
  await mkdir(join(root, "dist/cli"), { recursive: true });
  await mkdir(join(root, "config"));
  const contents: Record<string, string | Buffer> = {
    "package.json": '{"name":"agent-private-landing-zone","version":"0.1.0"}',
    "package-lock.json": '{"lockfileVersion":3}',
    "dist/cli/operator.js": "// preview only\n",
    "dist/binary.bin": Buffer.from([0xff, 0xfe, 0x00]),
    "config/security-baseline.md": "ACT DISABLED\n",
    "sbom.cdx.json": JSON.stringify({ bomFormat: "CycloneDX", specVersion: "1.5", version: 1, components: [] }),
  };
  for (const [path, data] of Object.entries(contents)) await writeFile(join(root, path), data);
  const manifest = createReleaseManifest({
    productVersion: "0.1.0", sourceCommit: "a".repeat(40),
    files: Object.entries(contents).map(([path, data]) => ({ path, sha256: sha256Buffer(data) })),
    sbomPath: "sbom.cdx.json", sbomSha256: sha256Buffer(contents["sbom.cdx.json"]),
  });
  const save = () => writeFile(join(root, "release-manifest.json"), JSON.stringify(manifest));
  await save();
  return { root, manifest, save };
}

function evidence(root: string) {
  const result = spawnSync(process.execPath, ["--import", loader, "--input-type=module", "--eval",
    `import { collectRepositoryEvidence } from ${JSON.stringify(repositoryUrl)}; console.log(JSON.stringify(collectRepositoryEvidence()));`],
  { cwd: root, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout) as { clean: boolean; commitSha: string };
}

test("Docker installed release attests without Git and hashes binary files exactly", async () => {
  const { root } = await artifact();
  try {
    assert.deepEqual(evidence(root).clean, true);
    assert.equal(evidence(root).commitSha, "a".repeat(40));
    const result = spawnSync(process.execPath, ["--import", loader, securityUrl.pathname], {
      cwd: root, encoding: "utf8",
      env: { ...process.env, AGENTIC_EVIDENCE_KEY: "", AGENTIC_EVIDENCE_KEY_FILE: join(root, "key/evidence.key") },
    });
    assert.equal(result.status, 0, result.stderr + result.stdout);
    assert.match(result.stdout, /SECURED SESSION READY/);
    assert.match(result.stdout, /no apply\/up\/destroy capability exposed/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

const mutations: Record<string, (a: Awaited<ReturnType<typeof artifact>>) => Promise<unknown>> = {
  "changed executable": a => writeFile(join(a.root, "dist/cli/operator.js"), "// tampered"),
  "changed policy configuration": a => writeFile(join(a.root, "config/security-baseline.md"), "ACT ENABLED"),
  "missing lockfile": a => rm(join(a.root, "package-lock.json")),
  "modified SBOM": a => writeFile(join(a.root, "sbom.cdx.json"), "{}"),
  "invalid SBOM with matching hashes": async a => {
    const data = '{}';
    await writeFile(join(a.root, "sbom.cdx.json"), data);
    a.manifest.sbom.sha256 = sha256Buffer(data);
    a.manifest.files.find(f => f.path === "sbom.cdx.json")!.sha256 = sha256Buffer(data);
    await a.save();
  },
  "package version inconsistent with provenance": async a => {
    const data = '{"name":"agent-private-landing-zone","version":"0.2.0"}';
    await writeFile(join(a.root, "package.json"), data);
    a.manifest.files.find(f => f.path === "package.json")!.sha256 = sha256Buffer(data);
    await a.save();
  },
  "unlisted executable": a => writeFile(join(a.root, "dist/extra.js"), "// injected"),
  "omitted executable entry": async a => {
    a.manifest.files = a.manifest.files.filter(f => f.path !== "dist/cli/operator.js"); await a.save();
  },
  "ACT enabled": async a => { (a.manifest.contract as { actEnabled: boolean }).actEnabled = true; await a.save(); },
  "wrong contract identity": async a => { a.manifest.contract.id = "other-contract"; await a.save(); },
  "wrong provenance": async a => { a.manifest.sourceCommit = "UNKNOWN"; await a.save(); },
  "empty inventory": async a => { a.manifest.files = []; await a.save(); },
  "duplicate inventory": async a => { a.manifest.files.push(a.manifest.files[0]); await a.save(); },
  "malformed manifest": a => writeFile(join(a.root, "release-manifest.json"), '{"sourceCommit":"' + "a".repeat(40) + '","files":[]}'),
  "invalid JSON": a => writeFile(join(a.root, "release-manifest.json"), "{"),
  "inconsistent SBOM hash": async a => { a.manifest.sbom.sha256 = "b".repeat(64); await a.save(); },
  "traversal path": async a => { a.manifest.files[0].path = "../package.json"; await a.save(); },
  "symbolic executable": async a => {
    await rm(join(a.root, "dist/cli/operator.js"));
    await writeFile(join(a.root, "outside.js"), "// preview only\n");
    await symlink(join(a.root, "outside.js"), join(a.root, "dist/cli/operator.js"));
  },
};
for (const [name, mutate] of Object.entries(mutations)) {
  test("Docker integrity refuses " + name, async () => {
    const a = await artifact();
    try {
      assert.equal(evidence(a.root).clean, true);
      await mutate(a);
      assert.equal(evidence(a.root).clean, false);
      const result = spawnSync(process.execPath, ["--import", loader, securityUrl.pathname], {
        cwd: a.root, encoding: "utf8",
        env: { ...process.env, AGENTIC_EVIDENCE_KEY: "", AGENTIC_EVIDENCE_KEY_FILE: join(a.root, "key/evidence.key") },
      });
      assert.equal(result.status, 1, result.stderr + result.stdout);
      assert.match(result.stdout, /SECURE SESSION REFUSED/);
    } finally { await rm(a.root, { recursive: true, force: true }); }
  });
}

test("malformed release JSON fails closed without throwing", () => {
  for (const value of [null, {}, { files: [] }]) {
    assert.ok(validateReleaseManifest(value as never).length > 0);
  }
});

test("unencrypted persistent conversation checkpoints are refused", () => {
  assert.throws(() => createSessionGraph("/tmp/alz-conversation.sqlite"), /UNENCRYPTED_PERSISTENT_CHECKPOINTS_DISABLED/);
});

test("Docker keeps production keys separate and drops mutation authority", async () => {
  const compose = await readFile(new URL("../compose.yaml", import.meta.url), "utf8");
  assert.match(compose, /AGENTIC_EVIDENCE_KEY_FILE: \/run\/alz-keys\/evidence.key/);
  assert.match(compose, /alz-evidence-keys:\/run\/alz-keys/);
  assert.match(compose, /read_only: true/);
  assert.match(compose, /no-new-privileges:true/);
  assert.doesNotMatch(compose, /\.alz-state|ALZ_CHECKPOINT_DB/);
  const cli = await readFile(new URL("../src/cli/session.ts", import.meta.url), "utf8");
  assert.doesNotMatch(cli, /ALZ_CHECKPOINT_DB/);
});

test("Docker bundles a pinned scanner and requires a successful scan before packaging", async () => {
  const dockerfile = await readFile(new URL("../Dockerfile", import.meta.url), "utf8");
  assert.match(dockerfile, /aquasecurity\/trivy:0\.75\.0@sha256:[a-f0-9]{64}/);
  assert.match(dockerfile, /trivy fs --scanners vuln,misconfig --severity HIGH,CRITICAL --exit-code 1/);
  assert.match(dockerfile, /COPY --from=scan \/app\/security-scan.json/);
  assert.match(dockerfile, /COPY --from=scanner \/usr\/local\/bin\/trivy \/usr\/local\/bin\/trivy/);
});
