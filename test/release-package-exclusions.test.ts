import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { deflateRawSync, gzipSync } from "node:zlib";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { loadPilotContract } from "../src/apply/contract.js";
import { tarFiles } from "../src/release/field-package.js";
import { sha256 } from "../src/util/sha256.js";
import {
  contentExclusions, EXCLUSION_CODES, EXCLUSION_RULES, pathExclusions, scanPackageRoot, ZIP_INFLATE_BUDGET, type ExclusionCode,
} from "../src/release/package-exclusions.js";

// The field package exclusion guard (docs/field-package.md). SYNTHETIC: every secret below is generated or assembled at run
// time from harmless parts, so this file holds no key, token or contract that a scanner could mistake for a real one.

const repository = fileURLToPath(new URL("../", import.meta.url));
const tsx = resolve(repository, "node_modules/.bin/tsx");
const cli = resolve(repository, "src/cli/release-package.ts");
const b64url = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
const jwt = () => [b64url({ alg: "RS256", typ: "JWT" }), b64url({ sub: "repo:example/example:environment:act-dev", aud: "sts.amazonaws.com", exp: 1 }), "s".repeat(43)].join(".");
const pem = (type: "pkcs8" | "pkcs1") => generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type, format: "pem" }).toString();
const enabledContract = (extra: Record<string, unknown> = {}) => JSON.stringify({
  schemaVersion: 1, enabled: true, provider: "AWS", engine: "TERRAFORM", targets: {}, requiredApprovals: {}, maxApprovalAgeMinutes: 60,
  approvers: [], killSwitchPath: ".runs/apply/KILL", ...extra,
});
const codes = (findings: { code: ExclusionCode }[]) => [...new Set(findings.map((x) => x.code))].sort();
const base40 = () => "wJalrXUtnFEMI/K7MDENG/" + "bPxRfiCYEXAMPLEKEY"; // 40 characters, the AWS secret key length
/** A zip written the way zip tools write one (local headers, directory, end record); each entry stored, deflated or a given method. */
function zipFiles(entries: [string, Buffer][], method: 0 | 8 | 12 = 0, flags = 0): Buffer {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of entries) {
    const body = method === 8 ? deflateRawSync(content) : content;
    const nameBytes = Buffer.from(name);
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(flags, 6); local.writeUInt16LE(method, 8);
    local.writeUInt32LE(body.length, 18); local.writeUInt32LE(content.length, 22); local.writeUInt16LE(nameBytes.length, 26);
    const entry = Buffer.alloc(46); entry.writeUInt32LE(0x02014b50, 0); entry.writeUInt16LE(flags, 8); entry.writeUInt16LE(method, 10);
    entry.writeUInt32LE(body.length, 20); entry.writeUInt32LE(content.length, 24); entry.writeUInt16LE(nameBytes.length, 28); entry.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, body); central.push(entry, nameBytes);
    offset += 30 + nameBytes.length + body.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}
const zip = (names: string[]) => zipFiles(names.map((name) => [name, Buffer.from("x")]));

