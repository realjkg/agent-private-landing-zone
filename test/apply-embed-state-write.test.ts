import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { loadPilotContract, pilotContractSha256 } from "../src/apply/contract.js";
import { runApply, sealPreview, type ApplyDeps } from "../src/apply/driver.js";
import { openNonceStore } from "../src/apply/nonces.js";
import { loadSealedPlan } from "../src/apply/seal.js";
import { APPLY_BACKEND_CONFIG_FILE, APPLY_INIT_ARGV } from "../src/apply/terraform.js";
import type { ApplyEnvironment, PilotContract } from "../src/apply/types.js";
import { runApplyCommand, type ApplyCliDeps } from "../src/cli/apply.js";
import { targetString } from "../src/cli/teardown-driver.js";
import { removeTree } from "../src/teardown/driver/cleanup.js";
import { SOURCE_COMMIT,
  AWS_REGION, DEV_TARGET, NOW, POLICY, awsContractJson, awsIdentityEnv, awsRoleArn, awsTargetOf, approvalFor as approval, behave as behaveIn, callsOf, contractJson,
  human, identityEnv, installFakeTerraform, testFixtureForgeQualificationEvidence, writeReviewedContract, writeProject, type Behavior, type Call,
  REQUESTER,
  requesterArgs,
} from "./helpers/apply-fixtures.js";
import { cdkContractJson } from "./helpers/cdk-fixtures.js";

// The opt-in `embedStateWrite` contract field (docs/act-pilot-apply.md, "Embedding STATE_WRITE in the plan"). The engine is a fake
// executable: these tests pin this program's logic, NOT what a real Terraform or backend does with the embedded settings (unverified).

const root = mkdtempSync(join(tmpdir(), "alz-embed-"));
const toolDir = mkdtempSync(join(tmpdir(), "alz-embed-tools-"));
process.env.AGENTIC_EVIDENCE_KEY = randomBytes(32).toString("base64");
process.chdir(root);
test.after(() => { removeTree(root); removeTree(toolDir); });
installFakeTerraform(toolDir);

let counter = 0;
const fresh = (label: string): string => {
  const dir = join(root, label + "-" + ++counter);
  mkdirSync(dir, { recursive: true });
  return dir;
};
const KILL = join(root, "KILL");
const behave = (behavior: Behavior = {}) => behaveIn(toolDir, KILL, { applyAdvance: true, ...behavior });
const calls = (): Call[] => callsOf(toolDir);
const initCalls = () => calls().filter((c) => c.args[0] === "init");
const AWS_PROVIDER = { name: "aws", full_name: "registry.terraform.io/hashicorp/aws", expressions: { region: { references: ["var.region"] } } };

let azureVault = "";
let awsVault = "";
test.before(async () => {
  azureVault = fresh("vault-azure");
  awsVault = fresh("vault-aws");
  await testFixtureForgeQualificationEvidence(azureVault);
  await testFixtureForgeQualificationEvidence(awsVault, undefined, "AWS");
});

