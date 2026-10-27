import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { consumeApprovals } from "../src/apply/approval.js";
import type { NonceStore } from "../src/apply/nonces.js";
import { installSignalCleanup } from "../src/cli/teardown-driver.js";
import { requireNotApplied } from "../src/apply/contract.js";
import { qualifyApply, runApply, sealPreview, type ApplyDeps, type ApplyRequest, type SealRequest } from "../src/apply/driver.js";
import { APPLY_AUTHORITY } from "../src/apply/evidence.js";
import { openNonceStore } from "../src/apply/nonces.js";
import { loadSealedPlan } from "../src/apply/seal.js";
import { APPLY_ADAPTER, APPLY_ARGV, APPLY_INIT_ARGV } from "../src/apply/terraform.js";
import type { ApplyEvidence, ApplyEnvironment, ApplyResult, SealedPlan, SignedApproval } from "../src/apply/types.js";
import { signApproval } from "../src/apply/approval.js";
import { withDebugDiagnosticContext } from "../src/debug/context.js";
import { readEncryptedEvidence } from "../src/evidence/vault.js";
import { removeTree, runCleanups } from "../src/teardown/driver/cleanup.js";
import { runBoundedProcess, runStoppableProcess } from "../src/tools/process.js";
import { TERRAFORM_APPLY_PROFILE } from "../src/tools/profiles.js";
import { SOURCE_COMMIT,
  AZURE_BACKEND_TF, AZURE_MAIN_TF, CANARIES, DEV_TARGET, approvers, ENV, H, NOW, OPERATOR, OUTPUT_CANARY, PLAN_CANARY, POLICY, PROD_TARGET, QA_TARGET, STATE_CANARY, TENANT, VALUE_CANARY,
  approvalFor as approval, behave as behaveIn, callsOf, contractJson, human, identityEnv, installFakeTerraform, keys, pinPathOf,
  testFixtureForgeQualificationEvidence, recordApplied, sha, signalsOf, targetOf, writePinnedContract, writeProject, type Behavior, type Call, type Project,
} from "./helpers/apply-fixtures.js";

// docs/act-pilot-plan.md. The engine is a fake executable, so these tests pin
// the driver's enforcement order and logic. They are NOT real-engine
// qualification. Explicit fixtures only: no real tenant, subscription or approver.

const root = mkdtempSync(join(tmpdir(), "alz-driver-"));
const toolDir = mkdtempSync(join(tmpdir(), "alz-driver-tools-"));
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
const behave = (behavior: Behavior = {}) => behaveIn(toolDir, KILL, behavior);
const calls = (): Call[] => callsOf(toolDir);
const applyCalls = () => calls().filter((c) => c.args[0] === "apply");
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const until = async (condition: () => boolean, what: string, limitMs = 15_000): Promise<void> => {
  const end = Date.now() + limitMs;
  while (!condition()) {
    if (Date.now() > end) throw new Error("timed out waiting for " + what);
    await sleep(20);
  }
};

type World = { deps: ApplyDeps; dirs: { scratch: string; evidence: string; nonces: string; vault: string }; contractPath: string };
let vaultDir = "";
/** Vaults holding evidence for one adapter only: the other adapter is then not qualified. */
let applyOnlyVault = "";
let previewOnlyVault = "";
function world(over: Partial<ApplyDeps> = {}, contract: unknown = contractJson(KILL)): World {
  behave();
  const dirs = { scratch: fresh("scratch"), evidence: fresh("evidence"), nonces: fresh("nonces"), vault: fresh("vault") };
  const contractPath = join(fresh("contract"), "act-pilot-contract.json");
  if (contract !== undefined) writePinnedContract(contractPath, contract);
  return {
    dirs, contractPath,
    deps: {
      sourceCommit: SOURCE_COMMIT,
      contractPath, contractPinPath: pinPathOf(contractPath), qualificationDir: vaultDir,
      evidenceDir: dirs.evidence, nonces: openNonceStore(dirs.nonces), env: ENV, now: () => NOW, scratchParent: dirs.scratch,
      toolDirs: [toolDir], killPollMs: 40, killGraceMs: 400, ...over,
    },
  };
}
/** The same world, with the identities aimed at one environment's tenant and subscription. */
const forEnv = (w: World, environment: ApplyEnvironment): ApplyDeps => ({ ...w.deps, env: identityEnv(environment) });

test.before(async () => {
  vaultDir = fresh("qualification");
  await testFixtureForgeQualificationEvidence(vaultDir);
  applyOnlyVault = fresh("qualification-apply");
  await testFixtureForgeQualificationEvidence(applyOnlyVault, "apply");
  previewOnlyVault = fresh("qualification-preview");
  await testFixtureForgeQualificationEvidence(previewOnlyVault, "preview");
});

async function seal(w: World, environment: ApplyEnvironment, p: Project = writeProject(fresh("project"), targetOf(environment))) {
  const target = targetOf(environment);
  const result = await sealPreview({
    invocation: human(target), environment, target, manifest: p.manifest, projectRoot: p.projectRoot, policyVersion: POLICY, resolved: p.resolved,
  }, forEnv(w, environment));
  assert.ok(result.ok, JSON.stringify(result));
  const loaded = await loadSealedPlan(result.path);
  assert.ok(loaded.ok);
  return { sealed: result.sealed, path: result.path, project: p, loaded: { sealed: loaded.sealed, planBytes: loaded.planBytes } };
}
type Sealed = Awaited<ReturnType<typeof seal>>;

/** One release, sealed for each environment: the same project files, so the same releaseIdentity. */
const SHARED_TF = AZURE_MAIN_TF;
const sealShared = (w: World, environment: ApplyEnvironment, mainTf: string = SHARED_TF) => seal(w, environment, writeProject(fresh("project"), targetOf(environment), mainTf));
/** The approvals a stage needs from the fixture contract: one for DEV and QA, two for PROD. */
const approvalsFor = (s: Sealed): SignedApproval[] => (s.sealed.environment === "PROD"
  ? [approval(s.sealed, "alice"), approval(s.sealed, "bob")] : [approval(s.sealed, "alice")]);
/** Seals and applies one stage of the shared release, and returns what it applied. */
async function promoteTo(w: World, environment: ApplyEnvironment, mainTf?: string) {
  const sealedPlan = await sealShared(w, environment, mainTf);
  const result = await run(w, sealedPlan, approvalsFor(sealedPlan));
  assert.ok(result.ok, environment + " " + JSON.stringify(result));
  return result.evidence;
}

const requestFor = (s: Sealed, approvals: SignedApproval[], over: Partial<ApplyRequest> = {}): ApplyRequest => ({
  invocation: human(s.sealed.target), environment: s.sealed.environment, target: { ...s.sealed.target }, sealedPlan: s.loaded,
  manifest: s.project.manifest, projectRoot: s.project.projectRoot, approvals, ...over,
});
const run = (w: World, s: Sealed, approvals: SignedApproval[], over: Partial<ApplyRequest> = {}) =>
  runApply(requestFor(s, approvals, over), forEnv(w, s.sealed.environment));
const ledgerOf = (w: World, s: Sealed): string => join(w.dirs.evidence, s.sealed.artifactSha256 + ".apply.evidence");
const storedOutcome = async (w: World, s: Sealed) => (await readEncryptedEvidence<ApplyEvidence>(ledgerOf(w, s))).outcome;

const refused = (result: ApplyResult, code: string): void => {
  assert.equal(result.ok, false, JSON.stringify(result));
  assert.equal((result as { code: string }).code, code, JSON.stringify(result));
};
const clean = (w: World): void => assert.deepEqual(readdirSync(w.dirs.scratch), [], "no scratch directory, plan copy or snapshot survives");
const noMessage = (result: unknown): void => {
  const text = JSON.stringify(result);
  for (const canary of CANARIES) assert.ok(!text.includes(canary), "result carries " + canary);
};

// --- the full path, in order ----------------------------------------------------------

test("a DEV apply runs the pinned steps with the right identity at each step and applies exactly the sealed plan bytes", async () => {
  const w = world();
  behave({ applyAdvance: true });
  const s = await seal(w, "DEV");
  const before = calls().length;
  const result = await run(w, s, [approval(s.sealed, "alice")]);
  assert.ok(result.ok, JSON.stringify(result));
  noMessage(result);

  const steps = calls().slice(before);
  assert.deepEqual(steps.map((c) => c.args), [
    ["version", "-json"],
    [...APPLY_INIT_ARGV],
    ["workspace", "show"],
    ["state", "pull"],
    ["show", "-json", "../alz-preview.tfplan"],
    [...APPLY_ARGV],
    ["state", "pull"],
    // The blueprint read (docs/observe-and-cleanup.md): the state after the apply, as STATE, mapped to identifiers and dropped.
    ["state", "pull"],
  ]);
  const clientOf = (c: Call) => c.env.ARM_CLIENT_ID;
  assert.equal(clientOf(steps[0]), undefined, "version needs no credentials");
  assert.equal(clientOf(steps[1]), "statewrite-client-3", "init and workspace use STATE_WRITE");
  assert.equal(clientOf(steps[2]), "statewrite-client-3");
  assert.equal(clientOf(steps[3]), "state-client-2", "state reads use STATE");
  assert.equal(clientOf(steps[4]), undefined, "the change list is derived again from the plan with no identity at all");
  assert.ok(!Object.keys(steps[4].env).some((name) => /^(ARM_|AZURE_|TF_CLI_CONFIG_FILE|TF_PLUGIN_CACHE_DIR)/.test(name)), "no credential and no provider-installation override reaches it");
  assert.equal(clientOf(steps[5]), "apply-client-4", "apply uses APPLY and never a state identity");
  assert.equal(clientOf(steps[6]), "state-client-2");
  for (const call of steps) {
    const text = JSON.stringify(call.env);
    for (const value of ["operator-ambient", "operator-azure"]) assert.ok(!text.includes(value), call.args[0] + " " + value);
    assert.ok(!call.args.some((a) => /^-(lock(=|-timeout|$)|refresh|target|replace|auto-approve|destroy)/.test(a)));
    for (const name of ["TF_CLI_CONFIG_FILE", "TF_PLUGIN_CACHE_DIR"]) assert.equal(call.env[name], undefined, call.args[0] + " " + name);
  }
  const applyEnv = JSON.stringify(steps[5].env);
  for (const other of ["discovery-", "state-client", "state-secret", "statewrite-"]) assert.ok(!applyEnv.includes(other), "apply env holds " + other);

  // The backend settings init saves name STATE_WRITE (ids and a token file path, no secret value), and the file is gone after init.
  const backend = steps[1].backendConfig ?? "";
  assert.match(backend, /client_id = "statewrite-client-3"/);
  assert.ok(backend.includes(`tenant_id = "${TENANT}"`) && backend.includes(`subscription_id = "${DEV_TARGET.account}"`));
  assert.ok(backend.includes('oidc_token_file_path = "/run/fixture/statewrite-oidc-token"') && backend.includes("use_oidc = true"));
  assert.ok(backend.includes("use_azuread_auth = true"), "state access is Entra ID only (owner decision, 2026-10-27)");
  assert.ok(!backend.includes("statewrite-secret") && !backend.includes("apply-"), "no secret and no other identity in the backend configuration");

  const apply = steps[5];
  assert.equal(apply.planSha, s.sealed.planSha256, "the file applied is byte-for-byte the sealed plan");
  assert.equal(apply.planMode, 0o600);
  assert.ok(apply.planText?.includes(PLAN_CANARY));
  assert.ok(!existsSync(join(apply.cwd, "..", "alz-apply.tfplan")), "the decrypted plan is gone");
  assert.ok(!existsSync(join(apply.cwd, "..", "alz-backend.tfbackend")), "the backend configuration is gone");
  clean(w);

  assert.equal(result.evidence.outcome, "SUCCEEDED");
  assert.equal(result.evidence.exitCode, 0);
  assert.deepEqual(result.evidence.approvals, [{ approverId: "alice", issuedAt: new Date(NOW.getTime() - 5 * 60_000).toISOString() }]);
  assert.deepEqual(result.evidence.adapter, { adapterVersion: APPLY_ADAPTER.adapterVersion, argvDigest: APPLY_ADAPTER.argvDigest });
  assert.deepEqual(result.evidence.authority, APPLY_AUTHORITY);
  assert.equal(result.evidence.artifactSha256, s.sealed.artifactSha256);
  assert.equal(result.evidence.manifestHash, s.sealed.manifestHash);
  assert.equal(result.evidence.releaseIdentity, s.sealed.releaseIdentity);
});

