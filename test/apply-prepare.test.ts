import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { loadPilotContract } from "../src/apply/contract.js";
import { lockedProviders, LockFileError } from "../src/apply/lockfile.js";
import {
  preparationIsCurrent, preparationUnitHash, prepareApply, PREPARATION_LABEL, TERRAFORM_LOCK_FILE, writePreparation,
  type PrepareDeps, type PrepareRefusal, type Prepared,
} from "../src/apply/prepare.js";
import { LOCK_FILE } from "../src/teardown/driver/adapters/project-copy.js";
import { validateManifestForRequest, verifyManifest } from "../src/teardown/manifest.js";
import { captureProjectFiles } from "../src/teardown/snapshot.js";
import {
  awsContractJson, awsTargetOf, contractJson, ENGINE_VERSION, installFakeTerraform, LOCK, pinPathOf, sha, targetOf,
  testFixtureForgeQualificationEvidence, writePinnedContract, writeProject,
} from "./helpers/apply-fixtures.js";
import { cdkContractJson, cdkTargetOf, installFakeAws, writeAssembly } from "./helpers/cdk-fixtures.js";

// Preparation is local: these tests run no engine, read no cloud and need no credential. The fake tools only exist so
// the "is the tool installed" check has something to find; prepare never runs them.
process.env.AGENTIC_EVIDENCE_KEY ??= randomBytes(32).toString("base64");

const root = mkdtempSync(join(tmpdir(), "alz-prepare-"));
test.after(() => rmSync(root, { recursive: true, force: true }));
const POLICY = "pilot-policy-2026-10-25";
let counter = 0;

type Setup = { dir: string; deps: PrepareDeps; killPath: string; toolDir: string };
function setup(contract: (killPath: string) => Record<string, unknown>, tools: "terraform" | "aws" | "none" = "terraform"): Setup {
  const dir = join(root, "case-" + (counter += 1));
  const toolDir = join(dir, "tools");
  mkdirSync(toolDir, { recursive: true });
  if (tools === "terraform") installFakeTerraform(toolDir);
  if (tools === "aws") installFakeAws(toolDir);
  const killPath = join(dir, "kill-switch");
  const contractPath = join(dir, "contract.json");
  writePinnedContract(contractPath, contract(killPath));
  return { dir, killPath, toolDir, deps: { contractPath, pinPath: pinPathOf(contractPath), qualificationDir: join(dir, "vault"), toolDirs: [toolDir] } };
}

const awsTf = (over: Record<string, unknown> = {}) => (kill: string) => awsContractJson(kill, { policyVersion: POLICY, ...over });
const azureTf = (over: Record<string, unknown> = {}) => (kill: string) => contractJson(kill, { policyVersion: POLICY, ...over });
const awsCdk = (over: Record<string, unknown> = {}) => (kill: string) => cdkContractJson(kill, [], { policyVersion: POLICY, ...over });

function terraformProject(s: Setup, environment: "DEV" | "QA" | "PROD" = "DEV"): string {
  const project = join(s.dir, "project");
  mkdirSync(project, { recursive: true });
  writeProject(project, awsTargetOf(environment));
  return project;
}

const ok = (result: Prepared | PrepareRefusal): Prepared => {
  assert.equal(result.ok, true, result.ok ? "" : result.code + ": " + result.message);
  return result as Prepared;
};
const refused = (result: Prepared | PrepareRefusal, code: string, blocker?: string): PrepareRefusal => {
  assert.equal(result.ok, false, "expected a refusal");
  const refusal = result as PrepareRefusal;
  assert.equal(refusal.code, code, refusal.message);
  if (blocker) assert.equal(refusal.blocker, blocker);
  return refusal;
};

test("Terraform on AWS: the request and manifest come from the contract and the project, and bind exactly as seal binds them", async () => {
  const s = setup(awsTf());
  const project = terraformProject(s);
  const prepared = ok(await prepareApply({ environment: "DEV", projectRoot: project }, s.deps));
  assert.deepEqual(Object.keys(prepared.request).sort(), ["environment", "policyVersion", "projectRoot", "resolved", "target"],
    "exactly the keys the seal request accepts");
  assert.deepEqual(prepared.request.target, awsTargetOf("DEV"));
  assert.equal(prepared.request.policyVersion, POLICY, "policy version comes from the contract");
  assert.deepEqual(prepared.request.resolved.providers, [{ source: "registry.terraform.io/hashicorp/azurerm", version: "4.10.0" }]);
  assert.equal(prepared.request.resolved.lockFileSha256, sha(LOCK));
  assert.deepEqual(prepared.request.resolved.inputs, []);
  assert.deepEqual(prepared.request.resolved.dependencies, []);
  assert.equal(verifyManifest(prepared.manifest).manifestHash, prepared.manifest.manifestHash);
  const binding = validateManifestForRequest(prepared.manifest, {
    engine: "TERRAFORM", mode: "PROJECT", target: prepared.request.target, unitHash: prepared.manifest.unitHash,
    files: captureProjectFiles(project), policyVersion: prepared.request.policyVersion, ...prepared.request.resolved,
  });
  assert.equal(binding.ok, true);
  assert.equal(prepared.summary.label, PREPARATION_LABEL);
  assert.equal(prepared.summary.path, "PRIMARY");
  assert.equal(prepared.summary.region, "us-east-1");
  assert.equal(prepared.summary.engineVersionSource, "TESTED_PIN");
  assert.equal(prepared.summary.engineVersion, "1.16.4");
  assert.equal(prepared.next.step, "qualify", "no qualification record yet, so DEV qualifies first");
  assert.ok(prepared.gaps.some((gap) => /not derived yet/.test(gap)));
  assert.ok(prepared.gaps.some((gap) => /not qualification evidence/.test(gap)));
});