type World = { deps: ApplyDeps; contractPath: string; scratch: string };
function world(contract: unknown, provider: "AZURE" | "AWS" = "AZURE", environment: ApplyEnvironment = "DEV"): World {
  behave(provider === "AWS" ? { showProviderConfig: { aws: AWS_PROVIDER } } : {});
  const scratch = fresh("scratch");
  const contractPath = join(fresh("contract"), "act-pilot-contract.json");
  writeReviewedContract(contractPath, contract);
  return {
    contractPath, scratch,
    deps: {
      sourceCommit: SOURCE_COMMIT,
      contractPath, qualificationDir: provider === "AWS" ? awsVault : azureVault, evidenceDir: fresh("evidence"),
      nonces: openNonceStore(fresh("nonces")), env: provider === "AWS" ? awsIdentityEnv(environment) : identityEnv(environment), now: () => NOW,
      scratchParent: scratch, toolDirs: [toolDir], killPollMs: 40, killGraceMs: 400,
    },
  };
}
const azureTf = 'resource "azurerm_resource_group" "pilot" {}\n';
async function seal(w: World, provider: "AZURE" | "AWS" = "AZURE") {
  const target = provider === "AWS" ? awsTargetOf("DEV") : DEV_TARGET;
  const p = writeProject(fresh("project"), target, provider === "AWS" ? 'resource "aws_s3_bucket" "pilot" {}\n' : azureTf);
  const result = await sealPreview({ invocation: human(target), environment: "DEV", target, manifest: p.manifest, projectRoot: p.projectRoot, policyVersion: POLICY, resolved: p.resolved, requester: REQUESTER }, w.deps);
  return { result, project: p, target };
}
const loadedContract = (w: World) => loadPilotContract(w.contractPath);
const reasonOf = (contract: unknown): string => {
  const path = join(fresh("contract"), "act-pilot-contract.json");
  writeReviewedContract(path, contract);
  const l = loadPilotContract(path);
  assert.equal(l.enabled, false);
  return (l as { reason: string }).reason;
};

// --- the contract field ---------------------------------------------------------------------------

test("the field is optional and default off: absent and false behave the same, the examples stay valid and shipped pin stays empty, true is a different contract", () => {
  const hashOf = (over: Record<string, unknown>) => {
    const w = world(contractJson(KILL, over));
    const l = loadedContract(w) as PilotContract;
    assert.equal(l.enabled, true, JSON.stringify(l));
    return { hash: pilotContractSha256(l), contract: l };
  };
  const absent = hashOf({});
  const off = hashOf({ embedStateWrite: false });
  const on = hashOf({ embedStateWrite: true });
  assert.ok(!("embedStateWrite" in absent.contract), "absent stays absent, so a contract that never mentions it hashes as it always did");
  assert.equal(off.contract.embedStateWrite, false);
  assert.notEqual(on.hash, off.hash);
  assert.equal(on.contract.embedStateWrite, true);
  assert.notEqual(on.hash, absent.hash, "the contract hash binds the choice");
  for (const bad of ["true", 1, null, "yes", [], {}]) assert.match(reasonOf(contractJson(KILL, { embedStateWrite: bad })), /embedStateWrite: expected true or false/);
  // AWS with Terraform may opt in too.
  assert.equal((loadPilotContract(...(() => { const w = world(awsContractJson(KILL, { embedStateWrite: true }), "AWS"); return [w.contractPath] as const; })()) as PilotContract).embedStateWrite, true);
  // The shipped examples do not mention it (so they stay valid and unchanged), and the repository ships no contract and no pin.
  for (const name of ["act-pilot-contract.example.json", "act-pilot-contract.aws.example.json", "act-pilot-contract.aws-cdk.example.json"]) {
    assert.ok(!readFileSync(fileURLToPath(new URL("../config/" + name, import.meta.url)), "utf8").includes("embedStateWrite"), name);
  }
  assert.equal(existsSync(fileURLToPath(new URL("../config/act-pilot-contract.json", import.meta.url))), false, "no contract is shipped");
  assert.equal(existsSync(fileURLToPath(new URL("../config/act-pilot-contract.sha256", import.meta.url))), false, "the retired pin is gone");
});

test("true with the CDK engine is an invalid contract", () => {
  assert.match(reasonOf({ ...cdkContractJson(KILL), embedStateWrite: true }), /embedStateWrite: valid only with an engine that has a state backend \(TERRAFORM\); CDK has none/);
});

// --- default off: unchanged -------------------------------------------------------------------------

