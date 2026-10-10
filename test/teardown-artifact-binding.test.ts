import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  assessmentLabel,
  bindPreview,
  buildManifest,
  type ManifestRequest,
  recordStateVersion,
  validateManifestForRequest,
  verifyManifest,
} from "../src/teardown/manifest.js";
import { captureProjectFiles, compareProject, createImmutableSnapshot } from "../src/teardown/snapshot.js";

const H = (char: string) => char.repeat(64);
const scratch = mkdtempSync(join(tmpdir(), "alz-binding-test-"));
test.after(() => {
  for (const name of readdirSync(scratch)) chmodTree(join(scratch, name));
  rmSync(scratch, { recursive: true, force: true });
});
function chmodTree(path: string) {
  try {
    chmodSync(path, 0o700);
    if (statSync(path).isDirectory()) for (const name of readdirSync(path)) chmodTree(join(path, name));
  } catch { /* best effort */ }
}
let counter = 0;
const fresh = (label: string) => {
  const dir = join(scratch, label + "-" + ++counter);
  mkdirSync(dir, { recursive: true });
  return dir;
};

const base = {
  engine: "TERRAFORM" as const,
  mode: "PROJECT" as const,
  target: { account: "123456789012", backend: "s3://alz-state/prod", workspace: "default" },
  unitHash: H("a"),
  engineVersion: "1.16.5",
  providers: [{ source: "registry.terraform.io/hashicorp/aws", version: "6.68.0" }],
  lockFileSha256: H("b"),
  files: [{ path: "main.tf", sha256: H("c") }, { path: "variables.tf", sha256: H("d") }],
  dependencies: [{ name: "terraform-aws-modules/vpc/aws", version: "5.0.0", integrity: H("e") }],
  inputs: [{ name: "aws_region", identity: H("f") }],
  policyVersion: "2026-10-07.1",
};
const approved = () => buildManifest(base);
const requestFor = (manifest = approved()): ManifestRequest => {
  const { manifestHash: _hash, schemaVersion: _v, operation: _o, ...rest } = manifest;
  return structuredClone(rest);
};

test("a manifest is sealed, order-independent and tamper-evident", () => {
  const one = approved();
  const shuffled = buildManifest({ ...base, files: [...base.files].reverse(), inputs: [...base.inputs].reverse() });
  assert.equal(one.manifestHash, shuffled.manifestHash);
  assert.deepEqual(verifyManifest(JSON.parse(JSON.stringify(one))), one);
  const tampered = JSON.parse(JSON.stringify(one));
  tampered.engineVersion = "1.99.0";
  assert.throws(() => verifyManifest(tampered), /SEAL_MISMATCH/);
  const unsealed = JSON.parse(JSON.stringify(one));
  delete unsealed.manifestHash;
  assert.throws(() => verifyManifest(unsealed), /SEAL_MISSING/);
});

test("mode rules: a project run needs files and a lock file; a state-derived run carries no project hash", () => {
  assert.throws(() => buildManifest({ ...base, lockFileSha256: undefined }), /LOCK_FILE_REQUIRED/);
  assert.throws(() => buildManifest({ ...base, files: [] }), /PROJECT_FILES_REQUIRED/);
  assert.throws(() => buildManifest({ ...base, executionManifestSha256: H("1") }), /PROJECT_HAS_EXECUTION_MANIFEST/);
  const pulumi = { ...base, engine: "PULUMI" as const, lockFileSha256: undefined };
  assert.doesNotThrow(() => buildManifest(pulumi)); // Pulumi has no Terraform-style lock file
  const derived = { ...pulumi, mode: "STATE_DERIVED" as const, files: [], dependencies: [], executionManifestSha256: H("1") };
  const sealed = buildManifest(derived);
  assert.equal(sealed.files.length, 0);
  assert.throws(() => buildManifest({ ...derived, files: base.files }), /STATE_DERIVED_HAS_PROJECT_INPUTS/);
  assert.throws(() => buildManifest({ ...derived, executionManifestSha256: undefined }), /EXECUTION_MANIFEST_REQUIRED/);
  assert.throws(() => buildManifest({ ...derived, engine: "TERRAFORM" }), /STATE_DERIVED_ENGINE/);
  // What the hash proves is stated, and for state-derived it does not claim a project.
  const result = validateManifestForRequest(sealed, requestFor(sealed));
  assert.ok(result.ok && /project is not run/.test(result.proves));
});

