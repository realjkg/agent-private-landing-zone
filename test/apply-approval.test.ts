import assert from "node:assert/strict";
import { createPrivateKey, generateKeyPairSync, randomBytes, sign as cryptoSign } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, statSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { consumeApprovals, signApproval, verifyApprovalSet, type VerifyApprovalsInput } from "../src/apply/approval.js";
import { targetForEnvironment } from "../src/apply/contract.js";
import { openNonceStore } from "../src/apply/nonces.js";
import type { ApprovalStatement, ApproverEntry, PilotContract, SignedApproval } from "../src/apply/types.js";

// Explicit fixtures only: no real tenant, subscription or approver values.
const TENANT = "11111111-1111-4111-8111-111111111111";
const SUBSCRIPTION = "22222222-2222-4222-8222-222222222222";
const TARGET = { account: SUBSCRIPTION, backend: "fixturestore/tfstate/dev.tfstate", workspace: "default" };
const ARTIFACT = "a".repeat(64);
const NOW = new Date("2026-10-11T12:00:00Z");
const iso = (minutes: number): string => new Date(NOW.getTime() + minutes * 60_000).toISOString();

const newKey = () => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return {
    priv: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    pub: publicKey.export({ type: "spki", format: "pem" }).toString(),
  };
};
const keys = { alice: newKey(), bob: newKey(), carol: newKey(), mallory: newKey() };
const allowlist: ApproverEntry[] = [
  { id: "alice", publicKeyPem: keys.alice.pub, environments: ["DEV", "PROD"] },
  { id: "bob", publicKeyPem: keys.bob.pub, environments: ["DEV", "PROD"] },
  { id: "carol", publicKeyPem: keys.carol.pub, environments: ["DEV"] },
];

// The approval check reads the allowlist, the counts and the age from the pinned contract. Both environments use
// TARGET here; the contract loader (not this check) is what keeps DEV and PROD apart.
const contractFor = (over: Partial<PilotContract> = {}): PilotContract => ({
  schemaVersion: 1, enabled: true, provider: "AZURE", engine: "TERRAFORM",
  targets: {
    DEV: { tenantId: TENANT, subscriptionId: TARGET.account, backend: TARGET.backend, workspace: TARGET.workspace },
    PROD: { tenantId: TENANT, subscriptionId: TARGET.account, backend: TARGET.backend, workspace: TARGET.workspace },
  },
  requiredApprovals: { DEV: 1, PROD: 2 }, maxApprovalAgeMinutes: 30, approvers: allowlist, killSwitchPath: "KILL", ...over,
});

const statement = (over: Partial<ApprovalStatement> = {}): ApprovalStatement => ({
  schemaVersion: 1, artifactSha256: ARTIFACT, environment: "DEV", target: TARGET, approverId: "alice",
  issuedAt: iso(-5), expiresAt: iso(25), nonce: randomBytes(16).toString("hex"), ...over,
});
const signedBy = (id: keyof typeof keys, over: Partial<ApprovalStatement> = {}): SignedApproval =>
  signApproval(statement({ approverId: id, ...over }), keys[id].priv);

const made: string[] = [];
test.after(() => { for (const dir of made) rmSync(dir, { recursive: true, force: true }); });

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "alz-approval-"));
  made.push(dir);
  const nonces = openNonceStore(dir);
  const input = (approvals: SignedApproval[], over: Partial<VerifyApprovalsInput> = {}): VerifyApprovalsInput => ({
    approvals, artifactSha256: ARTIFACT, environment: "DEV", target: TARGET, contract: contractFor(), now: NOW, nonces, ...over,
  });
  return { dir, nonces, input };
}
const code = (v: ReturnType<typeof verifyApprovalSet>) => (v.ok ? "OK" : v.code);

test("one valid DEV approval is accepted and reports approver and time only", () => {
  const { input } = fixture();
  const verdict = verifyApprovalSet(input([signedBy("alice")]));
  assert.deepEqual(verdict, { ok: true, approvers: [{ approverId: "alice", issuedAt: iso(-5) }] });
});

test("PROD accepts two distinct approvers", () => {
  const { input } = fixture();
  const env = { environment: "PROD" as const };
  const verdict = verifyApprovalSet(input([signedBy("alice", env), signedBy("bob", env)], env));
  assert.equal(verdict.ok, true);
});

