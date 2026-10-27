import assert from "node:assert/strict";
import { pilotUnitOf } from "../src/apply/unit.js";
import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { signRequest } from "../src/apply/approval.js";
import { computeArtifactSha256, engineBinaryChange, loadSealedPlan, planWithoutStoring, reviewBundleOf, sealPlan, verifyReviewBundle, verifySealedPlan, type SealInput } from "../src/apply/seal.js";
import type { PreviewProvenance, SealedPlan } from "../src/apply/types.js";
import { decryptEvidence, encryptEvidence, ensureEvidenceKey, type EvidenceEnvelope } from "../src/evidence/vault.js";
import { canonicalJson } from "../src/teardown/manifest.js";
import { createImmutableSnapshot } from "../src/teardown/snapshot.js";
import { createPrivateDirectory } from "../src/tools/private-workdir.js";
import { SOURCE_COMMIT,
  keys,
  AZURE_BACKEND_TF, DEV_TARGET, ENGINE_VERSION, ENV, identityEnv, TENANT, H, PLAN_CANARY, POLICY, PROD_TARGET, QA_TARGET, VALUE_CANARY, behave as behaveIn, callsOf, installFakeTerraform, sha,
  writeProject, type Behavior,
  REQUESTER,
} from "./helpers/apply-fixtures.js";
import { AZURE } from "../src/apply/providers/azure.js";
import { TERRAFORM } from "../src/apply/engines/terraform.js";

// docs/act-pilot-plan.md, authority items 2 and 5. The engine is a fake
// executable: these tests pin the sealing logic, not the real Terraform CLI.

const root = mkdtempSync(join(tmpdir(), "alz-seal-"));
process.env.AGENTIC_EVIDENCE_KEY = randomBytes(32).toString("base64");
process.chdir(root); // the vault writes under ./.runs
test.after(() => {
  const open = (path: string) => {
    try {
      chmodSync(path, 0o700);
      if (statSync(path).isDirectory()) for (const name of readdirSync(path)) open(join(path, name));
    } catch { /* best effort */ }
  };
  open(root);
  rmSync(root, { recursive: true, force: true });
});
let counter = 0;
const fresh = (label: string) => {
  const dir = join(root, label + "-" + ++counter);
  mkdirSync(dir, { recursive: true });
  return dir;
};

const toolDir = fresh("tools");
installFakeTerraform(toolDir);
const behave = (behavior: Behavior = {}) => behaveIn(toolDir, join(root, "KILL"), behavior);
/** What the driver observed before planning; these tests seal it and do not judge it (apply-driver tests do). */
const PROVENANCE: PreviewProvenance = { engineBinarySha256: H("e"), qualification: { state: "UNQUALIFIED", reason: "Fixture: no qualification evidence is in this test's vault." } };
const calls = () => callsOf(toolDir);

function fixture(options: { target?: typeof DEV_TARGET; environment?: "DEV" | "QA" | "PROD"; mainTf?: string; env?: NodeJS.ProcessEnv; workspace?: string } = {}) {
  const target = { ...(options.target ?? DEV_TARGET), ...(options.workspace ? { workspace: options.workspace } : {}) };
  behave({ workspace: target.workspace });
  const { projectRoot, manifest } = writeProject(fresh("project"), target, options.mainTf);
  const parent = fresh("scratch");
  const snapshot = createImmutableSnapshot(projectRoot, manifest, parent);
  const scratch = createPrivateDirectory("alz-seal-", parent);
  const input: SealInput = {
    engine: TERRAFORM, environment: options.environment ?? "DEV", target, manifest, snapshotPath: snapshot.path, scratchDir: scratch.path,
    env: options.env ?? identityEnv(options.environment ?? "DEV"), policyVersion: POLICY, engineVersion: ENGINE_VERSION, toolDirs: [toolDir],
    pinned: { tenantId: TENANT, subscriptionId: target.account, backend: target.backend, workspace: target.workspace }, spec: AZURE, contractSha256: H("9"), sourceCommit: SOURCE_COMMIT,
    provenance: PROVENANCE, requester: REQUESTER, now: () => new Date("2026-10-11T10:00:00.000Z"),
    unit: pilotUnitOf({ provider: "AZURE", contractSha256: H("9"), environment: options.environment ?? "DEV", target }),
  };
  return { input, scratch, cleanup: () => { snapshot.remove(); scratch.remove(); } };
}

/** What an apply's `rederive` needs: the fixture's scratch directory with an (empty) work directory, as `prepare` leaves it. */
function fixtureRun(f: ReturnType<typeof fixture>) {
  mkdirSync(join(f.scratch.path, "work"), { recursive: true });
  return TERRAFORM.openApply({
    scratchDir: f.scratch.path, env: f.input.env, toolDirs: f.input.toolDirs, manifest: f.input.manifest, pinned: f.input.pinned, spec: f.input.spec,
    target: f.input.target, engineVersion: f.input.engineVersion,
  });
}

