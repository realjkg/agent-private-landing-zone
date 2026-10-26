import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { loadPilotContract, loadQualificationRecords } from "../src/apply/contract.js";
import { qualifyApply, runApply, sealPreview, type ApplyDeps, type ApplyRequest } from "../src/apply/driver.js";
import { ENGINE_IDS, engineSpec } from "../src/apply/engine-spec.js";
import { CDK, isAllowedCdkArgv } from "../src/apply/engines/cdk.js";
import { assertApplyEvidence } from "../src/apply/evidence.js";
import { attestedClientId, checkApplyIdentities, verifyIdentityTargets } from "../src/apply/identities.js";
import { openNonceStore } from "../src/apply/nonces.js";
import { AWS } from "../src/apply/providers/aws.js";
import { loadSealedPlan, reviewBundleOf } from "../src/apply/seal.js";
import { APPLY_IDENTITIES, type ApplyEnvironment, type ApplyEvidence, type ApplyResult, type PilotContract, type SignedApproval } from "../src/apply/types.js";
import { buildCleanupProposal, verifyCleanupProposal } from "../src/apply/cleanup-proposal.js";
import { loadRunRecords, observeRun, type ObserveDeps } from "../src/apply/observe.js";
import { readBlueprintRecord } from "../src/apply/run-records.js";
import { runCleanup } from "../src/apply/driver.js";
import { canonicalJson } from "../src/teardown/manifest.js";
import { sha256 } from "../src/util/sha256.js";
import { runApplyCommand, type ApplyCliDeps } from "../src/cli/apply.js";
import { targetString } from "../src/cli/teardown-driver.js";
import { removeTree } from "../src/teardown/driver/cleanup.js";
import { createImmutableSnapshot } from "../src/teardown/snapshot.js";
import { codeOf } from "../src/apply/engine.js";
import { buildChildEnvironment } from "../src/tools/child-env.js";
import { AWS_CFN_APPLY_PROFILE } from "../src/tools/profiles.js";
import { EXECUTION_IDENTITIES } from "../src/tools/identity.js";
import { SOURCE_COMMIT, NOW, POLICY, approvalFor as approval, contractJson, human, keys, pinPathOf, writePinnedContract, type Project } from "./helpers/apply-fixtures.js";
import {
  AWS_CLI_VERSION, CDK_CANARIES, FAKE_AWS_SHA256, STACK, STDERR_CANARY, awsCallsOf, behaveAws, cdkContractJson, cdkIdentityEnv, cdkRoleArn, cdkTargetOf,
  forgeCdkQualification, installFakeAws, patchAws, subcommandsOf, writeAssembly, type AssemblyOptions, type AwsBehavior, type AwsCall,
} from "./helpers/cdk-fixtures.js";

// docs/act-pilot-apply.md, "CDK". The `aws` executable is a fake, so these tests pin the engine's logic and the driver's
// enforcement, NOT the behavior of the real AWS CLI or CloudFormation. Explicit fake ids only.

const root = mkdtempSync(join(tmpdir(), "alz-cdk-"));
const toolDir = mkdtempSync(join(tmpdir(), "alz-cdk-tools-"));
process.env.AGENTIC_EVIDENCE_KEY = randomBytes(32).toString("base64");
process.chdir(root); // the vault writes sealed plans under ./.runs
test.after(() => { removeTree(root); removeTree(toolDir); });
installFakeAws(toolDir);

let counter = 0;
const fresh = (label: string): string => {
  const dir = join(root, label + "-" + ++counter);
  mkdirSync(dir, { recursive: true });
  return dir;
};
const KILL = join(root, "KILL");
const behave = (behavior: AwsBehavior = {}) => behaveAws(toolDir, KILL, behavior);
const calls = (): AwsCall[] => awsCallsOf(toolDir);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type World = { deps: ApplyDeps; dirs: { scratch: string; evidence: string; nonces: string }; contractPath: string };
let vaultDir = "";
let applyOnlyVault = "";
let previewOnlyVault = "";
function world(over: Partial<ApplyDeps> = {}, contract: unknown = cdkContractJson(KILL), behavior: AwsBehavior = {}): World {
  behave(behavior);
  const dirs = { scratch: fresh("scratch"), evidence: fresh("evidence"), nonces: fresh("nonces") };
  const contractPath = join(fresh("contract"), "act-pilot-contract.json");
  writePinnedContract(contractPath, contract);
  return {
    dirs, contractPath,
    deps: {
      sourceCommit: SOURCE_COMMIT,
      contractPath, contractPinPath: pinPathOf(contractPath), qualificationDir: vaultDir, evidenceDir: dirs.evidence,
      nonces: openNonceStore(dirs.nonces), env: cdkIdentityEnv("DEV"), now: () => NOW, scratchParent: dirs.scratch,
      toolDirs: [toolDir], killPollMs: 40, killGraceMs: 400, ...over,
    },
  };
}
const forEnv = (w: World, environment: ApplyEnvironment): ApplyDeps => ({ ...w.deps, env: cdkIdentityEnv(environment) });

test.before(async () => {
  vaultDir = fresh("qualification");
  await forgeCdkQualification(vaultDir);
  applyOnlyVault = fresh("qualification-apply");
  await forgeCdkQualification(applyOnlyVault, "apply");
  previewOnlyVault = fresh("qualification-preview");
  await forgeCdkQualification(previewOnlyVault, "preview");
});

async function seal(w: World, environment: ApplyEnvironment, options: AssemblyOptions = {}, p: Project = writeAssembly(fresh("assembly"), cdkTargetOf(environment), options)) {
  const target = cdkTargetOf(environment);
  const result = await sealPreview({
    invocation: human(target), environment, target, manifest: p.manifest, projectRoot: p.projectRoot, policyVersion: POLICY, resolved: p.resolved,
  }, forEnv(w, environment));
  assert.ok(result.ok, JSON.stringify(result));
  const loaded = await loadSealedPlan(result.path);
  assert.ok(loaded.ok);
  return { sealed: result.sealed, path: result.path, project: p, loaded: { sealed: loaded.sealed, planBytes: loaded.planBytes } };
}
type Sealed = Awaited<ReturnType<typeof seal>>;
/** The seal refused: the result's message. */
async function sealRefused(w: World, environment: ApplyEnvironment, options: AssemblyOptions = {}, deps: ApplyDeps = forEnv(w, environment)) {
  const target = cdkTargetOf(environment);
  const p = writeAssembly(fresh("assembly"), target, options);
  const result = await sealPreview({
    invocation: human(target), environment, target, manifest: p.manifest, projectRoot: p.projectRoot, policyVersion: POLICY, resolved: p.resolved,
  }, deps);
  assert.equal(result.ok, false, "the seal was expected to be refused");
  return result as Extract<typeof result, { ok: false }>;
}

const approvalsFor = (s: Sealed): SignedApproval[] => (s.sealed.environment === "PROD" ? [approval(s.sealed, "alice"), approval(s.sealed, "bob")] : [approval(s.sealed, "alice")]);
const requestFor = (s: Sealed, approvals: SignedApproval[], over: Partial<ApplyRequest> = {}): ApplyRequest => ({
  invocation: human(s.sealed.target), environment: s.sealed.environment, target: { ...s.sealed.target }, sealedPlan: s.loaded,
  manifest: s.project.manifest, projectRoot: s.project.projectRoot, approvals, ...over,
});
const run = (w: World, s: Sealed, approvals: SignedApproval[] = approvalsFor(s), over: Partial<ApplyRequest> = {}, deps?: ApplyDeps) =>
  runApply(requestFor(s, approvals, over), deps ?? forEnv(w, s.sealed.environment));
const refused = (result: ApplyResult, code: string): void => {
  assert.equal(result.ok, false, JSON.stringify(result));
  assert.equal((result as { code: string }).code, code, JSON.stringify(result));
};
const outcomeOf = (result: ApplyResult): string | undefined => (result.ok ? result.evidence.outcome : result.outcome);
const clean = (w: World): void => assert.deepEqual(readdirSync(w.dirs.scratch), [], "no scratch directory, copy or snapshot survives");
const noCanary = (value: unknown): void => {
  const text = JSON.stringify(value);
  for (const canary of CDK_CANARIES) assert.ok(!text.includes(canary), "carries " + canary);
};
const roleOf = (call: AwsCall): string => (call.env.AWS_ROLE_ARN ?? "").split("/")[1] ?? "";
const recordOf = (s: Sealed) => JSON.parse(s.loaded.planBytes.toString("utf8")) as Record<string, unknown>;

// --- the engine and the contract ------------------------------------------------------------------

test("the CDK engine is registered, needs DISCOVERY, CHANGESET and APPLY, and is valid only with AWS", () => {
  assert.ok(ENGINE_IDS.includes("CDK"));
  assert.equal(engineSpec("CDK"), CDK);
  assert.deepEqual([...CDK.identities], ["DISCOVERY", "CHANGESET", "APPLY"]);
  assert.deepEqual([...CDK.attests], ["CHANGESET", "APPLY"]);
  assert.deepEqual([...CDK.providers], ["AWS"]);
  assert.ok(!CDK.identities.includes("STATE") && !CDK.identities.includes("STATE_WRITE"));
  assert.deepEqual([...EXECUTION_IDENTITIES], ["DISCOVERY", "STATE", "STATE_WRITE", "APPLY", "CHANGESET"]);
  assert.notEqual(CDK.previewAdapter().argvDigest, CDK.applyAdapter.argvDigest, "the surfaces never activate each other");
  assert.equal(CDK.previewAdapter().engine, "CDK");
});

const writeContract = (contract: unknown): string => {
  const path = join(fresh("contract"), "act-pilot-contract.json");
  writePinnedContract(path, contract);
  return path;
};
const loaded = (contract: unknown) => { const path = writeContract(contract); return loadPilotContract(path, pinPathOf(path)); };
const reasonOf = (contract: unknown): string => { const l = loaded(contract); assert.equal(l.enabled, false); return (l as { reason: string }).reason; };
const editTargets = (edit: (targets: Record<string, Record<string, unknown>>) => void, capabilities: string[] = []) => {
  const contract = cdkContractJson(KILL, capabilities) as { targets: Record<string, Record<string, unknown>> };
  edit(contract.targets);
  return contract;
};

test("a CDK contract loads with a stack name as the backend, the same in every account, and explicit capabilities per environment", () => {
  const good = loaded(cdkContractJson(KILL, ["CAPABILITY_IAM"])) as PilotContract;
  assert.equal(good.enabled, true);
  assert.equal(good.engine, "CDK");
  assert.deepEqual(good.targets.PROD, { accountId: "333333333333", region: "us-east-1", backend: STACK, workspace: "default", capabilities: ["CAPABILITY_IAM"] });
  assert.match(reasonOf(contractJson(KILL, { engine: "CDK" })), /engine: CDK is valid only with AWS/);
  assert.match(reasonOf(editTargets((t) => { t.DEV.backend = "examplefake-dev-state/pilot/dev.tfstate"; })), /DEV\.backend/);
  assert.match(reasonOf(editTargets((t) => { t.DEV.backend = "1-bad-stack"; })), /DEV\.backend/);
  assert.match(reasonOf(editTargets((t) => { t.QA.workspace = "other"; })), /QA\.workspace/);
  assert.match(reasonOf(editTargets((t) => { delete t.PROD.capabilities; })), /PROD\.capabilities: missing/);
  assert.match(reasonOf(editTargets((t) => { t.PROD.capabilities = ["CAPABILITY_ROOT"]; })), /PROD\.capabilities/);
  assert.match(reasonOf(editTargets((t) => { t.PROD.capabilities = ["CAPABILITY_IAM", "CAPABILITY_IAM"]; })), /PROD\.capabilities/);
  assert.match(reasonOf(editTargets((t) => { t.QA.accountId = t.DEV.accountId; })), /DEV and QA share an account/);
  // Terraform has no capabilities field: a contract that is not CDK refuses it as unknown.
  assert.match(reasonOf({ ...cdkContractJson(KILL), engine: "TERRAFORM" }), /unknown field|backend/);
  assert.match(reasonOf({ ...cdkContractJson(KILL), engine: "PULUMI" }), /pilot supports/);
});

