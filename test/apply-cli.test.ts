import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, randomBytes } from "node:crypto";
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runApplyCommand, type ApplyCliDeps } from "../src/cli/apply.js";
import { loadQualificationRecords } from "../src/apply/contract.js";
import { reserveArtifact } from "../src/apply/ledger.js";
import { openNonceStore, type NonceStore } from "../src/apply/nonces.js";
import { APPLY_ADAPTER, APPLY_ARGV, APPLY_INIT_ARGV } from "../src/apply/terraform.js";
import { removeTree } from "../src/teardown/driver/cleanup.js";
import type { ApplyEnvironment } from "../src/apply/types.js";
import type { ResolvedTarget } from "../src/teardown/driver/types.js";
import { targetString } from "../src/cli/teardown-driver.js";
import { SOURCE_COMMIT,
  DEV_TARGET, ENGINE_VERSION, NOW, OUTPUT_CANARY, PLAN_CANARY, POLICY, PROD_TARGET, QA_TARGET, STATE_CANARY, VALUE_CANARY, targetOf,
  behave as behaveIn, callsOf, contractJson, identityEnv, installFakeTerraform, keys, pinPathOf, testFixtureForgeQualificationEvidence, writePinnedContract,
  writeProject, type Behavior, type Project,
} from "./helpers/apply-fixtures.js";
import { AZURE } from "../src/apply/providers/azure.js";

// docs/act-pilot-apply.md. The CLI is the human gate: it needs a terminal, shows
// what will happen, and passes the driver a request only after the person typed
// the exact confirmation. The engine is a fake executable (logic only, NOT
// real-engine qualification). Fixtures only: no real tenant, subscription or approver.

const root = mkdtempSync(join(tmpdir(), "alz-cli-"));
const toolDir = mkdtempSync(join(tmpdir(), "alz-cli-tools-"));
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
const engineCalls = (): string[][] => callsOf(toolDir).map((call) => call.args);
const applyCalls = () => engineCalls().filter((args) => args[0] === "apply");
const ENV = identityEnv("DEV");

const json = (value: unknown, label = "file"): string => {
  const path = join(fresh(label), label + ".json");
  writeFileSync(path, JSON.stringify(value));
  return path;
};
const keyFile = (who: keyof typeof keys, mode = 0o600): string => {
  const path = join(fresh("key"), who + ".pem");
  writeFileSync(path, keys[who].priv, { mode });
  chmodSync(path, mode);
  return path;
};

type Terminal = NonNullable<ApplyCliDeps["terminal"]> & { out: string[]; asked: string[] };
const terminal = (answers: string[], tty = true): Terminal => {
  const out: string[] = [];
  const asked: string[] = [];
  return {
    stdinIsTTY: tty, stdoutIsTTY: tty, out, asked,
    write: (text: string) => { out.push(text); },
    ask: async (question: string) => { asked.push(question); return answers.shift() ?? ""; },
  };
};
type Run = { code: number; stdout: string; stderr: string; term: Terminal };
type World = { deps: (term: Terminal, over?: Partial<ApplyCliDeps>) => ApplyCliDeps; contractPath: string; vault: string; evidenceDir: string };

/** A pinned contract, a vault holding qualification evidence (none when `qualified` is false), and fresh ledgers. */
async function world(contract: unknown = contractJson(KILL), qualified = true): Promise<World> {
  behave();
  const contractPath = join(fresh("contract"), "act-pilot-contract.json");
  if (contract !== undefined) writePinnedContract(contractPath, contract);
  const vault = fresh("vault");
  if (qualified) await testFixtureForgeQualificationEvidence(vault);
  const scratch = fresh("scratch");
  const evidenceDir = fresh("evidence");
  const nonces = openNonceStore(fresh("nonces"));
  return {
    contractPath, vault, evidenceDir,
    deps: (term, over = {}) => ({
      sourceCommit: SOURCE_COMMIT,
      terminal: term, env: ENV, now: () => NOW, operatorId: "operator.fixture", contractPath, contractPinPath: pinPathOf(contractPath),
      qualificationDir: vault, evidenceDir, nonces, scratchParent: scratch, toolDirs: [toolDir], ...over,
    }),
  };
}
const outputs = () => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return { stdout, stderr, say: (t: string) => { stdout.push(t); }, complain: (t: string) => { stderr.push(t); } };
};
async function cli(w: World, args: string[], answers: string[], over: Partial<ApplyCliDeps> = {}, tty = true): Promise<Run> {
  const io = outputs();
  const term = terminal(answers, tty);
  const code = await runApplyCommand(args, { ...w.deps(term, over), stdout: io.say, stderr: io.complain });
  return { code, stdout: io.stdout.join(""), stderr: io.stderr.join(""), term };
}

const requestFile = (p: Project, target: ResolvedTarget, environment: string, extra: Record<string, unknown> = {}) =>
  json({ environment, target, projectRoot: p.projectRoot, policyVersion: POLICY, resolved: p.resolved, ...extra }, "request");
const manifestFile = (p: Project) => json(p.manifest, "manifest");
const sealArgs = (p: Project, target: ResolvedTarget, environment: string, extra: Record<string, unknown> = {}) =>
  ["seal", "--request", requestFile(p, target, environment, extra), "--manifest", manifestFile(p)];
const PHRASE = "RUN PROJECT CODE";

type Sealed = { project: Project; target: ResolvedTarget; environment: ApplyEnvironment; path: string; bundle: string; artifactSha256: string };
async function sealed(w: World, environment: ApplyEnvironment): Promise<Sealed> {
  const target = targetOf(environment);
  const p = writeProject(fresh("project"), target);
  const run = await cli(w, sealArgs(p, target, environment), [targetString(target), PHRASE], { env: identityEnv(environment) });
  assert.equal(run.code, 0, run.stderr);
  const result = JSON.parse(run.stdout) as { artifactSha256: string; sealedPlanPath: string; reviewBundlePath: string };
  return { project: p, target, environment, path: result.sealedPlanPath, bundle: result.reviewBundlePath, artifactSha256: result.artifactSha256 };
}
async function approve(w: World, s: Sealed, who: keyof typeof keys, over: Partial<ApplyCliDeps> = {}): Promise<string> {
  const run = await cli(w, ["approve", "--bundle", s.bundle, "--key", keyFile(who), "--approver", who], [approvePhrase(s)], over);
  assert.equal(run.code, 0, run.stderr);
  return json(JSON.parse(run.stdout), "approval-" + who);
}
const applyArgs = (s: Sealed, approvals: string[], extra: string[] = []) => [
  "apply", "--request", json({ environment: s.environment, target: s.target, projectRoot: s.project.projectRoot }, "apply-request"),
  "--manifest", manifestFile(s.project), "--sealed", s.path, ...approvals.flatMap((file) => ["--approval", file]), ...extra,
];
/** What the person types to apply: the environment, the first 12 hex of the artifact hash and the exact target. */
const applyPhrase = (s: Sealed) => "APPLY " + s.environment + " " + s.artifactSha256.slice(0, 12) + " " + targetString(s.target);
/** What an approver types: the environment and the first 12 hex of the artifact hash. */
const approvePhrase = (s: Sealed) => "APPROVE " + s.environment + " " + s.artifactSha256.slice(0, 12);
const applyIn = (s: Sealed, extra: Partial<ApplyCliDeps> = {}) => ({ env: identityEnv(s.environment), ...extra });

// --- the human gate ------------------------------------------------------------------------

test("every subcommand needs a terminal on stdin and stdout, and refuses before reading any file", async () => {
  const w = await world();
  for (const args of [
    ["seal", "--request", "/nonexistent/a", "--manifest", "/nonexistent/b"],
    ["qualify", "--request", "/nonexistent/a", "--manifest", "/nonexistent/b"],
    ["approve", "--sealed", "/nonexistent/a", "--key", "/nonexistent/k", "--approver", "alice"],
    ["apply", "--request", "/nonexistent/a", "--manifest", "/nonexistent/b", "--sealed", "/nonexistent/s", "--approval", "/nonexistent/p"],
    ["status"],
    ["pin"],
  ]) {
    for (const [stdinIsTTY, stdoutIsTTY] of [[false, false], [true, false], [false, true]]) {
      const io = outputs();
      const base = terminal(["anything"]);
      const code = await runApplyCommand(args, { ...w.deps(base), terminal: { ...base, stdinIsTTY, stdoutIsTTY }, stdout: io.say, stderr: io.complain });
      assert.equal(code, 1, args[0]);
      assert.match(io.stderr.join(""), /HUMAN_TERMINAL_REQUIRED/);
      assert.doesNotMatch(io.stderr.join(""), /nonexistent|ENOENT/);
      assert.equal(io.stdout.join(""), "");
      assert.deepEqual(base.asked, []);
    }
  }
  assert.deepEqual(engineCalls(), []);
});

