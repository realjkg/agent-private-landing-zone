import { randomBytes } from "node:crypto";
import { closeSync, lstatSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { canonicalJson } from "../../teardown/manifest.js";
import { ALZ_TAG_KEYS } from "../../teardown/unit.js";
import { checkCredentialConfiguration, exchangeSubjectToken, impersonateServiceAccount, readTokenFile, type GcpTokenFailure } from "../../tools/gcp-credentials.js";
import { identityVariables, type ExecutionIdentity } from "../../tools/identity.js";
import { sha256 } from "../../util/sha256.js";
import { GCP } from "../providers/gcp.js";
import { TOPIC_ID } from "../gcp-api-target.js";
import { requesterRefusal, signRequest, verifyRequestSignature } from "../approval.js";
import { HASH, TOKEN_FILE } from "../constants.js";
import type { ApplyEnvironment, ApproverEntry, PilotContract, SealedRequest } from "../types.js";

/**
 * Path 6 of the narrow ACT-DEV release: GCP API-native provisioning (docs/act-pilot-gcp-api.md).
 *
 * A small typed request engine. It creates exactly one allowlisted resource kind, a Pub/Sub topic, by calling the Pub/Sub
 * REST API directly, with ownership carried by the three `alz-*` labels. There is no Terraform and no state file: the sealed
 * plan is the complete list of REST calls, and the cloud read-back under DISCOVERY is the verification.
 *
 * This module is not wired to the pilot driver. `src/apply/contract.ts` does not admit `GCP_API` (admission refuses it), so
 * nothing in the product can reach `applyGcpApiPlan`; the authorization lane admits it under the same gates as every path.
 * Every refusal is a code; no response body, token or credential is ever carried in a result, record or error.
 *
 * Requests go only to three fixed hosts over https: `sts.googleapis.com` (one token exchange),
 * `iamcredentials.googleapis.com` (one impersonation) and `pubsub.googleapis.com` (the sealed topic URL only). Anything
 * else is refused before it is sent. Nothing is retried: a call that fails is reported, and an uncertain create is
 * settled by the read-back, never by sending it again.
 */

export const GCP_API_ENGINE = "GCP_API" as const;
export const GCP_API_KINDS = ["PUBSUB_TOPIC"] as const;
export type GcpApiKind = (typeof GCP_API_KINDS)[number];

const STS_HOST = "sts.googleapis.com";
const IAM_CREDENTIALS_HOST = "iamcredentials.googleapis.com";
const PUBSUB_HOST = "pubsub.googleapis.com";
const STS_TOKEN_URL = "https://" + STS_HOST + "/v1/token";
const SCOPE_EXCHANGE = "https://www.googleapis.com/auth/cloud-platform";
/**
 * The scope both identities' bearers carry. Pub/Sub accepts only `cloud-platform` and `pubsub` on `topics.get`, `.create`
 * and `.delete` (its v1 discovery document); `cloud-platform.read-only` is refused with 403. The narrower of the two is
 * requested for both identities, so a bearer reaches Pub/Sub only. Read-only is IAM's job, not the scope's: DISCOVERY's
 * service account holds `pubsub.topics.get` and nothing else (#308).
 */
const SCOPE_PUBSUB = "https://www.googleapis.com/auth/pubsub";
const TOKEN_LIFETIME = "300s";

/** A GCP project id. */
export const PROJECT_ID = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;
/** A run-created topic id: the `alz-` prefix and Pub/Sub's safe subset, so no id needs escaping in a URL path. */
// The one topic id rule of path 6 (src/apply/gcp-api-target.ts); re-exported so existing imports keep working.
export { TOPIC_ID };
const LABEL_VALUE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const UNIT_ID = /^alzu-[0-9a-f]{20}$/;
const SERVICE_ACCOUNT = /^([a-z][a-z0-9-]{4,28}[a-z0-9])@([a-z][a-z0-9-]{4,28}[a-z0-9])\.iam\.gserviceaccount\.com$/;
/** The seal's own nonce, bound into the artifact: every seal is a new artifact, so a stopped plan is recovered by sealing again. */
const SEAL_NONCE = /^[0-9a-f]{32}$/;
const REQUEST_KEYS = "kind,labels,projectId,topicId";
const LABEL_KEYS = [ALZ_TAG_KEYS.build, ALZ_TAG_KEYS.managedBy, ALZ_TAG_KEYS.unit].sort().join();

/** What the requester asks for: one resource of an allowlisted kind, with exactly these fields. */
export type GcpApiRequest = { kind: GcpApiKind; projectId: string; topicId: string; labels: Record<string, string> };
/** One REST call, exactly as it is sent (the bearer header aside). */
export type GcpApiCall = { method: "PUT" | "GET" | "DELETE"; url: string; body: { labels: Record<string, string> } | null };
/** The slice of the pilot contract this engine reads: the environment's project and the requester allowlist. */
export type GcpApiTarget = { environment: ApplyEnvironment; projectId: string; approvers: ApproverEntry[] };

export type SealedGcpApiPlan = {
  schemaVersion: 1;
  engine: typeof GCP_API_ENGINE;
  provider: "GCP";
  environment: ApplyEnvironment;
  resource: GcpApiRequest;
  /** What must hold when the plan is applied: the topic does not exist. */
  precondition: "ABSENT";
  create: GcpApiCall;
  readBack: GcpApiCall;
  cleanup: GcpApiCall;
  /**
   * Fresh random hex from this seal, inside the hash the requester signs. Sealing the same request again gives a new
   * artifact, which is how a plan stopped before its create is recovered (the ledger applies each artifact once). A second
   * topic cannot follow: every seal and every apply reads the topic ABSENT first, and Pub/Sub refuses a duplicate name (409).
   */
  sealNonce: string;
  artifactSha256: string;
  requesterId: string;
  request: SealedRequest;
};

export type GcpHttpRequest = { method: "GET" | "PUT" | "DELETE" | "POST"; url: string; headers: Readonly<Record<string, string>>; body?: string };
export type GcpHttpResponse = { status: number; body: string };
/** The HTTP client. Production: `fetch` (the runner's approved egress). Tests inject a fake. */
export type GcpHttp = (request: GcpHttpRequest) => Promise<GcpHttpResponse>;

export const fetchGcpHttp: GcpHttp = async (request) => {
  try {
    const response = await fetch(request.url, { method: request.method, headers: { ...request.headers }, body: request.body, redirect: "error" });
    return { status: response.status, body: await response.text() };
  } catch {
    return { status: 0, body: "" };
  }
};

export type GcpApiDeps = {
  target: GcpApiTarget;
  /** The runner's environment, holding `ALZ_<IDENTITY>_GOOGLE_*`. */
  env: NodeJS.ProcessEnv;
  http?: GcpHttp;
  /** Read before every mutating call; true stops the run before that call is sent. */
  killSwitch: () => boolean;
  /** A private directory: one record per applied plan, created exclusively, so a plan is applied at most once. */
  ledgerDir: string;
};

export type GcpApiRefusal = { ok: false; code: string };
type Ok<T> = { ok: true } & T;
const refuse = (code: string): GcpApiRefusal => ({ ok: false, code });

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const topicUrl = (projectId: string, topicId: string): string => "https://" + PUBSUB_HOST + "/v1/projects/" + projectId + "/topics/" + topicId;
const sameLabels = (a: unknown, b: Record<string, string>): boolean =>
  isRecord(a) && Object.keys(a).sort().join() === Object.keys(b).sort().join() && Object.entries(b).every(([k, v]) => a[k] === v);

/** The request document, judged field by field against the allowlist and the contract's project for this environment. */
export function checkRequest(value: unknown, target: GcpApiTarget): Ok<{ request: GcpApiRequest }> | GcpApiRefusal {
  if (!isRecord(value)) return refuse("REQUEST_INVALID");
  if (!(GCP_API_KINDS as readonly unknown[]).includes(value.kind)) return refuse("KIND_NOT_ALLOWED");
  if (Object.keys(value).sort().join() !== REQUEST_KEYS) return refuse("FIELD_NOT_ALLOWED");
  const { projectId, topicId, labels } = value;
  if (typeof projectId !== "string" || !PROJECT_ID.test(projectId) || !PROJECT_ID.test(target.projectId) || projectId !== target.projectId) return refuse("PROJECT_NOT_IN_CONTRACT");
  if (typeof topicId !== "string" || !TOPIC_ID.test(topicId)) return refuse("TOPIC_ID_INVALID");
  if (!isRecord(labels) || Object.keys(labels).sort().join() !== LABEL_KEYS || !Object.values(labels).every((v) => typeof v === "string" && LABEL_VALUE.test(v)) ||
    labels[ALZ_TAG_KEYS.managedBy] !== "alz" || !UNIT_ID.test(labels[ALZ_TAG_KEYS.unit] as string)) return refuse("LABELS_NOT_IN_CONTRACT");
  return { ok: true, request: { kind: "PUBSUB_TOPIC", projectId, topicId, labels: { ...(labels as Record<string, string>) } } };
}

/** The calls a request implies, derived the same way at seal and at apply: a plan carrying any other call is forged. */
function callsOf(request: GcpApiRequest): Pick<SealedGcpApiPlan, "create" | "readBack" | "cleanup"> {
  const url = topicUrl(request.projectId, request.topicId);
  return { create: { method: "PUT", url, body: { labels: { ...request.labels } } }, readBack: { method: "GET", url, body: null }, cleanup: { method: "DELETE", url, body: null } };
}

const artifactOf = (environment: ApplyEnvironment, request: GcpApiRequest, sealNonce: string): string =>
  sha256(canonicalJson({ engine: GCP_API_ENGINE, provider: "GCP", environment, precondition: "ABSENT", resource: request, ...callsOf(request), sealNonce }));

/** The engine's own verification the requester allowlist needs (only `approvers` is read). */
const allowlistOf = (target: GcpApiTarget): PilotContract => ({ approvers: target.approvers }) as unknown as PilotContract;

/**
 * Seals a request: judged against the contract, read back under DISCOVERY (the topic must not exist yet), and signed by an
 * allowlisted requester. Sends nothing but the read.
 */
export async function sealGcpApiPlan(input: { request: unknown; requester: { requesterId: string; privateKeyPem: string } }, deps: Omit<GcpApiDeps, "killSwitch" | "ledgerDir">):
  Promise<Ok<{ sealed: SealedGcpApiPlan }> | GcpApiRefusal> {
  const checked = checkRequest(input.request, deps.target);
  if (!checked.ok) return checked;
  // The same check as every seal (#321 review N2): on the allowlist, allowed for this environment, and the entry's own key.
  const requesterRefused = requesterRefusal(allowlistOf(deps.target), deps.target.environment, input.requester.requesterId, input.requester.privateKeyPem);
  if (requesterRefused) return refuse(requesterRefused.code);
  const calls = callsOf(checked.request);
  const read = await readTopic(calls.readBack.url, deps);
  if (!read.ok) return read;
  if (read.existence !== "ABSENT") return refuse("TOPIC_EXISTS");
  const environment = deps.target.environment;
  const sealNonce = randomBytes(16).toString("hex");
  const artifactSha256 = artifactOf(environment, checked.request, sealNonce);
  const request = signRequest({ schemaVersion: 1, artifactSha256, environment, requesterId: input.requester.requesterId, nonce: randomBytes(16).toString("hex") }, input.requester.privateKeyPem);
  return {
    ok: true,
    sealed: { schemaVersion: 1, engine: GCP_API_ENGINE, provider: "GCP", environment, resource: checked.request, precondition: "ABSENT", ...calls, sealNonce, artifactSha256, requesterId: input.requester.requesterId, request },
  };
}

const PLAN_KEYS = "artifactSha256,cleanup,create,engine,environment,precondition,provider,readBack,request,requesterId,resource,schemaVersion,sealNonce";

/** A sealed plan exactly as sealing makes it, for this contract: same fields, same derived calls, same hash, a valid requester signature. */
export function verifyGcpApiPlan(value: unknown, target: GcpApiTarget): Ok<{ plan: SealedGcpApiPlan }> | GcpApiRefusal {
  if (!isRecord(value) || Object.keys(value).sort().join() !== PLAN_KEYS || value.schemaVersion !== 1) return refuse("PLAN_FORGED");
  if (value.engine !== GCP_API_ENGINE || value.provider !== "GCP") return refuse("ENGINE_NOT_ALLOWED");
  if (value.environment !== target.environment) return refuse("ENVIRONMENT_MISMATCH");
  const checked = checkRequest(value.resource, target);
  if (!checked.ok) return checked;
  if (value.precondition !== "ABSENT" || canonicalJson({ create: value.create, readBack: value.readBack, cleanup: value.cleanup }) !== canonicalJson(callsOf(checked.request))) return refuse("PLAN_FORGED");
  if (typeof value.sealNonce !== "string" || !SEAL_NONCE.test(value.sealNonce)) return refuse("PLAN_FORGED");
  if (typeof value.artifactSha256 !== "string" || !HASH.test(value.artifactSha256) || value.artifactSha256 !== artifactOf(target.environment, checked.request, value.sealNonce)) return refuse("PLAN_FORGED");
  if (typeof value.requesterId !== "string") return refuse("PLAN_FORGED");
  const verdict = verifyRequestSignature({ request: value.request, artifactSha256: value.artifactSha256, environment: target.environment, requesterId: value.requesterId, contract: allowlistOf(target) });
  if (!verdict.ok) return refuse(verdict.code);
  return { ok: true, plan: value as unknown as SealedGcpApiPlan };
}

/* ------------------------------------------------------------------ transport and tokens */

/** An https URL on exactly this host: no other scheme, no port, no userinfo, and a path the parser leaves as written. */
const httpsOn = (url: string, host: string): boolean => {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && parsed.hostname === host && parsed.port === "" && parsed.username === "" && parsed.password === "" &&
      parsed.search === "" && parsed.hash === "" && parsed.href === url;
  } catch { return false; }
};

