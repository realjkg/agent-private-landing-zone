import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { AftLzaReader } from "../src/aft-lza/run.js";
import type { AccountObservation, PipelineObservation } from "../src/aft-lza/workflow.js";
import { aftLzaStage } from "../src/evidence-runner/aft-lza.js";
import { loadConfig } from "../src/evidence-runner/config.js";
import { Journal } from "../src/evidence-runner/journal.js";
import type { StageContext } from "../src/evidence-runner/steps.js";
import { DEFAULT_STAGES, READONLY_STAGES, STAGES } from "../src/evidence-runner/types.js";
import { CANDIDATE } from "./helpers/evidence-fixtures.js";

// SYNTHETIC: the aws-aft-lza stage with an in-memory reader. Nothing reaches AWS or GitHub.

const L = "1".repeat(40), ID = "111122223333", OU = "ou-ab12-cdef3456";
const CARD = {
  runId: "pilot-001", organizationId: "o-abcdefghij", homeRegion: "eu-west-1", regions: ["eu-west-1", "eu-central-1"],
  account: { name: "pilot-nonprod", email: "pilot+np@example.com", ouId: OU },
  lza: { repository: "acme/lza-config", baseBranch: "main", pipelineName: "AWSAccelerator-Pipeline", configurationDigest: "a".repeat(64), validatorEvidenceDigest: "b".repeat(64) },
  aft: { repository: "acme/aft-account-request", baseBranch: "main", requestPipelineName: "ct-aft-account-request", requestDigest: "c".repeat(64), requestedName: "pilot-nonprod", requestedEmail: "pilot+np@example.com" },
  disposition: "RETAIN",
};

class Reader implements AftLzaReader {
  runs: PipelineObservation[] = [];
  account?: AccountObservation;
  async pipelineExecutions(name: string) { return this.runs.filter((r) => r.pipelineName === name); }
  async findAccountByEmail() { return this.account ? { lookup: "FOUND" as const, account: this.account } : { lookup: "NOT_FOUND" as const }; }
  async controls() { return []; }
}

function context(answers: string[], tty = true): { ctx: StageContext; root: string; lines: string[] } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "alz-aftlza-stage-")));
  mkdirSync(join(root, "config"));
  writeFileSync(join(root, "config", "aft-lza-card.json"), JSON.stringify(CARD));
  const runDir = join(root, ".runs", "evidence", "run-1");
  mkdirSync(runDir, { recursive: true });
  const lines: string[] = [];
  const journal = new Journal(join(runDir, "journal.jsonl"), { sourceCommit: CANDIDATE, configSha256: "a".repeat(64), targetHardwareId: "owner-mac-01", label: "SYNTHETIC", host: "h", identityHash: "b".repeat(64) });
  const ctx = {
    root, label: "SYNTHETIC", runDir, runDirRel: ".runs/evidence/run-1", journal, env: {}, childHome: join(root, "home"),
    config: { schemaVersion: 1, candidateCommit: CANDIDATE, targetHardwareId: "owner-mac-01", evidenceDir: ".runs/evidence",
      aws: { expectedAccountId: ID, region: "eu-west-1", qualificationStack: "alz-qualification-noop", aftLzaCard: "config/aft-lza-card.json" } },
    preflight: { identities: [{ provider: "aws", status: "PASS", code: "VERIFIED", detail: "ok" }] },
    spawn: async () => { throw new Error("the aws-aft-lza stage must not start a child in this test"); },
    terminal: { stdinIsTTY: tty, stdoutIsTTY: tty, ask: async () => answers.shift() ?? "" },
    at: () => "2026-11-12T00:00:00.000Z", out: (line: string) => lines.push(line),
  } as unknown as StageContext;
  return { ctx, root, lines };
}

test("the stage is named-only, read-only and configured through config.aws.aftLzaCard", () => {
  assert.ok(STAGES.includes("aws-aft-lza"));
  assert.ok(!DEFAULT_STAGES.includes("aws-aft-lza"), "never selected without --stage");
  assert.ok(READONLY_STAGES.includes("aws-aft-lza"), "refuses to run beside a mutation identity");
  const root = realpathSync(mkdtempSync(join(tmpdir(), "alz-aftlza-cfg-")));
  mkdirSync(join(root, "config"));
  const base = { schemaVersion: 1, candidateCommit: CANDIDATE, targetHardwareId: "owner-mac-01", evidenceDir: ".runs/evidence" };
  writeFileSync(join(root, "config", "evidence-runner.json"), JSON.stringify({ ...base, aws: { expectedAccountId: ID, region: "eu-west-1", qualificationStack: "s", aftLzaCard: "../card.json" } }));
  assert.equal(loadConfig(root, "config/evidence-runner.json").ok, false);
});

test("the stage offers the LZA write, records the person's merge, then blocks on the bound pipeline — never repeating the offer", async () => {
  const reader = new Reader();
  const { ctx, root, lines } = context([L]);
  const first = await aftLzaStage(ctx, reader);
  assert.equal(first.outcome, "BLOCKED");
  assert.equal(first.code, "LZA_EXECUTION_NOT_FOUND");
  assert.ok(lines.some((l) => l.includes("acme/lza-config@main")));
  const document = JSON.parse(readFileSync(join(root, ".runs/evidence/run-1/aws-aft-lza/decision.json"), "utf8"));
  assert.equal(document.deploymentAuthorized, false);
  assert.equal(document.actStartedByRunner, false);
  assert.equal(document.observations.lzaMergedCommit, L);

  // A later run, after the pipeline and the account exist, moves to the AFT write without offering LZA again.
  reader.runs.push({ pipelineName: "AWSAccelerator-Pipeline", executionId: "e1", sourceRevision: L, status: "Succeeded", evidence: "OBSERVED" });
  reader.account = { accountId: ID, name: "pilot-nonprod", email: "pilot+np@example.com", parentOuId: OU, status: "ACTIVE", evidence: "OBSERVED" };
  const second = await aftLzaStage({ ...ctx, terminal: { stdinIsTTY: false, stdoutIsTTY: false, ask: async () => "" } }, reader);
  assert.equal(second.code, "AFT_NOT_SUBMITTED");
});

test("an incomplete card blocks before anything is read", async () => {
  const { ctx, root } = context([]);
  writeFileSync(join(root, "config", "aft-lza-card.json"), JSON.stringify({ ...CARD, organizationId: "UNRESOLVED" }));
  const reader = new Reader();
  reader.pipelineExecutions = async () => { throw new Error("must not read"); };
  const result = await aftLzaStage(ctx, reader);
  assert.equal(result.code, "OWNER_INPUT_AFT_LZA_CARD");
});