/** The planted files, one per owner-listed exclusion, each with the code the guard must give it. */
const PLANTED: readonly { path: string; body: () => string | Buffer; code: ExclusionCode }[] = [
  { path: "config/act-pilot-contract.json", body: () => enabledContract(), code: "PILOT_CONTRACT" },
  { path: "config/act-pilot-contract.sha256", body: () => "0".repeat(64) + "\n", code: "PILOT_CONTRACT" },
  { path: "config/act-pilot-contract.aws-dev.draft.json", body: () => enabledContract({ enabled: false }), code: "PILOT_CONTRACT" },
  { path: "config/customer/aws-dev.json", body: () => enabledContract(), code: "ENABLED_CONTRACT" },
  { path: "config/customer/disabled-but-authorized.json", body: () => enabledContract({ enabled: false, authorize: { DEV: ["APPLY"] } }), code: "ENABLED_CONTRACT" },
  { path: "config/evidence-runner.json", body: () => "{}\n", code: "OWNER_CONFIGURATION" },
  { path: "dist/DISCOVERY.jwt", body: () => jwt(), code: "TOKEN" },
  { path: "dist/notes.txt", body: () => "token=" + jwt() + "\n", code: "TOKEN" },
  { path: "dist/gh.txt", body: () => "ghp_" + "A1b2C3d4".repeat(5) + "\n", code: "TOKEN" },
  { path: "dist/aws.txt", body: () => "AKIA" + "ABCDEFGHIJKLMNOP" + "\n", code: "TOKEN" },
  { path: ".env", body: () => "ALZ_X=1\n", code: "TOKEN" },
  { path: "dist/readme.txt", body: () => pem("pkcs8"), code: "PRIVATE_KEY" },
  { path: "dist/legacy.txt", body: () => pem("pkcs1"), code: "PRIVATE_KEY" },
  { path: "dist/sa.json", body: () => JSON.stringify({ type: "service_account", private_key: pem("pkcs8") }), code: "PRIVATE_KEY" },
  { path: "dist/openssh.txt", body: () => "-----BEGIN OPENSSH " + "PRIVATE KEY-----\n" + "b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW".repeat(2) + "\n", code: "PRIVATE_KEY" },
  { path: "config/approver.pem", body: () => "not a key\n", code: "PRIVATE_KEY" },
  { path: "config/bundle.p12", body: () => Buffer.from([0x30, 0x82]), code: "PRIVATE_KEY" },
  { path: "keys/id_ed25519", body: () => "x\n", code: "PRIVATE_KEY" },
  { path: "actions-runner/.runner", body: () => "{}\n", code: "RUNNER_REGISTRATION" },
  { path: "runner/.credentials", body: () => "{}\n", code: "RUNNER_REGISTRATION" },
  { path: "runner/.credentials_rsaparams", body: () => "{}\n", code: "RUNNER_REGISTRATION" },
  { path: "runner/svc.sh", body: () => "#!/bin/sh\n", code: "RUNNER_REGISTRATION" },
  { path: "Library/LaunchAgents/actions.runner.alz.plist", body: () => "<plist/>\n", code: "SERVICE_UNIT" },
  { path: "etc/alz-runner.service", body: () => "[Unit]\n", code: "SERVICE_UNIT" },
  { path: "etc/alz-runner.timer", body: () => "[Timer]\n", code: "SERVICE_UNIT" },
  { path: "work/terraform.tfstate", body: () => "{}\n", code: "TERRAFORM_STATE" },
  { path: "work/terraform.tfstate.backup", body: () => "{}\n", code: "TERRAFORM_STATE" },
  { path: "work/errored.tfstate", body: () => "{}\n", code: "TERRAFORM_STATE" },
  { path: "work/.terraform/providers/x", body: () => "x\n", code: "TERRAFORM_WORKDIR" },
  { path: "work/prod.tfvars", body: () => "account = \"x\"\n", code: "TERRAFORM_VARIABLES" },
  { path: "work/alz-apply.tfplan", body: () => "x", code: "SAVED_PLAN" },
  { path: "work/plan.out", body: () => "x", code: "SAVED_PLAN" },
  { path: "work/dev.plan", body: () => "x", code: "SAVED_PLAN" },
  { path: ".runs/apply/evidence/abc.apply.evidence", body: () => "{}\n", code: "RUN_EVIDENCE" },
  { path: "dist/.runs/model-qualification/run.json", body: () => "{}\n", code: "RUN_EVIDENCE" },
  { path: "evidence-copy/abc.cleanup.evidence", body: () => "{}\n", code: "PILOT_EVIDENCE" },
  { path: "evidence-copy/abc.cleanup-proposal.json", body: () => "{}\n", code: "PILOT_EVIDENCE" },
  { path: "evidence-copy/consumed-nonces.jsonl", body: () => "\n", code: "PILOT_EVIDENCE" },
  { path: "dist/sealed.json", body: () => JSON.stringify({ schemaVersion: 2, artifactSha256: "a".repeat(64), planSha256: "b".repeat(64), manifestHash: "c".repeat(64) }), code: "SEALED_PLAN" },
  { path: "dist/approval.json", body: () => JSON.stringify({ statement: { schemaVersion: 1, artifactSha256: "a".repeat(64), approverId: "owner", nonce: "n".repeat(32) }, signatureBase64: "x" }), code: "SIGNED_APPROVAL" },
  { path: ".alz-identity/aws-terraform/APPLY.json", body: () => "{}\n", code: "DELIVERED_IDENTITY" },
  // B2: credentials and state by content, under any name.
  { path: "dist/aws-secret.txt", body: () => "aws_secret_access_key = " + base40() + "\n", code: "TOKEN" },
  { path: "dist/sts.json", body: () => JSON.stringify({ Credentials: { SecretAccessKey: base40() } }), code: "TOKEN" },
  { path: "dist/credentials", body: () => "[default]\naws_access_key_id = x\naws_secret_access_key = y\n", code: "CLOUD_CREDENTIALS" },
  { path: "dist/shared", body: () => "[pilot]\nregion = us-east-2\naws_session_token = z\n", code: "CLOUD_CREDENTIALS" },
  { path: "dist/azure.txt", body: () => "DefaultEndpointsProtocol=https;AccountName=a;AccountKey=" + "Q".repeat(86) + "==;EndpointSuffix=core.windows.net", code: "TOKEN" },
  { path: "dist/azure-sas-string.txt", body: () => "BlobEndpoint=https://a.blob.core.windows.net/;SharedAccessSignature=sv=2022-11-02&sig=" + "x".repeat(20), code: "TOKEN" },
  { path: "dist/sas.txt", body: () => "see https://a.blob.core.windows.net/c?sv=2022-11-02&se=2030-01-01&sp=r&sig=" + "abcdEFGH1234abcd%2B%3D", code: "TOKEN" },
  { path: "dist/sas-expiry-first.txt", body: () => "https://a.blob.core.windows.net/c?sig=" + "abcdEFGH1234abcd%3D" + "&se=2030-01-01", code: "TOKEN" },
  { path: "work/state.json", body: () => JSON.stringify({ version: 4, terraform_version: "1.16.4", serial: 3, lineage: "l", resources: [] }), code: "TERRAFORM_STATE" },
  { path: "work/snapshot", body: () => JSON.stringify({ version: 4, terraform_version: "1.16.4", serial: 3, lineage: "l" }), code: "TERRAFORM_STATE" },
  { path: "work/plan.bin", body: () => zip(["tfplan", "tfstate", "tfconfig/m-/main.tf"]), code: "SAVED_PLAN" },
  { path: "work/saved.zip", body: () => zip(["tfstate-prev", "tfconfig/main.tf"]), code: "SAVED_PLAN" },
  { path: "work/broken.zip", body: () => Buffer.concat([Buffer.from("PK\x03\x04", "latin1"), Buffer.from("tfplan")]), code: "UNREADABLE" },
  { path: "work/dev.tfplan.json", body: () => "{}", code: "SAVED_PLAN" },
  { path: "work/show.txt", body: () => JSON.stringify({ format_version: "1.2", terraform_version: "1.16.4", resource_changes: [] }), code: "SAVED_PLAN" },
  { path: "dist/sealed.dat", body: () => JSON.stringify({ artifactSha256: "a".repeat(64), planSha256: "b".repeat(64), manifestHash: "c".repeat(64) }), code: "SEALED_PLAN" },
  { path: "dist/approval.txt", body: () => JSON.stringify({ statement: { artifactSha256: "a".repeat(64), approverId: "o", nonce: "n" } }), code: "SIGNED_APPROVAL" },
  { path: "dist/sa-escaped.json", body: () => JSON.stringify({ type: "service_account", private_key: "-----BEGIN PRIVATE KEY-----\\nMIIE" + "A".repeat(60) + "\\n-----END PRIVATE KEY-----\\n" }), code: "CLOUD_CREDENTIALS" },
  // N2: an enabled contract under any name and in any of the cheap encodings, and tokens glued to a word.
  { path: "config/pilot.yaml", body: () => "enabled: true\nauthorize:\n  DEV: [APPLY]\n", code: "ENABLED_CONTRACT" },
  { path: "config/pilot.yml", body: () => "provider: AWS\nengine: TERRAFORM\nenabled: true\n", code: "ENABLED_CONTRACT" },
  { path: "config/pilot.json.gz", body: () => gzipSync(Buffer.from(enabledContract())), code: "ENABLED_CONTRACT" },
  { path: "config/pilot.b64", body: () => Buffer.from(enabledContract()).toString("base64"), code: "ENABLED_CONTRACT" },
  { path: "config/pilot.b64gz", body: () => gzipSync(Buffer.from(enabledContract())).toString("base64"), code: "ENABLED_CONTRACT" },
  { path: "config/pilot-utf16.json", body: () => Buffer.from("\ufeff" + enabledContract(), "utf16le"), code: "ENABLED_CONTRACT" },
  { path: "config/pilot-bom.json", body: () => "\ufeff" + enabledContract(), code: "ENABLED_CONTRACT" },
  { path: "config/pilot-array.json", body: () => "[" + enabledContract() + "]", code: "ENABLED_CONTRACT" },
  { path: "config/pilot-wrapped.json", body: () => JSON.stringify({ pilots: { dev: JSON.parse(enabledContract()) } }), code: "ENABLED_CONTRACT" },
  { path: "config/pilot-no-approvers.json", body: () => JSON.stringify({ enabled: true, provider: "AWS", engine: "TERRAFORM", targets: {} }), code: "ENABLED_CONTRACT" },
  { path: "config/authorize-only.json", body: () => JSON.stringify({ authorize: { DEV: ["APPLY"] } }), code: "ENABLED_CONTRACT" },
  { path: "dist/aws-secret-key.env", body: () => "AWS_SECRET_KEY=" + base40() + "\n", code: "TOKEN" },
  { path: "dist/secret-access-key.yml", body: () => "SECRET_ACCESS_KEY: " + base40() + "\n", code: "TOKEN" },
  { path: "dist/sas-sp.txt", body: () => "https://example.net/c?sp=r&sig=" + "abcdEFGH1234abcd%3D", code: "TOKEN" },
  { path: "dist/sas-host.txt", body: () => "https://acct.blob.core.windows.net/c/x?sig=" + "abcdEFGH1234abcd%3D", code: "TOKEN" },
  // N8: zip contents, stored or deflated, are judged as files of the package; an entry that cannot be read fails closed.
  { path: "work/creds.zip", body: () => zipFiles([["readme.txt", Buffer.from("hello")], ["credentials", Buffer.from("[default]\naws_access_key_id = x\n")]], 8), code: "CLOUD_CREDENTIALS" },
  { path: "work/pilot.zip", body: () => zipFiles([["pilot.json", Buffer.from(enabledContract())]]), code: "ENABLED_CONTRACT" },
  { path: "work/keys.zip", body: () => zipFiles([["id_ed25519", Buffer.from("x")]], 8), code: "PRIVATE_KEY" },
  { path: "work/bzip.zip", body: () => zipFiles([["notes.txt", Buffer.from("x")]], 12), code: "UNREADABLE" },
  { path: "config/authorize-object.json", body: () => JSON.stringify({ authorize: { DEV: { APPLY: true } } }), code: "ENABLED_CONTRACT" },
  { path: "config/padded.json", body: () => Buffer.concat([Buffer.alloc(8), Buffer.from(enabledContract()), Buffer.alloc(8)]), code: "ENABLED_CONTRACT" },
  { path: "dist/glued.txt", body: () => "x" + jwt(), code: "TOKEN" },
  { path: "dist/glued-gh.txt", body: () => "token_ghp_" + "A1b2C3d4".repeat(5), code: "TOKEN" },
];

