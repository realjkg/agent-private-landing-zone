import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { OperationStore } from "../src/aft-lza/operation-store.js";
import { advanceRemoval, recordRemoval } from "../src/aft-lza/removal-run.js";
import { decideRemoval, validateRemovalCard, type RemovalCard, type RemovalObservations } from "../src/aft-lza/removal.js";
import type { AftLzaReader } from "../src/aft-lza/run.js";
import type { AccountObservation, PipelineObservation } from "../src/aft-lza/workflow.js";
import { aftLzaRemovalStage } from "../src/evidence-runner/aft-lza-removal.js";
import { loadConfig } from "../src/evidence-runner/config.js";
import { Journal } from "../src/evidence-runner/journal.js";
import type { StageContext } from "../src/evidence-runner/steps.js";
import { DEFAULT_STAGES, READONLY_STAGES, STAGES } from "../src/evidence-runner/types.js";
import { CANDIDATE } from "./helpers/evidence-fixtures.js";

// SYNTHETIC: the removal decision and stage with an in-memory reader. Nothing reaches AWS or GitHub.

const A = "a".repeat(40), Z = "e".repeat(40), ID = "111122223333", IGNORED = "ou-ab12-ignored99", GOVERNED = "ou-ab12-cdef3456";
const CARD: RemovalCard = {
  runId: "pilot-001", homeRegion: "eu-west-1",
  account: { accountId: ID, name: "pilot-nonprod", email: "pilot+np@example.com" },
  ignoredOuId: IGNORED,
  aft: { repository: "acme/aft-account-request", baseBranch: "main", requestPipelineName: "ct-aft-account-request", removalDigest: "c".repeat(64) },
  lza: { repository: "acme/lza-config", baseBranch: "main", pipelineName: "AWSAccelerator-Pipeline", configurationDigest: "d".repeat(64) },
};

const run = (pipelineName: string, sourceRevision: string, status: PipelineObservation["status"], evidence: PipelineObservation["evidence"] = "OBSERVED"): PipelineObservation =>
  ({ pipelineName, executionId: "x-" + sourceRevision.slice(0, 4), sourceRevision, status, evidence });
const account = (parentOuId: string, accountId = ID, evidence: AccountObservation["evidence"] = "OBSERVED"): AccountObservation =>
  ({ accountId, name: "pilot-nonprod", email: "pilot+np@example.com", parentOuId, status: "ACTIVE", evidence });

const aftDone: RemovalObservations = { aftRemovalCommit: A, aftRemovalExecution: run("ct-aft-account-request", A, "Succeeded") };
const unmanaged: RemovalObservations = { ...aftDone, unmanagedAccountId: ID };
const lzaDone: RemovalObservations = { ...unmanaged, lzaMoveCommit: Z, lzaMoveExecution: run("AWSAccelerator-Pipeline", Z, "Succeeded") };

test("an incomplete removal card is unresolved, and no field is filled in for the owner", () => {
  const issues = validateRemovalCard({ ...CARD, ignoredOuId: "", account: { ...CARD.account, accountId: "" } });
  assert.ok(issues.some((i) => i.includes("ignoredOuId")));
  assert.ok(issues.some((i) => i.includes("account.accountId")));
  assert.equal(decideRemoval({ ...CARD, ignoredOuId: "" }, {}).phase, "UNRESOLVED");
});

test("removal runs in AWS's order: AFT, then Control Tower, then LZA, then confirmation", () => {
  assert.equal(decideRemoval(CARD, {}).phase, "AWAIT_AFT_REMOVAL");
  assert.equal(decideRemoval(CARD, {}).mutationByPerson, true);
  assert.equal(decideRemoval(CARD, { aftRemovalCommit: A }).code, "AFT_REMOVAL_EXECUTION_NOT_FOUND");
  assert.equal(decideRemoval(CARD, aftDone).phase, "AWAIT_UNMANAGE");
  assert.equal(decideRemoval(CARD, unmanaged).phase, "AWAIT_LZA_MOVE");
  assert.equal(decideRemoval(CARD, { ...unmanaged, lzaMoveCommit: Z }).code, "LZA_MOVE_EXECUTION_NOT_FOUND");
  assert.equal(decideRemoval(CARD, lzaDone).phase, "CONFIRM_MOVED");
  const retired = decideRemoval(CARD, { ...lzaDone, account: account(IGNORED), accountLookup: "FOUND" });
  assert.equal(retired.phase, "RETIRED");
  assert.match(retired.nextAction, /never closes/);
});

test("LZA is not offered before AFT has removed the account, and Control Tower comes before LZA", () => {
  // An LZA receipt without the earlier steps does not skip them.
  assert.equal(decideRemoval(CARD, { lzaMoveCommit: Z, lzaMoveExecution: run("AWSAccelerator-Pipeline", Z, "Succeeded") }).phase, "AWAIT_AFT_REMOVAL");
  assert.equal(decideRemoval(CARD, { ...aftDone, lzaMoveCommit: Z }).phase, "AWAIT_UNMANAGE");
});

