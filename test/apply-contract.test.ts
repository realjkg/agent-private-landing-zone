import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  canonicalPublicKey,
  isKillSwitchActive,
  loadPilotContract,
  loadQualificationRecords,
  pilotContractSha256,
  repoPaths,
  requireNotApplied,
  requirePromotionEvidence,
  targetForEnvironment,
  verifyApplyQualification,
  writeQualificationEvidence,
} from "../src/apply/contract.js";
import { APPLY_AUTHORITY, applyEvidenceProblems, assertApplyEvidence, qualificationEvidenceProblems, type QualificationEvidence } from "../src/apply/evidence.js";
import type { ApplyEvidence, PilotContract } from "../src/apply/types.js";
import { canonicalJson } from "../src/teardown/manifest.js";
import { recordApplied } from "./helpers/apply-fixtures.js";
import { AZURE } from "../src/apply/providers/azure.js";

// Explicit fixtures only: no real tenant, subscription or backend values.
const scratch = mkdtempSync(join(tmpdir(), "apply-contract-"));
process.env.AGENTIC_EVIDENCE_KEY = randomBytes(32).toString("base64");
test.after(() => { rmSync(scratch, { recursive: true, force: true }); delete process.env.AGENTIC_EVIDENCE_KEY; });

const KILL = join(scratch, "kill");
const approverKey = () => generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" }).toString();
const KEYS = { alice: approverKey(), bob: approverKey() };
const fixtureContract = (): PilotContract => ({
  schemaVersion: 1,
  enabled: true,
  provider: "AZURE",
  engine: "TERRAFORM",
  targets: {
    DEV: { tenantId: "11111111-1111-4111-8111-111111111111", subscriptionId: "22222222-2222-4222-8222-222222222222", backend: "fixturedevstore/tfstate/dev.tfstate", workspace: "default" },
    QA: { tenantId: "11111111-1111-4111-8111-111111111111", subscriptionId: "44444444-4444-4444-8444-444444444444", backend: "fixtureqastore/tfstate/qa.tfstate", workspace: "default" },
    PROD: { tenantId: "11111111-1111-4111-8111-111111111111", subscriptionId: "33333333-3333-4333-8333-333333333333", backend: "fixtureprodstore/tfstate/prod.tfstate", workspace: "default" },
  },
  requiredApprovals: { DEV: 1, QA: 1, PROD: 2 },
  maxApprovalAgeMinutes: 60,
  approvers: [
    { id: "alice", publicKeyPem: KEYS.alice, environments: ["DEV", "QA", "PROD"] },
    { id: "bob", publicKeyPem: KEYS.bob, environments: ["DEV", "QA", "PROD"] },
  ],
  killSwitchPath: KILL,
});

// Every written contract gets a committed-style pin beside it (<path>.sha256), computed from the raw JSON, so
// a test reaches validation; the pin tests below write their own.
let counter = 0;
const pinOf = (path: string): string => path + ".sha256";
const write = (value: unknown): string => {
  const path = join(scratch, "contract-" + counter++ + ".json");
  writeFileSync(path, typeof value === "string" ? value : JSON.stringify(value));
  try { writeFileSync(pinOf(path), createHash("sha256").update(canonicalJson(JSON.parse(readFileSync(path, "utf8")))).digest("hex") + "\n"); } catch { /* not JSON: no pin */ }
  return path;
};
const load = (path: string) => loadPilotContract(path, pinOf(path));
const mutate = (edit: (c: any) => void): string => { const c = fixtureContract() as any; edit(c); return write(c); };
const disabled = (path: string, pattern?: RegExp, code?: "ACT_DISABLED" | "CONTRACT_INVALID") => {
  const loaded = load(path);
  assert.equal(loaded.enabled, false);
  assert.ok("reason" in loaded && loaded.reason.length > 0);
  if (pattern) assert.match((loaded as { reason: string }).reason, pattern);
  if (code) assert.equal((loaded as { code: string }).code, code);
};

test("a valid contract loads and is returned as validated", () => {
  const loaded = load(write(fixtureContract()));
  assert.equal(loaded.enabled, true);
  assert.deepEqual(loaded, fixtureContract());
});

test("contract fails closed: missing, unparseable, not an object, disabled, unknown fields", () => {
  disabled(join(scratch, "does-not-exist.json"), /missing|unreadable/i, "ACT_DISABLED");
  disabled(write("{ not json"), /parse/i, "CONTRACT_INVALID");
  disabled(write("[]"), /object/i, "CONTRACT_INVALID");
  disabled(write("null"), /object/i, "CONTRACT_INVALID");
  disabled(mutate((c) => { c.enabled = false; }), /enabled/i, "ACT_DISABLED");
  for (const value of ["true", 1, "yes", null]) disabled(mutate((c) => { c.enabled = value; }), /enabled/i, "CONTRACT_INVALID");
  disabled(mutate((c) => { delete c.enabled; }), undefined, "CONTRACT_INVALID");
  disabled(mutate((c) => { c.extra = 1; }), /extra/);
  disabled(mutate((c) => { c.targets.DEV.extra = 1; }), /extra/);
  disabled(mutate((c) => { c.requiredApprovals.STAGING = 1; }), /STAGING/);
  disabled(mutate((c) => { delete c.requiredApprovals.QA; }), /QA/);
  disabled(mutate((c) => { delete c.targets.QA; }), /QA/);
  disabled(mutate((c) => { c.targets.STAGING = c.targets.DEV; }), /STAGING/);
  disabled(mutate((c) => { delete c.targets.PROD; }));
  disabled(mutate((c) => { delete c.approvers; }), /approvers/);
  disabled(mutate((c) => { c.schemaVersion = 2; }));
  disabled(mutate((c) => { c.provider = "AWS"; }));
  disabled(mutate((c) => { c.engine = "PULUMI"; }));
});

