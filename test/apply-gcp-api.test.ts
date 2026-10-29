import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { transformSync } from "esbuild";

import { cleanupScopeProblem } from "../src/apply/driver.js";
import { engineSpec } from "../src/apply/engine-spec.js";
import * as engineModule from "../src/apply/engines/gcp-api.js";
import {
  GCP_API_MODULE_FILES, REQUEST_TIMEOUT_MS, SETTLE_READS, STORAGE_POLICY_PROPERTY, TOPIC_TYPE, allowedRequest, artifactOf, checkRequest, fetchGcpHttp, gcpApiEngine,
  loadedModuleRoot, moduleClosureSha256, rederiveArtifact, tokenRefusal, topicUrl, type GcpApiEngineSpec, type GcpApiUnit,
} from "../src/apply/engines/gcp-api.js";
import { GCP_API_BACKEND_SENTINEL, GCP_API_TARGET, PARENT_LABEL } from "../src/apply/gcp-api-target.js";
import { checkApplyIdentities } from "../src/apply/identities.js";
import { GCP } from "../src/apply/providers/gcp.js";
import { DELIVERY_PATHS } from "../src/apply/token-delivery.js";
import type { PlanChange } from "../src/apply/types.js";
import { pilotUnitOf } from "../src/apply/unit.js";
import { blueprintFromGcpApiTopic } from "../src/observe/blueprint.js";
import { createDiscoveryGcpReader, readerFailure } from "../src/observe/gcp-rest.js";
import { observeBlueprint } from "../src/observe/verify.js";
import type { ResolvedTarget } from "../src/teardown/driver/types.js";
import { buildManifest, canonicalJson } from "../src/teardown/manifest.js";
import { captureProjectFiles } from "../src/teardown/snapshot.js";
import { inMemoryEmulator, writeIdentities, type Roles } from "./helpers/gcp-api-emulator.js";

/**
 * SYNTHETIC evidence only (docs/act-pilot-gcp-api.md, "Evidence"). The GCP_API engine spec (lane G2; docs/act-pilot-gcp-api-driver.md
 * D1 to D20) against an in-memory emulator of STS, IAM Credentials, Pub/Sub and Cloud Asset (test/helpers/gcp-api-emulator.ts). No
 * Google service, identity or network is used. These are the engine's unit cases: each spec is constructed directly with its own
 * emulator, and `inDriverOrder` and `cleanupInDriverOrder` step it in `runApply`'s and `runCleanup`'s order and refusal mapping
 * (src/apply/driver.ts) so a case can stop at one step. They are a harness for the engine, not evidence of the driver: the driver itself
 * runs the registered spec end to end (seal, apply, observe, propose, cleanup, leftovers, the kill switch and the N1 interrupt) in
 * test/apply-emulated-gcp-api.test.ts (INT-2, #357 review N3).
 */

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const PROJECT = "examplefake-dev";
const REGION = "europe-west4";
const PREFIX = "alz-act-dev1-";
const AUDIENCE = "//iam.googleapis.com/projects/123456789012/locations/global/workloadIdentityPools/alz-pilot-dev/providers/oidc";
const TARGET: ResolvedTarget = { account: PROJECT, backend: GCP_API_BACKEND_SENTINEL, workspace: "default" };
const CANARY = { resources: [{ type: "google_pubsub_topic", count: 1 }] };
const PINNED = { projectId: PROJECT, region: REGION, parent: "folders/123456789", backend: GCP_API_BACKEND_SENTINEL, workspace: "default", topicPrefix: PREFIX, canary: CANARY };
const CONTRACT_SHA = "c".repeat(64);
const PUBSUB_SCOPE = "https://www.googleapis.com/auth/pubsub";
const PLATFORM_SCOPE = "https://www.googleapis.com/auth/cloud-platform";

type Pinned = Record<string, unknown>;

/** One isolated world: two WIF identities, the in-memory Google, a `request.json` project, its manifest, the unit and the spec. */
function world(options: { request?: string; extraFile?: boolean; roles?: (email: (n: string) => string) => Roles } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "alz-gcp-api-"));
  const ids = writeIdentities(join(dir, "identities"), PROJECT, AUDIENCE);
  const roles: Roles = options.roles?.(ids.email) ?? {
    [ids.email("DISCOVERY")]: ["pubsub.topics.get", "cloudasset.assets.searchAllResources"],
    [ids.email("APPLY")]: ["pubsub.topics.create", "pubsub.topics.delete"],
  };
  const google = inMemoryEmulator(ids.trust, roles);
  const project = join(dir, "project");
  mkdirSync(project);
  writeFileSync(join(project, "request.json"), options.request ?? JSON.stringify({ schemaVersion: 1, kind: "PUBSUB_TOPIC" }) + "\n");
  if (options.extraFile) writeFileSync(join(project, "main.tf"), "# not allowed\n");
  const manifest = buildManifest({ engine: "GCP_API", mode: "PROJECT", target: TARGET, unitHash: "1".repeat(64), files: captureProjectFiles(project), policyVersion: "2026-10-29.1", engineVersion: "gcp-api-1", providers: [], dependencies: [], inputs: [] } as never);
  const unit = pilotUnitOf({ provider: "GCP", contractSha256: CONTRACT_SHA, environment: "DEV", target: TARGET, engine: "GCP_API" });
  const spec = gcpApiEngine({ http: google.http, settleDelayMs: 0 });
  const scratchDir = join(dir, "scratch");
  mkdirSync(scratchDir);
  const base = (pinned: Pinned = PINNED) => ({ scratchDir, env: ids.env, manifest, pinned: pinned as never, spec: GCP, target: { ...TARGET }, engineVersion: "gcp-api-1" });
  return {
    dir, ids, google, project, manifest, unit, spec, scratchDir,
    planInput: (pinned: Pinned = PINNED, engineVersion = "gcp-api-1") => ({ ...base(pinned), engineVersion, snapshotPath: project, unit }),
    runInput: (sealedUnit: GcpApiUnit | undefined, pinned: Pinned = PINNED) => ({ ...base(pinned), ...(sealedUnit ? { unit: sealedUnit } : {}) }),
  };
}
type World = ReturnType<typeof world>;
type Sealed = { bytes: Buffer; changes: PlanChange[]; unit: GcpApiUnit; topicId: string; url: string; name: string };

async function seal(w: World, pinned: Pinned = PINNED): Promise<Sealed> {
  const plan = await w.spec.plan(w.planInput(pinned));
  assert.ok(plan.unit);
  const parsed = JSON.parse(plan.artifact.toString("utf8")) as { topicId: string };
  return { bytes: plan.artifact, changes: plan.changes, unit: { unitId: plan.unit.unitId, tags: plan.unit.tags }, topicId: parsed.topicId, url: topicUrl(PROJECT, parsed.topicId), name: "projects/" + PROJECT + "/topics/" + parsed.topicId };
}
const codeOf = async (promise: Promise<unknown>): Promise<string> => { try { await promise; return "NO_REFUSAL"; } catch (error) { return (error as Error).message; } };

type Ended =
  | { refused: string; consumed: false }
  | { refused: "APPROVALS_SPENT" | "KILL_SWITCH_AFTER_APPROVALS"; code?: string; consumed: true }
  | { outcome: string; consumed: true; run: ReturnType<GcpApiEngineSpec["openApply"]> };

/**
 * The spec's apply steps in `runApply`'s order and refusal mapping (src/apply/driver.ts, steps 11 to 15): `prepare` and `rederive`
 * (a throw is a refusal with nothing consumed), the change list compared with the sealed one, the approvals consumed, `execute` (a
 * throw is APPROVALS_SPENT, `notStarted` is KILL_SWITCH_AFTER_APPROVALS), then `settle`.
 */