test("failed, running, unrelated and simulated executions never advance the removal", () => {
  assert.equal(decideRemoval(CARD, { aftRemovalCommit: A, aftRemovalExecution: run("ct-aft-account-request", A, "Failed") }).code, "AFT_REMOVAL_FAILED");
  assert.equal(decideRemoval(CARD, { aftRemovalCommit: A, aftRemovalExecution: run("ct-aft-account-request", A, "InProgress") }).code, "AFT_REMOVAL_RUNNING");
  assert.equal(decideRemoval(CARD, { aftRemovalCommit: A, aftRemovalExecution: run("ct-aft-account-request", Z, "Succeeded") }).code, "AFT_REMOVAL_EXECUTION_UNRELATED");
  assert.equal(decideRemoval(CARD, { aftRemovalCommit: A, aftRemovalExecution: run("ct-aft-account-request", A, "Succeeded", "SIMULATED") }).code, "AFT_REMOVAL_EVIDENCE_SIMULATED");
  assert.equal(decideRemoval(CARD, { ...unmanaged, lzaMoveCommit: Z, lzaMoveExecution: run("AWSAccelerator-Pipeline", Z, "Stopped") }).code, "LZA_MOVE_FAILED");
  assert.equal(decideRemoval(CARD, { ...unmanaged, lzaMoveCommit: Z, lzaMoveExecution: run("AWSAccelerator-Pipeline", Z, "Succeeded", "SIMULATED") }).code, "LZA_MOVE_EVIDENCE_SIMULATED");
  assert.equal(decideRemoval(CARD, { aftRemovalCommit: "abc" }).code, "AFT_REMOVAL_COMMIT_MALFORMED");
});

test("placement is confirmed independently: wrong OU, wrong account, unreadable, missing or simulated never retire", () => {
  assert.equal(decideRemoval(CARD, { ...lzaDone, account: account(GOVERNED), accountLookup: "FOUND" }).code, "ACCOUNT_NOT_IN_IGNORED_OU");
  assert.equal(decideRemoval(CARD, { ...lzaDone, account: account(IGNORED, "999988887777"), accountLookup: "FOUND" }).code, "ACCOUNT_ID_MISMATCH");
  assert.equal(decideRemoval(CARD, { ...lzaDone, accountLookup: "ACCESS_DENIED" }).phase, "UNRESOLVED");
  assert.equal(decideRemoval(CARD, { ...lzaDone, accountLookup: "NOT_FOUND" }).code, "ACCOUNT_NOT_FOUND");
  assert.equal(decideRemoval(CARD, { ...lzaDone, account: account(IGNORED, ID, "SIMULATED"), accountLookup: "FOUND" }).phase, "UNRESOLVED");
  assert.equal(decideRemoval(CARD, { ...aftDone, unmanagedAccountId: "999988887777" }).code, "UNMANAGED_ACCOUNT_MISMATCH");
});

class Reader implements AftLzaReader {
  runs: PipelineObservation[] = [];
  account?: AccountObservation;
  async pipelineExecutions(name: string) { return this.runs.filter((r) => r.pipelineName === name); }
  async findAccountByEmail() { return this.account ? { lookup: "FOUND" as const, account: this.account } : { lookup: "NOT_FOUND" as const }; }
  async controls() { return []; }
}

function store(): OperationStore {
  return new OperationStore(join(realpathSync(mkdtempSync(join(tmpdir(), "alz-removal-store-"))), "ops"));
}

test("a step is journaled before it is offered; a second offer is RECONCILE, and a receipt needs the offer first", async () => {
  const reader = new Reader();
  const s = store();
  assert.throws(() => recordRemoval(s, CARD, "aft", A), /NO_INTENT/);
  const first = await advanceRemoval(CARD, s, reader);
  assert.equal(first.decision.phase, "AWAIT_AFT_REMOVAL");
  assert.equal(first.journal.aft, "EXECUTE_ONCE");
  assert.equal(first.accountClosedByRunner, false);
  const again = await advanceRemoval(CARD, s, reader);
  assert.equal(again.journal.aft, "RECONCILE");
  assert.equal(again.decision.code, "AFT_REMOVAL_NOT_SUBMITTED_RECONCILE");
  assert.equal(again.decision.mutationByPerson, false);
  assert.throws(() => recordRemoval(s, CARD, "aft", "not-a-sha"), /FULL_SHA/);
  recordRemoval(s, CARD, "aft", A);
  reader.runs.push(run("ct-aft-account-request", A, "Succeeded"));
  const unmanage = await advanceRemoval(CARD, s, reader);
  assert.equal(unmanage.decision.phase, "AWAIT_UNMANAGE");
  assert.throws(() => recordRemoval(s, CARD, "unmanage", "12345"), /12_DIGITS/);
  recordRemoval(s, CARD, "unmanage", ID);
  assert.equal((await advanceRemoval(CARD, s, reader)).decision.phase, "AWAIT_LZA_MOVE");
  recordRemoval(s, CARD, "lza", Z);
  reader.runs.push(run("AWSAccelerator-Pipeline", Z, "Succeeded"));
  reader.account = account(IGNORED);
  const done = await advanceRemoval(CARD, s, reader);
  assert.equal(done.decision.phase, "RETIRED");
  assert.equal(done.observations.aftRemovalCommit, A);
  assert.equal(done.observations.unmanagedAccountId, ID);
});

