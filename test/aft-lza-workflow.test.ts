import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

import { AwsCliReader, assertNoAmbientKeys, type AwsExec } from "../src/aft-lza/aws-reader.js";
import { OperationStore } from "../src/aft-lza/operation-store.js";
import { advance, recordMerge, type AftLzaReader } from "../src/aft-lza/run.js";
import {
  checkReinvocation, decideNext, routeDrift, validateCard,
  type AccountObservation, type AftLzaCard, type ControlObservation, type PipelineObservation, type RunObservations,
} from "../src/aft-lza/workflow.js";

// SYNTHETIC: every observation below is a fixture. None of it is AWS evidence.

const L = "1".repeat(40), A = "2".repeat(40), ID = "111122223333", OU = "ou-ab12-cdef3456";
const card = (over: Partial<AftLzaCard> = {}): AftLzaCard => ({
  runId: "pilot-001", organizationId: "o-abcdefghij", homeRegion: "us-east-1", regions: ["us-east-1", "us-west-2"],
  account: { name: "pilot-nonprod", email: "pilot+np@example.com", ouId: OU },
  lza: { repository: "acme/lza-config", baseBranch: "main", pipelineName: "AWSAccelerator-Pipeline", configurationDigest: "a".repeat(64), validatorEvidenceDigest: "b".repeat(64) },
  aft: { repository: "acme/aft-account-request", baseBranch: "main", requestPipelineName: "ct-aft-account-request", requestDigest: "c".repeat(64), requestedName: "pilot-nonprod", requestedEmail: "pilot+np@example.com" },
  disposition: "RETAIN", ...over,
});
const run = (pipelineName: string, rev: string, status: PipelineObservation["status"] = "Succeeded", executionId = "e-" + pipelineName): PipelineObservation =>
  ({ pipelineName, executionId, sourceRevision: rev, status, evidence: "OBSERVED" });
const acct = (over: Partial<AccountObservation> = {}): AccountObservation => ({ accountId: ID, name: "pilot-nonprod", email: "pilot+np@example.com", parentOuId: OU, status: "ACTIVE", evidence: "OBSERVED", ...over });
const ctl = (region: string, result: ControlObservation["result"] = "PASS"): ControlObservation => ({ region, controlId: "cloudtrail-enabled", result, evidence: "OBSERVED" });
const full = (over: Partial<RunObservations> = {}): RunObservations => ({
  lzaMergedCommit: L, lzaExecution: run("AWSAccelerator-Pipeline", L), account: acct(), aftMergedCommit: A,
  aftRequestExecution: run("ct-aft-account-request", A), customizationExecutions: [run(ID + "-customizations-pipeline", "x")],
  controls: [ctl("us-east-1"), ctl("us-west-2")], ...over,
});
const store = () => new OperationStore(join(realpathSync(mkdtempSync(join(tmpdir(), "alz-aftlza-"))), "ops"));

test("happy path reaches VERIFIED only with observed controls in every Region", () => {
  assert.equal(decideNext(card(), full()).phase, "VERIFIED");
  assert.equal(decideNext(card(), full({ controls: [ctl("us-east-1")] })).code, "CONTROLS_INCOMPLETE");
  assert.equal(decideNext(card(), full({ controls: [{ ...ctl("us-east-1"), evidence: "SIMULATED" }, ctl("us-west-2")] })).phase, "UNRESOLVED");
  assert.equal(decideNext(card(), full({ controls: [ctl("us-east-1", "UNKNOWN"), ctl("us-west-2")] })).phase, "UNRESOLVED");
  assert.equal(decideNext(card(), full({ controls: [] })).code, "CONTROLS_NOT_OBSERVED");
});

test("lza-failure-blocks-aft", () => {
  const dec = decideNext(card(), { lzaMergedCommit: L, lzaExecution: run("AWSAccelerator-Pipeline", L, "Failed") });
  assert.equal(dec.code, "LZA_FAILED");
  assert.equal(dec.mutationByPerson, false);
});