async function inDriverOrder(w: World, sealed: Pick<Sealed, "bytes" | "changes" | "unit">, options: { stopWhen?: () => boolean; pinned?: Pinned; beforeExecute?: () => void } = {}): Promise<Ended> {
  const run = w.spec.openApply(w.runInput(sealed.unit, options.pinned));
  let derived: PlanChange[];
  try {
    await run.prepare(w.project);
    derived = await run.rederive(sealed.bytes);
  } catch (error) { return { refused: (error as Error).message, consumed: false }; }
  if (canonicalJson(derived) !== canonicalJson(sealed.changes)) return { refused: "ARTIFACT_TAMPERED", consumed: false };
  options.beforeExecute?.();
  let applied;
  try { applied = await run.execute(sealed.bytes, { stopWhen: options.stopWhen ?? (() => false) }); } catch (error) { return { refused: "APPROVALS_SPENT", code: (error as Error).message, consumed: true }; }
  if (applied.notStarted) return { refused: "KILL_SWITCH_AFTER_APPROVALS", consumed: true };
  const end = await run.settle(applied);
  return { outcome: "stale" in end ? "FAILED_NO_CHANGE" : end.outcome, consumed: true, run };
}

type CleanupEnded =
  | { refused: string; consumed: false }
  | { refused: "APPROVALS_SPENT" | "KILL_SWITCH_AFTER_APPROVALS"; consumed: true }
  | { outcome: string; consumed: true; deletedByRun: boolean | undefined };

/** The cleanup steps in `runCleanup`'s order: `prepare`, `planDestroy`, the driver's scope check, consumption, `execute`, `settle`. */
async function cleanupInDriverOrder(w: World, addresses: string[], unit: GcpApiUnit | undefined, options: { stopWhen?: () => boolean; pinned?: Pinned; beforeExecute?: () => void } = {}): Promise<CleanupEnded> {
  const run = w.spec.openCleanup(w.runInput(unit, options.pinned));
  let planned: PlanChange[];
  try {
    await run.prepare(w.project);
    planned = await run.planDestroy(addresses);
  } catch (error) { return { refused: (error as Error).message, consumed: false }; }
  const scope = cleanupScopeProblem(planned, addresses);
  if (scope) return { refused: "PROPOSAL_SCOPE_MISMATCH", consumed: false };
  options.beforeExecute?.();
  let destroyed;
  try { destroyed = await run.execute({ stopWhen: options.stopWhen ?? (() => false) }); } catch { return { refused: "APPROVALS_SPENT", consumed: true }; }
  if (destroyed.notStarted) return { refused: "KILL_SWITCH_AFTER_APPROVALS", consumed: true };
  const end = await run.settle(destroyed);
  return { outcome: "stale" in end ? "FAILED_NO_CHANGE" : end.outcome, consumed: true, deletedByRun: run.deletedByRun() };
}

const puts = (w: World): number => w.google.log().filter((e) => e.host === "pubsub.googleapis.com" && e.method === "PUT").length;
const deletes = (w: World): number => w.google.log().filter((e) => e.host === "pubsub.googleapis.com" && e.method === "DELETE").length;
/** No subject token, federated token or access token in anything the engine returns. */
function assertNoSecrets(w: World, ...values: unknown[]): void {
  const text = JSON.stringify(values, (_key, value) => (Buffer.isBuffer(value) ? value.toString("utf8") : value));
  for (const subject of Object.values(w.ids.subjectOf)) assert.ok(!text.includes(subject), "a subject token leaked");
  assert.ok(!/\b(?:fed|sa)-[0-9a-f]{24}\b/.test(text), "an emulated access token leaked");
}
async function applied(w: World): Promise<Sealed> {
  const sealed = await seal(w);
  const ended = await inDriverOrder(w, sealed);
  assert.ok("outcome" in ended && ended.outcome === "SUCCEEDED", JSON.stringify(ended));
  return sealed;
}

/* ------------------------------------------------------------------ the spec's facts */

test("SYNTHETIC: the spec is GCP_API on GCP, the shared target shape, two identities, one reviewed canary type, and registered as exactly this spec (INT-2)", () => {
  const spec = gcpApiEngine();
  assert.equal(spec.id, "GCP_API");
  assert.deepEqual(spec.providers, ["GCP"]);
  assert.equal(spec.target, GCP_API_TARGET, "D4/D9: the shared target shape, topicPrefix a location field");
  assert.deepEqual(spec.target?.locationFields, ["topicPrefix"]);
  // D12: DISCOVERY and APPLY only, the same identities the delivery runner delivers for this path.
  assert.deepEqual(spec.identities, ["DISCOVERY", "APPLY"]);
  assert.deepEqual(spec.attests, ["DISCOVERY", "APPLY"]);
  assert.deepEqual(DELIVERY_PATHS["gcp-api"].identities, spec.identities);
  assert.equal(DELIVERY_PATHS["gcp-api"].engine, spec.id);
  // D1: no external program.
  assert.deepEqual(spec.executables, []);
  assert.equal(spec.embedsStateWrite, undefined, "there is no state backend");
  assert.equal(spec.manifestMode, "PROJECT");
  // D8: exactly the reviewed type; a wildcard, a pattern, the Cloud Asset name or another type is never a canary type.
  assert.equal(spec.canaryTypeOk?.("google_pubsub_topic"), true);
  for (const other of ["*", "google_pubsub_*", "pubsub.googleapis.com/Topic", "google_pubsub_subscription", "google_pubsub_topic_iam_member", "GOOGLE_PUBSUB_TOPIC"]) assert.equal(spec.canaryTypeOk?.(other), false, other);
  // D16: the two evidence values.
  assert.equal(spec.mutation, "GCP_PUBSUB_TOPIC_CREATE_OF_SEALED_REQUEST");
  assert.equal(spec.cleanupMutation, "GCP_PUBSUB_TOPIC_DELETE_OF_RUN_TOPIC");
  assert.ok(spec.cleanupAdapter && spec.openCleanup, "the cleanup path the owner accepted (D16)");
  for (const adapter of [spec.previewAdapter(), spec.applyAdapter, spec.cleanupAdapter!]) assert.equal(adapter.engine, "GCP_API");
  assert.equal(new Set([spec.previewAdapter().argvDigest, spec.applyAdapter.argvDigest, spec.cleanupAdapter!.argvDigest]).size, 3, "each adapter is qualified on its own");
  assert.deepEqual(spec.recoveryFileNames, []);
  assert.match(spec.notices.sealReads, new RegExp(PARENT_LABEL), "D9: parent is shown only as owner-declared, not observed");
  assert.match(spec.notices.applyNote, /not a data-residency claim/, "D11: no data-residency claim");
  assert.equal(STORAGE_POLICY_PROPERTY, "messageStoragePolicy.allowedPersistenceRegions");
  // Registered by INT-2 (owner decision 6483993252): the driver loads exactly the production spec for a GCP_API contract.
  assert.equal(engineSpec("GCP_API"), engineModule.GCP_API);
  assert.notEqual(engineSpec("GCP_API"), engineSpec("TERRAFORM"), "GCP_API is never GCP Terraform");
});

test("SYNTHETIC: D19: the standalone functions, the engine's own ledger, signature and kill switch are gone; the module writes no file", () => {
  for (const removed of ["sealGcpApiPlan", "verifyGcpApiPlan", "applyGcpApiPlan", "observeGcpApiPlan", "cleanupGcpApiPlan"]) assert.equal((engineModule as Record<string, unknown>)[removed], undefined, removed);
  const source = readFileSync(join(ROOT, "src", "apply", "engines", "gcp-api.ts"), "utf8");
  for (const gone of ["signRequest", "verifyRequestSignature", "requesterKeyRefusal", "requesterRefusal", "ledgerDir", "sealNonce", "killSwitch", "CallEvidence"]) assert.ok(!source.includes(gone), gone);
  // The only fs function the engine imports reads.
  const fsImport = /import \{([^}]*)\} from "node:fs";/.exec(source)?.[1].split(",").map((name) => name.trim()).filter(Boolean);
  assert.deepEqual(fsImport, ["readFileSync"]);
});

