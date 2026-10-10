import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import test from "node:test";

import { createChangeSet } from "../src/iac/changeset.js";
import {
  assertNoRawPayload,
  evidenceProblems,
  runDestroyPreview,
  runPreview,
  type DriverDeps,
  type DriverEngine,
  type DriverResult,
  type EngineAdapter,
  type PreviewRequest,
  type QualificationRecord,
} from "../src/teardown/driver/index.js";
import { createPulumiAdapter, isAllowedPulumiArgv } from "../src/teardown/driver/adapters/pulumi.js";
import { createTerraformAdapter, isAllowedArgv } from "../src/teardown/driver/adapters/terraform.js";
import { buildManifest, canonicalJson, type InputMode, type ManifestBody } from "../src/teardown/manifest.js";
import { captureProjectFiles, createImmutableSnapshot } from "../src/teardown/snapshot.js";
import { recordDeletionUnit } from "../src/teardown/unit.js";
import { sha256 } from "../src/build/provenance.js";
import { getToolSecurityPosture } from "../src/tools/broker.js";

// Denial-path matrix for the human-invoked destroy-preview driver
// (docs/destroy-preview-driver.md). Every denial runs the REAL driver with the
// REAL adapters in front of a fake engine executable. The adapter is wrapped
// in a counter and the executable records every call to a file, so "never
// invoked" is observed twice: no adapter entry and no child process. After each
// denial the driver's scratch parent and the process temp directory must be
// empty. The fake engines answer with canary secrets, so what the driver kept
// can be observed too.

const H = (char: string) => char.repeat(64);
const sha = (text: string) => createHash("sha256").update(text).digest("hex");

const root = mkdtempSync(join(tmpdir(), "alz-denials-"));
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

// --- The world: secrets, rows, files ----------------------------------------------------

const DISCOVERY_SECRETS = {
  AWS_ACCESS_KEY_ID: "AKIADISCOVERY00001", AWS_SECRET_ACCESS_KEY: "discovery-secret-key-0001",
  PULUMI_ACCESS_TOKEN: "discovery-pulumi-token-0002", PULUMI_CONFIG_PASSPHRASE: "discovery-passphrase-0003",
};
const STATE_SECRETS = {
  AWS_ACCESS_KEY_ID: "AKIASTATE000000002", AWS_SECRET_ACCESS_KEY: "state-secret-key-0004",
  PULUMI_ACCESS_TOKEN: "state-pulumi-token-0005", PULUMI_CONFIG_PASSPHRASE: "state-passphrase-0006",
};
/** What the operator's own shell holds. None of it may reach a child. */
const OPERATOR_AMBIENT: Record<string, string> = {
  AWS_ACCESS_KEY_ID: "AKIAOPERATOR0000003", AWS_SECRET_ACCESS_KEY: "operator-secret-key-0007",
  AWS_SESSION_TOKEN: "operator-session-token-0008", AWS_PROFILE: "operator-profile-0009",
  ARM_CLIENT_SECRET: "operator-arm-secret-0010", GITHUB_TOKEN: "ghp_operator0011",
  PULUMI_ACCESS_TOKEN: "operator-pulumi-token-0012", PULUMI_CONFIG_PASSPHRASE: "operator-passphrase-0013",
  TF_VAR_password: "operator-tf-var-0014",
  // A lock bypass smuggled through the environment.
  TF_CLI_ARGS: "-lock=false", TF_CLI_ARGS_plan: "-lock=false -refresh=false",
  HOME: "/home/operator-0015",
};
const CANARIES = {
  planVar: "CANARY_PLAN_VAR_5a01", planBefore: "CANARY_PLAN_BEFORE_5a02", stateOutput: "CANARY_STATE_OUTPUT_5a03",
  lineage: "CANARY_LINEAGE_5a04", stderr: "CANARY_STDERR_5a05", stackState: "CANARY_STACK_STATE_5a06",
  stackStep: "CANARY_STACK_STEP_5a07", planFile: "CANARY_PLANFILE_5a08",
};
const ALL_SECRETS = [
  ...Object.values(DISCOVERY_SECRETS), ...Object.values(STATE_SECRETS),
  ...Object.values(OPERATOR_AMBIENT).filter((value) => value.length > 8), ...Object.values(CANARIES),
];

type Row = {
  id: string;
  engine: DriverEngine;
  mode: InputMode;
  version: string;
  backend: string;
  workspace: string;
};
const TF_LOCATION = "s3://alz-state/prod/terraform.tfstate";
const PULUMI_BACKEND = "s3://alz-pulumi";
const ROWS: readonly Row[] = [
  { id: "TERRAFORM", engine: "TERRAFORM", mode: "PROJECT", version: "1.9.5", backend: TF_LOCATION, workspace: "default" },
  { id: "OPENTOFU", engine: "OPENTOFU", mode: "PROJECT", version: "1.9.0", backend: TF_LOCATION, workspace: "default" },
  { id: "PULUMI", engine: "PULUMI", mode: "PROJECT", version: "3.150.0", backend: PULUMI_BACKEND, workspace: "prod" },
  { id: "PULUMI/STATE_DERIVED", engine: "PULUMI", mode: "STATE_DERIVED", version: "3.150.0", backend: PULUMI_BACKEND, workspace: "prod" },
];
const isTerraformFamily = (row: Row) => row.engine !== "PULUMI";

const LOCK = '# This file is maintained automatically by "terraform init".\nprovider "registry.terraform.io/hashicorp/aws" {\n  version = "6.68.0"\n}\n';
const projectFiles = (row: Row): Record<string, string> => isTerraformFamily(row)
  ? { "main.tf": 'resource "aws_s3_bucket" "logs" {}\n', ".terraform.lock.hcl": LOCK, "modules/net/main.tf": "# module\n" }
  : { "Pulumi.yaml": "name: landing\nruntime: nodejs\n", "index.ts": 'export const bucket = "logs";\n' };
/** A project file that is safe to edit or delete in a test (never the lock file). */
const editableFile = (row: Row) => (isTerraformFamily(row) ? "main.tf" : "index.ts");

/** One fake for all three executables. It records every call, and answers with canary-seeded output. */
const FAKE = `#!${process.execPath}
const fs = require("fs"), path = require("path");
const dir = __dirname;
const exe = path.basename(process.argv[1]);
const args = process.argv.slice(2);
const log = (extra) => fs.appendFileSync(path.join(dir, "calls.jsonl"),
  JSON.stringify({ exe, args, cwd: process.cwd(), env: process.env, ...extra }) + "\\n");
const C = ${JSON.stringify(CANARIES)};
process.stderr.write(C.stderr + "\\n");
const versions = { terraform: "1.9.5", tofu: "1.9.0" };
if (exe === "pulumi") {
  const kind = args[0] === "stack" ? "export" : args[0];
  log({});
  if (kind === "version") process.stdout.write("v3.150.0\\n");
  else if (kind === "export") process.stdout.write(JSON.stringify({ version: 3, deployment: { resources: [{ urn: "u", outputs: { password: C.stackState } }] } }));
  else if (kind === "destroy" || kind === "preview") {
    process.stdout.write(JSON.stringify({
      steps: [{ op: kind === "destroy" ? "delete" : "create", urn: "urn:pulumi:prod::landing::aws:s3/bucket:Bucket::logs",
        type: "aws:s3/bucket:Bucket", oldState: { type: "aws:s3/bucket:Bucket", inputs: { password: C.stackStep }, outputs: { secret: C.stackStep } } }],
      changeSummary: {}, duration: 1,
    }));
  } else process.exit(64);
} else {
  const [cmd] = args;
  if (cmd === "version") { log({}); process.stdout.write(JSON.stringify({ terraform_version: versions[exe] })); }
  else if (cmd === "init") { fs.mkdirSync(".terraform", { recursive: true }); fs.writeFileSync(".terraform/terraform.tfstate", "{}"); log({}); }
  else if (cmd === "workspace") { log({}); if (args[1] === "show") process.stdout.write("default\\n"); }
  else if (cmd === "state") {
    log({});
    process.stdout.write(JSON.stringify({ version: 4, serial: 42, lineage: C.lineage, outputs: { o: { value: C.stateOutput } }, resources: [] }));
  } else if (cmd === "plan") {
    const p = path.resolve(process.cwd(), args.find((a) => a.startsWith("-out=")).slice(5));
    fs.writeFileSync(p, "BINARY-PLAN " + C.planFile);
    log({ planPath: p });
  } else if (cmd === "show") {
    const p = path.resolve(process.cwd(), args[2]);
    log({ planPath: p, planExists: fs.existsSync(p) });
    process.stdout.write(JSON.stringify({
      format_version: "1.2", terraform_version: versions[exe], errored: false,
      variables: { db_password: { value: C.planVar } },
      prior_state: { values: { root_module: { resources: [{ address: "aws_s3_bucket.logs", values: { password: C.planVar } }] } } },
      planned_values: { root_module: {} },
      resource_changes: [{ address: "aws_s3_bucket.logs", type: "aws_s3_bucket",
        change: { actions: ["delete"], before: { tags: { k: C.planBefore } }, before_sensitive: { tags: true }, after: null } }],
    }));
  } else { log({ unexpected: true }); process.exit(2); }
}
`;

