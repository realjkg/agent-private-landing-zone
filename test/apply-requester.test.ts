import assert from "node:assert/strict";
import { createPrivateKey, randomBytes, sign } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { REQUESTER_MAY_APPROVE, signApproval, signRequest, verifyApprovalSet, verifyRequestSignature } from "../src/apply/approval.js";
import { canonicalPublicKey } from "../src/apply/contract.js";
import { runApply, sealPreview, type ApplyDeps, type ApplyRequest } from "../src/apply/driver.js";
import { openNonceStore } from "../src/apply/nonces.js";
import { loadSealedPlan, verifyReviewBundle, verifySealedPlan, reviewBundleOf } from "../src/apply/seal.js";
import type { ApplyEnvironment, ApplyResult, PilotContract, RequestStatement, SealedPlan, SignedApproval } from "../src/apply/types.js";
import { runApplyCommand, type ApplyCliDeps } from "../src/cli/apply.js";
import { removeTree } from "../src/teardown/driver/cleanup.js";
import { canonicalJson } from "../src/teardown/manifest.js";
import { readEncryptedEvidence } from "../src/evidence/vault.js";
import { SOURCE_COMMIT,
  DEV_TARGET, ENV, NOW, POLICY, REQUESTER, approvalFor, behave as behaveIn, callsOf, contractJson, human, identityEnv, installFakeTerraform, keys, requesterArgs, targetOf, testFixtureForgeQualificationEvidence, writeReviewedContract, writeProject, type Project,
} from "./helpers/apply-fixtures.js";

// The requester signs the sealed request (docs/act-pilot-plan.md, authority item 3; owner decisions on issue #39 of
// 2026-10-27: 6432115178, 6432129534, 6432161993). DEV and QA: one person may request and approve. PROD: three distinct
// people, the requester plus two approvers, and an approval from the requester's key or id is refused. The engine is a
// fake executable: these tests pin the driver's and the CLI's logic, not a real engine. Fixtures and generated keys only.

const root = mkdtempSync(join(tmpdir(), "alz-requester-"));
const toolDir = mkdtempSync(join(tmpdir(), "alz-requester-tools-"));
process.env.AGENTIC_EVIDENCE_KEY = randomBytes(32).toString("base64");
process.chdir(root);
test.after(() => { removeTree(root); removeTree(toolDir); });
installFakeTerraform(toolDir);

let counter = 0;
const fresh = (label: string): string => { const dir = join(root, label + "-" + ++counter); mkdirSync(dir, { recursive: true }); return dir; };
const KILL = join(root, "KILL");
const behave = () => behaveIn(toolDir, KILL, { applyAdvance: true });
const engineCalls = () => callsOf(toolDir);
const applyCalls = () => engineCalls().filter((c) => c.args[0] === "apply");

type World = { deps: ApplyDeps; contractPath: string; evidenceDir: string; vault: string; nonces: string; scratch: string };
let vaultDir = "";
test.before(async () => { vaultDir = fresh("qualification"); await testFixtureForgeQualificationEvidence(vaultDir); });
function world(contract: unknown = contractJson(KILL)): World {
  behave();
  const contractPath = join(fresh("contract"), "act-pilot-contract.json");
  writeReviewedContract(contractPath, contract);
  const evidenceDir = fresh("evidence");
  const nonces = fresh("nonces");
  const scratch = fresh("scratch");
  return {
    contractPath, evidenceDir, vault: vaultDir, nonces, scratch,
    deps: { sourceCommit: SOURCE_COMMIT, contractPath, qualificationDir: vaultDir, evidenceDir, nonces: openNonceStore(nonces), env: ENV, now: () => NOW, scratchParent: scratch, toolDirs: [toolDir], killPollMs: 40, killGraceMs: 400 },
  };
}
const forEnv = (w: World, environment: ApplyEnvironment): ApplyDeps => ({ ...w.deps, env: identityEnv(environment) });
const contractOf = (w: World): PilotContract => JSON.parse(readFileSync(w.contractPath, "utf8")) as PilotContract;

