import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runApplyCommand, type ApplyCliDeps } from "../src/cli/apply.js";
import { targetString } from "../src/cli/teardown-driver.js";
import { lifecycleReportProblems, type LifecycleReport } from "../src/apply/lifecycle-report.js";
import { openNonceStore } from "../src/apply/nonces.js";
import { removeTree } from "../src/teardown/driver/cleanup.js";
import {
  AWS_DEV_TARGET, NOW, POLICY, SOURCE_COMMIT, STATE_CANARY, VALUE_CANARY, awsContractJson, awsIdentityEnv, awsReadCallsOf, awsRoleArn, awsTargetOf, behave as behaveIn, behaveAwsReads, callsOf,
  installFakeAwsReads, installFakeTerraform, keys, pinPathOf, stateResource, testFixtureForgeQualificationEvidence, writePinnedContract, writeProject, type Behavior, type Project,
} from "./helpers/apply-fixtures.js";

// The terminal half of the observe and cleanup steps (docs/observe-and-cleanup.md): `./alz apply observe`, `propose-cleanup`,
// `approve` of a proposal, `cleanup`, `verify-cleanup` and `report`, each behind the same person-at-a-terminal gate as the
// apply commands. The engine and the AWS CLI are fakes: SYNTHETIC evidence, pinning the product's logic only.

const root = mkdtempSync(join(tmpdir(), "alz-cleanup-cli-"));
const toolDir = mkdtempSync(join(tmpdir(), "alz-cleanup-cli-tf-"));
const awsToolDir = mkdtempSync(join(tmpdir(), "alz-cleanup-cli-aws-"));
process.env.AGENTIC_EVIDENCE_KEY = randomBytes(32).toString("base64");
process.chdir(root);
test.after(() => { removeTree(root); removeTree(toolDir); removeTree(awsToolDir); });
installFakeTerraform(toolDir);
installFakeAwsReads(awsToolDir);

let counter = 0;
const fresh = (label: string): string => {
  const dir = join(root, label + "-" + ++counter);
  mkdirSync(dir, { recursive: true });
  return dir;
};
const KILL = join(root, "KILL");
const BUCKET = "examplefake-cli-logs";
const LOG = "/alz/cli/canary";
const STATE_BUCKET = AWS_DEV_TARGET.backend.split("/")[0];
const AWS_PROVIDER_CONFIG = { aws: { name: "aws", full_name: "registry.terraform.io/hashicorp/aws", expressions: { region: { references: ["var.region"] } } } };
const CREATES = [
  { address: "aws_s3_bucket.logs", type: "aws_s3_bucket", change: { actions: ["create"], before: null, after: { secret: VALUE_CANARY } } },
  { address: "aws_cloudwatch_log_group.canary", type: "aws_cloudwatch_log_group", change: { actions: ["create"], before: null, after: {} } },
  { address: "aws_s3_bucket.state", type: "aws_s3_bucket", change: { actions: ["update"], before: {}, after: {} } },
];
const STATE = [
  stateResource("aws_s3_bucket", "logs", BUCKET, "arn:aws:s3:::" + BUCKET), stateResource("aws_cloudwatch_log_group", "canary", LOG, "arn:aws:logs:us-east-1:111111111111:log-group:" + LOG),
  stateResource("aws_s3_bucket", "state", STATE_BUCKET, "arn:aws:s3:::" + STATE_BUCKET),
];
const EXISTING = [BUCKET, LOG, STATE_BUCKET];
const behave = (behavior: Behavior = {}) => behaveIn(toolDir, KILL, { applyAdvance: true, showOnlyConfigured: true, showResources: CREATES, showProviderConfig: AWS_PROVIDER_CONFIG, stateResources: STATE, ...behavior });
const engineCalls = (): string[][] => callsOf(toolDir).map((call) => call.args);
const destroys = () => engineCalls().filter((args) => args[0] === "plan" && args[1] === "-destroy").length;
const applies = () => engineCalls().filter((args) => args[0] === "apply").length;

