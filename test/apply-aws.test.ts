import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { loadPilotContract, pilotContractSha256, targetForEnvironment, verifyApplyQualification, writeQualificationEvidence } from "../src/apply/contract.js";
import { qualifyApply, runApply, sealPreview, type ApplyDeps, type ApplyRequest } from "../src/apply/driver.js";
import { qualificationEvidenceProblems } from "../src/apply/evidence.js";
import { attestedClientId, checkApplyIdentities, verifyIdentityTargets } from "../src/apply/identities.js";
import { providerSpec } from "../src/apply/provider.js";
import { AWS } from "../src/apply/providers/aws.js";
import { openNonceStore } from "../src/apply/nonces.js";
import { loadSealedPlan, reviewBundleOf } from "../src/apply/seal.js";
import { APPLY_ADAPTER, APPLY_INIT_ARGV } from "../src/apply/terraform.js";
import { APPLY_IDENTITIES, type ApplyEnvironment, type PilotContract, type SignedApproval } from "../src/apply/types.js";
import { runApplyCommand, type ApplyCliDeps } from "../src/cli/apply.js";
import { targetString } from "../src/cli/teardown-driver.js";
import { removeTree } from "../src/teardown/driver/cleanup.js";
import { buildChildEnvironment } from "../src/tools/child-env.js";
import { TERRAFORM_APPLY_PROFILE } from "../src/tools/profiles.js";
import { SOURCE_COMMIT,
  AWS_DEV_TARGET, AWS_PROD_TARGET, AWS_QA_TARGET, AWS_REGION, ENGINE_VERSION, NOW, POLICY, awsContractJson, awsIdentityEnv, awsRoleArn, awsTargetOf,
  behave as behaveIn, callsOf, human, installFakeTerraform, keys, pinPathOf, sha, testFixtureForgeQualificationEvidence, writePinnedContract, writeProject,
  approvalFor as approval, type Behavior, type Call, type Project,
} from "./helpers/apply-fixtures.js";

// docs/act-pilot-apply.md, "Providers". The AWS spec mirrors the Azure denial matrix. The engine is a fake executable, so
// these tests pin logic, NOT real-engine behavior or real AWS behavior. Explicit fixtures only: every account id, bucket and role is fake.

const root = mkdtempSync(join(tmpdir(), "alz-aws-"));
const toolDir = mkdtempSync(join(tmpdir(), "alz-aws-tools-"));
process.env.AGENTIC_EVIDENCE_KEY = randomBytes(32).toString("base64");
process.chdir(root); // the vault writes sealed plans under ./.runs
test.after(() => { removeTree(root); removeTree(toolDir); });
installFakeTerraform(toolDir);

let counter = 0;
const fresh = (label: string): string => {
  const dir = join(root, label + "-" + ++counter);
  mkdirSync(dir, { recursive: true });
  return dir;
};
const KILL = join(root, "KILL");
// `show` reports an aws provider block with expressions only, as a project that sets nothing but a region variable would.
const AWS_PROVIDER = { name: "aws", full_name: "registry.terraform.io/hashicorp/aws", expressions: { region: { references: ["var.region"] } } };
const behave = (behavior: Behavior = {}) => behaveIn(toolDir, KILL, { showProviderConfig: { aws: AWS_PROVIDER }, ...behavior });
const calls = (): Call[] => callsOf(toolDir);
const applyCalls = () => calls().filter((c) => c.args[0] === "apply");

// --- the target shape -----------------------------------------------------------------------------

test("the AWS target fields and backend accept the documented shapes and refuse the rest", () => {
  const ok = (check: (v: string) => boolean, good: string[], bad: string[]) => {
    for (const v of good) assert.equal(check(v), true, v);
    for (const v of bad) assert.equal(check(v), false, v);
  };
  ok(AWS.accountFields.accountId, ["111111111111", "000000000000"], ["", "11111111111", "1111111111111", "11111111111a", "111111111111\n", "1111 1111 111"]);
  ok(AWS.accountFields.region, ["us-east-1", "eu-west-2", "ap-southeast-4", "us-gov-west-1"], ["", "US-EAST-1", "us-east", "useast1", "us-east-12", "us_east_1", "us-east-1 "]);
  ok(AWS.backendOk, ["examplefake-dev-state/pilot/dev.tfstate", "a.b-c/k", "abc/env/dev/terraform.tfstate"], [
    "", "examplefake-dev-state", "examplefake-dev-state/", "ab/key", "Upper-bucket/key", "-bucket/key", "bucket-/key", "bu..cket/key", "bucket/../key", "bucket/./key",
    "bucket//key", 'bucket/ke"y', "bucket/ke${y", "bucket/key\nx", "x".repeat(64) + "/key", "bucket/ke y",
  ]);
  ok(AWS.clientIdOk, ["arn:aws:iam::111111111111:role/alz-apply-dev", "arn:aws:iam::111111111111:role/path/to/role+name=x,y.z@w_1"], [
    "", "arn:aws:iam::111111111111:role/Alz-Apply", "arn:aws:iam::1111:role/x", "arn:aws:iam::111111111111:user/x", "arn:aws-cn:iam::111111111111:role/x",
    'arn:aws:iam::111111111111:role/x"y', "arn:aws:iam::111111111111:role/", "arn:aws:iam::111111111111:role/x y",
  ]);
});

// --- the contract ---------------------------------------------------------------------------------

const writeContract = (contract: unknown): string => {
  const path = join(fresh("contract"), "act-pilot-contract.json");
  writePinnedContract(path, contract);
  return path;
};
const loaded = (contract: unknown) => { const path = writeContract(contract); return loadPilotContract(path, pinPathOf(path)); };
const editTargets = (edit: (targets: Record<string, Record<string, unknown>>) => void) => {
  const contract = awsContractJson(KILL) as { targets: Record<string, Record<string, unknown>> };
  edit(contract.targets);
  return contract;
};


test("ACT-DEV-1 accepts only an explicit AWS Terraform DEV pilot without fictitious QA/PROD targets", () => {
  const devOnly = awsContractJson(KILL) as any;
  devOnly.enabledEnvironments = ["DEV"];
  devOnly.targets = { DEV: devOnly.targets.DEV };
  devOnly.requiredApprovals = { DEV: 1 };
  devOnly.approvers = devOnly.approvers.map((item: any) => ({ ...item, environments: ["DEV"] }));
  const contract = loaded(devOnly);
  assert.equal(contract.enabled, true);
  if (!contract.enabled) return;
  assert.deepEqual(contract.enabledEnvironments, ["DEV"]);
  assert.equal(contract.targets.QA, undefined);
  assert.equal(contract.targets.PROD, undefined);
  assert.deepEqual(contract.requiredApprovals, { DEV: 1 });
  assert.equal(targetForEnvironment(contract, "DEV", AWS_DEV_TARGET).ok, true);
  assert.equal(targetForEnvironment(contract, "QA", AWS_DEV_TARGET).ok, false);
  assert.equal(targetForEnvironment(contract, "PROD", AWS_DEV_TARGET).ok, false);
  for (const scope of [["DEV","QA"], ["QA"], ["PROD"], ["DEV","DEV"], [], "DEV"]) {
    const bad = { ...devOnly, enabledEnvironments: scope };
    const result = loaded(bad);
    assert.equal(result.enabled, false, JSON.stringify(scope));
  }
  const surplus = { ...devOnly, targets: { ...devOnly.targets, QA: AWS_DEV_TARGET } };
  assert.equal(loaded(surplus).enabled, false, "disabled stages may not be smuggled into target metadata");
  const missing = { ...devOnly, targets: {} };
  assert.equal(loaded(missing).enabled, false, "DEV target is mandatory");
  const missingDevApprover = { ...devOnly, approvers: devOnly.approvers.map((item: any) => ({ ...item, environments: ["QA"] })) };
  assert.equal(loaded(missingDevApprover).enabled, false, "at least one DEV approver is required");
  for (const combination of [{ provider: "AZURE", engine: "TERRAFORM" }, { provider: "AWS", engine: "CDK" }]) {
    const changed = { ...devOnly, ...combination };
    assert.equal(loaded(changed).enabled, false, "DEV-only authority cannot expand beyond AWS Terraform");
  }
  const approvals = { ...devOnly, requiredApprovals: { DEV: 0 } };
  assert.equal(loaded(approvals).enabled, false, "DEV approval remains required");
});