test("evidence is encrypted at rest, is the ledger entry, and carries no plan, state or apply output values", async () => {
  const w = world();
  behave({ applyAdvance: true });
  const s = await seal(w, "DEV");
  const result = await run(w, s, [approval(s.sealed, "alice")]);
  assert.ok(result.ok);
  const file = ledgerOf(w, s);
  assert.equal(statSync(file).mode & 0o077, 0);
  const stored = await readEncryptedEvidence<ApplyEvidence>(file);
  assert.deepEqual(stored, result.evidence);
  assert.deepEqual(readdirSync(w.dirs.evidence).sort(), [s.sealed.artifactSha256 + ".apply.evidence", s.sealed.artifactSha256 + ".blueprint.evidence"],
    "the evidence and the blueprint of what the run left; no reservation or staging file is left beside them");
  // Nothing readable anywhere the run wrote: evidence, nonces, vault, scratch.
  const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]);
  for (const path of walk(root)) {
    const text = readFileSync(path, "utf8") + Buffer.from(readFileSync(path)).toString("base64");
    for (const canary of CANARIES) assert.ok(!text.includes(canary) && !text.includes(Buffer.from(canary).toString("base64")), path + " holds " + canary);
  }
  for (const canary of CANARIES) assert.ok(!JSON.stringify(stored).includes(canary));
});

// --- preview provenance ---------------------------------------------------------------

const programSha = (): string => sha(readFileSync(join(toolDir, "terraform")));
/** Another engine program in the same place: the fake with one more line, so it behaves the same and hashes differently. */
function swapProgram(): void { appendFileSync(join(toolDir, "terraform"), "// another build of the program\n"); }

test("the seal records the engine program that made the preview and the real-engine evidence that covers it, and the apply runs with that program", async () => {
  const w = world();
  behave({ applyAdvance: true });
  const s = await seal(w, "DEV");
  const { previewRecord } = await testFixtureForgeQualificationEvidence(fresh("records"));
  assert.deepEqual(s.sealed.provenance, {
    engineBinarySha256: programSha(),
    qualification: { state: "QUALIFIED", evidenceHash: previewRecord.evidenceHash, qualifiedAt: previewRecord.qualifiedAt },
  });
  const result = await run(w, s, [approval(s.sealed, "alice")]);
  assert.ok(result.ok, JSON.stringify(result));
  clean(w);
});

test("a preview from a program the evidence does not cover is sealed as UNQUALIFIED with the reason, and that plan still cannot apply", async () => {
  const w = world();
  swapProgram();
  try {
    behave({ applyAdvance: true });
    const s = await seal(w, "DEV");
    assert.equal(s.sealed.provenance.engineBinarySha256, programSha());
    const q = s.sealed.provenance.qualification;
    assert.ok(q.state === "UNQUALIFIED" && /not produced with this engine binary/.test(q.reason), JSON.stringify(q));
    refused(await run(w, s, [approval(s.sealed, "alice")]), "ENGINE_NOT_QUALIFIED");
    assert.equal(applyCalls().length, 0);
  } finally { installFakeTerraform(toolDir); }
  clean(w);
});

test("a program swapped or removed between seal and apply is ENGINE_BINARY_CHANGED before any engine call or reservation, and the same approval applies once the sealed program is back", async () => {
  const w = world();
  behave({ applyAdvance: true });
  const s = await seal(w, "DEV");
  const signed = approval(s.sealed, "alice");
  const before = calls().length;
  swapProgram();
  try {
    refused(await run(w, s, [signed]), "ENGINE_BINARY_CHANGED");
  } finally { installFakeTerraform(toolDir); }
  // No program at all where the runner looks is the same refusal.
  refused(await runApply(requestFor(s, [signed]), { ...forEnv(w, "DEV"), toolDirs: [fresh("no-tools")] }), "ENGINE_BINARY_CHANGED");
  assert.equal(calls().length, before, "no engine step ran for either refusal");
  assert.ok(!existsSync(ledgerOf(w, s)), "nothing was reserved");
  // Nothing was consumed: the approval that was refused applies the plan with the program that made it.
  const result = await run(w, s, [signed]);
  assert.ok(result.ok, JSON.stringify(result));
  clean(w);
});

test("a second apply of the same artifact is refused, even with fresh approvals, and never runs the engine", async () => {
  const w = world();
  behave({ applyAdvance: true });
  const s = await seal(w, "DEV");
  assert.ok((await run(w, s, [approval(s.sealed, "alice")])).ok);
  const applied = applyCalls().length;
  refused(await run(w, s, [approval(s.sealed, "bob")]), "ARTIFACT_ALREADY_APPLIED");
  assert.equal(applyCalls().length, applied);
  clean(w);
});

test("replayed approvals are refused by the nonce store even if the ledger record is gone", async () => {
  const w = world();
  behave({ applyAdvance: true });
  const s = await seal(w, "DEV");
  const approvals = [approval(s.sealed, "alice")];
  assert.ok((await run(w, s, approvals)).ok);
  rmSync(ledgerOf(w, s));
  const applied = applyCalls().length;
  refused(await run(w, s, approvals), "APPROVAL_REPLAYED");
  assert.equal(applyCalls().length, applied);
});

test("approvals consumed elsewhere are replayed", async () => {
  const w = world();
  const s = await seal(w, "DEV");
  const approvals = [approval(s.sealed, "alice")];
  assert.deepEqual(consumeApprovals(w.deps.nonces!, approvals), { ok: true });
  refused(await run(w, s, approvals), "APPROVAL_REPLAYED");
  assert.equal(applyCalls().length, 0);
});

// --- outcomes --------------------------------------------------------------------------

test("non-zero exit after the apply started and state moved is PARTIAL_REQUIRES_REVIEW with a clear no-retry message", async () => {
  const w = world();
  behave({ applyExit: 1, applyAdvance: true, applyStderr: "Error: " + VALUE_CANARY });
  const s = await seal(w, "DEV");
  const approvals = [approval(s.sealed, "alice")];
  const result = await run(w, s, approvals);
  refused(result, "APPLY_FAILED");
  assert.equal((result as { outcome?: string }).outcome, "PARTIAL_REQUIRES_REVIEW");
  const message = (result as { message: string }).message;
  assert.match(message, /do not retry/i);
  assert.match(message, /review/i);
  noMessage(result);
  const stored = await readEncryptedEvidence<ApplyEvidence>(ledgerOf(w, s));
  assert.equal(stored.outcome, "PARTIAL_REQUIRES_REVIEW");
  assert.equal(stored.exitCode, 1);
  // The artifact is closed and the approvals are spent.
  refused(await run(w, s, approvals), "ARTIFACT_ALREADY_APPLIED");
  clean(w);
});

test("a failure that left the state serial alone is still PARTIAL_REQUIRES_REVIEW: resources can exist while the state write failed", async () => {
  const w = world();
  behave({ applyExit: 1, applyStderr: "Error: quota " + VALUE_CANARY });
  const s = await seal(w, "DEV");
  const result = await run(w, s, [approval(s.sealed, "alice")]);
  refused(result, "APPLY_FAILED");
  assert.equal((result as { outcome?: string }).outcome, "PARTIAL_REQUIRES_REVIEW");
  noMessage(result);
  assert.equal(await storedOutcome(w, s), "PARTIAL_REQUIRES_REVIEW");
  refused(await run(w, s, [approval(s.sealed, "bob")]), "ARTIFACT_ALREADY_APPLIED");
});

test("a state lock that was not acquired is FAILED_NO_CHANGE; the artifact is still spent", async () => {
  const w = world();
  behave({ applyExit: 1, applyStderr: "\u2577\n\u2502 Error: Error acquiring the state lock\n\u2502 " + VALUE_CANARY });
  const s = await seal(w, "DEV");
  const result = await run(w, s, [approval(s.sealed, "alice")]);
  refused(result, "APPLY_FAILED");
  assert.equal((result as { outcome?: string }).outcome, "FAILED_NO_CHANGE");
  noMessage(result);
  assert.equal(await storedOutcome(w, s), "FAILED_NO_CHANGE");
  refused(await run(w, s, [approval(s.sealed, "bob")]), "ARTIFACT_ALREADY_APPLIED");
});

const recoveryDir = (): string => join(root, ".runs/evidence/apply-recovery");

test("errored.tfstate and crash.log are kept encrypted in the vault, referenced by count and hash, and never in scratch, the result or the evidence text", async () => {
  const w = world();
  const SECRET = "CANARY_ERRORED_STATE_c5";
  behave({
    applyExit: 1, applyStderr: "Error: " + VALUE_CANARY, planSalt: "with-recovery-files",
    applyWrites: [{ path: "errored.tfstate", content: JSON.stringify({ serial: 8, secret: SECRET }) }, { path: "crash.log", content: "panic " + SECRET }],
  });
  const s = await seal(w, "DEV");
  const result = await run(w, s, [approval(s.sealed, "alice")]);
  refused(result, "APPLY_FAILED");
  assert.equal((result as { outcome?: string }).outcome, "PARTIAL_REQUIRES_REVIEW");
  assert.match((result as { message: string }).message, /errored\.tfstate/);
  assert.ok(!JSON.stringify(result).includes(SECRET));
  clean(w);

  const stored = await readEncryptedEvidence<ApplyEvidence>(ledgerOf(w, s));
  assert.equal(stored.outcome, "PARTIAL_REQUIRES_REVIEW");
  assert.equal(stored.recovery?.files, 2);
  assert.match(stored.recovery?.sha256 ?? "", /^[0-9a-f]{64}$/);
  assert.ok(!JSON.stringify(stored).includes(SECRET));
  assert.deepEqual(Object.keys(stored.recovery ?? {}).sort(), ["files", "sha256"], "a count and a hash, never contents");

  const file = join(recoveryDir(), s.sealed.artifactSha256 + ".evidence");
  assert.equal(statSync(file).mode & 0o077, 0);
  assert.ok(!readFileSync(file, "utf8").includes(SECRET) && !readFileSync(file, "utf8").includes(Buffer.from(SECRET).toString("base64")), "encrypted at rest");
  const kept = await readEncryptedEvidence<{ files: { name: string; base64: string }[] }>(file);
  assert.deepEqual(kept.files.map((f) => f.name).sort(), ["crash.log", "errored.tfstate"]);
  assert.ok(Buffer.from(kept.files.find((f) => f.name === "errored.tfstate")!.base64, "base64").toString("utf8").includes(SECRET), "a person can recover it");
  refused(await run(w, s, [approval(s.sealed, "bob")]), "ARTIFACT_ALREADY_APPLIED");
});

test("a run that leaves no recovery files records none", async () => {
  const w = world();
  behave({ applyExit: 1, applyStderr: "Error: nothing left behind", planSalt: "no-recovery-files" });
  const s = await seal(w, "DEV");
  refused(await run(w, s, [approval(s.sealed, "alice")]), "APPLY_FAILED");
  const stored = await readEncryptedEvidence<ApplyEvidence>(ledgerOf(w, s));
  assert.equal(stored.recovery, undefined);
  assert.ok(!existsSync(join(recoveryDir(), s.sealed.artifactSha256 + ".evidence")));
});

