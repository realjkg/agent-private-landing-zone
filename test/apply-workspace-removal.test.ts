import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, chownSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { signApproval } from "../src/apply/approval.js";
import { authorizeContract, loadPilotContract, pilotContractSha256, pilotTargetSha256 } from "../src/apply/contract.js";
import { reserveArtifact } from "../src/apply/ledger.js";
import { openNonceStore } from "../src/apply/nonces.js";
import type { ApplyEnvironment, PilotContract, SignedApproval } from "../src/apply/types.js";
import {
  REMOVAL_RECORD_SUFFIX, authorizeRemoval, buildRemovalProposal, prepareRemoval, removalProposalSha256, removeWorkspace, signRemovalProposal, verifyRemovalProposal,
  type RemovalInput, type RemovalRun, type WorkspaceRemovalProposal, type WorkspaceRemovalRecord,
} from "../src/apply/workspace-removal.js";
import { runApplyCommand, type ApplyCliDeps } from "../src/cli/apply.js";
import { targetString } from "../src/cli/teardown-driver.js";
import { removeTree } from "../src/teardown/driver/cleanup.js";
import {
  NOW, POLICY, REQUESTER, SOURCE_COMMIT, awsContractJson, awsIdentityEnv, awsTargetOf, behave as behaveIn, behaveAwsReads, installFakeAwsReads, installFakeTerraform, keys, requesterArgs, stateResource, testFixtureForgeQualificationEvidence, writeReviewedContract, writeProject, type Project,
} from "./helpers/apply-fixtures.js";

// Removing a run's generated working files (owner decision 6443062568 "Unpin the ACT decision", item 2 (b), #39): through the same
// proposal, requester signature, approval quorum and kill-switch path as a cleanup. The removal deletes only what a fresh plan of the
// run produces AND the signed proposal lists (AND, when resumed, the record lists); a forged record or proposal can never widen it.
// Local files and a fake engine only: SYNTHETIC evidence.

const root = mkdtempSync(join(tmpdir(), "alz-ws-removal-"));
const toolDir = mkdtempSync(join(tmpdir(), "alz-ws-removal-tf-"));
const awsToolDir = mkdtempSync(join(tmpdir(), "alz-ws-removal-aws-"));
process.env.AGENTIC_EVIDENCE_KEY = randomBytes(32).toString("base64");
process.chdir(root);
test.after(() => { removeTree(root); removeTree(toolDir); removeTree(awsToolDir); });
installFakeTerraform(toolDir);
installFakeAwsReads(awsToolDir);
let counter = 0;
const fresh = (label: string): string => { const dir = join(root, label + "-" + ++counter); mkdirSync(dir, { recursive: true, mode: 0o700 }); return dir; };
const KILL = join(root, "KILL");
const ARTIFACT = "a".repeat(64);
const MANIFEST = "b".repeat(64);
const TAG = MANIFEST.slice(0, 16);
const OTHER_RUN = "request-cccccccccccccccc.json";
const HOUR = 60 * 60 * 1000;
const OLD = new Date(NOW.getTime() - 2 * HOUR);
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
/** The fixtures' authorization plus REMOVE: the reviewed contract authorizes removing a run's working files in every environment. */
const WITH_REMOVE = { authorize: { DEV: ["APPLY", "CLEANUP", "REMOVE"], QA: ["APPLY", "CLEANUP", "REMOVE"], PROD: ["APPLY", "CLEANUP", "REMOVE"] } };
const contractWith = (over: Record<string, unknown>): PilotContract => { const path = join(fresh("contract"), "act-pilot-contract.json"); writeReviewedContract(path, awsContractJson(KILL, over)); return loadPilotContract(path) as PilotContract; };
const CONTRACT = contractWith(WITH_REMOVE);
const runOf = (environment: ApplyEnvironment = "DEV"): RemovalRun => ({ artifactSha256: ARTIFACT, manifestHash: MANIFEST, environment, target: awsTargetOf(environment), channel: "CLI", targetSha256: pilotTargetSha256(CONTRACT, environment)! });

/** One run's leftovers: its preparation files, another run's, a stale scratch directory with a plan, .terraform and a state copy, a young one, and the evidence. */
function layout(environment: ApplyEnvironment = "DEV") {
  const base = fresh("ws");
  const env = join(base, "pilot", environment);
  mkdirSync(env, { recursive: true });
  for (const name of ["request-" + TAG + ".json", "manifest-" + TAG + ".json", "preparation-" + TAG + ".json", "manifest-" + TAG + ".json.partial-4242"]) writeFileSync(join(env, name), "{\"name\":\"" + name + "\"}\n");
  writeFileSync(join(env, OTHER_RUN), "{}\n");
  const scratch = join(base, "scratch");
  const stale = join(scratch, "alz-preview-old1");
  mkdirSync(join(stale, "work", ".terraform", "providers"), { recursive: true });
  writeFileSync(join(stale, "alz-apply.tfplan"), "PLAN-BYTES");
  writeFileSync(join(stale, "work", ".terraform", "terraform.tfstate"), "{\"backend\":{}}");
  writeFileSync(join(stale, "work", "main.tf"), "resource \"x\" \"y\" {}\n");
  utimesSync(stale, OLD, OLD);
  const young = join(scratch, "alz-preview-young");
  mkdirSync(young, { recursive: true });
  const evidence = join(base, "evidence");
  mkdirSync(evidence);
  for (const name of [ARTIFACT + ".apply.json", ARTIFACT + ".sealed.json", "apply.log"]) writeFileSync(join(evidence, name), "record");
  const where = { preparationDir: join(base, "pilot"), scratchParent: scratch, evidenceDir: evidence };
  const nonces = openNonceStore(fresh("nonces"));
  return { base, env, scratch, stale, young, evidence, where, nonces };
}
type Layout = ReturnType<typeof layout>;