test("live state never enters the manifest", () => {
  for (const field of ["stateVersion", "stateHash", "serial", "lineage", "etag", "versionId", "stateSerial"]) {
    assert.throws(() => buildManifest({ ...base, [field]: "1" } as never), /STATE_FIELD_IN_MANIFEST/, field);
  }
  assert.throws(() => buildManifest({ ...base, target: { ...base.target, serial: "3" } as never }), /STATE_FIELD_IN_MANIFEST/);
});

test("unsafe file paths and non-hash identities are refused", () => {
  for (const path of ["/etc/passwd", "../outside.tf", "a/../../b.tf", "a//b.tf", "a b.tf", ""]) {
    assert.throws(() => buildManifest({ ...base, files: [{ path, sha256: H("c") }] }), /FILE/, path);
  }
  assert.throws(() => buildManifest({ ...base, files: [{ path: "main.tf", sha256: "short" }] }), /FILE/);
  assert.throws(() => buildManifest({ ...base, inputs: [{ name: "db_password", identity: "hunter2" }] }), /INPUT_IDENTITY/);
  assert.throws(() => buildManifest({ ...base, files: [base.files[0], base.files[0]] }), /FILE_DUPLICATE/);
});

test("an identical request validates and says what the hash proves", () => {
  const result = validateManifestForRequest(approved(), requestFor());
  assert.ok(result.ok);
  assert.equal(result.label, "ARTIFACT_VALIDATED_DESTROY_PREVIEW");
  assert.match(result.proves, /configuration or program files/);
});

test("any difference fails closed with REVIEW_REQUIRED and names the field", () => {
  const cases: Array<[string, (r: ManifestRequest) => void]> = [
    ["engine", (r) => { r.engine = "OPENTOFU"; }],
    ["engineVersion", (r) => { r.engineVersion = "1.16.6"; }],
    ["policyVersion", (r) => { r.policyVersion = "2026-10-08.1"; }],
    ["unitHash", (r) => { r.unitHash = H("9"); }],
    ["target.account", (r) => { r.target.account = "999999999999"; }],
    ["target.backend", (r) => { r.target.backend = "s3://other/prod"; }],
    ["target.workspace", (r) => { r.target.workspace = "staging"; }],
    ["lockFileSha256", (r) => { r.lockFileSha256 = H("0"); }],
    ["providers", (r) => { r.providers[0].version = "6.69.0"; }],
    ["providers", (r) => { r.providers.push({ source: "registry.terraform.io/hashicorp/null", version: "3.2.0" }); }],
    ["files", (r) => { r.files[0].sha256 = H("0"); }],
    ["files", (r) => { r.files.push({ path: "extra.tf", sha256: H("0") }); }],
    ["files", (r) => { r.files.pop(); }],
    ["dependencies", (r) => { r.dependencies[0].integrity = H("0"); }],
    ["inputs", (r) => { r.inputs[0].identity = H("0"); }],
    ["inputs", (r) => { r.inputs.push({ name: "extra", identity: H("0") }); }],
  ];
  for (const [field, mutate] of cases) {
    const request = requestFor();
    mutate(request);
    const result = validateManifestForRequest(approved(), request);
    assert.equal(result.ok, false, field);
    assert.ok(!result.ok && result.code === "REVIEW_REQUIRED");
    assert.ok(!result.ok && result.mismatches.some((m) => m.field === field), field + " in " + JSON.stringify(!result.ok && result.mismatches));
    assert.ok(!result.ok && /newly reviewed manifest is required/.test(result.message));
  }
});

test("there is no override: unknown request fields are refused, not ignored, and no bypass exists in the source", () => {
  for (const field of ["force", "forcePreview", "skipValidation", "allowMismatch", "ignoreManifest", "override"]) {
    const request = { ...requestFor(), [field]: true } as ManifestRequest;
    assert.throws(() => validateManifestForRequest(approved(), request), /UNKNOWN_REQUEST_FIELD/, field);
  }
  assert.throws(() => validateManifestForRequest({ ...approved(), engineVersion: "9" }, requestFor()), /SEAL_MISMATCH/);
  for (const file of ["src/teardown/manifest.ts", "src/teardown/snapshot.ts"]) {
    const code = readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
    assert.doesNotMatch(code, /\b(force\w*|bypass\w*|allowMismatch\w*|ignoreMismatch\w*|skipValidation\w*)\b/i, file);
  }
});