test("a flag in the environment alone never enables ACT", () => {
  process.env.ALZ_ACT = "true";
  process.env.ACT_ENABLED = "true";
  try { disabled(join(scratch, "still-missing.json")); } finally { delete process.env.ALZ_ACT; delete process.env.ACT_ENABLED; }
});

test("contract refuses invalid identifiers, approval counts and ages", () => {
  disabled(mutate((c) => { c.targets.DEV.tenantId = "REPLACE-WITH-TENANT-GUID"; }), /tenantId/);
  disabled(mutate((c) => { c.targets.DEV.subscriptionId = "not-a-guid"; }), /subscriptionId/);
  disabled(mutate((c) => { c.targets.PROD.subscriptionId = 42; }), /subscriptionId/);
  disabled(mutate((c) => { c.targets.DEV.backend = "only/two"; }), /backend/);
  disabled(mutate((c) => { c.targets.DEV.backend = "fixturedevstore/tfstate/../escape"; }), /backend/);
  disabled(mutate((c) => { c.targets.DEV.backend = "Bad_Account/tfstate/dev.tfstate"; }), /backend/);
  disabled(mutate((c) => { c.targets.DEV.workspace = "has space"; }), /workspace/);
  disabled(mutate((c) => { c.targets.DEV.workspace = ""; }), /workspace/);
  disabled(mutate((c) => { c.requiredApprovals.PROD = 1; }), /PROD/);
  disabled(mutate((c) => { c.requiredApprovals.PROD = 0; }), /PROD/);
  disabled(mutate((c) => { c.requiredApprovals.PROD = 2.5; }), /PROD/);
  disabled(mutate((c) => { c.requiredApprovals.DEV = 0; }), /DEV/);
  disabled(mutate((c) => { c.requiredApprovals.QA = 0; }), /QA/);
  disabled(mutate((c) => { c.requiredApprovals.QA = -1; }), /QA/);
  disabled(mutate((c) => { c.requiredApprovals.QA = 1.5; }), /QA/);
  disabled(mutate((c) => { c.targets.QA.subscriptionId = "not-a-guid"; }), /QA.*subscriptionId/);
  disabled(mutate((c) => { c.maxApprovalAgeMinutes = 0; }), /maxApprovalAgeMinutes/);
  disabled(mutate((c) => { c.maxApprovalAgeMinutes = -5; }), /maxApprovalAgeMinutes/);
  disabled(mutate((c) => { c.maxApprovalAgeMinutes = 99999; }), /maxApprovalAgeMinutes/);
  disabled(mutate((c) => { c.killSwitchPath = ""; }), /killSwitchPath/);
  disabled(mutate((c) => { c.killSwitchPath = 7; }), /killSwitchPath/);
});

test("DEV, QA and PROD must pairwise differ in subscription and backend", () => {
  const pairs = [["DEV", "QA"], ["QA", "PROD"], ["DEV", "PROD"]] as const;
  for (const [a, b] of pairs) {
    disabled(mutate((c) => { c.targets[b].subscriptionId = c.targets[a].subscriptionId; }), new RegExp(a + " and " + b + " share a subscription"));
    disabled(mutate((c) => { c.targets[b].subscriptionId = c.targets[a].subscriptionId.toUpperCase(); }), /subscription/i);
    disabled(mutate((c) => { c.targets[b].backend = c.targets[a].backend; }), new RegExp(a + " and " + b + " share a backend"));
    disabled(mutate((c) => { c.targets[b].backend = c.targets[a].backend.toUpperCase().replace(/^FIXTURE/, "fixture"); }), /backend/i);
  }
});

test("dev and prod must not share a subscription or a backend", () => {
  disabled(mutate((c) => { c.targets.PROD.subscriptionId = c.targets.DEV.subscriptionId; }), /subscription/i);
  disabled(mutate((c) => { c.targets.PROD.subscriptionId = c.targets.DEV.subscriptionId.toUpperCase(); }), /subscription/i);
  disabled(mutate((c) => { c.targets.PROD.backend = c.targets.DEV.backend; }), /backend/i);
  disabled(mutate((c) => { c.targets.PROD.backend = "fixtureprodstore/tfstate/prod.tfstate"; c.targets.DEV.backend = "fixtureprodstore/tfstate/prod.tfstate"; }), /backend/i);
});

test("the shipped example is clearly marked, disabled, and cannot become valid by flipping the flag", () => {
  const path = join(process.cwd(), "config", "act-pilot-contract.example.json");
  const text = readFileSync(path, "utf8");
  const parsed = JSON.parse(text) as Record<string, unknown>;
  assert.equal(parsed.enabled, false);
  assert.match(text, /EXAMPLE/);
  disabled(path, undefined, "ACT_DISABLED");
  disabled(write({ ...parsed, enabled: true }), /EXAMPLE/);
  const { EXAMPLE: _marker, ...unmarked } = parsed;
  disabled(write({ ...unmarked, enabled: true }), /tenantId|subscriptionId|backend|approvers/);
});

// --- the approver allowlist lives in the reviewed contract ---------------------------------------------------