function proposal(l: Layout, environment: ApplyEnvironment = "DEV", now: Date = NOW, contract: PilotContract = CONTRACT): WorkspaceRemovalProposal {
  const built = buildRemovalProposal({ run: runOf(environment), where: l.where, contract, requesterId: REQUESTER.requesterId, now });
  assert.ok(built.ok, JSON.stringify(built));
  return signRemovalProposal(built.proposal, REQUESTER.privateKeyPem);
}
const approve = (p: WorkspaceRemovalProposal, who: keyof typeof keys, subject: "CLEANUP" | "APPLY" = "CLEANUP"): SignedApproval => signApproval({
  schemaVersion: 1, artifactSha256: p.proposalSha256, environment: p.environment, target: p.target, approverId: who,
  issuedAt: new Date(NOW.getTime() - 60_000).toISOString(), expiresAt: new Date(NOW.getTime() + 30 * 60_000).toISOString(), nonce: randomBytes(16).toString("hex"),
}, keys[who].priv, subject);
const input = (l: Layout, p: unknown, approvals: SignedApproval[], environment: ApplyEnvironment = "DEV"): RemovalInput => ({
  proposal: p, approvals, run: runOf(environment), contract: CONTRACT, where: l.where, nonces: l.nonces, operatorId: "operator.fixture", now: NOW,
});
/** The person confirms the list prepareRemoval shows, then the removal runs: the CLI's order. */
async function confirmAndRemove(i: RemovalInput, seams = {}) {
  const ready = await prepareRemoval(i);
  if (!ready.ok) return ready;
  return removeWorkspace({ ...i, expected: ready.deletes.map((d) => d.path) }, seams);
}
const recordOf = (l: Layout): WorkspaceRemovalRecord => JSON.parse(readFileSync(join(l.evidence, ARTIFACT + REMOVAL_RECORD_SUFFIX), "utf8")) as WorkspaceRemovalRecord;
const codeOf = (result: { ok: boolean }) => (result as { code?: string }).code;

test("an approved removal deletes the run's preparation files and stale scratch (plan, .terraform, state copy), records paths, sizes and the plan's SHA-256, and keeps evidence, other runs' files and young scratch", async () => {
  const l = layout();
  const p = proposal(l);
  assert.deepEqual(p.authorization, { operation: "REMOVE", subject: "CLEANUP", requiredApprovals: 1 }, "the cleanup quorum for DEV, under the cleanup domain");
  assert.ok(verifyRemovalProposal(p).ok);
  const result = await confirmAndRemove(input(l, p, [approve(p, "alice")]));
  assert.ok(result.ok, JSON.stringify(result));
  assert.deepEqual(readdirSync(l.env), [OTHER_RUN], "only this run's preparation files went");
  assert.ok(!existsSync(l.stale) && existsSync(l.young));
  assert.deepEqual(readdirSync(l.evidence).sort(), [ARTIFACT + ".apply.json", ARTIFACT + ".sealed.json", ARTIFACT + REMOVAL_RECORD_SUFFIX, "apply.log"].sort());
  const removal = recordOf(l).removals[0]!;
  assert.deepEqual([removal.status, removal.proposalSha256, removal.approvers], ["COMPLETE", p.proposalSha256, ["alice"]]);
  assert.match(removal.authorization, /requester dana; 1 approval\(s\) \(alice\) under the cleanup domain/);
  assert.deepEqual(removal.items.map((i) => [i.kind, i.path.slice(l.base.length + 1), i.removed]), [
    ["PREPARATION_FILE", "pilot/DEV/manifest-" + TAG + ".json", true], ["PREPARATION_FILE", "pilot/DEV/manifest-" + TAG + ".json.partial-4242", true],
    ["PREPARATION_FILE", "pilot/DEV/preparation-" + TAG + ".json", true], ["PREPARATION_FILE", "pilot/DEV/request-" + TAG + ".json", true], ["SCRATCH_DIRECTORY", "scratch/alz-preview-old1", true],
  ]);
  assert.equal(removal.items[3]!.sha256, sha("{\"name\":\"request-" + TAG + ".json\"}\n"));
  assert.deepEqual(removal.items[4]!.plans.map((x) => [x.bytes, x.sha256]), [[10, sha("PLAN-BYTES")]]);
  // The approvals are spent: the same set never removes anything again.
  assert.equal(codeOf(await prepareRemoval(input(l, p, [approve(p, "alice")]))), undefined, "fresh approvals are fine");
});