const SHARED_TF = 'resource "azurerm_resource_group" "pilot" {}\n';
type Requester = { requesterId: string; privateKeyPem: string };
async function seal(w: World, environment: ApplyEnvironment, requester: Requester | null = REQUESTER, p: Project = writeProject(fresh("project"), targetOf(environment), SHARED_TF)) {
  const target = targetOf(environment);
  const result = await sealPreview({
    invocation: human(target), environment, target, manifest: p.manifest, projectRoot: p.projectRoot, policyVersion: POLICY, resolved: p.resolved, ...(requester ? { requester } : {}),
  }, forEnv(w, environment));
  if (!result.ok) return { result, project: p } as const;
  const loaded = await loadSealedPlan(result.path);
  assert.ok(loaded.ok);
  return { result, sealed: result.sealed, project: p, loaded: { sealed: loaded.sealed, planBytes: loaded.planBytes } } as const;
}
type Sealed = Extract<Awaited<ReturnType<typeof seal>>, { sealed: SealedPlan }>;
const requestFor = (s: Sealed, approvals: SignedApproval[], over: Partial<ApplyRequest> = {}): ApplyRequest => ({
  invocation: human(s.sealed.target), environment: s.sealed.environment, target: { ...s.sealed.target }, sealedPlan: s.loaded,
  manifest: s.project.manifest, projectRoot: s.project.projectRoot, approvals, ...over,
});
const run = (w: World, s: Sealed, approvals: SignedApproval[], over: Partial<ApplyRequest> = {}): Promise<ApplyResult> => runApply(requestFor(s, approvals, over), forEnv(w, s.sealed.environment));
const refused = (result: { ok: boolean }, code: string): void => {
  assert.equal(result.ok, false, JSON.stringify(result));
  assert.equal((result as { code: string }).code, code, JSON.stringify(result));
};
/** A request signed under the APPLY approval domain instead of the REQUEST domain: a forgery that must never verify as a request. */
const underApprovalDomain = (statement: RequestStatement, privateKeyPem: string) =>
  ({ statement, signatureBase64: sign(null, Buffer.from("alz-apply-approval-v1\n" + canonicalJson(statement)), createPrivateKey(privateKeyPem)).toString("base64") });

// --- the rule ------------------------------------------------------------------------------------------------

test("the rule is a code constant: DEV and QA let the requester approve, PROD never does, and no contract field or flag changes it", () => {
  assert.deepEqual(REQUESTER_MAY_APPROVE, { DEV: true, QA: true, PROD: false });
  assert.ok(Object.isFrozen(REQUESTER_MAY_APPROVE), "the rule is frozen at runtime, not only Readonly in its type");
  assert.throws(() => { (REQUESTER_MAY_APPROVE as Record<string, boolean>).PROD = true; }, TypeError, "a strict-mode write to the frozen rule throws");
  assert.equal(Reflect.set(REQUESTER_MAY_APPROVE, "PROD", true), false, "a reflective write is refused");
  assert.equal(REQUESTER_MAY_APPROVE.PROD, false, "no mutation attempt widens PROD");
});

// --- positive flows ------------------------------------------------------------------------------------------

test("DEV and QA: one person requests and approves with the same key; the requester is bound into the artifact, verified at apply and recorded in the evidence", async () => {
  const w = world();
  const dev = await seal(w, "DEV", { requesterId: "alice", privateKeyPem: keys.alice.priv }) as Sealed;
  assert.equal(dev.sealed.requesterId, "alice");
  assert.equal(dev.sealed.schemaVersion, 2);
  assert.equal(dev.sealed.request!.statement.requesterId, "alice");
  const applied = await run(w, dev, [approvalFor(dev.sealed, "alice")]);
  assert.ok(applied.ok, JSON.stringify(applied));
  assert.deepEqual(applied.evidence.requester, { requesterId: "alice", nonce: dev.sealed.request!.statement.nonce });
  assert.deepEqual(applied.evidence.approvals.map((a) => a.approverId), ["alice"]);
  const stored = await readEncryptedEvidence<{ requester: unknown }>(join(w.evidenceDir, dev.sealed.artifactSha256 + ".apply.evidence"));
  assert.deepEqual(stored.requester, applied.evidence.requester, "the ledger records who requested");
  // QA, promoted from that DEV apply of the same release, with the same person requesting and approving.
  const qa = await seal(w, "QA", { requesterId: "alice", privateKeyPem: keys.alice.priv }) as Sealed;
  const qaApplied = await run(w, qa, [approvalFor(qa.sealed, "alice")]);
  assert.ok(qaApplied.ok, JSON.stringify(qaApplied));
  assert.equal(qaApplied.evidence.requester.requesterId, "alice");
});