test("denies unsigned, garbled and typed-name approvals", () => {
  const { input } = fixture();
  const good = signedBy("alice");
  assert.equal(code(verifyApprovalSet(input([{ statement: good.statement, signatureBase64: "" }]))), "APPROVAL_UNVERIFIED");
  assert.equal(code(verifyApprovalSet(input([{ statement: good.statement, signatureBase64: "not-a-signature!!" }]))), "APPROVAL_UNVERIFIED");
  const flipped = Buffer.from(good.signatureBase64, "base64"); flipped[0] ^= 1;
  assert.equal(code(verifyApprovalSet(input([{ statement: good.statement, signatureBase64: flipped.toString("base64") }]))), "APPROVAL_UNVERIFIED");
  // A typed name with no signature at all.
  assert.equal(code(verifyApprovalSet(input([{ approverId: "alice" } as unknown as SignedApproval]))), "APPROVAL_UNVERIFIED");
  assert.equal(code(verifyApprovalSet(input(["alice" as unknown as SignedApproval]))), "APPROVAL_UNVERIFIED");
  assert.equal(code(verifyApprovalSet(input({} as unknown as SignedApproval[]))), "APPROVAL_UNVERIFIED");
});

test("denies a signature made by the wrong key for an allowlisted id", () => {
  const { input } = fixture();
  const forged = signApproval(statement({ approverId: "alice" }), keys.mallory.priv);
  assert.equal(code(verifyApprovalSet(input([forged]))), "APPROVAL_UNVERIFIED");
});

test("denies a key that is not on the allowlist, even with a valid signature", () => {
  const { input } = fixture();
  assert.equal(code(verifyApprovalSet(input([signedBy("mallory")]))), "APPROVER_NOT_ALLOWED");
});

test("denies an allowlisted approver who is not allowed for that environment", () => {
  const { input } = fixture();
  const env = { environment: "PROD" as const };
  assert.equal(code(verifyApprovalSet(input([signedBy("alice", env), signedBy("carol", env)], env))), "APPROVER_NOT_ALLOWED");
});

test("denies a non-ed25519 allowlist key", () => {
  const { input } = fixture();
  const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 }).publicKey.export({ type: "spki", format: "pem" }).toString();
  const approval = signedBy("alice");
  assert.equal(code(verifyApprovalSet(input([approval], { contract: contractFor({ approvers: [{ id: "alice", publicKeyPem: rsa, environments: ["DEV"] }] }) }))), "APPROVAL_UNVERIFIED");
  assert.equal(code(verifyApprovalSet(input([approval], { contract: contractFor({ approvers: [{ id: "alice", publicKeyPem: "garbage", environments: ["DEV"] }] }) }))), "APPROVAL_UNVERIFIED");
});

test("denies expired approvals, future approvals and over-long lifetimes", () => {
  const { input } = fixture();
  assert.equal(code(verifyApprovalSet(input([signedBy("alice", { issuedAt: iso(-20), expiresAt: iso(-1) })]))), "APPROVAL_EXPIRED");
  assert.equal(code(verifyApprovalSet(input([signedBy("alice", { issuedAt: iso(-45), expiresAt: iso(10) })]))), "APPROVAL_EXPIRED");
  assert.equal(code(verifyApprovalSet(input([signedBy("alice", { issuedAt: iso(-1), expiresAt: iso(120) })]))), "APPROVAL_EXPIRED");
  assert.equal(code(verifyApprovalSet(input([signedBy("alice", { issuedAt: iso(10), expiresAt: iso(20) })]))), "APPROVAL_UNVERIFIED");
  assert.equal(code(verifyApprovalSet(input([signedBy("alice", { issuedAt: iso(-1), expiresAt: iso(-1) })]))), "APPROVAL_UNVERIFIED");
  assert.equal(code(verifyApprovalSet(input([signedBy("alice", { issuedAt: "yesterday" })]))), "APPROVAL_UNVERIFIED");
});

test("denies approvals bound to another artifact, environment, subscription, backend or workspace", () => {
  const { input } = fixture();
  const misbound = (over: Partial<ApprovalStatement>) => code(verifyApprovalSet(input([signedBy("alice", over)])));
  assert.equal(misbound({ artifactSha256: "b".repeat(64) }), "APPROVAL_MISBOUND");
  assert.equal(misbound({ environment: "PROD" }), "APPROVAL_MISBOUND");
  assert.equal(misbound({ target: { ...TARGET, account: "other-subscription" } }), "APPROVAL_MISBOUND");
  assert.equal(misbound({ target: { ...TARGET, backend: "otherstore/tfstate/dev.tfstate" } }), "APPROVAL_MISBOUND");
  assert.equal(misbound({ target: { ...TARGET, workspace: "other" } }), "APPROVAL_MISBOUND");
});

