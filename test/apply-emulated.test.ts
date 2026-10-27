import assert from "node:assert/strict";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import type http from "node:http";
import https from "node:https";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { writeQualificationEvidence } from "../src/apply/contract.js";
import { runApply, sealPreview, type ApplyDeps, type ApplyRequest } from "../src/apply/driver.js";
import { openNonceStore } from "../src/apply/nonces.js";
import { loadSealedPlan, reviewBundleOf, verifyReviewBundle } from "../src/apply/seal.js";
import { APPLY_ADAPTER } from "../src/apply/terraform.js";
import type { ApplyEnvironment, ApplyEvidence, ApplyResult, SignedApproval } from "../src/apply/types.js";
import { readEncryptedEvidence } from "../src/evidence/vault.js";
import { ADAPTER_VERSION, terraformArgvDigest } from "../src/teardown/driver/adapters/terraform.js";
import { buildManifest } from "../src/teardown/manifest.js";
import { captureProjectFiles } from "../src/teardown/snapshot.js";
import { removeTree } from "../src/teardown/driver/cleanup.js";
import {
  DEV_TARGET, NOW, POLICY, QA_TARGET, REQUESTER, SOURCE_COMMIT, TENANT, approvalFor, contractJson, human, identityEnv, sha, writeReviewedContract,
} from "./helpers/apply-fixtures.js";
import { AZURE } from "../src/apply/providers/azure.js";

/**
 * OPT-IN SIMULATION (docs/act-pilot-simulation.md). Skipped unless BOTH
 * ALZ_SIM_TERRAFORM (a real Terraform 1.x binary) and ALZ_SIM_AZURITE (the
 * Azurite blob service executable) are set, so default CI is unaffected.
 *
 * It drives the real src/apply driver (seal, approve, apply, evidence, ledger,
 * second apply refused, stale plan, kill switch, lock refusal) against the REAL
 * Terraform engine and an EMULATED Azure Storage backend (Azurite) with
 * built-in `terraform_data` resources only. It creates and touches no real
 * cloud resource: every connection is routed by a local proxy to a loopback
 * emulator, and any other host is refused.
 *
 * What this does NOT exercise: Entra ID and OIDC (Azurite cannot emulate them;
 * state access here is a SAS token signed with Azurite's published development
 * key, which is not a secret), the azurerm provider (the registry is not
 * reachable and no resource is declared), real Azure RBAC, real latency or
 * throttling. Whether the STATE_WRITE and APPLY identities stay separate is
 * therefore still unproven; see "What this does not prove" in the doc.
 *
 * DEV MODE ONLY setup (never an operator step; operators use ./alz):
 *   npm install --prefix <scratch>/azurite azurite
 *   ALZ_SIM_TERRAFORM=<verified terraform> ALZ_SIM_AZURITE=<scratch>/azurite/node_modules/.bin/azurite-blob \
 *     npx tsx --test test/apply-emulated.test.ts
 * Optional: ALZ_SIM_TERRAFORM_SHA256 makes the test refuse a binary whose hash differs.
 */
const TERRAFORM = process.env.ALZ_SIM_TERRAFORM;
const AZURITE = process.env.ALZ_SIM_AZURITE;
const SKIP = !TERRAFORM || !AZURITE ? "set ALZ_SIM_TERRAFORM and ALZ_SIM_AZURITE to run the emulated-backend simulation (docs/act-pilot-simulation.md)" : false;

// Azurite's published development account and key (public documentation; not a secret).
const ACCOUNT = "devstoreaccount1";
const DEV_KEY = "Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==";
const BLOB_HOST = ACCOUNT + ".blob.alz-sim.test";
const METADATA_HOST = "alz-sim.test:8443";
const CONTAINER = "tfstate";
const STATE_KEY = "dev.tfstate";
const BACKEND = `${ACCOUNT}/${CONTAINER}/${STATE_KEY}`;
const API_VERSION = "2023-11-03";

const isoSeconds = (date: Date): string => date.toISOString().replace(/\.\d+Z$/, "Z");

/** A container-scoped service SAS signed with the development key. */
function containerSas(permissions = "racwdl"): string {
  const start = isoSeconds(new Date(Date.now() - 5 * 60_000)), expiry = isoSeconds(new Date(Date.now() + 60 * 60_000));
  const toSign = [permissions, start, expiry, `/blob/${ACCOUNT}/${CONTAINER}`, "", "", "https", API_VERSION, "c", "", "", "", "", "", "", ""].join("\n");
  const sig = createHmac("sha256", Buffer.from(DEV_KEY, "base64")).update(toSign, "utf8").digest("base64");
  return new URLSearchParams({ sv: API_VERSION, sp: permissions, sr: "c", st: start, se: expiry, spr: "https", sig }).toString();
}