type ChildCall = { exe: string; args: string[]; cwd: string; env: Record<string, string>; planPath?: string; planExists?: boolean };

type Body = Omit<ManifestBody, "schemaVersion" | "operation">;
type Loose = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const loose = (value: unknown) => value as Loose;

type Fixture = {
  row: Row;
  request: PreviewRequest;
  deps: DriverDeps;
  env: NodeJS.ProcessEnv;
  body: Body;
  adapter: EngineAdapter;
  adapterCalls: number;
  /** What the adapter itself left in the driver's scratch directory when it returned (the driver removes the rest). */
  leftByAdapter: string[][];
  tools: string;
  parent: string;
  sysTmp: string;
  projectRoot: string;
  childCalls(): ChildCall[];
  /** Replace the sealed manifest with one built from the original body plus `patch`. */
  reseal(patch: Partial<Body>): void;
  qualification(version?: string): QualificationRecord;
};

const unitFor = (row: Row) => recordDeletionUnit({
  buildId: "build-1", provider: "aws",
  stateRef: row.engine === "PULUMI"
    ? { engine: "PULUMI", backendUrl: row.backend, stack: row.workspace }
    : { engine: row.engine, backend: "s3", location: row.backend, workspace: row.workspace },
  designHash: H("1"),
  createPlan: createChangeSet(row.engine, [{ address: "aws_s3_bucket.logs", type: "aws_s3_bucket", operation: "CREATE" }]),
  recordedAt: "2026-10-10T08:00:00.000Z",
});

const identityEnv = (row: Row): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = {};
  for (const name of ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"] as const) {
    env["ALZ_DISCOVERY_" + name] = DISCOVERY_SECRETS[name];
    env["ALZ_STATE_" + name] = STATE_SECRETS[name];
  }
  if (!isTerraformFamily(row)) {
    for (const name of ["PULUMI_ACCESS_TOKEN", "PULUMI_CONFIG_PASSPHRASE"] as const) {
      env["ALZ_DISCOVERY_" + name] = DISCOVERY_SECRETS[name];
      env["ALZ_STATE_" + name] = STATE_SECRETS[name];
    }
    env.ALZ_DISCOVERY_PULUMI_BACKEND_URL = PULUMI_BACKEND;
    env.ALZ_STATE_PULUMI_BACKEND_URL = PULUMI_BACKEND;
    env.ALZ_APPROVED_HOSTS = "alz-pulumi";
  }
  return env;
};

function fixture(row: Row): Fixture {
  const finished = <T>(evidence: T, scratchDir: string): T => { fx.leftByAdapter.push(readdirSync(scratchDir)); return evidence; };
  const tools = fresh("tools");
  for (const name of ["terraform", "tofu", "pulumi"]) {
    writeFileSync(join(tools, name), FAKE);
    chmodSync(join(tools, name), 0o755);
  }
  const parent = fresh("scratch");
  const sysTmp = fresh("systmp");
  // Everything the driver and the runner create under the default temp directory lands here.
  process.env.TMPDIR = sysTmp;
  const projectRoot = fresh("project");
  for (const [path, content] of Object.entries(projectFiles(row))) {
    mkdirSync(join(projectRoot, path, ".."), { recursive: true });
    writeFileSync(join(projectRoot, path), content);
  }
  const unit = unitFor(row);
  const target = { account: "123456789012", backend: row.backend, workspace: row.workspace };
  const providers = [{ source: isTerraformFamily(row) ? "registry.terraform.io/hashicorp/aws" : "pulumi/aws", version: "6.68.0" }];
  const inputs = [{ name: "aws_region", identity: H("f") }];
  const body: Body = {
    engine: row.engine, mode: row.mode, target, unitHash: unit.unitHash, engineVersion: row.version, providers,
    lockFileSha256: isTerraformFamily(row) ? sha(LOCK) : undefined,
    files: row.mode === "PROJECT" ? captureProjectFiles(projectRoot) : [],
    dependencies: [], inputs,
    executionManifestSha256: row.mode === "STATE_DERIVED" ? H("e") : undefined,
    policyVersion: "2026-10-07.1",
  };
  const request: PreviewRequest = {
    engine: row.engine, mode: row.mode, target: { ...target },
    invocation: { operatorId: "jane.doe", interactiveSession: true, confirmedTarget: { ...target }, confirmedAt: "2026-10-10T09:30:00.000Z" },
    manifest: buildManifest(structuredClone(body)), unit, projectRoot,
    capabilities: { cloudRead: true, projectCodeExecution: row.mode === "PROJECT" },
    policyVersion: body.policyVersion,
    resolved: structuredClone({
      engineVersion: body.engineVersion, providers, lockFileSha256: body.lockFileSha256, dependencies: body.dependencies,
      inputs, executionManifestSha256: body.executionManifestSha256,
    }),
  };
  const real = row.engine === "PULUMI"
    ? createPulumiAdapter({ toolDirs: [tools] })
    : createTerraformAdapter(row.engine, { toolDirs: [tools] });
  const env: NodeJS.ProcessEnv = { ...identityEnv(row), ...OPERATOR_AMBIENT };
  const fx: Fixture = {
    row, request, env, body, tools, parent, sysTmp, projectRoot, adapterCalls: 0, leftByAdapter: [],
    adapter: {
      engine: real.engine, adapterVersion: real.adapterVersion, argvDigest: real.argvDigest,
      preview: (r, c) => { fx.adapterCalls++; return finished(real.preview(r, c), c.scratchDir); },
      destroyPreview: (r, c) => { fx.adapterCalls++; return finished(real.destroyPreview(r, c), c.scratchDir); },
    },
    deps: undefined as unknown as DriverDeps,
    childCalls: () => existsSync(join(tools, "calls.jsonl"))
      ? readFileSync(join(tools, "calls.jsonl"), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as ChildCall)
      : [],
    reseal: (patch) => { fx.request.manifest = buildManifest({ ...structuredClone(body), ...patch }); },
    qualification: (version = row.version) => ({
      engine: row.engine, adapterVersion: real.adapterVersion, engineVersion: version,
      argvDigest: real.argvDigest, qualifiedAt: "2026-10-10T07:00:00.000Z", evidenceHash: H("9"),
    }),
  };
  fx.deps = {
    adapters: [fx.adapter], qualifications: [fx.qualification()], env,
    now: () => new Date("2026-10-10T10:00:00.000Z"), scratchParent: parent,
  };
  return fx;
}

const OPERATIONS = [
  ["destroy preview", runDestroyPreview],
  ["ordinary preview", runPreview],
] as const;
type Run = (typeof OPERATIONS)[number][1];

/** The adapter and the child were never reached, and nothing was left on disk. */
function assertUntouched(fx: Fixture, label = "") {
  assert.equal(fx.adapterCalls, 0, label + "the adapter must not be invoked");
  assert.deepEqual(fx.childCalls(), [], label + "the child executable must not run");
  assert.deepEqual(readdirSync(fx.parent), [], label + "nothing is left in the scratch parent");
  assert.deepEqual(readdirSync(fx.sysTmp), [], label + "nothing is left in the temp directory");
}