test("a stale plan is PLAN_STALE: nothing changed, a new preview and new approvals are needed", async () => {
  const w = world();
  behave({ applyExit: 1, applyStderr: "Error: Saved plan is stale " + VALUE_CANARY });
  const s = await seal(w, "DEV");
  const result = await run(w, s, [approval(s.sealed, "alice")]);
  refused(result, "PLAN_STALE");
  assert.equal((result as { outcome?: string }).outcome, "FAILED_NO_CHANGE");
  assert.match((result as { message: string }).message, /new preview/i);
  noMessage(result);
});

test("an engine that ends itself on a signal is KILLED, with evidence and a review message", async () => {
  const w = world();
  behave({ applyKill: true });
  const s = await seal(w, "DEV");
  const result = await run(w, s, [approval(s.sealed, "alice")]);
  refused(result, "APPLY_FAILED");
  assert.equal((result as { outcome?: string }).outcome, "KILLED");
  assert.match((result as { message: string }).message, /review/i);
  const stored = await readEncryptedEvidence<ApplyEvidence>(ledgerOf(w, s));
  assert.equal(stored.outcome, "KILLED");
  assert.equal(stored.exitCode, null);
  clean(w);
});

// --- the kill switch and signals stop a running apply ------------------------------------

/** Starts an apply that waits for `release`, and resolves once the engine is really running it. */
async function startHeldApply(w: World, s: Sealed, approvals: SignedApproval[], behavior: Behavior = {}) {
  const release = join(root, "release-" + ++counter);
  behave({ applyWaitFor: release, ...behavior });
  const running = run(w, s, approvals);
  await until(() => applyCalls().length === 1, "the apply to start");
  return { running, release: () => writeFileSync(release, "go") };
}

test("the kill switch appearing while the engine runs stops it: SIGINT first, KILLED, evidence, a true message", async () => {
  const w = world();
  const s = await seal(w, "DEV");
  const started = Date.now();
  const held = await startHeldApply(w, s, [approval(s.sealed, "alice")]);
  writeFileSync(KILL, "stop");
  const result = await held.running;
  refused(result, "APPLY_FAILED");
  assert.equal((result as { outcome?: string }).outcome, "KILLED");
  assert.deepEqual(signalsOf(toolDir), ["SIGINT"], "terraform's graceful stop, not a kill");
  assert.ok(Date.now() - started < 10_000, "stopped within seconds, not at the 30 minute limit");
  const message = (result as { message: string }).message;
  assert.match(message, /kill switch/i);
  assert.match(message, /SIGINT|interrupt/i);
  assert.match(message, /lease/i);
  assert.match(message, /review/i);
  assert.equal(await storedOutcome(w, s), "KILLED");
  assert.equal((await readEncryptedEvidence<ApplyEvidence>(ledgerOf(w, s))).exitCode, 1, "a graceful stop exits non-zero; the stop request, not the code, decides KILLED");
  rmSync(KILL);
  refused(await run(w, s, [approval(s.sealed, "bob")]), "ARTIFACT_ALREADY_APPLIED");
  clean(w);
});

test("an engine that ignores SIGINT is killed after the grace period", async () => {
  const w = world();
  const s = await seal(w, "DEV");
  const held = await startHeldApply(w, s, [approval(s.sealed, "alice")], { ignoreSigint: true });
  writeFileSync(KILL, "stop");
  const started = Date.now();
  const result = await held.running;
  assert.equal((result as { outcome?: string }).outcome, "KILLED");
  assert.ok(Date.now() - started >= 300, "the grace period was given");
  assert.ok(Date.now() - started < 10_000);
  assert.equal((await readEncryptedEvidence<ApplyEvidence>(ledgerOf(w, s))).exitCode, null, "ended by the final kill");
  clean(w);
});

const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT"] as const) {
  test(`${signal} sent to the CLI process is forwarded to the engine as its graceful stop`, async () => {
    const w = world();
    const s = await seal(w, "DEV");
    const baseline = process.listenerCount(signal);
    const held = await startHeldApply(w, s, [approval(s.sealed, "alice")]);
    assert.ok(process.listenerCount(signal) > baseline, "the run listens while the engine runs");
    process.emit(signal);
    const result = await held.running;
    assert.equal((result as { outcome?: string }).outcome, "KILLED");
    assert.deepEqual(signalsOf(toolDir), ["SIGINT"]);
    assert.equal(process.listenerCount(signal), baseline, "every listener is removed when the run ends");
    assert.equal(await storedOutcome(w, s), "KILLED");
    assert.ok(!alive(applyCalls()[0].pid!), "the engine does not outlive the run");
    clean(w);
  });
}

for (const signal of ["SIGHUP", "SIGQUIT"] as const) {
  test(`${signal} with the CLI's own handler installed: the run stops the engine, escalates, finalizes evidence and ledger, and the process is not exited`, async () => {
    const w = world();
    const s = await seal(w, "DEV");
    const held = await startHeldApply(w, s, [approval(s.sealed, "alice")], { ignoreSigint: true });
    const exits: unknown[] = [];
    const realExit = process.exit;
    process.exit = ((code?: number) => { exits.push(code); }) as typeof process.exit;
    const removeHandlers = installSignalCleanup();
    try {
      const started = Date.now();
      process.emit(signal);
      const result = await held.running;
      assert.deepEqual(exits, [], "the handler left the exit to the run");
      assert.equal((result as { outcome?: string }).outcome, "KILLED");
      assert.ok(Date.now() - started >= 300, "the grace period was given before the final kill");
      assert.ok(!alive(applyCalls()[0].pid!), "the engine child does not survive, even though it ignores the graceful stop");
      assert.equal((await readEncryptedEvidence<ApplyEvidence>(ledgerOf(w, s))).exitCode, null);
      assert.equal(await storedOutcome(w, s), "KILLED", "the reservation became evidence");
      clean(w);
    } finally {
      removeHandlers();
      process.exit = realExit;
    }
  });
}

test("with no run holding the signals, the CLI handler still cleans up and exits with the conventional code", () => {
  const exits: unknown[] = [];
  const realExit = process.exit;
  process.exit = ((code?: number) => { exits.push(code); }) as typeof process.exit;
  const removeHandlers = installSignalCleanup();
  try {
    for (const signal of ["SIGHUP", "SIGQUIT"] as const) process.emit(signal);
    assert.deepEqual(exits, [129, 131]);
  } finally {
    removeHandlers();
    process.exit = realExit;
  }
});

test("a signal that arrives while the pre-apply steps run stops before the engine: nothing consumed, the artifact given back", async () => {
  const w = world();
  const s = await seal(w, "DEV");
  const approvals = [approval(s.sealed, "alice")];
  const removeHandlers = installSignalCleanup();
  try {
    behave({ signalParentOn: { cmd: "init", signal: "SIGHUP" } });
    const result = await run(w, s, approvals);
    refused(result, "APPLY_FAILED");
    assert.match((result as { message: string }).message, /interrupt/i);
    assert.equal((result as { outcome?: string }).outcome, undefined);
    assert.equal(applyCalls().length, 0);
    assert.ok(!existsSync(ledgerOf(w, s)), "the reservation was released");
    clean(w);
  } finally { removeHandlers(); }
  behave({ applyAdvance: true });
  assert.ok((await run(w, s, approvals)).ok, "the same approvals still work");
});

test("the kill switch is read again right before the engine is spawned: a switch already up starts nothing", async () => {
  const quick = fresh("runner");
  const sentinel = join(quick, "ran");
  const result = await runStoppableProcess("terraform_plan", "node", ["-e", `require("fs").writeFileSync(${JSON.stringify(sentinel)}, "x")`], quick, {
    profile: TERRAFORM_APPLY_PROFILE, env: {}, toolDirs: [join(process.execPath, "..")], stopWhen: () => true,
  });
  assert.equal(result.notStarted, true);
  assert.equal(result.ok, false);
  assert.ok(!existsSync(sentinel), "the child never existed");
});

test("the kill switch appearing during the pre-apply steps stops before apply, consuming nothing", async () => {
  const w = world();
  behave({ touchKillOn: "init" });
  const s = await seal(w, "DEV");
  const approvals = [approval(s.sealed, "alice")];
  refused(await run(w, s, approvals), "KILL_SWITCH_ACTIVE");
  assert.equal(applyCalls().length, 0);
  assert.ok(!existsSync(ledgerOf(w, s)), "the reservation was given back");
  rmSync(KILL);
  // The approvals were not consumed: the same set works once the switch is lifted.
  behave({ applyAdvance: true });
  assert.ok((await run(w, s, approvals)).ok);
  clean(w);
});

/** A nonce store that runs `after` once the first check has passed (every approval verified), then once more when the approvals are consumed. */
function watchedNonces(real: NonceStore, hooks: { afterFirstHas?: () => void; afterConsume?: () => void }): NonceStore {
  let first = true;
  return {
    has: (nonce) => { const seen = real.has(nonce); if (first) { first = false; hooks.afterFirstHas?.(); } return seen; },
    consumeAll: (entries) => { const ok = real.consumeAll(entries); hooks.afterConsume?.(); return ok; },
  };
}

test("the kill switch appearing after the approvals were consumed and before the engine spawns: a distinct refusal, no outcome, approvals spent, artifact given back", async () => {
  const w = world();
  const s = await seal(w, "DEV");
  const approvals = [approval(s.sealed, "alice")];
  const real = w.deps.nonces!;
  const deps = { ...forEnv(w, "DEV"), nonces: watchedNonces(real, { afterConsume: () => writeFileSync(KILL, "stop") }) };
  const result = await runApply(requestFor(s, approvals), deps);
  refused(result, "KILL_SWITCH_AFTER_APPROVALS");
  assert.equal((result as { outcome?: string }).outcome, undefined, "the engine never ran, so there is no outcome");
  assert.match((result as { message: string }).message, /new approvals/i);
  assert.equal(applyCalls().length, 0);
  assert.ok(!existsSync(ledgerOf(w, s)), "the reservation was released: nothing ran");
  assert.deepEqual(consumeApprovals(real, approvals), { ok: false, code: "APPROVAL_REPLAYED", message: "An approval was already used." }, "the approvals are spent");
  clean(w);
});

// --- everything that can change while the engine is prepared is read again before the approvals are consumed

const rewriteContract = (w: World, over: Record<string, unknown>) => writePinnedContract(w.contractPath, contractJson(KILL, over));

test("the contract, the allowlist and approval expiry are checked again right before the approvals are consumed", async () => {
  const cases: Array<[string, string, (w: World) => void]> = [
    ["ACT_DISABLED", "the contract stops enabling ACT", (w) => rewriteContract(w, { enabled: false })],
    ["APPROVER_NOT_ALLOWED", "the approver leaves the allowlist", (w) => rewriteContract(w, { approvers: approvers.filter((entry) => entry.id !== "alice") })],
    ["CONTRACT_INVALID", "the contract no longer matches its pin", (w) => writeFileSync(w.contractPath, JSON.stringify(contractJson(KILL, { maxApprovalAgeMinutes: 61 })))],
    ["KILL_SWITCH_ACTIVE", "the kill switch appears", () => writeFileSync(KILL, "stop")],
  ];
  for (const [code, label, change] of cases) {
    const w = world();
    const s = await seal(w, "DEV");
    const approvals = [approval(s.sealed, "alice")];
    const real = w.deps.nonces!;
    const result = await runApply(requestFor(s, approvals), { ...forEnv(w, "DEV"), nonces: watchedNonces(real, { afterFirstHas: () => change(w) }) });
    refused(result, code);
    assert.equal(applyCalls().length, 0, label);
    assert.ok(!existsSync(ledgerOf(w, s)), label + ": the reservation was released");
    assert.deepEqual(consumeApprovals(real, approvals), { ok: true }, label + ": nothing was consumed");
    rmSync(KILL, { force: true });
    clean(w);
  }
  // Expiry: the clock moves past the approval's window while the engine is prepared.
  const w = world();
  const s = await seal(w, "DEV");
  const approvals = [approval(s.sealed, "alice")];
  let late = false;
  const real = w.deps.nonces!;
  const result = await runApply(requestFor(s, approvals), {
    ...forEnv(w, "DEV"), now: () => late ? new Date(NOW.getTime() + 3 * 3_600_000) : NOW, nonces: watchedNonces(real, { afterFirstHas: () => { late = true; } }),
  });
  refused(result, "APPROVAL_EXPIRED");
  assert.equal(applyCalls().length, 0);
  assert.ok(!existsSync(ledgerOf(w, s)));
  assert.deepEqual(consumeApprovals(real, approvals), { ok: true });
});