/* ------------------------------------------------------------------ D1: the module hash */

/** The real runtime import closure of the engine, as the running product loads it: esbuild's emit (as tsx runs it) drops type-only imports. */
function importClosure(): string[] {
  const src = join(ROOT, "src");
  const seen = new Set<string>();
  const todo = [join(src, "apply", "engines", "gcp-api.ts")];
  while (todo.length > 0) {
    const file = todo.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const js = transformSync(readFileSync(file, "utf8"), { loader: "ts", format: "esm", target: "es2022" }).code;
    for (const m of js.matchAll(/(?:^|\n)\s*(?:import|export)\s[^;]*?from\s+"(\.[^"]+)"|(?:^|\n)\s*import\s+"(\.[^"]+)"/g)) {
      const next = resolve(dirname(file), (m[1] ?? m[2]).replace(/\.js$/, ".ts"));
      assert.ok(existsSync(next), next);
      todo.push(next);
    }
  }
  return [...seen].map((file) => relative(src, file).replace(/\.ts$/, "")).sort();
}

test("SYNTHETIC: D1: the reviewed module list is exactly the engine's runtime import closure", () => {
  assert.deepEqual([...GCP_API_MODULE_FILES].sort(), importClosure(), "an import was added or removed: update GCP_API_MODULE_FILES in review");
});

test("SYNTHETIC: D1: the READY hash is the IN_PROCESS_MODULE preimage, moves with any listed file, and is undefined when one is missing", () => {
  const { root, extension } = loadedModuleRoot();
  assert.equal(root, join(ROOT, "src"));
  assert.equal(extension, ".ts");
  const hash = gcpApiEngine().binarySha256(undefined, {});
  assert.match(hash ?? "", /^[0-9a-f]{64}$/);
  const preimage = canonicalJson({
    kind: "IN_PROCESS_MODULE", engine: "GCP_API",
    files: [...GCP_API_MODULE_FILES].sort().map((file) => ({ path: file + ".ts", sha256: createHashHex(readFileSync(join(root, file + ".ts"))) })),
  });
  assert.equal(hash, createHashHex(preimage), "the named preimage, sorted by path");
  // A copy of the closure: each listed file changed in turn changes the hash; a missing one gives undefined.
  const copy = mkdtempSync(join(tmpdir(), "alz-gcp-api-closure-"));
  for (const file of GCP_API_MODULE_FILES) { mkdirSync(dirname(join(copy, file + ".ts")), { recursive: true }); cpSync(join(root, file + ".ts"), join(copy, file + ".ts")); }
  assert.equal(moduleClosureSha256(copy, ".ts"), hash);
  for (const file of GCP_API_MODULE_FILES) {
    const path = join(copy, file + ".ts");
    const original = readFileSync(path);
    writeFileSync(path, Buffer.concat([original, Buffer.from("\n")]));
    assert.notEqual(moduleClosureSha256(copy, ".ts"), hash, file);
    writeFileSync(path, original);
  }
  assert.equal(moduleClosureSha256(copy, ".ts"), hash);
  rmSync(join(copy, "observe", "gcp-rest.ts"));
  assert.equal(moduleClosureSha256(copy, ".ts"), undefined, "a missing file is never 'unknown, go ahead'");
  assert.equal(moduleClosureSha256(copy, ".js"), undefined, "the packaged extension is read as loaded, never mixed");
  rmSync(copy, { recursive: true, force: true });
});
const createHashHex = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");

/* ------------------------------------------------------------------ D7: the request and the artifact */

test("SYNTHETIC: D7: the request is exactly { schemaVersion: 1, kind: PUBSUB_TOPIC } in the project's one file, and the committed example passes", async () => {
  assert.deepEqual(checkRequest(JSON.parse(readFileSync(join(ROOT, "qualification", "gcp", "act-dev1-canary-api", "request.json"), "utf8"))), { schemaVersion: 1, kind: "PUBSUB_TOPIC" });
  const cases: [string, Parameters<typeof world>[0], string][] = [
    ["another key", { request: JSON.stringify({ schemaVersion: 1, kind: "PUBSUB_TOPIC", topicId: "alz-mine" }) }, "FIELD_NOT_ALLOWED"],
    ["a requester storage policy", { request: JSON.stringify({ schemaVersion: 1, kind: "PUBSUB_TOPIC", messageStoragePolicy: {} }) }, "FIELD_NOT_ALLOWED"],
    ["another kind", { request: JSON.stringify({ schemaVersion: 1, kind: "STORAGE_BUCKET" }) }, "KIND_NOT_ALLOWED"],
    ["another schema", { request: JSON.stringify({ schemaVersion: 2, kind: "PUBSUB_TOPIC" }) }, "REQUEST_INVALID"],
    ["not JSON", { request: "{ kind: PUBSUB_TOPIC" }, "REQUEST_INVALID"],
    ["an array", { request: "[]" }, "REQUEST_INVALID"],
    ["another file in the project", { extraFile: true }, "PROJECT_NOT_ALLOWED"],
  ];
  for (const [label, options, code] of cases) {
    const w = world(options);
    assert.equal(await codeOf(w.spec.plan(w.planInput())), code, label);
    assert.equal(w.google.log().length, 0, label + ": refused before any request");
  }
  const w = world();
  assert.equal(await codeOf(w.spec.plan(w.planInput(PINNED, "gcp-api-2"))), "ENGINE_VERSION_NOT_SUPPORTED");
});

test("SYNTHETIC: D7/D11/D13: the artifact is the canonical JSON of exactly the three derived calls, with the contract region's storage policy; one CREATE line", async () => {
  const w = world();
  const sealed = await seal(w);
  const labels = { ...w.unit.tags };
  const policy = { allowedPersistenceRegions: [REGION] };
  assert.deepEqual(JSON.parse(sealed.bytes.toString("utf8")), {
    schemaVersion: 1, kind: "GCP_API_PUBSUB_TOPIC", projectId: PROJECT, topicId: sealed.topicId, labels, messageStoragePolicy: policy, precondition: "ABSENT",
    create: { method: "PUT", url: sealed.url, body: { labels, messageStoragePolicy: policy } },
    readBack: { method: "GET", url: sealed.url },
    cleanup: { method: "DELETE", url: sealed.url },
  });
  assert.equal(sealed.bytes.toString("utf8"), canonicalJson(artifactOf({ projectId: PROJECT, region: REGION, topicPrefix: PREFIX }, labels, sealed.topicId)));
  assert.deepEqual(sealed.changes, [{ address: "google_pubsub_topic." + sealed.topicId, type: "google_pubsub_topic", action: "CREATE" }]);
  assert.deepEqual(sealed.unit, { unitId: w.unit.unitId, tags: w.unit.tags });
  // D13: under DISCOVERY the exact topic read absent and the unit sweep ran; nothing but reads, and APPLY made no call at seal.
  const log = w.google.log();
  assert.deepEqual(log.filter((e) => e.host === "pubsub.googleapis.com").map((e) => [e.method, e.path, e.status, e.sa]), [["GET", "/v1/" + sealed.name, 404, w.ids.email("DISCOVERY")]]);
  assert.ok(log.some((e) => e.host === "cloudasset.googleapis.com" && e.status === 200 && e.sa === w.ids.email("DISCOVERY")));
  assert.ok(!log.some((e) => e.host === "iamcredentials.googleapis.com" && e.path.includes("alz-pilot-dev-apply@")), "APPLY makes no call at seal");
  assert.equal(readdirSync(w.scratchDir).length, 0, "the engine writes no file");
  assertNoSecrets(w, sealed);
});

