import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { DELIVERY_PATHS, checkDeliveredTokens, deliveryEnvironment, identityDeliveryEvidence, type DeliveryPathId } from "../src/apply/token-delivery.js";
import type { ExecutionIdentity } from "../src/tools/identity.js";
import { GCP_CONFIG_AUDIENCE, REPO, RUN_ID, deliveryClaims, fakeJwt } from "./helpers/token-delivery-fixtures.js";

// .github/workflows/act-identity-delivery.yml (docs/act-pilot-identity-delivery.md). The static half proves the workflow cannot
// be started by untrusted code and holds the least authority; the executable half runs the workflow's own scripts against a
// local fake token service on 127.0.0.1 (SYNTHETIC: no GitHub, no cloud, unsigned look-alike tokens).

const FILE = ".github/workflows/act-identity-delivery.yml";
const workflow = readFileSync(FILE, "utf8");
const code = workflow.split("\n").filter((line) => !/^\s*#/.test(line)).join("\n");

/** A top-level block (`on:`, `jobs:`) or a job's block, by its exact header line and indentation. */
function block(header: string, indent: number): string {
  const lines = workflow.split("\n");
  const start = lines.findIndex((line) => line === " ".repeat(indent) + header);
  assert.ok(start >= 0, header);
  const body: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() !== "" && !line.startsWith(" ".repeat(indent + 1))) break;
    body.push(line);
  }
  return body.join("\n");
}
const job = (name: string): string => block(name + ":", 2);

/** The `run: |` script of the step with this name, as the runner would write it to a file. */
function stepScript(name: string): string {
  const lines = workflow.split("\n");
  const at = lines.findIndex((line) => line.trim() === "- name: " + name);
  assert.ok(at >= 0, name);
  const run = lines.findIndex((line, index) => index > at && line.trim() === "run: |");
  const indent = lines[run].indexOf("run:") + 2;
  const script: string[] = [];
  for (const line of lines.slice(run + 1)) {
    if (line.trim() !== "" && !line.startsWith(" ".repeat(indent))) break;
    script.push(line.slice(indent));
  }
  return script.join("\n");
}

// --- static: who can start it, where it runs and what it may do ----------------------------------------------------------

test("only a person can start it: workflow_dispatch and no other trigger", () => {
  const on = block("on:", 0);
  const triggers = on.split("\n").filter((line) => /^ {2}[a-z_]+:/.test(line)).map((line) => line.trim().replace(/:.*/, ""));
  assert.deepEqual(triggers, ["workflow_dispatch"]);
  for (const trigger of ["pull_request", "pull_request_target", "push", "schedule", "issue_comment", "workflow_run", "workflow_call", "repository_dispatch", "merge_group", "release", "issues", "discussion"]) {
    assert.doesNotMatch(code, new RegExp("^\\s*" + trigger + ":", "m"), trigger);
  }
  // The dispatch offers exactly the six paths and bounded holds.
  const options = on.slice(on.indexOf("path:"), on.indexOf("hold_minutes:")).split("\n").filter((line) => /^\s+- /.test(line)).map((line) => line.trim().slice(2));
  assert.deepEqual(options, Object.keys(DELIVERY_PATHS));
  const holds = on.slice(on.indexOf("hold_minutes:")).split("\n").filter((line) => /^\s+- /.test(line)).map((line) => line.trim().slice(2));
  assert.deepEqual(holds, ['"15"', '"30"', '"45"', '"60"']);
});

