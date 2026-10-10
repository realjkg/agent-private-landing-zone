import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";

import { createChangeSet } from "../src/iac/changeset.js";
import { normalizeTerraformPlan } from "../src/iac/terraform-plan.js";
import {
  argvDigest,
  assertNoRawPayload,
  buildEvidence,
  enabledEngines,
  evidenceProblems,
  runDestroyPreview,
  runCleanups,
  runPreview,
  type AdapterContext,
  type DriverDeps,
  type DriverEngine,
  type EngineAdapter,
  type PreviewEvidence,
  type PreviewOperation,
  type PreviewRequest,
  type QualificationRecord,
} from "../src/teardown/driver/index.js";
import { buildManifest } from "../src/teardown/manifest.js";
import { captureProjectFiles, createImmutableSnapshot } from "../src/teardown/snapshot.js";
import { recordDeletionUnit } from "../src/teardown/unit.js";
import type { DeletionUnit } from "../src/teardown/types.js";

const H = (char: string) => char.repeat(64);
const scratch = mkdtempSync(join(tmpdir(), "alz-driver-test-"));
test.after(() => {
  const open = (path: string) => {
    try {
      chmodSync(path, 0o700);
      if (statSync(path).isDirectory()) for (const name of readdirSync(path)) open(join(path, name));
    } catch { /* best effort */ }
  };
  open(scratch);
  rmSync(scratch, { recursive: true, force: true });
});
let counter = 0;
const fresh = (label: string) => {
  const dir = join(scratch, label + "-" + ++counter);
  mkdirSync(dir, { recursive: true });
  return dir;
};

const CANARY_PLAN_SECRET = "canary-plan-secret-9f3a";
const CANARY_STATE_SECRET = "canary-state-secret-77c1";

const ADDRESS = "aws_s3_bucket.logs";
const LOCATION = "s3://alz-state/prod/terraform.tfstate";
const TARGET = { account: "123456789012", backend: LOCATION, workspace: "default" };
const ENV = { ALZ_DISCOVERY_AWS_ACCESS_KEY_ID: "discovery-key-1", ALZ_STATE_AWS_ACCESS_KEY_ID: "state-key-2" };

const unitFor = (engine: DriverEngine): DeletionUnit => recordDeletionUnit({
  buildId: "build-1",
  provider: "aws",
  stateRef: engine === "PULUMI"
    ? { engine: "PULUMI", backendUrl: "s3://alz-pulumi", stack: "prod" }
    : { engine, backend: "s3", location: LOCATION, workspace: "default" },
  designHash: H("1"),
  createPlan: createChangeSet(engine, [{ address: ADDRESS, type: "aws_s3_bucket", operation: "CREATE" }]),
  recordedAt: "2026-10-10T08:00:00.000Z",
});

type Fixture = { request: PreviewRequest; deps: DriverDeps; adapter: FakeAdapter; parent: string };

type FakeAdapter = EngineAdapter & { calls: Array<{ operation: PreviewOperation; context: AdapterContext }> };

function fakeAdapter(
  engine: DriverEngine,
  behave?: (request: PreviewRequest, operation: PreviewOperation, context: AdapterContext) => PreviewEvidence,
): FakeAdapter {
  const descriptor = { engine, adapterVersion: "1.0.0", argvDigest: argvDigest([["fake", engine, "plan"]]) };
  const calls: FakeAdapter["calls"] = [];
  const run = (operation: PreviewOperation) => (request: PreviewRequest, context: AdapterContext): PreviewEvidence => {
    calls.push({ operation, context });
    if (behave) return behave(request, operation, context);
    return buildEvidence({
      request, operation, adapter: descriptor, observedEngineVersion: request.resolved.engineVersion,
      resources: [{ address: ADDRESS, type: "aws_s3_bucket", operation: operation === "DESTROY_PREVIEW" ? "DELETE" : "CREATE" }],
      stateVersion: { kind: "TERRAFORM_SERIAL", value: "42", observedAt: "2026-10-10T09:00:00.000Z" },
    });
  };
  return { ...descriptor, calls, preview: run("PREVIEW"), destroyPreview: run("DESTROY_PREVIEW") };
}

const qualify = (adapter: EngineAdapter, engineVersion: string): QualificationRecord => ({
  engine: adapter.engine, adapterVersion: adapter.adapterVersion, engineVersion,
  argvDigest: adapter.argvDigest, qualifiedAt: "2026-10-10T07:00:00.000Z", evidenceHash: H("9"),
});