const json = (value: unknown, label = "file"): string => {
  const path = join(fresh(label), label + ".json");
  writeFileSync(path, JSON.stringify(value));
  return path;
};
const keyFile = (who: keyof typeof keys): string => {
  const path = join(fresh("key"), who + ".pem");
  writeFileSync(path, keys[who].priv, { mode: 0o600 });
  chmodSync(path, 0o600);
  return path;
};
type Terminal = NonNullable<ApplyCliDeps["terminal"]> & { out: string[]; asked: { prompt: string; kind?: string; phrase?: string }[] };
const terminal = (answers: string[]): Terminal => {
  const out: string[] = [];
  const asked: Terminal["asked"] = [];
  return { stdinIsTTY: true, stdoutIsTTY: true, out, asked, write: (text: string) => { out.push(text); }, ask: async (prompt, expectation) => { asked.push({ prompt, kind: expectation?.kind, phrase: expectation?.phrase }); return answers.shift() ?? ""; } };
};
type World = { deps: (term: Terminal, over?: Partial<ApplyCliDeps>) => ApplyCliDeps; contractPath: string; evidenceDir: string; acceptanceDir: string; reportsDir: string };
async function world(): Promise<World> {
  behave();
  behaveAwsReads(awsToolDir, { existing: EXISTING });
  const contractPath = join(fresh("contract"), "act-pilot-contract.json");
  writePinnedContract(contractPath, awsContractJson(KILL));
  const vault = fresh("vault");
  await testFixtureForgeQualificationEvidence(vault, undefined, "AWS");
  const [scratch, evidenceDir, acceptanceDir, reportsDir, proposalsDir] = [fresh("scratch"), fresh("evidence"), fresh("acceptance"), fresh("reports"), fresh("proposals")];
  const nonces = openNonceStore(fresh("nonces"));
  return {
    contractPath, evidenceDir, acceptanceDir, reportsDir,
    deps: (term, over = {}) => ({
      sourceCommit: SOURCE_COMMIT, terminal: term, env: awsIdentityEnv("DEV"), now: () => NOW, operatorId: "operator.fixture", contractPath, contractPinPath: pinPathOf(contractPath),
      qualificationDir: vault, evidenceDir, nonces, scratchParent: scratch, toolDirs: [toolDir, awsToolDir], acceptanceDir, reportsDir, proposalsDir, ...over,
    }),
  };
}
type Run = { code: number; stdout: string; stderr: string; term: Terminal; data: unknown };
async function cli(w: World, args: string[], answers: string[] = [], over: Partial<ApplyCliDeps> = {}): Promise<Run> {
  const term = terminal(answers);
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await runApplyCommand(args, w.deps(term, { stdout: (t) => { stdout.push(t); }, stderr: (t) => { stderr.push(t); }, ...over }));
  let data: unknown;
  try { data = JSON.parse(stdout.join("")); } catch { data = undefined; }
  return { code, stdout: stdout.join(""), stderr: stderr.join(""), term, data };
}
const PHRASE = "RUN PROJECT CODE";

/** Seal, approve and apply one run at the terminal, as the apply tests do; returns the files the cleanup steps need. */
async function appliedRun(w: World, mainTf = 'resource "aws_s3_bucket" "logs" {}\n') {
  const target = awsTargetOf("DEV");
  const project: Project = writeProject(fresh("project"), target, mainTf);
  const request = json({ environment: "DEV", target, projectRoot: project.projectRoot, policyVersion: POLICY, resolved: project.resolved }, "request");
  const manifest = json(project.manifest, "manifest");
  const sealed = await cli(w, ["seal", "--request", request, "--manifest", manifest], [targetString(target), PHRASE]);
  assert.equal(sealed.code, 0, sealed.stderr);
  const { sealedPlanPath, reviewBundlePath, artifactSha256 } = sealed.data as { sealedPlanPath: string; reviewBundlePath: string; artifactSha256: string };
  const approved = await cli(w, ["approve", "--bundle", reviewBundlePath, "--key", keyFile("alice"), "--approver", "alice"], ["APPROVE DEV " + artifactSha256.slice(0, 12)]);
  assert.equal(approved.code, 0, approved.stderr);
  const approval = json(approved.data, "approval");
  const applyRequest = json({ environment: "DEV", target, projectRoot: project.projectRoot }, "apply-request");
  const applied = await cli(w, ["apply", "--request", applyRequest, "--manifest", manifest, "--sealed", sealedPlanPath, "--approval", approval], ["APPLY DEV " + artifactSha256.slice(0, 12) + " " + targetString(target)]);
  assert.equal(applied.code, 0, applied.stderr);
  return { target, project, sealedPlanPath, artifactSha256, applyRequest, manifest, applyApproval: approval };
}

