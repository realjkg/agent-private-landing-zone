import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { createChangeSet } from "../src/iac/changeset.js";
import {
  argvDigest,
  assertNoRawPayload,
  enabledEngines,
  runDestroyPreview,
  runPreview,
  type AdapterContext,
  type DriverDeps,
  type PreviewRequest,
  type QualificationRecord,
} from "../src/teardown/driver/index.js";
import * as pulumiModule from "../src/teardown/driver/adapters/pulumi.js";
import {
  createPulumiAdapter,
  isAllowedPulumiArgv,
  pulumiAdapter,
  PULUMI_ARGV,
  PULUMI_ARGV_DIGEST,
  PULUMI_PREVIEW_PROFILE,
  PULUMI_UNVERIFIED,
} from "../src/teardown/driver/adapters/pulumi.js";
import { buildManifest } from "../src/teardown/manifest.js";
import { captureProjectFiles } from "../src/teardown/snapshot.js";
import { recordDeletionUnit } from "../src/teardown/unit.js";
import { PROFILES } from "../src/tools/profiles.js";

// docs/destroy-preview-driver.md, "Pulumi adapter". There is no Pulumi CLI in
// this sandbox, so a fake `pulumi` (a node script in a temp directory handed to
// the runner as an approved tool directory) records what it was given and prints
// canned output. These tests prove the adapter's behavior around the CLI. They
// cannot prove the real CLI accepts the flags; that is the qualification step.

const H = (char: string) => char.repeat(64);
const work = mkdtempSync(join(tmpdir(), "alz-pulumi-adapter-"));
test.after(() => {
  const open = (path: string) => {
    try {
      chmodSync(path, 0o700);
      if (statSync(path).isDirectory()) for (const name of readdirSync(path)) open(join(path, name));
    } catch { /* best effort */ }
  };
  open(work);
  rmSync(work, { recursive: true, force: true });
});
let counter = 0;
const fresh = (label: string) => {
  const dir = join(work, label + "-" + ++counter);
  mkdirSync(dir, { recursive: true });
  return dir;
};

const BACKEND = "s3://alz-pulumi";
const STACK = "prod";
const URN = "urn:pulumi:prod::landing::aws:s3/bucket:Bucket::logs";
const TYPE = "aws:s3/bucket:Bucket";
const ENGINE_VERSION = "3.150.0";
const CANARY_PLAN = "canary-plan-secret-5d21";
const CANARY_STATE = "canary-state-secret-8e47";
const CANARY_STDERR = "canary-stderr-secret-1b90";
const CANARIES = [CANARY_PLAN, CANARY_STATE, CANARY_STDERR];

const STATE_SECRETS = ["state-token-0001", "state-passphrase-0002", "AKIASTATE000000001", "state-secret-key-0003"];
const DISCOVERY_SECRETS = ["discovery-token-0004", "discovery-passphrase-0005", "AKIADISC0000000002", "discovery-secret-key-0006"];
const OPERATOR_SECRETS = ["operator-passphrase-0007", "operator-token-0008", "AKIAOPERATOR00003", "operator-secret-key-0009"];

const ENV: NodeJS.ProcessEnv = {
  ALZ_APPROVED_HOSTS: "alz-pulumi",
  ALZ_STATE_PULUMI_BACKEND_URL: BACKEND,
  ALZ_STATE_PULUMI_ACCESS_TOKEN: STATE_SECRETS[0],
  ALZ_STATE_PULUMI_CONFIG_PASSPHRASE: STATE_SECRETS[1],
  ALZ_STATE_AWS_ACCESS_KEY_ID: STATE_SECRETS[2],
  ALZ_STATE_AWS_SECRET_ACCESS_KEY: STATE_SECRETS[3],
  ALZ_DISCOVERY_PULUMI_BACKEND_URL: BACKEND,
  ALZ_DISCOVERY_PULUMI_ACCESS_TOKEN: DISCOVERY_SECRETS[0],
  ALZ_DISCOVERY_PULUMI_CONFIG_PASSPHRASE: DISCOVERY_SECRETS[1],
  ALZ_DISCOVERY_AWS_ACCESS_KEY_ID: DISCOVERY_SECRETS[2],
  ALZ_DISCOVERY_AWS_SECRET_ACCESS_KEY: DISCOVERY_SECRETS[3],
  // The operator's own shell. None of it may reach a child.
  PULUMI_CONFIG_PASSPHRASE: OPERATOR_SECRETS[0],
  PULUMI_ACCESS_TOKEN: OPERATOR_SECRETS[1],
  AWS_ACCESS_KEY_ID: OPERATOR_SECRETS[2],
  AWS_SECRET_ACCESS_KEY: OPERATOR_SECRETS[3],
};

// --- The fake CLI -------------------------------------------------------------------------