test("SYNTHETIC: D7: rederive refuses anything not byte-identical to what the contract, the unit and the sealed suffix derive", async () => {
  const w = world();
  const sealed = await seal(w);
  const target = { projectId: PROJECT, region: REGION, topicPrefix: PREFIX };
  const labels = { ...w.unit.tags };
  assert.equal(rederiveArtifact(sealed.bytes, target, labels).topicId, sealed.topicId);
  const edit = (change: (a: Record<string, any>) => void): Buffer => { const a = JSON.parse(sealed.bytes.toString("utf8")); change(a); return Buffer.from(canonicalJson(a)); };
  const forged: [string, Buffer][] = [
    ["another create URL", edit((a) => { a.create.url = topicUrl(PROJECT, PREFIX + "000000000000"); })],
    ["another cleanup URL", edit((a) => { a.cleanup.url = topicUrl("someone-elses", sealed.topicId); })],
    ["a lookalike host", edit((a) => { a.create.url = a.create.url.replace("pubsub.googleapis.com", "pubsub.googleapis.com.evil.example"); })],
    ["another method", edit((a) => { a.cleanup.method = "POST"; })],
    ["an extra body field", edit((a) => { a.create.body.kmsKeyName = "projects/x/locations/y/keyRings/z/cryptoKeys/k"; })],
    ["another label", edit((a) => { a.create.body.labels["alz-unit"] = "alzu-ffffffffffffffffffff"; })],
    ["another storage policy", edit((a) => { a.create.body.messageStoragePolicy.allowedPersistenceRegions = ["us-central1"]; })],
    ["no storage policy", edit((a) => { delete a.create.body.messageStoragePolicy; })],
    ["an extra call", edit((a) => { a.publish = { method: "POST", url: a.create.url + ":publish" }; })],
    ["a topic outside the prefix", edit((a) => { a.topicId = "alz-other-" + sealed.topicId.slice(-12); })],
    ["a suffix that is not 12 hex", edit((a) => { a.topicId = PREFIX + "zzzzzzzzzzzz"; })],
    ["the same JSON, not canonical", Buffer.from(JSON.stringify(JSON.parse(sealed.bytes.toString("utf8")), null, 2))],
  ];
  for (const [label, bytes] of forged) {
    assert.throws(() => rederiveArtifact(bytes, target, labels), /ARTIFACT_TAMPERED/, label);
    const ended = await inDriverOrder(w, { ...sealed, bytes });
    assert.deepEqual(ended, { refused: "ARTIFACT_TAMPERED", consumed: false }, label);
  }
  // A plan renamed consistently to another suffix derives its own change list, which is not the sealed one: the driver's comparison refuses it.
  const renamed = Buffer.from(sealed.bytes.toString("utf8").split(sealed.topicId).join(PREFIX + "0123456789ab"));
  assert.equal(rederiveArtifact(renamed, target, labels).topicId, PREFIX + "0123456789ab");
  assert.deepEqual(await inDriverOrder(w, { ...sealed, bytes: renamed }), { refused: "ARTIFACT_TAMPERED", consumed: false });
  assert.equal(puts(w), 0, "nothing was created");
});

/* ------------------------------------------------------------------ D4: the name */

test("SYNTHETIC: D4: the suffix is drawn once at seal; every seal is a new name; apply and retry reuse the sealed name and never regenerate it", async () => {
  const w = world();
  const a = await seal(w);
  const b = await seal(w);
  for (const s of [a, b]) {
    assert.match(s.topicId, /^alz-act-dev1-[0-9a-f]{12}$/);
    assert.equal(s.changes[0].address, "google_pubsub_topic." + s.topicId, "the change list approvers read names the full topic");
  }
  assert.notEqual(a.topicId, b.topicId);
  // Stopped after the approvals were consumed and before the PUT: the reservation is given back and the same plan reapplies, same name.
  const stopped = await inDriverOrder(w, a, { stopWhen: () => true });
  assert.deepEqual(stopped, { refused: "KILL_SWITCH_AFTER_APPROVALS", consumed: true });
  w.ids.env.ALZ_APPLY_GOOGLE_IMPERSONATE_SERVICE_ACCOUNT = w.ids.email("NOBODY");
  const spent = await inDriverOrder(w, a);
  assert.equal(spent.refused, "APPROVALS_SPENT");
  w.ids.env.ALZ_APPLY_GOOGLE_IMPERSONATE_SERVICE_ACCOUNT = w.ids.email("APPLY");
  assert.equal(puts(w), 0);
  const again = await inDriverOrder(w, a);
  assert.ok("outcome" in again && again.outcome === "SUCCEEDED");
  const created = w.google.log().filter((e) => e.method === "PUT");
  assert.deepEqual(created.map((e) => e.path), ["/v1/" + a.name], "the one PUT went to the exact sealed name");
  assert.deepEqual([...w.google.topics.keys()], [a.name]);
});

/* ------------------------------------------------------------------ D8, D9: the canary and the target */

test("SYNTHETIC: D8: the canary is google_pubsub_topic x1, create only, judged at seal and again at apply", async () => {
  const w = world();
  const cases: [string, unknown, string][] = [
    ["no canary", undefined, "CANARY_ALLOWLIST_MISSING"],
    ["an empty canary", { resources: [] }, "CANARY_ALLOWLIST_MISSING"],
    ["count 2", { resources: [{ type: "google_pubsub_topic", count: 2 }] }, "RESOURCE_NOT_IN_CANARY"],
    ["count 0", { resources: [{ type: "google_pubsub_topic", count: 0 }] }, "RESOURCE_NOT_IN_CANARY"],
    ["another type", { resources: [{ type: "google_storage_bucket", count: 1 }] }, "RESOURCE_NOT_IN_CANARY"],
    ["the Cloud Asset name", { resources: [{ type: "pubsub.googleapis.com/Topic", count: 1 }] }, "RESOURCE_NOT_IN_CANARY"],
  ];
  for (const [label, canary, code] of cases) {
    assert.equal(await codeOf(w.spec.plan(w.planInput({ ...PINNED, canary }))), code, label);
  }
  assert.equal(w.google.log().length, 0, "the canary is judged before any request");
  const sealed = await seal(w);
  for (const [label, canary, code] of cases) {
    assert.deepEqual(await inDriverOrder(w, sealed, { pinned: { ...PINNED, canary } }), { refused: code, consumed: false }, label + " at apply");
  }
  assert.equal(puts(w), 0);
});

test("SYNTHETIC: D9: a target that is not the sentinel backend, the default workspace, a valid prefix or the resolved target is refused", async () => {
  const w = world();
  const cases: [string, Pinned][] = [
    ["a state bucket as backend", { ...PINNED, backend: "examplefake-dev-state/pilot/dev" }],
    ["a topic id as backend", { ...PINNED, backend: "alz-act-dev1-0123456789ab" }],
    ["another workspace", { ...PINNED, workspace: "dev" }],
    ["a prefix without the trailing dash", { ...PINNED, topicPrefix: "alz-act-dev1" }],
    ["a prefix outside alz-", { ...PINNED, topicPrefix: "goog-act-" }],
    ["no prefix", { ...PINNED, topicPrefix: undefined }],
    ["another project than the resolved target", { ...PINNED, projectId: "examplefake-qa" }],
    ["a malformed region", { ...PINNED, region: "Europe West 4" }],
  ];
  for (const [label, pinned] of cases) assert.equal(await codeOf(w.spec.plan(w.planInput(pinned))), "TARGET_NOT_IN_CONTRACT", label);
  assert.equal(w.google.log().length, 0);
});

/* ------------------------------------------------------------------ D10: one open run per target */