test("B1: a forged IN_PROGRESS record, and a requester-signed proposal, that name precious.txt, a young non-alz directory and another run's request file delete none of them", async () => {
  const l = layout();
  const precious = join(l.scratch, "precious.txt");
  writeFileSync(precious, "keep me");
  const notAlz = join(l.scratch, "someone-else");
  mkdirSync(notAlz);
  const other = join(l.env, OTHER_RUN);
  const forgedItems = [precious, notAlz, other].map((path) => ({ path, kind: path === notAlz ? "SCRATCH_DIRECTORY" : "PREPARATION_FILE", bytes: 1, files: 1, plans: [], removed: false,
    ...(path === notAlz ? {} : { sha256: sha(readFileSync(path, "utf8")) }) }));
  // A proposal whose list names them, signed by an allowlisted requester (the hash is honest; the content is not what the planner produced).
  const honest = proposal(l);
  const fields = { ...honest, items: [...honest.items, ...forgedItems.map(({ removed: _r, ...item }) => item)] as WorkspaceRemovalProposal["items"], request: null };
  const widened = signRemovalProposal({ ...fields, proposalSha256: removalProposalSha256(fields) }, REQUESTER.privateKeyPem);
  // And a forged record for that proposal that says a removal of them is in progress.
  writeFileSync(join(l.evidence, ARTIFACT + REMOVAL_RECORD_SUFFIX), JSON.stringify({ schemaVersion: 1, kind: "WORKSPACE_REMOVAL", artifactSha256: ARTIFACT, environment: "DEV", kept: "x",
    removals: [{ proposalSha256: widened.proposalSha256, operatorId: "x", approvers: [], startedAt: NOW.toISOString(), finishedAt: null, status: "IN_PROGRESS", authorization: "x",
      decisions: { authorized: { operation: "REMOVE", contractSha256: "c".repeat(64), authorizationSha256: "a".repeat(64) }, execute: { requesterId: "carol", approverIds: [] } },
      items: forgedItems, heldForReview: [], skipped: [] }] }));
  const i = input(l, widened, [approve(widened, "alice")]);
  const ready = await prepareRemoval(i);
  assert.ok(ready.ok, JSON.stringify(ready));
  assert.equal(ready.resumed, true);
  assert.deepEqual(ready.deletes, [], "the record narrows a resumed removal to what it lists, and the fresh plan never produces any of the forged paths");
  const result = await removeWorkspace({ ...i, expected: [] });
  assert.ok(result.ok, JSON.stringify(result));
  assert.equal(readFileSync(precious, "utf8"), "keep me");
  assert.ok(existsSync(notAlz) && existsSync(other));
  // Without the forged record, the widened proposal removes only what the planner produces; the forged entries still survive.
  const l2 = layout();
  writeFileSync(join(l2.scratch, "precious.txt"), "keep me");
  mkdirSync(join(l2.scratch, "someone-else"));
  const fields2 = { ...proposal(l2), request: null };
  const items2 = [...fields2.items, { path: join(l2.scratch, "precious.txt"), kind: "PREPARATION_FILE" as const, bytes: 7, files: 1, plans: [], sha256: sha("keep me") }, { path: join(l2.scratch, "someone-else"), kind: "SCRATCH_DIRECTORY" as const, bytes: 0, files: 0, plans: [] }];
  const widened2 = signRemovalProposal({ ...fields2, items: items2, proposalSha256: removalProposalSha256({ ...fields2, items: items2 }) }, REQUESTER.privateKeyPem);
  const done = await confirmAndRemove(input(l2, widened2, [approve(widened2, "alice")]));
  assert.ok(done.ok, JSON.stringify(done));
  assert.ok(existsSync(join(l2.scratch, "precious.txt")) && existsSync(join(l2.scratch, "someone-else")) && existsSync(join(l2.env, OTHER_RUN)));
  assert.ok(!existsSync(l2.stale), "the run's own stale scratch went");
});

test("an interrupted removal resumes from its record with new approvals for the same proposal: spent approvals are refused, and only what is left (and still this run's) goes", async () => {
  const l = layout();
  const p = proposal(l);
  const first = [approve(p, "alice")];
  let calls = 0;
  const crashed = await confirmAndRemove(input(l, p, first), { removePath: (path: string) => { calls += 1; if (calls === 3) throw Object.assign(new Error("interrupted"), { code: "EINTR" }); removeTree(path); } });
  assert.equal(codeOf(crashed), "REMOVAL_FAILED");
  assert.match((crashed as { message: string }).message, /3 path\(s\) remain; the approvals are spent/);
  assert.deepEqual(recordOf(l).removals[0]!.items.map((i) => i.removed), [true, true, false, false, false]);
  assert.equal(codeOf(await prepareRemoval(input(l, p, first))), "APPROVAL_REPLAYED", "spent approvals never run it again");
  const resumed = await confirmAndRemove(input(l, p, [approve(p, "alice")]));
  assert.ok(resumed.ok, JSON.stringify(resumed));
  assert.equal(resumed.resumed, true);
  assert.deepEqual(resumed.removal.items.map((i) => [i.path.slice(l.base.length + 1), i.removed]), [["pilot/DEV/preparation-" + TAG + ".json", true], ["pilot/DEV/request-" + TAG + ".json", true], ["scratch/alz-preview-old1", true]]);
  assert.deepEqual(recordOf(l).removals.map((r) => r.status), ["STOPPED", "COMPLETE"], "the record keeps both, append-only");
  assert.deepEqual(readdirSync(l.env), [OTHER_RUN]);
});

