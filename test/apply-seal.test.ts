import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { computeArtifactSha256, loadSealedPlan, planWithoutStoring, rederiveChanges, reviewBundleOf, sealPlan, verifyReviewBundle, verifySealedPlan, type SealInput } from "../src/apply/seal.js";
import type { SealedPlan } from "../src/apply/types.js";
import { decryptEvidence, encryptEvidence, ensureEvidenceKey, type EvidenceEnvelope } from "../src/evidence/vault.js";
import { canonicalJson } from "../src/teardown/manifest.js";
import { createImmutableSnapshot } from "../src/teardown/snapshot.js";
import { createPrivateDirectory } from "../src/tools/private-workdir.js";
import {
  DEV_TARGET, ENGINE_VERSION, ENV, TENANT, H, PLAN_CANARY, POLICY, PROD_TARGET, QA_TARGET, VALUE_CANARY, behave as behaveIn, callsOf, installFakeTerraform, sha,
  writeProject, type Behavior,
} from "./helpers/apply-fixtures.js";

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
const calls = () => callsOf(toolDir);

function fixture(options: { target?: typeof DEV_TARGET; environment?: "DEV" | "QA" | "PROD"; mainTf?: string; env?: NodeJS.ProcessEnv; workspace?: string } = {}) {
  const target = { ...(options.target ?? DEV_TARGET), ...(options.workspace ? { workspace: options.workspace } : {}) };
  behave({ workspace: target.workspace });
  const { projectRoot, manifest } = writeProject(fresh("project"), target, options.mainTf);
  const parent = fresh("scratch");
  const snapshot = createImmutableSnapshot(projectRoot, manifest, parent);
  const scratch = createPrivateDirectory("alz-seal-", parent);
  const input: SealInput = {
    environment: options.environment ?? "DEV", target, manifest, snapshotPath: snapshot.path, scratchDir: scratch.path,
    env: options.env ?? ENV, policyVersion: POLICY, engineVersion: ENGINE_VERSION, toolDirs: [toolDir],
    pinned: { tenantId: TENANT, subscriptionId: target.account },
    now: () => new Date("2026-10-11T10:00:00.000Z"),
  };
  return { input, scratch, cleanup: () => { snapshot.remove(); scratch.remove(); } };
}

/** What `rederiveChanges` needs: the fixture's scratch directory with an (empty) work directory, as `prepareWorkspace` leaves it. */
function fixtureSession(f: ReturnType<typeof fixture>) {
  mkdirSync(join(f.scratch.path, "work"), { recursive: true });
  return { scratchDir: f.scratch.path, env: f.input.env, toolDirs: f.input.toolDirs, manifest: f.input.manifest, pinned: f.input.pinned };
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

test("the sealed record binds plan, manifest, release identity, environment, target, engine and policy; the artifact hash recomputes from them", async () => {
  const { result } = await sealed();
  const { sealed: s } = result as Extract<typeof result, { ok: true }>;
  assert.equal(s.schemaVersion, 1);
  assert.equal(s.environment, "DEV");
  assert.deepEqual(s.target, DEV_TARGET);
  assert.equal(s.engineVersion, "1.9.5");
  assert.equal(s.policyVersion, "2026-10-11.1");
  assert.equal(s.createdAt, "2026-10-11T10:00:00.000Z");
  assert.match(s.planSha256, /^[a-f0-9]{64}$/);
  assert.match(s.releaseIdentity, /^[a-f0-9]{64}$/);
  assert.equal(s.artifactSha256, computeArtifactSha256(s));
  assert.equal(s.artifactSha256, sha(JSON.stringify({
    changesSha256: sha(canonicalJson(s.changes)), engineVersion: s.engineVersion, environment: s.environment, manifestHash: s.manifestHash,
    planSha256: s.planSha256, policyVersion: s.policyVersion, releaseIdentity: s.releaseIdentity,
    target: { account: s.target.account, backend: s.target.backend, workspace: s.target.workspace },
  })), "canonical JSON of exactly these eight fields, the change list through its own hash");
  assert.deepEqual(s.changes, [
    { address: "azurerm_log_analytics_workspace.pilot", type: "azurerm_log_analytics_workspace", action: "UPDATE" },
    { address: "azurerm_resource_group.pilot", type: "azurerm_resource_group", action: "CREATE" },
  ]);
  assert.ok(!JSON.stringify(s).includes(VALUE_CANARY) && !JSON.stringify(s).includes(PLAN_CANARY));
});

test("any change to a bound field changes the artifact hash", async () => {
  const { result } = await sealed();
  const s = (result as Extract<typeof result, { ok: true }>).sealed;
  const base = s.artifactSha256;
  const variants: Partial<SealedPlan>[] = [
    { planSha256: H("a") }, { manifestHash: H("b") }, { releaseIdentity: H("c") }, { environment: "PROD" }, { environment: "QA" },
    { target: { ...s.target, workspace: "other" } }, { target: { ...s.target, account: "sub-other" } },
    { target: { ...s.target, backend: "x/y/z" } }, { engineVersion: "1.9.6" }, { policyVersion: "2026-10-12.1" },
    { changes: [] }, { changes: s.changes.slice(1) }, { changes: s.changes.map((c) => ({ ...c, action: "DELETE" })) },
    { changes: s.changes.map((c) => ({ ...c, address: c.address + "x" })) }, { changes: [...s.changes].reverse() },
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

  const changed = (await sealed({ mainTf: 'resource "azurerm_resource_group" "other" {}\n' })).result as Extract<Awaited<ReturnType<typeof sealPlan>>, { ok: true }>;
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
    const session = fixtureSession(f);
    assert.deepEqual(rederiveChanges({ ...session, planBytes: loaded.planBytes }), ok.sealed.changes);
    const shown = calls().slice(before);
    assert.deepEqual(shown.map((c) => c.args), [["show", "-json", "../alz-preview.tfplan"]]);
    assert.ok(!Object.keys(shown[0].env).some((name) => /^(ARM_|AZURE_|TF_CLI_CONFIG_FILE|TF_PLUGIN_CACHE_DIR)/.test(name)));
    assert.deepEqual(readdirSync(f.scratch.path).filter((name) => name.endsWith(".tfplan")), [], "the decrypted plan is removed");
    behave({ failOn: "show" });
    assert.throws(() => rederiveChanges({ ...session, planBytes: loaded.planBytes }), /EXIT_1/);
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
  const qaRecord = { ...s, environment: "QA" as const };
  const qaBundle = { ...reviewBundleOf({ ...qaRecord, artifactSha256: computeArtifactSha256(qaRecord) }) };
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
