import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { createHash } from "node:crypto";

import { createChangeSet } from "../src/iac/changeset.js";
import { normalizeTerraformPlan } from "../src/iac/terraform-plan.js";
import { dangerousPreviewCommand } from "../src/qualification/provider-production.js";
import {
  ADAPTER_IDENTITIES,
  assertNoRawPayload,
  runDestroyPreview,
  runPreview,
  type AdapterContext,
  type DriverEngine,
  type PreviewRequest,
  type QualificationRecord,
} from "../src/teardown/driver/index.js";
import {
  DESTROY_PREVIEW_PLAN_ARGV,
  INIT_ARGV,
  LARGE_OUTPUT_BYTES,
  PREVIEW_PLAN_ARGV,
  SHOW_ARGV,
  STATE_PULL_ARGV,
  VERSION_ARGV,
  WORKSPACE_SHOW_ARGV,
  createTerraformAdapter,
  isAllowedArgv,
  isAllowedDestroyPreviewArgv,
  terraformArgvDigest,
  workspaceSelectArgv,
  type TerraformEngine,
} from "../src/teardown/driver/adapters/terraform.js";
import { buildManifest } from "../src/teardown/manifest.js";
import { captureProjectFiles, createImmutableSnapshot, type ImmutableSnapshot } from "../src/teardown/snapshot.js";
import { recordDeletionUnit } from "../src/teardown/unit.js";
import { approvedToolDirs, resolveExecutable } from "../src/tools/child-env.js";
import { runBoundedProcess } from "../src/tools/process.js";
import { createPrivateDirectory } from "../src/tools/private-workdir.js";
import { PROFILES } from "../src/tools/profiles.js";
import type { ToolResult } from "../src/tools/types.js";

// docs/destroy-preview-driver.md, "Terraform and OpenTofu adapter". The engine
// here is a fake executable (a node script named terraform or tofu) that
// records its argument list, working directory and environment to a file and
// answers with canned output seeded with canary secrets, so what the adapter
// ran and what it kept can both be observed.

const root = mkdtempSync(join(tmpdir(), "alz-tf-adapter-"));
test.after(() => {
  const open = (path: string) => {
    try {
      chmodSync(path, 0o700);
      if (statSync(path).isDirectory()) for (const name of readdirSync(path)) open(join(path, name));
    } catch { /* best effort */ }
  };
  open(root);
  rmSync(root, { recursive: true, force: true });
});
let counter = 0;
const fresh = (label: string) => {
  const dir = join(root, label + "-" + ++counter);
  mkdirSync(dir, { recursive: true });
  return dir;
};

const CANARIES = ["CANARY_VAR_7a1", "CANARY_STATE_PW_7a2", "CANARY_BEFORE_7a3", "CANARY_TAG_7a4", "CANARY_LINEAGE_7a5", "CANARY_OUTPUT_7a6", "CANARY_STDERR_7a7"];

/** The fake engine. Behavior is read from behavior.json on every call so a test can change it. */
const FAKE = `#!${process.execPath}
const fs = require("fs"), path = require("path");
const dir = __dirname;
const b = JSON.parse(fs.readFileSync(path.join(dir, "behavior.json"), "utf8"));
const args = process.argv.slice(2);
const rec = { exe: path.basename(process.argv[1]), args, cwd: process.cwd(), env: process.env };
const log = (extra) => fs.appendFileSync(path.join(dir, "calls.jsonl"), JSON.stringify({ ...rec, ...extra }) + "\\n");
const [cmd, sub] = args;
if (b.failOn === cmd) { log({ failed: true }); process.stderr.write("boom " + ${JSON.stringify(CANARIES[6])}); process.exit(1); }
if (cmd === "version") { log({}); process.stdout.write(JSON.stringify({ terraform_version: b.version })); }
else if (cmd === "init") {
  fs.mkdirSync(".terraform", { recursive: true });
  fs.writeFileSync(".terraform/terraform.tfstate", "{}");
  for (const w of b.initWrites || []) { fs.mkdirSync(path.dirname(w.path), { recursive: true }); fs.writeFileSync(w.path, w.content); }
  log({});
}
else if (cmd === "workspace") { log({}); if (sub === "show") process.stdout.write(b.workspace + "\\n"); }
else if (cmd === "state") {
  log({});
  const planned = fs.existsSync(path.resolve(process.cwd(), "../alz-preview.tfplan"));
  process.stdout.write(JSON.stringify({ version: 4, serial: planned && b.serialAfterPlan !== undefined ? b.serialAfterPlan : b.serial, lineage: ${JSON.stringify(CANARIES[4])}, outputs: { o: { value: ${JSON.stringify(CANARIES[5])} } }, resources: [] }));
}
else if (cmd === "plan") {
  const out = args.find((a) => a.startsWith("-out=")).slice(5);
  const p = path.resolve(process.cwd(), out);
  fs.writeFileSync(p, "BINARY-PLAN " + ${JSON.stringify(CANARIES[1])});
  log({ planPath: p });
}
else if (cmd === "show") {
  const p = path.resolve(process.cwd(), args[2]);
  log({ planPath: p, planExists: fs.existsSync(p) });
  if (b.hugeBytes) { process.stdout.write("x".repeat(b.hugeBytes)); }
  else {
    const plan = {
      format_version: "1.2", terraform_version: b.version, errored: false,
      variables: { db_password: { value: ${JSON.stringify(CANARIES[0])} } },
      prior_state: { values: { root_module: { resources: [{ address: "aws_db_instance.main", values: { password: ${JSON.stringify(CANARIES[1])} } }] } } },
      resource_changes: [
        { address: "aws_db_instance.main", type: "aws_db_instance", change: { actions: ["delete"], before: { password: ${JSON.stringify(CANARIES[2])} }, after: null } },
        { address: "aws_s3_bucket.logs", type: "aws_s3_bucket", change: { actions: ["delete"], before: { tags: { k: ${JSON.stringify(CANARIES[3])} } }, after: null } },
      ],
    };
    if (b.padBytes) plan.padding = "p".repeat(b.padBytes);
    process.stdout.write(JSON.stringify(plan));
  }
}
else { log({ unexpected: true }); process.exit(2); }
`;

