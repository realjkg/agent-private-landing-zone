import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { REQUESTER_MAY_APPROVE, signApproval, signRequest, verifyApprovalSet, verifyRequestSignature } from "../src/apply/approval.js";
import { buildCleanupProposal, computeProposalSha256, signCleanupProposal, verifyCleanupProposal, type CleanupProposal } from "../src/apply/cleanup-proposal.js";
import { canonicalPublicKey, loadPilotContract, pilotContractSha256 } from "../src/apply/contract.js";
import { runApply, runCleanup, sealPreview, type ApplyDeps } from "../src/apply/driver.js";
import { cleanupEvidenceProblems } from "../src/apply/evidence.js";
import { readCleanupEvidence } from "../src/apply/ledger.js";
import { openNonceStore } from "../src/apply/nonces.js";
import { loadRunRecords, observeRun } from "../src/apply/observe.js";
import { loadSealedPlan } from "../src/apply/seal.js";
import type { ApplyEnvironment, PilotContract, SealedPlan, SignedApproval } from "../src/apply/types.js";
import { pilotUnitOf } from "../src/apply/unit.js";
import { runApplyCommand, type ApplyCliDeps } from "../src/cli/apply.js";
import { removeTree } from "../src/teardown/driver/cleanup.js";
import {
  NOW, POLICY, SOURCE_COMMIT, approvalFor, awsContractJson, awsIdentityEnv, awsTargetOf, behave as behaveIn, behaveAwsReads, callsOf, human, installFakeAwsReads, installFakeTerraform, keys,
  stateResource, testFixtureForgeQualificationEvidence, writeReviewedContract, writeProject, type Project,
} from "./helpers/apply-fixtures.js";

// Production cleanup approvals use the production apply quorum (owner decision on issue #39, 6440801434, item 1; closes
// #286 N5): a cleanup has a requester who signs the proposal with an allowlisted key under the cleanup request domain, and
// in PROD the cleanup needs two distinct approvers, neither of them the requester, by id (any case) or by key under any id.
// DEV and QA behave as an apply does: the requester may approve. The check is the apply's own (`verifyApprovalSet`,
// `REQUESTER_MAY_APPROVE`), at proposal time, at the cleanup gate and again just before the approvals are consumed.
// The engine and the AWS CLI are fakes: SYNTHETIC evidence that pins the product's logic only. Fixtures and generated keys.

const root = mkdtempSync(join(tmpdir(), "alz-cleanup-requester-"));
const toolDir = mkdtempSync(join(tmpdir(), "alz-cleanup-requester-tf-"));
const awsToolDir = mkdtempSync(join(tmpdir(), "alz-cleanup-requester-aws-"));
process.env.AGENTIC_EVIDENCE_KEY = randomBytes(32).toString("base64");
process.chdir(root);
test.after(() => { removeTree(root); removeTree(toolDir); removeTree(awsToolDir); });
installFakeTerraform(toolDir);
installFakeAwsReads(awsToolDir);

let counter = 0;
const fresh = (label: string): string => { const dir = join(root, label + "-" + ++counter); mkdirSync(dir, { recursive: true }); return dir; };
const KILL = join(root, "KILL");

// Every approver may approve every environment here, so PROD can have a requester and two other approvers.
const CONTRACT = awsContractJson(KILL, { approvers: [
  { id: "alice", publicKeyPem: keys.alice.pub, environments: ["DEV", "QA", "PROD"] },
  { id: "bob", publicKeyPem: keys.bob.pub, environments: ["DEV", "QA", "PROD"] },
  { id: "carol", publicKeyPem: keys.carol.pub, environments: ["DEV", "QA", "PROD"] },
] });
type Who = "alice" | "bob" | "carol";
const person = (who: Who) => ({ requesterId: who, privateKeyPem: keys[who].priv });

const BUCKET = "examplefake-quorum-logs";
const LOG = "/alz/quorum/canary";
const logArn = (environment: ApplyEnvironment) => "arn:aws:logs:us-east-1:" + awsTargetOf(environment).account + ":log-group:" + LOG;
const CREATES = [
  { address: "aws_s3_bucket.logs", type: "aws_s3_bucket", change: { actions: ["create"], before: null, after: {} } },
  { address: "aws_cloudwatch_log_group.canary", type: "aws_cloudwatch_log_group", change: { actions: ["create"], before: null, after: {} } },
];
const stateOf = (environment: ApplyEnvironment) => [stateResource("aws_s3_bucket", "logs", BUCKET, "arn:aws:s3:::" + BUCKET), stateResource("aws_cloudwatch_log_group", "canary", LOG, logArn(environment))];
const AWS_PROVIDER_CONFIG = { aws: { name: "aws", full_name: "registry.terraform.io/hashicorp/aws", expressions: { region: { references: ["var.region"] } } } };
const SHARED_TF = 'resource "aws_s3_bucket" "logs" {}\n';