test("the state version is recorded beside the manifest and changing it never changes validation", () => {
  const manifest = approved();
  const result = validateManifestForRequest(manifest, requestFor(manifest));
  const first = bindPreview(result, base.unitHash, { kind: "TERRAFORM_SERIAL", value: "41", observedAt: "2026-10-10T12:00:00Z" });
  const later = bindPreview(result, base.unitHash, { kind: "TERRAFORM_SERIAL", value: "58", observedAt: "2026-11-01T09:30:00Z" });
  assert.equal(first.manifestHash, later.manifestHash);
  assert.notEqual(first.stateVersion.value, later.stateVersion.value);
  assert.equal(assessmentLabel(first), "ARTIFACT_VALIDATED_DESTROY_PREVIEW");
  assert.throws(() => recordStateVersion({ kind: "TERRAFORM_SERIAL", value: "41", observedAt: "yesterday" }), /STATE_OBSERVED_AT/);
  assert.throws(() => recordStateVersion({ kind: "NOPE" as never, value: "1", observedAt: "2026-10-10T12:00:00Z" }), /STATE_KIND/);
});

test("a mismatch cannot be bound, and an inventory-only assessment is never labeled validated", () => {
  const request = requestFor();
  request.files[0].sha256 = H("0");
  const failed = validateManifestForRequest(approved(), request);
  assert.throws(() => bindPreview(failed, base.unitHash, { kind: "ETAG", value: "abc", observedAt: "2026-10-10T12:00:00Z" }), /BINDING_NOT_VALIDATED/);
  assert.equal(assessmentLabel(undefined), "INVENTORY_ONLY_NOT_ARTIFACT_VALIDATED");
  const forged = { manifestHash: "nope", unitHash: base.unitHash, label: "ARTIFACT_VALIDATED_DESTROY_PREVIEW" as const,
    stateVersion: { kind: "ETAG" as const, value: "abc", observedAt: "2026-10-10T12:00:00Z" } };
  assert.equal(assessmentLabel(forged), "INVENTORY_ONLY_NOT_ARTIFACT_VALIDATED");
});

// --- Snapshots -----------------------------------------------------------------

function project() {
  const dir = fresh("project");
  writeFileSync(join(dir, "main.tf"), 'resource "aws_s3_bucket" "b" {}\n');
  mkdirSync(join(dir, "modules"));
  writeFileSync(join(dir, "modules", "m.tf"), "# module\n");
  writeFileSync(join(dir, ".terraform.lock.hcl"), "# lock\n");
  mkdirSync(join(dir, ".terraform"));
  writeFileSync(join(dir, ".terraform", "providers.json"), "{}");
  const files = captureProjectFiles(dir);
  const manifest = buildManifest({ ...base, files, lockFileSha256: files.find((f) => f.path === ".terraform.lock.hcl")!.sha256 });
  return { dir, files, manifest };
}

test("capture hashes files with standard SHA-256 and skips only caches", () => {
  const { files } = project();
  assert.deepEqual(files.map((f) => f.path), [".terraform.lock.hcl", "main.tf", "modules/m.tf"]);
  const { dir } = project();
  // Independent of the code under test: the same value `sha256sum main.tf` prints.
  const expected = createHash("sha256").update(readFileSync(join(dir, "main.tf"))).digest("hex");
  assert.equal(captureProjectFiles(dir).find((f) => f.path === "main.tf")!.sha256, expected);
});

test("capture refuses links, state files and plan files instead of working around them", () => {
  const dir = fresh("hostile");
  writeFileSync(join(dir, "main.tf"), "x");
  symlinkSync("/etc/passwd", join(dir, "link.tf"));
  assert.throws(() => captureProjectFiles(dir), /SYMLINK:link\.tf/);
  unlinkSync(join(dir, "link.tf"));
  for (const name of ["terraform.tfstate", "terraform.tfstate.backup", "plan.tfplan", ".agentic-preview.tfplan"]) {
    writeFileSync(join(dir, name), "secret");
    assert.throws(() => captureProjectFiles(dir), /STATE_OR_PLAN_FILE/, name);
    unlinkSync(join(dir, name));
  }
});