/** The one gate every request passes. `topic` is the sealed topic URL: the only Pub/Sub URL any request may name. */
function allowed(request: GcpHttpRequest, topic: string): boolean {
  if (request.method === "POST") {
    return (request.url === STS_TOKEN_URL && httpsOn(request.url, STS_HOST)) ||
      (httpsOn(request.url, IAM_CREDENTIALS_HOST) && /^https:\/\/iamcredentials\.googleapis\.com\/v1\/projects\/-\/serviceAccounts\/[a-z0-9.@-]+:generateAccessToken$/.test(request.url));
  }
  return request.url === topic && httpsOn(request.url, PUBSUB_HOST);
}

type GoogleIdentity = { audience: string; subjectTokenType: string; tokenFile: string; serviceAccount: string };

/**
 * The identity's credential configuration, judged by path 5's rules (src/apply/providers/gcp.ts and the shared src/tools/gcp-credentials.ts), so one file has one verdict:
 * first every identity in the environment together (no fallback variable, no identity carrying the operator's own
 * credentials, and no two identities sharing a service account, a credential configuration or a token file:
 * `IDENTITY_COLLAPSED`), then this identity's file (a workload identity federation file source by key allowlist, with no
 * `service_account_impersonation_url` of its own, P1). Its service account must be of the contract's project.
 */