test("PROD: three distinct people. The requester plus two other approvers apply; the requester's own approval, by id or by key under another id, is APPROVER_IS_REQUESTER and nothing is consumed", async () => {
  const w = world();
  // Promote the release through DEV and QA first (carol requests, alice approves: allowed there).
  for (const environment of ["DEV", "QA"] as const) {
    const s = await seal(w, environment) as Sealed;
    assert.ok((await run(w, s, [approvalFor(s.sealed, "alice")])).ok, environment);
  }
  const prod = await seal(w, "PROD", { requesterId: "alice", privateKeyPem: keys.alice.priv }) as Sealed;
  const before = applyCalls().length;
  // alice requested: alice approving with bob is refused, whatever order, and the id comparison ignores case.
  refused(await run(w, prod, [approvalFor(prod.sealed, "alice"), approvalFor(prod.sealed, "bob")]), "APPROVER_IS_REQUESTER");
  refused(await run(w, prod, [approvalFor(prod.sealed, "bob"), approvalFor(prod.sealed, "alice")]), "APPROVER_IS_REQUESTER");
  const bobOnly = await run(w, prod, [approvalFor(prod.sealed, "bob")]);
  refused(bobOnly, "APPROVAL_INSUFFICIENT");
  assert.equal(applyCalls().length, before, "nothing ran");
  assert.equal(w.deps.nonces!.has(prod.sealed.request!.statement.nonce), false, "the request nonce is never consumed by a refusal");
  // bob and carol, neither the requester: applies.
  const ok = await run(w, prod, [approvalFor(prod.sealed, "bob"), approvalFor(prod.sealed, "carol" as never)]);
  // carol is DEV-only in the fixture allowlist, so this is APPROVER_NOT_ALLOWED; the real second approver needs PROD rights.
  refused(ok, "APPROVER_NOT_ALLOWED");
  const widened = contractJson(KILL, { approvers: contractOf(w).approvers.map((a) => ({ ...a, environments: ["DEV", "QA", "PROD"] })) });
  writeReviewedContract(w.contractPath, widened);
  const prod2 = await seal(w, "PROD", { requesterId: "alice", privateKeyPem: keys.alice.priv }) as Sealed;
  const applied = await run(w, prod2, [approvalFor(prod2.sealed, "bob"), approvalFor(prod2.sealed, "carol")]);
  assert.ok(applied.ok, JSON.stringify(applied));
  assert.equal(applied.evidence.requester.requesterId, "alice");
  assert.deepEqual(applied.evidence.approvals.map((a) => a.approverId).sort(), ["bob", "carol"]);
});