async function sealed(options: Parameters<typeof fixture>[0] = {}) {
  const f = fixture(options);
  try {
    const result = await sealPlan(f.input);
    assert.ok(result.ok, JSON.stringify(result));
    return { result, leftover: readdirSync(f.scratch.path) };
  } finally { f.cleanup(); }
}

test("sealing runs the pinned init/workspace/plan/show sequence, with STATE for init and workspace, DISCOVERY for the plan and nothing for version and show", async () => {
  const f = fixture({ workspace: "pilot" });
  try {
    assert.ok((await sealPlan(f.input)).ok);
    assert.deepEqual(calls().map((c) => c.args), [
      ["version", "-json"],
      ["init", "-input=false", "-no-color", "-lockfile=readonly"],
      ["workspace", "select", "pilot"],
      ["workspace", "show"],
      ["plan", "-input=false", "-no-color", "-out=../alz-preview.tfplan"],
      ["show", "-json", "../alz-preview.tfplan"],
    ]);
    const by = Object.fromEntries(calls().map((c) => [c.args[0], c]));
    for (const step of ["init", "workspace"]) assert.equal(by[step].env.ARM_CLIENT_ID, "state-client-2", step);
    assert.equal(by.plan.env.ARM_CLIENT_ID, "discovery-client-1");
    for (const step of ["version", "show"]) assert.equal(by[step].env.ARM_CLIENT_ID, undefined, step);
    for (const call of calls()) {
      const text = JSON.stringify(call.env);
      // Sealing never holds the writer or the applier, and never the operator's own values.
      for (const value of ["statewrite-", "apply-client", "apply-secret", "operator-ambient"]) assert.ok(!text.includes(value), call.args[0] + " " + value);
      assert.ok(!call.args.some((a) => /^-(lock(=|-timeout|$)|refresh|target|replace|auto-approve|destroy)/.test(a)));
    }
  } finally { f.cleanup(); }
});

test("the sealed record binds plan, manifest, release identity, environment, target, engine, policy and pinned contract; the artifact hash recomputes from them", async () => {
  const { result } = await sealed();
  const { sealed: s } = result as Extract<typeof result, { ok: true }>;
  assert.equal(s.schemaVersion, 2, "schema 2: the requester signs the sealed request");
  assert.equal(s.environment, "DEV");
  assert.deepEqual(s.target, DEV_TARGET);
  assert.equal(s.engineVersion, "1.9.5");
  assert.equal(s.policyVersion, "2026-10-11.1");
  assert.equal(s.createdAt, "2026-10-11T10:00:00.000Z");
  assert.match(s.planSha256, /^[a-f0-9]{64}$/);
  assert.match(s.releaseIdentity, /^[a-f0-9]{64}$/);
  assert.equal(s.artifactSha256, computeArtifactSha256(s));
  assert.equal(s.channel, "CLI");
  assert.equal(s.artifactSha256, sha(JSON.stringify({
    changesSha256: sha(canonicalJson(s.changes)), channel: s.channel, contractSha256: s.contractSha256, engineVersion: s.engineVersion, environment: s.environment, manifestHash: s.manifestHash,
    planSha256: s.planSha256, policyVersion: s.policyVersion,
    provenance: { engineBinarySha256: PROVENANCE.engineBinarySha256, qualification: { reason: "Fixture: no qualification evidence is in this test's vault.", state: "UNQUALIFIED" } },
    releaseIdentity: s.releaseIdentity, requesterId: "carol", sourceCommit: s.sourceCommit,
    target: { account: s.target.account, backend: s.target.backend, workspace: s.target.workspace },
    unit: { tags: { "alz-build": s.unit!.tags["alz-build"], "alz-managed-by": "alz", "alz-unit": s.unit!.unitId }, unitId: s.unit!.unitId, untagged: s.unit!.untagged },
  })), "canonical JSON of exactly these fourteen fields (the requester id among them), the change list through its own hash");
  assert.equal(s.requesterId, "carol");
  assert.deepEqual(Object.keys(s.request!).sort(), ["signatureBase64", "statement"]);
  assert.deepEqual(s.request!.statement, { schemaVersion: 1, requesterId: "carol", artifactSha256: s.artifactSha256, environment: "DEV", nonce: s.request!.statement.nonce });
  assert.deepEqual(s.provenance, PROVENANCE, "the seal keeps the provenance the driver observed, unchanged");
  assert.deepEqual(s.changes, [
    { address: "azurerm_log_analytics_workspace.pilot", type: "azurerm_log_analytics_workspace", action: "UPDATE" },
    { address: "azurerm_resource_group.pilot", type: "azurerm_resource_group", action: "CREATE" },
  ]);
  assert.ok(!JSON.stringify(s).includes(VALUE_CANARY) && !JSON.stringify(s).includes(PLAN_CANARY));
});

test("Azure too: the backend the seal-time init saved must be the contract's, because the plan embeds it", async () => {
  for (const savedBackend of [
    { type: "azurerm", config: { storage_account_name: "attackerstore", container_name: "tfstate", key: "dev.tfstate" } }, { type: "s3", config: {} }, null,
  ]) {
    const f = fixture();
    try {
      behave({ savedBackend });
      const result = await sealPlan(f.input);
      assert.ok(!result.ok && /BACKEND_(NOT_IN_CONTRACT|UNREADABLE)/.test(result.message), JSON.stringify(result));
    } finally { f.cleanup(); }
  }
});