test("pin prints the contract hash and whether the contract is valid, and writes nothing", async () => {
  const w = await world(contractJson(KILL));
  const run = await cli(w, ["pin"], []);
  assert.equal(run.code, 0);
  const report = JSON.parse(run.stdout) as { sha256: string; valid: boolean };
  assert.match(report.sha256, /^[0-9a-f]{64}$/);
  assert.equal(report.valid, true);
  const unchanged = readFileSync(w.contractPath, "utf8");
  await cli(w, ["pin"], []);
  assert.equal(readFileSync(w.contractPath, "utf8"), unchanged);
  assert.deepEqual(engineCalls(), []);
});

test("an unknown subcommand or flag, a repeated or missing flag, or a flag for what the contract and vault now supply is an error with fixed text", async () => {
  const w = await world();
  for (const args of [
    [], ["destroy"], ["apply-now"], ["status", "--force"], ["status", "--sealed"], ["status", "--sealed", "a", "--sealed", "b"],
    ["seal", "--request", "r"], ["seal", "--request", "r", "--manifest", "m", "--yes", "x"],
    ["seal", "--request", "r", "--manifest", "m", "--qualifications", "q"], // qualification is verified from vault evidence
    ["qualify", "--request", "r"], ["qualify", "--request", "r", "--manifest", "m", "--approval", "a"],
    ["approve", "--sealed", "s", "--key", "k"], ["apply", "--approval", "p"],
    ["apply", "--request", "r", "--manifest", "m", "--sealed", "s", "--approval", "p", "--allowlist", "l"], // the allowlist is in the pinned contract
    ["apply", "--request", "r", "--manifest", "m", "--sealed", "s", "--approval", "p", "--qualifications", "q"],
  ]) {
    const run = await cli(w, args, []);
    assert.equal(run.code, 1, JSON.stringify(args));
    assert.match(run.stderr, /^APPLY_[A-Z_]+/);
    assert.equal(run.stdout, "");
  }
  assert.deepEqual(engineCalls(), []);
});

test("request files cannot carry the invocation, the manifest or approvals: the command supplies them", async () => {
  const w = await world();
  const p = writeProject(fresh("project"), DEV_TARGET);
  for (const extra of [{ invocation: { operatorId: "x" } }, { manifest: {} }, { approvals: [] }, { capabilities: {} }, { unknownField: 1 }]) {
    for (const sub of ["seal", "qualify"]) {
      const run = await cli(w, [sub, ...sealArgs(p, DEV_TARGET, "DEV", extra).slice(1)], [targetString(DEV_TARGET), PHRASE]);
      assert.equal(run.code, 1, sub + JSON.stringify(extra));
      assert.match(run.stderr, /APPLY_INPUT_INVALID/);
      assert.deepEqual(run.term.asked, [], "nothing was asked before the input was valid");
    }
  }
  assert.deepEqual(engineCalls(), []);
});

// --- seal --------------------------------------------------------------------------------

test("seal shows the target, needs the exact target and the project code phrase, and prints the artifact and redacted changes", async () => {
  const w = await world();
  const p = writeProject(fresh("project"), DEV_TARGET);
  const run = await cli(w, sealArgs(p, DEV_TARGET, "DEV"), [targetString(DEV_TARGET), PHRASE]);
  assert.equal(run.code, 0, run.stderr);
  const result = JSON.parse(run.stdout) as { artifactSha256: string; sealedPlanPath: string; environment: string; changes: { address: string; action: string }[] };
  assert.match(result.artifactSha256, /^[a-f0-9]{64}$/);
  assert.equal(result.environment, "DEV");
  assert.deepEqual(result.changes.map((c) => c.address).sort(), ["azurerm_log_analytics_workspace.pilot", "azurerm_resource_group.pilot"]);
  assert.ok(existsSync(result.sealedPlanPath));
  const shown = run.term.out.join("");
  assert.ok(shown.includes(targetString(DEV_TARGET)) && shown.includes(PHRASE));
  assert.match(shown, /DISCOVERY/);
  for (const secret of [PLAN_CANARY, VALUE_CANARY]) {
    assert.ok(!run.stdout.includes(secret) && !readFileSync(result.sealedPlanPath, "utf8").includes(secret), "plan bytes and values are not readable");
  }
  assert.equal(applyCalls().length, 0);
});

test("seal stops on a wrong target, a wrong phrase, a disabled contract or a vault with no qualification, and runs no engine", async () => {
  const w = await world();
  const p = writeProject(fresh("project"), DEV_TARGET);
  const wrongTarget = await cli(w, sealArgs(p, DEV_TARGET, "DEV"), [targetString(PROD_TARGET), PHRASE]);
  assert.equal(wrongTarget.code, 1);
  assert.match(wrongTarget.stderr, /HUMAN_CONFIRMATION_MISMATCH/);
  const wrongPhrase = await cli(w, sealArgs(p, DEV_TARGET, "DEV"), [targetString(DEV_TARGET), "yes"]);
  assert.equal(wrongPhrase.code, 1);
  assert.match(wrongPhrase.stderr, /PROJECT_CODE_CONFIRMATION_MISMATCH/);
  assert.deepEqual(engineCalls(), []);
  const off = await world(contractJson(KILL, { enabled: false }));
  const disabled = await cli(off, sealArgs(p, DEV_TARGET, "DEV"), [targetString(DEV_TARGET), PHRASE]);
  assert.equal(disabled.code, 2);
  assert.match(disabled.stderr, /BLOCKED ACT_DISABLED/);
  const bare = await world(contractJson(KILL), false);
  const unqualified = await cli(bare, sealArgs(p, DEV_TARGET, "DEV"), [targetString(DEV_TARGET), PHRASE]);
  assert.equal(unqualified.code, 2);
  assert.match(unqualified.stderr, /BLOCKED ENGINE_NOT_QUALIFIED/);
  assert.deepEqual(engineCalls(), []);
});

// --- qualify -----------------------------------------------------------------------------

const attest = (env: NodeJS.ProcessEnv = ENV) =>
  "SEPARATED " + env.ALZ_STATE_WRITE_ARM_CLIENT_ID + " " + env.ALZ_APPLY_ARM_CLIENT_ID;
const qualifyArgs = (p: Project, environment = "DEV", target = DEV_TARGET) =>
  ["qualify", "--request", requestFile(p, target, environment), "--manifest", manifestFile(p)];
const sealedPlanFiles = () => existsSync(join(root, ".runs/evidence/sealed-plan")) ? readdirSync(join(root, ".runs/evidence/sealed-plan")).length : 0;

test("qualify runs the engine steps against DEV without applying, asks for the separation attestation, then writes evidence that unlocks seal and apply", async () => {
  const w = await world(contractJson(KILL), false);
  behave({ planSalt: "unique-to-this-qualify-run" }); // a plan nothing else sealed, so a stored copy would show as a new file
  const p = writeProject(fresh("project"), DEV_TARGET);
  const stored = sealedPlanFiles();
  assert.deepEqual(await loadQualificationRecords(AZURE, w.vault), []);
  const run = await cli(w, qualifyArgs(p), [targetString(DEV_TARGET), PHRASE, attest()]);
  assert.equal(run.code, 0, run.stderr);
  assert.equal(applyCalls().length, 0, "qualify applies nothing");
  assert.ok(engineCalls().some((args) => args.join(" ") === APPLY_INIT_ARGV.join(" ")), "the apply adapter's init ran");
  assert.equal(sealedPlanFiles(), stored, "no sealed plan was stored");
  const shown = run.term.out.join("");
  assert.ok(shown.includes("statewrite-client-3") && shown.includes("apply-client-4") && shown.includes("real Terraform engine"));
  assert.ok(!shown.includes("secret") && !run.stdout.includes("secret"));
  const printed = JSON.parse(run.stdout) as { qualified: { adapterVersion: string; argvDigest: string; engineVersion: string; evidenceHash: string }[] };
  assert.ok(printed.qualified.some((q) => q.adapterVersion === APPLY_ADAPTER.adapterVersion && q.argvDigest === APPLY_ADAPTER.argvDigest && q.engineVersion === ENGINE_VERSION));
  const records = await loadQualificationRecords(AZURE, w.vault);
  assert.deepEqual(records.map((r) => r.evidenceHash).sort(), printed.qualified.map((q) => q.evidenceHash).sort());
  // Unlocked: the full path now works with no record supplied by anyone.
  const s = await sealed(w, "DEV");
  const done = await cli(w, applyArgs(s, [await approve(w, s, "alice")]), [applyPhrase(s)], applyIn(s));
  assert.equal(done.code, 0, done.stderr);
});