test("unrelated-pipeline-does-not-advance", () => {
  assert.equal(decideNext(card(), { lzaMergedCommit: L, lzaExecution: run("AWSAccelerator-Pipeline", "9".repeat(40)) }).code, "LZA_EXECUTION_UNRELATED");
  assert.equal(decideNext(card(), { lzaMergedCommit: L, lzaExecution: run("Other-Pipeline", L) }).code, "LZA_EXECUTION_UNRELATED");
  assert.equal(decideNext(card(), full({ aftRequestExecution: run("ct-aft-account-request", L) })).code, "AFT_EXECUTION_UNRELATED");
});

test("unconfirmed-account-blocks-aft; unreadable is unresolved, not mismatch", () => {
  const base = { lzaMergedCommit: L, lzaExecution: run("AWSAccelerator-Pipeline", L) };
  assert.equal(decideNext(card(), base).code, "ACCOUNT_NOT_CONFIRMED");
  assert.equal(decideNext(card(), { ...base, accountLookup: "ACCESS_DENIED" }).phase, "UNRESOLVED");
});

test("name-or-email-mismatch-rejected and wrong-ou-rejected", () => {
  assert.equal(decideNext(card(), full({ account: acct({ name: "other" }) })).code, "ACCOUNT_IDENTITY_MISMATCH");
  assert.equal(decideNext(card(), full({ account: acct({ email: "x@example.com" }) })).code, "ACCOUNT_IDENTITY_MISMATCH");
  assert.equal(decideNext(card(), full({ account: acct({ parentOuId: "ou-zz99-zzzzzzzz" }) })).code, "ACCOUNT_IDENTITY_MISMATCH");
  const issues = validateCard(card({ aft: { ...card().aft, requestedEmail: "other@example.com" } }));
  assert.ok(issues.some((i) => i.includes("AccountEmail")));
});

test("card offline validation blocks unresolved fields, missing validator evidence and a shared repository", () => {
  assert.deepEqual(validateCard(card()), []);
  assert.ok(validateCard(card({ lza: { ...card().lza, validatorEvidenceDigest: undefined } })).some((i) => i.includes("validator")));
  assert.ok(validateCard(card({ aft: { ...card().aft, repository: "acme/lza-config" } })).some((i) => i.includes("separate")));
  assert.ok(validateCard(card({ regions: ["us-west-2"] })).some((i) => i.includes("home Region")));
  assert.equal(decideNext(card({ organizationId: "UNRESOLVED" }), {}).code, "CARD_INCOMPLETE");
});

test("configuration-change-reevaluates-dependency without repeating account creation", () => {
  assert.equal(decideNext(card(), { lzaMergedCommit: L, currentLzaConfigurationDigest: "d".repeat(64) }).phase, "REAUTHORIZE");
  const after = decideNext(card(), full({ aftMergedCommit: undefined, aftRequestExecution: undefined, currentAftRequestDigest: "d".repeat(64) }));
  assert.equal(after.code, "AFT_REQUEST_CHANGED");
  assert.match(after.detail, /kept/);
});

test("customization-recovery-preserves-account and reinvocation is scoped to one account", () => {
  const obs = full({ customizationExecutions: [run(ID + "-customizations-pipeline", "x", "Failed")], controls: undefined });
  const dec = decideNext(card(), obs);
  assert.equal(dec.phase, "RECOVER_CUSTOMIZATION");
  const ok = checkReinvocation(card(), obs, { accountIds: [ID], priorExecutionReconciled: true, attempt: 1 });
  assert.deepEqual(ok, { allowed: true, input: { include: [{ type: "accounts", target_value: [ID] }] } });
  assert.equal((checkReinvocation(card(), obs, { accountIds: [ID, "999988887777"], priorExecutionReconciled: true, attempt: 1 }) as { code: string }).code, "SCOPE_EXPANSION");
  assert.equal((checkReinvocation(card(), obs, { accountIds: [ID], includeAll: true, priorExecutionReconciled: true, attempt: 1 }) as { code: string }).code, "SCOPE_EXPANSION");
  assert.equal((checkReinvocation(card(), obs, { accountIds: [ID], priorExecutionReconciled: false, attempt: 1 }) as { code: string }).code, "RECONCILE_FIRST");
  assert.equal((checkReinvocation(card(), obs, { accountIds: [ID], priorExecutionReconciled: true, attempt: 4 }) as { code: string }).code, "RETRY_BUDGET_EXHAUSTED");
  assert.equal((checkReinvocation(card(), full(), { accountIds: [ID], priorExecutionReconciled: true, attempt: 1 }) as { code: string }).code, "NOT_IN_RECOVERY");
});