type World = { contractPath: string; evidenceDir: string; noncesDir: string; scratch: string; vault: string; proposalsDir: string; nonces: ReturnType<typeof openNonceStore> };
let vaultDir = "";
test.before(async () => { vaultDir = fresh("qualification"); await testFixtureForgeQualificationEvidence(vaultDir, undefined, "AWS"); });
function world(contract: unknown = CONTRACT): World {
  const contractPath = join(fresh("contract"), "act-pilot-contract.json");
  writeReviewedContract(contractPath, contract);
  const noncesDir = fresh("nonces");
  return { contractPath, evidenceDir: fresh("evidence"), noncesDir, scratch: fresh("scratch"), vault: vaultDir, proposalsDir: fresh("proposals"), nonces: openNonceStore(noncesDir) };
}
const contractOf = (w: World): PilotContract => loadPilotContract(w.contractPath) as PilotContract;
/** The engine and the cloud as one environment's run shapes them: its deletion unit's tags, its state and the ARNs its unit lists. */
function shape(w: World, environment: ApplyEnvironment): void {
  const unit = pilotUnitOf({ provider: "AWS", contractSha256: pilotContractSha256(contractOf(w)), environment, target: awsTargetOf(environment) });
  behaveIn(toolDir, KILL, { applyAdvance: true, showOnlyConfigured: true, showResources: CREATES, showProviderConfig: AWS_PROVIDER_CONFIG, stateResources: stateOf(environment), unitTags: { ...unit.tags } });
  behaveAwsReads(awsToolDir, { existing: [BUCKET, LOG], tagged: ["arn:aws:s3:::" + BUCKET, logArn(environment)] });
}
const depsOf = (w: World, environment: ApplyEnvironment): ApplyDeps => ({
  sourceCommit: SOURCE_COMMIT, contractPath: w.contractPath, qualificationDir: w.vault, evidenceDir: w.evidenceDir, nonces: w.nonces,
  env: awsIdentityEnv(environment), now: () => NOW, scratchParent: w.scratch, toolDirs: [toolDir, awsToolDir], killPollMs: 40, killGraceMs: 400,
});
const destroyPlans = () => callsOf(toolDir).filter((c) => c.args[0] === "plan" && c.args[1] === "-destroy").length;
const refused = (result: { ok: boolean }, code: string): void => {
  assert.equal(result.ok, false, JSON.stringify(result));
  assert.equal((result as { code: string }).code, code, JSON.stringify(result));
};