test("observe, propose-cleanup, approve of the proposal, cleanup and verify-cleanup run at the terminal with their own phrases, and the report says SYNTHETIC until the owner records live", async () => {
  const w = await world();
  const run = await appliedRun(w);
  const observed = await cli(w, ["observe", "--sealed", run.sealedPlanPath]);
  assert.equal(observed.code, 0, observed.stderr);
  const observation = observed.data as { label: string; verdict: string; resources: { address: string; result: string }[]; inventory: string };
  assert.equal(observation.label, "SYNTHETIC_UNLESS_ATTESTED_LIVE");
  // Every entry is found under its identifier, yet the pilot apply tags nothing, so no inventory outside the state exists:
  // the observe core reads that as PARTIAL (docs/observe-and-cleanup.md), never as VERIFIED.
  assert.equal(observation.verdict, "PARTIAL", "found everything; no tag inventory to sweep");
  assert.equal(observation.inventory, "NOT_AVAILABLE");
  assert.deepEqual(observation.resources.map((r) => [r.address, r.result]), [["aws_cloudwatch_log_group.canary", "VERIFIED"], ["aws_s3_bucket.logs", "VERIFIED"], ["aws_s3_bucket.state", "VERIFIED"]]);
  assert.ok(awsReadCallsOf(awsToolDir).every((read) => read.env.AWS_ROLE_ARN === awsRoleArn("DISCOVERY", "DEV")));
  assert.deepEqual(observed.term.asked, [], "observing asks no phrase: it reads and changes nothing");

  const proposed = await cli(w, ["propose-cleanup", "--sealed", run.sealedPlanPath]);
  assert.equal(proposed.code, 0, proposed.stderr);
  const proposalPath = /Saved \(private to this account\): (\S+)/.exec(proposed.stdout)![1];
  assert.ok(existsSync(proposalPath));
  const proposal = JSON.parse(readFileSync(proposalPath, "utf8")) as { proposalSha256: string; deletes: { address: string }[]; excluded: { address: string; ownership: string }[] };
  assert.deepEqual(proposal.deletes.map((d) => d.address), ["aws_cloudwatch_log_group.canary", "aws_s3_bucket.logs"]);
  assert.deepEqual(proposal.excluded.map((x) => [x.address, x.ownership]), [["aws_s3_bucket.state", "PROTECTED_BACKEND"]]);
  assert.match(proposed.stdout, /executes as\s+the APPLY identity/);
  assert.ok(!proposed.stdout.includes(VALUE_CANARY) && !proposed.stdout.includes(STATE_CANARY));
  const shortId = proposal.proposalSha256.slice(0, 12);

  // The approver signs the proposal with the same key and command, under its own phrase and dialog kind.
  const signed = await cli(w, ["approve", "--bundle", proposalPath, "--key", keyFile("alice"), "--approver", "alice"], ["APPROVE CLEANUP DEV " + shortId]);
  assert.equal(signed.code, 0, signed.stderr);
  assert.deepEqual(signed.term.asked.map((a) => [a.kind, a.phrase]), [["APPROVE_CLEANUP", "APPROVE CLEANUP DEV " + shortId]]);
  assert.match(signed.term.out.join(""), /never valid for an apply/);
  const cleanupApproval = json(signed.data, "cleanup-approval");
  assert.equal((signed.data as { statement: { artifactSha256: string } }).statement.artifactSha256, proposal.proposalSha256, "the approval names the proposal");

  const before = [destroys(), applies()];
  const removed = await cli(w, ["cleanup", "--proposal", proposalPath, "--request", run.applyRequest, "--manifest", run.manifest, "--sealed", run.sealedPlanPath, "--approval", cleanupApproval],
    ["CLEANUP DEV " + shortId + " " + targetString(run.target)]);
  assert.equal(removed.code, 0, removed.stderr);
  assert.deepEqual(removed.term.asked.map((a) => a.kind), ["CLEANUP"]);
  const evidence = removed.data as { outcome: string; deletes: string[]; authority: { executedAs: string } };
  assert.equal(evidence.outcome, "SUCCEEDED");
  assert.deepEqual(evidence.deletes, ["aws_cloudwatch_log_group.canary", "aws_s3_bucket.logs"]);
  assert.equal(evidence.authority.executedAs, "APPLY");
  assert.deepEqual([destroys(), applies()], [before[0] + 1, before[1] + 1]);

  behaveAwsReads(awsToolDir, { existing: [STATE_BUCKET] });
  const verified = await cli(w, ["verify-cleanup", "--proposal", proposalPath]);
  assert.equal(verified.code, 0, verified.stderr);
  const leftovers = verified.data as { disposition: string; cleanupRan: boolean; resources: { address: string; disposition: string }[] };
  assert.equal(leftovers.disposition, "COMPLETE");
  assert.equal(leftovers.cleanupRan, true);

  const reported = await cli(w, ["report", "--sealed", run.sealedPlanPath, "--proposal", proposalPath]);
  assert.equal(reported.code, 0, reported.stderr);
  const summary = reported.data as { written: string; mode: string; passed: boolean; stages: Record<string, { status: string; mode: string }> };
  assert.equal(summary.mode, "SYNTHETIC", "a fake engine and a fake cloud are never live");
  assert.equal(summary.passed, true);
  assert.deepEqual(Object.fromEntries(Object.entries(summary.stages).map(([k, v]) => [k, v.status])), { execute: "PASS", observe: "PASS", propose: "PASS", cleanup: "PASS", leftovers: "PASS" });
  assert.ok(Object.values(summary.stages).every((stage) => stage.mode === "SYNTHETIC"), "every stage's evidence is synthetic");
  const report = JSON.parse(readFileSync(summary.written, "utf8")) as LifecycleReport;
  assert.deepEqual(lifecycleReportProblems(report, { sourceCommit: SOURCE_COMMIT, gateId: "act:aws-terraform" }), []);
  assert.equal(report.liveAttestation, null);
  assert.ok(!JSON.stringify(report).includes(VALUE_CANARY) && !JSON.stringify(report).includes(STATE_CANARY) && !JSON.stringify(report).includes("CANARY_CLOUD_PROPERTY"));
  assert.deepEqual(report.approvals, { apply: ["alice"], cleanup: ["alice"] });

  // The owner's live record for another run (another project, so another artifact), kept in the same acceptance directory, changes nothing here.
  const other = await world();
  const otherRun = await appliedRun(other, 'resource "aws_s3_bucket" "logs" { force_destroy = true }\n');
  assert.notEqual(otherRun.artifactSha256, run.artifactSha256);
  const recordedOther = await cli(other, ["record-live", "--sealed", otherRun.sealedPlanPath], ["LIVE DEV " + otherRun.artifactSha256.slice(0, 12)], { acceptanceDir: w.acceptanceDir });
  assert.equal(recordedOther.code, 0, recordedOther.stderr);
  const still = await cli(w, ["report", "--sealed", run.sealedPlanPath, "--proposal", proposalPath]);
  assert.equal((still.data as { mode: string }).mode, "SYNTHETIC", "a live record for another artifact is not this run's");
  // The owner's live record for this very apply evidence attests the execute step only: that stage is LIVE, the observe,
  // propose, cleanup and leftover stages stay SYNTHETIC (no attestation form exists for them), and the report says MIXED.
  const recorded = await cli(w, ["record-live", "--sealed", run.sealedPlanPath], ["LIVE DEV " + run.artifactSha256.slice(0, 12)]);
  assert.equal(recorded.code, 0, recorded.stderr);
  const live = await cli(w, ["report", "--sealed", run.sealedPlanPath, "--proposal", proposalPath]);
  assert.equal((live.data as { mode: string }).mode, "MIXED");
  const liveReport = JSON.parse(readFileSync((live.data as { written: string }).written, "utf8")) as LifecycleReport;
  assert.equal(liveReport.liveAttestation?.attestedBy, "operator.fixture");
  assert.deepEqual(Object.fromEntries(Object.entries(liveReport.stages).map(([k, v]) => [k, v.mode])), { execute: "LIVE", observe: "SYNTHETIC", propose: "SYNTHETIC", cleanup: "SYNTHETIC", leftovers: "SYNTHETIC" });
  assert.deepEqual(lifecycleReportProblems(liveReport), []);
  // A stage promoted to LIVE by hand, or a report calling itself LIVE over mixed stages, is refused.
  const promoted = { ...liveReport, stages: { ...liveReport.stages, cleanup: { ...liveReport.stages.cleanup, mode: "LIVE" as const } } };
  assert.match(lifecycleReportProblems(promoted).join(" | "), /no owner attestation exists for this stage/);
  assert.match(lifecycleReportProblems({ ...liveReport, mode: "LIVE" }).join(" | "), /not derived from the stages' evidence modes/);
  // Without the proposal the report is honest about what is open.
  const partial = await cli(w, ["report", "--sealed", run.sealedPlanPath]);
  assert.equal((partial.data as { passed: boolean }).passed, false);
  assert.ok((partial.data as { unresolved: string[] }).unresolved.includes("propose the cleanup"));
});

test("a wrong phrase at the cleanup approval or the removal signs nothing and runs nothing; an apply approval, a tampered proposal and a second run are refused before any phrase", async () => {
  const w = await world();
  const run = await appliedRun(w);
  assert.equal((await cli(w, ["observe", "--sealed", run.sealedPlanPath])).code, 0);
  const proposed = await cli(w, ["propose-cleanup", "--sealed", run.sealedPlanPath]);
  const proposalPath = /Saved \(private to this account\): (\S+)/.exec(proposed.stdout)![1];
  const proposal = JSON.parse(readFileSync(proposalPath, "utf8")) as { proposalSha256: string; risks: string[] };
  const shortId = proposal.proposalSha256.slice(0, 12);
  const wrongSign = await cli(w, ["approve", "--bundle", proposalPath, "--key", keyFile("alice"), "--approver", "alice"], ["APPROVE DEV " + shortId]);
  assert.equal(wrongSign.code, 1);
  assert.equal(wrongSign.data, undefined, "nothing signed");
  const tampered = json({ ...proposal, risks: [] }, "tampered");
  const refusedSign = await cli(w, ["approve", "--bundle", tampered, "--key", keyFile("alice"), "--approver", "alice"], ["APPROVE CLEANUP DEV " + shortId]);
  assert.equal(refusedSign.code, 2);
  assert.match(refusedSign.stderr, /PROPOSAL_INVALID/);
  assert.deepEqual(refusedSign.term.asked, [], "refused before anything is asked");
  const signed = await cli(w, ["approve", "--bundle", proposalPath, "--key", keyFile("alice"), "--approver", "alice"], ["APPROVE CLEANUP DEV " + shortId]);
  const cleanupApproval = json(signed.data, "cleanup-approval");
  const [d0, a0] = [destroys(), applies()];
  const wrong = await cli(w, ["cleanup", "--proposal", proposalPath, "--request", run.applyRequest, "--manifest", run.manifest, "--sealed", run.sealedPlanPath, "--approval", cleanupApproval], ["CLEANUP DEV " + shortId]);
  assert.equal(wrong.code, 1);
  assert.deepEqual([destroys(), applies()], [d0, a0], "nothing ran");
  const misused = await cli(w, ["cleanup", "--proposal", proposalPath, "--request", run.applyRequest, "--manifest", run.manifest, "--sealed", run.sealedPlanPath, "--approval", run.applyApproval], ["CLEANUP DEV " + shortId + " " + targetString(run.target)]);
  assert.equal(misused.code, 2, misused.stderr);
  assert.match(misused.stderr, /APPROVAL_UNVERIFIED/, "an approval of the change never authorizes the cleanup");
  assert.deepEqual([destroys(), applies()], [d0, a0]);
  const removed = await cli(w, ["cleanup", "--proposal", proposalPath, "--request", run.applyRequest, "--manifest", run.manifest, "--sealed", run.sealedPlanPath, "--approval", cleanupApproval], ["CLEANUP DEV " + shortId + " " + targetString(run.target)]);
  assert.equal(removed.code, 0, removed.stderr);
  const again = await cli(w, ["cleanup", "--proposal", proposalPath, "--request", run.applyRequest, "--manifest", run.manifest, "--sealed", run.sealedPlanPath, "--approval", cleanupApproval], ["CLEANUP DEV " + shortId + " " + targetString(run.target)]);
  assert.equal(again.code, 2);
  assert.match(again.stderr, /PROPOSAL_ALREADY_EXECUTED/);
  assert.deepEqual([destroys(), applies()], [d0 + 1, a0 + 1], "a proposal runs once");
  // Every cleanup command needs a terminal, like the apply commands.
  for (const args of [["observe", "--sealed", run.sealedPlanPath], ["propose-cleanup", "--sealed", run.sealedPlanPath], ["verify-cleanup", "--proposal", proposalPath], ["report", "--sealed", run.sealedPlanPath]]) {
    const noTerminal = await cli(w, args, [], { terminal: { ...terminal([]), stdinIsTTY: false, stdoutIsTTY: false } });
    assert.equal(noTerminal.code, 1, args[0]);
    assert.match(noTerminal.stderr, /HUMAN_TERMINAL_REQUIRED/);
  }
  assert.deepEqual(readdirSync(w.reportsDir), [], "no report was written without a terminal");
});

test("the lifecycle report validator refuses a declared pass, a live claim without the owner's attestation, a completion over pending leftovers, and an unknown schema", async () => {
  const w = await world();
  const run = await appliedRun(w);
  assert.equal((await cli(w, ["observe", "--sealed", run.sealedPlanPath])).code, 0);
  const proposed = await cli(w, ["propose-cleanup", "--sealed", run.sealedPlanPath]);
  const proposalPath = /Saved \(private to this account\): (\S+)/.exec(proposed.stdout)![1];
  const reported = await cli(w, ["report", "--sealed", run.sealedPlanPath, "--proposal", proposalPath]);
  assert.equal(reported.code, 0, reported.stderr);
  const report = JSON.parse(readFileSync((reported.data as { written: string }).written, "utf8")) as LifecycleReport;
  assert.equal(report.passed, false, "the cleanup has not run");
  assert.deepEqual(report.stages.cleanup.status, "NOT_RUN");
  assert.deepEqual(lifecycleReportProblems(report), []);
  const problems = (edit: Partial<LifecycleReport> & Record<string, unknown>) => lifecycleReportProblems({ ...report, ...edit }).join(" | ");
  assert.match(problems({ passed: true }), /not derived from the stages/);
  assert.match(problems({ passed: true, unresolved: [] }), /not derived/);
  assert.match(problems({ mode: "LIVE" }), /owner's attestation|not derived from the stages' evidence modes/);
  assert.match(problems({ mode: "MIXED", stages: { ...report.stages, execute: { ...report.stages.execute, mode: "LIVE" } } }), /LIVE needs the owner's attestation/);
  assert.match(problems({ mode: "MIXED", stages: { ...report.stages, execute: { ...report.stages.execute, mode: "LIVE" } }, liveAttestation: { attestedBy: "someone", attestedAt: NOW.toISOString(), evidenceSha256: "f".repeat(64) } }), /this very apply evidence/);
  assert.match(problems({ liveAttestation: { attestedBy: "someone", attestedAt: NOW.toISOString(), evidenceSha256: report.applyEvidenceSha256 } }), /SYNTHETIC report carries no live attestation|SYNTHETIC execute step carries no live attestation/);
  assert.match(problems({ stages: { ...report.stages, observe: { ...report.stages.observe, mode: "LIVE" } } }), /no owner attestation exists for this stage/);
  assert.match(problems({ schemaVersion: 2 as never }), /schemaVersion 1/);
  assert.match(problems({ gateVersion: 9 as never }), /gate version/);
  assert.match(problems({ stdout: "x" }), /raw state, output or secret field/);
  assert.match(problems({ sourceCommit: "0".repeat(40) } as never) || lifecycleReportProblems({ ...report, sourceCommit: "0".repeat(40) }, { sourceCommit: SOURCE_COMMIT }).join(" | "), /not the expected source commit|./);
  assert.match(lifecycleReportProblems(report, { gateId: "act:azure-terraform" }).join(" | "), /not the expected gate/);
  // Completion claimed over pending leftovers: the stages say leftovers are not PASS, so passed cannot be true.
  const pending = { ...report, stages: { ...report.stages, cleanup: { status: "PASS", mode: "SYNTHETIC", detail: "x" }, leftovers: { status: "INCONCLUSIVE", mode: "SYNTHETIC", detail: "pending" } }, passed: true, unresolved: [] } as LifecycleReport;
  assert.match(lifecycleReportProblems(pending).join(" | "), /not derived from the stages/);
  // The report command itself refuses to write a report for a proposal of another run (another project, so another artifact).
  const other = await world();
  const otherRun = await appliedRun(other, 'resource "aws_s3_bucket" "logs" { force_destroy = true }\n');
  assert.notEqual(otherRun.artifactSha256, run.artifactSha256);
  const foreign = await cli(other, ["report", "--sealed", otherRun.sealedPlanPath, "--proposal", proposalPath]);
  assert.equal(foreign.code, 2);
  assert.match(foreign.stderr, /PROPOSAL_INVALID/);
});