type FakeConfig = {
  version?: string;
  exportBefore?: unknown;
  exportAfter?: unknown;
  destroy?: string;
  preview?: string;
  exitCodes?: Record<string, number>;
  /** What the program does to its own working directory while it runs (a hostile or buggy project). */
  program?: "rewrite-project" | "plant-in-parent" | "leave-read-only";
};
type Call = { argv: string[]; cwd: string; cwdEntries: string[]; env: Record<string, string> };

const stateDocument = (version = 3) => ({
  version,
  deployment: { manifest: {}, resources: [{ urn: URN, type: TYPE, outputs: { password: CANARY_STATE } }] },
});
const stepsDocument = (op: string) => JSON.stringify({
  steps: [{ op, urn: URN, type: TYPE, oldState: { type: TYPE, inputs: { password: CANARY_PLAN }, outputs: { secret: CANARY_PLAN } } }],
  changeSummary: { [op]: 1 },
  duration: 1,
});

function fakePulumi(config: FakeConfig = {}): { dir: string; calls: () => Call[] } {
  const dir = fresh("tools");
  writeFileSync(join(dir, "config.json"), JSON.stringify({
    version: "v" + ENGINE_VERSION,
    exportBefore: stateDocument(),
    destroy: stepsDocument("delete"),
    preview: stepsDocument("create"),
    exitCodes: {},
    ...config,
  }));
  writeFileSync(join(dir, "pulumi"), `#!${process.execPath}
const fs = require("fs"), path = require("path");
const argv = process.argv.slice(2);
const config = JSON.parse(fs.readFileSync(path.join(__dirname, "config.json"), "utf8"));
const log = path.join(__dirname, "calls.jsonl");
const prior = fs.existsSync(log) ? fs.readFileSync(log, "utf8").split("\\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
fs.appendFileSync(log, JSON.stringify({ argv, cwd: process.cwd(), cwdEntries: fs.readdirSync(process.cwd()), env: process.env }) + "\\n");
const kind = argv[0] === "stack" ? "export" : argv[0];
if (config.exitCodes[kind]) { process.stderr.write("${CANARY_STDERR}\\n"); process.exit(config.exitCodes[kind]); }
if (kind === "version") process.stdout.write(config.version + "\\n");
else if (kind === "export") {
  const again = prior.some((c) => c.argv[0] === "stack");
  const doc = again && config.exportAfter !== undefined ? config.exportAfter : config.exportBefore;
  process.stdout.write(JSON.stringify(doc));
} else if (kind === "destroy") {
  const cwd = process.cwd();
  if (config.program === "rewrite-project") {
    fs.chmodSync(cwd, 0o700);
    fs.writeFileSync(path.join(cwd, "Pulumi.yaml"), "name: landing\\nbackend:\\n  url: https://attacker.example\\n");
  } else if (config.program === "plant-in-parent") fs.writeFileSync(path.join(cwd, "..", "Pulumi.yaml"), "name: planted\\n");
  else if (config.program === "leave-read-only") {
    fs.mkdirSync(path.join(cwd, "ro")); fs.writeFileSync(path.join(cwd, "ro", "x"), "x"); fs.chmodSync(path.join(cwd, "ro"), 0o500);
  }
  process.stdout.write(config.destroy);
}
else if (kind === "preview") process.stdout.write(config.preview);
else { process.stderr.write("unexpected subcommand\\n"); process.exit(64); }
process.stderr.write("${CANARY_STDERR}\\n");
`);
  chmodSync(join(dir, "pulumi"), 0o755);
  return {
    dir,
    calls: () => existsSync(join(dir, "calls.jsonl"))
      ? readFileSync(join(dir, "calls.jsonl"), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as Call)
      : [],
  };
}

// --- A full driver fixture ----------------------------------------------------------------

const TARGET = { account: "123456789012", backend: BACKEND, workspace: STACK };
const unit = recordDeletionUnit({
  buildId: "build-1",
  provider: "AWS",
  stateRef: { engine: "PULUMI", backendUrl: BACKEND, stack: STACK },
  designHash: H("1"),
  createPlan: createChangeSet("PULUMI", [{ address: URN, type: TYPE, operation: "CREATE" }]),
  recordedAt: "2026-10-10T08:00:00.000Z",
});

type Fixture = {
  request: PreviewRequest;
  deps: DriverDeps;
  fake: ReturnType<typeof fakePulumi>;
  parent: string;
  projectRoot: string;
};