test("default off: the seal init reads the contract's backend location only (the pinned backend has no settings of its own), never STATE_WRITE settings", async () => {
  const [account, container, ...key] = DEV_TARGET.backend.split("/");
  for (const over of [{}, { embedStateWrite: false }]) {
    const w = world(contractJson(KILL, over));
    const { result } = await seal(w);
    assert.ok(result.ok, JSON.stringify(result));
    const inits = initCalls();
    assert.equal(inits.length, 1);
    assert.deepEqual(inits[0].args, [...APPLY_INIT_ARGV]);
    assert.equal(inits[0].backendConfig, `storage_account_name = "${account}"\ncontainer_name = "${container}"\nkey = "${key.join("/")}"\n`);
    assert.equal(inits[0].backendOverride, 'terraform {\n  backend "azurerm" {}\n}\n', "Azure is pinned the same way, with type azurerm");
    assert.ok(calls().filter((c) => c.args[0] !== "init").every((c) => c.backendFileExists === false), "the backend file is gone right after init");
  }
});

// --- on: the seal init ------------------------------------------------------------------------------

const SECRETS = ["statewrite-secret-cccc", "apply-secret-dddd", "state-secret-bbbb", "discovery-secret-aaaa", "operator-ambient-secret"];

test("on (Azure): the seal init uses the backend-config file with STATE_WRITE's non-secret settings, the file is 0600 and gone right after init, and no secret reaches it or the child", async () => {
  const w = world(contractJson(KILL, { embedStateWrite: true }));
  const { result } = await seal(w);
  assert.ok(result.ok, JSON.stringify(result));
  const all = calls();
  const inits = initCalls();
  assert.equal(inits.length, 1);
  assert.equal(all[0].args[0], "version");
  assert.deepEqual(inits[0].args, [...APPLY_INIT_ARGV]);
  assert.equal(inits[0].backendFileExists, true);
  assert.equal(inits[0].backendMode, 0o600);
  const file = inits[0].backendConfig ?? "";
  assert.match(file, /client_id = "statewrite-client-3"/);
  assert.ok(file.includes(DEV_TARGET.account) && file.includes("/run/fixture/statewrite-oidc-token"));
  for (const secret of SECRETS) assert.ok(!file.includes(secret), "no secret in the backend file");
  assert.ok(!file.includes("apply-client-4") && !file.includes("state-client-2"), "only STATE_WRITE's settings");
  // Gone as soon as init ended: no later engine step sees it, and nothing is left in the scratch parent.
  const afterInit = all.slice(all.findIndex((c) => c.args[0] === "init") + 1);
  assert.ok(afterInit.length > 0 && afterInit.every((c) => c.backendFileExists === false));
  assert.deepEqual(readdirSync(w.scratch), []);
  assert.ok(all.every((c) => c.args[0] !== "apply"));
  // The seal environment: no STATE_WRITE or APPLY variable, no secret and no token contents; the rendering stayed in this process.
  for (const call of calls()) {
    assert.ok(Object.keys(call.env).every((k) => !/^ALZ_/.test(k)), "no ALZ_ variable reaches a child");
    const text = JSON.stringify(call.env);
    for (const value of ["statewrite-client-3", "apply-client-4", "statewrite-secret-cccc", "apply-secret-dddd", "operator-ambient-secret"]) assert.ok(!text.includes(value), value);
  }
  // Never in the evidence: the sealed plan file and the review bundle hold no backend settings.
  const loaded = await loadSealedPlan(result.path);
  assert.ok(loaded.ok);
  assert.ok(!JSON.stringify(loaded.sealed).includes("statewrite-client-3"));
  assert.ok(!APPLY_BACKEND_CONFIG_FILE || !existsSync(join(w.scratch, APPLY_BACKEND_CONFIG_FILE)));
});