function fixture(options: { engine?: DriverEngine; mode?: "PROJECT" | "STATE_DERIVED"; behave?: Parameters<typeof fakeAdapter>[1] } = {}): Fixture {
  const engine = options.engine ?? "TERRAFORM";
  const mode = options.mode ?? "PROJECT";
  const projectRoot = fresh("project");
  writeFileSync(join(projectRoot, "main.tf"), 'resource "aws_s3_bucket" "logs" {}\n');
  writeFileSync(join(projectRoot, ".terraform.lock.hcl"), "# lock\n");
  const unit = unitFor(engine);
  const target = engine === "PULUMI" ? { ...TARGET, backend: "s3://alz-pulumi", workspace: "prod" } : TARGET;
  const providers = [{ source: "registry.terraform.io/hashicorp/aws", version: "6.68.0" }];
  const manifest = buildManifest({
    engine, mode, target, unitHash: unit.unitHash, engineVersion: "1.16.5", providers,
    lockFileSha256: engine === "PULUMI" ? undefined : H("b"),
    files: mode === "PROJECT" ? captureProjectFiles(projectRoot) : [],
    dependencies: [], inputs: [{ name: "aws_region", identity: H("f") }],
    executionManifestSha256: mode === "STATE_DERIVED" ? H("e") : undefined,
    policyVersion: "2026-10-07.1",
  });
  const request: PreviewRequest = {
    engine, mode, target,
    invocation: { operatorId: "jane.doe", interactiveSession: true, confirmedTarget: { ...target }, confirmedAt: "2026-10-10T09:30:00.000Z" },
    manifest, unit, projectRoot,
    capabilities: { cloudRead: true, projectCodeExecution: mode === "PROJECT" },
    policyVersion: "2026-10-07.1",
    resolved: {
      engineVersion: "1.16.5", providers, lockFileSha256: engine === "PULUMI" ? undefined : H("b"),
      dependencies: [], inputs: [{ name: "aws_region", identity: H("f") }],
      executionManifestSha256: mode === "STATE_DERIVED" ? H("e") : undefined,
    },
  };
  const adapter = fakeAdapter(engine, options.behave);
  const parent = fresh("scratch");
  const deps: DriverDeps = {
    adapters: [adapter], qualifications: [qualify(adapter, "1.16.5")], env: { ...ENV },
    now: () => new Date("2026-10-10T10:00:00.000Z"), scratchParent: parent,
  };
  return { request, deps, adapter, parent };
}

/** The request, mutated by `change`, run as a destroy preview. */
const refused = (f: Fixture, code: string, change?: (request: PreviewRequest, deps: DriverDeps) => void) => {
  const request = structuredClone(f.request);
  change?.(request, f.deps);
  const result = runDestroyPreview(request, f.deps);
  assert.equal(result.ok, false, "expected a refusal");
  if (!result.ok) assert.equal(result.code, code, result.message);
  assert.equal(f.adapter.calls.length, 0, "the adapter must not be called");
  assert.deepEqual(readdirSync(f.parent), [], "nothing is left behind");
  return result;
};

// --- Refusals: one test each, adapter never called -------------------------------

test("refused: no human invocation record", () => {
  refused(fixture(), "HUMAN_INVOCATION_REQUIRED", (request) => { delete (request as Partial<PreviewRequest>).invocation; });
});

test("refused: the invocation is not from an interactive session", () => {
  refused(fixture(), "HUMAN_INVOCATION_REQUIRED", (request) => { (request.invocation as { interactiveSession: boolean }).interactiveSession = false; });
});

test("refused: the operator typed a different target than the request resolves", () => {
  for (const key of ["account", "backend", "workspace"] as const) {
    refused(fixture(), "HUMAN_CONFIRMATION_MISMATCH", (request) => { request.invocation.confirmedTarget[key] = "other"; });
  }
});

test("refused: an unknown field of any spelling, at any level", () => {
  for (const name of ["force", "forcePreview", "skipValidation", "ignoreManifest", "override", "allowMismatch", "noLock", "lock"]) {
    refused(fixture(), "UNKNOWN_REQUEST_FIELD", (request) => { (request as unknown as Record<string, unknown>)[name] = true; });
  }
  refused(fixture(), "UNKNOWN_REQUEST_FIELD", (request) => { (request.capabilities as Record<string, unknown>).skipChecks = true; });
  refused(fixture(), "UNKNOWN_REQUEST_FIELD", (request) => { (request.resolved as unknown as Record<string, unknown>).force = true; });
  refused(fixture(), "UNKNOWN_REQUEST_FIELD", (request) => { (request.invocation.confirmedTarget as Record<string, unknown>).ignore = true; });
});

test("refused: the engine has no qualification record", () => {
  const result = refused(fixture(), "ENGINE_NOT_QUALIFIED", (_request, deps) => { deps.qualifications = []; });
  assert.ok(!result.ok && /no qualification record/.test(result.message) && /argv digest/.test(result.message));
});

test("refused: a qualification for another engine version or a changed argv does not count", () => {
  const stale = refused(fixture(), "ENGINE_NOT_QUALIFIED", (_request, deps) => {
    deps.qualifications = [{ ...deps.qualifications[0], engineVersion: "1.15.0" }];
  });
  assert.ok(!stale.ok && /engine version 1\.16\.5/.test(stale.message));
  const changed = refused(fixture(), "ENGINE_NOT_QUALIFIED", (_request, deps) => {
    deps.qualifications = [{ ...deps.qualifications[0], argvDigest: H("0") }];
  });
  assert.ok(!changed.ok && /argument list changed/.test(changed.message));
  const version = refused(fixture(), "ENGINE_NOT_QUALIFIED", (_request, deps) => {
    deps.qualifications = [{ ...deps.qualifications[0], adapterVersion: "0.9.0" }];
  });
  assert.ok(!version.ok && /adapter version 1\.0\.0/.test(version.message));
});

test("refused: project mode without PROJECT_CODE_EXECUTION", () => {
  const result = refused(fixture(), "PROJECT_CODE_EXECUTION_REQUIRED", (request) => { request.capabilities.projectCodeExecution = false; });
  assert.ok(!result.ok && /never permits changing infrastructure/.test(result.message));
});