test("every owner-listed exclusion has a rule, and every planted file is refused with its own code", () => {
  assert.deepEqual(Object.keys(EXCLUSION_RULES).sort(), [...EXCLUSION_CODES].sort());
  for (const planted of PLANTED) {
    const body = planted.body();
    const found = [...pathExclusions(planted.path), ...contentExclusions(planted.path, Buffer.from(body))];
    assert.ok(found.some((x) => x.code === planted.code), planted.path + " must be refused as " + planted.code + ", got " + JSON.stringify(codes(found)));
  }
});

test("the shipped content's own names and patterns are not mistaken for secrets", () => {
  const allowed = [
    "config/act-pilot-contract.aws-dev.example.json", "config/act-pilot-contract.example.json", "config/evidence-runner.example.json",
    "config/tool-pins.json", "qualification/aws/act-dev1-canary/terraform.tfvars.example.json", "qualification/aws/act-dev1-canary/.terraform.lock.hcl",
    ".env.example", "dist/evidence/index.js", "dist/evidence-runner/run.js", "dist/apply/token-delivery.js", "dist/apply/engines/terraform.js",
    "dist/cli/release-package.js", "package-lock.json", "sbom.cdx.json", "release-manifest.json", "brand-provenance.json", "alz",
  ];
  for (const path of allowed) assert.deepEqual(pathExclusions(path), [], path);
  // A pattern that names a key, as the redaction code does, is not a key.
  const redaction = readFileSync(join(repository, "src/observability/redaction.ts"));
  assert.deepEqual(contentExclusions("dist/observability/redaction.js", redaction), []);
  // The committed example contracts are disabled and authorize nothing.
  for (const name of readdirSync(join(repository, "config")).filter((n) => n.startsWith("act-pilot-contract.") && n.endsWith(".example.json"))) {
    assert.deepEqual(contentExclusions("config/" + name, readFileSync(join(repository, "config", name))), [], name);
  }
  // Lockfile integrity hashes, provider lock hashes, an SBOM's hashes and the repository's own configuration are not secrets.
  const realFiles = ["package-lock.json", ...readdirSync(join(repository, "config"), { recursive: true }).map((n) => "config/" + String(n)),
    ...readdirSync(join(repository, "policy"), { recursive: true }).map((n) => "policy/" + String(n))]
    .filter((path) => statSync(join(repository, path)).isFile());
  const qualification = join(repository, "qualification");
  if (existsSync(qualification)) {
    realFiles.push(...readdirSync(qualification, { recursive: true }).map((n) => "qualification/" + String(n))
      .filter((path) => /(?:\.terraform\.lock\.hcl|package-lock\.json|\.example\.json)$/.test(path)));
  }
  for (const path of realFiles) assert.deepEqual(contentExclusions(path, readFileSync(join(repository, path))), [], path);
  const sbom = { bomFormat: "CycloneDX", specVersion: "1.5", components: [{ name: "zod", hashes: [{ alg: "SHA-512", content: "a".repeat(128) }],
    externalReferences: [{ type: "distribution", url: "https://registry.npmjs.org/zod/-/zod-3.0.0.tgz", hashes: [{ alg: "SHA-512", content: "b".repeat(128) }] }] }] };
  assert.deepEqual(contentExclusions("sbom.cdx.json", Buffer.from(JSON.stringify(sbom))), []);
  const hcl = 'provider "registry.terraform.io/hashicorp/aws" {\n  version = "6.68.0"\n  hashes = [\n    "h1:' + "Q".repeat(43) + '=",\n    "zh:' + "a".repeat(64) + '",\n  ]\n}\n';
  assert.deepEqual(contentExclusions("qualification/x/.terraform.lock.hcl", Buffer.from(hcl)), []);
  // A zip that is not a plan, code that only names the keys, and YAML-like object literals in a bundle are not refused.
  assert.deepEqual(contentExclusions("dist/assets.zip", zip(["index.html", "app.js"])), []);
  assert.deepEqual(contentExclusions("dist/env.js", Buffer.from('const refused = ["AWS_SECRET_ACCESS_KEY", "aws_secret_access_key", "AccountKey", "sig"];\n')), []);
  assert.deepEqual(contentExclusions("dist/ui.js", Buffer.from("const c = {\n  provider: \"AWS\",\n  engine: \"TERRAFORM\",\n  enabled: true,\n};\n")), []);
  assert.deepEqual(contentExclusions("dist/url.txt", Buffer.from("https://example.com/?sig=" + "a".repeat(20) + "&page=2")), [], "a sig parameter without a SAS version or expiry");
  // A two-part JWT without a signature, or a public key, is not refused by content.
  const pub = generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" }).toString();
  assert.deepEqual(contentExclusions("dist/pub.txt", Buffer.from(pub)), []);
});