test("verifyApprovalSet refuses the requester's key under any id in PROD, and accepts it in DEV and QA", () => {
  const w = world();
  const contract = contractJson(KILL, { approvers: [
    { id: "alice", publicKeyPem: keys.alice.pub, environments: ["DEV", "QA", "PROD"] },
    { id: "alice-again", publicKeyPem: keys.mallory.pub, environments: ["DEV", "QA", "PROD"] },
    { id: "bob", publicKeyPem: keys.bob.pub, environments: ["DEV", "QA", "PROD"] },
  ] }) as PilotContract;
  const nonces = openNonceStore(w.nonces);
  const artifactSha256 = "a".repeat(64);
  const statement = (approverId: string, environment: ApplyEnvironment) => ({
    schemaVersion: 1 as const, artifactSha256, environment, target: targetOf(environment), approverId,
    issuedAt: new Date(NOW.getTime() - 60_000).toISOString(), expiresAt: new Date(NOW.getTime() + 20 * 60_000).toISOString(), nonce: randomBytes(16).toString("hex"),
  });
  const requester = { requesterId: "alice", publicKeyCanonical: canonicalPublicKey(keys.alice.pub) };
  const verdict = (environment: ApplyEnvironment, approvals: SignedApproval[]) => verifyApprovalSet({ approvals, artifactSha256, environment, target: targetOf(environment), contract, now: NOW, nonces, requester });
  // PROD: the requester's id (any case) and the requester's key are refused; two others pass.
  assert.equal((verdict("PROD", [signApproval(statement("alice", "PROD"), keys.alice.priv), signApproval(statement("bob", "PROD"), keys.bob.priv)]) as { code: string }).code, "APPROVER_IS_REQUESTER");
  assert.equal((verdict("PROD", [signApproval(statement("bob", "PROD"), keys.bob.priv), signApproval(statement("alice-again", "PROD"), keys.mallory.priv)])).ok, true, "another key under a similar id is another person");
  const sameKeyOtherId = { ...contract, approvers: contract.approvers.map((a) => (a.id === "alice-again" ? { ...a, publicKeyPem: keys.alice.pub } : a)) } as PilotContract;
  const byKey = verifyApprovalSet({ approvals: [signApproval(statement("bob", "PROD"), keys.bob.priv), signApproval(statement("alice-again", "PROD"), keys.alice.priv)], artifactSha256, environment: "PROD", target: targetOf("PROD"), contract: sameKeyOtherId, now: NOW, nonces, requester });
  assert.equal((byKey as { code: string }).code, "APPROVER_IS_REQUESTER", "the requester's key under another id is the requester");
  // DEV and QA: the requester approves.
  for (const environment of ["DEV", "QA"] as const) assert.equal(verdict(environment, [signApproval(statement("alice", environment), keys.alice.priv)]).ok, true, environment);
  // A set with no verified requester is refused in every environment: every apply and every cleanup has one, so no caller can skip
  // the rule by leaving it out (owner decision 6440801434, item 1; this closes #286 N5, which pinned the opposite for cleanup).
  for (const environment of ["DEV", "QA", "PROD"] as const) {
    const noRequester = verifyApprovalSet({ approvals: [signApproval(statement("bob", environment), keys.bob.priv), signApproval(statement("alice-again", environment), keys.mallory.priv)], artifactSha256, environment, target: targetOf(environment), contract, now: NOW, nonces } as never);
    assert.equal((noRequester as { code: string }).code, "REQUESTER_SIGNATURE_MISSING", environment);
  }
});

// --- forged, reused and missing requester signatures ----------------------------------------------------------

test("a seal needs an allowlisted requester with that entry's own key, checked before any engine runs", async () => {
  const w = world();
  const before = engineCalls().length;
  refused((await seal(w, "DEV", null)).result, "REQUESTER_SIGNATURE_MISSING");
  refused((await seal(w, "DEV", { requesterId: "mallory", privateKeyPem: keys.mallory.priv })).result, "REQUESTER_NOT_ALLOWED");
  refused((await seal(w, "DEV", { requesterId: "carol", privateKeyPem: keys.alice.priv })).result, "REQUESTER_KEY_MISMATCH");
  refused((await seal(w, "DEV", { requesterId: "carol", privateKeyPem: "not a key" })).result, "REQUESTER_KEY_MISMATCH");
  assert.equal(engineCalls().length, before, "no engine ran for a refused requester");
  // Any allowlisted key may request for any environment: carol is DEV-only as an approver and still requests PROD.
  const prod = await seal(w, "PROD");
  assert.ok(prod.result.ok, JSON.stringify(prod.result));
});