type Run = { sealed: SealedPlan; sealedPath: string; loaded: { sealed: SealedPlan; planBytes: Buffer }; project: Project };
/** Seal (carol requests the change), approve and apply one environment's run of the shared release. PROD gets alice and bob. */
async function appliedIn(w: World, environment: ApplyEnvironment): Promise<Run> {
  shape(w, environment);
  const target = awsTargetOf(environment);
  const project = writeProject(fresh("project"), target, SHARED_TF);
  const sealed = await sealPreview({ invocation: human(target), environment, target, manifest: project.manifest, projectRoot: project.projectRoot, policyVersion: POLICY, resolved: project.resolved, requester: person("carol") }, depsOf(w, environment));
  assert.ok(sealed.ok, JSON.stringify(sealed));
  const loaded = await loadSealedPlan(sealed.path);
  assert.ok(loaded.ok);
  const approvers: Who[] = environment === "PROD" ? ["alice", "bob"] : ["alice"];
  const applied = await runApply({
    invocation: human(target), environment, target: { ...target }, sealedPlan: { sealed: loaded.sealed, planBytes: loaded.planBytes }, manifest: project.manifest, projectRoot: project.projectRoot,
    approvals: approvers.map((who) => approvalFor(sealed.sealed, who)),
  }, depsOf(w, environment));
  assert.ok(applied.ok, JSON.stringify(applied));
  return { sealed: sealed.sealed, sealedPath: sealed.path, loaded: { sealed: loaded.sealed, planBytes: loaded.planBytes }, project };
}
/** Observe the run and build its proposal, requested and signed by `requester` (the CLI's propose-cleanup does the same through the same functions). */
async function proposedIn(w: World, run: Run, requester: Who): Promise<CleanupProposal> {
  const environment = run.sealed.environment;
  shape(w, environment);
  const observed = await observeRun(run.sealed.artifactSha256, { contractPath: w.contractPath, evidenceDir: w.evidenceDir, env: awsIdentityEnv(environment),
    toolDirs: [toolDir, awsToolDir], scratchParent: w.scratch, now: () => new Date(NOW.getTime() + 60_000) });
  assert.ok(observed.ok, JSON.stringify(observed));
  const records = await loadRunRecords(run.sealed.artifactSha256, w.evidenceDir);
  assert.ok(records.ok, JSON.stringify(records));
  const built = buildCleanupProposal({ ...records, changes: run.sealed.changes, channel: "CLI", contract: contractOf(w), engineVersion: run.sealed.engineVersion, env: awsIdentityEnv(environment),
    now: new Date(NOW.getTime() + 120_000), requesterId: requester });
  assert.ok(built.ok, JSON.stringify(built));
  return signCleanupProposal(built.proposal, keys[requester].priv);
}
const cleanupApproval = (proposal: CleanupProposal, approverId: string, privateKeyPem: string): SignedApproval => signApproval({
  schemaVersion: 1, artifactSha256: proposal.proposalSha256, environment: proposal.environment, target: proposal.target, approverId,
  issuedAt: new Date(NOW.getTime() - 5 * 60_000).toISOString(), expiresAt: new Date(NOW.getTime() + 25 * 60_000).toISOString(), nonce: randomBytes(16).toString("hex"),
}, privateKeyPem, "CLEANUP");
const by = (proposal: CleanupProposal, who: Who) => cleanupApproval(proposal, who, keys[who].priv);
const cleanUp = (w: World, run: Run, proposal: CleanupProposal, approvals: SignedApproval[]) => runCleanup({
  invocation: human(run.sealed.target), environment: run.sealed.environment, target: { ...run.sealed.target }, proposal, sealedPlan: run.loaded, manifest: run.project.manifest,
  projectRoot: run.project.projectRoot, approvals,
}, depsOf(w, run.sealed.environment));
/** The release promoted DEV, QA, PROD: the three applied runs, each requested by carol. */
async function promoted(w: World): Promise<Record<ApplyEnvironment, Run>> {
  const dev = await appliedIn(w, "DEV");
  const qa = await appliedIn(w, "QA");
  const prod = await appliedIn(w, "PROD");
  return { DEV: dev, QA: qa, PROD: prod };
}

// --- the rule is the apply's ---------------------------------------------------------------------------------------

