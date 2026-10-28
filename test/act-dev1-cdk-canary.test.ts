import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { sealPreview } from "../src/apply/driver.js";
import { codeOf } from "../src/apply/engine.js";
import { removalTemplateOf } from "../src/apply/engines/cdk.js";
import { openNonceStore } from "../src/apply/nonces.js";
import { removeTree } from "../src/teardown/driver/cleanup.js";
import type { ResolvedTarget } from "../src/teardown/driver/types.js";
import { buildManifest } from "../src/teardown/manifest.js";
import { captureProjectFiles } from "../src/teardown/snapshot.js";
import { H, NOW, POLICY, REQUESTER, SOURCE_COMMIT, awsTargetOf, human, writeReviewedContract } from "./helpers/apply-fixtures.js";
import { AWS_CLI_VERSION, behaveAws, cdkContractJson, cdkIdentityEnv, forgeCdkQualification, installFakeAws } from "./helpers/cdk-fixtures.js";

// The committed ACT-DEV-1 AWS CDK canary (qualification/aws/act-dev1-cdk-canary, owner decision E3). SYNTHETIC and offline:
// the committed cdk.out is read as text, and sealed once through the real CDK engine with the FAKE `aws` of the CDK unit tests,
// which pins the engine's own assembly checks, NOT CloudFormation's behavior. The opt-in run re-synthesizes the app with the
// pinned packages (ALZ_CDK_CANARY_SYNTH=1, after `npm ci` in the canary folder) and requires the committed bytes.

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const DIR = join(ROOT, "qualification", "aws", "act-dev1-cdk-canary");
const OUT = join(DIR, "cdk.out");
const STACK_ID = "ActDev1CdkCanary";
const EXAMPLE_STACK = "alz-act-dev1-cdk-canary";
const json = (path: string): any => JSON.parse(readFileSync(path, "utf8"));

