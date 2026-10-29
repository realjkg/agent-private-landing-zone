import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { execFile, execFileSync, spawn, type ChildProcess } from "node:child_process";
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
import { AWS } from "../src/apply/providers/aws.js";
import { loadSealedPlan, reviewBundleOf, verifyReviewBundle } from "../src/apply/seal.js";
import { APPLY_ADAPTER } from "../src/apply/terraform.js";
import type { ApplyEnvironment, ApplyEvidence, ApplyResult, SignedApproval } from "../src/apply/types.js";
import { readEncryptedEvidence } from "../src/evidence/vault.js";
import { ADAPTER_VERSION, terraformArgvDigest } from "../src/teardown/driver/adapters/terraform.js";
import { removeTree } from "../src/teardown/driver/cleanup.js";
import { buildManifest } from "../src/teardown/manifest.js";
import { captureProjectFiles } from "../src/teardown/snapshot.js";
import { zipEntries } from "./helpers/plan-zip.js";
import {
  AWS_DEV_TARGET, AWS_REGION, NOW, POLICY, REQUESTER, SOURCE_COMMIT, approvalFor, awsContractJson, awsIdentityEnv, awsRoleArn, human, sha, writeReviewedContract, withCanary } from "./helpers/apply-fixtures.js";

/**
 * OPT-IN SIMULATION (docs/act-pilot-simulation-aws.md), the AWS Terraform counterpart of test/apply-emulated.test.ts
 * and gate G1b of docs/act-pilot-plan.md for the first live ACT path. Skipped unless BOTH ALZ_SIM_TERRAFORM (a real
 * Terraform 1.x binary) and ALZ_SIM_MOTO (the `moto_server` executable of a moto[server] install) are set, so default
 * CI is unaffected.
 *
 * It drives the real src/apply driver (seal, approve, apply, evidence, ledger, second apply refused, stale plan, held
 * lock, kill switch) against the REAL Terraform engine and an EMULATED S3 state backend (moto) with built-in
 * `terraform_data` resources only: no aws provider, no registry access, no real AWS account, bucket, role or token.
 * Every connection is routed by a local CONNECT proxy to the loopback emulator, and any other host is refused. State
 * locking is the backend's native lock file (`use_lockfile`, the mode src/apply/providers/aws.ts pins); no DynamoDB.
 *
 * What this does NOT exercise: real STS (moto's AssumeRoleWithWebIdentity accepts any token and issues fake
 * credentials, so the web identity token files are dummies and no trust policy is evaluated), the aws provider (the
 * registry is not reachable and no aws resource is declared), real IAM or bucket policies, S3 versioning, real latency
 * or throttling. Whether the STATE_WRITE and APPLY identities stay separate is therefore still unproven; see "What
 * this does not prove" in the doc.
 *
 * DEV MODE ONLY setup (never an operator step; operators use ./alz):
 *   python3 -m venv <scratch>/moto && <scratch>/moto/bin/pip install "moto[server]"
 *   ALZ_SIM_TERRAFORM=<verified terraform> ALZ_SIM_MOTO=<scratch>/moto/bin/moto_server \
 *     npx tsx --test test/apply-emulated-aws.test.ts
 * Optional: ALZ_SIM_TERRAFORM_SHA256 makes the test refuse a binary whose hash differs. It needs `openssl` on the path.
 */
const TERRAFORM = process.env.ALZ_SIM_TERRAFORM;
const MOTO = process.env.ALZ_SIM_MOTO;
const SKIP = !TERRAFORM || !MOTO ? "set ALZ_SIM_TERRAFORM and ALZ_SIM_MOTO to run the AWS emulated-backend simulation (docs/act-pilot-simulation-aws.md)" : false;

// The contract's fake DEV target: a 12-digit account id that is obviously not real, and the fixture bucket and key.
const [BUCKET, ...KEY_PARTS] = AWS_DEV_TARGET.backend.split("/");
const STATE_KEY = KEY_PARTS.join("/");
const LOCK_KEY = STATE_KEY + ".tflock";
/** The hosts the S3 backend builds for this bucket and region (virtual-hosted-style S3 and the regional STS endpoint). */
const BUCKET_HOST = BUCKET + ".s3." + AWS_REGION + ".amazonaws.com";
const STS_HOST = "sts." + AWS_REGION + ".amazonaws.com";
const EMULATED_HOSTS = [BUCKET_HOST + ":443", STS_HOST + ":443"];
/** Terraform's own version check is attempted on every run and refused by the proxy; nothing else may be contacted. */
const VERSION_CHECK_HOST = "checkpoint-api.hashicorp.com:443";
/** The dummy web identity token: not a real token, and never allowed to appear in any result. */
const TOKEN_CANARY = "emulated-not-a-real-token-CANARY_WEB_IDENTITY";