const toolDir = fresh("tools");
for (const name of ["terraform", "tofu"]) {
  writeFileSync(join(toolDir, name), FAKE, { mode: 0o755 });
  chmodSync(join(toolDir, name), 0o755);
}
type Behavior = { version?: string; workspace?: string; serial?: number; serialAfterPlan?: number; failOn?: string; initWrites?: Array<{ path: string; content: string }>; hugeBytes?: number; padBytes?: number };
const behave = (behavior: Behavior = {}) => {
  writeFileSync(join(toolDir, "behavior.json"), JSON.stringify({ version: "1.9.5", workspace: "default", serial: 42, ...behavior }));
  rmSync(join(toolDir, "calls.jsonl"), { force: true });
};
type Call = {
  exe: string; args: string[]; cwd: string; env: Record<string, string>; planPath?: string; planExists?: boolean;
};
const calls = (): Call[] => existsSync(join(toolDir, "calls.jsonl"))
  ? readFileSync(join(toolDir, "calls.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line) as Call)
  : [];

const H = (char: string) => char.repeat(64);
const sha = (bytes: string) => createHash("sha256").update(bytes).digest("hex");
const LOCK = '# This file is maintained automatically by "terraform init".\nprovider "registry.terraform.io/hashicorp/aws" {\n  version = "6.68.0"\n}\n';
const LOCATION = "s3://alz-state/prod/terraform.tfstate";
const ENV = {
  ALZ_DISCOVERY_AWS_ACCESS_KEY_ID: "discovery-key-1", ALZ_DISCOVERY_AWS_SECRET_ACCESS_KEY: "discovery-secret-aaaa",
  ALZ_STATE_AWS_ACCESS_KEY_ID: "state-key-2", ALZ_STATE_AWS_SECRET_ACCESS_KEY: "state-secret-bbbb",
  ALZ_NETWORK_HTTPS_PROXY: "http://127.0.0.1:3128",
};
/** What the operator's own shell holds. None of it may reach a child. */
const OPERATOR = {
  HOME: "/home/operator", AWS_ACCESS_KEY_ID: "operator-ambient-key", AWS_SECRET_ACCESS_KEY: "operator-ambient-secret",
  AWS_SESSION_TOKEN: "operator-ambient-token", AWS_PROFILE: "operator", GITHUB_TOKEN: "ghp_operator", TF_VAR_x: "operator-var",
};

type Fixture = {
  request: PreviewRequest; context: AdapterContext; parent: string; snapshot: ImmutableSnapshot; engine: TerraformEngine;
  projectRoot: string; cleanup(): void;
};

function fixture(engine: TerraformEngine = "TERRAFORM", options: { workspace?: string; env?: NodeJS.ProcessEnv } = {}): Fixture {
  behave({ workspace: options.workspace ?? "default" });
  const workspace = options.workspace ?? "default";
  const projectRoot = fresh("project");
  writeFileSync(join(projectRoot, "main.tf"), 'resource "aws_s3_bucket" "logs" {}\nresource "aws_db_instance" "main" {}\n');
  writeFileSync(join(projectRoot, ".terraform.lock.hcl"), LOCK);
  mkdirSync(join(projectRoot, "modules", "net"), { recursive: true });
  writeFileSync(join(projectRoot, "modules", "net", "main.tf"), "# module\n");
  const unit = recordDeletionUnit({
    buildId: "build-1", provider: "aws",
    stateRef: { engine, backend: "s3", location: LOCATION, workspace },
    designHash: H("1"),
    createPlan: createChangeSet(engine, [
      { address: "aws_s3_bucket.logs", type: "aws_s3_bucket", operation: "CREATE" },
      { address: "aws_db_instance.main", type: "aws_db_instance", operation: "CREATE" },
    ]),
    recordedAt: "2026-10-10T08:00:00.000Z",
  });
  const target = { account: "123456789012", backend: LOCATION, workspace };
  const providers = [{ source: "registry.terraform.io/hashicorp/aws", version: "6.68.0" }];
  const manifest = buildManifest({
    engine, mode: "PROJECT", target, unitHash: unit.unitHash, engineVersion: "1.9.5", providers,
    lockFileSha256: sha(LOCK), files: captureProjectFiles(projectRoot), dependencies: [],
    inputs: [{ name: "aws_region", identity: H("f") }], policyVersion: "2026-10-07.1",
  });
  const request: PreviewRequest = {
    engine, mode: "PROJECT", target,
    invocation: { operatorId: "jane.doe", interactiveSession: true, confirmedTarget: { ...target }, confirmedAt: "2026-10-10T09:30:00.000Z" },
    manifest, unit, projectRoot, capabilities: { cloudRead: true, projectCodeExecution: true }, policyVersion: "2026-10-07.1",
    resolved: { engineVersion: "1.9.5", providers, lockFileSha256: sha(LOCK), dependencies: [], inputs: [{ name: "aws_region", identity: H("f") }] },
  };
  const parent = fresh("scratch");
  const snapshot = createImmutableSnapshot(projectRoot, manifest, parent);
  const scratch = createPrivateDirectory("alz-adapter-", parent);
  const context: AdapterContext = {
    snapshotPath: snapshot.path, scratchDir: scratch.path, identities: ADAPTER_IDENTITIES,
    env: options.env ?? { ...OPERATOR, ...ENV },
  };
  return { request, context, parent, snapshot, engine, projectRoot, cleanup: () => { snapshot.remove(); scratch.remove(); } };
}

const adapterFor = (engine: TerraformEngine) => createTerraformAdapter(engine, { toolDirs: [toolDir] });
const failureOf = (run: () => unknown): string => {
  try { run(); } catch (error) { return (error as Error).message; }
  return assert.fail("expected the adapter to throw");
};

test("a destroy preview runs exactly these argument lists, in this order, and nothing else", () => {
  const f = fixture();
  try {
    const evidence = adapterFor("TERRAFORM").destroyPreview(f.request, f.context);
    assert.deepEqual(calls().map((call) => call.args), [
      ["version", "-json"],
      ["init", "-input=false", "-no-color", "-lockfile=readonly"],
      ["workspace", "show"],
      ["state", "pull"],
      ["plan", "-destroy", "-input=false", "-no-color", "-out=../alz-preview.tfplan"],
      ["show", "-json", "../alz-preview.tfplan"],
      // The state version is read again after the plan, to prove the plan was computed against it.
      ["state", "pull"],
    ]);
    assert.deepEqual(calls().map((call) => call.exe), Array(7).fill("terraform"));
    // The constants are the single source of those lists.
    assert.deepEqual(calls().map((call) => call.args),
      [VERSION_ARGV, INIT_ARGV, WORKSPACE_SHOW_ARGV, STATE_PULL_ARGV, DESTROY_PREVIEW_PLAN_ARGV, SHOW_ARGV, STATE_PULL_ARGV]);
    assert.equal(evidence.operation, "DESTROY_PREVIEW");
    assert.equal(evidence.adapter.argvDigest, terraformArgvDigest("TERRAFORM"));
  } finally { f.cleanup(); }
});

test("an ordinary preview is a separate operation: plan without -destroy", () => {
  const f = fixture();
  try {
    const evidence = adapterFor("TERRAFORM").preview(f.request, f.context);
    const argvs = calls().map((call) => call.args);
    assert.deepEqual(argvs[4], ["plan", "-input=false", "-no-color", "-out=../alz-preview.tfplan"]);
    assert.deepEqual(argvs[4], PREVIEW_PLAN_ARGV);
    assert.equal(evidence.operation, "PREVIEW");
    assert.ok(!argvs.flat().includes("-destroy"), "no -destroy anywhere in an ordinary preview");
  } finally { f.cleanup(); }
});

test("a non-default workspace is selected with STATE and verified; a mismatch stops before the plan", () => {
  const f = fixture("TERRAFORM", { workspace: "staging" });
  try {
    adapterFor("TERRAFORM").destroyPreview(f.request, f.context);
    const seen = calls();
    assert.deepEqual(seen.map((call) => call.args.slice(0, 2).join(" ")),
      ["version -json", "init -input=false", "workspace select", "workspace show", "state pull", "plan -destroy", "show -json", "state pull"]);
    assert.deepEqual(seen[2].args, ["workspace", "select", "staging"]);
    assert.equal(seen[2].env.AWS_ACCESS_KEY_ID, "state-key-2");

    behave({ workspace: "prod-other" });
    assert.match(failureOf(() => adapterFor("TERRAFORM").destroyPreview(f.request, f.context)), /WORKSPACE_MISMATCH/);
    assert.ok(!calls().some((call) => call.args[0] === "plan"), "no plan ran against the wrong workspace");
  } finally { f.cleanup(); }
});

test("no run ever carries a lock flag, and locking is therefore the engine default", () => {
  const f = fixture();
  try {
    adapterFor("TERRAFORM").destroyPreview(f.request, f.context);
    adapterFor("TERRAFORM").preview(f.request, f.context);
    for (const call of calls()) {
      assert.ok(!call.args.some((arg) => /^-lock(=|-timeout|$)/.test(arg)), call.args.join(" "));
      assert.ok(!call.args.some((arg) => /^-(refresh|target|replace|var|auto-approve|parallelism)/.test(arg)), call.args.join(" "));
    }
  } finally { f.cleanup(); }
});

test("identities arrive as injected: STATE for init and state reads, DISCOVERY for the plan, none for version and show; the operator's environment is absent", () => {
  const f = fixture();
  try {
    adapterFor("TERRAFORM").destroyPreview(f.request, f.context);
    const byStep = Object.fromEntries(calls().map((call) => [call.args[0], call]));
    const key = (step: string) => byStep[step].env.AWS_ACCESS_KEY_ID;
    const secret = (step: string) => byStep[step].env.AWS_SECRET_ACCESS_KEY;
    for (const step of ["init", "workspace", "state"]) {
      assert.equal(key(step), "state-key-2", step);
      assert.equal(secret(step), "state-secret-bbbb", step);
    }
    assert.equal(key("plan"), "discovery-key-1");
    assert.equal(secret("plan"), "discovery-secret-aaaa");
    for (const step of ["version", "show"]) {
      assert.equal(key(step), undefined, step + " is given no credentials");
      assert.equal(secret(step), undefined, step);
    }
    for (const call of calls()) {
      const text = JSON.stringify(call.env);
      // Neither identity ever reaches a step that belongs to the other.
      if (call.args[0] !== "plan") assert.ok(!text.includes("discovery-key-1") && !text.includes("discovery-secret-aaaa"), call.args[0]);
      if (call.args[0] !== "init" && call.args[0] !== "workspace" && call.args[0] !== "state") {
        assert.ok(!text.includes("state-key-2") && !text.includes("state-secret-bbbb"), call.args[0]);
      }
      // Nothing of the operator's, and no ALZ_ names at all.
      for (const value of Object.values(OPERATOR)) assert.ok(!text.includes(value), call.args[0] + " got an operator value");
      assert.deepEqual(Object.keys(call.env).filter((name) => name.startsWith("ALZ_")), []);
      assert.notEqual(call.env.HOME, OPERATOR.HOME);
      assert.equal(call.env.PATH, toolDir);
      assert.equal(call.env.TF_IN_AUTOMATION, "1");
      assert.equal(call.env.HTTPS_PROXY, "http://127.0.0.1:3128");
    }
  } finally { f.cleanup(); }
});

test("without a configured identity a step gets nothing: there is no fallback to the other identity or to the operator", () => {
  const f = fixture("TERRAFORM", { env: { ...OPERATOR, ALZ_STATE_AWS_ACCESS_KEY_ID: "state-key-2" } });
  try {
    adapterFor("TERRAFORM").destroyPreview(f.request, f.context);
    const plan = calls().find((call) => call.args[0] === "plan");
    assert.equal(plan?.env.AWS_ACCESS_KEY_ID, undefined, "the plan did not borrow the STATE key");
    assert.ok(!JSON.stringify(plan?.env).includes("operator-ambient"));
  } finally { f.cleanup(); }
});

test("the plan file lives only inside the private directory and is gone afterwards", () => {
  const f = fixture();
  try {
    const before = readdirSync(f.context.scratchDir);
    assert.deepEqual(before, []);
    adapterFor("TERRAFORM").destroyPreview(f.request, f.context);
    const seen = calls();
    const plan = seen.find((call) => call.args[0] === "plan");
    const show = seen.find((call) => call.args[0] === "show");
    assert.equal(plan?.planPath, join(f.context.scratchDir, "alz-preview.tfplan"));
    assert.equal(show?.planPath, plan?.planPath);
    assert.equal(show?.planExists, true, "the plan existed when it was read");
    for (const call of seen) {
      assert.ok(call.cwd === join(f.context.scratchDir, "work") || call.cwd.startsWith(join(f.context.scratchDir, "work") + "/"), call.cwd);
      assert.ok(!call.cwd.startsWith(f.snapshot.path), "nothing ran in the read-only snapshot");
    }
    assert.equal(statSync(f.context.scratchDir).mode & 0o777, 0o700);
    assert.deepEqual(readdirSync(f.context.scratchDir), [], "no plan, no work directory, no provider cache left");
    f.snapshot.verify();
  } finally { f.cleanup(); }
});

test("the work directory and plan are removed when a step fails, and the failure message holds no engine output", () => {
  const f = fixture();
  try {
    for (const failOn of ["version", "init", "workspace", "state", "plan", "show"]) {
      behave({ failOn });
      const message = failureOf(() => adapterFor("TERRAFORM").destroyPreview(f.request, f.context));
      assert.match(message, /^TERRAFORM_ADAPTER:EXIT_1$/, failOn);
      for (const canary of CANARIES) assert.ok(!message.includes(canary), failOn);
      assert.deepEqual(readdirSync(f.context.scratchDir), [], failOn);
    }
  } finally { f.cleanup(); }
});

test("evidence holds the normalized change set, hashes and versions, and none of the canary secrets", () => {
  const f = fixture();
  try {
    const evidence = adapterFor("TERRAFORM").destroyPreview(f.request, f.context);
    assertNoRawPayload(evidence, CANARIES);
    const text = JSON.stringify(evidence);
    for (const canary of CANARIES) assert.ok(!text.includes(canary), canary);
    assert.deepEqual(evidence.changes.resources, [
      { address: "aws_db_instance.main", type: "aws_db_instance", operation: "DELETE" },
      { address: "aws_s3_bucket.logs", type: "aws_s3_bucket", operation: "DELETE" },
    ]);
    assert.equal(evidence.changes.deletes, 2);
    assert.deepEqual(evidence.stateVersion.kind, "TERRAFORM_SERIAL");
    assert.equal(evidence.stateVersion.value, "42");
    assert.equal(evidence.toolVersions.engine, "1.9.5");
    assert.equal(evidence.hashes.manifestHash, f.request.manifest.manifestHash);
    assert.equal(evidence.hashes.unitHash, f.request.unit.unitHash);
    // The normalizer used is the repository's own.
    const fromCanned = normalizeTerraformPlan(JSON.stringify({ resource_changes: [
      { address: "aws_db_instance.main", type: "aws_db_instance", change: { actions: ["delete"] } },
      { address: "aws_s3_bucket.logs", type: "aws_s3_bucket", change: { actions: ["delete"] } },
    ] }));
    assert.equal(evidence.changes.evidenceHash, fromCanned.evidenceHash);
  } finally { f.cleanup(); }
});

test("init changing a manifest file, adding a file or rewriting the lock file is refused, and no plan runs", () => {
  const cases: Array<[string, Array<{ path: string; content: string }>, RegExp]> = [
    ["edited configuration", [{ path: "main.tf", content: 'resource "aws_s3_bucket" "other" {}\n' }], /PROJECT_CHANGED:main\.tf/],
    ["lock file rewritten", [{ path: ".terraform.lock.hcl", content: "# upgraded\n" }], /PROJECT_CHANGED:\.terraform\.lock\.hcl/],
    ["file added", [{ path: "override.tf", content: "# added\n" }], /PROJECT_CHANGED:override\.tf/],
    ["local state written into the project", [{ path: "terraform.tfstate", content: "{}" }], /PROJECT_FILES_REFUSED/],
  ];
  for (const [label, initWrites, expected] of cases) {
    const f = fixture();
    try {
      behave({ initWrites });
      const message = failureOf(() => adapterFor("TERRAFORM").destroyPreview(f.request, f.context));
      assert.match(message, expected, label);
      assert.deepEqual(calls().map((call) => call.args[0]), ["version", "init"], label + ": stopped right after init");
      assert.deepEqual(readdirSync(f.context.scratchDir), [], label);
    } finally { f.cleanup(); }
  }
});

test("a lock file that is not the one the manifest names is refused before anything runs", () => {
  const f = fixture();
  try {
    const tampered = { ...f.request, manifest: { ...f.request.manifest, lockFileSha256: H("c") } };
    assert.match(failureOf(() => adapterFor("TERRAFORM").destroyPreview(tampered, f.context)), /LOCK_FILE_CHANGED/);
    assert.deepEqual(calls(), []);
  } finally { f.cleanup(); }
});

test("an engine that reports a version other than the validated one never runs init", () => {
  const f = fixture();
  try {
    behave({ version: "1.10.0" });
    assert.match(failureOf(() => adapterFor("TERRAFORM").destroyPreview(f.request, f.context)), /ENGINE_VERSION_MISMATCH/);
    assert.deepEqual(calls().map((call) => call.args[0]), ["version"]);
  } finally { f.cleanup(); }
});

test("the adapter refuses a request for the other engine and any run without a snapshot", () => {
  const f = fixture();
  try {
    assert.match(failureOf(() => adapterFor("OPENTOFU").destroyPreview(f.request, f.context)), /WRONG_ENGINE/);
    assert.match(failureOf(() => adapterFor("TERRAFORM").destroyPreview(f.request, { ...f.context, snapshotPath: null })), /PROJECT_MODE_REQUIRED/);
    assert.deepEqual(calls(), []);
  } finally { f.cleanup(); }
});

test("OpenTofu differs from Terraform only by the executable", () => {
  const runs = (["TERRAFORM", "OPENTOFU"] as const).map((engine) => {
    const f = fixture(engine);
    try {
      const evidence = adapterFor(engine).destroyPreview(f.request, f.context);
      return { evidence, seen: calls() };
    } finally { f.cleanup(); }
  });
  const [terraform, tofu] = runs;
  assert.deepEqual(terraform.seen.map((call) => call.args), tofu.seen.map((call) => call.args));
  assert.deepEqual(terraform.seen.map((call) => call.exe), Array(7).fill("terraform"));
  assert.deepEqual(tofu.seen.map((call) => call.exe), Array(7).fill("tofu"));
  assert.deepEqual(terraform.evidence.changes.resources, tofu.evidence.changes.resources);
  assert.equal(tofu.evidence.engine, "OPENTOFU");
  assert.equal(tofu.evidence.changes.engine, "OPENTOFU");
  assert.notEqual(terraformArgvDigest("TERRAFORM"), terraformArgvDigest("OPENTOFU"), "qualification is per engine");
  for (const call of tofu.seen) assert.ok(isAllowedArgv("OPENTOFU", "tofu", call.args));
});

const MUTATION_SHAPED: string[][] = [
  ["apply"], ["apply", "-auto-approve"], ["apply", "../alz-preview.tfplan"], ["destroy"], ["destroy", "-auto-approve"],
  ["plan", "-destroy", "-lock=false", "-input=false", "-no-color", "-out=../alz-preview.tfplan"],
  ["plan", "-destroy", "-input=false", "-no-color", "-lock=false", "-out=../alz-preview.tfplan"],
  ["plan", "-lock=false", "-input=false", "-no-color", "-out=../alz-preview.tfplan"],
  ["plan", "-destroy", "-input=false", "-no-color", "-out=../alz-preview.tfplan", "-target=aws_s3_bucket.logs"],
  ["plan", "-destroy", "-input=false", "-no-color", "-out=../alz-preview.tfplan", "-replace=aws_s3_bucket.logs"],
  ["plan", "-destroy", "-input=false", "-no-color", "-out=../alz-preview.tfplan", "-var=x=1"],
  ["plan", "-destroy", "-input=false", "-no-color", "-out=../alz-preview.tfplan", "-refresh=false"],
  ["plan", "-destroy", "-input=false", "-no-color", "-out=/tmp/alz-preview.tfplan"],
  ["plan", "-destroy", "-input=false", "-no-color", "-out=alz-preview.tfplan"],
  ["plan", "-destroy", "-input=false", "-out=../alz-preview.tfplan", "-no-color"],
  ["plan", "-destroy=true", "-input=false", "-no-color", "-out=../alz-preview.tfplan"],
  ["plan", "-DESTROY", "-input=false", "-no-color", "-out=../alz-preview.tfplan"],
  ["plan", "-destroy"], ["plan"], ["-destroy"], [],
  ["init"], ["init", "-input=false", "-no-color", "-upgrade"], ["init", "-input=false", "-no-color", "-lockfile=readonly", "-reconfigure"],
  ["init", "-input=false", "-no-color", "-lockfile=false"], ["init", "-input=false", "-no-color", "-lock=false"],
  ["state", "rm", "aws_s3_bucket.logs"], ["state", "push", "terraform.tfstate"], ["state", "mv", "a", "b"], ["state", "pull", "-lock=false"],
  ["force-unlock", "-force", "abc"], ["import", "aws_s3_bucket.logs", "b"], ["taint", "aws_s3_bucket.logs"], ["untaint", "x"],
  ["workspace", "delete", "staging"], ["workspace", "new", "staging"], ["workspace", "select", "-force"], ["workspace", "select", "../x"],
  ["workspace", "select", "a b"], ["workspace", "select", ""], ["workspace", "select", "a", "b"],
  ["show", "-json"], ["show", "-json", "/tmp/other.tfplan"], ["show", "../alz-preview.tfplan"],
  ["console"], ["output", "-json"], ["refresh"], ["login"], ["providers", "mirror", "x"], ["get", "-update"],
];

test("only the exact destroy-preview argv is allowed for destroy, and every other mutation-shaped argv is rejected", () => {
  for (const engine of ["TERRAFORM", "OPENTOFU"] as const) {
    const exe = engine === "TERRAFORM" ? "terraform" : "tofu";
    const other = engine === "TERRAFORM" ? "tofu" : "terraform";
    assert.equal(isAllowedDestroyPreviewArgv(engine, exe, DESTROY_PREVIEW_PLAN_ARGV), true);
    assert.equal(isAllowedDestroyPreviewArgv(engine, other, DESTROY_PREVIEW_PLAN_ARGV), false, "the other engine's executable");
    assert.equal(isAllowedDestroyPreviewArgv(engine, "/usr/bin/" + exe, DESTROY_PREVIEW_PLAN_ARGV), false, "a path, not a name");
    assert.equal(isAllowedDestroyPreviewArgv(engine, exe, PREVIEW_PLAN_ARGV), false);
    assert.equal(isAllowedArgv(engine, other, VERSION_ARGV), false);
    for (const argv of MUTATION_SHAPED) {
      assert.equal(isAllowedDestroyPreviewArgv(engine, exe, argv), false, exe + " " + argv.join(" "));
      assert.equal(isAllowedArgv(engine, exe, argv), false, exe + " " + argv.join(" "));
    }
    // Every list the adapter itself runs is allowed, and the workspace name is the only parameter.
    for (const argv of [VERSION_ARGV, INIT_ARGV, WORKSPACE_SHOW_ARGV, STATE_PULL_ARGV, PREVIEW_PLAN_ARGV, DESTROY_PREVIEW_PLAN_ARGV, SHOW_ARGV,
      workspaceSelectArgv("staging"), workspaceSelectArgv("prod.eu-1_b")]) {
      assert.equal(isAllowedArgv(engine, exe, argv), true, argv.join(" "));
    }
    assert.equal(isAllowedArgv(engine, exe, ["workspace", "select", "default"]), true);
  }
});

test("the adapter itself refuses a disallowed argument list before the runner sees it", () => {
  const f = fixture("TERRAFORM", { workspace: "-force" });
  try {
    assert.match(failureOf(() => adapterFor("TERRAFORM").destroyPreview(f.request, f.context)), /ARGV_NOT_ALLOWED/);
    assert.ok(!calls().some((call) => call.args[0] === "workspace"), "the odd workspace name never reached an executable");
  } finally { f.cleanup(); }
});

test("the existing preview guard is untouched: it still flags the destroy argv, so the destroy path can never be an ordinary preview", () => {
  const result = (parts: readonly string[]): ToolResult => ({
    tool: "terraform_plan", ok: true, exitCode: 0, stdout: "", stderr: "", durationMs: 0, command: ["terraform", ...parts],
  });
  assert.equal(dangerousPreviewCommand(result(DESTROY_PREVIEW_PLAN_ARGV)), true);
  assert.equal(dangerousPreviewCommand(result(PREVIEW_PLAN_ARGV)), false);
});

const sourcesUnder = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
  entry.isDirectory() ? sourcesUnder(join(dir, entry.name)) : entry.name.endsWith(".ts") ? [join(dir, entry.name)] : []);

test("the only -destroy literal in the source tree is this adapter's single destroy-preview argv, and no lock switch exists", () => {
  const adapter = resolve("src/teardown/driver/adapters/terraform.ts");
  const holders = sourcesUnder(resolve("src")).filter((file) => /"-destroy/.test(readFileSync(file, "utf8")));
  assert.deepEqual(holders, [adapter]);
  const source = readFileSync(adapter, "utf8");
  assert.equal(source.match(/"-destroy/g)?.length, 1);
  assert.doesNotMatch(source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, ""), /"-lock(=|"|-timeout)|-lock[a-z-]*=false|auto-approve|"apply"|"-target|"-replace/);
  // Not reachable by an agent: nothing under src/tools refers to it.
  for (const file of sourcesUnder(resolve("src/tools"))) {
    assert.doesNotMatch(readFileSync(file, "utf8"), /teardown\/driver|adapters\/terraform/, file);
  }
});

test("show and state pull get the larger reviewed output cap, and an oversized document fails closed instead of being parsed", () => {
  assert.equal(PROFILES.terraform.maxOutputBytes, 1024 * 1024, "the shared profile is unchanged");
  assert.equal(PROFILES.tofu.maxOutputBytes, 1024 * 1024);
  assert.equal(LARGE_OUTPUT_BYTES, 32 * 1024 * 1024);
  const f = fixture();
  try {
    // 3 MiB of plan JSON: over the default cap, under the derived one.
    behave({ padBytes: 3 * 1024 * 1024 });
    const evidence = adapterFor("TERRAFORM").destroyPreview(f.request, f.context);
    assert.equal(evidence.changes.deletes, 2);
    assert.deepEqual(JSON.stringify(evidence).length < 10_000, true, "the padding is not in the evidence");

    behave({ hugeBytes: LARGE_OUTPUT_BYTES + 2 * 1024 * 1024 });
    assert.match(failureOf(() => adapterFor("TERRAFORM").destroyPreview(f.request, f.context)), /OUTPUT_TRUNCATED/);
    assert.deepEqual(readdirSync(f.context.scratchDir), []);
  } finally { f.cleanup(); }
});

// --- Through the driver ---------------------------------------------------------------

function drivePair(engine: TerraformEngine) {
  const f = fixture(engine);
  const adapter = adapterFor(engine);
  const record: QualificationRecord = {
    engine, adapterVersion: adapter.adapterVersion, engineVersion: "1.9.5", argvDigest: adapter.argvDigest,
    qualifiedAt: "2026-10-10T07:00:00.000Z", evidenceHash: H("9"),
  };
  const deps = {
    adapters: [adapter], qualifications: [record], env: { ...ENV }, scratchParent: f.parent,
    now: () => new Date("2026-10-10T10:00:00.000Z"),
  };
  // The driver makes its own snapshot and scratch; this fixture's are released first.
  f.cleanup();
  return { f, deps };
}

test("through the driver, both engines produce validated, canary-free evidence and leave nothing behind", () => {
  for (const engine of ["TERRAFORM", "OPENTOFU"] as const) {
    const { f, deps } = drivePair(engine);
    const before = readdirSync(f.parent);
    const result = runDestroyPreview(f.request, deps);
    assert.equal(result.ok, true, engine + ": " + JSON.stringify(result));
    if (!result.ok) return;
    assert.equal(result.evidence.label, "ARTIFACT_VALIDATED_DESTROY_PREVIEW");
    assert.equal(result.evidence.engine, engine);
    assert.equal(result.evidence.stateVersion.value, "42");
    assert.equal(result.evidence.authority.infrastructureAct, "DISABLED");
    assertNoRawPayload(result.evidence, CANARIES);
    for (const canary of CANARIES) assert.ok(!JSON.stringify(result).includes(canary), canary);
    assert.deepEqual(readdirSync(f.parent), before, "snapshot and scratch removed");
    const exe = engine === "TERRAFORM" ? "terraform" : "tofu";
    assert.deepEqual(calls().map((call) => call.exe), Array(7).fill(exe));
  }
});

test("through the driver, a qualified engine runs while the other is refused for lack of a record", () => {
  const { f, deps } = drivePair("TERRAFORM");
  const tofuFixture = fixture("OPENTOFU");
  tofuFixture.cleanup();
  const both = { ...deps, adapters: [adapterFor("TERRAFORM"), adapterFor("OPENTOFU")] };
  assert.equal(runDestroyPreview(f.request, both).ok, true);
  const refused = runDestroyPreview(tofuFixture.request, both);
  assert.equal(refused.ok, false);
  if (!refused.ok) assert.equal(refused.code, "ENGINE_NOT_QUALIFIED");
});

test("through the driver, an ordinary preview works and init editing the project is reported as a failed adapter", () => {
  const { f, deps } = drivePair("TERRAFORM");
  const preview = runPreview(f.request, deps);
  assert.equal(preview.ok, true);
  if (preview.ok) assert.equal(preview.evidence.operation, "PREVIEW");

  behave({ initWrites: [{ path: "main.tf", content: "# edited\n" }] });
  const result = runDestroyPreview(f.request, deps);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.code, "ADAPTER_FAILED");
    assert.ok(!/main\.tf/.test(result.message), "the driver forwards no adapter text");
  }
  assert.ok(!calls().some((call) => call.args[0] === "plan"));
});