test("any change to a bound field changes the artifact hash", async () => {
  const { result } = await sealed();
  const s = (result as Extract<typeof result, { ok: true }>).sealed;
  const base = s.artifactSha256;
  const variants: Partial<SealedPlan>[] = [
    { planSha256: H("a") }, { channel: "UI" }, { manifestHash: H("b") }, { releaseIdentity: H("c") }, { environment: "PROD" }, { environment: "QA" },
    { target: { ...s.target, workspace: "other" } }, { target: { ...s.target, account: "sub-other" } },
    { target: { ...s.target, backend: "x/y/z" } }, { engineVersion: "1.9.6" }, { policyVersion: "2026-10-12.1" },
    { changes: [] }, { changes: s.changes.slice(1) }, { changes: s.changes.map((c) => ({ ...c, action: "DELETE" })) },
    { changes: s.changes.map((c) => ({ ...c, address: c.address + "x" })) }, { changes: [...s.changes].reverse() }, { contractSha256: H("8") }, { sourceCommit: "1".repeat(40) },
    { provenance: { ...s.provenance, engineBinarySha256: H("7") } },
    { provenance: { ...s.provenance, qualification: { state: "QUALIFIED", evidenceHash: H("6"), qualifiedAt: "2026-10-10T10:00:00.000Z" } } },
    { provenance: { ...s.provenance, qualification: { state: "UNQUALIFIED", reason: "Another reason." } } },
  ];
  for (const change of variants) assert.notEqual(computeArtifactSha256({ ...s, ...change }), base, JSON.stringify(change));
});

test("the plan is kept only encrypted in the vault, and nothing readable is left in scratch", async () => {
  const { result, leftover } = await sealed();
  const { path, sealed: s } = result as Extract<typeof result, { ok: true }>;
  const onDisk = readFileSync(path, "utf8");
  assert.ok(!onDisk.includes(PLAN_CANARY) && !onDisk.includes(Buffer.from("BINARY-PLAN " + PLAN_CANARY).toString("base64")));
  assert.equal(statSync(path).mode & 0o077, 0, "the vault file is private");
  assert.deepEqual(leftover, [], "no plan file and no work copy survive in the scratch directory");
  const key = (await ensureEvidenceKey()).key;
  const inner = decryptEvidence<{ planBase64: string }>(JSON.parse(onDisk) as EvidenceEnvelope, key);
  assert.equal(sha(Buffer.from(inner.planBase64, "base64")), s.planSha256);
});

test("release identity is target-independent; the artifact hash is not", async () => {
  const dev = (await sealed({ environment: "DEV", target: DEV_TARGET })).result as Extract<Awaited<ReturnType<typeof sealPlan>>, { ok: true }>;
  const qa = (await sealed({ environment: "QA", target: QA_TARGET })).result as Extract<Awaited<ReturnType<typeof sealPlan>>, { ok: true }>;
  const prod = (await sealed({ environment: "PROD", target: PROD_TARGET })).result as Extract<Awaited<ReturnType<typeof sealPlan>>, { ok: true }>;
  assert.equal(qa.sealed.environment, "QA");
  assert.notEqual(dev.sealed.manifestHash, prod.sealed.manifestHash, "manifests are target-bound");
  assert.notEqual(dev.sealed.manifestHash, qa.sealed.manifestHash, "manifests are target-bound");
  assert.equal(dev.sealed.releaseIdentity, prod.sealed.releaseIdentity, "the qualified release is the same");
  assert.equal(dev.sealed.releaseIdentity, qa.sealed.releaseIdentity, "the qualified release is the same");
  assert.notEqual(dev.sealed.artifactSha256, prod.sealed.artifactSha256);
  assert.notEqual(dev.sealed.artifactSha256, qa.sealed.artifactSha256);
  assert.notEqual(qa.sealed.artifactSha256, prod.sealed.artifactSha256);
  // A QA record loads back as QA; an environment outside DEV, QA and PROD is not a sealed plan.
  const loaded = await loadSealedPlan(qa.path);
  assert.ok(loaded.ok && loaded.sealed.environment === "QA");
  await rewrite(qa.path, (i) => { i.sealed.environment = "STAGING" as never; });
  const bogus = await loadSealedPlan(qa.path);
  assert.ok(!bogus.ok, "an unknown environment is refused");

  const changed = (await sealed({ mainTf: AZURE_BACKEND_TF + 'resource "azurerm_resource_group" "other" {}\n' })).result as Extract<Awaited<ReturnType<typeof sealPlan>>, { ok: true }>;
  assert.notEqual(changed.sealed.releaseIdentity, dev.sealed.releaseIdentity, "different project files are a different release");
});

test("a sealed plan loads back to exactly the same record and plan bytes", async () => {
  const { result } = await sealed();
  const ok = result as Extract<typeof result, { ok: true }>;
  const loaded = await loadSealedPlan(ok.path);
  assert.ok(loaded.ok);
  assert.deepEqual(loaded.sealed, ok.sealed);
  assert.equal(sha(loaded.planBytes), ok.sealed.planSha256);
  assert.ok(loaded.planBytes.toString("utf8").includes(PLAN_CANARY));
});