type Emulator = {
  proxyUrl: string; caFile: string; connects(): string[];
  s3(method: string, path: string, headers?: Record<string, string>, body?: string): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }>;
  /** moto's own API (`/moto-api/...`): its request recorder and its model data, read directly, never through the proxy. */
  api(method: string, path: string): Promise<string>;
  /**
   * The status of one HEAD request, sent from a short-lived child process. Use it while the driver runs: the driver blocks this
   * process during its synchronous engine steps, and moto (werkzeug) completes each TLS handshake on its single accepting thread.
   * A request this process had begun would leave moto waiting for a ClientHello that only comes once the step ends, while the
   * step itself waits for moto: Terraform's STS call then fails with "TLS handshake timeout" after 3 attempts (about 33 seconds).
   */
  headOutOfProcess(path: string): Promise<number>;
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

/** moto over TLS with a throwaway certificate for the two AWS hostnames, and a CONNECT proxy that sends only those two hosts to loopback. */
async function startEmulator(dir: string): Promise<Emulator> {
  const key = join(dir, "key.pem"), cert = join(dir, "cert.pem");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "2", "-keyout", key, "-out", cert, "-subj", "/CN=alz-sim-aws",
    "-addext", `subjectAltName=DNS:${BUCKET_HOST},DNS:${STS_HOST}`], { stdio: "ignore" });
  const ca = readFileSync(cert);

  const motoPort = await freePort();
  mkdirSync(join(dir, "moto"), { recursive: true });
  const moto: ChildProcess = spawn(MOTO as string, ["-H", "127.0.0.1", "-p", String(motoPort), "-c", cert, "-k", key],
    { stdio: "ignore", env: { PATH: process.env.PATH ?? "", HOME: join(dir, "moto") } });
  await waitForPort(motoPort);

  // The driver blocks this process while Terraform runs (synchronous spawns), so the proxy lives in a helper process.
  const helperPath = join(dir, "helper.cjs"), connectsLog = join(dir, "connects.log");
  writeFileSync(helperPath, HELPER);
  const helper: ChildProcess = spawn(process.execPath, [helperPath, String(motoPort), connectsLog, ...EMULATED_HOSTS], { stdio: ["ignore", "pipe", "inherit"] });
  const proxyPort = await new Promise<number>((resolve, reject) => {
    helper.once("error", reject);
    helper.stdout?.once("data", (chunk: Buffer) => resolve(Number(chunk.toString().trim())));
    helper.once("exit", () => reject(new Error("the proxy helper exited")));
  });

  // Direct requests to the emulator (not through the proxy, so they never show in the connect log). moto checks that a request is signed, not the
  // signature itself, and treats an unsigned object request as anonymous (refused); this fixture credential is not a key of anything.
  const s3: Emulator["s3"] = (method, path, headers = {}, body) => new Promise((resolve, reject) => {
    const request = https.request({
      host: "127.0.0.1", port: motoPort, servername: BUCKET_HOST, ca, method, path,
      headers: {
        host: BUCKET_HOST, "content-length": String(Buffer.byteLength(body ?? "")), "x-amz-content-sha256": "UNSIGNED-PAYLOAD",
        authorization: `AWS4-HMAC-SHA256 Credential=AKIAFAKEEMULATORONLY/20261027/${AWS_REGION}/s3/aws4_request, SignedHeaders=host, Signature=${"0".repeat(64)}`,
        ...headers,
      },
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks).toString("utf8") }));
    });
    request.on("error", reject);
    request.end(body);
  });

  const api: Emulator["api"] = (method, path) => new Promise((resolve, reject) => {
    const request = https.request({ host: "127.0.0.1", port: motoPort, servername: BUCKET_HOST, ca, method, path, headers: { host: "127.0.0.1:" + motoPort, "content-length": "0" } }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    });
    request.on("error", reject);
    request.end();
  });

  const probePath = join(dir, "probe.cjs");
  writeFileSync(probePath, PROBE);
  const headOutOfProcess: Emulator["headOutOfProcess"] = (path) => new Promise((resolve, reject) => {
    execFile(process.execPath, [probePath, String(motoPort), cert, BUCKET_HOST, path, AWS_REGION], { encoding: "utf8" }, (error, stdout) => {
      if (error) reject(error); else resolve(Number(stdout.trim()));
    });
  });

  return {
    proxyUrl: `http://127.0.0.1:${proxyPort}`, caFile: cert, s3, api, headOutOfProcess,
    connects: () => (existsSync(connectsLog) ? readFileSync(connectsLog, "utf8").split("\n").filter(Boolean) : []),
    async stop() { moto.kill("SIGKILL"); helper.kill("SIGKILL"); },
  };
}