test("drift routes to its owner and never auto-repairs", () => {
  assert.deepEqual(routeDrift({ resourceArn: "arn:x", owner: "LZA", detail: "" }), { route: "LZA_OWNER", autoRepair: false });
  assert.equal(routeDrift({ resourceArn: "arn:x", owner: "BOTH", detail: "" }).route, "OWNERSHIP_CONFLICT");
});

// Fake reader for the end-to-end synthetic journey.
class FakeReader implements AftLzaReader {
  executions = new Map<string, PipelineObservation[]>();
  account: AccountObservation | undefined;
  controlsSeen: ControlObservation[] = [];
  accountReads = 0;
  async pipelineExecutions(name: string) { return this.executions.get(name) ?? []; }
  async findAccountByEmail() { this.accountReads++; return this.account ? { lookup: "FOUND" as const, account: this.account } : { lookup: "NOT_FOUND" as const }; }
  async controls() { return this.controlsSeen; }
}

test("synthetic journey: LZA then identity then AFT then customization then controls, with a restart in between", async () => {
  const s = store(); const r = new FakeReader(); const c = card();
  let step = await advance(c, s, r);
  assert.equal(step.decision.phase, "AWAIT_LZA_SUBMISSION");
  assert.equal(step.journal.lza, "EXECUTE_ONCE");
  assert.equal(step.deploymentAuthorized, false);
  // Interrupted before the merge was recorded: offering the write again is RECONCILE, not a second submission.
  step = await advance(c, s, r);
  assert.equal(step.journal.lza, "RECONCILE");
  assert.equal(step.decision.mutationByPerson, false);
  recordMerge(s, c, "lza", L);
  r.executions.set("AWSAccelerator-Pipeline", [run("AWSAccelerator-Pipeline", L, "InProgress")]);
  assert.equal((await advance(c, s, r)).decision.code, "LZA_RUNNING");
  r.executions.set("AWSAccelerator-Pipeline", [run("AWSAccelerator-Pipeline", L)]);
  assert.equal((await advance(c, s, r)).decision.code, "ACCOUNT_NOT_CONFIRMED");
  r.account = acct();
  step = await advance(c, s, r);
  assert.equal(step.decision.phase, "AWAIT_AFT_SUBMISSION");
  // restart-after-account-creation-does-not-recreate: a new store on the same folder resumes at AFT, LZA is reused.
  const restarted = new OperationStore((s as unknown as { dir: string }).dir);
  step = await advance(c, restarted, r);
  assert.equal(step.decision.phase, "AWAIT_AFT_SUBMISSION");
  assert.equal(step.journal.lza, undefined);
  recordMerge(restarted, c, "aft", A);
  r.executions.set("ct-aft-account-request", [run("ct-aft-account-request", A)]);
  r.executions.set(ID + "-customizations-pipeline", [run(ID + "-customizations-pipeline", "x", "Failed")]);
  assert.equal((await advance(c, restarted, r)).decision.phase, "RECOVER_CUSTOMIZATION");
  r.executions.set(ID + "-customizations-pipeline", [run(ID + "-customizations-pipeline", "x", "Failed"), run(ID + "-customizations-pipeline", "x", "Succeeded", "e2")]);
  r.controlsSeen = [ctl("us-east-1"), ctl("us-west-2")];
  step = await advance(c, restarted, r);
  assert.equal(step.decision.phase, "VERIFIED");
  assert.equal(step.evidenceLabel, "SYNTHETIC");
});

test("recordMerge refuses a write the runner never offered and a changed digest", () => {
  const s = store();
  assert.throws(() => recordMerge(s, card(), "lza", L), /NO_INTENT/);
  assert.equal(s.hasIntent("pilot-001:lza"), false, "a refused merge leaves no intent behind");
  s.beginEffect("pilot-001:lza", "a".repeat(64));
  assert.throws(() => s.beginEffect("pilot-001:lza", "f".repeat(64)), /ACTION_CONTENT_CONFLICT/);
  assert.throws(() => s.confirmEffect("pilot-001:lza", "a".repeat(64), { sessionToken: "x" }), /SECRETS/);
});