function fixture(options: { mode?: "PROJECT" | "STATE_DERIVED"; config?: FakeConfig; env?: NodeJS.ProcessEnv } = {}): Fixture {
  const mode = options.mode ?? "PROJECT";
  const projectRoot = fresh("project");
  writeFileSync(join(projectRoot, "Pulumi.yaml"), "name: landing\nruntime: nodejs\n");
  writeFileSync(join(projectRoot, "index.ts"), 'export const bucket = "logs";\n');
  const providers = [{ source: "pulumi/aws", version: "6.68.0" }];
  const inputs = [{ name: "aws:region", identity: H("f") }];
  const manifest = buildManifest({
    engine: "PULUMI", mode, target: TARGET, unitHash: unit.unitHash, engineVersion: ENGINE_VERSION, providers,
    files: mode === "PROJECT" ? captureProjectFiles(projectRoot) : [],
    dependencies: [], inputs,
    executionManifestSha256: mode === "STATE_DERIVED" ? H("e") : undefined,
    policyVersion: "2026-10-07.1",
  });
  const request: PreviewRequest = {
    engine: "PULUMI", mode, target: TARGET,
    invocation: { operatorId: "jane.doe", interactiveSession: true, confirmedTarget: { ...TARGET }, confirmedAt: "2026-10-10T09:30:00.000Z" },
    manifest, unit, projectRoot,
    capabilities: { cloudRead: true, projectCodeExecution: mode === "PROJECT" },
    policyVersion: "2026-10-07.1",
    resolved: {
      engineVersion: ENGINE_VERSION, providers, dependencies: [], inputs,
      executionManifestSha256: mode === "STATE_DERIVED" ? H("e") : undefined,
    },
  };
  const fake = fakePulumi(options.config);
  const adapter = createPulumiAdapter({ toolDirs: [fake.dir] });
  const parent = fresh("scratch");
  const deps: DriverDeps = {
    adapters: [adapter], qualifications: [qualify(ENGINE_VERSION)], env: { ...(options.env ?? ENV) },
    now: () => new Date("2026-10-10T10:00:00.000Z"), scratchParent: parent,
  };
  return { request, deps, fake, parent, projectRoot };
}

/** What a qualification step would supply after confirming the flags on a real CLI. Tests only. */
const qualify = (engineVersion: string): QualificationRecord => ({
  engine: "PULUMI", adapterVersion: pulumiAdapter.adapterVersion, engineVersion,
  argvDigest: PULUMI_ARGV_DIGEST, qualifiedAt: "2026-10-10T07:00:00.000Z", evidenceHash: H("9"),
});

const ARGVS: Readonly<Record<string, readonly string[]>> = PULUMI_ARGV;
const bound = (template: readonly string[], stack = STACK) => template.map((arg) => (arg === "<stack>" ? stack : arg));
const secretsSeen = (call: Call, secrets: readonly string[]) => secrets.filter((s) => Object.values(call.env).includes(s));
const ok = (result: ReturnType<typeof runDestroyPreview>) => {
  assert.equal(result.ok, true, result.ok ? "" : result.code + ": " + result.message);
  if (!result.ok) throw new Error("unreachable");
  return result;
};

// --- Pinned argv ---------------------------------------------------------------------------

test("every argument list is pinned in one place, with its digest", () => {
  assert.deepEqual(PULUMI_ARGV, {
    VERSION: ["pulumi", "version"],
    STATE_EXPORT: ["pulumi", "stack", "export", "--stack", "<stack>", "--non-interactive"],
    PREVIEW_PROJECT: ["pulumi", "preview", "--non-interactive", "--stack", "<stack>", "--json"],
    DESTROY_PREVIEW_PROJECT: ["pulumi", "destroy", "--preview-only", "--non-interactive", "--stack", "<stack>", "--json", "--run-program"],
    DESTROY_PREVIEW_STATE_DERIVED: ["pulumi", "destroy", "--preview-only", "--non-interactive", "--stack", "<stack>", "--json", "--run-program=false"],
  });
  assert.equal(PULUMI_ARGV_DIGEST, argvDigest(Object.values(PULUMI_ARGV)));
  assert.equal(pulumiAdapter.argvDigest, PULUMI_ARGV_DIGEST);
  // Changing any one list changes the digest, so a qualification record stops matching.
  const changed = { ...PULUMI_ARGV, DESTROY_PREVIEW_PROJECT: [...PULUMI_ARGV.DESTROY_PREVIEW_PROJECT, "--diff"] };
  assert.notEqual(argvDigest(Object.values(changed)), PULUMI_ARGV_DIGEST);
});

test("a destroy subcommand appears only with --preview-only, and every list names an explicit stack", () => {
  for (const [name, argv] of Object.entries(ARGVS)) {
    if (argv.includes("destroy")) {
      assert.equal(argv[1], "destroy", name);
      assert.ok(argv.includes("--preview-only"), name + " must be preview-only");
    }
    if (name !== "VERSION") {
      assert.ok(argv.includes("--non-interactive"), name);
      assert.equal(argv[argv.indexOf("--stack") + 1], "<stack>", name);
    }
    for (const arg of argv) assert.doesNotMatch(arg, /^--?(yes|y|skip-preview|target|replace|refresh|lock)\b|auto-approve|^-lock/, name);
  }
});