test("an AWS contract loads; DEV, QA and PROD differ pairwise in account and backend; the Azure shape is not an AWS target", () => {
  const good = loaded(awsContractJson(KILL)) as PilotContract;
  assert.equal(good.enabled, true);
  assert.equal(good.provider, "AWS");
  assert.deepEqual(good.targets.PROD, { accountId: "333333333333", region: AWS_REGION, backend: AWS_PROD_TARGET.backend, workspace: "default" });
  assert.deepEqual(good.requiredApprovals, { DEV: 1, QA: 1, PROD: 2 });
  const reason = (contract: unknown): string => { const l = loaded(contract); assert.equal(l.enabled, false); return (l as { reason: string }).reason; };
  assert.match(reason(editTargets((t) => { t.QA.accountId = t.DEV.accountId; })), /DEV and QA share an account/);
  assert.match(reason(editTargets((t) => { t.PROD.accountId = t.QA.accountId; })), /QA and PROD share an account/);
  assert.match(reason(editTargets((t) => { t.PROD.backend = String(t.DEV.backend).replace("dev.tfstate", "DEV.TFSTATE"); })), /DEV and PROD share a backend/i);
  assert.match(reason(editTargets((t) => { t.DEV.accountId = "12345"; })), /DEV\.accountId/);
  assert.match(reason(editTargets((t) => { t.QA.region = "US-EAST-1"; })), /QA\.region/);
  assert.match(reason(editTargets((t) => { t.PROD.backend = "x/y"; })), /PROD\.backend/);
  assert.match(reason(editTargets((t) => { t.DEV.tenantId = "11111111-1111-4111-8111-111111111111"; })), /tenantId: unknown field/);
  assert.match(reason(editTargets((t) => { delete t.DEV.region; })), /DEV\.region: missing/);
  assert.match(reason({ ...awsContractJson(KILL), requiredApprovals: { DEV: 1, QA: 1, PROD: 1 } }), /requiredApprovals\.PROD/);
  assert.match(reason({ ...awsContractJson(KILL), provider: "AZURE" }), /accountId: unknown field|tenantId: missing/);
});

test("the shipped AWS example is clearly marked, disabled, and cannot become valid by flipping the flag", () => {
  const text = readFileSync(fileURLToPath(new URL("../config/act-pilot-contract.aws.example.json", import.meta.url)), "utf8");
  const parsed = JSON.parse(text) as Record<string, unknown>;
  assert.equal(parsed.enabled, false);
  assert.equal(parsed.provider, "AWS");
  assert.match(text, /EXAMPLE/);
  const flipped = (contract: Record<string, unknown>) => { const l = loaded({ ...contract, enabled: true }); assert.equal(l.enabled, false); return (l as { reason: string }).reason; };
  assert.match(flipped(parsed), /EXAMPLE/);
  const { EXAMPLE: _marker, ...unmarked } = parsed;
  assert.match(flipped(unmarked), /approvers/, "the placeholder approver keys are not keys");
  assert.equal(providerSpec("AWS"), AWS);
});

// --- identities -----------------------------------------------------------------------------------

const env = (environment: ApplyEnvironment = "DEV", over: Record<string, string> = {}): NodeJS.ProcessEnv => ({ ...awsIdentityEnv(environment), ...over });
const refusal = (e: NodeJS.ProcessEnv, code: string, ...mentions: string[]): string => {
  const outcome = checkApplyIdentities(e, AWS, APPLY_IDENTITIES);
  assert.equal(outcome.ok, false, mentions.join());
  if (outcome.ok) return "";
  assert.equal(outcome.code, code, outcome.message);
  for (const name of mentions) assert.ok(outcome.message.includes(name), name + " in " + outcome.message);
  return outcome.message;
};

test("four distinct web-identity roles are accepted; each missing identity is IDENTITY_NOT_CONFIGURED", () => {
  assert.deepEqual(checkApplyIdentities(env(), AWS, APPLY_IDENTITIES), { ok: true });
  for (const identity of APPLY_IDENTITIES) {
    const e = env();
    for (const key of Object.keys(e)) if (key.startsWith("ALZ_" + identity + "_") && !(identity === "STATE" && key.startsWith("ALZ_STATE_WRITE_"))) delete e[key];
    refusal(e, "IDENTITY_NOT_CONFIGURED", identity);
  }
});