test("approvers: a malformed, empty, duplicated or non-Ed25519 allowlist disables the contract", () => {
  const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 }).publicKey.export({ type: "spki", format: "pem" }).toString();
  const one = (c: any) => c.approvers[0];
  disabled(mutate((c) => { c.approvers = []; }), /approvers/, "CONTRACT_INVALID");
  disabled(mutate((c) => { c.approvers = "alice"; }), /approvers/);
  disabled(mutate((c) => { one(c).extra = 1; }), /extra/);
  disabled(mutate((c) => { one(c).id = ""; }), /id/);
  disabled(mutate((c) => { one(c).id = "has space"; }), /id/);
  disabled(mutate((c) => { one(c).environments = []; }), /environments/);
  disabled(mutate((c) => { one(c).environments = ["STAGING"]; }), /environments/);
  disabled(mutate((c) => { one(c).environments = ["QA", "QA"]; }), /environments/);
  assert.equal(load(mutate((c) => { one(c).environments = ["QA"]; })).enabled, true, "QA is a valid approver environment");
  disabled(mutate((c) => { one(c).environments = ["DEV", "DEV"]; }), /environments/);
  disabled(mutate((c) => { one(c).publicKeyPem = "garbage"; }), /publicKeyPem/);
  disabled(mutate((c) => { one(c).publicKeyPem = rsa; }), /publicKeyPem/);
  disabled(mutate((c) => { c.approvers[1].id = "alice"; }), /duplicate/i);
  disabled(mutate((c) => { c.approvers[1].id = "ALICE"; }), /duplicate/i);
});

test("approvers: the same public key under two ids is refused whatever its PEM text", () => {
  const reformatted = KEYS.alice.replaceAll("\n", "\r\n") + "\n";
  assert.notEqual(reformatted, KEYS.alice);
  assert.equal(canonicalPublicKey(reformatted), canonicalPublicKey(KEYS.alice));
  assert.notEqual(canonicalPublicKey(KEYS.alice), canonicalPublicKey(KEYS.bob));
  disabled(mutate((c) => { c.approvers[1].publicKeyPem = KEYS.alice; }), /duplicate/i);
  disabled(mutate((c) => { c.approvers[1].publicKeyPem = reformatted; }), /duplicate/i);
});

// --- the contract is pinned to the committed hash ------------------------------------------------------------

test("pin: the contract loads only when its sha256 equals the pin file", () => {
  const path = write(fixtureContract());
  const sha = pilotContractSha256(fixtureContract());
  assert.equal(load(path).enabled, true);
  // The hash is of the canonical contract, so key order and whitespace do not matter.
  writeFileSync(path, JSON.stringify(fixtureContract(), null, 4));
  assert.equal(load(path).enabled, true);
  for (const pin of [sha.replace(/.$/, (d) => (d === "0" ? "1" : "0")), "f".repeat(64), "not a hash", sha + "00", "0x" + sha]) {
    writeFileSync(pinOf(path), pin + "\n");
    disabled(path, /pin/i, "CONTRACT_INVALID");
  }
  writeFileSync(pinOf(path), sha.toUpperCase() + "\n");
  assert.equal(load(path).enabled, true, "hex case does not matter");
});

test("pin: an absent or empty pin file means disabled, even for an enabled valid contract", () => {
  const path = write(fixtureContract());
  rmSync(pinOf(path));
  disabled(path, /pin/i, "ACT_DISABLED");
  writeFileSync(pinOf(path), "");
  disabled(path, /pin/i, "ACT_DISABLED");
  writeFileSync(pinOf(path), "\n  \n");
  disabled(path, /pin/i, "ACT_DISABLED");
  writeFileSync(pinOf(path), pilotContractSha256(fixtureContract()));
  assert.equal(load(path).enabled, true);
});

test("pin: any edit to the contract after it was pinned disables it", () => {
  const path = write(fixtureContract());
  const sha = pilotContractSha256(fixtureContract());
  const edits: ((c: any) => void)[] = [
    (c) => { c.maxApprovalAgeMinutes = 61; },
    (c) => { c.approvers.push({ id: "mallory", publicKeyPem: approverKey(), environments: ["DEV"] }); },
    (c) => { c.approvers[0].environments = ["DEV"]; },
    (c) => { c.targets.DEV.tenantId = "99999999-9999-4999-8999-999999999999"; },
    (c) => { c.killSwitchPath = join(scratch, "elsewhere"); },
  ];
  for (const edit of edits) {
    const c = fixtureContract() as any; edit(c);
    writeFileSync(path, JSON.stringify(c));
    writeFileSync(pinOf(path), sha);
    disabled(path, /pin/i, "CONTRACT_INVALID");
  }
});

test("the committed pin file is empty or absent, so the repository ships with ACT disabled", () => {
  const pin = repoPaths().pin;
  assert.equal(existsSync(pin) ? readFileSync(pin, "utf8").trim() : "", "");
  const loaded = loadPilotContract();
  assert.equal(loaded.enabled, false);
  assert.equal((loaded as { code: string }).code, "ACT_DISABLED");
});

// --- every path is anchored to the repository, never the working directory ------------------------------------

test("repoPaths and the defaults resolve from the module location, not process.cwd()", () => {
  const here = repoPaths();
  const root = resolve(import.meta.dirname, "..");
  assert.equal(here.root, root);
  assert.deepEqual(here, {
    root, contract: join(root, "config/act-pilot-contract.json"), pin: join(root, "config/act-pilot-contract.sha256"),
    evidence: join(root, ".runs/apply/evidence"), qualifications: join(root, ".runs/apply/qualification"), nonces: join(root, ".runs/apply"),
  });
  const cwd = process.cwd();
  // A hostile working directory with its own contract, pin and kill switch changes nothing.
  const hostile = mkdtempSync(join(scratch, "cwd-"));
  mkdirSync(join(hostile, "config"), { recursive: true });
  const contract = fixtureContract();
  writeFileSync(join(hostile, "config/act-pilot-contract.json"), JSON.stringify(contract));
  writeFileSync(join(hostile, "config/act-pilot-contract.sha256"), pilotContractSha256(contract));
  mkdirSync(join(hostile, ".runs/apply"), { recursive: true });
  writeFileSync(join(hostile, ".runs/apply/KILL-anchor-test"), "");
  process.chdir(hostile);
  try {
    assert.deepEqual(repoPaths(), here);
    const loaded = loadPilotContract();
    assert.equal(loaded.enabled, false, "the contract in the working directory is not read");
    assert.equal(isKillSwitchActive({ killSwitchPath: ".runs/apply/KILL-anchor-test" }), false, "a relative kill switch path is under the repository root");
    assert.equal(isKillSwitchActive({ killSwitchPath: join(hostile, ".runs/apply/KILL-anchor-test") }), true, "an absolute one is used as given");
  } finally { process.chdir(cwd); }
});