test("a qualified path takes its engine version from the qualification record and hands off to seal", async () => {
  const s = setup(awsTf());
  await testFixtureForgeQualificationEvidence(s.deps.qualificationDir!, "preview", "AWS");
  const prepared = ok(await prepareApply({ environment: "DEV", projectRoot: terraformProject(s) }, s.deps));
  assert.equal(prepared.summary.engineVersionSource, "QUALIFICATION_RECORD");
  assert.equal(prepared.summary.engineVersion, ENGINE_VERSION);
  assert.equal(prepared.next.step, "seal");
});

test("QA before DEV is qualified is prepared but blocked on the owner, with the exact reason", async () => {
  const s = setup(awsTf());
  const prepared = ok(await prepareApply({ environment: "QA", projectRoot: terraformProject(s, "QA") }, s.deps));
  assert.deepEqual(prepared.next, { step: "blocked", blocker: "OWNER", reason: "The TERRAFORM path must be qualified in DEV before QA can be sealed." });
});

test("CDK is the AWS secondary path: no lock file, no providers, and the AWS CLI version is asked only until it is qualified", async () => {
  const s = setup(awsCdk(), "aws");
  const assembly = join(s.dir, "cdk.out");
  writeAssembly(assembly, cdkTargetOf("DEV"));
  refused(await prepareApply({ environment: "DEV", projectRoot: assembly }, s.deps), "ENGINE_VERSION_REQUIRED", "OPERATOR");
  refused(await prepareApply({ environment: "DEV", projectRoot: assembly, awsCliVersion: "two" }, s.deps), "ENGINE_VERSION_REQUIRED", "OPERATOR");
  const prepared = ok(await prepareApply({ environment: "DEV", projectRoot: assembly, awsCliVersion: "2.15.0" }, s.deps));
  assert.equal(prepared.summary.engine, "CDK");
  assert.equal(prepared.summary.path, "SECONDARY");
  assert.equal(prepared.summary.engineVersionSource, "OPERATOR");
  assert.deepEqual(prepared.request.resolved.providers, []);
  assert.equal(prepared.request.resolved.lockFileSha256, undefined);
  assert.equal(prepared.manifest.engine, "CDK");
});

test("owner prerequisites stop preparation with the owner named, and never offer another path around them", async () => {
  const missing = setup(awsTf());
  rmSync(missing.deps.contractPath!);
  const disabled = refused(await prepareApply({ environment: "DEV", projectRoot: join(missing.dir, "x") }, missing.deps), "CONTRACT_DISABLED", "OWNER");
  assert.equal(disabled.alternative, undefined);

  const stopped = setup(awsTf());
  writeFileSync(stopped.killPath, "stop");
  assert.equal(refused(await prepareApply({ environment: "DEV", projectRoot: terraformProject(stopped) }, stopped.deps), "KILL_SWITCH_ACTIVE", "OWNER").alternative, undefined);

  const noPolicy = setup((kill) => awsContractJson(kill));
  assert.equal(refused(await prepareApply({ environment: "DEV", projectRoot: terraformProject(noPolicy) }, noPolicy.deps), "POLICY_VERSION_MISSING", "OWNER").alternative, undefined);

  const devOnly = setup(awsTf({ enabledEnvironments: ["DEV"], targets: { DEV: { accountId: awsTargetOf("DEV").account, region: "us-east-1", backend: awsTargetOf("DEV").backend, workspace: "default" } }, requiredApprovals: { DEV: 1 } }));
  refused(await prepareApply({ environment: "PROD", projectRoot: terraformProject(devOnly, "PROD") }, devOnly.deps), "TARGET_NOT_IN_CONTRACT", "OWNER");
  refused(await prepareApply({ environment: "STAGING", projectRoot: terraformProject(devOnly) }, devOnly.deps), "ENVIRONMENT_INVALID", "OPERATOR");
});