function assertDenied(fx: Fixture, result: DriverResult, code: string | readonly string[], fields?: readonly string[]) {
  assert.equal(result.ok, false, "expected a refusal");
  if (result.ok) return;
  const codes = typeof code === "string" ? [code] : code;
  assert.ok(codes.includes(result.code), "expected " + codes.join(" or ") + " but got " + result.code + ": " + result.message);
  for (const field of fields ?? []) assert.ok(result.fields?.includes(field), "fields should name " + field + ", got " + JSON.stringify(result.fields));
  assertUntouched(fx);
  const text = JSON.stringify(result);
  for (const secret of ALL_SECRETS) assert.equal(text.includes(secret), false, "a refusal must not carry " + secret);
}

// --- The denial matrix ------------------------------------------------------------------

type Denial = {
  name: string;
  /** Rows this denial applies to. Defaults to all. */
  rows?: (row: Row) => boolean;
  /** Operations it applies to. Defaults to both for project rows and destroy preview for state-derived. */
  operations?: readonly ("destroy preview" | "ordinary preview")[];
  setup: (fx: Fixture) => void;
  code: string | readonly string[] | ((row: Row, operation: string) => string | readonly string[]);
  fields?: readonly string[] | ((row: Row) => readonly string[]);
};

const projectOnly = (row: Row) => row.mode === "PROJECT";
const stateDerivedOnly = (row: Row) => row.mode === "STATE_DERIVED";
const rewriteTarget = (fx: Fixture, key: "account" | "backend" | "workspace", value: string) => {
  fx.request.target[key] = value;
};
const replaceEnv = (fx: Fixture, env: NodeJS.ProcessEnv) => {
  for (const key of Object.keys(fx.env)) delete fx.env[key];
  Object.assign(fx.env, env);
};
/** Marks a sealed manifest as carrying `extra`, then re-seals the hash so only the state rule can stop it. */
const resealedWith = (fx: Fixture, extra: Loose) => {
  const { manifestHash: _old, ...body } = fx.request.manifest;
  const tampered = { ...body, ...extra };
  loose(fx.request).manifest = { ...tampered, manifestHash: sha256(canonicalJson(tampered)) };
};

const DENIALS: Denial[] = [];
const deny = (denial: Denial) => { DENIALS.push(denial); };

// 1. A person invoked it.
const NO_HUMAN = "HUMAN_INVOCATION_REQUIRED";
deny({ name: "no human invocation record", setup: (fx) => { delete loose(fx.request).invocation; }, code: NO_HUMAN });
deny({ name: "invocation record is null", setup: (fx) => { loose(fx.request).invocation = null; }, code: NO_HUMAN });
deny({ name: "invocation record is a string", setup: (fx) => { loose(fx.request).invocation = "jane.doe"; }, code: NO_HUMAN });
deny({ name: "the whole request is null", setup: (fx) => { loose(fx).request = null; }, code: NO_HUMAN });
deny({ name: "the session is not interactive", setup: (fx) => { loose(fx.request.invocation).interactiveSession = false; }, code: NO_HUMAN });
deny({ name: "interactiveSession is the string 'true'", setup: (fx) => { loose(fx.request.invocation).interactiveSession = "true"; }, code: NO_HUMAN });
deny({ name: "no operator id", setup: (fx) => { delete loose(fx.request.invocation).operatorId; }, code: NO_HUMAN });
deny({ name: "empty operator id", setup: (fx) => { fx.request.invocation.operatorId = ""; }, code: NO_HUMAN });
deny({ name: "operator id shaped like a command", setup: (fx) => { fx.request.invocation.operatorId = "jane; rm -rf /"; }, code: NO_HUMAN });
deny({ name: "no confirmation time", setup: (fx) => { delete loose(fx.request.invocation).confirmedAt; }, code: NO_HUMAN });
deny({ name: "confirmation time is not a date", setup: (fx) => { fx.request.invocation.confirmedAt = "yesterday-ish"; }, code: NO_HUMAN });

// 2. The operator typed the exact target.
const NO_MATCH = "HUMAN_CONFIRMATION_MISMATCH";
for (const key of ["account", "backend", "workspace"] as const) {
  deny({ name: "wrong confirmation of the " + key, setup: (fx) => { fx.request.invocation.confirmedTarget[key] = "something-else"; }, code: NO_MATCH });
  deny({ name: "empty confirmation of the " + key, setup: (fx) => { fx.request.invocation.confirmedTarget[key] = ""; }, code: NO_MATCH });
  deny({ name: "the " + key + " confirmation differs only in trailing whitespace", setup: (fx) => { fx.request.invocation.confirmedTarget[key] += " "; }, code: NO_MATCH });
  deny({ name: "the " + key + " confirmation differs only in case", setup: (fx) => { fx.request.invocation.confirmedTarget[key] = fx.request.invocation.confirmedTarget[key].toUpperCase() + "X"; }, code: NO_MATCH });
  deny({ name: "the request's " + key + " was changed after the operator confirmed", setup: (fx) => { rewriteTarget(fx, key, "changed-after-confirmation"); }, code: NO_MATCH });
}
deny({ name: "no confirmed target at all", setup: (fx) => { delete loose(fx.request.invocation).confirmedTarget; }, code: NO_MATCH });
deny({ name: "confirmed target is a string", setup: (fx) => { loose(fx.request.invocation).confirmedTarget = "all of it"; }, code: NO_MATCH });
deny({ name: "no target in the request", setup: (fx) => { delete loose(fx.request).target; }, code: NO_MATCH });
deny({
  name: "empty target confirmed by an empty target",
  setup: (fx) => { fx.request.target = { account: "", backend: "", workspace: "" }; fx.request.invocation.confirmedTarget = { account: "", backend: "", workspace: "" }; },
  code: "UNIT_TARGET_MISMATCH",
});
deny({
  name: "empty account confirmed by an empty account",
  setup: (fx) => { fx.request.target.account = ""; fx.request.invocation.confirmedTarget.account = ""; },
  code: "REVIEW_REQUIRED", fields: ["target.account"],
});

// 3. Unknown and force-shaped fields.
const UNKNOWN = "UNKNOWN_REQUEST_FIELD";
const FORCE_SHAPED = [
  "force", "forcePreview", "force_preview", "skipValidation", "skip", "skipManifest", "ignoreManifest", "ignore", "ignoreMismatch",
  "override", "overrideManifest", "bypass", "allowMismatch", "noLock", "lock", "unlock", "lockFalse", "autoApprove", "yes",
  "apply", "destroy", "execute", "shell", "command", "argv", "args", "env", "dryRun", "unsafe", "trustMe",
];
for (const name of FORCE_SHAPED) {
  for (const value of [true, false] as const) {
    deny({ name: "unknown top-level field '" + name + "' = " + value, setup: (fx) => { loose(fx.request)[name] = value; }, code: UNKNOWN });
  }
}
deny({
  name: "a field named __proto__ (own property)",
  setup: (fx) => { Object.defineProperty(fx.request, "__proto__", { value: { force: true }, enumerable: true, configurable: true }); },
  code: UNKNOWN,
});
for (const nested of ["invocation", "confirmedTarget", "target", "capabilities", "resolved"] as const) {
  for (const name of ["force", "skipChecks", "ignoreLock", "override"]) {
    deny({
      name: "unknown field '" + name + "' inside " + nested,
      setup: (fx) => {
        const holder = nested === "confirmedTarget" ? fx.request.invocation.confirmedTarget : loose(fx.request)[nested];
        loose(holder)[name] = true;
      },
      code: UNKNOWN,
    });
  }
}

