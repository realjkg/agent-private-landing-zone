import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { sha256 } from "../src/util/sha256.js";
import {
  contentExclusions, EXCLUSION_CODES, EXCLUSION_RULES, pathExclusions, scanPackageRoot, type ExclusionCode,
} from "../src/release/package-exclusions.js";

// The field package exclusion guard (docs/field-package.md). SYNTHETIC: every secret below is generated or assembled at run
// time from harmless parts, so this file holds no key, token or contract that a scanner could mistake for a real one.

const repository = fileURLToPath(new URL("../", import.meta.url));
const tsx = resolve(repository, "node_modules/.bin/tsx");
const cli = resolve(repository, "src/cli/release-package.ts");
const b64url = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
const jwt = () => [b64url({ alg: "RS256", typ: "JWT" }), b64url({ sub: "repo:example/example:environment:act-dev", aud: "sts.amazonaws.com", exp: 1 }), "s".repeat(43)].join(".");
const pem = (type: "pkcs8" | "pkcs1") => generateKeyPairSync("rsa", { modulusLength: 1024 }).privateKey.export({ type, format: "pem" }).toString();
const enabledContract = (extra: Record<string, unknown> = {}) => JSON.stringify({
  schemaVersion: 1, enabled: true, provider: "AWS", engine: "TERRAFORM", targets: {}, requiredApprovals: {}, maxApprovalAgeMinutes: 60,
  approvers: [], killSwitchPath: ".runs/apply/KILL", ...extra,
});
const codes = (findings: { code: ExclusionCode }[]) => [...new Set(findings.map((x) => x.code))].sort();

/** The planted files, one per owner-listed exclusion, each with the code the guard must give it. */
const PLANTED: readonly { path: string; body: () => string | Buffer; code: ExclusionCode }[] = [
  { path: "config/act-pilot-contract.json", body: () => enabledContract(), code: "PILOT_CONTRACT" },
  { path: "config/act-pilot-contract.sha256", body: () => "0".repeat(64) + "\n", code: "PILOT_CONTRACT" },
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
  // A two-part JWT without a signature, or a public key, is not refused by content.
  const pub = generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" }).toString();
  assert.deepEqual(contentExclusions("dist/pub.txt", Buffer.from(pub)), []);
});

function stage(): string {
  const root = mkdtempSync(join(tmpdir(), "alz-pkg-"));
  // What supply-chain.yml stages: dist (here the sources it compiles from), policy, config, package.json, package-lock.json, alz.
  cpSync(join(repository, "src"), join(root, "dist"), { recursive: true });
  cpSync(join(repository, "policy"), join(root, "policy"), { recursive: true });
  cpSync(join(repository, "config"), join(root, "config"), { recursive: true });
  for (const file of ["package.json", "package-lock.json", "alz"]) cpSync(join(repository, file), join(root, file));
  writeFileSync(join(root, "sbom.cdx.json"), JSON.stringify({ bomFormat: "CycloneDX", specVersion: "1.5", components: [] }) + "\n");
  // A checkout may hold the owner's local files; a stage made from it must not.
  for (const local of ["config/act-pilot-contract.json", "config/act-pilot-contract.sha256", "config/evidence-runner.json"]) rmSync(join(root, local), { force: true });
  return root;
}

test("the staged package content of this repository passes the guard", async () => {
  const root = stage();
  try {
    assert.deepEqual(await scanPackageRoot(root), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("planted files in a staged package are each found, by path, code and order; a link fails closed; only the root node_modules is skipped", async () => {
  const root = stage();
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
    rmSync(root, { recursive: true, force: true });
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

test("the package installs no runner service or launch agent: the staged and image file sets, and the shipped sources, carry none", () => {
  // supply-chain.yml stages exactly these, so scripts/ (the identity runner hook) and bootstrap/ are never in the archive.
  const workflow = readFileSync(join(repository, ".github/workflows/supply-chain.yml"), "utf8");
  const staged = [...workflow.matchAll(/^\s*cp (?:-R )?(.+?) "\$STAGE(?:\/[a-z]+)?\/?"$/gm)].flatMap((m) => m[1].split(/\s+/)).sort();
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
  if (SERVICE.test(readFileSync(join(repository, "alz"), "utf8"))) offenders.push("alz");
  assert.deepEqual(offenders, []);
});
