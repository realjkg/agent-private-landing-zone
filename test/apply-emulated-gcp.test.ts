import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { signApproval } from "../src/apply/approval.js";
import { buildCleanupProposal, signCleanupProposal, type CleanupProposal } from "../src/apply/cleanup-proposal.js";
import { loadPilotContract, pilotContractSha256, writeQualificationEvidence } from "../src/apply/contract.js";
import { runApply, runCleanup, sealPreview, type ApplyDeps, type ApplyRequest } from "../src/apply/driver.js";
import { lockedProviders } from "../src/apply/lockfile.js";
import { openNonceStore } from "../src/apply/nonces.js";
import { loadRunRecords, observeRun, verifyProposalLeftovers, type ObserveDeps } from "../src/apply/observe.js";
import { GCP } from "../src/apply/providers/gcp.js";
import { readBlueprintRecord } from "../src/apply/run-records.js";
import { loadSealedPlan, reviewBundleOf, verifyReviewBundle } from "../src/apply/seal.js";
import { APPLY_ADAPTER, CLEANUP_ADAPTER } from "../src/apply/terraform.js";
import type { ApplyEvidence, ApplyResult, PilotContract, SignedApproval } from "../src/apply/types.js";
import { pilotUnitOf } from "../src/apply/unit.js";
import { readEncryptedEvidence } from "../src/evidence/vault.js";
import type { GcpHttp } from "../src/observe/gcp-rest.js";
import { ADAPTER_VERSION, terraformArgvDigest } from "../src/teardown/driver/adapters/terraform.js";
import { removeTree } from "../src/teardown/driver/cleanup.js";
import type { ResolvedTarget } from "../src/teardown/driver/types.js";
import { buildManifest, canonicalJson } from "../src/teardown/manifest.js";
import { captureProjectFiles } from "../src/teardown/snapshot.js";
import { sha256 } from "../src/util/sha256.js";
import { NOW, POLICY, REQUESTER, SOURCE_COMMIT, approvalFor, approvers, human, keys, sha, writeReviewedContract } from "./helpers/apply-fixtures.js";
import { zipEntries } from "./helpers/plan-zip.js";

/**
 * OPT-IN SIMULATION, EMULATED (docs/act-pilot-simulation-gcp.md, "S6b"; lane G1). The GCP Terraform counterpart of
 * test/apply-emulated-aws.test.ts and test/apply-emulated.test.ts. Skipped unless ALZ_SIM_TERRAFORM (a real Terraform 1.x binary),
 * ALZ_SIM_FAKE_GCS (the fake-gcs-server executable) and ALZ_SIM_GOOGLE_PROVIDER (a folder holding HashiCorp's signed release files
 * for hashicorp/google 8.9.0: the linux_amd64 zip, SHA256SUMS, SHA256SUMS.72D7468F.sig, and HashiCorp's public key as hashicorp.asc)
 * are all set, so default CI is unaffected.
 *
 * It drives the REAL src/apply driver and judge (seal, approve, apply, evidence, ledger, observe, cleanup proposal, cleanup,
 * leftovers, second apply refused, held lock, kill switch) against the REAL Terraform engine and the REAL hashicorp/google 8.9.0
 * provider, on the committed canary (qualification/gcp/act-dev1-canary) exactly as committed. No provisioner, no `local-exec`, no
 * judge bypass. Google is EMULATED on loopback: one helper process answers as the Terraform registry and releases.hashicorp.com
 * (serving HashiCorp's own signed files, so Terraform verifies the real signature and the committed lock's h1 hashes), Google's
 * security token service and IAM Credentials API (each identity's subject may impersonate only its own service account, as the
 * bootstrap's workload identity bindings do), Pub/Sub topics, Cloud Asset search and, through fake-gcs-server, the Cloud Storage
 * JSON and XML APIs behind the gcs backend. The driver reaches it only through `ALZ_NETWORK_HTTPS_PROXY` and
 * `ALZ_NETWORK_SSL_CERT_FILE`, the operator's network settings: no emulator variable (`STORAGE_EMULATOR_HOST`, which the spec
 * refuses, P2) and no endpoint setting is used anywhere. The proxy refuses every other host. The independent observation reads the
 * same emulator through the reader's own HTTP seam. Run it inside a network namespace with loopback only (the lane's
 * isolated-suite.sh), so even a mistake cannot reach Google.
 *
 * What this does NOT prove (the emulator is not Google): IAM and its custom roles, which permission each call needs (GF7 to GF11),
 * whether Google accepts the scopes and request shapes the product and the provider send (GF1 to GF3, GF8), the organization
 * policy on storage locations, Cloud Asset's indexing delay (GF5), real latency, quotas or errors. Only the owner's supervised DEV
 * run is live evidence (docs/act-pilot-gcp-evidence.md). Every artifact here is EMULATED and never live provider qualification.
 *
 * DEV MODE ONLY setup (never an operator step; operators use ./alz): build fake-gcs-server v1.53.1 as
 * docs/act-pilot-simulation-gcp.md, "How to repeat it", step 1; download the google 8.9.0 release files and check the signature;
 * then, inside a loopback-only network namespace,
 *   ALZ_SIM_TERRAFORM=<verified terraform> ALZ_SIM_FAKE_GCS=<dl>/bin/fake-gcs-server ALZ_SIM_GOOGLE_PROVIDER=<release dir> \
 *     npx tsx --test test/apply-emulated-gcp.test.ts
 * Optional: ALZ_SIM_TERRAFORM_SHA256 makes the test refuse a binary whose hash differs.
 */
const TERRAFORM = process.env.ALZ_SIM_TERRAFORM;
const FAKE_GCS = process.env.ALZ_SIM_FAKE_GCS;
const PROVIDER_DIR = process.env.ALZ_SIM_GOOGLE_PROVIDER;
const SKIP = !TERRAFORM || !FAKE_GCS || !PROVIDER_DIR
  ? "set ALZ_SIM_TERRAFORM, ALZ_SIM_FAKE_GCS and ALZ_SIM_GOOGLE_PROVIDER to run the GCP emulated simulation (docs/act-pilot-simulation-gcp.md)" : false;

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const CANARY_DIR = join(ROOT, "qualification", "gcp", "act-dev1-canary");
/** The committed canary's placeholder project: the contract names it, so the canary is sealed exactly as committed. */
const PROJECT = "examplefake-dev";
const REGION = "europe-west4";
const BUCKET = "examplefake-dev-state";
const PREFIX = "pilot/dev";
const DEV: ResolvedTarget = { account: PROJECT, backend: BUCKET + "/" + PREFIX, workspace: "default" };
const IDENTITIES = ["DISCOVERY", "STATE", "STATE_WRITE", "APPLY"] as const;
const email = (identity: string): string => "alz-pilot-dev-" + identity.toLowerCase().replace("_", "-") + "@" + PROJECT + ".iam.gserviceaccount.com";
const AUDIENCE = "//iam.googleapis.com/projects/123456789012/locations/global/workloadIdentityPools/alz-pilot-dev/providers/oidc";
/** Dummy subject tokens: not real tokens, and never allowed to appear in any result, record or argument list. */
const subjectToken = (identity: string): string => "EMULATED-NOT-A-TOKEN-CANARY-" + identity;
const EMULATED_HOSTS = ["registry.terraform.io", "releases.hashicorp.com", "sts.googleapis.com", "iamcredentials.googleapis.com", "pubsub.googleapis.com", "storage.googleapis.com", "cloudasset.googleapis.com"];
const CONTROL_HOST = "control.alz-sim.invalid";
/** Terraform's own version check is attempted on every run and refused by the proxy; nothing else may be contacted. */
const VERSION_CHECK_HOST = "checkpoint-api.hashicorp.com:443";