// 4. Qualification.
const UNQUALIFIED = "ENGINE_NOT_QUALIFIED";
deny({ name: "engine unqualified: no record at all", setup: (fx) => { fx.deps.qualifications = []; }, code: UNQUALIFIED });
deny({
  name: "engine unqualified: only another engine has a record",
  setup: (fx) => {
    const other = ROWS.find((r) => r.engine !== fx.row.engine)!;
    fx.deps.qualifications = [{ ...fx.qualification(), engine: other.engine }];
  },
  code: UNQUALIFIED,
});
deny({ name: "engine unqualified: the record is malformed", setup: (fx) => { fx.deps.qualifications = [{ ...fx.qualification(), argvDigest: "not-a-digest" }]; }, code: UNQUALIFIED });
deny({ name: "engine unqualified: the record has no evidence hash", setup: (fx) => { fx.deps.qualifications = [{ ...fx.qualification(), evidenceHash: "" }]; }, code: UNQUALIFIED });
deny({ name: "qualification for a different argv digest", setup: (fx) => { fx.deps.qualifications = [{ ...fx.qualification(), argvDigest: H("0") }]; }, code: UNQUALIFIED });
deny({ name: "qualification for a different engine version", setup: (fx) => { fx.deps.qualifications = [fx.qualification("0.0.1")]; }, code: UNQUALIFIED });
deny({ name: "qualification for a different adapter version", setup: (fx) => { fx.deps.qualifications = [{ ...fx.qualification(), adapterVersion: "0.0.1" }]; }, code: UNQUALIFIED });
deny({
  name: "qualification matches three records, none of which matches on all three fields",
  setup: (fx) => {
    fx.deps.qualifications = [
      { ...fx.qualification(), argvDigest: H("0") }, fx.qualification("0.0.1"), { ...fx.qualification(), adapterVersion: "0.0.1" },
    ];
  },
  code: UNQUALIFIED,
});
deny({ name: "the request names an engine version nobody qualified", setup: (fx) => { fx.request.resolved.engineVersion = "9.9.9"; }, code: UNQUALIFIED });
deny({ name: "the request names no resolved inputs", setup: (fx) => { delete loose(fx.request).resolved; }, code: UNQUALIFIED });
deny({ name: "no adapter is registered for the engine", setup: (fx) => { fx.deps.adapters = []; }, code: UNQUALIFIED });
deny({ name: "the engine is not one of the three", setup: (fx) => { loose(fx.request).engine = "BICEP"; }, code: UNQUALIFIED });

// 5. Project code execution.
for (const [label, set] of [
  ["false", (fx: Fixture) => { fx.request.capabilities.projectCodeExecution = false; }],
  ["absent", (fx: Fixture) => { delete loose(fx.request.capabilities).projectCodeExecution; }],
  ["the string 'true'", (fx: Fixture) => { loose(fx.request.capabilities).projectCodeExecution = "true"; }],
  ["the number 1", (fx: Fixture) => { loose(fx.request.capabilities).projectCodeExecution = 1; }],
  ["null", (fx: Fixture) => { loose(fx.request.capabilities).projectCodeExecution = null; }],
  ["cloudRead granted but nothing else", (fx: Fixture) => { fx.request.capabilities = { cloudRead: true, projectCodeExecution: false }; }],
] as const) {
  deny({ name: "PROJECT mode without PROJECT_CODE_EXECUTION (" + label + ")", rows: projectOnly, setup: set, code: "PROJECT_CODE_EXECUTION_REQUIRED" });
}
deny({ name: "PROJECT mode with no capabilities object", rows: projectOnly, setup: (fx) => { delete loose(fx.request).capabilities; }, code: "PROJECT_CODE_EXECUTION_REQUIRED" });
deny({
  name: "PROJECT mode downgraded to STATE_DERIVED to avoid the capability",
  rows: projectOnly, operations: ["destroy preview"],
  setup: (fx) => { fx.request.mode = "STATE_DERIVED"; fx.request.capabilities.projectCodeExecution = false; },
  code: "REVIEW_REQUIRED", fields: ["mode"],
});
deny({
  name: "a state-derived manifest replayed as PROJECT mode without the capability",
  rows: stateDerivedOnly, operations: ["destroy preview"],
  setup: (fx) => { fx.request.mode = "PROJECT"; },
  code: "PROJECT_CODE_EXECUTION_REQUIRED",
});
deny({
  name: "a state-derived manifest replayed as PROJECT mode with the capability",
  rows: stateDerivedOnly, operations: ["destroy preview"],
  setup: (fx) => { fx.request.mode = "PROJECT"; fx.request.capabilities.projectCodeExecution = true; },
  code: "REVIEW_REQUIRED", fields: ["mode"],
});
deny({
  name: "an ordinary preview in state-derived mode",
  rows: stateDerivedOnly, operations: ["ordinary preview"],
  setup: () => {}, code: "MODE_NOT_SUPPORTED",
});

// 6. Identities.
const NO_IDENTITY = "IDENTITY_NOT_CONFIGURED";
const without = (prefix: string) => (fx: Fixture) => {
  replaceEnv(fx, Object.fromEntries(Object.entries(fx.env).filter(([key]) => !key.startsWith(prefix))));
};
deny({ name: "identity missing: DISCOVERY", setup: without("ALZ_DISCOVERY_"), code: NO_IDENTITY });
deny({ name: "identity missing: STATE", setup: without("ALZ_STATE_"), code: NO_IDENTITY });
deny({
  name: "identity missing: both, with the operator's ambient credentials present",
  setup: (fx) => { replaceEnv(fx, { ...OPERATOR_AMBIENT }); }, code: NO_IDENTITY,
});
deny({ name: "identity missing: an empty environment", setup: (fx) => { replaceEnv(fx, {}); }, code: NO_IDENTITY });
deny({
  name: "identity missing: DISCOVERY variables exist but are empty",
  setup: (fx) => { for (const key of Object.keys(fx.env)) if (key.startsWith("ALZ_DISCOVERY_")) fx.env[key] = ""; },
  code: NO_IDENTITY,
});
deny({
  name: "identity missing: STATE variables are unset (undefined)",
  setup: (fx) => { for (const key of Object.keys(fx.env)) if (key.startsWith("ALZ_STATE_")) fx.env[key] = undefined; },
  code: NO_IDENTITY,
});
deny({
  name: "identity missing: operator credentials stand in for neither",
  setup: (fx) => { replaceEnv(fx, { ALZ_DISCOVERY_AWS_ACCESS_KEY_ID: DISCOVERY_SECRETS.AWS_ACCESS_KEY_ID, ...OPERATOR_AMBIENT }); },
  code: NO_IDENTITY,
});
for (const name of ["AWS_SECRET_ACCESS_KEY", "AWS_ACCESS_KEY_ID"] as const) {
  deny({
    name: "DISCOVERY and STATE configured with the same " + name,
    setup: (fx) => { fx.env["ALZ_STATE_" + name] = fx.env["ALZ_DISCOVERY_" + name]; },
    code: "IDENTITY_COLLAPSED",
  });
}
deny({
  name: "DISCOVERY and STATE configured with the same Pulumi access token",
  rows: (row) => row.engine === "PULUMI",
  setup: (fx) => { fx.env.ALZ_STATE_PULUMI_ACCESS_TOKEN = fx.env.ALZ_DISCOVERY_PULUMI_ACCESS_TOKEN; },
  code: "IDENTITY_COLLAPSED",
});
for (const prefix of ["ALZ_DEPLOY_", "ALZ_DEPLOYMENT_", "ALZ_OPERATOR_", "ALZ_ADMIN_", "ALZ_APPLY_", "ALZ_DESTROY_"]) {
  deny({
    name: prefix + "* variable present beside valid identities",
    setup: (fx) => { fx.env[prefix + "AWS_ACCESS_KEY_ID"] = "forbidden-identity-secret-0016"; },
    code: "IDENTITY_FORBIDDEN",
  });
}
deny({
  name: "ALZ_DEPLOY_* variable present with an empty-looking value",
  setup: (fx) => { fx.env.ALZ_DEPLOY_ROLE_ARN = "arn:aws:iam::123456789012:role/deployer"; },
  code: "IDENTITY_FORBIDDEN",
});

