import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createDiscoveryGcpReader } from "../../observe/gcp-rest.js";
import { canonicalJson, type ArtifactManifest } from "../../teardown/manifest.js";
import { ALZ_TAG_KEYS } from "../../teardown/unit.js";
import { checkCredentialConfiguration, exchangeSubjectToken, impersonateServiceAccount, readRegularFile, readTokenFile, SERVICE_ACCOUNT, STS_TOKEN_URL, type GcpTokenFailure } from "../../tools/gcp-credentials.js";
import { identityVariables } from "../../tools/identity.js";
import type { StoppableResult } from "../../tools/process.js";
import type { ToolName } from "../../tools/types.js";
import { sha256 } from "../../util/sha256.js";
import { assertCanary } from "../canary.js";
import { TOKEN_FILE } from "../constants.js";
import { codeOf, stop } from "../engine.js";
import type { ApplyEnd, EngineApplyRun, EngineCleanupRun, EnginePlan, EnginePlanInput, EngineRunInput, EngineSpec, StopControl } from "../engine-spec.js";
import { GCP_API_BACKEND_SENTINEL, GCP_API_TARGET, GCP_API_WORKSPACE, PARENT_LABEL, TOPIC_ID, TOPIC_PREFIX } from "../gcp-api-target.js";
import { GCP } from "../providers/gcp.js";
import type { PilotTarget, PlanChange, SealedUnit } from "../types.js";

// The driver types this engine names, through the spec (no import from the teardown driver: test/teardown-driver-denials.test.ts).
type AdapterDescriptor = EngineSpec["applyAdapter"];
type ResolvedTarget = EngineRunInput["target"];

/**
 * Path 6 of the narrow ACT-DEV release: GCP API-native provisioning (docs/act-pilot-gcp-api.md; the accepted design is
 * docs/act-pilot-gcp-api-driver.md, D1 to D20, with the owner's D4, D9, D11, D12 and D16 constraints of #39 6483366237).
 *
 * An `EngineSpec` for the shared pilot driver (src/apply/driver.ts). The driver owns everything that is not this engine's: the
 * contract, the kill switch, the target and its hash, the requester signature (D2), the approvals, the once-only ledger (D3), the
 * evidence, the blueprint, the independent observation through `GCP_REST` (D15) and the cleanup proposal. This module owns only
 * the typed request check, the derived REST calls, the network gate, the workload identity federation token exchange (through
 * the one shared exchange, D20) and its own reads of the run's topic.
 *
 * REGISTERED (INT-2) and admitted for DEV only: `GCP_API` is in `SPECS` (src/apply/engine-spec.ts) and `DEV_ONLY_PATHS`
 * (src/apply/contract.ts), with its own evidence mutations, the `GCP_API_TOPIC` blueprint source and the release gate act:gcp-gcp_api.
 * The engine's unit tests construct a spec directly (`gcpApiEngine`). ACT stays DISABLED until the owner's reviewed contract authorizes it.
 *
 * The workload: exactly one Pub/Sub topic, created once, with the run's unit labels and the contract region's storage policy. The
 * requester's whole request is `request.json`, `{ "schemaVersion": 1, "kind": "PUBSUB_TOPIC" }` (D7); every other value is derived
 * from the reviewed contract, the run's unit and the suffix drawn once at seal (D4, D10). The sealed artifact is the canonical JSON of
 * the exact three calls (create, read-back, cleanup), and the apply sends exactly those bytes' create, once.
 *
 * Requests go only to three fixed hosts over https: `sts.googleapis.com` (the token exchange), `iamcredentials.googleapis.com`
 * (the impersonation) and `pubsub.googleapis.com` (the run's one sealed topic URL only). The unit sweep goes through the GCP reader
 * (src/observe/gcp-rest.ts), which reads `cloudasset.googleapis.com` behind its own gate. Anything else is refused before it is
 * sent. Nothing is retried: a call that fails is reported, and an uncertain create or delete is settled by the read-back, never by
 * sending it again (D14, D16). Every refusal is a code; no response body, token or credential is ever carried in a result, a
 * record or an error. A refusal from an HTTP answer names the step and the status, never the body (D20).
 *
 * Nothing here has run against Google. Every Google behavior relied on is listed with its source in docs/act-pilot-gcp-api.md,
 * "Google API facts (GF1 to GF11)"; what only the owner's live run can show is marked there UNVERIFIED-OWNER-LIVE.
 */

export const GCP_API_ENGINE = "GCP_API" as const;
/** The engine's own version string (D7): the manifest's `engineVersion` must be exactly this. */
export const GCP_API_ENGINE_VERSION = "gcp-api-1";
/** The one requester-supplied file of a GCP_API project (D7). */
export const REQUEST_FILE = "request.json";
export const GCP_API_KINDS = ["PUBSUB_TOPIC"] as const;
/** The one resource type, in the product's reviewed GCP vocabulary (D8). */
export const TOPIC_TYPE = "google_pubsub_topic";
/** The evidence values D16 names (their members of the evidence enums in src/apply/types.ts). */
export const GCP_API_MUTATION = "GCP_PUBSUB_TOPIC_CREATE_OF_SEALED_REQUEST" as const;
export const GCP_API_CLEANUP_MUTATION = "GCP_PUBSUB_TOPIC_DELETE_OF_RUN_TOPIC" as const;
/** The exact property D11 sets and reads back, named in the evidence. It is not a data-residency claim. */
export const STORAGE_POLICY_PROPERTY = "messageStoragePolicy.allowedPersistenceRegions";

const STS_HOST = "sts.googleapis.com";
const IAM_CREDENTIALS_HOST = "iamcredentials.googleapis.com";
const PUBSUB_HOST = "pubsub.googleapis.com";
/** The scope the federated exchange asks for (GF8): what Google's own auth libraries send, and the one scope `generateAccessToken` lists. */
const SCOPE_EXCHANGE = "https://www.googleapis.com/auth/cloud-platform";
/**
 * The scope both identities' Pub/Sub bearers carry (GF2): the Pub/Sub v1 discovery document lists only `cloud-platform` and `pubsub`
 * on `topics.get`, `.create` and `.delete`, so the narrower of the two is requested. Read-only is IAM's job, not the scope's (D12).
 */
const SCOPE_PUBSUB = "https://www.googleapis.com/auth/pubsub";
const TOKEN_LIFETIME = "300s";
/** Each request's bound (docs/act-pilot-gcp-api-driver.md, section 6). A request past it is a status of 0: no answer. Never retried. */
export const REQUEST_TIMEOUT_MS = 30_000;
/** At most this many DISCOVERY reads settle an apply or a cleanup (D14, D16), this far apart. */
export const SETTLE_READS = 3;
export const SETTLE_DELAY_MS = 2_000;