// --- A real binary, only if one is already installed ----------------------------------------

const realDirs = approvedToolDirs(process.env);
const realTerraform = resolveExecutable("terraform", realDirs);
test("a real terraform accepts the pinned argument lists and normalizes an empty destroy plan",
  { skip: realTerraform ? false : "no terraform binary in the approved tool directories (" + realDirs.join(", ") + "); nothing is downloaded. The pinned argument lists were NOT exercised against a real terraform here." },
  () => {
    const scratch = createPrivateDirectory("alz-real-tf-", root);
    const work = join(scratch.path, "work");
    mkdirSync(work, { mode: 0o700 });
    writeFileSync(join(work, "main.tf"), 'terraform {\n  required_version = ">= 1.0"\n}\nresource "terraform_data" "x" {}\n');
    const run = (args: readonly string[]) => runBoundedProcess("terraform_plan", "terraform", [...args], work, {
      profile: { ...PROFILES.terraform, maxOutputBytes: LARGE_OUTPUT_BYTES }, env: {}, toolDirs: realDirs, root: scratch.path,
    });
    try {
      const version = run(VERSION_ARGV);
      assert.equal(version.ok, true);
      assert.equal(typeof (JSON.parse(version.stdout) as { terraform_version: unknown }).terraform_version, "string");
      assert.equal(run(INIT_ARGV).ok, true, "init -lockfile=readonly");
      assert.equal(run(DESTROY_PREVIEW_PLAN_ARGV).ok, true, "plan -destroy with the private -out file");
      assert.equal(existsSync(join(scratch.path, "alz-preview.tfplan")), true);
      const shown = run(SHOW_ARGV);
      assert.equal(shown.ok, true);
      assert.equal(normalizeTerraformPlan(shown.stdout).deletes, 0);
    } finally {
      scratch.remove();
    }
  });