// 7. The unit and the sealed manifest.
deny({ name: "deletion unit tampered with", setup: (fx) => { fx.request.unit.plannedCreates = ["aws_s3_bucket.other"]; }, code: "UNIT_INVALID" });
deny({ name: "no deletion unit", setup: (fx) => { delete loose(fx.request).unit; }, code: "UNIT_INVALID" });
deny({
  name: "the request targets another workspace than the unit recorded",
  setup: (fx) => { rewriteTarget(fx, "workspace", "staging"); fx.request.invocation.confirmedTarget.workspace = "staging"; },
  code: "UNIT_TARGET_MISMATCH",
});
deny({
  name: "the request targets another backend than the unit recorded",
  setup: (fx) => { rewriteTarget(fx, "backend", "s3://elsewhere/x"); fx.request.invocation.confirmedTarget.backend = "s3://elsewhere/x"; },
  code: "UNIT_TARGET_MISMATCH",
});
deny({ name: "no manifest", setup: (fx) => { delete loose(fx.request).manifest; }, code: "MANIFEST_INVALID" });
deny({ name: "manifest is null", setup: (fx) => { loose(fx.request).manifest = null; }, code: "MANIFEST_INVALID" });
deny({ name: "manifest without its seal", setup: (fx) => { delete loose(fx.request.manifest).manifestHash; }, code: "MANIFEST_INVALID" });
deny({ name: "manifest edited after sealing", setup: (fx) => { fx.request.manifest.policyVersion = "edited-after-sealing"; }, code: "MANIFEST_INVALID" });
deny({ name: "manifest seal replaced by a made-up hash", setup: (fx) => { fx.request.manifest.manifestHash = H("a"); }, code: "MANIFEST_INVALID" });
for (const [name, extra] of [
  ["a state serial", { stateSerial: "42" }],
  ["a lineage", { lineage: "abc" }],
  ["an etag", { etag: "W/abc" }],
  ["a version id", { versionId: "3Lg" }],
  ["a state field nested in the target", { target: { account: "123456789012", backend: "x", workspace: "y", stateVersion: "1" } }],
  ["a state field nested in an input", { inputs: [{ name: "aws_region", identity: H("f"), stateSerial: "1" }] }],
] as const) {
  deny({ name: "manifest containing " + name + " (re-sealed so only the state rule can refuse it)", setup: (fx) => { resealedWith(fx, extra); }, code: "MANIFEST_INVALID" });
}

// 8. Each manifest field mismatch: the approved manifest differs from what is requested.
const other = (row: Row): DriverEngine => (row.engine === "TERRAFORM" ? "OPENTOFU" : "TERRAFORM");
const mismatch = (
  name: string,
  fields: readonly string[] | ((row: Row) => readonly string[]),
  patch: (fx: Fixture) => Partial<Body>,
  rows?: (row: Row) => boolean,
) => deny({ name: "manifest mismatch: " + name, rows, setup: (fx) => { fx.reseal(patch(fx)); }, code: "REVIEW_REQUIRED", fields });
mismatch("engine", ["engine"], (fx) => ({ engine: other(fx.row), lockFileSha256: fx.body.lockFileSha256 ?? H("b") }), projectOnly);
mismatch("engine version", ["engineVersion"], () => ({ engineVersion: "0.0.1" }));
mismatch("provider added", ["providers"], (fx) => ({ providers: [...fx.body.providers, { source: "registry.example/evil/x", version: "1.0.0" }] }));
mismatch("provider version changed", ["providers"], (fx) => ({ providers: [{ ...fx.body.providers[0], version: "7.0.0" }] }));
mismatch("provider removed", ["providers"], () => ({ providers: [] }));
mismatch("lock file", ["lockFileSha256"], () => ({ lockFileSha256: H("c") }), projectOnly);
mismatch("file changed", ["files"], (fx) => ({ files: fx.body.files.map((file, index) => (index === 0 ? { ...file, sha256: H("d") } : file)) }), projectOnly);
mismatch("file added", ["files"], (fx) => ({ files: [...fx.body.files, { path: "extra.tf", sha256: H("d") }] }), projectOnly);
mismatch("file removed", ["files"], (fx) => ({ files: fx.body.files.slice(1) }), projectOnly);
mismatch("dependency added", ["dependencies"], (fx) => ({ dependencies: [...fx.body.dependencies, { name: "left-pad", version: "1.3.0", integrity: H("d") }] }), projectOnly);
mismatch("input identity changed", ["inputs"], (fx) => ({ inputs: [{ ...fx.body.inputs[0], identity: H("d") }] }));
mismatch("input added", ["inputs"], (fx) => ({ inputs: [...fx.body.inputs, { name: "extra_var", identity: H("d") }] }));
mismatch("input removed", ["inputs"], () => ({ inputs: [] }));
for (const key of ["account", "backend", "workspace"] as const) {
  mismatch("target " + key, ["target." + key], (fx) => ({ target: { ...fx.body.target, [key]: "approved-something-else" } }));
}
mismatch("unit hash", ["unitHash"], () => ({ unitHash: H("d") }));
mismatch("policy version", ["policyVersion"], () => ({ policyVersion: "2099-01-01.1" }));
mismatch("execution manifest", ["executionManifestSha256"], () => ({ executionManifestSha256: H("d") }), stateDerivedOnly);

// ... and the request side: what the caller resolved differs from the approved manifest.
const resolvedMismatch = (name: string, fields: readonly string[], change: (fx: Fixture) => void, rows?: (row: Row) => boolean) =>
  deny({ name: "request mismatch: " + name, rows, setup: change, code: "REVIEW_REQUIRED", fields });
resolvedMismatch("engine version (and a record exists for it)", ["engineVersion"], (fx) => {
  fx.request.resolved.engineVersion = "9.9.9";
  fx.deps.qualifications = [...fx.deps.qualifications, fx.qualification("9.9.9")];
});
resolvedMismatch("providers", ["providers"], (fx) => { fx.request.resolved.providers = [{ ...fx.request.resolved.providers[0], version: "7.0.0" }]; });
resolvedMismatch("lock file", ["lockFileSha256"], (fx) => { fx.request.resolved.lockFileSha256 = H("c"); }, projectOnly);
resolvedMismatch("dependencies", ["dependencies"], (fx) => { fx.request.resolved.dependencies = [{ name: "left-pad", version: "1.3.0", integrity: H("d") }]; }, projectOnly);
resolvedMismatch("inputs", ["inputs"], (fx) => { fx.request.resolved.inputs = []; });
resolvedMismatch("policy version", ["policyVersion"], (fx) => { fx.request.policyVersion = "2099-01-01.1"; });
resolvedMismatch("execution manifest", ["executionManifestSha256"], (fx) => { fx.request.resolved.executionManifestSha256 = H("d"); }, stateDerivedOnly);

// 9. The source changed after approval, and what the project holds.
const sourceChanged = (name: string, change: (fx: Fixture) => void) =>
  deny({ name: "source changed after approval: " + name, rows: projectOnly, setup: change, code: "REVIEW_REQUIRED", fields: ["files"] });