test("kill switch: active when the file exists, inactive otherwise, active when it cannot be determined", () => {
  const contract = fixtureContract();
  rmSync(KILL, { force: true });
  assert.equal(isKillSwitchActive(contract), false);
  writeFileSync(KILL, "");
  assert.equal(isKillSwitchActive(contract), true);
  rmSync(KILL, { force: true });
  // A path under a regular file cannot be inspected (ENOTDIR): fail closed.
  const blocker = join(scratch, "blocker");
  writeFileSync(blocker, "x");
  assert.equal(isKillSwitchActive({ ...contract, killSwitchPath: join(blocker, "kill") }), true);
});

test("targetForEnvironment returns the contract target only on an exact match", () => {
  const contract = fixtureContract();
  for (const env of ["DEV", "QA", "PROD"] as const) {
    const t = contract.targets[env];
    const requested = { account: t.subscriptionId, backend: t.backend, workspace: t.workspace };
    const result = targetForEnvironment(contract, env, requested);
    assert.deepEqual(result, { ok: true, target: t });
  }
  const dev = contract.targets.DEV;
  const base = { account: dev.subscriptionId, backend: dev.backend, workspace: dev.workspace };
  const refused = [
    targetForEnvironment(contract, "PROD", base), // dev target presented as prod
    targetForEnvironment(contract, "DEV", { ...base, account: contract.targets.PROD.subscriptionId }),
    targetForEnvironment(contract, "DEV", { ...base, backend: base.backend + "x" }),
    targetForEnvironment(contract, "DEV", { ...base, workspace: "other" }),
    targetForEnvironment(contract, "DEV", { ...base, account: base.account + " " }),
    targetForEnvironment(contract, "DEV", { ...base, account: "" }),
    targetForEnvironment(contract, "STAGING" as never, base),
    targetForEnvironment(contract, "QA", base), // dev target presented as qa
    targetForEnvironment(contract, "PROD", { ...base, account: contract.targets.QA.subscriptionId, backend: contract.targets.QA.backend }), // qa target presented as prod
  ];
  for (const r of refused) assert.ok(!r.ok && r.code === "TARGET_NOT_IN_CONTRACT");
});

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const RELEASE = "c".repeat(64);
const evidenceFor = (over: Partial<ApplyEvidence> = {}): ApplyEvidence => ({
  schemaVersion: 1,
  environment: "DEV",
  target: { account: "22222222-2222-4222-8222-222222222222", backend: "fixturedevstore/tfstate/dev.tfstate", workspace: "default" },
  artifactSha256: HASH_A,
  manifestHash: "d".repeat(64),
  releaseIdentity: RELEASE,
  contractSha256: "c".repeat(64), sourceCommit: "5ec0de0000000000000000000000000000c0ffee",
  approvals: [{ approverId: "alice", issuedAt: "2026-10-11T12:00:00.000Z" }],
  requester: { requesterId: "carol", nonce: "0".repeat(32) },
  adapter: { adapterVersion: "terraform-apply-1", argvDigest: "e".repeat(64) },
  toolVersions: { engine: "1.9.8" },
  outcome: "SUCCEEDED",
  exitCode: 0,
  startedAt: "2026-10-11T12:01:00.000Z",
  finishedAt: "2026-10-11T12:02:00.000Z",
  authority: { ...APPLY_AUTHORITY },
  ...over,
});
const dirFor = (): string => mkdtempSync(join(scratch, "ev-"));

test("apply evidence: a complete document passes, authority must equal the pilot literals", () => {
  assert.deepEqual(applyEvidenceProblems(evidenceFor()), []);
  assert.deepEqual(assertApplyEvidence(evidenceFor()), evidenceFor());
  assert.deepEqual(APPLY_AUTHORITY, { infrastructureAct: "PILOT_ENABLED", mutation: "TERRAFORM_APPLY_OF_SEALED_PLAN", agentInitiated: false });
  const bad: unknown[] = [
    evidenceFor({ authority: { infrastructureAct: "DISABLED", mutation: "NONE", agentInitiated: false } as never }),
    evidenceFor({ authority: { ...APPLY_AUTHORITY, agentInitiated: true } as never }),
    evidenceFor({ authority: { ...APPLY_AUTHORITY, mutation: "NONE" } as never }),
    evidenceFor({ authority: { ...APPLY_AUTHORITY, extra: 1 } as never }),
    evidenceFor({ authority: undefined as never }),
  ];
  for (const doc of bad) {
    assert.ok(applyEvidenceProblems(doc).some((p) => /authority/.test(p)), JSON.stringify(doc));
    assert.throws(() => assertApplyEvidence(doc), /EVIDENCE_REJECTED/);
  }
});