/** One HEAD request to the emulator, with the same fixture authorization as `s3`; prints the status. See `headOutOfProcess`. */
const PROBE = `
const https = require("node:https"), fs = require("node:fs");
const [port, caFile, host, path, region] = process.argv.slice(2);
const request = https.request({
  host: "127.0.0.1", port: Number(port), servername: host, ca: fs.readFileSync(caFile), method: "HEAD", path, agent: false,
  headers: {
    host, "content-length": "0", "x-amz-content-sha256": "UNSIGNED-PAYLOAD",
    authorization: "AWS4-HMAC-SHA256 Credential=AKIAFAKEEMULATORONLY/20261027/" + region + "/s3/aws4_request, SignedHeaders=host, Signature=" + "0".repeat(64),
  },
}, (response) => { response.resume(); response.on("end", () => process.stdout.write(String(response.statusCode))); });
request.on("error", (error) => { process.stderr.write(String(error)); process.exitCode = 2; });
request.end();
`;

const HELPER = `
const http = require("node:http"), net = require("node:net"), fs = require("node:fs");
const [motoPort, log, ...hosts] = process.argv.slice(2);
const proxy = http.createServer((_req, res) => { res.writeHead(403); res.end(); });
proxy.on("connect", (req, client, head) => {
  // A client reset at any moment (a refused host hanging up, Terraform's SDK canceling a request) must never end the helper: no CONNECT is ever unhandled.
  client.on("error", () => client.destroy());
  fs.appendFileSync(log, req.url + "\\n");
  if (!hosts.includes(req.url)) { client.end("HTTP/1.1 403 Forbidden\\r\\n\\r\\n"); return; }
  const upstream = net.connect(Number(motoPort), "127.0.0.1", () => {
    client.write("HTTP/1.1 200 Connection Established\\r\\n\\r\\n");
    if (head.length > 0) upstream.write(head);
    upstream.pipe(client); client.pipe(upstream);
  });
  upstream.on("error", () => client.destroy());
  client.on("close", () => upstream.destroy());
});
proxy.on("clientError", (_error, socket) => socket.destroy());
proxy.listen(0, "127.0.0.1", () => process.stdout.write(String(proxy.address().port) + "\\n"));
`;

