import assert from "node:assert/strict";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import type http from "node:http";
import https from "node:https";
import net from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { loadPilotContract, writeQualificationEvidence } from "../src/apply/contract.js";
import { runApply, sealPreview, type ApplyDeps, type ApplyRequest } from "../src/apply/driver.js";
import { openNonceStore } from "../src/apply/nonces.js";
import { loadSealedPlan, reviewBundleOf, sealPlan, verifyReviewBundle } from "../src/apply/seal.js";
import { TERRAFORM as TERRAFORM_ENGINE } from "../src/apply/engines/terraform.js";
import { writeBackendOverride } from "../src/apply/backend-pin.js";
import { pilotUnitOf } from "../src/apply/unit.js";
import { buildChildEnvironment } from "../src/tools/child-env.js";
import { TERRAFORM_APPLY_PROFILE } from "../src/tools/profiles.js";
import { EXECUTION_IDENTITIES } from "../src/tools/identity.js";
import { createImmutableSnapshot } from "../src/teardown/snapshot.js";
import { createPrivateDirectory } from "../src/tools/private-workdir.js";
import { APPLY_ADAPTER } from "../src/apply/terraform.js";
import type { ApplyEnvironment, ApplyEvidence, ApplyResult, SignedApproval } from "../src/apply/types.js";
import { readEncryptedEvidence } from "../src/evidence/vault.js";
import { ADAPTER_VERSION, terraformArgvDigest } from "../src/teardown/driver/adapters/terraform.js";
import { buildManifest } from "../src/teardown/manifest.js";
import { captureProjectFiles } from "../src/teardown/snapshot.js";
import { removeTree } from "../src/teardown/driver/cleanup.js";
import {
  DEV_TARGET, ENGINE_VERSION, H, NOW, POLICY, QA_TARGET, REQUESTER, SOURCE_COMMIT, TENANT, approvalFor, behave as behaveFake, callsOf, contractJson, human, identityEnv,
  installFakeTerraform, sha, writeReviewedContract, writeProject,
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
 * key, which is not a secret, supplied only by the TEST-ONLY AZURITE SAS HARNESS
 * below; Entra ID state auth is proven only in the supervised DEV qualification), the azurerm provider (the registry is not
 * reachable and no resource is declared), real Azure RBAC, real latency or
 * throttling. Whether the STATE_WRITE and APPLY identities stay separate is
 * therefore still unproven; see "What this does not prove" in the doc.
 *
 * DEV MODE ONLY setup (never an operator step; operators use ./alz):
 *   npm install --prefix <scratch>/azurite azurite
 *   ALZ_SIM_TERRAFORM=<verified terraform> ALZ_SIM_AZURITE=<scratch>/azurite/node_modules/.bin/azurite-blob \
 *     npx tsx --test test/apply-emulated.test.ts
 * Optional: ALZ_SIM_TERRAFORM_SHA256 makes the test refuse a binary whose hash differs.
 *
 * The last describe block runs in default CI with no emulator and a fake engine: it proves that the emulator's
 * credentials (the SAS token, the metadata host, the development key) are refused however they are supplied
 * (contract, project files, backend configuration, environment) and that the harness is reachable only from here.
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
    // A fresh connection per call (no keep-alive pool): Azurite closes idle sockets, and a reused one fails with ECONNRESET after a long engine step.
    const request = https.request({
      agent: false, host: "127.0.0.1", port: blobPort, servername: BLOB_HOST, ca: tls.cert, method,
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

/**
 * TEST-ONLY AZURITE SAS HARNESS. Azurite cannot issue Entra ID tokens, so the emulated backend is reached with a
 * container SAS (signed with Azurite's published development key, not a secret) and a custom metadata host. The
 * product never accepts either: the project's backend block carries neither, no contract field names them, and no
 * product flag or variable selects them. The harness is a wrapper the TEST installs as `terraform` in the tool
 * directory it hands the driver (`deps.toolDirs`); the wrapper sets Terraform's own `ARM_SAS_TOKEN` and
 * `ARM_METADATA_HOSTNAME` in its own process and then runs the real binary. It exists only in this file and in a
 * temporary directory, and nothing in src/ can reach it.
 */
function installAzuriteSasHarness(toolDir: string, realTerraform: string, sas: string): string {
  const quote = (value: string): string => "'" + value.replace(/'/g, "'\\''") + "'";
  const wrapper = join(toolDir, "terraform");
  writeFileSync(wrapper, [
    "#!/bin/sh",
    "# ALZ TEST-ONLY AZURITE SAS HARNESS (test/apply-emulated.test.ts). Never shipped and never an operator step.",
    "ARM_SAS_TOKEN=" + quote(sas) + "; export ARM_SAS_TOKEN",
    "ARM_METADATA_HOSTNAME=" + quote(METADATA_HOST) + "; export ARM_METADATA_HOSTNAME",
    "exec " + quote(realTerraform) + ' "$@"',
    "",
  ].join("\n"), { mode: 0o700 });
  return wrapper;
}

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
  let plainToolDir = "";
  let realSha = "";
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
    realSha = createHash("sha256").update(readFileSync(binary)).digest("hex");
    if (process.env.ALZ_SIM_TERRAFORM_SHA256) assert.equal(realSha, process.env.ALZ_SIM_TERRAFORM_SHA256.toLowerCase(), "the terraform binary is not the verified one");
    engineVersion = (JSON.parse(execFileSync(binary, ["version", "-json"], { env: { PATH: "/usr/bin:/bin" }, encoding: "utf8" })) as { terraform_version: string }).terraform_version;

    emulator = await startEmulator(fresh("emulator"));
    assert.equal(await createContainer(emulator), 201);

    // The runner finds `terraform` by name in approved directories; /usr/bin and /bin keep sh, touch and sleep reachable for the local-exec fixture.
    // The `terraform` it finds here is the test-only SAS harness around the real binary, so the engine hash the driver binds is the harness's.
    toolDir = fresh("tools");
    const binarySha = createHash("sha256").update(readFileSync(installAzuriteSasHarness(toolDir, binary, containerSas()))).digest("hex");
    // The real binary on its own, as a production host would run it: no harness.
    plainToolDir = fresh("plain-tools");
    symlinkSync(binary, join(plainToolDir, "terraform"));

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
  /** The pinned project: an azurerm backend naming the contract's storage account, container and key, and one built-in resource. It carries no credential and no endpoint: the harness supplies the emulator's. */
  function project(input: string, extra = "") {
    const projectRoot = fresh("project");
    writeFileSync(join(projectRoot, "main.tf"), [
      "terraform {",
      '  backend "azurerm" {',
      `    storage_account_name = "${ACCOUNT}"`,
      `    container_name       = "${CONTAINER}"`,
      `    key                  = "${STATE_KEY}"`,
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

  /**
   * Real `terraform init` (through the harness, as the STATE identity's child would run it) in a directory holding the product's backend
   * override and the product's backend file, plus `extra` lines a test appends to that file. Returns the backend init saved.
   */
  function realInitSaved(extra: readonly string[]): Record<string, unknown> {
    const work = fresh("init");
    writeFileSync(join(work, "main.tf"), 'resource "terraform_data" "probe" {}\n');
    writeBackendOverride(work, "azurerm");
    const pinned = { tenantId: TENANT, subscriptionId: DEV_TARGET.account, backend: BACKEND, workspace: "default" };
    const backendFile = join(fresh("backend"), "alz-backend.tfbackend");
    writeFileSync(backendFile, AZURE.backendLocation(pinned) + extra.map((line) => line + "\n").join(""), { mode: 0o600 });
    const child = buildChildEnvironment({ profile: TERRAFORM_APPLY_PROFILE, base: env, toolDirs: [toolDir, "/usr/bin", "/bin"], home: fresh("home"), tmp: fresh("tmp"), identity: "STATE" });
    try {
      execFileSync(join(toolDir, "terraform"), ["init", "-input=false", "-no-color", "-backend-config=" + backendFile], { cwd: work, env: child.env, stdio: ["ignore", "ignore", "pipe"] });
    } catch (error) {
      // The emulator's own error text: it can quote only the harness's SAS, signed with Azurite's published development key.
      throw new Error("real init failed with " + JSON.stringify(extra.map((line) => line.split(" ")[0])) + ": " + String((error as { stderr?: Buffer }).stderr ?? "").slice(0, 2000));
    }
    return (JSON.parse(readFileSync(join(work, ".terraform", "terraform.tfstate"), "utf8")) as { backend: Record<string, unknown> }).backend;
  }

  it("real init saves the product's Entra-only backend exactly: use_azuread_auth true, and no SAS, key, resource group or endpoint", () => {
    const pinned = { tenantId: TENANT, subscriptionId: DEV_TARGET.account, backend: BACKEND, workspace: "default" };
    const saved = realInitSaved([]);
    const config = saved.config as Record<string, unknown>;
    assert.equal(saved.type, "azurerm");
    assert.equal(config.use_azuread_auth, true, "the product's backend file turns Entra ID authorization on, and init saves it (so the plan embeds it)");
    // The harness's ARM_SAS_TOKEN and ARM_METADATA_HOSTNAME reached init through its environment only, and init does not save them.
    for (const name of ["sas_token", "access_key", "resource_group_name", "lookup_blob_endpoint", "metadata_host", "endpoint", "client_secret", "use_msi", "use_cli"]) {
      assert.ok(config[name] === null || config[name] === undefined, name + " is not saved");
    }
    assert.equal(AZURE.savedBackendMatches(saved, pinned), true, "the product accepts what real init saved from its own file");
    // Had a SAS token or a resource group reached the saved backend, the product refuses it (and so the plan that embeds it). A shared
    // key cannot be probed here (init with `access_key` gets 403 from Azurite behind the custom host and saves nothing); the default-CI
    // test in test/apply-azure-state-auth.test.ts refuses a saved `access_key`.
    for (const line of [`sas_token = "${containerSas()}"`, 'resource_group_name = "rg-alz-sim"']) {
      const tainted = realInitSaved([line]);
      assert.notEqual((tainted.config as Record<string, unknown>)[line.split(" ")[0]], null, line.split(" ")[0] + " is saved when the file sets it");
      assert.equal(AZURE.savedBackendMatches(tainted, pinned), false, line.split(" ")[0] + " is refused");
    }
  });

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

  // --- emulator-only credentials never enter a production path, against the real engine -----------------

  const emulatorHosts = () => emulator.connects().filter((c) => c === METADATA_HOST || c === BLOB_HOST + ":443").length;

  it("a production seal without the harness is refused even when the project and the operator's environment carry the emulator's SAS and metadata host", async () => {
    const before = await stateBlob();
    const contacts = emulatorHosts();
    const seen = emulator.connects().length;
    const projectRoot = fresh("project");
    // The project's own backend block names the emulator's credential and endpoint; the product's pinned override replaces the block.
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
      '  input = "never-sealed"',
      "}",
      "",
    ].join("\n"));
    writeFileSync(join(projectRoot, ".terraform.lock.hcl"), LOCK);
    const resolved = { engineVersion, providers: [], lockFileSha256: sha(LOCK), dependencies: [], inputs: [] };
    const manifest = buildManifest({
      engine: "TERRAFORM", mode: "PROJECT", target: DEV_TARGET_EMULATED, unitHash: "1".repeat(64), files: captureProjectFiles(projectRoot), policyVersion: POLICY, ...resolved,
    });
    // The operator's own environment carries the harness's settings too; a child never inherits it.
    const production = { ...deps, toolDirs: [plainToolDir, "/usr/bin", "/bin"], env: { ...env, ...harnessSettings() } };
    const result = await sealPreview({
      invocation: human(DEV_TARGET_EMULATED), environment: "DEV", target: DEV_TARGET_EMULATED, manifest, projectRoot, policyVersion: POLICY, resolved, requester: REQUESTER,
    }, production);
    assert.equal(result.ok, false, "a production seal never reaches the emulator's state");
    // Init ran with the product's pinned backend (use_azuread_auth = true) and the STATE identity's OIDC settings only, and failed: the
    // backend asked Entra ID for a token, which the proxy refuses. That is the production path: Entra ID, never the emulator's SAS.
    assert.equal((result as { code: string }).code, "ARTIFACT_INVALID", JSON.stringify(result));
    noSecrets(result);
    assert.equal(emulatorHosts(), contacts, "neither the emulator's storage host nor its metadata host was contacted");
    assert.ok(emulator.connects().slice(seen).some((host) => host === "login.microsoftonline.com:443"), "the production backend went to Entra ID for its token");
    assert.deepEqual(await stateBlob(), before);
  });

  it("a production apply with the harness's settings is refused: as identity variables, or through an engine binary the qualification did not attest", async () => {
    const s = await seal("harness-settings-refused");
    const before = await stateBlob();
    // As one identity's variables (one at a time, so the refusal is theirs and not a shared value's): refused before the engine changes anything.
    for (const identity of TERRAFORM_IDENTITIES) {
      const injected = await runApply(requestFor(s, [approvalFor(s.sealed, "alice")]), { ...deps, env: { ...env, ...harnessIdentityVariables([identity]) } });
      assert.equal(injected.ok, false, identity);
      assert.match((injected as { message: string }).message, /ENVIRONMENT_REFUSED/, identity);
      noSecrets(injected);
      assert.deepEqual(await stateBlob(), before, identity);
      assert.equal(await leaseState(), "available", identity);
    }
    // Through the harness binary under a production qualification, which attests the real binary only.
    const productionVault = fresh("production-qualification");
    for (const [version, digest] of [[APPLY_ADAPTER.adapterVersion, APPLY_ADAPTER.argvDigest], [ADAPTER_VERSION, terraformArgvDigest("TERRAFORM")]]) {
      const written = await writeQualificationEvidence({
        schemaVersion: 1, engine: "TERRAFORM", realEngine: true, backendIdentitySeparated: true,
        tenantId: TENANT, subscriptionId: DEV_TARGET.account, backend: BACKEND, workspace: "default",
        stateWriteClientId: "statewrite-client-3", applyClientId: "apply-client-4", terraformSha256: realSha,
        adapterVersion: version, argvDigest: digest, engineVersion, qualifiedAt: "2026-10-11T00:00:00.000Z",
      }, AZURE, productionVault);
      assert.ok(written.ok, JSON.stringify(written));
    }
    const unattested = await runApply(requestFor(s, [approvalFor(s.sealed, "bob")]), { ...deps, qualificationDir: productionVault });
    assert.equal((unattested as { code?: string }).code, "ENGINE_NOT_QUALIFIED", JSON.stringify(unattested));
    noSecrets(unattested);
    assert.deepEqual(await stateBlob(), before);
    // And the real binary cannot apply a plan the harness sealed: the engine that applies must be the one that sealed.
    const swapped = await runApply(requestFor(s, [approvalFor(s.sealed, "carol")]), { ...deps, toolDirs: [plainToolDir, "/usr/bin", "/bin"], qualificationDir: productionVault });
    assert.equal((swapped as { code?: string }).code, "ENGINE_BINARY_CHANGED", JSON.stringify(swapped));
    assert.deepEqual(await stateBlob(), before);
  });
});

// --- default CI: emulator-only credentials can never enter a production path ------------------------------

/** The settings the harness gives Terraform, as an operator might try to supply them in the environment. */
const harnessSettings = (): NodeJS.ProcessEnv => ({ ARM_SAS_TOKEN: containerSas(), ARM_METADATA_HOSTNAME: METADATA_HOST, ARM_ACCESS_KEY: DEV_KEY });
/** The same settings as every identity's variables and as network variables. */
const harnessIdentityVariables = (identities: readonly string[] = TERRAFORM_IDENTITIES): NodeJS.ProcessEnv => Object.fromEntries([...identities, "NETWORK"].flatMap((identity) =>
  Object.entries(harnessSettings()).map(([name, value]) => ["ALZ_" + identity + "_" + name, value])));
/** The Terraform engine's four identities; CHANGESET belongs to CDK, and configuring it here would be refused for that reason alone. */
const TERRAFORM_IDENTITIES = ["DISCOVERY", "STATE", "STATE_WRITE", "APPLY"] as const;
const HARNESS_NAMES = ["ARM_SAS_TOKEN", "ARM_METADATA_HOSTNAME", "ARM_ACCESS_KEY"];
const HARNESS_TEXT = ["sas_token", "metadata_host", "access_key", METADATA_HOST, "sig=", DEV_KEY];

describe("emulator-only credentials never enter a production path (default CI; no emulator, fake engine)", () => {
  const root = mkdtempSync(join(tmpdir(), "alz-sim-guard-"));
  const previousCwd = process.cwd();
  const previousKey = process.env.AGENTIC_EVIDENCE_KEY;
  let counter = 0;
  const fresh = (label: string): string => { const dir = join(root, label + "-" + ++counter); mkdirSync(dir, { recursive: true }); return dir; };
  const KILL = join(root, "KILL");
  const toolDir = join(root, "fake-tools");
  // The fake engine saves the shared fixture's backend; the emulator's own location is checked in the contract test.
  const pinned = { tenantId: TENANT, subscriptionId: DEV_TARGET.account, backend: DEV_TARGET.backend, workspace: "default" };
  const target = { ...DEV_TARGET };

  before(() => {
    process.env.AGENTIC_EVIDENCE_KEY = randomBytes(32).toString("base64");
    process.chdir(root); // the vault writes sealed plans under ./.runs
    mkdirSync(toolDir, { recursive: true });
    installFakeTerraform(toolDir);
  });
  after(() => {
    process.chdir(previousCwd);
    if (previousKey === undefined) delete process.env.AGENTIC_EVIDENCE_KEY; else process.env.AGENTIC_EVIDENCE_KEY = previousKey;
    removeTree(root);
  });

  it("the contract refuses an Azurite SAS token or metadata host in any field", () => {
    const base = contractJson(KILL, {
      targets: {
        DEV: { tenantId: TENANT, subscriptionId: DEV_TARGET.account, backend: BACKEND, workspace: "default" },
        QA: { tenantId: TENANT, subscriptionId: QA_TARGET.account, backend: "emulatedqa/tfstate/qa.tfstate", workspace: "default" },
        PROD: { tenantId: TENANT, subscriptionId: "33333333-3333-4333-8333-333333333333", backend: "emulatedprod/tfstate/prod.tfstate", workspace: "default" },
      },
    });
    const load = (contract: unknown) => { const path = join(fresh("contract"), "act-pilot-contract.json"); writeReviewedContract(path, contract); return loadPilotContract(path); };
    assert.equal(load(base).enabled, true, "control: the emulator's storage account name alone is an ordinary backend location");
    const dev = (base.targets as Record<string, Record<string, unknown>>).DEV;
    for (const [label, contract] of [
      ["targets.DEV.sas_token", { ...base, targets: { ...base.targets, DEV: { ...dev, sas_token: containerSas() } } }],
      ["targets.DEV.metadata_host", { ...base, targets: { ...base.targets, DEV: { ...dev, metadata_host: METADATA_HOST } } }],
      ["targets.DEV.access_key", { ...base, targets: { ...base.targets, DEV: { ...dev, access_key: DEV_KEY } } }],
      ["sas_token", { ...base, sas_token: containerSas() }],
      ["metadata_host", { ...base, metadata_host: METADATA_HOST }],
      ["backend with a SAS query", { ...base, targets: { ...base.targets, DEV: { ...dev, backend: BACKEND + "?" + containerSas() } } }],
      ["backend with a metadata host", { ...base, targets: { ...base.targets, DEV: { ...dev, backend: METADATA_HOST + "/" + CONTAINER + "/" + STATE_KEY } } }],
    ] as const) {
      const loaded = load(contract);
      assert.equal(loaded.enabled, false, label);
      assert.equal((loaded as { code: string }).code, "CONTRACT_INVALID", label);
    }
  });

  it("the product's backend configuration never carries one, whatever the identity variables say", () => {
    const env = { ...identityEnv("DEV"), ...harnessSettings(), ...harnessIdentityVariables() };
    for (const text of [AZURE.backendLocation(pinned), AZURE.backendConfig(env, pinned)]) {
      for (const marker of HARNESS_TEXT) assert.ok(!text.includes(marker), "the backend configuration carries " + marker.slice(0, 13));
      const keys = text.split("\n").filter(Boolean).map((line) => line.split("=")[0].trim());
      for (const key of keys) {
        assert.ok(["storage_account_name", "container_name", "key", "use_oidc", "use_azuread_auth", "client_id", "tenant_id", "subscription_id", "oidc_token_file_path"].includes(key), key);
      }
    }
  });

  it("the environment never delivers one to a Terraform child: not as an identity variable, a network variable or the operator's own", () => {
    for (const name of HARNESS_NAMES) {
      assert.equal(TERRAFORM_APPLY_PROFILE.injectable.includes(name), false, name);
      assert.equal(TERRAFORM_APPLY_PROFILE.injectablePrefixes.some((prefix) => name.startsWith(prefix)), false, name);
    }
    const base = { ...identityEnv("DEV"), ...harnessSettings(), ...harnessIdentityVariables(EXECUTION_IDENTITIES) };
    for (const identity of EXECUTION_IDENTITIES) {
      const child = buildChildEnvironment({ profile: TERRAFORM_APPLY_PROFILE, base, toolDirs: [toolDir], home: root, tmp: root, identity });
      for (const name of HARNESS_NAMES) {
        assert.equal(child.env[name], undefined, identity + " " + name);
        assert.ok(child.refused.includes("ALZ_" + identity + "_" + name), identity + " refuses ALZ_" + identity + "_" + name);
        assert.ok(child.refused.includes("ALZ_NETWORK_" + name), identity + " refuses ALZ_NETWORK_" + name);
      }
      const text = JSON.stringify(child.env);
      for (const marker of [METADATA_HOST, "sig=", DEV_KEY]) assert.ok(!text.includes(marker), identity);
    }
  });

  /** A production seal (src/apply/seal.ts) through the fake engine, the way test/apply-seal.test.ts drives it. */
  async function productionSeal(options: { mainTf?: string; extraFile?: [string, string]; env?: NodeJS.ProcessEnv }) {
    behaveFake(toolDir, KILL);
    const projectRoot = fresh("project");
    if (options.extraFile) writeFileSync(join(projectRoot, options.extraFile[0]), options.extraFile[1]);
    const { manifest } = writeProject(projectRoot, target, options.mainTf);
    const parent = fresh("scratch");
    const snapshot = createImmutableSnapshot(projectRoot, manifest, parent);
    const scratch = createPrivateDirectory("alz-sim-guard-", parent);
    try {
      return await sealPlan({
        engine: TERRAFORM_ENGINE, environment: "DEV", target, manifest, snapshotPath: snapshot.path, scratchDir: scratch.path,
        env: options.env ?? identityEnv("DEV"), policyVersion: POLICY, engineVersion: ENGINE_VERSION, toolDirs: [toolDir],
        pinned, spec: AZURE, contractSha256: H("9"), sourceCommit: SOURCE_COMMIT,
        provenance: { engineBinarySha256: H("e"), qualification: { state: "UNQUALIFIED", reason: "Fixture: no qualification evidence." } },
        requester: REQUESTER, now: () => NOW, unit: pilotUnitOf({ provider: "AZURE", contractSha256: H("9"), environment: "DEV", target }),
      });
    } finally { snapshot.remove(); scratch.remove(); }
  }
  const SIM_BACKEND_TF = 'terraform {\n  backend "azurerm" {\n    metadata_host = "' + METADATA_HOST + '"\n    sas_token     = "' + containerSas() + '"\n  }\n}\nresource "azurerm_resource_group" "pilot" {}\n';

  it("a production seal with the harness's settings in the identity or network variables is refused before the engine uses them", async () => {
    const result = await productionSeal({ env: { ...identityEnv("DEV"), ...harnessIdentityVariables() } });
    assert.equal(result.ok, false);
    assert.match(JSON.stringify(result), /ENVIRONMENT_REFUSED/);
    for (const call of callsOf(toolDir)) for (const name of HARNESS_NAMES) assert.equal(call.env[name], undefined, call.args[0] + " " + name);
  });

  it("a production seal refuses a project override file that would carry the harness's settings, by name, before any engine step", async () => {
    for (const name of ["zzzz_alz_sim_override.tf", "azurite_override.tf", "override.tf.json"]) {
      const result = await productionSeal({ extraFile: [name, SIM_BACKEND_TF.replace(/resource[^\n]*\n$/, "")] });
      assert.equal(result.ok, false, name);
      assert.match(JSON.stringify(result), /BACKEND_OVERRIDE_NOT_ALLOWED/, name);
      assert.deepEqual(callsOf(toolDir).filter((c) => c.args[0] !== "version"), [], name + ": no engine step ran");
    }
  });

  it("a project's own SAS token or metadata host, and the operator's own, never reach init: the product's pinned backend replaces the block", async () => {
    const result = await productionSeal({ mainTf: SIM_BACKEND_TF, env: { ...identityEnv("DEV"), ...harnessSettings() } });
    assert.ok(result.ok, JSON.stringify(result));
    const init = callsOf(toolDir).find((c) => c.args[0] === "init");
    assert.equal(init?.backendOverride, 'terraform {\n  backend "azurerm" {}\n}\n', "the product's override pins an empty azurerm block");
    for (const marker of HARNESS_TEXT) assert.ok(!(init?.backendConfig ?? "").includes(marker), "init's backend configuration carries " + marker.slice(0, 13));
    for (const call of callsOf(toolDir)) for (const name of HARNESS_NAMES) assert.equal(call.env[name], undefined, call.args[0] + " " + name);
  });

  it("the test-only allowance is reachable only from this test file: no product code, script, configuration or other test names it", () => {
    const repo = resolve(fileURLToPath(new URL("..", import.meta.url)));
    const self = fileURLToPath(import.meta.url);
    const source = readFileSync(self, "utf8");
    assert.ok(!/^export /m.test(source), "this file exports nothing, so nothing can import the harness");
    const markers = ["installAzuriteSasHarness", "AZURITE SAS HARNESS", "ALZ_SIM_AZURITE", "alz-sim.test", DEV_KEY];
    const hits: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        if (["node_modules", ".git", ".runs", "dist", "docs"].includes(name)) continue;
        const path = join(dir, name);
        const stat = statSync(path, { throwIfNoEntry: false });
        if (!stat) continue;
        if (stat.isDirectory()) { walk(path); continue; }
        if (path === self || stat.size > 2_000_000 || !/\.(m?[jt]sx?|c?js|json|ya?ml|sh|py|hcl|tf|toml|txt)$|^(alz|Dockerfile)$/.test(name)) continue;
        const text = readFileSync(path, "utf8");
        for (const marker of markers) if (text.includes(marker)) hits.push(path.slice(repo.length + 1) + ": " + marker.slice(0, 24));
      }
    };
    walk(repo);
    assert.deepEqual(hits, [], "the harness and its emulator settings appear only in test/apply-emulated.test.ts (and its documentation)");
  });
});
