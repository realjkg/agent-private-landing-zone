import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { isRetainedByDefault, proposalProblems, teardownPhrase, type CleanupProposal } from "../src/apply/cleanup-proposal.js";
import { loadPilotContract, pilotContractSha256 } from "../src/apply/contract.js";
import { lifecycleReportProblems, type LifecycleReport } from "../src/apply/lifecycle-report.js";
import { openNonceStore } from "../src/apply/nonces.js";
import type { PilotChannel, PilotContract } from "../src/apply/types.js";
import { pilotUnitOf } from "../src/apply/unit.js";
import { runApplyCommand, type ApplyCliDeps } from "../src/cli/apply.js";
import { targetString } from "../src/cli/teardown-driver.js";
import { removeTree } from "../src/teardown/driver/cleanup.js";
import {
  AWS_DEV_TARGET, NOW, POLICY, SOURCE_COMMIT, awsContractJson, awsIdentityEnv, awsTargetOf, behave as behaveIn, behaveAwsReads, callsOf, canaryFor, installFakeAwsReads,
  installFakeTerraform, keys, reHashedProposal, requesterArgs, stateResource, testFixtureForgeQualificationEvidence, withCanary, writeProject, writeReviewedContract,
  type AwsReadBehavior, type Project,
} from "./helpers/apply-fixtures.js";

// Retention by default for the cost baseline (owner decision of 2026-11-05, issue #39 comment 6646346513, item 3): a run that created a
// cost baseline (a CUR 2.0 export and its bucket) is kept unless a person at the terminal types the teardown disposition,
// `TEAR DOWN COST BASELINE <artifact12>`, which is bound into the signed proposal. Without it `./alz apply propose-cleanup` writes and
// signs nothing; with it the proposal still faces the bucket preflight before anything is destroyed. Any other run is unchanged. The
// engine and the AWS CLI are fakes: SYNTHETIC evidence, pinning the product's logic only.

const root = mkdtempSync(join(tmpdir(), "alz-retention-"));
const toolDir = mkdtempSync(join(tmpdir(), "alz-retention-tf-"));
const awsToolDir = mkdtempSync(join(tmpdir(), "alz-retention-aws-"));
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
const ACCOUNT = AWS_DEV_TARGET.account;
const BUCKET = "examplefake-cur-export";
const LOG = "/alz/retention/canary";
const EXPORT = "arn:aws:bcm-data-exports:us-east-1:" + ACCOUNT + ":export/alz-cur2-retention";
const AWS_PROVIDER_CONFIG = { aws: { name: "aws", full_name: "registry.terraform.io/hashicorp/aws", expressions: { region: { references: ["var.region"] } } } };
const created = (address: string, type: string) => ({ address, type, change: { actions: ["create"], before: null, after: {} } });
const PLAIN_CREATES = [created("aws_s3_bucket.cost_export", "aws_s3_bucket"), created("aws_cloudwatch_log_group.canary", "aws_cloudwatch_log_group")];
const COST_CREATES = [...PLAIN_CREATES, created("aws_bcmdataexports_export.cur2", "aws_bcmdataexports_export")];
const PLAIN_STATE = [stateResource("aws_s3_bucket", "cost_export", BUCKET, "arn:aws:s3:::" + BUCKET),
  stateResource("aws_cloudwatch_log_group", "canary", LOG, "arn:aws:logs:us-east-1:" + ACCOUNT + ":log-group:" + LOG)];
const COST_STATE = [...PLAIN_STATE, stateResource("aws_bcmdataexports_export", "cur2", EXPORT, EXPORT)];

type Shape = { creates: typeof PLAIN_CREATES; state: typeof PLAIN_STATE; existing: string[]; tagged: string[] };
const PLAIN: Shape = { creates: PLAIN_CREATES, state: PLAIN_STATE, existing: [BUCKET, LOG], tagged: ["arn:aws:s3:::" + BUCKET, "arn:aws:logs:us-east-1:" + ACCOUNT + ":log-group:" + LOG] };
const COST: Shape = { ...PLAIN, creates: COST_CREATES, state: COST_STATE, existing: [BUCKET, LOG, EXPORT], tagged: [...PLAIN.tagged, EXPORT] };