test("qualify stops without evidence on a wrong confirmation or attestation, outside DEV, with a disabled contract or a failing engine", async () => {
  const w = await world(contractJson(KILL), false);
  const p = writeProject(fresh("project"), DEV_TARGET);
  const none = async (run: Run, code: number, pattern: RegExp) => {
    assert.equal(run.code, code, run.stderr);
    assert.match(run.stderr, pattern);
    assert.equal(run.stdout, "");
    assert.deepEqual(await loadQualificationRecords(AZURE, w.vault), [], "no evidence was written");
  };
  await none(await cli(w, qualifyArgs(p), [targetString(PROD_TARGET), PHRASE, attest()]), 1, /HUMAN_CONFIRMATION_MISMATCH/);
  await none(await cli(w, qualifyArgs(p), [targetString(DEV_TARGET), "yes", attest()]), 1, /PROJECT_CODE_CONFIRMATION_MISMATCH/);
  assert.deepEqual(engineCalls(), []);
  for (const typed of ["", "SEPARATED", "SEPARATED apply-client-4 statewrite-client-3", "SEPARATED statewrite-client-3", attest().toLowerCase(), "yes"]) {
    await none(await cli(w, qualifyArgs(p), [targetString(DEV_TARGET), PHRASE, typed]), 1, /QUALIFICATION_ATTESTATION_MISMATCH/);
    assert.equal(applyCalls().length, 0);
  }
  const prod = writeProject(fresh("project"), PROD_TARGET);
  await none(await cli(w, qualifyArgs(prod, "PROD", PROD_TARGET), [targetString(PROD_TARGET), PHRASE, attest()], { env: identityEnv("PROD") }), 2, /BLOCKED ARTIFACT_INVALID/);
  const qa = writeProject(fresh("project"), QA_TARGET);
  await none(await cli(w, qualifyArgs(qa, "QA", QA_TARGET), [targetString(QA_TARGET), PHRASE, attest()], { env: identityEnv("QA") }), 2, /BLOCKED ARTIFACT_INVALID/);
  const off = await world(contractJson(KILL, { enabled: false }), false);
  const disabled = await cli(off, qualifyArgs(p), [targetString(DEV_TARGET), PHRASE, attest()]);
  assert.equal(disabled.code, 2);
  assert.match(disabled.stderr, /BLOCKED ACT_DISABLED/);
  behave({ failOn: "workspace", failStderr: "leak " + VALUE_CANARY });
  await none(await cli(w, qualifyArgs(p), [targetString(DEV_TARGET), PHRASE, attest()]), 2, /BLOCKED ARTIFACT_INVALID/);
  assert.ok(!(await cli(w, qualifyArgs(p), [targetString(DEV_TARGET), PHRASE, attest()])).stderr.includes(VALUE_CANARY));
});

// --- approve -----------------------------------------------------------------------------

test("approve shows the redacted changes, needs the artifact phrase, and signs with the key file it was given", async () => {
  const w = await world();
  const s = await sealed(w, "DEV");
  const run = await cli(w, ["approve", "--bundle", s.bundle, "--key", keyFile("alice"), "--approver", "alice"], [approvePhrase(s)]);
  assert.equal(run.code, 0, run.stderr);
  const shown = run.term.out.join("");
  assert.match(shown, /CREATE\s+azurerm_resource_group\.pilot/);
  assert.ok(shown.includes(s.artifactSha256) && shown.includes(targetString(DEV_TARGET)));
  const signed = JSON.parse(run.stdout) as { statement: Record<string, unknown>; signatureBase64: string };
  assert.equal(signed.statement.artifactSha256, s.artifactSha256);
  assert.equal(signed.statement.environment, "DEV");
  assert.equal(signed.statement.approverId, "alice");
  assert.equal(signed.statement.issuedAt, NOW.toISOString());
  assert.equal(signed.statement.expiresAt, new Date(NOW.getTime() + 60 * 60_000).toISOString());
  assert.match(String(signed.statement.nonce), /^[a-f0-9]{32}$/);
  assert.ok(!run.stdout.includes("PRIVATE KEY"));
});