function identityOf(env: NodeJS.ProcessEnv, identity: "APPLY" | "DISCOVERY", projectId: string): Ok<{ id: GoogleIdentity }> | GcpApiRefusal {
  const ambient = GCP.ambientRefusal(env);
  if (ambient) return refuse(ambient.code);
  const variables = identityVariables(env, identity as ExecutionIdentity);
  const configPath = variables.get("GOOGLE_APPLICATION_CREDENTIALS") ?? "";
  const serviceAccount = variables.get("GOOGLE_IMPERSONATE_SERVICE_ACCOUNT") ?? "";
  const sa = SERVICE_ACCOUNT.exec(serviceAccount);
  if (!TOKEN_FILE.test(configPath) || !sa || sa[2] !== projectId) return refuse("IDENTITY_NOT_CONFIGURED");
  const config = checkCredentialConfiguration(configPath);
  if (!config.ok) return refuse("IDENTITY_NOT_CONFIGURED");
  return { ok: true, id: { audience: config.audience, subjectTokenType: config.subjectTokenType, tokenFile: config.tokenFile, serviceAccount } };
}

/** A gated sender for one run: every request is judged by `allowed` before it exists. Status 0 means not sent or no answer. */
function senderFor(topic: string, http: GcpHttp): GcpHttp {
  return async (request) => (allowed(request, topic) ? http(request) : { status: 0, body: "HOST_REFUSED" });
}