function context(answers: string[], tty = true): { ctx: StageContext; root: string; lines: string[] } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "alz-removal-stage-")));
  mkdirSync(join(root, "config"));
  writeFileSync(join(root, "config", "aft-lza-removal-card.json"), JSON.stringify(CARD));
  const runDir = join(root, ".runs", "evidence", "run-1");
  mkdirSync(runDir, { recursive: true });
  const lines: string[] = [];
  const journal = new Journal(join(runDir, "journal.jsonl"), { sourceCommit: CANDIDATE, configSha256: "a".repeat(64), targetHardwareId: "owner-mac-01", label: "SYNTHETIC", host: "h", identityHash: "b".repeat(64) });
  const ctx = {
    root, label: "SYNTHETIC", runDir, runDirRel: ".runs/evidence/run-1", journal, env: {}, childHome: join(root, "home"),
    config: { schemaVersion: 1, candidateCommit: CANDIDATE, targetHardwareId: "owner-mac-01", evidenceDir: ".runs/evidence",
      aws: { expectedAccountId: ID, region: "eu-west-1", qualificationStack: "alz-qualification-noop", aftLzaRemovalCard: "config/aft-lza-removal-card.json" } },
    preflight: { identities: [{ provider: "aws", status: "PASS", code: "VERIFIED", detail: "ok" }] },
    spawn: async () => { throw new Error("the removal stage must not start a child in this test"); },
    terminal: { stdinIsTTY: tty, stdoutIsTTY: tty, ask: async () => answers.shift() ?? "" },
    at: () => "2026-11-14T00:00:00.000Z", out: (line: string) => lines.push(line),
  } as unknown as StageContext;
  return { ctx, root, lines };
}

test("the removal stage is named-only, read-only and configured through config.aws.aftLzaRemovalCard", () => {
  assert.ok(STAGES.includes("aws-aft-lza-removal"));
  assert.ok(!DEFAULT_STAGES.includes("aws-aft-lza-removal"), "never selected without --stage");
  assert.ok(READONLY_STAGES.includes("aws-aft-lza-removal"), "refuses to run beside a mutation identity");
  const root = realpathSync(mkdtempSync(join(tmpdir(), "alz-removal-cfg-")));
  mkdirSync(join(root, "config"));
  const base = { schemaVersion: 1, candidateCommit: CANDIDATE, targetHardwareId: "owner-mac-01", evidenceDir: ".runs/evidence" };
  writeFileSync(join(root, "config", "evidence-runner.json"), JSON.stringify({ ...base, aws: { expectedAccountId: ID, region: "eu-west-1", qualificationStack: "s", aftLzaRemovalCard: "../card.json" } }));
  assert.equal(loadConfig(root, "config/evidence-runner.json").ok, false);
});

test("the stage skips without a card, blocks on an unverified identity, and records the person's step", async () => {
  const { ctx: none } = context([]);
  (none.config.aws as Record<string, unknown>).aftLzaRemovalCard = undefined;
  assert.equal((await aftLzaRemovalStage(none, new Reader())).outcome, "SKIPPED");

  const { ctx: denied } = context([]);
  (denied as unknown as { preflight: unknown }).preflight = { identities: [{ provider: "aws", status: "BLOCKED", code: "AWS_IDENTITY_UNVERIFIED", detail: "no" }] };
  const blocked = await aftLzaRemovalStage(denied, new Reader());
  assert.equal(blocked.outcome, "BLOCKED");
  assert.equal(blocked.code, "AWS_IDENTITY_UNVERIFIED");

  const reader = new Reader();
  const { ctx, root, lines } = context([A]);
  const first = await aftLzaRemovalStage(ctx, reader);
  assert.equal(first.outcome, "BLOCKED");
  assert.equal(first.code, "AFT_REMOVAL_EXECUTION_NOT_FOUND");
  assert.ok(lines.some((l) => l.includes("acme/aft-account-request@main")));
  const document = JSON.parse(readFileSync(join(root, ".runs/evidence/run-1/aws-aft-lza-removal/decision.json"), "utf8"));
  assert.equal(document.accountClosedByRunner, false);
  assert.equal(document.actStartedByRunner, false);
  assert.equal(document.observations.aftRemovalCommit, A);
});

test("without a terminal the stage offers the step but records nothing", async () => {
  const { ctx, root } = context([A], false);
  const result = await aftLzaRemovalStage(ctx, new Reader());
  assert.equal(result.code, "AFT_REMOVAL_NOT_SUBMITTED");
  const document = JSON.parse(readFileSync(join(root, ".runs/evidence/run-1/aws-aft-lza-removal/decision.json"), "utf8"));
  assert.equal(document.observations.aftRemovalCommit, undefined);
});