test("SYNTHETIC: D10: the topic must read absent and the unit sweep complete and empty, at seal and again before any approval is consumed", async () => {
  const w = world();
  // At seal.
  w.google.behave({ asset: { status: 403 } });
  assert.equal(await codeOf(w.spec.plan(w.planInput())), "UNIT_LISTING_INCOMPLETE");
  w.google.behave({ asset: { status: 503 } });
  assert.equal(await codeOf(w.spec.plan(w.planInput())), "UNIT_LISTING_INCOMPLETE");
  w.google.behave({ asset: { incomplete: true } });
  assert.equal(await codeOf(w.spec.plan(w.planInput())), "UNIT_LISTING_INCOMPLETE");
  w.google.behave({ get: { status: 403 } });
  assert.equal(await codeOf(w.spec.plan(w.planInput())), "ACCESS_DENIED_PUBSUB_HTTP_403", "an unreadable topic is never absent");
  w.google.behave({ get: { status: 500 } });
  assert.equal(await codeOf(w.spec.plan(w.planInput())), "HTTP_ERROR_PUBSUB_HTTP_500");
  w.google.behave({});
  const earlier = "projects/" + PROJECT + "/topics/" + PREFIX + "aaaaaaaaaaaa";
  w.google.topics.set(earlier, { name: earlier, labels: { ...w.unit.tags }, messageStoragePolicy: { allowedPersistenceRegions: [REGION] } });
  assert.equal(await codeOf(w.spec.plan(w.planInput())), "UNIT_NOT_EMPTY", "an earlier run's topic is cleaned up first");
  w.google.topics.clear();

  // At apply, in prepare and rederive, with nothing consumed.
  const sealed = await seal(w);
  for (const [label, behavior, code] of [
    ["sweep refused", { asset: { status: 403 } }, "UNIT_LISTING_INCOMPLETE"],
    ["sweep incomplete", { asset: { incomplete: true } }, "UNIT_LISTING_INCOMPLETE"],
    ["topic unreadable", { get: { status: 429 } }, "THROTTLED_PUBSUB_HTTP_429"],
  ] as const) {
    w.google.behave(behavior);
    assert.deepEqual(await inDriverOrder(w, sealed), { refused: code, consumed: false }, label);
  }
  w.google.behave({});
  w.google.topics.set(sealed.name, { name: sealed.name, labels: { other: "owner" } });
  assert.deepEqual(await inDriverOrder(w, sealed), { refused: "PLAN_STALE", consumed: false }, "the sealed topic exists (unlabeled, so the sweep does not list it): a stale plan");
  w.google.topics.clear();
  assert.equal(puts(w), 0);
});

test("SYNTHETIC: D10: two plans sealed back to back: once the first one's topic is listed, the second apply is refused in prepare with nothing consumed", async () => {
  const w = world();
  const first = await seal(w);
  const second = await seal(w);
  assert.ok("outcome" in (await inDriverOrder(w, first)));
  assert.deepEqual(await inDriverOrder(w, second), { refused: "UNIT_NOT_EMPTY", consumed: false });
  assert.equal(puts(w), 1);
  assert.equal(await codeOf(w.spec.plan(w.planInput())), "UNIT_NOT_EMPTY", "a third seal waits for the first run's cleanup");
});

test("SYNTHETIC: D10 residual, stated plainly: inside Cloud Asset's indexing window both applies create a topic, and each run owns only its own", async () => {
  const w = world();
  const first = await seal(w);
  const second = await seal(w);
  assert.ok("outcome" in (await inDriverOrder(w, first)));
  // The first topic exists but is not indexed yet (GF5): neither sweep sees it.
  w.google.behave({ unindexed: [first.name] });
  const ended = await inDriverOrder(w, second);
  assert.ok("outcome" in ended && ended.outcome === "SUCCEEDED");
  assert.equal(w.google.topics.size, 2, "two canary topics of one target briefly coexist; the design does not claim otherwise");
  // Once indexed, each run's observation lists the other run's topic as unexpected, so its verdict is FAILED and the overlap is in evidence.
  w.google.behave({});
  const reader = createDiscoveryGcpReader({ env: w.ids.env, projectId: PROJECT, storagePolicyRegion: REGION, http: w.google.http });
  const blueprint = blueprintFromGcpApiTopic((await (ended as { run: ReturnType<GcpApiEngineSpec["openApply"]> }).run.stateDocument())!.document, second.changes, { project: PROJECT });
  const report = await observeBlueprint(blueprint, { unitId: second.unit.unitId, reader: reader.reader });
  reader.close();
  assert.equal(report.verdict, "FAILED");
  assert.deepEqual(report.unexpected, [first.name]);
});

/* ------------------------------------------------------------------ D14: the outcome table */

test("SYNTHETIC: D14: every row of the apply outcome table, each with exactly one PUT, and never KILLED", async () => {
  type Row = [string, Parameters<World["google"]["behave"]>[0], string];
  const rows: Row[] = [
    ["200, present with the sealed labels and policy", {}, "SUCCEEDED"],
    ["200, present with other labels", { createLabels: { "alz-managed-by": "alz", "alz-unit": "alzu-ffffffffffffffffffff", "alz-build": "alz-pilot-dev-cccccccccccc" } }, "PARTIAL_REQUIRES_REVIEW"],
    ["200, present with another storage policy (D11)", { createRegions: ["us-central1"] }, "PARTIAL_REQUIRES_REVIEW"],
    ["200, present with no storage policy (D11)", { createRegions: null }, "PARTIAL_REQUIRES_REVIEW"],
    ["200, absent on every read", { put: { status: 200 } }, "PARTIAL_REQUIRES_REVIEW"],
    ["200, unreadable", { get: { status: 500 } }, "PARTIAL_REQUIRES_REVIEW"],
    ["409 ALREADY_EXISTS", { put: { status: 409, create: true } }, "PARTIAL_REQUIRES_REVIEW"],
    ["400, absent on every read", { put: { status: 400 } }, "FAILED_NO_CHANGE"],
    ["401, absent on every read", { put: { status: 401 } }, "FAILED_NO_CHANGE"],
    ["403, absent on every read", { put: { status: 403 } }, "FAILED_NO_CHANGE"],
    ["404, absent on every read", { put: { status: 404 } }, "FAILED_NO_CHANGE"],
    ["429, absent on every read", { put: { status: 429 } }, "FAILED_NO_CHANGE"],
    ["403, present", { put: { status: 403, create: true } }, "PARTIAL_REQUIRES_REVIEW"],
    ["400, unreadable", { put: { status: 400 }, get: { status: 503 } }, "PARTIAL_REQUIRES_REVIEW"],
    ["500, present with the sealed labels and policy", { put: { status: 500, create: true } }, "SUCCEEDED"],
    ["503, present with another policy", { put: { status: 503, create: true }, createRegions: ["us-east1"] }, "PARTIAL_REQUIRES_REVIEW"],
    ["500, absent", { put: { status: 500 } }, "PARTIAL_REQUIRES_REVIEW"],
    ["no answer, present", { put: { status: 0, create: true } }, "SUCCEEDED"],
    ["no answer, absent", { put: { status: 0 } }, "PARTIAL_REQUIRES_REVIEW"],
    ["no answer, unreadable", { put: { status: 0, create: true }, get: { status: 403 } }, "PARTIAL_REQUIRES_REVIEW"],
    ["408, absent (not a definite refusal)", { put: { status: 408 } }, "PARTIAL_REQUIRES_REVIEW"],
  ];
  for (const [label, behavior, outcome] of rows) {
    const w = world();
    const sealed = await seal(w);
    const ended = await inDriverOrder(w, sealed, { beforeExecute: () => w.google.behave(behavior) });
    assert.ok("outcome" in ended, label + ": " + JSON.stringify(ended));
    assert.equal(ended.outcome, outcome, label);
    assert.notEqual(ended.outcome, "KILLED");
    assert.equal(puts(w), 1, label + ": the PUT is sent exactly once, never retried");
    assertNoSecrets(w, ended.outcome);
  }
});