async function rewrite(path: string, edit: (inner: { sealed: SealedPlan; planBase64: string }) => void): Promise<void> {
  const key = (await ensureEvidenceKey()).key;
  const inner = decryptEvidence<{ sealed: SealedPlan; planBase64: string }>(JSON.parse(readFileSync(path, "utf8")) as EvidenceEnvelope, key);
  edit(inner);
  writeFileSync(path, JSON.stringify(encryptEvidence("sealed-plan", inner, key)) + "\n");
}

test("any mismatch is ARTIFACT_TAMPERED: swapped plan bytes, edited target, edited environment, edited hash, flipped ciphertext", async () => {
  const edits: Array<[string, (inner: { sealed: SealedPlan; planBase64: string }) => void]> = [
    ["plan bytes swapped", (i) => { i.planBase64 = Buffer.from("a different plan").toString("base64"); }],
    ["target edited", (i) => { i.sealed.target = { ...i.sealed.target, workspace: "other" }; }],
    ["environment edited", (i) => { i.sealed.environment = "PROD"; }],
    ["environment edited to QA", (i) => { i.sealed.environment = "QA"; }],
    ["artifact hash edited", (i) => { i.sealed.artifactSha256 = H("0"); }],
    ["plan hash edited", (i) => { i.sealed.planSha256 = H("0"); }],
    ["release identity edited", (i) => { i.sealed.releaseIdentity = H("0"); }],
    ["change list edited", (i) => { i.sealed.changes = i.sealed.changes.map((c) => ({ ...c, action: "DELETE" })); }],
    ["change list emptied", (i) => { i.sealed.changes = []; }],
  ];
  for (const [label, edit] of edits) {
    const { result } = await sealed();
    const ok = result as Extract<typeof result, { ok: true }>;
    await rewrite(ok.path, edit);
    const loaded = await loadSealedPlan(ok.path);
    assert.ok(!loaded.ok, label);
    assert.equal(loaded.code, "ARTIFACT_TAMPERED", label);
  }
  const { result } = await sealed();
  const ok = result as Extract<typeof result, { ok: true }>;
  const envelope = JSON.parse(readFileSync(ok.path, "utf8")) as EvidenceEnvelope;
  const bytes = Buffer.from(envelope.ciphertext, "base64");
  bytes[0] ^= 0xff;
  writeFileSync(ok.path, JSON.stringify({ ...envelope, ciphertext: bytes.toString("base64") }));
  const flipped = await loadSealedPlan(ok.path);
  assert.ok(!flipped.ok);
  assert.equal(flipped.code, "ARTIFACT_TAMPERED");
});

test("verifySealedPlan is the one verification: an already-loaded plan is re-checked, and a malformed change list is invalid", async () => {
  const { result } = await sealed();
  const ok = result as Extract<typeof result, { ok: true }>;
  const loaded = await loadSealedPlan(ok.path);
  assert.ok(loaded.ok);
  assert.ok(verifySealedPlan({ sealed: loaded.sealed, planBytes: loaded.planBytes }).ok);
  const tamper = (code: string, value: unknown) => { const v = verifySealedPlan(value); assert.ok(!v.ok); assert.equal(v.code, code); };
  tamper("ARTIFACT_TAMPERED", { sealed: loaded.sealed, planBytes: Buffer.from("x") });
  tamper("ARTIFACT_TAMPERED", { sealed: { ...loaded.sealed, changes: [] }, planBytes: loaded.planBytes });
  tamper("ARTIFACT_INVALID", { sealed: { ...loaded.sealed, changes: [{ address: "a" }] }, planBytes: loaded.planBytes });
  tamper("ARTIFACT_INVALID", { sealed: { ...loaded.sealed, changes: "none" }, planBytes: loaded.planBytes });
  tamper("ARTIFACT_INVALID", { sealed: loaded.sealed, planBytes: loaded.planBytes.toString("base64") });
  for (const junk of [undefined, null, 7, {}, { sealed: loaded.sealed }]) tamper("ARTIFACT_INVALID", junk);
});