test("a forged requester signature is refused at apply: a non-allowlisted key, an approval-domain signature, or a statement edited after sealing; nothing is consumed", async () => {
  const w = world();
  const s = await seal(w, "DEV") as Sealed;
  const approvals = () => [approvalFor(s.sealed, "alice")];
  const withRequest = (request: SealedPlan["request"]) => ({ sealedPlan: { sealed: { ...s.loaded.sealed, request }, planBytes: s.loaded.planBytes } });
  const statement = s.sealed.request!.statement;
  // Mallory signs carol's statement: the signature does not verify against carol's allowlisted key.
  refused(await run(w, s, approvals(), withRequest(signRequest(statement, keys.mallory.priv))), "REQUESTER_SIGNATURE_UNVERIFIED");
  // Carol's key, but under the APPLY approval domain: never a request.
  refused(await run(w, s, approvals(), withRequest(underApprovalDomain(statement, keys.carol.priv))), "REQUESTER_SIGNATURE_UNVERIFIED");
  // A statement edited after signing (another nonce) breaks the signature.
  refused(await run(w, s, approvals(), withRequest({ ...s.sealed.request!, statement: { ...statement, nonce: "f".repeat(32) } })), "REQUESTER_SIGNATURE_UNVERIFIED");
  // The requester signature directly: a statement bound to another artifact or environment is REQUESTER_MISBOUND; a stranger's id is REQUESTER_NOT_ALLOWED.
  const contract = contractOf(w);
  assert.equal((verifyRequestSignature({ request: s.sealed.request, artifactSha256: "b".repeat(64), environment: "DEV", requesterId: "carol", contract }) as { code: string }).code, "REQUESTER_MISBOUND");
  assert.equal((verifyRequestSignature({ request: s.sealed.request, artifactSha256: s.sealed.artifactSha256, environment: "QA", requesterId: "carol", contract }) as { code: string }).code, "REQUESTER_MISBOUND");
  assert.equal((verifyRequestSignature({ request: signRequest({ ...statement, requesterId: "mallory" }, keys.mallory.priv), artifactSha256: s.sealed.artifactSha256, environment: "DEV", requesterId: "mallory", contract }) as { code: string }).code, "REQUESTER_NOT_ALLOWED");
  assert.equal((verifyRequestSignature({ request: null, artifactSha256: s.sealed.artifactSha256, environment: "DEV", requesterId: "carol", contract }) as { code: string }).code, "REQUESTER_SIGNATURE_MISSING");
  assert.equal(applyCalls().length, 0);
  assert.equal(w.deps.nonces!.has(approvals()[0].statement.nonce), false, "no approval was consumed");
  // The untouched plan still applies: the refusals consumed nothing.
  assert.ok((await run(w, s, approvals())).ok);
});

test("a requester signature cannot be moved between artifacts: a sealed plan or review bundle carrying another plan's request is ARTIFACT_TAMPERED", async () => {
  const w = world();
  const a = await seal(w, "DEV") as Sealed;
  const b = await seal(w, "DEV", REQUESTER, writeProject(fresh("project"), targetOf("DEV"), 'resource "azurerm_resource_group" "other" {}\n')) as Sealed;
  assert.notEqual(a.sealed.artifactSha256, b.sealed.artifactSha256);
  const moved = verifySealedPlan({ sealed: { ...b.loaded.sealed, request: a.sealed.request }, planBytes: b.loaded.planBytes });
  refused(moved, "ARTIFACT_TAMPERED");
  refused(await run(w, b, [approvalFor(b.sealed, "alice")], { sealedPlan: { sealed: { ...b.loaded.sealed, request: a.sealed.request }, planBytes: b.loaded.planBytes } }), "ARTIFACT_TAMPERED");
  refused(verifyReviewBundle({ ...reviewBundleOf(b.sealed), request: a.sealed.request }), "ARTIFACT_TAMPERED");
  // Swapping the requester id changes the artifact hash every approver signed.
  refused(verifySealedPlan({ sealed: { ...b.loaded.sealed, requesterId: "alice" }, planBytes: b.loaded.planBytes }), "ARTIFACT_TAMPERED");
  assert.equal(applyCalls().length, 0);
});