sourceChanged("a file was edited", (fx) => { writeFileSync(join(fx.projectRoot, editableFile(fx.row)), "# edited after approval\n"); });
sourceChanged("a file was appended to", (fx) => {
  writeFileSync(join(fx.projectRoot, editableFile(fx.row)), readFileSync(join(fx.projectRoot, editableFile(fx.row)), "utf8") + "# one more line\n");
});
sourceChanged("a file was added", (fx) => { writeFileSync(join(fx.projectRoot, "extra.tf"), "# new\n"); });
sourceChanged("a file was added in a new directory", (fx) => {
  mkdirSync(join(fx.projectRoot, "modules", "late"), { recursive: true });
  writeFileSync(join(fx.projectRoot, "modules", "late", "main.tf"), "# new\n");
});
sourceChanged("a file was deleted", (fx) => { unlinkSync(join(fx.projectRoot, editableFile(fx.row))); });
for (const leftover of ["terraform.tfstate", "terraform.tfstate.backup", "prod.tfplan", ".agentic-preview.tfplan", "modules/net/terraform.tfstate"]) {
  deny({
    name: "leftover state or plan file in the project: " + leftover,
    rows: projectOnly,
    setup: (fx) => {
      mkdirSync(join(fx.projectRoot, leftover, ".."), { recursive: true });
      writeFileSync(join(fx.projectRoot, leftover), JSON.stringify({ secret: CANARIES.stateOutput }));
    },
    code: "SNAPSHOT_REFUSED",
  });
}
deny({
  name: "a symbolic link in the project",
  rows: projectOnly,
  setup: (fx) => { symlinkSync("/etc/hostname", join(fx.projectRoot, "link.tf")); },
  code: "SNAPSHOT_REFUSED",
});
deny({ name: "the project root does not exist", rows: projectOnly, setup: (fx) => { fx.request.projectRoot = join(fx.projectRoot, "gone"); }, code: "SNAPSHOT_REFUSED" });
deny({
  name: "a file changes between the review hash and the snapshot copy",
  rows: projectOnly,
  setup: (fx) => {
    fx.deps.createSnapshot = (rootDir, manifest, parent) => {
      writeFileSync(join(rootDir, editableFile(fx.row)), "# swapped between hash and copy\n");
      return createImmutableSnapshot(rootDir, manifest, parent);
    };
  },
  code: "SNAPSHOT_REFUSED",
});
deny({
  name: "the snapshot is altered after it was made (verified again right before the run)",
  rows: projectOnly,
  setup: (fx) => {
    fx.deps.createSnapshot = (rootDir, manifest, parent) => {
      const snapshot = createImmutableSnapshot(rootDir, manifest, parent);
      const file = join(snapshot.path, editableFile(fx.row));
      chmodSync(file, 0o600);
      writeFileSync(file, "# swapped after the copy\n");
      return snapshot;
    };
  },
  code: "SNAPSHOT_CHANGED",
});

function codeFor(denial: Denial, row: Row, operation: string): readonly string[] {
  const code = typeof denial.code === "function" ? denial.code(row, operation) : denial.code;
  return typeof code === "string" ? [code] : code;
}

for (const denial of DENIALS) {
  for (const row of ROWS) {
    if (denial.rows && !denial.rows(row)) continue;
    for (const [operation, run] of OPERATIONS) {
      const operations = denial.operations ?? (row.mode === "PROJECT" ? ["destroy preview", "ordinary preview"] : ["destroy preview"]);
      if (!operations.includes(operation)) continue;
      test("denied [" + row.id + ", " + operation + "]: " + denial.name, () => {
        const fx = fixture(row);
        denial.setup(fx);
        const result = (run as Run)(fx.request, fx.deps);
        const fields = typeof denial.fields === "function" ? denial.fields(row) : denial.fields;
        assertDenied(fx, result, codeFor(denial, row, operation), fields);
      });
    }
  }
}

test("the matrix covers every denial for every engine", () => {
  // A guard against the table silently shrinking.
  assert.ok(DENIALS.length >= 200, "denials: " + DENIALS.length);
  for (const row of ROWS) {
    const count = DENIALS.filter((denial) => !denial.rows || denial.rows(row)).length;
    assert.ok(count >= 150, row.id + " covers " + count);
  }
});

// --- Successful runs: environment, evidence, cleanup ---------------------------------------

function ran(row: Row, run: Run = runDestroyPreview) {
  const fx = fixture(row);
  const result = run(fx.request, fx.deps);
  assert.equal(result.ok, true, result.ok ? "" : result.code + ": " + result.message);
  if (!result.ok) throw new Error("unreachable");
  return { fx, result };
}
const secretValues = (identity: Record<string, string>) => Object.values(identity);
const hasAny = (call: ChildCall, values: readonly string[]) => values.some((value) => Object.values(call.env).includes(value));

for (const row of ROWS) {
  test("[" + row.id + "] the child never sees the operator's ambient credentials, and never both identities at once", () => {
    const { fx } = ran(row);
    const calls = fx.childCalls();
    assert.ok(calls.length > 0, "the fake engine ran");
    const operatorValues = Object.values(OPERATOR_AMBIENT);
    for (const call of calls) {
      const label = call.exe + " " + call.args.join(" ");
      assert.equal(hasAny(call, operatorValues), false, label + " saw an operator value");
      for (const name of ["TF_CLI_ARGS", "TF_CLI_ARGS_plan", "TF_VAR_password", "GITHUB_TOKEN", "AWS_PROFILE", "ARM_CLIENT_SECRET", "AWS_SESSION_TOKEN"]) {
        assert.equal(name in call.env, false, label + " was given " + name);
      }
      assert.notEqual(call.env.HOME, OPERATOR_AMBIENT.HOME, label);
      // Steps that need no credentials are given none: the engine version and the plan JSON.
      if (isTerraformFamily(row) && (call.args[0] === "version" || call.args[0] === "show")) {
        assert.equal(hasAny(call, [...secretValues(STATE_SECRETS), ...secretValues(DISCOVERY_SECRETS)]), false, label + " was given an identity");
      }
      assert.equal(hasAny(call, secretValues(STATE_SECRETS)) && hasAny(call, secretValues(DISCOVERY_SECRETS)), false,
        label + " held both the STATE and the DISCOVERY secrets");
      assert.equal(Object.keys(call.env).some((key) => /^ALZ_(DEPLOY|OPERATOR|ADMIN|APPLY|DESTROY)/.test(key)), false, label);
    }
    // Each identity is used: the state reads carry STATE, the provider reads carry DISCOVERY.
    assert.ok(calls.some((call) => hasAny(call, secretValues(STATE_SECRETS))), "a STATE step ran");
    assert.ok(row.engine === "PULUMI" && row.mode === "STATE_DERIVED" ? true : calls.some((call) => hasAny(call, secretValues(DISCOVERY_SECRETS))),
      "a DISCOVERY step ran");
  });

  test("[" + row.id + "] the child never sees operator credentials taken from process.env either", () => {
    const saved = { ...process.env };
    const fx = fixture(row);
    try {
      for (const [key, value] of Object.entries({ ...identityEnv(row), ...OPERATOR_AMBIENT })) process.env[key] = value;
      process.env.TMPDIR = fx.sysTmp;
      const deps: DriverDeps = { ...fx.deps, env: undefined };
      const result = runDestroyPreview(fx.request, deps);
      assert.equal(result.ok, true, result.ok ? "" : result.code + ": " + result.message);
    } finally {
      for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
      Object.assign(process.env, saved);
    }
    const operatorValues = Object.values(OPERATOR_AMBIENT);
    for (const call of fx.childCalls()) {
      assert.equal(hasAny(call, operatorValues), false, call.exe + " " + call.args.join(" "));
      assert.equal("TF_CLI_ARGS" in call.env, false);
    }
  });

  test("[" + row.id + "] a destroy preview runs only pinned argument lists, and the ordinary preview never runs a destroy one", () => {
    const argvOk = (call: ChildCall) => row.engine === "PULUMI"
      ? isAllowedPulumiArgv([call.exe, ...call.args])
      : isAllowedArgv(row.engine as "TERRAFORM" | "OPENTOFU", call.exe, call.args);
    const destroyShaped = (call: ChildCall) => call.args.some((arg) => /^-{1,2}destroy$/.test(arg) || arg === "destroy" || arg === "--preview-only");
    const FORBIDDEN_ARG = /^-{1,2}(lock(=.*)?|auto-approve|yes|y|target|replace|force|skip-preview|show-secrets)$|^(apply|up|refresh|import|taint|force-unlock)$/;
    const { fx: destroy } = ran(row);
    const destroyCalls = destroy.childCalls();
    for (const call of destroyCalls) {
      assert.ok(argvOk(call), "not a pinned argument list: " + call.exe + " " + call.args.join(" "));
      assert.ok(!call.args.some((arg) => FORBIDDEN_ARG.test(arg)), call.args.join(" "));
    }
    assert.equal(destroyCalls.filter(destroyShaped).length, 1, "exactly one destroy-shaped call, and it is a preview");
    if (row.engine === "PULUMI") {
      assert.ok(destroyCalls.filter(destroyShaped).every((call) => call.args.includes("--preview-only")));
    } else {
      assert.ok(destroyCalls.filter(destroyShaped).every((call) => call.args[0] === "plan" && call.args.includes("-destroy")));
    }
    if (row.mode === "PROJECT") {
      const { fx: ordinary } = ran(row, runPreview);
      for (const call of ordinary.childCalls()) {
        assert.ok(argvOk(call), call.args.join(" "));
        assert.equal(destroyShaped(call), false, "an ordinary preview ran a destroy-shaped call: " + call.args.join(" "));
      }
    }
  });

  test("[" + row.id + "] evidence holds no canary secret and no raw show-json marker", () => {
    const runs = row.mode === "PROJECT" ? OPERATIONS : OPERATIONS.slice(0, 1);
    for (const [operation, run] of runs) {
      const { result } = ran(row, run);
      const text = JSON.stringify(result);
      for (const secret of ALL_SECRETS) assert.equal(text.includes(secret), false, operation + " leaked " + secret);
      for (const marker of ["resource_changes", "prior_state", "planned_values", "before_sensitive", "oldState", "deployment", "checkpoint", "variables"]) {
        assert.equal(text.includes(marker), false, operation + " carries the raw marker " + marker);
      }
      assert.deepEqual(evidenceProblems(result.evidence, ALL_SECRETS), []);
      assert.doesNotThrow(() => assertNoRawPayload(result.evidence, ALL_SECRETS));
      assert.deepEqual(result.evidence.changes.resources.map((resource) => resource.operation), [operation === "destroy preview" ? "DELETE" : result.evidence.changes.resources[0].operation]);
      assert.deepEqual(result.evidence.authority, { infrastructureAct: "DISABLED", mutation: "NONE", executionMode: "PREVIEW_ONLY", agentInitiated: false });
    }
  });

  test("[" + row.id + "] a successful run leaves no plan file and no snapshot directory behind", () => {
    const { fx } = ran(row);
    assert.deepEqual(readdirSync(fx.parent), [], "scratch parent");
    assert.deepEqual(readdirSync(fx.sysTmp), [], "temp directory");
    assert.deepEqual(fx.leftByAdapter, [[]], "the adapter removed its plan file and work directory before returning");
    const planCalls = fx.childCalls().filter((call) => call.planPath !== undefined);
    if (row.mode === "PROJECT" && isTerraformFamily(row)) assert.ok(planCalls.length >= 2, "the plan file was written and read");
    for (const call of planCalls) assert.equal(existsSync(call.planPath!), false, call.planPath + " must be deleted");
    // The working project gained nothing: no plan, no state, no cache.
    const after = readdirSync(fx.projectRoot, { recursive: true }).map(String).sort();
    const expected = Object.keys(projectFiles(row)).flatMap((path) => {
      const parts = path.split("/");
      return parts.map((_, index) => parts.slice(0, index + 1).join("/"));
    });
    assert.deepEqual(after, [...new Set(expected)].sort());
    // Nothing anywhere under this test's directories holds a plan or the canary plan bytes.
    const found: string[] = [];
    const scan = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        if (statSync(full).isDirectory()) scan(full);
        else if (/\.tfplan$/.test(name) || /\.tfstate/.test(name) && relative(fx.tools, full).startsWith("..")) found.push(full);
      }
    };
    for (const dir of [fx.parent, fx.sysTmp, fx.projectRoot]) scan(dir);
    assert.deepEqual(found, []);
  });

  test("[" + row.id + "] a failing engine leaves nothing behind and the failure text carries no engine output", () => {
    const fx = fixture(row);
    // The fake exits non-zero for every call once its tools directory holds this marker script.
    for (const name of ["terraform", "tofu", "pulumi"]) {
      writeFileSync(join(fx.tools, name), FAKE.replace('const args = process.argv.slice(2);', 'const args = process.argv.slice(2);\nif (args[0] !== "version" && args[0] !== "init" && args[0] !== "workspace" && args[0] !== "state" && args[0] !== "stack") { process.stderr.write("boom " + ' + JSON.stringify(CANARIES.stackStep) + '); process.exit(1); }'));
    }
    const result = runDestroyPreview(fx.request, fx.deps);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, "ADAPTER_FAILED");
    const text = JSON.stringify(result);
    for (const secret of ALL_SECRETS) assert.equal(text.includes(secret), false, secret);
    assert.deepEqual(readdirSync(fx.parent), []);
    assert.deepEqual(readdirSync(fx.sysTmp), []);
    for (const call of fx.childCalls()) if (call.planPath) assert.equal(existsSync(call.planPath), false);
  });
}