test("a sealed plan or review bundle whose preview provenance is missing or malformed is refused, never shown as qualified", async () => {
  const { result } = await sealed();
  const ok = result as Extract<typeof result, { ok: true }>;
  const loaded = await loadSealedPlan(ok.path);
  assert.ok(loaded.ok);
  const bundle = reviewBundleOf(loaded.sealed);
  assert.ok(verifyReviewBundle(bundle).ok);
  const qualified = { state: "QUALIFIED", evidenceHash: H("6"), qualifiedAt: "2026-10-10T10:00:00.000Z" };
  for (const provenance of [
    undefined, null, {}, { engineBinarySha256: "short", qualification: PROVENANCE.qualification }, { engineBinarySha256: H("e") },
    { ...PROVENANCE, extra: true }, { ...PROVENANCE, qualification: { state: "QUALIFIED" } }, { ...PROVENANCE, qualification: { ...qualified, evidenceHash: "x" } },
    { ...PROVENANCE, qualification: { ...qualified, qualifiedAt: "yesterday" } }, { ...PROVENANCE, qualification: { state: "UNQUALIFIED", reason: "" } },
    { ...PROVENANCE, qualification: { state: "UNQUALIFIED", reason: "hidden\u202e text" } }, { ...PROVENANCE, qualification: { state: "MAYBE", reason: "unsure" } },
    { ...PROVENANCE, qualification: { ...qualified, reason: "both" } },
  ]) {
    const plan = verifySealedPlan({ sealed: { ...loaded.sealed, provenance }, planBytes: loaded.planBytes });
    assert.ok(!plan.ok && plan.code === "ARTIFACT_INVALID", JSON.stringify(provenance));
    const review = verifyReviewBundle({ ...bundle, provenance });
    assert.ok(!review.ok && review.code === "ARTIFACT_INVALID", JSON.stringify(provenance));
  }
  // A well-formed but edited provenance (claiming qualification after the fact) breaks the signed hash.
  const claimed = verifyReviewBundle({ ...bundle, provenance: { ...PROVENANCE, qualification: qualified } });
  assert.ok(!claimed.ok && claimed.code === "ARTIFACT_TAMPERED");
});

test("only the engine program that made the preview may apply it: another program, or none, is ENGINE_BINARY_CHANGED", () => {
  assert.equal(engineBinaryChange({ provenance: PROVENANCE }, PROVENANCE.engineBinarySha256), undefined);
  for (const now of [H("7"), undefined]) {
    const changed = engineBinaryChange({ provenance: PROVENANCE }, now);
    assert.equal(changed?.code, "ENGINE_BINARY_CHANGED");
    assert.match(changed!.message, /Nothing was consumed/);
  }
});

test("a missing or malformed record is ARTIFACT_INVALID, and a record of the wrong shape is refused", async () => {
  const missing = await loadSealedPlan(join(root, "nope.evidence"));
  assert.ok(!missing.ok);
  assert.equal(missing.code, "ARTIFACT_INVALID");
  const junk = join(root, "junk.evidence");
  writeFileSync(junk, "not json");
  const parsed = await loadSealedPlan(junk);
  assert.ok(!parsed.ok);
  assert.equal(parsed.code, "ARTIFACT_INVALID");
  const { result } = await sealed();
  const ok = result as Extract<typeof result, { ok: true }>;
  await rewrite(ok.path, (i) => { (i as unknown as { planBase64: unknown }).planBase64 = 5; });
  const wrong = await loadSealedPlan(ok.path);
  assert.ok(!wrong.ok);
  assert.ok(wrong.code === "ARTIFACT_INVALID" || wrong.code === "ARTIFACT_TAMPERED");
});

test("sealing fails closed with codes only: engine failure, wrong engine version, wrong workspace, changed project files", async () => {
  const cases: Array<[string, () => ReturnType<typeof fixture>, RegExp]> = [
    ["plan fails", () => { const f = fixture(); behave({ failOn: "plan" }); return f; }, /EXIT_1/],
    ["engine version", () => { const f = fixture(); behave({ version: "1.9.9" }); return f; }, /ENGINE_VERSION_MISMATCH/],
    ["workspace", () => { const f = fixture({ workspace: "pilot" }); behave({ workspace: "elsewhere" }); return f; }, /WORKSPACE_MISMATCH/],
    ["init rewrote a file", () => { const f = fixture(); behave({ initWrites: [{ path: "main.tf", content: "tampered" }] }); return f; }, /PROJECT_CHANGED/],
  ];
  for (const [label, make, pattern] of cases) {
    const f = make();
    try {
      const result = await sealPlan(f.input);
      assert.ok(!result.ok, label);
      assert.equal(result.code, "ARTIFACT_INVALID", label);
      assert.match(result.message, pattern, label);
      assert.ok(!result.message.includes(VALUE_CANARY) && !result.message.includes(PLAN_CANARY), label);
      assert.deepEqual(readdirSync(f.scratch.path), [], label + ": scratch is clean");
    } finally { f.cleanup(); }
  }
});

test("a credential the runner refused fails the seal instead of running with no identity", async () => {
  const f = fixture({ env: { ...ENV, ALZ_STATE_ARM_CLIENT_SECRET: "line\nbreak-secret" } });
  try {
    const result = await sealPlan(f.input);
    assert.ok(!result.ok);
    assert.match(result.message, /ENVIRONMENT_REFUSED/);
  } finally { f.cleanup(); }
});