test("refused: a preview without the CLOUD_READ capability, in either mode", () => {
  for (const mode of ["PROJECT", "STATE_DERIVED"] as const) {
    for (const cloudRead of [false, undefined]) {
      const result = refused(fixture({ mode, engine: mode === "PROJECT" ? "TERRAFORM" : "PULUMI" }), "CLOUD_READ_REQUIRED", (request) => {
        (request.capabilities as { cloudRead?: boolean }).cloudRead = cloudRead;
      });
      assert.ok(!result.ok && /cloudRead/.test(result.message) && /never permits changing infrastructure/.test(result.message));
    }
  }
});

test("the project-code denial names the field and says where the approval comes from", () => {
  const result = refused(fixture(), "PROJECT_CODE_EXECUTION_REQUIRED", (request) => { request.capabilities.projectCodeExecution = false; });
  assert.ok(!result.ok && /capabilities\.projectCodeExecution/.test(result.message) && /second prompt/.test(result.message));
});

test("refused: an identity is not configured, and neither stands in for the other", () => {
  refused(fixture(), "IDENTITY_NOT_CONFIGURED", (_request, deps) => { deps.env = { ALZ_DISCOVERY_AWS_ACCESS_KEY_ID: "d" }; });
  refused(fixture(), "IDENTITY_NOT_CONFIGURED", (_request, deps) => { deps.env = { ALZ_STATE_AWS_ACCESS_KEY_ID: "s" }; });
  // The operator's own credentials are not an identity.
  refused(fixture(), "IDENTITY_NOT_CONFIGURED", (_request, deps) => { deps.env = { AWS_ACCESS_KEY_ID: "operator", AWS_SECRET_ACCESS_KEY: "operator" }; });
});

test("refused: the two identities share a secret", () => {
  const result = refused(fixture(), "IDENTITY_COLLAPSED", (_request, deps) => {
    deps.env = { ALZ_DISCOVERY_AWS_SECRET_ACCESS_KEY: "shared-secret-value", ALZ_STATE_AWS_SECRET_ACCESS_KEY: "shared-secret-value", ...ENV };
  });
  assert.ok(!result.ok && result.message.includes("AWS_SECRET_ACCESS_KEY") && !result.message.includes("shared-secret-value"));
});

test("refused: a forbidden identity variable is exported", () => {
  const result = refused(fixture(), "IDENTITY_FORBIDDEN", (_request, deps) => { deps.env = { ...ENV, ALZ_DEPLOY_AWS_ACCESS_KEY_ID: "deploy-secret" }; });
  assert.ok(!result.ok && result.message.includes("ALZ_DEPLOY_AWS_ACCESS_KEY_ID") && !result.message.includes("deploy-secret"));
});

test("refused: the deletion unit is tampered with", () => {
  refused(fixture(), "UNIT_INVALID", (request) => { request.unit.plannedCreates = ["aws_s3_bucket.other"]; });
});

test("refused: the request targets a different state container than the unit recorded", () => {
  for (const change of [
    (request: PreviewRequest) => { request.target.workspace = "staging"; request.invocation.confirmedTarget.workspace = "staging"; },
    (request: PreviewRequest) => { request.target.backend = "s3://elsewhere/x"; request.invocation.confirmedTarget.backend = "s3://elsewhere/x"; },
  ]) refused(fixture(), "UNIT_TARGET_MISMATCH", change);
});

test("refused: the unit belongs to a different engine than the request", () => {
  refused(fixture(), "UNIT_TARGET_MISMATCH", (request, deps) => {
    // OpenTofu is qualified and shares the Terraform state location, so only the engine differs.
    const tofu = fakeAdapter("OPENTOFU");
    deps.adapters = [tofu];
    deps.qualifications = [qualify(tofu, "1.16.5")];
    request.engine = "OPENTOFU";
  });
});

test("refused: an ordinary preview in state-derived mode", () => {
  const f = fixture({ engine: "PULUMI", mode: "STATE_DERIVED" });
  const result = runPreview(f.request, f.deps);
  assert.ok(!result.ok && result.code === "MODE_NOT_SUPPORTED");
  assert.equal(f.adapter.calls.length, 0);
});

test("refused: an unsealed or tampered manifest", () => {
  refused(fixture(), "MANIFEST_INVALID", (request) => { delete (request.manifest as Partial<typeof request.manifest>).manifestHash; });
  refused(fixture(), "MANIFEST_INVALID", (request) => { request.manifest.policyVersion = "tampered"; });
});

test("refused: any input differing from the approved manifest needs a new review, naming the field", () => {
  const cases: Array<[string, (request: PreviewRequest, deps: DriverDeps) => void]> = [
    // A qualification for the new version exists, so only the manifest stands in the way.
    ["engineVersion", (request, deps) => { request.resolved.engineVersion = "1.17.0"; deps.qualifications = [{ ...deps.qualifications[0], engineVersion: "1.17.0" }]; }],
    ["providers", (request) => { request.resolved.providers = [{ source: "registry.terraform.io/hashicorp/aws", version: "7.0.0" }]; }],
    ["lockFileSha256", (request) => { request.resolved.lockFileSha256 = H("c"); }],
    ["inputs", (request) => { request.resolved.inputs = []; }],
    ["policyVersion", (request) => { request.policyVersion = "2026-11-01.1"; }],
  ];
  for (const [field, change] of cases) {
    const result = refused(fixture(), "REVIEW_REQUIRED", change);
    assert.ok(!result.ok && result.fields?.includes(field), field);
  }
});