test("denies tampered statements and extra fields", () => {
  const { input } = fixture();
  const good = signedBy("alice");
  const tamper = (over: Partial<ApprovalStatement>) => code(verifyApprovalSet(input([{ ...good, statement: { ...good.statement, ...over } }])));
  assert.equal(tamper({ artifactSha256: "c".repeat(64) }), "APPROVAL_UNVERIFIED");
  assert.equal(tamper({ expiresAt: iso(29) }), "APPROVAL_UNVERIFIED");
  assert.equal(tamper({ nonce: "f".repeat(32) }), "APPROVAL_UNVERIFIED");
  assert.equal(tamper({ target: { ...TARGET, workspace: "x" } }), "APPROVAL_UNVERIFIED");
  // Re-attributing a valid signature to a different allowlisted approver fails verification.
  assert.equal(tamper({ approverId: "bob" }), "APPROVAL_UNVERIFIED");
  // Extra fields are refused even when the signer signed them.
  const extra = signApproval({ ...statement(), admin: true } as unknown as ApprovalStatement, keys.alice.priv);
  assert.equal(code(verifyApprovalSet(input([extra]))), "APPROVAL_UNVERIFIED");
  const extraTarget = signApproval(statement({ target: { ...TARGET, region: "x" } as never }), keys.alice.priv);
  assert.equal(code(verifyApprovalSet(input([extraTarget]))), "APPROVAL_UNVERIFIED");
  const badNonce = signApproval(statement({ nonce: "short" }), keys.alice.priv);
  assert.equal(code(verifyApprovalSet(input([badNonce]))), "APPROVAL_UNVERIFIED");
});

test("a signature over the statement alone is not accepted without the domain prefix", () => {
  const { input } = fixture();
  const s = statement();
  const bare = cryptoSign(null, Buffer.from(JSON.stringify(s)), createPrivateKey(keys.alice.priv)).toString("base64");
  assert.equal(code(verifyApprovalSet(input([{ statement: s, signatureBase64: bare }]))), "APPROVAL_UNVERIFIED");
});

test("denies a replayed nonce after consumption, and nothing is consumed by verification", () => {
  const { input, nonces } = fixture();
  const approval = signedBy("alice");
  assert.equal(verifyApprovalSet(input([approval])).ok, true);
  assert.equal(verifyApprovalSet(input([approval])).ok, true, "verifying alone never consumes");
  assert.deepEqual(consumeApprovals(nonces, [approval]), { ok: true });
  assert.equal(code(verifyApprovalSet(input([approval]))), "APPROVAL_REPLAYED");
});

test("denies a nonce repeated inside one set", () => {
  const { input } = fixture();
  const env = { environment: "PROD" as const };
  const nonce = randomBytes(16).toString("hex");
  const set = [signedBy("alice", { ...env, nonce }), signedBy("bob", { ...env, nonce })];
  assert.equal(code(verifyApprovalSet(input(set, env))), "APPROVAL_REPLAYED");
});

test("denies the same approver signing twice", () => {
  const { input } = fixture();
  const env = { environment: "PROD" as const };
  const set = [signedBy("alice", env), signedBy("alice", env)];
  assert.equal(code(verifyApprovalSet(input(set, env))), "SAME_APPROVER_TWICE");
});

test("denies PROD with one approval and with none (a low configured requirement cannot load: apply-contract tests)", () => {
  const { input } = fixture();
  const env = { environment: "PROD" as const };
  assert.equal(code(verifyApprovalSet(input([signedBy("alice", env)], env))), "APPROVAL_INSUFFICIENT");
  assert.equal(code(verifyApprovalSet(input([], env))), "APPROVAL_INSUFFICIENT");
  assert.equal(code(verifyApprovalSet(input([]))), "APPROVAL_INSUFFICIENT");
});

test("the operator's own name is not authentication: it neither blocks nor admits an approver", () => {
  const { input } = fixture();
  const env = { environment: "PROD" as const };
  const set = [signedBy("alice", env), signedBy("bob", env)];
  assert.equal("requesterId" in input(set, env), false);
  assert.equal(verifyApprovalSet({ ...input(set, env), requesterId: "alice" } as VerifyApprovalsInput).ok, true);
});

test("PROD needs two distinct keys: one key under two ids is one approver, whatever its PEM text", () => {
  const { input } = fixture();
  const env = { environment: "PROD" as const };
  const twin = keys.alice.pub.replaceAll("\n", "\r\n") + "\n";
  const approvers: ApproverEntry[] = [...allowlist, { id: "alice-twin", publicKeyPem: twin, environments: ["DEV", "PROD"] }];
  const set = [signedBy("alice", env), signApproval(statement({ ...env, approverId: "alice-twin" }), keys.alice.priv)];
  assert.equal(code(verifyApprovalSet(input(set, { ...env, contract: contractFor({ approvers }) }))), "SAME_APPROVER_TWICE");
});

