import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { loadPilotContract } from "../src/apply/contract.js";
import { loadToolPins } from "../src/deps/pins.js";
import { lockedProviders, LockFileError, OFFICIAL_PROVIDER_HASHES, REVIEWED_PROVIDER_VERSIONS, unreviewedProviderVersion } from "../src/apply/lockfile.js";
import { AWS_DENIED_TYPES_REVIEWED_AGAINST } from "../src/apply/providers/aws.js";
import { AZURE_DENIED_TYPES_REVIEWED_AGAINST } from "../src/apply/providers/azure.js";
import {
  preparationIsCurrent, preparationUnitHash, prepareApply, PREPARATION_LABEL, TERRAFORM_LOCK_FILE, writePreparation,
  type PrepareDeps, type PrepareRefusal, type Prepared,
} from "../src/apply/prepare.js";
import { LOCK_FILE } from "../src/teardown/driver/adapters/project-copy.js";
import { validateManifestForRequest, verifyManifest } from "../src/teardown/manifest.js";
import { captureProjectFiles } from "../src/teardown/snapshot.js";
import {
  AWS_LOCK, awsContractJson, awsTargetOf, contractJson, ENGINE_VERSION, installFakeTerraform, LOCK, sha, targetOf,
  testFixtureForgeQualificationEvidence, writeReviewedContract, writeProject,
} from "./helpers/apply-fixtures.js";
import { cdkContractJson, cdkTargetOf, installFakeAws, PARAMETER_CANARY, writeAssembly } from "./helpers/cdk-fixtures.js";

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
  writeReviewedContract(contractPath, contract(killPath));
  return { dir, killPath, toolDir, deps: { contractPath, qualificationDir: join(dir, "vault"), toolDirs: [toolDir] } };
}

const awsTf = (over: Record<string, unknown> = {}) => (kill: string) => awsContractJson(kill, { policyVersion: POLICY, ...over });
const azureTf = (over: Record<string, unknown> = {}) => (kill: string) => contractJson(kill, { policyVersion: POLICY, ...over });
const awsCdk = (over: Record<string, unknown> = {}) => (kill: string) => cdkContractJson(kill, [], { policyVersion: POLICY, ...over });