test("sealing and qualifying run under the restricted terraform profile: a CLI configuration file or plugin cache never reaches a child, and the seal fails closed", async () => {
  for (const name of ["ALZ_DISCOVERY_TF_CLI_CONFIG_FILE", "ALZ_STATE_TF_CLI_CONFIG_FILE", "ALZ_DISCOVERY_TF_PLUGIN_CACHE_DIR", "ALZ_STATE_TF_PLUGIN_CACHE_DIR"]) {
    for (const mode of ["seal", "qualify"] as const) {
      const f = fixture({ env: { ...ENV, [name]: "/tmp/evil-mirror.tfrc" } });
      try {
        const result = mode === "seal" ? await sealPlan(f.input) : planWithoutStoring(f.input);
        assert.ok(!result.ok, name + " " + mode);
        assert.match(result.message, /ENVIRONMENT_REFUSED/, name);
        for (const call of calls()) {
          for (const variable of ["TF_CLI_CONFIG_FILE", "TF_PLUGIN_CACHE_DIR"]) assert.equal(call.env[variable], undefined, call.args[0] + " " + variable);
          assert.ok(!JSON.stringify(call.env).includes("evil-mirror"), call.args[0]);
        }
        assert.deepEqual(readdirSync(f.scratch.path), []);
      } finally { f.cleanup(); }
    }
  }
});

test("a throwaway plan has its own result shape: a sealed record and no vault path, and nothing is stored", async () => {
  const f = fixture();
  try {
    const result = planWithoutStoring(f.input);
    assert.ok(result.ok);
    assert.deepEqual(Object.keys(result).sort(), ["ok", "sealed"], "no path, not even an empty one");
    assert.equal(result.sealed.artifactSha256, computeArtifactSha256(result.sealed));
  } finally { f.cleanup(); }
  const stored = await sealed();
  const ok = stored.result as Extract<typeof stored.result, { ok: true }>;
  assert.ok(ok.path.length > 0 && readFileSync(ok.path, "utf8").length > 0);
});

test("the change list an apply derives again comes from the same extraction as the seal's, with the same pinned show and no identity", async () => {
  const { result } = await sealed();
  const ok = result as Extract<typeof result, { ok: true }>;
  const loaded = await loadSealedPlan(ok.path);
  assert.ok(loaded.ok);
  const f = fixture();
  try {
    // The work directory an apply has already initialized: the snapshot copy of the project, with .terraform built by init.
    const before = calls().length;
    const run = fixtureRun(f);
    assert.deepEqual(run.rederive(loaded.planBytes), ok.sealed.changes);
    const shown = calls().slice(before);
    assert.deepEqual(shown.map((c) => c.args), [["show", "-json", "../alz-preview.tfplan"]]);
    assert.ok(!Object.keys(shown[0].env).some((name) => /^(ARM_|AZURE_|TF_CLI_CONFIG_FILE|TF_PLUGIN_CACHE_DIR)/.test(name)));
    assert.deepEqual(readdirSync(f.scratch.path).filter((name) => name.endsWith(".tfplan")), [], "the decrypted plan is removed");
    behave({ failOn: "show" });
    assert.throws(() => run.rederive(loaded.planBytes), /EXIT_1/);
    assert.deepEqual(readdirSync(f.scratch.path).filter((name) => name.endsWith(".tfplan")), [], "removed even when show fails");
  } finally { f.cleanup(); }
});

// --- what an approver must see, and the provider half of the contract binding ---------------------

const shownWith = async (behavior: Behavior, options: Parameters<typeof fixture>[0] = {}) => {
  const f = fixture(options);
  try {
    behave({ workspace: f.input.target.workspace, ...behavior });
    return await sealPlan(f.input);
  } finally { f.cleanup(); }
};
const WORKING = { address: "azurerm_x.moved", type: "azurerm_x", previous_address: "azurerm_x.old", change: { actions: ["no-op"] } };

