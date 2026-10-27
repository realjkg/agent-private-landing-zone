import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { inflateRawSync } from "node:zlib";

import { BACKEND_OVERRIDE_FILE, backendOverride } from "../src/apply/backend-pin.js";
import type { PilotTarget } from "../src/apply/types.js";
import { GCP, type GcpTarget } from "../src/apply/providers/gcp.js";
import { classifyApply } from "../src/apply/terraform.js";

/**
 * OPT-IN SIMULATION (docs/act-pilot-simulation-gcp.md, "S6a"), the GCP Terraform step toward gate G1b. Skipped unless BOTH
 * ALZ_SIM_TERRAFORM (a real Terraform 1.x binary) and ALZ_SIM_FAKE_GCS (the fake-gcs-server executable, built as the G-7 spike
 * describes) are set, so default CI is unaffected.
 *
 * It runs the REAL Terraform engine against an EMULATED Cloud Storage backend (fake-gcs-server on loopback) with the provider
 * spec's own functions (src/apply/providers/gcp.ts): the product's backend override file, `backendLocation` and the STATE_WRITE
 * `backendConfig` as the seal writes them, `savedBackendMatches` on what init really saved, and the product's `classifyApply` on
 * the engine's real lock and stale-plan errors. Built-in `terraform_data` resources only: no google provider, no registry, no
 * Google project, account or token. Every proxy variable points at a closed local port, so any attempt to reach Google fails
 * locally.
 *
 * NOT THROUGH THE DRIVER YET. GCP is not an admitted provider (the authorization lane adds it to the contract, `SPECS` and
 * `BackendType`), so seal, approve, apply, ledger and kill switch cannot run a GCP contract. That journey (S6b) follows admission,
 * in the shape of test/apply-emulated.test.ts. `STORAGE_EMULATOR_HOST` is set here, in the engine children this test starts, and
 * nowhere a product path can reach (owner decision 6432984515, the Azurite precedent); the spec refuses it by name (P2).
 *
 * What this does NOT exercise (the emulator skips authentication, spike finding G3): workload identity federation, service
 * account impersonation, IAM, or which principal writes state. Those are G2 questions.
 *
 * DEV MODE ONLY setup (never an operator step; operators use ./alz): build fake-gcs-server v1.53.1 as
 * docs/act-pilot-simulation-gcp.md, "How to repeat it", step 1, then
 *   ALZ_SIM_TERRAFORM=<verified terraform> ALZ_SIM_FAKE_GCS=<dl>/bin/fake-gcs-server npx tsx --test test/apply-emulated-gcp.test.ts
 */
const TERRAFORM = process.env.ALZ_SIM_TERRAFORM;
const FAKE_GCS = process.env.ALZ_SIM_FAKE_GCS;
const SKIP = !TERRAFORM || !FAKE_GCS ? "set ALZ_SIM_TERRAFORM and ALZ_SIM_FAKE_GCS to run the GCP emulated-backend simulation (docs/act-pilot-simulation-gcp.md)" : false;

const TARGET: GcpTarget = { projectId: "alz-sim-dev", region: "europe-west4", backend: "alz-sim-dev-state/pilot/dev", workspace: "default" };
const [BUCKET, ...PREFIX_PARTS] = TARGET.backend.split("/");
const PREFIX = PREFIX_PARTS.join("/");
const STATE_WRITE_SA = "alz-sim-dev-state-write@alz-sim-dev.iam.gserviceaccount.com";
const TOKEN_CANARY = "SIM-NOT-A-TOKEN-CANARY-0001";
const target = TARGET as unknown as PilotTarget;