test("approve refuses without the typed phrase, with an open key file, a non-Ed25519 key, a tampered bundle or a contract that is disabled or does not match its pin", async () => {
  const w = await world();
  const s = await sealed(w, "DEV");
  const base = (key: string) => ["approve", "--bundle", s.bundle, "--key", key, "--approver", "alice"];
  const phrase = approvePhrase(s);
  for (const typed of ["", "alice", "APPROVE", "APPROVE " + s.artifactSha256.slice(0, 12), "APPROVE PROD " + s.artifactSha256.slice(0, 12), "APPROVE DEV " + "0".repeat(12), s.artifactSha256, phrase.toLowerCase()]) {
    const run = await cli(w, base(keyFile("alice")), [typed]);
    assert.equal(run.code, 1, typed);
    assert.equal(run.stdout, "");
    assert.match(run.stderr, /APPLY_CONFIRMATION_MISMATCH/);
  }
  const open = await cli(w, base(keyFile("alice", 0o644)), [phrase]);
  assert.equal(open.code, 1);
  assert.match(open.stderr, /APPLY_KEY_INVALID/);
  const rsa = join(fresh("key"), "rsa.pem");
  writeFileSync(rsa, generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
  assert.match((await cli(w, base(rsa), [phrase])).stderr, /APPLY_KEY_INVALID/);
  assert.match((await cli(w, base("/nonexistent/key.pem"), [phrase])).stderr, /APPLY_KEY_INVALID/);
  // The key comes from the file argument only: the environment is never consulted.
  const viaEnv = await cli(w, base(join(fresh("none"), "absent.pem")), [phrase], { env: { ...ENV, APPLY_APPROVER_KEY: keys.alice.priv, ALZ_APPROVER_KEY: keys.alice.priv } });
  assert.equal(viaEnv.code, 1);
  assert.match((await cli(w, ["approve", "--bundle", s.bundle, "--key", keyFile("alice"), "--approver", "Alice Smith; rm"], [phrase])).stderr, /APPLY_INPUT_INVALID/);
  const notABundle = await cli(w, ["approve", "--bundle", json({}, "bundle"), "--key", keyFile("alice"), "--approver", "alice"], [phrase]);
  assert.equal(notABundle.code, 2);
  assert.match(notABundle.stderr, /BLOCKED ARTIFACT_INVALID/);
  const off = await world(contractJson(KILL, { enabled: false }));
  const disabled = await cli(off, base(keyFile("alice")), [phrase]);
  assert.equal(disabled.code, 2);
  assert.match(disabled.stderr, /BLOCKED ACT_DISABLED/);
  writeFileSync(w.contractPath, JSON.stringify(contractJson(KILL, { maxApprovalAgeMinutes: 600 }))); // edited after the pin
  const mismatched = await cli(w, base(keyFile("alice")), [phrase]);
  assert.equal(mismatched.code, 2);
  assert.match(mismatched.stderr, /BLOCKED CONTRACT_INVALID/);
});

test("seal writes a non-secret review bundle: the artifact's own fields and the redacted changes, with no plan bytes and no values", async () => {
  const w = await world();
  const s = await sealed(w, "DEV");
  const text = readFileSync(s.bundle, "utf8");
  const bundle = JSON.parse(text) as Record<string, unknown>;
  assert.deepEqual(Object.keys(bundle).sort(), [
    "artifactSha256", "changes", "changesSha256", "channel", "contractSha256", "createdAt", "engineVersion", "environment", "manifestHash", "planSha256", "policyVersion", "provenance", "releaseIdentity", "sourceCommit", "target",
  ]);
  assert.equal(bundle.artifactSha256, s.artifactSha256);
  assert.equal(bundle.environment, "DEV");
  assert.equal(bundle.channel, "CLI", "the terminal CLI seals into the CLI channel, and the approvers' bundle says so");
  for (const secret of [PLAN_CANARY, VALUE_CANARY, STATE_CANARY, "planBase64"]) assert.ok(!text.includes(secret), secret);
});

test("approve needs no evidence key: an approver holds only the review bundle, the contract and their own key file", async () => {
  const w = await world();
  const s = await sealed(w, "DEV");
  const keyDir = fresh("no-evidence-key");
  const saved = { key: process.env.AGENTIC_EVIDENCE_KEY, file: process.env.AGENTIC_EVIDENCE_KEY_FILE };
  delete process.env.AGENTIC_EVIDENCE_KEY;
  process.env.AGENTIC_EVIDENCE_KEY_FILE = join(keyDir, "absent.key");
  try {
    const unreadable = await cli(w, ["status", "--sealed", s.path], []);
    assert.equal(unreadable.code, 2, "without the key the vault cannot be read (the control for this test)");
    rmSync(join(keyDir, "absent.key"), { force: true }); // the vault may create a key on first touch; approve must not
    const run = await cli(w, ["approve", "--bundle", s.bundle, "--key", keyFile("alice"), "--approver", "alice"], [approvePhrase(s)]);
    assert.equal(run.code, 0, run.stderr);
    const signed = JSON.parse(run.stdout) as { statement: { artifactSha256: string; environment: string; target: ResolvedTarget } };
    assert.equal(signed.statement.artifactSha256, s.artifactSha256);
    assert.equal(signed.statement.environment, "DEV");
    assert.deepEqual(signed.statement.target, DEV_TARGET);
    assert.ok(!existsSync(join(keyDir, "absent.key")), "approve created no evidence key");
  } finally {
    if (saved.key === undefined) delete process.env.AGENTIC_EVIDENCE_KEY; else process.env.AGENTIC_EVIDENCE_KEY = saved.key;
    if (saved.file === undefined) delete process.env.AGENTIC_EVIDENCE_KEY_FILE; else process.env.AGENTIC_EVIDENCE_KEY_FILE = saved.file;
  }
  // The approval it signs is the one `apply` accepts, with the key restored.
  assert.equal((await cli(w, applyArgs(s, [await approve(w, s, "alice")]), [applyPhrase(s)], applyIn(s))).code, 0);
});

test("approve refuses a tampered or malformed bundle before asking anything, and prints no plan value", async () => {
  const w = await world();
  const s = await sealed(w, "DEV");
  const original = JSON.parse(readFileSync(s.bundle, "utf8")) as Record<string, unknown> & { changes: { address: string; action: string }[] };
  const variants: [string, Record<string, unknown>, RegExp][] = [
    ["an edited change address", { changes: [{ ...original.changes[0], address: "azurerm_resource_group.other" }, ...original.changes.slice(1)] }, /ARTIFACT_TAMPERED/],
    ["a hidden change", { changes: original.changes.slice(1) }, /ARTIFACT_TAMPERED/],
    ["another environment", { environment: "PROD" }, /ARTIFACT_TAMPERED/],
    ["another target", { target: PROD_TARGET }, /ARTIFACT_TAMPERED/],
    ["another plan hash", { planSha256: "a".repeat(64) }, /ARTIFACT_TAMPERED/],
    ["an artifact hash of its own choosing", { artifactSha256: "b".repeat(64) }, /ARTIFACT_TAMPERED/],
    ["a changes hash that does not match", { changesSha256: "c".repeat(64) }, /ARTIFACT_TAMPERED/],
    ["a field the bundle does not have", { planBase64: "AAAA" }, /ARTIFACT_INVALID/],
    ["a changes list that is not a list", { changes: "none" }, /ARTIFACT_INVALID/],
    ["a malformed hash", { manifestHash: "short" }, /ARTIFACT_INVALID/],
  ];
  for (const [label, over, expected] of variants) {
    const run = await cli(w, ["approve", "--bundle", json({ ...original, ...over }, "bundle"), "--key", keyFile("alice"), "--approver", "alice"], [approvePhrase(s)]);
    assert.equal(run.code, 2, label);
    assert.match(run.stderr, expected, label);
    assert.deepEqual(run.term.asked, [], label + ": nothing is asked about a bundle that does not verify");
    assert.equal(run.stdout, "", label);
  }
  const garbage = join(fresh("garbage"), "bundle.json");
  writeFileSync(garbage, "not json");
  assert.equal((await cli(w, ["approve", "--bundle", garbage, "--key", keyFile("alice"), "--approver", "alice"], [approvePhrase(s)])).code, 1);
  const ok = await cli(w, ["approve", "--bundle", s.bundle, "--key", keyFile("alice"), "--approver", "alice"], [approvePhrase(s)]);
  assert.equal(ok.code, 0, ok.stderr);
  for (const text of [ok.stdout, ok.stderr, ok.term.out.join("")]) for (const canary of [PLAN_CANARY, VALUE_CANARY, STATE_CANARY]) assert.ok(!text.includes(canary), canary);
});

// --- apply -------------------------------------------------------------------------------

test("a DEV apply shows the plan, needs the one confirmation phrase, and prints only redacted evidence", async () => {
  const w = await world();
  const s = await sealed(w, "DEV");
  const approval = await approve(w, s, "alice");
  const run = await cli(w, applyArgs(s, [approval]), [applyPhrase(s)], applyIn(s));
  assert.equal(run.code, 0, run.stderr);
  const evidence = JSON.parse(run.stdout) as { outcome: string; artifactSha256: string; approvals: { approverId: string }[]; authority: { agentInitiated: boolean } };
  assert.equal(evidence.outcome, "SUCCEEDED");
  assert.equal(evidence.artifactSha256, s.artifactSha256);
  assert.deepEqual(evidence.approvals.map((a) => a.approverId), ["alice"]);
  assert.equal(evidence.authority.agentInitiated, false);
  assert.ok(!run.stdout.includes(OUTPUT_CANARY) && !run.stderr.includes(OUTPUT_CANARY) && !run.term.out.join("").includes(OUTPUT_CANARY));
  const shown = run.term.out.join("");
  assert.ok(shown.includes(targetString(DEV_TARGET)) && shown.includes("azurerm_resource_group.pilot") && shown.includes("alice") && shown.includes(applyPhrase(s)));
  assert.equal(run.term.asked.length, 1, "one confirmation, which carries the environment, the artifact and the target");
  assert.deepEqual(applyCalls(), [[...APPLY_ARGV]]);
});

test("apply stops at the prompt: a wrong environment, artifact or target, or the bare words, run nothing and consume nothing", async () => {
  const w = await world();
  const s = await sealed(w, "DEV");
  const approval = await approve(w, s, "alice");
  const sha12 = s.artifactSha256.slice(0, 12);
  const target = targetString(DEV_TARGET);
  for (const typed of [
    "APPLY DEV", "APPLY PROD " + sha12 + " " + target, "APPLY QA " + sha12 + " " + target, "APPLY DEV " + "0".repeat(12) + " " + target, "APPLY DEV " + sha12, "APPLY DEV " + sha12 + " " + targetString(PROD_TARGET),
    applyPhrase(s).toLowerCase(), target, "yes", "",
  ]) {
    const run = await cli(w, applyArgs(s, [approval]), [typed], applyIn(s));
    assert.equal(run.code, 1, typed);
    assert.match(run.stderr, /APPLY_CONFIRMATION_MISMATCH/);
    assert.equal(run.stdout, "");
  }
  assert.equal(applyCalls().length, 0);
  const ok = await cli(w, applyArgs(s, [approval]), [applyPhrase(s)], applyIn(s));
  assert.equal(ok.code, 0, ok.stderr);
});

test("exit codes: 0 done, 1 error with nothing spent, 2 refused before any action, 3 the attempt started and the artifact is spent", async () => {
  const w = await world();
  const s = await sealed(w, "DEV");
  const approval = await approve(w, s, "alice");
  const confirm = () => [applyPhrase(s)];

  writeFileSync(KILL, "stop");
  const killed = await cli(w, applyArgs(s, [approval]), confirm(), applyIn(s));
  assert.equal(killed.code, 2);
  assert.match(killed.stderr, /BLOCKED KILL_SWITCH_ACTIVE/);
  rmSync(KILL);

  const forged = join(fresh("forged"), "approval.json");
  writeFileSync(forged, JSON.stringify({ statement: { ...JSON.parse(readFileSync(approval, "utf8")).statement, approverId: "bob" }, signatureBase64: "AAAA" }));
  const unverified = await cli(w, applyArgs(s, [forged]), confirm(), applyIn(s));
  assert.equal(unverified.code, 2);
  assert.match(unverified.stderr, /BLOCKED APPROVAL_UNVERIFIED/);

  const none = await cli(w, ["apply", ...applyArgs(s, []).slice(1)], confirm(), applyIn(s));
  assert.equal(none.code, 1, "at least one --approval is required");
  const badInput = await cli(w, applyArgs(s, [approval]).map((a) => a === s.path ? "/nonexistent/sealed" : a), confirm(), applyIn(s));
  assert.equal(badInput.code, 2, "an unreadable sealed plan is refused before any action");
  assert.equal(applyCalls().length, 0);

  behave({ failOn: "workspace" });
  const noStart = await cli(w, applyArgs(s, [approval]), confirm(), applyIn(s));
  assert.equal(noStart.code, 1, "the engine could not start: nothing was applied or spent");
  assert.match(noStart.stderr, /APPLY_FAILED/);
  assert.match(noStart.stderr, /no approval was consumed/);
  assert.equal(applyCalls().length, 0);

  behave();
  const done = await cli(w, applyArgs(s, [approval]), confirm(), applyIn(s));
  assert.equal(done.code, 0, done.stderr);
  const again = await cli(w, applyArgs(s, [await approve(w, s, "bob")]), confirm(), applyIn(s));
  assert.equal(again.code, 2);
  assert.match(again.stderr, /BLOCKED ARTIFACT_ALREADY_APPLIED/);
  assert.equal(applyCalls().length, 1);
});

test("a failed, partial or killed apply exits 3, withholds engine output and says not to retry when state may have changed", async () => {
  for (const [behavior, outcome, retry] of [
    // Terraform exits 1 for every error: only a lock refusal with an unmoved serial is known to have changed nothing.
    [{ applyExit: 1, applyAdvance: false, applyStderr: "Error: Error acquiring the state lock" }, /failed before it changed state/, /seal a new preview/i],
    [{ applyExit: 1, applyAdvance: false }, /partly applied/, /Do not retry/],
    [{ applyExit: 1, applyAdvance: true }, /partly applied/, /Do not retry/],
    [{ applyKill: true, applyAdvance: true }, /told to stop|ended on a signal/, /Do not retry/],
  ] as const) {
    const w = await world();
    behave(behavior);
    const s = await sealed(w, "DEV");
    const run = await cli(w, applyArgs(s, [await approve(w, s, "alice")]), [applyPhrase(s)], applyIn(s));
    assert.equal(run.code, 3, JSON.stringify(behavior) + run.stderr);
    assert.match(run.stderr, /APPLY_FAILED/);
    assert.match(run.stderr, outcome);
    assert.match(run.stderr, retry);
    assert.equal(run.stdout, "");
    assert.ok(!run.stderr.includes(OUTPUT_CANARY));
    // The artifact is spent: status says so, and a second try is refused.
    const status = JSON.parse((await cli(w, ["status", "--sealed", s.path], [])).stdout) as { artifact: { applied: boolean } };
    assert.equal(status.artifact.applied, true);
  }
});

/** A nonce store that runs `hook` once the approvals are consumed, which is after the last kill-switch read before the engine. */
const afterConsume = (real: NonceStore, hook: () => void): NonceStore => ({
  has: (nonce) => real.has(nonce),
  consumeAll: (entries) => { const ok = real.consumeAll(entries); hook(); return ok; },
});

test("the kill switch appearing after the approvals were consumed exits 3: they are spent although nothing ran, and the plan can be approved again", async () => {
  const w = await world();
  const s = await sealed(w, "DEV");
  const approval = await approve(w, s, "alice");
  const real = openNonceStore(fresh("nonces"));
  const run = await cli(w, applyArgs(s, [approval]), [applyPhrase(s)], applyIn(s, { nonces: afterConsume(real, () => writeFileSync(KILL, "stop")) }));
  assert.equal(run.code, 3, run.stderr);
  assert.match(run.stderr, /BLOCKED KILL_SWITCH_AFTER_APPROVALS/);
  assert.match(run.stderr, /obtain new approvals/);
  assert.equal(run.stdout, "");
  assert.equal(applyCalls().length, 0, "the engine never started");
  rmSync(KILL);
  const status = JSON.parse((await cli(w, ["status", "--sealed", s.path], [])).stdout) as { artifact: { applied: boolean } };
  assert.equal(status.artifact.applied, false, "no engine ran, so the artifact was given back");
  const again = await cli(w, applyArgs(s, [await approve(w, s, "alice")]), [applyPhrase(s)], applyIn(s, { nonces: real }));
  assert.equal(again.code, 0, again.stderr);
});

/** An hour-old driver directory (and an unrelated one), a young one, and a command that sweeps and then stops on its missing input. */
function staleScratch() {
  const scratch = fresh("sweep");
  const dirs = { old: join(scratch, "alz-preview-stale"), young: join(scratch, "alz-preview-young"), other: join(scratch, "unrelated-old") };
  for (const dir of Object.values(dirs)) mkdirSync(dir);
  const longAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
  utimesSync(dirs.old, longAgo, longAgo);
  utimesSync(dirs.other, longAgo, longAgo);
  return { scratch, ...dirs };
}
const sweepingCommand = ["seal", "--request", "/nonexistent/request", "--manifest", "/nonexistent/manifest"];

test("qualify, seal and apply sweep stale scratch directories at startup, as the teardown CLI does, and leave young ones and other names alone", async () => {
  const w = await world();
  const d = staleScratch();
  const run = await cli(w, sweepingCommand, [], { scratchParent: d.scratch });
  assert.equal(run.code, 1, "it stops on the missing request after the sweep");
  assert.ok(!existsSync(d.old), "an hour-old driver directory is removed");
  assert.ok(existsSync(d.young) && existsSync(d.other));
  assert.doesNotMatch(run.stderr, /NOTICE/);
});

test("the sweep is skipped, with a notice, while the ledger holds a reservation or a scratch directory holds errored.tfstate or crash.log, and status never sweeps", async () => {
  const w = await world();
  // status never sweeps, whatever the state of the ledger.
  const quiet = staleScratch();
  assert.equal((await cli(w, ["status"], [], { scratchParent: quiet.scratch })).code, 0);
  assert.ok(existsSync(quiet.old), "status removes nothing");

  const noKey = staleScratch();
  assert.doesNotMatch((await cli(w, sweepingCommand, [], { scratchParent: noKey.scratch })).stderr, /NOTICE/);
  assert.ok(!existsSync(noKey.old), "an empty ledger and clean scratch directories are swept");

  // A reservation: a run may be in flight or may have died holding the engine's leftovers.
  const reserved = staleScratch();
  assert.ok((await reserveArtifact("a".repeat(64), w.evidenceDir, NOW)).ok);
  const held = await cli(w, sweepingCommand, [], { scratchParent: reserved.scratch });
  assert.match(held.stderr, /NOTICE the stale scratch sweep was skipped because the apply ledger holds a reservation/);
  assert.ok(existsSync(reserved.old), "nothing was removed");

  // An unreadable ledger entry counts as held.
  const evidenceDir = fresh("evidence-junk");
  writeFileSync(join(evidenceDir, "b".repeat(64) + ".apply.evidence"), "not an envelope");
  const junk = staleScratch();
  assert.match((await cli(w, sweepingCommand, [], { scratchParent: junk.scratch, evidenceDir })).stderr, /ledger holds a reservation/);
  assert.ok(existsSync(junk.old));

  // Recovery files a crashed apply left, at the top of the scratch directory or in its work directory.
  for (const file of ["errored.tfstate", "crash.log"]) for (const where of ["", "work"]) {
    const crashed = staleScratch();
    const target = join(crashed.old, where);
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, file), "the only record of what the apply did");
    const evidence = fresh("evidence-clean");
    const run = await cli(w, sweepingCommand, [], { scratchParent: crashed.scratch, evidenceDir: evidence });
    assert.match(run.stderr, /NOTICE the stale scratch sweep was skipped because a scratch directory holds errored\.tfstate or crash\.log/, file + where);
    assert.ok(existsSync(join(target, file)), "the recovery file is still there");
  }
});