/** A GCP project id. */
export const PROJECT_ID = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;
const REGION = /^[a-z]+-[a-z]+[0-9]{1,2}$/;
/** The run-unique suffix drawn once at seal (D4, D10): 6 random bytes. */
export const TOPIC_SUFFIX = /^[0-9a-f]{12}$/;
const TAG_VALUE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const UNIT_ID = /^alzu-[0-9a-f]{20}$/;
const LABEL_KEYS = [ALZ_TAG_KEYS.build, ALZ_TAG_KEYS.managedBy, ALZ_TAG_KEYS.unit].sort().join();
const IAM_URL = /^https:\/\/iamcredentials\.googleapis\.com\/v1\/projects\/-\/serviceAccounts\/[a-z0-9.@-]+:generateAccessToken$/;
// The one topic id rule of path 6 (src/apply/gcp-api-target.ts); re-exported so existing imports keep working.
export { TOPIC_ID };

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

/* ------------------------------------------------------------------ D1: the READY hash of the in-process module */

/**
 * The engine module and its transitive in-repository runtime imports, relative to the source root (`src/` in a checkout under tsx,
 * `dist/` in the packaged image), without the extension: the files the running product loads for this engine. A reviewed constant:
 * test/apply-gcp-api.test.ts computes the real import closure of this module and fails when it differs, so an added import cannot
 * escape the hash. Type-only imports are erased at run time and are not listed.
 */
export const GCP_API_MODULE_FILES: readonly string[] = [
  "apply/canary",
  "apply/constants",
  "apply/engine",
  "apply/engines/gcp-api",
  "apply/gcp-api-target",
  "apply/providers/gcp",
  "apply/providers/shared",
  "iac/changeset",
  "observe/gcp-rest",
  "teardown/manifest",
  "teardown/unit",
  "tools/gcp-credentials",
  "tools/identity",
  "util/sha256",
];

/**
 * The SHA-256 of the named preimage D1 defines, `{ kind: "IN_PROCESS_MODULE", engine: "GCP_API", files: [{ path, sha256 }] }` in canonical
 * JSON, sorted by path, each file read from `root`. Undefined when any file is missing or unreadable: the driver refuses that at seal
 * ("the engine program cannot be found or read") and at apply (`ENGINE_BINARY_CHANGED`), so it never means "unknown, go ahead".
 */
export function moduleClosureSha256(root: string, extension: string, files: readonly string[] = GCP_API_MODULE_FILES, read: (path: string) => Buffer = readFileSync): string | undefined {
  try {
    const entries = [...files].sort().map((file) => ({ path: file + extension, sha256: sha256(read(join(root, file + extension))) }));
    return sha256(canonicalJson({ kind: "IN_PROCESS_MODULE", engine: GCP_API_ENGINE, files: entries }));
  } catch {
    return undefined;
  }
}

/** The source root and extension of this module as it is loaded: `src/` and `.ts` under tsx, `dist/` and `.js` in the image. */
export function loadedModuleRoot(moduleUrl: string = import.meta.url): { root: string; extension: string } {
  const here = fileURLToPath(moduleUrl);
  return { root: resolve(dirname(here), "..", ".."), extension: extname(here) };
}

/* ------------------------------------------------------------------ transport */

export type GcpHttpRequest = { method: "GET" | "PUT" | "DELETE" | "POST"; url: string; headers: Readonly<Record<string, string>>; body?: string };
export type GcpHttpResponse = { status: number; body: string };
/** The HTTP client. Production: `fetch` with a per-request bound. Tests inject a fake or a loopback emulator. */
export type GcpHttp = (request: GcpHttpRequest) => Promise<GcpHttpResponse>;