test("the exact-match allowlist accepts the pinned lists and rejects every other command", () => {
  for (const argv of Object.values(ARGVS)) {
    assert.equal(isAllowedPulumiArgv(bound(argv)), true, argv.join(" "));
    assert.equal(isAllowedPulumiArgv(bound(argv, "acme/landing/prod")), true, argv.join(" "));
  }
  const rejected: string[][] = [
    ["pulumi", "up", "--stack", "prod", "--non-interactive"],
    ["pulumi", "up", "--yes", "--stack", "prod"],
    ["pulumi", "destroy", "--stack", "prod", "--non-interactive", "--json"],
    ["pulumi", "destroy", "--yes", "--stack", "prod"],
    ["pulumi", "destroy", "--stack", "prod", "--preview-only"],
    ["pulumi", "destroy", "--preview-only", "--non-interactive", "--stack", "prod", "--json", "--run-program", "--yes"],
    ["pulumi", "destroy", "--preview-only", "--non-interactive", "--stack", "prod", "--json", "--run-program", "--skip-preview"],
    ["pulumi", "destroy", "--preview-only", "--non-interactive", "--stack", "prod", "--json", "--run-program", "--target", "urn:x"],
    ["pulumi", "destroy", "--preview-only", "--non-interactive", "--stack", "prod", "--json", "--run-program", "--refresh"],
    ["pulumi", "destroy", "--preview-only", "--non-interactive", "--json", "--run-program"],
    ["pulumi", "destroy", "--non-interactive", "--stack", "prod", "--json", "--run-program", "--preview-only=false"],
    ["pulumi", "refresh", "--yes", "--stack", "prod"],
    ["pulumi", "refresh", "--stack", "prod", "--non-interactive"],
    ["pulumi", "cancel", "--stack", "prod"],
    ["pulumi", "stack", "rm", "prod"],
    ["pulumi", "stack", "rm", "--stack", "prod", "--yes"],
    ["pulumi", "stack", "export", "--stack", "prod", "--non-interactive", "--show-secrets"],
    ["pulumi", "stack", "import", "--stack", "prod", "--non-interactive"],
    ["pulumi", "state", "delete", "urn:x", "--stack", "prod"],
    ["pulumi", "state", "unprotect", "--all", "--stack", "prod"],
    ["pulumi", "preview", "--non-interactive", "--stack", "prod", "--json", "--refresh"],
    ["pulumi", "preview", "--destroy", "--non-interactive", "--stack", "prod", "--json"],
    ["pulumi", "version", "--json"],
    ["pulumi"],
    [],
    ["sh", "-c", "pulumi destroy --yes"],
    ["/usr/bin/pulumi", "version"],
  ];
  for (const argv of rejected) assert.equal(isAllowedPulumiArgv(argv), false, argv.join(" "));
  // The stack slot takes a stack name, never a flag or something shell-shaped.
  for (const stack of ["--yes", "-x", "", "a b", "prod;rm", "prod\n--yes", "a/b/c/d", "../prod", "$(id)"]) {
    for (const argv of Object.values(ARGVS)) {
      if (argv.includes("<stack>")) assert.equal(isAllowedPulumiArgv(bound(argv, stack)), false, JSON.stringify(stack));
    }
  }
});

test("the runner profile differs from the shared pulumi profile only in its reviewed output cap", () => {
  const { maxOutputBytes, ...rest } = PULUMI_PREVIEW_PROFILE;
  const { maxOutputBytes: shared, ...sharedRest } = PROFILES.pulumi;
  assert.deepEqual(rest, sharedRest);
  assert.ok(maxOutputBytes > shared && maxOutputBytes <= 16 * 1024 * 1024);
  assert.equal(PULUMI_PREVIEW_PROFILE.suppressExcerpts, true);
});

// --- Disabled until qualified --------------------------------------------------------------

test("the adapter ships disabled: no qualification record is bundled, and the engine is denied without one", () => {
  for (const [name, value] of Object.entries(pulumiModule)) {
    assert.doesNotMatch(name, /qualif/i, name);
    assert.ok(!(value && typeof value === "object" && "evidenceHash" in value), name + " looks like a qualification record");
  }
  const [terraform, opentofu, pulumi] = enabledEngines([], [pulumiAdapter], { PULUMI: ENGINE_VERSION });
  assert.equal(pulumi.enabled, false);
  assert.ok(!pulumi.enabled && pulumi.reason.includes(PULUMI_ARGV_DIGEST) && /no qualification record/.test(pulumi.reason));
  assert.equal(terraform.enabled, false);
  assert.equal(opentofu.enabled, false);
  assert.ok(PULUMI_UNVERIFIED.length >= 8);
});