test("SYNTHETIC: D14: the kill switch before the token or between the token and the PUT stops with nothing sent; a token failure is APPROVALS_SPENT", async () => {
  const w = world();
  const sealed = await seal(w);
  const before = w.google.log().length;
  assert.deepEqual(await inDriverOrder(w, sealed, { stopWhen: () => true }), { refused: "KILL_SWITCH_AFTER_APPROVALS", consumed: true });
  assert.ok(!w.google.log().slice(before).some((e) => e.host === "iamcredentials.googleapis.com" && e.path.includes("-apply@")), "no APPLY token before the switch is read");
  let reads = 0;
  assert.deepEqual(await inDriverOrder(w, sealed, { stopWhen: () => ++reads > 1 }), { refused: "KILL_SWITCH_AFTER_APPROVALS", consumed: true });
  assert.ok(w.google.log().some((e) => e.host === "iamcredentials.googleapis.com" && e.path.includes("-apply@") && e.status === 200), "the token was minted, then the switch read again");
  assert.equal(puts(w), 0);
  // APPLY's impersonation refused (its subject may impersonate only its own service account): execute throws before the PUT,
  // which the driver reports as APPROVALS_SPENT, with the step and status in the code.
  w.ids.env.ALZ_APPLY_GOOGLE_IMPERSONATE_SERVICE_ACCOUNT = w.ids.email("OTHER");
  assert.deepEqual(await inDriverOrder(w, sealed), { refused: "APPROVALS_SPENT", code: "CREDENTIALS_IAM_CREDENTIALS_HTTP_403", consumed: true });
  assert.equal(puts(w), 0);
});

test("SYNTHETIC: D14 recovery: a process stopped after the PUT is never resumed: the same plan reads its topic present and is PLAN_STALE", async () => {
  const w = world();
  const sealed = await seal(w);
  // The engine ran the PUT; the process was killed before settle (SIGKILL after the reservation). record-recovery is the driver's (INT-2).
  const run = w.spec.openApply(w.runInput(sealed.unit));
  await run.prepare(w.project);
  await run.rederive(sealed.bytes);
  await run.execute(sealed.bytes, { stopWhen: () => false });
  assert.equal(run.createStatus(), 200);
  assert.deepEqual(await inDriverOrder(w, sealed), { refused: "UNIT_NOT_EMPTY", consumed: false });
  w.google.behave({ unindexed: [sealed.name] });
  assert.deepEqual(await inDriverOrder(w, sealed), { refused: "PLAN_STALE", consumed: false }, "even inside the indexing window, the sealed topic's own GET stops it");
  assert.equal(puts(w), 1);
});

/* ------------------------------------------------------------------ D16: cleanup */

test("SYNTHETIC: D16: cleanup refuses before consumption: absent, unreadable, labels or policy changed, an address outside the target, a second address", async () => {
  const w = world();
  const sealed = await applied(w);
  const address = sealed.changes[0].address;
  const cases: [string, () => void, string[], string][] = [
    ["the unit is not given", () => undefined, [address], "UNIT_NOT_GIVEN"],
    ["unreadable (403)", () => w.google.behave({ get: { status: 403 } }), [address], "CLEANUP_READ_FAILED"],
    ["unreadable (500)", () => w.google.behave({ get: { status: 500 } }), [address], "CLEANUP_READ_FAILED"],
    ["unreadable (no answer)", () => w.google.behave({ drop: { host: "pubsub.googleapis.com", method: "GET" } }), [address], "CLEANUP_READ_FAILED"],
    ["labels changed", () => { w.google.topics.get(sealed.name)!.labels["alz-unit"] = "alzu-ffffffffffffffffffff"; }, [address], "OWNERSHIP_MISMATCH"],
    ["a label added", () => { w.google.topics.get(sealed.name)!.labels.team = "x"; }, [address], "OWNERSHIP_MISMATCH"],
    ["storage policy changed", () => { w.google.topics.get(sealed.name)!.messageStoragePolicy = { allowedPersistenceRegions: [REGION, "us-central1"] }; }, [address], "OWNERSHIP_MISMATCH"],
    ["outside the prefix", () => undefined, ["google_pubsub_topic.alz-other-0123456789ab"], "CLEANUP_ADDRESS_NOT_IN_CONTRACT"],
    ["not the 12-hex suffix", () => undefined, ["google_pubsub_topic." + PREFIX + "x"], "CLEANUP_ADDRESS_NOT_IN_CONTRACT"],
    ["a subscription", () => undefined, ["google_pubsub_subscription." + sealed.topicId], "CLEANUP_ADDRESS_NOT_IN_CONTRACT"],
    ["two addresses", () => undefined, [address, "google_pubsub_topic." + PREFIX + "0123456789ab"], "CLEANUP_ADDRESSES_INVALID"],
    ["none", () => undefined, [], "CLEANUP_ADDRESSES_INVALID"],
  ];
  for (const [label, arrange, addresses, code] of cases) {
    const saved = structuredClone(w.google.topics.get(sealed.name)!);
    arrange();
    const ended = await cleanupInDriverOrder(w, addresses, label === "the unit is not given" ? undefined : sealed.unit);
    assert.deepEqual(ended, { refused: code, consumed: false }, label);
    w.google.behave({});
    w.google.topics.set(sealed.name, saved);
  }
  w.google.topics.clear();
  assert.deepEqual(await cleanupInDriverOrder(w, [address], sealed.unit), { refused: "CLEANUP_NO_CHANGES", consumed: false }, "already absent, not deleted by this run");
  assert.equal(deletes(w), 0);
});

test("SYNTHETIC: D16: every row of the cleanup outcome table, each with exactly one DELETE of the sealed URL", async () => {
  type Row = [string, (w: World, name: string) => void, string, boolean | undefined];
  const rows: Row[] = [
    ["200, absent: deleted by this run", () => undefined, "SUCCEEDED", true],
    ["404, absent: already absent, not deleted by this run", (w) => w.google.behave({ delete: { status: 404, remove: true } }), "SUCCEEDED", false],
    ["400, present and unchanged", (w) => w.google.behave({ delete: { status: 400 } }), "FAILED_NO_CHANGE", undefined],
    ["401, present and unchanged", (w) => w.google.behave({ delete: { status: 401 } }), "FAILED_NO_CHANGE", undefined],
    ["403, present and unchanged", (w) => w.google.behave({ delete: { status: 403 } }), "FAILED_NO_CHANGE", undefined],
    ["429, present and unchanged", (w) => w.google.behave({ delete: { status: 429 } }), "FAILED_NO_CHANGE", undefined],
    ["403, then absent", (w) => w.google.behave({ delete: { status: 403, remove: true } }), "PARTIAL_REQUIRES_REVIEW", undefined],
    ["403, then unreadable", (w) => w.google.behave({ delete: { status: 403 }, get: { status: 500 } }), "PARTIAL_REQUIRES_REVIEW", undefined],
    ["500, absent: uncertain, never no change", (w) => w.google.behave({ delete: { status: 500, remove: true } }), "PARTIAL_REQUIRES_REVIEW", undefined],
    ["503, present", (w) => w.google.behave({ delete: { status: 503 } }), "PARTIAL_REQUIRES_REVIEW", undefined],
    ["timeout (no answer), absent", (w) => w.google.behave({ delete: { status: 0, remove: true } }), "PARTIAL_REQUIRES_REVIEW", undefined],
    ["timeout (no answer), present", (w) => w.google.behave({ delete: { status: 0 } }), "PARTIAL_REQUIRES_REVIEW", undefined],
    ["200, present after", (w) => w.google.behave({ delete: { status: 200 } }), "PARTIAL_REQUIRES_REVIEW", undefined],
    ["200, unreadable", (w) => w.google.behave({ delete: { status: 200, remove: true }, get: { status: 403 } }), "PARTIAL_REQUIRES_REVIEW", undefined],
    ["404, present after", (w) => w.google.behave({ delete: { status: 404 } }), "PARTIAL_REQUIRES_REVIEW", undefined],
  ];
  for (const [label, arrange, outcome, deletedByRun] of rows) {
    const w = world();
    const sealed = await applied(w);
    const ended = await cleanupInDriverOrder(w, [sealed.changes[0].address], sealed.unit, { beforeExecute: () => arrange(w, sealed.name) });
    assert.deepEqual(ended, { outcome, consumed: true, deletedByRun }, label);
    const sent = w.google.log().filter((e) => e.method === "DELETE");
    assert.deepEqual(sent.map((e) => [e.host, e.path, e.sa]), [["pubsub.googleapis.com", "/v1/" + sealed.name, w.ids.email("APPLY")]], label + ": one DELETE, the sealed URL, as APPLY");
  }
});