type Emulator = {
  proxyUrl: string; caFile: string; connects(): string[];
  blob(method: string, path: string, headers?: Record<string, string>): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }>;
  stop(): Promise<void>;
};

const freePort = (): Promise<number> => new Promise((resolve, reject) => {
  const server = net.createServer();
  server.listen(0, "127.0.0.1", () => { const { port } = server.address() as net.AddressInfo; server.close(() => resolve(port)); });
  server.on("error", reject);
});

async function waitForPort(port: number, limitMs = 30_000): Promise<void> {
  const end = Date.now() + limitMs;
  for (;;) {
    const open = await new Promise<boolean>((resolve) => {
      const socket = net.connect(port, "127.0.0.1", () => { socket.destroy(); resolve(true); });
      socket.on("error", () => resolve(false));
    });
    if (open) return;
    if (Date.now() > end) throw new Error("the emulator did not start");
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** Azurite over TLS, a metadata endpoint that names it as the storage suffix, and a CONNECT proxy that sends only those two hosts to loopback. */
async function startEmulator(dir: string): Promise<Emulator> {
  const key = join(dir, "key.pem"), cert = join(dir, "cert.pem");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "2", "-keyout", key, "-out", cert, "-subj", "/CN=alz-sim.test",
    "-addext", `subjectAltName=DNS:alz-sim.test,DNS:${BLOB_HOST}`], { stdio: "ignore" });
  const tls = { key: readFileSync(key), cert: readFileSync(cert) };

  const blobPort = await freePort();
  mkdirSync(join(dir, "azurite"), { recursive: true });
  const azurite: ChildProcess = spawn(AZURITE as string, [
    "--silent", "--disableTelemetry", "--location", join(dir, "azurite"), "--blobHost", "127.0.0.1", "--blobPort", String(blobPort),
    "--cert", cert, "--key", key, "--skipApiVersionCheck",
  ], { stdio: "ignore", env: { PATH: process.env.PATH ?? "", HOME: dir } });
  await waitForPort(blobPort);

  // The driver blocks this process while Terraform runs (synchronous spawns), so the metadata endpoint and the proxy live in a helper process.
  const helperPath = join(dir, "helper.cjs"), connectsLog = join(dir, "connects.log");
  writeFileSync(helperPath, HELPER);
  const helper: ChildProcess = spawn(process.execPath, [helperPath, key, cert, String(blobPort), BLOB_HOST, METADATA_HOST, connectsLog], { stdio: ["ignore", "pipe", "inherit"] });
  const proxyPort = await new Promise<number>((resolve, reject) => {
    helper.once("error", reject);
    helper.stdout?.once("data", (chunk: Buffer) => resolve(Number(chunk.toString().trim())));
    helper.once("exit", () => reject(new Error("the proxy helper exited")));
  });

  const blob: Emulator["blob"] = (method, path, headers = {}) => new Promise((resolve, reject) => {
    const request = https.request({
      host: "127.0.0.1", port: blobPort, servername: BLOB_HOST, ca: tls.cert, method,
      path, headers: { host: BLOB_HOST, "x-ms-version": API_VERSION, ...headers },
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks).toString("utf8") }));
    });
    request.on("error", reject);
    request.end();
  });

  return {
    proxyUrl: `http://127.0.0.1:${proxyPort}`, caFile: cert, blob,
    connects: () => (existsSync(connectsLog) ? readFileSync(connectsLog, "utf8").split("\n").filter(Boolean) : []),
    async stop() { azurite.kill("SIGKILL"); helper.kill("SIGKILL"); },
  };
}