function terraformProject(s: Setup, environment: "DEV" | "QA" | "PROD" = "DEV"): string {
  const project = join(s.dir, "project");
  mkdirSync(project, { recursive: true });
  // Each cloud path locks its own provider at the reviewed version (an AWS project's lock names aws, an Azure one's azurerm).
  const provider = (JSON.parse(readFileSync(s.deps.contractPath!, "utf8")) as { provider: string }).provider;
  writeProject(project, awsTargetOf(environment), undefined, provider === "AWS" ? AWS_LOCK : LOCK);
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
  assert.deepEqual(prepared.request.resolved.providers, [{ source: "registry.terraform.io/hashicorp/aws", version: "6.68.0" }]);
  assert.equal(prepared.request.resolved.lockFileSha256, sha(AWS_LOCK));
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
  assert.ok(prepared.gaps.some((gap) => /local folder inside the project/.test(gap)), "dependencies are stated, not left as a gap");
  assert.ok(!prepared.gaps.some((gap) => /not derived yet/.test(gap)));
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

test("CDK is the AWS secondary path: no lock file, no providers, and the engine version is the tested AWS CLI pin until it is qualified; nobody is asked, and a version that is not the pin is refused", async () => {
  const s = setup(awsCdk(), "aws");
  const assembly = join(s.dir, "cdk.out");
  writeAssembly(assembly, cdkTargetOf("DEV"));
  const pin = loadToolPins().awsCli.version;
  assert.match(pin, /^2\.\d+\.\d+$/);
  const prepared = ok(await prepareApply({ environment: "DEV", projectRoot: assembly }, s.deps));
  assert.equal(prepared.summary.engineVersion, pin);
  assert.equal(prepared.summary.engineVersionSource, "TESTED_PIN");
  // The pin named explicitly (an older caller) is the same preparation; any other version, or a non-version, is refused with the tested version named.
  assert.equal(ok(await prepareApply({ environment: "DEV", projectRoot: assembly, awsCliVersion: pin }, s.deps)).summary.engineVersion, pin);
  const other = refused(await prepareApply({ environment: "DEV", projectRoot: assembly, awsCliVersion: "2.15.0" }, s.deps), "ENGINE_VERSION_REQUIRED", "OPERATOR");
  const at = other.message.indexOf("tested with AWS CLI " + pin);
  assert.ok(at >= 0 && other.message.indexOf("2.15.0 is not it", at) > at, other.message);
  assert.match(refused(await prepareApply({ environment: "DEV", projectRoot: assembly, awsCliVersion: "two" }, s.deps), "ENGINE_VERSION_REQUIRED", "OPERATOR").message, /not an AWS CLI version/);
  assert.equal(prepared.summary.engine, "CDK");
  assert.equal(prepared.summary.path, "SECONDARY");
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

  const devOnly = setup(awsTf({ enabledEnvironments: ["DEV"], targets: { DEV: { accountId: awsTargetOf("DEV").account, region: "us-east-1", backend: awsTargetOf("DEV").backend, workspace: "default" } }, requiredApprovals: { DEV: 1 }, authorize: { DEV: ["APPLY", "CLEANUP"] } }));
  refused(await prepareApply({ environment: "PROD", projectRoot: terraformProject(devOnly, "PROD") }, devOnly.deps), "TARGET_NOT_IN_CONTRACT", "OWNER");
  refused(await prepareApply({ environment: "STAGING", projectRoot: terraformProject(devOnly) }, devOnly.deps), "ENVIRONMENT_INVALID", "OPERATOR");
});

test("a missing engine tool explains the supported alternative for that provider and says what it requires", async () => {
  const aws = setup(awsTf(), "none");
  const awsRefusal = refused(await prepareApply({ environment: "DEV", projectRoot: terraformProject(aws) }, aws.deps), "TOOL_UNAVAILABLE", "TOOL");
  assert.match(awsRefusal.alternative ?? "", /commit a contract for CDK/);
  assert.match(awsRefusal.alternative ?? "", /own reviewed contract, its own preview and its own approvals/);

  const azure = setup(azureTf(), "none");
  const project = join(azure.dir, "project");
  mkdirSync(project);
  writeProject(project, targetOf("DEV"));
  const azureRefusal = refused(await prepareApply({ environment: "DEV", projectRoot: project }, azure.deps), "TOOL_UNAVAILABLE", "TOOL");
  // Azure Bicep is admitted for DEV only (the admission-wiring lane, #39): the other supported Azure way, with its own contract.
  assert.match(azureRefusal.alternative ?? "", /commit a contract for BICEP/);
  assert.match(azureRefusal.alternative ?? "", /own reviewed contract, its own preview and its own approvals/);
});

test("Azure Bicep is the Azure secondary path: main.bicep is the project, no lock file and no providers, and the engine version is the tested az pin until it is qualified", async () => {
  const bicep = (kill: string) => ({
    ...contractJson(kill, { policyVersion: POLICY }), engine: "BICEP", enabledEnvironments: ["DEV"], requiredApprovals: { DEV: 1 }, authorize: { DEV: ["APPLY", "CLEANUP"] },
    targets: { DEV: { tenantId: "11111111-1111-4111-8111-111111111111", subscriptionId: targetOf("DEV").account, backend: "alz-pilot-stack", workspace: "default", resourceGroup: "alz-pilot-dev", location: "eastus2" } },
  });
  const s = setup(bicep, "none");
  for (const name of ["az", "bicep"]) writeFileSync(join(s.toolDir, name), "#!/bin/sh\nexit 9\n", { mode: 0o755 });
  const project = join(s.dir, "bicep-project");
  mkdirSync(project);
  writeFileSync(join(project, "main.bicep"), "resource vnet 'Microsoft.Network/virtualNetworks@2024-05-01' = {}\n");
  const prepared = ok(await prepareApply({ environment: "DEV", projectRoot: project }, s.deps));
  assert.equal(prepared.summary.engine, "BICEP");
  assert.equal(prepared.summary.path, "SECONDARY");
  assert.equal(prepared.summary.engineVersion, loadToolPins().azureCli.version);
  assert.equal(prepared.summary.engineVersionSource, "TESTED_PIN");
  assert.deepEqual(prepared.request.resolved.providers, []);
  assert.equal(prepared.request.resolved.lockFileSha256, undefined);
  assert.equal(prepared.manifest.engine, "BICEP");
  assert.equal(prepared.next.step, "qualify");
  // A folder with no main.bicep is not this engine's project.
  const empty = join(s.dir, "not-bicep");
  mkdirSync(empty);
  writeFileSync(join(empty, "main.tf"), "");
  assert.match(refused(await prepareApply({ environment: "DEV", projectRoot: empty }, s.deps), "PROJECT_ENGINE_MISMATCH", "OPERATOR").message, /no main\.bicep/);
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


/**
 * Real `terraform init` lock-file syntax (Terraform 1.16.4, offline mirror, 2026-10-27): the reviewed hashicorp/aws 6.68.0 and
 * hashicorp/azurerm 4.81.0 entries as init wrote them, and hashicorp/null 3.2.4. Each test swaps a version as plain text.
 */
const REAL_LOCK = [
  '# This file is maintained automatically by "terraform init".', "# Manual edits may be lost in future updates.", "",
  'provider "registry.terraform.io/hashicorp/aws" {', '  version     = "6.68.0"', '  constraints = ">= 5.0.0, < 7.0.0"', "  hashes = [",
  '    "h1:79hHQtjGSCiXBZK+VDiNUdI2SLXbNaHf+CHySvKFnvA=",', "  ]", "}", "",
  'provider "registry.terraform.io/hashicorp/azurerm" {', '  version     = "4.81.0"', '  constraints = "4.81.0"', "  hashes = [",
  '    "h1:olVprUWhmFTARlydw/r7VIx4fata2gy3zsAWfPGRrhg=",', "  ]", "}", "",
  'provider "registry.terraform.io/hashicorp/null" {', '  version     = "3.2.4"', "}", "",
].join("\n");

test("a lock that pins aws or azurerm at any version but the one the denied types were reviewed against is refused at prepare, naming both versions (review of #327, round 4)", async () => {
  // One source of truth: the reviewed versions are read from the constants beside the denied-type lists.
  assert.deepEqual(REVIEWED_PROVIDER_VERSIONS, { "registry.terraform.io/hashicorp/aws": "6.68.0", "registry.terraform.io/hashicorp/azurerm": "4.81.0" });
  assert.equal(AWS_DENIED_TYPES_REVIEWED_AGAINST, "hashicorp/aws 6.68.0");
  assert.equal(AZURE_DENIED_TYPES_REVIEWED_AGAINST, "hashicorp/azurerm 4.81.0");
  // Each cloud path locks its own provider (an AWS project locking azurerm is refused as not admitted, below).
  const awsLock = REAL_LOCK.replace(/\nprovider "registry\.terraform\.io\/hashicorp\/azurerm" \{[\s\S]*?\n\}\n/, "\n");
  const azureLock = REAL_LOCK.replace(/\nprovider "registry\.terraform\.io\/hashicorp\/aws" \{[\s\S]*?\n\}\n/, "\n");
  assert.deepEqual(lockedProviders(awsLock).map((p) => p.source), ["registry.terraform.io/hashicorp/aws", "registry.terraform.io/hashicorp/null"]);
  assert.deepEqual(lockedProviders(azureLock).map((p) => p.source), ["registry.terraform.io/hashicorp/azurerm", "registry.terraform.io/hashicorp/null"]);
  const clouds = { aws: { contract: awsTf(), lock: awsLock }, azurerm: { contract: azureTf(), lock: azureLock } } as const;
  const project = (cloud: keyof typeof clouds, lock: string): { dir: string; deps: PrepareDeps } => {
    const s = setup(clouds[cloud].contract);
    const dir = terraformProject(s);
    writeFileSync(join(dir, TERRAFORM_LOCK_FILE), lock);
    return { dir, deps: s.deps };
  };
  const prep = (p: { dir: string; deps: PrepareDeps }) => prepareApply({ environment: "DEV", projectRoot: p.dir }, p.deps);
  // The exact reviewed versions are admitted, and so is any version of a provider that is neither aws nor azurerm.
  assert.equal(unreviewedProviderVersion(lockedProviders(REAL_LOCK)), undefined);
  for (const cloud of ["aws", "azurerm"] as const) {
    ok(await prep(project(cloud, clouds[cloud].lock)));
    ok(await prep(project(cloud, clouds[cloud].lock.replace('version     = "3.2.4"', 'version     = "3.2.5"'))));
  }
  for (const [source, version, reviewed] of [["aws", "6.69.0", "6.68.0"], ["aws", "6.67.0", "6.68.0"], ["aws", "7.0.0", "6.68.0"], ["aws", "6.68.1", "6.68.0"],
    ["azurerm", "4.82.0", "4.81.0"], ["azurerm", "4.80.0", "4.81.0"], ["azurerm", "4.81.0-beta1", "4.81.0"]] as const) {
    const lock = clouds[source].lock.replace('version     = "' + reviewed + '"', 'version     = "' + version + '"');
    assert.ok(lock.includes('version     = "' + version + '"'), "the swap landed: " + source + " " + version);
    const refusal = refused(await prep(project(source, lock)), "PROVIDER_VERSION_NOT_REVIEWED", "OPERATOR");
    // Compared as plain text (no pattern built from the version).
    const expected = "pins registry.terraform.io/hashicorp/" + source + " " + version + ", but the pilot's denied-type lists were reviewed against " + reviewed + ".";
    assert.ok(refusal.message.includes(expected), source + " " + version + ": " + refusal.message);
    assert.ok(refusal.message.includes("re-review the denied types against the new schema"));
  }
});

test("round 5 (review of #327): the lock reader cannot be made to read less than Terraform: indented and CRLF blocks, an empty parse, and a foreign host or namespace are refused at prepare", async () => {
  // The reviewer's probes (real lock syntax): Terraform still selects 6.70.0 from each, and the old line-anchored reader saw nothing.
  const header = '# This file is maintained automatically by "terraform init".\n# Manual edits may be lost in future updates.\n\n';
  const block = (source: string, version: string, indent = "") =>
    indent + 'provider "' + source + '" {\n' + indent + '  version = "' + version + '"\n' + indent + "  hashes = [\n" + indent + '    "h1:79hHQtjGSCiXBZK+VDiNUdI2SLXbNaHf+CHySvKFnvA=",\n' + indent + "  ]\n" + indent + "}\n";
  const AWS = "registry.terraform.io/hashicorp/aws";
  const indented = header + block(AWS, "6.70.0", "  ");
  const crlf = (header + block(AWS, "6.70.0")).replace(/\n/g, "\r\n");
  const code = (text: string) => { try { lockedProviders(text); return "none"; } catch (error) { return (error as LockFileError).code; } };
  assert.equal(code(indented), "LOCK_FILE_UNREADABLE", "an indented block");
  assert.equal(code(crlf), "LOCK_FILE_UNREADABLE", "CRLF line endings");
  assert.equal(code((header + block(AWS, "6.68.0")).replace(/\n/g, "\r\n")), "LOCK_FILE_UNREADABLE", "CRLF even at the reviewed version");
  assert.equal(code(header + block(AWS, "6.68.0") + block(AWS, "6.70.0", "\t")), "LOCK_FILE_UNREADABLE", "a reviewed block beside an indented one");
  assert.equal(code(header + "provider\n"), "LOCK_FILE_UNREADABLE", "a mention that parses to nothing");
  assert.equal(code(header), "LOCK_FILE_EMPTY", "nothing locked");
  const s = setup(awsTf());
  for (const [label, lock, expected] of [
    ["indented", indented, "LOCK_FILE_UNREADABLE"], ["CRLF", crlf, "LOCK_FILE_UNREADABLE"],
    ["an OpenTofu registry host", header + block("registry.opentofu.org/hashicorp/aws", "6.68.0"), "PROVIDER_NOT_ADMITTED"],
    ["another namespace for aws", header + block("registry.terraform.io/attacker/aws", "6.68.0"), "PROVIDER_NOT_ADMITTED"],
    ["azurerm in an AWS project", header + block("registry.terraform.io/hashicorp/azurerm", "4.81.0"), "PROVIDER_NOT_ADMITTED"],
  ] as const) {
    const dir = terraformProject(setup(awsTf()));
    writeFileSync(join(dir, TERRAFORM_LOCK_FILE), lock);
    refused(await prepareApply({ environment: "DEV", projectRoot: dir }, s.deps), expected, "OPERATOR");
    assert.ok(label.length > 0);
  }
});

test("round 6 (review of #327): a project-shipped plugin directory or CLI configuration is refused at prepare, and a reviewed version's lock must carry HashiCorp's own package hashes", async () => {
  const s = setup(awsTf());
  for (const [label, make] of [
    ["terraform.d/plugins at the root", (dir: string) => { mkdirSync(join(dir, "terraform.d/plugins/registry.terraform.io/hashicorp/aws/6.68.0/linux_amd64"), { recursive: true }); writeFileSync(join(dir, "terraform.d/plugins/registry.terraform.io/hashicorp/aws/6.68.0/linux_amd64/terraform-provider-aws_v6.68.0_x5"), "#!/bin/sh\n"); }],
    ["terraform.d in a module", (dir: string) => { mkdirSync(join(dir, "modules/app/terraform.d"), { recursive: true }); writeFileSync(join(dir, "modules/app/terraform.d/x"), "x"); }],
    ["a .terraform data directory in a module", (dir: string) => { mkdirSync(join(dir, "modules/app/.terraform/providers"), { recursive: true }); writeFileSync(join(dir, "modules/app/.terraform/providers/x"), "x"); }],
    ["a .terraformrc", (dir: string) => writeFileSync(join(dir, ".terraformrc"), "provider_installation {}\n")],
    ["a terraform.rc, any case", (dir: string) => writeFileSync(join(dir, "Terraform.RC"), "provider_installation {}\n")],
  ] as const) {
    const dir = terraformProject(setup(awsTf()));
    make(dir);
    const refusal = refused(await prepareApply({ environment: "DEV", projectRoot: dir }, s.deps), "TERRAFORM_LOCAL_PLUGIN_DIR_REFUSED", "OPERATOR");
    assert.ok(refusal.message.includes("only from the official registry"), label);
  }
  // Hashes: the official ones are admitted (h1 for linux_amd64 and darwin_arm64, zh for every platform); anything else is refused.
  const lockWithHashes = (hashes: string[]) => '# lock\nprovider "registry.terraform.io/hashicorp/aws" {\n  version = "6.68.0"\n  hashes = [\n' + hashes.map((h) => '    "' + h + '",\n').join("") + "  ]\n}\n";
  const official = [...OFFICIAL_PROVIDER_HASHES["registry.terraform.io/hashicorp/aws 6.68.0"]!];
  const prep = async (lock: string) => {
    const dir = terraformProject(setup(awsTf()));
    writeFileSync(join(dir, TERRAFORM_LOCK_FILE), lock);
    return prepareApply({ environment: "DEV", projectRoot: dir }, s.deps);
  };
  ok(await prep(lockWithHashes(official)));
  ok(await prep(lockWithHashes(["zh:f292ad91c97ac7354a04a698f346c2a0c3866d9170ca45dda6a6bfab71180be0"])));
  for (const [label, hashes] of [
    ["no hashes", []],
    ["an unofficial h1 (a rebuilt package)", ["h1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="]],
    ["an official h1 beside an unofficial zh", ["h1:79hHQtjGSCiXBZK+VDiNUdI2SLXbNaHf+CHySvKFnvA=", "zh:" + "0".repeat(64)]],
    ["azurerm's official hash under aws", ["h1:olVprUWhmFTARlydw/r7VIx4fata2gy3zsAWfPGRrhg="]],
  ] as const) refused(await prep(lockWithHashes([...hashes])), "PROVIDER_HASH_NOT_OFFICIAL", "OPERATOR");
  // A hash list this reader cannot read exactly is unreadable, not skipped.
  refused(await prep(lockWithHashes(["md5:abc"])), "LOCK_FILE_UNREADABLE", "OPERATOR");
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
  assert.equal(code("# nothing locked\n"), "LOCK_FILE_EMPTY");
  // Strict (review of #327, round 5): a lock that mentions a provider but parses to none is unreadable, never empty.
  assert.equal(code("# no providers\n"), "LOCK_FILE_UNREADABLE");
  assert.equal(TERRAFORM_LOCK_FILE, LOCK_FILE, "prepare checks the same lock file name the engines use");
});

test("the contract's policyVersion is optional, kept exactly, and refused when it holds unsafe text", () => {
  const dir = join(root, "policy");
  mkdirSync(dir);
  const path = join(dir, "contract.json");
  writeReviewedContract(path, awsContractJson(join(dir, "kill"), { policyVersion: POLICY }));
  const loaded = loadPilotContract(path);
  assert.equal("reason" in loaded ? "" : loaded.policyVersion, POLICY);
  writeReviewedContract(path, awsContractJson(join(dir, "kill"), { policyVersion: "bad\nvalue" }));
  const bad = loadPilotContract(path);
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

// --- inputs and dependencies --------------------------------------------------------------------------------------------

const VALUE_CANARY = "s3cr3t-value-canary-91";
function tfProject(s: Setup, files: Record<string, string>): string {
  const project = terraformProject(s);
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(join(project, name, ".."), { recursive: true });
    writeFileSync(join(project, name), text);
  }
  return project;
}
const VARIABLES = [
  'variable "region" {\n  type = string\n}',
  'variable "env" {\n  default = "' + VALUE_CANARY + '"\n}',
  'variable "owner" {}',
  'variable "tags" {\n  description = <<EOT\nA { brace } and default = inside a heredoc are not structure.\nEOT\n  default = { team = "a" }\n}',
  'variable "note" {\n  description = "a \\"quoted\\" ${upper("default = x")} { brace"\n  # default = in a comment\n  /* default = in a block comment { */\n}',
].join("\n");

test("each Terraform variable becomes an input named by where its value comes from, in Terraform's precedence, and never by its value", async () => {
  const s = setup(awsTf());
  const project = tfProject(s, {
    "variables.tf": VARIABLES,
    "terraform.tfvars": 'region = "' + VALUE_CANARY + '"\nnote = "x"\n',
    "b.auto.tfvars": 'region = "later"\n',
    "a.auto.tfvars.json": JSON.stringify({ region: "earlier", note: "y" }),
  });
  const env = { ALZ_DISCOVERY_TF_VAR_owner: VALUE_CANARY };
  const prepared = ok(await prepareApply({ environment: "DEV", projectRoot: project }, { ...s.deps, env }));
  assert.deepEqual(prepared.summary.inputs, [
    { name: "env", source: "DEFAULT", from: "variables.tf" },
    { name: "note", source: "TFVARS", from: "a.auto.tfvars.json" },
    { name: "owner", source: "ENVIRONMENT", from: "ALZ_DISCOVERY_TF_VAR_owner" },
    { name: "region", source: "TFVARS", from: "b.auto.tfvars" },
    { name: "tags", source: "DEFAULT", from: "variables.tf" },
  ], "the last *.auto.tfvars wins, auto files beat terraform.tfvars, a file beats the environment, the environment beats a default");
  assert.deepEqual(prepared.request.resolved.inputs.map((i) => i.name), ["env", "note", "owner", "region", "tags"]);
  assert.deepEqual(prepared.manifest.inputs, prepared.request.resolved.inputs, "the manifest binds exactly the request's inputs");
  assert.ok(prepared.request.resolved.inputs.every((i) => /^[0-9a-f]{64}$/.test(i.identity)));
  for (const text of [JSON.stringify(prepared.request), JSON.stringify(prepared.manifest), JSON.stringify(prepared.summary)]) {
    assert.ok(!text.includes(VALUE_CANARY), "no input value is ever recorded");
  }
  assert.ok(prepared.gaps.some((gap) => /owner come from environment variables/.test(gap)));
  // A changed value file changes that input's identity; an unrelated input keeps its own.
  writeFileSync(join(project, "b.auto.tfvars"), 'region = "changed"\n');
  const again = ok(await prepareApply({ environment: "DEV", projectRoot: project }, { ...s.deps, env }));
  const identity = (p: Prepared, name: string) => p.request.resolved.inputs.find((i) => i.name === name)!.identity;
  assert.notEqual(identity(again, "region"), identity(prepared, "region"));
  assert.equal(identity(again, "owner"), identity(prepared, "owner"));
});

test("a Terraform variable with no value anywhere is refused before any preview, naming it and never asking for its value", async () => {
  const s = setup(awsTf());
  const project = tfProject(s, { "variables.tf": 'variable "region" {}\nvariable "zone" {}\nvariable "defaulted" {\n  default = 1\n}' });
  const refusal = refused(await prepareApply({ environment: "DEV", projectRoot: project }, { ...s.deps, env: {} }), "INPUT_UNSET", "OPERATOR");
  assert.match(refusal.message, /region, zone/);
  assert.doesNotMatch(refusal.message, /defaulted/, "a variable with a default is not reported");
  assert.match(refusal.message, /ALZ_DISCOVERY_TF_VAR_<name>/);
});

test("local modules inside the project are followed and bound with its files; remote and outside modules are refused", async () => {
  const s = setup(awsTf());
  const project = tfProject(s, {
    "modules.tf": 'module "net" {\n  source = "./modules/net"\n}',
    "modules/net/main.tf": 'module "inner" {\n  source = "../inner"\n}\nvariable "cidr" {}',
    "modules/inner/main.tf": 'resource "aws_s3_bucket" "b" {}',
  });
  const prepared = ok(await prepareApply({ environment: "DEV", projectRoot: project }, s.deps));
  assert.deepEqual(prepared.request.resolved.dependencies, []);
  assert.deepEqual(prepared.summary.inputs, [], "a module's own variables are not root inputs");
  assert.ok(prepared.manifest.files.some((f) => f.path === "modules/inner/main.tf"), "nested local module code is fingerprinted");

  for (const [source, code] of [["hashicorp/consul/aws", "MODULE_REMOTE"], ["git::https://example.invalid/m.git", "MODULE_REMOTE"], ["../../outside", "MODULE_OUTSIDE_PROJECT"], ["./missing", "MODULE_OUTSIDE_PROJECT"]] as const) {
    const other = setup(awsTf());
    const dir = tfProject(other, { "modules.tf": 'module "m" {\n  source = "' + source + '"\n  version = "1.0.0"\n}' });
    refused(await prepareApply({ environment: "DEV", projectRoot: dir }, other.deps), code, "OPERATOR");
  }
  const nested = setup(awsTf());
  const deep = tfProject(nested, { "modules.tf": 'module "net" {\n  source = "./net"\n}', "net/main.tf": 'module "x" {\n  source = "terraform-aws-modules/vpc/aws"\n}' });
  refused(await prepareApply({ environment: "DEV", projectRoot: deep }, nested.deps), "MODULE_REMOTE");
});

test("a Terraform file that cannot be scanned is refused rather than guessed at", async () => {
  const s = setup(awsTf());
  const project = tfProject(s, { "broken.tf": 'variable "a" {\n  default = "unterminated\n}' });
  refused(await prepareApply({ environment: "DEV", projectRoot: project }, s.deps), "TERRAFORM_CONFIG_UNREADABLE", "OPERATOR");
});

test("CDK template parameters become inputs from their defaults, without the default's value; one with no default is refused", async () => {
  const s = setup(awsCdk(), "aws");
  const project = join(s.dir, "assembly");
  writeAssembly(project, cdkTargetOf("DEV"));
  const prepared = ok(await prepareApply({ environment: "DEV", projectRoot: project }, s.deps));
  assert.equal(prepared.summary.inputs.length, 1);
  assert.match(prepared.summary.inputs[0].name, /\/DbPassword$/);
  assert.equal(prepared.summary.inputs[0].source, "DEFAULT");
  for (const text of [JSON.stringify(prepared.request), JSON.stringify(prepared.manifest), JSON.stringify(prepared.summary)]) assert.ok(!text.includes(PARAMETER_CANARY));
  const template = readdirSync(project).find((name) => name.endsWith(".template.json"))!;
  const body = JSON.parse(readFileSync(join(project, template), "utf8")) as { Parameters: Record<string, Record<string, unknown>> };
  delete body.Parameters.DbPassword.Default;
  writeFileSync(join(project, template), JSON.stringify(body));
  refused(await prepareApply({ environment: "DEV", projectRoot: project }, s.deps), "INPUT_UNSET", "OPERATOR");
});