// --- the ledger: reserve before the engine, finalize after ----------------------------------

test("the artifact is reserved while the engine runs: another run with different approvals is refused and consumes nothing", async () => {
  const w = world();
  const s = await seal(w, "DEV");
  const held = await startHeldApply(w, s, [approval(s.sealed, "alice")]);
  assert.ok(existsSync(ledgerOf(w, s)), "reserved before and during the engine");
  assert.equal(requireNotApplied(s.sealed.artifactSha256, w.dirs.evidence).ok, false);
  const bob = [approval(s.sealed, "bob")];
  refused(await run(w, s, bob), "ARTIFACT_ALREADY_APPLIED");
  assert.equal(applyCalls().length, 1);
  assert.deepEqual(consumeApprovals(w.deps.nonces!, bob), { ok: true }, "the refused run consumed none of its approvals");
  held.release();
  assert.ok((await held.running).ok);
  assert.equal(await storedOutcome(w, s), "SUCCEEDED", "the reservation became the evidence");
});

test("two concurrent runs with different approval sets: exactly one reaches the engine", async () => {
  const w = world();
  behave({ applyAdvance: true });
  const s = await seal(w, "DEV");
  const [a, b] = await Promise.all([run(w, s, [approval(s.sealed, "alice")]), run(w, s, [approval(s.sealed, "bob")])]);
  assert.equal([a, b].filter((r) => r.ok).length, 1, JSON.stringify([a, b]));
  const loser = [a, b].find((r) => !r.ok)!;
  refused(loser, "ARTIFACT_ALREADY_APPLIED");
  assert.equal(applyCalls().length, 1);
  clean(w);
});

test("a crash after the reservation leaves the artifact reserved: never silently re-applicable", async () => {
  let explode = false;
  const w = world({ now: () => { if (explode) throw new Error("crash"); return NOW; } });
  const s = await seal(w, "DEV");
  const held = await startHeldApply(w, s, [approval(s.sealed, "alice")]);
  explode = true; // the clock fails when the run goes to write its evidence
  held.release();
  await assert.rejects(held.running, /crash/);
  explode = false;
  assert.ok(existsSync(ledgerOf(w, s)), "the reservation is still there");
  const stored = await readEncryptedEvidence<{ state?: string }>(ledgerOf(w, s));
  assert.equal(stored.state, "RESERVED");
  const again = applyCalls().length;
  refused(await run(w, s, [approval(s.sealed, "bob")]), "ARTIFACT_ALREADY_APPLIED");
  assert.equal(applyCalls().length, again);
  // A reservation is not evidence of a successful DEV apply.
  const qa = await seal(w, "QA", writeProject(fresh("project"), QA_TARGET));
  refused(await run(w, qa, [approval(qa.sealed, "alice")]), "PROMOTION_EVIDENCE_MISSING");
});

test("a step that fails before the engine runs gives the artifact back, and the same approvals work after", async () => {
  const w = world();
  const s = await seal(w, "DEV");
  const approvals = [approval(s.sealed, "alice")];
  behave({ failOn: "init" });
  const failed = await run(w, s, approvals);
  refused(failed, "APPLY_FAILED");
  assert.match((failed as { message: string }).message, /EXIT_1/);
  assert.ok(!existsSync(ledgerOf(w, s)));
  behave({ applyAdvance: true });
  assert.ok((await run(w, s, approvals)).ok);
});

test("the evidence failing after the apply still reports the outcome, leaves the artifact reserved and no scratch", async () => {
  const w = world();
  const s = await seal(w, "DEV");
  const held = await startHeldApply(w, s, [approval(s.sealed, "alice")]);
  rmSync(ledgerOf(w, s)); // the ledger entry vanishes under the run
  held.release();
  const result = await held.running;
  refused(result, "EVIDENCE_REJECTED");
  assert.equal((result as { outcome?: string }).outcome, "SUCCEEDED");
  assert.match((result as { message: string }).message, /record that by hand/);
  clean(w);
});

// --- the sealed plan is verified again by the driver ------------------------------------------

test("a change list edited after sealing is ARTIFACT_TAMPERED: it is bound into the artifact hash", async () => {
  const w = world();
  const s = await seal(w, "DEV");
  const approvals = [approval(s.sealed, "alice")];
  const edited: Sealed["loaded"] = { sealed: { ...s.loaded.sealed, changes: s.loaded.sealed.changes.map((c) => ({ ...c, action: "DELETE" })) }, planBytes: s.loaded.planBytes };
  refused(await run(w, s, approvals, { sealedPlan: edited }), "ARTIFACT_TAMPERED");
  const dropped: Sealed["loaded"] = { sealed: { ...s.loaded.sealed, changes: [] }, planBytes: s.loaded.planBytes };
  refused(await run(w, s, approvals, { sealedPlan: dropped }), "ARTIFACT_TAMPERED");
  assert.equal(calls().filter((c) => c.args[0] !== "plan" && c.args[0] !== "show" && c.args[0] !== "version" && c.args[0] !== "init" && c.args[0] !== "workspace").length, 0);
  assert.ok(!existsSync(ledgerOf(w, s)));
});

test("an already-loaded sealed plan is trusted for nothing: swapped plan bytes and a hash recomputed by the caller are caught", async () => {
  const w = world();
  const s = await seal(w, "DEV");
  const approvals = [approval(s.sealed, "alice")];
  refused(await run(w, s, approvals, { sealedPlan: { sealed: s.loaded.sealed, planBytes: Buffer.from("a different plan") } }), "ARTIFACT_TAMPERED");
  refused(await run(w, s, approvals, { sealedPlan: { sealed: { ...s.loaded.sealed, planSha256: H("a") }, planBytes: s.loaded.planBytes } }), "ARTIFACT_TAMPERED");
  refused(await run(w, s, approvals, { sealedPlan: { ...s.loaded, sealed: { ...s.loaded.sealed, artifactSha256: undefined as never } } }), "ARTIFACT_INVALID");
  for (const garbage of [undefined, null, {}, "x", { sealed: {}, planBytes: Buffer.alloc(0) }]) {
    refused(await run(w, s, approvals, { sealedPlan: garbage as never }), "ARTIFACT_INVALID");
  }
  assert.equal(applyCalls().length, 0);
});

test("the change list is derived again from the decrypted plan: a record that does not describe it is ARTIFACT_TAMPERED, and nothing is consumed", async () => {
  const w = world();
  const s = await seal(w, "DEV");
  const approvals = [approval(s.sealed, "alice")];
  behave({ showExtra: true }); // the plan now shows a resource the sealed record never listed
  const before = calls().length;
  const result = await run(w, s, approvals);
  refused(result, "ARTIFACT_TAMPERED");
  assert.match((result as { message: string }).message, /change list/i);
  assert.equal(applyCalls().length, 0);
  assert.ok(calls().slice(before).some((c) => c.args[0] === "show"), "it was derived with the pinned show");
  assert.ok(!existsSync(ledgerOf(w, s)));
  clean(w);
  // The same plan, listed truthfully, applies with the very same approvals: none was consumed.
  behave({ applyAdvance: true });
  const again = await run(w, s, approvals);
  assert.ok(again.ok, JSON.stringify(again));
});

test("a plan that cannot be shown stops before the approvals are consumed", async () => {
  const w = world();
  const s = await seal(w, "DEV");
  const approvals = [approval(s.sealed, "alice")];
  behave({ failOn: "show", failStderr: "leak " + VALUE_CANARY });
  const result = await run(w, s, approvals);
  refused(result, "APPLY_FAILED");
  noMessage(result);
  assert.equal(applyCalls().length, 0);
  assert.ok(!existsSync(ledgerOf(w, s)));
  assert.deepEqual(consumeApprovals(w.deps.nonces!, approvals), { ok: true });
});

// --- identities, qualification and the backend configuration ---------------------------------------

test("identity gate: a credential for another tenant or subscription, or one naming none, cannot apply", async () => {
  const w = world();
  const s = await seal(w, "DEV");
  const approvals = [approval(s.sealed, "alice")];
  const mismatch = async (env: NodeJS.ProcessEnv) => refused(await runApply(requestFor(s, approvals), { ...w.deps, env }), "IDENTITY_TARGET_MISMATCH");
  await mismatch({ ...ENV, ALZ_APPLY_ARM_SUBSCRIPTION_ID: PROD_TARGET.account });
  await mismatch({ ...ENV, ALZ_STATE_WRITE_ARM_TENANT_ID: "99999999-9999-4999-8999-999999999999" });
  const { ALZ_APPLY_ARM_SUBSCRIPTION_ID: _omitted, ...noSubscription } = ENV;
  await mismatch(noSubscription as NodeJS.ProcessEnv);
  assert.equal(applyCalls().length, 0);
  assert.ok(!existsSync(ledgerOf(w, s)));
});

test("identity gate: a variable for an identity this system never reads, or a collapsed pair, is refused", async () => {
  const w = world();
  const s = await seal(w, "DEV");
  const approvals = [approval(s.sealed, "alice")];
  const forbidden = await runApply(requestFor(s, approvals), { ...w.deps, env: { ...ENV, ALZ_DEPLOY_ARM_CLIENT_SECRET: "x-deploy-secret" } });
  refused(forbidden, "IDENTITY_NOT_CONFIGURED");
  assert.match((forbidden as { message: string }).message, /ALZ_DEPLOY_ARM_CLIENT_SECRET/);
  assert.ok(!(forbidden as { message: string }).message.includes("x-deploy-secret"), "names, never values");
  refused(await runApply(requestFor(s, approvals), { ...w.deps, env: { ...ENV, ALZ_APPLY_ARM_CLIENT_SECRET: ENV.ALZ_STATE_ARM_CLIENT_SECRET } }), "IDENTITY_COLLAPSED");
  assert.equal(applyCalls().length, 0);
});

test("qualification comes only from valid evidence in the vault: an empty vault, junk, evidence under the wrong hash or another adapter's evidence does not activate apply", async () => {
  const w = world();
  const s = await seal(w, "DEV");
  const approvals = [approval(s.sealed, "alice")];
  const junk = fresh("junk-vault");
  writeFileSync(join(junk, H("e") + ".qualification.evidence"), "not json");
  writeFileSync(join(junk, "not-a-hash.qualification.evidence"), "{}");
  const misnamed = fresh("misnamed-vault");
  for (const name of readdirSync(applyOnlyVault)) writeFileSync(join(misnamed, H("e") + ".qualification.evidence"), readFileSync(join(applyOnlyVault, name)));
  for (const qualificationDir of [fresh("empty-vault"), join(root, "no-such-vault"), junk, misnamed, previewOnlyVault]) {
    refused(await runApply(requestFor(s, approvals), { ...w.deps, qualificationDir }), "ENGINE_NOT_QUALIFIED");
  }
  assert.equal(applyCalls().length, 0);
  assert.ok(!existsSync(ledgerOf(w, s)));
});