const keyFile = (who: keyof typeof keys): string => {
  const path = join(fresh("key"), who + ".pem");
  writeFileSync(path, keys[who].priv, { mode: 0o600 });
  chmodSync(path, 0o600);
  return path;
};
const json = (value: unknown, label = "file"): string => {
  const path = join(fresh(label), label + ".json");
  writeFileSync(path, JSON.stringify(value));
  return path;
};
type Terminal = NonNullable<ApplyCliDeps["terminal"]> & { out: string[]; asked: { prompt: string; kind?: string; phrase?: string }[] };
const terminal = (answers: string[], tty = true): Terminal => {
  const out: string[] = [];
  const asked: Terminal["asked"] = [];
  return { stdinIsTTY: tty, stdoutIsTTY: tty, out, asked, write: (text: string) => { out.push(text); }, ask: async (prompt, expectation) => { asked.push({ prompt, kind: expectation?.kind, phrase: expectation?.phrase }); return answers.shift() ?? ""; } };
};

type World = { shape: Shape; channel: PilotChannel; deps: (term: Terminal, over?: Partial<ApplyCliDeps>) => ApplyCliDeps; proposalsDir: string; reportsDir: string };
const cloud = (w: World, behavior: AwsReadBehavior = {}) => behaveAwsReads(awsToolDir, { existing: w.shape.existing, tagged: w.shape.tagged, ...behavior });
async function world(shape: Shape, channel: PilotChannel = "CLI"): Promise<World> {
  const contract = withCanary(awsContractJson(KILL), canaryFor(shape.creates));
  const contractPath = join(fresh("contract"), "act-pilot-contract.json");
  writeReviewedContract(contractPath, contract);
  const unit = pilotUnitOf({ provider: "AWS", contractSha256: pilotContractSha256(loadPilotContract(contractPath) as PilotContract), environment: "DEV", target: awsTargetOf("DEV") });
  behaveIn(toolDir, KILL, { applyAdvance: true, showOnlyConfigured: true, showResources: shape.creates, showProviderConfig: AWS_PROVIDER_CONFIG, stateResources: shape.state, unitTags: { ...unit.tags } });
  const vault = fresh("vault");
  await testFixtureForgeQualificationEvidence(vault, undefined, "AWS");
  const [scratch, evidenceDir, acceptanceDir, reportsDir, proposalsDir] = [fresh("scratch"), fresh("evidence"), fresh("acceptance"), fresh("reports"), fresh("proposals")];
  const nonces = openNonceStore(fresh("nonces"));
  const w: World = {
    shape, channel, proposalsDir, reportsDir,
    deps: (term, over = {}) => ({
      sourceCommit: SOURCE_COMMIT, terminal: term, env: awsIdentityEnv("DEV"), now: () => NOW, operatorId: "operator.fixture", contractPath, channel,
      qualificationDir: vault, evidenceDir, nonces, scratchParent: scratch, toolDirs: [toolDir, awsToolDir], acceptanceDir, reportsDir, proposalsDir, ...over,
    }),
  };
  cloud(w);
  return w;
}
type Run = { code: number; stdout: string; stderr: string; term: Terminal; data: unknown; reports: { code: string; message: string }[] };
async function cli(w: World, args: string[], answers: string[] = [], tty = true): Promise<Run> {
  const term = terminal(answers, tty);
  const stdout: string[] = [];
  const stderr: string[] = [];
  const reports: Run["reports"] = [];
  const code = await runApplyCommand(args, w.deps(term, { stdout: (t) => { stdout.push(t); }, stderr: (t) => { stderr.push(t); }, report: (r) => { reports.push({ code: r.code, message: r.message }); } }));
  let data: unknown;
  try { data = JSON.parse(stdout.join("")); } catch { data = undefined; }
  return { code, stdout: stdout.join(""), stderr: stderr.join(""), term, data, reports };
}