// --- Qualification independence --------------------------------------------------------------

test("a qualified Terraform runs while Pulumi and OpenTofu are registered and unqualified", () => {
  const terraform = fixture(ROWS[0]);
  const tofu = fixture(ROWS[1]);
  const pulumi = fixture(ROWS[2]);
  terraform.deps.adapters = [pulumi.adapter, tofu.adapter, terraform.adapter];
  terraform.deps.qualifications = [terraform.qualification()];
  process.env.TMPDIR = terraform.sysTmp;
  const result = runDestroyPreview(terraform.request, terraform.deps);
  assert.equal(result.ok, true, result.ok ? "" : result.code + ": " + result.message);
  assert.equal(terraform.adapterCalls, 1);
  assert.equal(pulumi.adapterCalls + tofu.adapterCalls, 0);
  assert.deepEqual([...pulumi.childCalls(), ...tofu.childCalls()], []);
  // And the unqualified ones are refused on their own account, with the other engine's record in hand.
  for (const [row, fx] of [[ROWS[1], tofu], [ROWS[2], pulumi]] as const) {
    fx.deps.adapters = [terraform.adapter, tofu.adapter, pulumi.adapter];
    fx.deps.qualifications = [terraform.qualification()];
    process.env.TMPDIR = fx.sysTmp;
    assertDenied(fx, runDestroyPreview(fx.request, fx.deps), "ENGINE_NOT_QUALIFIED");
    assert.equal(row.engine === fx.row.engine, true);
  }
});

test("a qualified Pulumi runs while Terraform and OpenTofu are registered and unqualified, and a bad record disables only its engine", () => {
  const pulumi = fixture(ROWS[2]);
  const terraform = fixture(ROWS[0]);
  const tofu = fixture(ROWS[1]);
  pulumi.deps.adapters = [terraform.adapter, tofu.adapter, pulumi.adapter];
  pulumi.deps.qualifications = [{ ...terraform.qualification(), argvDigest: "broken" }, pulumi.qualification()];
  const result = runDestroyPreview(pulumi.request, pulumi.deps);
  assert.equal(result.ok, true, result.ok ? "" : result.code + ": " + result.message);
  assert.equal(pulumi.adapterCalls, 1);
  assert.equal(terraform.adapterCalls + tofu.adapterCalls, 0);
  assert.deepEqual([...terraform.childCalls(), ...tofu.childCalls()], []);
  // The same registry refuses Terraform: its own record is the broken one.
  terraform.deps.adapters = pulumi.deps.adapters;
  terraform.deps.qualifications = pulumi.deps.qualifications;
  process.env.TMPDIR = terraform.sysTmp;
  assertDenied(terraform, runDestroyPreview(terraform.request, terraform.deps), "ENGINE_NOT_QUALIFIED");
});

test("every engine is refused with no qualification and every engine runs with its own", () => {
  for (const row of ROWS) {
    const fx = fixture(row);
    fx.deps.qualifications = [];
    assertDenied(fx, runDestroyPreview(fx.request, fx.deps), "ENGINE_NOT_QUALIFIED");
    const ok = fixture(row);
    assert.equal(runDestroyPreview(ok.request, ok.deps).ok, true, row.id);
  }
});

// --- Source-level boundary -------------------------------------------------------------------