test("N2: a planted link, a plugin-cache link under .terraform and another account's entry are skipped and reported, never followed, and never block the rest; a linked preparation folder is refused", async () => {
  const outside = fresh("outside");
  writeFileSync(join(outside, "precious.txt"), "keep me");
  const l = layout();
  symlinkSync(outside, join(l.scratch, "alz-snapshot-evil"));
  symlinkSync(join(outside, "precious.txt"), join(l.env, "manifest-" + TAG + ".json.partial-1"));
  const cached = join(l.scratch, "alz-preview-cache");
  mkdirSync(join(cached, "work", ".terraform", "providers"), { recursive: true });
  symlinkSync(outside, join(cached, "work", ".terraform", "providers", "registry.terraform.io"));
  utimesSync(cached, OLD, OLD);
  const foreign = join(l.scratch, "alz-child-foreign");
  mkdirSync(foreign);
  utimesSync(foreign, OLD, OLD);
  const asRoot = process.getuid?.() === 0;
  if (asRoot) chownSync(foreign, 4242, 4242);
  const p = proposal(l);
  assert.deepEqual(p.skipped.map((x) => x.path.slice(l.base.length + 1)).sort(), ["pilot/DEV/manifest-" + TAG + ".json.partial-1", "scratch/alz-preview-cache", "scratch/alz-snapshot-evil"]);
  const result = await confirmAndRemove(input(l, p, [approve(p, "alice")]));
  assert.ok(result.ok, JSON.stringify(result));
  assert.equal(readFileSync(join(outside, "precious.txt"), "utf8"), "keep me");
  assert.ok(existsSync(cached) && existsSync(join(l.scratch, "alz-snapshot-evil")), "skipped entries are left for a person");
  if (asRoot) assert.ok(existsSync(foreign), "another account's directory is not this command's");
  assert.ok(!existsSync(l.stale), "the rest of the run was still removed");
  assert.equal(recordOf(l).removals[0]!.skipped.length, 3);

  const linked = layout();
  removeTree(linked.env);
  symlinkSync(outside, linked.env);
  const built = buildRemovalProposal({ run: runOf(), where: linked.where, contract: CONTRACT, requesterId: REQUESTER.requesterId, now: NOW });
  assert.equal(codeOf(built), "REMOVAL_PATH_REFUSED");
  // A path swapped for a link after it was shown is refused at the moment of removal, after the approvals were consumed.
  const swap = layout();
  const ps = proposal(swap);
  const i = input(swap, ps, [approve(ps, "alice")]);
  const ready = await prepareRemoval(i);
  assert.ok(ready.ok);
  const next = ready.deletes[1]!.path;
  const swapped = await removeWorkspace({ ...i, expected: ready.deletes.map((d) => d.path) }, { removePath: (path: string) => {
    removeTree(path);
    if (existsSync(next)) { removeTree(next); symlinkSync(join(outside, "precious.txt"), next); }
  } });
  assert.equal(codeOf(swapped), "REMOVAL_PATH_CHANGED");
  assert.equal(readFileSync(join(outside, "precious.txt"), "utf8"), "keep me");
});

test("refused before anything is removed or consumed: a run in progress, the kill switch, missing, wrong-domain or insufficient approvals, the requester approving in PROD, an edited proposal, another run's proposal, a malformed record (N1) and a list that changed after it was shown; the kill switch also stops a removal between items (N4)", async () => {
  const l = layout();
  const p = proposal(l);
  const alice = [approve(p, "alice")];
  await reserveArtifact(ARTIFACT, l.evidence, NOW);
  assert.equal(codeOf(await prepareRemoval(input(l, p, alice))), "REMOVAL_RUN_IN_PROGRESS");

  const k = layout();
  const pk = proposal(k);
  writeFileSync(KILL, "stop");
  try { assert.equal(codeOf(await prepareRemoval(input(k, pk, [approve(pk, "alice")]))), "REMOVAL_NOT_AUTHORIZED"); } finally { removeTree(KILL); }
  assert.equal(codeOf(await prepareRemoval(input(k, pk, []))), "APPROVAL_INSUFFICIENT");
  assert.equal(codeOf(await prepareRemoval(input(k, pk, [approve(pk, "alice", "APPLY")]))), "APPROVAL_UNVERIFIED", "an apply-domain approval never authorizes a removal");
  const edited = { ...pk, items: pk.items.slice(1) };
  assert.equal(codeOf(await prepareRemoval(input(k, edited, [approve(pk, "alice")]))), "PROPOSAL_INVALID", "an edited list no longer matches its hash");
  const otherRun = { ...input(k, pk, [approve(pk, "alice")]), run: { ...runOf(), artifactSha256: "d".repeat(64) } };
  assert.equal(codeOf(await prepareRemoval(otherRun)), "PROPOSAL_INVALID");
  // N1: a malformed record is a typed refusal, never a TypeError.
  for (const body of ["{", JSON.stringify({ schemaVersion: 1, kind: "WORKSPACE_REMOVAL", artifactSha256: ARTIFACT, environment: "DEV", kept: "x", removals: [{ status: "IN_PROGRESS" }] }), "[]"]) {
    writeFileSync(join(k.evidence, ARTIFACT + REMOVAL_RECORD_SUFFIX), body);
    assert.equal(codeOf(await prepareRemoval(input(k, pk, [approve(pk, "alice")]))), "REMOVAL_RECORD_INVALID", body);
  }
  removeTree(join(k.evidence, ARTIFACT + REMOVAL_RECORD_SUFFIX));
  // The list changed after the person saw it: nothing is consumed, and the same approval still works once shown again.
  const once = [approve(pk, "alice")];
  assert.equal(codeOf(await removeWorkspace({ ...input(k, pk, once), expected: [] })), "REMOVAL_SCOPE_CHANGED");
  assert.ok((await confirmAndRemove(input(k, pk, once))).ok, "the approval was not consumed by the refused attempt");

  // PROD: the cleanup quorum, two distinct approvers, neither the requester.
  const prod = layout("PROD");
  const pp = proposal(prod, "PROD");
  assert.equal(pp.authorization.requiredApprovals, 2);
  assert.equal(codeOf(await prepareRemoval(input(prod, pp, [approve(pp, "alice")], "PROD"))), "APPROVAL_INSUFFICIENT");
  const byAlice = buildRemovalProposal({ run: runOf("PROD"), where: prod.where, contract: CONTRACT, requesterId: "alice", now: NOW });
  assert.ok(byAlice.ok);
  const pa = signRemovalProposal(byAlice.proposal, keys.alice.priv);
  assert.equal(codeOf(await prepareRemoval(input(prod, pa, [approve(pa, "alice"), approve(pa, "bob")], "PROD"))), "APPROVER_IS_REQUESTER", "the requester never approves a PROD removal");
  assert.ok((await prepareRemoval(input(prod, pp, [approve(pp, "alice"), approve(pp, "bob")], "PROD"))).ok);

  // N4: the kill switch read again before each item stops a removal part-way; the record says what remains.
  const s = layout();
  const ps = proposal(s);
  try {
    const stopped = await confirmAndRemove(input(s, ps, [approve(ps, "alice")]), { removePath: (path: string) => { removeTree(path); writeFileSync(KILL, "stop"); } });
    assert.equal(codeOf(stopped), "REMOVAL_STOPPED");
    assert.deepEqual([recordOf(s).removals[0]!.status, recordOf(s).removals[0]!.items.filter((i) => i.removed).length], ["STOPPED", 1]);
  } finally { removeTree(KILL); }

  // A stale scratch directory holding errored.tfstate is held for a person, never removed.
  const r = layout();
  writeFileSync(join(r.stale, "work", "errored.tfstate"), "{}");
  utimesSync(r.stale, OLD, OLD);
  const pr = proposal(r);
  assert.deepEqual(pr.heldForReview, [r.stale]);
  assert.ok((await confirmAndRemove(input(r, pr, [approve(pr, "alice")]))).ok);
  assert.ok(existsSync(join(r.stale, "work", "errored.tfstate")));
});