test("apply evidence: extra and raw fields, missing fields and bad values are rejected", () => {
  const raw = (extra: Record<string, unknown>) => ({ ...evidenceFor(), ...extra });
  assert.ok(applyEvidenceProblems(raw({ planJson: "{}" })).length > 0);
  assert.ok(applyEvidenceProblems(raw({ stdout: "secret" })).some((p) => /raw/i.test(p)));
  assert.ok(applyEvidenceProblems(raw({ state: {} })).some((p) => /raw/i.test(p)));
  assert.ok(applyEvidenceProblems(raw({ target: { ...evidenceFor().target, extra: "x" } })).length > 0);
  assert.ok(applyEvidenceProblems({ ...evidenceFor(), approvals: [{ approverId: "a", issuedAt: "2026-10-11T12:00:00.000Z", signatureBase64: "x" }] }).length > 0);
  const missing = evidenceFor() as Record<string, unknown>;
  delete missing.releaseIdentity;
  assert.ok(applyEvidenceProblems(missing).some((p) => /releaseIdentity.*missing/.test(p)));
  // The product commit is required, and only a full commit id.
  const noSource = evidenceFor() as Record<string, unknown>;
  delete noSource.sourceCommit;
  assert.ok(applyEvidenceProblems(noSource).some((p) => /sourceCommit.*missing/.test(p)));
  for (const bad of ["HEAD", "5ec0de000000", "5EC0DE0000000000000000000000000000C0FFEE"]) {
    assert.ok(applyEvidenceProblems({ ...evidenceFor(), sourceCommit: bad }).some((p) => /sourceCommit/.test(p)), bad);
  }
  for (const doc of [null, undefined, "x", [], 7]) assert.ok(applyEvidenceProblems(doc).length > 0);
  assert.ok(applyEvidenceProblems(evidenceFor({ schemaVersion: 2 as never })).length > 0);
  assert.ok(applyEvidenceProblems(evidenceFor({ environment: "STAGING" as never })).length > 0);
  assert.ok(applyEvidenceProblems(evidenceFor({ outcome: "DONE" as never })).length > 0);
  assert.ok(applyEvidenceProblems(evidenceFor({ artifactSha256: "short" })).length > 0);
  assert.ok(applyEvidenceProblems(evidenceFor({ startedAt: "yesterday" })).length > 0);
  assert.ok(applyEvidenceProblems(evidenceFor({ exitCode: "0" as never })).length > 0);
  assert.ok(applyEvidenceProblems(evidenceFor({ exitCode: null, outcome: "KILLED" })).length === 0);
  assert.ok(applyEvidenceProblems(evidenceFor({ approvals: [] })).some((p) => /approvals/.test(p)));
  assert.ok(applyEvidenceProblems(evidenceFor({ releaseIdentity: "x".repeat(600) })).length > 0);
  assert.ok(applyEvidenceProblems(evidenceFor({ toolVersions: { engine: '{"plan":1}' } })).length > 0);
});

test("writing evidence is encrypted at rest, validated, and refuses a second apply of the same artifact", async () => {
  const dir = dirFor();
  assert.deepEqual(requireNotApplied(HASH_A, dir), { ok: true });
  const written = await recordApplied(evidenceFor(), dir);
  assert.ok(written.ok);
  const files = readdirSync(dir);
  assert.equal(files.length, 1);
  const onDisk = readFileSync(join(dir, files[0]), "utf8");
  assert.equal(onDisk.includes("fixturedevstore"), false);
  assert.equal(onDisk.includes(HASH_A), false);
  const again = requireNotApplied(HASH_A, dir);
  assert.ok(!again.ok && again.code === "ARTIFACT_ALREADY_APPLIED");
  const second = await recordApplied(evidenceFor({ outcome: "FAILED_NO_CHANGE", exitCode: 1 }), dir);
  assert.ok(!second.ok && second.code === "ARTIFACT_ALREADY_APPLIED");
  assert.equal(readdirSync(dir).length, 1);
  assert.deepEqual(requireNotApplied(HASH_B, dir), { ok: true });
});

test("concurrent writes of the same artifact: exactly one wins", async () => {
  const dir = dirFor();
  const results = await Promise.all([1, 2, 3, 4].map(() => recordApplied(evidenceFor(), dir)));
  assert.equal(results.filter((r) => r.ok).length, 1);
  assert.ok(results.filter((r) => !r.ok).every((r) => !r.ok && r.code === "ARTIFACT_ALREADY_APPLIED"));
});

test("evidence that fails validation is refused and nothing is written", async () => {
  const dir = dirFor();
  const result = await recordApplied(evidenceFor({ authority: { ...APPLY_AUTHORITY, agentInitiated: true } as never }), dir);
  assert.ok(!result.ok && result.code === "EVIDENCE_REJECTED");
  assert.deepEqual(readdirSync(dir), []);
  const traversal = await recordApplied(evidenceFor({ artifactSha256: "../../escape" }), dir);
  assert.ok(!traversal.ok && traversal.code === "ARTIFACT_INVALID");
  const check = requireNotApplied("../../escape", dir);
  assert.ok(!check.ok && check.code === "ARTIFACT_INVALID");
});