test("on (AWS): the seal init renders STATE_WRITE's role and token file path, and nothing of APPLY's", async () => {
  const w = world(awsContractJson(KILL, { embedStateWrite: true }), "AWS");
  const { result } = await seal(w, "AWS");
  assert.ok(result.ok, JSON.stringify(result));
  const inits = initCalls();
  assert.deepEqual(inits[0].args, [...APPLY_INIT_ARGV]);
  const file = inits[0].backendConfig ?? "";
  assert.ok(file.includes(awsRoleArn("STATE_WRITE", "DEV")) && file.includes("/run/fixture/state_write-dev-token"));
  assert.ok(file.includes(`region = "${AWS_REGION}"`) && file.includes("use_lockfile = true"));
  assert.ok(!file.includes(awsRoleArn("APPLY", "DEV")) && !file.includes("apply-dev-token"));
  assert.ok(calls().filter((c) => c.args[0] !== "init").every((c) => c.backendFileExists === false));
  for (const call of calls()) {
    assert.ok(Object.keys(call.env).every((k) => !/^ALZ_/.test(k)));
    const text = JSON.stringify(call.env);
    for (const value of [awsRoleArn("STATE_WRITE", "DEV"), awsRoleArn("APPLY", "DEV"), "apply-dev-token", "state_write-dev-token"]) assert.ok(!text.includes(value), value);
  }
});

test("on: a STATE_WRITE value the backend file cannot hold safely stops the seal before init, with the file removed", async () => {
  const w = world(contractJson(KILL, { embedStateWrite: true }));
  w.deps.env = { ...w.deps.env, ALZ_STATE_WRITE_ARM_OIDC_TOKEN_FILE: 'relative/"quote' };
  const { result } = await seal(w);
  assert.equal(result.ok, false);
  assert.equal(initCalls().length, 0);
  assert.deepEqual(readdirSync(w.scratch), []);
});

// --- sealed plans bind the choice -------------------------------------------------------------------

test("a plan sealed with embed=false is refused under embed=true and the reverse, before any engine step", async () => {
  for (const [sealedWith, appliedUnder] of [[false, true], [true, false]] as const) {
    const w = world(contractJson(KILL, { embedStateWrite: sealedWith }));
    const { result, project, target } = await seal(w);
    assert.ok(result.ok, JSON.stringify(result));
    const loaded = await loadSealedPlan(result.path);
    assert.ok(loaded.ok);
    const sealedPlan = { sealed: loaded.sealed, planBytes: loaded.planBytes };
    writeReviewedContract(w.contractPath, contractJson(KILL, { embedStateWrite: appliedUnder }));
    const before = calls().length;
    const refused = await runApply({
      invocation: human(target), environment: "DEV", target: { ...target }, sealedPlan, manifest: project.manifest, projectRoot: project.projectRoot,
      approvals: [approval(result.sealed, "alice")],
    }, w.deps);
    assert.equal(refused.ok, false);
    assert.equal((refused as unknown as { code: string }).code, "ARTIFACT_INVALID");
    assert.match((refused as unknown as { message: string }).message, /another pilot contract/);
    assert.equal(calls().length, before, "no engine step ran");
    assert.equal(calls().filter((c) => c.args[0] === "apply").length, 0);
  }
});

// --- the CLI: confirmation and preflight ------------------------------------------------------------

type Terminal = NonNullable<ApplyCliDeps["terminal"]> & { out: string[]; asked: string[] };
const terminal = (answers: string[]): Terminal => {
  const out: string[] = [];
  const asked: string[] = [];
  return { stdinIsTTY: true, stdoutIsTTY: true, out, asked, write: (t: string) => { out.push(t); }, ask: async (q: string) => { asked.push(q); return answers.shift() ?? ""; } };
};
const json = (value: unknown): string => { const path = join(fresh("file"), "f.json"); writeFileSync(path, JSON.stringify(value)); return path; };
async function cli(w: World, args: string[], answers: string[]) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const term = terminal(answers);
  const d = w.deps;
  const code = await runApplyCommand(args, {
    terminal: term, env: d.env, now: d.now, operatorId: "operator.fixture", contractPath: d.contractPath, qualificationDir: d.qualificationDir,
    evidenceDir: d.evidenceDir, nonces: d.nonces, scratchParent: d.scratchParent, toolDirs: d.toolDirs, sourceCommit: d.sourceCommit, stdout: (t) => { stdout.push(t); }, stderr: (t) => { stderr.push(t); },
  });
  return { code, stdout: stdout.join(""), stderr: stderr.join(""), term };
}
const RUN_CODE = "RUN PROJECT CODE";
const PHRASE = "EMBED STATE_WRITE DEV";
const request = (kind: "seal" | "qualify") => {
  const p = writeProject(fresh("project"), DEV_TARGET);
  return [kind, "--request", json({ environment: "DEV", target: DEV_TARGET, projectRoot: p.projectRoot, policyVersion: POLICY, resolved: p.resolved }), "--manifest", json(p.manifest), ...(kind === "seal" ? requesterArgs() : [])];
};