test("a missing engine tool explains the supported alternative for that provider and says what it requires", async () => {
  const aws = setup(awsTf(), "none");
  const awsRefusal = refused(await prepareApply({ environment: "DEV", projectRoot: terraformProject(aws) }, aws.deps), "TOOL_UNAVAILABLE", "TOOL");
  assert.match(awsRefusal.alternative ?? "", /pin a contract for CDK/);
  assert.match(awsRefusal.alternative ?? "", /own reviewed contract, its own preview and its own approvals/);

  const azure = setup(azureTf(), "none");
  const project = join(azure.dir, "project");
  mkdirSync(project);
  writeProject(project, targetOf("DEV"));
  const azureRefusal = refused(await prepareApply({ environment: "DEV", projectRoot: project }, azure.deps), "TOOL_UNAVAILABLE", "TOOL");
  assert.match(azureRefusal.alternative ?? "", /Bicep .* not supported for apply yet/);
});

test("projects that do not match the engine, are not clean, or cannot be fingerprinted are refused, never patched up", async () => {
  const s = setup(awsTf());
  const cdkFolder = join(s.dir, "cdk.out");
  writeAssembly(cdkFolder, cdkTargetOf("DEV"));
  assert.match(refused(await prepareApply({ environment: "DEV", projectRoot: cdkFolder }, s.deps), "PROJECT_ENGINE_MISMATCH").message, /CDK cloud assembly/);

  const cdk = setup(awsCdk(), "aws");
  assert.match(refused(await prepareApply({ environment: "DEV", projectRoot: terraformProject(cdk), awsCliVersion: "2.15.0" }, cdk.deps), "PROJECT_ENGINE_MISMATCH").message, /Terraform project/);

  refused(await prepareApply({ environment: "DEV", projectRoot: join(s.dir, "no-such-folder") }, s.deps), "PROJECT_INVALID");

  const noLock = terraformProject(setup(awsTf()));
  rmSync(join(noLock, TERRAFORM_LOCK_FILE));
  refused(await prepareApply({ environment: "DEV", projectRoot: noLock }, s.deps), "LOCK_FILE_MISSING");

  const badLock = terraformProject(setup(awsTf()));
  writeFileSync(join(badLock, TERRAFORM_LOCK_FILE), 'provider "registry.terraform.io/hashicorp/aws" {\n  constraints = ">= 5.0"\n}\n');
  refused(await prepareApply({ environment: "DEV", projectRoot: badLock }, s.deps), "LOCK_FILE_UNREADABLE");

  const dirty = terraformProject(setup(awsTf()));
  mkdirSync(join(dirty, ".terraform"));
  refused(await prepareApply({ environment: "DEV", projectRoot: dirty }, s.deps), "PROJECT_NOT_CLEAN");

  const withState = terraformProject(setup(awsTf()));
  writeFileSync(join(withState, "terraform.tfstate"), "{}");
  refused(await prepareApply({ environment: "DEV", projectRoot: withState }, s.deps), "PROJECT_SNAPSHOT_REFUSED");

  const withLink = terraformProject(setup(awsTf()));
  symlinkSync(join(root), join(withLink, "elsewhere"));
  refused(await prepareApply({ environment: "DEV", projectRoot: withLink }, s.deps), "PROJECT_SNAPSHOT_REFUSED");
});

test("the files are private, named by the manifest hash, and written all or nothing", async () => {
  const s = setup(awsTf());
  const prepared = ok(await prepareApply({ environment: "DEV", projectRoot: terraformProject(s) }, s.deps));
  const out = join(s.dir, "out");
  const paths = writePreparation(prepared, out);
  const tag = prepared.manifest.manifestHash.slice(0, 16);
  assert.deepEqual(readdirSync(join(out, "DEV")).sort(), ["manifest-" + tag + ".json", "preparation-" + tag + ".json", "request-" + tag + ".json"]);
  for (const path of Object.values(paths)) assert.equal(statSync(path).mode & 0o777, 0o600, path);
  assert.deepEqual(JSON.parse(readFileSync(paths.request, "utf8")), prepared.request);
  assert.equal(verifyManifest(JSON.parse(readFileSync(paths.manifest, "utf8"))).manifestHash, prepared.manifest.manifestHash);
  const record = JSON.parse(readFileSync(paths.record, "utf8"));
  assert.equal(record.label, "LOCAL_PREPARATION");
  assert.equal(record.next.step, "qualify");
  assert.equal(writePreparation(prepared, out).request, paths.request, "preparing the same project again gives the same names");

  const blocked = join(s.dir, "out-blocked");
  mkdirSync(join(blocked, "DEV", "manifest-" + tag + ".json"), { recursive: true });
  assert.throws(() => writePreparation(prepared, blocked));
  assert.deepEqual(readdirSync(join(blocked, "DEV")), ["manifest-" + tag + ".json"], "an interrupted write leaves no other or partial file");
});