// --- the terminal commands -----------------------------------------------------------------------------------

type Terminal = NonNullable<ApplyCliDeps["terminal"]> & { out: string[]; asked: { prompt: string; kind?: string; phrase?: string }[] };
const terminal = (answers: string[]): Terminal => {
  const out: string[] = [];
  const asked: Terminal["asked"] = [];
  return { stdinIsTTY: true, stdoutIsTTY: true, out, asked, write: (text: string) => { out.push(text); }, ask: async (prompt, expectation) => { asked.push({ prompt, kind: expectation?.kind, phrase: expectation?.phrase }); return answers.shift() ?? ""; } };
};
const json = (value: unknown, label: string): string => { const path = join(fresh(label), label + ".json"); writeFileSync(path, JSON.stringify(value)); return path; };
const keyFile = (who: keyof typeof keys): string => { const path = join(fresh("key"), who + ".pem"); writeFileSync(path, keys[who].priv, { mode: 0o600 }); chmodSync(path, 0o600); return path; };

test("at the terminal: propose-removal, approve (APPROVE REMOVAL, cleanup domain) and remove-workspace, which shows exactly the list it removes and removes nothing without the phrase", async () => {
  const BUCKET = "examplefake-ws-logs";
  behaveIn(toolDir, KILL, { applyAdvance: true, showOnlyConfigured: true, showResources: [{ address: "aws_s3_bucket.logs", type: "aws_s3_bucket", change: { actions: ["create"], before: null, after: {} } }],
    showProviderConfig: { aws: { name: "aws", full_name: "registry.terraform.io/hashicorp/aws", expressions: { region: { references: ["var.region"] } } } }, stateResources: [stateResource("aws_s3_bucket", "logs", BUCKET, "arn:aws:s3:::" + BUCKET)] });
  behaveAwsReads(awsToolDir, { existing: [BUCKET], tagged: [] });
  const contractPath = join(fresh("contract"), "act-pilot-contract.json");
  writeReviewedContract(contractPath, awsContractJson(KILL, WITH_REMOVE));
  const vault = fresh("vault");
  await testFixtureForgeQualificationEvidence(vault, undefined, "AWS");
  const [scratch, evidenceDir, preparationDir, proposalsDir] = [fresh("scratch"), fresh("evidence"), fresh("pilot"), fresh("proposals")];
  const nonces = openNonceStore(fresh("nonces"));
  const cli = async (args: string[], answers: string[] = [], sourceCommit: string = SOURCE_COMMIT) => {
    const term = terminal(answers);
    const stdout: string[] = [];
    const stderr: string[] = [];
    const code = await runApplyCommand(args, { sourceCommit, terminal: term, env: awsIdentityEnv("DEV"), now: () => NOW, operatorId: "operator.fixture", contractPath,
      qualificationDir: vault, evidenceDir, nonces, scratchParent: scratch, toolDirs: [toolDir, awsToolDir], preparationDir, proposalsDir, stdout: (t) => { stdout.push(t); }, stderr: (t) => { stderr.push(t); } });
    let data: unknown;
    try { data = JSON.parse(stdout.join("")); } catch { data = undefined; }
    return { code, stdout: stdout.join(""), stderr: stderr.join(""), term, data };
  };
  const target = awsTargetOf("DEV");
  const project: Project = writeProject(fresh("project"), target, 'resource "aws_s3_bucket" "logs" {}\n');
  const request = json({ environment: "DEV", target, projectRoot: project.projectRoot, policyVersion: POLICY, resolved: project.resolved }, "request");
  const manifest = json(project.manifest, "manifest");
  const sealed = await cli(["seal", "--request", request, "--manifest", manifest, ...requesterArgs()], [targetString(target), "RUN PROJECT CODE"]);
  assert.equal(sealed.code, 0, sealed.stderr);
  const { sealedPlanPath, reviewBundlePath, artifactSha256 } = sealed.data as { sealedPlanPath: string; reviewBundlePath: string; artifactSha256: string };
  const approved = await cli(["approve", "--bundle", reviewBundlePath, "--key", keyFile("alice"), "--approver", "alice"], ["APPROVE DEV " + artifactSha256.slice(0, 12)]);
  assert.equal(approved.code, 0, approved.stderr);
  const applied = await cli(["apply", "--request", json({ environment: "DEV", target, projectRoot: project.projectRoot }, "apply-request"), "--manifest", manifest, "--sealed", sealedPlanPath, "--approval", json(approved.data, "approval")],
    ["APPLY DEV " + artifactSha256.slice(0, 12) + " " + targetString(target)]);
  assert.equal(applied.code, 0, applied.stderr);
  const tag = project.manifest.manifestHash.slice(0, 16);
  mkdirSync(join(preparationDir, "DEV"), { recursive: true });
  for (const name of ["request", "manifest", "preparation"]) writeFileSync(join(preparationDir, "DEV", name + "-" + tag + ".json"), "{}\n");
  const evidenceBefore = readdirSync(evidenceDir).sort();

  // B3: removal has the pilot commands' uncommitted-checkout refusal. A checkout whose contract (or anything else) is not
  // committed has no product commit, so an uncommitted edit adding REMOVE never proposes or removes (the committed-bytes
  // check behind it is test/source-commit.test.ts).
  const dirty = await cli(["propose-removal", "--sealed", sealedPlanPath, ...requesterArgs()], [], "uncommitted");
  assert.equal(dirty.code, 2, dirty.stderr);
  assert.match(dirty.stderr, /BLOCKED SOURCE_UNVERIFIED/);
  assert.deepEqual(readdirSync(proposalsDir), [], "no proposal was written");
  // A requester whose allowlist entry does not name the run's environment proposes nothing: the committed contract now allows
  // dana in QA and PROD only, so her DEV removal is refused before a proposal is built. The original contract is then restored.
  const original = readFileSync(contractPath, "utf8");
  const parsed = JSON.parse(original) as { approvers: { id: string; environments: string[] }[] };
  writeReviewedContract(contractPath, { ...parsed, approvers: parsed.approvers.map((a) => (a.id === REQUESTER.requesterId ? { ...a, environments: ["QA", "PROD"] } : a)) });
  const outside = await cli(["propose-removal", "--sealed", sealedPlanPath, ...requesterArgs()]);
  assert.equal(outside.code, 2, outside.stderr);
  assert.match(outside.stderr, /REQUESTER_NOT_ALLOWED/);
  assert.match(outside.stderr, /not allowed to request in DEV/);
  assert.deepEqual(readdirSync(proposalsDir), [], "no proposal was written for a requester outside their environments");
  writeReviewedContract(contractPath, parsed);
  const proposed = await cli(["propose-removal", "--sealed", sealedPlanPath, ...requesterArgs()]);
  assert.equal(proposed.code, 0, proposed.stderr);
  assert.deepEqual(proposed.term.asked, [], "a proposal asks no phrase: it authorizes nothing");
  const proposalPath = /Saved \(private to this account\): (\S+)/.exec(proposed.stdout)![1]!;
  const p = JSON.parse(readFileSync(proposalPath, "utf8")) as WorkspaceRemovalProposal;
  const signed = await cli(["approve", "--bundle", proposalPath, "--key", keyFile("alice"), "--approver", "alice"], ["APPROVE REMOVAL DEV " + p.proposalSha256.slice(0, 12)]);
  assert.equal(signed.code, 0, signed.stderr);
  assert.equal(signed.term.asked[0]!.kind, "APPROVE_CLEANUP");
  const approval = json(signed.data, "removal-approval");

  const phrase = "REMOVE WORKSPACE DEV " + p.proposalSha256.slice(0, 12);
  const args = ["remove-workspace", "--proposal", proposalPath, "--sealed", sealedPlanPath, "--approval", approval];
  const wrong = await cli(args, ["REMOVE WORKSPACE DEV"]);
  assert.notEqual(wrong.code, 0);
  assert.equal(readdirSync(join(preparationDir, "DEV")).length, 3, "nothing is removed without the exact phrase");
  const shown = wrong.term.out.join("");
  assert.equal((shown.match(/^ {2}removes {9}/gm) ?? []).length, 3, "the confirmed list is exactly the three paths that will go");
  assert.match(shown, /local files only; no cloud resource is touched/);
  const forced = await cli([...args, "--force", "yes"]);
  assert.match(forced.stderr, /APPLY_FLAG_UNKNOWN/, "no flag forces it");
  assert.equal(readdirSync(join(preparationDir, "DEV")).length, 3);

  const unverified = await cli(args, [phrase], "uncommitted");
  assert.equal(unverified.code, 2);
  assert.match(unverified.stderr, /BLOCKED SOURCE_UNVERIFIED/);
  assert.equal(readdirSync(join(preparationDir, "DEV")).length, 3, "nothing is removed from an uncommitted checkout");
  const done = await cli(args, [phrase]);
  assert.equal(done.code, 0, done.stderr);
  assert.deepEqual(readdirSync(join(preparationDir, "DEV")), []);
  assert.ok(existsSync(project.projectRoot) && existsSync(sealedPlanPath), "the project folder and the sealed plan are kept");
  assert.deepEqual(readdirSync(evidenceDir).sort(), [...evidenceBefore, artifactSha256 + REMOVAL_RECORD_SUFFIX].sort(), "every evidence, ledger and sealed record is kept");
  assert.equal((done.data as { status: string }).status, "COMPLETE");
  const again = await cli(args, [phrase]);
  assert.match(again.stderr, /APPROVAL_REPLAYED/, "the approval was consumed");
});