/** Seal, approve, apply and observe one run at the terminal; returns the files the cleanup steps need. */
async function observedRun(w: World) {
  const target = awsTargetOf("DEV");
  const project: Project = writeProject(fresh("project"), target, 'resource "aws_s3_bucket" "cost_export" {}\n');
  const request = json({ environment: "DEV", target, projectRoot: project.projectRoot, policyVersion: POLICY, resolved: project.resolved }, "request");
  const manifest = json(project.manifest, "manifest");
  const sealed = await cli(w, ["seal", "--request", request, "--manifest", manifest, ...requesterArgs()], [targetString(target), "RUN PROJECT CODE", "EMBED STATE_WRITE DEV"]);
  assert.equal(sealed.code, 0, sealed.stderr);
  const { sealedPlanPath, reviewBundlePath, artifactSha256, changes } = sealed.data as { sealedPlanPath: string; reviewBundlePath: string; artifactSha256: string; changes: { type: string }[] };
  const approved = await cli(w, ["approve", "--bundle", reviewBundlePath, "--key", keyFile("alice"), "--approver", "alice"], ["APPROVE DEV " + artifactSha256.slice(0, 12)]);
  assert.equal(approved.code, 0, approved.stderr);
  const applyRequest = json({ environment: "DEV", target, projectRoot: project.projectRoot }, "apply-request");
  const applied = await cli(w, ["apply", "--request", applyRequest, "--manifest", manifest, "--sealed", sealedPlanPath, "--approval", json(approved.data, "approval")],
    ["APPLY DEV " + artifactSha256.slice(0, 12) + " " + targetString(target)]);
  assert.equal(applied.code, 0, applied.stderr);
  const observed = await cli(w, ["observe", "--sealed", sealedPlanPath]);
  assert.equal(observed.code, 0, observed.stderr);
  return { target, sealedPlanPath, artifactSha256, applyRequest, manifest, changes };
}
type Observed = Awaited<ReturnType<typeof observedRun>>;
const propose = (w: World, run: Observed, answers: string[] = [], tty = true) => cli(w, ["propose-cleanup", "--sealed", run.sealedPlanPath, ...requesterArgs()], answers, tty);
const written = (w: World) => readdirSync(w.proposalsDir);
const engineApplies = () => callsOf(toolDir).filter((c) => c.args[0] === "apply").length;

/** Approve a proposal file as alice, and run it at the terminal. */
async function approveAndClean(w: World, run: Observed, proposalPath: string) {
  const proposal = JSON.parse(readFileSync(proposalPath, "utf8")) as CleanupProposal;
  const short = proposal.proposalSha256.slice(0, 12);
  const signed = await cli(w, ["approve", "--bundle", proposalPath, "--key", keyFile("alice"), "--approver", "alice"], ["APPROVE CLEANUP DEV " + short]);
  assert.equal(signed.code, 0, signed.stderr);
  const approval = json(signed.data, "cleanup-approval");
  const clean = () => cli(w, ["cleanup", "--proposal", proposalPath, "--request", run.applyRequest, "--manifest", run.manifest, "--sealed", run.sealedPlanPath, "--approval", approval],
    ["CLEANUP DEV " + short + " " + targetString(run.target)]);
  return { proposal, clean };
}