test("denied: a driver run with no matching qualification record never reaches the CLI", () => {
  const stale = [
    [],
    [{ ...qualify(ENGINE_VERSION), engine: "TERRAFORM" as const }],
    [{ ...qualify(ENGINE_VERSION), argvDigest: H("0") }],
    [{ ...qualify(ENGINE_VERSION), adapterVersion: "0.0.1" }],
    [qualify("3.1.0")],
  ];
  for (const mode of ["PROJECT", "STATE_DERIVED"] as const) {
    for (const records of stale) {
      for (const run of [runDestroyPreview, ...(mode === "PROJECT" ? [runPreview] : [])]) {
        const f = fixture({ mode });
        f.deps.qualifications = records;
        const result = run(f.request, f.deps);
        assert.equal(result.ok, false);
        if (!result.ok) assert.equal(result.code, "ENGINE_NOT_QUALIFIED", result.message);
        assert.deepEqual(f.fake.calls(), [], "pulumi must not run");
        assert.deepEqual(readdirSync(f.parent), []);
      }
    }
  }
});

// --- Permission and manifest ---------------------------------------------------------------

test("denied: project mode without PROJECT_CODE_EXECUTION runs nothing", () => {
  const f = fixture({ mode: "PROJECT" });
  f.request.capabilities.projectCodeExecution = false;
  const result = runDestroyPreview(f.request, f.deps);
  assert.ok(!result.ok && result.code === "PROJECT_CODE_EXECUTION_REQUIRED");
  assert.deepEqual(f.fake.calls(), []);
  const ordinary = runPreview(f.request, f.deps);
  assert.ok(!ordinary.ok && ordinary.code === "PROJECT_CODE_EXECUTION_REQUIRED");
  assert.deepEqual(f.fake.calls(), []);
});

test("the adapter itself also refuses a project run without the permission or a snapshot", () => {
  const f = fixture({ mode: "PROJECT" });
  const adapter = createPulumiAdapter({ toolDirs: [f.fake.dir] });
  const context = (snapshotPath: string | null): AdapterContext => ({
    snapshotPath, scratchDir: fresh("scratch"), identities: { providerReads: "DISCOVERY", stateReads: "STATE" }, env: ENV,
  });
  assert.throws(() => adapter.destroyPreview({ ...f.request, capabilities: { cloudRead: true, projectCodeExecution: false } }, context(f.projectRoot)));
  assert.throws(() => adapter.destroyPreview(f.request, context(null)));
  assert.throws(() => adapter.destroyPreview({ ...f.request, target: { ...TARGET, workspace: "--yes" } }, context(f.projectRoot)));
  assert.deepEqual(f.fake.calls(), []);
});

test("state-derived mode needs no PROJECT_CODE_EXECUTION but still needs the approved execution manifest", () => {
  const withoutPermission = fixture({ mode: "STATE_DERIVED" });
  assert.equal(withoutPermission.request.capabilities.projectCodeExecution, false);
  ok(runDestroyPreview(withoutPermission.request, withoutPermission.deps));

  const missing = fixture({ mode: "STATE_DERIVED" });
  delete missing.request.resolved.executionManifestSha256;
  const result = runDestroyPreview(missing.request, missing.deps);
  assert.ok(!result.ok && result.code === "REVIEW_REQUIRED" && result.fields?.includes("executionManifestSha256"));
  assert.deepEqual(missing.fake.calls(), []);

  const different = fixture({ mode: "STATE_DERIVED" });
  different.request.resolved.executionManifestSha256 = H("d");
  const changed = runDestroyPreview(different.request, different.deps);
  assert.ok(!changed.ok && changed.code === "REVIEW_REQUIRED" && changed.fields?.includes("executionManifestSha256"));
  assert.deepEqual(different.fake.calls(), []);

  // An ordinary preview runs the program, so it is not offered in state-derived mode.
  const ordinary = fixture({ mode: "STATE_DERIVED" });
  const refusedMode = runPreview(ordinary.request, ordinary.deps);
  assert.ok(!refusedMode.ok && refusedMode.code === "MODE_NOT_SUPPORTED");
  assert.deepEqual(ordinary.fake.calls(), []);
});

// --- Exact argv and identities per mode ----------------------------------------------------

