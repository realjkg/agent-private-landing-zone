import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { engineSpec } from "../src/apply/engine-spec.js";
import {
  applyGcpApiPlan, cleanupGcpApiPlan, observeGcpApiPlan, sealGcpApiPlan, verifyGcpApiPlan,
  type GcpApiDeps, type GcpApiTarget, type GcpHttp, type GcpHttpRequest, type SealedGcpApiPlan,
} from "../src/apply/engines/gcp-api.js";
import type { ApproverEntry } from "../src/apply/types.js";
import { REQUESTER, approvers, keys } from "./helpers/apply-fixtures.js";

/**
 * SYNTHETIC evidence only (docs/act-pilot-gcp-api.md, "Evidence"). A scripted fake stands in for sts.googleapis.com,
 * iamcredentials.googleapis.com and pubsub.googleapis.com; no Google service, identity or emulator is used. Live identity
 * proof (STS, impersonation, which principal Google sees) is G2. The Pub/Sub emulator is not used: it has no IAM and no
 * token exchange, so it would prove only the REST shape this fake already scripts.
 */

const PROJECT = "alz-pilot-dev-1a2b";
const TOPIC = "alz-canary-topic";
const TOPIC_URL = "https://pubsub.googleapis.com/v1/projects/" + PROJECT + "/topics/" + TOPIC;
const LABELS = { "alz-managed-by": "alz", "alz-unit": "alzu-0123456789abcdef0123", "alz-build": "alz-pilot-dev-0123456789ab" };
const AUDIENCE = "//iam.googleapis.com/projects/123456789/locations/global/workloadIdentityPools/alz-pool/providers/alz-oidc";
/** Canaries: none of these may appear in any result, record or error. */
const OIDC = "oidc-canary-subject-token";
const FEDERATED = "federated-canary-token";
const BEARER = { APPLY: "apply-canary-bearer", DISCOVERY: "discovery-canary-bearer" } as const;

const target = (over: Partial<GcpApiTarget> = {}): GcpApiTarget => ({ environment: "DEV", projectId: PROJECT, approvers: approvers as ApproverEntry[], ...over });
const request = (over: Record<string, unknown> = {}) => ({ kind: "PUBSUB_TOPIC", projectId: PROJECT, topicId: TOPIC, labels: { ...LABELS }, ...over });

function identityEnv(dir: string): NodeJS.ProcessEnv {
  const tokenFile = join(dir, "oidc.jwt");
  writeFileSync(tokenFile, OIDC + "\n");
  const env: NodeJS.ProcessEnv = {};
  for (const identity of ["APPLY", "DISCOVERY"] as const) {
    const config = join(dir, identity.toLowerCase() + "-wif.json");
    writeFileSync(config, JSON.stringify({
      type: "external_account", audience: AUDIENCE, subject_token_type: "urn:ietf:params:oauth:token-type:jwt",
      token_url: "https://sts.googleapis.com/v1/token", credential_source: { file: tokenFile },
    }));
    env["ALZ_" + identity + "_GOOGLE_APPLICATION_CREDENTIALS"] = config;
    env["ALZ_" + identity + "_GOOGLE_IMPERSONATE_SERVICE_ACCOUNT"] = "alz-pilot-dev-" + identity.toLowerCase() + "@" + PROJECT + ".iam.gserviceaccount.com";
  }
  return env;
}