test("a plan without a requester signature is refused everywhere, PROD included, and a plan sealed before requester signatures (schema 1) is ARTIFACT_INVALID", async () => {
  const w = world();
  const s = await seal(w, "DEV") as Sealed;
  const stripped = { sealed: { ...s.loaded.sealed, request: null }, planBytes: s.loaded.planBytes };
  refused(verifySealedPlan(stripped), "ARTIFACT_INVALID");
  refused(await run(w, s, [approvalFor(s.sealed, "alice")], { sealedPlan: stripped }), "ARTIFACT_INVALID");
  const { request: _request, requesterId: _requesterId, ...legacy } = s.loaded.sealed;
  const schemaOne = verifySealedPlan({ sealed: { ...legacy, schemaVersion: 1 }, planBytes: s.loaded.planBytes });
  refused(schemaOne, "ARTIFACT_INVALID");
  assert.match((schemaOne as { message: string }).message, /before requester signatures existed/);
  // The review bundle an approver reads must carry the request too.
  const { request: _r2, ...bundleWithout } = reviewBundleOf(s.sealed);
  refused(verifyReviewBundle(bundleWithout), "ARTIFACT_INVALID");
  // PROD: the same plan relabeled cannot be made PROD without a new seal and signature (the hash and the statement both bind the environment).
  refused(verifySealedPlan({ sealed: { ...s.loaded.sealed, environment: "PROD" }, planBytes: s.loaded.planBytes }), "ARTIFACT_TAMPERED");
  assert.equal(applyCalls().length, 0);
});

// --- the commands -------------------------------------------------------------------------------------------

type Terminal = NonNullable<ApplyCliDeps["terminal"]> & { out: string[]; asked: string[] };
const terminal = (answers: string[]): Terminal => {
  const out: string[] = [];
  const asked: string[] = [];
  return { stdinIsTTY: true, stdoutIsTTY: true, out, asked, write: (t) => { out.push(t); }, ask: async (q) => { asked.push(q); return answers.shift() ?? ""; } };
};
async function cli(w: World, args: string[], answers: string[], environment: ApplyEnvironment = "DEV") {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const term = terminal(answers);
  const code = await runApplyCommand(args, {
    sourceCommit: SOURCE_COMMIT, terminal: term, env: identityEnv(environment), now: () => NOW, operatorId: "operator.fixture", contractPath: w.contractPath,
    qualificationDir: w.vault, evidenceDir: w.evidenceDir, nonces: w.deps.nonces, scratchParent: w.scratch, toolDirs: [toolDir], stdout: (t) => { stdout.push(t); }, stderr: (t) => { stderr.push(t); },
  });
  return { code, stdout: stdout.join(""), stderr: stderr.join(""), term };
}
const json = (value: unknown, label = "file"): string => { const path = join(fresh(label), label + ".json"); writeFileSync(path, JSON.stringify(value)); return path; };
const keyFile = (who: keyof typeof keys): string => { const path = join(fresh("key"), who + ".pem"); writeFileSync(path, keys[who].priv, { mode: 0o600 }); chmodSync(path, 0o600); return path; };