test("the deletion unit is verified in the plan and sealed: every created resource that carries tags must carry exactly the unit's tags; a missing, foreign or computed tag refuses the seal; untaggable types are listed", async () => {
  const f = fixture();
  const unit = f.input.unit;
  f.cleanup();
  const created = (address: string, after: Record<string, unknown>, more: Record<string, unknown> = {}) => ({ address, type: address.split(".")[0], change: { actions: ["create"], before: null, after, ...more } });
  // Tagged as required, one untaggable type, and a data source and an update that are not judged.
  const ok = await shownWith({ showResources: [
    created("azurerm_resource_group.a", { tags: { ...unit.tags, team: "CANARY_TEAM" } }), created("azurerm_role_assignment.b", { scope: "/x" }),
    { address: "data.azurerm_client_config.me", type: "azurerm_client_config", mode: "data", change: { actions: ["read"], after: { tags: {} } } },
    { address: "azurerm_storage_account.old", type: "azurerm_storage_account", change: { actions: ["update"], before: { tags: {} }, after: { tags: {} } } },
  ] });
  assert.ok(ok.ok, JSON.stringify(ok));
  assert.deepEqual(ok.sealed.unit, { unitId: unit.unitId, tags: { ...unit.tags }, untagged: ["azurerm_resource_group.pilot", "azurerm_role_assignment.b"] }, "the fixture's default resource group carries no tag attribute either");
  assert.ok(!JSON.stringify(ok.sealed).includes("CANARY_TEAM"), "only the unit's own tag keys are read; no other tag value is recorded");
  assert.equal(computeArtifactSha256({ ...ok.sealed, unit: null }) === ok.sealed.artifactSha256, false, "the unit is bound by the artifact hash");
  assert.match(unit.unitId, /^alzu-[0-9a-f]{20}$/);
  assert.deepEqual(unit.tags["alz-unit"], unit.unitId);
  // The same unit for the same contract, environment and state container; another environment is another unit.
  assert.equal(pilotUnitOf({ provider: "AZURE", contractSha256: H("9"), environment: "DEV", target: f.input.target }).unitId, unit.unitId);
  assert.notEqual(pilotUnitOf({ provider: "AZURE", contractSha256: H("9"), environment: "QA", target: f.input.target }).unitId, unit.unitId);
  for (const [label, after, more, code] of [
    ["no unit tag", { tags: { team: "x" } }, {}, "UNIT_TAG_MISSING"],
    ["another unit", { tags: { ...unit.tags, "alz-unit": "alzu-00000000000000000000" } }, {}, "UNIT_TAG_FOREIGN"],
    ["another build id", { tags: { ...unit.tags, "alz-build": "someone-else" } }, {}, "UNIT_TAG_MISSING"],
    ["tags computed at apply time", {}, { after_unknown: { tags: true } }, "UNIT_TAG_UNVERIFIABLE"],
    ["tags that are not a map", { tags: "alz" }, {}, "UNIT_TAG_MISSING"],
  ] as const) {
    const result = await shownWith({ showResources: [created("azurerm_resource_group.a", after as Record<string, unknown>, more as Record<string, unknown>)] });
    assert.ok(!result.ok && result.code === "ARTIFACT_INVALID" && result.message.includes(code), label + ": " + JSON.stringify(result));
  }
  // A record whose unit was edited or malformed is refused, as any other bound field.
  const base = (await sealed()).result as Extract<Awaited<ReturnType<typeof sealPlan>>, { ok: true }>;
  const loaded = await loadSealedPlan(base.path);
  assert.ok(loaded.ok);
  for (const unitEdit of [{ ...loaded.sealed.unit!, untagged: ["x"] }, { ...loaded.sealed.unit!, tags: { "alz-unit": "alzu-ffffffffffffffffffff" } }, { unitId: "Bad Id", tags: {}, untagged: [] }, undefined]) {
    const result = verifySealedPlan({ sealed: { ...loaded.sealed, unit: unitEdit }, planBytes: loaded.planBytes });
    assert.ok(!result.ok, JSON.stringify(unitEdit));
  }
});