test("a STATE_WRITE identity that cannot be written into a backend configuration stops before any engine step that changes state", async () => {
  const w = world();
  const s = await seal(w, "DEV");
  const approvals = [approval(s.sealed, "alice")];
  const { ALZ_STATE_WRITE_ARM_OIDC_TOKEN_FILE: _token, ...noToken } = ENV;
  // A client id other than the attested one is refused earlier still: it can never match qualification evidence.
  for (const [env, code, message] of [
    [noToken, "APPLY_FAILED", /STATE_WRITE_BACKEND_CONFIG_INVALID/], [{ ...ENV, ALZ_STATE_WRITE_ARM_OIDC_TOKEN_FILE: '/run/x"\nbackend = "evil' }, "APPLY_FAILED", /STATE_WRITE_BACKEND_CONFIG_INVALID/],
    [{ ...ENV, ALZ_STATE_WRITE_ARM_CLIENT_ID: 'id"${evil}' }, "ENGINE_NOT_QUALIFIED", /client ids/],
  ] as const) {
    const before = calls().length;
    const result = await runApply(requestFor(s, approvals), { ...w.deps, env: env as NodeJS.ProcessEnv });
    refused(result, code);
    assert.match((result as { message: string }).message, message);
    assert.ok(!calls().slice(before).some((c) => c.args[0] === "init" || c.args[0] === "apply"), "init never ran with a malformed configuration");
    assert.ok(!existsSync(ledgerOf(w, s)));
  }
  clean(w);
});

test("an ALZ_APPLY_ or ALZ_STATE_WRITE_ variable that redirects provider installation is refused, and the apply never starts", async () => {
  const w = world();
  const s = await seal(w, "DEV");
  const approvals = [approval(s.sealed, "alice")];
  for (const name of ["ALZ_APPLY_TF_CLI_CONFIG_FILE", "ALZ_STATE_WRITE_TF_CLI_CONFIG_FILE", "ALZ_APPLY_TF_PLUGIN_CACHE_DIR", "ALZ_STATE_WRITE_TF_PLUGIN_CACHE_DIR"]) {
    const result = await runApply(requestFor(s, approvals), { ...w.deps, env: { ...ENV, [name]: "/tmp/evil-mirror.tfrc" } as NodeJS.ProcessEnv });
    refused(result, "APPLY_FAILED");
    assert.match((result as { message: string }).message, /ENVIRONMENT_REFUSED/, name);
    assert.equal(applyCalls().length, 0, name);
    assert.ok(!existsSync(ledgerOf(w, s)), name);
  }
  // The same variable through the preview profile is still passed: the restriction is the apply path's alone.
  const preview = runBoundedProcess("terraform_plan", "node", ["-e", "process.stdout.write(process.env.TF_CLI_CONFIG_FILE || 'absent')"], root, {
    profile: { ...TERRAFORM_APPLY_PROFILE, injectable: [...TERRAFORM_APPLY_PROFILE.injectable, "TF_CLI_CONFIG_FILE"] },
    env: { ALZ_DISCOVERY_TF_CLI_CONFIG_FILE: "/x.tfrc" }, toolDirs: [join(process.execPath, "..")],
  });
  assert.equal(preview.stdout, "/x.tfrc");
  clean(w);
});

// --- the runner leaks nothing from a failed apply step ----------------------------------------------

test("a failed apply step's stderr never reaches the debug diagnostics, while other callers keep their detail", async () => {
  const PLANTED = "PLANTED_SECRET_zq81_in_engine_stderr";
  for (const behavior of [{ failOn: "init", failStderr: "Error: " + PLANTED }, { applyExit: 1, applyStderr: "Error: " + PLANTED }] as Behavior[]) {
    const w = world();
    const s = await seal(w, "DEV");
    behave(behavior);
    const outcome = await withDebugDiagnosticContext("apply-leak", async () => run(w, s, [approval(s.sealed, "alice")]));
    assert.equal(outcome.value.ok, false);
    assert.ok(outcome.events.some((e) => e.component === "allowlisted-process" && e.status === "FAILED"), "the failure was reported");
    assert.ok(!JSON.stringify(outcome).includes(PLANTED), "the diagnostics are free of engine stderr");
  }
  const plain = await withDebugDiagnosticContext("other", async () => runBoundedProcess("terraform_plan", "node",
    ["-e", `process.stderr.write("visible-detail"); process.exit(1)`], root, { profile: TERRAFORM_APPLY_PROFILE, env: {}, toolDirs: [join(process.execPath, "..")] }));
  assert.ok(plain.events.some((e) => e.detail?.includes("visible-detail")), "the default is unchanged");
  const quiet = await withDebugDiagnosticContext("quiet", async () => runBoundedProcess("terraform_plan", "node",
    ["-e", `process.stderr.write("visible-detail"); process.exit(1)`], root, { profile: TERRAFORM_APPLY_PROFILE, env: {}, toolDirs: [join(process.execPath, "..")], suppressDetail: true }));
  assert.ok(quiet.events.every((e) => e.detail === undefined));
});

// --- cleanup --------------------------------------------------------------------------------------------

test("the plaintext plan is removed at once when cleanups run mid-apply (the SIGINT/SIGTERM handlers' path)", async () => {
  const w = world();
  const s = await seal(w, "DEV");
  const held = await startHeldApply(w, s, [approval(s.sealed, "alice")]);
  const planDir = applyCalls()[0].planDir!;
  assert.ok(existsSync(join(planDir, "alz-apply.tfplan")), "the decrypted plan exists while the engine runs");
  assert.equal(runCleanups(), 0);
  assert.ok(!existsSync(join(planDir, "alz-apply.tfplan")), "gone before the handler's process exits");
  assert.deepEqual(readdirSync(w.dirs.scratch), []);
  held.release();
  await held.running; // the run ends however it ends; the point is that nothing readable outlived the handler
  clean(w);
});

// --- the denial path, in order ----------------------------------------------------------

test("every refusal comes in the specified order, and the apply argv is never executed by any of them", async () => {
  const w = world();
  behave();
  const devSeal = await seal(w, "DEV");
  const qaSeal = await seal(w, "QA");
  const prodSeal = await seal(w, "PROD");
  rmSync(w.contractPath); // 1. no contract
  const prodApprovals = () => [approval(prodSeal.sealed, "alice"), approval(prodSeal.sealed, "bob")];
  let request = requestFor(prodSeal, prodApprovals());
  const prodDeps = forEnv(w, "PROD");
  const step = async (code: string, req: ApplyRequest = request, deps: ApplyDeps = prodDeps) => {
    refused(await runApply(req, deps), code);
    assert.equal(applyCalls().length, 0, "refused with " + code + " but the engine ran apply");
    clean(w);
  };

  await step("ACT_DISABLED"); // 1. no contract
  writePinnedContract(w.contractPath, { ...contractJson(KILL), force: true });
  await step("CONTRACT_INVALID"); // 1. a contract that is not one
  writePinnedContract(w.contractPath, contractJson(KILL));
  writeFileSync(KILL, "stop");
  await step("KILL_SWITCH_ACTIVE"); // 2.
  rmSync(KILL);
  await step("HUMAN_INVOCATION_REQUIRED", { ...request, invocation: undefined as never }); // 3.
  const wrongTarget = { ...PROD_TARGET, workspace: "other" };
  await step("TARGET_NOT_IN_CONTRACT", { ...request, target: wrongTarget, invocation: human(wrongTarget) }); // 4.
  await step("ARTIFACT_INVALID", { ...request, sealedPlan: undefined as never }); // 5.
  await step("SOURCE_UNVERIFIED", request, { ...prodDeps, sourceCommit: undefined }); // 5. no product commit, or not a full one
  await step("SOURCE_UNVERIFIED", request, { ...prodDeps, sourceCommit: "HEAD" });
  await step("SOURCE_CHANGED", request, { ...prodDeps, sourceCommit: "1".repeat(40) }); // 5. another commit than the one that sealed it
  const evidence: ApplyEvidence = {
    schemaVersion: 1, environment: "PROD", target: prodSeal.sealed.target, artifactSha256: prodSeal.sealed.artifactSha256,
    manifestHash: prodSeal.sealed.manifestHash, releaseIdentity: prodSeal.sealed.releaseIdentity, contractSha256: prodSeal.sealed.contractSha256, sourceCommit: prodSeal.sealed.sourceCommit,
    approvals: [{ approverId: "alice", issuedAt: NOW.toISOString() }],
    adapter: { adapterVersion: APPLY_ADAPTER.adapterVersion, argvDigest: APPLY_ADAPTER.argvDigest },
    toolVersions: { engine: "1.9.5" }, outcome: "SUCCEEDED", exitCode: 0, startedAt: NOW.toISOString(), finishedAt: NOW.toISOString(), authority: APPLY_AUTHORITY,
  };
  assert.ok((await recordApplied(evidence, w.dirs.evidence)).ok);
  await step("ARTIFACT_ALREADY_APPLIED"); // 6.
  rmSync(ledgerOf(w, prodSeal));
  await step("PROMOTION_EVIDENCE_MISSING"); // 7. PROD, and no successful QA apply for this release yet
  await step("PROMOTION_EVIDENCE_MISSING", requestFor(qaSeal, [approval(qaSeal.sealed, "alice")]), forEnv(w, "QA")); // 7. QA, and no successful DEV apply either

  behave({ applyAdvance: true });
  assert.ok((await run(w, devSeal, [approval(devSeal.sealed, "alice")])).ok);
  assert.equal(applyCalls().length, 1);
  let baseline = applyCalls().length;
  assert.equal(baseline, 1);
  const step2 = async (code: string, req: ApplyRequest, deps: ApplyDeps = prodDeps) => {
    refused(await runApply(req, deps), code);
    assert.equal(applyCalls().length, baseline, "refused with " + code + " but the engine ran apply");
    assert.ok(!existsSync(ledgerOf(w, prodSeal)), "nothing was reserved by " + code);
    clean(w);
  };
  await step2("PROMOTION_EVIDENCE_MISSING", request); // 7. PROD does not accept a DEV apply alone
  assert.ok((await run(w, qaSeal, [approval(qaSeal.sealed, "alice")])).ok);
  baseline = applyCalls().length;
  assert.equal(baseline, 2);
  await step2("APPROVAL_INSUFFICIENT", requestFor(prodSeal, [approval(prodSeal.sealed, "alice")])); // 8.
  request = requestFor(prodSeal, prodApprovals());
  await step2("ENGINE_NOT_QUALIFIED", request, { ...prodDeps, qualificationDir: previewOnlyVault }); // 9. a preview qualification does not activate apply
  const noWriter = Object.fromEntries(Object.entries(identityEnv("PROD")).filter(([key]) => !key.startsWith("ALZ_STATE_WRITE_")));
  await step2("ENGINE_NOT_QUALIFIED", request, { ...prodDeps, env: noWriter }); // 9. no attested STATE_WRITE client id matches the evidence
  const noState = Object.fromEntries(Object.entries(identityEnv("PROD")).filter(([key]) => !key.startsWith("ALZ_STATE_") || key.startsWith("ALZ_STATE_WRITE_")));
  await step2("IDENTITY_NOT_CONFIGURED", request, { ...prodDeps, env: noState }); // 10.
  await step2("IDENTITY_TARGET_MISMATCH", request, { ...prodDeps, env: ENV }); // 10. DEV's credentials do not apply to PROD
  await step2("IDENTITY_TARGET_MISMATCH", request, { ...prodDeps, env: identityEnv("QA") }); // 10. nor do QA's
  assert.ok((await runApply(request, prodDeps)).ok); // all repaired
  assert.equal(applyCalls().length, baseline + 1);
});