test("AUTHORIZED: a removal runs only when the reviewed contract lists REMOVE for the environment, and the kill switch still refuses", async () => {
  // authorizeRemoval is the one call site: the contract's authorize entry (requireActAuthorized) and then the kill switch.
  const withoutRemove = contractWith({});
  const devOnlyRemove = contractWith({ authorize: { DEV: ["APPLY", "CLEANUP", "REMOVE"], QA: ["APPLY", "CLEANUP"], PROD: ["APPLY", "CLEANUP"] } });
  const ask = (contract: PilotContract, environment: ApplyEnvironment = "DEV") => authorizeRemoval({ operation: "REMOVE", contract, environment, artifactSha256: ARTIFACT });
  const refused = ask(withoutRemove);
  assert.ok(!refused.authorized && /Not AUTHORIZED: .* REMOVE for AWS TERRAFORM DEV/.test(refused.reason), JSON.stringify(refused));
  assert.equal(ask(devOnlyRemove).authorized, true);
  assert.equal(ask(devOnlyRemove, "QA").authorized, false, "REMOVE in DEV is not REMOVE in QA");
  assert.equal(ask(contractWith({ authorize: {} })).authorized, false, "an empty authorization is disabled");
  const allowed = ask(CONTRACT);
  assert.ok(allowed.authorized && /^AUTHORIZED: REMOVE in DEV by contract [0-9a-f]{12}, entry [0-9a-f]{12}/.test(allowed.basis), JSON.stringify(allowed));
  writeFileSync(KILL, "stop");
  try { assert.deepEqual(ask(CONTRACT), { authorized: false, reason: "the kill switch is active" }); } finally { removeTree(KILL); }

  // End to end: the same approved proposal is refused under a contract without REMOVE and passes the gate with it, nothing removed by the refusal.
  const l = layout();
  const p = proposal(l, "DEV", NOW, withoutRemove);
  const denied = await prepareRemoval({ ...input(l, p, [approve(p, "alice")]), contract: withoutRemove });
  assert.equal(codeOf(denied), "REMOVAL_NOT_AUTHORIZED");
  assert.match(JSON.stringify(denied), /REMOVE/);
  const ok = proposal(l);
  const ready = await prepareRemoval(input(l, ok, [approve(ok, "alice")]));
  assert.equal(ready.ok, true, JSON.stringify(ready));
  // N4: the removal record carries the AUTHORIZED decision with the contract and entry hashes, and who executed it.
  const removed = await confirmAndRemove(input(l, ok, [approve(ok, "alice")]));
  assert.ok(removed.ok, JSON.stringify(removed));
  const expected = authorizeContract(CONTRACT, "DEV", "REMOVE");
  assert.ok(expected.ok);
  assert.deepEqual(removed.removal.decisions, {
    authorized: { operation: "REMOVE", contractSha256: expected.authorization.contractSha256, authorizationSha256: expected.authorization.authorizationSha256 },
    execute: { requesterId: REQUESTER.requesterId, approverIds: ["alice"] },
  });
  assert.deepEqual(JSON.parse(readFileSync(removed.recordPath, "utf8")).removals.at(-1).decisions, removed.removal.decisions, "and the record on disk says the same");
});