test("a cleanup is judged by the apply's own frozen rule: verifyApprovalSet under the cleanup domain refuses the requester in PROD by id, by a case variant of the id and by key under another id, and needs a requester at all", () => {
  assert.deepEqual(REQUESTER_MAY_APPROVE, { DEV: true, QA: true, PROD: false });
  assert.ok(Object.isFrozen(REQUESTER_MAY_APPROVE));
  const w = world();
  const nonces = openNonceStore(w.noncesDir);
  const proposalSha256 = "c".repeat(64);
  const statement = (approverId: string, environment: ApplyEnvironment) => ({
    schemaVersion: 1 as const, artifactSha256: proposalSha256, environment, target: awsTargetOf(environment), approverId,
    issuedAt: new Date(NOW.getTime() - 60_000).toISOString(), expiresAt: new Date(NOW.getTime() + 20 * 60_000).toISOString(), nonce: randomBytes(16).toString("hex"),
  });
  const requester = { requesterId: "alice", publicKeyCanonical: canonicalPublicKey(keys.alice.pub) };
  // Hand-built allowlists the contract loader would refuse (a case variant of an id, one key under two ids), to prove the rule itself holds even then.
  const base = contractOf(w);
  const withEntry = (id: string, publicKeyPem: string): PilotContract => ({ ...base, approvers: [...base.approvers, { id, publicKeyPem, environments: ["DEV", "QA", "PROD"] }] });
  const judge = (environment: ApplyEnvironment, approvals: SignedApproval[], contract: PilotContract = base) =>
    verifyApprovalSet({ approvals, artifactSha256: proposalSha256, environment, target: awsTargetOf(environment), contract, now: NOW, nonces, subject: "CLEANUP", requester });
  const sign = (approverId: string, environment: ApplyEnvironment, privateKeyPem: string) => signApproval(statement(approverId, environment), privateKeyPem, "CLEANUP");
  // PROD: by id, by a case variant of the id (another key), by the requester's key under another id; each is APPROVER_IS_REQUESTER.
  refused(judge("PROD", [sign("alice", "PROD", keys.alice.priv), sign("bob", "PROD", keys.bob.priv)]), "APPROVER_IS_REQUESTER");
  refused(judge("PROD", [sign("bob", "PROD", keys.bob.priv), sign("ALICE", "PROD", keys.mallory.priv)], withEntry("ALICE", keys.mallory.pub)), "APPROVER_IS_REQUESTER");
  refused(judge("PROD", [sign("bob", "PROD", keys.bob.priv), sign("alice-again", "PROD", keys.alice.priv)], { ...base, approvers: [...base.approvers.filter((a) => a.id !== "alice"), { id: "alice-again", publicKeyPem: keys.alice.pub, environments: ["PROD"] }] }), "APPROVER_IS_REQUESTER");
  // PROD: fewer than two distinct approvers.
  refused(judge("PROD", [sign("bob", "PROD", keys.bob.priv)]), "APPROVAL_INSUFFICIENT");
  refused(judge("PROD", [sign("bob", "PROD", keys.bob.priv), sign("bob", "PROD", keys.bob.priv)]), "SAME_APPROVER_TWICE");
  refused(judge("PROD", [sign("bob", "PROD", keys.bob.priv), sign("bob-twin", "PROD", keys.bob.priv)], withEntry("bob-twin", keys.bob.pub)), "SAME_APPROVER_TWICE");
  // PROD: two others pass.
  assert.equal(judge("PROD", [sign("bob", "PROD", keys.bob.priv), sign("carol", "PROD", keys.carol.priv)]).ok, true);
  // DEV and QA: the requester approves, as for an apply.
  for (const environment of ["DEV", "QA"] as const) assert.equal(judge(environment, [sign("alice", environment, keys.alice.priv)]).ok, true, environment);
  // No requester at all: refused in every environment, so a caller cannot skip the rule by leaving it out.
  for (const environment of ["DEV", "QA", "PROD"] as const) {
    const verdict = verifyApprovalSet({ approvals: [sign("bob", environment, keys.bob.priv), sign("carol", environment, keys.carol.priv)], artifactSha256: proposalSha256, environment, target: awsTargetOf(environment), contract: base, now: NOW, nonces, subject: "CLEANUP" } as never);
    refused(verdict, "REQUESTER_SIGNATURE_MISSING");
  }
});

// --- the driver ----------------------------------------------------------------------------------------------------

test("PROD cleanup: the requester's approval by id is APPROVER_IS_REQUESTER, one approver or the same one twice is refused, and nothing is consumed or destroyed; the requester plus two distinct approvers clean up, and the evidence records the requester", async () => {
  const w = world();
  const runs = await promoted(w);
  const run = runs.PROD;
  const proposal = await proposedIn(w, run, "alice");
  assert.equal(proposal.requesterId, "alice");
  assert.equal(proposal.authorization.requiredApprovals, 2, "PROD needs the contract's PROD count, the same as an apply");
  const before = destroyPlans();
  const bob = by(proposal, "bob");
  refused(await cleanUp(w, run, proposal, [by(proposal, "alice"), bob]), "APPROVER_IS_REQUESTER");
  refused(await cleanUp(w, run, proposal, [bob, by(proposal, "alice")]), "APPROVER_IS_REQUESTER");
  refused(await cleanUp(w, run, proposal, [bob]), "APPROVAL_INSUFFICIENT");
  refused(await cleanUp(w, run, proposal, [bob, by(proposal, "bob")]), "SAME_APPROVER_TWICE");
  assert.equal(destroyPlans(), before, "no destroy was planned for a refused set");
  assert.equal(w.nonces.has(bob.statement.nonce), false, "bob's approval was not consumed by any refusal");
  assert.equal(w.nonces.has(proposal.request!.statement.nonce), false, "the request nonce is never consumed");
  assert.equal(await readCleanupEvidence(proposal.proposalSha256, w.evidenceDir), undefined, "nothing was recorded as executed");
  // The requester plus two distinct approvers, neither the requester: the same bob approval, unspent, now counts.
  const done = await cleanUp(w, run, proposal, [bob, by(proposal, "carol")]);
  assert.ok(done.ok, JSON.stringify(done));
  assert.deepEqual(done.evidence.requester, { requesterId: "alice", nonce: proposal.request!.statement.nonce });
  assert.deepEqual(done.evidence.approvals.map((a) => a.approverId).sort(), ["bob", "carol"]);
  assert.deepEqual(cleanupEvidenceProblems(done.evidence), []);
  assert.deepEqual(await readCleanupEvidence(proposal.proposalSha256, w.evidenceDir), done.evidence, "the ledger records who requested the cleanup");
  assert.equal(w.nonces.has(bob.statement.nonce), true, "the approvals of the accepted set are consumed");
  // Evidence without a requester is not cleanup evidence.
  const { requester: _requester, ...withoutRequester } = done.evidence;
  assert.match(cleanupEvidenceProblems(withoutRequester).join(), /evidence\.requester: missing/);
});