for (const kind of ["seal", "qualify"] as const) {
  test(`${kind} with embed=true warns in plain language and needs the exact phrase; a wrong or missing phrase runs no engine and seals nothing`, async () => {
    const answers = (phrase?: string) => [targetString(DEV_TARGET), RUN_CODE, ...(phrase === undefined ? [] : [phrase])];
    for (const wrong of [undefined, "", "yes", "embed state_write dev", "EMBED STATE_WRITE QA", PHRASE + " ", RUN_CODE]) {
      const w = world(contractJson(KILL, { embedStateWrite: true }));
      const run = await cli(w, request(kind), answers(wrong));
      assert.equal(run.code, 1, JSON.stringify(wrong));
      assert.match(run.stderr, /EMBED_STATE_WRITE_CONFIRMATION_MISMATCH/);
      assert.deepEqual(calls(), [], "no engine ran");
      assert.ok(!run.stdout.includes("sealedPlanPath"));
      const shown = run.term.out.join("");
      for (const part of [PHRASE, "non-secret backend settings", "name the state writer", "write-capable at the backend", "secret-bearing and", "SIMULATED"]) {
        assert.ok(shown.includes(part), part);
      }
      assert.ok(run.term.asked.includes("embed> "));
    }
  });
}

test("seal with embed=true and the exact phrase runs the engine with the embedding init; no flag skips the prompt", async () => {
  const w = world(contractJson(KILL, { embedStateWrite: true }));
  const run = await cli(w, request("seal"), [targetString(DEV_TARGET), RUN_CODE, PHRASE]);
  assert.equal(run.code, 0, run.stderr);
  assert.deepEqual(initCalls().map((c) => c.args), [[...APPLY_INIT_ARGV]]);
  const flagged = await cli(w, [...request("seal"), "--yes"], [targetString(DEV_TARGET), RUN_CODE, PHRASE]);
  assert.equal(flagged.code, 1, "an unknown flag is an error; there is none that skips the phrase");
  // Default off: no phrase is asked.
  const off = world(contractJson(KILL));
  const plain = await cli(off, request("seal"), [targetString(DEV_TARGET), RUN_CODE]);
  assert.equal(plain.code, 0, plain.stderr);
  assert.ok(!plain.term.asked.includes("embed> ") && !plain.term.out.join("").includes("embedStateWrite"));
});

test("preflight reports whether the plan will embed STATE_WRITE settings, informationally", async () => {
  for (const [over, answer] of [[{}, "no"], [{ embedStateWrite: false }, "no"], [{ embedStateWrite: true }, "yes"]] as const) {
    const w = world(contractJson(KILL, over));
    const run = await cli(w, ["preflight", "--environment", "DEV"], []);
    assert.equal(run.code, 0, run.stderr);
    const report = JSON.parse(run.stdout) as { ready: boolean; checks: { check: string; ok: boolean }[] };
    const line = report.checks.find((c) => c.check.startsWith("plan will embed STATE_WRITE settings"));
    assert.equal(line?.check, "plan will embed STATE_WRITE settings: " + answer);
    assert.equal(line?.ok, true);
    assert.equal(report.ready, true);
  }
});