test("lost-aft-submission-response-reconciles and later processes reconcile instead of resubmitting (separate OS processes)", () => {
  const dir = join(realpathSync(mkdtempSync(join(tmpdir(), "alz-aftlza-proc-"))), "ops");
  const mod = resolve("src/aft-lza/operation-store.ts");
  // A fixed child script; the module, directory and digest travel as arguments, never as generated code.
  const script = join(dirname(dir), "child.mjs");
  writeFileSync(script, [
    "const [mod, dir, digest, kill] = process.argv.slice(2);",
    "const { OperationStore } = await import(mod);",
    "process.stdout.write(new OperationStore(dir).beginEffect('pilot-001:aft-registration', digest));",
    "if (kill === 'kill') process.kill(process.pid, 'SIGKILL');",
  ].join("\n"));
  const child = (exitAfter: boolean) => spawnSync(process.execPath, ["--import", "tsx", script, pathToFileURL(mod).href, dir, "c".repeat(64), exitAfter ? "kill" : "stay"], { encoding: "utf8" });
  // The first process records intent and is killed before any receipt: the write may or may not have happened.
  const first = child(true);
  assert.equal(first.stdout, "EXECUTE_ONCE");
  assert.equal(first.signal, "SIGKILL");
  // Every later process, concurrent or restarted, must reconcile instead of submitting again.
  const results = [child(false), child(false), child(false)].map((r) => r.stdout);
  assert.deepEqual(results, ["RECONCILE", "RECONCILE", "RECONCILE"]);
});

test("AWS reader runs only allow-listed read calls and refuses ambient keys", async () => {
  assert.throws(() => assertNoAmbientKeys({ AWS_ACCESS_KEY_ID: "AKIA" }), /AMBIENT/);
  const calls: string[][] = [];
  const exec: AwsExec = async (args) => {
    calls.push(args);
    if (args[1] === "list-accounts") return { code: 0, stderr: "", stdout: JSON.stringify({ Accounts: [{ Id: ID, Name: "pilot-nonprod", Email: "pilot+np@example.com", Status: "ACTIVE" }] }) };
    if (args[1] === "list-parents") return { code: 0, stderr: "", stdout: JSON.stringify({ Parents: [{ Id: OU, Type: "ORGANIZATIONAL_UNIT" }] }) };
    if (args[1] === "list-pipeline-executions") return { code: 0, stderr: "", stdout: JSON.stringify({ pipelineExecutionSummaries: [{ pipelineExecutionId: "new", status: "InProgress", sourceRevisions: [{ revisionId: L }] }, { pipelineExecutionId: "old", status: "Succeeded", sourceRevisions: [{ revisionId: "9".repeat(40) }] }] }) };
    if (args[1] === "describe-compliance-by-config-rule") return args.includes("us-west-2") ? { code: 254, stdout: "", stderr: "AccessDeniedException" } : { code: 0, stderr: "", stdout: JSON.stringify({ ComplianceByConfigRules: [{ ConfigRuleName: "cloudtrail-enabled", Compliance: { ComplianceType: "COMPLIANT" } }] }) };
    return { code: 1, stdout: "", stderr: "unexpected" };
  };
  const reader = new AwsCliReader(exec, ["cloudtrail-enabled"]);
  const found = await reader.findAccountByEmail("PILOT+np@example.com");
  assert.equal(found.lookup === "FOUND" && found.account.parentOuId, OU);
  const execs = await reader.pipelineExecutions("AWSAccelerator-Pipeline", "us-east-1");
  assert.deepEqual(execs.map((e) => e.executionId), ["old", "new"]);
  const controls = await reader.controls(ID, ["us-east-1", "us-west-2"]);
  assert.deepEqual(controls.map((c) => c.result), ["PASS", "UNKNOWN"]);
  for (const args of calls) assert.match(args.slice(0, 2).join(" "), /^(organizations (list-accounts|list-parents)|codepipeline list-pipeline-executions|configservice describe-compliance-by-config-rule)$/);
  // access-denied control evidence keeps the run UNRESOLVED
  assert.equal(decideNext(card(), full({ controls })).phase, "UNRESOLVED");
});