test("ACT stays disabled without an enabling contract: a missing file, enabled=false, an unknown field, garbage, an unpinned or tampered contract, or an environment flag", async () => {
  const w = world({ env: { ...ENV, ALZ_ACT_ENABLED: "true", ACT_ENABLED: "1" } as NodeJS.ProcessEnv });
  const s = await seal(w, "DEV");
  process.env.ALZ_ACT_ENABLED = "true";
  try {
    const cases: [string | undefined, string][] = [
      [undefined, "ACT_DISABLED"], [JSON.stringify(contractJson(KILL, { enabled: false })), "ACT_DISABLED"],
      [JSON.stringify({ ...contractJson(KILL), force: true }), "CONTRACT_INVALID"], ["not json", "CONTRACT_INVALID"],
    ];
    for (const [contract, code] of cases) {
      rmSync(w.contractPath, { force: true });
      if (contract !== undefined) writeFileSync(w.contractPath, contract);
      refused(await runApply(requestFor(s, [approval(s.sealed, "alice")]), w.deps), code);
    }
    writePinnedContract(w.contractPath, contractJson(KILL));
    rmSync(pinPathOf(w.contractPath));
    refused(await runApply(requestFor(s, [approval(s.sealed, "alice")]), w.deps), "ACT_DISABLED"); // unpinned
    writePinnedContract(w.contractPath, contractJson(KILL));
    writeFileSync(w.contractPath, JSON.stringify(contractJson(KILL, { maxApprovalAgeMinutes: 600 }))); // edited after the pin
    refused(await runApply(requestFor(s, [approval(s.sealed, "alice")]), w.deps), "CONTRACT_INVALID");
  } finally { delete process.env.ALZ_ACT_ENABLED; }
  assert.equal(applyCalls().length, 0);
});

test("agent-initiated requests are refused: no invocation, a non-interactive one, a mismatched confirmation or a forged operator id", async () => {
  const w = world();
  const s = await seal(w, "DEV");
  const good = requestFor(s, [approval(s.sealed, "alice")]);
  const before = calls().length;
  const forged: unknown[] = [
    undefined, null, {}, { ...good.invocation, interactiveSession: false }, { ...good.invocation, interactiveSession: "true" },
    { ...good.invocation, operatorId: "" }, { ...good.invocation, operatorId: "a b;rm -rf" }, { ...good.invocation, confirmedAt: "never" },
    { ...good.invocation, confirmedTarget: { ...DEV_TARGET, backend: "other/x/y" } }, { ...good.invocation, confirmedTarget: undefined },
  ];
  for (const invocation of forged) {
    refused(await runApply({ ...good, invocation: invocation as never }, w.deps), "HUMAN_INVOCATION_REQUIRED");
  }
  assert.equal(calls().length, before, "the engine never ran");
  assert.deepEqual(consumeApprovals(w.deps.nonces!, [approval(s.sealed, "bob")]), { ok: true }, "nothing was consumed by the refusals");
});

test("a sealed plan sealed for another environment, or whose manifest differs, is refused before approvals are read", async () => {
  const w = world();
  const s = await seal(w, "DEV");
  const approvals = [approval(s.sealed, "alice")];
  // A different environment's sealed plan, requested as DEV.
  const prod = await seal(w, "PROD");
  const before = calls().length;
  refused(await run(w, s, approvals, { sealedPlan: prod.loaded }), "ARTIFACT_INVALID");
  // A manifest that is not the sealed one (an edited project).
  const edited = writeProject(fresh("project"), DEV_TARGET, 'resource "azurerm_resource_group" "other" {}\n');
  refused(await run(w, s, approvals, { manifest: edited.manifest, projectRoot: edited.projectRoot }), "ARTIFACT_TAMPERED");
  // The project changed on disk after sealing: the snapshot cannot be made, so nothing runs.
  writeFileSync(join(s.project.projectRoot, "main.tf"), 'resource "azurerm_resource_group" "changed" {}\n');
  refused(await run(w, s, approvals), "ARTIFACT_TAMPERED");
  assert.equal(calls().length, before, "no engine step ran for any of them");
  assert.ok(!existsSync(ledgerOf(w, s)), "the reservation was given back");
  clean(w);
});

test("approval failures: unsigned, wrong key, wrong artifact, wrong target, expired, wrong environment approver, same approver twice", async () => {
  const w = world();
  const s = await seal(w, "DEV");
  const base = approval(s.sealed, "alice");
  const cases: [string, SignedApproval[]][] = [
    ["APPROVAL_INSUFFICIENT", []],
    ["APPROVAL_UNVERIFIED", [{ statement: base.statement, signatureBase64: "" }]],
    ["APPROVAL_UNVERIFIED", [signApproval(base.statement, keys.mallory.priv)]],
    ["APPROVER_NOT_ALLOWED", [signApproval({ ...base.statement, approverId: "mallory" }, keys.mallory.priv)]],
    ["APPROVAL_MISBOUND", [approval(s.sealed, "alice", { artifactSha256: H("9") })]],
    ["APPROVAL_MISBOUND", [approval(s.sealed, "alice", { target: { ...s.sealed.target, workspace: "other" } })]],
    ["APPROVAL_MISBOUND", [approval(s.sealed, "alice", { environment: "PROD" })]],
    ["APPROVAL_MISBOUND", [approval(s.sealed, "alice", { environment: "QA" })]],
    ["APPROVAL_EXPIRED", [approval(s.sealed, "alice", { issuedAt: new Date(NOW.getTime() - 50 * 60_000).toISOString(), expiresAt: new Date(NOW.getTime() - 10 * 60_000).toISOString() })]],
    ["SAME_APPROVER_TWICE", [approval(s.sealed, "alice"), approval(s.sealed, "alice")]],
  ];
  for (const [code, approvals] of cases) {
    refused(await run(w, s, approvals), code);
  }
  assert.equal(applyCalls().length, 0);
  assert.ok(!existsSync(ledgerOf(w, s)));
});

test("PROD needs two distinct verified approvals from the contract's allowlist, and QA at least one", async () => {
  const lax = world({}, contractJson(KILL, { requiredApprovals: { DEV: 1, QA: 1, PROD: 1 } }));
  const noQa = world({}, contractJson(KILL, { requiredApprovals: { DEV: 1, QA: 0, PROD: 2 } }));
  const w = world();
  behave({ applyAdvance: true });
  await promoteTo(w, "DEV");
  const qa = await sealShared(w, "QA");
  // QA needs an approver the contract allows for QA: carol is DEV only.
  refused(await run(w, qa, [approval(qa.sealed, "carol")]), "APPROVER_NOT_ALLOWED");
  refused(await run(w, qa, []), "APPROVAL_INSUFFICIENT");
  refused(await runApply(requestFor(qa, [approval(qa.sealed, "alice")]), forEnv(noQa, "QA")), "CONTRACT_INVALID"); // fewer than one QA approval is not a contract
  assert.ok((await run(w, qa, [approval(qa.sealed, "alice")])).ok);
  const prod = await sealShared(w, "PROD");
  refused(await run(w, prod, [approval(prod.sealed, "alice")]), "APPROVAL_INSUFFICIENT");
  refused(await run(w, prod, [approval(prod.sealed, "alice"), approval(prod.sealed, "alice")]), "SAME_APPROVER_TWICE");
  refused(await run(w, prod, [approval(prod.sealed, "alice"), approval(prod.sealed, "carol")]), "APPROVER_NOT_ALLOWED"); // carol is DEV only
  // An approval signed for QA is not one for PROD, and the reverse.
  refused(await run(w, prod, [approval(qa.sealed, "alice"), approval(qa.sealed, "bob")]), "APPROVAL_MISBOUND");
  refused(await run(w, prod, [approval(prod.sealed, "alice", { environment: "QA" }), approval(prod.sealed, "bob", { environment: "QA" })]), "APPROVAL_MISBOUND");
  // A contract that asks for fewer than two PROD approvals is not a contract.
  refused(await runApply(requestFor(prod, [approval(prod.sealed, "alice")]), forEnv(lax, "PROD")), "CONTRACT_INVALID");
  assert.equal(applyCalls().length, 2, "only the DEV and QA applies ran");
});

// --- the path from dev to production ------------------------------------------------------

test("fixture path: seal and apply DEV, then QA, then PROD, each a separate plan bound to the same release with its own approvals", async () => {
  const w = world();
  behave({ applyAdvance: true });
  const dev = await sealShared(w, "DEV");
  const qa = await sealShared(w, "QA");
  const prod = await sealShared(w, "PROD");
  const all = [dev, qa, prod];
  assert.equal(new Set(all.map((x) => x.sealed.manifestHash)).size, 3, "manifests are target-bound and differ");
  assert.equal(new Set(all.map((x) => x.sealed.releaseIdentity)).size, 1, "the qualified release is the same");
  assert.equal(new Set(all.map((x) => x.sealed.artifactSha256)).size, 3);

  // Nothing goes out of order: QA cannot go first, and PROD cannot go first.
  refused(await run(w, qa, approvalsFor(qa)), "PROMOTION_EVIDENCE_MISSING");
  refused(await run(w, prod, approvalsFor(prod)), "PROMOTION_EVIDENCE_MISSING");
  // A plan sealed for one environment cannot be applied to another.
  refused(await runApply({ ...requestFor(dev, approvalsFor(dev)), environment: "QA", target: QA_TARGET, invocation: human(QA_TARGET) }, forEnv(w, "QA")), "ARTIFACT_INVALID");
  refused(await runApply({ ...requestFor(qa, approvalsFor(qa)), environment: "PROD", target: PROD_TARGET, invocation: human(PROD_TARGET) }, forEnv(w, "PROD")), "ARTIFACT_INVALID");
  assert.equal(applyCalls().length, 0);

  const devResult = await run(w, dev, approvalsFor(dev));
  assert.ok(devResult.ok, JSON.stringify(devResult));
  // DEV evidence alone does not let PROD through.
  refused(await run(w, prod, approvalsFor(prod)), "PROMOTION_EVIDENCE_MISSING");
  const qaResult = await run(w, qa, approvalsFor(qa));
  assert.ok(qaResult.ok, JSON.stringify(qaResult));
  assert.equal(qaResult.evidence.environment, "QA");
  assert.equal(qaResult.evidence.releaseIdentity, devResult.evidence.releaseIdentity);
  assert.deepEqual(qaResult.evidence.target, QA_TARGET);
  const prodResult = await run(w, prod, approvalsFor(prod));
  assert.ok(prodResult.ok, JSON.stringify(prodResult));
  assert.equal(prodResult.evidence.environment, "PROD");
  assert.equal(prodResult.evidence.releaseIdentity, devResult.evidence.releaseIdentity);
  assert.deepEqual(prodResult.evidence.approvals.map((a) => a.approverId).sort(), ["alice", "bob"]);
  assert.equal(applyCalls().length, 3);
  clean(w);
});

test("QA of a different release than the one DEV applied is refused, and so is PROD of a different release than the one QA applied", async () => {
  const w = world();
  behave({ applyAdvance: true });
  const other = AZURE_BACKEND_TF + 'resource "azurerm_resource_group" "different" {}\n';
  await promoteTo(w, "DEV");
  const qa = await sealShared(w, "QA", other);
  assert.notEqual(qa.sealed.releaseIdentity, (await sealShared(w, "DEV")).sealed.releaseIdentity);
  refused(await run(w, qa, approvalsFor(qa)), "PROMOTION_EVIDENCE_MISSING");
  assert.equal(applyCalls().length, 1);

  // The other release has been through DEV and QA; the shared release only through DEV and QA of its own. PROD of a third release has neither.
  await promoteTo(w, "QA");
  const prodOther = await sealShared(w, "PROD", other);
  refused(await run(w, prodOther, approvalsFor(prodOther)), "PROMOTION_EVIDENCE_MISSING"); // QA applied the shared release, not this one
  const prodThird = await sealShared(w, "PROD", AZURE_BACKEND_TF + 'resource "azurerm_resource_group" "third" {}\n');
  refused(await run(w, prodThird, approvalsFor(prodThird)), "PROMOTION_EVIDENCE_MISSING");
  assert.equal(applyCalls().length, 2);
});