test("least authority: no token permission at the top, id-token only in the delivery job, nothing in cleanup, no secret, no checkout, no action", () => {
  assert.match(workflow, /^permissions: \{\}$/m);
  const deliver = job("deliver");
  assert.match(deliver, /^ {4}permissions:\n {6}id-token: write\n {4}strategy:/m, "the delivery job may mint its OIDC token and nothing else");
  assert.equal((code.match(/^\s+id-token: write$/gm) ?? []).length, 1);
  assert.match(job("cleanup"), /^ {4}permissions: \{\}$/m);
  assert.doesNotMatch(code, /contents: write|actions: write|packages: write|pull-requests: write|issues: write|deployments: write|statuses: write|checks: write|attestations: write|security-events: write/);
  assert.doesNotMatch(code, /secrets\./, "no secret is named; the environments hold no secret");
  assert.doesNotMatch(code, /^\s*(?:- )?uses:/m, "no action runs: the jobs run only the reviewed scripts in this file");
  for (const line of workflow.split("\n").filter((l) => /uses:/.test(l) && !/^\s*#/.test(l))) assert.match(line, /@[0-9a-f]{40}\b/, "an action is pinned by commit");
  assert.doesNotMatch(code, /GITHUB_OUTPUT|GITHUB_ENV|GITHUB_PATH|GITHUB_STEP_SUMMARY|upload-artifact|cache|set -x|::add-mask::|^\s+outputs:/m, "no token can reach an output, the environment file, a summary, an artifact or a cache");
  assert.doesNotMatch(code, /echo[^\n]*ACTIONS_ID_TOKEN_REQUEST_TOKEN|console\.log/);
  assert.match(workflow, /concurrency:\n {2}group: act-identity-delivery\n {2}cancel-in-progress: false/);
});

test("both jobs run only on the dedicated runner label, only for a dispatch on main, and no other workflow names that label", () => {
  for (const name of ["deliver", "cleanup"]) {
    const body = job(name);
    assert.match(body, /^ {4}runs-on: \[self-hosted, alz-identity-delivery\]$/m, name);
    assert.match(body, /^ {4}if: (?:always\(\) && )?github\.event_name == 'workflow_dispatch' && github\.ref == 'refs\/heads\/main'$/m, name);
    assert.match(body, /^ {4}timeout-minutes: [0-9]+$/m, name);
  }
  const others = readdirSync(".github/workflows").filter((file) => file !== "act-identity-delivery.yml");
  for (const other of others) assert.doesNotMatch(readFileSync(join(".github/workflows", other), "utf8"), /alz-identity-delivery/, other);
});

test("no other workflow can land on a delivery runner by its default labels: every self-hosted job names its own dedicated label and an operating system the MBP is not (review N6)", () => {
  // A delivery runner carries self-hosted, macOS, ARM64 and alz-identity-delivery. A job matches it when every label it names is
  // one of those. The runner hook refuses such a job anyway; this keeps the repository from offering one.
  const delivery = new Set(["self-hosted", "macos", "arm64", "x64", "alz-identity-delivery"]);
  for (const file of readdirSync(".github/workflows").filter((name) => /\.ya?ml$/.test(name))) {
    const text = readFileSync(join(".github/workflows", file), "utf8");
    for (const match of text.matchAll(/^\s*runs-on:\s*(.+)$/gm)) {
      const value = match[1].trim();
      if (!/self-hosted/.test(value)) continue;
      const labels = value.replace(/^\[|\]$/g, "").split(",").map((label) => label.trim().toLowerCase());
      const landsOnDelivery = labels.every((label) => delivery.has(label));
      assert.equal(landsOnDelivery, file === "act-identity-delivery.yml", file + ": runs-on " + value);
    }
  }
});

test("the delivery job pins the reviewed runner hook by its SHA-256", () => {
  const pinned = /ALZ_RUNNER_HOOK_SHA256: "([0-9a-f]{64})"/.exec(workflow)?.[1];
  assert.equal(pinned, createHash("sha256").update(readFileSync("scripts/act-identity-runner-hook.sh")).digest("hex"),
    "update ALZ_RUNNER_HOOK_SHA256 in the workflow whenever the reviewed hook changes");
});

const expression = (body: string, key: string): string => {
  const line = body.split("\n").find((l) => l.trimStart().startsWith(key + ":"));
  assert.ok(line, key);
  return line.trim().slice(key.length + 1).trim();
};
/** The JSON maps inside `fromJSON('...')[...]` expressions, in order. */
const fromJsonMaps = (text: string): unknown[] => [...text.matchAll(/fromJSON\('([^']+)'\)/g)].map((m) => JSON.parse(m[1]));

test("each identity runs in its own environment, named exactly as the driver expects, from one table the product also holds", () => {
  const deliver = job("deliver");
  const environment = expression(deliver, "environment");
  assert.equal(expression(deliver, "ALZ_DELIVERY_ENVIRONMENT"), environment, "the job's environment and the name the script checks are one expression");
  const [scopes, slugs] = fromJsonMaps(environment) as [Record<string, string>, Record<string, string>];
  const [matrix] = fromJsonMaps(expression(deliver, "identity")) as [Record<string, string[]>];
  for (const path of Object.keys(DELIVERY_PATHS) as DeliveryPathId[]) {
    assert.deepEqual(matrix[path], DELIVERY_PATHS[path].identities, path);
    assert.equal(scopes[path], DELIVERY_PATHS[path].scope, path);
    for (const identity of DELIVERY_PATHS[path].identities) assert.equal("act-dev-" + scopes[path] + "-" + slugs[identity], deliveryEnvironment(path, identity));
  }
  assert.deepEqual(Object.keys(matrix), Object.keys(DELIVERY_PATHS));
  assert.match(deliver, /fail-fast: true/);
  assert.match(deliver, /ALZ_DELIVERY_REFRESH_SECONDS: "60"/);
  // The holder script carries the same table, audiences included.
  const holder = stepScript("Hold a refreshed identity token");
  const paths = new Function(holder.slice(holder.indexOf("const PATHS = "), holder.indexOf("const SLUG")).replace("const PATHS = ", "return ") ) as () => Record<string, { scope: string; identities: string[]; audience: string | null }>;
  for (const [path, spec] of Object.entries(paths())) {
    const product = DELIVERY_PATHS[path as DeliveryPathId];
    assert.deepEqual([spec.scope, spec.identities, spec.audience ?? undefined], [product.scope, [...product.identities], product.audience], path);
  }
});

// --- executable: the workflow's own scripts against a fake token service ---------------------------------------------------

type Mode = "ok" | "wrong-sub" | "wrong-aud" | "expired" | "error";
type Service = { url: string; requests: { identity: string; audience: string }[]; mode: Map<string, Mode>; close: () => Promise<void> };

/** A fake of the runner's token endpoint: each job's request token names its identity; the answer is a look-alike token. */
async function tokenService(path: DeliveryPathId): Promise<Service> {
  const requests: Service["requests"] = [];
  const mode = new Map<string, Mode>();
  const server: Server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const identity = /^bearer request-token-([A-Z_]+)$/.exec(request.headers.authorization ?? "")?.[1] as ExecutionIdentity | undefined;
    const audience = url.searchParams.get("audience") ?? "";
    if (!identity || url.pathname !== "/token" || url.searchParams.get("api-version") !== "2.0") { response.writeHead(401).end(); return; }
    requests.push({ identity, audience });
    const behavior = mode.get(identity) ?? "ok";
    if (behavior === "error") { response.writeHead(500).end(); return; }
    const now = Math.floor(Date.now() / 1000);
    const claims = { ...deliveryClaims(path, identity, now), aud: audience };
    if (behavior === "wrong-sub") claims.sub = "repo:" + REPO + ":environment:act-dev-other";
    if (behavior === "wrong-aud") claims.aud = "someone-else";
    if (behavior === "expired") claims.exp = now + 30;
    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ count: 1, value: fakeJwt(claims) }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return { url: "http://127.0.0.1:" + port + "/token?api-version=2.0", requests, mode, close: () => new Promise((resolve) => server.close(() => resolve())) };
}

const scratch = mkdtempSync(join(tmpdir(), "alz-delivery-wf-"));
test.after(() => rmSync(scratch, { recursive: true, force: true }));
const holderFile = join(scratch, "holder");
writeFileSync(holderFile, stepScript("Hold a refreshed identity token"));
const removeFile = join(scratch, "remove.sh");
writeFileSync(removeFile, stepScript("Remove the identity token"));
const cleanupFile = join(scratch, "cleanup");
writeFileSync(cleanupFile, stepScript("Remove the session directory and report leftovers"));
let rootCounter = 0;
const newRoot = (): string => { const root = join(scratch, "root-" + ++rootCounter); mkdirSync(root, { mode: 0o700 }); return root; };

const HOOK_SHA256 = /ALZ_RUNNER_HOOK_SHA256: "([0-9a-f]{64})"/.exec(workflow)![1];
let instanceCounter = 0;
/** One runner instance's installed hook, its owner-only configuration and its work directory, as the owner sets them up. */
function runnerInstance(conf?: (work: string) => string): { hook: string; eventPath: string } {
  const base = join(scratch, "instance-" + ++instanceCounter);
  const hookDir = join(base, "hook");
  const work = join(base, "runner", "_work");
  mkdirSync(hookDir, { recursive: true, mode: 0o700 });
  const hook = join(hookDir, "act-identity-runner-hook.sh");
  copyFileSync("scripts/act-identity-runner-hook.sh", hook);
  chmodSync(hook, 0o700);
  writeFileSync(join(hookDir, "act-identity-runner-hook.conf"), conf ? conf(work) : "REPOSITORY=" + REPO + "\nRUNNER_WORK=" + work + "\nNODE=" + process.execPath + "\n", { mode: 0o600 });
  return { hook, eventPath: work + "/_temp/_github_workflow/event.json" };
}

function jobEnv(path: DeliveryPathId, identity: ExecutionIdentity, root: string, service: Service, over: Record<string, string> = {}): NodeJS.ProcessEnv {
  const instance = runnerInstance();
  return {
    ACTIONS_RUNNER_HOOK_JOB_STARTED: instance.hook, GITHUB_EVENT_PATH: instance.eventPath, ALZ_RUNNER_HOOK_SHA256: HOOK_SHA256,
    PATH: dirname(process.execPath) + ":/usr/bin:/bin", HOME: scratch,
    ALZ_DELIVERY_PATH: path, ALZ_DELIVERY_IDENTITY: identity, ALZ_DELIVERY_ENVIRONMENT: deliveryEnvironment(path, identity), ALZ_DELIVERY_REPOSITORY: REPO,
    ALZ_DELIVERY_RUN_ID: RUN_ID, ALZ_DELIVERY_HOLD_MINUTES: "15", ALZ_DELIVERY_REFRESH_SECONDS: "5", ALZ_DELIVERY_GCP_AUDIENCE: GCP_CONFIG_AUDIENCE,
    ACTIONS_ID_TOKEN_REQUEST_URL: service.url, ACTIONS_ID_TOKEN_REQUEST_TOKEN: "request-token-" + identity, ALZ_IDENTITY_DELIVERY_ROOT: root, ...over,
  };
}
type Held = { child: ChildProcess; output: () => string; exit: Promise<number | null> };
function hold(env: NodeJS.ProcessEnv): Held {
  const child = spawn(process.execPath, [holderFile], { env, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout!.on("data", (chunk: Buffer) => { output += chunk.toString(); });
  child.stderr!.on("data", (chunk: Buffer) => { output += chunk.toString(); });
  const exit = new Promise<number | null>((resolve) => child.on("exit", (status, signal) => resolve(status ?? (signal ? 128 : null))));
  return { child, output: () => output, exit };
}
async function until(condition: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 200 && !condition(); i++) await new Promise((resolve) => setTimeout(resolve, 50));
  assert.ok(condition(), what);
}
const runCleanupJob = (path: DeliveryPathId, root: string) =>
  spawnSync(process.execPath, [cleanupFile], { env: { PATH: dirname(process.execPath) + ":/usr/bin:/bin", ALZ_DELIVERY_PATH: path, ALZ_IDENTITY_DELIVERY_ROOT: root }, encoding: "utf8" });
const tokenEnv = (path: DeliveryPathId, root: string): Record<string, string> =>
  Object.fromEntries(DELIVERY_PATHS[path].identities.map((identity) => ["ALZ_" + identity + "_ARM_OIDC_TOKEN_FILE", join(root, path, identity + ".jwt")]));

test("a delivery holds one private token per identity, re-mints it, the driver accepts it, and release, cleanup and the cleaned check leave nothing (SYNTHETIC)", async () => {
  const path = "azure-bicep";
  const service = await tokenService(path);
  const root = newRoot();
  try {
    const jobs = DELIVERY_PATHS[path].identities.map((identity) => hold(jobEnv(path, identity, root, service)));
    const session = join(root, path);
    await until(() => DELIVERY_PATHS[path].identities.every((identity) => existsSync(join(session, identity + ".json"))), "both tokens delivered");
    assert.equal(lstatSync(session).mode & 0o777, 0o700);
    for (const identity of DELIVERY_PATHS[path].identities) {
      assert.equal(lstatSync(join(session, identity + ".jwt")).mode & 0o777, 0o600);
      assert.equal(lstatSync(join(session, identity + ".json")).mode & 0o777, 0o600);
    }
    assert.deepEqual(new Set(service.requests.map((r) => r.audience)), new Set(["api://AzureADTokenExchange"]));
    const env = tokenEnv(path, root);
    const accepted = checkDeliveredTokens({ env, path, now: new Date(), repoRoot: process.cwd() });
    assert.ok(accepted.ok && accepted.delivered, JSON.stringify(accepted));
    const first = readFileSync(join(session, "APPLY.jwt"), "utf8");
    await until(() => service.requests.filter((r) => r.identity === "APPLY").length >= 2 && readFileSync(join(session, "APPLY.jwt"), "utf8") !== first, "APPLY re-minted");
    assert.ok(checkDeliveredTokens({ env, path, now: new Date(), repoRoot: process.cwd() }).ok);
    // Nothing a job prints carries a token or the request token.
    writeFileSync(join(session, "RELEASE"), "", { mode: 0o600 });
    assert.deepEqual(await Promise.all(jobs.map((j) => j.exit)), [0, 0]);
    for (const j of jobs) {
      assert.match(j.output(), /Delivered (DISCOVERY|APPLY) for act-dev-azure-(discovery|apply)/);
      assert.match(j.output(), /Released by the person at the terminal\.\nDeleted the (DISCOVERY|APPLY) token and its metadata\./);
      assert.doesNotMatch(j.output(), /request-token-|eyJ/);
      assert.equal(j.output().includes(root), false, "no host path in the job log");
    }
    assert.deepEqual(readdirSync(session), ["RELEASE"]);
    const cleaned = runCleanupJob(path, root);
    assert.equal(cleaned.status, 0, cleaned.stderr);
    assert.equal(existsSync(session), false);
    const record = identityDeliveryEvidence({ env, path, repository: REPO, phase: "cleaned", now: new Date(), repoRoot: process.cwd(), driverIdentityConfiguration: { ready: false } });
    assert.equal(record.result, "PASS", record.failures.join("; "));
  } finally { await service.close(); }
});

test("a token for the wrong subject or audience, one about to expire, or a failed token service is never written (SYNTHETIC)", async () => {
  for (const mode of ["wrong-sub", "wrong-aud", "expired", "error"] as const) {
    const service = await tokenService("aws-cdk");
    const root = newRoot();
    try {
      service.mode.set("CHANGESET", mode);
      const job = hold(jobEnv("aws-cdk", "CHANGESET", root, service));
      assert.equal(await job.exit, 1, mode);
      assert.match(job.output(), /IDENTITY_DELIVERY_REFUSED: /, mode);
      assert.deepEqual(readdirSync(join(root, "aws-cdk")), [], mode + ": nothing left behind");
    } finally { await service.close(); }
  }
});

test("a refresh that fails deletes the token instead of leaving it to go stale (SYNTHETIC)", async () => {
  const service = await tokenService("gcp-api");
  const root = newRoot();
  try {
    const job = hold(jobEnv("gcp-api", "APPLY", root, service));
    await until(() => existsSync(join(root, "gcp-api", "APPLY.jwt")), "delivered");
    assert.deepEqual(service.requests.map((r) => r.audience), ["https:" + GCP_CONFIG_AUDIENCE]);
    service.mode.set("APPLY", "error");
    assert.equal(await job.exit, 1);
    assert.deepEqual(readdirSync(join(root, "gcp-api")), []);
  } finally { await service.close(); }
});

test("the job refuses a shared or open root, a leftover token, a leftover RELEASE, a wrong environment and a missing GCP audience (SYNTHETIC)", async () => {
  const service = await tokenService("aws-terraform");
  try {
    const refusedWith = async (env: NodeJS.ProcessEnv, pattern: RegExp) => {
      const job = hold(env);
      assert.equal(await job.exit, 1, job.output());
      assert.match(job.output(), pattern);
    };
    const open = newRoot();
    chmodSync(open, 0o755);
    await refusedWith(jobEnv("aws-terraform", "APPLY", open, service), /not private to the runner user/);
    await refusedWith(jobEnv("aws-terraform", "APPLY", "", service), /ALZ_IDENTITY_DELIVERY_ROOT is not set/);
    const leftover = newRoot();
    mkdirSync(join(leftover, "aws-terraform"), { mode: 0o700 });
    writeFileSync(join(leftover, "aws-terraform", "APPLY.jwt"), "old", { mode: 0o600 });
    await refusedWith(jobEnv("aws-terraform", "APPLY", leftover, service), /from an earlier delivery is still present/);
    assert.equal(readFileSync(join(leftover, "aws-terraform", "APPLY.jwt"), "utf8"), "old", "a refused job deletes nothing it did not write");
    const released = newRoot();
    mkdirSync(join(released, "aws-terraform"), { mode: 0o700 });
    writeFileSync(join(released, "aws-terraform", "RELEASE"), "");
    await refusedWith(jobEnv("aws-terraform", "APPLY", released, service), /RELEASE marker from an earlier delivery/);
    await refusedWith(jobEnv("aws-terraform", "APPLY", newRoot(), service, { ALZ_DELIVERY_ENVIRONMENT: "act-dev-aws-terraform-discovery" }), /environment is not act-dev-aws-terraform-apply/);
    await refusedWith(jobEnv("aws-terraform", "CHANGESET", newRoot(), service), /not one of the path's identities/);
    await refusedWith(jobEnv("aws-terraform", "APPLY", newRoot(), service, { ACTIONS_ID_TOKEN_REQUEST_TOKEN: "" }), /cannot request an OIDC token/);
    await refusedWith(jobEnv("aws-terraform", "APPLY", newRoot(), service, { ALZ_DELIVERY_HOLD_MINUTES: "600" }), /hold is not/);
    await refusedWith(jobEnv("gcp-terraform", "APPLY", newRoot(), service, { ALZ_DELIVERY_GCP_AUDIENCE: "" }), /ALZ_GCP_WIF_AUDIENCE/);
    // A runner instance without the reviewed hook, or with another instance's or repository's configuration, mints nothing.
    await refusedWith(jobEnv("aws-terraform", "APPLY", newRoot(), service, { ACTIONS_RUNNER_HOOK_JOB_STARTED: "" }), /names no job-started hook/);
    await refusedWith(jobEnv("aws-terraform", "APPLY", newRoot(), service, { ACTIONS_RUNNER_HOOK_JOB_STARTED: join(scratch, "absent.sh") }), /job-started hook is missing/);
    const tampered = runnerInstance();
    writeFileSync(tampered.hook, "#!/bin/bash\nexit 0\n", { mode: 0o700 });
    await refusedWith(jobEnv("aws-terraform", "APPLY", newRoot(), service, { ACTIONS_RUNNER_HOOK_JOB_STARTED: tampered.hook }), /not the reviewed script/);
    const writable = runnerInstance();
    chmodSync(writable.hook, 0o777);
    await refusedWith(jobEnv("aws-terraform", "APPLY", newRoot(), service, { ACTIONS_RUNNER_HOOK_JOB_STARTED: writable.hook }), /hook is not an owner-only regular file/);
    await refusedWith(jobEnv("aws-terraform", "APPLY", newRoot(), service, { ALZ_RUNNER_HOOK_SHA256: "0".repeat(64) }), /not the reviewed script/);
    const otherRepo = runnerInstance((work) => "REPOSITORY=someone/else\nRUNNER_WORK=" + work + "\nNODE=" + process.execPath + "\n");
    await refusedWith(jobEnv("aws-terraform", "APPLY", newRoot(), service, { ACTIONS_RUNNER_HOOK_JOB_STARTED: otherRepo.hook, GITHUB_EVENT_PATH: otherRepo.eventPath }), /names another repository/);
    const otherInstance = runnerInstance();
    await refusedWith(jobEnv("aws-terraform", "APPLY", newRoot(), service, { ACTIONS_RUNNER_HOOK_JOB_STARTED: otherInstance.hook }), /not this runner instance's/);
    assert.equal(service.requests.length, 0, "no refused job asked for a token");
  } finally { await service.close(); }
});

test("an interrupted job deletes its token; a killed one is cleaned by the always-run step and the cleanup job (SYNTHETIC)", async () => {
  const service = await tokenService("aws-terraform");
  const root = newRoot();
  try {
    const session = join(root, "aws-terraform");
    for (const signal of ["SIGTERM", "SIGINT"] as const) {
      const job = hold(jobEnv("aws-terraform", "STATE", root, service));
      await until(() => existsSync(join(session, "STATE.json")), "delivered: the token, then its metadata");
      job.child.kill(signal);
      assert.equal(await job.exit, signal === "SIGTERM" ? 143 : 130);
      assert.deepEqual(readdirSync(session), [], signal);
    }
    const killed = hold(jobEnv("aws-terraform", "STATE_WRITE", root, service));
    // Wait for the whole first delivery (token, then metadata): a kill between the two leaves a partial write, covered below.
    await until(() => existsSync(join(session, "STATE_WRITE.json")), "delivered: the token, then its metadata");
    killed.child.kill("SIGKILL");
    await killed.exit;
    assert.deepEqual(readdirSync(session).sort(), ["STATE_WRITE.json", "STATE_WRITE.jwt"], "a killed process cannot clean up");
    writeFileSync(join(session, "STATE_WRITE.jwt.tmp-12345"), "partial", { mode: 0o600 });
    const removed = spawnSync("bash", [removeFile], { env: { PATH: "/usr/bin:/bin", ALZ_DELIVERY_PATH: "aws-terraform", ALZ_DELIVERY_IDENTITY: "STATE_WRITE", ALZ_IDENTITY_DELIVERY_ROOT: root }, encoding: "utf8" });
    assert.equal(removed.status, 0, removed.stderr);
    assert.deepEqual(readdirSync(session), []);
    assert.equal(spawnSync("bash", [removeFile], { env: { PATH: "/usr/bin:/bin", ALZ_DELIVERY_PATH: "../etc", ALZ_DELIVERY_IDENTITY: "APPLY", ALZ_IDENTITY_DELIVERY_ROOT: root } }).status, 1);
    // The cleanup job removes what the workflow writes and refuses to touch anything else.
    writeFileSync(join(session, "APPLY.json"), "{}", { mode: 0o600 });
    writeFileSync(join(session, "notes.txt"), "the owner's", { mode: 0o600 });
    const refused = runCleanupJob("aws-terraform", root);
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /IDENTITY_DELIVERY_LEFTOVER: .*notes\.txt/);
    assert.deepEqual(readdirSync(session), ["notes.txt"]);
    rmSync(join(session, "notes.txt"));
    assert.equal(runCleanupJob("aws-terraform", root).status, 0);
    assert.equal(existsSync(session), false);
    assert.equal(runCleanupJob("aws-terraform", root).status, 0, "nothing left is a clean result");
  } finally { await service.close(); }
});