test("SYNTHETIC: D16: the kill switch stops a cleanup before its token or between the token and the DELETE", async () => {
  const w = world();
  const sealed = await applied(w);
  const address = sealed.changes[0].address;
  assert.deepEqual(await cleanupInDriverOrder(w, [address], sealed.unit, { stopWhen: () => true }), { refused: "KILL_SWITCH_AFTER_APPROVALS", consumed: true });
  let reads = 0;
  assert.deepEqual(await cleanupInDriverOrder(w, [address], sealed.unit, { stopWhen: () => ++reads > 1 }), { refused: "KILL_SWITCH_AFTER_APPROVALS", consumed: true });
  assert.equal(deletes(w), 0);
  assert.equal(w.google.topics.size, 1, "the topic is kept");
});

/* ------------------------------------------------------------------ D12, D15: identities, scopes, the reader */

test("SYNTHETIC: D12: two distinct WIF identities only: a third identity, a collapse, a key file or a service account outside the project is refused", async () => {
  const w = world();
  // The driver's check (src/apply/identities.ts) with this spec's identities: any other identity configured is refused.
  assert.ok(checkApplyIdentities(w.ids.env, GCP, gcpApiEngine().identities).ok);
  for (const extra of ["STATE", "STATE_WRITE", "CHANGESET"]) {
    const env = { ...w.ids.env, ["ALZ_" + extra + "_GOOGLE_APPLICATION_CREDENTIALS"]: w.ids.env.ALZ_DISCOVERY_GOOGLE_APPLICATION_CREDENTIALS, ["ALZ_" + extra + "_GOOGLE_IMPERSONATE_SERVICE_ACCOUNT"]: w.ids.email(extra) };
    assert.equal(checkApplyIdentities(env, GCP, gcpApiEngine().identities).ok, false, extra);
  }
  const cases: [string, (env: NodeJS.ProcessEnv) => void, string][] = [
    ["DISCOVERY and APPLY share a service account", (env) => { env.ALZ_APPLY_GOOGLE_IMPERSONATE_SERVICE_ACCOUNT = env.ALZ_DISCOVERY_GOOGLE_IMPERSONATE_SERVICE_ACCOUNT; }, "IDENTITY_COLLAPSED"],
    ["DISCOVERY and APPLY share a configuration", (env) => { env.ALZ_APPLY_GOOGLE_APPLICATION_CREDENTIALS = env.ALZ_DISCOVERY_GOOGLE_APPLICATION_CREDENTIALS; }, "IDENTITY_COLLAPSED"],
    ["a key file", (env) => { writeFileSync(env.ALZ_DISCOVERY_GOOGLE_APPLICATION_CREDENTIALS!, JSON.stringify({ type: "service_account", private_key: "x", client_email: "y" })); }, "IDENTITY_NOT_CONFIGURED"],
    ["a service account outside the project", (env) => { env.ALZ_APPLY_GOOGLE_IMPERSONATE_SERVICE_ACCOUNT = "alz-pilot-dev-apply@someone-elses-1.iam.gserviceaccount.com"; }, "IDENTITY_NOT_CONFIGURED"],
    ["an identity carrying gcloud's configuration", (env) => { env.ALZ_DISCOVERY_CLOUDSDK_CONFIG = "/tmp/gcloud"; }, "IDENTITY_NOT_CONFIGURED"],
    ["an identity pointed at a metadata server", (env) => { env.ALZ_APPLY_GCE_METADATA_HOST = "169.254.169.254"; }, "IDENTITY_NOT_CONFIGURED"],
    ["an access token variable", (env) => { env.ALZ_APPLY_GOOGLE_OAUTH_ACCESS_TOKEN = "x"; }, "IDENTITY_NOT_CONFIGURED"],
  ];
  for (const [label, edit, code] of cases) {
    const v = world();
    edit(v.ids.env);
    assert.equal(await codeOf(v.spec.plan(v.planInput())), code, label);
    assert.equal(v.google.log().length, 0, label + ": refused before any token request");
  }
});