const BROKER_ALLOWLIST: readonly string[] = [
  "ansible_preview", "ansible_syntax_check", "ansible_version", "aws_cloudtrail_trails", "aws_config_recorders",
  "aws_controltower_list_landing_zones", "aws_org_describe", "aws_org_list_scps", "aws_sts_identity", "aws_version",
  "azure_account_show", "azure_management_groups", "azure_policy_assignments", "azure_version", "bicep_build",
  "bicep_lint", "bicep_version", "bicep_what_if", "cdk_preview", "cdk_synth", "cdk_version", "cloudformation_preview",
  "cloudformation_validate", "cloudformation_version", "crossplane_preview", "crossplane_validate", "crossplane_version",
  "opentofu_fmt_check", "opentofu_plan", "opentofu_validate", "opentofu_version", "pulumi_preview", "pulumi_version",
  "query_environment", "show_evidence", "terraform_fmt_check", "terraform_plan", "terraform_validate", "terraform_version",
];

test("the broker allowlist is exactly the 39 tools, contains no driver tool, and the broker cannot reach the driver", () => {
  const { allowedTools } = getToolSecurityPosture();
  assert.equal(BROKER_ALLOWLIST.length, 39);
  assert.deepEqual(allowedTools, [...BROKER_ALLOWLIST].sort());
  for (const tool of allowedTools) {
    assert.doesNotMatch(tool, /destroy|driver|teardown|preview_only|run_preview|apply|force/i, tool);
  }
  for (const name of readdirSync(resolve("src/tools"))) {
    if (!name.endsWith(".ts")) continue;
    const code = codeOnly(readFileSync(join(resolve("src/tools"), name), "utf8"));
    assert.doesNotMatch(code, /teardown|runDestroyPreview|destroyPreview|runPreview\b/, "src/tools/" + name);
  }
});

/** Source text with comments removed, so a prose mention of a flag is not an argv. */
function codeOnly(source: string): string {
  let out = "";
  let previous = "";
  let i = 0;
  while (i < source.length) {
    const char = source[i];
    const next = source[i + 1];
    if (char === "/" && next === "/") { while (i < source.length && source[i] !== "\n") i++; continue; }
    if (char === "/" && next === "*") { const end = source.indexOf("*/", i + 2); i = end < 0 ? source.length : end + 2; out += " "; continue; }
    if (char === '"' || char === "'" || char === "`") {
      let j = i + 1;
      while (j < source.length && source[j] !== char) { if (source[j] === "\\") j++; j++; }
      out += source.slice(i, j + 1); i = j + 1; previous = char; continue;
    }
    if (char === "/" && (previous === "" || "(,=:[!&|?{};".includes(previous))) {
      let j = i + 1;
      let inClass = false;
      while (j < source.length) {
        const c = source[j];
        if (c === "\\") { j += 2; continue; }
        if (c === "[") inClass = true; else if (c === "]") inClass = false; else if (c === "/" && !inClass) break;
        j++;
      }
      out += source.slice(i, j + 1); i = j + 1; previous = ")"; continue;
    }
    out += char;
    if (!/\s/.test(char)) previous = char;
    i++;
  }
  return out;
}

const sourcesUnder = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
  const full = join(dir, entry.name);
  if (entry.isDirectory()) return sourcesUnder(full);
  return /\.(ts|tsx)$/.test(entry.name) ? [full] : [];
});
const rel = (path: string) => relative(process.cwd(), path).split("\\").join("/");
const DRIVER_FILES = sourcesUnder(resolve("src/teardown/driver"));

test("the comment stripper keeps code and drops prose, so the scans below mean what they say", () => {
  const driver = codeOnly(readFileSync(resolve("src/teardown/driver/driver.ts"), "utf8"));
  assert.match(driver, /export function runDestroyPreview/);
  assert.doesNotMatch(driver, /The human-invoked preview driver/);
  assert.doesNotMatch(driver, /\/\*|\*\//);
  const adapter = codeOnly(readFileSync(resolve("src/teardown/driver/adapters/terraform.ts"), "utf8"));
  assert.match(adapter, /"-destroy"/);
  assert.doesNotMatch(adapter, /plans a destroy; it never runs one/);
  assert.equal(codeOnly('const re = /["\'`]/; // "-destroy"\nconst s = "a // b";'), 'const re = /["\'`]/; \nconst s = "a // b";');
  assert.ok(DRIVER_FILES.length >= 6, DRIVER_FILES.map(rel).join(","));
});

test("no source outside the driver, its adapters and the teardown CLI contains a -destroy or --preview-only argument", () => {
  const allowed = (path: string) => rel(path).startsWith("src/teardown/driver/") || /^src\/cli\/teardown[^/]*\.ts$/.test(rel(path));
  const files = sourcesUnder(resolve("src"));
  assert.ok(files.length > 100);
  const hits: string[] = [];
  for (const path of files) {
    if (allowed(path)) continue;
    const code = codeOnly(readFileSync(path, "utf8"));
    for (const match of code.matchAll(/(["'`])((?:(?!\1)[^\\\n]|\\.)*)\1/g)) {
      if (/(^|\s)-{1,2}(destroy|preview-only)(\b|=)/i.test(match[2])) hits.push(rel(path) + ": " + match[0]);
    }
  }
  assert.deepEqual(hits, [], "a destroy-shaped argument outside the driver. See docs/teardown-broker-review.md");
  // The scan does see the allowed places, so an empty result is not a blind scan.
  const terraform = codeOnly(readFileSync(resolve("src/teardown/driver/adapters/terraform.ts"), "utf8"));
  assert.match(terraform, /"-destroy"/);
  const pulumi = codeOnly(readFileSync(resolve("src/teardown/driver/adapters/pulumi.ts"), "utf8"));
  assert.match(pulumi, /"--preview-only"/);
});

test("no source under the driver contains apply, auto-approve, -lock=false, shell: true, exec( or execSync", () => {
  for (const path of DRIVER_FILES) {
    const code = codeOnly(readFileSync(path, "utf8"));
    const name = rel(path);
    assert.doesNotMatch(code, /\bapply\b/i, name);
    assert.doesNotMatch(code, /auto-?approve/i, name);
    assert.doesNotMatch(code, /-lock\b|lock\s*=\s*false|lock\s*:\s*false/i, name);
    assert.doesNotMatch(code, /shell\s*:\s*true/, name);
    assert.doesNotMatch(code, /\bexec\s*\(|\bexecSync\b|\bexecFile(Sync)?\b|\bspawn(Sync)?\b|\bfork\s*\(/, name);
    assert.doesNotMatch(code, /child_process/, name);
    assert.doesNotMatch(code, /\beval\s*\(|new\s+Function\s*\(/, name);
    // No bypass of any spelling. rmSync's `force: true` is a file-deletion option, not a switch for a check.
    assert.doesNotMatch(code.replace(/rmSync\([^)]*\)/g, ""), /\b(force|skip|ignore|bypass|override)\w*/i, name);
    // Mutation vocabulary, as a command word or flag in a string: never an argument.
    for (const match of code.matchAll(/(["'`])((?:(?!\1)[^\\\n]|\\.)*)\1/g)) {
      assert.doesNotMatch(match[2], /^-{0,2}(apply|up|deploy|auto-approve|yes|force|force-unlock|import|taint)(=.*)?$/i, name + ": " + match[0]);
    }
  }
});

test("the driver is human-invoked only: no module under src/ other than the CLI imports it", () => {
  for (const path of sourcesUnder(resolve("src"))) {
    const name = rel(path);
    if (name.startsWith("src/teardown/driver/") || /^src\/cli\/teardown[^/]*\.ts$/.test(name)) continue;
    const code = codeOnly(readFileSync(path, "utf8"));
    assert.doesNotMatch(code, /from\s+["'][^"']*teardown\/driver/, name);
    assert.doesNotMatch(code, /\brunDestroyPreview\b|\bcreateTerraformAdapter\b|\bcreatePulumiAdapter\b/, name);
  }
});

// --- Mutation checks guard ---------------------------------------------------------------------

test("the fake engine really is the only thing that could run: an unlisted tools directory finds nothing", () => {
  // Proves the denial assertions can fail: with the fake in place a successful run is recorded.
  const fx = fixture(ROWS[0]);
  assert.deepEqual(fx.childCalls(), []);
  assert.equal(runDestroyPreview(fx.request, fx.deps).ok, true);
  assert.ok(fx.childCalls().length >= 6);
  assert.equal(fx.adapterCalls, 1);
});
