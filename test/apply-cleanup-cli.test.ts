import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runApplyCommand, type ApplyCliDeps } from "../src/cli/apply.js";
import { targetString } from "../src/cli/teardown-driver.js";
import { loadPilotContract, pilotContractSha256 } from "../src/apply/contract.js";
import { acceptanceStatement, lifecycleReportProblems, type LifecycleReport } from "../src/apply/lifecycle-report.js";
import type { PilotContract } from "../src/apply/types.js";
import { pilotUnitOf } from "../src/apply/unit.js";
import { openNonceStore } from "../src/apply/nonces.js";
import { removeTree } from "../src/teardown/driver/cleanup.js";
import { deliverSession } from "./helpers/token-delivery-fixtures.js";
import {
  AWS_DEV_TARGET, NOW, POLICY, SOURCE_COMMIT, STATE_CANARY, VALUE_CANARY, awsContractJson, awsIdentityEnv, awsReadCallsOf, awsRoleArn, awsTargetOf, behave as behaveIn, behaveAwsReads, callsOf,
  installFakeAwsReads, installFakeTerraform, keys, stateResource, testFixtureForgeQualificationEvidence, writeReviewedContract, writeProject, type Behavior, type Project,
  requesterArgs, canaryFor, withCanary } from "./helpers/apply-fixtures.js";

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
];
/** Owner decision E1: the run's contract names exactly the two creates. The plan cannot also update the state bucket (RESOURCE_NOT_IN_CANARY): that bucket is in the state only. */
const runContract = (over: Record<string, unknown> = {}) => withCanary(awsContractJson(KILL, over), canaryFor(CREATES));
const STATE = [
  stateResource("aws_s3_bucket", "logs", BUCKET, "arn:aws:s3:::" + BUCKET), stateResource("aws_cloudwatch_log_group", "canary", LOG, "arn:aws:logs:us-east-1:111111111111:log-group:" + LOG),
  stateResource("aws_s3_bucket", "state", STATE_BUCKET, "arn:aws:s3:::" + STATE_BUCKET),
];
const EXISTING = [BUCKET, LOG, STATE_BUCKET];
const BUCKET_ARN = "arn:aws:s3:::" + BUCKET;
const LOG_ARN = "arn:aws:logs:us-east-1:111111111111:log-group:" + LOG;
/** The deletion unit of the DEV state container under the fixture contract: what every created resource is stamped with, and what the fake tagging API lists by. */
const UNIT = (() => { const path = join(fresh("unit-contract"), "act-pilot-contract.json"); writeReviewedContract(path, runContract()); return pilotUnitOf({ provider: "AWS", contractSha256: pilotContractSha256(loadPilotContract(path) as PilotContract), environment: "DEV", target: awsTargetOf("DEV") }); })();
/** The run's own resources, as the tagging API lists them: the listing is not empty, and it matches the records. */
const TAGGED = [BUCKET_ARN, LOG_ARN];
const behave = (behavior: Behavior = {}) => behaveIn(toolDir, KILL, { applyAdvance: true, showOnlyConfigured: true, showResources: CREATES, showProviderConfig: AWS_PROVIDER_CONFIG, stateResources: STATE, unitTags: { ...UNIT.tags }, ...behavior });
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
  behaveAwsReads(awsToolDir, { existing: EXISTING, tagged: TAGGED });
  const contractPath = join(fresh("contract"), "act-pilot-contract.json");
  writeReviewedContract(contractPath, runContract());
  const vault = fresh("vault");
  await testFixtureForgeQualificationEvidence(vault, undefined, "AWS");
  const [scratch, evidenceDir, acceptanceDir, reportsDir, proposalsDir] = [fresh("scratch"), fresh("evidence"), fresh("acceptance"), fresh("reports"), fresh("proposals")];
  const nonces = openNonceStore(fresh("nonces"));
  return {
    contractPath, evidenceDir, acceptanceDir, reportsDir,
    deps: (term, over = {}) => ({
      sourceCommit: SOURCE_COMMIT, terminal: term, env: awsIdentityEnv("DEV"), now: () => NOW, operatorId: "operator.fixture", contractPath,
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
/** Every Terraform contract binds STATE_WRITE (owner decision 6486426552), so seal and qualify ask for this phrase after the project-code one. */
const EMBED = (environment: string): string => "EMBED STATE_WRITE " + environment;

/** Seal, approve and apply one run at the terminal, as the apply tests do; returns the files the cleanup steps need. */
async function appliedRun(w: World, mainTf = 'resource "aws_s3_bucket" "logs" {}\n') {
  const target = awsTargetOf("DEV");
  const project: Project = writeProject(fresh("project"), target, mainTf);
  const request = json({ environment: "DEV", target, projectRoot: project.projectRoot, policyVersion: POLICY, resolved: project.resolved }, "request");
  const manifest = json(project.manifest, "manifest");
  const sealed = await cli(w, ["seal", "--request", request, "--manifest", manifest, ...requesterArgs()], [targetString(target), PHRASE, EMBED("DEV")]);
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

test("observe, propose-cleanup, approve of the proposal, cleanup and verify-cleanup run at the terminal with their own phrases, and the report is SYNTHETIC, MIXED only after the owner's live record", async () => {
  const w = await world();
  const run = await appliedRun(w);
  const observed = await cli(w, ["observe", "--sealed", run.sealedPlanPath]);
  assert.equal(observed.code, 0, observed.stderr);
  const observation = observed.data as { label: string; verdict: string; resources: { address: string; result: string }[]; inventory: string };
  assert.equal(observation.label, "SYNTHETIC_UNLESS_ATTESTED_LIVE");
  // Every entry is found under its identifier, and the sweep by the run's deletion-unit tag (the fixture stamps the unit tags on
  // what it creates, and its fake tagging API lists exactly those ARNs) covered every page: VERIFIED.
  assert.equal(observation.verdict, "VERIFIED", "found everything, and the unit sweep found nothing else");
  assert.equal(observation.inventory, "COMPLETE");
  assert.deepEqual(observation.resources.map((r) => [r.address, r.result]), [["aws_cloudwatch_log_group.canary", "VERIFIED"], ["aws_s3_bucket.logs", "VERIFIED"], ["aws_s3_bucket.state", "VERIFIED"]]);
  assert.ok(awsReadCallsOf(awsToolDir).every((read) => read.env.AWS_ROLE_ARN === awsRoleArn("DISCOVERY", "DEV")));
  assert.ok(awsReadCallsOf(awsToolDir).some((read) => read.args[0] === "resourcegroupstaggingapi" && read.args.includes("Key=alz-unit,Values=" + UNIT.unitId)), "the sweep asked for this run's own unit tag");
  assert.deepEqual(observed.term.asked, [], "observing asks no phrase: it reads and changes nothing");
  // #360 review N1: the plain summary the evidence runner reads, beside the reports: the verdict and why, never a resource's contents.
  const summaryName = run.artifactSha256.slice(0, 12) + "-observation.json";
  assert.deepEqual(readdirSync(w.reportsDir).filter((n) => n.endsWith("-observation.json")), [summaryName]);
  const observationSummary = JSON.parse(readFileSync(join(w.reportsDir, summaryName), "utf8")) as Record<string, unknown>;
  assert.deepEqual(Object.keys(observationSummary).sort(), ["artifactSha256", "inventory", "kind", "label", "observedAt", "schemaVersion", "sweepNotListing", "verdict", "verifier"]);
  assert.deepEqual([observationSummary.kind, observationSummary.label, observationSummary.verdict, observationSummary.inventory, observationSummary.verifier, observationSummary.sweepNotListing], ["OBSERVATION_SUMMARY", "SYNTHETIC_UNLESS_ATTESTED_LIVE", "VERIFIED", "COMPLETE", "AWS_CLOUD_CONTROL", []]);

  const proposed = await cli(w, ["propose-cleanup", "--sealed", run.sealedPlanPath, ...requesterArgs()]);
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

  behaveAwsReads(awsToolDir, { existing: [STATE_BUCKET], tagged: [] });
  const verified = await cli(w, ["verify-cleanup", "--proposal", proposalPath]);
  assert.equal(verified.code, 0, verified.stderr);
  const leftovers = verified.data as { disposition: string; cleanupRan: boolean; resources: { address: string; disposition: string }[] };
  assert.equal(leftovers.disposition, "COMPLETE");
  assert.equal(leftovers.cleanupRan, true);
  // Delivered identity tokens (docs/act-pilot-identity-delivery.md) are judged before verify-cleanup reads as DISCOVERY (review N4). SYNTHETIC.
  const delivered = deliverSession("aws-terraform", NOW, { meta: { DISCOVERY: { refreshedAt: new Date(NOW.getTime() - 10 * 60 * 1000).toISOString() } } });
  try {
    const stale = await cli(w, ["verify-cleanup", "--proposal", proposalPath], [], { env: { ...awsIdentityEnv("DEV"), ...delivered.env } });
    assert.equal(stale.code, 2, stale.stderr);
    assert.match(stale.stderr, /IDENTITY_NOT_CONFIGURED: .*DISCOVERY token is stale/);
  } finally { rmSync(delivered.root, { recursive: true, force: true }); }

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
  // Three states, kept apart: the approved resources are cleaned up, the protected object is retained by its owner, and the environment is not retired.
  assert.deepEqual(report.acceptance, {
    resourceCleanup: "COMPLETED", retained: { total: 1, byOwnership: { PROTECTED_BACKEND: 1 }, byOwner: { PILOT_OWNER: 1 } }, environmentRetirement: "OUTSTANDING",
    statement: "approved resources deleted; 1 protected or pre-existing object(s) intentionally retained (1 kept by PILOT_OWNER); environment retirement outstanding (a separate, reviewed action; this report does not claim the environment retired)",
  });
  assert.match(report.stages.leftovers.detail, /^approved resources deleted.*protected objects intentionally retained; environment retirement outstanding$/);
  assert.ok(!/entire environment|environment (is |was )?deleted/.test(JSON.stringify(report)), "a passing report never says the environment is deleted");
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
  // A stale record for this very artifact but other apply evidence (a re-applied plan, say), sorted ahead of the valid one, does not shadow it:
  // the report matches the record on step, artifact and evidence hash, not on the artifact alone.
  writeFileSync(join(w.acceptanceDir, "0-stale-" + run.artifactSha256.slice(0, 12) + ".json"), JSON.stringify({
    schemaVersion: 1, label: "LIVE", step: "execute", cloud: "AWS", engine: "TERRAFORM", environment: "DEV", target: run.target, sourceCommit: SOURCE_COMMIT, artifactSha256: run.artifactSha256,
    outcome: "SUCCEEDED", evidenceSha256: "1".repeat(64), contractSha256: report.contractSha256, attestedBy: "someone.else", attestedAt: NOW.toISOString(),
  }, null, 2) + "\n");
  const shadowed = await cli(w, ["report", "--sealed", run.sealedPlanPath, "--proposal", proposalPath]);
  assert.equal((shadowed.data as { mode: string }).mode, "SYNTHETIC", "a same-artifact record for other evidence is not this run's either");
  // The owner's live record for this very apply evidence attests the execute step only: that stage is LIVE, the observe,
  // propose, cleanup and leftover stages stay SYNTHETIC (no attestation form exists for them), and the report says MIXED.
  const recorded = await cli(w, ["record-live", "--sealed", run.sealedPlanPath], ["LIVE DEV " + run.artifactSha256.slice(0, 12)]);
  assert.equal(recorded.code, 0, recorded.stderr);
  const live = await cli(w, ["report", "--sealed", run.sealedPlanPath, "--proposal", proposalPath]);
  assert.equal((live.data as { mode: string }).mode, "MIXED");
  const liveReport = JSON.parse(readFileSync((live.data as { written: string }).written, "utf8")) as LifecycleReport;
  assert.equal(liveReport.liveAttestation?.attestedBy, "operator.fixture");
  assert.deepEqual([liveReport.liveAttestation?.artifactSha256, liveReport.liveAttestation?.step, liveReport.liveAttestation?.evidenceSha256], [run.artifactSha256, "execute", liveReport.applyEvidenceSha256]);
  assert.deepEqual(Object.fromEntries(Object.entries(liveReport.stages).map(([k, v]) => [k, v.mode])), { execute: "LIVE", observe: "SYNTHETIC", propose: "SYNTHETIC", cleanup: "SYNTHETIC", leftovers: "SYNTHETIC" });
  assert.deepEqual(lifecycleReportProblems(liveReport), []);
  assert.equal(liveReport.liveAttestation?.attestedBy, "operator.fixture", "the valid record is found although a stale same-artifact record sorts ahead of it");
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
  const proposed = await cli(w, ["propose-cleanup", "--sealed", run.sealedPlanPath, ...requesterArgs()]);
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
  // Every cleanup command needs a terminal, like the apply commands. What the reports folder holds before (the observation summary an
  // earlier observe at the terminal wrote) is exactly what it holds after: nothing is written or rewritten without a terminal.
  // Names, bytes, inode and modification time (#362 review N3): a rewrite with identical bytes (the test clock is fixed) is caught too.
  const reportsNow = () => readdirSync(w.reportsDir).sort().map((name) => {
    const stat = lstatSync(join(w.reportsDir, name));
    return [name, readFileSync(join(w.reportsDir, name), "utf8"), stat.ino, stat.mtimeMs];
  });
  const reportsBefore = reportsNow();
  assert.ok(reportsBefore.length > 0, "the earlier observe at the terminal left its summary");
  for (const args of [["observe", "--sealed", run.sealedPlanPath], ["propose-cleanup", "--sealed", run.sealedPlanPath, ...requesterArgs()], ["verify-cleanup", "--proposal", proposalPath], ["report", "--sealed", run.sealedPlanPath]]) {
    const noTerminal = await cli(w, args, [], { terminal: { ...terminal([]), stdinIsTTY: false, stdoutIsTTY: false } });
    assert.equal(noTerminal.code, 1, args[0]);
    assert.match(noTerminal.stderr, /HUMAN_TERMINAL_REQUIRED/);
  }
  assert.deepEqual(reportsNow(), reportsBefore, "no report was written or rewritten without a terminal");
  assert.ok(!readdirSync(w.reportsDir).some((name) => name.includes("-lifecycle")), "no lifecycle report was written without a terminal");
  // #362 review N2: a symbolic link at the report's name is refused, and nothing is written through it.
  const outside = join(w.reportsDir, "..", "outside-" + run.artifactSha256.slice(0, 6) + ".json");
  writeFileSync(outside, "untouched\n");
  symlinkSync(outside, join(w.reportsDir, run.artifactSha256.slice(0, 12) + "-lifecycle.json"));
  const linked = await cli(w, ["report", "--sealed", run.sealedPlanPath]);
  assert.equal(linked.code, 1, linked.stderr);
  assert.match(linked.stderr, /^PRIVATE_FILE_REFUSED: [0-9a-f]{12}-lifecycle\.json is not a regular file/);
  assert.equal(readFileSync(outside, "utf8"), "untouched\n");
  assert.ok(!readdirSync(w.reportsDir).some((name) => name.includes(".tmp-")), "no temporary file is left");
});

test("the lifecycle report validator refuses a declared pass, a live claim without the owner's attestation, a completion over pending leftovers, and an unknown schema", async () => {
  const w = await world();
  const run = await appliedRun(w);
  assert.equal((await cli(w, ["observe", "--sealed", run.sealedPlanPath])).code, 0);
  const proposed = await cli(w, ["propose-cleanup", "--sealed", run.sealedPlanPath, ...requesterArgs()]);
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
  assert.match(problems({ mode: "MIXED", stages: { ...report.stages, execute: { ...report.stages.execute, mode: "LIVE" } }, liveAttestation: { attestedBy: "someone", attestedAt: NOW.toISOString(), evidenceSha256: "f".repeat(64), artifactSha256: report.artifactSha256, step: "execute" } }), /this very apply evidence/);
  assert.match(problems({ mode: "MIXED", stages: { ...report.stages, execute: { ...report.stages.execute, mode: "LIVE" } }, liveAttestation: { attestedBy: "someone", attestedAt: NOW.toISOString(), evidenceSha256: report.applyEvidenceSha256, artifactSha256: "e".repeat(64), step: "execute" } }), /must name this artifact and the execute step/);
  assert.match(problems({ mode: "MIXED", stages: { ...report.stages, execute: { ...report.stages.execute, mode: "LIVE" } }, liveAttestation: { attestedBy: "someone", attestedAt: NOW.toISOString(), evidenceSha256: report.applyEvidenceSha256, artifactSha256: report.artifactSha256, step: "cleanup" } as never }), /must name this artifact and the execute step/);
  assert.match(problems({ liveAttestation: { attestedBy: "someone", attestedAt: NOW.toISOString(), evidenceSha256: report.applyEvidenceSha256, artifactSha256: report.artifactSha256, step: "execute" } }), /SYNTHETIC report carries no live attestation|SYNTHETIC execute step carries no live attestation/);
  assert.match(problems({ stages: { ...report.stages, observe: { ...report.stages.observe, mode: "LIVE" } } }), /no owner attestation exists for this stage/);
  assert.match(problems({ schemaVersion: 2 as never }), /schemaVersion 1/);
  assert.match(problems({ gateVersion: 9 as never }), /gate version/);
  assert.match(problems({ stdout: "x" }), /raw state, output or secret field/);
  assert.match(lifecycleReportProblems({ ...report, sourceCommit: "0".repeat(40) }, { sourceCommit: SOURCE_COMMIT }).join(" | "), /not the expected source commit/);
  // A stage result must agree with the record it summarizes, so a stored report cannot be promoted by hand.
  assert.match(problems({ stages: { ...report.stages, observe: { ...report.stages.observe, status: "PASS" } }, observation: { verdict: "FAILED", resources: [] } }), /observe: PASS needs an observation whose verdict is VERIFIED or PARTIAL/);
  assert.match(problems({ stages: { ...report.stages, leftovers: { ...report.stages.leftovers, status: "PASS" } }, dispositions: { disposition: "KNOWN_ADDRESSES_CONFIRMED", resources: [] } }), /leftovers: PASS needs dispositions that say COMPLETE/);
  assert.match(problems({ stages: { ...report.stages, leftovers: { ...report.stages.leftovers, status: "PASS" } }, dispositions: null }), /leftovers: PASS needs dispositions that say COMPLETE/);
  assert.match(lifecycleReportProblems(report, { gateId: "act:azure-terraform" }).join(" | "), /not the expected gate/);
  // The three acceptance states are derived and kept apart: no report claims the environment deleted or retired, or a cleanup complete its leftovers stage does not show.
  assert.match(problems({ acceptance: { ...report.acceptance, environmentRetirement: "COMPLETE" as never } }), /environmentRetirement: always OUTSTANDING/);
  assert.match(problems({ acceptance: { ...report.acceptance, resourceCleanup: "COMPLETED" } }), /resourceCleanup: not derived from the leftovers stage/);
  // The statement is recomputed, not matched as text: a forged sentence that adds a claim, or drops one, is refused.
  for (const forged of ["entire environment deleted; environment retirement outstanding", "approved resources deleted", report.acceptance.statement + "; the environment has been deleted", report.acceptance.statement.replace("outstanding", "complete")]) {
    assert.match(problems({ acceptance: { ...report.acceptance, statement: forged } }), /statement: not derived from the resource cleanup state and the retained counts/, forged);
  }
  assert.match(problems({ acceptance: { ...report.acceptance, retained: { ...report.acceptance.retained, byOwner: { AGENT: report.acceptance.retained.total } } } }), /byOwner: a key is not a retention owner/);
  assert.match(problems({ acceptance: { ...report.acceptance, retained: { ...report.acceptance.retained, byOwnership: { RUN_CREATED: report.acceptance.retained.total } } } }), /byOwnership: a key is not an ownership class a kept resource can carry/);
  assert.match(problems({ acceptance: { ...report.acceptance, retained: { ...report.acceptance.retained, total: report.acceptance.retained.total + 1 } } }), /counts by ownership and by owner must add up/);
  // NB1 (review 6410149770): who keeps what follows from the ownership classes. A swapped owner with a consistent statement and total is still refused.
  const swapped = { ...report.acceptance.retained, byOwner: { ENVIRONMENT_OWNER: report.acceptance.retained.total } };
  assert.match(problems({ acceptance: { ...report.acceptance, retained: swapped, statement: acceptanceStatement(report.acceptance.resourceCleanup, swapped) } }), /byOwner: not derived from the counts by ownership/);
  const split = { total: 2, byOwnership: { PROTECTED_BACKEND: 1, NOT_IN_PLAN: 1 }, byOwner: { PILOT_OWNER: 2 } };
  assert.match(lifecycleReportProblems({ ...report, acceptance: { ...report.acceptance, retained: split, statement: acceptanceStatement(report.acceptance.resourceCleanup, split) } }).join(" | "), /byOwner: not derived from the counts by ownership/, "a count moved between owners");
  const { acceptance: _dropped, ...withoutAcceptance } = report;
  assert.match(lifecycleReportProblems(withoutAcceptance).join(" | "), /report\.acceptance: missing/);
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
  // And the cleanup command refuses another run's sealed plan for this proposal before any phrase is asked.
  const wrongSeal = await cli(w, ["cleanup", "--proposal", proposalPath, "--request", run.applyRequest, "--manifest", run.manifest, "--sealed", otherRun.sealedPlanPath, "--approval", run.applyApproval]);
  assert.equal(wrongSeal.code, 2);
  assert.match(wrongSeal.stderr, /PROPOSAL_INVALID/);
  assert.deepEqual(wrongSeal.term.asked, [], "refused before the phrase");
});

test("propose-cleanup and approve of a proposal are AUTHORIZED by the current contract's CLEANUP entry: refused without it or after an edit, and a revoked APPLY does not strand the cleanup", async () => {
  const w = await world();
  const run = await appliedRun(w);
  assert.equal((await cli(w, ["observe", "--sealed", run.sealedPlanPath])).code, 0);
  const withAuthorize = (authorize: Record<string, string[]>, over: Record<string, unknown> = {}) =>
    writeReviewedContract(w.contractPath, runContract({ authorize: { QA: ["APPLY", "CLEANUP"], PROD: ["APPLY", "CLEANUP"], ...authorize }, ...over }));
  // From an uncommitted checkout (the contract included) nothing is proposed: the committed contract is the authorization.
  const dirty = await cli(w, ["propose-cleanup", "--sealed", run.sealedPlanPath, ...requesterArgs()], [], { sourceCommit: "uncommitted" });
  assert.equal(dirty.code, 2, dirty.stderr);
  assert.match(dirty.stderr, /BLOCKED SOURCE_UNVERIFIED/);
  // No CLEANUP for DEV: propose-cleanup refuses before anything is built, and writes no proposal.
  withAuthorize({ DEV: ["APPLY"] });
  const denied = await cli(w, ["propose-cleanup", "--sealed", run.sealedPlanPath, ...requesterArgs()]);
  assert.equal(denied.code, 2, denied.stderr);
  assert.match(denied.stderr, /BLOCKED ACT_NOT_AUTHORIZED: .*CLEANUP for AWS TERRAFORM DEV.* No proposal was written\./);
  // APPLY revoked, CLEANUP kept: the run is still proposed (N3), under the contract committed now.
  withAuthorize({ DEV: ["CLEANUP"] });
  const proposed = await cli(w, ["propose-cleanup", "--sealed", run.sealedPlanPath, ...requesterArgs()]);
  assert.equal(proposed.code, 0, proposed.stderr);
  const proposalPath = /Saved \(private to this account\): (\S+)/.exec(proposed.stdout)![1];
  const proposal = JSON.parse(readFileSync(proposalPath, "utf8")) as { proposalSha256: string; contractSha256: string; authorizingContractSha256: string };
  assert.notEqual(proposal.authorizingContractSha256, proposal.contractSha256);
  const approveArgs = ["approve", "--bundle", proposalPath, "--key", keyFile("alice"), "--approver", "alice"];
  const phrase = "APPROVE CLEANUP DEV " + proposal.proposalSha256.slice(0, 12);
  // An approver never signs under a contract or entry other than the one the proposal bound, nor without CLEANUP.
  withAuthorize({ DEV: ["CLEANUP"] }, { maxApprovalAgeMinutes: 61 });
  const changed = await cli(w, approveArgs, [phrase]);
  assert.equal(changed.code, 2);
  assert.match(changed.stderr, /BLOCKED ACT_AUTHORIZATION_CHANGED/);
  assert.equal(changed.stdout, "", "nothing was signed");
  withAuthorize({ DEV: ["APPLY"] });
  const revoked = await cli(w, approveArgs, [phrase]);
  assert.equal(revoked.code, 2);
  assert.match(revoked.stderr, /BLOCKED ACT_NOT_AUTHORIZED/);
  // Back to the contract the proposal bound: approve, then clean up.
  withAuthorize({ DEV: ["CLEANUP"] });
  const signed = await cli(w, approveArgs, [phrase]);
  assert.equal(signed.code, 0, signed.stderr);
  const removed = await cli(w, ["cleanup", "--proposal", proposalPath, "--request", run.applyRequest, "--manifest", run.manifest, "--sealed", run.sealedPlanPath, "--approval", json(signed.data, "cleanup-approval")],
    ["CLEANUP DEV " + proposal.proposalSha256.slice(0, 12) + " " + targetString(run.target)]);
  assert.equal(removed.code, 0, removed.stderr);
  assert.equal((removed.data as { decisions: { authorized: { operation: string; contractSha256: string } } }).decisions.authorized.contractSha256, proposal.authorizingContractSha256);
});