test("a cost-baseline run is retained by default: without the disposition, propose-cleanup writes and signs nothing, and the report says intentionally retained, not missing", async () => {
  const w = await world(COST);
  const run = await observedRun(w);
  assert.equal(isRetainedByDefault(run.changes), true);
  const phrase = teardownPhrase(run.artifactSha256);
  assert.equal(phrase, "TEAR DOWN COST BASELINE " + run.artifactSha256.slice(0, 12));
  for (const [label, answers] of [["nothing typed", []], ["wrong phrase", ["TEAR DOWN COST BASELINE"]], ["another run's phrase", ["TEAR DOWN COST BASELINE 000000000000"]],
    ["lower case", [phrase.toLowerCase()]], ["trailing space", [phrase + " "]]] as const) {
    const refused = await propose(w, run, [...answers]);
    assert.equal(refused.code, 2, label + ": " + refused.stderr);
    assert.match(refused.stderr, /BLOCKED CLEANUP_RETAINED_BY_DEFAULT: What was typed is not the teardown disposition, so the cost baseline stays retained\. No proposal was written and nothing was signed\./, label);
    assert.deepEqual(refused.term.asked.map((a) => [a.kind, a.phrase]), [["CLEANUP", phrase]], label + ": one phrase, the run's own");
    assert.match(refused.term.out.join(""), /COST BASELINE: RETAINED BY DEFAULT/, label);
    assert.deepEqual(written(w), [], label + ": nothing written");
  }
  // The report of a retained run: intentionally retained (owner default), never "propose the cleanup", and it still validates.
  const reported = await cli(w, ["report", "--sealed", run.sealedPlanPath]);
  assert.equal(reported.code, 0, reported.stderr);
  const report = JSON.parse(readFileSync((reported.data as { written: string }).written, "utf8")) as LifecycleReport;
  assert.deepEqual(lifecycleReportProblems(report, { sourceCommit: SOURCE_COMMIT }), []);
  assert.equal(report.passed, false);
  for (const stage of ["propose", "cleanup", "leftovers"] as const) {
    assert.equal(report.stages[stage].status, "NOT_RUN");
    assert.match(report.stages[stage].detail, /^intentionally retained \(owner default\)/, stage);
  }
  assert.ok(report.unresolved.some((u) => /^intentionally retained \(owner default\)/.test(u)), JSON.stringify(report.unresolved));
  assert.ok(!report.unresolved.includes("propose the cleanup"));
});

test("a non-terminal caller is refused before anything is read, and the console never takes the disposition: the run stays retained", async () => {
  const w = await world(COST);
  const run = await observedRun(w);
  const headless = await propose(w, run, [teardownPhrase(run.artifactSha256)], false);
  assert.equal(headless.code, 1);
  assert.match(headless.stderr, /^HUMAN_TERMINAL_REQUIRED/);
  assert.deepEqual(headless.term.asked, []);
  assert.deepEqual(written(w), []);
  // A run started in the console (UI channel) is finished there, and the console asks no teardown phrase.
  const ui = await world(COST, "UI");
  const uiRun = await observedRun(ui);
  const refused = await propose(ui, uiRun, [teardownPhrase(uiRun.artifactSha256)]);
  assert.equal(refused.code, 2, refused.stderr);
  assert.match(refused.stderr, /BLOCKED CLEANUP_RETAINED_BY_DEFAULT: .*given only by a person at a terminal/);
  assert.deepEqual(refused.term.asked, [], "no phrase is asked in the console");
  assert.deepEqual(written(ui), []);
});

test("with the disposition, the signed proposal carries it, the driver's rebuild accepts it, and the cleanup still faces the bucket preflight before anything is destroyed", async () => {
  const w = await world(COST);
  const run = await observedRun(w);
  const proposed = await propose(w, run, [teardownPhrase(run.artifactSha256)]);
  assert.equal(proposed.code, 0, proposed.stderr);
  const proposalPath = /Saved \(private to this account\): (\S+)/.exec(proposed.stdout)![1]!;
  assert.match(proposed.stdout, /DISPOSITION\s+TEARDOWN_CONFIRMED/);
  const { proposal, clean } = await approveAndClean(w, run, proposalPath);
  assert.equal(proposal.disposition, "TEARDOWN_CONFIRMED");
  assert.deepEqual(proposalProblems(proposal), []);
  assert.ok(proposal.deletes.some((d) => d.address === "aws_bcmdataexports_export.cur2") && proposal.deletes.some((d) => d.address === "aws_s3_bucket.cost_export"));
  // The bucket still holds a delivered report: refused, nothing destroyed, the approval kept.
  const before = engineApplies();
  cloud(w, { buckets: { [BUCKET]: { versions: 4, versioning: "Enabled" } } });
  const blocked = await clean();
  assert.equal(blocked.code, 2, blocked.stderr);
  assert.match(blocked.stderr, /BLOCKED CLEANUP_BUCKET_NOT_EMPTY: The bucket aws_s3_bucket\.cost_export \(examplefake-cur-export\) is not empty/);
  assert.equal(engineApplies(), before, "nothing was destroyed");
  // A delivery in flight: refused the same way.
  cloud(w, { executions: { [EXPORT]: ["DELIVERY_IN_PROCESS"] } });
  const inFlight = await clean();
  assert.equal(inFlight.code, 2, inFlight.stderr);
  assert.match(inFlight.stderr, /BLOCKED CLEANUP_BUCKET_NOT_EMPTY: .*QUEUED or IN_PROGRESS/);
  // Emptied by a person, the delivery finished: the same approval runs the cleanup, and the disposition rebuilt from the records matches.
  cloud(w, { executions: { [EXPORT]: ["DELIVERY_SUCCESS"] } });
  const done = await clean();
  assert.equal(done.code, 0, done.stderr);
  assert.equal((done.data as { outcome: string }).outcome, "SUCCEEDED");
  assert.equal(engineApplies(), before + 1);
});