test("DEV and QA cleanup behave as apply: the requester may approve their own cleanup", async () => {
  const w = world();
  const runs = await promoted(w);
  for (const environment of ["DEV", "QA"] as const) {
    const run = runs[environment];
    const proposal = await proposedIn(w, run, "alice");
    assert.equal(proposal.authorization.requiredApprovals, 1, environment);
    const done = await cleanUp(w, run, proposal, [by(proposal, "alice")]);
    assert.ok(done.ok, environment + ": " + JSON.stringify(done));
    assert.equal(done.evidence.requester.requesterId, "alice");
    assert.deepEqual(done.evidence.approvals.map((a) => a.approverId), ["alice"]);
  }
});

test("a request signature cannot be carried between an apply and a cleanup: each verifies only under its own domain, and nothing is consumed by the refusal", async () => {
  const w = world();
  const runs = await promoted(w);
  const run = runs.PROD;
  const proposal = await proposedIn(w, run, "alice");
  const contract = contractOf(w);
  const statement = proposal.request!.statement;
  // An apply-domain request over this proposal's very hash, environment and requester: never a cleanup request.
  const applyDomain = { ...proposal, request: signRequest(statement, keys.alice.priv, "REQUEST") };
  assert.equal(verifyCleanupProposal(applyDomain).ok, true, "its fields still name this proposal");
  const before = destroyPlans();
  const approvals = [by(proposal, "bob"), by(proposal, "carol")];
  refused(await cleanUp(w, run, applyDomain, approvals), "REQUESTER_SIGNATURE_UNVERIFIED");
  // The sealed plan's own request (the apply's, over the artifact hash) moved onto the proposal names another artifact.
  refused(verifyCleanupProposal({ ...proposal, request: run.sealed.request }), "PROPOSAL_INVALID");
  refused(await cleanUp(w, run, { ...proposal, request: run.sealed.request }, approvals), "PROPOSAL_INVALID");
  // The other way round: a cleanup-domain request never verifies as the requester of an apply.
  const sealedStatement = run.sealed.request!.statement;
  refused(verifyRequestSignature({ request: signRequest(sealedStatement, keys.carol.priv, "CLEANUP_REQUEST"), artifactSha256: run.sealed.artifactSha256, environment: "PROD", requesterId: "carol", contract }), "REQUESTER_SIGNATURE_UNVERIFIED");
  refused(verifyRequestSignature({ request: run.sealed.request, artifactSha256: run.sealed.artifactSha256, environment: "PROD", requesterId: "carol", contract, subject: "CLEANUP_REQUEST" }), "REQUESTER_SIGNATURE_UNVERIFIED");
  assert.equal(verifyRequestSignature({ request: proposal.request, artifactSha256: proposal.proposalSha256, environment: "PROD", requesterId: "alice", contract, subject: "CLEANUP_REQUEST" }).ok, true);
  assert.equal(destroyPlans(), before);
  assert.ok(approvals.every((a) => !w.nonces.has(a.statement.nonce)), "no approval was consumed");
  // An unapplied plan carrying a cleanup-domain request is refused at apply, before anything is consumed.
  const other = world();
  shape(other, "DEV");
  const target = awsTargetOf("DEV");
  const project = writeProject(fresh("project"), target, SHARED_TF);
  const sealed = await sealPreview({ invocation: human(target), environment: "DEV", target, manifest: project.manifest, projectRoot: project.projectRoot, policyVersion: POLICY, resolved: project.resolved, requester: person("carol") }, depsOf(other, "DEV"));
  assert.ok(sealed.ok, JSON.stringify(sealed));
  const loaded = await loadSealedPlan(sealed.path);
  assert.ok(loaded.ok);
  const swapped = { ...loaded.sealed, request: signRequest(loaded.sealed.request!.statement, keys.carol.priv, "CLEANUP_REQUEST") };
  const approval = approvalFor(sealed.sealed, "alice");
  refused(await runApply({ invocation: human(target), environment: "DEV", target: { ...target }, sealedPlan: { sealed: swapped, planBytes: loaded.planBytes }, manifest: project.manifest, projectRoot: project.projectRoot, approvals: [approval] }, depsOf(other, "DEV")), "REQUESTER_SIGNATURE_UNVERIFIED");
  assert.equal(other.nonces.has(approval.statement.nonce), false);
});