test("refused: a project file changed since the manifest was approved, or one was added", () => {
  const edited = fixture();
  writeFileSync(join(edited.request.projectRoot, "main.tf"), 'resource "aws_s3_bucket" "logs" { force_destroy = true }\n');
  const one = runDestroyPreview(edited.request, edited.deps);
  assert.ok(!one.ok && one.code === "REVIEW_REQUIRED" && one.fields?.includes("files"));
  const added = fixture();
  writeFileSync(join(added.request.projectRoot, "extra.tf"), "# new\n");
  const two = runDestroyPreview(added.request, added.deps);
  assert.ok(!two.ok && two.code === "REVIEW_REQUIRED" && two.fields?.includes("files"));
  assert.equal(edited.adapter.calls.length + added.adapter.calls.length, 0);
  assert.deepEqual(readdirSync(edited.parent), []);
});

test("refused: the project holds a state file or a link, so it cannot be snapshotted", () => {
  const withState = fixture();
  writeFileSync(join(withState.request.projectRoot, "terraform.tfstate"), "{}");
  const one = runDestroyPreview(withState.request, withState.deps);
  assert.ok(!one.ok && one.code === "SNAPSHOT_REFUSED" && /STATE_OR_PLAN_FILE/.test(one.message));
  const withLink = fixture();
  symlinkSync("/etc/hostname", join(withLink.request.projectRoot, "link.tf"));
  const two = runDestroyPreview(withLink.request, withLink.deps);
  assert.ok(!two.ok && two.code === "SNAPSHOT_REFUSED");
  assert.equal(withState.adapter.calls.length + withLink.adapter.calls.length, 0);
});

test("refused: the snapshot is altered after it was made, caught by verifying again right before the run", () => {
  const f = fixture();
  let created: string | undefined;
  f.deps.createSnapshot = (root, manifest, parent) => {
    const snapshot = createImmutableSnapshot(root, manifest, parent);
    const file = join(snapshot.path, "main.tf");
    chmodSync(file, 0o600);
    writeFileSync(file, "# swapped after the copy\n");
    created = dirname(snapshot.path);
    return snapshot;
  };
  const result = runDestroyPreview(f.request, f.deps);
  assert.ok(!result.ok && result.code === "SNAPSHOT_CHANGED");
  assert.equal(f.adapter.calls.length, 0);
  assert.ok(created && !existsSync(created), "the snapshot is removed");
  assert.deepEqual(readdirSync(f.parent), []);
});

// --- Happy paths ------------------------------------------------------------------

test("a destroy preview runs the adapter on a private snapshot and returns validated, bound evidence", () => {
  const f = fixture();
  let seen: { snapshotMode: number; scratchMode: number; files: string[]; scratchEmpty: boolean } | undefined;
  f.adapter.destroyPreview = ((request: PreviewRequest, context: AdapterContext) => {
    f.adapter.calls.push({ operation: "DESTROY_PREVIEW", context });
    seen = {
      snapshotMode: statSync(context.snapshotPath!).mode & 0o777,
      scratchMode: statSync(context.scratchDir).mode & 0o777,
      files: readdirSync(context.snapshotPath!).sort(),
      scratchEmpty: readdirSync(context.scratchDir).length === 0,
    };
    assert.deepEqual(context.identities, { providerReads: "DISCOVERY", stateReads: "STATE" });
    return buildEvidence({
      request, operation: "DESTROY_PREVIEW",
      adapter: { engine: "TERRAFORM", adapterVersion: f.adapter.adapterVersion, argvDigest: f.adapter.argvDigest },
      observedEngineVersion: "1.16.5",
      resources: [{ address: ADDRESS, type: "aws_s3_bucket", operation: "DELETE" }],
      stateVersion: { kind: "TERRAFORM_SERIAL", value: "42", observedAt: "2026-10-10T09:00:00.000Z" },
    });
  }) as EngineAdapter["destroyPreview"];
  const result = runDestroyPreview(f.request, f.deps);
  assert.ok(result.ok);
  assert.equal(f.adapter.calls.length, 1);
  assert.deepEqual(seen!.files, [".terraform.lock.hcl", "main.tf"]);
  assert.equal(seen!.snapshotMode, 0o500);
  assert.equal(seen!.scratchMode, 0o700);
  assert.ok(seen!.scratchEmpty);
  assert.equal(result.preview?.verdict, "READY_FOR_AUTHORIZATION");
  const evidence = result.evidence;
  assert.equal(evidence.operation, "DESTROY_PREVIEW");
  assert.equal(evidence.label, "ARTIFACT_VALIDATED_DESTROY_PREVIEW");
  assert.equal(evidence.verdict, "READY_FOR_AUTHORIZATION");
  assert.equal(evidence.hashes.manifestHash, f.request.manifest.manifestHash);
  assert.equal(evidence.hashes.unitHash, f.request.unit.unitHash);
  assert.equal(evidence.hashes.changeSetHash, result.preview?.destroyChangeSetHash);
  assert.deepEqual(evidence.stateVersion, { kind: "TERRAFORM_SERIAL", value: "42", observedAt: "2026-10-10T09:00:00.000Z" });
  assert.equal(evidence.toolVersions.engine, "1.16.5");
  assert.deepEqual(evidence.invokedBy, { operatorId: "jane.doe", confirmedAt: "2026-10-10T09:30:00.000Z" });
  assert.equal(evidence.startedAt, "2026-10-10T10:00:00.000Z");
  assert.deepEqual(evidence.authority, { infrastructureAct: "DISABLED", mutation: "NONE", executionMode: "PREVIEW_ONLY", agentInitiated: false });
  assert.deepEqual(evidenceProblems(evidence), []);
  // Snapshot and scratch are gone, and the source was never the run directory.
  assert.deepEqual(readdirSync(f.parent), []);
  assert.notEqual(f.adapter.calls[0].context.snapshotPath, f.request.projectRoot);
});