test("the change list carries an import, a move, a forget and output changes, strips bidi and zero-width characters, and all of it is bound by the hashes", async () => {
  const result = await shownWith({
    showResources: [
      { address: "azurerm_x.imported", type: "azurerm_x", change: { actions: ["no-op"], importing: { id: "/subscriptions/x" } } },
      WORKING,
      { address: "azurerm_x.gone", type: "azurerm_x", change: { actions: ["forget"] } },
      { address: "azurerm_x.a\u202Eb\u200Bc\u2066d\uFEFF", type: "azurerm_x\u200F", previous_address: "azurerm_x.\u2060p", change: { actions: ["update"] } },
    ],
    showOutputChanges: { endpoint: { actions: ["update"], before: "CANARY_OUT_1", after: "CANARY_OUT_2" }, unchanged: { actions: ["no-op"] }, gone: { actions: ["delete"] } },
  });
  assert.ok(result.ok, JSON.stringify(result));
  const { sealed: s } = result;
  const byAddress = Object.fromEntries(s.changes.map((c) => [c.address, c]));
  assert.deepEqual(byAddress["azurerm_x.imported"], { address: "azurerm_x.imported", type: "azurerm_x", action: "SAME", importing: true });
  assert.deepEqual(byAddress["azurerm_x.moved"], { address: "azurerm_x.moved", type: "azurerm_x", action: "SAME", previousAddress: "azurerm_x.old" });
  assert.equal(byAddress["azurerm_x.gone"].action, "FORGET");
  assert.deepEqual(byAddress["azurerm_x.abcd"], { address: "azurerm_x.abcd", type: "azurerm_x", action: "UPDATE", previousAddress: "azurerm_x.p" }, "no invisible character survives");
  assert.deepEqual(byAddress["output.endpoint"], { address: "output.endpoint", type: "output", action: "UPDATE" });
  assert.equal(byAddress["output.gone"].action, "DELETE");
  assert.equal(byAddress["output.unchanged"], undefined, "an unchanged output is not a change");
  assert.ok(!JSON.stringify(s).includes("CANARY_OUT"), "output values are never recorded");
  assert.ok(!/[\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/.test(JSON.stringify(s.changes)));

  // The one hash covers every added field: the artifact, the review bundle and the apply's re-derivation agree.
  const bundle = reviewBundleOf(s);
  assert.equal(bundle.changesSha256, sha(canonicalJson(s.changes)));
  assert.ok(verifyReviewBundle(bundle).ok);
  for (const edit of [
    (c: SealedPlan["changes"][number]) => ({ ...c, importing: undefined }), (c: SealedPlan["changes"][number]) => ({ ...c, previousAddress: undefined }),
    (c: SealedPlan["changes"][number]) => (c.action === "FORGET" ? { ...c, action: "SAME" } : c),
  ]) {
    const edited = { ...bundle, changes: bundle.changes.map((c) => JSON.parse(JSON.stringify(edit(c))) as typeof c) };
    assert.ok(edited.changes.some((c, i) => canonicalJson(c) !== canonicalJson(bundle.changes[i])));
    const checked = verifyReviewBundle(edited);
    assert.ok(!checked.ok && checked.code === "ARTIFACT_TAMPERED");
  }
  // A QA bundle verifies once its hashes are recomputed for QA, and an unknown environment never does.
  // The requester signed the DEV artifact, so a relabeled record needs the requester's own new signature over the QA hash (a copied one is tampering).
  const qaRecord = { ...s, environment: "QA" as const };
  const qaHash = computeArtifactSha256(qaRecord);
  const qaBundle = { ...reviewBundleOf({ ...qaRecord, artifactSha256: qaHash, request: signRequest({ schemaVersion: 1, requesterId: s.requesterId, artifactSha256: qaHash, environment: "QA", nonce: s.request!.statement.nonce }, keys.carol.priv) }) };
  const relabeledOnly = verifyReviewBundle({ ...reviewBundleOf({ ...qaRecord, artifactSha256: qaHash }) });
  assert.ok(!relabeledOnly.ok && relabeledOnly.code === "ARTIFACT_TAMPERED", "the DEV request signature does not carry over to a QA relabel");
  assert.ok(verifyReviewBundle(qaBundle).ok && qaBundle.environment === "QA");
  assert.ok(!verifyReviewBundle({ ...qaBundle, environment: "STAGING" }).ok);
  assert.ok(!verifyReviewBundle({ ...qaBundle, environment: "DEV" }).ok, "relabeling a QA bundle breaks its hash");
  // A list that hides characters, adds fields or flags something other than true is not well formed.
  const planBytes = Buffer.from("x");
  for (const bad of [{ address: "a\u202Eb" }, { type: "t\u200Bx" }, { previousAddress: "p\uFEFF" }, { importing: false }, { previousAddress: "" }, { extra: 1 }]) {
    const record = { ...s, changes: [{ address: "a", type: "t", action: "SAME", ...bad }] };
    const v = verifySealedPlan({ sealed: record, planBytes });
    assert.ok(!v.ok && v.code === "ARTIFACT_INVALID", JSON.stringify(bad));
  }
});

test("a constant subscription_id or tenant_id in any azurerm provider block must equal the contract's; an expression is not judged", async () => {
  const provider = (expressions: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
    ({ azurerm: { name: "azurerm", full_name: "registry.terraform.io/hashicorp/azurerm", expressions, ...extra } });
  const other = "99999999-9999-4999-8999-999999999999";
  const cases: Array<[string, Record<string, unknown>, RegExp | undefined]> = [
    ["a matching constant, in any letter case", provider({ subscription_id: { constant_value: DEV_TARGET.account.toUpperCase() }, tenant_id: { constant_value: TENANT } }), undefined],
    ["an expression only (not checkable, not refused)", provider({ subscription_id: { references: ["var.sub"] } }), undefined],
    ["an explicit null is the same as unset", provider({ subscription_id: { constant_value: null } }), undefined],
    ["another subscription", provider({ subscription_id: { constant_value: other } }), /PROVIDER_SUBSCRIPTION_NOT_IN_CONTRACT/],
    ["another tenant", provider({ tenant_id: { constant_value: other } }), /PROVIDER_TENANT_NOT_IN_CONTRACT/],
    ["a constant that is not a string", provider({ subscription_id: { constant_value: 7 } }), /PROVIDER_SUBSCRIPTION_NOT_IN_CONTRACT/],
    ["a second, aliased block in a module", { ...provider({ subscription_id: { constant_value: DEV_TARGET.account } }), "module.m:azurerm.other": { name: "azurerm", alias: "other", module_address: "module.m", expressions: { subscription_id: { constant_value: other } } } }, /PROVIDER_SUBSCRIPTION_NOT_IN_CONTRACT/],
    ["another provider's constant is not an azurerm block", { random: { name: "random", full_name: "registry.terraform.io/hashicorp/random", expressions: { subscription_id: { constant_value: other } } } }, undefined],
  ];
  for (const [label, showProviderConfig, refusal] of cases) {
    const result = await shownWith({ showProviderConfig });
    if (refusal) {
      assert.ok(!result.ok && refusal.test(result.message), label + " " + JSON.stringify(result));
      assert.ok(!JSON.stringify(result).includes(other), "the refusal names a code, not the value");
    } else assert.ok(result.ok, label + " " + JSON.stringify(result));
  }
  // The binding is the contract's for the environment: the DEV subscription is not PROD's.
  const prod = await shownWith({ showProviderConfig: provider({ subscription_id: { constant_value: DEV_TARGET.account } }) }, { target: PROD_TARGET, environment: "PROD" });
  assert.ok(!prod.ok && /PROVIDER_SUBSCRIPTION_NOT_IN_CONTRACT/.test(prod.message));
});