test("QA needs a DEV apply of the same release and PROD a QA apply, each with its own approvers; one approver cannot sign twice", async () => {
  const w = await world();
  const dev = await sealed(w, "DEV");
  const qa = await sealed(w, "QA");
  const prod = await sealed(w, "PROD");
  const runOf = (s: Sealed, approvals: string[]) => cli(w, applyArgs(s, approvals), [applyPhrase(s)], applyIn(s));
  const alice = await approve(w, prod, "alice");
  const bob = await approve(w, prod, "bob");
  const qaAlice = await approve(w, qa, "alice");

  // The phrases carry the environment.
  assert.match(applyPhrase(qa), /^APPLY QA [0-9a-f]{12} /);
  assert.match(approvePhrase(qa), /^APPROVE QA [0-9a-f]{12}$/);

  // Neither QA nor PROD can go first.
  const qaFirst = await runOf(qa, [qaAlice]);
  assert.equal(qaFirst.code, 2);
  assert.match(qaFirst.stderr, /PROMOTION_EVIDENCE_MISSING/);
  const prodFirst = await runOf(prod, [alice, bob]);
  assert.equal(prodFirst.code, 2);
  assert.match(prodFirst.stderr, /PROMOTION_EVIDENCE_MISSING/);

  // A QA approval is not a DEV or PROD approval: it is signed for QA's environment and artifact.
  const wrongEnv = await runOf(dev, [qaAlice]);
  assert.equal(wrongEnv.code, 2);
  assert.match(wrongEnv.stderr, /APPROVAL_MISBOUND/);

  const devRun = await runOf(dev, [await approve(w, dev, "alice")]);
  assert.equal(devRun.code, 0, devRun.stderr);

  // DEV evidence alone does not let PROD through.
  const prodAfterDev = await runOf(prod, [alice, bob]);
  assert.equal(prodAfterDev.code, 2);
  assert.match(prodAfterDev.stderr, /PROMOTION_EVIDENCE_MISSING/);

  const qaRun = await runOf(qa, [qaAlice]);
  assert.equal(qaRun.code, 0, qaRun.stderr);
  assert.equal((JSON.parse(qaRun.stdout) as { environment: string }).environment, "QA");

  const qaApprovalsForProd = await runOf(prod, [qaAlice, await approve(w, qa, "bob")]);
  assert.equal(qaApprovalsForProd.code, 2);
  assert.match(qaApprovalsForProd.stderr, /APPROVAL_MISBOUND/);

  const one = await runOf(prod, [alice]);
  assert.equal(one.code, 2);
  assert.match(one.stderr, /APPROVAL_INSUFFICIENT/);

  const twice = await runOf(prod, [alice, await approve(w, prod, "alice")]);
  assert.equal(twice.code, 2);
  assert.match(twice.stderr, /SAME_APPROVER_TWICE/);

  // The operator's own account name has no bearing: there is no requester check, only distinct signed approvers.
  const ok = await cli(w, applyArgs(prod, [alice, bob]), [applyPhrase(prod)], applyIn(prod, { operatorId: "alice" }));
  assert.equal(ok.code, 0, ok.stderr);
  assert.equal((JSON.parse(ok.stdout) as { environment: string }).environment, "PROD");
  assert.equal(applyCalls().length, 3);
});

