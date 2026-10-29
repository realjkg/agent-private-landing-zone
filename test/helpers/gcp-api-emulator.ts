import { randomBytes } from "node:crypto";
import http from "node:http";
import { mkdirSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { join } from "node:path";

import type { GcpHttp, GcpHttpRequest } from "../../src/apply/engines/gcp-api.js";

/**
 * TEST FIXTURE, EMULATED (docs/act-pilot-gcp-api.md, "Evidence"). A loopback emulator of the four Google services path 6 calls:
 * the security token service, the IAM Credentials API, Pub/Sub topics and Cloud Asset `searchAllResources`. It follows the Google side
 * of the #345 emulator (test/apply-emulated-gcp.test.ts, `HELPER`) request for request: the form-encoded STS exchange, a workload
 * identity binding that lets each subject impersonate only its own service account, tokens that carry the scope they were minted with,
 * Pub/Sub refusing any scope but `pubsub` and `cloud-platform`, Cloud Asset refusing any scope but `cloud-platform`, 409 for a duplicate
 * create and 404 for an absent topic. It adds what path 6 needs and #345 did not: the custom roles of D12 (DISCOVERY's service account
 * may only get topics and search assets; APPLY's may only create and delete topics), and knobs for the outcome tables (D14, D16).
 *
 * Every request reaches it through `http` (the engine's and the reader's HTTP seam), which accepts only the four Google hosts over
 * https and sends each to the loopback server over plain HTTP with a fresh connection (`agent: false`, as #356 fixed for #345). TLS
 * itself is not emulated. Nothing here is Google: IAM, quotas, latency, organization policies, Cloud Asset's indexing delay and
 * what Google accepts are not shown by it (GF1 to GF11). Token values never appear in its log.
 */

export const EMULATED_HOSTS = ["sts.googleapis.com", "iamcredentials.googleapis.com", "pubsub.googleapis.com", "cloudasset.googleapis.com"] as const;
const PUBSUB_SCOPES = new Set(["https://www.googleapis.com/auth/pubsub", "https://www.googleapis.com/auth/cloud-platform"]);
const ASSET_SCOPES = new Set(["https://www.googleapis.com/auth/cloud-platform"]);

export type EmulatedTopic = { name: string; labels: Record<string, string>; messageStoragePolicy?: { allowedPersistenceRegions: string[] } };
export type Logged = { host: string; method: string; path: string; sa: string | null; scope: string | null; status: number; createBody?: unknown; requestedScope?: unknown; stsScope?: string | null; refused?: true };

/** What the emulator does differently for the next requests; each knob is cleared with `behave({})`. */
export type EmulatorBehavior = {
  /** The PUT's answer (0: no answer, the connection closes). `create: true` stores the topic first (the create landed, then the answer was lost or wrong). */
  put?: { status: number; create?: boolean };
  /** A storage policy the service reports instead of the one sent (an organization policy rewrote it, or a mismatch); null: none. */
  createRegions?: string[] | null;
  /** Labels the service reports instead of the ones sent. */
  createLabels?: Record<string, string>;
  /** The DELETE's answer (0: no answer). `remove: true` removes the topic first. */
  delete?: { status: number; remove?: boolean };
  /** GETs of a topic answer this status, for the next `count` GETs (default: all of them). */
  get?: { status: number; count?: number };
  /** Cloud Asset answers this status, or reports a page token with no next page (an incomplete listing). */
  asset?: { status?: number; incomplete?: boolean };
  /** Topics Cloud Asset has not indexed yet (GF5's window): they exist, but the search does not list them. */
  unindexed?: string[];
  /** The next matching request gets no answer: the connection is closed before a response. */
  drop?: { host: string; method: string };
};

export type GcpApiEmulator = {
  /** The seam the engine and the reader use: only the four Google hosts over https, each to loopback with a fresh connection. */
  http: GcpHttp;
  log(): Logged[];
  topics: Map<string, EmulatedTopic>;
  behave(next: EmulatorBehavior): void;
  /** A person deleting a topic by hand, outside the product (the manual resolution of a run that did not succeed, D14). */
  deleteByHand(name: string): boolean;
  close(): Promise<void>;
};

export type TrustedSubjects = { audience: string; subjects: Record<string, string> };

/** A fresh workload identity federation identity per name: its token file, its credential configuration and its service account. */
export function writeIdentities(dir: string, projectId: string, audience: string, names: readonly string[] = ["DISCOVERY", "APPLY"]): { env: NodeJS.ProcessEnv; trust: TrustedSubjects; subjectOf: Record<string, string>; email(name: string): string } {
  mkdirSync(dir, { recursive: true });
  const env: NodeJS.ProcessEnv = {};
  const subjects: Record<string, string> = {};
  const subjectOf: Record<string, string> = {};
  const email = (name: string): string => "alz-pilot-dev-" + name.toLowerCase().replace("_", "-") + "@" + projectId + ".iam.gserviceaccount.com";
  for (const name of names) {
    const subject = "EMULATED-NOT-A-TOKEN-CANARY-" + name + "-" + randomBytes(4).toString("hex");
    const tokenFile = join(dir, name.toLowerCase() + ".jwt");
    writeFileSync(tokenFile, subject + "\n", { mode: 0o600 });
    const configuration = join(dir, name.toLowerCase() + ".json");
    writeFileSync(configuration, JSON.stringify({ type: "external_account", audience, subject_token_type: "urn:ietf:params:oauth:token-type:jwt", token_url: "https://sts.googleapis.com/v1/token", credential_source: { file: tokenFile } }));
    env["ALZ_" + name + "_GOOGLE_APPLICATION_CREDENTIALS"] = configuration;
    env["ALZ_" + name + "_GOOGLE_IMPERSONATE_SERVICE_ACCOUNT"] = email(name);
    subjects[subject] = email(name);
    subjectOf[name] = subject;
  }
  return { env, trust: { audience, subjects }, subjectOf, email };
}

/**
 * The custom roles of D12, by service account: what each identity's role lists. The bootstrap's real roles are the owner's
 * (bootstrap/gcp); these only let the emulator refuse a call the wrong identity makes.
 */
export type Roles = Record<string, readonly ("pubsub.topics.get" | "pubsub.topics.create" | "pubsub.topics.delete" | "cloudasset.assets.searchAllResources")[]>;

type Handled = { status: number; body: string } | "DROP";

export function createHandler(trust: TrustedSubjects, roles: Roles) {
  const topics = new Map<string, EmulatedTopic>();
  const tokens = new Map<string, { federated?: string; sa?: string; scope?: string }>();
  const log: Logged[] = [];
  let behavior: EmulatorBehavior = {};
  let getsLeft = Infinity;
  const json = (status: number, body: unknown): Handled => ({ status, body: JSON.stringify(body) });
  const allowed = (sa: string | undefined, permission: Roles[string][number]): boolean => !!sa && (roles[sa] ?? []).includes(permission);

  function handle(host: string, method: string, path: string, search: string, headers: Record<string, string>, body: string): Handled {
    const bearer = /^Bearer (\S+)$/.exec(headers.authorization ?? "");
    const who = bearer ? tokens.get(bearer[1]) : undefined;
    const entry: Logged = { host, method, path, sa: who?.sa ?? null, scope: who?.scope ?? null, status: 0 };
    const answer = (handled: Handled): Handled => { entry.status = handled === "DROP" ? 0 : handled.status; log.push(entry); return handled; };
    if (behavior.drop && behavior.drop.host === host && behavior.drop.method === method) { behavior = { ...behavior, drop: undefined }; return answer("DROP"); }
    if (host === "sts.googleapis.com") {
      if (method !== "POST" || path !== "/v1/token" || headers.authorization !== undefined) return answer(json(400, { error: "invalid_request" }));
      const form = new URLSearchParams(body);
      entry.stsScope = form.get("scope");
      const subject = (form.get("subject_token") ?? "").trim();
      if (headers["content-type"] !== "application/x-www-form-urlencoded" || form.get("grant_type") !== "urn:ietf:params:oauth:grant-type:token-exchange" ||
        !Object.hasOwn(trust.subjects, subject) || form.get("audience") !== trust.audience) return answer(json(400, { error: "invalid_grant" }));
      const token = "fed-" + randomBytes(12).toString("hex");
      tokens.set(token, { federated: trust.subjects[subject] });
      return answer(json(200, { access_token: token, issued_token_type: "urn:ietf:params:oauth:token-type:access_token", token_type: "Bearer", expires_in: 3600 }));
    }
    if (host === "iamcredentials.googleapis.com") {
      const m = /^\/v1\/projects\/-\/serviceAccounts\/([^/:]+):generateAccessToken$/.exec(path);
      let request: { scope?: unknown } = {};
      try { request = JSON.parse(body) as typeof request; } catch { request = {}; }
      entry.requestedScope = request.scope ?? null;
      // The workload identity binding: a federated principal impersonates its own service account and no other.
      if (method !== "POST" || !m || !who?.federated || who.federated !== m[1]) return answer(json(403, { error: { code: 403, status: "PERMISSION_DENIED" } }));
      if (!Array.isArray(request.scope) || request.scope.length === 0) return answer(json(400, { error: { code: 400 } }));
      const token = "sa-" + randomBytes(12).toString("hex");
      tokens.set(token, { sa: m[1], scope: request.scope.join(" ") });
      return answer(json(200, { accessToken: token, expireTime: "2026-10-29T13:00:00Z" }));
    }
    if (host === "pubsub.googleapis.com") {
      if (method === "PUT") { try { entry.createBody = JSON.parse(body); } catch { entry.createBody = null; } }
      if (!who?.sa) return answer(json(401, { error: { code: 401, status: "UNAUTHENTICATED" } }));
      if (!(who.scope ?? "").split(" ").some((s) => PUBSUB_SCOPES.has(s))) return answer(json(403, { error: { code: 403, status: "PERMISSION_DENIED", reason: "ACCESS_TOKEN_SCOPE_INSUFFICIENT" } }));
      const m = /^\/v1\/(projects\/[a-z][a-z0-9-]{4,28}[a-z0-9]\/topics\/[A-Za-z][A-Za-z0-9._~+-]{2,254})$/.exec(path);
      if (!m || search !== "") return answer(json(404, { error: { code: 404 } }));
      const name = m[1];
      if (method === "GET") {
        if (!allowed(who.sa, "pubsub.topics.get")) return answer(json(403, { error: { code: 403, status: "PERMISSION_DENIED" } }));
        if (behavior.get && getsLeft > 0) { getsLeft -= 1; return answer(json(behavior.get.status, { error: { code: behavior.get.status } })); }
        const topic = topics.get(name);
        return answer(topic ? json(200, topic) : json(404, { error: { code: 404, status: "NOT_FOUND" } }));
      }
      if (method === "PUT") {
        if (!allowed(who.sa, "pubsub.topics.create")) return answer(json(403, { error: { code: 403, status: "PERMISSION_DENIED" } }));
        const create = (): void => {
          const sent = (entry.createBody ?? {}) as { labels?: Record<string, string>; messageStoragePolicy?: { allowedPersistenceRegions: string[] } };
          const regions = behavior.createRegions === null ? undefined : behavior.createRegions ?? sent.messageStoragePolicy?.allowedPersistenceRegions;
          topics.set(name, { name, labels: { ...(behavior.createLabels ?? sent.labels ?? {}) }, ...(regions ? { messageStoragePolicy: { allowedPersistenceRegions: [...regions] } } : {}) });
        };
        if (behavior.put) {
          if (behavior.put.create && !topics.has(name)) create();
          return answer(behavior.put.status === 0 ? "DROP" : json(behavior.put.status, { error: { code: behavior.put.status } }));
        }
        if (topics.has(name)) return answer(json(409, { error: { code: 409, status: "ALREADY_EXISTS" } }));
        create();
        return answer(json(200, topics.get(name)));
      }
      if (method === "DELETE") {
        if (!allowed(who.sa, "pubsub.topics.delete")) return answer(json(403, { error: { code: 403, status: "PERMISSION_DENIED" } }));
        if (behavior.delete) {
          if (behavior.delete.remove) topics.delete(name);
          return answer(behavior.delete.status === 0 ? "DROP" : json(behavior.delete.status, { error: { code: behavior.delete.status } }));
        }
        return answer(topics.delete(name) ? json(200, {}) : json(404, { error: { code: 404, status: "NOT_FOUND" } }));
      }
      return answer(json(400, { error: { code: 400 } }));
    }
    if (host === "cloudasset.googleapis.com") {
      if (!who?.sa) return answer(json(401, { error: { code: 401 } }));
      if (!(who.scope ?? "").split(" ").some((s) => ASSET_SCOPES.has(s))) return answer(json(403, { error: { code: 403, status: "PERMISSION_DENIED", reason: "ACCESS_TOKEN_SCOPE_INSUFFICIENT" } }));
      if (!allowed(who.sa, "cloudasset.assets.searchAllResources")) return answer(json(403, { error: { code: 403, status: "PERMISSION_DENIED" } }));
      if (method !== "GET" || !/^\/v1\/projects\/[a-z][a-z0-9-]{4,28}[a-z0-9]:searchAllResources$/.test(path)) return answer(json(404, { error: { code: 404 } }));
      if (behavior.asset?.status !== undefined) return answer(json(behavior.asset.status, { error: { code: behavior.asset.status } }));
      const m = /^labels\.([a-z0-9_-]+)=([a-z0-9_-]+)$/.exec(new URLSearchParams(search).get("query") ?? "");
      if (!m) return answer(json(400, { error: { code: 400 } }));
      const project = path.slice("/v1/".length, path.indexOf(":"));
      const results = [...topics.values()].filter((t) => t.name.startsWith(project + "/") && t.labels[m[1]] === m[2] && !(behavior.unindexed ?? []).includes(t.name))
        .map((t) => ({ name: "//pubsub.googleapis.com/" + t.name, assetType: "pubsub.googleapis.com/Topic" }));
      return answer(json(200, { results, ...(behavior.asset?.incomplete ? { nextPageToken: "!not a token!" } : {}) }));
    }
    entry.refused = true;
    return answer(json(404, {}));
  }

  return {
    topics, log: () => [...log], handle,
    behave(next: EmulatorBehavior) { behavior = { ...next }; getsLeft = next.get?.count ?? Infinity; },
  };
}

/** The four hosts over https only, as the seam's own gate: anything else never reaches the server. */
function routeOf(url: string): { host: string; path: string; search: string } | undefined {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" || parsed.port !== "" || parsed.username !== "" || parsed.password !== "" || !(EMULATED_HOSTS as readonly string[]).includes(parsed.hostname)) return undefined;
    return { host: parsed.hostname, path: parsed.pathname, search: parsed.search };
  } catch { return undefined; }
}