test("STATE_DERIVED destroy preview: exact argv, the program is not run, state identity only", () => {
  const f = fixture({ mode: "STATE_DERIVED" });
  const result = ok(runDestroyPreview(f.request, f.deps));
  const calls = f.fake.calls();
  assert.deepEqual(calls.map((c) => c.argv), [
    ["version"],
    ["stack", "export", "--stack", STACK, "--non-interactive"],
    ["destroy", "--preview-only", "--non-interactive", "--stack", STACK, "--json", "--run-program=false"],
    ["stack", "export", "--stack", STACK, "--non-interactive"],
  ]);
  for (const call of calls) {
    assert.ok(!call.argv.includes("--run-program"), "no bare --run-program in state-derived mode");
    // No project directory is involved: the run is in the private scratch directory, which holds no program.
    assert.notEqual(call.cwd, f.projectRoot);
    assert.ok(!call.cwdEntries.some((name) => name === "index.ts" || name === "Pulumi.yaml"));
    // Only the STATE identity is used; DISCOVERY credentials are never handed over.
    assert.deepEqual(secretsSeen(call, DISCOVERY_SECRETS), []);
    assert.deepEqual(secretsSeen(call, STATE_SECRETS).sort(), [...STATE_SECRETS].sort());
    assert.deepEqual(secretsSeen(call, OPERATOR_SECRETS), []);
  }
  assert.equal(result.evidence.mode, "STATE_DERIVED");
  assert.equal(result.evidence.operation, "DESTROY_PREVIEW");
  assert.equal(result.evidence.label, "ARTIFACT_VALIDATED_DESTROY_PREVIEW");
  assert.equal(result.evidence.hashes.manifestHash, f.request.manifest.manifestHash);
  assert.equal(result.evidence.toolVersions.engine, ENGINE_VERSION);
  assert.deepEqual(readdirSync(f.parent), [], "scratch is removed");
});

test("PROJECT destroy preview: exact argv, runs the snapshot, DISCOVERY for the program and STATE for state", () => {
  const f = fixture({ mode: "PROJECT" });
  const result = ok(runDestroyPreview(f.request, f.deps));
  const calls = f.fake.calls();
  assert.deepEqual(calls.map((c) => c.argv), [
    ["version"],
    ["stack", "export", "--stack", STACK, "--non-interactive"],
    ["destroy", "--preview-only", "--non-interactive", "--stack", STACK, "--json", "--run-program"],
    ["stack", "export", "--stack", STACK, "--non-interactive"],
  ]);
  for (const call of calls) {
    assert.notEqual(call.cwd, f.projectRoot, "a copy runs, not the working project");
    assert.deepEqual(secretsSeen(call, OPERATOR_SECRETS), []);
  }
  // Only the program runs where the project is; the state-identity steps run in an empty directory.
  assert.deepEqual(calls.map((c) => c.cwdEntries.includes("index.ts")), [false, false, true, false]);
  assert.equal(calls[2].cwd.endsWith("/work"), true);
  // The program runs with provider-read credentials only; the state reads hold the state credentials only.
  const [version, exportBefore, destroy, exportAfter] = calls;
  for (const call of [version, exportBefore, exportAfter]) {
    assert.deepEqual(secretsSeen(call, DISCOVERY_SECRETS), []);
    assert.equal(secretsSeen(call, STATE_SECRETS).length, STATE_SECRETS.length);
  }
  assert.deepEqual(secretsSeen(destroy, STATE_SECRETS), []);
  assert.equal(secretsSeen(destroy, DISCOVERY_SECRETS).length, DISCOVERY_SECRETS.length);
  assert.equal(destroy.env.PULUMI_CONFIG_PASSPHRASE, DISCOVERY_SECRETS[1]);
  assert.equal(exportBefore.env.PULUMI_CONFIG_PASSPHRASE, STATE_SECRETS[1]);
  assert.equal(destroy.env.PULUMI_BACKEND_URL, BACKEND);

  assert.equal(result.evidence.mode, "PROJECT");
  assert.deepEqual(result.evidence.changes.resources, [{ address: URN, type: TYPE, operation: "DELETE" }]);
  assert.equal(result.evidence.verdict, result.preview?.verdict);
  assert.equal(result.evidence.verdict, "READY_FOR_AUTHORIZATION");
  assert.equal(result.evidence.stateVersion.kind, "PULUMI_CHECKPOINT_VERSION");
  assert.match(result.evidence.stateVersion.value, /^3:[a-f0-9]{64}$/);
  assert.deepEqual(result.evidence.authority, {
    infrastructureAct: "DISABLED", mutation: "NONE", executionMode: "PREVIEW_ONLY", agentInitiated: false,
  });
  assert.deepEqual(readdirSync(f.parent), []);
});

test("ordinary preview: pinned `preview` argv, the program runs, never a destroy", () => {
  const f = fixture({ mode: "PROJECT" });
  const result = ok(runPreview(f.request, f.deps));
  const argvs = f.fake.calls().map((c) => c.argv);
  assert.deepEqual(argvs[2], ["preview", "--non-interactive", "--stack", STACK, "--json"]);
  assert.ok(argvs.every((argv) => !argv.includes("destroy")));
  assert.equal(result.evidence.operation, "PREVIEW");
  assert.equal(result.evidence.verdict, null);
  assert.equal(result.preview, undefined);
});