const HELPER = `
const https = require("node:https"), http = require("node:http"), net = require("node:net"), fs = require("node:fs");
const [key, cert, blobPort, blobHost, metadataHost, log] = process.argv.slice(2);
const tls = { key: fs.readFileSync(key), cert: fs.readFileSync(cert) };
const root = "https://" + metadataHost + "/";
const metadata = JSON.stringify({
  name: "AlzSim", portal: root, authentication: { loginEndpoint: root, audiences: [root], tenant: "common", identityProvider: "AAD" },
  graphAudience: root, graph: root, microsoftGraphResourceId: root, resourceManager: root, batch: root, media: root,
  suffixes: { storage: "alz-sim.test", keyVaultDns: "vault.alz-sim.test" },
});
const meta = https.createServer(tls, (req, res) => {
  if (req.url.startsWith("/metadata/endpoints")) { res.writeHead(200, { "content-type": "application/json" }); res.end(metadata); } else { res.writeHead(404); res.end("{}"); }
});
meta.listen(0, "127.0.0.1", () => {
  const routes = { [metadataHost]: meta.address().port, [blobHost + ":443"]: Number(blobPort) };
  const proxy = http.createServer((_req, res) => { res.writeHead(403); res.end(); });
  proxy.on("connect", (req, client, head) => {
    // A client reset at any moment (a refused host hanging up, a canceled request) must never end the helper: no CONNECT is ever unhandled.
    client.on("error", () => client.destroy());
    fs.appendFileSync(log, req.url + "\\n");
    const target = routes[req.url];
    if (target === undefined) { client.end("HTTP/1.1 403 Forbidden\\r\\n\\r\\n"); return; }
    const upstream = net.connect(target, "127.0.0.1", () => {
      client.write("HTTP/1.1 200 Connection Established\\r\\n\\r\\n");
      if (head.length > 0) upstream.write(head);
      upstream.pipe(client); client.pipe(upstream);
    });
    upstream.on("error", () => client.destroy());
    client.on("close", () => upstream.destroy());
  });
  proxy.on("clientError", (_error, socket) => socket.destroy());
  proxy.listen(0, "127.0.0.1", () => process.stdout.write(String(proxy.address().port) + "\\n"));
});
`;

/** Creates the state container with a SharedKey-signed request (the only unsigned-by-SAS call: a container SAS cannot create its own container). */
function createContainer(emulator: Emulator): Promise<number> {
  const date = new Date().toUTCString();
  const toSign = `PUT\n\n\n\n\n\n\n\n\n\n\n\nx-ms-date:${date}\nx-ms-version:${API_VERSION}\n/${ACCOUNT}/${CONTAINER}\nrestype:container`;
  const signature = createHmac("sha256", Buffer.from(DEV_KEY, "base64")).update(toSign).digest("base64");
  return emulator.blob("PUT", `/${CONTAINER}?restype=container`, {
    "x-ms-date": date, authorization: `SharedKey ${ACCOUNT}:${signature}`, "content-length": "0",
  }).then((r) => r.status);
}