/** A checkout as CI builds it (dist stands in from src), holding the owner's committed contract and local runner configuration. */
function checkout(): string {
  const root = mkdtempSync(join(tmpdir(), "alz-pkg-src-"));
  cpSync(join(repository, "src"), join(root, "dist"), { recursive: true });
  cpSync(join(repository, "policy"), join(root, "policy"), { recursive: true });
  cpSync(join(repository, "config"), join(root, "config"), { recursive: true });
  for (const file of ["package.json", "package-lock.json", "alz"]) cpSync(join(repository, file), join(root, file));
  writeFileSync(join(root, "sbom.cdx.json"), JSON.stringify({ bomFormat: "CycloneDX", specVersion: "1.5", components: [] }) + "\n");
  writeFileSync(join(root, "config", "act-pilot-contract.json"), enabledContract({ authorize: { DEV: ["APPLY", "CLEANUP"] } }));
  writeFileSync(join(root, "config", "act-pilot-contract.aws-dev.draft.json"), enabledContract());
  writeFileSync(join(root, "config", "evidence-runner.json"), "{}\n");
  return root;
}

/** Stages exactly as supply-chain.yml does: scripts/release-stage.sh, run from the checkout's root. */
function stage(source = checkout()): { root: string; stdout: string; source: string } {
  const root = join(mkdtempSync(join(tmpdir(), "alz-pkg-")), "stage");
  const run = spawnSync("bash", [join(repository, "scripts/release-stage.sh"), root], { cwd: source, encoding: "utf8", timeout: 60000 });
  assert.equal(run.status, 0, run.stderr);
  return { root, stdout: run.stdout, source };
}
const cleanup = (...dirs: string[]) => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); };