test("the snapshot is a private, read-only copy of exactly the manifest's files", () => {
  const { dir, manifest } = project();
  const parent = fresh("snap-parent");
  const snapshot = createImmutableSnapshot(dir, manifest, parent);
  assert.equal(readFileSync(join(snapshot.path, "main.tf"), "utf8"), readFileSync(join(dir, "main.tf"), "utf8"));
  assert.equal(statSync(join(snapshot.path, "main.tf")).mode & 0o222, 0);
  assert.equal(statSync(snapshot.path).mode & 0o222, 0);
  const holder = join(snapshot.path, "..");
  assert.equal(statSync(holder).mode & 0o077, 0, "the directory holding the snapshot is private");
  assert.equal(existsSync(join(snapshot.path, ".terraform")), false);
  assert.doesNotThrow(() => snapshot.verify());
  snapshot.remove();
  assert.equal(existsSync(holder), false);
});

test("a source that changed since approval is refused, and nothing is left behind", () => {
  const { dir, manifest } = project();
  writeFileSync(join(dir, "main.tf"), 'resource "aws_s3_bucket" "b" { force_destroy = true }\n');
  const parent = fresh("snap-parent");
  assert.throws(() => createImmutableSnapshot(dir, manifest, parent), /CHANGED:main\.tf/);
  assert.deepEqual(readdirSync(parent), []);
});

test("a file removed, or a link planted, after approval is refused", () => {
  const first = project();
  unlinkSync(join(first.dir, "modules", "m.tf"));
  assert.throws(() => createImmutableSnapshot(first.dir, first.manifest, fresh("p")), /MISSING:modules\/m\.tf/);
  const second = project();
  unlinkSync(join(second.dir, "main.tf"));
  symlinkSync("/etc/hostname", join(second.dir, "main.tf"));
  assert.throws(() => createImmutableSnapshot(second.dir, second.manifest, fresh("p")), /SYMLINK:main\.tf/);
});

test("changing the source after the snapshot exists cannot change what runs", () => {
  const { dir, manifest } = project();
  const snapshot = createImmutableSnapshot(dir, manifest, fresh("snap-parent"));
  writeFileSync(join(dir, "main.tf"), "changed after the copy");
  assert.doesNotThrow(() => snapshot.verify());
  assert.notEqual(readFileSync(join(snapshot.path, "main.tf"), "utf8"), "changed after the copy");
  snapshot.remove();
});

test("verify catches content changed, a file added, one removed, and a planted cache directory", () => {
  const make = () => {
    const { dir, manifest } = project();
    return createImmutableSnapshot(dir, manifest, fresh("snap-parent"));
  };
  const changed = make();
  chmodSync(changed.path, 0o700); chmodSync(join(changed.path, "main.tf"), 0o600);
  writeFileSync(join(changed.path, "main.tf"), "tampered");
  assert.throws(() => changed.verify(), /CHANGED:main\.tf/);
  changed.remove();

  const added = make();
  chmodSync(added.path, 0o700);
  writeFileSync(join(added.path, "extra.tf"), 'provider "evil" {}');
  assert.throws(() => added.verify(), /UNLISTED:extra\.tf/);
  added.remove();

  const removed = make();
  chmodSync(removed.path, 0o700);
  unlinkSync(join(removed.path, "main.tf"));
  assert.throws(() => removed.verify(), /MISSING:main\.tf/);
  removed.remove();

  const planted = make();
  chmodSync(planted.path, 0o700);
  mkdirSync(join(planted.path, ".terraform"));
  writeFileSync(join(planted.path, ".terraform", "evil.tf"), "x");
  assert.throws(() => planted.verify(), /UNLISTED:\.terraform\/evil\.tf/);
  planted.remove();
});

test("a state-derived manifest has no project to snapshot", () => {
  const derived = buildManifest({ ...base, engine: "PULUMI", mode: "STATE_DERIVED", lockFileSha256: undefined,
    files: [], dependencies: [], executionManifestSha256: H("1") });
  assert.throws(() => createImmutableSnapshot(fresh("x"), derived, fresh("p")), /NO_PROJECT_INPUTS_IN_STATE_DERIVED_MODE/);
});

test("compareProject tells a reviewer what moved, and repairs nothing", () => {
  const { dir, manifest } = project();
  writeFileSync(join(dir, "main.tf"), "edited");
  writeFileSync(join(dir, "new.tf"), "added");
  unlinkSync(join(dir, "modules", "m.tf"));
  assert.deepEqual(compareProject(dir, manifest), { added: ["new.tf"], removed: ["modules/m.tf"], changed: ["main.tf"] });
  assert.equal(readFileSync(join(dir, "main.tf"), "utf8"), "edited");
});