test("SYNTHETIC: D12/D15: each token carries its host's scope; DISCOVERY only reads and APPLY only creates and deletes; the emulator refuses the wrong scopes", async () => {
  const w = world();
  const sealed = await applied(w);
  const ended = await cleanupInDriverOrder(w, [sealed.changes[0].address], sealed.unit);
  assert.ok("outcome" in ended && ended.outcome === "SUCCEEDED");
  const log = w.google.log();
  assert.ok(log.filter((e) => e.host === "sts.googleapis.com").every((e) => e.stsScope === PLATFORM_SCOPE), "the exchange asks for cloud-platform (GF8)");
  for (const e of log.filter((x) => x.host === "pubsub.googleapis.com")) assert.equal(e.scope, PUBSUB_SCOPE, "Pub/Sub tokens carry the pubsub scope (GF2)");
  for (const e of log.filter((x) => x.host === "cloudasset.googleapis.com")) assert.equal(e.scope, PLATFORM_SCOPE, "Cloud Asset tokens carry cloud-platform (GF3)");
  assert.ok(log.filter((e) => e.sa === w.ids.email("DISCOVERY")).every((e) => e.method === "GET"), "DISCOVERY never writes");
  assert.ok(log.filter((e) => e.sa === w.ids.email("APPLY")).every((e) => e.method === "PUT" || e.method === "DELETE"), "APPLY never reads");
  assert.ok(!log.some((e) => e.host === "pubsub.googleapis.com" && e.status === 403), "no call was refused for its scope or role");
  // The emulator itself refuses a read-only scope on Pub/Sub and the pubsub scope on Cloud Asset (D15's fake rule).
  const mint = async (sa: string, scope: string): Promise<string> => {
    const fed = JSON.parse((await w.google.http({ method: "POST", url: "https://sts.googleapis.com/v1/token", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:token-exchange", audience: AUDIENCE, scope: PLATFORM_SCOPE, requested_token_type: "urn:ietf:params:oauth:token-type:access_token", subject_token: w.ids.subjectOf.DISCOVERY, subject_token_type: "urn:ietf:params:oauth:token-type:jwt" }).toString() })).body).access_token as string;
    return JSON.parse((await w.google.http({ method: "POST", url: "https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/" + sa + ":generateAccessToken", headers: { authorization: "Bearer " + fed, "content-type": "application/json" }, body: JSON.stringify({ scope: [scope], lifetime: "300s" }) })).body).accessToken as string;
  };
  const readOnly = await mint(w.ids.email("DISCOVERY"), "https://www.googleapis.com/auth/cloud-platform.read-only");
  assert.equal((await w.google.http({ method: "GET", url: sealed.url, headers: { authorization: "Bearer " + readOnly } })).status, 403);
  const pubsubOnly = await mint(w.ids.email("DISCOVERY"), PUBSUB_SCOPE);
  assert.equal((await w.google.http({ method: "GET", url: "https://cloudasset.googleapis.com/v1/projects/" + PROJECT + ":searchAllResources?query=labels.alz-unit%3A" + sealed.unit.unitId, headers: { authorization: "Bearer " + pubsubOnly } })).status, 403);
});

test("SYNTHETIC: D15/D6/D11: the observation of record is GCP_REST on the blueprint the stateDocument gives: VERIFIED, and FAILED for another storage policy", async () => {
  const w = world();
  const sealed = await seal(w);
  const ended = await inDriverOrder(w, sealed);
  assert.ok("outcome" in ended && ended.outcome === "SUCCEEDED");
  const state = await ended.run.stateDocument();
  assert.equal(state?.source, "GCP_API_TOPIC");
  assert.deepEqual(JSON.parse(state!.document), { name: sealed.name, labels: { ...w.unit.tags } });
  const blueprint = blueprintFromGcpApiTopic(state!.document, sealed.changes, { project: PROJECT });
  assert.deepEqual(blueprint.entries.map((e) => [e.address, e.type, e.id, e.origin]), [[sealed.changes[0].address, TOPIC_TYPE, sealed.name, "IN_PLAN"]]);
  const observe = async () => {
    const reader = createDiscoveryGcpReader({ env: w.ids.env, projectId: PROJECT, storagePolicyRegion: REGION, http: w.google.http });
    try { return await observeBlueprint(blueprint, { unitId: sealed.unit.unitId, reader: reader.reader }); } finally { reader.close(); }
  };
  const verified = await observe();
  assert.equal(verified.verdict, "VERIFIED");
  assert.equal(verified.verifier, "GCP_REST");
  w.google.topics.get(sealed.name)!.messageStoragePolicy = { allowedPersistenceRegions: ["us-central1"] };
  const misplaced = await observe();
  assert.equal(misplaced.verdict, "FAILED");
  assert.equal(misplaced.checks[0].misplaced, true);
  assertNoSecrets(w, state, verified, misplaced);
});

/* ------------------------------------------------------------------ D20 and the network gate */

test("SYNTHETIC: D20: refusal shapes name the step and the HTTP status, never the body; invalidInput is the identity's configuration", async () => {
  assert.equal(tokenRefusal({ ok: false, step: "IMPERSONATE", status: 0, hostRefused: false, malformed: false, invalidInput: true }), "IDENTITY_NOT_CONFIGURED");
  assert.equal(tokenRefusal({ ok: false, step: "EXCHANGE", status: 0, hostRefused: true, malformed: false }), "HOST_REFUSED");
  assert.equal(tokenRefusal({ ok: false, step: "EXCHANGE", status: 400, hostRefused: false, malformed: false }), "CREDENTIALS_STS_HTTP_400");
  assert.equal(tokenRefusal({ ok: false, step: "EXCHANGE", status: 401, hostRefused: false, malformed: false }), "CREDENTIALS_STS_HTTP_401");
  assert.equal(tokenRefusal({ ok: false, step: "IMPERSONATE", status: 403, hostRefused: false, malformed: false }), "CREDENTIALS_IAM_CREDENTIALS_HTTP_403");
  assert.equal(tokenRefusal({ ok: false, step: "IMPERSONATE", status: 503, hostRefused: false, malformed: false }), "HTTP_ERROR_IAM_CREDENTIALS_HTTP_503");
  assert.equal(tokenRefusal({ ok: false, step: "EXCHANGE", status: 0, hostRefused: false, malformed: false }), "HTTP_ERROR_STS_NO_ANSWER");
  assert.equal(tokenRefusal({ ok: false, step: "EXCHANGE", status: 200, hostRefused: false, malformed: true }), "UNEXPECTED_RESPONSE_STS_HTTP_200");
  // The reader's line (src/observe/gcp-rest.ts), the other one #356's round-2 review found unpinned.
  assert.deepEqual(readerFailure({ ok: false, step: "IMPERSONATE", status: 0, hostRefused: false, malformed: false, invalidInput: true }), { failed: "CREDENTIALS" });
  assert.deepEqual(readerFailure({ ok: false, step: "IMPERSONATE", status: 0, hostRefused: false, malformed: false }), { failed: "HOST_REFUSED" });
  // A live STS 400 (the open GF1 question) reaches the person as its class, step and status; the body never does.
  const w = world();
  writeFileSync(w.ids.env.ALZ_DISCOVERY_GOOGLE_APPLICATION_CREDENTIALS!, JSON.stringify({ type: "external_account", audience: AUDIENCE.replace("123456789012", "999999999999"), subject_token_type: "urn:ietf:params:oauth:token-type:jwt", token_url: "https://sts.googleapis.com/v1/token", credential_source: { file: join(w.dir, "identities", "discovery.jwt") } }));
  const code = await codeOf(w.spec.plan(w.planInput()));
  assert.equal(code, "CREDENTIALS_STS_HTTP_400");
  assert.ok(!code.includes("invalid_grant"), "no body");
});

test("SYNTHETIC: the network gate: only the three hosts over https, only the sealed topic URL, no lookalike, port, userinfo, query or redirect", async () => {
  const url = topicUrl(PROJECT, PREFIX + "0123456789ab");
  for (const method of ["GET", "PUT", "DELETE"] as const) assert.equal(allowedRequest({ method, url }, url, method), true, method);
  assert.equal(allowedRequest({ method: "POST", url: "https://sts.googleapis.com/v1/token" }, undefined, undefined), true);
  assert.equal(allowedRequest({ method: "POST", url: "https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/a-b-c-d-e@examplefake-dev.iam.gserviceaccount.com:generateAccessToken" }, undefined, undefined), true);
  // #357 review N2: each sender is for one Pub/Sub method, tied to its identity. PATCH and POST are never sent to the topic, a read
  // sender (DISCOVERY) can never PUT or DELETE, and the create sender (APPLY) can never DELETE, nor the delete sender PUT.
  for (const [method, sender] of [["PATCH", "PUT"], ["PATCH", "GET"], ["POST", "PUT"], ["POST", "DELETE"], ["PUT", "GET"], ["DELETE", "GET"], ["DELETE", "PUT"], ["PUT", "DELETE"], ["GET", undefined]] as const) {
    assert.equal(allowedRequest({ method: method as never, url }, url, sender), false, method + " through a " + (sender ?? "token-only") + " sender");
  }
  for (const [label, method, candidate, topic] of [
    ["another topic", "GET", topicUrl(PROJECT, PREFIX + "ffffffffffff"), url],
    ["no topic yet", "GET", url, undefined],
    ["a lookalike host", "PUT", url.replace("pubsub.googleapis.com", "pubsub.googleapis.com.evil.example"), url.replace("pubsub.googleapis.com", "pubsub.googleapis.com.evil.example")],
    ["plain http", "GET", url.replace("https:", "http:"), url.replace("https:", "http:")],
    ["a port", "GET", url.replace("googleapis.com/", "googleapis.com:8443/"), url.replace("googleapis.com/", "googleapis.com:8443/")],
    ["userinfo", "GET", url.replace("https://", "https://user@"), url.replace("https://", "https://user@")],
    ["a query", "GET", url + "?alt=media", url + "?alt=media"],
    ["a path the parser rewrites", "GET", url.replace("/topics/", "/topics/../topics/"), url.replace("/topics/", "/topics/../topics/")],
    ["Cloud Asset through the engine", "GET", "https://cloudasset.googleapis.com/v1/projects/" + PROJECT + ":searchAllResources", url],
    ["another STS path", "POST", "https://sts.googleapis.com/v1/introspect", url],
    ["a POST to Pub/Sub", "POST", url + ":publish", url],
  ] as const) assert.equal(allowedRequest({ method, url: candidate }, topic, method === "POST" ? undefined : method), false, label);
  // fetch follows no redirect: a 302 is no answer.
  const http = await import("node:http");
  const server = http.createServer((_req, res) => { res.writeHead(302, { location: "http://127.0.0.1:1/" }); res.end(); });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const port = (server.address() as { port: number }).port;
  assert.deepEqual(await fetchGcpHttp({ method: "GET", url: "http://127.0.0.1:" + port + "/", headers: {} }), { status: 0, body: "" });
  server.closeAllConnections();
  await new Promise<void>((done) => server.close(() => done()));
  assert.equal(REQUEST_TIMEOUT_MS, 30_000, "each request is bounded; the bound is reviewed and never raised to hide a failure");
  assert.equal(SETTLE_READS, 3);
});