test("the shipped CDK example is clearly marked, disabled, lists no capabilities, and cannot become valid by flipping the flag", () => {
  const text = readFileSync(fileURLToPath(new URL("../config/act-pilot-contract.aws-cdk.example.json", import.meta.url)), "utf8");
  const parsed = JSON.parse(text) as Record<string, unknown> & { targets: Record<string, { capabilities: unknown }> };
  assert.equal(parsed.enabled, false);
  assert.equal(parsed.provider, "AWS");
  assert.equal(parsed.engine, "CDK");
  assert.match(text, /EXAMPLE/);
  for (const environment of ["DEV", "QA", "PROD"]) assert.deepEqual(parsed.targets[environment].capabilities, [], environment);
  assert.match(reasonOf({ ...parsed, enabled: true }), /EXAMPLE/);
  const { EXAMPLE: _marker, ...unmarked } = parsed;
  assert.match(reasonOf({ ...unmarked, enabled: true }), /approvers/, "the placeholder approver keys are not keys");
});

// --- identities -------------------------------------------------------------------------------------

const env = (environment: ApplyEnvironment = "DEV", over: Record<string, string> = {}): NodeJS.ProcessEnv => ({ ...cdkIdentityEnv(environment), ...over });
const identityRefusal = (e: NodeJS.ProcessEnv, code: string, ...mentions: string[]): void => {
  const outcome = checkApplyIdentities(e, AWS, CDK.identities);
  assert.equal(outcome.ok, false, mentions.join());
  if (outcome.ok) return;
  assert.equal(outcome.code, code, outcome.message);
  for (const name of mentions) assert.ok(outcome.message.includes(name), name + " in " + outcome.message);
  for (const value of Object.values(e)) if (value && value.length > 12) assert.ok(!outcome.message.includes(value), "the message carries a value");
};

test("three distinct roles are accepted; each missing identity is IDENTITY_NOT_CONFIGURED", () => {
  assert.deepEqual(checkApplyIdentities(env(), AWS, CDK.identities), { ok: true });
  for (const identity of ["DISCOVERY", "CHANGESET", "APPLY"]) {
    const e = env();
    for (const key of Object.keys(e)) if (key.startsWith("ALZ_" + identity + "_")) delete e[key];
    identityRefusal(e, "IDENTITY_NOT_CONFIGURED", identity);
  }
});

test("a state identity is an unneeded privileged identity for CDK, and CHANGESET is one for Terraform: both are refused when configured", () => {
  for (const identity of ["STATE", "STATE_WRITE"]) {
    identityRefusal(env("DEV", {
      ["ALZ_" + identity + "_AWS_ROLE_ARN"]: cdkRoleArn(identity, "DEV"), ["ALZ_" + identity + "_AWS_WEB_IDENTITY_TOKEN_FILE"]: "/run/fixture/" + identity + "-token",
    }), "IDENTITY_NOT_CONFIGURED", identity);
  }
  // A full Terraform set beside the CDK set.
  identityRefusal(env("DEV", Object.fromEntries(["STATE", "STATE_WRITE"].map((i) => ["ALZ_" + i + "_AWS_REGION", "us-east-1"]))), "IDENTITY_NOT_CONFIGURED", "STATE");
  const terraformSet = checkApplyIdentities({ ...cdkIdentityEnv("DEV"), ...Object.fromEntries(["STATE", "STATE_WRITE"].flatMap((i) => [
    ["ALZ_" + i + "_AWS_ROLE_ARN", cdkRoleArn(i, "DEV")], ["ALZ_" + i + "_AWS_WEB_IDENTITY_TOKEN_FILE", "/run/fixture/" + i + "-token"],
  ])) }, AWS, APPLY_IDENTITIES);
  assert.equal(terraformSet.ok, false, "Terraform's four plus CHANGESET");
  if (!terraformSet.ok) assert.match(terraformSet.message, /CHANGESET/);
});

test("CHANGESET and APPLY (and DISCOVERY) are separate principals: the same role or token file collapses them, by name and never by value", () => {
  identityRefusal(env("DEV", { ALZ_CHANGESET_AWS_ROLE_ARN: cdkRoleArn("APPLY", "DEV") }), "IDENTITY_COLLAPSED", "CHANGESET", "APPLY", "AWS_ROLE_ARN");
  identityRefusal(env("DEV", { ALZ_CHANGESET_AWS_ROLE_ARN: cdkRoleArn("APPLY", "DEV").toUpperCase().replace("ARN:AWS:IAM", "arn:aws:iam") }), "IDENTITY_COLLAPSED", "CHANGESET", "APPLY");
  identityRefusal(env("DEV", { ALZ_APPLY_AWS_WEB_IDENTITY_TOKEN_FILE: "/run/fixture/changeset-dev-token" }), "IDENTITY_COLLAPSED", "AWS_WEB_IDENTITY_TOKEN_FILE");
  identityRefusal(env("DEV", { ALZ_CHANGESET_AWS_ROLE_ARN: cdkRoleArn("DISCOVERY", "DEV") }), "IDENTITY_COLLAPSED", "CHANGESET", "DISCOVERY");
  // Static keys, a profile or the operator's own credentials for the new identity are refused like for the others.
  identityRefusal(env("DEV", { ALZ_CHANGESET_AWS_ACCESS_KEY_ID: "AKIAFAKECHANGESET0000" }), "IDENTITY_NOT_CONFIGURED", "ALZ_CHANGESET_AWS_ACCESS_KEY_ID");
  identityRefusal(env("DEV", { ALZ_CHANGESET_AWS_PROFILE: "operator" }), "IDENTITY_NOT_CONFIGURED", "ALZ_CHANGESET_AWS_PROFILE");
  identityRefusal(env("DEV", { ALZ_CHANGESET_AWS_WEB_IDENTITY_TOKEN_FILE: "relative/token" }), "IDENTITY_NOT_CONFIGURED", "ALZ_CHANGESET_AWS_WEB_IDENTITY_TOKEN_FILE");
  // A service endpoint, a trust store, a second default region or the metadata service would send the web identity token elsewhere: the aws profile hands none to a child.
  for (const identity of ["CHANGESET", "APPLY", "DISCOVERY"]) {
    const refusedNames = buildChildEnvironment({
      profile: AWS_CFN_APPLY_PROFILE, base: env("DEV", {
        ["ALZ_" + identity + "_AWS_ENDPOINT_URL"]: "https://abc123.execute-api.us-east-1.amazonaws.com", ["ALZ_" + identity + "_AWS_CA_BUNDLE"]: "/tmp/ca.pem",
        ["ALZ_" + identity + "_AWS_DEFAULT_REGION"]: "eu-west-2", ["ALZ_" + identity + "_AWS_ACCESS_KEY_ID"]: "AKIAFAKECHANGESET0000",
      }), toolDirs: ["/usr/bin"], home: "/h", tmp: "/t", identity,
    });
    assert.deepEqual(refusedNames.refused, ["AWS_ACCESS_KEY_ID", "AWS_CA_BUNDLE", "AWS_DEFAULT_REGION", "AWS_ENDPOINT_URL"].map((n) => "ALZ_" + identity + "_" + n));
    for (const name of ["AWS_ENDPOINT_URL", "AWS_CA_BUNDLE", "AWS_DEFAULT_REGION", "AWS_ACCESS_KEY_ID"]) assert.equal(refusedNames.env[name], undefined, name);
    assert.equal(refusedNames.env.AWS_EC2_METADATA_DISABLED, "true");
    assert.equal(refusedNames.env.AWS_ROLE_ARN, cdkRoleArn(identity, "DEV"));
  }
});

test("a variable the runner would drop from an identity stops the seal before any change set exists", async () => {
  const w = world();
  const refusal = await sealRefused(w, "DEV", {}, { ...forEnv(w, "DEV"), env: env("DEV", { ALZ_CHANGESET_AWS_ENDPOINT_URL: "https://abc123.execute-api.us-east-1.amazonaws.com" }) });
  assert.match(refusal.message, /ENVIRONMENT_REFUSED/);
  assert.ok(!calls().some((call) => call.args[1] === "create-change-set"));
});

test("every CDK role names the contract's account and region; CHANGESET is a mutating identity and must set both", async () => {
  const contract = loaded(cdkContractJson(KILL)) as PilotContract;
  assert.deepEqual(verifyIdentityTargets(contract, "DEV", env("DEV"), AWS, CDK.identities), { ok: true });
  const wrong = verifyIdentityTargets(contract, "DEV", env("DEV", { ALZ_CHANGESET_AWS_ROLE_ARN: cdkRoleArn("CHANGESET", "QA") }), AWS, CDK.identities);
  assert.equal(wrong.ok, false);
  if (!wrong.ok) { assert.equal(wrong.code, "IDENTITY_TARGET_MISMATCH"); assert.match(wrong.message, /ALZ_CHANGESET_AWS_ROLE_ARN/); }
  const unset = env("DEV");
  delete unset.ALZ_CHANGESET_AWS_REGION;
  const missing = verifyIdentityTargets(contract, "DEV", unset, AWS, CDK.identities);
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.match(missing.message, /ALZ_CHANGESET_AWS_REGION \(not set\)/);
  assert.equal(attestedClientId(env(), "CHANGESET", AWS), cdkRoleArn("CHANGESET", "DEV"));
});

// --- the argument allowlist -------------------------------------------------------------------------

const ARN_CS = "arn:aws:cloudformation:us-east-1:111111111111:changeSet/alz-0123456789ab/11111111-2222-3333-4444-555555555555";
const COMMON = ["--region", "us-east-1", "--output", "json", "--no-cli-pager"];
/** The deletion unit's three stack tags, as the CLI's shorthand (src/apply/unit.ts; the engine passes exactly these keys). */
const UNIT_TAGS = ["Key=alz-build,Value=alzb-0123456789abcdef0123", "Key=alz-managed-by,Value=alz", "Key=alz-unit,Value=alzu-0123456789abcdef0123"];
const create = (caps: string[] = [], tags: string[] = UNIT_TAGS) => ["cloudformation", "create-change-set", "--stack-name", STACK, "--change-set-name", "alz-0123456789ab", "--change-set-type", "UPDATE",
  "--template-body", "file://PilotStack.template.json", ...(caps.length ? ["--capabilities", ...caps] : []), "--tags", ...tags, ...COMMON];
const EXECUTE = ["cloudformation", "execute-change-set", "--change-set-name", ARN_CS, "--region", "us-east-1", "--no-cli-pager"];