test("promotion: DEV needs none; QA needs a successful DEV apply of the same release; PROD needs a successful QA apply, never DEV alone", async () => {
  const dir = dirFor();
  assert.deepEqual(await requirePromotionEvidence("DEV", RELEASE, dir), { ok: true });

  const missing = async (env: "QA" | "PROD", release: string, d: string, from = env === "QA" ? "DEV" : "QA") => {
    const r = await requirePromotionEvidence(env, release, d);
    assert.ok(!r.ok && r.code === "PROMOTION_EVIDENCE_MISSING");
    assert.match(r.ok ? "" : r.message, new RegExp("successful " + from + " apply"));
  };
  await missing("QA", RELEASE, join(scratch, "no-such-dir"));
  await missing("PROD", RELEASE, join(scratch, "no-such-dir"));
  await missing("QA", RELEASE, dir);
  await missing("PROD", RELEASE, dir);

  // Failed, partial and killed dev applies do not qualify a release.
  await recordApplied(evidenceFor({ artifactSha256: "1".repeat(64), outcome: "FAILED_NO_CHANGE", exitCode: 1 }), dir);
  await recordApplied(evidenceFor({ artifactSha256: "2".repeat(64), outcome: "PARTIAL_REQUIRES_REVIEW", exitCode: 1 }), dir);
  await recordApplied(evidenceFor({ artifactSha256: "3".repeat(64), outcome: "KILLED", exitCode: null }), dir);
  await missing("QA", RELEASE, dir);
  await missing("PROD", RELEASE, dir);

  // A successful dev apply of a different release does not qualify this one.
  await recordApplied(evidenceFor({ artifactSha256: "4".repeat(64), releaseIdentity: "f".repeat(64) }), dir);
  await missing("QA", RELEASE, dir);

  // A successful PROD apply is neither DEV nor QA evidence.
  await recordApplied(evidenceFor({ artifactSha256: "5".repeat(64), environment: "PROD" }), dir);
  await missing("QA", RELEASE, dir);
  await missing("PROD", RELEASE, dir);

  // An empty release identity never matches.
  await missing("QA", "", dir);
  await missing("PROD", "", dir);

  // A successful DEV apply of this release qualifies QA and nothing else: PROD must not accept DEV alone.
  await recordApplied(evidenceFor({ artifactSha256: "6".repeat(64) }), dir);
  assert.deepEqual(await requirePromotionEvidence("QA", RELEASE, dir), { ok: true });
  await missing("PROD", RELEASE, dir);
  await missing("QA", "f".repeat(63) + "0", dir);

  // A failed or other-release QA apply does not qualify PROD.
  await recordApplied(evidenceFor({ artifactSha256: "a1".repeat(32), environment: "QA", outcome: "FAILED_NO_CHANGE", exitCode: 1 }), dir);
  await recordApplied(evidenceFor({ artifactSha256: "a2".repeat(32), environment: "QA", releaseIdentity: "f".repeat(64) }), dir);
  await missing("PROD", RELEASE, dir);

  // A successful QA apply of this release qualifies PROD; it does not need to qualify QA again.
  await recordApplied(evidenceFor({ artifactSha256: "a3".repeat(32), environment: "QA" }), dir);
  assert.deepEqual(await requirePromotionEvidence("PROD", RELEASE, dir), { ok: true });

  // QA evidence alone, without any DEV apply, qualifies PROD only as far as the PROD gate looks (the QA gate is enforced when QA is applied).
  const qaOnly = dirFor();
  await recordApplied(evidenceFor({ artifactSha256: "a4".repeat(32), environment: "QA" }), qaOnly);
  await missing("QA", RELEASE, qaOnly);
  assert.deepEqual(await requirePromotionEvidence("PROD", RELEASE, qaOnly), { ok: true });

  // An unknown environment never passes.
  assert.equal((await requirePromotionEvidence("STAGING" as never, RELEASE, dir)).ok, false);
});

test("promotion ignores unreadable, foreign-key, renamed and invalid evidence files", async () => {
  const dir = dirFor();
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "7".repeat(64) + ".apply.evidence"), "not json");
  writeFileSync(join(dir, "notes.txt"), "irrelevant");

  // Evidence sealed under a different key is not evidence this vault can read.
  const saved = process.env.AGENTIC_EVIDENCE_KEY;
  process.env.AGENTIC_EVIDENCE_KEY = randomBytes(32).toString("base64");
  const otherDir = dirFor();
  await recordApplied(evidenceFor({ artifactSha256: "8".repeat(64) }), otherDir);
  process.env.AGENTIC_EVIDENCE_KEY = saved;
  const foreign = readdirSync(otherDir)[0];
  writeFileSync(join(dir, foreign), readFileSync(join(otherDir, foreign)));

  // A valid successful record copied under another artifact's name is not trusted.
  const sourceDir = dirFor();
  await recordApplied(evidenceFor({ artifactSha256: "9".repeat(64) }), sourceDir);
  writeFileSync(join(dir, "0".repeat(64) + ".apply.evidence"), readFileSync(join(sourceDir, readdirSync(sourceDir)[0])));

  for (const env of ["QA", "PROD"] as const) {
    const r = await requirePromotionEvidence(env, RELEASE, dir);
    assert.ok(!r.ok && r.code === "PROMOTION_EVIDENCE_MISSING");
  }
});

// --- qualification evidence: a record counts only if the vault holds matching evidence -------------------------

const ADAPTER = { adapterVersion: "terraform-apply-1", argvDigest: "e".repeat(64), engineVersion: "1.9.8" };
const DEV_TENANT = "11111111-1111-4111-8111-111111111111";
const DEV_SUBSCRIPTION = "22222222-2222-4222-8222-222222222222";
const DEV = { tenantId: DEV_TENANT, subscriptionId: DEV_SUBSCRIPTION, backend: "devstore/tfstate/dev.tfstate", workspace: "default" };
const QNOW = new Date("2026-10-12T00:00:00.000Z");
const TF_SHA = "c".repeat(64);
const RUN = { terraformSha256: TF_SHA as string | undefined, stateWriteClientId: "writer-client", applyClientId: "applier-client" };
const BOUND = { dev: DEV, now: QNOW, ...RUN };
const qualificationFor = (over: Partial<QualificationEvidence> = {}): QualificationEvidence => ({
  schemaVersion: 1, engine: "TERRAFORM", realEngine: true, backendIdentitySeparated: true, tenantId: DEV_TENANT, subscriptionId: DEV_SUBSCRIPTION,
  backend: DEV.backend, workspace: DEV.workspace, stateWriteClientId: "writer-client", applyClientId: "applier-client", terraformSha256: TF_SHA,
  ...ADAPTER, qualifiedAt: "2026-10-11T12:00:00.000Z", ...over,
});
const recordFor = (evidenceHash: string) => ({ engine: "TERRAFORM" as const, ...ADAPTER, qualifiedAt: "2026-10-11T12:00:00.000Z", evidenceHash });
const denied = async (record: ReturnType<typeof recordFor>, dir: string, expected = ADAPTER, bound: typeof BOUND = BOUND) => {
  const r = await verifyApplyQualification(record, dir, expected, bound, AZURE);
  assert.ok(!r.ok && r.code === "ENGINE_NOT_QUALIFIED", JSON.stringify(r));
};