/**
 * A short-lived access token for one identity, held in memory for one call and dropped: the OIDC token file is read,
 * exchanged once at STS, and the federated token is used once to impersonate the identity's SA. Nothing is written or cached.
 */
async function bearerFor(identity: "APPLY" | "DISCOVERY", deps: Pick<GcpApiDeps, "env" | "target">, send: GcpHttp): Promise<Ok<{ token: string }> | GcpApiRefusal> {
  const id = identityOf(deps.env, identity, deps.target.projectId);
  if (!id.ok) return id;
  // A regular file of one word, read without blocking (a FIFO in its place cannot hang the run; review N1 of #305).
  const subjectToken = readTokenFile(id.id.tokenFile);
  if (subjectToken === undefined) return refuse("CREDENTIALS");
  // The one exchange and impersonation (src/tools/gcp-credentials.ts, D20), each through this run's gated sender.
  const federated = await exchangeSubjectToken(send, { audience: id.id.audience, subjectTokenType: id.id.subjectTokenType, subjectToken, scope: SCOPE_EXCHANGE });
  if (!federated.ok) return tokenRefusal(federated);
  const impersonated = await impersonateServiceAccount(send, { federatedToken: federated.token, serviceAccount: id.id.serviceAccount, scopes: [SCOPE_PUBSUB], lifetime: TOKEN_LIFETIME });
  return impersonated.ok ? { ok: true, token: impersonated.token } : tokenRefusal(impersonated);
}