test("each identity may run only its own argument lists: CHANGESET cannot execute, APPLY cannot create, and nothing deletes", () => {
  assert.equal(isAllowedCdkArgv("CHANGESET", create()), true);
  assert.equal(isAllowedCdkArgv("CHANGESET", create(["CAPABILITY_IAM", "CAPABILITY_NAMED_IAM"])), true);
  assert.equal(isAllowedCdkArgv("APPLY", EXECUTE), true);
  assert.equal(isAllowedCdkArgv("CHANGESET", EXECUTE), false, "a change set creator cannot execute one");
  assert.equal(isAllowedCdkArgv("DISCOVERY", EXECUTE), false);
  assert.equal(isAllowedCdkArgv(null, EXECUTE), false);
  assert.equal(isAllowedCdkArgv("APPLY", create()), false, "the applier cannot create a change set");
  assert.equal(isAllowedCdkArgv("DISCOVERY", create()), false);
  assert.equal(isAllowedCdkArgv("DISCOVERY", ["cloudformation", "describe-stacks", "--stack-name", STACK, ...COMMON]), true);
  assert.equal(isAllowedCdkArgv(null, ["--version"]), true);
  for (const identity of [null, "DISCOVERY", "CHANGESET", "APPLY", "STATE", "STATE_WRITE"] as const) {
    for (const args of [
      ["cloudformation", "delete-stack", "--stack-name", STACK, ...COMMON], ["cloudformation", "delete-change-set", "--change-set-name", ARN_CS, ...COMMON],
      ["cloudformation", "create-stack", "--stack-name", STACK, ...COMMON], ["cloudformation", "update-stack", "--stack-name", STACK, ...COMMON],
      ["cloudformation", "update-termination-protection", "--stack-name", STACK, ...COMMON], ["cloudformation", "deploy", "--stack-name", STACK],
      ["s3", "cp", "a", "b"], ["sts", "get-caller-identity"], ["cloudformation", "execute-change-set", "--change-set-name", ARN_CS, "--disable-rollback", "--region", "us-east-1", "--no-cli-pager"],
    ]) assert.equal(isAllowedCdkArgv(identity, args), false, String(identity) + " " + args.join(" "));
  }
  // Slots are judged: a path that climbs, a name that is not ours, another capability, another change set type.
  assert.equal(isAllowedCdkArgv("CHANGESET", create().map((a) => a.replace("file://PilotStack.template.json", "file://../x.json"))), false);
  assert.equal(isAllowedCdkArgv("CHANGESET", create().map((a) => a.replace("alz-0123456789ab", "mine"))), false);
  assert.equal(isAllowedCdkArgv("CHANGESET", create(["CAPABILITY_ROOT"])), false);
  assert.equal(isAllowedCdkArgv("CHANGESET", create().map((a) => a.replace("UPDATE", "IMPORT"))), false);
  assert.equal(isAllowedCdkArgv("APPLY", EXECUTE.map((a) => a.replace("us-east-1", "us-east-1 --profile x"))), false);
  assert.equal(isAllowedCdkArgv("APPLY", [...EXECUTE, "--profile", "operator"]), false);
  assert.equal(isAllowedCdkArgv("APPLY", EXECUTE.map((a) => a.replace(ARN_CS, "alz-0123456789ab"))), false, "a change set is named by its ARN");
  // The stack tags are the deletion unit's three and nothing else: no tag dropped, no fourth, no other key, no value outside the tag-safe shape.
  assert.equal(isAllowedCdkArgv("CHANGESET", create([], [])), false, "a change set without the unit's tags");
  assert.equal(isAllowedCdkArgv("CHANGESET", create([], UNIT_TAGS.slice(0, 2))), false, "a dropped tag");
  assert.equal(isAllowedCdkArgv("CHANGESET", create([], [...UNIT_TAGS, "Key=alz-expires,Value=2026-12-31"])), false, "a fourth tag");
  assert.equal(isAllowedCdkArgv("CHANGESET", create([], [...UNIT_TAGS.slice(0, 2), "Key=owner,Value=alice"])), false, "another key");
  assert.equal(isAllowedCdkArgv("CHANGESET", create([], [...UNIT_TAGS.slice(0, 2), "Key=alz-unit,Value=../x"])), false, "a value outside the tag-safe shape");
  // The blueprint's read is DISCOVERY's alone, on the apply surface.
  const resources = ["cloudformation", "describe-stack-resources", "--stack-name", STACK, ...COMMON];
  assert.equal(isAllowedCdkArgv("DISCOVERY", resources), true);
  for (const who of [null, "CHANGESET", "APPLY"] as const) assert.equal(isAllowedCdkArgv(who, resources), false, String(who) + " cannot read the stack's resources");
  assert.equal(isAllowedCdkArgv("DISCOVERY", resources, "preview"), false, "sealing reads no resources");
});

// --- the full path, in order ------------------------------------------------------------------------

