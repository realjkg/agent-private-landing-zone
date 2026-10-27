import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";

import { assertNoBackendOverrideOrState, writeBackendOverride } from "../src/apply/backend-pin.js";
import { codeOf } from "../src/apply/engine.js";
import { AWS } from "../src/apply/providers/aws.js";
import { APPLY_BACKEND_CONFIG_FILE, APPLY_INIT_ARGV } from "../src/apply/terraform.js";

/**
 * OPT-IN, SYNTHETIC (docs/act-pilot-backend-pinning.md). Skipped unless ALZ_SIM_TERRAFORM points at the pinned Terraform
 * binary, so default CI is unaffected. It runs the product's backend pin (the name refusals and the override file from
 * src/apply/backend-pin.ts, the AWS spec's backend location and the pilot's own init argument list) against REAL
 * `terraform init` for the proof harness cases in test/fixtures/backend-pin/cases.json, including the reviewer's exact
 * reproduction (PR #287 comment 6436660507).
 *
 * Two loopback listeners: one stands in for the user's backend (every `__USER_LISTENER__` in a case) and must see zero
 * connections; the other is a minimal S3 stand-in for the product's backend, reached only through TEST-ONLY settings
 * (endpoint, path style, fake static keys) appended to the backend file. The product never writes those settings. No
 * registry, cloud or other host is contacted: the CLI configuration names an empty provider mirror.
 *
 * DEV MODE ONLY (never an operator step): ALZ_SIM_TERRAFORM=<terraform 1.16.4> npx tsx --test test/apply-backend-pin-real.test.ts
 */
const TERRAFORM = process.env.ALZ_SIM_TERRAFORM;
const SKIP = TERRAFORM ? false : "set ALZ_SIM_TERRAFORM to the pinned Terraform binary to run the real-engine backend pin proof";

type Case = { expect: string; files: Record<string, string> };
const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "backend-pin", "cases.json");
const CASES = (JSON.parse(readFileSync(FIXTURES, "utf8")) as { cases: Record<string, Case> }).cases;
const TARGET = { accountId: "111111111111", region: "us-east-1", backend: "alz-state-dev/pilot/dev.tfstate", workspace: "default" };

const listen = (server: net.Server): Promise<number> => new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as net.AddressInfo).port)));

describe("the backend pin against real Terraform init (SYNTHETIC, loopback only)", { skip: SKIP }, () => {
  let userContacts = 0;
  let oursContacts = 0;
  let userPort = 0;
  let oursPort = 0;
  const user = net.createServer((socket) => { userContacts++; socket.destroy(); });
  // Answers the S3 calls init makes: an empty bucket listing, no state object, and accepted writes.
  const ours = http.createServer((request, response) => {
    oursContacts++;
    request.resume();
    const listing = request.method === "GET" && /[?&]list-type=/.test(request.url ?? "");
    const body = listing
      ? '<?xml version="1.0" encoding="UTF-8"?><ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Name>alz-state-dev</Name><KeyCount>0</KeyCount><MaxKeys>1000</MaxKeys><IsTruncated>false</IsTruncated></ListBucketResult>'
      : request.method === "GET" ? '<?xml version="1.0" encoding="UTF-8"?><Error><Code>NoSuchKey</Code><Message>x</Message></Error>' : "";
    const status = listing || request.method === "PUT" ? 200 : request.method === "DELETE" ? 204 : 404;
    response.writeHead(status, { "Content-Type": "application/xml", "Content-Length": Buffer.byteLength(body), ...(status === 200 ? { ETag: '"d41d8cd98f00b204e9800998ecf8427e"' } : {}) });
    response.end(request.method === "HEAD" ? undefined : body);
  });
  const root = mkdtempSync(join(tmpdir(), "alz-backend-pin-real-"));
  const results: Record<string, unknown>[] = [];

  before(async () => {
    userPort = await listen(user);
    oursPort = await listen(ours);
    mkdirSync(join(root, "empty-mirror"));
    writeFileSync(join(root, "empty.tfrc"), `provider_installation {\n  filesystem_mirror {\n    path = "${join(root, "empty-mirror")}"\n  }\n}\n`);
  });
  after(() => {
    user.close();
    ours.close();
    rmSync(root, { recursive: true, force: true });
    if (process.env.ALZ_SIM_RESULTS) writeFileSync(process.env.ALZ_SIM_RESULTS, results.map((r) => JSON.stringify(r)).join("\n") + "\n");
  });

  const init = (cwd: string, home: string): Promise<number> => new Promise((resolve) => {
    execFile(TERRAFORM!, [...APPLY_INIT_ARGV], {
      cwd, timeout: 120_000,
      env: { HOME: home, PATH: "/usr/bin:/bin", CHECKPOINT_DISABLE: "1", TF_IN_AUTOMATION: "1", TF_DATA_DIR: ".terraform", TF_CLI_CONFIG_FILE: join(root, "empty.tfrc") },
    }, (error) => resolve(error ? (typeof error.code === "number" ? error.code : -1) : 0));
  });

  for (const [name, spec] of Object.entries(CASES)) {
    it(name + " (" + spec.expect + ")", async () => {
      const work = join(root, name);
      const project = join(work, "p");
      mkdirSync(join(work, "home"), { recursive: true });
      for (const [path, content] of Object.entries(spec.files)) {
        mkdirSync(dirname(join(project, path)), { recursive: true });
        writeFileSync(join(project, path), content.replaceAll("__USER_LISTENER__", "127.0.0.1:" + userPort));
      }
      let refusal = "";
      try { assertNoBackendOverrideOrState(project); } catch (error) { refusal = codeOf(error); }
      if (spec.expect.startsWith("refused:")) {
        assert.equal(refusal, spec.expect.slice("refused:".length));
        results.push({ case: name, refused: refusal, init: "not run" });
        return;
      }
      assert.equal(refusal, "");
      writeBackendOverride(project, AWS.backendType);
      // The product's location settings, then TEST-ONLY settings that reach the loopback S3 stand-in.
      writeFileSync(join(work, APPLY_BACKEND_CONFIG_FILE), AWS.backendLocation(TARGET as never) + [
        `endpoints = { s3 = "http://127.0.0.1:${oursPort}" }`, "use_path_style = true", 'access_key = "AKIAFAKEFAKEFAKE"', 'secret_key = "fake"',
        "skip_credentials_validation = true", "skip_requesting_account_id = true", "skip_metadata_api_check = true", "",
      ].join("\n"));
      const userBefore = userContacts;
      const oursBefore = oursContacts;
      const exit = await init(project, join(work, "home"));
      const savedFile = join(project, ".terraform", "terraform.tfstate");
      const saved = existsSync(savedFile) ? (JSON.parse(readFileSync(savedFile, "utf8")) as { backend?: Record<string, unknown> }).backend : undefined;
      const record = { case: name, exit, userContacts: userContacts - userBefore, oursContacts: oursContacts - oursBefore, savedType: saved?.type ?? null, savedMatches: saved ? AWS.savedBackendMatches(saved, TARGET as never, {}) : null };
      results.push(record);
      assert.equal(record.userContacts, 0, "the user's backend is never contacted");
      if (saved) {
        assert.equal(saved.type, "s3", "only the pinned type is ever saved");
        assert.equal(record.savedMatches, true, "the saved backend is the contract's (the product's post-init check)");
      }
      // Init's exit code is the product's verdict (any non-zero stops the run); the positive control must succeed.
      if (name === "n-ok-s3") assert.equal(exit, 0);
    });
  }
});