test("approvals bind the contract's subscription, backend, workspace and, through the contract lookup, its tenant", () => {
  const { input } = fixture();
  const approval = signedBy("alice");
  const other = { tenantId: "99999999-9999-4999-8999-999999999999", subscriptionId: "88888888-8888-4888-8888-888888888888", backend: "otherstore/tfstate/x.tfstate", workspace: "default" };
  const contract = contractFor();
  // The target the approver signed must be the target the caller passes in; the contract check is targetForEnvironment's alone.
  assert.equal(verifyApprovalSet(input([approval])).ok, true);
  for (const requested of [{ ...TARGET, account: other.subscriptionId }, { ...TARGET, backend: other.backend }, { ...TARGET, workspace: "other" }]) {
    assert.equal(code(verifyApprovalSet(input([approval], { target: requested }))), "APPROVAL_MISBOUND");
    assert.equal(targetForEnvironment(contract, "DEV", requested).ok, false);
  }
  assert.equal(targetForEnvironment(contract, "DEV", TARGET).ok, true);
});

test("one bad approval refuses the whole set", () => {
  const { input } = fixture();
  const env = { environment: "PROD" as const };
  const set = [signedBy("alice", env), signedBy("bob", { ...env, artifactSha256: "d".repeat(64) })];
  assert.equal(code(verifyApprovalSet(input(set, env))), "APPROVAL_MISBOUND");
});

test("consume records atomically: a second consume of any nonce fails and records nothing new", () => {
  const { nonces, dir } = fixture();
  const a = signedBy("alice"), b = signedBy("bob"), c = signedBy("alice");
  assert.deepEqual(consumeApprovals(nonces, [a]), { ok: true });
  const before = readFileSync(join(dir, "consumed-nonces.jsonl"), "utf8");
  const result = consumeApprovals(nonces, [b, a, c]);
  assert.equal(result.ok, false);
  assert.equal(readFileSync(join(dir, "consumed-nonces.jsonl"), "utf8"), before);
  assert.deepEqual(consumeApprovals(nonces, [b, c]), { ok: true });
  assert.equal(consumeApprovals(nonces, [signedBy("alice", { nonce: c.statement.nonce })]).ok, false);
  const duplicate = signedBy("bob");
  assert.equal(consumeApprovals(nonces, [duplicate, duplicate]).ok, false, "a nonce repeated within one consume is refused");
});

test("the nonce store is an append-only 0600 JSONL file without secrets", () => {
  const { nonces, dir } = fixture();
  const a = signedBy("alice");
  consumeApprovals(nonces, [a]);
  const file = join(dir, "consumed-nonces.jsonl");
  assert.equal(statSync(file).mode & 0o777, 0o600);
  const lines = readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(lines.length, 1);
  assert.equal(lines[0].nonce, a.statement.nonce);
  assert.equal(JSON.stringify(lines).includes(a.signatureBase64), false);
  // A fresh handle sees prior consumption.
  assert.equal(openNonceStore(dir).has(a.statement.nonce), true);
});

test("the nonce store fails closed when unreadable, malformed, loosely permissioned or locked", () => {
  const cases: [string, (dir: string, file: string) => void][] = [
    ["malformed", (_d, f) => writeFileSync(f, "not json\n", { mode: 0o600 })],
    ["missing nonce", (_d, f) => writeFileSync(f, '{"x":1}\n', { mode: 0o600 })],
    ["open permissions", (_d, f) => { writeFileSync(f, "", { mode: 0o600 }); chmodSync(f, 0o644); }],
    ["a directory in its place", (_d, f) => mkdirSync(f)],
  ];
  for (const [name, setup] of cases) {
    const { input, nonces, dir } = fixture();
    setup(dir, join(dir, "consumed-nonces.jsonl"));
    const approval = signedBy("alice");
    assert.equal(code(verifyApprovalSet(input([approval]))), "APPROVAL_REPLAYED", name);
    assert.equal(consumeApprovals(nonces, [approval]).ok, false, name);
    rmSync(dir, { recursive: true, force: true });
  }
  const { nonces, dir } = fixture();
  writeFileSync(join(dir, "consumed-nonces.lock"), "", { mode: 0o600 });
  assert.equal(consumeApprovals(nonces, [signedBy("alice")]).ok, false, "a held lock fails closed");
});