/** One entry of a plan file (a zip), by its central directory record; stored or deflated, the only methods Terraform writes. */
function zipEntry(zip: Buffer, name: string): Buffer {
  const end = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.ok(end >= 0, "a zip file");
  let at = zip.readUInt32LE(end + 16);
  for (let i = 0; i < zip.readUInt16LE(end + 10); i += 1) {
    const nameLength = zip.readUInt16LE(at + 28);
    const next = at + 46 + nameLength + zip.readUInt16LE(at + 30) + zip.readUInt16LE(at + 32);
    if (zip.toString("utf8", at + 46, at + 46 + nameLength) === name) {
      const local = zip.readUInt32LE(at + 42);
      const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
      const data = zip.subarray(start, start + zip.readUInt32LE(at + 20));
      return zip.readUInt16LE(at + 10) === 0 ? data : inflateRawSync(data);
    }
    at = next;
  }
  return assert.fail("no " + name + " in the plan file");
}

const freePort = (): Promise<number> => new Promise((resolve, reject) => {
  const server = net.createServer();
  server.listen(0, "127.0.0.1", () => { const { port } = server.address() as net.AddressInfo; server.close(() => resolve(port)); });
  server.on("error", reject);
});

describe("GCP Terraform against an emulated Cloud Storage backend (SYNTHETIC, opt-in)", { skip: SKIP }, () => {
  let root = "";
  let port = 0;
  let emulator: ReturnType<typeof spawn> | undefined;
  let engineEnv: NodeJS.ProcessEnv = {};
  let stateWriteEnv: NodeJS.ProcessEnv = {};

  const storage = async (method: string, path: string, body?: string): Promise<{ status: number; text: string }> => {
    const response = await fetch("http://127.0.0.1:" + port + path, { method, body, headers: body ? { "content-type": "application/json" } : {} });
    return { status: response.status, text: await response.text() };
  };
  const objects = async (): Promise<string[]> => {
    const listed = JSON.parse((await storage("GET", "/storage/v1/b/" + BUCKET + "/o")).text) as { items?: { name: string }[] };
    return (listed.items ?? []).map((item) => item.name).sort();
  };
  const serial = async (): Promise<string> => {
    const state = await storage("GET", "/storage/v1/b/" + BUCKET + "/o/" + encodeURIComponent(PREFIX + "/default.tfstate") + "?alt=media");
    return state.status === 200 ? String((JSON.parse(state.text) as { serial: number }).serial) : "none";
  };
  const terraform = (cwd: string, args: string[]) => {
    const run = spawnSync(TERRAFORM!, [...args, "-no-color"], { cwd, env: engineEnv, encoding: "utf8", timeout: 120_000 });
    return { code: run.status, stdout: run.stdout, stderr: run.stderr };
  };
  /** A project whose own backend block names another bucket and a custom endpoint: the product override must replace both. */
  const project = (name: string, resources: string): string => {
    const dir = join(root, name);
    mkdirSync(dir);
    writeFileSync(join(dir, "main.tf"), [
      "terraform {", '  backend "gcs" {', '    bucket                  = "someone-elses-bucket"', '    storage_custom_endpoint = "http://127.0.0.1:9/storage/v1/"', "  }", "}", resources, "",
    ].join("\n"));
    // The override the pin writes: today's s3 override with the gcs type, until BackendType admits "gcs" (#297).
    writeFileSync(join(dir, BACKEND_OVERRIDE_FILE), backendOverride("s3").replace('"s3"', '"gcs"'));
    return dir;
  };
  const savedBackend = (dir: string): Record<string, unknown> =>
    (JSON.parse(readFileSync(join(dir, ".terraform", "terraform.tfstate"), "utf8")) as { backend: Record<string, unknown> }).backend;

  before(async () => {
    root = mkdtempSync(join(tmpdir(), "alz-gcp-emulated-"));
    port = await freePort();
    emulator = spawn(FAKE_GCS!, ["-scheme", "http", "-host", "127.0.0.1", "-port", String(port), "-backend", "memory", "-public-host", "127.0.0.1:" + port, "-external-url", "http://127.0.0.1:" + port], { stdio: "ignore" });
    for (let i = 0; i < 100; i += 1) {
      try { if ((await storage("GET", "/storage/v1/b")).status === 200) break; } catch { /* not up yet */ }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal((await storage("POST", "/storage/v1/b?project=" + TARGET.projectId, JSON.stringify({ name: BUCKET, versioning: { enabled: true } }))).status, 200);
    const home = join(root, "home");
    mkdirSync(home);
    engineEnv = {
      PATH: "/usr/bin:/bin", HOME: home, CHECKPOINT_DISABLE: "1", TF_IN_AUTOMATION: "1", HTTPS_PROXY: "http://127.0.0.1:9", HTTP_PROXY: "http://127.0.0.1:9",
      NO_PROXY: "127.0.0.1,localhost", STORAGE_EMULATOR_HOST: "http://127.0.0.1:" + port,
    };
    // STATE_WRITE's settings, as the seal renders them: a WIF credential configuration (a dummy token file) and the service account.
    const tokenFile = join(root, "state-write.jwt");
    writeFileSync(tokenFile, "dummy-not-a-token\n");
    const configuration = join(root, "state-write.json");
    writeFileSync(configuration, JSON.stringify({
      type: "external_account", audience: "//iam.googleapis.com/projects/123456789012/locations/global/workloadIdentityPools/alz-sim-dev/providers/oidc",
      subject_token_type: "urn:ietf:params:oauth:token-type:jwt", token_url: "https://sts.googleapis.com/v1/token", credential_source: { file: tokenFile },
    }));
    stateWriteEnv = { ALZ_STATE_WRITE_GOOGLE_APPLICATION_CREDENTIALS: configuration, ALZ_STATE_WRITE_GOOGLE_IMPERSONATE_SERVICE_ACCOUNT: STATE_WRITE_SA };
  });
  after(() => {
    emulator?.kill("SIGKILL");
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it("the pin replaces the project's backend; init saves exactly the spec's location and STATE_WRITE settings, and the spec accepts what it saved", () => {
    const dir = project("seal", 'resource "terraform_data" "unit" {\n  input = "one"\n}');
    writeFileSync(join(root, "seal.hcl"), GCP.backendConfig(stateWriteEnv, target));
    const init = terraform(dir, ["init", "-input=false", "-backend-config=" + join(root, "seal.hcl")]);
    assert.equal(init.code, 0, init.stderr);
    const saved = savedBackend(dir);
    assert.equal(GCP.savedBackendMatches(saved, target), true);
    const config = saved.config as Record<string, unknown>;
    assert.equal(config.bucket, BUCKET, "the project's own bucket did not survive the pin");
    assert.equal(config.storage_custom_endpoint, null, "nor its endpoint");
    assert.equal(config.impersonate_service_account, STATE_WRITE_SA);
    assert.equal(config.access_token, null);

    // A seal that does not embed STATE_WRITE saves the location only, and the spec accepts that too.
    const plain = project("plain", 'resource "terraform_data" "unit" {\n  input = "one"\n}');
    writeFileSync(join(root, "plain.hcl"), GCP.backendLocation(target));
    assert.equal(terraform(plain, ["init", "-input=false", "-backend-config=" + join(root, "plain.hcl")]).code, 0);
    assert.equal(GCP.savedBackendMatches(savedBackend(plain), target), true);
    assert.equal((savedBackend(plain).config as Record<string, unknown>).credentials, null);
  });

  it("an access token or a custom endpoint in the saved backend is refused by the spec on the engine's real saved shape (spike findings G1 and H)", () => {
    for (const [name, value] of [["access_token", TOKEN_CANARY], ["storage_custom_endpoint", "http://127.0.0.1:" + port + "/storage/v1/"]]) {
      const dir = project("refused-" + name, 'resource "terraform_data" "unit" {\n  input = "one"\n}');
      writeFileSync(join(dir, "extra.hcl"), GCP.backendLocation(target) + name + ' = "' + value + '"\n');
      assert.equal(terraform(dir, ["init", "-input=false", "-backend-config=extra.hcl"]).code, 0, name);
      assert.equal(GCP.savedBackendMatches(savedBackend(dir), target), false, name);
      if (name === "access_token") assert.ok(readFileSync(join(dir, ".terraform", "terraform.tfstate"), "utf8").includes(TOKEN_CANARY), "Terraform stores it in plaintext, which is why the spec refuses it");
    }
  });

  it("the plan embeds the backend and STATE_WRITE's settings but never the emulator; apply <planfile> writes <prefix>/default.tfstate and releases the lock", async () => {
    const dir = join(root, "seal");
    const plan = terraform(dir, ["plan", "-input=false", "-out=" + join(root, "unit.tfplan")]);
    assert.equal(plan.code, 0, plan.stderr);
    const bytes = zipEntry(readFileSync(join(root, "unit.tfplan")), "tfplan").toString("latin1");
    assert.ok(bytes.includes(BUCKET) && bytes.includes(PREFIX) && bytes.includes(STATE_WRITE_SA), "the plan carries the bucket, the prefix and STATE_WRITE's account (finding G3)");
    assert.equal(bytes.includes(String(port)), false, "the emulator address came from the environment and is not in the plan (finding F)");
    const apply = terraform(dir, ["apply", "-input=false", join(root, "unit.tfplan")]);
    assert.equal(apply.code, 0, apply.stderr);
    assert.deepEqual(await objects(), [PREFIX + "/default.tfstate"], "the state object, and no lock left behind");
    assert.equal(classifyApply({ exitCode: apply.code, stderr: apply.stderr, serialBefore: "none", serialAfter: await serial() }).outcome, "SUCCEEDED");
  });

  it("a held lock refuses another apply as FAILED_NO_CHANGE, and once released that plan is stale (the product's classifyApply on the engine's real errors)", async () => {
    const dir = project("lock", 'variable "hold" {\n  default = "0"\n}\nresource "terraform_data" "slow" {\n  input = var.hold\n  provisioner "local-exec" {\n    command = "sleep ${var.hold}"\n  }\n}');
    writeFileSync(join(dir, "loc.hcl"), GCP.backendLocation({ ...TARGET, backend: BUCKET + "/pilot/lock" } as unknown as PilotTarget));
    assert.equal(terraform(dir, ["init", "-input=false", "-backend-config=loc.hcl"]).code, 0);
    assert.equal(terraform(dir, ["plan", "-input=false", "-var=hold=6", "-out=held.tfplan"]).code, 0);
    assert.equal(terraform(dir, ["plan", "-input=false", "-var=hold=1", "-out=other.tfplan"]).code, 0);
    const holder = spawn(TERRAFORM!, ["apply", "-input=false", "-no-color", "held.tfplan"], { cwd: dir, env: engineEnv, stdio: "ignore" });
    const held = new Promise<number | null>((resolve) => holder.on("exit", resolve));
    for (let i = 0; i < 100 && !(await objects()).includes("pilot/lock/default.tflock"); i += 1) await new Promise((resolve) => setTimeout(resolve, 100));
    assert.ok((await objects()).includes("pilot/lock/default.tflock"), "the native lock object is held during the apply");

    const blocked = terraform(dir, ["apply", "-input=false", "other.tfplan"]);
    assert.notEqual(blocked.code, 0);
    assert.deepEqual(classifyApply({ exitCode: blocked.code, stderr: blocked.stderr, serialBefore: "1", serialAfter: "1" }), { outcome: "FAILED_NO_CHANGE" });
    assert.equal(await held, 0, "the holder finishes");
    assert.equal((await objects()).includes("pilot/lock/default.tflock"), false, "and releases the lock");

    const stale = terraform(dir, ["apply", "-input=false", "other.tfplan"]);
    assert.notEqual(stale.code, 0);
    assert.deepEqual(classifyApply({ exitCode: stale.code, stderr: stale.stderr, serialBefore: "1", serialAfter: "1" }), { stale: true });
    assert.equal(existsSync(join(dir, "errored.tfstate")), false);
  });
});