test("a cleanup requester signature that is forged, missing or edited is refused at the gate; a proposal made before cleanup requesters existed (schema 1) is refused everywhere", async () => {
  const w = world();
  const runs = await promoted(w);
  const run = runs.DEV;
  const proposal = await proposedIn(w, run, "carol");
  const approvals = [by(proposal, "alice")];
  const before = destroyPlans();
  // Mallory signs carol's statement: it does not verify against carol's allowlisted key.
  refused(await cleanUp(w, run, { ...proposal, request: signRequest(proposal.request!.statement, keys.mallory.priv, "CLEANUP_REQUEST") }, approvals), "REQUESTER_SIGNATURE_UNVERIFIED");
  // A requester who is not on the allowlist, with a self-consistent proposal and signature.
  const stranger = signCleanupProposal(((p) => ({ ...p, proposalSha256: computeProposalSha256(p) }))({ ...proposal, requesterId: "mallory" }), keys.mallory.priv);
  refused(await cleanUp(w, run, stranger, approvals), "REQUESTER_NOT_ALLOWED");
  // A swapped requester id changes the hash every approver signed; re-hashed but not re-signed, the request names the old one.
  refused(verifyCleanupProposal({ ...proposal, requesterId: "alice" }), "PROPOSAL_INVALID");
  refused(verifyCleanupProposal(((p) => ({ ...p, proposalSha256: computeProposalSha256(p) }))({ ...proposal, requesterId: "alice" })), "PROPOSAL_INVALID");
  // A stripped signature, and a schema 1 proposal without requester fields.
  refused(verifyCleanupProposal({ ...proposal, request: null }), "PROPOSAL_INVALID");
  refused(await cleanUp(w, run, { ...proposal, request: null }, approvals), "PROPOSAL_INVALID");
  const { requesterId: _requesterId, request: _request, ...legacyFields } = proposal;
  const legacy = { ...legacyFields, schemaVersion: 1 };
  const schemaOne = verifyCleanupProposal({ ...legacy, proposalSha256: computeProposalSha256(legacy as never) });
  refused(schemaOne, "PROPOSAL_INVALID");
  assert.match((schemaOne as { message: string }).message, /before cleanup requesters existed/);
  refused(await cleanUp(w, run, { ...legacy, proposalSha256: computeProposalSha256(legacy as never) } as never, approvals), "PROPOSAL_INVALID");
  assert.equal(destroyPlans(), before, "nothing was planned");
  assert.ok(approvals.every((a) => !w.nonces.has(a.statement.nonce)), "nothing was consumed");
  // The untouched proposal still cleans up: the refusals spent nothing.
  assert.ok((await cleanUp(w, run, proposal, approvals)).ok);
});

// --- the commands --------------------------------------------------------------------------------------------------

type Terminal = NonNullable<ApplyCliDeps["terminal"]> & { out: string[]; asked: string[] };
const terminal = (answers: string[]): Terminal => {
  const out: string[] = [];
  const asked: string[] = [];
  return { stdinIsTTY: true, stdoutIsTTY: true, out, asked, write: (t) => { out.push(t); }, ask: async (q) => { asked.push(q); return answers.shift() ?? ""; } };
};
async function cli(w: World, environment: ApplyEnvironment, args: string[], answers: string[] = []) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const term = terminal(answers);
  const code = await runApplyCommand(args, {
    sourceCommit: SOURCE_COMMIT, terminal: term, env: awsIdentityEnv(environment), now: () => new Date(NOW.getTime() + 120_000), operatorId: "operator.fixture", contractPath: w.contractPath, qualificationDir: w.vault, evidenceDir: w.evidenceDir, nonces: w.nonces, scratchParent: w.scratch, toolDirs: [toolDir, awsToolDir], proposalsDir: w.proposalsDir,
    stdout: (t) => { stdout.push(t); }, stderr: (t) => { stderr.push(t); },
  });
  return { code, stdout: stdout.join(""), stderr: stderr.join(""), term };
}
const keyFile = (who: keyof typeof keys): string => { const path = join(fresh("key"), who + ".pem"); writeFileSync(path, keys[who].priv, { mode: 0o600 }); chmodSync(path, 0o600); return path; };
const proposalFiles = (w: World): string[] => existsSync(w.proposalsDir) ? readdirSync(w.proposalsDir) : [];