test("the CDK canary pins aws-cdk-lib, constructs and the CDK CLI exactly, to the versions the repository already records", () => {
  const pkg = json(join(DIR, "package.json"));
  assert.equal(pkg.private, true);
  assert.deepEqual(pkg.dependencies, { "aws-cdk-lib": "2.272.0", constructs: "10.8.1" });
  assert.deepEqual(pkg.devDependencies, { "aws-cdk": "2.1144.0" });
  // The same versions the CDK preview adapter records as tested (src/plugins/catalog.ts) and the adapter-runtime workflow installs.
  const catalog = readFileSync(join(ROOT, "src", "plugins", "catalog.ts"), "utf8");
  assert.ok(catalog.includes("AWS CDK CLI 2.1144.0; aws-cdk-lib 2.272.0"));
  const lock = json(join(DIR, "package-lock.json"));
  assert.equal(lock.lockfileVersion, 3);
  for (const [name, version] of [["aws-cdk-lib", "2.272.0"], ["constructs", "10.8.1"], ["aws-cdk", "2.1144.0"]]) {
    const entry = lock.packages["node_modules/" + name];
    assert.equal(entry.version, version, name);
    assert.equal(entry.resolved, "https://registry.npmjs.org/" + name + "/-/" + name + "-" + version + ".tgz", name);
    assert.match(entry.integrity, /^sha512-[A-Za-z0-9+/]{86}==$/, name);
  }
  // Every locked package comes from the public registry with an integrity hash, or is bundled inside one that does.
  for (const [path, entry] of Object.entries<any>(lock.packages)) {
    if (path === "" || entry.inBundle) continue;
    assert.match(entry.resolved ?? "", /^https:\/\/registry\.npmjs\.org\//, path);
    assert.ok(entry.integrity, path);
  }
  // No install script and no network at synthesis: the app is plain JavaScript run by node.
  assert.equal(pkg.scripts.synth, "cdk synth --quiet --no-lookups --output cdk.out");
  assert.equal(json(join(DIR, "cdk.json")).app, "node app.js");
});

test("the app takes its three inputs from CDK context, validates them, and synthesizes without bootstrap, metadata or stack traces", () => {
  const app = readFileSync(join(DIR, "app.js"), "utf8");
  for (const key of ["stackName", "canaryName", "owner"]) assert.ok(app.includes('input("' + key + '"'), key);
  assert.ok(app.includes("/^\\/alz\\/act-dev-1\\/[a-z0-9][a-z0-9-]{2,48}$/"), "the Terraform canary's name rule");
  assert.ok(app.includes("new BootstraplessSynthesizer()"));
  assert.ok(app.includes("analyticsReporting: false"));
  assert.ok(app.includes("terminationProtection: true"));
  assert.ok(app.includes('"aws:cdk:disable-creation-stack-traces": true'));
  assert.equal(app.match(/new Cfn[A-Za-z]+\(/g)?.length, 1, "one construct");
  const cdkJson = json(join(DIR, "cdk.json"));
  assert.equal(cdkJson.versionReporting, false);
  assert.equal(cdkJson.pathMetadata, false);
  assert.equal(cdkJson.assetMetadata, false);
  assert.deepEqual(Object.keys(cdkJson.context).sort(), ["canaryName", "owner", "stackName"]);
  assert.equal(cdkJson.context.owner, "REPLACE-WITH-APPROVED-OWNER", "the committed owner is an EXAMPLE placeholder");
});

test("the committed template is exactly one AWS::Logs::LogGroup, with the Terraform canary's name scheme, retention and tags", () => {
  const files = readdirSync(OUT).sort();
  assert.deepEqual(files, ["ActDev1CdkCanary.metadata.json", "ActDev1CdkCanary.template.json", "cdk.out", "manifest.json", "tree.json", "validation-report.json"]);
  const template = json(join(OUT, STACK_ID + ".template.json"));
  // No Parameters (so no BootstrapVersion), no Rules (no CheckBootstrapVersion), no Conditions or Metadata (no AWS::CDK::Metadata), no Outputs.
  assert.deepEqual(Object.keys(template), ["Resources"]);
  assert.deepEqual(Object.keys(template.Resources), ["ActDev1"]);
  assert.deepEqual(template.Resources.ActDev1, {
    Type: "AWS::Logs::LogGroup",
    Properties: {
      LogGroupName: "/alz/act-dev-1/cdk-canary-01",
      RetentionInDays: 30,
      Tags: [
        { Key: "environment", Value: "DEV" },
        { Key: "managed-by", Value: "sovereign-alz" },
        { Key: "owner", Value: "REPLACE-WITH-APPROVED-OWNER" },
        { Key: "purpose", Value: "act-dev-1" },
      ],
    },
  });
  // The same tag keys and constants as the Terraform canary's log group.
  const hcl = readFileSync(join(ROOT, "qualification", "aws", "act-dev1-canary", "main.tf"), "utf8");
  for (const line of ['environment = "DEV"', 'managed-by  = "sovereign-alz"', 'purpose     = "act-dev-1"', "retention_in_days = 30"]) assert.ok(hcl.includes(line), line);

  const text = readdirSync(OUT).map((name) => readFileSync(join(OUT, name), "utf8")).join("\n");
  for (const absent of ["BootstrapVersion", "CheckBootstrapVersion", "AWS::CDK::Metadata", "AWS::Lambda::", "Custom::", "AWS::CloudFormation::CustomResource", "creationStack", "/tmp/", "/home/"]) {
    assert.ok(!text.includes(absent), absent);
  }
});

test("the committed manifest is one environment-agnostic, termination-protected stack with no asset manifest", () => {
  const manifest = json(join(OUT, "manifest.json"));
  const artifacts = Object.entries<any>(manifest.artifacts);
  assert.deepEqual(artifacts.map(([id, artifact]) => [id, artifact.type]).sort(), [
    [STACK_ID, "aws:cloudformation:stack"], ["Tree", "cdk:tree"], ["aws-cdk-lib/feature-flag-report", "cdk:feature-flag-report"],
  ]);
  const stack = manifest.artifacts[STACK_ID];
  assert.equal(stack.environment, "aws://unknown-account/unknown-region");
  assert.equal(stack.properties.stackName, EXAMPLE_STACK);
  assert.equal(stack.properties.templateFile, STACK_ID + ".template.json");
  assert.equal(stack.properties.terminationProtection, true);
  assert.equal(stack.dependencies, undefined);
  assert.equal(stack.properties.requiresBootstrapStackVersion, undefined);
  assert.equal(stack.properties.bootstrapStackVersionSsmParameter, undefined);
  assert.equal(manifest.minimumCliVersion, "2.1144.0");
});

test("cleanup of the only resource is refused as CLEANUP_WOULD_EMPTY_STACK: the stack is retained for the owner's separate decision", () => {
  const template = json(join(OUT, STACK_ID + ".template.json"));
  let code = "";
  try { removalTemplateOf(template, ["ActDev1"]); } catch (error) { code = codeOf(error); }
  assert.equal(code, "CLEANUP_WOULD_EMPTY_STACK");
});

test("the committed cdk.out seals through the real CDK engine (fake aws): exactly one create, no assembly refusal", async () => {
  const root = mkdtempSync(join(tmpdir(), "alz-cdk-canary-"));
  const toolDir = mkdtempSync(join(tmpdir(), "alz-cdk-canary-tools-"));
  const previous = { cwd: process.cwd(), key: process.env.AGENTIC_EVIDENCE_KEY };
  try {
    process.env.AGENTIC_EVIDENCE_KEY = randomBytes(32).toString("base64");
    process.chdir(root);
    installFakeAws(toolDir);
    const kill = join(root, "KILL");
    behaveAws(toolDir, kill, { changesAllAdd: true });
    const dir = (name: string): string => { const path = join(root, name); mkdirSync(path, { recursive: true }); return path; };
    const vault = dir("qualification");
    await forgeCdkQualification(vault);
    // The contract's DEV backend is the canary's stack name; the fixture's fake account and region.
    const base = cdkContractJson(kill);
    const contract = { ...base, targets: Object.fromEntries(Object.entries<any>(base.targets).map(([env, t]) => [env, { ...t, backend: EXAMPLE_STACK }])) };
    const contractPath = join(dir("contract"), "act-pilot-contract.json");
    writeReviewedContract(contractPath, contract);
    const project = dir("cdk.out");
    cpSync(OUT, project, { recursive: true });
    const target: ResolvedTarget = { account: awsTargetOf("DEV").account, backend: EXAMPLE_STACK, workspace: "default" };
    const resolved = { engineVersion: AWS_CLI_VERSION, providers: [], lockFileSha256: undefined, dependencies: [], inputs: [] };
    const manifest = buildManifest({ engine: "CDK", mode: "PROJECT", target, unitHash: H("1"), files: captureProjectFiles(project), policyVersion: POLICY, ...resolved });
    const result = await sealPreview({
      invocation: human(target), environment: "DEV", target, manifest, projectRoot: project, policyVersion: POLICY, resolved, requester: REQUESTER,
    }, {
      sourceCommit: SOURCE_COMMIT, contractPath, qualificationDir: vault, evidenceDir: dir("evidence"), nonces: openNonceStore(dir("nonces")),
      env: cdkIdentityEnv("DEV"), now: () => NOW, scratchParent: dir("scratch"), toolDirs: [toolDir], killPollMs: 40, killGraceMs: 400,
    });
    assert.ok(result.ok, JSON.stringify(result));
    assert.deepEqual(result.sealed.changes, [{ address: "ActDev1", type: "AWS::Logs::LogGroup", action: "CREATE" }]);
  } finally {
    process.chdir(previous.cwd);
    if (previous.key === undefined) delete process.env.AGENTIC_EVIDENCE_KEY; else process.env.AGENTIC_EVIDENCE_KEY = previous.key;
    removeTree(root);
    removeTree(toolDir);
  }
});

const SYNTH = process.env.ALZ_CDK_CANARY_SYNTH === "1" && existsSync(join(DIR, "node_modules", "aws-cdk", "package.json"));
test("re-synthesizing with the pinned packages yields the committed cdk.out byte for byte (opt-in)", { skip: SYNTH ? false : "set ALZ_CDK_CANARY_SYNTH=1 after npm ci in the canary folder" }, () => {
  const out = mkdtempSync(join(tmpdir(), "alz-cdk-canary-synth-"));
  try {
    const run = spawnSync(join(DIR, "node_modules", ".bin", "cdk"), ["synth", "--quiet", "--no-lookups", "--no-notices", "--output", out], {
      cwd: DIR, encoding: "utf8", env: { ...process.env, CDK_DISABLE_CLI_TELEMETRY: "true" },
    });
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(readdirSync(out).sort(), readdirSync(OUT).sort());
    for (const name of readdirSync(OUT)) assert.ok(readFileSync(join(out, name)).equals(readFileSync(join(OUT, name))), name);
  } finally {
    removeTree(out);
  }
});