test("the state version is recorded beside the manifest: two state versions share one manifest hash", () => {
  const at = (serial: string) => {
    const f = fixture({ behave: (request, operation) => buildEvidence({
      request, operation, adapter: { engine: "TERRAFORM", adapterVersion: "1.0.0", argvDigest: argvDigest([["fake", "TERRAFORM", "plan"]]) },
      observedEngineVersion: "1.16.5", resources: [{ address: ADDRESS, type: "aws_s3_bucket", operation: "DELETE" }],
      stateVersion: { kind: "TERRAFORM_SERIAL", value: serial, observedAt: "2026-10-10T09:00:00.000Z" },
    }) });
    const result = runDestroyPreview(f.request, f.deps);
    assert.ok(result.ok);
    return result.evidence;
  };
  const one = at("41");
  const two = at("42");
  assert.equal(one.hashes.manifestHash, two.hashes.manifestHash);
  assert.notEqual(one.stateVersion.value, two.stateVersion.value);
});

test("an ordinary preview is a separate operation and carries no destroy verdict", () => {
  const f = fixture();
  const result = runPreview(f.request, f.deps);
  assert.ok(result.ok);
  assert.equal(f.adapter.calls[0].operation, "PREVIEW");
  assert.equal(result.evidence.operation, "PREVIEW");
  assert.equal(result.evidence.verdict, null);
  assert.equal(result.preview, undefined);
  assert.equal(result.evidence.label, "ARTIFACT_VALIDATED_DESTROY_PREVIEW");
});

test("a destroy plan that deletes outside the unit is BLOCKED by the existing gate, not by the driver", () => {
  const f = fixture({ behave: (request, operation) => buildEvidence({
    request, operation, adapter: { engine: "TERRAFORM", adapterVersion: "1.0.0", argvDigest: argvDigest([["fake", "TERRAFORM", "plan"]]) },
    observedEngineVersion: "1.16.5",
    resources: [{ address: ADDRESS, type: "aws_s3_bucket", operation: "DELETE" }, { address: "aws_s3_bucket.customer", type: "aws_s3_bucket", operation: "DELETE" }],
    stateVersion: { kind: "ETAG", value: "abc", observedAt: "2026-10-10T09:00:00.000Z" },
  }) });
  const result = runDestroyPreview(f.request, f.deps);
  assert.ok(result.ok);
  assert.equal(result.preview?.verdict, "BLOCKED");
  assert.equal(result.evidence.verdict, "BLOCKED");
  assert.ok(result.preview?.reasons.some((reason) => reason.startsWith("DELETE_OUTSIDE_UNIT")));
});

test("a state-derived Pulumi destroy preview runs no project: no snapshot, and the label says what was bound", () => {
  const f = fixture({ engine: "PULUMI", mode: "STATE_DERIVED" });
  const result = runDestroyPreview(f.request, f.deps);
  assert.ok(result.ok, result.ok ? "" : result.message);
  assert.equal(f.adapter.calls[0].context.snapshotPath, null);
  assert.equal(result.evidence.mode, "STATE_DERIVED");
  assert.equal(result.evidence.label, "ARTIFACT_VALIDATED_DESTROY_PREVIEW");
  // PROJECT_CODE_EXECUTION is not needed when no project runs.
  assert.equal(f.request.capabilities.projectCodeExecution, false);
  assert.deepEqual(readdirSync(f.parent), []);
});

// --- Cleanup ------------------------------------------------------------------------

test("snapshot and scratch are removed when the adapter throws, and its message is withheld", () => {
  let scratchDir = "";
  let snapshotDir = "";
  const f = fixture({ behave: (_request, _operation, context) => {
    scratchDir = context.scratchDir;
    snapshotDir = context.snapshotPath!;
    writeFileSync(join(context.scratchDir, "plan.tfplan"), CANARY_STATE_SECRET);
    throw new Error("terraform failed: " + CANARY_STATE_SECRET);
  } });
  const result = runDestroyPreview(f.request, f.deps);
  assert.ok(!result.ok && result.code === "ADAPTER_FAILED");
  assert.equal(JSON.stringify(result).includes(CANARY_STATE_SECRET), false);
  assert.equal(f.adapter.calls.length, 1);
  assert.ok(scratchDir && snapshotDir);
  assert.equal(existsSync(scratchDir), false);
  assert.equal(existsSync(dirname(snapshotDir)), false);
  assert.deepEqual(readdirSync(f.parent), []);
});

test("snapshot and scratch are removed when the evidence is rejected", () => {
  const f = fixture({ behave: (request, operation) => ({
    ...buildEvidence({ request, operation, adapter: { engine: "TERRAFORM", adapterVersion: "1.0.0", argvDigest: argvDigest([["fake", "TERRAFORM", "plan"]]) },
      observedEngineVersion: "1.16.5", resources: [], stateVersion: { kind: "OTHER", value: "x", observedAt: "2026-10-10T09:00:00.000Z" } }),
    resource_changes: [{ change: { before: { password: CANARY_PLAN_SECRET } } }],
  } as PreviewEvidence) });
  const result = runDestroyPreview(f.request, f.deps);
  assert.ok(!result.ok && result.code === "EVIDENCE_REJECTED");
  assert.equal(JSON.stringify(result).includes(CANARY_PLAN_SECRET), false);
  assert.deepEqual(readdirSync(f.parent), []);
});