// --- Modules, state version and refused credentials ----------------------------------------

const modulesJson = (...modules: Array<{ Key: string; Source: string; Dir: string }>) =>
  JSON.stringify({ Modules: [{ Key: "", Source: "", Dir: "." }, ...modules] });
const withModules = (json: string) => behave({ initWrites: [{ path: ".terraform/modules/modules.json", content: json }] });

test("a local module inside the project is accepted: its files are in the manifest", () => {
  const f = fixture();
  try {
    withModules(modulesJson({ Key: "net", Source: "./modules/net", Dir: "modules/net" }));
    adapterFor("TERRAFORM").destroyPreview(f.request, f.context);
    assert.ok(calls().some((call) => call.args[0] === "plan"));
  } finally { f.cleanup(); }
});

test("a module source the manifest cannot bind is refused before the plan runs with the DISCOVERY identity", () => {
  const refused: Array<[string, { Key: string; Source: string; Dir: string }]> = [
    ["git ref", { Key: "m", Source: "git::https://example.com/m.git?ref=main", Dir: ".terraform/modules/m" }],
    ["registry range", { Key: "m", Source: "registry.terraform.io/acme/m/aws", Dir: ".terraform/modules/m" }],
    ["local path outside the project", { Key: "m", Source: "../elsewhere", Dir: "../elsewhere" }],
    ["local source whose directory leaves the project", { Key: "m", Source: "./modules/net", Dir: "../../etc" }],
    ["no source", { Key: "m", Source: undefined as unknown as string, Dir: "modules/net" }],
  ];
  for (const [label, entry] of refused) {
    const f = fixture();
    try {
      withModules(modulesJson(entry));
      assert.match(failureOf(() => adapterFor("TERRAFORM").destroyPreview(f.request, f.context)), /MODULE_/, label);
      assert.ok(!calls().some((call) => call.args[0] === "plan"), "no plan ran (" + label + ")");
    } finally { f.cleanup(); }
  }
  const f = fixture();
  try {
    withModules("not json");
    assert.match(failureOf(() => adapterFor("TERRAFORM").destroyPreview(f.request, f.context)), /MODULES_UNREADABLE/);
  } finally { f.cleanup(); }
});