describe("AWS emulated backend simulation: real Terraform, moto S3 with use_lockfile, built-in resources only", { skip: SKIP }, () => {
  const root = mkdtempSync(join(tmpdir(), "alz-sim-aws-"));
  const previousCwd = process.cwd();
  const previousKey = process.env.AGENTIC_EVIDENCE_KEY;
  let emulator: Emulator;
  let toolDir = "";
  let engineVersion = "";
  let counter = 0;
  const KILL = join(root, "KILL");
  const fresh = (label: string): string => { const dir = join(root, label + "-" + ++counter); mkdirSync(dir, { recursive: true }); return dir; };
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  /** Built-in values in the kill-during fixture: enough that the real apply runs for seconds after it takes the native lock. */
  const SLOW_COUNT = 2000;

  let vault = "";
  let evidence = "";
  let nonces = "";
  let scratch = "";
  let env: NodeJS.ProcessEnv;
  let deps: ApplyDeps;
  let contractPath = "";
  /**
   * Owner decision E1: the contract names, as every target's canary allowlist, exactly the terraform_data resources the scenario's plan
   * creates (the pilot resource, plus the kill test's slow ones), and each seal writes that allowlist before it plans.
   */
  const withTerraformDataCanary = (count: number) => withCanary(awsContractJson(KILL), { resources: [{ type: "terraform_data", count }] });

  before(async () => {
    process.env.AGENTIC_EVIDENCE_KEY = randomBytes(32).toString("base64");
    process.chdir(root); // the vault writes sealed plans under ./.runs

    const binary = TERRAFORM as string;
    assert.ok(existsSync(binary), "ALZ_SIM_TERRAFORM does not exist");
    const binarySha = createHash("sha256").update(readFileSync(binary)).digest("hex");
    if (process.env.ALZ_SIM_TERRAFORM_SHA256) assert.equal(binarySha, process.env.ALZ_SIM_TERRAFORM_SHA256.toLowerCase(), "the terraform binary is not the verified one");
    // The runner finds `terraform` by name in approved directories. /usr/bin and /bin stay approved, although no fixture runs a command any more (RB1).
    toolDir = fresh("tools");
    symlinkSync(binary, join(toolDir, "terraform"));
    engineVersion = (JSON.parse(execFileSync(binary, ["version", "-json"], { env: { PATH: "/usr/bin:/bin" }, encoding: "utf8" })) as { terraform_version: string }).terraform_version;

    emulator = await startEmulator(fresh("emulator"));
    const created = await emulator.s3("PUT", "/");
    assert.equal(created.status, 200, "the state bucket exists in the emulator: " + created.body);

    // The DEV contract names the fixture bucket and an obviously fake 12-digit account; QA and PROD are the fixture's other fakes.
    contractPath = join(fresh("contract"), "act-pilot-contract.json");
    writeReviewedContract(contractPath, withTerraformDataCanary(1));

    // TEST FIXTURE: the qualification attestation is forged here because no person can attest an emulator run. It records the REAL
    // binary hash and version. It is not evidence of identity separation and must never be copied into production code.
    vault = fresh("qualification");
    const attested = (adapterVersion: string, argvDigest: string) => ({
      schemaVersion: 1 as const, engine: "TERRAFORM" as const, realEngine: true as const, backendIdentitySeparated: true as const,
      accountId: AWS_DEV_TARGET.account, region: AWS_REGION, backend: AWS_DEV_TARGET.backend, workspace: "default",
      stateWriteClientId: awsRoleArn("STATE_WRITE", "DEV"), applyClientId: awsRoleArn("APPLY", "DEV"), terraformSha256: binarySha,
      adapterVersion, argvDigest, engineVersion, qualifiedAt: "2026-10-11T00:00:00.000Z",
    });
    for (const [version, digest] of [[APPLY_ADAPTER.adapterVersion, APPLY_ADAPTER.argvDigest], [ADAPTER_VERSION, terraformArgvDigest("TERRAFORM")]]) {
      const written = await writeQualificationEvidence(attested(version, digest), AWS, vault);
      assert.ok(written.ok, JSON.stringify(written));
    }

    evidence = fresh("evidence"); nonces = fresh("nonces"); scratch = fresh("scratch");
    // Each identity's web identity token file must exist (the SDK reads it for STS) and differ in path (the collapse check compares paths).
    env = { ...awsIdentityEnv("DEV" satisfies ApplyEnvironment) };
    const tokens = fresh("tokens");
    for (const identity of ["DISCOVERY", "STATE", "STATE_WRITE", "APPLY"]) {
      const tokenFile = join(tokens, identity.toLowerCase() + "-token");
      writeFileSync(tokenFile, TOKEN_CANARY + "\n", { mode: 0o600 });
      env["ALZ_" + identity + "_AWS_WEB_IDENTITY_TOKEN_FILE"] = tokenFile;
    }
    // Network settings reach the child only as ALZ_NETWORK_*: the proxy sends the two AWS hostnames to loopback; the CA is the emulator's own.
    env.ALZ_NETWORK_HTTPS_PROXY = emulator.proxyUrl;
    env.ALZ_NETWORK_SSL_CERT_FILE = emulator.caFile;
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

  const LOCK = "# This file is maintained automatically by \"terraform init\".\n# The pilot fixture locks nothing: it uses only the built-in terraform_data type.\n";
  /** The pinned project: an s3 backend with the contract's location (the product override replaces it; `backendLocation` supplies the same settings) and one built-in resource. No credential anywhere in it. */
  function project(input: string, extra = "") {
    const projectRoot = fresh("project");
    writeFileSync(join(projectRoot, "main.tf"), [
      "terraform {",
      '  backend "s3" {',
      `    bucket       = "${BUCKET}"`,
      `    key          = "${STATE_KEY}"`,
      `    region       = "${AWS_REGION}"`,
      "    use_lockfile = true",
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
      engine: "TERRAFORM", mode: "PROJECT", target: AWS_DEV_TARGET, unitHash: "1".repeat(64), files: captureProjectFiles(projectRoot), policyVersion: POLICY, ...resolved,
    });
    return { projectRoot, manifest, resolved };
  }

  /**
   * Owner decision E1: a canary run only creates, so every scenario starts from an empty workspace, as the owner's cleanup of the previous
   * canary would leave it: what an earlier scenario applied is cleared from the state object (lineage kept, serial moved). The object stays.
   */
  async function emptyWorkspace(): Promise<void> {
    const got = await emulator.s3("GET", "/" + STATE_KEY);
    if (got.status !== 200) return;
    const state = JSON.parse(got.body) as { serial: number; resources: unknown[] };
    if (state.resources.length === 0) return;
    const put = await emulator.s3("PUT", "/" + STATE_KEY, { "content-type": "application/json" }, JSON.stringify({ ...state, serial: state.serial + 1, resources: [], outputs: {} }));
    assert.equal(put.status, 200, "the emptied state was written: " + put.body);
  }

  async function seal(input: string, extra = "", created = 1) {
    await emptyWorkspace();
    const p = project(input, extra);
    writeReviewedContract(contractPath, withTerraformDataCanary(created));
    const result = await sealPreview({
      invocation: human(AWS_DEV_TARGET), environment: "DEV", target: AWS_DEV_TARGET, manifest: p.manifest, projectRoot: p.projectRoot,
      policyVersion: POLICY, resolved: p.resolved, requester: REQUESTER,
    }, deps);
    assert.ok(result.ok, JSON.stringify(result));
    const loaded = await loadSealedPlan(result.path);
    assert.ok(loaded.ok);
    return { sealed: result.sealed, project: p, loaded: { sealed: loaded.sealed, planBytes: loaded.planBytes } };
  }
  type Sealed = Awaited<ReturnType<typeof seal>>;
  const requestFor = (s: Sealed, approvals: SignedApproval[]): ApplyRequest => ({
    invocation: human(AWS_DEV_TARGET), environment: "DEV", target: { ...AWS_DEV_TARGET }, sealedPlan: s.loaded,
    manifest: s.project.manifest, projectRoot: s.project.projectRoot, approvals,
  });
  const run = (s: Sealed, who: "alice" | "bob" | "carol" = "alice"): Promise<ApplyResult> =>
    runApply(requestFor(s, [approvalFor(s.sealed, who)]), deps);
  const ledgerOf = (s: Sealed): string => join(evidence, s.sealed.artifactSha256 + ".apply.evidence");
  const stored = (s: Sealed) => readEncryptedEvidence<ApplyEvidence>(ledgerOf(s));
  const stateObject = async (): Promise<{ serial: number; inputs: unknown[] }> => {
    const response = await emulator.s3("GET", "/" + STATE_KEY);
    assert.equal(response.status, 200, response.body);
    const state = JSON.parse(response.body) as { serial: number; resources: { type: string; instances: { attributes: { input: unknown } }[] }[] };
    return { serial: state.serial, inputs: state.resources.filter((r) => r.type === "terraform_data").flatMap((r) => r.instances.map((i) => (i.attributes.input as { value: unknown } | null)?.value)) };
  };
  /** The native lock is the object `<key>.tflock`: present while an operation holds it, absent once released. */
  const lockHeld = async (): Promise<boolean> => {
    // Out of process: the kill test polls while the driver runs (see `headOutOfProcess`).
    const status = await emulator.headOutOfProcess("/" + LOCK_KEY);
    assert.ok(status === 200 || status === 404, "lock object status " + status);
    return status === 200;
  };
  const noSecrets = (value: unknown): void => {
    const text = JSON.stringify(value);
    // The dummy token, and the operator's own ambient keys from the fixture environment, which never reach a child.
    for (const secret of [TOKEN_CANARY, "operator-ambient-aws-secret", "AKIAFAKEOPERATORKEY00"]) assert.ok(!text.includes(secret), "output carries " + secret.slice(0, 8));
  };

  // --- the path, against the real engine ------------------------------------------------------------

  it("seals with the real engine, the review bundle verifies, and the plan is the real show -json shape", async () => {
    const s = await seal("first");
    assert.deepEqual(s.sealed.changes.map((c) => [c.address, c.type, c.action]), [["terraform_data.pilot", "terraform_data", "CREATE"]]);
    // A built-in resource has no tag attribute: the deletion unit lists it as untagged rather than refusing the seal.
    assert.deepEqual(s.sealed.unit?.untagged, ["terraform_data.pilot"]);
    const bundle = verifyReviewBundle(JSON.parse(JSON.stringify(reviewBundleOf(s.sealed))));
    assert.ok(bundle.ok);
    // The engine's plan file is a zip; the sealed bytes are exactly what terraform wrote.
    assert.equal(s.loaded.planBytes.subarray(0, 2).toString("latin1"), "PK");
    noSecrets(s.sealed);
  });

  it("applies a sealed plan end to end: state lands in the emulator, the lock is released, evidence and ledger are written, nothing leaks", async () => {
    const s = await seal("first");
    const result = await run(s);
    assert.ok(result.ok, JSON.stringify(result));
    noSecrets(result);
    const landed = await stateObject();
    assert.deepEqual(landed.inputs, ["first"]);
    assert.ok(landed.serial >= 1);
    assert.equal(await lockHeld(), false, "the native lock file is released");
    const record = await stored(s);
    assert.equal(record.outcome, "SUCCEEDED");
    assert.equal(record.exitCode, 0);
    assert.equal(record.toolVersions.engine, engineVersion);
    noSecrets(record);
    const contacted = emulator.connects();
    assert.ok(contacted.includes(BUCKET_HOST + ":443") && contacted.includes(STS_HOST + ":443"), "state and credentials went through the emulated hosts: " + contacted.join(" "));
    // Terraform's own version check (checkpoint-api.hashicorp.com) is attempted on every run; the proxy refuses it. Nothing else is reachable.
    assert.deepEqual(contacted.filter((c) => !EMULATED_HOSTS.includes(c) && c !== VERSION_CHECK_HOST), [], "no host other than the emulator was ever contacted");
  });

  it("binds STATE_WRITE (owner decision 6486426552): every state and lock request of the apply is STATE_WRITE's, APPLY never reaches the bucket, a renewed token file is used without resealing, and the plan holds only identity references, no token", async () => {
    // Each identity's token file holds its own dummy value (all carry the canary, so nothing may ever print one), and the
    // web identity role each assumes is told apart from moto's own record of the credentials it issued.
    const tokenFile = (identity: string): string => env["ALZ_" + identity + "_AWS_WEB_IDENTITY_TOKEN_FILE"] as string;
    const token = (identity: string, version: number): string => TOKEN_CANARY + "-" + identity.toLowerCase() + "-v" + version;
    for (const identity of ["DISCOVERY", "STATE", "STATE_WRITE", "APPLY"]) writeFileSync(tokenFile(identity), token(identity, 1) + "\n", { mode: 0o600 });
    try {
      const s = await seal("state-write-bound");
      // The decrypted plan: every file of Terraform's plan archive is read. It names STATE_WRITE's role and token FILE, never a token, never APPLY's.
      const files = zipEntries(s.loaded.planBytes);
      const plan = Buffer.concat([...files.values()]).toString("latin1");
      assert.ok(plan.includes(awsRoleArn("STATE_WRITE", "DEV")), "the plan's backend names STATE_WRITE's role");
      assert.ok(plan.includes(tokenFile("STATE_WRITE")), "and STATE_WRITE's token file path, a reference");
      assert.ok(!plan.includes(awsRoleArn("APPLY", "DEV")) && !plan.includes(tokenFile("APPLY")), "nothing of APPLY's");
      for (const identity of ["DISCOVERY", "STATE", "STATE_WRITE", "APPLY"]) {
        for (const version of [1, 2]) assert.ok(!plan.includes(token(identity, version)), "no token value in the plan: " + identity);
      }
      assert.ok(!plan.includes(TOKEN_CANARY) && !s.loaded.planBytes.includes(TOKEN_CANARY), "no token at all, compressed or not");
      // Renewal: the token files are rewritten after the seal, as a delivery would refresh them. The sealed plan is unchanged.
      for (const identity of ["STATE_WRITE", "APPLY"]) writeFileSync(tokenFile(identity), token(identity, 2) + "\n", { mode: 0o600 });
      await emulator.api("POST", "/moto-api/recorder/clear-recording");
      await emulator.api("POST", "/moto-api/recorder/start-recording");
      const result = await run(s);
      await emulator.api("POST", "/moto-api/recorder/stop-recording");
      assert.ok(result.ok, JSON.stringify(result));
      noSecrets(result);
      type Recorded = { method: string; url: string; headers: Record<string, string>; body?: string; body_encoded?: boolean };
      const recorded = (await emulator.api("GET", "/moto-api/recorder/download-recording")).split("\n").filter(Boolean).map((line) => JSON.parse(line) as Recorded);
      const issued = (JSON.parse(await emulator.api("GET", "/moto-api/data.json")) as { sts?: { AssumedRole?: { access_key_id: string; role_arn: string }[] } }).sts?.AssumedRole ?? [];
      const roleOf = (request: Recorded): string | undefined => {
        const key = /Credential=([A-Z0-9]+)\//.exec(request.headers.Authorization ?? request.headers.authorization ?? "")?.[1];
        return issued.find((x) => x.access_key_id === key)?.role_arn;
      };
      const header = (request: Recorded, name: string): string => request.headers[name] ?? request.headers[name.toLowerCase()] ?? "";
      const bucket = recorded.filter((r) => header(r, "Host").startsWith(BUCKET_HOST));
      assert.ok(bucket.length > 0, "the apply reached the state bucket");
      const roles = new Set(bucket.map(roleOf));
      assert.ok(!roles.has(undefined), "every bucket request was signed with credentials moto issued to a web identity role");
      assert.ok(!roles.has(awsRoleArn("APPLY", "DEV")), "APPLY never reached the state bucket: " + JSON.stringify([...roles]));
      assert.ok([...roles].every((role) => role === awsRoleArn("STATE_WRITE", "DEV") || role === awsRoleArn("STATE", "DEV")), "only STATE_WRITE, and STATE's read: " + JSON.stringify([...roles]));
      const keyOf = (request: Recorded): string => new URL(request.url, "https://" + BUCKET_HOST).pathname.slice(1);
      const writes = bucket.filter((r) => r.method !== "GET" && r.method !== "HEAD");
      const lockOps = bucket.filter((r) => keyOf(r) === LOCK_KEY);
      assert.ok(writes.some((r) => keyOf(r) === STATE_KEY) && lockOps.some((r) => r.method === "PUT") && lockOps.some((r) => r.method === "DELETE"), "the apply wrote the state and took and released the lock: " + JSON.stringify(writes.map((r) => [r.method, keyOf(r)])));
      assert.ok([...writes, ...lockOps].every((r) => roleOf(r) === awsRoleArn("STATE_WRITE", "DEV")), "every state write and every lock operation is STATE_WRITE's");
      // The STATE_WRITE role was assumed with the renewed token, never the one current at seal time.
      const assumes = recorded.filter((r) => header(r, "Host").startsWith(STS_HOST)).map((r) => new URLSearchParams(r.body_encoded === true ? Buffer.from(r.body ?? "", "base64").toString("utf8") : r.body ?? ""))
        .filter((form) => form.get("Action") === "AssumeRoleWithWebIdentity");
      const stateWrite = assumes.filter((form) => form.get("RoleArn") === awsRoleArn("STATE_WRITE", "DEV"));
      assert.ok(stateWrite.length > 0 && stateWrite.every((form) => (form.get("WebIdentityToken") ?? "").trim() === token("STATE_WRITE", 2)), "STATE_WRITE assumed its role with the renewed token");
      assert.ok(!assumes.some((form) => (form.get("WebIdentityToken") ?? "").trim().endsWith("-v1")), "no request used a token from before the renewal");
      assert.deepEqual((await stateObject()).inputs, ["state-write-bound"]);
    } finally {
      for (const identity of ["DISCOVERY", "STATE", "STATE_WRITE", "APPLY"]) writeFileSync(tokenFile(identity), TOKEN_CANARY + "\n", { mode: 0o600 });
    }
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
    const before = await stateObject();
    const result = await run(older, "bob");
    assert.equal(result.ok, false);
    assert.equal((result as { code: string }).code, "PLAN_STALE", JSON.stringify(result));
    assert.equal((await stored(older)).outcome, "FAILED_NO_CHANGE");
    noSecrets(result);
    assert.deepEqual(await stateObject(), before);
    assert.deepEqual(before.inputs, ["stale-newer"]);
    assert.equal(await lockHeld(), false, "a refused apply leaves no lock behind");
  });

  it("classifies a held native lock as FAILED_NO_CHANGE and leaves the other holder's lock alone", async () => {
    const s = await seal("lock-held");
    // Another operation's lock, written the way Terraform writes it (a lock-info document, created only if absent).
    const other = JSON.stringify({ ID: "11111111-2222-4333-8444-555555555555", Operation: "OperationTypeApply", Info: "", Who: "other-operator@elsewhere", Version: engineVersion, Created: NOW.toISOString(), Path: BUCKET + "/" + STATE_KEY });
    const taken = await emulator.s3("PUT", "/" + LOCK_KEY, { "if-none-match": "*", "content-type": "application/json" }, other);
    assert.equal(taken.status, 200, taken.body);
    try {
      const before = await stateObject();
      const result = await run(s);
      assert.equal(result.ok, false);
      assert.equal((result as { outcome?: string }).outcome, "FAILED_NO_CHANGE", JSON.stringify(result));
      assert.deepEqual(await stateObject(), before);
      const still = await emulator.s3("GET", "/" + LOCK_KEY);
      assert.equal(still.status, 200, "the other holder's lock is untouched");
      assert.equal(still.body, other, "the other holder's lock document is unchanged");
    } finally {
      const released = await emulator.s3("DELETE", "/" + LOCK_KEY);
      assert.equal(released.status, 204);
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

  it("stops a running apply when the kill switch appears: Terraform is interrupted, the lock is released, the outcome is KILLED", async () => {
    // Provisioner-free (RB1: the judge refuses every provisioner). A wide count of built-in values keeps the real apply busy for
    // seconds; only the apply takes the native lock, so once it is held the apply is running. The switch usually appears before
    // Terraform's apply walk starts, where Terraform would drop a SIGINT; the driver holds its stop until the walk runs
    // (TERRAFORM_WALK_STARTED in src/apply/engines/terraform.ts), so the stop lands part-way.
    const s = await seal("kill-during", `resource "terraform_data" "slow" {\n  count = ${SLOW_COUNT}\n  input = count.index\n}`, 1 + SLOW_COUNT);
    assert.equal(s.sealed.changes.length, SLOW_COUNT + 1, "the pilot value and every slow one are in the sealed change list");
    const before = await stateObject();
    let settled: ApplyResult | undefined;
    const running = run(s).then((r) => (settled = r));
    for (let waited = 0; !(await lockHeld()); waited += 100) {
      if (settled || waited > 60_000) throw new Error("the apply never took the native lock: " + JSON.stringify(settled));
      await sleep(100);
    }
    assert.equal(await lockHeld(), true, "Terraform holds the native lock while it applies");
    writeFileSync(KILL, "stop");
    try {
      const result = await running;
      assert.equal(result.ok, false);
      assert.equal((result as { outcome?: string }).outcome, "KILLED", JSON.stringify(result));
      assert.equal((await stored(s)).outcome, "KILLED");
      noSecrets(result);
    } finally { rmSync(KILL, { force: true }); }
    assert.equal(await lockHeld(), false, "a graceful interrupt releases the lock");
    const after = await stateObject();
    assert.ok(after.serial > before.serial, "the interrupted resources were recorded in state");
    assert.ok(after.inputs.length < before.inputs.length + SLOW_COUNT + 1, "interrupted part-way: not every planned value was created");
  });
});