test("./alz apply seal takes --requester and --key, shows the requester before the phrases, refuses a stranger or a wrong key before any engine runs, and the bundle names the requester", async () => {
  const w = world();
  const target = DEV_TARGET;
  const p = writeProject(fresh("project"), target, SHARED_TF);
  const request = json({ environment: "DEV", target, projectRoot: p.projectRoot, policyVersion: POLICY, resolved: p.resolved }, "request");
  const manifest = json(p.manifest, "manifest");
  const base = ["seal", "--request", request, "--manifest", manifest];
  // Both flags are required and no other key source exists.
  assert.equal((await cli(w, base, [])).code, 1);
  assert.equal((await cli(w, [...base, "--requester", "carol"], [])).code, 1);
  const before = engineCalls().length;
  const stranger = await cli(w, [...base, "--requester", "mallory", "--key", keyFile("mallory")], [`${target.account} | ${target.backend} | ${target.workspace}`, "RUN PROJECT CODE"]);
  assert.equal(stranger.code, 2);
  assert.match(stranger.stderr, /REQUESTER_NOT_ALLOWED/);
  const wrongKey = await cli(w, [...base, "--requester", "carol", "--key", keyFile("alice")], [`${target.account} | ${target.backend} | ${target.workspace}`, "RUN PROJECT CODE"]);
  assert.equal(wrongKey.code, 2);
  assert.match(wrongKey.stderr, /REQUESTER_KEY_MISMATCH/);
  assert.equal(engineCalls().length, before, "no engine ran");
  const ok = await cli(w, [...base, ...requesterArgs()], [`${target.account} | ${target.backend} | ${target.workspace}`, "RUN PROJECT CODE"]);
  assert.equal(ok.code, 0, ok.stderr);
  assert.match(ok.term.out.join(""), /requester {7}carol/);
  const result = JSON.parse(ok.stdout) as { requesterId: string; reviewBundlePath: string };
  assert.equal(result.requesterId, "carol");
  const bundle = JSON.parse(readFileSync(result.reviewBundlePath, "utf8")) as { requesterId: string; request: { statement: { requesterId: string } } };
  assert.equal(bundle.requesterId, "carol");
  assert.equal(bundle.request.statement.requesterId, "carol");
});

test("./alz apply approve shows who requested, and for a PROD bundle refuses the requester (by id or key) before asking for the phrase; DEV lets the requester approve", async () => {
  const w = world();
  const prod = await seal(w, "PROD", { requesterId: "alice", privateKeyPem: keys.alice.priv }) as Sealed;
  const bundlePath = json(reviewBundleOf(prod.sealed), "bundle");
  const phrase = "APPROVE PROD " + prod.sealed.artifactSha256.slice(0, 12);
  const self = await cli(w, ["approve", "--bundle", bundlePath, "--key", keyFile("alice"), "--approver", "alice"], [phrase], "PROD");
  assert.equal(self.code, 2);
  assert.match(self.stderr, /APPROVER_IS_REQUESTER/);
  assert.deepEqual(self.term.asked, [], "refused before the phrase was asked");
  const byCase = await cli(w, ["approve", "--bundle", bundlePath, "--key", keyFile("alice"), "--approver", "ALICE"], [phrase], "PROD");
  assert.equal(byCase.code, 2);
  const other = await cli(w, ["approve", "--bundle", bundlePath, "--key", keyFile("bob"), "--approver", "bob"], [phrase], "PROD");
  assert.equal(other.code, 0, other.stderr);
  assert.match(other.term.out.join(""), /requested by {4}alice \(signature verified against the allowlist\)/);
  // A bundle whose request was forged is refused before anything is shown or signed.
  const forged = json({ ...reviewBundleOf(prod.sealed), request: signRequest(prod.sealed.request!.statement, keys.mallory.priv) }, "forged");
  const bad = await cli(w, ["approve", "--bundle", forged, "--key", keyFile("bob"), "--approver", "bob"], [phrase], "PROD");
  assert.equal(bad.code, 2);
  assert.match(bad.stderr, /REQUESTER_SIGNATURE_UNVERIFIED/);
  assert.deepEqual(bad.term.asked, []);
  // DEV: the requester approves their own change.
  const dev = await seal(w, "DEV", { requesterId: "alice", privateKeyPem: keys.alice.priv }) as Sealed;
  const devSelf = await cli(w, ["approve", "--bundle", json(reviewBundleOf(dev.sealed), "dev-bundle"), "--key", keyFile("alice"), "--approver", "alice"], ["APPROVE DEV " + dev.sealed.artifactSha256.slice(0, 12)]);
  assert.equal(devSelf.code, 0, devSelf.stderr);
});