test("a project changed after preparation is no longer current, and its old manifest no longer binds", async () => {
  const s = setup(awsTf());
  const project = terraformProject(s);
  const prepared = ok(await prepareApply({ environment: "DEV", projectRoot: project }, s.deps));
  assert.equal(preparationIsCurrent(prepared.manifest, project), true);
  writeFileSync(join(project, "main.tf"), 'resource "aws_s3_bucket" "changed" {}\n');
  assert.equal(preparationIsCurrent(prepared.manifest, project), false);
  const stale = validateManifestForRequest(prepared.manifest, {
    engine: "TERRAFORM", mode: "PROJECT", target: prepared.request.target, unitHash: prepared.manifest.unitHash,
    files: captureProjectFiles(project), policyVersion: prepared.request.policyVersion, ...prepared.request.resolved,
  });
  assert.equal(stale.ok, false);
});

test("the preparation unit hash is reproducible and changes with the environment, target or files", () => {
  const base = { engine: "TERRAFORM" as const, environment: "DEV" as const, target: awsTargetOf("DEV"), files: [{ path: "main.tf", sha256: "a".repeat(64) }] };
  assert.equal(preparationUnitHash(base), preparationUnitHash({ ...base }));
  assert.match(preparationUnitHash(base), /^[0-9a-f]{64}$/);
  assert.notEqual(preparationUnitHash(base), preparationUnitHash({ ...base, environment: "QA" }));
  assert.notEqual(preparationUnitHash(base), preparationUnitHash({ ...base, target: awsTargetOf("QA") }));
  assert.notEqual(preparationUnitHash(base), preparationUnitHash({ ...base, files: [{ path: "main.tf", sha256: "b".repeat(64) }] }));
});

test("the lock file reader returns sorted providers and refuses duplicates, missing versions and empty files", () => {
  const lock = [
    'provider "registry.terraform.io/hashicorp/random" {', '  version     = "3.6.0"', '  constraints = ">= 3.0.0"', "  hashes = [", '    "h1:abc=",', "  ]", "}",
    "", 'provider "registry.terraform.io/hashicorp/aws" {', '  version = "5.70.0"', "}", "",
  ].join("\n");
  assert.deepEqual(lockedProviders(lock), [
    { source: "registry.terraform.io/hashicorp/aws", version: "5.70.0" },
    { source: "registry.terraform.io/hashicorp/random", version: "3.6.0" },
  ]);
  const code = (text: string) => { try { lockedProviders(text); return "none"; } catch (error) { return (error as LockFileError).code; } };
  assert.equal(code(lock + 'provider "registry.terraform.io/hashicorp/aws" {\n  version = "5.71.0"\n}\n'), "LOCK_FILE_DUPLICATE_PROVIDER");
  assert.equal(code('provider "registry.terraform.io/hashicorp/aws" {\n  constraints = ">= 5"\n}\n'), "LOCK_FILE_UNREADABLE");
  assert.equal(code("# no providers\n"), "LOCK_FILE_EMPTY");
  assert.equal(TERRAFORM_LOCK_FILE, LOCK_FILE, "prepare checks the same lock file name the engines use");
});

test("the contract's policyVersion is optional, kept exactly, and refused when it holds unsafe text", () => {
  const dir = join(root, "policy");
  mkdirSync(dir);
  const path = join(dir, "contract.json");
  writePinnedContract(path, awsContractJson(join(dir, "kill"), { policyVersion: POLICY }));
  const loaded = loadPilotContract(path, pinPathOf(path));
  assert.equal("reason" in loaded ? "" : loaded.policyVersion, POLICY);
  writePinnedContract(path, awsContractJson(join(dir, "kill"), { policyVersion: "bad\nvalue" }));
  const bad = loadPilotContract(path, pinPathOf(path));
  assert.equal("reason" in bad && bad.code, "CONTRACT_INVALID");
});

test("preparation starts no process, reaches no engine session and calls nothing that seals, approves or applies", () => {
  const source = readFileSync(resolve(import.meta.dirname, "..", "src", "apply", "prepare.ts"), "utf8");
  assert.doesNotMatch(source, /child_process|spawn\(|execFile|execSync/);
  const imports = [...source.matchAll(/from\s+"([^"]+)"/g)].map((match) => match[1]);
  for (const forbidden of ["./driver.js", "./seal.js", "./approvals.js", "./ledger.js", "./engines/terraform.js", "./engines/cdk.js", "../cli/apply.js"]) {
    assert.ok(!imports.includes(forbidden), "prepare.ts must not import " + forbidden);
  }
  assert.ok(!existsSync(join(root, ".runs")), "tests write only under their own temp folder");
});