test("qualification evidence shape: closed, validated, real engine and separated backend identity only", () => {
  assert.deepEqual(qualificationEvidenceProblems(qualificationFor(), AZURE), []);
  for (const bad of [
    qualificationFor({ realEngine: false as never }), qualificationFor({ backendIdentitySeparated: false as never }),
    qualificationFor({ engine: "PULUMI" as never }), qualificationFor({ argvDigest: "short" }), qualificationFor({ adapterVersion: "" }),
    qualificationFor({ qualifiedAt: "yesterday" }), qualificationFor({ tenantId: "not-a-guid" }), qualificationFor({ subscriptionId: "" }), { ...qualificationFor(), stdout: "x" }, { ...qualificationFor(), extra: 1 }, null, "x", [],
  ]) assert.ok(qualificationEvidenceProblems(bad, AZURE).length > 0, JSON.stringify(bad));
  const { realEngine: _omit, ...missing } = qualificationFor();
  assert.ok(qualificationEvidenceProblems(missing, AZURE).some((p) => /realEngine.*missing/.test(p)));
});

test("verifyApplyQualification: only a matching encrypted vault file qualifies, never a bare hash", async () => {
  const dir = dirFor();
  const written = await writeQualificationEvidence(qualificationFor(), AZURE, dir);
  assert.ok(written.ok);
  const hash = written.ok ? written.evidenceHash : "";
  assert.match(hash, /^[0-9a-f]{64}$/);
  assert.deepEqual(await verifyApplyQualification(recordFor(hash), dir, ADAPTER, BOUND, AZURE), { ok: true });
  assert.equal(readFileSync(join(dir, readdirSync(dir)[0]), "utf8").includes("realEngine"), false, "encrypted at rest");
  // A bare hex string, an unknown hash, no vault, a malformed hash and a traversal attempt never pass.
  await denied(recordFor("a".repeat(64)), dir);
  await denied(recordFor(hash), join(scratch, "no-such-vault"));
  await denied(recordFor("../../etc/passwd"), dir);
  await denied(recordFor(""), dir);
  // The record must match what is being run.
  await denied(recordFor(hash), dir, { ...ADAPTER, adapterVersion: "terraform-apply-2" });
  await denied(recordFor(hash), dir, { ...ADAPTER, argvDigest: "f".repeat(64) });
  await denied(recordFor(hash), dir, { ...ADAPTER, engineVersion: "1.9.9" });
});

test("verifyApplyQualification: evidence is bound to the contract's DEV tenant and subscription and must be fresh", async () => {
  const dir = dirFor();
  const put = async (over: Partial<QualificationEvidence>) => {
    const written = await writeQualificationEvidence(qualificationFor(over), AZURE, dir);
    assert.ok(written.ok);
    return recordFor(written.ok ? written.evidenceHash : "");
  };
  const fresh = await put({});
  assert.deepEqual(await verifyApplyQualification(fresh, dir, ADAPTER, BOUND, AZURE), { ok: true });
  // Another tenant or subscription than the contract's DEV target.
  await denied(fresh, dir, ADAPTER, { ...BOUND, dev: { ...DEV, tenantId: "99999999-9999-4999-8999-999999999999" } });
  await denied(fresh, dir, ADAPTER, { ...BOUND, dev: { ...DEV, subscriptionId: "88888888-8888-4888-8888-888888888888" } });
  await denied(await put({ tenantId: "99999999-9999-4999-8999-999999999999" }), dir);
  await denied(await put({ subscriptionId: "88888888-8888-4888-8888-888888888888" }), dir);
  // Stale (31 days) and future-dated evidence; exactly 30 days still counts.
  const at = (days: number) => new Date(QNOW.getTime() - days * 86_400_000).toISOString();
  await denied(await put({ qualifiedAt: at(31) }), dir);
  const edge = await put({ qualifiedAt: at(30) });
  assert.deepEqual(await verifyApplyQualification(edge, dir, ADAPTER, BOUND, AZURE), { ok: true });
  await denied(await put({ qualifiedAt: at(-1) }), dir);
  // The record's own qualifiedAt is not what is judged: the evidence is.
  assert.deepEqual(await verifyApplyQualification({ ...fresh, qualifiedAt: at(400) }, dir, ADAPTER, BOUND, AZURE), { ok: true });
});