test("a DEV, QA and PROD promotion seals a change set per account and executes exactly it, each step as the right identity", async () => {
  const w = world();
  const stages: { sealed: Sealed; result: ApplyResult }[] = [];
  for (const environment of ["DEV", "QA", "PROD"] as const) {
    const before = calls().length;
    const s = await seal(w, environment);
    const sealCalls = calls().slice(before);
    assert.deepEqual(subcommandsOf(sealCalls), ["--version", "describe-stacks", "create-change-set", "wait", "describe-change-set", "get-template", "describe-stacks"], environment);
    assert.deepEqual(sealCalls.map(roleOf), ["", ...["discovery", "changeset", "changeset", "changeset", "changeset", "discovery"].map((who) => "alz-" + who + "-" + environment.toLowerCase())]);
    assert.equal(sealCalls.every((call) => !("AWS_ACCESS_KEY_ID" in call.env) && !("AWS_SECRET_ACCESS_KEY" in call.env)), true, "no ambient key reaches a child");
    assert.equal(sealCalls[0].env.AWS_ROLE_ARN, undefined, "the version check holds no identity");
    assert.ok(sealCalls.slice(1).every((call) => call.args.includes("--region") && call.args[call.args.indexOf("--region") + 1] === "us-east-1"));
    assert.ok(!sealCalls.some((call) => ["execute-change-set", "delete-change-set", "delete-stack"].includes(call.args[1])), "nothing is executed or deleted at seal");

    const record = recordOf(s);
    assert.equal(record.stackName, STACK);
    assert.equal(record.changeSetType, "CREATE");
    assert.match(String(record.changeSetId), new RegExp("^arn:aws:cloudformation:us-east-1:" + cdkTargetOf(environment).account + ":changeSet/alz-[0-9a-f]{12}/"));
    assert.match(String(record.stackId), /^arn:aws:cloudformation:us-east-1:\d{12}:stack\/PilotStack\//);
    for (const field of ["templateSha256", "parametersSha256", "changeListSha256", "stackSha256", "tagsSha256"]) assert.match(String(record[field]), /^[0-9a-f]{64}$/, field);
    assert.deepEqual(record.capabilities, []);
    // The deletion unit rides on the change set as stack tags, and the sealed plan carries the unit the approvers sign.
    const created = sealCalls.find((call) => call.args[1] === "create-change-set")!;
    const tagArgs = created.args.slice(created.args.indexOf("--tags") + 1, created.args.indexOf("--region"));
    assert.ok(s.sealed.unit, "the CDK seal carries the unit");
    assert.deepEqual(tagArgs, Object.entries(s.sealed.unit!.tags).sort(([a], [b]) => (a < b ? -1 : 1)).map(([key, value]) => "Key=" + key + ",Value=" + value));
    assert.deepEqual(Object.keys(s.sealed.unit!.tags).sort(), ["alz-build", "alz-managed-by", "alz-unit"]);
    assert.equal(s.sealed.unit!.tags["alz-unit"], s.sealed.unit!.unitId);
    assert.deepEqual(s.sealed.unit!.untagged, []);
    assert.deepEqual(s.sealed.changes, [
      { address: "PilotBucket", type: "AWS::S3::Bucket", action: "CREATE" },
      { address: "PilotTopic", type: "AWS::SNS::Topic", action: "REPLACE" },
    ]);
    noCanary(reviewBundleOf(s.sealed));
    noCanary(s.sealed);

    const applyFrom = calls().length;
    const result = await run(w, s);
    assert.ok(result.ok, environment + " " + JSON.stringify(result));
    const applyCalls = calls().slice(applyFrom);
    // After the execution the stack's resources are read once as DISCOVERY for the blueprint (src/observe/blueprint.ts), and nothing else runs.
    assert.deepEqual(subcommandsOf(applyCalls), ["--version", "describe-stacks", "describe-change-set", "get-template", "describe-stacks", "execute-change-set", "describe-stacks", "describe-stacks", "describe-change-set", "describe-stack-resources"]);
    assert.deepEqual(applyCalls.map(roleOf).slice(1), ["alz-apply-", "alz-changeset-", "alz-changeset-", "alz-apply-", "alz-apply-", "alz-apply-", "alz-apply-", "alz-changeset-", "alz-discovery-"].map((r) => r + environment.toLowerCase()));
    const execute = applyCalls.filter((call) => call.args[1] === "execute-change-set");
    assert.equal(execute.length, 1);
    assert.deepEqual(execute[0].args, ["cloudformation", "execute-change-set", "--change-set-name", String(record.changeSetId), "--region", "us-east-1", "--no-cli-pager"]);
    assert.equal(result.evidence.outcome, "SUCCEEDED");
    assert.equal(result.evidence.artifactSha256, s.sealed.artifactSha256);
    assert.deepEqual(result.evidence.adapter, { adapterVersion: CDK.applyAdapter.adapterVersion, argvDigest: CDK.applyAdapter.argvDigest });
    assert.equal(result.evidence.toolVersions.engine, AWS_CLI_VERSION);
    assert.equal(result.evidence.authority.agentInitiated, false);
    assert.equal(result.evidence.authority.mutation, "CLOUDFORMATION_EXECUTE_OF_SEALED_CHANGE_SET");
    assertApplyEvidence(result.evidence);
    noCanary(result.evidence);
    stages.push({ sealed: s, result });
  }
  assert.equal(new Set(stages.map((stage) => stage.sealed.sealed.releaseIdentity)).size, 1, "one release, promoted");
  assert.ok(!calls().some((call) => call.unexpected || /delete|update-stack|create-stack/.test(call.args[1] ?? "")), "no stack deletion or other argv anywhere");
  clean(w);
});

test("QA needs a successful DEV apply of the same release, and PROD a successful QA apply", async () => {
  const w = world();
  const qa = await seal(w, "QA");
  refused(await run(w, qa), "PROMOTION_EVIDENCE_MISSING");
  const dev = await seal(w, "DEV");
  assert.ok((await run(w, dev)).ok);
  const prod = await seal(w, "PROD");
  refused(await run(w, prod), "PROMOTION_EVIDENCE_MISSING");
  assert.ok((await run(w, qa)).ok);
  assert.ok((await run(w, prod)).ok);
  assert.equal(calls().filter((call) => call.args[1] === "execute-change-set").length, 3);
});

test("an existing stack is updated: the change set type comes from describe-stacks, and a stable status and termination protection are required", async () => {
  const w = world({}, undefined, { stackExists: true });
  const s = await seal(w, "DEV");
  assert.equal(recordOf(s).changeSetType, "UPDATE");
  assert.ok(calls().some((call) => call.args[1] === "create-change-set" && call.args[call.args.indexOf("--change-set-type") + 1] === "UPDATE"));
  assert.ok((await run(w, s)).ok);
  for (const status of ["UPDATE_IN_PROGRESS", "ROLLBACK_COMPLETE", "UPDATE_ROLLBACK_FAILED", "DELETE_COMPLETE"]) {
    behave({ stackExists: true, stackStatus: status });
    const refusal = await sealRefused(w, "DEV");
    assert.match(refusal.message, /STACK_STATE_UNSUITABLE/, status);
    assert.ok(!calls().some((call) => call.args[1] === "create-change-set"), "no change set for " + status);
  }
  behave({ stackExists: true, termination: false });
  assert.match((await sealRefused(w, "DEV")).message, /TERMINATION_PROTECTION_OFF/);
  assert.ok(!calls().some((call) => call.args[1] === "create-change-set"));
});

// --- sealing refusals --------------------------------------------------------------------------------

test("an assembly that needs asset publishing, a second stack, a nested stack or a cross-stack import is refused before any change set exists", async () => {
  const w = world();
  const cases: [AssemblyOptions, RegExp][] = [
    [{ fileAsset: true }, /ASSEMBLY_NEEDS_ASSETS/],
    [{ dockerAsset: true }, /ASSEMBLY_NEEDS_ASSETS/],
    [{ secondStack: true }, /ASSEMBLY_STACK_COUNT/],
    [{ nestedAssembly: true }, /ASSEMBLY_ARTIFACT_UNSUPPORTED/],
    [{ nestedStack: true }, /ASSEMBLY_NESTED_STACK/],
    [{ importValue: true }, /ASSEMBLY_CROSS_STACK_IMPORT/],
    [{ padding: 60_000 }, /TEMPLATE_TOO_LARGE/],
    [{ terminationProtection: false }, /TERMINATION_PROTECTION_OFF/],
    [{ stackName: "OtherName" }, /STACK_NOT_IN_CONTRACT/],
    [{ environment: "aws://222222222222/us-east-1" }, /ASSEMBLY_ENV_NOT_IN_CONTRACT/],
    [{ environment: "aws://111111111111/eu-west-1" }, /ASSEMBLY_ENV_NOT_IN_CONTRACT/],
  ];
  for (const [options, pattern] of cases) {
    const refusal = await sealRefused(w, "DEV", options);
    assert.equal(refusal.code, "ARTIFACT_INVALID");
    assert.match(refusal.message, pattern, JSON.stringify(options));
    assert.ok(!calls().some((call) => ["create-change-set", "execute-change-set"].includes(call.args[1])), JSON.stringify(options));
  }
  // The same assembly bound to the contract's own account is fine.
  assert.ok((await seal(w, "DEV", { environment: "aws://111111111111/us-east-1" })).sealed);
  clean(w);
});

test("capabilities are granted only when the pinned contract lists them for the environment", async () => {
  const w = world();
  const refusal = await sealRefused(w, "DEV", { iam: true });
  assert.match(refusal.message, /EXIT_254/);
  assert.ok(calls().some((call) => call.args[1] === "create-change-set"));
  assert.ok(!calls().some((call) => call.args.includes("--capabilities")), "no capability is passed that the contract does not list");
  assert.ok(!calls().some((call) => ["wait", "describe-change-set", "execute-change-set"].includes(call.args[1])), "no change set came of it");

  const iam = world({}, cdkContractJson(KILL, ["CAPABILITY_IAM"]));
  const s = await seal(iam, "DEV", { iam: true });
  assert.deepEqual(recordOf(s).capabilities, ["CAPABILITY_IAM"]);
  const created = calls().find((call) => call.args[1] === "create-change-set")!;
  assert.deepEqual(created.args.slice(created.args.indexOf("--capabilities"), created.args.indexOf("--capabilities") + 2), ["--capabilities", "CAPABILITY_IAM"]);
  assert.ok((await run(iam, s)).ok);
  // One environment's decision is not another's.
  const perEnvironment = cdkContractJson(KILL, []) as { targets: Record<string, { capabilities: string[] }> };
  perEnvironment.targets.DEV.capabilities = ["CAPABILITY_IAM"];
  const mixed = world({}, perEnvironment);
  assert.ok(await seal(mixed, "DEV", { iam: true }));
  assert.match((await sealRefused(mixed, "QA", { iam: true })).message, /EXIT_254/);
});

test("a change set the CHANGESET role did not create in the contract's account, a failed wait, a failed describe or a wrong CLI version fail the seal closed", async () => {
  const w = world();
  const cases: [AwsBehavior, RegExp][] = [
    [{ arnAccount: "222222222222" }, /CHANGESET_NOT_IN_CONTRACT/],
    [{ waitFails: true }, /EXIT_255/],
    // A change set with nothing to change and one that could not be built both end FAILED; the reason tells them apart. An empty list is never sealed.
    [{ waitFails: true, changeSetStatus: "FAILED", statusReason: "The submitted information didn't contain changes. Submit different information to create a change set." }, /NO_CHANGES_TO_APPLY/],
    [{ waitFails: true, changeSetStatus: "FAILED", statusReason: "Template format error: unresolved resource dependencies" }, /CHANGE_SET_CREATION_FAILED/],
    [{ noChanges: true }, /NO_CHANGES_TO_APPLY/],
    // A page that was not read (a NextToken left in the output) is never sealed.
    [{ nextToken: true }, /CHANGE_SET_TRUNCATED/],
    [{ changeSetStatus: "FAILED" }, /CHANGE_SET_NOT_CREATED/],
    [{ executionStatus: "UNAVAILABLE" }, /CHANGE_SET_NOT_CREATED/],
    [{ describeStacksFail: true }, /STACK_UNREADABLE/],
    [{ version: "2.0.1" }, /ENGINE_VERSION_MISMATCH/],
    [{ echoCapabilities: ["CAPABILITY_NAMED_IAM"] }, /CAPABILITY_NOT_IN_CONTRACT/],
  ];
  for (const [behavior, pattern] of cases) {
    behave(behavior);
    const refusal = await sealRefused(w, "DEV");
    assert.match(refusal.message, pattern, JSON.stringify(behavior));
    assert.ok(!calls().some((call) => ["execute-change-set", "delete-change-set", "delete-stack"].includes(call.args[1])));
  }
  clean(w);
});

// --- applying ------------------------------------------------------------------------------------------

/** Seals DEV, changes the cloud, and applies: the refusal must come before any approval is consumed and any execution. */
async function refusedBeforeExecution(behavior: AwsBehavior, code: string, w = world()) {
  const s = await seal(w, "DEV");
  patchAws(toolDir, behavior);
  const result = await run(w, s);
  refused(result, code);
  assert.ok(!calls().some((call) => call.args[1] === "execute-change-set"), "nothing executed");
  // The approvals were not consumed: the same ones apply once the cloud is as sealed.
  patchAws(toolDir, {
    swapChangeSetId: undefined, swapStackId: undefined, describedStackId: undefined, executionStatus: undefined, extraChange: undefined, changeSetStatus: undefined,
    stackUpdated: undefined, stackRoleArn: undefined, templateDiffers: undefined,
  });
  assert.ok((await run(w, s)).ok, "the approvals and the sealed plan were still good");
  clean(w);
  return result;
}

test("a swapped change set id or stack id is ARTIFACT_TAMPERED, before any approval is consumed", async () => {
  await refusedBeforeExecution({ swapChangeSetId: "arn:aws:cloudformation:us-east-1:111111111111:changeSet/alz-ffffffffffff/99999999-9999-9999-9999-999999999999" }, "ARTIFACT_TAMPERED");
  await refusedBeforeExecution({ swapStackId: "arn:aws:cloudformation:us-east-1:111111111111:stack/PilotStack/99999999-9999-9999-9999-999999999999" }, "ARTIFACT_TAMPERED");
});

test("a stack that is not the sealed stack (deleted and made again) is ARTIFACT_TAMPERED", async () => {
  await refusedBeforeExecution({ describedStackId: "arn:aws:cloudformation:us-east-1:111111111111:stack/PilotStack/99999999-9999-9999-9999-999999999999" }, "ARTIFACT_TAMPERED");
});

test("a change list that differs from the sealed one is ARTIFACT_TAMPERED", async () => {
  await refusedBeforeExecution({ extraChange: true }, "ARTIFACT_TAMPERED");
});

test("a change set CloudFormation no longer calls executable is PLAN_STALE, nothing executed", async () => {
  for (const executionStatus of ["OBSOLETE", "UNAVAILABLE", "EXECUTE_COMPLETE"]) await refusedBeforeExecution({ executionStatus }, "PLAN_STALE");
  await refusedBeforeExecution({ changeSetStatus: "FAILED" }, "PLAN_STALE");
});

test("a stack changed after sealing is PLAN_STALE on the engine's own check, even when CloudFormation still calls the change set executable", async () => {
  // The fake keeps the change set AVAILABLE throughout: only the sealed stack state can catch these.
  await refusedBeforeExecution({ stackUpdated: "2026-10-11T11:45:00.000Z" }, "PLAN_STALE", world({}, undefined, { stackExists: true }));
  await refusedBeforeExecution({ stackRoleArn: "arn:aws:iam::111111111111:role/AdministratorAccess" }, "PLAN_STALE", world({}, undefined, { stackExists: true }));
});

test("a stack that changes between the engine's preparation and the execution is read again and stops the apply before execute-change-set", async () => {
  const w = world({}, undefined, { stackExists: true });
  const s = await seal(w, "DEV");
  patchAws(toolDir, { bumpStackOn: "get-template" });
  const result = await run(w, s);
  refused(result, "APPROVALS_SPENT");
  assert.match((result as { message: string }).message, /PLAN_STALE/);
  assert.ok(!calls().some((call) => call.args[1] === "execute-change-set"), "nothing executed");
  // The approvals are spent, the artifact is given back: it is not an applied artifact.
  patchAws(toolDir, { bumpStackOn: undefined });
  const again = await run(w, s, [approval(s.sealed, "alice")]);
  refused(again, "PLAN_STALE");
  clean(w);
});

test("a change set that does not hold the assembly's template is refused at the seal and at the apply", async () => {
  const w = world();
  behave({ templateDiffers: true });
  assert.match((await sealRefused(w, "DEV")).message, /CHANGE_SET_TEMPLATE_MISMATCH/);
  assert.ok(!calls().some((call) => call.args[1] === "execute-change-set"));
  const ok = world();
  await refusedBeforeExecution({ templateDiffers: true }, "ARTIFACT_TAMPERED", ok);
});

test("a template changed after sealing is ARTIFACT_TAMPERED: the assembly is bound to the manifest and the sealed record", async () => {
  const w = world();
  const s = await seal(w, "DEV");
  const template = join(s.project.projectRoot, STACK + ".template.json");
  appendFileSync(template, " ");
  const result = await run(w, s);
  refused(result, "ARTIFACT_TAMPERED");
  assert.ok(!calls().some((call) => call.args[1] === "execute-change-set"));
  clean(w);
  // A new assembly with a changed template bound to a new manifest is not this sealed plan either.
  const other = writeAssembly(fresh("assembly"), cdkTargetOf("DEV"), { iam: false, padding: 5 });
  refused(await run(w, s, approvalsFor(s), { manifest: other.manifest, projectRoot: other.projectRoot }), "ARTIFACT_TAMPERED");
});

test("the engine binds the sealed record to the assembly it is given, whatever the driver passed", async () => {
  const w = world();
  const s = await seal(w, "DEV");
  const other = writeAssembly(fresh("assembly"), cdkTargetOf("DEV"), { padding: 5 });
  const snapshot = createImmutableSnapshot(other.projectRoot, other.manifest, w.dirs.scratch);
  try {
    const engineRun = CDK.openApply({
      scratchDir: fresh("direct"), env: cdkIdentityEnv("DEV"), toolDirs: [toolDir], manifest: other.manifest,
      pinned: (loaded(cdkContractJson(KILL)) as PilotContract).targets.DEV, spec: AWS, target: s.sealed.target, engineVersion: AWS_CLI_VERSION,
    });
    engineRun.prepare(snapshot.path);
    assert.throws(() => engineRun.rederive(s.loaded.planBytes), (error) => codeOf(error) === "ARTIFACT_TAMPERED");
  } finally { snapshot.remove(); }
});

test("an execute that fails with the stack untouched is FAILED_NO_CHANGE, spends the sealed plan and carries no engine text", async () => {
  const w = world();
  const s = await seal(w, "DEV");
  patchAws(toolDir, { executeFail: true, failStderr: STDERR_CANARY });
  const result = await run(w, s);
  refused(result, "APPLY_FAILED");
  assert.equal(outcomeOf(result), "FAILED_NO_CHANGE");
  noCanary(result);
  assert.equal(calls().filter((call) => call.args[1] === "execute-change-set").length, 1, "never retried");
  assert.equal(calls().filter((call) => call.args[1] === "describe-stacks" && roleOf(call) === "alz-apply-dev").length >= 2, true);
  refused(await run(w, s), "ARTIFACT_ALREADY_APPLIED");
  clean(w);
});

test("an execute that is accepted but never shows in the stack is not a success", async () => {
  const w = world({}, undefined, { stackExists: true });
  const s = await seal(w, "DEV");
  patchAws(toolDir, { executeNoop: true });
  const result = await run(w, s);
  refused(result, "APPLY_FAILED");
  assert.equal(outcomeOf(result), "PARTIAL_REQUIRES_REVIEW");
  assert.equal(calls().filter((call) => call.args[1] === "execute-change-set").length, 1);
  clean(w);
});

test("rollback and unknown stack states are classified, and a rollback that touched resources needs a person", async () => {
  const table: [string, string[], boolean, string][] = [
    ["rollback with no resource touched", ["UPDATE_IN_PROGRESS", "UPDATE_ROLLBACK_IN_PROGRESS", "UPDATE_ROLLBACK_COMPLETE"], false, "FAILED_NO_CHANGE"],
    ["rollback after resources were touched", ["UPDATE_IN_PROGRESS", "UPDATE_ROLLBACK_IN_PROGRESS", "UPDATE_ROLLBACK_COMPLETE"], true, "PARTIAL_REQUIRES_REVIEW"],
    ["rollback failed", ["UPDATE_IN_PROGRESS", "UPDATE_ROLLBACK_FAILED"], false, "PARTIAL_REQUIRES_REVIEW"],
    ["create rollback failed", ["ROLLBACK_FAILED"], false, "PARTIAL_REQUIRES_REVIEW"],
    ["a status nobody knows", ["UPDATE_IN_PROGRESS", "SOMETHING_NEW"], false, "PARTIAL_REQUIRES_REVIEW"],
    ["update failed", ["UPDATE_IN_PROGRESS", "UPDATE_FAILED"], false, "PARTIAL_REQUIRES_REVIEW"],
  ];
  for (const [label, pollStatuses, eventsTouched, expected] of table) {
    const w = world({}, undefined, { stackExists: true, pollStatuses, eventsTouched });
    const s = await seal(w, "DEV");
    const result = await run(w, s);
    refused(result, "APPLY_FAILED");
    assert.equal(outcomeOf(result), expected, label);
    noCanary(result);
    assert.equal(calls().filter((call) => call.args[1] === "execute-change-set").length, 1, label);
    assert.ok(!calls().some((call) => /delete|cancel/.test(call.args[1] ?? "")), label);
    refused(await run(w, s), "ARTIFACT_ALREADY_APPLIED");
    clean(w);
  }
});

test("the kill switch before the apply stops it with nothing executed; during polling it cancels an update once and is KILLED; a create cannot be canceled", async () => {
  // Appearing after the engine was prepared and before the approvals are consumed.
  const early = world({}, undefined);
  const s0 = await seal(early, "DEV");
  patchAws(toolDir, { touchKillOn: "describe-change-set" });
  refused(await run(early, s0), "KILL_SWITCH_ACTIVE");
  assert.ok(!calls().some((call) => call.args[1] === "execute-change-set"));
  clean(early);

  // Appearing once the execution is under way, for an update.
  const w = world({}, undefined, { stackExists: true, pollStatuses: ["UPDATE_IN_PROGRESS", "UPDATE_IN_PROGRESS", "UPDATE_IN_PROGRESS"], touchKillAtPoll: 1 });
  const s = await seal(w, "DEV");
  const result = await run(w, s);
  refused(result, "APPLY_FAILED");
  assert.equal(outcomeOf(result), "KILLED");
  assert.equal(calls().filter((call) => call.args[1] === "cancel-update-stack").length, 1, "canceled once");
  assert.equal(calls().filter((call) => call.args[1] === "execute-change-set").length, 1);
  assert.ok(!calls().some((call) => /delete/.test(call.args[1] ?? "")));
  noCanary(result);
  clean(w);

  // A create stays in progress; there is nothing to cancel, so the engine waits for its grace period and reports it.
  const create = world({}, undefined, { pollStatuses: ["CREATE_IN_PROGRESS"], touchKillAtPoll: 1 });
  const c = await seal(create, "DEV");
  const stopped = await run(create, c);
  assert.equal(outcomeOf(stopped), "KILLED");
  assert.equal(calls().filter((call) => call.args[1] === "cancel-update-stack").length, 0, "a create cannot be canceled");
  clean(create);
});

test("the engine never starts the execution when told to stop first", async () => {
  const w = world();
  const s = await seal(w, "DEV");
  const scratch = fresh("direct");
  const work = CDK.openApply({
    scratchDir: scratch, env: cdkIdentityEnv("DEV"), toolDirs: [toolDir], manifest: s.project.manifest,
    pinned: (loaded(cdkContractJson(KILL)) as PilotContract).targets.DEV, spec: AWS, target: s.sealed.target, engineVersion: AWS_CLI_VERSION,
  });
  const result = await work.execute(s.loaded.planBytes, { stopWhen: () => true, pollMs: 10, graceMs: 10 });
  assert.equal(result.notStarted, true);
  assert.ok(!calls().some((call) => call.args[1] === "execute-change-set"));
  await sleep(1);
});

// --- the outcome is the execution's, not the stack's alone ----------------------------------------------------

async function applied(behavior: AwsBehavior, setup: AwsBehavior = { stackExists: true }) {
  const w = world({}, undefined, setup);
  const s = await seal(w, "DEV");
  patchAws(toolDir, behavior);
  return { w, s, result: await run(w, s) };
}

test("a refused execute while someone else's update moves the stack is never a success, is not canceled, and does not promote the release", async () => {
  const { w, s, result } = await applied({ executeFail: true, foreignUpdateOnExecute: true });
  refused(result, "APPLY_FAILED");
  assert.equal(outcomeOf(result), "PARTIAL_REQUIRES_REVIEW");
  assert.ok(!calls().some((call) => call.args[1] === "cancel-update-stack"));
  const qa = await seal(w, "QA");
  refused(await run(w, qa), "PROMOTION_EVIDENCE_MISSING");
  refused(await run(w, s), "ARTIFACT_ALREADY_APPLIED");
});

test("an execute whose response was lost is only a no-change when the change set is proven unexecuted; otherwise a person reviews", async () => {
  const lost = await applied({ executeLost: true });
  assert.equal(outcomeOf(lost.result), "FAILED_NO_CHANGE", "CloudFormation reports the change set still AVAILABLE");
  const unread = await applied({ executeLost: true, changeSetReadFailsAfterExecute: true });
  assert.equal(outcomeOf(unread.result), "PARTIAL_REQUIRES_REVIEW", "the change set could not be read");
  const ran = await applied({ executeLost: true, ranAnyway: true });
  refused(ran.result, "APPLY_FAILED");
  assert.equal(outcomeOf(ran.result), "PARTIAL_REQUIRES_REVIEW", "the stack updated although the call failed");
  assert.equal(calls().filter((call) => call.args[1] === "execute-change-set").length, 1, "never retried");
  const stopped = await applied({ executeLost: true, ranAnyway: true, pollStatuses: ["UPDATE_IN_PROGRESS"], touchKillAtPoll: 0 });
  assert.equal(outcomeOf(stopped.result), "KILLED");
  assert.ok(!calls().some((call) => call.args[1] === "cancel-update-stack"), "only an update this command's execute started is canceled");
});

test("a successful stack with a change set not reported executed is not a success", async () => {
  const { result } = await applied({ executionStatus: "EXECUTE_FAILED" }, { stackExists: true });
  // The fake reports the override from the first read, so the apply is refused before it starts; the engine-level check is the next test.
  refused(result, "PLAN_STALE");
});

test("the engine judges a finished stack by the change set too: EXECUTE_COMPLETE is part of success", async () => {
  const w = world({}, undefined, { stackExists: true });
  const s = await seal(w, "DEV");
  const snapshot = createImmutableSnapshot(s.project.projectRoot, s.project.manifest, w.dirs.scratch);
  try {
    const engineRun = CDK.openApply({
      scratchDir: fresh("direct"), env: cdkIdentityEnv("DEV"), toolDirs: [toolDir], manifest: s.project.manifest,
      pinned: (loaded(cdkContractJson(KILL)) as PilotContract).targets.DEV, spec: AWS, target: s.sealed.target, engineVersion: AWS_CLI_VERSION,
    });
    engineRun.prepare(snapshot.path);
    engineRun.rederive(s.loaded.planBytes);
    const result = await engineRun.execute(s.loaded.planBytes, { stopWhen: () => false, pollMs: 10, graceMs: 10 });
    assert.equal(result.ok, true);
    assert.deepEqual(await engineRun.settle(result), { outcome: "SUCCEEDED" });
    patchAws(toolDir, { executionStatus: "EXECUTE_FAILED" });
    assert.deepEqual(await engineRun.settle(result), { outcome: "PARTIAL_REQUIRES_REVIEW" }, "the stack looks done but the change set does not say it was executed");
  } finally { snapshot.remove(); }
});

test("the engine runs only the record it rederived, and only after it was prepared", async () => {
  const w = world({}, undefined, { stackExists: true });
  const s = await seal(w, "DEV");
  // A well-formed record for a different stack state: the engine must not run what it did not rederive.
  const other = Buffer.from(JSON.stringify({ ...recordOf(s), stackSha256: "f".repeat(64) }));
  const snapshot = createImmutableSnapshot(s.project.projectRoot, s.project.manifest, w.dirs.scratch);
  try {
    const open = () => CDK.openApply({
      scratchDir: fresh("direct"), env: cdkIdentityEnv("DEV"), toolDirs: [toolDir], manifest: s.project.manifest,
      pinned: (loaded(cdkContractJson(KILL)) as PilotContract).targets.DEV, spec: AWS, target: s.sealed.target, engineVersion: AWS_CLI_VERSION,
    });
    const control = { stopWhen: () => false, pollMs: 10, graceMs: 10 };
    await assert.rejects(open().execute(s.loaded.planBytes, control), (error) => codeOf(error) === "ENGINE_NOT_PREPARED");
    const prepared = open();
    prepared.prepare(snapshot.path);
    prepared.rederive(s.loaded.planBytes);
    await assert.rejects(prepared.execute(other, control), (error) => codeOf(error) === "ARTIFACT_TAMPERED");
    assert.ok(!calls().some((call) => call.args[1] === "execute-change-set"));
  } finally { snapshot.remove(); }
});

// --- the template and the capabilities ----------------------------------------------------------------------

test("a transform, a macro, a custom resource or a repeated template key is refused before any change set exists", async () => {
  const w = world();
  const templateFile = STACK + ".template.json";
  const cases: [AssemblyOptions, RegExp][] = [
    [{ templateExtra: { Transform: "AWS::Serverless-2016-10-31" } }, /ASSEMBLY_TRANSFORM/],
    [{ templateExtra: { Transform: { Name: "AWS::Include", Parameters: { Location: "s3://example-bucket/snippet.json" } } } }, /ASSEMBLY_TRANSFORM/],
    [{ resources: { Wrapped: { Type: "AWS::SNS::Topic", Properties: { Tags: { "Fn::Transform": { Name: "AWS::Include" } } } } } }, /ASSEMBLY_TRANSFORM/],
    [{ resources: { Hook: { Type: "Custom::Thing", Properties: { ServiceToken: "arn:aws:lambda:us-east-1:111111111111:function:fake" } } } }, /ASSEMBLY_CUSTOM_RESOURCE/],
    [{ resources: { Hook: { Type: "AWS::CloudFormation::CustomResource", Properties: {} } } }, /ASSEMBLY_CUSTOM_RESOURCE/],
    [{ resources: { Expander: { Type: "AWS::CloudFormation::Macro", Properties: {} } } }, /ASSEMBLY_CUSTOM_RESOURCE/],
    [{ raw: { [templateFile]: '{"Resources":{"A":{"Type":"AWS::SNS::Topic"}},"Resources":{"B":{"Type":"AWS::CloudFormation::Stack"}}}' } }, /TEMPLATE_DUPLICATE_KEY/],
    [{ raw: { [templateFile]: '{"Resources":{"A":{"Type":"AWS::SNS::Topic","Properties":{"x":1,"y":[{"k":1,"k":2}]}}}}' } }, /TEMPLATE_DUPLICATE_KEY/],
  ];
  for (const [options, pattern] of cases) {
    const refusal = await sealRefused(w, "DEV", options);
    assert.match(refusal.message, pattern, JSON.stringify(options).slice(0, 120));
    assert.ok(!calls().some((call) => call.args[1] === "create-change-set"));
  }
  // The same keys in different objects, and strings that look like keys, are not duplicates.
  const fine = '{"Resources":{"A":{"Type":"AWS::SNS::Topic","Properties":{"a":"\\"Resources\\":1","b":[{"a":1},{"a":2}]}},"B":{"Type":"AWS::SNS::Topic"}}}';
  assert.ok((await seal(w, "DEV", { raw: { [templateFile]: fine } })).sealed);
});

test("an IAM capability is passed only for a template with an IAM resource, and only the ones the contract lists; auto-expand is not a capability", async () => {
  const both = world({}, cdkContractJson(KILL, ["CAPABILITY_IAM", "CAPABILITY_NAMED_IAM"]));
  const plain = await seal(both, "DEV");
  assert.ok(!calls().some((call) => call.args.includes("--capabilities")), "the contract lists IAM but the template has no IAM resource");
  assert.deepEqual(recordOf(plain).capabilities, []);
  assert.ok((await run(both, plain)).ok);
  const withRole = world({}, cdkContractJson(KILL, ["CAPABILITY_NAMED_IAM", "CAPABILITY_IAM"]));
  const s = await seal(withRole, "DEV", { iam: true });
  const created = calls().find((call) => call.args[1] === "create-change-set")!;
  assert.deepEqual(created.args.slice(created.args.indexOf("--capabilities"), created.args.indexOf("--capabilities") + 3), ["--capabilities", "CAPABILITY_IAM", "CAPABILITY_NAMED_IAM"]);
  assert.deepEqual(recordOf(s).capabilities, ["CAPABILITY_IAM", "CAPABILITY_NAMED_IAM"]);
  assert.match(reasonOf(editTargets((t) => { t.DEV.capabilities = ["CAPABILITY_AUTO_EXPAND"]; })), /DEV\.capabilities/);
});

// --- the allowlist per adapter and the refusal codes ----------------------------------------------------------------

test("an adapter's session may run only that adapter's lists: the apply cannot create, sealing cannot execute, and qualification may do neither", () => {
  assert.equal(isAllowedCdkArgv("CHANGESET", create(), "preview"), true);
  assert.equal(isAllowedCdkArgv("CHANGESET", create(), "apply"), false);
  assert.equal(isAllowedCdkArgv("DISCOVERY", ["cloudformation", "describe-stacks", "--stack-name", STACK, ...COMMON], "apply"), false);
  assert.equal(isAllowedCdkArgv("DISCOVERY", ["cloudformation", "describe-stack-resources", "--stack-name", STACK, ...COMMON], "apply"), true, "the blueprint's read is on the apply surface");
  assert.equal(isAllowedCdkArgv("APPLY", EXECUTE, "apply"), true);
  assert.equal(isAllowedCdkArgv("APPLY", EXECUTE, "preview"), false);
  assert.equal(isAllowedCdkArgv("CHANGESET", ["cloudformation", "describe-change-set", "--change-set-name", ARN_CS, ...COMMON], "apply"), true);
  const getTemplate = ["cloudformation", "get-template", "--change-set-name", ARN_CS, "--template-stage", "Original", ...COMMON];
  for (const adapter of ["preview", "apply"] as const) assert.equal(isAllowedCdkArgv("CHANGESET", getTemplate, adapter), true);
  assert.equal(isAllowedCdkArgv("APPLY", getTemplate), false);
  assert.equal(isAllowedCdkArgv("CHANGESET", getTemplate.map((a) => a.replace("Original", "Processed"))), false);
});

test("each way a cloud assembly, a change set or the AWS CLI can be unreadable is a code, and nothing is created for an unreadable assembly", async () => {
  const w = world();
  const dependency = (files: Record<string, any>) => { files["manifest.json"].artifacts[STACK].dependencies = ["Missing"]; };
  const assemblyCases: [AssemblyOptions, RegExp][] = [
    [{ raw: { "manifest.json": "not json" } }, /ASSEMBLY_UNREADABLE/],
    [{ environment: "somewhere" }, /ASSEMBLY_ENV_INVALID/],
    [{ mutate: dependency }, /ASSEMBLY_DEPENDENCY/],
    [{ raw: { [STACK + ".template.json"]: "{" } }, /TEMPLATE_UNREADABLE/],
  ];
  for (const [options, pattern] of assemblyCases) {
    assert.match((await sealRefused(w, "DEV", options)).message, pattern, JSON.stringify(options).slice(0, 100));
    assert.ok(!calls().some((call) => call.args[1] === "create-change-set"));
  }
  const cloudCases: [AwsBehavior, RegExp][] = [
    [{ badChange: "unreadable" }, /CHANGE_UNREADABLE/],
    [{ badChange: "action" }, /CHANGE_ACTION_UNKNOWN/],
    [{ describeGarbage: true }, /CHANGE_SET_UNREADABLE/],
    [{ swapChangeSetId: "arn:aws:cloudformation:us-east-1:111111111111:changeSet/alz-ffffffffffff/99999999-9999-9999-9999-999999999999" }, /CHANGE_SET_MISMATCH/],
    [{ version: "garbled" }, /VERSION_UNREADABLE/],
    [{ bigOutput: true }, /OUTPUT_TRUNCATED/],
  ];
  for (const [behavior, pattern] of cloudCases) {
    behave(behavior);
    assert.match((await sealRefused(w, "DEV")).message, pattern, JSON.stringify(behavior).slice(0, 100));
    assert.ok(!calls().some((call) => call.args[1] === "execute-change-set"));
  }
  clean(w);
});

// --- identities at the driver -----------------------------------------------------------------------

test("identity problems stop the seal and the apply: collapse, a Terraform identity beside CDK's, and a role from another account", async () => {
  const w = world();
  const s = await seal(w, "DEV");
  const withEnv = (over: Record<string, string>): ApplyDeps => ({ ...w.deps, env: { ...cdkIdentityEnv("DEV"), ...over } });
  const state = { ALZ_STATE_AWS_ROLE_ARN: cdkRoleArn("STATE", "DEV"), ALZ_STATE_AWS_WEB_IDENTITY_TOKEN_FILE: "/run/fixture/state-token" };
  const stateWrite = { ALZ_STATE_WRITE_AWS_ROLE_ARN: cdkRoleArn("STATE_WRITE", "DEV"), ALZ_STATE_WRITE_AWS_WEB_IDENTITY_TOKEN_FILE: "/run/fixture/sw-token" };
  // Sealing judges the identities after the preview adapter; applying judges them after the qualification of the attested roles, so only a
  // principal the attestation does not name can be changed at an apply.
  const atSeal: [Record<string, string>, string][] = [
    [{ ALZ_CHANGESET_AWS_ROLE_ARN: cdkRoleArn("APPLY", "DEV") }, "IDENTITY_COLLAPSED"],
    [state, "IDENTITY_NOT_CONFIGURED"], [stateWrite, "IDENTITY_NOT_CONFIGURED"],
    [{ ALZ_CHANGESET_AWS_ROLE_ARN: cdkRoleArn("CHANGESET", "QA") }, "IDENTITY_TARGET_MISMATCH"],
    [{ ALZ_APPLY_AWS_ROLE_ARN: cdkRoleArn("APPLY", "PROD") }, "IDENTITY_TARGET_MISMATCH"],
  ];
  for (const [over, code] of atSeal) {
    behave();
    assert.equal((await sealRefused(w, "DEV", {}, withEnv(over))).code, code);
    assert.equal(calls().length, 0, "no aws process ran");
  }
  const atApply: [Record<string, string>, string][] = [
    [{ ALZ_DISCOVERY_AWS_ROLE_ARN: cdkRoleArn("CHANGESET", "DEV") }, "IDENTITY_COLLAPSED"],
    [state, "IDENTITY_NOT_CONFIGURED"], [stateWrite, "IDENTITY_NOT_CONFIGURED"],
    [{ ALZ_DISCOVERY_AWS_ROLE_ARN: cdkRoleArn("DISCOVERY", "QA") }, "IDENTITY_TARGET_MISMATCH"],
  ];
  for (const [over, code] of atApply) {
    behave();
    refused(await run(w, s, approvalsFor(s), {}, withEnv(over)), code);
    assert.equal(calls().length, 0, "no aws process ran");
  }
  // The attested roles are bound at an apply: a CHANGESET or APPLY role other than the qualified ones is not a qualified engine.
  refused(await run(w, s, approvalsFor(s), {}, withEnv({ ALZ_CHANGESET_AWS_ROLE_ARN: cdkRoleArn("APPLY", "DEV") })), "ENGINE_NOT_QUALIFIED");
});

// --- evidence ---------------------------------------------------------------------------------------------

test("no template body, parameter value, output, event text or engine error reaches the evidence, the review bundle or any message", async () => {
  const w = world({}, undefined, { stackExists: true, eventsTouched: true, pollStatuses: ["UPDATE_IN_PROGRESS", "UPDATE_ROLLBACK_COMPLETE"], failStderr: STDERR_CANARY });
  const s = await seal(w, "DEV");
  noCanary(s.sealed);
  noCanary(reviewBundleOf(s.sealed));
  noCanary(JSON.parse(s.loaded.planBytes.toString("utf8")));
  const result = await run(w, s);
  noCanary(result);
  const stored = readdirSync(w.dirs.evidence).map((name) => readFileSync(join(w.dirs.evidence, name), "utf8")).join("\n");
  for (const canary of CDK_CANARIES) assert.ok(!stored.includes(canary));
  const ok = world({}, undefined, { stackExists: true });
  const good = await run(ok, await seal(ok, "DEV"));
  assert.ok(good.ok);
  noCanary(good);
  assert.ok(!existsSync(join(w.dirs.scratch, "work")));
});

// --- qualification ----------------------------------------------------------------------------------------

test("an apply needs both adapters qualified, with the evidence for this account, region, stack, aws binary and roles", async () => {
  const w = world({ qualificationDir: previewOnlyVault });
  const s = await seal(w, "DEV");
  refused(await run(w, s), "ENGINE_NOT_QUALIFIED");
  const onlyApply = world({ qualificationDir: applyOnlyVault });
  const refusal = await sealRefused(onlyApply, "DEV");
  assert.equal(refusal.code, "ENGINE_NOT_QUALIFIED");
  assert.ok(!calls().some((call) => call.args[1] === "create-change-set"));

  const record = async (over: Record<string, unknown>) => {
    const vault = fresh("qualification");
    await forgeCdkQualification(vault, "apply", over);
    const mine = world({ qualificationDir: vault });
    return run(mine, await seal(world({ qualificationDir: vaultDir }), "DEV"), undefined, {}, forEnv(mine, "DEV"));
  };
  refused(await record({ terraformSha256: "0".repeat(64) }), "ENGINE_NOT_QUALIFIED");
  refused(await record({ backend: "OtherStack" }), "ENGINE_NOT_QUALIFIED");
  refused(await record({ region: "eu-west-1" }), "ENGINE_NOT_QUALIFIED");
  refused(await record({ accountId: "222222222222" }), "ENGINE_NOT_QUALIFIED");
  refused(await record({ qualifiedAt: "2026-08-01T00:00:00.000Z" }), "ENGINE_NOT_QUALIFIED");
  refused(await record({ stateWriteClientId: cdkRoleArn("DISCOVERY", "DEV") }), "ENGINE_NOT_QUALIFIED");
  refused(await record({ applyClientId: cdkRoleArn("CHANGESET", "DEV"), stateWriteClientId: cdkRoleArn("APPLY", "DEV") }), "ENGINE_NOT_QUALIFIED");
  // QA and PROD bring their own roles (each names its account), so the DEV roles qualification attested are not compared there.
  const qa = world();
  assert.ok((await run(qa, await seal(qa, "DEV"))).ok);
  assert.ok((await run(qa, await seal(qa, "QA"))).ok);
});

test("qualify runs describe-stacks as each identity and nothing that creates, executes or deletes, and only against DEV", async () => {
  const w = world();
  const target = cdkTargetOf("DEV");
  const p = writeAssembly(fresh("assembly"), target);
  const request = (environment: ApplyEnvironment) => ({
    invocation: human(cdkTargetOf(environment)), environment, target: cdkTargetOf(environment), manifest: p.manifest, projectRoot: p.projectRoot, policyVersion: POLICY, resolved: p.resolved,
  });
  const ran = await qualifyApply(request("DEV"), forEnv(w, "DEV"));
  assert.ok(ran.ok, JSON.stringify(ran));
  if (ran.ok) {
    assert.equal(ran.terraformSha256, FAKE_AWS_SHA256);
    assert.deepEqual(ran.adapters.map((a) => a.argvDigest), [CDK.previewAdapter().argvDigest, CDK.applyAdapter.argvDigest]);
    assert.equal(ran.engineVersion, AWS_CLI_VERSION);
  }
  const all = calls();
  assert.deepEqual([...new Set(subcommandsOf(all))].sort(), ["--version", "describe-stacks"]);
  assert.deepEqual(all.filter((call) => call.args[1] === "describe-stacks").map(roleOf), ["alz-discovery-dev", "alz-changeset-dev", "alz-apply-dev"]);
  assert.ok(all.every((call) => call.args[0] === "--version" || call.args[call.args.indexOf("--stack-name") + 1] === STACK));
  behave();
  const outside = await qualifyApply(request("QA"), forEnv(w, "QA"));
  assert.equal(outside.ok, false);
  assert.equal(calls().length, 0, "nothing ran outside DEV");
  clean(w);
  // Unreadable stacks (a role that cannot describe) fail the qualification.
  behave({ describeStacksFail: true });
  assert.equal((await qualifyApply(request("DEV"), forEnv(w, "DEV"))).ok, false);
});

// --- the CLI --------------------------------------------------------------------------------------------------

test("./alz apply works for the engine the pinned contract names, with no engine flag: qualify, seal, approve and apply, and no project code is run", async () => {
  const w = world();
  const vault = fresh("cli-vault");
  const write = (value: unknown, label: string): string => { const path = join(fresh(label), label + ".json"); writeFileSync(path, JSON.stringify(value)); return path; };
  const asked: string[] = [];
  const cli = async (args: string[], answers: string[], environment: ApplyEnvironment = "DEV") => {
    const out: string[] = [];
    const err: string[] = [];
    const deps: ApplyCliDeps = {
      terminal: { stdinIsTTY: true, stdoutIsTTY: true, write: (t) => { out.push(t); }, ask: async (q) => { asked.push(q); return answers.shift() ?? ""; } },
      env: cdkIdentityEnv(environment), now: () => NOW, operatorId: "operator.fixture", contractPath: w.contractPath, contractPinPath: pinPathOf(w.contractPath),
      qualificationDir: vault, evidenceDir: w.dirs.evidence, nonces: w.deps.nonces, scratchParent: w.dirs.scratch, toolDirs: [toolDir], sourceCommit: SOURCE_COMMIT,
      stdout: (t) => { out.push(t); }, stderr: (t) => { err.push(t); },
    };
    const code = await runApplyCommand(args, deps);
    return { code, out: out.join(""), err: err.join("") };
  };
  const target = cdkTargetOf("DEV");
  const p = writeAssembly(fresh("assembly"), target);
  const request = write({ environment: "DEV", target, projectRoot: p.projectRoot, policyVersion: POLICY, resolved: p.resolved }, "request");
  const manifest = write(p.manifest, "manifest");
  const attest = "SEPARATED " + cdkRoleArn("CHANGESET", "DEV") + " " + cdkRoleArn("APPLY", "DEV");

  // Nothing is qualified yet, so a seal is refused; qualifying asks for the target and the attestation, never for the project code phrase.
  assert.equal((await cli(["seal", "--request", request, "--manifest", manifest], [targetString(target)])).code, 2);
  const qualified = await cli(["qualify", "--request", request, "--manifest", manifest], [targetString(target), attest]);
  assert.equal(qualified.code, 0, qualified.err);
  assert.match(qualified.out, /THIS RUNS NO PROJECT CODE/);
  assert.match(qualified.out, /change set creation was by\s+CHANGESET/);
  assert.doesNotMatch(asked.join("\n"), /code>/);
  assert.deepEqual((await loadQualificationRecords(AWS, vault)).map((r) => r.engine), ["CDK", "CDK"]);
  assert.deepEqual([...new Set(subcommandsOf(calls()))].sort(), ["--version", "describe-stacks"], "qualifying created nothing");

  const sealed = await cli(["seal", "--request", request, "--manifest", manifest], [targetString(target)]);
  assert.equal(sealed.code, 0, sealed.err);
  assert.match(sealed.out, /SEAL A CHANGE SET/);
  const summary = JSON.parse(sealed.out.slice(sealed.out.indexOf("{"))) as { artifactSha256: string; sealedPlanPath: string; reviewBundlePath: string; changes: { address: string; action: string }[] };
  assert.deepEqual(summary.changes.map((c) => c.address + ":" + c.action), ["PilotBucket:CREATE", "PilotTopic:REPLACE"]);
  assert.doesNotMatch(asked.join("\n"), /code>/);

  const keyPath = join(fresh("key"), "alice.pem");
  writeFileSync(keyPath, keys.alice.priv, { mode: 0o600 });
  chmodSync(keyPath, 0o600);
  const approved = await cli(["approve", "--bundle", summary.reviewBundlePath, "--key", keyPath, "--approver", "alice"], ["APPROVE DEV " + summary.artifactSha256.slice(0, 12)]);
  assert.equal(approved.code, 0, approved.err);
  const approvalPath = write(JSON.parse(approved.out.slice(approved.out.indexOf("{"))), "approval");
  const applied = await cli(["apply", "--request", write({ environment: "DEV", target, projectRoot: p.projectRoot }, "apply-request"), "--manifest", manifest, "--sealed", summary.sealedPlanPath, "--approval", approvalPath],
    ["APPLY DEV " + summary.artifactSha256.slice(0, 12) + " " + targetString(target)]);
  assert.equal(applied.code, 0, applied.err);
  assert.match(applied.out, /executes exactly the sealed change set/);
  const evidence = JSON.parse(applied.out.slice(applied.out.indexOf("{", applied.out.indexOf("executes")))) as ApplyEvidence;
  assert.equal(evidence.outcome, "SUCCEEDED");
  noCanary(applied.out);
  assert.equal(calls().filter((call) => call.args[1] === "execute-change-set").length, 1);
});

// --- observe and the cleanup proposal (docs/observe-and-cleanup.md, "CloudFormation") ---------------------------------------

/** The observe step's dependencies for a world: the same contract, ledger and fake `aws`, read as DISCOVERY through the runner. */
const observeDepsOf = (w: World, environment: ApplyEnvironment = "DEV"): ObserveDeps => ({
  contractPath: w.contractPath, contractPinPath: pinPathOf(w.contractPath), evidenceDir: w.dirs.evidence, env: cdkIdentityEnv(environment), toolDirs: [toolDir], scratchParent: w.dirs.scratch, now: () => new Date(NOW.getTime() + 60_000),
});
const BUCKET_ID = "pilotstack-pilotbucket-fake1";
const TOPIC_ARN = "arn:aws:sns:us-east-1:111111111111:PilotStack-PilotTopic-FAKE1";

test("after a CDK apply the blueprint is CloudFormation's own resource list, read once as DISCOVERY: logical ids, physical ids, ARNs derived for the known types, the stack tags' unit, and nothing else; observe reads each resource back through Cloud Control and sweeps by the unit; the proposal lists exactly the run-created resources by logical id, keeps the pilot's role and a nested stack, and says the stack itself is never deleted", async () => {
  // The pilot's own APPLY role appears in the template under its real name, so the proposal must keep it; the SNS physical id is an ARN.
  const w = world({}, cdkContractJson(KILL, ["CAPABILITY_IAM"]), { physicalIds: { PilotRole: "alz-apply-dev" } });
  const s = await seal(w, "DEV", { iam: true });
  const result = await run(w, s);
  assert.ok(result.ok, JSON.stringify(result));
  const applyEvidenceSha256 = sha256(canonicalJson(result.evidence as never));
  const blueprint = await readBlueprintRecord(s.sealed.artifactSha256, applyEvidenceSha256, w.dirs.evidence);
  assert.ok(blueprint, "the apply left a blueprint");
  assert.equal(blueprint.source, "CLOUDFORMATION_STACK_RESOURCES");
  assert.equal(blueprint.unitId, s.sealed.unit!.unitId, "the record carries the unit the stack tags stamped");
  assert.deepEqual(blueprint.blueprint.entries, [
    { address: "PilotBucket", type: "AWS::S3::Bucket", id: BUCKET_ID, arn: "arn:aws:s3:::" + BUCKET_ID, origin: "IN_PLAN" },
    { address: "PilotRole", type: "AWS::IAM::Role", id: "alz-apply-dev", arn: "arn:aws:iam::111111111111:role/alz-apply-dev", origin: "NOT_IN_PLAN" },
    { address: "PilotTopic", type: "AWS::SNS::Topic", id: TOPIC_ARN, arn: TOPIC_ARN, origin: "IN_PLAN" },
  ]);
  assert.deepEqual(blueprint.blueprint.missing, []);
  noCanary(blueprint);
  const read = calls().filter((call) => call.args[1] === "describe-stack-resources");
  assert.equal(read.length, 1);
  assert.equal(roleOf(read[0]), "alz-discovery-dev", "the stack's resources are read as DISCOVERY");

  // Observe: each identifier through Cloud Control under its CloudFormation type, the sweep by the unit; all as DISCOVERY, nothing but existence kept.
  const before = calls().length;
  const observed = await observeRun(s.sealed.artifactSha256, observeDepsOf(w));
  assert.ok(observed.ok, JSON.stringify(observed));
  assert.equal(observed.record.verdict, "VERIFIED");
  assert.equal(observed.record.inventory, "COMPLETE");
  assert.deepEqual(observed.record.resources.map((r) => [r.address, r.result, r.identifier]), [["PilotBucket", "VERIFIED", BUCKET_ID], ["PilotRole", "VERIFIED", "alz-apply-dev"], ["PilotTopic", "VERIFIED", TOPIC_ARN]]);
  const reads = calls().slice(before);
  assert.deepEqual(reads.map((call) => call.args[0] + " " + call.args[1]), ["cloudcontrol get-resource", "cloudcontrol get-resource", "cloudcontrol get-resource", "resourcegroupstaggingapi get-resources"]);
  assert.deepEqual(reads.slice(0, 3).map((call) => call.args[3]), ["AWS::S3::Bucket", "AWS::IAM::Role", "AWS::SNS::Topic"], "read under the CloudFormation type itself");
  assert.ok(reads.every((call) => roleOf(call) === "alz-discovery-dev"));
  assert.ok(reads[3].args.includes("Key=alz-unit,Values=" + s.sealed.unit!.unitId), "the sweep asks for this run's unit");
  noCanary(observed.record);

  // The proposal: run-created resources by logical id; the pilot's role kept as PROTECTED_IDENTITY; the stack never deleted.
  const records = await loadRunRecords(s.sealed.artifactSha256, w.dirs.evidence);
  assert.ok(records.ok, JSON.stringify(records));
  const contract = loadPilotContract(w.contractPath, pinPathOf(w.contractPath)) as PilotContract;
  const built = buildCleanupProposal({ ...records, changes: s.sealed.changes, channel: "CLI", contract, engineVersion: AWS_CLI_VERSION, env: cdkIdentityEnv("DEV"), now: new Date(NOW.getTime() + 120_000) });
  assert.ok(built.ok, JSON.stringify(built));
  assert.ok(verifyCleanupProposal(built.proposal).ok);
  // The change set created the bucket and replaced the topic (the fake's change list), so only the bucket is this run's to delete.
  assert.deepEqual(built.proposal.deletes.map((d) => [d.address, d.type, d.identifier, d.observed]), [["PilotBucket", "AWS::S3::Bucket", BUCKET_ID, "VERIFIED"]]);
  assert.match(built.proposal.deletes[0].risk ?? "", /deletes stored objects/);
  assert.deepEqual(built.proposal.excluded.map((x) => [x.address, x.ownership, x.retainedBy]), [["PilotRole", "PROTECTED_IDENTITY", "PILOT_OWNER"], ["PilotTopic", "REPLACED_PRE_EXISTING", "ENVIRONMENT_OWNER"]]);
  assert.ok(built.proposal.risks.some((r) => /the CloudFormation stack itself is never deleted/.test(r)), JSON.stringify(built.proposal.risks));
  assert.equal(built.proposal.unitId, s.sealed.unit!.unitId);
  assert.equal(built.proposal.engine, "CDK");
  noCanary(built.proposal);
  // Until the CDK cleanup path exists, a cleanup of that proposal is refused before anything runs.
  const cleanup = await runCleanup({ invocation: human(s.sealed.target), environment: "DEV", target: { ...s.sealed.target }, proposal: built.proposal, sealedPlan: s.loaded, manifest: s.project.manifest, projectRoot: s.project.projectRoot, approvals: [] }, forEnv(w, "DEV"));
  assert.equal(cleanup.ok, false);
  assert.equal((cleanup as { code: string }).code, "CLEANUP_NOT_SUPPORTED");
  clean(w);
});

test("CDK observe denied and interrupted: a resource Cloud Control no longer returns fails the observation, a stray ARN under the unit fails it, a failed sweep leaves it inconclusive, a stack resource read that fails leaves no blueprint so nothing can be observed or proposed, and a nested stack that appears in the stack is never proposed", async () => {
  const w = world();
  const s = await seal(w, "DEV");
  assert.ok((await run(w, s)).ok);
  patchAws(toolDir, { absent: [BUCKET_ID] });
  const missing = await observeRun(s.sealed.artifactSha256, observeDepsOf(w));
  assert.ok(missing.ok);
  assert.equal(missing.record.verdict, "FAILED");
  assert.deepEqual(missing.record.resources.map((r) => [r.address, r.result]), [["PilotBucket", "MISSING"], ["PilotTopic", "VERIFIED"]]);
  patchAws(toolDir, { absent: [], stray: ["arn:aws:sqs:us-east-1:111111111111:stray-of-this-unit"] });
  const stray = await observeRun(s.sealed.artifactSha256, observeDepsOf(w));
  assert.ok(stray.ok);
  assert.equal(stray.record.verdict, "FAILED");
  assert.deepEqual(stray.record.unexpected, ["arn:aws:sqs:us-east-1:111111111111:stray-of-this-unit"]);
  patchAws(toolDir, { stray: [], taggingFail: true, failStderr: STDERR_CANARY });
  const unswept = await observeRun(s.sealed.artifactSha256, observeDepsOf(w));
  assert.ok(unswept.ok);
  assert.equal(unswept.record.verdict, "INCONCLUSIVE");
  assert.equal(unswept.record.inventory, "INCOMPLETE");
  noCanary(unswept.record);
  patchAws(toolDir, { taggingFail: false, readFail: { [BUCKET_ID]: "An error occurred (AccessDeniedException) when calling the GetResource operation: " + STDERR_CANARY } });
  const denied = await observeRun(s.sealed.artifactSha256, observeDepsOf(w));
  assert.ok(denied.ok);
  assert.deepEqual(denied.record.resources.find((r) => r.address === "PilotBucket")?.reason, "ACCESS_DENIED");
  noCanary(denied.record);
  // A nested stack that appears in the stack (never through this engine, which refuses one at the seal) is CONTAINS_OTHERS, never proposed.
  patchAws(toolDir, { readFail: {} });
  const w2 = world({}, cdkContractJson(KILL), { resourcesNested: true });
  const s2 = await seal(w2, "DEV");
  assert.ok((await run(w2, s2)).ok);
  const observed2 = await observeRun(s2.sealed.artifactSha256, observeDepsOf(w2));
  assert.ok(observed2.ok);
  assert.equal(observed2.record.resources.find((r) => r.address === "NestedLater")?.result, "UNVERIFIABLE");
  const records2 = await loadRunRecords(s2.sealed.artifactSha256, w2.dirs.evidence);
  assert.ok(records2.ok);
  const contract2 = loadPilotContract(w2.contractPath, pinPathOf(w2.contractPath)) as PilotContract;
  const built2 = buildCleanupProposal({ ...records2, changes: s2.sealed.changes, channel: "CLI", contract: contract2, engineVersion: AWS_CLI_VERSION, env: cdkIdentityEnv("DEV"), now: new Date(NOW.getTime() + 120_000) });
  assert.ok(built2.ok, JSON.stringify(built2));
  assert.deepEqual(built2.proposal.excluded.map((x) => [x.address, x.ownership]), [["NestedLater", "CONTAINS_OTHERS"], ["PilotTopic", "REPLACED_PRE_EXISTING"]]);
  assert.deepEqual(built2.proposal.deletes.map((d) => d.address), ["PilotBucket"]);
  // A stack resource read that fails after the execution: the apply still succeeded, but it left no blueprint, and nothing downstream guesses.
  const w3 = world({}, cdkContractJson(KILL), { resourcesFail: true, failStderr: STDERR_CANARY });
  const s3 = await seal(w3, "DEV");
  const applied3 = await run(w3, s3);
  assert.ok(applied3.ok && applied3.evidence.outcome === "SUCCEEDED", JSON.stringify(applied3));
  noCanary(applied3);
  const none = await observeRun(s3.sealed.artifactSha256, observeDepsOf(w3));
  assert.equal(none.ok, false);
  assert.equal((none as { code: string }).code, "RUN_RECORD_MISSING");
  assert.match((none as { message: string }).message, /left no blueprint/);
  assert.equal((await loadRunRecords(s3.sealed.artifactSha256, w3.dirs.evidence)).ok, false);
});

test("the stack tags are bound: a change set whose tags are not the unit's is refused at the seal, and one whose tags changed after sealing is ARTIFACT_TAMPERED before any approval is consumed", async () => {
  const w = world({}, cdkContractJson(KILL), { swapTags: ["Key=alz-managed-by,Value=alz", "Key=alz-unit,Value=alzu-someone-elses-unit00", "Key=alz-build,Value=alzb-0123456789abcdef0123"] });
  const refusedSeal = await sealRefused(w, "DEV");
  assert.equal(refusedSeal.code, "ARTIFACT_INVALID", JSON.stringify(refusedSeal));
  assert.match(refusedSeal.message, /CHANGE_SET_TAGS_MISMATCH/);
  assert.ok(!calls().some((call) => call.args[1] === "execute-change-set"));
  const w2 = world();
  const s = await seal(w2, "DEV");
  patchAws(toolDir, { swapTags: ["Key=alz-managed-by,Value=alz", "Key=alz-unit,Value=alzu-someone-elses-unit00", "Key=alz-build,Value=alzb-0123456789abcdef0123"] });
  const result = await run(w2, s);
  refused(result, "ARTIFACT_TAMPERED");
  assert.ok(!calls().some((call) => call.args[1] === "execute-change-set"), "nothing executed");
  assert.equal(result.ok || (result as { outcome?: string }).outcome === undefined, true, "no approval consumed: the refusal has no outcome");
});
