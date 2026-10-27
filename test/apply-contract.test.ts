import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  authorizationChanged,
  authorizationSha256Of,
  authorizeContract,
  canonicalPublicKey,
  duplicateKeyOf,
  isKillSwitchActive,
  loadPilotContract,
  loadQualificationRecords,
  pilotContractSha256,
  pilotTargetSha256,
  repoPaths,
  requireNotApplied,
  requireActAuthorized,
  requirePromotionEvidence,
  targetForEnvironment,
  targetMoved,
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
  authorize: { DEV: ["APPLY", "CLEANUP"], QA: ["APPLY"], PROD: ["APPLY"] },
});

let counter = 0;
const write = (value: unknown): string => {
  const path = join(scratch, "contract-" + counter++ + ".json");
  writeFileSync(path, typeof value === "string" ? value : JSON.stringify(value));
  return path;
};
const load = (path: string) => loadPilotContract(path);
const mutate = (edit: (c: any) => void): string => { const c = fixtureContract() as any; edit(c); return write(c); };
const disabled = (path: string, pattern?: RegExp, code?: "ACT_DISABLED" | "CONTRACT_INVALID" | "NOT_IMPLEMENTED") => {
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

// One DEV-only rule for every implemented path (six-path baseline, #39; it folds in #298's Azure Terraform extension).
const azureDevOnly = (): any => {
  const c = fixtureContract() as any;
  c.enabledEnvironments = ["DEV"];
  c.targets = { DEV: c.targets.DEV };
  c.requiredApprovals = { DEV: 1 };
  c.approvers = c.approvers.map((entry: any) => ({ ...entry, environments: ["DEV"] }));
  c.authorize = { DEV: ["APPLY", "CLEANUP"] };
  return c;
};

test("an Azure Terraform DEV-only contract loads with no QA or PROD target, and resolves and authorizes only DEV", () => {
  const loaded = load(write(azureDevOnly()));
  assert.equal(loaded.enabled, true);
  if (!loaded.enabled) return;
  assert.deepEqual(loaded.enabledEnvironments, ["DEV"]);
  assert.deepEqual(Object.keys(loaded.targets), ["DEV"]);
  const dev = { account: "22222222-2222-4222-8222-222222222222", backend: "fixturedevstore/tfstate/dev.tfstate", workspace: "default" };
  assert.equal(targetForEnvironment(loaded, "DEV", dev).ok, true);
  assert.equal(targetForEnvironment(loaded, "QA", dev).ok, false, "QA is outside a DEV-only contract");
  assert.equal(targetForEnvironment(loaded, "PROD", dev).ok, false, "PROD is outside a DEV-only contract");
  assert.ok(authorizeContract(loaded, "DEV", "APPLY").ok);
  for (const env of ["QA", "PROD"] as const) assert.equal((authorizeContract(loaded, env, "APPLY") as { code: string }).code, "ACT_NOT_AUTHORIZED");
});

test("a DEV-only contract cannot name QA or PROD, and QA and PROD still need the full three-stage contract", () => {
  for (const scope of [["QA"], ["PROD"], ["DEV", "QA"], ["DEV", "PROD"], ["DEV", "QA", "PROD"], ["DEV", "DEV"], [], "DEV"]) {
    disabled(write({ ...azureDevOnly(), enabledEnvironments: scope }), /enabledEnvironments/, "CONTRACT_INVALID");
  }
  const base = fixtureContract() as any;
  disabled(write({ ...azureDevOnly(), targets: { DEV: base.targets.DEV, QA: base.targets.QA } }), /QA/, "CONTRACT_INVALID");
  disabled(write({ ...azureDevOnly(), requiredApprovals: { DEV: 1, PROD: 2 } }), /PROD/, "CONTRACT_INVALID");
  disabled(write({ ...azureDevOnly(), targets: {} }), /DEV/, "CONTRACT_INVALID");
  disabled(write({ ...azureDevOnly(), requiredApprovals: { DEV: 0 } }), /DEV/, "CONTRACT_INVALID");
  disabled(write({ ...azureDevOnly(), approvers: azureDevOnly().approvers.map((entry: any) => ({ ...entry, environments: ["QA"] })) }), /DEV approver/, "CONTRACT_INVALID");
  // Without the DEV-only field the contract is the three-stage chain: every stage, distinct targets, two PROD approvals.
  disabled(mutate((c) => { delete c.targets.QA; delete c.requiredApprovals.QA; c.authorize = { DEV: ["APPLY"] }; }), /QA/, "CONTRACT_INVALID");
  disabled(mutate((c) => { c.requiredApprovals.PROD = 1; }), /PROD/, "CONTRACT_INVALID");
});

test("the DEV-only rule is the same for AWS CDK: its own target shape, DEV only", () => {
  const cdk = {
    ...azureDevOnly(), provider: "AWS", engine: "CDK",
    targets: { DEV: { accountId: "123456789012", region: "us-east-2", backend: "alz-pilot-stack", workspace: "default", capabilities: [] } },
  };
  const loaded = load(write(cdk));
  assert.equal(loaded.enabled, true, JSON.stringify(loaded));
  assert.deepEqual((loaded as PilotContract).enabledEnvironments, ["DEV"]);
  disabled(write({ ...cdk, enabledEnvironments: ["DEV", "QA"] }), /enabledEnvironments/, "CONTRACT_INVALID");
});

test("planned paths are named and refused NOT_IMPLEMENTED until their lane lands; unknown ones stay CONTRACT_INVALID", () => {
  for (const [provider, engine] of [["AZURE", "BICEP"], ["GCP", "TERRAFORM"], ["GCP", "GCP_API"]]) {
    disabled(write({ ...fixtureContract(), provider, engine }), /planned path that is not implemented/, "NOT_IMPLEMENTED");
    disabled(write({ ...azureDevOnly(), provider, engine }), /not implemented/, "NOT_IMPLEMENTED");
  }
  for (const [provider, engine] of [["GCP", "CDK"], ["AWS", "BICEP"], ["AZURE", "GCP_API"], ["OCI", "TERRAFORM"], ["gcp", "TERRAFORM"], ["AWS", "PULUMI"]]) {
    disabled(write({ ...fixtureContract(), provider, engine }), undefined, "CONTRACT_INVALID");
  }
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

// --- the contract is the authorization (owner direction, #39): no hash file ------------------------------------

test("authorize: an enabled, valid contract is disabled unless it authorizes an operation", () => {
  assert.equal(load(write(fixtureContract())).enabled, true);
  // Key order and whitespace do not matter: the contract hash is canonical.
  const path = write(fixtureContract());
  writeFileSync(path, JSON.stringify(fixtureContract(), null, 4));
  assert.equal(load(path).enabled, true);
  disabled(mutate((c) => { delete c.authorize; }), /authorize/, "ACT_DISABLED");
  disabled(mutate((c) => { c.authorize = {}; }), /authorize/, "ACT_DISABLED");
});

test("authorize: a malformed authorization is refused, never ignored", () => {
  for (const [authorize, why] of [
    [[], /expected an object/], ["DEV", /expected an object/], [{ STAGING: ["APPLY"] }, /unknown field/], [{ DEV: [] }, /distinct operations/],
    [{ DEV: ["APPLY", "APPLY"] }, /distinct operations/], [{ DEV: ["DESTROY"] }, /distinct operations/], [{ DEV: "APPLY" }, /distinct operations/],
  ] as const) disabled(mutate((c) => { c.authorize = authorize; }), why, "CONTRACT_INVALID");
  // A DEV-only contract cannot authorize an environment it does not enable.
  disabled(mutate((c) => {
    c.enabledEnvironments = ["DEV"]; c.provider = "AWS"; c.targets = { DEV: { accountId: "123456789012", region: "us-east-2", backend: "fixture-dev-state/pilot/dev.tfstate", workspace: "default" } };
    c.requiredApprovals = { DEV: 1 }; c.authorize = { DEV: ["APPLY"], QA: ["APPLY"] };
  }), /authorize\.QA: unknown field/, "CONTRACT_INVALID");
});

test("N1: a contract that states a key twice, at any depth, is CONTRACT_INVALID rather than last-one-wins", () => {
  const text = JSON.stringify(fixtureContract());
  const cases: [string, string][] = [
    [text.replace('"authorize":', '"authorize":{"DEV":["APPLY"]},"authorize":'), "authorize"],
    [text.replace('"enabled":true', '"enabled":false,"enabled":true'), "enabled"],
    [text.replace('"authorize":{', '"authorize":{"DEV":["APPLY"],'), "DEV"],
    [text.replace('"authorize":{', '"authorize":{"\\u0044EV":["APPLY"],'), "DEV"],
    [text.replace('"maxApprovalAgeMinutes":60', '"maxApprovalAgeMinutes":60,"maxApprovalAgeMinutes":600'), "maxApprovalAgeMinutes"],
    [text.replace('"workspace":"default"', '"workspace":"default","workspace":"other"'), "workspace"],
  ];
  for (const [source, key] of cases) {
    assert.notEqual(source, text, "the fixture replacement applied for " + key);
    assert.doesNotThrow(() => JSON.parse(source), "it is valid JSON, which JSON.parse alone would accept");
    disabled(write(source), new RegExp("duplicate key \"" + key + "\""), "CONTRACT_INVALID");
  }
  // The same key in different objects, or a key-like string value, is not a duplicate.
  assert.equal(duplicateKeyOf('{"a":{"b":1},"c":{"b":2},"d":["b","b"],"e":"\\"b\\""}'), undefined);
  assert.equal(load(write(text)).enabled, true);
});

test("authorizeContract: default deny per environment and operation, bound to the contract's provider, engine and account", () => {
  const contract = load(write(fixtureContract())) as PilotContract;
  const dev = authorizeContract(contract, "DEV", "APPLY");
  assert.ok(dev.ok);
  assert.deepEqual(dev.authorization.entry, { provider: "AZURE", engine: "TERRAFORM", environment: "DEV", account: "22222222-2222-4222-8222-222222222222", operations: ["APPLY", "CLEANUP"] });
  assert.equal(dev.authorization.contractSha256, pilotContractSha256(contract));
  assert.equal(dev.authorization.authorizationSha256, authorizationSha256Of(dev.authorization.entry));
  assert.ok(authorizeContract(contract, "DEV", "CLEANUP").ok);
  for (const [env, op] of [["DEV", "REMOVE"], ["QA", "CLEANUP"], ["PROD", "REMOVE"]] as const) {
    const refused = authorizeContract(contract, env, op);
    assert.ok(!refused.ok && refused.code === "ACT_NOT_AUTHORIZED", env + " " + op);
  }
  // Each environment's entry is its own: a QA authorization is not a DEV one.
  const qa = authorizeContract(contract, "QA", "APPLY");
  assert.ok(qa.ok && qa.authorization.authorizationSha256 !== dev.authorization.authorizationSha256);
  // An entry for another cloud or engine never matches: the provider and engine are part of the signed entry.
  const entry = dev.authorization.entry;
  for (const other of [{ ...entry, engine: "CDK" as const }, { ...entry, provider: "AWS" as const }, { ...entry, account: "33333333-3333-4333-8333-333333333333" }]) {
    assert.notEqual(authorizationSha256Of(other), dev.authorization.authorizationSha256);
  }
  // The removal lane's entry point reads the same contract.
  const path = write(fixtureContract());
  assert.ok(requireActAuthorized("CLEANUP", "DEV", path).ok);
  const removal = requireActAuthorized("REMOVE", "DEV", path);
  assert.ok(!removal.ok && removal.code === "ACT_NOT_AUTHORIZED");
  const none = requireActAuthorized("APPLY", "DEV", join(scratch, "absent.json"));
  assert.ok(!none.ok && none.code === "ACT_DISABLED");
});

test("authorizationChanged: a changed contract or entry is refused, nothing else is", () => {
  const contract = load(write(fixtureContract())) as PilotContract;
  const now = authorizeContract(contract, "DEV", "APPLY");
  assert.ok(now.ok);
  const bound = { contractSha256: now.authorization.contractSha256, authorizationSha256: now.authorization.authorizationSha256 };
  assert.equal(authorizationChanged(bound, now.authorization), undefined);
  assert.equal(authorizationChanged({ ...bound, contractSha256: "0".repeat(64) }, now.authorization)?.code, "ACT_AUTHORIZATION_CHANGED");
  assert.equal(authorizationChanged({ ...bound, authorizationSha256: "0".repeat(64) }, now.authorization)?.code, "ACT_AUTHORIZATION_CHANGED");
});

test("any edit to the contract changes its hash, so a plan sealed before the edit no longer matches", () => {
  const sha = pilotContractSha256(fixtureContract());
  const edits: ((c: any) => void)[] = [
    (c) => { c.maxApprovalAgeMinutes = 61; },
    (c) => { c.approvers.push({ id: "mallory", publicKeyPem: approverKey(), environments: ["DEV"] }); },
    (c) => { c.approvers[0].environments = ["DEV"]; },
    (c) => { c.targets.DEV.tenantId = "99999999-9999-4999-8999-999999999999"; },
    (c) => { c.killSwitchPath = join(scratch, "elsewhere"); },
    (c) => { c.authorize.DEV = ["APPLY"]; },
  ];
  for (const edit of edits) {
    const loaded = load(mutate(edit));
    assert.equal(loaded.enabled, true);
    assert.notEqual(pilotContractSha256(loaded as PilotContract), sha);
  }
});

test("the repository ships no contract and no pin file: ACT is disabled and no product code reads or writes a pin or the contract", () => {
  const root = resolve(import.meta.dirname, "..");
  assert.equal(existsSync(join(root, "config/act-pilot-contract.sha256")), false, "the old pin is removed, not left as a second switch");
  assert.equal(existsSync(repoPaths().contract), false, "the shipped default is no contract");
  const loaded = loadPilotContract();
  assert.equal(loaded.enabled, false);
  assert.equal((loaded as { code: string }).code, "ACT_DISABLED");
  for (const file of sourceFiles(join(root, "src"))) {
    const text = readFileSync(file, "utf8");
    assert.doesNotMatch(text, /act-pilot-contract\.sha256/, file + " still names the retired pin");
    // Nothing writes the contract: the owner's reviewed commit is the only author of the authorization.
    assert.doesNotMatch(text, /(writeFile|appendFile|copyFile|rename|createWriteStream)[A-Za-z]*\([^)]*(repoPaths\(\)\.contract|act-pilot-contract\.json)/, file + " writes the contract");
  }
});

test("the bootstrap templates tell the owner to leave ACT unauthorized, and never name the retired pin", () => {
  const root = resolve(import.meta.dirname, "..");
  for (const name of ["config.aws.template.json", "config.azure.template.json", "config.gcp.template.json"]) {
    const text = readFileSync(join(root, "bootstrap", name), "utf8");
    const template = JSON.parse(text) as Record<string, unknown>;
    assert.doesNotMatch(text, /act-pilot-contract\.sha256|\bpin(ning)?\b/i, name);
    assert.match(String(template.NOTE), /add no authorize entry/, name);
  }
});

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? sourceFiles(join(dir, e.name)) : /\.tsx?$/.test(e.name) ? [join(dir, e.name)] : []);
}

// --- every path is anchored to the repository, never the working directory ------------------------------------

test("repoPaths and the defaults resolve from the module location, not process.cwd()", () => {
  const here = repoPaths();
  const root = resolve(import.meta.dirname, "..");
  assert.equal(here.root, root);
  assert.deepEqual(here, {
    root, contract: join(root, "config/act-pilot-contract.json"),
    evidence: join(root, ".runs/apply/evidence"), qualifications: join(root, ".runs/apply/qualification"), nonces: join(root, ".runs/apply"),
  });
  const cwd = process.cwd();
  // A hostile working directory with its own contract and kill switch changes nothing.
  const hostile = mkdtempSync(join(scratch, "cwd-"));
  mkdirSync(join(hostile, "config"), { recursive: true });
  const contract = fixtureContract();
  writeFileSync(join(hostile, "config/act-pilot-contract.json"), JSON.stringify(contract));
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
  targetSha256: "b".repeat(64),
  decisions: { authorized: { operation: "APPLY", contractSha256: "c".repeat(64), authorizationSha256: "a".repeat(64) }, ready: { engineBinarySha256: null, qualificationEvidenceHash: null }, execute: { requesterId: "carol", approverIds: ["alice"] } },
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

test("#313 F3: an Azure tenant or subscription GUID hashes the same in any letter case, so a contract writing the run's GUIDs in uppercase still states the run's target; any other change still moves it", () => {
  const TENANT = "4b1d7c2e-9a3f-4e6b-8c5d-2f7a9e1b3c4d";
  const SUBSCRIPTION = "7e8f9a0b-1c2d-4e3f-9a5b-6c7d8e9f0a1b";
  const withDev = (dev: Record<string, string>) => {
    const loaded = load(mutate((c) => { c.targets.DEV = { ...c.targets.DEV, tenantId: TENANT, subscriptionId: SUBSCRIPTION, ...dev }; }));
    assert.ok(!("reason" in loaded), JSON.stringify(loaded));
    return loaded as PilotContract;
  };
  const run = pilotTargetSha256(withDev({}), "DEV")!;
  assert.match(run, /^[a-f0-9]{64}$/);
  const upper = withDev({ tenantId: TENANT.toUpperCase(), subscriptionId: SUBSCRIPTION.toUpperCase() });
  assert.equal(upper.targets.DEV!.subscriptionId, SUBSCRIPTION.toUpperCase(), "the validator accepts the uppercase GUIDs as written");
  assert.equal(pilotTargetSha256(upper, "DEV"), run, "the uppercase variant of the same GUIDs is the same target");
  assert.equal(pilotTargetSha256(withDev({ tenantId: "4B1D7C2E-9a3f-4E6B-8c5d-2F7A9E1B3C4D" }), "DEV"), run, "mixed case too");
  assert.equal(targetMoved(run, upper, "DEV"), undefined, "a cleanup or removal of the run passes the target check under the uppercase contract");
  // Another GUID, or another backend, is another target.
  const other = withDev({ subscriptionId: "8f9a0b1c-2d3e-4f5a-8b6c-7d8e9f0a1b2c" });
  assert.notEqual(pilotTargetSha256(other, "DEV"), run);
  assert.equal(targetMoved(run, other, "DEV")?.code, "TARGET_NOT_IN_CONTRACT");
  assert.notEqual(pilotTargetSha256(withDev({ backend: "fixtureotherstore/tfstate/dev.tfstate" }), "DEV"), run);
});