test("any two identities sharing a role ARN (across names, case and padding) or a token file (path, symlink, hard link) are IDENTITY_COLLAPSED", () => {
  const pairs = APPLY_IDENTITIES.flatMap((a, i) => APPLY_IDENTITIES.slice(i + 1).map((b) => [a, b] as const));
  const dir = mkdtempSync(join(tmpdir(), "alz-aws-ident-"));
  try {
    const real = join(dir, "token");
    writeFileSync(real, "jwt");
    symlinkSync(real, join(dir, "symlink"));
    linkSync(real, join(dir, "hardlink"));
    for (const [a, b] of pairs) {
      const arn = awsRoleArn("APPLY", "DEV");
      for (const [valueB, label] of [[arn, "same"], [arn.toUpperCase(), "upper case"], ["  " + arn + "\n", "padded"], [arn.replace("alz-apply-dev", "ALZ-Apply-DEV"), "mixed case"]] as const) {
        const message = refusal(env("DEV", { ["ALZ_" + a + "_AWS_ROLE_ARN"]: arn, ["ALZ_" + b + "_AWS_ROLE_ARN"]: valueB }), "IDENTITY_COLLAPSED", "AWS_ROLE_ARN");
        assert.equal(message.includes("111111111111"), false, label + " no value in the message");
      }
      for (const [x, y] of [["/run/t", "/run//t"], ["/run/t", "/run/x/../t "], [real, join(dir, "symlink")], [real, join(dir, "hardlink")]]) {
        refusal(env("DEV", { ["ALZ_" + a + "_AWS_WEB_IDENTITY_TOKEN_FILE"]: x, ["ALZ_" + b + "_AWS_WEB_IDENTITY_TOKEN_FILE"]: y }), "IDENTITY_COLLAPSED", "AWS_WEB_IDENTITY_TOKEN_FILE");
      }
    }
    // The role ARN of one identity in another identity's token variable is not special; only equal principals collapse.
    assert.deepEqual(checkApplyIdentities(env("DEV", { ALZ_APPLY_AWS_WEB_IDENTITY_TOKEN_FILE: join(dir, "other") }), AWS, APPLY_IDENTITIES), { ok: true });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("every ambient or static credential fallback on any identity is refused by name, never by value", () => {
  for (const identity of APPLY_IDENTITIES) {
    for (const [name, value] of [
      ["AWS_ACCESS_KEY_ID", "AKIAFAKEFAKEFAKE0000"], ["AWS_SECRET_ACCESS_KEY", "fake-secret-0001"], ["AWS_SESSION_TOKEN", "fake-session-0001"],
      ["AWS_PROFILE", "operator"], ["AWS_SHARED_CREDENTIALS_FILE", "/home/operator/.aws/credentials"], ["AWS_CONFIG_FILE", "/home/operator/.aws/config"],
      ["AWS_CONTAINER_CREDENTIALS_FULL_URI", "http://127.0.0.1:9/creds"], ["AWS_CONTAINER_AUTHORIZATION_TOKEN", "fake-container-0001"],
      ["AWS_EC2_METADATA_DISABLED", "false"], ["AWS_EC2_METADATA_SERVICE_ENDPOINT", "http://169.254.169.254"],
    ] as const) {
      const message = refusal(env("DEV", { ["ALZ_" + identity + "_" + name]: value }), "IDENTITY_NOT_CONFIGURED", "ALZ_" + identity + "_" + name);
      assert.equal(message.includes(value), false, name);
    }
  }
});

test("an identity value equal to the operator's own ambient AWS_* variable is refused, whatever its case or path spelling", () => {
  const dir = mkdtempSync(join(tmpdir(), "alz-aws-ambient-"));
  try {
    const real = join(dir, "token");
    writeFileSync(real, "jwt");
    symlinkSync(real, join(dir, "symlink"));
    for (const identity of APPLY_IDENTITIES) {
      const arn = awsRoleArn(identity, "DEV");
      const message = refusal(env("DEV", { AWS_ROLE_ARN: arn.toUpperCase() }), "IDENTITY_COLLAPSED", "ALZ_" + identity + "_AWS_ROLE_ARN", "AWS_ROLE_ARN");
      assert.equal(message.includes(arn), false);
      refusal(env("DEV", { AWS_WEB_IDENTITY_TOKEN_FILE: join(dir, "symlink"), ["ALZ_" + identity + "_AWS_WEB_IDENTITY_TOKEN_FILE"]: real }), "IDENTITY_COLLAPSED", "AWS_WEB_IDENTITY_TOKEN_FILE");
    }
    // The operator's own static keys in the ambient environment are not an identity and never reach a child; a region they share is not a clash.
    assert.deepEqual(checkApplyIdentities(env("DEV", { AWS_REGION: AWS_REGION, AWS_ROLE_ARN: "arn:aws:iam::999999999999:role/operator" }), AWS, APPLY_IDENTITIES), { ok: true });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("identity targets: each role ARN's account and the region must be the environment's; APPLY and STATE_WRITE must set both", () => {
  const contract = { targets: { DEV: { ...awsTargetOf("DEV"), accountId: "111111111111", region: AWS_REGION }, QA: { accountId: "222222222222", region: AWS_REGION, backend: AWS_QA_TARGET.backend, workspace: "default" } } } as unknown as PilotContract;
  assert.deepEqual(verifyIdentityTargets(contract, "DEV", env("DEV"), AWS, APPLY_IDENTITIES), { ok: true });
  assert.deepEqual(verifyIdentityTargets(contract, "QA", env("QA"), AWS, APPLY_IDENTITIES), { ok: true });
  assert.equal(verifyIdentityTargets(contract, "QA", env("DEV"), AWS, APPLY_IDENTITIES).ok, false, "DEV credentials do not apply in QA");
  for (const identity of APPLY_IDENTITIES) {
    for (const [name, bad] of [
      ["AWS_ROLE_ARN", awsRoleArn(identity, "QA")], ["AWS_ROLE_ARN", "not-an-arn"], ["AWS_ROLE_ARN", awsRoleArn(identity, "DEV").replace("role/", "user/")], ["AWS_REGION", "eu-west-2"],
    ] as const) {
      const outcome = verifyIdentityTargets(contract, "DEV", env("DEV", { ["ALZ_" + identity + "_" + name]: bad }), AWS, APPLY_IDENTITIES);
      assert.equal(outcome.ok, false, identity + name);
      if (outcome.ok) continue;
      assert.equal(outcome.code, "IDENTITY_TARGET_MISMATCH");
      assert.ok(outcome.message.includes("ALZ_" + identity + "_" + name) && !outcome.message.includes(bad), "names the variable, never the value");
    }
  }
  assert.deepEqual(verifyIdentityTargets(contract, "DEV", env("DEV", { ALZ_APPLY_AWS_REGION: AWS_REGION.toUpperCase() }), AWS, APPLY_IDENTITIES), { ok: true }, "region case does not matter");
  for (const identity of ["APPLY", "STATE_WRITE"] as const) {
    for (const name of ["AWS_ROLE_ARN", "AWS_REGION"]) {
      const e = env(); delete e["ALZ_" + identity + "_" + name];
      assert.equal(verifyIdentityTargets(contract, "DEV", e, AWS, APPLY_IDENTITIES).ok, false, identity + name);
    }
  }
  for (const identity of ["DISCOVERY", "STATE"] as const) {
    const e = env(); delete e["ALZ_" + identity + "_AWS_ROLE_ARN"]; delete e["ALZ_" + identity + "_AWS_REGION"];
    assert.deepEqual(verifyIdentityTargets(contract, "DEV", e, AWS, APPLY_IDENTITIES), { ok: true }, identity);
  }
});

test("an apply child sees only what its identity injects: no static key, profile, config file, metadata fallback, endpoint, CA bundle or default region, and the metadata service is off", () => {
  const e = env("DEV", { ALZ_APPLY_AWS_ACCESS_KEY_ID: "AKIAFAKEFAKEFAKE0000", ALZ_APPLY_AWS_PROFILE: "operator", ALZ_APPLY_AWS_EC2_METADATA_DISABLED: "false", ALZ_APPLY_AWS_CONTAINER_CREDENTIALS_FULL_URI: "http://127.0.0.1/x",
    ALZ_APPLY_AWS_ENDPOINT_URL: "https://abc123.execute-api.us-east-1.amazonaws.com", ALZ_APPLY_AWS_CA_BUNDLE: "/tmp/ca.pem", ALZ_APPLY_AWS_DEFAULT_REGION: "eu-west-2" });
  const child = buildChildEnvironment({ profile: TERRAFORM_APPLY_PROFILE, base: e, toolDirs: ["/usr/bin"], home: "/h", tmp: "/t", identity: "APPLY" });
  assert.equal(child.env.AWS_ROLE_ARN, awsRoleArn("APPLY", "DEV"));
  assert.equal(child.env.AWS_WEB_IDENTITY_TOKEN_FILE, "/run/fixture/apply-dev-token");
  assert.equal(child.env.AWS_REGION, AWS_REGION);
  assert.equal(child.env.AWS_EC2_METADATA_DISABLED, "true", "not overridable by an injected value");
  for (const name of ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_PROFILE", "AWS_CONTAINER_CREDENTIALS_FULL_URI", "AWS_ENDPOINT_URL", "AWS_CA_BUNDLE", "AWS_DEFAULT_REGION"]) assert.equal(child.env[name], undefined, name);
  assert.deepEqual(child.refused, [
    "ALZ_APPLY_AWS_ACCESS_KEY_ID", "ALZ_APPLY_AWS_CA_BUNDLE", "ALZ_APPLY_AWS_CONTAINER_CREDENTIALS_FULL_URI", "ALZ_APPLY_AWS_DEFAULT_REGION",
    "ALZ_APPLY_AWS_EC2_METADATA_DISABLED", "ALZ_APPLY_AWS_ENDPOINT_URL", "ALZ_APPLY_AWS_PROFILE",
  ], "refused, so a step with one does not run: no service endpoint, trust store or second region can be injected");
  assert.equal(Object.values(child.env).some((v) => v.includes("operator-ambient") || v.includes("AKIAFAKEOPERATORKEY00")), false, "the operator's own keys are out of reach");
  assert.equal(Object.keys(child.env).some((k) => k.startsWith("ALZ_") || k.startsWith("ARM_")), false);
});

// --- the full path through the driver -------------------------------------------------------------

type World = { deps: ApplyDeps; dirs: { scratch: string; evidence: string; nonces: string }; contractPath: string };
let vaultDir = "";
test.before(async () => {
  vaultDir = fresh("qualification");
  await testFixtureForgeQualificationEvidence(vaultDir, undefined, "AWS");
});
function world(contract: unknown = awsContractJson(KILL)): World {
  behave({ applyAdvance: true });
  const dirs = { scratch: fresh("scratch"), evidence: fresh("evidence"), nonces: fresh("nonces") };
  const contractPath = join(fresh("contract"), "act-pilot-contract.json");
  writePinnedContract(contractPath, contract);
  return {
    dirs, contractPath,
    deps: {
      sourceCommit: SOURCE_COMMIT,
      contractPath, contractPinPath: pinPathOf(contractPath), qualificationDir: vaultDir, evidenceDir: dirs.evidence, nonces: openNonceStore(dirs.nonces),
      env: awsIdentityEnv("DEV"), now: () => NOW, scratchParent: dirs.scratch, toolDirs: [toolDir], killPollMs: 40, killGraceMs: 400,
    },
  };
}
const forEnv = (w: World, environment: ApplyEnvironment): ApplyDeps => ({ ...w.deps, env: awsIdentityEnv(environment) });
const SHARED_TF = 'resource "aws_s3_bucket" "pilot" {}\n';

async function seal(w: World, environment: ApplyEnvironment, mainTf = SHARED_TF) {
  const target = awsTargetOf(environment);
  const p = writeProject(fresh("project"), target, mainTf);
  const result = await sealPreview({ invocation: human(target), environment, target, manifest: p.manifest, projectRoot: p.projectRoot, policyVersion: POLICY, resolved: p.resolved }, forEnv(w, environment));
  assert.ok(result.ok, JSON.stringify(result));
  const loadedPlan = await loadSealedPlan(result.path);
  assert.ok(loadedPlan.ok);
  return { sealed: result.sealed, project: p, loaded: { sealed: loadedPlan.sealed, planBytes: loadedPlan.planBytes } };
}
type Sealed = Awaited<ReturnType<typeof seal>>;
const approvalsFor = (s: Sealed): SignedApproval[] => (s.sealed.environment === "PROD" ? [approval(s.sealed, "alice"), approval(s.sealed, "bob")] : [approval(s.sealed, "alice")]);
const run = (w: World, s: Sealed, approvals: SignedApproval[], over: Partial<ApplyRequest> = {}, deps: ApplyDeps = forEnv(w, s.sealed.environment)) => runApply({
  invocation: human(s.sealed.target), environment: s.sealed.environment, target: { ...s.sealed.target }, sealedPlan: s.loaded,
  manifest: s.project.manifest, projectRoot: s.project.projectRoot, approvals, ...over,
}, deps);
const refused = (result: { ok: boolean }, code: string) => {
  assert.equal(result.ok, false, JSON.stringify(result));
  assert.equal((result as unknown as { code: string }).code, code, JSON.stringify(result));
};
const sealRefusal = async (w: World, environment: ApplyEnvironment, deps: ApplyDeps = forEnv(w, environment), mainTf = SHARED_TF) => {
  const target = awsTargetOf(environment);
  const p = writeProject(fresh("project"), target, mainTf);
  return sealPreview({ invocation: human(target), environment, target, manifest: p.manifest, projectRoot: p.projectRoot, policyVersion: POLICY, resolved: p.resolved }, deps);
};
/** A refusal before the approvals were consumed leaves nothing spent: no apply ran, and the same approvals work once the cause is fixed. */
async function nothingSpent(w: World, s: Sealed, approvals: SignedApproval[]): Promise<void> {
  assert.equal(applyCalls().length, 0);
  assert.deepEqual(readdirSync(w.dirs.evidence), []);
  assert.deepEqual(readdirSync(w.dirs.scratch), [], "no scratch directory survives");
  behave({ applyAdvance: true });
  assert.ok((await run(w, s, approvals)).ok, "the approvals were not consumed");
}

test("DEV, then QA, then PROD: each stage seals and applies with the right role at each step, the contract's S3 backend, and nothing else in the child", async () => {
  const w = world();
  for (const environment of ["DEV", "QA", "PROD"] as const) {
    const target = awsTargetOf(environment);
    const s = await seal(w, environment);
    const before = calls().length;
    const approvals = approvalsFor(s);
    assert.equal(approvals.length, environment === "PROD" ? 2 : 1);
    const result = await run(w, s, approvals);
    assert.ok(result.ok, environment + " " + JSON.stringify(result));
    assert.equal(result.evidence.outcome, "SUCCEEDED");
    assert.deepEqual(result.evidence.target, target);

    const steps = calls().slice(before);
    assert.deepEqual(steps.map((c) => c.args[0]), ["version", "init", "workspace", "state", "show", "apply", "state"]);
    assert.deepEqual(steps[1].args, [...APPLY_INIT_ARGV]);
    const roleOf = (c: Call) => c.env.AWS_ROLE_ARN;
    assert.equal(roleOf(steps[0]), undefined, "version needs no credentials");
    assert.equal(roleOf(steps[1]), awsRoleArn("STATE_WRITE", environment), "init uses STATE_WRITE");
    assert.equal(roleOf(steps[2]), awsRoleArn("STATE_WRITE", environment));
    assert.equal(roleOf(steps[3]), awsRoleArn("STATE", environment), "state reads use STATE");
    assert.equal(roleOf(steps[4]), undefined, "the change list is derived again from the plan with no identity at all");
    assert.equal(roleOf(steps[5]), awsRoleArn("APPLY", environment), "apply uses APPLY and never a state identity");
    assert.equal(roleOf(steps[6]), awsRoleArn("STATE", environment));
    for (const call of steps) {
      assert.equal(call.env.AWS_EC2_METADATA_DISABLED, "true", call.args[0]);
      assert.ok(!JSON.stringify(call.env).includes("operator-ambient") && !JSON.stringify(call.env).includes("AKIAFAKEOPERATORKEY00"), call.args[0] + " carries an operator key");
      for (const name of ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "AWS_PROFILE", "AWS_SHARED_CREDENTIALS_FILE", "AWS_CONFIG_FILE"]) assert.equal(call.env[name], undefined, call.args[0] + " " + name);
    }
    const applyEnv = JSON.stringify(steps[5].env);
    for (const other of ["alz-state", "alz-discovery"]) assert.ok(!applyEnv.includes(other), "apply env holds " + other);

    // The partial backend configuration: the contract's bucket, key and region, native locking, and STATE_WRITE's non-secret web-identity settings only.
    const [bucket, ...key] = target.backend.split("/");
    assert.equal(steps[1].backendConfig, [
      `bucket = "${bucket}"`, `key = "${key.join("/")}"`, `region = "${AWS_REGION}"`, "use_lockfile = true", "assume_role_with_web_identity = {",
      `  role_arn = "${awsRoleArn("STATE_WRITE", environment)}"`, `  web_identity_token_file = "/run/fixture/state_write-${environment.toLowerCase()}-token"`, "}", "",
    ].join("\n"));
    assert.ok(!existsSync(join(steps[5].cwd, "..", "alz-backend.tfbackend")), "the backend configuration is gone");
    assert.ok(!steps[1].backendConfig?.includes("dynamodb"), "native locking: no DynamoDB table");
    assert.deepEqual(readdirSync(w.dirs.scratch), [], "no scratch directory survives");
  }
});

test("PROD without a successful QA apply of the same release is PROMOTION_EVIDENCE_MISSING, and QA without DEV likewise", async () => {
  const w = world();
  const qa = await seal(w, "QA");
  refused(await run(w, qa, approvalsFor(qa)), "PROMOTION_EVIDENCE_MISSING");
  assert.equal(applyCalls().length, 0);
});

test("a role in another account than the environment's is IDENTITY_TARGET_MISMATCH before anything runs; a collapsed or fallback identity is refused at seal", async () => {
  const w = world();
  const s = await seal(w, "DEV");
  const approvals = approvalsFor(s);
  // Sealing judges all four. At apply the attested STATE_WRITE and APPLY roles are qualification-bound first, so a swapped one is not qualified.
  for (const [name, value] of [
    ["ALZ_APPLY_AWS_ROLE_ARN", awsRoleArn("APPLY", "QA")], ["ALZ_STATE_WRITE_AWS_ROLE_ARN", awsRoleArn("STATE_WRITE", "PROD")], ["ALZ_STATE_AWS_ROLE_ARN", awsRoleArn("STATE", "QA")],
    ["ALZ_DISCOVERY_AWS_ROLE_ARN", awsRoleArn("DISCOVERY", "PROD")], ["ALZ_APPLY_AWS_REGION", "eu-west-2"],
  ] as const) {
    refused(await sealRefusal(w, "DEV", { ...w.deps, env: env("DEV", { [name]: value }) }), "IDENTITY_TARGET_MISMATCH");
  }
  for (const [name, value, code] of [
    ["ALZ_STATE_AWS_ROLE_ARN", awsRoleArn("STATE", "QA"), "IDENTITY_TARGET_MISMATCH"], ["ALZ_DISCOVERY_AWS_ROLE_ARN", awsRoleArn("DISCOVERY", "PROD"), "IDENTITY_TARGET_MISMATCH"],
    ["ALZ_APPLY_AWS_ROLE_ARN", awsRoleArn("APPLY", "QA"), "ENGINE_NOT_QUALIFIED"], ["ALZ_STATE_WRITE_AWS_ROLE_ARN", awsRoleArn("STATE_WRITE", "PROD"), "ENGINE_NOT_QUALIFIED"],
  ] as const) {
    refused(await run(w, s, approvals, {}, { ...w.deps, env: env("DEV", { [name]: value }) }), code);
  }
  assert.equal(applyCalls().length, 0);
  const sealed = await sealRefusal(w, "DEV", { ...w.deps, env: env("DEV", { ALZ_APPLY_AWS_ROLE_ARN: awsRoleArn("STATE", "DEV") }) });
  refused(sealed, "IDENTITY_COLLAPSED");
  refused(await sealRefusal(w, "DEV", { ...w.deps, env: env("DEV", { ALZ_DISCOVERY_AWS_ACCESS_KEY_ID: "AKIAFAKEFAKEFAKE0000" }) }), "IDENTITY_NOT_CONFIGURED");
  refused(await sealRefusal(w, "DEV", { ...w.deps, env: env("DEV", { AWS_ROLE_ARN: awsRoleArn("APPLY", "DEV") }) }), "IDENTITY_COLLAPSED");
});

test("the backend init saved must be the contract's bucket, key and region with native locking; anything else is refused at seal (the plan embeds it) and before the approvals are consumed at apply", async () => {
  const [bucket, ...key] = AWS_DEV_TARGET.backend.split("/");
  const saved = (config: Record<string, unknown>, type = "s3") => ({ type, config: { bucket, key: key.join("/"), region: AWS_REGION, use_lockfile: true, ...config } });
  const cases: Array<[string, unknown]> = [
    ["another bucket", saved({ bucket: "attacker-bucket" })],
    ["another key", saved({ key: "prod/prod.tfstate" })],
    ["another region", saved({ region: "eu-west-2" })],
    ["the production backend", saved({ bucket: "examplefake-prod-state", key: "pilot/prod.tfstate" })],
    ["locking off", saved({ use_lockfile: false })],
    ["no locking setting", { type: "s3", config: { bucket, key: key.join("/"), region: AWS_REGION } }],
    ["a different backend type", saved({}, "azurerm")],
    ["a non-string field", saved({ key: 7 })],
    ["no config", { type: "s3" }],
  ];
  for (const [label, savedBackend] of cases) {
    const w = world();
    const s = await seal(w, "DEV");
    const approvals = approvalsFor(s);
    behave({ savedBackend });
    const result = await run(w, s, approvals);
    refused(result, "TARGET_NOT_IN_CONTRACT");
    assert.match((result as { message: string }).message, /BACKEND_NOT_IN_CONTRACT/, label);
    assert.match((result as { message: string }).message, /no approval was consumed/);
    await nothingSpent(w, s, approvals);

    behave({ savedBackend });
    const atSeal = await sealRefusal(w, "DEV");
    refused(atSeal, "ARTIFACT_INVALID");
    assert.match((atSeal as { message: string }).message, /BACKEND_NOT_IN_CONTRACT/, label);
  }
  const w = world();
  const s = await seal(w, "DEV");
  behave({ savedBackend: null });
  refused(await run(w, s, approvalsFor(s)), "APPLY_FAILED");
});

test("PROD is bound to the PROD backend: the DEV backend is refused there", async () => {
  const w = world();
  const dev = await seal(w, "DEV");
  assert.ok((await run(w, dev, approvalsFor(dev))).ok);
  const qa = await seal(w, "QA");
  assert.ok((await run(w, qa, approvalsFor(qa))).ok);
  const prod = await seal(w, "PROD");
  const [bucket, ...key] = AWS_DEV_TARGET.backend.split("/");
  behave({ savedBackend: { type: "s3", config: { bucket, key: key.join("/"), region: AWS_REGION, use_lockfile: true } } });
  const before = applyCalls().length;
  refused(await run(w, prod, approvalsFor(prod)), "TARGET_NOT_IN_CONTRACT");
  assert.equal(applyCalls().length, before);
  behave({ applyAdvance: true });
  assert.ok((await run(w, prod, approvalsFor(prod))).ok, "the PROD backend passes");
});

test("qualify refuses a backend that is not the contract's DEV backend", async () => {
  const w = world();
  const p = writeProject(fresh("project"), AWS_DEV_TARGET, SHARED_TF);
  behave({ savedBackend: { type: "s3", config: { bucket: "attacker-bucket", key: "pilot/dev.tfstate", region: AWS_REGION, use_lockfile: true } } });
  const result = await qualifyApply({ invocation: human(AWS_DEV_TARGET), environment: "DEV", target: AWS_DEV_TARGET, manifest: p.manifest, projectRoot: p.projectRoot, policyVersion: POLICY, resolved: p.resolved }, w.deps);
  assert.ok(!result.ok && /BACKEND_NOT_IN_CONTRACT/.test(result.message), JSON.stringify(result));
});

test("a provider block that names another account, role, credential, file, destination or provider refuses at seal and at apply; an expression for an account or role is not judged", async () => {
  const other = "999999999999";
  const provider = (expressions: Record<string, unknown>) => ({ aws: { name: "aws", full_name: "registry.terraform.io/hashicorp/aws", expressions } });
  const otherRole = "arn:aws:iam::" + other + ":role/elsewhere";
  const mine = AWS_DEV_TARGET.account;
  const CONFIG = "PROVIDER_CONFIG_NOT_IN_CONTRACT";
  const refusing: Array<[string, Record<string, unknown>, string?]> = [
    ["allowed_account_ids without the account", provider({ allowed_account_ids: { constant_value: [other] } })],
    ["allowed_account_ids with another account first and not ours", provider({ allowed_account_ids: { constant_value: [other, "888888888888"] } })],
    ["forbidden_account_ids naming the account", provider({ forbidden_account_ids: { constant_value: [other, mine] } })],
    ["assume_role in another account", provider({ assume_role: [{ role_arn: { constant_value: otherRole } }] })],
    ["assume_role as one object", provider({ assume_role: { role_arn: { constant_value: otherRole } } })],
    ["assume_role_with_web_identity in another account", provider({ assume_role_with_web_identity: [{ role_arn: { constant_value: otherRole } }] })],
    ["a role ARN that is not a role ARN", provider({ assume_role: [{ role_arn: { constant_value: "not-an-arn" } }] })],
    ["a second, aliased block", { ...provider({ allowed_account_ids: { constant_value: [mine] } }), "aws.other": { name: "aws", alias: "other", expressions: { allowed_account_ids: { constant_value: [other] } } } }],
    ["a full name only", { "x": { full_name: "registry.terraform.io/hashicorp/aws", expressions: { allowed_account_ids: { constant_value: [other] } } } }],
    // Credentials, files and destinations the APPLY identity does not own: refused whether constant or an expression.
    ...Object.entries({
      access_key: { constant_value: "AKIAFAKEFAKEFAKE0000" }, secret_key: { constant_value: "fake-secret-0001" }, token: { references: ["var.token"] },
      profile: { constant_value: "operator" }, shared_credentials_files: { constant_value: ["/home/operator/.aws/credentials"] },
      shared_config_files: { constant_value: ["/home/operator/.aws/config"] }, endpoints: [{ sts: { constant_value: "https://attacker.example" } }],
      http_proxy: { constant_value: "http://attacker.example" }, custom_ca_bundle: { constant_value: "/tmp/ca.pem" },
      skip_metadata_api_check: { constant_value: "false" }, skip_requesting_account_id: { constant_value: true }, skip_credentials_validation: { constant_value: true },
      ec2_metadata_service_endpoint: { constant_value: "http://127.0.0.1:1" },
    }).map(([name, expression]): [string, Record<string, unknown>, string] => [name + " in the provider block", provider({ [name]: expression }), CONFIG]),
    ["a role in the account that is not the APPLY role", provider({ assume_role: [{ role_arn: { constant_value: awsRoleArn("STATE_WRITE", "DEV") } }] }), CONFIG],
    ["a web identity token file of another identity", provider({ assume_role_with_web_identity: [{ role_arn: { constant_value: awsRoleArn("APPLY", "DEV") }, web_identity_token_file: { constant_value: "/run/fixture/state_write-dev-token" } }] }), CONFIG],
    ["a web identity token", provider({ assume_role_with_web_identity: [{ web_identity_token: { references: ["var.t"] } }] }), CONFIG],
    ["a provider that is not on the allowlist", { azurerm: { name: "azurerm", full_name: "registry.terraform.io/hashicorp/azurerm", expressions: {} } }, CONFIG],
    ["an allowlisted name from another namespace", { aws: { name: "aws", full_name: "registry.terraform.io/attacker/aws", expressions: {} } }, CONFIG],
  ];
  const fine: Array<[string, Record<string, unknown>]> = [
    ["the APPLY role under another path (role names are unique per account)", provider({ assume_role: [{ role_arn: { constant_value: awsRoleArn("APPLY", "DEV").replace("role/", "role/ci/") } }] })],
    ["matching constants", provider({ allowed_account_ids: { constant_value: [mine, other] }, forbidden_account_ids: { constant_value: [other] }, assume_role: [{ role_arn: { constant_value: awsRoleArn("APPLY", "DEV") } }], region: { constant_value: "eu-west-2" } })],
    ["expressions only", provider({ allowed_account_ids: { references: ["var.accounts"] }, assume_role: [{ role_arn: { references: ["var.role"] } }] })],
    ["explicit nulls and an empty list", provider({ allowed_account_ids: { constant_value: [] }, forbidden_account_ids: { constant_value: null } })],
    ["explicit nulls for the denied attributes", provider({ profile: { constant_value: null }, access_key: { constant_value: null }, endpoints: { constant_value: null } })],
    ["another provider's constants", { random: { name: "random", full_name: "registry.terraform.io/hashicorp/random", expressions: { allowed_account_ids: { constant_value: [other] } } } }],
  ];
  for (const [label, showProviderConfig, code = "PROVIDER_ACCOUNT_NOT_IN_CONTRACT"] of refusing) {
    const w = world();
    behave({ showProviderConfig });
    const atSeal = await sealRefusal(w, "DEV");
    refused(atSeal, "ARTIFACT_INVALID");
    assert.match((atSeal as { message: string }).message, new RegExp(code), label);
    assert.ok(!JSON.stringify(atSeal).includes(other) && !/AKIAFAKE|fake-secret|attacker/.test(JSON.stringify(atSeal)), "the refusal names a code, not the value");
    // Applying: the plan is shown again, and what it shows is judged again.
    behave({});
    const s = await seal(w, "DEV");
    const approvals = approvalsFor(s);
    behave({ showProviderConfig });
    const result = await run(w, s, approvals);
    refused(result, "TARGET_NOT_IN_CONTRACT");
    assert.match((result as { message: string }).message, new RegExp(code), label);
    await nothingSpent(w, s, approvals);
  }
  for (const [label, showProviderConfig] of fine) {
    const w = world();
    behave({ showProviderConfig, applyAdvance: true });
    const s = await seal(w, "DEV");
    assert.ok((await run(w, s, approvalsFor(s))).ok, label);
  }
});

test("the project's backend block is judged before init: any attribute beyond bucket, key, region and use_lockfile is refused and no init runs", async () => {
  const [bucket, ...key] = AWS_DEV_TARGET.backend.split("/");
  const backend = (body: string) => `terraform {\n  backend "s3" {\n    bucket = "${bucket}"\n    key = "${key.join("/")}"\n    region = "${AWS_REGION}"\n    use_lockfile = true\n${body}\n  }\n}\n` + SHARED_TF;
  const w = world();
  assert.ok((await sealRefusal(w, "DEV", undefined, backend(""))).ok, "exactly the contract's settings are fine");
  for (const body of [
    '    endpoints = {\n      sts = "https://attacker.example"\n      s3 = "https://attacker.example"\n    }', '    access_key = "AKIAFAKEFAKEFAKE0000"\n    secret_key = "fake"',
    '    profile = "operator"', '    shared_credentials_files = ["/home/operator/.aws/credentials"]', '    skip_credentials_validation = true',
  ]) {
    behave();
    const result = await sealRefusal(w, "DEV", undefined, backend(body));
    refused(result, "ARTIFACT_INVALID");
    assert.match((result as { message: string }).message, /BACKEND_BLOCK_NOT_IN_CONTRACT/);
    assert.deepEqual(calls().map((c) => c.args[0]), ["version"], "init never ran, so no credential was sent anywhere");
  }
});

test("the identity checks also refuse the other cloud's credentials, a role spelled with a path, and a token file that is not an absolute path", () => {
  for (const identity of APPLY_IDENTITIES) {
    for (const name of ["ARM_CLIENT_SECRET", "ARM_USE_OIDC", "ARM_OIDC_TOKEN_FILE", "AZURE_CLIENT_SECRET"]) {
      refusal(env("DEV", { ["ALZ_" + identity + "_" + name]: "fake-0001" }), "IDENTITY_NOT_CONFIGURED", "ALZ_" + identity + "_" + name);
    }
    refusal(env("DEV", { ["ALZ_" + identity + "_AWS_WEB_IDENTITY_TOKEN_FILE"]: "run/relative-token" }), "IDENTITY_NOT_CONFIGURED", "ALZ_" + identity + "_AWS_WEB_IDENTITY_TOKEN_FILE");
  }
  // IAM role names are unique per account whatever the path, so one name under two paths is one role.
  refusal(env("DEV", { ALZ_APPLY_AWS_ROLE_ARN: awsRoleArn("STATE_WRITE", "DEV").replace("role/", "role/ci/team/") }), "IDENTITY_COLLAPSED", "AWS_ROLE_ARN");
  assert.deepEqual(checkApplyIdentities(env("DEV", { ALZ_APPLY_AWS_ROLE_ARN: awsRoleArn("APPLY", "DEV").replace("role/", "role/ci/") }), AWS, APPLY_IDENTITIES), { ok: true }, "a path alone is not a collision with another name");
});

test("a sealed plan applies only under the pinned contract it was sealed under; the evidence names that contract", async () => {
  const w = world();
  const s = await seal(w, "DEV");
  const pinned = loadPilotContract(w.contractPath, pinPathOf(w.contractPath)) as PilotContract;
  assert.equal(s.sealed.contractSha256, pilotContractSha256(pinned));
  assert.equal(reviewBundleOf(s.sealed).contractSha256, s.sealed.contractSha256, "the approvers' bundle carries it");
  // Re-pinned with the same account and backend but another region: every other gate would pass against the new contract.
  const other = awsContractJson(KILL) as { targets: Record<string, Record<string, unknown>> };
  other.targets.DEV.region = "eu-west-2";
  writePinnedContract(w.contractPath, other);
  const approvals = approvalsFor(s);
  refused(await run(w, s, approvals, {}, { ...forEnv(w, "DEV"), env: env("DEV", { ALZ_APPLY_AWS_REGION: "eu-west-2", ALZ_STATE_WRITE_AWS_REGION: "eu-west-2" }) }), "ARTIFACT_INVALID");
  assert.equal(applyCalls().length, 0);
  writePinnedContract(w.contractPath, awsContractJson(KILL));
  const result = await run(w, s, approvals);
  assert.ok(result.ok, JSON.stringify(result));
  assert.equal(result.evidence.contractSha256, s.sealed.contractSha256);
});

// --- qualification evidence -----------------------------------------------------------------------

const qualification = (over: Record<string, unknown> = {}) => ({
  schemaVersion: 1 as const, engine: "TERRAFORM" as const, realEngine: true as const, backendIdentitySeparated: true as const,
  accountId: AWS_DEV_TARGET.account, region: AWS_REGION, backend: AWS_DEV_TARGET.backend, workspace: "default",
  stateWriteClientId: awsRoleArn("STATE_WRITE", "DEV"), applyClientId: awsRoleArn("APPLY", "DEV"), terraformSha256: sha("terraform-binary"),
  adapterVersion: "adapter-1", argvDigest: sha("argv"), engineVersion: ENGINE_VERSION, qualifiedAt: "2026-10-10T12:00:00.000Z", ...over,
});

test("qualification evidence binds the DEV account, region, backend, workspace, normalized role ARNs and the terraform binary", async () => {
  const dir = fresh("evidence-vault");
  const dev = awsContractJson(KILL).targets.DEV as unknown as PilotContract["targets"]["DEV"];
  const expected = { adapterVersion: "adapter-1", argvDigest: sha("argv"), engineVersion: ENGINE_VERSION };
  const verify = async (over: Record<string, unknown>, bound: Partial<Parameters<typeof verifyApplyQualification>[4]> = {}) => {
    const written = await writeQualificationEvidence(qualification(over) as never, AWS, dir);
    assert.ok(written.ok, JSON.stringify(written));
    const record = { engine: "TERRAFORM" as const, ...expected, qualifiedAt: "2026-10-10T12:00:00.000Z", evidenceHash: written.evidenceHash };
    return verifyApplyQualification(record, dir, expected, {
      dev, now: NOW, terraformSha256: sha("terraform-binary"), stateWriteClientId: attestedClientId(env(), "STATE_WRITE", AWS), applyClientId: attestedClientId(env(), "APPLY", AWS), ...bound,
    }, AWS);
  };
  assert.deepEqual(await verify({}), { ok: true });
  assert.equal(attestedClientId(env("DEV", { ALZ_APPLY_AWS_ROLE_ARN: "  " + awsRoleArn("APPLY", "DEV").toUpperCase() + "\n" }), "APPLY", AWS), awsRoleArn("APPLY", "DEV"), "normalized: trimmed, lowercase");
  for (const [label, over] of [
    ["another account", { accountId: AWS_QA_TARGET.account }], ["another region", { region: "eu-west-2" }], ["another backend", { backend: AWS_QA_TARGET.backend }],
    ["another workspace", { workspace: "other" }], ["another binary", { terraformSha256: sha("another-binary") }],
    ["another STATE_WRITE role", { stateWriteClientId: awsRoleArn("STATE", "DEV") }], ["another APPLY role", { applyClientId: awsRoleArn("DISCOVERY", "DEV") }],
  ] as const) {
    const outcome = await verify(over);
    assert.equal(outcome.ok === false && outcome.code, "ENGINE_NOT_QUALIFIED", label);
  }
  assert.equal((await verify({}, { applyClientId: "" })).ok, false);
  assert.equal((await verify({ qualifiedAt: "2026-08-01T00:00:00.000Z" })).ok, false, "the 30 day freshness rule is unchanged");
  // Evidence is closed and typed: the Azure shape, an upper-case or non-ARN principal, or both principals equal are not AWS qualification evidence.
  for (const bad of [
    { accountId: undefined, tenantId: "11111111-1111-4111-8111-111111111111", subscriptionId: "22222222-2222-4222-8222-222222222222" },
    { accountId: "12345" }, { region: "US-EAST-1" }, { applyClientId: awsRoleArn("APPLY", "DEV").toUpperCase() }, { applyClientId: "apply-client-4" },
    { applyClientId: awsRoleArn("STATE_WRITE", "DEV") }, { extra: 1 },
  ]) assert.ok(qualificationEvidenceProblems(qualification(bad), AWS).length > 0, JSON.stringify(bad));
  assert.deepEqual(qualificationEvidenceProblems(qualification(), AWS), []);
});

// --- the CLI: the pinned contract names the provider ----------------------------------------------

type Terminal = NonNullable<ApplyCliDeps["terminal"]> & { out: string[] };
const terminal = (answers: string[]): Terminal => {
  const out: string[] = [];
  return { stdinIsTTY: true, stdoutIsTTY: true, out, write: (text: string) => { out.push(text); }, ask: async () => answers.shift() ?? "" };
};
const json = (value: unknown): string => { const path = join(fresh("file"), "file.json"); writeFileSync(path, JSON.stringify(value)); return path; };

test("./alz apply qualify, seal, approve and apply work for an AWS contract with no provider flag, and the attestation names the role ARNs", async () => {
  behave({ applyAdvance: true });
  const contractPath = join(fresh("contract"), "act-pilot-contract.json");
  writePinnedContract(contractPath, awsContractJson(KILL));
  const vault = fresh("cli-vault");
  const evidenceDir = fresh("cli-evidence");
  const nonces = openNonceStore(fresh("cli-nonces"));
  const scratch = fresh("cli-scratch");
  const cli = async (args: string[], answers: string[], environment: ApplyEnvironment = "DEV") => {
    const out: string[] = []; const err: string[] = [];
    const term = terminal(answers);
    const code = await runApplyCommand(args, {
      terminal: term, env: awsIdentityEnv(environment), now: () => NOW, operatorId: "operator.fixture", contractPath, contractPinPath: pinPathOf(contractPath),
      qualificationDir: vault, evidenceDir, nonces, scratchParent: scratch, toolDirs: [toolDir], sourceCommit: SOURCE_COMMIT, stdout: (t: string) => { out.push(t); }, stderr: (t: string) => { err.push(t); },
    });
    return { code, stdout: out.join(""), stderr: err.join(""), shown: term.out.join("") };
  };
  const requestFor = (p: Project, environment: ApplyEnvironment) => json({ environment, target: awsTargetOf(environment), projectRoot: p.projectRoot, policyVersion: POLICY, resolved: p.resolved });
  const dev = writeProject(fresh("project"), AWS_DEV_TARGET, SHARED_TF);
  const devArgs = (sub: string) => [sub, "--request", requestFor(dev, "DEV"), "--manifest", json(dev.manifest)];
  const typed = [targetString(AWS_DEV_TARGET), "RUN PROJECT CODE"];

  // Qualify: the person attests from the CloudTrail logs, typing the two role ARNs.
  const attest = "SEPARATED " + awsRoleArn("STATE_WRITE", "DEV") + " " + awsRoleArn("APPLY", "DEV");
  const wrong = await cli(devArgs("qualify"), [...typed, "SEPARATED statewrite-client-3 apply-client-4"]);
  assert.equal(wrong.code, 1);
  assert.match(wrong.stderr, /QUALIFICATION_ATTESTATION_MISMATCH/);
  const qualified = await cli(devArgs("qualify"), [...typed, attest]);
  assert.equal(qualified.code, 0, qualified.stderr);
  assert.match(qualified.shown, /CloudTrail/);
  assert.ok(qualified.shown.includes(awsRoleArn("STATE_WRITE", "DEV")) && qualified.shown.includes(awsRoleArn("APPLY", "DEV")));
  assert.ok(calls().some((c) => c.args.join(" ") === APPLY_INIT_ARGV.join(" ")), "the apply adapter's init ran");
  const printed = JSON.parse(qualified.stdout) as { qualified: { adapterVersion: string }[] };
  assert.ok(printed.qualified.some((q) => q.adapterVersion === APPLY_ADAPTER.adapterVersion));

  // The unlocked path, DEV to PROD, by the CLI alone.
  for (const environment of ["DEV", "QA", "PROD"] as const) {
    const target = awsTargetOf(environment);
    const p = writeProject(fresh("project"), target, SHARED_TF);
    const sealed = await cli(["seal", "--request", requestFor(p, environment), "--manifest", json(p.manifest)], [targetString(target), "RUN PROJECT CODE"], environment);
    assert.equal(sealed.code, 0, sealed.stderr);
    const result = JSON.parse(sealed.stdout) as { artifactSha256: string; sealedPlanPath: string; reviewBundlePath: string };
    const signers = environment === "PROD" ? ["alice", "bob"] as const : ["alice"] as const;
    const approvalFiles: string[] = [];
    for (const who of signers) {
      const key = join(fresh("key"), who + ".pem");
      writeFileSync(key, keys[who].priv, { mode: 0o600 });
      chmodSync(key, 0o600);
      const approved = await cli(["approve", "--bundle", result.reviewBundlePath, "--key", key, "--approver", who], ["APPROVE " + environment + " " + result.artifactSha256.slice(0, 12)], environment);
      assert.equal(approved.code, 0, approved.stderr);
      approvalFiles.push(json(JSON.parse(approved.stdout)));
    }
    const applied = await cli([
      "apply", "--request", json({ environment, target, projectRoot: p.projectRoot }), "--manifest", json(p.manifest), "--sealed", result.sealedPlanPath,
      ...approvalFiles.flatMap((file) => ["--approval", file]),
    ], ["APPLY " + environment + " " + result.artifactSha256.slice(0, 12) + " " + targetString(target)], environment);
    assert.equal(applied.code, 0, environment + " " + applied.stderr);
  }
  assert.equal(applyCalls().length, 3);
});