test("supply-chain.yml stages through the one staging script, and the staging the tests use is that script", () => {
  const workflow = readFileSync(join(repository, ".github/workflows/supply-chain.yml"), "utf8");
  assert.match(workflow, /^\s*scripts\/release-stage\.sh "\$STAGE"$/m);
  assert.doesNotMatch(workflow, /cp -R config/, "config/ is never copied wholesale outside the staging script");
});

test("a checkout at the owner's authorization commit still packages: the stage, the manifest and the archive carry no contract, and ACT reads DISABLED there", async () => {
  const { root, stdout, source } = stage();
  try {
    assert.match(stdout, /left out the owner's config\/act-pilot-contract\.json/);
    assert.match(stdout, /left out the owner's config\/act-pilot-contract\.aws-dev\.draft\.json/);
    assert.match(stdout, /left out the owner's config\/evidence-runner\.json/);
    assert.ok(existsSync(join(source, "config", "act-pilot-contract.json")), "the checkout keeps the owner's contract");
    for (const owned of ["act-pilot-contract.json", "act-pilot-contract.aws-dev.draft.json", "evidence-runner.json"]) assert.equal(existsSync(join(root, "config", owned)), false, owned);
    assert.ok(readdirSync(join(root, "config")).some((name) => name.endsWith(".example.json")), "the disabled examples ship");
    assert.deepEqual(await scanPackageRoot(root), []);
    // In the package, ACT reads DISABLED: there is no contract, which the product reports as ACT_DISABLED.
    const loaded = loadPilotContract(join(root, "config", "act-pilot-contract.json"));
    assert.equal(loaded.enabled, false);
    assert.equal((loaded as { code: string }).code, "ACT_DISABLED");

    const built = spawnSync(tsx, [cli, "--root", root, "--version", "1.0.0", "--source-commit", "a".repeat(40)], { cwd: repository, encoding: "utf8", timeout: 60000 });
    assert.equal(built.status, 0, built.stderr || built.stdout);
    const manifest = JSON.parse(readFileSync(join(root, "release-manifest.json"), "utf8")) as { files: { path: string }[] };
    assert.ok(!manifest.files.some((file) => /act-pilot-contract(?!.*\.example\.json$)|evidence-runner\.json$/.test(file.path)));
    // The archive, made as supply-chain.yml makes it.
    const archive = join(dirname(root), "package.tar.gz");
    const tar = spawnSync("bash", ["-c", 'tar --sort=name --mtime=@0 --owner=0 --group=0 --numeric-owner -C "$1" -cf - . | gzip -n > "$2"', "tar", root, archive], { encoding: "utf8" });
    assert.equal(tar.status, 0, tar.stderr);
    const entries = [...tarFiles(readFileSync(archive)).keys()];
    assert.ok(entries.includes("release-manifest.json") && entries.includes("config/tool-pins.json"));
    assert.ok(!entries.some((path) => /^config\/(?:act-pilot-contract(?!.*\.example\.json$)|evidence-runner\.json$)/.test(path)), entries.filter((p) => p.startsWith("config/")).join(" "));
  } finally {
    cleanup(dirname(root), source);
  }
});

/** A zip whose directory holds `records` entries that all point at the one local entry at offset 0 (the review's N12 probe). */
function zipSharedEntry(content: Buffer, records: number): Buffer {
  const body = deflateRawSync(content);
  const name = Buffer.from("x.bin");
  const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(8, 8);
  local.writeUInt32LE(body.length, 18); local.writeUInt32LE(content.length, 22); local.writeUInt16LE(name.length, 26);
  const central: Buffer[] = [];
  for (let i = 0; i < records; i++) {
    const own = Buffer.from("x" + i + ".bin");
    const entry = Buffer.alloc(46); entry.writeUInt32LE(0x02014b50, 0); entry.writeUInt16LE(8, 10);
    entry.writeUInt32LE(body.length, 20); entry.writeUInt32LE(content.length, 24); entry.writeUInt16LE(own.length, 28); entry.writeUInt32LE(0, 42);
    central.push(entry, own);
  }
  const directory = Buffer.concat(central);
  const start = 30 + name.length + body.length;
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(records, 8); end.writeUInt16LE(records, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(start, 16);
  return Buffer.concat([local, name, body, directory, end]);
}
const reasons = (findings: { code: string; reason: string }[]) => findings.map((x) => x.code + ": " + x.reason).join(" | ");

test("zip inflation is bounded: shared entries, a zip past its total budget and an entry past its own cap are refused cleanly; encrypted entries are refused", () => {
  // The review's probe: 40 directory records pointing at one large deflated entry. Refused from the directory, nothing inflated.
  const shared = zipSharedEntry(Buffer.alloc(8 * 1024 * 1024), 40);
  const before = process.memoryUsage().rss;
  const sharedFindings = contentExclusions("work/shared.zip", shared);
  assert.match(reasons(sharedFindings), /UNREADABLE: a zip archive: two directory records point at one entry/);
  assert.ok(process.memoryUsage().rss - before < 64 * 1024 * 1024, "the shared entry is never inflated once per record");

  // Distinct entries past the total budget: the zip fails closed at the entry that would cross it, and the rest is not read.
  const mb = 1024 * 1024;
  const many = zipFiles([["a.bin", Buffer.alloc(2 * mb)], ["b.bin", Buffer.alloc(2 * mb)], ["c.txt", Buffer.from("x" + jwt())]], 8);
  const overBudget = contentExclusions("work/many.zip", many, 0, 3 * mb);
  assert.match(reasons(overBudget), /UNREADABLE: a zip entry larger than the inflation budget: b\.bin/);
  assert.doesNotMatch(reasons(overBudget), /c\.txt/, "nothing past the budget is read");
  assert.deepEqual(contentExclusions("work/many.zip", many, 0, 5 * mb).map((x) => x.code), ["TOKEN"], "within the budget every entry is judged");

  // One entry past its own 64 MB cap under the default budget: by its declared size, and when the declared size lies.
  const huge = Buffer.alloc(65 * mb);
  assert.ok(ZIP_INFLATE_BUDGET >= 64 * mb);
  assert.match(reasons(contentExclusions("work/huge.zip", zipFiles([["big.bin", huge]], 8))), /UNREADABLE: a zip entry larger than the inflation budget: big\.bin/);
  const lying = zipFiles([["big.bin", huge]], 8);
  lying.writeUInt32LE(1, 22); // the local header's declared size
  lying.writeUInt32LE(1, lying.length - 22 - 46 - "big.bin".length + 24); // the directory record's declared size
  assert.match(reasons(contentExclusions("work/lying.zip", lying)), /UNREADABLE: a zip entry larger than the inflation budget: big\.bin/);

  // N13: an encrypted entry is refused whether stored or deflated, and its bytes are never judged as plaintext.
  for (const method of [0, 8] as const) {
    const encrypted = zipFiles([["notes.txt", Buffer.from("harmless")]], method, 1);
    assert.match(reasons(contentExclusions("work/encrypted.zip", encrypted)), /UNREADABLE: an encrypted zip entry, which cannot be judged: notes\.txt/, "method " + method);
  }
});

test("an HTML-escaped SAS URL is found", () => {
  const sas = "https://acct.blob.example.net/c?sv=2022-11-02&amp;se=2030-01-01&amp;sig=" + "abcdEFGH1234abcd%3D";
  assert.deepEqual(contentExclusions("dist/page.html", Buffer.from('<a href="' + sas + '">x</a>')).map((x) => x.code), ["TOKEN"]);
  assert.deepEqual(contentExclusions("dist/page.html", Buffer.from('<a href="https://example.com/?page=2&amp;sig=' + "a".repeat(20) + '">x</a>')), [], "sig= alone on another host");
});

test("staging refuses a stage inside the checkout or a copied source before anything is copied, and stops when find fails", () => {
  const source = checkout();
  const tools = mkdtempSync(join(tmpdir(), "alz-pkg-tools-"));
  try {
    for (const [stagePath, message] of [[".", /into the checkout itself/], ["dist/stage", /inside dist\//], ["config/x/stage", /inside config\//], ["policy", /inside policy\//]] as const) {
      const run = spawnSync("bash", [join(repository, "scripts/release-stage.sh"), stagePath], { cwd: source, encoding: "utf8" });
      assert.notEqual(run.status, 0, stagePath);
      assert.match(run.stderr, message, stagePath);
    }
    assert.equal(existsSync(join(source, "dist", "stage")), false, "no partial copy is left in dist/");
    assert.equal(existsSync(join(source, "config", "x")), false, "no partial copy is left in config/");
    // A find that fails stops the script with a clear message, never a stage that silently kept the owner's files.
    writeFileSync(join(tools, "find"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    const stage = join(tools, "stage");
    const failed = spawnSync("bash", [join(repository, "scripts/release-stage.sh"), stage], { cwd: source, encoding: "utf8", env: { ...process.env, PATH: tools + ":" + process.env.PATH } });
    assert.notEqual(failed.status, 0);
    assert.match(failed.stderr, /could not list the staged config\/ folder/);
  } finally {
    cleanup(source, tools);
  }
});

test("staging refuses a folder that is not empty and a checkout that is not built", () => {
  const source = checkout();
  const busy = mkdtempSync(join(tmpdir(), "alz-pkg-busy-"));
  try {
    writeFileSync(join(busy, "left.txt"), "x");
    const full = spawnSync("bash", [join(repository, "scripts/release-stage.sh"), busy], { cwd: source, encoding: "utf8" });
    assert.notEqual(full.status, 0);
    assert.match(full.stderr, /is not empty/);
    rmSync(join(source, "dist"), { recursive: true });
    const unbuilt = spawnSync("bash", [join(repository, "scripts/release-stage.sh"), join(busy, "s")], { cwd: source, encoding: "utf8" });
    assert.notEqual(unbuilt.status, 0);
    assert.match(unbuilt.stderr, /dist is missing/);
  } finally {
    cleanup(source, busy);
  }
});

test("staging names are read NUL-separated and removed only inside the stage: a newline in a name, glob characters or a leading dash in STAGE change nothing in the checkout", () => {
  const source = checkout();
  const parent = mkdtempSync(join(tmpdir(), "alz-pkg-odd-"));
  try {
    // The review's probe: a committed name with a newline once split into ".json", which was removed from the checkout.
    writeFileSync(join(source, "config", "act-pilot-contract\n.json"), enabledContract());
    writeFileSync(join(source, ".json"), "checkout file\n");
    writeFileSync(join(source, "config", ".json"), "checkout file\n");
    for (const name of ["g[x]* stage", "-dash-stage"]) {
      const run = spawnSync("bash", [join(repository, "scripts/release-stage.sh"), name], { cwd: parent, encoding: "utf8", timeout: 60000, env: { ...process.env } });
      // The script stages from the checkout it runs in.
      assert.notEqual(run.status, 0, "a folder that is not a checkout is refused");
      const staged = spawnSync("bash", ["-c", 'cd "$1" && "$2" "$3"', "stage", source, join(repository, "scripts/release-stage.sh"), join(parent, name)], { encoding: "utf8", timeout: 60000 });
      assert.equal(staged.status, 0, staged.stderr);
      const stageConfig = join(parent, name, "config");
      assert.equal(existsSync(join(stageConfig, "act-pilot-contract\n.json")), false, name + ": the newline name is left out");
      assert.equal(existsSync(join(stageConfig, "act-pilot-contract.json")), false, name);
      assert.equal(existsSync(join(stageConfig, "evidence-runner.json")), false, name + ": glob characters in STAGE do not keep the runner configuration");
      assert.ok(existsSync(join(stageConfig, "tool-pins.json")), name);
      assert.ok(existsSync(join(stageConfig, ".json")), name + ": an unrelated staged file stays");
    }
    // Nothing in the checkout was touched.
    for (const kept of [".json", "config/.json", "config/act-pilot-contract\n.json", "config/act-pilot-contract.json", "config/evidence-runner.json"]) {
      assert.ok(existsSync(join(source, kept)), kept + " stays in the checkout");
    }
  } finally {
    cleanup(source, parent);
  }
});

/** Docker's .dockerignore rule: the last pattern that matches a path, or one of its parent folders, decides; `!` keeps. */
function dockerIgnored(patterns: string[], path: string): boolean {
  let ignored = false;
  for (const raw of patterns) {
    const keep = raw.startsWith("!");
    const pattern = (keep ? raw.slice(1) : raw).replace(/^\/+/, "").replace(/\/+$/, "");
    const source = "^" + pattern.split("**").map((part) => part.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]")).join(".*") + "(?:/.*)?$";
    if (new RegExp(source).test(path)) ignored = !keep;
  }
  return ignored;
}

test("the runtime image cannot hold the owner's files: .dockerignore keeps them out of the context, and config/ is the only config source", () => {
  const patterns = readFileSync(join(repository, ".dockerignore"), "utf8").split("\n").map((line) => line.trim()).filter((line) => line !== "" && !line.startsWith("#"));
  for (const owned of ["config/act-pilot-contract.json", "config/act-pilot-contract.sha256", "config/act-pilot-contract.aws-dev.draft.json", "config/evidence-runner.json"]) {
    assert.ok(dockerIgnored(patterns, owned), owned + " is kept out of the image");
  }
  // Every committed configuration file still reaches the image.
  for (const name of readdirSync(join(repository, "config"), { recursive: true }).map(String)) {
    if (statSync(join(repository, "config", name)).isFile()) assert.equal(dockerIgnored(patterns, "config/" + name), false, "config/" + name);
  }
  const dockerfile = readFileSync(join(repository, "Dockerfile"), "utf8");
  const runtime = dockerfile.slice(dockerfile.lastIndexOf("FROM "));
  assert.match(runtime, /release-package\.js \\\n\s*--root \/app/, "the image build runs the guard on /app");
});

test("planted files in a staged package are each found, by path, code and order; a link fails closed; only the root node_modules is skipped", async () => {
  const { root, source } = stage();
  try {
    for (const planted of PLANTED) {
      mkdirSync(dirname(join(root, planted.path)), { recursive: true });
      writeFileSync(join(root, planted.path), planted.body());
    }
    symlinkSync("/etc/hostname", join(root, "dist", "linked.txt"));
    mkdirSync(join(root, "node_modules", "x"), { recursive: true });
    writeFileSync(join(root, "node_modules", "x", "fixture.json"), enabledContract());
    mkdirSync(join(root, "dist", "node_modules"), { recursive: true });
    writeFileSync(join(root, "dist", "node_modules", "fixture.json"), enabledContract());

    const findings = await scanPackageRoot(root);
    for (const planted of PLANTED) {
      assert.ok(findings.some((x) => x.path === planted.path && x.code === planted.code), planted.path + " (" + planted.code + ")");
    }
    assert.ok(findings.some((x) => x.path === "dist/linked.txt" && x.code === "NOT_A_REGULAR_FILE"));
    assert.ok(!findings.some((x) => x.path.startsWith("node_modules/")), "the root node_modules is the installed dependencies, covered by the SBOM");
    assert.ok(findings.some((x) => x.path === "dist/node_modules/fixture.json" && x.code === "ENABLED_CONTRACT"));
    const sorted = [...findings].sort((a, b) => a.path === b.path ? a.code.localeCompare(b.code) : a.path < b.path ? -1 : 1);
    assert.deepEqual(findings, sorted);
    assert.deepEqual(await scanPackageRoot(root), findings, "the same root gives the same findings");
  } finally {
    cleanup(dirname(root), source);
  }
});

test("release-package refuses to build a package with an owner contract or a token in it, and writes no manifest", () => {
  for (const [path, body] of [["config/act-pilot-contract.json", enabledContract()], ["dist/APPLY.jwt", jwt()], ["work/terraform.tfstate", "{}"]] as const) {
    const root = mkdtempSync(join(tmpdir(), "alz-pkg-cli-"));
    try {
      writeFileSync(join(root, "sbom.cdx.json"), '{"bomFormat":"CycloneDX"}\n');
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), body);
      const run = spawnSync(tsx, [cli, "--root", root, "--version", "1.0.0", "--source-commit", "a".repeat(40)], { cwd: repository, encoding: "utf8", timeout: 60000 });
      assert.notEqual(run.status, 0, path);
      assert.match(run.stderr, /RELEASE_PACKAGE_EXCLUDED_CONTENT/);
      assert.ok(run.stderr.includes(path), run.stderr);
      assert.equal(existsSync(join(root, "release-manifest.json")), false, "nothing is hashed or written once a finding exists");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("release-package --verify refuses a manifest that names excluded content, even when every hash matches", () => {
  const root = mkdtempSync(join(tmpdir(), "alz-pkg-verify-"));
  try {
    writeFileSync(join(root, "sbom.cdx.json"), '{"bomFormat":"CycloneDX"}\n');
    const built = spawnSync(tsx, [cli, "--root", root, "--version", "1.0.0", "--source-commit", "a".repeat(40)], { cwd: repository, encoding: "utf8", timeout: 60000 });
    assert.equal(built.status, 0, built.stderr || built.stdout);
    assert.match(built.stdout, /ACT remains disabled/);

    // Someone adds a sealed plan under .runs/ after the build and re-hashes it into the manifest.
    mkdirSync(join(root, ".runs", "apply"), { recursive: true });
    writeFileSync(join(root, ".runs", "apply", "x.apply.evidence"), "{}\n");
    const manifestPath = join(root, "release-manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { files: { path: string; sha256: string }[] };
    manifest.files.push({ path: ".runs/apply/x.apply.evidence", sha256: sha256(readFileSync(join(root, ".runs", "apply", "x.apply.evidence"))) });
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
    assert.equal(statSync(manifestPath).isFile(), true);

    const verified = spawnSync(tsx, [cli, "--root", root, "--verify"], { cwd: repository, encoding: "utf8", timeout: 60000 });
    assert.notEqual(verified.status, 0);
    assert.match(verified.stderr, /excluded content: RUN_EVIDENCE \.runs\/apply\/x\.apply\.evidence/);
    assert.match(verified.stderr, /PILOT_EVIDENCE \.runs\/apply\/x\.apply\.evidence/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the package installs no runner service or launch agent: the staged and image file sets, and the shipped sources, configuration and policy, carry none", () => {
  // The staging script copies exactly these, so scripts/ (the identity runner hook) and bootstrap/ are never in the archive.
  const script = readFileSync(join(repository, "scripts/release-stage.sh"), "utf8");
  const staged = [...script.matchAll(/^\s*cp (?:-R )?(?:-- )?(.+?) "\$STAGE_ABS(?:\/[a-z]+)?\/?"$/gm)].flatMap((m) => m[1].split(/\s+/)).sort();
  assert.deepEqual(staged, ["alz", "config", "dist", "package-lock.json", "package.json", "policy", "sbom.cdx.json"]);
  // The runtime image copies the same kind of content, and nothing that registers or starts a runner.
  const dockerfile = readFileSync(join(repository, "Dockerfile"), "utf8");
  const runtime = dockerfile.slice(dockerfile.lastIndexOf("FROM "));
  const copied = [...runtime.matchAll(/^COPY (.+)$/gm)]
    .flatMap((m) => m[1].split(/\s+/).filter((x) => !x.startsWith("--")).slice(0, -1)).sort();
  assert.deepEqual(copied, ["/app/dist", "/app/node_modules", "config/", "package-lock.json", "package.json", "policy/"]);

  // No shipped code or the launcher installs, registers or schedules anything: no launchd, systemd, cron or Windows task,
  // and no actions runner. The guard's own rule table is the one file that names them, as refusals.
  const SERVICE = /\blaunchctl\b|\bsystemctl\b|LaunchAgents|LaunchDaemons|\bsvc\.sh\b|actions-runner|\bcrontab\b|\bschtasks\b|config\.sh\s+--url/;
  const offenders: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(join(repository, dir), { withFileTypes: true })) {
      const path = dir + "/" + entry.name;
      if (entry.isDirectory()) walk(path);
      else if (path !== "src/release/package-exclusions.ts" && SERVICE.test(readFileSync(join(repository, path), "utf8"))) offenders.push(path);
    }
  };
  walk("src");
  walk("config");
  walk("policy");
  if (SERVICE.test(readFileSync(join(repository, "alz"), "utf8"))) offenders.push("alz");
  assert.deepEqual(offenders, []);
});