test("an environment other than DEV, QA or PROD is refused as invalid input before anything runs", async () => {
  const w = await world();
  const p = writeProject(fresh("project"), QA_TARGET);
  for (const environment of ["STAGING", "qa", "", 7]) {
    const run = await cli(w, sealArgs(p, QA_TARGET, environment as string), [targetString(QA_TARGET), PHRASE], { env: identityEnv("QA") });
    assert.equal(run.code, 1, String(environment));
    assert.match(run.stderr, /APPLY_INPUT_INVALID.*DEV, QA or PROD/);
    assert.equal(run.stdout, "");
  }
  assert.deepEqual(engineCalls(), []);
});

test("an apply is refused before anything is asked when the manifest is not valid, or the vault holds no qualification", async () => {
  const w = await world();
  const s = await sealed(w, "DEV");
  const approval = await approve(w, s, "alice");
  const args = applyArgs(s, [approval]);
  args[args.indexOf("--manifest") + 1] = json({ bogus: true }, "bad-manifest");
  const badManifest = await cli(w, args, [applyPhrase(s)], applyIn(s));
  assert.equal(badManifest.code, 2);
  assert.match(badManifest.stderr, /MANIFEST_INVALID/);
  assert.deepEqual(badManifest.term.asked, []);
  const bare = await world(contractJson(KILL), false);
  const unqualified = await cli(bare, applyArgs(s, [approval]), [applyPhrase(s)], applyIn(s));
  assert.equal(unqualified.code, 2);
  assert.match(unqualified.stderr, /BLOCKED ENGINE_NOT_QUALIFIED/);
  assert.equal(applyCalls().length, 0);
});

// --- status ------------------------------------------------------------------------------

test("status reports the contract, the kill switch and whether an artifact was applied, and never calls the engine", async () => {
  const w = await world();
  const off = await cli(await world(contractJson(KILL, { enabled: false })), ["status"], []);
  assert.equal(off.code, 0);
  const disabled = JSON.parse(off.stdout) as { act: string; code: string; reason: string };
  assert.equal(disabled.act, "DISABLED");
  assert.equal(disabled.code, "ACT_DISABLED");
  assert.ok(disabled.reason.length > 0);
  // With no overrides the repository's own contract and pin decide: it ships with ACT disabled.
  const shipped = await cli(w, ["status"], [], { contractPath: undefined, contractPinPath: undefined });
  assert.equal((JSON.parse(shipped.stdout) as { act: string }).act, "DISABLED");

  const s = await sealed(w, "DEV");
  const idle = JSON.parse((await cli(w, ["status", "--sealed", s.path], [])).stdout) as { act: string; killSwitch: boolean; artifact: { artifactSha256: string; applied: boolean; environment: string } };
  assert.equal(idle.act, "PILOT_ENABLED");
  assert.equal(idle.killSwitch, false);
  assert.deepEqual(idle.artifact, { artifactSha256: s.artifactSha256, environment: "DEV", applied: false });
  const quiet = engineCalls().length;
  writeFileSync(KILL, "stop");
  assert.equal((JSON.parse((await cli(w, ["status"], [])).stdout) as { killSwitch: boolean }).killSwitch, true);
  rmSync(KILL);
  assert.equal(engineCalls().length, quiet, "status runs no engine");

  assert.equal((await cli(w, applyArgs(s, [await approve(w, s, "alice")]), [applyPhrase(s)], applyIn(s))).code, 0);
  const after = JSON.parse((await cli(w, ["status", "--sealed", s.path], [])).stdout) as { artifact: { applied: boolean } };
  assert.equal(after.artifact.applied, true);
});

test("a failure after the approvals were consumed and before the engine starts exits 3 (spent), never APPLY_UNEXPECTED_ERROR or the exit 1 of nothing spent", async () => {
  const w = await world();
  const s = await sealed(w, "DEV");
  const approval = await approve(w, s, "alice");
  behave({ initWrites: [{ path: "../alz-apply.tfplan", content: "in the way" }] });
  const run = await cli(w, applyArgs(s, [approval]), [applyPhrase(s)], applyIn(s));
  assert.equal(run.code, 3, run.stderr);
  assert.match(run.stderr, /BLOCKED APPROVALS_SPENT/);
  assert.match(run.stderr, /approvals were consumed/);
  assert.match(run.stderr, /sealed plan was given back/);
  assert.doesNotMatch(run.stderr, /APPLY_UNEXPECTED_ERROR|nothing was applied or spent/);
  assert.equal(run.stdout, "");
  assert.equal(applyCalls().length, 0);
  const status = JSON.parse((await cli(w, ["status", "--sealed", s.path], [])).stdout) as { artifact: { applied: boolean } };
  assert.equal(status.artifact.applied, false, "the artifact was given back");
  behave();
  const again = await cli(w, applyArgs(s, [approval]), [applyPhrase(s)], applyIn(s));
  assert.match(again.stderr, /BLOCKED APPROVAL_REPLAYED/, "the first approval is spent");
  assert.equal((await cli(w, applyArgs(s, [await approve(w, s, "bob")]), [applyPhrase(s)], applyIn(s))).code, 0);
});