test("R1: a removal is held to the run's full target: a run whose target the contract no longer states exactly is refused at propose and at removal", async () => {
  const l = layout();
  const movedRun: RemovalRun = { ...runOf(), targetSha256: "e".repeat(64) };
  const built = buildRemovalProposal({ run: movedRun, where: l.where, contract: CONTRACT, requesterId: REQUESTER.requesterId, now: NOW });
  assert.equal(codeOf(built), "TARGET_NOT_IN_CONTRACT");
  const p = proposal(l);
  assert.equal(p.targetSha256, runOf().targetSha256, "the proposal binds the run's full target");
  // The same proposal judged for a run whose sealed target differs: refused, nothing removed.
  const refusedRun = await prepareRemoval({ ...input(l, p, [approve(p, "alice")]), run: movedRun });
  assert.equal(codeOf(refusedRun), "PROPOSAL_INVALID");
  // A contract committed now with the DEV region moved: the run is no longer where the contract says.
  const c = awsContractJson(KILL, WITH_REMOVE) as { targets: Record<string, Record<string, unknown>> };
  const moved = contractWith({ ...WITH_REMOVE, targets: { ...c.targets, DEV: { ...c.targets.DEV, region: "eu-west-2" } } });
  const movedProposal = buildRemovalProposal({ run: runOf(), where: l.where, contract: moved, requesterId: REQUESTER.requesterId, now: NOW });
  assert.equal(codeOf(movedProposal), "TARGET_NOT_IN_CONTRACT");
  assert.ok(existsSync(l.where.preparationDir), "nothing was removed");
});