test("every destroy argv the CLI ever sees carries --preview-only, whatever the mode", () => {
  for (const mode of ["PROJECT", "STATE_DERIVED"] as const) {
    const f = fixture({ mode });
    ok(runDestroyPreview(f.request, f.deps));
    for (const call of f.fake.calls()) {
      assert.equal(isAllowedPulumiArgv(["pulumi", ...call.argv]), true, call.argv.join(" "));
      if (call.argv.includes("destroy")) assert.ok(call.argv.includes("--preview-only"));
      assert.ok(!call.argv.some((arg) => /^(up|refresh|cancel|rm|--yes|-y|--skip-preview|--target|--replace)$/.test(arg)));
    }
  }
});

// --- Secrets stay out of evidence ----------------------------------------------------------

test("canary secrets from the plan, the state export and stderr never reach the evidence or the result", () => {
  for (const mode of ["PROJECT", "STATE_DERIVED"] as const) {
    const f = fixture({ mode });
    const result = ok(runDestroyPreview(f.request, f.deps));
    assertNoRawPayload(result.evidence, CANARIES);
    const serialized = JSON.stringify(result);
    for (const canary of [...CANARIES, ...STATE_SECRETS, ...DISCOVERY_SECRETS, ...OPERATOR_SECRETS]) {
      assert.equal(serialized.includes(canary), false, canary);
    }
    // The canaries really were in what the fake printed.
    assert.ok(JSON.stringify(f.fake.calls().length) !== "0");
    assert.ok(readFileSync(join(f.fake.dir, "config.json"), "utf8").includes(CANARY_PLAN));
    assert.deepEqual(readdirSync(f.parent), []);
  }
});

// --- Fail closed ---------------------------------------------------------------------------

const adapterFailed = (f: Fixture) => {
  const result = runDestroyPreview(f.request, f.deps);
  assert.ok(!result.ok && result.code === "ADAPTER_FAILED", result.ok ? "ran" : result.code + ": " + result.message);
  assert.equal(JSON.stringify(result).includes(CANARY_STDERR), false, "engine output is not forwarded");
  assert.deepEqual(readdirSync(f.parent), []);
  return f.fake.calls();
};

test("fails closed: the CLI exits non-zero at any step", () => {
  for (const kind of ["version", "export", "destroy"]) {
    const f = fixture({ mode: "STATE_DERIVED", config: { exitCodes: { [kind]: 1 } } });
    adapterFailed(f);
  }
});

test("fails closed: an identity that does not name the requested backend, before anything runs", () => {
  for (const key of ["ALZ_STATE_PULUMI_BACKEND_URL", "ALZ_DISCOVERY_PULUMI_BACKEND_URL"]) {
    for (const value of ["s3://other-backend", undefined]) {
      const env = { ...ENV };
      if (value === undefined) delete env[key]; else env[key] = value;
      const f = fixture({ mode: "PROJECT", env });
      assert.deepEqual(adapterFailed(f), []);
    }
  }
  // State-derived mode runs no program, so the DISCOVERY backend is not consulted.
  const env = { ...ENV };
  delete env.ALZ_DISCOVERY_PULUMI_BACKEND_URL;
  const stateOnly = fixture({ mode: "STATE_DERIVED", env });
  ok(runDestroyPreview(stateOnly.request, stateOnly.deps));
});

test("fails closed: the runner refused the backend URL (unapproved host)", () => {
  const env = { ...ENV };
  delete env.ALZ_APPROVED_HOSTS;
  adapterFailed(fixture({ mode: "STATE_DERIVED", env }));
});

test("fails closed: a preview document without a step list is not read as 'nothing to destroy'", () => {
  for (const destroy of ['{"changeSummary":{}}', "[]", "not json", ""]) {
    adapterFailed(fixture({ mode: "STATE_DERIVED", config: { destroy } }));
  }
});

test("fails closed: a state export of an unexpected shape, or state that moved while the preview ran", () => {
  adapterFailed(fixture({ mode: "STATE_DERIVED", config: { exportBefore: { nope: true } } }));
  adapterFailed(fixture({ mode: "STATE_DERIVED", config: { exportBefore: "text" } }));
  const moved = adapterFailed(fixture({ mode: "STATE_DERIVED", config: { exportBefore: stateDocument(3), exportAfter: stateDocument(4) } }));
  assert.equal(moved.length, 4, "it finished the preview, then noticed the state moved");
});