// --- Evidence the driver will not accept ---------------------------------------------

test("evidence that does not match the validated run is rejected", () => {
  const descriptor = { engine: "TERRAFORM" as const, adapterVersion: "1.0.0", argvDigest: argvDigest([["fake", "TERRAFORM", "plan"]]) };
  const base = (request: PreviewRequest, operation: PreviewOperation) => buildEvidence({
    request, operation, adapter: descriptor, observedEngineVersion: "1.16.5",
    resources: [{ address: ADDRESS, type: "aws_s3_bucket", operation: "DELETE" }],
    stateVersion: { kind: "ETAG", value: "abc", observedAt: "2026-10-10T09:00:00.000Z" },
  });
  const tampers: Array<[string, (e: PreviewEvidence) => PreviewEvidence]> = [
    ["another manifest", (e) => ({ ...e, hashes: { ...e.hashes, manifestHash: H("1") } })],
    ["another unit", (e) => ({ ...e, hashes: { ...e.hashes, unitHash: H("2") } })],
    ["an engine version the validation did not see", (e) => ({ ...e, toolVersions: { ...e.toolVersions, engine: "1.99.0" } })],
    ["another adapter digest", (e) => ({ ...e, adapter: { ...e.adapter, argvDigest: H("3") } })],
    ["a change set whose hash was edited", (e) => ({ ...e, changes: { ...e.changes, evidenceHash: H("4") }, hashes: { ...e.hashes, changeSetHash: H("4") } })],
    ["a change set whose counts were edited", (e) => ({ ...e, changes: { ...e.changes, deletes: 0 } })],
    ["the wrong operation", (e) => ({ ...e, operation: "PREVIEW" })],
    ["a lying authority field", (e) => ({ ...e, authority: { ...e.authority, mutation: "APPLY" } as never })],
  ];
  for (const [label, tamper] of tampers) {
    const f = fixture({ behave: (request, operation) => tamper(base(request, operation)) });
    const result = runDestroyPreview(f.request, f.deps);
    // The authority field is caught by the driver overwriting it; every other tamper is rejected.
    if (label === "a lying authority field") {
      assert.ok(result.ok && result.evidence.authority.mutation === "NONE", label);
    } else {
      assert.ok(!result.ok && result.code === "EVIDENCE_REJECTED", label);
    }
    assert.deepEqual(readdirSync(f.parent), [], label);
  }
});

// --- Canaries -------------------------------------------------------------------------

const RAW_PLAN = JSON.stringify({
  format_version: "1.2",
  prior_state: { values: { root_module: { resources: [{ address: ADDRESS, values: { token: CANARY_STATE_SECRET } }] } } },
  resource_changes: [{
    address: ADDRESS, type: "aws_s3_bucket",
    change: { actions: ["delete"], before: { password: CANARY_PLAN_SECRET }, before_sensitive: { password: true }, after: null },
  }],
});

test("canary secrets in the raw plan and state never reach the evidence or the result", () => {
  const f = fixture({ behave: (request, operation) => {
    const changes = normalizeTerraformPlan(RAW_PLAN); // what an adapter does with show -json output
    return buildEvidence({
      request, operation, adapter: { engine: "TERRAFORM", adapterVersion: "1.0.0", argvDigest: argvDigest([["fake", "TERRAFORM", "plan"]]) },
      observedEngineVersion: "1.16.5", resources: changes.resources,
      stateVersion: { kind: "TERRAFORM_SERIAL", value: "7", observedAt: "2026-10-10T09:00:00.000Z" },
    });
  } });
  const result = runDestroyPreview(f.request, f.deps);
  assert.ok(result.ok);
  const text = JSON.stringify(result);
  for (const canary of [CANARY_PLAN_SECRET, CANARY_STATE_SECRET, "prior_state", "before_sensitive"]) {
    assert.equal(text.includes(canary), false, canary);
  }
  assert.doesNotThrow(() => assertNoRawPayload(result.evidence, [CANARY_PLAN_SECRET, CANARY_STATE_SECRET]));
  assert.deepEqual(result.evidence.changes.resources, [{ address: ADDRESS, type: "aws_s3_bucket", operation: "DELETE" }]);
});