test("approvers and the operator see an import, a move, a forget and output changes, and no bidi or zero-width character", async () => {
  const w = await world();
  behave({
    showResources: [
      { address: "azurerm_x.imported", type: "azurerm_x", change: { actions: ["no-op"], importing: { id: "/x" } } },
      { address: "azurerm_x.moved", type: "azurerm_x", previous_address: "azurerm_x.old", change: { actions: ["no-op"] } },
      { address: "azurerm_x.gone", type: "azurerm_x", change: { actions: ["forget"] } },
      { address: "azurerm_x.safe\u202Egnp.exe\u200B", type: "azurerm_x", change: { actions: ["create"] } },
    ],
    showOutputChanges: { endpoint: { actions: ["update"] } },
  });
  const s = await sealed(w, "DEV");
  const shown = (text: string) => {
    assert.match(text, /\[importing an existing resource\]/);
    assert.match(text, /azurerm_x\.moved \(azurerm_x\) \[moved from azurerm_x\.old\]/);
    assert.match(text, /FORGET\s+azurerm_x\.gone \(azurerm_x\) \[removed from state only; the real resource is left\]/);
    assert.match(text, /UPDATE\s+output\.endpoint \(output\)/);
    assert.ok(text.includes("azurerm_x.safegnp.exe"));
    assert.ok(!/[\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/.test(text), "no hidden character reaches the screen");
  };
  const approving = await cli(w, ["approve", "--bundle", s.bundle, "--key", keyFile("alice"), "--approver", "alice"], [approvePhrase(s)]);
  assert.equal(approving.code, 0, approving.stderr);
  shown(approving.term.out.join(""));
  const approval = JSON.parse(approving.stdout);
  const applying = await cli(w, applyArgs(s, [json(approval, "approval")]), [applyPhrase(s)], applyIn(s));
  assert.equal(applying.code, 0, applying.stderr);
  shown(applying.term.out.join(""));
});

type Readiness = { ready: boolean; checks: { check: string; ok: boolean; state: string; detail?: string }[] };
const stateOf = (report: Readiness, prefix: string) => report.checks.find((c) => c.check.startsWith(prefix))?.state;

test("preflight is read-only and offline: every item says READY, MISSING, INVALID, UNVERIFIED, UNAVAILABLE or BLOCKED, and names no value", async () => {
  const w = await world();
  const before = engineCalls().length;
  const run = async (args: string[], over: Partial<ApplyCliDeps> = {}) => cli(w, ["preflight", ...args], [], over);
  const ok = await run(["--environment", "DEV"]);
  assert.equal(ok.code, 0, ok.stderr);
  const report = JSON.parse(ok.stdout) as Readiness & { authentication?: unknown };
  assert.equal(report.ready, true);
  assert.equal(report.authentication, undefined, "there is no fixed authentication claim any more");
  assert.ok(report.checks.length >= 7 && report.checks.every((c) => c.ok && c.state === "READY"));
  assert.match(report.checks.find((c) => c.check.startsWith("engine qualified"))?.detail ?? "", /^Qualified in DEV/);
  assert.equal(stateOf(report, "identity separation attested"), "READY", "attested only because the qualification evidence records it");
  assert.equal(engineCalls().length, before, "no engine started");

  // A missing identity is MISSING, a collapsed pair INVALID; exit 2 (BLOCKED) and no value printed.
  const noIdentity = await run(["--environment", "DEV"], { env: {} });
  assert.equal(noIdentity.code, 2);
  assert.equal(stateOf(JSON.parse(noIdentity.stdout), "identities configured"), "MISSING");
  const secretValues = Object.values(ENV).filter((v): v is string => typeof v === "string" && v.length >= 8);
  for (const v of secretValues) assert.ok(!ok.stdout.includes(v) && !noIdentity.stdout.includes(v), "no identity value is printed");
  // A draft that is not pinned or enabled is MISSING the owner's approval, though its shape is checked.
  const draft = await world(contractJson(KILL, { enabled: false }));
  const drafted = JSON.parse((await cli(draft, ["preflight", "--environment", "DEV"], [])).stdout) as Readiness;
  assert.equal(drafted.checks[0].state, "READY", "a draft contract's shape is checked even though it is not enabled");
  assert.equal(stateOf(drafted, "pilot contract pinned"), "MISSING");
  // A missing tool is UNAVAILABLE; the emergency stop, a stop put in place on purpose, is BLOCKED.
  assert.equal(stateOf(JSON.parse((await run(["--environment", "DEV"], { toolDirs: [fresh("empty-tools")] })).stdout), "tool terraform"), "UNAVAILABLE");
  writeFileSync(KILL, "stop");
  const stopped = await run(["--environment", "DEV"]);
  assert.equal(stopped.code, 2);
  assert.equal(stateOf(JSON.parse(stopped.stdout), "kill switch absent"), "BLOCKED");
  rmSync(KILL);
  // The environment is required and checked; no flag changes what is checked.
  assert.equal((await run(["--environment", "STAGING"])).code, 1);
  assert.equal((await run([])).code, 1);
  assert.equal((await run(["--environment", "DEV", "--force", "yes"])).code, 1);
});

test("preflight does not say ready before qualification: no record is MISSING and the backend attestation stays UNVERIFIED, as seal would refuse", async () => {
  const w = await world(contractJson(KILL), false);
  const run = await cli(w, ["preflight", "--environment", "DEV"], []);
  assert.equal(run.code, 2, run.stderr);
  const report = JSON.parse(run.stdout) as Readiness;
  assert.equal(report.ready, false);
  assert.equal(stateOf(report, "engine qualified"), "MISSING");
  assert.match(report.checks.find((c) => c.check.startsWith("engine qualified"))?.detail ?? "", /\.\/alz apply qualify/);
  assert.equal(stateOf(report, "identity separation attested"), "UNVERIFIED");
  assert.ok(report.checks.filter((c) => !c.check.startsWith("engine qualified") && !c.check.startsWith("identity separation")).every((c) => c.state === "READY"));
  // What readiness reports is what seal does: the same machine cannot seal.
  const target = targetOf("DEV");
  const sealing = await cli(w, sealArgs(writeProject(fresh("project"), target), target, "DEV"), [targetString(target), PHRASE]);
  assert.match(sealing.stderr, /ENGINE_NOT_QUALIFIED/);

  // Evidence that no longer matches this machine (another engine binary) is INVALID, not MISSING: apply would refuse it too.
  const qualified = await world();
  const otherBinary = fresh("other-tools");
  installFakeTerraform(otherBinary);
  writeFileSync(join(otherBinary, "terraform"), readFileSync(join(otherBinary, "terraform"), "utf8") + "\n// a different build\n", { mode: 0o755 });
  const changed = JSON.parse((await cli(qualified, ["preflight", "--environment", "DEV"], [], { toolDirs: [otherBinary] })).stdout) as Readiness;
  assert.equal(stateOf(changed, "engine qualified"), "INVALID");
  assert.match(changed.checks.find((c) => c.check.startsWith("engine qualified"))?.detail ?? "", /this engine binary/);
  assert.equal(stateOf(changed, "identity separation attested"), "UNVERIFIED");
});

test("preflight gives a safe readiness item for a missing or unreadable owner contract", async () => {
  const w = await world(undefined, false);
  // An explicit undefined invokes the helper default, so remove its fixture to test genuine absence.
  rmSync(w.contractPath);
  const before = engineCalls().length;
  const args = ["preflight", "--environment", "DEV"];
  const absent = await cli(w, args, []);
  assert.equal(absent.code, 2, absent.stderr);
  assert.equal(absent.stderr, "", "missing pilot configuration must not surface a generic input-file error");
  const missing = JSON.parse(absent.stdout) as Readiness;
  assert.equal(missing.ready, false);
  assert.equal(missing.checks.length, 1);
  assert.match(missing.checks[0].check, /^contract shape/);
  assert.equal(missing.checks[0].state, "MISSING");
  assert.match(missing.checks[0].detail ?? "", /has not been installed by the owner/);
  assert.equal(engineCalls().length, before, "preflight never starts an engine");

  writeFileSync(w.contractPath, "{");
  const malformed = await cli(w, args, []);
  assert.equal(malformed.code, 2, malformed.stderr);
  assert.equal(malformed.stderr, "");
  const broken = JSON.parse(malformed.stdout) as Readiness;
  assert.equal(broken.ready, false);
  assert.equal(broken.checks[0].state, "INVALID");
  assert.match(broken.checks[0].detail ?? "", /cannot be read as valid JSON/);
  assert.equal(engineCalls().length, before, "invalid configuration cannot start an engine");
});

test("prepare writes the request and manifest from the contract and project, and seal accepts them unchanged", async () => {
  const w = await world(contractJson(KILL, { policyVersion: POLICY }));
  const target = targetOf("DEV");
  const project = writeProject(fresh("project"), target).projectRoot;
  // A variable from terraform.tfvars: prepare binds it as an input identity, and seal must accept that binding.
  writeFileSync(join(project, "variables.tf"), 'variable "location" {}\n');
  writeFileSync(join(project, "terraform.tfvars"), 'location = "westeurope"\n');
  const outDir = fresh("prepared");
  const before = engineCalls().length;
  const run = await cli(w, ["prepare", "--environment", "DEV", "--project", project], [], { preparationDir: outDir });
  assert.equal(run.code, 0, run.stdout + run.stderr);
  assert.equal(engineCalls().length, before, "prepare never starts an engine");
  assert.match(run.stdout, /LOCAL_PREPARATION: local files, not qualification evidence/);
  assert.match(run.stdout, /account {9}\S+/);
  assert.match(run.stdout, /Known gaps:/);
  const request = /request {3}(\S+)/.exec(run.stdout)?.[1];
  const manifest = /manifest {2}(\S+)/.exec(run.stdout)?.[1];
  assert.ok(request && manifest && existsSync(request) && existsSync(manifest));
  assert.match(run.stdout, /NEXT \.\/alz apply seal --request /);
  assert.match(run.stdout, /input {11}location from terraform\.tfvars/);
  assert.doesNotMatch(run.stdout, /westeurope/, "a value is never printed");
  assert.equal(readdirSync(join(outDir, "DEV")).length, 3);

  const seal = await cli(w, ["seal", "--request", request, "--manifest", manifest], [targetString(target), PHRASE]);
  assert.equal(seal.code, 0, seal.stderr);
  assert.match(JSON.parse(seal.stdout).artifactSha256, /^[0-9a-f]{64}$/);
});

test("prepare reports the exact owner prerequisite, offers no way around it, and writes nothing", async () => {
  const w = await world(contractJson(KILL));
  const project = writeProject(fresh("project"), targetOf("DEV")).projectRoot;
  const outDir = fresh("prepared");
  const run = await cli(w, ["prepare", "--environment", "DEV", "--project", project], [], { preparationDir: outDir });
  assert.equal(run.code, 2);
  assert.match(run.stdout, /^BLOCKED POLICY_VERSION_MISSING \(owner prerequisite\)/);
  assert.doesNotMatch(run.stdout, /Alternative/);
  assert.equal(readdirSync(outDir).length, 0);
  // No flag names an engine, a target or a policy version.
  for (const flag of ["--engine", "--target", "--policy-version", "--force"]) {
    assert.equal((await cli(w, ["prepare", "--environment", "DEV", "--project", project, flag, "x"], [])).code, 1);
  }
  assert.equal((await cli(w, ["prepare", "--environment", "DEV"], [])).code, 1);
});

test("seal and apply stop before any question when the product commit is unknown or uncommitted, and apply only from the commit that sealed it", async () => {
  const w = await world();
  const target = targetOf("DEV");
  const p = writeProject(fresh("project"), target);
  const before = engineCalls().length;
  const unknown = await cli(w, sealArgs(p, target, "DEV"), [targetString(target), PHRASE], { sourceCommit: "not-a-commit" });
  assert.equal(unknown.code, 2);
  assert.match(unknown.stderr, /^BLOCKED SOURCE_UNVERIFIED/);
  assert.deepEqual(unknown.term.asked, [], "no phrase was asked");
  assert.equal(engineCalls().length, before, "no engine ran");

  const s = await sealed(w, "DEV");
  assert.match(s.artifactSha256, /^[0-9a-f]{64}$/);
  const bundle = JSON.parse(readFileSync(s.bundle, "utf8")) as { sourceCommit: string };
  assert.equal(bundle.sourceCommit, SOURCE_COMMIT, "the review bundle names the commit approvers sign");
  const approval = await approve(w, s, "alice");
  const appliedBefore = applyCalls().length;
  const moved = await cli(w, applyArgs(s, [approval]), [applyPhrase(s)], applyIn(s, { sourceCommit: "1".repeat(40) }));
  assert.equal(moved.code, 2);
  assert.match(moved.stderr, /^BLOCKED SOURCE_CHANGED/);
  assert.deepEqual(moved.term.asked, [], "no phrase was asked");
  assert.equal(applyCalls().length, appliedBefore, "no engine ran");
  const applied = await cli(w, applyArgs(s, [approval]), [applyPhrase(s)], applyIn(s));
  assert.equal(applied.code, 0, applied.stderr);
  assert.equal((JSON.parse(applied.stdout) as { sourceCommit: string }).sourceCommit, SOURCE_COMMIT, "the evidence names the commit");
});

test("approvers and the operator see which engine program made the preview and that real-engine evidence covers it; apply stops before any question when the program changed", async () => {
  const w = await world();
  const s = await sealed(w, "DEV");
  const program = createHash("sha256").update(readFileSync(join(toolDir, "terraform"))).digest("hex");
  const bundle = JSON.parse(readFileSync(s.bundle, "utf8")) as { provenance: { engineBinarySha256: string; qualification: { state: string } } };
  assert.equal(bundle.provenance.engineBinarySha256, program, "the review bundle names the program approvers sign");
  assert.equal(bundle.provenance.qualification.state, "QUALIFIED");
  const approved = await cli(w, ["approve", "--bundle", s.bundle, "--key", keyFile("alice"), "--approver", "alice"], [approvePhrase(s)]);
  assert.equal(approved.code, 0, approved.stderr);
  const shown = approved.term.out.join("");
  assert.ok(shown.includes("preview engine  version 1.9.5, program sha256 " + program), shown);
  assert.match(shown, /qualified {7}yes: real-engine evidence [0-9a-f]{12} from /);
  const approval = await approve(w, s, "alice");

  const appliedBefore = applyCalls().length;
  appendFileSync(join(toolDir, "terraform"), "// another build of the program\n");
  try {
    const swapped = await cli(w, applyArgs(s, [approval]), [applyPhrase(s)], applyIn(s));
    assert.equal(swapped.code, 2);
    assert.match(swapped.stderr, /^BLOCKED ENGINE_BINARY_CHANGED/);
    assert.deepEqual(swapped.term.asked, [], "no phrase was asked");
    assert.equal(applyCalls().length, appliedBefore, "no engine ran");
  } finally { installFakeTerraform(toolDir); }
  const applied = await cli(w, applyArgs(s, [approval]), [applyPhrase(s)], applyIn(s));
  assert.equal(applied.code, 0, applied.stderr);
  assert.ok(applied.term.out.join("").includes("program sha256 " + program), "the apply screen shows the program too");
});

test("record-live makes the execute step's live record only from a recorded successful apply, after the person attests it, and never overwrites it", async () => {
  const w = await world();
  const s = await sealed(w, "DEV");
  const acceptanceDir = fresh("acceptance");
  const record = (answers: string[]) => cli(w, ["record-live", "--sealed", s.path], answers, { acceptanceDir });
  const phrase = "LIVE DEV " + s.artifactSha256.slice(0, 12);

  const early = await record([phrase]);
  assert.equal(early.code, 1);
  assert.match(early.stderr, /^LIVE_RECORD_UNAVAILABLE/);
  assert.deepEqual(readdirSync(acceptanceDir), []);

  const applied = await cli(w, applyArgs(s, [await approve(w, s, "alice")]), [applyPhrase(s)], applyIn(s));
  assert.equal(applied.code, 0, applied.stderr);
  const before = engineCalls().length;
  const wrong = await record(["LIVE DEV"]);
  assert.equal(wrong.code, 1);
  assert.match(wrong.stderr, /^LIVE_ATTESTATION_MISMATCH/);
  assert.deepEqual(readdirSync(acceptanceDir), [], "nothing is written without the attestation");

  const done = await record([phrase]);
  assert.equal(done.code, 0, done.stderr);
  assert.equal(engineCalls().length, before, "recording starts no engine");
  const { written } = JSON.parse(done.stdout) as { written: string };
  const saved = JSON.parse(readFileSync(written, "utf8")) as Record<string, unknown>;
  const evidence = JSON.parse(applied.stdout) as { artifactSha256: string; sourceCommit: string; target: unknown };
  assert.deepEqual(Object.keys(saved).sort(), ["artifactSha256", "attestedAt", "attestedBy", "cloud", "contractSha256", "engine", "environment",
    "evidenceSha256", "label", "outcome", "schemaVersion", "sourceCommit", "step", "target"]);
  assert.equal(saved.label, "LIVE");
  assert.equal(saved.step, "execute");
  assert.equal(saved.cloud, "AZURE");
  assert.equal(saved.engine, "TERRAFORM");
  assert.equal(saved.sourceCommit, SOURCE_COMMIT);
  assert.equal(saved.artifactSha256, evidence.artifactSha256);
  assert.deepEqual(saved.target, evidence.target);
  assert.equal(saved.attestedBy, "operator.fixture");
  for (const canary of [OUTPUT_CANARY, PLAN_CANARY, VALUE_CANARY, STATE_CANARY]) assert.ok(!readFileSync(written, "utf8").includes(canary), "no value reaches the record");

  const again = await record([phrase]);
  assert.equal(again.code, 1);
  assert.match(again.stderr, /^LIVE_RECORD_EXISTS/);
  assert.equal(readdirSync(acceptanceDir).length, 1);
});