test("verifyApplyQualification: evidence is bound to the DEV backend and workspace, the attested client ids and the terraform binary", async () => {
  const dir = dirFor();
  const put = async (over: Partial<QualificationEvidence>) => {
    const written = await writeQualificationEvidence(qualificationFor(over), AZURE, dir);
    assert.ok(written.ok);
    return recordFor(written.ok ? written.evidenceHash : "");
  };
  const fresh = await put({});
  assert.deepEqual(await verifyApplyQualification(fresh, dir, ADAPTER, BOUND, AZURE), { ok: true });
  // Another backend or workspace than the contract's, on either side.
  await denied(fresh, dir, ADAPTER, { ...BOUND, dev: { ...DEV, backend: "other/tfstate/dev.tfstate" } });
  await denied(fresh, dir, ADAPTER, { ...BOUND, dev: { ...DEV, workspace: "feature" } });
  await denied(await put({ backend: "other/tfstate/dev.tfstate" }), dir);
  await denied(await put({ workspace: "feature" }), dir);
  // Another terraform binary, or none found.
  await denied(fresh, dir, ADAPTER, { ...BOUND, terraformSha256: "d".repeat(64) });
  await denied(fresh, dir, ADAPTER, { ...BOUND, terraformSha256: undefined });
  await denied(await put({ terraformSha256: "d".repeat(64) }), dir);
  // Other STATE_WRITE or APPLY client ids than the ones attested, or none configured.
  await denied(fresh, dir, ADAPTER, { ...BOUND, stateWriteClientId: "someone-else" });
  await denied(fresh, dir, ADAPTER, { ...BOUND, applyClientId: "someone-else" });
  await denied(fresh, dir, ADAPTER, { ...BOUND, stateWriteClientId: "" });
  await denied(fresh, dir, ADAPTER, { ...BOUND, applyClientId: "" });
  await denied(await put({ stateWriteClientId: "writer-client-2" }), dir);
  // The shape keeps them closed: required, lowercase, hash-shaped, and two different principals.
  for (const bad of [
    qualificationFor({ terraformSha256: "short" }), qualificationFor({ stateWriteClientId: "Writer-Client" }), qualificationFor({ applyClientId: "" }),
    qualificationFor({ applyClientId: "writer-client" }), qualificationFor({ backend: "" }), qualificationFor({ workspace: "" }),
  ]) assert.ok(qualificationEvidenceProblems(bad, AZURE).length > 0, JSON.stringify(bad));
  for (const key of ["backend", "workspace", "stateWriteClientId", "applyClientId", "terraformSha256"] as const) {
    const { [key]: _omit, ...missing } = qualificationFor();
    assert.ok(qualificationEvidenceProblems(missing, AZURE).some((p) => p.includes(key + ": missing")), key);
  }
});

test("verifyApplyQualification: evidence that is not real-engine, unseparated, mismatched, renamed or foreign is refused", async () => {
  const dir = dirFor();
  const put = async (over: Partial<QualificationEvidence>) => {
    // Bypass the writer's validation to plant what a careless or hostile tool could leave behind.
    const { ensureEvidenceKey, encryptEvidence } = await import("../src/evidence/vault.js");
    const { key } = await ensureEvidenceKey();
    const envelope = encryptEvidence("qualification", { ...qualificationFor(), ...over }, key);
    writeFileSync(join(dir, envelope.plaintextSha256 + ".qualification.evidence"), JSON.stringify(envelope));
    return envelope.plaintextSha256;
  };
  await denied(recordFor(await put({ realEngine: false as never })), dir);
  await denied(recordFor(await put({ backendIdentitySeparated: false as never })), dir);
  await denied(recordFor(await put({ adapterVersion: "other" })), dir);
  await denied(recordFor(await put({ argvDigest: "0".repeat(64) })), dir);
  await denied(recordFor(await put({ engineVersion: "0.0.1" })), dir);
  await denied(recordFor(await put({ extra: 1 } as never)), dir);
  // A valid file renamed to another hash is not evidence for that hash.
  const good = await writeQualificationEvidence(qualificationFor(), AZURE, dirFor());
  assert.ok(good.ok);
  const source = dirFor();
  const real = await writeQualificationEvidence(qualificationFor({ qualifiedAt: "2026-10-12T12:00:00.000Z" }), AZURE, source);
  assert.ok(real.ok);
  const other = "9".repeat(64);
  writeFileSync(join(dir, other + ".qualification.evidence"), readFileSync(join(source, readdirSync(source)[0])));
  await denied(recordFor(other), dir);
  // Garbage in the file's place.
  writeFileSync(join(dir, "8".repeat(64) + ".qualification.evidence"), "not json");
  await denied(recordFor("8".repeat(64)), dir);
});

test("loadQualificationRecords: records come only from valid vault evidence, never from a file the operator supplies", async () => {
  const dir = dirFor();
  assert.deepEqual(await loadQualificationRecords(AZURE, join(scratch, "no-such-vault")), []);
  const a = await writeQualificationEvidence(qualificationFor(), AZURE, dir);
  const b = await writeQualificationEvidence(qualificationFor({ adapterVersion: "other-adapter" }), AZURE, dir);
  assert.ok(a.ok && b.ok);
  // Junk beside it: garbage, a renamed copy, unrelated names and a not-real-engine document are not records.
  writeFileSync(join(dir, "8".repeat(64) + ".qualification.evidence"), "not json");
  writeFileSync(join(dir, "9".repeat(64) + ".qualification.evidence"), readFileSync(join(dir, readdirSync(dir).find((n) => n.startsWith(a.ok ? a.evidenceHash : "")) as string)));
  writeFileSync(join(dir, "notes.txt"), "x");
  const records = await loadQualificationRecords(AZURE, dir);
  assert.deepEqual(records.map((r) => r.evidenceHash).sort(), [a.ok ? a.evidenceHash : "", b.ok ? b.evidenceHash : ""].sort());
  assert.deepEqual(records.find((r) => r.evidenceHash === (a.ok ? a.evidenceHash : ""))!, recordFor(a.ok ? a.evidenceHash : ""));
  // Each record passes the apply gate it was derived for.
  assert.deepEqual(await verifyApplyQualification(records.find((r) => r.adapterVersion === ADAPTER.adapterVersion)!, dir, ADAPTER, BOUND, AZURE), { ok: true });
});