test("the disposition is bound by the signed hash: stripped from a cost-baseline proposal, or added to another run's, the driver's rebuild refuses it before anything is destroyed", async () => {
  const cost = await world(COST);
  const costRun = await observedRun(cost);
  const honest = await propose(cost, costRun, [teardownPhrase(costRun.artifactSha256)]);
  assert.equal(honest.code, 0, honest.stderr);
  const honestProposal = JSON.parse(readFileSync(/Saved \(private to this account\): (\S+)/.exec(honest.stdout)![1]!, "utf8")) as CleanupProposal;
  // Only TEARDOWN_CONFIRMED, on an AWS cleanup proposal, is a disposition.
  for (const [label, value] of [["unknown word", { ...honestProposal, disposition: "MAYBE" }], ["remediation", { ...honestProposal, kind: "LOCATION_REMEDIATION" }],
    ["another provider", { ...honestProposal, provider: "AZURE" }]] as const) {
    assert.ok(proposalProblems(value).some((p) => p.startsWith("proposal.disposition")), label + ": " + proposalProblems(value).join("; "));
  }
  const { disposition: _dropped, ...rest } = honestProposal;
  const stripped = reHashedProposal(rest);
  assert.deepEqual(proposalProblems(stripped), [], "well formed; only the derivation can refuse it");
  const strippedPath = json(stripped, "stripped");
  const before = engineApplies();
  const strippedRun = await (await approveAndClean(cost, costRun, strippedPath)).clean();
  assert.equal(strippedRun.code, 2, strippedRun.stderr);
  assert.match(strippedRun.stderr, /BLOCKED CLEANUP_RETAINED_BY_DEFAULT/);
  assert.equal(engineApplies(), before);

  const plain = await world(PLAIN);
  const plainRun = await observedRun(plain);
  const ordinary = await propose(plain, plainRun);
  assert.equal(ordinary.code, 0, ordinary.stderr);
  assert.deepEqual(ordinary.term.asked, [], "a run without a cost baseline asks no phrase");
  const ordinaryProposal = JSON.parse(readFileSync(/Saved \(private to this account\): (\S+)/.exec(ordinary.stdout)![1]!, "utf8")) as CleanupProposal;
  assert.equal(Object.hasOwn(ordinaryProposal, "disposition"), false, "its proposal has no disposition key, so its hash is what it always was");
  const added = reHashedProposal({ ...ordinaryProposal, disposition: "TEARDOWN_CONFIRMED" });
  const addedRun = await (await approveAndClean(plain, plainRun, json(added, "added"))).clean();
  assert.equal(addedRun.code, 2, addedRun.stderr);
  assert.match(addedRun.stderr, /BLOCKED PROPOSAL_INVALID: A teardown disposition applies only to a run that created a cost baseline/);
  // The honest ordinary proposal is unchanged and still runs.
  const fine = await (await approveAndClean(plain, plainRun, /Saved \(private to this account\): (\S+)/.exec(ordinary.stdout)![1]!)).clean();
  assert.equal(fine.code, 0, fine.stderr);
});

test("a cost baseline is told by its export in the sealed changes", () => {
  assert.equal(isRetainedByDefault([{ type: "aws_s3_bucket" }]), false);
  assert.equal(isRetainedByDefault([{ type: "aws_s3_bucket" }, { type: "aws_bcmdataexports_export" }]), true);
});