test("a failed DEV or QA apply is not promotion evidence", async () => {
  const w = world();
  // Release A: its DEV apply fails, so QA is refused.
  behave({ applyExit: 1 });
  const devA = await sealShared(w, "DEV");
  refused(await run(w, devA, approvalsFor(devA)), "APPLY_FAILED");
  const qaA = await sealShared(w, "QA");
  refused(await run(w, qaA, approvalsFor(qaA)), "PROMOTION_EVIDENCE_MISSING");
  // Release B: DEV succeeds but its QA apply fails, so PROD is refused.
  const releaseB = SHARED_TF + "# b\n";
  behave({ applyAdvance: true });
  await promoteTo(w, "DEV", releaseB);
  behave({ applyExit: 1 });
  const qaB = await sealShared(w, "QA", releaseB);
  refused(await run(w, qaB, approvalsFor(qaB)), "APPLY_FAILED");
  const prodB = await sealShared(w, "PROD", releaseB);
  refused(await run(w, prodB, approvalsFor(prodB)), "PROMOTION_EVIDENCE_MISSING");
});

test("a contract where QA shares a subscription or a backend with DEV or PROD is not a contract, so nothing is sealed or applied", async () => {
  const base = contractJson(KILL) as { targets: Record<string, { subscriptionId: string; backend: string }> };
  const shared = (key: "subscriptionId" | "backend", from: string) => ({ ...base, targets: { ...base.targets, QA: { ...base.targets.QA, [key]: base.targets[from][key] } } });
  const w = world();
  const s = await seal(w, "QA");
  for (const from of ["DEV", "PROD"]) {
    for (const key of ["subscriptionId", "backend"] as const) {
      const bad = world({}, shared(key, from));
      refused(await runApply(requestFor(s, approvalsFor(s)), forEnv(bad, "QA")), "CONTRACT_INVALID");
      const p = writeProject(fresh("project"), QA_TARGET);
      const sealResult = await sealPreview({ invocation: human(QA_TARGET), environment: "QA", target: QA_TARGET, manifest: p.manifest, projectRoot: p.projectRoot, policyVersion: POLICY, resolved: p.resolved }, forEnv(bad, "QA"));
      assert.ok(!sealResult.ok && sealResult.code === "CONTRACT_INVALID", key + " shared with " + from);
    }
  }
  assert.equal(applyCalls().length, 0);
});

// --- the preview-to-seal entry --------------------------------------------------------------

test("sealing refuses in order: contract, kill switch, human, target, then manifest binding, engine qualification and identities", async () => {
  const w = world();
  rmSync(w.contractPath); // no contract yet
  const p = writeProject(fresh("project"), DEV_TARGET);
  const req = (over: Partial<SealRequest> = {}): SealRequest => ({
    invocation: human(DEV_TARGET), environment: "DEV", target: DEV_TARGET, manifest: p.manifest, projectRoot: p.projectRoot,
    policyVersion: POLICY, resolved: p.resolved, ...over,
  });
  const refuse = async (code: string, r: SealRequest = req(), deps = w.deps) => {
    const result = await sealPreview(r, deps);
    assert.equal(result.ok, false);
    assert.equal((result as { code: string }).code, code, JSON.stringify(result));
    assert.equal(calls().length, 0, "refused with " + code + " but the engine ran");
    clean(w);
  };
  await refuse("ACT_DISABLED");
  writePinnedContract(w.contractPath, contractJson(KILL));
  writeFileSync(KILL, "stop");
  await refuse("KILL_SWITCH_ACTIVE");
  rmSync(KILL);
  await refuse("HUMAN_INVOCATION_REQUIRED", req({ invocation: undefined as never }));
  await refuse("TARGET_NOT_IN_CONTRACT", req({ target: PROD_TARGET, invocation: human(PROD_TARGET) })); // PROD target requested as DEV
  await refuse("IDENTITY_NOT_CONFIGURED", req(), { ...w.deps, env: {} });
  await refuse("IDENTITY_TARGET_MISMATCH", req(), { ...w.deps, env: identityEnv("PROD") });
  await refuse("ENGINE_NOT_QUALIFIED", req(), { ...w.deps, qualificationDir: applyOnlyVault }); // an apply qualification does not activate the preview steps
  const other = writeProject(fresh("project"), DEV_TARGET, 'resource "azurerm_resource_group" "x" {}\n');
  await refuse("ARTIFACT_INVALID", req({ manifest: other.manifest })); // the project is not the manifest's
  await refuse("ARTIFACT_INVALID", req({ resolved: { ...p.resolved, engineVersion: "1.9.6" } }));
  const ok = await sealPreview(req(), w.deps);
  assert.ok(ok.ok, JSON.stringify(ok));
  assert.equal(ok.sealed.environment, "DEV");
  clean(w);
});

// --- qualification: the real-engine run, applying nothing ---------------------------------------

const sealedPlanFiles = (): number => existsSync(join(root, ".runs/evidence/sealed-plan")) ? readdirSync(join(root, ".runs/evidence/sealed-plan")).length : 0;
const qualifyRequest = (p: Project, over: Partial<SealRequest> = {}): SealRequest => ({
  invocation: human(DEV_TARGET), environment: "DEV", target: DEV_TARGET, manifest: p.manifest, projectRoot: p.projectRoot,
  policyVersion: POLICY, resolved: p.resolved, ...over,
});

test("qualifying runs the seal's steps and the apply adapter's init with STATE_WRITE, applies nothing, stores no plan and needs no record", async () => {
  const w = world({ qualificationDir: fresh("empty-vault") });
  behave({ planSalt: "unique-to-this-qualify-run" }); // a plan nothing else sealed, so a stored copy would show as a new file
  const p = writeProject(fresh("project"), DEV_TARGET);
  const stored = sealedPlanFiles();
  const result = await qualifyApply(qualifyRequest(p), w.deps);
  assert.ok(result.ok, JSON.stringify(result));
  assert.equal(result.ok && result.adapters.length, 3, "the preview adapter, the apply adapter and the cleanup adapter");
  assert.ok(result.ok && result.adapters.some((a) => a.adapterVersion === APPLY_ADAPTER.adapterVersion && a.argvDigest === APPLY_ADAPTER.argvDigest));
  assert.equal(applyCalls().length, 0, "nothing is applied");
  const names = calls().map((c) => c.args[0] + (c.args[1] === "pull" || c.args[1] === "show" ? " " + c.args[1] : ""));
  assert.ok(names.includes("plan") && names.includes("state pull"));
  const init = calls().filter((c) => c.args[0] === "init");
  assert.equal(init.length, 2, "the seal's init, then the apply adapter's");
  assert.deepEqual(init[1].args, [...APPLY_INIT_ARGV]);
  assert.equal(init[0].env.ARM_CLIENT_ID, "state-client-2");
  assert.equal(init[1].env.ARM_CLIENT_ID, "statewrite-client-3");
  assert.match(init[1].backendConfig ?? "", /client_id = "statewrite-client-3"/);
  assert.ok(!(init[1].backendConfig ?? "").includes("secret"));
  assert.equal(sealedPlanFiles(), stored, "the throwaway plan is not stored, so it can never be approved");
  assert.deepEqual(readdirSync(w.dirs.scratch), [], "scratch is removed");
});

test("qualifying refuses without a pinned enabling contract, in QA or PROD, with a kill switch, a collapsed identity or a failing engine", async () => {
  const p = writeProject(fresh("project"), DEV_TARGET);
  const w = world();
  const refused = async (code: string, request: SealRequest, deps: ApplyDeps) => {
    const result = await qualifyApply(request, deps);
    assert.ok(!result.ok && result.code === code, code + " " + JSON.stringify(result));
    assert.equal(applyCalls().length, 0);
  };
  await refused("ARTIFACT_INVALID", qualifyRequest(p, { environment: "PROD", target: PROD_TARGET, invocation: human(PROD_TARGET) }), w.deps);
  await refused("ARTIFACT_INVALID", qualifyRequest(p, { environment: "QA", target: QA_TARGET, invocation: human(QA_TARGET) }), w.deps);
  rmSync(pinPathOf(w.contractPath));
  await refused("ACT_DISABLED", qualifyRequest(p), w.deps);
  const k = world();
  writeFileSync(KILL, "stop");
  await refused("KILL_SWITCH_ACTIVE", qualifyRequest(p), k.deps);
  rmSync(KILL);
  await refused("HUMAN_INVOCATION_REQUIRED", qualifyRequest(p, { invocation: undefined as never }), k.deps);
  await refused("IDENTITY_COLLAPSED", qualifyRequest(p), { ...k.deps, env: { ...ENV, ALZ_APPLY_ARM_CLIENT_ID: ENV.ALZ_STATE_WRITE_ARM_CLIENT_ID } });
  behave({ failOn: "workspace", failStderr: "leak " + VALUE_CANARY });
  const failed = await qualifyApply(qualifyRequest(p), k.deps);
  assert.ok(!failed.ok && !JSON.stringify(failed).includes(VALUE_CANARY));
});

test("seal and apply take their records from the vault: valid evidence qualifies, an empty vault does not", async () => {
  const w = world();
  const s = await seal(w, "DEV");
  const done = await run(w, s, [approval(s.sealed, "alice")]);
  assert.ok(done.ok, JSON.stringify(done));
  const empty = world({ qualificationDir: fresh("empty-vault") });
  const p = writeProject(fresh("project"), DEV_TARGET);
  const refused = await sealPreview({
    invocation: human(DEV_TARGET), environment: "DEV", target: DEV_TARGET, manifest: p.manifest, projectRoot: p.projectRoot, policyVersion: POLICY, resolved: p.resolved,
  }, empty.deps);
  assert.ok(!refused.ok && refused.code === "ENGINE_NOT_QUALIFIED");
});

// --- the contract binds the backend and the provider, and a spent failure is defined ----------------------

/** The refusal leaves nothing consumed and nothing reserved: no apply ran, the ledger is empty and the same approvals work once the cause is fixed. */
async function nothingSpent(w: World, s: Sealed, approvals: SignedApproval[]): Promise<void> {
  assert.equal(applyCalls().length, 0);
  assert.ok(!existsSync(ledgerOf(w, s)));
  clean(w);
  behave({ applyAdvance: true });
  assert.ok((await run(w, s, approvals)).ok, "the approvals were not consumed");
}

test("the backend init saved must be the contract's storage account, container and key; anything else is TARGET_NOT_IN_CONTRACT before the approvals are consumed", async () => {
  const [account, container, key] = DEV_TARGET.backend.split("/");
  const saved = (config: Record<string, unknown>, type = "azurerm") => ({ type, config: { storage_account_name: account, container_name: container, key, ...config } });
  for (const [label, savedBackend] of [
    ["another storage account", saved({ storage_account_name: "attackerstore" })],
    ["another container", saved({ container_name: "other" })],
    ["another key", saved({ key: "prod.tfstate" })],
    ["the production backend", saved({ storage_account_name: "fixtureprodstore", key: "prod.tfstate" })],
    ["a different backend type", saved({}, "local")],
    ["a non-string field", saved({ key: 7 })],
    ["no config", { type: "azurerm" }],
    // State access is Entra ID only: a saved backend without `use_azuread_auth`, or with anything but `true`, is not the contract's.
    ["Entra ID authorization not saved", saved({ use_azuread_auth: null })],
    ["Entra ID authorization off (a shared key or SAS would be used)", saved({ use_azuread_auth: false })],
    ["Entra ID authorization as a string", saved({ use_azuread_auth: "true" })],
  ] as const) {
    const w = world();
    const s = await seal(w, "DEV");
    const approvals = [approval(s.sealed, "alice")];
    behave({ savedBackend });
    const result = await run(w, s, approvals);
    refused(result, "TARGET_NOT_IN_CONTRACT");
    assert.match((result as { message: string }).message, /BACKEND_NOT_IN_CONTRACT/, label);
    assert.match((result as { message: string }).message, /no approval was consumed/);
    await nothingSpent(w, s, approvals);
  }
  // A backend that cannot be read at all is not a pass either.
  const w = world();
  const s = await seal(w, "DEV");
  const approvals = [approval(s.sealed, "alice")];
  behave({ savedBackend: null });
  const unreadable = await run(w, s, approvals);
  refused(unreadable, "APPLY_FAILED");
  assert.match((unreadable as { message: string }).message, /BACKEND_UNREADABLE/);
  await nothingSpent(w, s, approvals);
});