/** The fake Google: STS, IAM credentials and one Pub/Sub project. Scope decides which bearer is minted; Pub/Sub checks it. */
function fakeGoogle() {
  const topics = new Map<string, Record<string, string>>();
  const sent: GcpHttpRequest[] = [];
  const hooks: { beforePut?: () => void; putStatus?: number } = {};
  const http: GcpHttp = async (req) => {
    sent.push(req);
    const url = new URL(req.url);
    if (url.hostname === "sts.googleapis.com") {
      const body = JSON.parse(req.body ?? "{}");
      return body.subjectToken === OIDC && body.audience === AUDIENCE ? { status: 200, body: JSON.stringify({ access_token: FEDERATED }) } : { status: 400, body: "{}" };
    }
    if (url.hostname === "iamcredentials.googleapis.com") {
      if (req.headers.authorization !== "Bearer " + FEDERATED) return { status: 401, body: "{}" };
      const scope = JSON.parse(req.body ?? "{}").scope?.[0] as string;
      const identity = scope.endsWith("/pubsub") ? "APPLY" : "DISCOVERY";
      if (!req.url.includes("alz-pilot-dev-" + identity.toLowerCase() + "@")) return { status: 403, body: "{}" };
      return { status: 200, body: JSON.stringify({ accessToken: BEARER[identity], expireTime: "x" }) };
    }
    const name = url.pathname.replace(/^\/v1\//, "");
    const auth = req.headers.authorization;
    if (req.method === "GET") {
      if (auth !== "Bearer " + BEARER.DISCOVERY) return { status: 403, body: "{}" };
      const labels = topics.get(name);
      return labels ? { status: 200, body: JSON.stringify({ name, labels }) } : { status: 404, body: "{}" };
    }
    if (auth !== "Bearer " + BEARER.APPLY) return { status: 403, body: "{}" };
    if (req.method === "PUT") {
      hooks.beforePut?.();
      if (hooks.putStatus !== undefined) return { status: hooks.putStatus, body: "" };
      if (topics.has(name)) return { status: 409, body: "{}" };
      topics.set(name, JSON.parse(req.body ?? "{}").labels);
      return { status: 200, body: JSON.stringify({ name }) };
    }
    if (req.method === "DELETE") return topics.delete(name) ? { status: 200, body: "{}" } : { status: 404, body: "{}" };
    return { status: 400, body: "{}" };
  };
  return { http, topics, sent, hooks };
}

function setup(over: Partial<GcpApiDeps> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "alz-gcp-api-"));
  const google = fakeGoogle();
  let kill = false;
  const deps: GcpApiDeps = { target: target(), env: identityEnv(dir), http: google.http, killSwitch: () => kill, ledgerDir: mkdtempSync(join(dir, "ledger-")), ...over };
  return { deps, google, setKill: (on: boolean) => { kill = on; } };
}

async function seal(deps: GcpApiDeps, req: unknown = request()): Promise<SealedGcpApiPlan> {
  const sealed = await sealGcpApiPlan({ request: req, requester: REQUESTER }, deps);
  assert.ok(sealed.ok, JSON.stringify(sealed));
  return sealed.sealed;
}