type Logged = { connError?: string; code?: string; object?: string; host?: string; method?: string; path?: string; sa?: string | null; scope?: string | null; connect?: string; impersonate?: string; requestedScope?: string[]; stsScope?: string; subjectOf?: string | null; renewed?: boolean; refused?: boolean; createBody?: Record<string, unknown> };
type Topic = { name: string; labels: Record<string, string>; messageStoragePolicy?: { allowedPersistenceRegions: string[] } };

const freePort = (): Promise<number> => new Promise((done, fail) => {
  const server = net.createServer();
  server.listen(0, "127.0.0.1", () => { const { port } = server.address() as net.AddressInfo; server.close(() => done(port)); });
  server.on("error", fail);
});

/**
 * The emulator, in its own process because the driver blocks this one while Terraform runs (synchronous spawns). Loopback only.
 * Arguments: key, certificate, fake-gcs-server port, the release folder, the request log, the trust file (subject token to the one
 * service account it may impersonate). It prints "<proxy port> <api port>".
 */
const HELPER = String.raw`
const http = require("node:http"), https = require("node:https"), net = require("node:net"), fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const [keyFile, certFile, gcsPort, providerDir, log, trustFile] = process.argv.slice(2);
const HOSTS = ["registry.terraform.io", "releases.hashicorp.com", "sts.googleapis.com", "iamcredentials.googleapis.com", "pubsub.googleapis.com", "storage.googleapis.com", "cloudasset.googleapis.com"];
const trust = JSON.parse(fs.readFileSync(trustFile, "utf8"));
const record = (entry) => fs.appendFileSync(log, JSON.stringify(entry) + "\n");
const topics = new Map();
const tokens = new Map();
const VERSION = "8.9.0", ZIP = "terraform-provider-google_8.9.0_linux_amd64.zip";
const send = (res, status, body, type) => { const data = typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body); res.writeHead(status, { "content-type": type || "application/json", "content-length": Buffer.byteLength(data) }); res.end(data); };
const scopes = (who) => (who && who.scope ? who.scope.split(" ") : []);
function handle(req, res, body) {
  const host = (req.headers.host || "").split(":")[0];
  const url = new URL(req.url, "https://" + host);
  const bearer = /^Bearer (\S+)$/.exec(req.headers.authorization || "");
  const who = bearer ? tokens.get(bearer[1]) : undefined;
  const entry = { host, method: req.method, path: url.pathname, sa: who && who.sa ? who.sa : null, scope: who && who.scope ? who.scope : null };
  if (host === "control.alz-sim.invalid") {
    const input = body.length ? JSON.parse(body.toString("utf8")) : {};
    if (url.pathname === "/topics") return send(res, 200, [...topics.values()]);
    if (url.pathname === "/topics/delete") { topics.delete(input.name); return send(res, 200, {}); }
    if (url.pathname === "/topics/reset") { topics.clear(); return send(res, 200, {}); }
    if (url.pathname === "/topics/regions") { const t = topics.get(input.name); if (t) t.messageStoragePolicy = { allowedPersistenceRegions: input.regions }; return send(res, 200, {}); }
    return send(res, 404, {});
  }
  if (host === "registry.terraform.io") {
    record(entry);
    if (url.pathname === "/.well-known/terraform.json") return send(res, 200, { "providers.v1": "/v1/providers/" });
    if (url.pathname === "/v1/providers/hashicorp/google/versions") return send(res, 200, { versions: [{ version: VERSION, protocols: ["5.0"], platforms: [{ os: "linux", arch: "amd64" }] }] });
    if (url.pathname === "/v1/providers/hashicorp/google/" + VERSION + "/download/linux/amd64") {
      const sums = fs.readFileSync(path.join(providerDir, "terraform-provider-google_" + VERSION + "_SHA256SUMS"), "utf8");
      const base = "https://releases.hashicorp.com/terraform-provider-google/" + VERSION + "/";
      return send(res, 200, { protocols: ["5.0"], os: "linux", arch: "amd64", filename: ZIP, download_url: base + ZIP,
        shasums_url: base + "terraform-provider-google_" + VERSION + "_SHA256SUMS", shasums_signature_url: base + "terraform-provider-google_" + VERSION + "_SHA256SUMS.72D7468F.sig",
        shasum: sums.split("\n").find((line) => line.endsWith(ZIP)).split(/\s+/)[0],
        signing_keys: { gpg_public_keys: [{ key_id: "34365D9472D7468F", ascii_armor: fs.readFileSync(path.join(providerDir, "hashicorp.asc"), "utf8"), trust_signature: "", source: "HashiCorp", source_url: "https://www.hashicorp.com/security.html" }] } });
    }
    return send(res, 404, {});
  }
  if (host === "releases.hashicorp.com") {
    record(entry);
    const file = path.basename(url.pathname), full = path.join(providerDir, file);
    if (/^terraform-provider-google_8\.9\.0_/.test(file) && fs.existsSync(full)) return send(res, 200, fs.readFileSync(full), "application/octet-stream");
    return send(res, 404, "");
  }
  if (host === "sts.googleapis.com" && req.method === "POST" && url.pathname === "/v1/token") {
    const form = new URLSearchParams(body.toString("utf8"));
    const subject = (form.get("subject_token") || "").trim();
    // The subject is recorded by the identity the trust file maps it to and whether it is the renewed one, never by its value.
    record({ ...entry, stsScope: form.get("scope"), subjectOf: Object.prototype.hasOwnProperty.call(trust, subject) && subject !== "audience" ? trust[subject] : null, renewed: subject.endsWith("-RENEWED") });
    if (!Object.prototype.hasOwnProperty.call(trust, subject) || form.get("audience") !== trust.audience) return send(res, 400, { error: "invalid_grant" });
    const token = "fed-" + crypto.randomBytes(12).toString("hex");
    tokens.set(token, { federated: trust[subject] });
    return send(res, 200, { access_token: token, issued_token_type: "urn:ietf:params:oauth:token-type:access_token", token_type: "Bearer", expires_in: 3600 });
  }
  if (host === "iamcredentials.googleapis.com" && req.method === "POST") {
    const m = /^\/v1\/projects\/-\/serviceAccounts\/([^/:]+):generateAccessToken$/.exec(url.pathname);
    let request = {}; try { request = JSON.parse(body.toString("utf8")); } catch { request = {}; }
    record({ ...entry, impersonate: m ? m[1] : null, requestedScope: request.scope || null });
    // The workload identity binding: a federated principal impersonates its own service account and no other.
    if (!m || !who || who.federated !== m[1]) return send(res, 403, { error: { code: 403, status: "PERMISSION_DENIED" } });
    const token = "sa-" + crypto.randomBytes(12).toString("hex");
    tokens.set(token, { sa: m[1], scope: (request.scope || []).join(" ") });
    return send(res, 200, { accessToken: token, expireTime: new Date(Date.now() + 3600000).toISOString() });
  }
  if (host === "pubsub.googleapis.com") {
    record(req.method === "PUT" ? { ...entry, createBody: JSON.parse(body.toString("utf8") || "{}") } : entry);
    if (!who || !who.sa) return send(res, 401, { error: { code: 401 } });
    if (!scopes(who).some((s) => s === "https://www.googleapis.com/auth/pubsub" || s === "https://www.googleapis.com/auth/cloud-platform")) return send(res, 403, { error: { code: 403, status: "PERMISSION_DENIED" } });
    const m = /^\/v1\/(projects\/[a-z][a-z0-9-]{4,28}[a-z0-9]\/topics\/[A-Za-z][A-Za-z0-9._~+-]{2,254})$/.exec(url.pathname);
    if (!m) return send(res, 404, { error: { code: 404 } });
    const name = m[1];
    if (req.method === "PUT") {
      if (topics.has(name)) return send(res, 409, { error: { code: 409, status: "ALREADY_EXISTS" } });
      const t = JSON.parse(body.toString("utf8") || "{}");
      const topic = { name, labels: t.labels || {}, ...(t.messageStoragePolicy ? { messageStoragePolicy: t.messageStoragePolicy } : {}) };
      topics.set(name, topic);
      return send(res, 200, topic);
    }
    if (req.method === "GET") return topics.has(name) ? send(res, 200, topics.get(name)) : send(res, 404, { error: { code: 404, status: "NOT_FOUND" } });
    if (req.method === "DELETE") return topics.delete(name) ? send(res, 200, {}) : send(res, 404, { error: { code: 404, status: "NOT_FOUND" } });
    return send(res, 400, { error: { code: 400 } });
  }
  if (host === "cloudasset.googleapis.com") {
    record(entry);
    if (!who || !who.sa) return send(res, 401, { error: { code: 401 } });
    if (!scopes(who).includes("https://www.googleapis.com/auth/cloud-platform")) return send(res, 403, { error: { code: 403, status: "PERMISSION_DENIED" } });
    const m = /^labels\.([a-z0-9_-]+)=([a-z0-9_-]+)$/.exec(url.searchParams.get("query") || "");
    if (!m) return send(res, 400, { error: { code: 400 } });
    return send(res, 200, { results: [...topics.values()].filter((t) => t.labels[m[1]] === m[2]).map((t) => ({ name: "//pubsub.googleapis.com/" + t.name, assetType: "pubsub.googleapis.com/Topic" })) });
  }
  if (host === "storage.googleapis.com") {
    record({ ...entry, object: url.searchParams.get("name") || decodeURIComponent(url.pathname.replace(/^.*\/o\//, "")) });
    // A fresh connection per request (agent: false), as below: a pooled keep-alive socket fake-gcs-server already closed is never reused.
    const upstream = http.request({ agent: false, host: "127.0.0.1", port: Number(gcsPort), method: req.method, path: req.url, headers: { ...req.headers, host: "storage.googleapis.com" } }, (up) => {
      const headers = { ...up.headers };
      if (headers.location) headers.location = String(headers.location).replace(/^http:\/\/[^/]+/, "https://storage.googleapis.com");
      res.writeHead(up.statusCode, headers); up.pipe(res);
    });
    upstream.on("error", (error) => { record({ connError: "storage-upstream", code: error.code || "UNKNOWN" }); send(res, 502, ""); });
    upstream.end(body);
    return;
  }
  record({ ...entry, refused: true });
  return send(res, 404, {});
}
const api = https.createServer({ key: fs.readFileSync(keyFile), cert: fs.readFileSync(certFile) }, (req, res) => {
  const chunks = []; req.on("data", (c) => chunks.push(c)); req.on("end", () => { try { handle(req, res, Buffer.concat(chunks)); } catch { send(res, 500, ""); } });
});
// Every connection-level error the emulator sees is logged by code (never a body), so a failure names its cause.
api.on("tlsClientError", (error) => record({ connError: "api-tls", code: error.code || "UNKNOWN" }));
api.on("clientError", (error, socket) => { record({ connError: "api", code: error.code || "UNKNOWN" }); socket.destroy(); });
api.listen(0, "127.0.0.1", () => {
  const apiPort = api.address().port;
  const proxy = http.createServer((_q, r) => { r.writeHead(403); r.end(); });
  proxy.on("connect", (req, client, head) => {
    client.on("error", (error) => { record({ connError: "proxy-client", code: error.code || "UNKNOWN" }); client.destroy(); });
    record({ connect: req.url });
    const [name, port] = req.url.split(":");
    if (port !== "443" || !HOSTS.includes(name)) { client.end("HTTP/1.1 403 Forbidden\r\n\r\n"); return; }
    const up = net.connect(apiPort, "127.0.0.1", () => { client.write("HTTP/1.1 200 Connection Established\r\n\r\n"); if (head.length) up.write(head); up.pipe(client); client.pipe(up); });
    up.on("error", (error) => { record({ connError: "proxy-upstream", code: error.code || "UNKNOWN" }); client.destroy(); }); client.on("close", () => up.destroy());
  });
  proxy.on("clientError", (error, s) => { record({ connError: "proxy", code: error.code || "UNKNOWN" }); s.destroy(); });
  proxy.listen(0, "127.0.0.1", () => process.stdout.write(proxy.address().port + " " + apiPort + "\n"));
});
`;