test("fails closed: output past the cap, and an unrecognizable engine version", () => {
  const huge = JSON.stringify({ steps: [], pad: "x".repeat(PULUMI_PREVIEW_PROFILE.maxOutputBytes + 1024) });
  adapterFailed(fixture({ mode: "STATE_DERIVED", config: { destroy: huge } }));
  adapterFailed(fixture({ mode: "STATE_DERIVED", config: { version: "pulumi dev build" } }));
});

test("a plan larger than the shared 1 MiB cap still previews, under the adapter's own cap", () => {
  const padded = JSON.stringify({ steps: JSON.parse(stepsDocument("delete")).steps, pad: "x".repeat(2 * 1024 * 1024) });
  const f = fixture({ mode: "STATE_DERIVED", config: { destroy: padded } });
  assert.deepEqual(ok(runDestroyPreview(f.request, f.deps)).evidence.changes.resources, [{ address: URN, type: TYPE, operation: "DELETE" }]);
});

test("an engine version that differs from the qualified one runs nothing: no export, no preview, no program", () => {
  for (const mode of ["STATE_DERIVED", "PROJECT"] as const) {
    for (const run of [runDestroyPreview, ...(mode === "PROJECT" ? [runPreview] : [])]) {
      const f = fixture({ mode, config: { version: "v3.151.0" } });
      const result = run(f.request, f.deps);
      assert.ok(!result.ok && result.code === "ADAPTER_FAILED", mode);
      assert.deepEqual(f.fake.calls().map((c) => c.argv), [["version"]], "only `version` ran (" + mode + ")");
      assert.deepEqual(readdirSync(f.parent), []);
    }
  }
});

// --- The program cannot change what the manifest bound ---------------------------------------

test("a program that rewrites a project file is caught before the state is read again, and the run is not labelled validated", () => {
  const f = fixture({ mode: "PROJECT", config: { program: "rewrite-project" } });
  const result = runDestroyPreview(f.request, f.deps);
  assert.ok(!result.ok && result.code === "ADAPTER_FAILED", JSON.stringify(result));
  // version, export, the program. The STATE-credentialed export after the program never ran.
  assert.deepEqual(f.fake.calls().map((c) => c.argv[0]), ["version", "stack", "destroy"]);
  assert.equal(readFileSync(join(f.projectRoot, "Pulumi.yaml"), "utf8"), "name: landing\nruntime: nodejs\n", "the working project is untouched");
  assert.deepEqual(readdirSync(f.parent), []);
});

test("a program that plants a project file next to its work copy stops the STATE steps from running there", () => {
  const f = fixture({ mode: "PROJECT", config: { program: "plant-in-parent" } });
  const result = runDestroyPreview(f.request, f.deps);
  assert.ok(!result.ok && result.code === "ADAPTER_FAILED", JSON.stringify(result));
  assert.deepEqual(f.fake.calls().map((c) => c.argv[0]), ["version", "stack", "destroy"]);
  assert.deepEqual(readdirSync(f.parent), []);
});

test("read-only directories left by the program do not stop the scratch tree from being removed", () => {
  const f = fixture({ mode: "PROJECT", config: { program: "leave-read-only" } });
  const result = runDestroyPreview(f.request, f.deps);
  assert.equal(result.ok, false);
  assert.deepEqual(readdirSync(f.parent), [], "nothing is left behind");
});

// --- Source boundary -----------------------------------------------------------------------

test("the adapter source has no bypass, no lock switch, no shell and no mutation argument", () => {
  const source = readFileSync(resolve("src/teardown/driver/adapters/pulumi.ts"), "utf8");
  assert.doesNotMatch(source, /\b(force|skip|ignore|bypass|override)\w*/i);
  assert.doesNotMatch(source, /-lock\b|lock=false/);
  assert.doesNotMatch(source, /child_process|spawn|exec\(|runAllowlistedProcess|shell: true/);
  const FORBIDDEN_LITERAL = /^(-{0,2}(apply|up|deploy|auto-approve|yes|refresh|cancel|rm|import|state)|-{1,2}(target|replace))(=.*)?$/;
  for (const match of source.matchAll(/"([^"\n]{1,60})"/g)) {
    assert.doesNotMatch(match[1].toLowerCase(), FORBIDDEN_LITERAL, '"' + match[1] + '"');
  }
  // The word `destroy` is a literal only inside lists that also carry --preview-only.
  const lines = source.split("\n").filter((line) => /"destroy"/.test(line));
  assert.equal(lines.length, 2);
  for (const line of lines) assert.match(line, /"--preview-only"/);
  assert.equal(existsSync(resolve("src/tools/pulumi-destroy.ts")), false);
});

test("the adapter is not reachable from the tool broker", () => {
  for (const name of readdirSync(resolve("src/tools"))) {
    if (!name.endsWith(".ts")) continue;
    assert.doesNotMatch(readFileSync(join(resolve("src/tools"), name), "utf8"), /teardown\/driver|adapters\/pulumi/, name);
  }
});