test("#313 F1: a requester-forged removal proposal made under a moved contract, carrying the run's original targetSha256, is refused at removal by targetMoved; nothing is removed or consumed", async () => {
  const l = layout();
  // The contract committed now moves the DEV region; account, backend and workspace stay, so only the full-target hash moves.
  const c = awsContractJson(KILL, WITH_REMOVE) as { targets: Record<string, Record<string, unknown>> };
  const moved = contractWith({ ...WITH_REMOVE, targets: { ...c.targets, DEV: { ...c.targets.DEV, region: "eu-west-2" } } });
  assert.notEqual(pilotTargetSha256(moved, "DEV"), runOf().targetSha256);
  // What an insider holding the requester's key could forge without propose-removal (which refuses to build it): the proposal
  // re-stamped with the moved contract's hash, re-hashed and re-signed, still carrying the run's own targetSha256.
  const original = proposal(l);
  const { proposalSha256: _self, request: _request, ...fields } = { ...original, contractSha256: pilotContractSha256(moved) };
  const forged = signRemovalProposal({ ...fields, request: null, proposalSha256: removalProposalSha256(fields) } as WorkspaceRemovalProposal, REQUESTER.privateKeyPem);
  assert.ok(verifyRemovalProposal(forged).ok, "the forgery is a well-formed, self-consistent, requester-signed proposal");
  assert.equal(forged.targetSha256, runOf().targetSha256);
  const approvals = [approve(forged, "alice")];
  const i: RemovalInput = { ...input(l, forged, approvals), contract: moved };
  const ready = await prepareRemoval(i);
  assert.equal(codeOf(ready), "TARGET_NOT_IN_CONTRACT", JSON.stringify(ready));
  assert.match((ready as { message: string }).message, /runs only where the run ran/);
  assert.equal(codeOf(await removeWorkspace({ ...i, expected: [] })), "TARGET_NOT_IN_CONTRACT");
  assert.ok(approvals.every((a) => !l.nonces.has(a.statement.nonce)), "no approval was consumed");
  assert.equal(readdirSync(l.env).length, 5, "nothing was removed");
  assert.ok(existsSync(l.stale), "nothing was removed");
});

test("a removal requester's allowlist entry must name the environment: a PROD removal requested by DEV-only carol with her own key is refused before anything is removed or consumed", async () => {
  const l = layout("PROD");
  const built = buildRemovalProposal({ run: runOf("PROD"), where: l.where, contract: CONTRACT, requesterId: "carol", now: NOW });
  assert.ok(built.ok, JSON.stringify(built));
  const p = signRemovalProposal(built.proposal, keys.carol.priv);
  const approvals = [approve(p, "alice"), approve(p, "bob")];
  const refusal = await prepareRemoval(input(l, p, approvals, "PROD"));
  assert.equal(codeOf(refusal), "REQUESTER_NOT_ALLOWED", JSON.stringify(refusal));
  assert.match((refusal as { message: string }).message, /carol is not allowed to request in PROD/);
  assert.equal(codeOf(await removeWorkspace({ ...input(l, p, approvals, "PROD"), expected: [] })), "REQUESTER_NOT_ALLOWED");
  assert.ok(approvals.every((a) => !l.nonces.has(a.statement.nonce)), "no approval was consumed");
  assert.ok(existsSync(l.stale), "nothing was removed");
  // The same requester in DEV, an environment her entry names, is accepted.
  const d = layout();
  const dev = buildRemovalProposal({ run: runOf(), where: d.where, contract: CONTRACT, requesterId: "carol", now: NOW });
  assert.ok(dev.ok);
  const devProposal = signRemovalProposal(dev.proposal, keys.carol.priv);
  assert.equal((await prepareRemoval(input(d, devProposal, [approve(devProposal, "alice")]))).ok, true);
});

test("M24: a removal record whose decisions are missing, forged or malformed is not a removal record of this run, and nothing is removed", async () => {
  const p0 = proposal(layout());
  const good = { authorized: { operation: "REMOVE", contractSha256: "c".repeat(64), authorizationSha256: "a".repeat(64) }, execute: { requesterId: "carol", approverIds: ["alice"] } };
  for (const [label, decisions] of [
    ["missing", undefined], ["APPLY instead of REMOVE", { ...good, authorized: { ...good.authorized, operation: "APPLY" } }],
    ["a short hash", { ...good, authorized: { ...good.authorized, contractSha256: "c" } }], ["an extra field", { ...good, extra: 1 }],
    ["no execute", { authorized: good.authorized }], ["a bad requester id", { ...good, execute: { requesterId: "carol smith; rm", approverIds: [] } }],
  ] as const) {
    const l = layout();
    const p = proposal(l);
    const entry = { proposalSha256: p0.proposalSha256, operatorId: "x", approvers: [], startedAt: NOW.toISOString(), finishedAt: null, status: "COMPLETE", authorization: "x",
      ...(decisions === undefined ? {} : { decisions }), items: [], heldForReview: [], skipped: [] };
    writeFileSync(join(l.evidence, ARTIFACT + REMOVAL_RECORD_SUFFIX), JSON.stringify({ schemaVersion: 1, kind: "WORKSPACE_REMOVAL", artifactSha256: ARTIFACT, environment: "DEV", kept: "x", removals: [entry] }));
    const before = readdirSync(join(l.where.preparationDir, "DEV")).sort();
    assert.equal(codeOf(await confirmAndRemove(input(l, p, [approve(p, "alice")]))), "REMOVAL_RECORD_INVALID", label);
    assert.deepEqual(readdirSync(join(l.where.preparationDir, "DEV")).sort(), before, label + ": nothing removed");
  }
});