test("./alz apply propose-cleanup takes --requester and --key, refuses a stranger or a wrong key before any proposal is written, and writes a proposal the requester signed", async () => {
  const w = world();
  const runs = await promoted(w);
  const run = runs.PROD;
  shape(w, "PROD");
  assert.equal((await cli(w, "PROD", ["observe", "--sealed", run.sealedPath])).code, 0);
  const base = ["propose-cleanup", "--sealed", run.sealedPath];
  // Both flags are required; no other key source exists.
  assert.equal((await cli(w, "PROD", base)).code, 1);
  assert.equal((await cli(w, "PROD", [...base, "--requester", "alice"])).code, 1);
  const stranger = await cli(w, "PROD", [...base, "--requester", "mallory", "--key", keyFile("mallory")]);
  assert.equal(stranger.code, 2);
  assert.match(stranger.stderr, /REQUESTER_NOT_ALLOWED/);
  const wrongKey = await cli(w, "PROD", [...base, "--requester", "alice", "--key", keyFile("bob")]);
  assert.equal(wrongKey.code, 2);
  assert.match(wrongKey.stderr, /REQUESTER_KEY_MISMATCH/);
  assert.deepEqual(proposalFiles(w), [], "no proposal was written for a refused requester");
  const ok = await cli(w, "PROD", [...base, "--requester", "alice", "--key", keyFile("alice")]);
  assert.equal(ok.code, 0, ok.stderr);
  assert.match(ok.stdout, /requested by {4}alice \(in PROD the requester cannot approve this cleanup\)/);
  assert.match(ok.stdout, /2 distinct approvers, none of them the requester alice/);
  const path = /Saved \(private to this account\): (\S+)/.exec(ok.stdout)![1];
  const proposal = JSON.parse(readFileSync(path, "utf8")) as CleanupProposal;
  assert.equal(proposal.schemaVersion, 2);
  assert.equal(proposal.requesterId, "alice");
  assert.ok(verifyCleanupProposal(proposal).ok);
  assert.equal(verifyRequestSignature({ request: proposal.request, artifactSha256: proposal.proposalSha256, environment: "PROD", requesterId: "alice", contract: contractOf(w), subject: "CLEANUP_REQUEST" }).ok, true);
});

test("./alz apply approve of a PROD cleanup shows who requested it and refuses the requester (by id, a case variant or their key under another id) before asking for the phrase; DEV lets the requester approve", async () => {
  const w = world();
  const runs = await promoted(w);
  const prod = await proposedIn(w, runs.PROD, "alice");
  const prodPath = join(fresh("proposal"), "prod.json");
  writeFileSync(prodPath, JSON.stringify(prod));
  const phrase = "APPROVE CLEANUP PROD " + prod.proposalSha256.slice(0, 12);
  for (const [approverId, key] of [["alice", "alice"], ["ALICE", "alice"], ["bob", "alice"]] as const) {
    const self = await cli(w, "PROD", ["approve", "--bundle", prodPath, "--key", keyFile(key), "--approver", approverId], [phrase]);
    assert.equal(self.code, 2, approverId + " with " + key + "'s key");
    assert.match(self.stderr, /APPROVER_IS_REQUESTER/);
    assert.deepEqual(self.term.asked, [], "refused before the phrase was asked");
    assert.equal(self.stdout, "", "nothing was signed");
  }
  const other = await cli(w, "PROD", ["approve", "--bundle", prodPath, "--key", keyFile("bob"), "--approver", "bob"], [phrase]);
  assert.equal(other.code, 0, other.stderr);
  assert.match(other.term.out.join(""), /requester {7}alice \(signature verified against the allowlist\)/);
  // A proposal whose request was forged is refused before anything is shown or signed.
  const forgedPath = join(fresh("proposal"), "forged.json");
  writeFileSync(forgedPath, JSON.stringify({ ...prod, request: signRequest(prod.request!.statement, keys.mallory.priv, "CLEANUP_REQUEST") }));
  const forged = await cli(w, "PROD", ["approve", "--bundle", forgedPath, "--key", keyFile("bob"), "--approver", "bob"], [phrase]);
  assert.equal(forged.code, 2);
  assert.match(forged.stderr, /REQUESTER_SIGNATURE_UNVERIFIED/);
  assert.deepEqual(forged.term.asked, []);
  // A schema 1 proposal is refused by approve too.
  const { requesterId: _requesterId, request: _request, ...legacyFields } = prod;
  const legacy = { ...legacyFields, schemaVersion: 1 };
  const legacyPath = join(fresh("proposal"), "legacy.json");
  writeFileSync(legacyPath, JSON.stringify({ ...legacy, proposalSha256: computeProposalSha256(legacy as never) }));
  const old = await cli(w, "PROD", ["approve", "--bundle", legacyPath, "--key", keyFile("bob"), "--approver", "bob"], [phrase]);
  assert.equal(old.code, 2);
  assert.match(old.stderr, /PROPOSAL_INVALID/);
  // DEV: the requester approves their own cleanup.
  const dev = await proposedIn(w, runs.DEV, "alice");
  const devPath = join(fresh("proposal"), "dev.json");
  writeFileSync(devPath, JSON.stringify(dev));
  const devSelf = await cli(w, "DEV", ["approve", "--bundle", devPath, "--key", keyFile("alice"), "--approver", "alice"], ["APPROVE CLEANUP DEV " + dev.proposalSha256.slice(0, 12)]);
  assert.equal(devSelf.code, 0, devSelf.stderr);
});