/** `fetch` with no redirect followed and each request bounded by `REQUEST_TIMEOUT_MS`. Any failure is a status of 0 and an empty body. */
export const fetchGcpHttp: GcpHttp = async (request) => {
  try {
    const response = await fetch(request.url, { method: request.method, headers: { ...request.headers }, body: request.body, redirect: "error", signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    return { status: response.status, body: await response.text() };
  } catch {
    return { status: 0, body: "" };
  }
};

/** An https URL on exactly this host: no other scheme, no port, no userinfo, no query or fragment, and a path the parser leaves as written. */
const httpsOn = (url: string, host: string): boolean => {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && parsed.hostname === host && parsed.port === "" && parsed.username === "" && parsed.password === "" &&
      parsed.search === "" && parsed.hash === "" && parsed.href === url;
  } catch { return false; }
};

/**
 * The one gate every request of this engine passes. A POST goes to the one STS URL or a `generateAccessToken` URL; a GET, PUT or
 * DELETE goes to the run's one sealed topic URL and nothing else. `topic` is undefined before the run's topic is known: then only the
 * token POSTs pass.
 */
export function allowedRequest(request: Pick<GcpHttpRequest, "method" | "url">, topic: string | undefined, pubsubMethod: PubsubMethod | undefined): boolean {
  if (request.method === "POST") return (request.url === STS_TOKEN_URL && httpsOn(request.url, STS_HOST)) || (httpsOn(request.url, IAM_CREDENTIALS_HOST) && IAM_URL.test(request.url));
  // The one Pub/Sub method this sender exists for (#357 review N2): GET for DISCOVERY's reads, PUT for APPLY's create, DELETE for
  // APPLY's delete. Any other method (PATCH, a POST to the topic, a PUT through a read sender) is refused before it exists.
  return pubsubMethod !== undefined && request.method === pubsubMethod && topic !== undefined && request.url === topic && httpsOn(request.url, PUBSUB_HOST);
}
/** The Pub/Sub method a sender is for, each tied to one identity: GET is DISCOVERY's read, PUT and DELETE are APPLY's create and delete. */
export type PubsubMethod = "GET" | "PUT" | "DELETE";

/**
 * A gated sender for one topic and one purpose: every request is judged by `allowedRequest` before it exists, so a sender made for
 * DISCOVERY's read can never PUT or DELETE, and APPLY's create sender can never DELETE. Status 0 means not sent or no answer.
 */
function senderFor(topic: string | undefined, http: GcpHttp, pubsubMethod: PubsubMethod | undefined): GcpHttp {
  return async (request) => {
    if (!allowedRequest(request, topic, pubsubMethod)) return { status: 0, body: "HOST_REFUSED" };
    try { return await http(request); } catch { return { status: 0, body: "" }; }
  };
}

/* ------------------------------------------------------------------ refusal shapes (D20) */

type Step = "STS" | "IAM_CREDENTIALS" | "PUBSUB";
/** `<CLASS>_<STEP>_HTTP_<status>`, or `<CLASS>_<STEP>_NO_ANSWER`: the step and the status, never the answer's body. */
const statusCode = (klass: string, step: Step, status: number): string => klass + "_" + step + (status === 0 ? "_NO_ANSWER" : "_HTTP_" + status);

/**
 * This engine's refusal for a failed token step. A request the shared exchange refused before sending (a malformed service account,
 * lifetime or scope list) is the identity's configuration, never a refused host; the gate's refusal is `HOST_REFUSED`; a 200 with no
 * usable token is `UNEXPECTED_RESPONSE`; 400, 401 and 403 are `CREDENTIALS` (a live 400 from STS is the open GF1 question first,
 * docs/act-pilot-gcp-evidence.md); anything else is `HTTP_ERROR`. Each answered refusal carries its step and status.
 */
export function tokenRefusal(failure: GcpTokenFailure): string {
  if (failure.invalidInput) return "IDENTITY_NOT_CONFIGURED";
  if (failure.hostRefused) return "HOST_REFUSED";
  const step: Step = failure.step === "EXCHANGE" ? "STS" : "IAM_CREDENTIALS";
  if (failure.malformed) return statusCode("UNEXPECTED_RESPONSE", step, failure.status);
  if (failure.status === 0) return statusCode("HTTP_ERROR", step, 0);
  return statusCode(failure.status === 400 || failure.status === 401 || failure.status === 403 ? "CREDENTIALS" : "HTTP_ERROR", step, failure.status);
}

/** A Pub/Sub read's refusal class, with the status. */
const readRefusal = (status: number): string =>
  statusCode(status === 401 ? "CREDENTIALS" : status === 403 ? "ACCESS_DENIED" : status === 429 ? "THROTTLED" : "HTTP_ERROR", "PUBSUB", status);

/* ------------------------------------------------------------------ identities and tokens */

type Identity = "APPLY" | "DISCOVERY";
type GoogleIdentity = { audience: string; subjectTokenType: string; tokenFile: string; serviceAccount: string };

/**
 * The identity's credential configuration, judged by path 5's rules (src/apply/providers/gcp.ts and the shared
 * src/tools/gcp-credentials.ts), so one file has one verdict: first every identity in the environment together (no fallback variable,
 * no identity carrying the operator's own credentials, no two identities sharing a service account, a credential configuration or a
 * token file: `IDENTITY_COLLAPSED`), then this identity's file (a workload identity federation file source, with no
 * `service_account_impersonation_url` of its own). Its service account must be of the contract's project. The driver runs the same
 * checks first (`checkApplyIdentities`, `verifyIdentityTargets`, the delivered-token checks); this is the engine's own second line.
 */
function identityOf(env: NodeJS.ProcessEnv, identity: Identity, projectId: string): GoogleIdentity {
  const ambient = GCP.ambientRefusal(env);
  if (ambient) return stop(ambient.code);
  const variables = identityVariables(env, identity);
  const configPath = variables.get("GOOGLE_APPLICATION_CREDENTIALS") ?? "";
  const serviceAccount = variables.get("GOOGLE_IMPERSONATE_SERVICE_ACCOUNT") ?? "";
  const sa = SERVICE_ACCOUNT.exec(serviceAccount);
  if (!TOKEN_FILE.test(configPath) || !sa || sa[1] !== projectId) return stop("IDENTITY_NOT_CONFIGURED");
  const config = checkCredentialConfiguration(configPath);
  if (!config.ok) return stop("IDENTITY_NOT_CONFIGURED");
  return { audience: config.audience, subjectTokenType: config.subjectTokenType, tokenFile: config.tokenFile, serviceAccount };
}

/**
 * A short-lived Pub/Sub access token for one identity, held in memory for one call and dropped: the OIDC token file is read when it is
 * needed (the delivery runner re-mints it, docs/act-pilot-identity-delivery.md), exchanged once at STS, and the federated token is
 * used once to impersonate the identity's service account. Nothing is written or cached. Throws a code before any Pub/Sub request.
 */
async function bearerFor(identity: Identity, env: NodeJS.ProcessEnv, projectId: string, send: GcpHttp): Promise<string> {
  const id = identityOf(env, identity, projectId);
  // A regular file of one word, read without blocking (a FIFO in its place cannot hang the run).
  const subjectToken = readTokenFile(id.tokenFile);
  if (subjectToken === undefined) return stop("CREDENTIALS_TOKEN_FILE");
  const federated = await exchangeSubjectToken(send, { audience: id.audience, subjectTokenType: id.subjectTokenType, subjectToken, scope: SCOPE_EXCHANGE });
  if (!federated.ok) return stop(tokenRefusal(federated));
  const impersonated = await impersonateServiceAccount(send, { federatedToken: federated.token, serviceAccount: id.serviceAccount, scopes: [SCOPE_PUBSUB], lifetime: TOKEN_LIFETIME });
  return impersonated.ok ? impersonated.token : stop(tokenRefusal(impersonated));
}

/* ------------------------------------------------------------------ the request, the target, the unit (D7, D9, D10) */

export type GcpApiRequest = { schemaVersion: 1; kind: (typeof GCP_API_KINDS)[number] };

/**
 * The requester's whole request: `request.json`, the project's one file, with exactly `schemaVersion` 1 and `kind` `PUBSUB_TOPIC`.
 * Any other key is `FIELD_NOT_ALLOWED`, any other kind `KIND_NOT_ALLOWED`; a project holding any other file is `PROJECT_NOT_ALLOWED`.
 */
export function checkRequest(value: unknown): GcpApiRequest {
  if (!isRecord(value)) return stop("REQUEST_INVALID");
  if (Object.keys(value).some((key) => key !== "schemaVersion" && key !== "kind")) return stop("FIELD_NOT_ALLOWED");
  if (value.schemaVersion !== 1) return stop("REQUEST_INVALID");
  if (!(GCP_API_KINDS as readonly unknown[]).includes(value.kind)) return stop("KIND_NOT_ALLOWED");
  return { schemaVersion: 1, kind: "PUBSUB_TOPIC" };
}

function readRequest(snapshotPath: string, manifest: Pick<ArtifactManifest, "files">, engineVersion: string): GcpApiRequest {
  if (engineVersion !== GCP_API_ENGINE_VERSION) return stop("ENGINE_VERSION_NOT_SUPPORTED");
  if (manifest.files.length !== 1 || manifest.files[0]?.path !== REQUEST_FILE) return stop("PROJECT_NOT_ALLOWED");
  let parsed: unknown;
  try {
    const bytes = readRegularFile(join(snapshotPath, REQUEST_FILE), 4096);
    if (bytes === undefined) return stop("REQUEST_INVALID");
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return stop("REQUEST_INVALID");
  }
  return checkRequest(parsed);
}

/** The contract target as this path reads it (D9). `parent` is carried for display only, labeled owner-declared, and never read. */
export type GcpApiTarget = { projectId: string; region: string; topicPrefix: string; parent?: string };

/** The pinned target, judged again here (the contract reader judged it first), and the run's resolved target, which must be the same. */
export function targetOf(pinned: PilotTarget, resolved: ResolvedTarget): GcpApiTarget {
  const t = pinned as unknown as Record<string, unknown>;
  if (typeof t.projectId !== "string" || !PROJECT_ID.test(t.projectId) || typeof t.region !== "string" || !REGION.test(t.region) ||
    typeof t.topicPrefix !== "string" || !TOPIC_PREFIX.test(t.topicPrefix) || t.backend !== GCP_API_BACKEND_SENTINEL || t.workspace !== GCP_API_WORKSPACE) {
    return stop("TARGET_NOT_IN_CONTRACT");
  }
  if (resolved.account !== t.projectId || resolved.backend !== GCP_API_BACKEND_SENTINEL || resolved.workspace !== GCP_API_WORKSPACE) return stop("TARGET_NOT_IN_CONTRACT");
  return { projectId: t.projectId, region: t.region, topicPrefix: t.topicPrefix, ...(typeof t.parent === "string" ? { parent: t.parent } : {}) };
}

/** What a run of this engine is told about its unit: the driver's unit at seal (`EnginePlanInput.unit`), the sealed unit at apply and cleanup. */
export type GcpApiUnit = { unitId: string; tags: Readonly<Record<string, string>> };

/** The run's labels: exactly the unit's three `alz-*` tags, `alz-managed-by` = `alz` and `alz-unit` = the unit id (D10). */
export function unitLabels(unit: GcpApiUnit | undefined): Record<string, string> {
  if (!unit || !isRecord(unit.tags) || typeof unit.unitId !== "string" || !UNIT_ID.test(unit.unitId)) return stop("UNIT_NOT_GIVEN");
  const tags = unit.tags as Record<string, unknown>;
  if (Object.keys(tags).sort().join() !== LABEL_KEYS || !Object.values(tags).every((v) => typeof v === "string" && TAG_VALUE.test(v)) ||
    tags[ALZ_TAG_KEYS.managedBy] !== "alz" || tags[ALZ_TAG_KEYS.unit] !== unit.unitId) {
    return stop("UNIT_INVALID");
  }
  return { ...(tags as Record<string, string>) };
}

/* ------------------------------------------------------------------ the artifact: the exact calls (D7) */

export type GcpApiCall = { method: "PUT" | "GET" | "DELETE"; url: string; body?: { labels: Record<string, string>; messageStoragePolicy: { allowedPersistenceRegions: string[] } } };
export type GcpApiArtifact = {
  schemaVersion: 1; kind: "GCP_API_PUBSUB_TOPIC"; projectId: string; topicId: string; labels: Record<string, string>;
  messageStoragePolicy: { allowedPersistenceRegions: string[] }; precondition: "ABSENT"; create: GcpApiCall; readBack: GcpApiCall; cleanup: GcpApiCall;
};

export const topicUrl = (projectId: string, topicId: string): string => "https://" + PUBSUB_HOST + "/v1/projects/" + projectId + "/topics/" + topicId;
export const topicAddress = (topicId: string): string => TOPIC_TYPE + "." + topicId;
const storagePolicyOf = (region: string) => ({ allowedPersistenceRegions: [region] });

/** Every field derived: the project and region from the contract, the labels from the unit, the topic from the prefix and the sealed suffix. */
export function artifactOf(target: GcpApiTarget, labels: Record<string, string>, topicId: string): GcpApiArtifact {
  const url = topicUrl(target.projectId, topicId);
  return {
    schemaVersion: 1, kind: "GCP_API_PUBSUB_TOPIC", projectId: target.projectId, topicId, labels: { ...labels }, messageStoragePolicy: storagePolicyOf(target.region),
    precondition: "ABSENT",
    create: { method: "PUT", url, body: { labels: { ...labels }, messageStoragePolicy: storagePolicyOf(target.region) } },
    readBack: { method: "GET", url },
    cleanup: { method: "DELETE", url },
  };
}
const bytesOf = (artifact: GcpApiArtifact): Buffer => Buffer.from(canonicalJson(artifact), "utf8");

/** The one change approvers read (D7): one CREATE of the run's topic, by its full sealed name. */
const changesOf = (topicId: string): PlanChange[] => [{ address: topicAddress(topicId), type: TOPIC_TYPE, action: "CREATE" }];
/** The canary allowlist judged on that change (D8): exactly one `google_pubsub_topic`, create only. */
const assertTopicInCanary = (pinned: PilotTarget, topicId: string): void =>
  assertCanary(pinned.canary, [{ address: topicAddress(topicId), type: TOPIC_TYPE, action: "CREATE", creates: true }], "request");

/** A topic id this target's prefix owns: the prefix followed by exactly the 12-hex suffix. */
const ownedTopicId = (target: GcpApiTarget, topicId: unknown): topicId is string =>
  typeof topicId === "string" && TOPIC_ID.test(topicId) && topicId.startsWith(target.topicPrefix) && TOPIC_SUFFIX.test(topicId.slice(target.topicPrefix.length));

/**
 * The sealed artifact derived again (D7): its topic must be the target's prefix and a 12-hex suffix, and every other byte must be what
 * the contract target, the unit and that suffix derive. Anything else (another URL, body, label, storage policy or call) is
 * ARTIFACT_TAMPERED. The suffix is the one thing taken from the artifact, so nothing regenerates the sealed name (D4).
 */
export function rederiveArtifact(bytes: Buffer, target: GcpApiTarget, labels: Record<string, string>): GcpApiArtifact {
  let parsed: unknown;
  try { parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch { return stop("ARTIFACT_TAMPERED"); }
  if (!isRecord(parsed) || !ownedTopicId(target, parsed.topicId)) return stop("ARTIFACT_TAMPERED");
  const artifact = artifactOf(target, labels, parsed.topicId);
  if (!bytesOf(artifact).equals(bytes)) return stop("ARTIFACT_TAMPERED");
  return artifact;
}

/* ------------------------------------------------------------------ DISCOVERY reads */

export type TopicReading =
  | { existence: "PRESENT"; name: string; labels: Record<string, string> | undefined; regions: string[] | undefined }
  | { existence: "ABSENT" }
  /** A read that failed (401, 403, 429, 5xx, no answer, an unexpected body): never absence. */
  | { existence: "UNREADABLE"; code: string };

/** The run's topic, read once under DISCOVERY through the gate. Only the name, the labels and the storage policy's regions are kept. */
async function readTopic(url: string, projectId: string, env: NodeJS.ProcessEnv, http: GcpHttp): Promise<TopicReading> {
  const send = senderFor(url, http, "GET");
  let bearer: string;
  try { bearer = await bearerFor("DISCOVERY", env, projectId, send); } catch (error) { return { existence: "UNREADABLE", code: codeOf(error) }; }
  const response = await send({ method: "GET", url, headers: { authorization: "Bearer " + bearer, accept: "application/json" } });
  if (response.status === 404) return { existence: "ABSENT" };
  if (response.status !== 200) return { existence: "UNREADABLE", code: response.status === 0 && response.body === "HOST_REFUSED" ? "HOST_REFUSED" : readRefusal(response.status) };
  try {
    const body = JSON.parse(response.body) as { name?: unknown; labels?: unknown; messageStoragePolicy?: unknown };
    const expected = new URL(url).pathname.replace(/^\/v1\//, "");
    if (!isRecord(body) || body.name !== expected) return { existence: "UNREADABLE", code: "UNEXPECTED_RESPONSE_PUBSUB_HTTP_200" };
    const labels = body.labels === undefined ? {} : isRecord(body.labels) && Object.values(body.labels).every((v) => typeof v === "string") ? { ...(body.labels as Record<string, string>) } : undefined;
    const policy = isRecord(body.messageStoragePolicy) ? body.messageStoragePolicy.allowedPersistenceRegions : undefined;
    const regions = Array.isArray(policy) && policy.every((r) => typeof r === "string") ? [...(policy as string[])] : undefined;
    return { existence: "PRESENT", name: expected, labels, regions };
  } catch {
    return { existence: "UNREADABLE", code: "UNEXPECTED_RESPONSE_PUBSUB_HTTP_200" };
  }
}

const sameLabels = (a: Record<string, string> | undefined, b: Record<string, string>): boolean =>
  a !== undefined && Object.keys(a).sort().join() === Object.keys(b).sort().join() && Object.entries(b).every(([k, v]) => a[k] === v);
/** Present with exactly the sealed labels and exactly the sealed storage policy (D11): the only reading that is ever the run's own topic. */
const matchesSealed = (reading: TopicReading, labels: Record<string, string>, region: string): boolean =>
  reading.existence === "PRESENT" && sameLabels(reading.labels, labels) && reading.regions !== undefined && reading.regions.length === 1 && reading.regions[0] === region;

/**
 * The target-wide one-open-run check (D10), through the GCP reader's `listTagged` (Cloud Asset, DISCOVERY): anything listed under the
 * unit is `UNIT_NOT_EMPTY`; a listing that failed or did not finish is `UNIT_LISTING_INCOMPLETE`. Not a guarantee: Cloud Asset is
 * eventually consistent (GF5), so a topic created inside its indexing window is not listed yet (docs/act-pilot-gcp-api.md, "Residual").
 */
async function sweepUnit(unitId: string, projectId: string, env: NodeJS.ProcessEnv, http: GcpHttp): Promise<void> {
  const opened = createDiscoveryGcpReader({ env, projectId, http });
  try {
    const listed = await opened.reader.listTagged(unitId);
    if (listed === undefined || !listed.complete) stop("UNIT_LISTING_INCOMPLETE");
    if (listed!.identifiers.length > 0) stop("UNIT_NOT_EMPTY");
  } finally {
    opened.close();
  }
}

const sleep = (ms: number): Promise<void> => new Promise((done) => { setTimeout(done, ms); });

/* ------------------------------------------------------------------ the spec's runs */

/** What a run of this engine is given: the driver's run input and the run's sealed unit (the driver passes `sealed.unit`). */
export type GcpApiRunInput = EngineRunInput & { unit?: GcpApiUnit | SealedUnit };
/** The blueprint document (D6): the topic's name and labels as the engine's DISCOVERY read-back saw them, under the `GCP_API_TOPIC` source. */
export type GcpApiStateDocument = { source: "GCP_API_TOPIC"; document: string };
export type GcpApiApplyRun = Omit<EngineApplyRun, "stateDocument"> & {
  stateDocument(): Promise<GcpApiStateDocument | undefined>;
  /** The Pub/Sub answer to the one PUT (0: no answer), for tests and evidence; undefined when nothing was sent. */
  createStatus(): number | undefined;
};
export type GcpApiCleanupRun = EngineCleanupRun & {
  /**
   * Whether this run's DELETE removed the topic (D16, `deletedByRun`, recorded in `CleanupEvidence`): true only for a 200 and a
   * read-back absent, false for a 404 and a read-back absent ("already absent, not deleted by this run"), undefined otherwise.
   */
  deletedByRun(): boolean | undefined;
};

const TOOL: ToolName = "gcp_pubsub_topic";
const outcomeResult = (over: Partial<StoppableResult>): StoppableResult => ({ tool: TOOL, ok: false, exitCode: null, stdout: "", stderr: "", durationMs: 0, stopped: false, ...over });
const notStarted = (what: string): StoppableResult => outcomeResult({ stopped: true, notStarted: true, stderr: "Stopped before the " + what + " was sent." });
/** The exit code the evidence records for one call: 0 for 200, 1 for any other answer, null for no answer. */
const exitOf = (status: number): number | null => (status === 200 ? 0 : status === 0 ? null : 1);

/** Refusals of a create that are definite (D14): Pub/Sub refused the one PUT, so a topic absent on every read was not created. */
const DEFINITE_CREATE_REFUSALS: ReadonlySet<number> = new Set([400, 401, 403, 404, 429]);
/** Refusals of a delete that are definite (D16). A 404 has its own row. */
const DEFINITE_DELETE_REFUSALS: ReadonlySet<number> = new Set([400, 401, 403, 429]);

export type GcpApiOptions = {
  /** The HTTP client for every request of this engine and its unit sweep. Default: `fetchGcpHttp`. */
  http?: GcpHttp;
  /** Settle reads and their spacing (D14, D16). Tests shorten the spacing; the count is never raised to hide a failure. */
  settleReads?: number;
  settleDelayMs?: number;
};

function openApplyWith(options: Required<GcpApiOptions>, input: GcpApiRunInput): GcpApiApplyRun {
  let prepared: { target: GcpApiTarget; labels: Record<string, string> } | undefined;
  let sealed: { bytes: Buffer; artifact: GcpApiArtifact } | undefined;
  let putStatus: number | undefined;
  let lastPresent: Extract<TopicReading, { existence: "PRESENT" }> | undefined;
  let verified = false;
  const read = async (url: string): Promise<TopicReading> => {
    const reading = await readTopic(url, prepared!.target.projectId, input.env, options.http);
    if (reading.existence === "PRESENT") lastPresent = reading;
    return reading;
  };
  return {
    async prepare(snapshotPath) {
      readRequest(snapshotPath, input.manifest, input.engineVersion);
      const target = targetOf(input.pinned, input.target);
      const labels = unitLabels(input.unit);
      identityOf(input.env, "DISCOVERY", target.projectId);
      identityOf(input.env, "APPLY", target.projectId);
      // D10, the second sweep: before any approval is consumed, the unit must still list nothing, completely.
      await sweepUnit(labels[ALZ_TAG_KEYS.unit], target.projectId, input.env, options.http);
      prepared = { target, labels };
    },
    async rederive(artifact) {
      if (prepared === undefined) return stop("ENGINE_NOT_PREPARED");
      const derived = rederiveArtifact(artifact, prepared.target, prepared.labels);
      assertTopicInCanary(input.pinned, derived.topicId);
      // The sealed topic itself must still read absent by its own GET (D10, D14): present is a stale plan; unreadable is never absent.
      const reading = await read(derived.readBack.url);
      if (reading.existence === "PRESENT") return stop("PLAN_STALE");
      if (reading.existence === "UNREADABLE") return stop(reading.code);
      sealed = { bytes: Buffer.from(artifact), artifact: derived };
      return changesOf(derived.topicId);
    },
    async execute(artifact, control: StopControl) {
      if (prepared === undefined || sealed === undefined) return stop("ENGINE_NOT_PREPARED");
      if (!sealed.bytes.equals(artifact)) return stop("ARTIFACT_TAMPERED");
      if (control.stopWhen()) return notStarted("create");
      const create = sealed.artifact.create;
      const send = senderFor(create.url, options.http, "PUT");
      // A throw here means nothing was sent to Pub/Sub: the driver reports APPROVALS_SPENT, and nothing was created.
      const bearer = await bearerFor("APPLY", input.env, prepared.target.projectId, send);
      if (control.stopWhen()) return notStarted("create");
      // From the PUT on nothing throws, and nothing is sent again: the one answer (or none) is what `settle` judges with the read-back.
      putStatus = 0;
      try {
        const response = await send({ method: "PUT", url: create.url, headers: { authorization: "Bearer " + bearer, "content-type": "application/json" }, body: JSON.stringify(create.body) });
        putStatus = response.status;
      } catch { /* no answer */ }
      return outcomeResult({ ok: putStatus === 200, exitCode: exitOf(putStatus) });
    },
    async settle(): Promise<ApplyEnd> {
      if (prepared === undefined || sealed === undefined || putStatus === undefined) return { outcome: "PARTIAL_REQUIRES_REVIEW" };
      const { labels, target } = prepared;
      const url = sealed.artifact.readBack.url;
      // 409: another topic of this run-unique name exists. Never success and never "no change": a person looks (D14). Read once for the blueprint.
      if (putStatus === 409) { await read(url); return { outcome: "PARTIAL_REQUIRES_REVIEW" }; }
      if (DEFINITE_CREATE_REFUSALS.has(putStatus)) {
        // A definite refusal is FAILED_NO_CHANGE only when the topic reads absent (404) on every read; present or unreadable is review.
        for (let reads = 0; reads < options.settleReads; reads++) {
          if (reads > 0) await sleep(options.settleDelayMs);
          if ((await read(url)).existence !== "ABSENT") return { outcome: "PARTIAL_REQUIRES_REVIEW" };
        }
        return { outcome: "FAILED_NO_CHANGE" };
      }
      // 200, 5xx, no answer, or any other status: positive evidence only. Present with the sealed labels and storage policy is SUCCEEDED;
      // present otherwise is review; absent or unreadable after every read is review, because a create may still land.
      for (let reads = 0; reads < options.settleReads; reads++) {
        if (reads > 0) await sleep(options.settleDelayMs);
        const reading = await read(url);
        if (reading.existence === "PRESENT") {
          verified = matchesSealed(reading, labels, target.region);
          return { outcome: verified ? "SUCCEEDED" : "PARTIAL_REQUIRES_REVIEW" };
        }
      }
      return { outcome: "PARTIAL_REQUIRES_REVIEW" };
    },
    recoveryFiles: async () => [],
    // Tokens live in this run's memory only and no file is written: there is nothing to remove.
    removeSecrets: () => undefined,
    // D6: what `settle` read, never a new read; labels as read, for the driver to map to one blueprint entry and drop.
    stateDocument: async () => lastPresent === undefined ? undefined : { source: "GCP_API_TOPIC", document: canonicalJson({ name: lastPresent.name, labels: lastPresent.labels ?? {} }) },
    createStatus: () => putStatus,
    // D11: named for the evidence only after `settle` read the topic back with exactly the sealed storage policy (the driver records it for SUCCEEDED).
    verifiedProperty: () => verified ? { name: STORAGE_POLICY_PROPERTY, value: [prepared!.target.region] } : undefined,
  };
}

const ADDRESS = /^google_pubsub_topic\.([a-z0-9-]{1,64})$/;

function openCleanupWith(options: Required<GcpApiOptions>, input: GcpApiRunInput): GcpApiCleanupRun {
  let prepared: { target: GcpApiTarget; labels: Record<string, string> } | undefined;
  let before: { url: string; reading: Extract<TopicReading, { existence: "PRESENT" }> } | undefined;
  let deleteStatus: number | undefined;
  let deleted: boolean | undefined;
  const read = (url: string): Promise<TopicReading> => readTopic(url, prepared!.target.projectId, input.env, options.http);
  return {
    async prepare(snapshotPath) {
      readRequest(snapshotPath, input.manifest, input.engineVersion);
      const target = targetOf(input.pinned, input.target);
      const labels = unitLabels(input.unit);
      identityOf(input.env, "DISCOVERY", target.projectId);
      identityOf(input.env, "APPLY", target.projectId);
      prepared = { target, labels };
    },
    /**
     * Exactly one address, the run's topic in the target's project and prefix, and only after a DISCOVERY read shows it exists with
     * exactly the unit's labels and the sealed storage policy (D16). Absent is `CLEANUP_NO_CHANGES` (already absent, not deleted by
     * this run); a read that fails is `CLEANUP_READ_FAILED`, never absence; anything else present is `OWNERSHIP_MISMATCH`, and the
     * topic is kept. Every refusal comes before any approval is consumed.
     */
    async planDestroy(addresses) {
      if (prepared === undefined) return stop("ENGINE_NOT_PREPARED");
      if (addresses.length !== 1) return stop("CLEANUP_ADDRESSES_INVALID");
      const topicId = ADDRESS.exec(addresses[0])?.[1];
      if (!ownedTopicId(prepared.target, topicId)) return stop("CLEANUP_ADDRESS_NOT_IN_CONTRACT");
      const url = topicUrl(prepared.target.projectId, topicId);
      const reading = await read(url);
      if (reading.existence === "ABSENT") return stop("CLEANUP_NO_CHANGES");
      if (reading.existence === "UNREADABLE") return stop("CLEANUP_READ_FAILED");
      if (!matchesSealed(reading, prepared.labels, prepared.target.region)) return stop("OWNERSHIP_MISMATCH");
      before = { url, reading };
      return [{ address: topicAddress(topicId), type: TOPIC_TYPE, action: "DELETE" }];
    },
    async execute(control) {
      if (prepared === undefined || before === undefined) return stop("ENGINE_NOT_PREPARED");
      if (control.stopWhen()) return notStarted("delete");
      const send = senderFor(before.url, options.http, "DELETE");
      const bearer = await bearerFor("APPLY", input.env, prepared.target.projectId, send);
      if (control.stopWhen()) return notStarted("delete");
      // One DELETE of the exact sealed URL, never sent again.
      deleteStatus = 0;
      try {
        deleteStatus = (await send({ method: "DELETE", url: before.url, headers: { authorization: "Bearer " + bearer } })).status;
      } catch { /* no answer */ }
      return outcomeResult({ ok: deleteStatus === 200, exitCode: exitOf(deleteStatus) });
    },
    async settle(): Promise<ApplyEnd> {
      if (prepared === undefined || before === undefined || deleteStatus === undefined) return { outcome: "PARTIAL_REQUIRES_REVIEW" };
      const status = deleteStatus;
      if (status === 200 || status === 404) {
        // Absent means a 404 on the read; a failed read is unreadable, never absent. Present after every read is review.
        for (let reads = 0; reads < options.settleReads; reads++) {
          if (reads > 0) await sleep(options.settleDelayMs);
          if ((await read(before.url)).existence === "ABSENT") {
            deleted = status === 200;
            return { outcome: "SUCCEEDED" };
          }
        }
        return { outcome: "PARTIAL_REQUIRES_REVIEW" };
      }
      if (DEFINITE_DELETE_REFUSALS.has(status)) {
        // Not deleted only when every read shows the topic present and unchanged.
        for (let reads = 0; reads < options.settleReads; reads++) {
          if (reads > 0) await sleep(options.settleDelayMs);
          const reading = await read(before.url);
          if (!matchesSealed(reading, prepared.labels, prepared.target.region)) return { outcome: "PARTIAL_REQUIRES_REVIEW" };
        }
        return { outcome: "FAILED_NO_CHANGE" };
      }
      // A timeout, a 5xx, no answer or any other status: uncertain. Reconciliation, never "no change" (D16).
      return { outcome: "PARTIAL_REQUIRES_REVIEW" };
    },
    recoveryFiles: async () => [],
    removeSecrets: () => undefined,
    deletedByRun: () => deleted,
  };
}

/**
 * The qualification run (D13): the engine's own read-only steps, as each identity. DISCOVERY mints its Pub/Sub token and sweeps the
 * unit; APPLY mints its token and makes no Pub/Sub call. Nothing is created. The person then attests the two principals from the
 * cloud's audit logs.
 */
async function qualifyWith(options: Required<GcpApiOptions>, input: EnginePlanInput): Promise<void> {
  readRequest(input.snapshotPath, input.manifest, input.engineVersion);
  const target = targetOf(input.pinned, input.target);
  const labels = unitLabels(input.unit);
  const send = senderFor(undefined, options.http, undefined);
  await bearerFor("DISCOVERY", input.env, target.projectId, send);
  await sweepUnit(labels[ALZ_TAG_KEYS.unit], target.projectId, input.env, options.http);
  await bearerFor("APPLY", input.env, target.projectId, send);
}

/**
 * Sealing (D7, D10, D13): the request, the target and the unit judged; the run-unique suffix drawn ONCE here; the artifact and its
 * one-line change list derived; the canary judged; then, under DISCOVERY, the exact topic must read absent and the unit sweep must be
 * complete and empty. The suffix is inside the artifact, so every approver signs the one exact topic name (D4).
 */
async function planWith(options: Required<GcpApiOptions>, input: EnginePlanInput): Promise<EnginePlan> {
  readRequest(input.snapshotPath, input.manifest, input.engineVersion);
  const target = targetOf(input.pinned, input.target);
  const labels = unitLabels(input.unit);
  identityOf(input.env, "DISCOVERY", target.projectId);
  identityOf(input.env, "APPLY", target.projectId);
  const topicId = target.topicPrefix + randomBytes(6).toString("hex");
  if (!ownedTopicId(target, topicId)) return stop("TOPIC_ID_INVALID");
  const artifact = artifactOf(target, labels, topicId);
  assertTopicInCanary(input.pinned, topicId);
  const reading = await readTopic(artifact.readBack.url, target.projectId, input.env, options.http);
  if (reading.existence === "PRESENT") return stop("TOPIC_EXISTS");
  if (reading.existence === "UNREADABLE") return stop(reading.code);
  await sweepUnit(labels[ALZ_TAG_KEYS.unit], target.projectId, input.env, options.http);
  return { artifact: bytesOf(artifact), changes: changesOf(topicId), unit: { unitId: labels[ALZ_TAG_KEYS.unit], tags: { ...labels }, untagged: [] } };
}

/* ------------------------------------------------------------------ the spec */

/** Every request each adapter can make, as whom and with which scope: the adapter's `argvDigest` is over exactly this. */
const ADAPTER_CALLS = {
  preview: [
    { identity: "DISCOVERY", method: "GET", url: "https://pubsub.googleapis.com/v1/projects/<project>/topics/<sealed topic>", scope: SCOPE_PUBSUB },
    { identity: "DISCOVERY", method: "GET", url: "https://cloudasset.googleapis.com/v1/projects/<project>:searchAllResources?query=labels.alz-unit=<unit>", scope: "reader" },
  ],
  apply: [
    { identity: "DISCOVERY", method: "GET", url: "https://pubsub.googleapis.com/v1/projects/<project>/topics/<sealed topic>", scope: SCOPE_PUBSUB },
    { identity: "DISCOVERY", method: "GET", url: "https://cloudasset.googleapis.com/v1/projects/<project>:searchAllResources?query=labels.alz-unit=<unit>", scope: "reader" },
    { identity: "APPLY", method: "PUT", url: "https://pubsub.googleapis.com/v1/projects/<project>/topics/<sealed topic>", scope: SCOPE_PUBSUB },
  ],
  cleanup: [
    { identity: "DISCOVERY", method: "GET", url: "https://pubsub.googleapis.com/v1/projects/<project>/topics/<run topic>", scope: SCOPE_PUBSUB },
    { identity: "APPLY", method: "DELETE", url: "https://pubsub.googleapis.com/v1/projects/<project>/topics/<run topic>", scope: SCOPE_PUBSUB },
  ],
} as const;
const ADAPTER_VERSIONS = { preview: "gcp-api-preview-1.0.0", apply: "gcp-api-apply-1.0.0", cleanup: "gcp-api-cleanup-1.0.0" } as const;
const adapterOf = (kind: keyof typeof ADAPTER_CALLS): AdapterDescriptor => ({
  engine: "GCP_API", adapterVersion: ADAPTER_VERSIONS[kind],
  argvDigest: sha256(canonicalJson({ engine: GCP_API_ENGINE, adapter: kind, exchange: { url: STS_TOKEN_URL, scope: SCOPE_EXCHANGE }, impersonation: { lifetime: TOKEN_LIFETIME }, calls: ADAPTER_CALLS[kind] })),
});

/**
 * The spec's own type: `EngineSpec` with the GCP_API id, its two evidence `mutation` values (D16) and its runs, which take the run's
 * sealed unit and say what the engine read. It is registered in `SPECS`, and the driver passes `unit` from the sealed plan into
 * `openApply` and `openCleanup` (INT-2).
 */
export type GcpApiEngineSpec = Omit<EngineSpec, "id" | "mutation" | "cleanupMutation" | "openApply" | "openCleanup" | "plan" | "qualify"> & {
  id: typeof GCP_API_ENGINE;
  mutation: typeof GCP_API_MUTATION;
  cleanupMutation: typeof GCP_API_CLEANUP_MUTATION;
  plan(input: EnginePlanInput): Promise<EnginePlan>;
  qualify(input: EnginePlanInput): Promise<void>;
  openApply(input: GcpApiRunInput): GcpApiApplyRun;
  openCleanup(input: GcpApiRunInput): GcpApiCleanupRun;
};

/** The GCP_API spec, with an injected HTTP client for tests. The production spec is `GCP_API`. */
export function gcpApiEngine(given: GcpApiOptions = {}): GcpApiEngineSpec {
  const options: Required<GcpApiOptions> = { http: given.http ?? fetchGcpHttp, settleReads: given.settleReads ?? SETTLE_READS, settleDelayMs: given.settleDelayMs ?? SETTLE_DELAY_MS };
  return {
    id: GCP_API_ENGINE,
    // D1: no external program runs. `prepare.ts` and `readiness.ts` loop over this, so an empty list means "no external tool".
    executables: [],
    providers: ["GCP"],
    // D4, D9: the shared target shape, `topicPrefix` as a location field (src/apply/gcp-api-target.ts).
    target: GCP_API_TARGET,
    // D8: exactly the one reviewed GCP type, never a pattern.
    canaryTypeOk: (value) => value === TOPIC_TYPE,
    // D8 and #358 review N4: one topic per run, so the canary's count is exactly 1, refused at contract load otherwise.
    canaryCountMax: 1,
    notices: {
      sealHeading: "SEAL A PUB/SUB TOPIC PLAN (this reads Pub/Sub and Cloud Asset; nothing is created, changed or deleted)",
      sealReads: "  reads           the sealed topic (it must be absent) and the unit's labeled resources (there must be none) with the DISCOVERY identity\n" +
        "  creates         one topic, named by the change list below (the contract's topicPrefix and a 12-hex suffix drawn now), with the unit's labels and\n" +
        "                  " + STORAGE_POLICY_PROPERTY + " = [the contract's region]\n" +
        "  calls           PUT, then GET to check, https://pubsub.googleapis.com/v1/projects/<project>/topics/<that topic>; cleanup is one DELETE of the same URL\n" +
        "  parent          " + PARENT_LABEL + " (this path never reads Resource Manager)",
      qualifyHeading: "QUALIFY THE GCP API ADAPTERS (against DEV it signs both identities in and sweeps the unit; it creates nothing)",
      qualifyReads: "  runs            the token exchange and impersonation as DISCOVERY and APPLY, and one Cloud Asset search as DISCOVERY; APPLY makes no Pub/Sub call",
      // What qualify's own logs can show (#365 review 6510401916, N14): APPLY only signs in, so no topic create or delete is attested here.
      attestation: (_provider, discovery, apply) => [
        "  this run's calls     DISCOVERY  " + discovery + "  signed in and ran one Cloud Asset search; APPLY  " + apply + "  only signed in, with no Pub/Sub call",
        "  no topic             was created or deleted in this run",
        "That DISCOVERY cannot write and that APPLY (which creates and deletes the topic at apply and cleanup) holds only topic create and delete is shown by the custom roles, not by this run.",
        "Only if the audit logs show only those calls, and the custom roles show that, type (anything else writes nothing):",
      ],
      applyNote: "It sends one PUT that creates exactly the sealed topic, with the unit's labels and " + STORAGE_POLICY_PROPERTY + " = [the contract's region], as APPLY. " +
        "It is never sent again; the result is judged by DISCOVERY reads of that topic. This sets and reads back one Pub/Sub property; it is not a data-residency claim.",
      cleanupNote: "It sends one DELETE of exactly the run's sealed topic, as APPLY, after a DISCOVERY read shows the unit's labels and the sealed storage policy. " +
        "Nothing else is ever deleted: no other topic, subscription, IAM binding or project resource.",
    },
    manifestMode: "PROJECT",
    mutation: GCP_API_MUTATION,
    // D12: two distinct runtime identities, workload identity federation only. No STATE, STATE_WRITE or CHANGESET on this path.
    identities: ["DISCOVERY", "APPLY"],
    attests: ["DISCOVERY", "APPLY"],
    previewAdapter: () => adapterOf("preview"),
    applyAdapter: adapterOf("apply"),
    cleanupAdapter: adapterOf("cleanup"),
    cleanupMutation: GCP_API_CLEANUP_MUTATION,
    binarySha256() {
      const { root, extension } = loadedModuleRoot();
      return moduleClosureSha256(root, extension);
    },
    plan: (input) => planWith(options, input),
    qualify: (input) => qualifyWith(options, input),
    openApply: (input) => openApplyWith(options, input),
    openCleanup: (input) => openCleanupWith(options, input),
    outcomeMessages: {
      FAILED_NO_CHANGE: "Pub/Sub refused the create and the topic read absent on every read, so nothing was created. Its answer is withheld. This sealed plan and its approvals are spent: seal a new plan (a new topic name) and obtain new approvals.",
      PARTIAL_REQUIRES_REVIEW: "The create's result cannot be told, or the topic is not exactly the sealed one: a 409, no answer or a 5xx without a matching read-back, a topic present after a refusal, or other labels or storage policy than sealed. " +
        "Do not retry. Run ./alz apply observe for this plan, then a person reviews the topic by hand; the product makes no cleanup proposal for this run (docs/act-pilot-gcp-api.md, \"Runs that did not succeed\"). This sealed plan and its approvals are spent.",
      KILLED: "This engine never reports KILLED: its one create has nothing to stop part way, and a signal during it is settled by the read-back like a lost answer. If you see this, a person reviews the run's topic by hand.",
    },
    recoveryLostNote: "",
    recoveryFileNames: [],
  };
}

/** The production spec: `fetch` with a per-request bound. The one registered in `SPECS`. */
export const GCP_API: GcpApiEngineSpec = gcpApiEngine();