test("the proof catches raw plan or state content however it is smuggled in", () => {
  const f = fixture();
  const clean = buildEvidence({
    request: f.request, operation: "DESTROY_PREVIEW",
    adapter: { engine: "TERRAFORM", adapterVersion: "1.0.0", argvDigest: H("a") }, observedEngineVersion: "1.16.5",
    resources: [{ address: ADDRESS, type: "aws_s3_bucket", operation: "DELETE" }],
    stateVersion: { kind: "OTHER", value: "x", observedAt: "2026-10-10T09:00:00.000Z" },
  });
  assert.deepEqual(evidenceProblems(clean), []);
  const smuggled: Array<[string, unknown, string[]]> = [
    ["an extra top-level raw field", { ...clean, prior_state: { v: CANARY_STATE_SECRET } }, []],
    ["a nested raw field", { ...clean, changes: { ...clean.changes, resources: [{ ...clean.changes.resources[0], before: { p: CANARY_PLAN_SECRET } }] } }, []],
    ["a JSON document in an address", { ...clean, changes: { ...clean.changes, resources: [{ address: '{"p":"' + CANARY_PLAN_SECRET + '"}', operation: "DELETE" }] } }, []],
    ["a value riding in an address", { ...clean, changes: { ...clean.changes, resources: [{ address: "aws_db.main,password=" + CANARY_PLAN_SECRET, operation: "DELETE" }] } }, []],
    ["a value riding in a type", { ...clean, changes: { ...clean.changes, resources: [{ address: ADDRESS, type: "aws db " + CANARY_PLAN_SECRET, operation: "DELETE" }] } }, []],
    ["a long blob in a version", { ...clean, toolVersions: { ...clean.toolVersions, engine: "x".repeat(600) } }, []],
    ["a JSON document in a string field", { ...clean, policyVersion: JSON.stringify({ state: CANARY_STATE_SECRET }) }, []],
    ["a known secret in an allowed field", { ...clean, invokedBy: { ...clean.invokedBy, operatorId: CANARY_PLAN_SECRET } }, [CANARY_PLAN_SECRET]],
  ];
  for (const [label, evidence, canaries] of smuggled) {
    assert.notDeepEqual(evidenceProblems(evidence, canaries), [], label);
    assert.throws(() => assertNoRawPayload(evidence, canaries), /EVIDENCE_REJECTED/, label);
  }
});

// --- Qualification -----------------------------------------------------------------------

test("qualification: each engine is judged alone, and an unqualified engine never holds back a qualified one", () => {
  const terraform = fakeAdapter("TERRAFORM");
  const opentofu = fakeAdapter("OPENTOFU");
  const pulumi = fakeAdapter("PULUMI");
  const versions = { TERRAFORM: "1.16.5", OPENTOFU: "1.10.0", PULUMI: "3.150.0" };
  const only = (...records: QualificationRecord[]) => enabledEngines(records, [terraform, opentofu, pulumi], versions);
  const state = (activations: ReturnType<typeof only>) => Object.fromEntries(activations.map((a) => [a.engine, a.enabled]));

  assert.deepEqual(state(only()), { TERRAFORM: false, OPENTOFU: false, PULUMI: false });
  assert.deepEqual(state(only(qualify(terraform, "1.16.5"))), { TERRAFORM: true, OPENTOFU: false, PULUMI: false });
  assert.deepEqual(state(only(qualify(terraform, "1.16.5"), qualify(pulumi, "3.150.0"))), { TERRAFORM: true, OPENTOFU: false, PULUMI: true });
  // A bad record for one engine disables that engine only.
  const broken = { ...qualify(opentofu, "1.10.0"), argvDigest: "not-a-digest" };
  assert.deepEqual(state(only(qualify(terraform, "1.16.5"), broken)), { TERRAFORM: true, OPENTOFU: false, PULUMI: false });
  // A record for engine A never enables engine B.
  assert.deepEqual(state(only({ ...qualify(terraform, "1.16.5"), engine: "PULUMI" })), { TERRAFORM: false, OPENTOFU: false, PULUMI: false });
  // No adapter registered: disabled, with a reason that says so.
  const missing = enabledEngines([qualify(terraform, "1.16.5")], [terraform], versions).find((a) => a.engine === "PULUMI");
  assert.ok(missing && !missing.enabled && /no adapter is registered/.test(missing.reason));
  // The reason for an unqualified engine names what is missing.
  const reason = only().find((a) => a.engine === "PULUMI");
  assert.ok(reason && !reason.enabled && reason.reason.includes(pulumi.argvDigest) && reason.reason.includes("3.150.0"));
});

test("qualification: the driver runs the qualified engine while another engine is unqualified", () => {
  const f = fixture();
  const pulumi = fakeAdapter("PULUMI");
  f.deps.adapters = [pulumi, f.adapter]; // PULUMI has an adapter and no record
  const result = runDestroyPreview(f.request, f.deps);
  assert.ok(result.ok);
  assert.equal(f.adapter.calls.length, 1);
  assert.equal(pulumi.calls.length, 0);
  // And the unqualified one is refused on its own account.
  const p = fixture({ engine: "PULUMI", mode: "STATE_DERIVED" });
  p.deps.qualifications = [qualify(f.adapter, "1.16.5")];
  const refusal = runDestroyPreview(p.request, p.deps);
  assert.ok(!refusal.ok && refusal.code === "ENGINE_NOT_QUALIFIED");
});

test("an adapter pins its argv by digest, and the digest changes when the argv does", () => {
  const one = argvDigest([["terraform", "plan", "-input=false"]]);
  assert.match(one, /^[a-f0-9]{64}$/);
  assert.equal(one, argvDigest([["terraform", "plan", "-input=false"]]));
  assert.notEqual(one, argvDigest([["terraform", "plan", "-input=false", "-refresh=false"]]));
  assert.notEqual(one, argvDigest([["terraform", "plan"], ["-input=false"]]));
});

// --- Source-level boundary ----------------------------------------------------------------

const DRIVER_DIR = resolve("src/teardown/driver");
const driverSources = () => readdirSync(DRIVER_DIR).filter((name) => name.endsWith(".ts"))
  .map((name) => [name, readFileSync(join(DRIVER_DIR, name), "utf8")] as const);