type Emulator = {
  proxyUrl: string; caFile: string; log(): Logged[];
  /** A request straight to the API port as `host` would see it (the observation's HTTP seam and the control channel). */
  call(host: string, method: string, path: string, headers?: Record<string, string>, body?: string): Promise<{ status: number; body: string }>;
  gcs(method: string, path: string, body?: string, contentType?: string): Promise<{ status: number; body: string }>;
  stop(): void;
};

async function startEmulator(dir: string, trust: Record<string, string>): Promise<Emulator> {
  const key = join(dir, "key.pem"), cert = join(dir, "cert.pem");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "2", "-keyout", key, "-out", cert, "-subj", "/CN=alz-sim-gcp",
    "-addext", "subjectAltName=" + [...EMULATED_HOSTS, CONTROL_HOST].map((h) => "DNS:" + h).join(",")], { stdio: "ignore" });
  const ca = readFileSync(cert);
  const gcsPort = await freePort();
  const gcs: ChildProcess = spawn(FAKE_GCS as string, ["-scheme", "http", "-host", "127.0.0.1", "-port", String(gcsPort), "-backend", "memory",
    "-public-host", "storage.googleapis.com", "-external-url", "https://storage.googleapis.com", "-log-level", "error"], { stdio: "ignore", env: { PATH: "/usr/bin:/bin" } });
  const helperPath = join(dir, "helper.cjs"), log = join(dir, "requests.jsonl"), trustFile = join(dir, "trust.json");
  writeFileSync(helperPath, HELPER);
  writeFileSync(trustFile, JSON.stringify(trust));
  const helper: ChildProcess = spawn(process.execPath, [helperPath, key, cert, String(gcsPort), PROVIDER_DIR as string, log, trustFile], { stdio: ["ignore", "pipe", "inherit"] });
  const [proxyPort, apiPort] = await new Promise<number[]>((done, fail) => {
    helper.once("error", fail);
    helper.stdout?.once("data", (chunk: Buffer) => done(chunk.toString().trim().split(" ").map(Number)));
    helper.once("exit", () => fail(new Error("the emulator helper exited")));
  });
  const gcsCall: Emulator["gcs"] = (method, path, body, contentType = "application/json") => new Promise((done, fail) => {
    // A fresh connection per call (agent: false). Node's default agent keeps sockets alive, and a server closes an idle one after its
    // keep-alive timeout (Node: 5 s); a call made after a long engine step could reuse a socket the server was closing, which failed
    // as "socket hang up" (ECONNRESET), intermittently. No pool, so no reuse and no race.
    const request = http.request({ agent: false, host: "127.0.0.1", port: gcsPort, method, path, headers: { host: "storage.googleapis.com", "content-type": contentType, "content-length": String(Buffer.byteLength(body ?? "")) } }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (c: Buffer) => chunks.push(c));
      response.on("end", () => done({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
    });
    request.on("error", (error: NodeJS.ErrnoException) => fail(new Error("emulator storage call " + method + " " + path + " failed: " + (error.code ?? error.message))));
    request.end(body);
  });
  for (let i = 0; i < 100; i += 1) {
    try { if ((await gcsCall("GET", "/storage/v1/b")).status === 200) break; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  const call: Emulator["call"] = (host, method, path, headers = {}, body) => new Promise((done, fail) => {
    const request = https.request({ agent: false, host: "127.0.0.1", port: apiPort, servername: host, ca, method, path,
      headers: { ...headers, host, "content-length": String(Buffer.byteLength(body ?? "")) } }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (c: Buffer) => chunks.push(c));
      response.on("end", () => done({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
    });
    request.on("error", (error: NodeJS.ErrnoException) => fail(new Error("emulator call " + host + " " + method + " " + path + " failed: " + (error.code ?? error.message))));
    request.end(body);
  });
  return {
    proxyUrl: "http://127.0.0.1:" + proxyPort, caFile: cert, call, gcs: gcsCall,
    log: () => (existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as Logged) : []),
    stop() { helper.kill("SIGKILL"); gcs.kill("SIGKILL"); },
  };
}

describe("GCP Terraform through the real driver: real Terraform and google 8.9.0, the committed canary, Google EMULATED on loopback (opt-in)", { skip: SKIP }, () => {
  const root = mkdtempSync(join(tmpdir(), "alz-sim-gcp-"));
  const previousCwd = process.cwd();
  const previousKey = process.env.AGENTIC_EVIDENCE_KEY;
  const KILL = join(root, "KILL");
  let counter = 0;
  const fresh = (label: string): string => { const dir = join(root, label + "-" + ++counter); mkdirSync(dir, { recursive: true, mode: 0o700 }); return dir; };
  let emulator: Emulator;
  let deps: ApplyDeps;
  let env: NodeJS.ProcessEnv;
  let contractPath = "";
  let evidenceDir = "";
  let engineVersion = "";
  let toolDir = "";
  let unitLabels: Record<string, string> = {};

  /**
   * The DEV contract. `embedStateWrite: true` is what keeps the state STATE_WRITE's on this path: without it, the plan would leave the gcs
   * backend's `credentials` and `impersonate_service_account` to the apply process's environment, APPLY's, so the contract requires it (see the last test).
   */
  const contract = (embedStateWrite = true) => ({
    schemaVersion: 1, enabled: true, provider: "GCP", engine: "TERRAFORM", enabledEnvironments: ["DEV"],
    targets: { DEV: { projectId: PROJECT, region: REGION, backend: DEV.backend, workspace: "default", canary: { resources: [{ type: "google_pubsub_topic", count: 1 }] } } },
    requiredApprovals: { DEV: 1 }, maxApprovalAgeMinutes: 60, approvers, killSwitchPath: KILL, authorize: { DEV: ["APPLY", "CLEANUP"] },
    embedStateWrite,
  });

  before(async () => {
    process.env.AGENTIC_EVIDENCE_KEY = randomBytes(32).toString("base64");
    process.chdir(root); // the vault writes sealed plans under ./.runs
    const binary = TERRAFORM as string;
    const binarySha = createHash("sha256").update(readFileSync(binary)).digest("hex");
    if (process.env.ALZ_SIM_TERRAFORM_SHA256) assert.equal(binarySha, process.env.ALZ_SIM_TERRAFORM_SHA256.toLowerCase(), "the terraform binary is not the verified one");
    toolDir = fresh("tools");
    symlinkSync(binary, join(toolDir, "terraform"));
    engineVersion = (JSON.parse(execFileSync(binary, ["version", "-json"], { env: { PATH: "/usr/bin:/bin" }, encoding: "utf8" })) as { terraform_version: string }).terraform_version;

    // Four workload identity federation identities, each its own subject token, credential configuration and service account.
    env = {};
    const trust: Record<string, string> = { audience: AUDIENCE };
    const identities = fresh("identities");
    for (const identity of IDENTITIES) {
      const tokenFile = join(identities, identity.toLowerCase() + ".jwt");
      writeFileSync(tokenFile, subjectToken(identity) + "\n", { mode: 0o600 });
      const configuration = join(identities, identity.toLowerCase() + ".json");
      writeFileSync(configuration, JSON.stringify({ type: "external_account", audience: AUDIENCE, subject_token_type: "urn:ietf:params:oauth:token-type:jwt", token_url: "https://sts.googleapis.com/v1/token", credential_source: { file: tokenFile } }));
      env["ALZ_" + identity + "_GOOGLE_APPLICATION_CREDENTIALS"] = configuration;
      env["ALZ_" + identity + "_GOOGLE_IMPERSONATE_SERVICE_ACCOUNT"] = email(identity);
      env["ALZ_" + identity + "_GOOGLE_PROJECT"] = PROJECT;
      env["ALZ_" + identity + "_GOOGLE_REGION"] = REGION;
      trust[subjectToken(identity)] = email(identity);
      // The token a delivery would write after the seal (owner decision 6486426552, token renewal): the same identity, a new value.
      trust[subjectToken(identity) + "-RENEWED"] = email(identity);
    }
    emulator = await startEmulator(fresh("emulator"), trust);
    const bucket = await emulator.gcs("POST", "/storage/v1/b?project=" + PROJECT, JSON.stringify({ name: BUCKET, versioning: { enabled: true } }));
    assert.equal(bucket.status, 200, "the state bucket exists in the emulator: " + bucket.body);
    // Network settings reach the engine only as ALZ_NETWORK_*: the proxy sends the emulated hosts to loopback; the CA is the emulator's own.
    env.ALZ_NETWORK_HTTPS_PROXY = emulator.proxyUrl;
    env.ALZ_NETWORK_SSL_CERT_FILE = emulator.caFile;

    contractPath = join(fresh("contract"), "act-pilot-contract.json");
    useContract(contract());

    // TEST FIXTURE: the qualification attestation is forged here because no person can attest an emulator run. It records the REAL
    // binary hash and version. It is not evidence of identity separation and must never be copied into production code.
    const vault = fresh("qualification");
    for (const [adapterVersion, argvDigest] of [[APPLY_ADAPTER.adapterVersion, APPLY_ADAPTER.argvDigest], [CLEANUP_ADAPTER.adapterVersion, CLEANUP_ADAPTER.argvDigest], [ADAPTER_VERSION, terraformArgvDigest("TERRAFORM")]]) {
      const written = await writeQualificationEvidence({
        schemaVersion: 1, engine: "TERRAFORM", realEngine: true, backendIdentitySeparated: true, projectId: PROJECT, region: REGION, backend: DEV.backend, workspace: "default",
        stateWriteClientId: email("STATE_WRITE"), applyClientId: email("APPLY"), terraformSha256: binarySha, adapterVersion, argvDigest, engineVersion, qualifiedAt: "2026-10-11T00:00:00.000Z",
      } as never, GCP, vault);
      assert.ok(written.ok, JSON.stringify(written));
    }
    evidenceDir = fresh("evidence");
    deps = {
      contractPath, qualificationDir: vault, evidenceDir, nonces: openNonceStore(fresh("nonces")), env, now: () => NOW, scratchParent: fresh("scratch"),
      toolDirs: [toolDir, "/usr/bin", "/bin"], killPollMs: 100, killGraceMs: 30_000, sourceCommit: SOURCE_COMMIT,
    };
  });

  after(() => {
    emulator?.stop();
    process.chdir(previousCwd);
    if (previousKey === undefined) delete process.env.AGENTIC_EVIDENCE_KEY; else process.env.AGENTIC_EVIDENCE_KEY = previousKey;
    removeTree(root);
  });

  // --- fixtures -----------------------------------------------------------------------------------------------------------

  /** Writes the reviewed contract and derives the unit labels prepare would print for it (they follow the contract's hash). */
  function useContract(value: unknown): void {
    writeReviewedContract(contractPath, value);
    unitLabels = { ...pilotUnitOf({ provider: "GCP", contractSha256: pilotContractSha256(loadPilotContract(contractPath) as PilotContract), environment: "DEV", target: DEV }).tags };
  }

  /** The committed canary, copied unchanged, with the operator's tfvars; `edit` changes the copy for a refusal case. */
  function canary(name: string, tfvars: Record<string, unknown> = {}, edit?: (hcl: string) => string) {
    const projectRoot = fresh("project");
    cpSync(CANARY_DIR, projectRoot, { recursive: true });
    if (edit) writeFileSync(join(projectRoot, "main.tf"), edit(readFileSync(join(projectRoot, "main.tf"), "utf8")));
    writeFileSync(join(projectRoot, "terraform.tfvars.json"), JSON.stringify({ region: REGION, canary_name: name, owner: "alz-sim-owner", unit_labels: unitLabels, ...tfvars }));
    const lock = readFileSync(join(projectRoot, ".terraform.lock.hcl"), "utf8");
    const resolved = { engineVersion, providers: lockedProviders(lock), lockFileSha256: sha(lock), dependencies: [], inputs: [] };
    const manifest = buildManifest({ engine: "TERRAFORM", mode: "PROJECT", target: DEV, unitHash: "1".repeat(64), files: captureProjectFiles(projectRoot), policyVersion: POLICY, ...resolved });
    return { projectRoot, manifest, resolved };
  }
  const topicName = (name: string): string => "projects/" + PROJECT + "/topics/" + name;
  const STATE_OBJECT = PREFIX + "/default.tfstate";
  const LOCK_OBJECT = PREFIX + "/default.tflock";

  /**
   * Owner decision E1: a canary run only creates, so each scenario starts as the owner's cleanup of the previous canary would leave
   * it: no topic, and an empty workspace (lineage kept, serial moved). The state object stays.
   */
  async function emptyWorkspace(): Promise<void> {
    assert.equal((await control("/topics/reset", {})).status, 200);
    const got = await emulator.gcs("GET", "/storage/v1/b/" + BUCKET + "/o/" + encodeURIComponent(STATE_OBJECT) + "?alt=media");
    if (got.status !== 200) return;
    const state = JSON.parse(got.body) as { serial: number; resources: unknown[] };
    if (state.resources.length === 0) return;
    const put = await emulator.gcs("POST", "/upload/storage/v1/b/" + BUCKET + "/o?uploadType=media&name=" + encodeURIComponent(STATE_OBJECT), JSON.stringify({ ...state, serial: state.serial + 1, resources: [], outputs: {} }));
    assert.equal(put.status, 200, put.body);
  }
  const sealRequest = (p: ReturnType<typeof canary>) => ({ invocation: human(DEV), environment: "DEV" as const, target: DEV, manifest: p.manifest, projectRoot: p.projectRoot, policyVersion: POLICY, resolved: p.resolved, requester: REQUESTER });
  async function seal(name: string) {
    await emptyWorkspace();
    const p = canary(name);
    const result = await sealPreview(sealRequest(p), deps);
    assert.ok(result.ok, JSON.stringify(result));
    const loaded = await loadSealedPlan(result.path);
    assert.ok(loaded.ok);
    return { sealed: result.sealed, project: p, loaded: { sealed: loaded.sealed, planBytes: loaded.planBytes } };
  }
  type Sealed = Awaited<ReturnType<typeof seal>>;
  const requestFor = (s: Sealed, approvals: SignedApproval[]): ApplyRequest => ({
    invocation: human(DEV), environment: "DEV", target: { ...DEV }, sealedPlan: s.loaded, manifest: s.project.manifest, projectRoot: s.project.projectRoot, approvals,
  });
  const run = (s: Sealed, who: "alice" | "bob" | "carol" = "alice"): Promise<ApplyResult> => runApply(requestFor(s, [approvalFor(s.sealed, who)]), deps);
  const ledgerOf = (s: Sealed): string => join(evidenceDir, s.sealed.artifactSha256 + ".apply.evidence");
  /** The observation's HTTP seam, pointed at the emulator: the same requests the reader sends, to the same emulated hosts. */
  const viaEmulator: GcpHttp = async (request) => {
    const url = new URL(request.url);
    try { return await emulator.call(url.host, request.method, url.pathname + url.search, { ...request.headers }, request.body); } catch { return { status: 0, body: "" }; }
  };
  const observeDeps = (): ObserveDeps => ({ contractPath, evidenceDir, env, toolDirs: [toolDir], scratchParent: deps.scratchParent, now: () => new Date(NOW.getTime() + 60_000), gcp: viaEmulator });
  const topics = async (): Promise<Topic[]> => JSON.parse((await emulator.call(CONTROL_HOST, "GET", "/topics")).body) as Topic[];
  const control = (path: string, body: unknown) => emulator.call(CONTROL_HOST, "POST", path, { "content-type": "application/json" }, JSON.stringify(body));
  const noSecrets = (value: unknown): void => {
    const text = JSON.stringify(value);
    for (const identity of IDENTITIES) assert.ok(!text.includes(subjectToken(identity)), "output carries " + identity + "'s subject token");
    assert.ok(!/\b(?:fed|sa)-[0-9a-f]{24}\b/.test(text), "output carries an emulated access token");
  };
  const cleanupApproval = (proposal: CleanupProposal, who: keyof typeof keys): SignedApproval => signApproval({
    schemaVersion: 1, artifactSha256: proposal.proposalSha256, environment: proposal.environment, target: proposal.target, approverId: who,
    issuedAt: new Date(NOW.getTime() - 5 * 60_000).toISOString(), expiresAt: new Date(NOW.getTime() + 25 * 60_000).toISOString(), nonce: randomBytes(16).toString("hex"),
  }, keys[who].priv, "CLEANUP");

  // --- the path ---------------------------------------------------------------------------------------------------------

  it("seals the committed canary: real init verifies HashiCorp's signature and the lock, the real plan passes the judge, exactly one topic in the contract's region", async () => {
    const s = await seal("alz-act-dev-1-seal-01");
    assert.deepEqual(s.sealed.changes.map((c) => [c.address, c.type, c.action]), [["google_pubsub_topic.act_dev1", "google_pubsub_topic", "CREATE"]]);
    assert.deepEqual(s.sealed.unit?.untagged, [], "the topic carries the unit labels through the provider's default_labels");
    assert.equal(s.sealed.sourceCommit, SOURCE_COMMIT);
    assert.ok(verifyReviewBundle(JSON.parse(JSON.stringify(reviewBundleOf(s.sealed)))).ok);
    assert.equal(s.loaded.planBytes.subarray(0, 2).toString("latin1"), "PK");
    noSecrets(s.sealed);
    const log = emulator.log();
    // The provider came from the emulated registry with HashiCorp's own signed files; init refuses a bad signature or a hash outside the lock.
    assert.ok(log.some((e) => e.host === "releases.hashicorp.com" && e.path?.endsWith("_SHA256SUMS.72D7468F.sig")), "the signature was fetched and checked");
    assert.equal((await topics()).length, 0, "a seal creates nothing");
    // embedStateWrite: the seal-time backend names STATE_WRITE, so the plan's state lock and reads are STATE_WRITE's, never DISCOVERY's or APPLY's.
    const backend = log.filter((e) => e.host === "storage.googleapis.com");
    assert.ok(backend.length > 0 && backend.every((e) => e.sa === email("STATE_WRITE")), JSON.stringify([...new Set(backend.map((e) => e.sa))]));
    assert.ok(!log.some((e) => e.host === "pubsub.googleapis.com" && e.method !== "GET"), "a seal only reads Pub/Sub");
  });

  it("applies the sealed canary end to end: APPLY creates the one topic with the contract region's storage policy, STATE_WRITE alone writes state, evidence and blueprint name the commit, nothing leaks", async () => {
    const s = await seal("alz-act-dev-1-apply-01");
    const before = emulator.log().length;
    const result = await run(s);
    assert.ok(result.ok, JSON.stringify(result));
    noSecrets(result);
    const record = await readEncryptedEvidence<ApplyEvidence>(ledgerOf(s));
    assert.equal(record.outcome, "SUCCEEDED");
    assert.equal(record.sourceCommit, SOURCE_COMMIT);
    assert.equal(record.toolVersions.engine, engineVersion);
    noSecrets(record);
    const [topic] = await topics();
    assert.equal(topic.name, topicName("alz-act-dev-1-apply-01"));
    assert.deepEqual(topic.messageStoragePolicy, { allowedPersistenceRegions: [REGION] }, "D11: the contract's region, and only it");
    for (const [key, value] of Object.entries({ ...unitLabels, environment: "dev", "managed-by": "sovereign-alz", purpose: "act-dev-1", owner: "alz-sim-owner" })) assert.equal(topic.labels[key], value, key);
    const during = emulator.log().slice(before);
    const creates = during.filter((e) => e.host === "pubsub.googleapis.com" && e.method === "PUT");
    assert.deepEqual(creates.map((e) => e.sa), [email("APPLY")], "APPLY created the topic, once");
    assert.ok(!during.some((e) => e.host === "pubsub.googleapis.com" && e.method === "DELETE"), "nothing was deleted");
    const stateWrites = during.filter((e) => e.host === "storage.googleapis.com" && e.method === "POST" && e.path?.includes("/upload/") && e.object === STATE_OBJECT);
    assert.ok(stateWrites.length > 0 && stateWrites.every((e) => e.sa === email("STATE_WRITE")), "only STATE_WRITE writes state: " + JSON.stringify(stateWrites.map((e) => e.sa)));
    assert.ok(!during.some((e) => e.host === "storage.googleapis.com" && e.sa === email("APPLY")), "APPLY never touches the state bucket");
    assert.equal((await emulator.gcs("GET", "/storage/v1/b/" + BUCKET + "/o/" + encodeURIComponent(LOCK_OBJECT))).status, 404, "the lock object is released");
    // Review N2 of #341, on a real apply: the blueprint the driver kept from the state names the topic and this commit.
    const blueprint = await readBlueprintRecord(s.sealed.artifactSha256, sha256(canonicalJson(record as never)), evidenceDir);
    assert.ok(blueprint, "the blueprint was kept");
    assert.equal(blueprint.sourceCommit, SOURCE_COMMIT);
    assert.deepEqual(blueprint.blueprint.entries.map((e) => [e.address, e.id, e.origin]), [["google_pubsub_topic.act_dev1", topicName("alz-act-dev-1-apply-01"), "IN_PLAN"]]);
    noSecrets(blueprint);
    // Every connection went to an emulated host; Terraform's version check was refused; nothing else was reachable.
    const connects = emulator.log().filter((e) => e.connect).map((e) => e.connect as string);
    assert.deepEqual([...new Set(connects.filter((c) => !EMULATED_HOSTS.map((h) => h + ":443").includes(c) && c !== VERSION_CHECK_HOST))], [], "no other host was contacted");

    // The independent observation, as DISCOVERY, through the reader's own requests: per-host tokens (D15) and the storage policy read back (D11).
    const observed = await observeRun(s.sealed.artifactSha256, observeDeps());
    assert.ok(observed.ok, JSON.stringify(observed));
    assert.equal(observed.record.verifier, "GCP_REST");
    assert.equal(observed.record.verdict, "VERIFIED", JSON.stringify(observed.record));
    assert.equal(observed.record.inventory, "COMPLETE");
    assert.equal(observed.record.sourceCommit, SOURCE_COMMIT);
    const reads = emulator.log().filter((e) => e.sa === email("DISCOVERY"));
    assert.ok(reads.every((e) => e.method === "GET"), "DISCOVERY only reads");
    assert.deepEqual([...new Set(reads.filter((e) => e.host === "pubsub.googleapis.com").map((e) => e.scope))], ["https://www.googleapis.com/auth/pubsub"]);
    assert.deepEqual([...new Set(reads.filter((e) => e.host === "cloudasset.googleapis.com").map((e) => e.scope))], ["https://www.googleapis.com/auth/cloud-platform"]);
    noSecrets(observed.record);
  });

  it("binds STATE_WRITE (owner decision 6486426552): the plan holds STATE_WRITE's credential-file reference and service account, never a token; a renewed token file is used at apply without resealing; APPLY never reaches the state bucket", async () => {
    const s = await seal("alz-act-dev-1-renew-01");
    const plan = Buffer.concat([...zipEntries(s.loaded.planBytes).values()]).toString("latin1");
    assert.ok(plan.includes(env.ALZ_STATE_WRITE_GOOGLE_APPLICATION_CREDENTIALS as string), "the plan names STATE_WRITE's credential configuration file, a reference");
    assert.ok(plan.includes(email("STATE_WRITE")), "and STATE_WRITE's service account");
    assert.ok(!plan.includes(email("APPLY")) && !plan.includes(env.ALZ_APPLY_GOOGLE_APPLICATION_CREDENTIALS as string), "nothing of APPLY's");
    for (const identity of IDENTITIES) {
      assert.ok(!plan.includes(subjectToken(identity)), "no subject token: " + identity);
      assert.ok(!s.loaded.planBytes.includes(subjectToken(identity)), "no subject token in the compressed bytes: " + identity);
    }
    assert.ok(!/\b(fed|sa)-[0-9a-f]{24}\b/.test(plan), "no federated or service-account access token");
    // Renewal: STATE_WRITE's token file is rewritten after the seal, as a delivery would refresh it. The credential configuration and the plan are unchanged.
    const configuration = JSON.parse(readFileSync(env.ALZ_STATE_WRITE_GOOGLE_APPLICATION_CREDENTIALS as string, "utf8")) as { credential_source: { file: string } };
    const tokenFile = configuration.credential_source.file;
    writeFileSync(tokenFile, subjectToken("STATE_WRITE") + "-RENEWED\n", { mode: 0o600 });
    try {
      const before = emulator.log().length;
      const result = await run(s);
      assert.ok(result.ok, JSON.stringify(result));
      noSecrets(result);
      const during = emulator.log().slice(before);
      const exchanges = during.filter((e) => e.host === "sts.googleapis.com" && e.subjectOf === email("STATE_WRITE"));
      assert.ok(exchanges.length > 0 && exchanges.every((e) => e.renewed === true), "STATE_WRITE exchanged the renewed token, never the one current at seal");
      const backend = during.filter((e) => e.host === "storage.googleapis.com" && e.sa !== null);
      assert.ok(backend.length > 0, "the apply reached the state bucket");
      assert.ok(backend.every((e) => e.sa === email("STATE_WRITE") || e.sa === email("STATE")), "only STATE_WRITE, and STATE's read: " + JSON.stringify([...new Set(backend.map((e) => e.sa))]));
      const lockOrState = backend.filter((e) => e.method !== "GET" && e.method !== "HEAD");
      assert.ok(lockOrState.length > 0 && lockOrState.every((e) => e.sa === email("STATE_WRITE")), "every state write and lock operation is STATE_WRITE's");
      assert.ok(!during.some((e) => e.host === "storage.googleapis.com" && e.sa === email("APPLY")), "APPLY never reaches the state bucket");
    } finally {
      writeFileSync(tokenFile, subjectToken("STATE_WRITE") + "\n", { mode: 0o600 });
    }
  });

  it("refuses a second apply of the same artifact, with a fresh approval", async () => {
    const s = await seal("alz-act-dev-1-again-01");
    assert.ok((await run(s)).ok);
    const again = await run(s, "carol");
    assert.equal(again.ok, false);
    assert.equal((again as { code: string }).code, "ARTIFACT_ALREADY_APPLIED");
  });

  it("the judge on the real provider's plan: another region, CMEK, message retention, a tag binding or ABANDON on destroy seals nothing", async () => {
    for (const [label, tfvars, edit, code] of [
      ["another region", { region: "us-central1" }, undefined, "LOCATION_NOT_IN_CONTRACT"],
      ["CMEK", {}, (hcl: string) => hcl.replace("  name = var.canary_name\n", '  name = var.canary_name\n  kms_key_name = "projects/other-proj/locations/europe-west4/keyRings/r/cryptoKeys/k"\n'), "CANARY_ATTRIBUTE_NOT_IN_CONTRACT"],
      ["message retention", {}, (hcl: string) => hcl.replace("  name = var.canary_name\n", '  name = var.canary_name\n  message_retention_duration = "600s"\n'), "CANARY_ATTRIBUTE_NOT_IN_CONTRACT"],
      ["a tag binding", {}, (hcl: string) => hcl.replace("  name = var.canary_name\n", '  name = var.canary_name\n  tags = { "tagKeys/123" = "tagValues/456" }\n'), "CANARY_ATTRIBUTE_NOT_IN_CONTRACT"],
      ["ABANDON on destroy", {}, (hcl: string) => hcl.replace("  name = var.canary_name\n", '  name = var.canary_name\n  deletion_policy = "ABANDON"\n'), "CANARY_ATTRIBUTE_NOT_IN_CONTRACT"],
      ["no storage policy", {}, (hcl: string) => hcl.replace(/\n {2}message_storage_policy \{[^}]*\}\n/, "\n"), "LOCATION_NOT_IN_CONTRACT"],
      ["another project", {}, (hcl: string) => hcl.replace('"examplefake-dev"', '"examplefake-other"'), "PROVIDER_ACCOUNT_NOT_IN_CONTRACT"],
    ] as const) {
      await emptyWorkspace();
      const result = await sealPreview(sealRequest(canary("alz-act-dev-1-refused-" + ++counter, tfvars, edit)), deps);
      assert.equal(result.ok, false, label);
      assert.ok(JSON.stringify(result).includes(code), label + ": " + JSON.stringify(result));
    }
    assert.equal((await topics()).filter((t) => t.name.includes("refused")).length, 0, "nothing was created");
  });

  it("observation reads the storage policy back: a topic stored elsewhere FAILS as DIFFERENT_FROM_DESIRED and gets no cleanup proposal; a hand-deleted topic observes as FAILED (missing), the expected absence result", async () => {
    const s = await seal("alz-act-dev-1-policy-01");
    assert.ok((await run(s)).ok);
    const name = topicName("alz-act-dev-1-policy-01");
    await control("/topics/regions", { name, regions: ["us-central1"] });
    const moved = await observeRun(s.sealed.artifactSha256, observeDeps());
    assert.ok(moved.ok);
    assert.equal(moved.record.verdict, "FAILED");
    assert.deepEqual(moved.record.resources.map((r) => [r.result, r.reason]), [["DIFFERENT_FROM_DESIRED", "LOCATION_NOT_IN_CONTRACT"]]);
    const records = await loadRunRecords(s.sealed.artifactSha256, evidenceDir);
    assert.ok(records.ok);
    const built = buildCleanupProposal({ requesterId: REQUESTER.requesterId, ...records, changes: s.sealed.changes, channel: "CLI", contract: loadPilotContract(contractPath) as PilotContract, engineVersion: s.sealed.engineVersion, env, now: new Date(NOW.getTime() + 120_000) });
    assert.equal(built.ok, false);
    assert.equal((built as { code: string }).code, "OBSERVATION_INCONCLUSIVE");
    // Review note N-3 of the API record: a person deletes the topic by hand, and observing again reports it missing (FAILED).
    await control("/topics/delete", { name });
    const gone = await observeRun(s.sealed.artifactSha256, observeDeps());
    assert.ok(gone.ok);
    assert.equal(gone.record.verdict, "FAILED");
    assert.deepEqual(gone.record.resources.map((r) => r.result), ["MISSING"]);
  });

  it("proposes and runs the governed cleanup: only the run's topic is deleted, by APPLY, and the leftovers check confirms it is gone", async () => {
    const s = await seal("alz-act-dev-1-cleanup-01");
    assert.ok((await run(s)).ok);
    const observed = await observeRun(s.sealed.artifactSha256, observeDeps());
    assert.ok(observed.ok && observed.record.verdict === "VERIFIED", JSON.stringify(observed));
    const records = await loadRunRecords(s.sealed.artifactSha256, evidenceDir);
    assert.ok(records.ok);
    const built = buildCleanupProposal({ requesterId: REQUESTER.requesterId, ...records, changes: s.sealed.changes, channel: "CLI", contract: loadPilotContract(contractPath) as PilotContract, engineVersion: s.sealed.engineVersion, env, now: new Date(NOW.getTime() + 120_000) });
    assert.ok(built.ok, JSON.stringify(built));
    const proposal = signCleanupProposal(built.proposal, REQUESTER.privateKeyPem);
    assert.deepEqual(proposal.deletes.map((d) => [d.address, d.identifier]), [["google_pubsub_topic.act_dev1", topicName("alz-act-dev-1-cleanup-01")]]);
    const before = emulator.log().length;
    const cleaned = await runCleanup({
      invocation: human(DEV), environment: "DEV", target: { ...DEV }, proposal, sealedPlan: s.loaded, manifest: s.project.manifest, projectRoot: s.project.projectRoot,
      approvals: [cleanupApproval(proposal, "alice")],
    }, deps);
    assert.ok(cleaned.ok, JSON.stringify(cleaned));
    const deletes = emulator.log().slice(before).filter((e) => e.host === "pubsub.googleapis.com" && e.method === "DELETE");
    assert.deepEqual(deletes.map((e) => [e.path, e.sa]), [["/v1/" + topicName("alz-act-dev-1-cleanup-01"), email("APPLY")]], "the one topic, by APPLY");
    // The cleanup's destroy plan carries the same STATE_WRITE binding (owner decision 6486426552): its state and lock work is STATE_WRITE's, never APPLY's.
    const cleanupBackend = emulator.log().slice(before).filter((e) => e.host === "storage.googleapis.com" && e.sa !== null && e.method !== "GET" && e.method !== "HEAD");
    assert.ok(cleanupBackend.length > 0 && cleanupBackend.every((e) => e.sa === email("STATE_WRITE")), "the cleanup's state writes and lock: " + JSON.stringify([...new Set(cleanupBackend.map((e) => e.sa))]));
    assert.ok(!emulator.log().slice(before).some((e) => e.host === "storage.googleapis.com" && e.sa === email("APPLY")), "APPLY never reaches the state bucket during cleanup");
    assert.ok(!(await topics()).some((t) => t.name === topicName("alz-act-dev-1-cleanup-01")));
    const leftovers = await verifyProposalLeftovers(proposal, { ...observeDeps(), now: () => new Date(NOW.getTime() + 600_000) });
    assert.ok(leftovers.ok, JSON.stringify(leftovers));
    assert.deepEqual(leftovers.record.resources.map((r) => [r.address, r.disposition, r.basis]), [["google_pubsub_topic.act_dev1", "CONFIRMED_DELETED", "GCP_REST_ABSENT"]]);
    noSecrets([proposal, cleaned, leftovers.record]);
  });

  it("classifies another holder's lock as FAILED_NO_CHANGE and leaves that lock alone", async () => {
    const s = await seal("alz-act-dev-1-lock-01");
    const other = JSON.stringify({ ID: "11111111-2222-4333-8444-555555555555", Operation: "OperationTypeApply", Info: "", Who: "other-operator@elsewhere", Version: engineVersion, Created: NOW.toISOString(), Path: "gs://" + BUCKET + "/" + LOCK_OBJECT });
    const taken = await emulator.gcs("POST", "/upload/storage/v1/b/" + BUCKET + "/o?uploadType=media&ifGenerationMatch=0&name=" + encodeURIComponent(LOCK_OBJECT), other);
    assert.equal(taken.status, 200, taken.body);
    try {
      const result = await run(s);
      assert.equal(result.ok, false);
      assert.equal((result as { outcome?: string }).outcome, "FAILED_NO_CHANGE", JSON.stringify(result));
      assert.ok(!(await topics()).some((t) => t.name === topicName("alz-act-dev-1-lock-01")), "nothing was created");
      assert.equal((await emulator.gcs("GET", "/storage/v1/b/" + BUCKET + "/o/" + encodeURIComponent(LOCK_OBJECT) + "?alt=media")).body, other, "the other holder's lock is unchanged");
    } finally {
      assert.ok([200, 204].includes((await emulator.gcs("DELETE", "/storage/v1/b/" + BUCKET + "/o/" + encodeURIComponent(LOCK_OBJECT))).status));
    }
  });

  it("refuses when the kill switch exists, before the engine runs", async () => {
    const s = await seal("alz-act-dev-1-kill-01");
    writeFileSync(KILL, "stop");
    try {
      const result = await run(s);
      assert.equal(result.ok, false);
      assert.equal((result as { code: string }).code, "KILL_SWITCH_ACTIVE");
      assert.equal(existsSync(ledgerOf(s)), false, "a blocked run reserves nothing");
    } finally { rmSync(KILL, { force: true }); }
  });

  it("EMULATED: a GCP contract without embedStateWrite true (absent or false) is refused at load (#345 review N1), so no seal starts and no request reaches the emulated state backend or Pub/Sub", async () => {
    // Before the contract rule, this run showed the risk: without embedStateWrite the apply process's own identity, APPLY, locked,
    // read and wrote the gcs state. The contract now refuses such a contract, so that apply can no longer be sealed.
    const absent = (({ embedStateWrite: _dropped, ...rest }) => rest)(contract());
    try {
      for (const raw of [contract(false), absent]) {
        writeReviewedContract(contractPath, raw);
        const off = loadPilotContract(contractPath);
        assert.equal(off.enabled, false);
        assert.match((off as { reason: string }).reason, /^embedStateWrite: GCP TERRAFORM requires embedStateWrite true/);
        await emptyWorkspace();
        const before = emulator.log().length;
        const result = await sealPreview(sealRequest(canary("alz-act-dev-1-noembed-01")), deps);
        assert.equal(result.ok, false);
        assert.equal((result as { code: string }).code, "CONTRACT_INVALID");
        assert.equal(emulator.log().length, before, "nothing reached the emulator");
      }
    } finally {
      useContract(contract());
    }
  });
});