describe("emulated backend simulation: real Terraform, Azurite, built-in resources only", { skip: SKIP }, () => {
  const root = mkdtempSync(join(tmpdir(), "alz-sim-"));
  const previousCwd = process.cwd();
  const previousKey = process.env.AGENTIC_EVIDENCE_KEY;
  let emulator: Emulator;
  let toolDir = "";
  let engineVersion = "";
  let counter = 0;
  const KILL = join(root, "KILL");
  const fresh = (label: string): string => { const dir = join(root, label + "-" + ++counter); mkdirSync(dir, { recursive: true }); return dir; };
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  let vault = "";
  let evidence = "";
  let nonces = "";
  let scratch = "";
  let env: NodeJS.ProcessEnv;
  let deps: ApplyDeps;
  let contractPath = "";

  before(async () => {
    process.env.AGENTIC_EVIDENCE_KEY = randomBytes(32).toString("base64");
    process.chdir(root); // the vault writes sealed plans under ./.runs

    const binary = TERRAFORM as string;
    assert.ok(existsSync(binary), "ALZ_SIM_TERRAFORM does not exist");
    const binarySha = createHash("sha256").update(readFileSync(binary)).digest("hex");
    if (process.env.ALZ_SIM_TERRAFORM_SHA256) assert.equal(binarySha, process.env.ALZ_SIM_TERRAFORM_SHA256.toLowerCase(), "the terraform binary is not the verified one");
    // The runner finds `terraform` by name in approved directories; /usr/bin and /bin keep sh, touch and sleep reachable for the local-exec fixture.
    toolDir = fresh("tools");
    symlinkSync(binary, join(toolDir, "terraform"));
    engineVersion = (JSON.parse(execFileSync(binary, ["version", "-json"], { env: { PATH: "/usr/bin:/bin" }, encoding: "utf8" })) as { terraform_version: string }).terraform_version;

    emulator = await startEmulator(fresh("emulator"));
    assert.equal(await createContainer(emulator), 201);

    // The DEV contract names the emulator's storage account; the tenant and subscription are obviously fake GUIDs.
    contractPath = join(fresh("contract"), "act-pilot-contract.json");
    const contract = contractJson(KILL, {
      targets: {
        DEV: { tenantId: TENANT, subscriptionId: DEV_TARGET.account, backend: BACKEND, workspace: "default" },
        QA: { tenantId: TENANT, subscriptionId: QA_TARGET.account, backend: "emulatedqa/tfstate/qa.tfstate", workspace: "default" },
        PROD: { tenantId: TENANT, subscriptionId: "33333333-3333-4333-8333-333333333333", backend: "emulatedprod/tfstate/prod.tfstate", workspace: "default" },
      },
    });
    writeReviewedContract(contractPath, contract);

    // TEST FIXTURE: the qualification attestation is forged here because no person can attest an emulator run. It records the REAL
    // binary hash and version. It is not evidence of identity separation and must never be copied into production code.
    vault = fresh("qualification");
    const attested = (adapterVersion: string, argvDigest: string) => ({
      schemaVersion: 1 as const, engine: "TERRAFORM" as const, realEngine: true as const, backendIdentitySeparated: true as const,
      tenantId: TENANT, subscriptionId: DEV_TARGET.account, backend: BACKEND, workspace: "default",
      stateWriteClientId: "statewrite-client-3", applyClientId: "apply-client-4", terraformSha256: binarySha,
      adapterVersion, argvDigest, engineVersion, qualifiedAt: "2026-10-11T00:00:00.000Z",
    });
    for (const [version, digest] of [[APPLY_ADAPTER.adapterVersion, APPLY_ADAPTER.argvDigest], [ADAPTER_VERSION, terraformArgvDigest("TERRAFORM")]]) {
      const written = await writeQualificationEvidence(attested(version, digest), AZURE, vault);
      assert.ok(written.ok, JSON.stringify(written));
    }

    evidence = fresh("evidence"); nonces = fresh("nonces"); scratch = fresh("scratch");
    // Terraform reads the OIDC token file at init when use_oidc is set, even though state access here uses the SAS token, so the file must exist.
    const tokenFile = join(fresh("oidc"), "statewrite-token");
    writeFileSync(tokenFile, "emulated-not-a-real-token\n", { mode: 0o600 });
    env = {
      ...identityEnv("DEV" satisfies ApplyEnvironment), ALZ_STATE_WRITE_ARM_OIDC_TOKEN_FILE: tokenFile,
      // Network settings reach the child only as ALZ_NETWORK_*: the proxy sends the two emulator hosts to loopback; the CA is the emulator's own.
      ALZ_NETWORK_HTTPS_PROXY: emulator.proxyUrl, ALZ_NETWORK_SSL_CERT_FILE: emulator.caFile,
    };
    deps = {
      contractPath, qualificationDir: vault, evidenceDir: evidence, nonces: openNonceStore(nonces), env,
      // The product commit a seal binds (a fixture value: the test runs from a temporary directory, not from a checkout).
      now: () => NOW, scratchParent: scratch, toolDirs: [toolDir, "/usr/bin", "/bin"], killPollMs: 100, killGraceMs: 30_000, sourceCommit: SOURCE_COMMIT,
    };
  });

  after(async () => {
    await emulator?.stop();
    process.chdir(previousCwd);
    if (previousKey === undefined) delete process.env.AGENTIC_EVIDENCE_KEY; else process.env.AGENTIC_EVIDENCE_KEY = previousKey;
    removeTree(root);
  });

  // --- fixtures ---------------------------------------------------------------------------------

  const LOCK = "# This file is maintained automatically by \"terraform init\".\n# The pilot fixture uses only the built-in terraform provider.\n";
  /** The pinned project: an azurerm backend aimed at the emulator and one built-in resource. The SAS token is the emulator's, signed with its public development key. */
  function project(input: string, extra = "") {
    const projectRoot = fresh("project");
    writeFileSync(join(projectRoot, "main.tf"), [
      "terraform {",
      '  backend "azurerm" {',
      `    storage_account_name = "${ACCOUNT}"`,
      `    container_name       = "${CONTAINER}"`,
      `    key                  = "${STATE_KEY}"`,
      `    metadata_host        = "${METADATA_HOST}"`,
      `    sas_token            = "${containerSas()}"`,
      "  }",
      "}",
      'resource "terraform_data" "pilot" {',
      `  input = "${input}"`,
      "}",
      extra,
      "",
    ].join("\n"));
    writeFileSync(join(projectRoot, ".terraform.lock.hcl"), LOCK);
    const resolved = { engineVersion, providers: [], lockFileSha256: sha(LOCK), dependencies: [], inputs: [] };
    const manifest = buildManifest({
      engine: "TERRAFORM", mode: "PROJECT", target: DEV_TARGET_EMULATED, unitHash: "1".repeat(64), files: captureProjectFiles(projectRoot), policyVersion: POLICY, ...resolved,
    });
    return { projectRoot, manifest, resolved };
  }
  const DEV_TARGET_EMULATED = { account: DEV_TARGET.account, backend: BACKEND, workspace: "default" };

  async function seal(input: string, extra = "") {
    const p = project(input, extra);
    const result = await sealPreview({
      invocation: human(DEV_TARGET_EMULATED), environment: "DEV", target: DEV_TARGET_EMULATED, manifest: p.manifest, projectRoot: p.projectRoot,
      policyVersion: POLICY, resolved: p.resolved, requester: REQUESTER,
    }, deps);
    assert.ok(result.ok, JSON.stringify(result));
    const loaded = await loadSealedPlan(result.path);
    assert.ok(loaded.ok);
    return { sealed: result.sealed, project: p, loaded: { sealed: loaded.sealed, planBytes: loaded.planBytes } };
  }
  type Sealed = Awaited<ReturnType<typeof seal>>;
  const requestFor = (s: Sealed, approvals: SignedApproval[]): ApplyRequest => ({
    invocation: human(DEV_TARGET_EMULATED), environment: "DEV", target: { ...DEV_TARGET_EMULATED }, sealedPlan: s.loaded,
    manifest: s.project.manifest, projectRoot: s.project.projectRoot, approvals,
  });
  const run = (s: Sealed, who: "alice" | "bob" | "carol" = "alice"): Promise<ApplyResult> =>
    runApply(requestFor(s, [approvalFor(s.sealed, who)]), deps);
  const ledgerOf = (s: Sealed): string => join(evidence, s.sealed.artifactSha256 + ".apply.evidence");
  const stored = (s: Sealed) => readEncryptedEvidence<ApplyEvidence>(ledgerOf(s));
  const sas = () => containerSas();
  const stateBlob = async (): Promise<{ serial: number; inputs: unknown[] }> => {
    const response = await emulator.blob("GET", `/${CONTAINER}/${STATE_KEY}?${sas()}`);
    assert.equal(response.status, 200, response.body);
    const state = JSON.parse(response.body) as { serial: number; resources: { type: string; instances: { attributes: { input: unknown } }[] }[] };
    return { serial: state.serial, inputs: state.resources.filter((r) => r.type === "terraform_data").flatMap((r) => r.instances.map((i) => (i.attributes.input as { value: unknown } | null)?.value)) };
  };
  const leaseState = async (): Promise<string | undefined> => {
    const response = await emulator.blob("HEAD", `/${CONTAINER}/${STATE_KEY}?${sas()}`);
    return response.headers["x-ms-lease-state"] as string | undefined;
  };
  const noSecrets = (value: unknown): void => {
    const text = JSON.stringify(value);
    for (const secret of ["sig=", "sv=2023", DEV_KEY, "statewrite-secret-cccc", "apply-secret-dddd"]) assert.ok(!text.includes(secret), "output carries " + secret.slice(0, 6));
  };

  // --- the path, against the real engine ------------------------------------------------------------

  it("seals with the real engine, the review bundle verifies, and the plan is the real show -json shape", async () => {
    const s = await seal("first");
    assert.deepEqual(s.sealed.changes.map((c) => [c.address, c.type, c.action]), [["terraform_data.pilot", "terraform_data", "CREATE"]]);
    const bundle = verifyReviewBundle(JSON.parse(JSON.stringify(reviewBundleOf(s.sealed))));
    assert.ok(bundle.ok);
    // The engine's plan file is a zip; the sealed bytes are exactly what terraform wrote.
    assert.equal(s.loaded.planBytes.subarray(0, 2).toString("latin1"), "PK");
  });

  it("applies a sealed plan end to end: state lands in the emulator, evidence and ledger are written, nothing leaks", async () => {
    const s = await seal("first");
    const result = await run(s);
    assert.ok(result.ok, JSON.stringify(result));
    noSecrets(result);
    const landed = await stateBlob();
    assert.deepEqual(landed.inputs, ["first"]);
    assert.ok(landed.serial >= 1);
    assert.equal(await leaseState(), "available", "the state lease is released");
    const record = await stored(s);
    assert.equal(record.outcome, "SUCCEEDED");
    assert.equal(record.exitCode, 0);
    assert.equal(record.toolVersions.engine, engineVersion);
    noSecrets(record);
    // Terraform's own version check (checkpoint-api.hashicorp.com) is attempted on every run; the proxy refuses it. Nothing else is reachable.
    assert.deepEqual(emulator.connects().filter((c) => c !== METADATA_HOST && c !== BLOB_HOST + ":443" && c !== "checkpoint-api.hashicorp.com:443"), [], "no host other than the emulator was ever contacted");
  });

  it("refuses a second apply of the same artifact, with a fresh approval", async () => {
    const s = await seal("second-seal-target");
    const first = await run(s);
    assert.ok(first.ok, JSON.stringify(first));
    const again = await run(s, "carol");
    assert.equal(again.ok, false);
    assert.equal((again as { code: string }).code, "ARTIFACT_ALREADY_APPLIED");
  });

  it("refuses a stale plan: state changed after sealing, nothing applied, serial unmoved", async () => {
    const older = await seal("stale-older");
    const newer = await seal("stale-newer");
    const applied = await run(newer);
    assert.ok(applied.ok, JSON.stringify(applied));
    const before = await stateBlob();
    const result = await run(older, "bob");
    assert.equal(result.ok, false);
    assert.equal((result as { code: string }).code, "PLAN_STALE", JSON.stringify(result));
    assert.equal((await stored(older)).outcome, "FAILED_NO_CHANGE");
    noSecrets(result);
    assert.deepEqual(await stateBlob(), before);
    assert.deepEqual(before.inputs, ["stale-newer"]);
  });

  it("classifies a held state lease as FAILED_NO_CHANGE and leaves the other holder's lease alone", async () => {
    const s = await seal("lock-held");
    const lease = await emulator.blob("PUT", `/${CONTAINER}/${STATE_KEY}?comp=lease&${sas()}`, { "x-ms-lease-action": "acquire", "x-ms-lease-duration": "-1", "content-length": "0" });
    assert.equal(lease.status, 201, lease.body);
    const leaseId = lease.headers["x-ms-lease-id"] as string;
    try {
      const before = await stateBlob();
      const result = await run(s);
      assert.equal(result.ok, false);
      assert.equal((result as { outcome?: string }).outcome, "FAILED_NO_CHANGE", JSON.stringify(result));
      assert.deepEqual(await stateBlob(), before);
      assert.equal(await leaseState(), "leased", "the other holder's lease is untouched");
    } finally {
      const released = await emulator.blob("PUT", `/${CONTAINER}/${STATE_KEY}?comp=lease&${sas()}`, { "x-ms-lease-action": "release", "x-ms-lease-id": leaseId, "content-length": "0" });
      assert.equal(released.status, 200);
    }
  });

  it("refuses when the kill switch exists, before the engine runs", async () => {
    const s = await seal("kill-before");
    writeFileSync(KILL, "stop");
    try {
      const result = await run(s);
      assert.equal(result.ok, false);
      assert.equal((result as { code: string }).code, "KILL_SWITCH_ACTIVE");
      assert.equal(existsSync(ledgerOf(s)), false, "a blocked run reserves nothing");
    } finally { rmSync(KILL, { force: true }); }
  });

  it("stops a running apply when the kill switch appears: Terraform is interrupted, the lease is released, the outcome is KILLED", async () => {
    const flag = join(root, "slow-started");
    const s = await seal("kill-during", `resource "terraform_data" "slow" {\n  provisioner "local-exec" {\n    command = "touch ${flag}; sleep 120"\n  }\n}`);
    const before = await stateBlob();
    let settled: ApplyResult | undefined;
    const running = run(s).then((r) => (settled = r));
    for (let waited = 0; !existsSync(flag); waited += 100) {
      if (settled || waited > 60_000) throw new Error("the apply never reached the provisioner: " + JSON.stringify(settled));
      await sleep(100);
    }
    assert.equal(await leaseState(), "leased", "Terraform holds the state lease while it applies");
    writeFileSync(KILL, "stop");
    try {
      const result = await running;
      assert.equal(result.ok, false);
      assert.equal((result as { outcome?: string }).outcome, "KILLED", JSON.stringify(result));
      assert.equal((await stored(s)).outcome, "KILLED");
      noSecrets(result);
    } finally { rmSync(KILL, { force: true }); }
    assert.equal(await leaseState(), "available", "a graceful interrupt releases the lease");
    assert.ok((await stateBlob()).serial > before.serial, "the interrupted resource was recorded in state");
  });
});