test("the core has no bypass, no lock switch, no process execution and no mutation argument", () => {
  // "target" is a request field here, so only its flag spelling is forbidden.
  const FORBIDDEN_LITERAL = /^(-{0,2}(apply|destroy|up|deploy|auto-approve|yes)|-{1,2}(target|replace))(=.*)?$/;
  for (const [name, code] of driverSources()) {
    assert.doesNotMatch(code, /\b(force|skip|ignore|bypass|override)\w*/i, name);
    assert.doesNotMatch(code, /-lock\b|lock=false/, name);
    assert.doesNotMatch(code, /child_process|runBoundedProcess|runAllowlistedProcess|spawn|exec\(/, name);
    for (const match of code.matchAll(/"([^"\n]{1,60})"/g)) {
      assert.doesNotMatch(match[1].toLowerCase(), FORBIDDEN_LITERAL, name + ': "' + match[1] + '"');
    }
  }
});

test("the driver is not reachable from the tool broker", () => {
  for (const name of readdirSync(resolve("src/tools"))) {
    if (!name.endsWith(".ts")) continue;
    assert.doesNotMatch(readFileSync(join(resolve("src/tools"), name), "utf8"), /teardown\/driver/, name);
  }
});

// --- Cleanup, and a project that changes under the run ---------------------------------------

const defaultEvidence = (request: PreviewRequest, operation: PreviewOperation, adapter: EngineAdapter) => buildEvidence({
  request, operation, adapter: { engine: adapter.engine, adapterVersion: adapter.adapterVersion, argvDigest: adapter.argvDigest }, observedEngineVersion: request.resolved.engineVersion,
  resources: [{ address: ADDRESS, type: "aws_s3_bucket", operation: "DELETE" }],
  stateVersion: { kind: "TERRAFORM_SERIAL", value: "42", observedAt: "2026-10-10T09:00:00.000Z" },
});

test("a snapshot that changed while the adapter ran withholds the result", () => {
  let self: EngineAdapter | undefined;
  const f = fixture({
    behave: (request, operation, context) => {
      // What project code running as the same user could do to a read-only snapshot.
      chmodSync(context.snapshotPath as string, 0o700);
      chmodSync(join(context.snapshotPath as string, "main.tf"), 0o600);
      writeFileSync(join(context.snapshotPath as string, "main.tf"), "# rewritten while the preview ran\n");
      return defaultEvidence(request, operation, self as EngineAdapter);
    },
  });
  self = f.adapter;
  const result = runDestroyPreview(f.request, f.deps);
  assert.ok(!result.ok && result.code === "SNAPSHOT_CHANGED", JSON.stringify(result));
  assert.equal(f.adapter.calls.length, 1);
  assert.deepEqual(readdirSync(f.parent), [], "the changed snapshot is removed too");
});

test("evidence whose invokedBy differs from the invocation record is rejected", () => {
  let self: EngineAdapter | undefined;
  const f = fixture({
    behave: (request, operation) => ({
      ...defaultEvidence(request, operation, self as EngineAdapter),
      invokedBy: { operatorId: "someone.else", confirmedAt: request.invocation.confirmedAt },
    }),
  });
  self = f.adapter;
  const result = runDestroyPreview(f.request, f.deps);
  assert.ok(!result.ok && result.code === "EVIDENCE_REJECTED" && /invokedBy/.test(result.message), JSON.stringify(result));
});

test("the scratch directory and snapshot are registered for signal cleanup while the adapter runs", () => {
  const seen: { scratch?: string; snapshot?: string | null; failed?: number; held?: boolean } = {};
  let self: EngineAdapter | undefined;
  const f = fixture({
    behave: (request, operation, context) => {
      seen.scratch = context.scratchDir;
      seen.snapshot = context.snapshotPath;
      writeFileSync(join(context.scratchDir, "alz-preview.tfplan"), "plaintext plan " + CANARY_PLAN_SECRET);
      // What the CLI's signal handlers do.
      seen.failed = runCleanups();
      assert.equal(existsSync(context.scratchDir), false, "scratch (and the plan file in it) is gone");
      assert.equal(existsSync(context.snapshotPath as string), false, "the snapshot is gone");
      seen.held = true;
      return defaultEvidence(request, operation, self as EngineAdapter);
    },
  });
  self = f.adapter;
  // Cleanup ran under the driver's feet, so there is no valid snapshot left to return a result for.
  assert.equal(runDestroyPreview(f.request, f.deps).ok, false);
  assert.equal(seen.held, true, "the assertions inside the adapter held");
  assert.equal(seen.failed, 0);
  assert.ok(seen.scratch && seen.snapshot);
  assert.deepEqual(readdirSync(f.parent), []);
});

test("read-only directories left by the adapter do not stop the scratch tree from being removed", () => {
  let self: EngineAdapter | undefined;
  const f = fixture({
    behave: (request, operation, context) => {
      mkdirSync(join(context.scratchDir, "ro", "deeper"), { recursive: true });
      writeFileSync(join(context.scratchDir, "ro", "deeper", "x"), "x");
      chmodSync(join(context.scratchDir, "ro", "deeper"), 0o500);
      chmodSync(join(context.scratchDir, "ro"), 0o500);
      return defaultEvidence(request, operation, self as EngineAdapter);
    },
  });
  self = f.adapter;
  assert.equal(runDestroyPreview(f.request, f.deps).ok, true);
  assert.deepEqual(readdirSync(f.parent), []);
});