/** No canary token appears in anything the engine returns, and no request left for another host. */
function assertClean(google: ReturnType<typeof fakeGoogle>, ...results: unknown[]): void {
  const text = JSON.stringify(results);
  for (const canary of [OIDC, FEDERATED, BEARER.APPLY, BEARER.DISCOVERY]) assert.ok(!text.includes(canary), canary);
  for (const req of google.sent) assert.match(req.url, /^https:\/\/(sts|iamcredentials|pubsub)\.googleapis\.com\//);
}

test("SYNTHETIC: seal, apply, observe and cleanup one labeled Pub/Sub topic", async () => {
  const { deps, google } = setup();
  const plan = await seal(deps);
  assert.equal(plan.requesterId, "carol");
  assert.equal(plan.create.method, "PUT");
  assert.equal(plan.create.url, TOPIC_URL);
  assert.deepEqual(plan.create.body, { labels: LABELS });
  assert.equal(google.sent.some((r) => r.method === "PUT"), false, "sealing sends nothing but reads");

  const applied = await applyGcpApiPlan(plan, deps);
  assert.ok(applied.ok);
  assert.equal(applied.outcome, "APPLIED");
  assert.deepEqual(google.topics.get("projects/" + PROJECT + "/topics/" + TOPIC), LABELS);
  assert.equal(google.sent.filter((r) => r.method === "PUT").length, 1);

  const observed = await observeGcpApiPlan(plan, deps);
  assert.ok(observed.ok && observed.verified && observed.existence === "PRESENT");

  const cleaned = await cleanupGcpApiPlan(plan, deps);
  assert.ok(cleaned.ok);
  assert.equal(cleaned.outcome, "DELETED");
  assert.equal(google.topics.size, 0);
  const again = await cleanupGcpApiPlan(plan, deps);
  assert.ok(again.ok && again.outcome === "ALREADY_ABSENT", "cleanup is idempotent");
  assertClean(google, plan, applied, observed, cleaned, again);
});

test("SYNTHETIC: a second apply of the same plan is refused before anything is sent", async () => {
  const { deps, google } = setup();
  const plan = await seal(deps);
  assert.ok((await applyGcpApiPlan(plan, deps)).ok);
  const before = google.sent.length;
  const second = await applyGcpApiPlan(plan, deps);
  assert.deepEqual([second.ok, !second.ok && second.code], [false, "ALREADY_APPLIED"]);
  assert.equal(google.sent.length, before);
});

test("SYNTHETIC: a stale plan is refused: the topic exists at seal, at apply, or appears at create", async () => {
  const { deps, google } = setup();
  google.topics.set("projects/" + PROJECT + "/topics/" + TOPIC, { ...LABELS });
  const sealed = await sealGcpApiPlan({ request: request(), requester: REQUESTER }, deps);
  assert.deepEqual(sealed, { ok: false, code: "TOPIC_EXISTS" });

  google.topics.clear();
  const plan = await seal(deps);
  google.topics.set("projects/" + PROJECT + "/topics/" + TOPIC, { other: "owner" });
  const stale = await applyGcpApiPlan(plan, deps);
  assert.deepEqual([stale.ok, !stale.ok && stale.code], [false, "PLAN_STALE"]);
  assert.equal(google.sent.some((r) => r.method === "PUT"), false);

  const fresh = setup();
  const plan2 = await seal(fresh.deps);
  fresh.google.hooks.beforePut = () => fresh.google.topics.set("projects/" + PROJECT + "/topics/" + TOPIC, { other: "owner" });
  const raced = await applyGcpApiPlan(plan2, fresh.deps);
  assert.ok(raced.ok && raced.outcome === "NOT_APPLIED" && raced.code === "PLAN_STALE");
  const cleanup = await cleanupGcpApiPlan(plan2, fresh.deps);
  assert.deepEqual([cleanup.ok, !cleanup.ok && cleanup.code], [false, "NOT_RUN_CREATED"], "a topic the run did not create is never deleted");
});

test("SYNTHETIC: a topic changed after apply is kept: cleanup refuses OWNERSHIP_MISMATCH and observe reports unverified", async () => {
  const { deps, google } = setup();
  const plan = await seal(deps);
  assert.ok((await applyGcpApiPlan(plan, deps)).ok);
  google.topics.set("projects/" + PROJECT + "/topics/" + TOPIC, { ...LABELS, "alz-unit": "alzu-ffffffffffffffffffff" });
  const observed = await observeGcpApiPlan(plan, deps);
  assert.ok(observed.ok && !observed.verified && !observed.owned);
  const cleaned = await cleanupGcpApiPlan(plan, deps);
  assert.deepEqual([cleaned.ok, !cleaned.ok && cleaned.code], [false, "OWNERSHIP_MISMATCH"]);
  assert.equal(google.sent.some((r) => r.method === "DELETE"), false);
  assert.equal(google.topics.size, 1);
});

test("SYNTHETIC: the kill switch stops the run before it starts and between the token and the create", async () => {
  const before = setup();
  const plan = await seal(before.deps);
  before.setKill(true);
  const refused = await applyGcpApiPlan(plan, before.deps);
  assert.deepEqual([refused.ok, !refused.ok && refused.code], [false, "KILL_SWITCH_ACTIVE"]);
  before.setKill(false);
  assert.ok((await applyGcpApiPlan(plan, before.deps)).ok, "a plan stopped before the claim may run later");

  const during = setup();
  const plan2 = await seal(during.deps);
  let reads = 0;
  during.deps.killSwitch = () => ++reads > 1;
  const stopped = await applyGcpApiPlan(plan2, during.deps);
  assert.deepEqual([stopped.ok, !stopped.ok && stopped.code], [false, "KILL_SWITCH_DURING_APPLY"]);
  assert.equal(during.google.sent.some((r) => r.method === "PUT"), false);
  assert.equal(during.google.topics.size, 0);
  during.deps.killSwitch = () => false;
  const retried = await applyGcpApiPlan(plan2, during.deps);
  assert.deepEqual([retried.ok, !retried.ok && retried.code], [false, "ALREADY_APPLIED"], "a stopped plan is consumed; it is sealed again");
});

test("SYNTHETIC: a create with no answer is UNCERTAIN, never sent again, and settled by the read-back", async () => {
  const { deps, google } = setup();
  const plan = await seal(deps);
  google.hooks.putStatus = 0;
  const applied = await applyGcpApiPlan(plan, deps);
  assert.ok(applied.ok && applied.outcome === "UNCERTAIN" && applied.code === "CREATE_UNANSWERED");
  assert.equal(google.sent.filter((r) => r.method === "PUT").length, 1, "no silent retry");
  const observed = await observeGcpApiPlan(plan, deps);
  assert.ok(observed.ok && observed.existence === "ABSENT" && !observed.verified);
});

test("SYNTHETIC: forged plans, a disallowed kind or field, a wrong project and foreign labels are refused", async () => {
  const { deps, google } = setup();
  const plan = await seal(deps);
  const forged = (edit: (p: Record<string, any>) => void) => { const p = structuredClone(plan) as Record<string, any>; edit(p); return p; };
  const code = async (value: unknown) => { const r = await applyGcpApiPlan(value, deps); return r.ok ? "APPLIED" : r.code; };

  assert.equal(await code(forged((p) => { p.create.url = TOPIC_URL.replace(TOPIC, "alz-other-topic"); })), "PLAN_FORGED");
  assert.equal(await code(forged((p) => { p.create.body.messageRetentionDuration = "600s"; })), "PLAN_FORGED");
  assert.equal(await code(forged((p) => { p.resource.topicId = "alz-other-topic"; p.create.url = p.readBack.url = p.cleanup.url = TOPIC_URL.replace(TOPIC, "alz-other-topic"); })), "PLAN_FORGED");
  assert.equal(await code(forged((p) => { p.extra = true; })), "PLAN_FORGED");
  assert.equal(await code(forged((p) => { p.resource.kind = "STORAGE_BUCKET"; })), "KIND_NOT_ALLOWED");
  assert.equal(await code(forged((p) => { p.resource.projectId = "someone-elses-prj"; })), "PROJECT_NOT_IN_CONTRACT");
  assert.equal(await code(forged((p) => { p.environment = "PROD"; })), "ENVIRONMENT_MISMATCH");
  assert.equal(await code(forged((p) => { p.engine = "TERRAFORM"; })), "ENGINE_NOT_ALLOWED");
  assert.equal(await code(forged((p) => { p.requesterId = "alice"; })), "REQUESTER_MISBOUND");
  assert.equal(google.sent.some((r) => r.method === "PUT"), false);

  // A plan re-hashed by someone without an allowlisted key does not carry a valid request signature.
  const resealed = await sealGcpApiPlan({ request: request(), requester: { requesterId: "carol", privateKeyPem: keys.mallory.priv } }, deps);
  assert.deepEqual(resealed, { ok: false, code: "REQUESTER_KEY_MISMATCH" });

  const sealCode = async (req: unknown, t: GcpApiTarget = target()) => { const r = await sealGcpApiPlan({ request: req, requester: REQUESTER }, { ...deps, target: t }); return r.ok ? "SEALED" : r.code; };
  assert.equal(await sealCode(request({ kind: "COMPUTE_INSTANCE" })), "KIND_NOT_ALLOWED");
  assert.equal(await sealCode(request({ messageStoragePolicy: {} })), "FIELD_NOT_ALLOWED");
  assert.equal(await sealCode(request({ projectId: "someone-elses-prj" })), "PROJECT_NOT_IN_CONTRACT");
  assert.equal(await sealCode(request(), target({ projectId: "someone-elses-prj" })), "PROJECT_NOT_IN_CONTRACT");
  assert.equal(await sealCode(request({ topicId: "goog-topic" })), "TOPIC_ID_INVALID");
  assert.equal(await sealCode(request({ topicId: "alz-../x" })), "TOPIC_ID_INVALID");
  assert.equal(await sealCode(request({ labels: { ...LABELS, team: "x" } })), "LABELS_NOT_IN_CONTRACT");
  assert.equal(await sealCode(request({ labels: { ...LABELS, "alz-managed-by": "someone" } })), "LABELS_NOT_IN_CONTRACT");
  assert.equal(verifyGcpApiPlan(plan, target({ environment: "QA" })).ok, false);
});

test("SYNTHETIC: identities: a key file, a foreign SA or a missing configuration is refused before any token request", async () => {
  for (const edit of [
    (env: NodeJS.ProcessEnv) => { writeFileSync(env.ALZ_DISCOVERY_GOOGLE_APPLICATION_CREDENTIALS!, JSON.stringify({ type: "service_account", private_key: "x" })); },
    (env: NodeJS.ProcessEnv) => { env.ALZ_DISCOVERY_GOOGLE_IMPERSONATE_SERVICE_ACCOUNT = "reader@another-project.iam.gserviceaccount.com"; },
    (env: NodeJS.ProcessEnv) => { delete env.ALZ_DISCOVERY_GOOGLE_APPLICATION_CREDENTIALS; },
  ]) {
    const { deps, google } = setup();
    edit(deps.env);
    const sealed = await sealGcpApiPlan({ request: request(), requester: REQUESTER }, deps);
    assert.deepEqual(sealed, { ok: false, code: "IDENTITY_NOT_CONFIGURED" });
    assert.equal(google.sent.length, 0);
  }
});

test("SYNTHETIC: a plan naming a lookalike host is refused and nothing is sent to it", async () => {
  const { deps, google } = setup();
  const plan = await seal(deps);
  const p = structuredClone(plan) as Record<string, any>;
  // A forged URL is refused by verification; the transport gate is the second line, proven by the sent log.
  p.create.url = "https://pubsub.googleapis.com.evil.example/v1/projects/" + PROJECT + "/topics/" + TOPIC;
  assert.equal((await applyGcpApiPlan(p, deps)).ok, false);
  assertClean(google);
});

test("admission: no engine spec exists for GCP_API, so a pilot contract naming it is refused", () => {
  assert.equal(engineSpec("GCP_API"), undefined);
});