/** An in-memory emulator: the same handler, called directly (no socket). For the engine's unit tests. */
export function inMemoryEmulator(trust: TrustedSubjects, roles: Roles): Omit<GcpApiEmulator, "close"> & { sent: GcpHttpRequest[] } {
  const core = createHandler(trust, roles);
  const sent: GcpHttpRequest[] = [];
  const seam: GcpHttp = async (request) => {
    sent.push(request);
    const route = routeOf(request.url);
    if (!route) return { status: 0, body: "" };
    const handled = core.handle(route.host, request.method, route.path, route.search, lower(request.headers), request.body ?? "");
    return handled === "DROP" ? { status: 0, body: "" } : handled;
  };
  return { http: seam, sent, log: core.log, topics: core.topics, behave: core.behave, deleteByHand: (name) => core.topics.delete(name) };
}

const lower = (headers: Readonly<Record<string, string>>): Record<string, string> => Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));

/** The loopback emulator: an HTTP server on 127.0.0.1, routed by the Host header, reached through `http` with a fresh connection per request. */
export async function startGcpApiEmulator(trust: TrustedSubjects, roles: Roles): Promise<GcpApiEmulator> {
  const core = createHandler(trust, roles);
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const host = (req.headers.host ?? "").split(":")[0];
      const url = new URL(req.url ?? "/", "http://" + host);
      const headers = Object.fromEntries(Object.entries(req.headers).filter(([, v]) => typeof v === "string")) as Record<string, string>;
      let handled: Handled;
      try { handled = core.handle(host, req.method ?? "", url.pathname, url.search, headers, Buffer.concat(chunks).toString("utf8")); } catch { handled = { status: 500, body: "" }; }
      if (handled === "DROP") { req.socket.destroy(); return; }
      res.writeHead(handled.status, { "content-type": "application/json", "content-length": Buffer.byteLength(handled.body) });
      res.end(handled.body);
    });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const port = (server.address() as AddressInfo).port;
  const seam: GcpHttp = (request) => new Promise((done) => {
    const route = routeOf(request.url);
    if (!route) { done({ status: 0, body: "" }); return; }
    // A fresh connection per request (agent: false): a pooled keep-alive socket the server already closed is never reused (#356).
    const outgoing = http.request({ agent: false, host: "127.0.0.1", port, method: request.method, path: route.path + route.search, headers: { ...request.headers, host: route.host } }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => done({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
      response.on("error", () => done({ status: 0, body: "" }));
    });
    outgoing.on("error", () => done({ status: 0, body: "" }));
    outgoing.end(request.body);
  });
  return {
    http: seam, log: core.log, topics: core.topics, behave: core.behave, deleteByHand: (name) => core.topics.delete(name),
    close: () => new Promise<void>((done) => { server.closeAllConnections(); server.close(() => done()); }),
  };
}