/** This engine's refusal for a failed token step: the same classes it always gave. */
function tokenRefusal(failure: GcpTokenFailure): GcpApiRefusal {
  // The identity check above already refuses a malformed service account; the exchange's own input check is the second line.
  if (failure.invalidInput) return refuse("IDENTITY_NOT_CONFIGURED");
  if (failure.malformed) return refuse("UNEXPECTED_RESPONSE");
  if (failure.status === 0) return refuse(failure.hostRefused ? "HOST_REFUSED" : "HTTP_ERROR");
  return refuse(failure.status === 400 || failure.status === 401 || failure.status === 403 ? "CREDENTIALS" : "HTTP_ERROR");
}

/* ------------------------------------------------------------------ read-back (DISCOVERY) */

export type TopicReading = { existence: "PRESENT"; labels: Record<string, string> } | { existence: "ABSENT" };

async function readTopic(url: string, deps: Pick<GcpApiDeps, "env" | "target" | "http">): Promise<Ok<TopicReading> | GcpApiRefusal> {
  const send = senderFor(url, deps.http ?? fetchGcpHttp);
  const bearer = await bearerFor("DISCOVERY", deps, send);
  if (!bearer.ok) return bearer;
  const response = await send({ method: "GET", url, headers: { authorization: "Bearer " + bearer.token, accept: "application/json" } });
  if (response.status === 404) return { ok: true, existence: "ABSENT" };
  if (response.status !== 200) return refuse(response.status === 0 ? "HTTP_ERROR" : response.status === 403 ? "ACCESS_DENIED" : "HTTP_ERROR");
  try {
    const body = JSON.parse(response.body) as { name?: unknown; labels?: unknown };
    const expected = new URL(url).pathname.replace(/^\/v1\//, "");
    if (body.name !== expected) return refuse("UNEXPECTED_RESPONSE");
    const labels = isRecord(body.labels) && Object.values(body.labels).every((v) => typeof v === "string") ? (body.labels as Record<string, string>) : {};
    return { ok: true, existence: "PRESENT", labels: { ...labels } };
  } catch { return refuse("UNEXPECTED_RESPONSE"); }
}

/* ------------------------------------------------------------------ ledger */

type LedgerState = "CLAIMED" | "APPLIED" | "NOT_APPLIED" | "UNCERTAIN" | "CLEANED";

/**
 * The ledger decides what cleanup may delete, so only this user may write it: a real directory (not a symlink) owned by
 * this process's user, with no group or other permission bits. Anything else is refused before the ledger is read.
 */
function ledgerPrivate(dir: string): boolean {
  try {
    const stat = lstatSync(dir);
    return stat.isDirectory() && (stat.mode & 0o077) === 0 && (process.getuid === undefined || stat.uid === process.getuid());
  } catch { return false; }
}
const ledgerPath = (dir: string, artifactSha256: string): string => join(dir, "gcp-api-" + artifactSha256 + ".json");

/** Claims a plan before anything is sent: an exclusive create, so a second apply of the same plan, even a concurrent one, is refused. */
function claim(dir: string, artifactSha256: string): boolean {
  try {
    const fd = openSync(ledgerPath(dir, artifactSha256), "wx", 0o600);
    try { writeFileSync(fd, JSON.stringify({ artifactSha256, state: "CLAIMED" }) + "\n"); } finally { closeSync(fd); }
    return true;
  } catch { return false; }
}
function record(dir: string, artifactSha256: string, state: LedgerState): void {
  const path = ledgerPath(dir, artifactSha256);
  writeFileSync(path + ".tmp", JSON.stringify({ artifactSha256, state }) + "\n", { mode: 0o600 });
  renameSync(path + ".tmp", path);
}
function stateOf(dir: string, artifactSha256: string): LedgerState | undefined {
  try {
    const value = JSON.parse(readFileSync(ledgerPath(dir, artifactSha256), "utf8")) as { artifactSha256?: unknown; state?: unknown };
    return value.artifactSha256 === artifactSha256 && typeof value.state === "string" ? (value.state as LedgerState) : undefined;
  } catch { return undefined; }
}

/* ------------------------------------------------------------------ apply, observe, cleanup */

/** One call actually sent, for the evidence record: method, host, path and status; never a header or a body. */
export type CallEvidence = { identity: "APPLY" | "DISCOVERY"; method: string; host: string; path: string; status: number };
export type GcpApiOutcome = "APPLIED" | "NOT_APPLIED" | "UNCERTAIN";
export type GcpApiApplyResult = { ok: true; outcome: GcpApiOutcome; code?: string; calls: CallEvidence[] } | (GcpApiRefusal & { calls: CallEvidence[] });

const evidenceOf = (identity: CallEvidence["identity"], call: GcpApiCall, status: number): CallEvidence => {
  const url = new URL(call.url);
  return { identity, method: call.method, host: url.hostname, path: url.pathname, status };
};

/**
 * Applies a sealed plan once. In order, fail closed: the kill switch, the plan verified against the contract, the
 * precondition read back under DISCOVERY (a topic that now exists makes the plan stale), the plan claimed in the ledger,
 * the APPLY token, the kill switch again, then the one create. A create with no clear answer is UNCERTAIN and is never sent
 * again; `observeGcpApiPlan` settles it.
 */
export async function applyGcpApiPlan(value: unknown, deps: GcpApiDeps): Promise<GcpApiApplyResult> {
  const calls: CallEvidence[] = [];
  const stopped = (code: string): GcpApiApplyResult => ({ ok: false, code, calls });
  if (deps.killSwitch()) return stopped("KILL_SWITCH_ACTIVE");
  const verified = verifyGcpApiPlan(value, deps.target);
  if (!verified.ok) return stopped(verified.code);
  const plan = verified.plan;
  if (!ledgerPrivate(deps.ledgerDir)) return stopped("LEDGER_NOT_PRIVATE");
  if (stateOf(deps.ledgerDir, plan.artifactSha256) !== undefined) return stopped("ALREADY_APPLIED");
  const before = await readTopic(plan.readBack.url, deps);
  if (!before.ok) return stopped(before.code);
  calls.push(evidenceOf("DISCOVERY", plan.readBack, before.existence === "ABSENT" ? 404 : 200));
  if (before.existence !== "ABSENT") return stopped("PLAN_STALE");
  if (!claim(deps.ledgerDir, plan.artifactSha256)) return stopped("ALREADY_APPLIED");
  const send = senderFor(plan.create.url, deps.http ?? fetchGcpHttp);
  const bearer = await bearerFor("APPLY", deps, send);
  if (!bearer.ok) { record(deps.ledgerDir, plan.artifactSha256, "NOT_APPLIED"); return stopped(bearer.code); }
  if (deps.killSwitch()) { record(deps.ledgerDir, plan.artifactSha256, "NOT_APPLIED"); return stopped("KILL_SWITCH_DURING_APPLY"); }
  const response = await send({ method: "PUT", url: plan.create.url, headers: { authorization: "Bearer " + bearer.token, "content-type": "application/json" }, body: JSON.stringify(plan.create.body) });
  calls.push(evidenceOf("APPLY", plan.create, response.status));
  const outcome: GcpApiOutcome = response.status === 200 ? "APPLIED" : response.status === 409 || (response.status >= 400 && response.status < 500) ? "NOT_APPLIED" : "UNCERTAIN";
  record(deps.ledgerDir, plan.artifactSha256, outcome);
  if (response.status === 409) return { ok: true, outcome, code: "PLAN_STALE", calls };
  return outcome === "APPLIED" ? { ok: true, outcome, calls } : { ok: true, outcome, code: outcome === "UNCERTAIN" ? "CREATE_UNANSWERED" : "CREATE_REFUSED", calls };
}

export type GcpApiObservation = { verified: boolean; existence: "PRESENT" | "ABSENT"; owned: boolean; calls: CallEvidence[] };

/** The read-back under DISCOVERY: verified when the sealed topic exists and carries exactly the sealed labels. */
export async function observeGcpApiPlan(value: unknown, deps: Pick<GcpApiDeps, "env" | "target" | "http">): Promise<Ok<GcpApiObservation> | GcpApiRefusal> {
  const verified = verifyGcpApiPlan(value, deps.target);
  if (!verified.ok) return verified;
  const plan = verified.plan;
  const read = await readTopic(plan.readBack.url, deps);
  if (!read.ok) return read;
  const owned = read.existence === "PRESENT" && sameLabels(read.labels, plan.resource.labels);
  return { ok: true, verified: owned, existence: read.existence, owned, calls: [evidenceOf("DISCOVERY", plan.readBack, read.existence === "ABSENT" ? 404 : 200)] };
}

export type GcpApiCleanupResult = { ok: true; outcome: "DELETED" | "ALREADY_ABSENT"; calls: CallEvidence[] } | (GcpApiRefusal & { calls: CallEvidence[] });

/**
 * Deletes the run-created topic only: the plan must be in this ledger as applied (or uncertain), and the topic must still
 * carry exactly the sealed labels. A topic that changed is kept (OWNERSHIP_MISMATCH). Verified absent by a read-back after.
 * Pub/Sub's delete takes no etag, so a label change between the read and the DELETE is not caught; this is accepted for one
 * run-named `alz-` topic in DEV (docs/act-pilot-gcp-api.md, "Cleanup").
 */
export async function cleanupGcpApiPlan(value: unknown, deps: GcpApiDeps): Promise<GcpApiCleanupResult> {
  const calls: CallEvidence[] = [];
  const stopped = (code: string): GcpApiCleanupResult => ({ ok: false, code, calls });
  if (deps.killSwitch()) return stopped("KILL_SWITCH_ACTIVE");
  const verified = verifyGcpApiPlan(value, deps.target);
  if (!verified.ok) return stopped(verified.code);
  const plan = verified.plan;
  if (!ledgerPrivate(deps.ledgerDir)) return stopped("LEDGER_NOT_PRIVATE");
  const state = stateOf(deps.ledgerDir, plan.artifactSha256);
  if (state === "CLEANED") return { ok: true, outcome: "ALREADY_ABSENT", calls };
  if (state !== "APPLIED" && state !== "UNCERTAIN") return stopped("NOT_RUN_CREATED");
  const before = await readTopic(plan.readBack.url, deps);
  if (!before.ok) return stopped(before.code);
  calls.push(evidenceOf("DISCOVERY", plan.readBack, before.existence === "ABSENT" ? 404 : 200));
  if (before.existence === "ABSENT") { record(deps.ledgerDir, plan.artifactSha256, "CLEANED"); return { ok: true, outcome: "ALREADY_ABSENT", calls }; }
  if (!sameLabels(before.labels, plan.resource.labels)) return stopped("OWNERSHIP_MISMATCH");
  const send = senderFor(plan.cleanup.url, deps.http ?? fetchGcpHttp);
  const bearer = await bearerFor("APPLY", deps, send);
  if (!bearer.ok) return stopped(bearer.code);
  if (deps.killSwitch()) return stopped("KILL_SWITCH_DURING_CLEANUP");
  const response = await send({ method: "DELETE", url: plan.cleanup.url, headers: { authorization: "Bearer " + bearer.token } });
  calls.push(evidenceOf("APPLY", plan.cleanup, response.status));
  if (response.status !== 200 && response.status !== 404) return stopped("DELETE_FAILED");
  const after = await readTopic(plan.readBack.url, deps);
  if (!after.ok) return stopped(after.code);
  calls.push(evidenceOf("DISCOVERY", plan.readBack, after.existence === "ABSENT" ? 404 : 200));
  if (after.existence !== "ABSENT") return stopped("CLEANUP_NOT_VERIFIED");
  record(deps.ledgerDir, plan.artifactSha256, "CLEANED");
  return { ok: true, outcome: response.status === 200 ? "DELETED" : "ALREADY_ABSENT", calls };
}