test("a .terraform directory that arrives with the snapshot is refused: init builds its own", () => {
  const f = fixture();
  try {
    chmodSync(f.snapshot.path, 0o700);
    mkdirSync(join(f.snapshot.path, ".terraform", "modules"), { recursive: true });
    writeFileSync(join(f.snapshot.path, ".terraform", "modules", "x.tf"), "# unreviewed\n");
    assert.match(failureOf(() => adapterFor("TERRAFORM").destroyPreview(f.request, f.context)), /PRE_EXISTING_TERRAFORM_DIRECTORY/);
    assert.deepEqual(calls(), [], "nothing ran");
  } finally { f.cleanup(); }
});

test("state that moved while the plan ran is not recorded against the plan", () => {
  const f = fixture();
  try {
    behave({ serial: 41, serialAfterPlan: 42 });
    assert.match(failureOf(() => adapterFor("TERRAFORM").destroyPreview(f.request, f.context)), /STATE_CHANGED/);
  } finally { f.cleanup(); }
});

test("a credential the runner refuses is a failure, not a run with no identity", () => {
  const f = fixture("TERRAFORM", { env: { ...OPERATOR, ...ENV, ALZ_STATE_AWS_SECRET_ACCESS_KEY: "line one\nline two" } });
  try {
    assert.match(failureOf(() => adapterFor("TERRAFORM").destroyPreview(f.request, f.context)), /ENVIRONMENT_REFUSED/);
    assert.ok(!calls().some((call) => call.args[0] === "plan"));
  } finally { f.cleanup(); }
});