test("a cleanup requester's allowlist entry must name the environment: a DEV-only requester is refused at propose-cleanup, at approve and at the cleanup gate in PROD, with nothing written, signed, consumed or destroyed; DEV still proceeds", async () => {
  const w = world();
  const runs = await promoted(w);
  // The owner's committed contract now allows carol to request and approve in DEV only. A cleanup is authorized by the
  // contract committed now, so every check below reads this one.
  writeReviewedContract(w.contractPath, awsContractJson(KILL, { approvers: (CONTRACT.approvers as { id: string }[]).map((a) => (a.id === "carol" ? { ...a, environments: ["DEV"] } : a)) }));
  const run = runs.PROD;
  shape(w, "PROD");
  assert.equal((await cli(w, "PROD", ["observe", "--sealed", run.sealedPath])).code, 0);
  const proposed = await cli(w, "PROD", ["propose-cleanup", "--sealed", run.sealedPath, "--requester", "carol", "--key", keyFile("carol")]);
  assert.equal(proposed.code, 2);
  assert.match(proposed.stderr, /REQUESTER_NOT_ALLOWED/);
  assert.match(proposed.stderr, /not allowed to request in PROD/);
  assert.deepEqual(proposalFiles(w), [], "no proposal was written");
  // The same proposal built and signed with carol's own key outside the command: refused at approve and at the gate.
  const forged = await proposedIn(w, run, "carol");
  const forgedPath = join(fresh("proposal"), "forged.json");
  writeFileSync(forgedPath, JSON.stringify(forged));
  const phrase = "APPROVE CLEANUP PROD " + forged.proposalSha256.slice(0, 12);
  const approve = await cli(w, "PROD", ["approve", "--bundle", forgedPath, "--key", keyFile("bob"), "--approver", "bob"], [phrase]);
  assert.equal(approve.code, 2);
  assert.match(approve.stderr, /REQUESTER_NOT_ALLOWED/);
  assert.deepEqual(approve.term.asked, [], "refused before the phrase was asked");
  const before = destroyPlans();
  const approvals = [by(forged, "alice"), by(forged, "bob")];
  refused(await cleanUp(w, run, forged, approvals), "REQUESTER_NOT_ALLOWED");
  assert.equal(destroyPlans(), before, "no destroy was planned");
  assert.ok(approvals.every((a) => !w.nonces.has(a.statement.nonce)), "no approval was consumed");
  assert.equal(await readCleanupEvidence(forged.proposalSha256, w.evidenceDir), undefined, "nothing was recorded as executed");
  // In DEV, the environment carol's entry names, her cleanup proceeds.
  const dev = await proposedIn(w, runs.DEV, "carol");
  const done = await cleanUp(w, runs.DEV, dev, [by(dev, "alice")]);
  assert.ok(done.ok, JSON.stringify(done));
  assert.equal(done.evidence.requester.requesterId, "carol");
});