test("PROD is bound to the PROD backend: the DEV backend is refused there", async () => {
  const w = world();
  behave({ applyAdvance: true });
  const shared = AZURE_BACKEND_TF + 'resource "azurerm_resource_group" "pilot" {}\n';
  const prod = await seal(w, "PROD", writeProject(fresh("project"), PROD_TARGET, shared));
  await promoteTo(w, "DEV", shared);
  await promoteTo(w, "QA", shared);
  const approvals = [approval(prod.sealed, "alice"), approval(prod.sealed, "bob")];
  const [account, container, key] = DEV_TARGET.backend.split("/");
  behave({ savedBackend: { type: "azurerm", config: { storage_account_name: account, container_name: container, key } } });
  const before = applyCalls().length;
  refused(await run(w, prod, approvals), "TARGET_NOT_IN_CONTRACT");
  assert.equal(applyCalls().length, before);
  behave({ applyAdvance: true });
  assert.ok((await run(w, prod, approvals)).ok, "the PROD backend passes");
});

test("qualify refuses a backend that is not the contract's DEV backend", async () => {
  const w = world();
  const p = writeProject(fresh("project"), DEV_TARGET);
  behave({ savedBackend: { type: "azurerm", config: { storage_account_name: "attackerstore", container_name: "tfstate", key: "dev.tfstate" } } });
  const result = await qualifyApply({ invocation: human(DEV_TARGET), environment: "DEV", target: DEV_TARGET, manifest: p.manifest, projectRoot: p.projectRoot, policyVersion: POLICY, resolved: p.resolved }, w.deps);
  assert.ok(!result.ok && /BACKEND_NOT_IN_CONTRACT/.test(result.message), JSON.stringify(result));
});

test("the project's own azurerm backend block is judged before init: a shared key or SAS, another auth path or endpoint, another storage account, Entra ID off or any other attribute is refused and no init runs", async () => {
  const [account, container, key] = DEV_TARGET.backend.split("/");
  const backend = (body: string) => `terraform {\n  backend "azurerm" {\n    storage_account_name = "${account}"\n    container_name = "${container}"\n    key = "${key}"\n    use_oidc = true\n    use_azuread_auth = true\n${body}\n  }\n}\n` + 'resource "azurerm_resource_group" "pilot" {}\n';
  const sealOf = (w: World, mainTf: string) => {
    const p = writeProject(fresh("project"), DEV_TARGET, mainTf);
    return sealPreview({ invocation: human(DEV_TARGET), environment: "DEV", target: DEV_TARGET, manifest: p.manifest, projectRoot: p.projectRoot, policyVersion: POLICY, resolved: p.resolved }, forEnv(w, "DEV"));
  };
  const w = world();
  behave({ applyAdvance: true });
  const fine = await seal(w, "DEV", writeProject(fresh("project"), DEV_TARGET, backend("")));
  assert.ok((await run(w, fine, [approval(fine.sealed, "alice")])).ok, "exactly the contract's settings seal and apply");
  for (const body of [
    '    access_key = "fakekey"', '    sas_token = "?sv=fake"', "    use_msi = true", '    client_secret = "fake"', '    client_certificate_path = "/x.pfx"',
    '    endpoint = "https://attacker.example"', '    metadata_host = "attacker.example"', '    environment = "usgovernment"', '    resource_group_name = "rg"',
    '    oidc_token_file_path = "/run/other-token"', '    client_id = "other-client"',
  ]) {
    behave();
    const result = await sealOf(w, backend(body));
    refused(result, "ARTIFACT_INVALID");
    assert.match((result as { message: string }).message, /BACKEND_BLOCK_NOT_IN_CONTRACT/, body);
    assert.deepEqual(calls().map((c) => c.args[0]), ["version"], "init never ran, so no credential was sent anywhere: " + body);
  }
  // The literals: another storage account, container or key than the contract's, Entra ID or OIDC off, or an expression.
  const other = (mainTf: string) => `terraform {\n  backend "azurerm" {\n${mainTf}\n  }\n}\n` + 'resource "azurerm_resource_group" "pilot" {}\n';
  for (const body of [
    '    storage_account_name = "attackerstore"', '    storage_account_name = "fixtureprodstore"\n    key = "prod.tfstate"', '    container_name = "other"', '    key = "qa.tfstate"',
    "    use_azuread_auth = false", "    use_oidc = false", "    storage_account_name = var.store", '    key = "${var.key}"',
  ]) {
    behave();
    const result = await sealOf(w, other(body));
    refused(result, "ARTIFACT_INVALID");
    assert.match((result as { message: string }).message, /BACKEND_BLOCK_NOT_IN_CONTRACT/, body);
    assert.deepEqual(calls().map((c) => c.args[0]), ["version"], body);
  }
  // A block that leaves Entra ID to the environment is not refused before init, but what init saved is then not the contract's (nothing from the environment is saved).
  behave();
  const unset = await sealOf(w, 'terraform {\n  backend "azurerm" {\n  }\n}\n' + 'resource "azurerm_resource_group" "pilot" {}\n');
  refused(unset, "ARTIFACT_INVALID");
  assert.match((unset as { message: string }).message, /BACKEND_NOT_IN_CONTRACT/);
  assert.ok(calls().some((c) => c.args[0] === "init"), "judged after init, from what init saved");
  // Qualifying walks the same init, so it refuses the same block.
  behave();
  const p = writeProject(fresh("project"), DEV_TARGET, backend('    sas_token = "?sv=fake"'));
  const qualified = await qualifyApply({ invocation: human(DEV_TARGET), environment: "DEV", target: DEV_TARGET, manifest: p.manifest, projectRoot: p.projectRoot, policyVersion: POLICY, resolved: p.resolved }, w.deps);
  assert.ok(!qualified.ok && /BACKEND_BLOCK_NOT_IN_CONTRACT/.test(qualified.message), JSON.stringify(qualified));
  assert.deepEqual(calls().map((c) => c.args[0]), ["version"]);
});

test("a hard-coded provider subscription_id or tenant_id that is not the contract's refuses at seal and at apply; an expression is not judged", async () => {
  const other = "99999999-9999-4999-8999-999999999999";
  const provider = (expressions: Record<string, unknown>) => ({ azurerm: { name: "azurerm", full_name: "registry.terraform.io/hashicorp/azurerm", expressions } });
  // Sealing: nothing is stored.
  const w = world();
  behave({ showProviderConfig: provider({ subscription_id: { constant_value: other } }) });
  const p = writeProject(fresh("project"), DEV_TARGET);
  const sealRefused = await sealPreview({ invocation: human(DEV_TARGET), environment: "DEV", target: DEV_TARGET, manifest: p.manifest, projectRoot: p.projectRoot, policyVersion: POLICY, resolved: p.resolved }, forEnv(w, "DEV"));
  assert.ok(!sealRefused.ok && /PROVIDER_SUBSCRIPTION_NOT_IN_CONTRACT/.test(sealRefused.message), JSON.stringify(sealRefused));
  // Applying: the plan is shown again, and what it shows is judged again.
  for (const [config, code] of [
    [provider({ subscription_id: { constant_value: other } }), /PROVIDER_SUBSCRIPTION_NOT_IN_CONTRACT/],
    [provider({ tenant_id: { constant_value: other } }), /PROVIDER_TENANT_NOT_IN_CONTRACT/],
  ] as const) {
    const w2 = world();
    const s = await seal(w2, "DEV");
    const approvals = [approval(s.sealed, "alice")];
    behave({ showProviderConfig: config });
    const result = await run(w2, s, approvals);
    refused(result, "TARGET_NOT_IN_CONTRACT");
    assert.match((result as { message: string }).message, code);
    await nothingSpent(w2, s, approvals);
  }
  const w3 = world();
  behave({ showProviderConfig: provider({ subscription_id: { references: ["var.subscription_id"] }, tenant_id: { constant_value: TENANT } }), applyAdvance: true });
  const s = await seal(w3, "DEV");
  assert.ok((await run(w3, s, [approval(s.sealed, "alice")])).ok);
});

test("an import, a move, a forget and an output change are sealed, re-derived at apply, and a plan that differs only in one of them is ARTIFACT_TAMPERED", async () => {
  const w = world();
  const extras = {
    showResources: [
      { address: "azurerm_x.imported", type: "azurerm_x", change: { actions: ["no-op"], importing: { id: "/x" } } },
      { address: "azurerm_x.moved", type: "azurerm_x", previous_address: "azurerm_x.old", change: { actions: ["no-op"] } },
    ],
    showOutputChanges: { endpoint: { actions: ["update"] } },
  };
  behave({ ...extras, applyAdvance: true });
  const s = await seal(w, "DEV");
  assert.ok(s.sealed.changes.some((c) => c.importing) && s.sealed.changes.some((c) => c.previousAddress === "azurerm_x.old") && s.sealed.changes.some((c) => c.address === "output.endpoint"));
  const approvals = [approval(s.sealed, "alice")];
  for (const edit of [
    { showResources: [{ ...extras.showResources[0], change: { actions: ["no-op"] } }, extras.showResources[1]] },
    { showResources: [extras.showResources[0], { ...extras.showResources[1], previous_address: undefined }] },
    { showOutputChanges: {} },
    { showResources: [...extras.showResources, { address: "azurerm_x.forgotten", type: "azurerm_x", change: { actions: ["forget"] } }] },
  ]) {
    behave({ ...extras, ...edit, applyAdvance: true });
    refused(await run(w, s, approvals), "ARTIFACT_TAMPERED");
    assert.equal(applyCalls().length, 0);
  }
  behave({ ...extras, applyAdvance: true });
  assert.ok((await run(w, s, approvals)).ok, "the approvals were never consumed");
});

test("a failure after the approvals were consumed and before the engine starts is APPROVALS_SPENT: the approvals are gone, the artifact is given back", async () => {
  const w = world();
  const s = await seal(w, "DEV");
  const approvals = [approval(s.sealed, "alice")];
  // The plan file's place is taken before the apply writes it (a write that cannot happen, as a full disk would be).
  behave({ initWrites: [{ path: "../alz-apply.tfplan", content: "in the way" }] });
  const result = await run(w, s, approvals);
  refused(result, "APPROVALS_SPENT");
  const message = (result as { message: string }).message;
  assert.match(message, /approvals were consumed/);
  assert.match(message, /sealed plan was given back/);
  assert.match(message, /obtain new approvals/);
  assert.equal((result as { outcome?: string }).outcome, undefined, "nothing ran, so there is no outcome");
  noMessage(result);
  assert.equal(applyCalls().length, 0);
  assert.ok(!existsSync(ledgerOf(w, s)), "released: the artifact can be approved again");
  clean(w);
  assert.equal(consumeApprovals(w.deps.nonces!, approvals).ok, false, "the approvals are spent");
  behave({ applyAdvance: true });
  refused(await run(w, s, approvals), "APPROVAL_REPLAYED");
  assert.ok((await run(w, s, [approval(s.sealed, "bob")])).ok, "fresh approvals for the same sealed plan work");
});
