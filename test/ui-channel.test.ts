import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { request, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { openNonceStore } from "../src/apply/nonces.js";
import { runApplyCommand, type ApplyCliDeps } from "../src/cli/apply.js";
import { targetString } from "../src/cli/teardown-driver.js";
import { PILOT_STEPS, countChanges, createDialogBroker, PILOT_TOKEN_HEADER } from "../src/cli/ui-channel.js";
import { createLocalOperatorServer } from "../src/operator-ui/server.js";
import { removeTree } from "../src/teardown/driver/cleanup.js";
import { loadPilotContract, pilotContractSha256 } from "../src/apply/contract.js";
import type { ApplyEnvironment, PilotContract } from "../src/apply/types.js";
import { pilotUnitOf } from "../src/apply/unit.js";
import type { ResolvedTarget } from "../src/teardown/driver/types.js";
import { SOURCE_COMMIT,
  AWS_DEV_TARGET, ENGINE_VERSION, NOW, POLICY, awsContractJson, awsIdentityEnv, awsReadCallsOf, awsRoleArn, awsTargetOf, behave as behaveIn, behaveAwsReads, callsOf, contractJson, identityEnv,
  installFakeAwsReads, installFakeTerraform, keys, pinPathOf, stateResource, targetOf, testFixtureForgeQualificationEvidence,
  writePinnedContract, writeProject, type Behavior, type Project,
} from "./helpers/apply-fixtures.js";

// The console's pilot channel (src/cli/ui-channel.ts, docs/act-pilot-walkthrough.md). A workflow runs wholly in the terminal or
// wholly in the console; the channel is sealed into the plan; the console reaches the same gates through dialogs. The engine is a
// fake executable (logic only, NOT real-engine qualification). Fixtures only: no real tenant, subscription or approver.

const repo = (path: string): string => fileURLToPath(new URL("../" + path, import.meta.url));
const root = mkdtempSync(join(tmpdir(), "alz-ui-"));
const toolDir = mkdtempSync(join(tmpdir(), "alz-ui-tools-"));
const awsToolDir = mkdtempSync(join(tmpdir(), "alz-ui-aws-"));
process.env.AGENTIC_EVIDENCE_KEY = randomBytes(32).toString("base64");
process.chdir(root);
const servers: Server[] = [];
test.after(() => { for (const server of servers) server.close(); removeTree(root); removeTree(toolDir); removeTree(awsToolDir); });
installFakeTerraform(toolDir);
installFakeAwsReads(awsToolDir);

let counter = 0;
const fresh = (label: string): string => {
  const dir = join(root, label + "-" + ++counter);
  mkdirSync(dir, { recursive: true });
  return dir;
};
const KILL = join(root, "KILL");
const behave = (behavior: Behavior = {}) => behaveIn(toolDir, KILL, { applyAdvance: true, ...behavior });
const engineCalls = (): string[][] => callsOf(toolDir).map((call) => call.args);
const mutating = () => engineCalls().filter((args) => ["plan", "apply", "init"].includes(args[0]));
const TOKEN = "t".repeat(64);

type World = { cli: NonNullable<Parameters<typeof createLocalOperatorServer>[0]["pilot"]>["cli"] & object; contractPath: string; approvals: string; vault: string };

async function world(contract: unknown = contractJson(KILL), env: NodeJS.ProcessEnv = identityEnv("DEV")): Promise<World> {
  behave();
  const contractPath = join(fresh("contract"), "act-pilot-contract.json");
  writePinnedContract(contractPath, contract);
  const vault = fresh("vault");
  await testFixtureForgeQualificationEvidence(vault);
  const scratchParent = fresh("scratch");
  return {
    contractPath, vault, approvals: fresh("approvals"),
    cli: {
      sourceCommit: SOURCE_COMMIT,
      env, now: () => NOW, operatorId: "operator.fixture", contractPath, contractPinPath: pinPathOf(contractPath), qualificationDir: vault,
      evidenceDir: fresh("evidence"), nonces: openNonceStore(fresh("nonces")), scratchParent, toolDirs: [toolDir],
    },
  };
}

async function serve(w: World, over: { token?: string; dialogTimeoutMs?: number } = {}): Promise<{ port: number; token: string; server: Server }> {
  const { server, pilotToken } = createLocalOperatorServer({
    root, pilot: { token: over.token ?? TOKEN, dialogTimeoutMs: over.dialogTimeoutMs ?? 30_000, cli: w.cli, approvalsDir: w.approvals },
  });
  servers.push(server);
  await new Promise<void>((done) => { server.listen(0, "127.0.0.1", done); });
  const address = server.address();
  return { port: typeof address === "object" && address ? address.port : 0, token: pilotToken, server };
}

type Reply = { status: number; headers: Record<string, string | string[] | undefined>; text: string; body: any };
type CallOptions = { body?: unknown; raw?: string; token?: string | null; origin?: string | null; host?: string; contentType?: string | null };
function call(port: number, method: string, path: string, options: CallOptions = {}): Promise<Reply> {
  const payload = options.raw ?? (options.body === undefined ? undefined : JSON.stringify(options.body));
  const headers: Record<string, string> = { Host: options.host ?? "127.0.0.1:" + port };
  if (options.origin !== null) headers.Origin = options.origin ?? "http://127.0.0.1:" + port;
  if (options.token !== null) headers[PILOT_TOKEN_HEADER] = options.token ?? TOKEN;
  if (options.contentType !== null && method === "POST") headers["Content-Type"] = options.contentType ?? "application/json";
  if (payload !== undefined) headers["Content-Length"] = String(Buffer.byteLength(payload));
  return new Promise((done, fail) => {
    const req = request({ host: "127.0.0.1", port, method, path, headers, setHost: false }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let body: unknown;
        try { body = JSON.parse(text); } catch { body = undefined; }
        done({ status: res.statusCode ?? 0, headers: res.headers, text, body });
      });
    });
    req.on("error", fail);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

type State = {
  unlocked: boolean; path: "UI" | "CLI" | null; busy: boolean;
  run: null | { id: string; step: string; status: "RUNNING" | "WAITING" | "DONE"; transcript: string; dialog?: { id: string; kind: string; phrase: string };
    result?: { exit: number; code?: string; message?: string; outcome?: string; data?: any; summary?: any; savedPath?: string } };
};
const stateOf = async (port: number): Promise<State> => (await call(port, "GET", "/pilot/state")).body as State;
async function until(port: number, ready: (state: State) => boolean): Promise<State> {
  for (let attempt = 0; attempt < 600; attempt += 1) {
    const state = await stateOf(port);
    if (ready(state)) return state;
    await new Promise((done) => setTimeout(done, 25));
  }
  throw new Error("the wizard state never reached the expected point: " + JSON.stringify(await stateOf(port)));
}
const waiting = (port: number) => until(port, (s) => s.run?.status === "WAITING");
const finished = (port: number) => until(port, (s) => s.run?.status === "DONE");
async function answer(port: number, text: string): Promise<State> {
  const state = await waiting(port);
  const sent = await call(port, "POST", "/pilot/answer", { body: { dialogId: state.run!.dialog!.id, answer: text } });
  assert.equal(sent.status, 200, sent.text);
  return finished(port).catch(() => stateOf(port));
}
const choose = async (port: number, path: "UI" | "CLI" = "UI") => assert.equal((await call(port, "POST", "/pilot/path", { body: { path } })).status, 200);

const json = (value: unknown, label = "file"): string => {
  const path = join(fresh(label), label + ".json");
  writeFileSync(path, JSON.stringify(value));
  return path;
};
const keyFile = (who: keyof typeof keys, mode = 0o600): string => {
  const path = join(fresh("key"), who + ".pem");
  writeFileSync(path, keys[who].priv, { mode });
  chmodSync(path, mode);
  return path;
};
const requestFile = (p: Project, target: ResolvedTarget, environment: string) =>
  json({ environment, target, projectRoot: p.projectRoot, policyVersion: POLICY, resolved: p.resolved }, "request");
const applyRequestFile = (p: Project, target: ResolvedTarget, environment: string) => json({ environment, target, projectRoot: p.projectRoot }, "apply-request");
const PHRASE = "RUN PROJECT CODE";

// The terminal CLI, for the other half of every channel test.
async function cliRun(w: World, args: string[], answers: string[]): Promise<{ code: number; stderr: string; stdout: string; asked: string[] }> {
  const asked: string[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const code = await runApplyCommand(args, {
    ...w.cli, terminal: { stdinIsTTY: true, stdoutIsTTY: true, write: () => undefined, ask: async (q: string) => { asked.push(q); return answers.shift() ?? ""; } },
    stdout: (t: string) => { out.push(t); }, stderr: (t: string) => { err.push(t); },
  } as ApplyCliDeps);
  return { code, stdout: out.join(""), stderr: err.join(""), asked };
}

type Sealed = { project: Project; target: ResolvedTarget; environment: ApplyEnvironment; path: string; bundle: string; artifactSha256: string };
async function sealViaCli(w: World, environment: ApplyEnvironment = "DEV"): Promise<Sealed> {
  const target = targetOf(environment);
  const project = writeProject(fresh("project"), target);
  const run = await cliRun({ ...w, cli: { ...w.cli, env: identityEnv(environment) } },
    ["seal", "--request", requestFile(project, target, environment), "--manifest", json(project.manifest, "manifest")], [targetString(target), PHRASE]);
  assert.equal(run.code, 0, run.stderr);
  const result = JSON.parse(run.stdout) as { artifactSha256: string; sealedPlanPath: string; reviewBundlePath: string };
  return { project, target, environment, path: result.sealedPlanPath, bundle: result.reviewBundlePath, artifactSha256: result.artifactSha256 };
}
async function sealViaUi(port: number, project: Project, target: ResolvedTarget, environment: ApplyEnvironment = "DEV"): Promise<Sealed> {
  const started = await call(port, "POST", "/pilot/seal", { body: { environment, requestPath: requestFile(project, target, environment), manifestPath: json(project.manifest, "manifest") } });
  assert.equal(started.status, 202, started.text);
  const first = await waiting(port);
  assert.equal(first.run!.dialog!.kind, "TARGET");
  assert.equal(first.run!.dialog!.phrase, targetString(target));
  await call(port, "POST", "/pilot/answer", { body: { dialogId: first.run!.dialog!.id, answer: targetString(target) } });
  const second = await until(port, (s) => s.run?.status === "WAITING" && s.run.dialog?.kind === "RUN_PROJECT_CODE");
  assert.equal(second.run!.dialog!.phrase, PHRASE);
  await call(port, "POST", "/pilot/answer", { body: { dialogId: second.run!.dialog!.id, answer: PHRASE } });
  const done = await finished(port);
  assert.equal(done.run!.result!.exit, 0, JSON.stringify(done.run!.result));
  const data = done.run!.result!.data as { artifactSha256: string; sealedPlanPath: string; reviewBundlePath: string };
  return { project, target, environment, path: data.sealedPlanPath, bundle: data.reviewBundlePath, artifactSha256: data.artifactSha256 };
}
const approvePhrase = (s: Sealed) => "APPROVE " + s.environment + " " + s.artifactSha256.slice(0, 12);
const applyPhrase = (s: Sealed) => "APPLY " + s.environment + " " + s.artifactSha256.slice(0, 12) + " " + targetString(s.target);

async function approveViaUi(port: number, s: Sealed, who: keyof typeof keys): Promise<string> {
  const started = await call(port, "POST", "/pilot/approve", { body: { bundlePath: s.bundle, keyPath: keyFile(who), approverId: who } });
  assert.equal(started.status, 202, started.text);
  const asked = await waiting(port);
  assert.equal(asked.run!.dialog!.kind, "APPROVE");
  assert.equal(asked.run!.dialog!.phrase, approvePhrase(s));
  await call(port, "POST", "/pilot/answer", { body: { dialogId: asked.run!.dialog!.id, answer: approvePhrase(s) } });
  const done = await finished(port);
  assert.equal(done.run!.result!.exit, 0, JSON.stringify(done.run!.result));
  return done.run!.result!.savedPath!;
}
async function applyViaUi(port: number, s: Sealed, approvals: string[]): Promise<State> {
  const started = await call(port, "POST", "/pilot/apply", {
    body: { environment: s.environment, requestPath: requestFile(s.project, s.target, s.environment), manifestPath: json(s.project.manifest, "manifest"), sealedPath: s.path, approvalPaths: approvals },
  });
  assert.equal(started.status, 202, started.text);
  const asked = await waiting(port);
  assert.equal(asked.run!.dialog!.kind, "APPLY");
  assert.equal(asked.run!.dialog!.phrase, applyPhrase(s));
  await call(port, "POST", "/pilot/answer", { body: { dialogId: asked.run!.dialog!.id, answer: applyPhrase(s) } });
  return finished(port);
}

// --- the session token ----------------------------------------------------------------------------

test("a missing or wrong session token is refused on every pilot POST, and the page learns nothing before the token is pasted", async () => {
  const w = await world();
  const { port } = await serve(w);
  const routes = ["path", "reset", "preflight", "review", "seal", "approve", "apply", "answer", "cancel"];
  for (const route of routes) {
    for (const token of [null, "", "wrong", TOKEN.slice(1), TOKEN + "x", "T".repeat(64)]) {
      const reply = await call(port, "POST", "/pilot/" + route, { body: {}, token });
      assert.equal(reply.status, 401, route + " with " + String(token));
      assert.equal(reply.body.error, "PILOT_TOKEN_REQUIRED");
    }
  }
  assert.deepEqual(engineCalls(), []);
  const locked = await call(port, "GET", "/pilot/state", { token: null });
  assert.deepEqual(locked.body, { unlocked: false });
  assert.deepEqual((await call(port, "GET", "/pilot/state", { token: "wrong" })).body, { unlocked: false });
  assert.equal((await stateOf(port)).unlocked, true);
});

test("the token is neither echoed nor logged: no response, header, transcript or page carries it", async () => {
  const w = await world();
  const { port } = await serve(w);
  const seen: string[] = [];
  const note = (reply: Reply) => { seen.push(reply.text, JSON.stringify(reply.headers)); };
  note(await call(port, "GET", "/"));
  note(await call(port, "GET", "/state"));
  note(await call(port, "GET", "/pilot/state"));
  note(await call(port, "POST", "/pilot/path", { body: { path: "UI" } }));
  note(await call(port, "POST", "/pilot/preflight", { body: { environment: "DEV" } }));
  note(await call(port, "POST", "/pilot/path", { body: { path: "UI" }, token: "wrong-but-" + TOKEN.slice(0, 8) }));
  note(await call(port, "POST", "/pilot/seal", { body: { oops: 1 } }));
  await finished(port);
  note(await call(port, "GET", "/pilot/state"));
  for (const text of seen) assert.ok(!text.includes(TOKEN), "the token appeared in a response");
  const page = await call(port, "GET", "/");
  assert.ok(!page.text.includes(TOKEN));
});

test("a fresh console start draws a new random token, so a token from a previous start is refused (replay after restart)", async () => {
  const w = await world();
  const first = await serve(w, { token: undefined });
  const randomA = createLocalOperatorServer({ root }).pilotToken;
  const randomB = createLocalOperatorServer({ root }).pilotToken;
  assert.match(randomA, /^[0-9a-f]{64}$/);
  assert.notEqual(randomA, randomB);
  // The restarted console is a new process with a new token: the old one means nothing there.
  const restarted = createLocalOperatorServer({ root, pilot: { cli: w.cli, approvalsDir: w.approvals } });
  servers.push(restarted.server);
  await new Promise<void>((done) => { restarted.server.listen(0, "127.0.0.1", done); });
  const address = restarted.server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  const replay = await call(port, "POST", "/pilot/path", { body: { path: "UI" }, token: first.token });
  assert.equal(replay.status, 401);
  const fresh2 = await call(port, "POST", "/pilot/path", { body: { path: "UI" }, token: restarted.pilotToken });
  assert.equal(fresh2.status, 200);
});

// --- same origin, JSON, size, no CORS -------------------------------------------------------------

test("a pilot POST needs the console's own origin and host, JSON, and a small body; no CORS header is ever sent", async () => {
  const w = await world();
  const { port } = await serve(w);
  const body = { path: "UI" };
  assert.equal((await call(port, "POST", "/pilot/path", { body, origin: "http://evil.example" })).status, 403);
  assert.equal((await call(port, "POST", "/pilot/path", { body, origin: "http://127.0.0.1:" + (port + 1) })).status, 403);
  assert.equal((await call(port, "POST", "/pilot/path", { body, origin: "null" })).status, 403);
  const noOrigin = await call(port, "POST", "/pilot/path", { body, origin: null });
  assert.equal(noOrigin.status, 403);
  assert.equal(noOrigin.body.error, "PILOT_ORIGIN_REQUIRED");
  assert.equal((await call(port, "POST", "/pilot/path", { body, host: "localhost:" + port })).status, 403);
  assert.equal((await call(port, "POST", "/pilot/path", { body, host: "evil.example" })).status, 403);
  assert.equal((await call(port, "GET", "/pilot/state", { host: "evil.example" })).status, 403);
  for (const contentType of ["text/plain", "application/x-www-form-urlencoded", "multipart/form-data", null]) {
    assert.equal((await call(port, "POST", "/pilot/path", { body, contentType })).status, 415, String(contentType));
  }
  const big = await call(port, "POST", "/pilot/seal", { raw: JSON.stringify({ environment: "DEV", requestPath: "x".repeat(40_000), manifestPath: "m" }) });
  assert.equal(big.status, 413);
  assert.equal((await call(port, "POST", "/pilot/path", { raw: "{not json" })).status, 400);
  assert.equal((await call(port, "OPTIONS", "/pilot/path", { origin: "http://evil.example" })).status, 403);
  const options = await call(port, "OPTIONS", "/pilot/path");
  assert.equal(options.status, 405);
  for (const reply of [noOrigin, options, await call(port, "GET", "/pilot/state"), await call(port, "POST", "/pilot/path", { body })]) {
    assert.ok(!Object.keys(reply.headers).some((name) => name.startsWith("access-control-")), "a CORS header was sent");
  }
  assert.deepEqual(engineCalls(), []);
});

test("the console binds to the loopback address only", async () => {
  const source = readFileSync(repo("src/cli/operator-web.ts"), "utf8");
  assert.match(source, /server\.listen\(port, "127\.0\.0\.1"/);
  assert.doesNotMatch(source, /0\.0\.0\.0|"::"|listen\(port\)/);
});

test("the session token goes to the operator's terminal at start, from the launcher only", () => {
  const launcher = readFileSync(repo("src/cli/operator-web.ts"), "utf8");
  assert.match(launcher, /pilotToken/);
  assert.match(launcher, /console\.log\("  " \+ pilotToken\)/);
  const server = readFileSync(repo("src/operator-ui/server.ts"), "utf8");
  // It is returned to the launcher; no route of the page-facing server writes it into a response.
  assert.doesNotMatch(server, /split\(CONSOLE_CSRF_PLACEHOLDER\)\.join\(pilot/);
  assert.doesNotMatch(readFileSync(repo("src/cli/ui-channel.ts"), "utf8"), /send\([^)]*sessionToken|JSON\.stringify\([^)]*\btoken\b/);
});

// --- the closed command surface ------------------------------------------------------------------

test("the console starts only the nine named steps, from values the router turns into arguments; nothing else, and no process of its own", async () => {
  assert.deepEqual([...PILOT_STEPS], ["preflight", "prepare", "seal", "approve", "apply", "observe", "propose-cleanup", "cleanup", "verify-cleanup"]);
  const w = await world();
  const { port } = await serve(w);
  await choose(port);
  for (const route of ["exec", "run", "qualify", "pin", "status", "shell", "preflight/../seal", "../run"]) {
    const reply = await call(port, "POST", "/pilot/" + route, { body: {} });
    assert.ok([404, 400].includes(reply.status), route + " -> " + reply.status);
  }
  // A client sends values, never arguments: extra fields, flags in place of paths and argument lists are refused before a command exists.
  const refused = [
    ["seal", { environment: "DEV", requestPath: "r", manifestPath: "m", args: ["pin"] }],
    ["seal", { environment: "DEV", requestPath: "--yes", manifestPath: "m" }],
    ["seal", { environment: "DEV", requestPath: "r\nm", manifestPath: "m" }],
    ["seal", { environment: "ROOT", requestPath: "r", manifestPath: "m" }],
    ["preflight", { environment: "DEV", contract: "/tmp/other.json" }],
    ["prepare", { environment: "DEV", projectPath: "--force" }],
    ["prepare", { environment: "DEV", projectPath: "p", engine: "CDK" }],
    ["prepare", { environment: "DEV", projectPath: "p", awsCliVersion: "latest" }],
    ["prepare", { environment: "STAGING", projectPath: "p" }],
    ["approve", { bundlePath: "b", keyPath: "k", approverId: "a b" }],
    ["apply", { environment: "DEV", requestPath: "r", manifestPath: "m", sealedPath: "s", approvalPaths: [] }],
    ["apply", { environment: "DEV", requestPath: "r", manifestPath: "m", sealedPath: "s", approvalPaths: ["a"], force: true }],
  ] as const;
  for (const [route, body] of refused) {
    const reply = await call(port, "POST", "/pilot/" + route, { body });
    assert.equal(reply.status, 400, route + JSON.stringify(body));
  }
  assert.deepEqual(engineCalls(), []);
  assert.equal((await stateOf(port)).run, null, "nothing was started");
  // Structurally: the adapter spawns nothing, and the server's one spawn is the fixed job runner with its own script allowlist.
  const adapter = readFileSync(repo("src/cli/ui-channel.ts"), "utf8");
  assert.doesNotMatch(adapter, /node:child_process|\bspawn(Sync)?\s*\(|\bexec(File)?(Sync)?\s*\(|\bfork\s*\(/);
  assert.equal([...readFileSync(repo("src/operator-ui/server.ts"), "utf8").matchAll(/\bspawn\s*\(/g)].length, 1);
  assert.equal([...adapter.matchAll(/\brunApplyCommand\s*\(/g)].length, 1, "one call site, in start()");
  assert.match(adapter, /channel: "UI"/);
});

test("the job route still refuses the pilot: the catalog's apply card is a handoff, and a job for it is not accepted", async () => {
  const w = await world();
  let ran = 0;
  const { server, getState } = createLocalOperatorServer({ root, runner: async () => { ran += 1; return "ok"; }, pilot: { token: TOKEN, cli: w.cli, approvalsDir: w.approvals } });
  servers.push(server);
  await new Promise<void>((done) => { server.listen(0, "127.0.0.1", done); });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  const page = (await call(port, "GET", "/", { token: null })).text;
  const csrf = /data-operator-csrf[^>]*value="([^"]+)"|value="([^"]+)"[^>]*data-operator-csrf/.exec(page);
  const form = new URLSearchParams({ operation: "act-pilot-apply", inputs: JSON.stringify({ step: "apply" }), token: csrf?.[1] ?? csrf?.[2] ?? "missing" }).toString();
  const reply = await call(port, "POST", "/run", { raw: form, contentType: "application/x-www-form-urlencoded", token: null });
  assert.ok([400, 403].includes(reply.status), String(reply.status));
  assert.equal(ran, 0);
  assert.notEqual(getState().status, "RUNNING");
});

// --- the dialog terminal -------------------------------------------------------------------------

test("a terminal that did not pass channel authentication reports no terminal, so the command refuses before reading any file", async () => {
  const broker = createDialogBroker({ authenticated: false });
  assert.equal(broker.stdinIsTTY, false);
  assert.equal(broker.stdoutIsTTY, false);
  assert.equal(await broker.ask("target> ", { kind: "TARGET", phrase: "x" }), "");
  assert.equal(broker.pending(), undefined);
  const w = await world();
  const err: string[] = [];
  const code = await runApplyCommand(["seal", "--request", "/nonexistent/a", "--manifest", "/nonexistent/b"], { ...w.cli, terminal: broker, channel: "UI", stderr: (t) => { err.push(t); } });
  assert.equal(code, 1);
  assert.match(err.join(""), /HUMAN_TERMINAL_REQUIRED/);
  assert.doesNotMatch(err.join(""), /nonexistent|ENOENT/);
  assert.deepEqual(engineCalls(), []);
});

test("one dialog waits at a time; it needs its own id; an empty or missing phrase is never shown; nothing answers for the person", async () => {
  const broker = createDialogBroker({ authenticated: true, timeoutMs: 60_000 });
  assert.equal(broker.stdinIsTTY, true);
  const first = broker.ask("target> ", { kind: "TARGET", phrase: "acct | backend | ws" });
  const dialog = broker.pending()!;
  assert.equal(dialog.phrase, "acct | backend | ws");
  assert.equal(await broker.ask("second> ", { kind: "APPLY", phrase: "second" }), "", "a second question while one waits is refused");
  assert.equal(broker.pending()!.id, dialog.id);
  assert.equal(await broker.ask("none> "), "", "a question with no exact phrase is never shown");
  assert.equal(await broker.ask("empty> ", { kind: "APPLY", phrase: "" }), "");
  assert.equal(broker.answer("not-the-id", "acct | backend | ws"), false);
  assert.equal(broker.answer(dialog.id, "x".repeat(5000)), false);
  assert.equal(broker.pending()!.id, dialog.id, "a stale or oversized answer leaves the dialog waiting");
  let settled = false;
  void first.then(() => { settled = true; });
  await new Promise((done) => setTimeout(done, 40));
  assert.equal(settled, false, "the dialog does not answer itself");
  assert.equal(broker.answer(dialog.id, "acct | backend | ws"), true);
  assert.equal(await first, "acct | backend | ws");
  assert.equal(broker.pending(), undefined);
  assert.equal(broker.answer(dialog.id, "again"), false, "an answer is used once");
});

test("a dialog that times out or is canceled answers with nothing, which can never equal a phrase", async () => {
  const slow = createDialogBroker({ authenticated: true, timeoutMs: 30 });
  assert.equal(await slow.ask("target> ", { kind: "TARGET", phrase: "abc" }), "");
  assert.equal(slow.pending(), undefined);
  const broker = createDialogBroker({ authenticated: true, timeoutMs: 60_000 });
  const asked = broker.ask("target> ", { kind: "TARGET", phrase: "abc" });
  assert.equal(broker.cancel(), true);
  assert.equal(await asked, "");
  assert.equal(broker.cancel(), false);
});

// --- the whole path, wholly in the console -------------------------------------------------------

test("readiness: the check runs the preflight logic and reports each item", async () => {
  const w = await world();
  const { port } = await serve(w);
  await choose(port);
  assert.equal((await call(port, "POST", "/pilot/preflight", { body: { environment: "DEV" } })).status, 202);
  const done = await finished(port);
  const result = done.run!.result!;
  assert.equal(result.exit, 0, JSON.stringify(result));
  assert.equal(result.data.ready, true);
  assert.ok(result.data.checks.length >= 7);
  assert.match(JSON.stringify(result.data.checks), /kill switch absent/);
  // Every item reaches the page with its state, including qualification and the evidence-based attestation.
  const states = Object.fromEntries((result.data.checks as { check: string; state: string }[]).map((c) => [c.check.split(" (")[0], c.state]));
  assert.ok(Object.values(states).every((state) => state === "READY"), JSON.stringify(states));
  assert.equal(states["engine qualified in DEV for seal and apply"], "READY");
  assert.equal(states["identity separation attested on the real DEV backend"], "READY");
  // Missing identities: the same command, a red item per fact, still no engine.
  const bare = await world(contractJson(KILL), {});
  const other = await serve(bare, { token: "u".repeat(64) });
  await call(other.port, "POST", "/pilot/path", { body: { path: "UI" }, token: "u".repeat(64) });
  await call(other.port, "POST", "/pilot/preflight", { body: { environment: "DEV" }, token: "u".repeat(64) });
  const red = (await (async () => { for (let i = 0; i < 400; i += 1) { const s = (await call(other.port, "GET", "/pilot/state", { token: "u".repeat(64) })).body as State; if (s.run?.status === "DONE") return s; await new Promise((r) => setTimeout(r, 25)); } throw new Error("never finished"); })()).run!.result!;
  assert.equal(red.exit, 2);
  assert.equal(red.data.ready, false);
  const redStates = Object.fromEntries((red.data.checks as { check: string; state: string }[]).map((c) => [c.check.split(" (")[0], c.state]));
  assert.equal(redStates["identities configured, distinct, no fallback"], "MISSING");
  // Without the attested sign-ins, the stored qualification no longer matches this machine, so neither is reported ready.
  assert.notEqual(redStates["engine qualified in DEV for seal and apply"], "READY");
  assert.equal(redStates["identity separation attested on the real DEV backend"], "UNVERIFIED");
  assert.deepEqual(mutating(), []);
});

test("seal, approve, apply wholly in the console: every phrase is asked exactly as in the terminal, and the plan is sealed into the UI channel", async () => {
  const w = await world();
  const { port } = await serve(w);
  await choose(port);
  const project = writeProject(fresh("project"), targetOf("DEV"));
  const sealed = await sealViaUi(port, project, targetOf("DEV"));
  const bundle = JSON.parse(readFileSync(sealed.bundle, "utf8")) as { channel: string; artifactSha256: string };
  assert.equal(bundle.channel, "UI");
  assert.equal(bundle.artifactSha256, sealed.artifactSha256);
  const reviewed = (await call(port, "POST", "/pilot/review", { body: { bundlePath: sealed.bundle } })).body;
  assert.equal(reviewed.ok, true);
  assert.equal(reviewed.summary.environment, "DEV");
  assert.equal(reviewed.summary.shortId, sealed.artifactSha256.slice(0, 12));
  assert.deepEqual(reviewed.summary.counts, countChanges(reviewed.summary.changes));
  assert.ok(reviewed.summary.counts.create + reviewed.summary.counts.update >= 1);
  const approvalPath = await approveViaUi(port, sealed, "alice");
  assert.ok(existsSync(approvalPath));
  const approval = JSON.parse(readFileSync(approvalPath, "utf8")) as { statement: { artifactSha256: string; approverId: string }; signatureBase64: string };
  assert.equal(approval.statement.artifactSha256, sealed.artifactSha256);
  assert.equal(approval.statement.approverId, "alice");
  const before = engineCalls().filter((args) => args[0] === "apply").length;
  const applied = await applyViaUi(port, sealed, [approvalPath]);
  assert.equal(applied.run!.result!.exit, 0, JSON.stringify(applied.run!.result));
  assert.equal(applied.run!.result!.data.outcome, "SUCCEEDED");
  assert.equal(engineCalls().filter((args) => args[0] === "apply").length, before + 1);
  // No key material, and no secret, reached the page.
  const everything = JSON.stringify(await stateOf(port)) + JSON.stringify(reviewed) + readFileSync(sealed.bundle, "utf8");
  assert.ok(!everything.includes("BEGIN PRIVATE KEY") && !everything.includes(keys.alice.priv.split("\n")[1]));
});

test("the same contract opt-in asks for the STATE_WRITE phrase in the console, and a wrong one runs no engine", async () => {
  const w = await world(contractJson(KILL, { embedStateWrite: true }));
  const { port } = await serve(w);
  await choose(port);
  const target = targetOf("DEV");
  const project = writeProject(fresh("project"), target);
  const before = mutating().length;
  await call(port, "POST", "/pilot/seal", { body: { environment: "DEV", requestPath: requestFile(project, target, "DEV"), manifestPath: json(project.manifest, "manifest") } });
  let state = await waiting(port);
  await call(port, "POST", "/pilot/answer", { body: { dialogId: state.run!.dialog!.id, answer: targetString(target) } });
  state = await until(port, (s) => s.run?.dialog?.kind === "RUN_PROJECT_CODE");
  await call(port, "POST", "/pilot/answer", { body: { dialogId: state.run!.dialog!.id, answer: PHRASE } });
  state = await until(port, (s) => s.run?.dialog?.kind === "EMBED_STATE_WRITE");
  assert.equal(state.run!.dialog!.phrase, "EMBED STATE_WRITE DEV");
  assert.match(state.run!.transcript, /WARNING: this contract sets embedStateWrite/);
  const done = await answer(port, "embed state_write dev");
  assert.equal(done.run!.result!.exit, 1);
  assert.equal(done.run!.result!.code, "EMBED_STATE_WRITE_CONFIRMATION_MISMATCH");
  assert.equal(mutating().length, before, "no engine ran");
});

// --- wrong phrase, timeout, cancel: nothing runs, nothing is spent ---------------------------------

test("a wrong phrase in any dialog runs no engine and spends nothing; the right one proceeds", async () => {
  const w = await world();
  const { port } = await serve(w);
  await choose(port);
  const target = targetOf("DEV");
  const project = writeProject(fresh("project"), target);
  const seal = { environment: "DEV", requestPath: requestFile(project, target, "DEV"), manifestPath: json(project.manifest, "manifest") };
  for (const wrong of ["", "nope", targetString(target).toUpperCase(), targetString(target) + " ", " " + targetString(target), targetString({ ...target, workspace: "other" })]) {
    await call(port, "POST", "/pilot/seal", { body: seal });
    const done = await answer(port, wrong);
    assert.equal(done.run!.result!.exit, 1, JSON.stringify(wrong));
    assert.equal(done.run!.result!.code, "HUMAN_CONFIRMATION_MISMATCH");
    assert.deepEqual(mutating(), [], "the target phrase gates every engine step");
  }
  // The project-code phrase.
  await call(port, "POST", "/pilot/seal", { body: seal });
  let state = await waiting(port);
  await call(port, "POST", "/pilot/answer", { body: { dialogId: state.run!.dialog!.id, answer: targetString(target) } });
  state = await until(port, (s) => s.run?.dialog?.kind === "RUN_PROJECT_CODE");
  const stopped = await answer(port, "run project code");
  assert.equal(stopped.run!.result!.code, "PROJECT_CODE_CONFIRMATION_MISMATCH");
  assert.deepEqual(mutating(), []);
  // And the approve and apply phrases, against a real sealed plan.
  const s = await sealViaUi(port, project, target);
  const startedApprove = await call(port, "POST", "/pilot/approve", { body: { bundlePath: s.bundle, keyPath: keyFile("alice"), approverId: "alice" } });
  assert.equal(startedApprove.status, 202);
  const approveStopped = await answer(port, approvePhrase(s).toLowerCase());
  assert.equal(approveStopped.run!.result!.code, "APPLY_CONFIRMATION_MISMATCH");
  assert.equal(approveStopped.run!.result!.savedPath, undefined, "nothing was signed");
  assert.deepEqual(readdirSync(w.approvals), []);
  const approvalPath = await approveViaUi(port, s, "alice");
  const applies = engineCalls().filter((args) => args[0] === "apply").length;
  const startedApply = await call(port, "POST", "/pilot/apply", {
    body: { environment: "DEV", requestPath: applyRequestFile(project, target, "DEV"), manifestPath: json(project.manifest, "manifest"), sealedPath: s.path, approvalPaths: [approvalPath] },
  });
  assert.equal(startedApply.status, 202);
  const applyStopped = await answer(port, applyPhrase(s).replace("APPLY", "apply"));
  assert.equal(applyStopped.run!.result!.code, "APPLY_CONFIRMATION_MISMATCH");
  assert.equal(engineCalls().filter((args) => args[0] === "apply").length, applies, "no apply ran");
  // Nothing was spent: the same approval and sealed plan still apply.
  const okay = await applyViaUi(port, s, [approvalPath]);
  assert.equal(okay.run!.result!.exit, 0, JSON.stringify(okay.run!.result));
});

test("a dialog that times out, or is canceled, ends the command with nothing run and nothing spent", async () => {
  const w = await world();
  const { port } = await serve(w, { dialogTimeoutMs: 120 });
  await choose(port);
  const target = targetOf("DEV");
  const project = writeProject(fresh("project"), target);
  const seal = { environment: "DEV", requestPath: requestFile(project, target, "DEV"), manifestPath: json(project.manifest, "manifest") };
  await call(port, "POST", "/pilot/seal", { body: seal });
  const timedOut = await finished(port);
  assert.equal(timedOut.run!.result!.exit, 1);
  assert.equal(timedOut.run!.result!.code, "HUMAN_CONFIRMATION_MISMATCH");
  assert.deepEqual(mutating(), []);
  // Cancel through the page.
  const slow = await serve(w, { token: "c".repeat(64), dialogTimeoutMs: 60_000 });
  const t = { token: "c".repeat(64) };
  await call(slow.port, "POST", "/pilot/path", { body: { path: "UI" }, ...t });
  await call(slow.port, "POST", "/pilot/seal", { body: seal, ...t });
  for (let i = 0; i < 400; i += 1) { const s = (await call(slow.port, "GET", "/pilot/state", t)).body as State; if (s.run?.status === "WAITING") break; await new Promise((r) => setTimeout(r, 25)); }
  assert.equal((await call(slow.port, "POST", "/pilot/cancel", { body: {}, ...t })).status, 200);
  let state: State = (await call(slow.port, "GET", "/pilot/state", t)).body as State;
  for (let i = 0; i < 400 && state.run?.status !== "DONE"; i += 1) { await new Promise((r) => setTimeout(r, 25)); state = (await call(slow.port, "GET", "/pilot/state", t)).body as State; }
  assert.equal(state.run!.result!.code, "HUMAN_CONFIRMATION_MISMATCH");
  assert.deepEqual(mutating(), []);
  assert.equal((await call(slow.port, "POST", "/pilot/cancel", { body: {}, ...t })).status, 409, "nothing left to cancel");
  // A sealed plan was never written by either.
  assert.deepEqual(readdirSync(w.cli.evidenceDir!).filter((name) => name.endsWith(".json")), []);
});

test("one run at a time, and a stale answer is refused", async () => {
  const w = await world();
  const { port } = await serve(w);
  await choose(port);
  const target = targetOf("DEV");
  const project = writeProject(fresh("project"), target);
  const seal = { environment: "DEV", requestPath: requestFile(project, target, "DEV"), manifestPath: json(project.manifest, "manifest") };
  assert.equal((await call(port, "POST", "/pilot/seal", { body: seal })).status, 202);
  const first = await waiting(port);
  assert.equal((await call(port, "POST", "/pilot/seal", { body: seal })).status, 409);
  assert.equal((await call(port, "POST", "/pilot/preflight", { body: { environment: "DEV" } })).status, 409);
  assert.equal((await call(port, "POST", "/pilot/reset", { body: {} })).status, 409);
  const stale = await call(port, "POST", "/pilot/answer", { body: { dialogId: "00000000-0000-4000-8000-000000000000", answer: targetString(target) } });
  assert.equal(stale.status, 409);
  assert.equal((await stateOf(port)).run!.dialog!.id, first.run!.dialog!.id, "the stale answer left the question waiting");
  await call(port, "POST", "/pilot/cancel", { body: {} });
  await finished(port);
});

// --- the path is chosen once and never mixed ---------------------------------------------------

test("a change set to run on the command line turns the console buttons off, and one path never switches to the other without starting over", async () => {
  const w = await world();
  const { port } = await serve(w);
  const target = targetOf("DEV");
  const project = writeProject(fresh("project"), target);
  const seal = { environment: "DEV", requestPath: requestFile(project, target, "DEV"), manifestPath: json(project.manifest, "manifest") };
  const before = await call(port, "POST", "/pilot/seal", { body: seal });
  assert.equal(before.status, 409);
  assert.equal(before.body.error, "PILOT_PATH_NOT_CHOSEN");
  await choose(port, "CLI");
  for (const [route, body] of [["preflight", { environment: "DEV" }], ["seal", seal], ["review", { bundlePath: "b" }]] as const) {
    const reply = await call(port, "POST", "/pilot/" + route, { body });
    assert.equal(reply.status, 409, route);
    assert.equal(reply.body.error, "PILOT_PATH_CLI");
  }
  assert.equal((await call(port, "POST", "/pilot/path", { body: { path: "UI" } })).body.error, "PILOT_PATH_LOCKED");
  assert.equal((await stateOf(port)).path, "CLI");
  assert.deepEqual(engineCalls(), []);
  assert.equal((await call(port, "POST", "/pilot/reset", { body: {} })).status, 200);
  assert.equal((await stateOf(port)).path, null);
  await choose(port, "UI");
  assert.equal((await call(port, "POST", "/pilot/path", { body: { path: "CLI" } })).body.error, "PILOT_PATH_LOCKED");
});

test("a request file for another environment than the one picked is stopped before anything runs", async () => {
  const w = await world();
  const { port } = await serve(w);
  await choose(port);
  const target = targetOf("QA");
  const project = writeProject(fresh("project"), target);
  const reply = await call(port, "POST", "/pilot/seal", { body: { environment: "DEV", requestPath: requestFile(project, target, "QA"), manifestPath: json(project.manifest, "manifest") } });
  assert.equal(reply.status, 422);
  assert.equal(reply.body.error, "PILOT_ENVIRONMENT_MISMATCH");
  assert.equal((await stateOf(port)).run, null);
});

// --- channel binding: both directions, and nothing is consumed ---------------------------------

test("a plan sealed in the terminal cannot be reviewed, approved or applied from the console, and nothing is used up", async () => {
  const w = await world();
  const { port } = await serve(w);
  await choose(port);
  const s = await sealViaCli(w);
  assert.equal(JSON.parse(readFileSync(s.bundle, "utf8")).channel, "CLI");
  const reviewed = (await call(port, "POST", "/pilot/review", { body: { bundlePath: s.bundle } })).body;
  assert.equal(reviewed.ok, false);
  assert.equal(reviewed.code, "CHANNEL_MISMATCH");
  assert.match(reviewed.message, /command line/);
  // The console's approve: refused before any question, so no key is used and nothing is signed.
  await call(port, "POST", "/pilot/approve", { body: { bundlePath: s.bundle, keyPath: keyFile("alice"), approverId: "alice" } });
  const refusedApprove = await finished(port);
  assert.equal(refusedApprove.run!.result!.exit, 2);
  assert.equal(refusedApprove.run!.result!.code, "CHANNEL_MISMATCH");
  assert.equal(refusedApprove.run!.dialog, undefined);
  assert.deepEqual(readdirSync(w.approvals), []);
  // An approval the terminal legitimately signed, offered to the console's apply: refused, and it is still good afterward.
  const signed = await cliRun(w, ["approve", "--bundle", s.bundle, "--key", keyFile("alice"), "--approver", "alice"], [approvePhrase(s)]);
  assert.equal(signed.code, 0, signed.stderr);
  const approvalPath = json(JSON.parse(signed.stdout), "approval");
  const applies = engineCalls().filter((args) => args[0] === "apply").length;
  await call(port, "POST", "/pilot/apply", {
    body: { environment: "DEV", requestPath: applyRequestFile(s.project, s.target, "DEV"), manifestPath: json(s.project.manifest, "manifest"), sealedPath: s.path, approvalPaths: [approvalPath] },
  });
  const refusedApply = await finished(port);
  assert.equal(refusedApply.run!.result!.exit, 2);
  assert.equal(refusedApply.run!.result!.code, "CHANNEL_MISMATCH");
  assert.equal(refusedApply.run!.dialog, undefined, "refused before the final question");
  assert.equal(engineCalls().filter((args) => args[0] === "apply").length, applies);
  const stillGood = await cliRun(w, ["apply", "--request", applyRequestFile(s.project, s.target, "DEV"), "--manifest", json(s.project.manifest, "manifest"), "--sealed", s.path, "--approval", approvalPath], [applyPhrase(s)]);
  assert.equal(stillGood.code, 0, stillGood.stderr);
  assert.equal(engineCalls().filter((args) => args[0] === "apply").length, applies + 1, "the approval and the plan were not consumed by the refusal");
});

test("a plan sealed in the console cannot be approved or applied from the terminal, and nothing is used up", async () => {
  const w = await world();
  const { port } = await serve(w);
  await choose(port);
  const project = writeProject(fresh("project"), targetOf("DEV"));
  const s = await sealViaUi(port, project, targetOf("DEV"));
  const signedByUi = await approveViaUi(port, s, "alice");
  const refusedApprove = await cliRun(w, ["approve", "--bundle", s.bundle, "--key", keyFile("bob"), "--approver", "bob"], [approvePhrase(s)]);
  assert.equal(refusedApprove.code, 2);
  assert.match(refusedApprove.stderr, /CHANNEL_MISMATCH/);
  assert.match(refusedApprove.stderr, /web console/);
  assert.deepEqual(refusedApprove.asked, [], "no question was asked");
  const applies = engineCalls().filter((args) => args[0] === "apply").length;
  const refusedApply = await cliRun(w, ["apply", "--request", applyRequestFile(project, s.target, "DEV"), "--manifest", json(project.manifest, "manifest"), "--sealed", s.path, "--approval", signedByUi], [applyPhrase(s)]);
  assert.equal(refusedApply.code, 2);
  assert.match(refusedApply.stderr, /CHANNEL_MISMATCH/);
  assert.deepEqual(refusedApply.asked, []);
  assert.equal(engineCalls().filter((args) => args[0] === "apply").length, applies);
  const stillGood = await applyViaUi(port, s, [signedByUi]);
  assert.equal(stillGood.run!.result!.exit, 0, JSON.stringify(stillGood.run!.result));
});

test("the channel cannot be flipped by editing the review file: the artifact hash binds it", async () => {
  const w = await world();
  const { port } = await serve(w);
  await choose(port);
  const project = writeProject(fresh("project"), targetOf("DEV"));
  const s = await sealViaUi(port, project, targetOf("DEV"));
  const bundle = JSON.parse(readFileSync(s.bundle, "utf8")) as Record<string, unknown>;
  const forged = json({ ...bundle, channel: "CLI" }, "forged-bundle");
  const run = await cliRun(w, ["approve", "--bundle", forged, "--key", keyFile("alice"), "--approver", "alice"], [approvePhrase(s)]);
  assert.equal(run.code, 2);
  assert.match(run.stderr, /ARTIFACT_TAMPERED/);
  assert.deepEqual(run.asked, []);
  const missing = { ...bundle };
  delete missing.channel;
  const noChannel = await cliRun(w, ["approve", "--bundle", json(missing, "no-channel"), "--key", keyFile("alice"), "--approver", "alice"], [approvePhrase(s)]);
  assert.equal(noChannel.code, 2);
  assert.match(noChannel.stderr, /ARTIFACT_INVALID/);
});

test("the approver's key stays a file: the same ownership and permission checks as the terminal, and no key material comes back", async () => {
  const w = await world();
  const { port } = await serve(w);
  await choose(port);
  const project = writeProject(fresh("project"), targetOf("DEV"));
  const s = await sealViaUi(port, project, targetOf("DEV"));
  for (const bad of [keyFile("alice", 0o644), join(fresh("nokey"), "absent.pem"), root]) {
    await call(port, "POST", "/pilot/approve", { body: { bundlePath: s.bundle, keyPath: bad, approverId: "alice" } });
    const done = await finished(port);
    assert.equal(done.run!.result!.exit, 1);
    assert.equal(done.run!.result!.code, "APPLY_KEY_INVALID");
    assert.equal(done.run!.dialog, undefined);
    assert.ok(!JSON.stringify(done).includes("PRIVATE KEY"));
  }
  assert.deepEqual(readdirSync(w.approvals), []);
  // The route takes a location, never key text.
  const pasted = await call(port, "POST", "/pilot/approve", { body: { bundlePath: s.bundle, keyPath: keys.alice.priv, approverId: "alice" } });
  assert.equal(pasted.status, 400, "a pasted key is refused as a location");
  assert.ok(!pasted.text.includes("PRIVATE KEY"));
});

test("guided AWS setup inherits protected pilot token and refuses malformed or elevated requests before AWS calls", async () => {
  const w=await world();
  const {port}=await serve(w);
  const route="/pilot/aws-readiness";
  const valid={account:"111111111111",profile:"adaptcloud-admin"};
  assert.equal((await call(port,"POST",route,{body:valid,token:null})).status,401);
  assert.equal((await call(port,"POST",route,{body:valid,token:"wrong"})).status,401);
  assert.equal((await call(port,"POST",route,{body:valid,origin:"http://unknown.invalid"})).status,403);
  assert.equal((await call(port,"POST",route,{body:{...valid,extra:"apply"}})).status,400);
  assert.equal((await call(port,"POST",route,{body:{...valid,account:"973471129135"}})).status,400);
  assert.equal((await call(port,"POST",route,{body:{...valid,profile:"unsafe;echo x"}})).status,400);
  assert.deepEqual(mutating(),[]);
});

test("prepare in the console writes the request and manifest from the contract and project, and seal accepts them unchanged", async () => {
  const base = await world(contractJson(KILL, { policyVersion: POLICY }));
  const preparationDir = fresh("prepared");
  const w = { ...base, cli: { ...base.cli, preparationDir } };
  const { port } = await serve(w);
  await choose(port);
  const target = targetOf("DEV");
  const project = writeProject(fresh("project"), target);
  const started = await call(port, "POST", "/pilot/prepare", { body: { environment: "DEV", projectPath: project.projectRoot } });
  assert.equal(started.status, 202, started.text);
  const done = await finished(port);
  const result = done.run!.result!;
  assert.equal(result.exit, 0, JSON.stringify(result));
  assert.equal(result.code, "PREPARED");
  const data = result.data as { files: { request: string; manifest: string }; summary: { label: string; engine: string }; next: { step: string } };
  assert.equal(data.summary.label, "LOCAL_PREPARATION");
  assert.equal(data.summary.engine, "TERRAFORM");
  assert.equal(data.next.step, "seal");
  assert.ok(data.files.request.startsWith(preparationDir) && data.files.manifest.startsWith(preparationDir));
  assert.deepEqual(engineCalls(), [], "preparation starts no engine");

  const sealing = await call(port, "POST", "/pilot/seal", { body: { environment: "DEV", requestPath: data.files.request, manifestPath: data.files.manifest } });
  assert.equal(sealing.status, 202, sealing.text);
  const first = await waiting(port);
  await call(port, "POST", "/pilot/answer", { body: { dialogId: first.run!.dialog!.id, answer: targetString(target) } });
  const second = await until(port, (s) => s.run?.status === "WAITING" && s.run.dialog?.kind === "RUN_PROJECT_CODE");
  await call(port, "POST", "/pilot/answer", { body: { dialogId: second.run!.dialog!.id, answer: PHRASE } });
  const sealed = await finished(port);
  assert.equal(sealed.run!.result!.exit, 0, JSON.stringify(sealed.run!.result));
});

test("prepare in the console reports the owner prerequisite with its blocker and writes nothing", async () => {
  const base = await world();
  const preparationDir = fresh("prepared");
  const { port } = await serve({ ...base, cli: { ...base.cli, preparationDir } });
  await choose(port);
  const project = writeProject(fresh("project"), targetOf("DEV"));
  assert.equal((await call(port, "POST", "/pilot/prepare", { body: { environment: "DEV", projectPath: project.projectRoot } })).status, 202);
  const result = (await finished(port)).run!.result!;
  assert.equal(result.exit, 2);
  assert.equal(result.code, "POLICY_VERSION_MISSING");
  assert.deepEqual(result.data, { blocker: "OWNER" });
  assert.deepEqual(readdirSync(preparationDir), []);
});

// --- whole journeys through the real router, service and adapter, per cloud (config/acceptance/journeys.json cites these) ---

type Cloud = "AWS" | "AZURE";
const AWS_PROVIDER_CONFIG = { aws: { name: "aws", full_name: "registry.terraform.io/hashicorp/aws", expressions: { region: { references: ["var.region"] } } } };

/** A pinned contract with a policy version for the cloud, its identities and qualification, and a Terraform project for its DEV target. */
async function consoleJourney(cloud: Cloud, sourceCommit = SOURCE_COMMIT) {
  // The same fake engine as every test here (logic only, NOT real cloud behavior); the contract, identities and project are the cloud's own.
  behave(cloud === "AWS" ? { showProviderConfig: AWS_PROVIDER_CONFIG } : {});
  const contractPath = join(fresh("contract"), "act-pilot-contract.json");
  writePinnedContract(contractPath, cloud === "AWS" ? awsContractJson(KILL, { policyVersion: POLICY }) : contractJson(KILL, { policyVersion: POLICY }));
  const vault = fresh("vault");
  await testFixtureForgeQualificationEvidence(vault, undefined, cloud);
  const w: World = {
    contractPath, vault, approvals: fresh("approvals"),
    cli: {
      sourceCommit: SOURCE_COMMIT,
      env: cloud === "AWS" ? awsIdentityEnv("DEV") : identityEnv("DEV"), now: () => NOW, operatorId: "operator.fixture", contractPath,
      contractPinPath: pinPathOf(contractPath), qualificationDir: vault, evidenceDir: fresh("evidence"), nonces: openNonceStore(fresh("nonces")),
      scratchParent: fresh("scratch"), toolDirs: [toolDir], preparationDir: fresh("prepared"),
    },
  };
  w.cli.sourceCommit = sourceCommit;
  const { port } = await serve(w);
  await choose(port);
  const target = cloud === "AWS" ? awsTargetOf("DEV") : targetOf("DEV");
  const project = writeProject(fresh("project"), target, cloud === "AWS" ? 'resource "aws_s3_bucket" "pilot" {}\n' : undefined);
  return { w, port, target, project };
}

/** Prepare from the project folder (no hand-written request or manifest), then seal those files through the two dialogs. */
async function prepareAndSealInConsole(port: number, project: Project, target: ResolvedTarget) {
  assert.equal((await call(port, "POST", "/pilot/prepare", { body: { environment: "DEV", projectPath: project.projectRoot } })).status, 202);
  const prepared = (await finished(port)).run!.result!;
  assert.equal(prepared.exit, 0, JSON.stringify(prepared));
  const data = prepared.data as { files: { request: string; manifest: string }; summary: { provider: string; engine: string; account: string } };
  assert.equal((await call(port, "POST", "/pilot/seal", { body: { environment: "DEV", requestPath: data.files.request, manifestPath: data.files.manifest } })).status, 202);
  const first = await waiting(port);
  assert.equal(first.run!.dialog!.phrase, targetString(target));
  await call(port, "POST", "/pilot/answer", { body: { dialogId: first.run!.dialog!.id, answer: targetString(target) } });
  const second = await until(port, (s) => s.run?.status === "WAITING" && s.run.dialog?.kind === "RUN_PROJECT_CODE");
  await call(port, "POST", "/pilot/answer", { body: { dialogId: second.run!.dialog!.id, answer: PHRASE } });
  const sealedRun = (await finished(port)).run!.result!;
  assert.equal(sealedRun.exit, 0, JSON.stringify(sealedRun));
  // The review the approvers see names the cleanup marker (the deletion unit) the sealed plan was checked for.
  const unit = (sealedRun.summary as { unit: { unitId: string; tags: Record<string, string>; untagged: string[] } | null } | undefined)?.unit;
  assert.ok(unit, "the console summary carries the unit");
  assert.match(unit.unitId, /^alzu-[0-9a-f]{20}$/);
  assert.equal(unit.tags["alz-unit"], unit.unitId);
  assert.ok(Array.isArray(unit.untagged));
  const out = sealedRun.data as { artifactSha256: string; sealedPlanPath: string; reviewBundlePath: string };
  const sealed: Sealed = { project, target, environment: "DEV", path: out.sealedPlanPath, bundle: out.reviewBundlePath, artifactSha256: out.artifactSha256 };
  return { prepared: data, sealed };
}

/** Starts an apply of the prepared request and answers its one dialog with `answer` (undefined cancels it). */
async function applyInConsole(port: number, files: { request: string; manifest: string }, sealed: Sealed, approvals: string[], answer: string | undefined) {
  const started = await call(port, "POST", "/pilot/apply", {
    body: { environment: "DEV", requestPath: files.request, manifestPath: files.manifest, sealedPath: sealed.path, approvalPaths: approvals },
  });
  assert.equal(started.status, 202, started.text);
  const asked = await waiting(port);
  assert.equal(asked.run!.dialog!.kind, "APPLY");
  if (answer === undefined) await call(port, "POST", "/pilot/cancel", { body: {} });
  else await call(port, "POST", "/pilot/answer", { body: { dialogId: asked.run!.dialog!.id, answer } });
  return (await finished(port)).run!.result!;
}

async function wholeJourneyInConsole(cloud: Cloud): Promise<void> {
  const { port, target, project } = await consoleJourney(cloud);
  const { prepared, sealed } = await prepareAndSealInConsole(port, project, target);
  assert.equal(prepared.summary.provider, cloud);
  assert.equal(prepared.summary.engine, "TERRAFORM");
  assert.equal(prepared.summary.account, target.account);
  const reviewed = (await call(port, "POST", "/pilot/review", { body: { bundlePath: sealed.bundle } })).body;
  assert.equal(reviewed.ok, true);
  assert.deepEqual(reviewed.summary.target, target);
  assert.equal(reviewed.summary.sourceCommit, SOURCE_COMMIT, "approvers see the product commit they sign");
  assert.deepEqual({ ...reviewed.summary.preview, qualifiedAt: undefined }, { engineVersion: ENGINE_VERSION, programId: programId(), qualified: true, qualifiedAt: undefined },
    "approvers see which engine program made the preview, and that real-engine evidence covers it");
  assert.match(reviewed.summary.preview.qualifiedAt, /^\d{4}-\d{2}-\d{2}T/);
  const approvalPath = await approveViaUi(port, sealed, "alice");
  const before = engineCalls().filter((args) => args[0] === "apply").length;
  // The router derives the apply request from the prepared seal request.
  const applied = await applyInConsole(port, prepared.files, sealed, [approvalPath], applyPhrase(sealed));
  assert.equal(applied.exit, 0, JSON.stringify(applied));
  const evidence = applied.data as { outcome: string; target: ResolvedTarget; artifactSha256: string; sourceCommit: string };
  assert.equal(evidence.outcome, "SUCCEEDED");
  assert.equal(evidence.sourceCommit, SOURCE_COMMIT, "the evidence names the product commit that sealed and applied");
  assert.deepEqual(evidence.target, target);
  assert.equal(evidence.artifactSha256, sealed.artifactSha256);
  assert.equal(engineCalls().filter((args) => args[0] === "apply").length, before + 1);
}

async function interruptedJourneyInConsole(cloud: Cloud): Promise<void> {
  const { w, port, target, project } = await consoleJourney(cloud);
  const { prepared, sealed } = await prepareAndSealInConsole(port, project, target);
  const approvalFiles = () => readdirSync(w.approvals);

  // Approval: a wrong phrase, then a cancel, each end with nothing signed.
  for (const answer of ["APPROVE " + sealed.environment, undefined]) {
    assert.equal((await call(port, "POST", "/pilot/approve", { body: { bundlePath: sealed.bundle, keyPath: keyFile("alice"), approverId: "alice" } })).status, 202);
    const asked = await waiting(port);
    if (answer === undefined) await call(port, "POST", "/pilot/cancel", { body: {} });
    else await call(port, "POST", "/pilot/answer", { body: { dialogId: asked.run!.dialog!.id, answer } });
    const result = (await finished(port)).run!.result!;
    assert.notEqual(result.exit, 0);
    assert.equal(result.savedPath, undefined);
    assert.deepEqual(approvalFiles(), [], "nothing was signed");
  }
  const approvalPath = await approveViaUi(port, sealed, "alice");

  // Apply: a wrong phrase, then a cancel, each run no engine and spend neither the approval nor the plan.
  const applies = () => engineCalls().filter((args) => args[0] === "apply").length;
  const before = applies();
  for (const answer of ["APPLY " + sealed.environment, undefined]) {
    const result = await applyInConsole(port, prepared.files, sealed, [approvalPath], answer);
    assert.notEqual(result.exit, 0);
    assert.notEqual(result.exit, 3, "nothing is spent: " + JSON.stringify(result));
    assert.equal(applies(), before, "no engine ran");
  }
  // Recovery: the same approval still applies, exactly once.
  const applied = await applyInConsole(port, prepared.files, sealed, [approvalPath], applyPhrase(sealed));
  assert.equal(applied.exit, 0, JSON.stringify(applied));
  assert.equal(applies(), before + 1);
}

// Literal titles: config/acceptance/journeys.json cites each one exactly.
test("AWS Terraform in the console: prepare from a project folder, preview, approve and apply through the real router, service and adapter", () => wholeJourneyInConsole("AWS"));
test("AWS Terraform in the console: a wrong phrase or a cancel at approval or apply signs nothing and spends nothing, and the same approval still applies", () => interruptedJourneyInConsole("AWS"));
test("Azure Terraform in the console: prepare from a project folder, preview, approve and apply through the real router, service and adapter", () => wholeJourneyInConsole("AZURE"));
test("Azure Terraform in the console: a wrong phrase or a cancel at approval or apply signs nothing and spends nothing, and the same approval still applies", () => interruptedJourneyInConsole("AZURE"));

/** The first 12 characters of the engine program's sha256, as the review shows it. */
const programId = (): string => createHash("sha256").update(readFileSync(join(toolDir, "terraform"))).digest("hex").slice(0, 12);

test("AWS Terraform in the console: a plan applies only with the engine program that made its preview, and nothing is consumed by a mismatch", async () => {
  const { port, target, project } = await consoleJourney("AWS");
  const { prepared, sealed } = await prepareAndSealInConsole(port, project, target);
  const approvalPath = await approveViaUi(port, sealed, "alice");
  const applies = () => engineCalls().filter((args) => args[0] === "apply").length;
  const before = applies();
  appendFileSync(join(toolDir, "terraform"), "// another build of the program\n");
  try {
    const started = await call(port, "POST", "/pilot/apply", {
      body: { environment: "DEV", requestPath: prepared.files.request, manifestPath: prepared.files.manifest, sealedPath: sealed.path, approvalPaths: [approvalPath] },
    });
    assert.equal(started.status, 202, started.text);
    const refusal = (await finished(port)).run!.result!;
    assert.equal(refusal.exit, 2, JSON.stringify(refusal));
    assert.equal(refusal.code, "ENGINE_BINARY_CHANGED");
    assert.equal(applies(), before, "no engine ran");
  } finally { installFakeTerraform(toolDir); }
  // Nothing was consumed: with the program that made the preview, the same approval applies.
  const applied = await applyInConsole(port, prepared.files, sealed, [approvalPath], applyPhrase(sealed));
  assert.equal(applied.exit, 0, JSON.stringify(applied));
});

test("AWS Terraform in the console: a plan applies only from the product commit that sealed it, and nothing is consumed by a mismatch", async () => {
  const { w, port, target, project } = await consoleJourney("AWS");
  const { prepared, sealed } = await prepareAndSealInConsole(port, project, target);
  const approvalPath = await approveViaUi(port, sealed, "alice");
  const applies = () => engineCalls().filter((args) => args[0] === "apply").length;
  const before = applies();
  // The same files, approvals and vault, from a console running another product commit.
  const other = await serve({ ...w, cli: { ...w.cli, sourceCommit: "1".repeat(40) } });
  await choose(other.port);
  const started = await call(other.port, "POST", "/pilot/apply", {
    body: { environment: "DEV", requestPath: prepared.files.request, manifestPath: prepared.files.manifest, sealedPath: sealed.path, approvalPaths: [approvalPath] },
  });
  assert.equal(started.status, 202, started.text);
  const refusal = (await finished(other.port)).run!.result!;
  assert.equal(refusal.exit, 2, JSON.stringify(refusal));
  assert.equal(refusal.code, "SOURCE_CHANGED");
  assert.equal(applies(), before, "no engine ran");
  // Nothing was consumed: from the sealing commit, the same approval applies.
  const applied = await applyInConsole(port, prepared.files, sealed, [approvalPath], applyPhrase(sealed));
  assert.equal(applied.exit, 0, JSON.stringify(applied));
  assert.equal((applied.data as { sourceCommit: string }).sourceCommit, SOURCE_COMMIT);
});

// --- observe and clean up (docs/observe-and-cleanup.md) --------------------------------------------------------------

// The run's shape for the cleanup journey: two things the plan creates, the state bucket the pilot runs on, and one thing the plan never mentioned.
const CLEANUP_BUCKET = "examplefake-console-logs";
const CLEANUP_LOG = "/alz/console/canary";
const CLEANUP_STATE_BUCKET = AWS_DEV_TARGET.backend.split("/")[0];
const CLEANUP_QUEUE = "https://sqs.us-east-1.amazonaws.com/111111111111/console-preexisting";
const CLEANUP_CREATES = [
  { address: "aws_s3_bucket.logs", type: "aws_s3_bucket", change: { actions: ["create"], before: null, after: {} } },
  { address: "aws_cloudwatch_log_group.canary", type: "aws_cloudwatch_log_group", change: { actions: ["create"], before: null, after: {} } },
  { address: "aws_s3_bucket.state", type: "aws_s3_bucket", change: { actions: ["update"], before: {}, after: {} } },
];
const CLEANUP_STATE = [
  stateResource("aws_s3_bucket", "logs", CLEANUP_BUCKET, "arn:aws:s3:::" + CLEANUP_BUCKET), stateResource("aws_cloudwatch_log_group", "canary", CLEANUP_LOG, "arn:aws:logs:us-east-1:111111111111:log-group:" + CLEANUP_LOG),
  stateResource("aws_s3_bucket", "state", CLEANUP_STATE_BUCKET, "arn:aws:s3:::" + CLEANUP_STATE_BUCKET), stateResource("aws_sqs_queue", "preexisting", CLEANUP_QUEUE, "arn:aws:sqs:us-east-1:111111111111:console-preexisting"),
];
const CLEANUP_EXISTING = [CLEANUP_BUCKET, CLEANUP_LOG, CLEANUP_STATE_BUCKET, CLEANUP_QUEUE];
/** The run's own resources as the tagging API lists them by the change's deletion unit: a listing that is not empty and matches the records. */
const CLEANUP_TAGGED = ["arn:aws:s3:::" + CLEANUP_BUCKET, "arn:aws:logs:us-east-1:111111111111:log-group:" + CLEANUP_LOG];
const CLEANUP_STRAY = "arn:aws:sqs:us-east-1:111111111111:stray-of-this-unit";
/** The deletion unit of the DEV state container under the console's AWS contract: what the fake provider stamps on every created resource. */
const CLEANUP_UNIT = (() => {
  const path = join(fresh("unit-contract"), "act-pilot-contract.json");
  writePinnedContract(path, awsContractJson(KILL, { policyVersion: POLICY }));
  return pilotUnitOf({ provider: "AWS", contractSha256: pilotContractSha256(loadPilotContract(path, pinPathOf(path)) as PilotContract), environment: "DEV", target: awsTargetOf("DEV") });
})();

/** An AWS console journey whose fake engine reports a state, with the fake AWS CLI the verifier reads through, in a second approved tool directory. */
async function cleanupJourney() {
  const journey = await consoleJourney("AWS");
  behaveIn(toolDir, KILL, { applyAdvance: true, showProviderConfig: AWS_PROVIDER_CONFIG, showOnlyConfigured: true, showResources: CLEANUP_CREATES, stateResources: CLEANUP_STATE, unitTags: { ...CLEANUP_UNIT.tags } });
  behaveAwsReads(awsToolDir, { existing: CLEANUP_EXISTING, tagged: CLEANUP_TAGGED });
  // The same console, now able to find the aws program for the read-only verifier.
  const w = { ...journey.w, cli: { ...journey.w.cli, toolDirs: [toolDir, awsToolDir], proposalsDir: fresh("proposals") } };
  const { port } = await serve(w);
  await choose(port);
  return { ...journey, w, port };
}
const cleanupApprovePhrase = (shortId: string) => "APPROVE CLEANUP DEV " + shortId;
const cleanupPhrase = (shortId: string, target: ResolvedTarget) => "CLEANUP DEV " + shortId + " " + targetString(target);
type CleanupSummary = { shortId: string; deletes: { address: string }[]; excluded: { address: string; ownership: string }[]; requiredApprovals: number };

async function approveCleanupViaUi(port: number, proposalPath: string, shortId: string, who: keyof typeof keys, answer?: string | null): Promise<State> {
  const started = await call(port, "POST", "/pilot/approve", { body: { bundlePath: proposalPath, keyPath: keyFile(who), approverId: who } });
  assert.equal(started.status, 202, started.text);
  const asked = await waiting(port);
  assert.equal(asked.run!.dialog!.kind, "APPROVE_CLEANUP", "a cleanup approval has its own dialog");
  assert.equal(asked.run!.dialog!.phrase, cleanupApprovePhrase(shortId));
  if (answer === null) await call(port, "POST", "/pilot/cancel", { body: {} });
  else await call(port, "POST", "/pilot/answer", { body: { dialogId: asked.run!.dialog!.id, answer: answer ?? cleanupApprovePhrase(shortId) } });
  return finished(port);
}
async function cleanupViaUi(port: number, files: { request: string; manifest: string }, sealed: Sealed, proposalPath: string, shortId: string, target: ResolvedTarget, approvals: string[], answer?: string | null): Promise<State> {
  const started = await call(port, "POST", "/pilot/cleanup", { body: { environment: "DEV", requestPath: files.request, manifestPath: files.manifest, sealedPath: sealed.path, proposalPath, approvalPaths: approvals } });
  assert.equal(started.status, 202, started.text);
  const asked = await waiting(port);
  assert.equal(asked.run!.dialog!.kind, "CLEANUP");
  assert.equal(asked.run!.dialog!.phrase, cleanupPhrase(shortId, target));
  if (answer === null) await call(port, "POST", "/pilot/cancel", { body: {} });
  else await call(port, "POST", "/pilot/answer", { body: { dialogId: asked.run!.dialog!.id, answer: answer ?? cleanupPhrase(shortId, target) } });
  return finished(port);
}
async function observeAndProposeInConsole(port: number, sealed: Sealed) {
  assert.equal((await call(port, "POST", "/pilot/observe", { body: { sealedPath: sealed.path } })).status, 202);
  const observed = (await finished(port)).run!.result!;
  assert.equal(observed.exit, 0, JSON.stringify(observed));
  const observation = observed.data as { verdict: string; resources: { address: string; result: string }[]; inventory: string };
  assert.equal((await call(port, "POST", "/pilot/propose-cleanup", { body: { sealedPath: sealed.path } })).status, 202);
  const proposed = (await finished(port)).run!.result!;
  assert.equal(proposed.exit, 0, JSON.stringify(proposed));
  const data = proposed.data as { path: string; proposal: { proposalSha256: string } };
  assert.ok(proposed.cleanup, "the console summarizes the proposal for the person");
  return { observation, proposalPath: data.path, summary: proposed.cleanup as unknown as CleanupSummary };
}

// Literal titles: config/acceptance/journeys.json cites each one exactly.
test("AWS Terraform in the console: observe what the apply created, propose and approve the cleanup, remove exactly that list and verify it is gone, through the real router, service and adapter", async () => {
  const { port, target, project } = await cleanupJourney();
  const { prepared, sealed } = await prepareAndSealInConsole(port, project, target);
  const approvalPath = await approveViaUi(port, sealed, "alice");
  const applied = await applyInConsole(port, prepared.files, sealed, [approvalPath], applyPhrase(sealed));
  assert.equal(applied.exit, 0, JSON.stringify(applied));

  const { observation, proposalPath, summary } = await observeAndProposeInConsole(port, sealed);
  // Everything the state recorded is found under its identifier, and the sweep by the change's deletion-unit tag found
  // nothing else: VERIFIED.
  assert.equal(observation.verdict, "VERIFIED", "found under its identifier, and the unit sweep found nothing else");
  assert.deepEqual(observation.resources.map((r) => [r.address, r.result]).sort(), [
    ["aws_cloudwatch_log_group.canary", "VERIFIED"], ["aws_s3_bucket.logs", "VERIFIED"], ["aws_s3_bucket.state", "VERIFIED"], ["aws_sqs_queue.preexisting", "VERIFIED"],
  ]);
  assert.equal(observation.inventory, "COMPLETE", "the unit sweep covered every page");
  assert.ok(awsReadCallsOf(awsToolDir).every((read) => read.env.AWS_ROLE_ARN === awsRoleArn("DISCOVERY", "DEV")), "the verifier read as DISCOVERY through the runner");
  assert.deepEqual(summary.deletes.map((d) => d.address), ["aws_cloudwatch_log_group.canary", "aws_s3_bucket.logs"]);
  assert.deepEqual(summary.excluded.map((x) => [x.address, x.ownership]), [["aws_s3_bucket.state", "PROTECTED_BACKEND"], ["aws_sqs_queue.preexisting", "NOT_IN_PLAN"]]);
  assert.equal(summary.requiredApprovals, 1);

  // An approver reviews the proposal file the operator sent, and signs it under the cleanup domain.
  const reviewed = (await call(port, "POST", "/pilot/review-cleanup", { body: { proposalPath } })).body;
  assert.equal(reviewed.ok, true, JSON.stringify(reviewed));
  assert.equal(reviewed.cleanup.shortId, summary.shortId);
  assert.ok(Array.isArray(reviewed.cleanup.lines) && reviewed.cleanup.lines.some((line: string) => line.includes("executes as")));
  const signed = await approveCleanupViaUi(port, proposalPath, summary.shortId, "alice");
  assert.equal(signed.run!.result!.exit, 0, JSON.stringify(signed.run!.result));
  const cleanupApproval = signed.run!.result!.savedPath!;
  assert.ok(existsSync(cleanupApproval));

  const before = engineCalls().length;
  const removed = await cleanupViaUi(port, prepared.files, sealed, proposalPath, summary.shortId, target, [cleanupApproval]);
  assert.equal(removed.run!.result!.exit, 0, JSON.stringify(removed.run!.result));
  const evidence = removed.run!.result!.data as { outcome: string; deletes: string[]; authority: { executedAs: string; mutation: string }; artifactSha256: string };
  assert.equal(evidence.outcome, "SUCCEEDED");
  assert.deepEqual(evidence.deletes, ["aws_cloudwatch_log_group.canary", "aws_s3_bucket.logs"]);
  assert.deepEqual(evidence.authority, { infrastructureAct: "PILOT_ENABLED", mutation: "TERRAFORM_DESTROY_OF_APPROVED_PROPOSAL", executedAs: "APPLY", agentInitiated: false });
  assert.equal(evidence.artifactSha256, sealed.artifactSha256);
  const steps = engineCalls().slice(before);
  assert.deepEqual(steps.map((args) => args[0]), ["version", "init", "workspace", "state", "plan", "show", "apply", "state"]);
  assert.deepEqual(steps[4].filter((arg) => arg.startsWith("-target=")), ["-target=aws_cloudwatch_log_group.canary", "-target=aws_s3_bucket.logs"], "the destroy targets exactly the approved list");

  // The independent check: the fake cloud no longer holds what was removed, and nothing carries the unit's tag any more.
  behaveAwsReads(awsToolDir, { existing: [CLEANUP_STATE_BUCKET, CLEANUP_QUEUE], tagged: [] });
  assert.equal((await call(port, "POST", "/pilot/verify-cleanup", { body: { proposalPath } })).status, 202);
  const verified = (await finished(port)).run!.result!;
  assert.equal(verified.exit, 0, JSON.stringify(verified));
  const leftovers = verified.data as { disposition: string; cleanupRan?: boolean; resources: { address: string; disposition: string }[] };
  assert.equal(leftovers.disposition, "COMPLETE");
  assert.deepEqual(leftovers.resources.map((r) => [r.address, r.disposition]), [
    ["aws_cloudwatch_log_group.canary", "CONFIRMED_DELETED"], ["aws_s3_bucket.logs", "CONFIRMED_DELETED"], ["aws_s3_bucket.state", "INTENTIONALLY_RETAINED"], ["aws_sqs_queue.preexisting", "INTENTIONALLY_RETAINED"],
  ]);
  assert.equal(verified.code, "CLEANUP_COMPLETE");
  // Had something else still carried this change's cleanup marker, the check would have found it and not called the cleanup complete.
  behaveAwsReads(awsToolDir, { existing: [CLEANUP_STATE_BUCKET, CLEANUP_QUEUE], tagged: [CLEANUP_STRAY] });
  assert.equal((await call(port, "POST", "/pilot/verify-cleanup", { body: { proposalPath } })).status, 202);
  const strayRun = (await finished(port)).run!.result!;
  assert.equal(strayRun.exit, 0, JSON.stringify(strayRun));
  assert.equal(strayRun.code, "CLEANUP_INCOMPLETE");
  const strayLeftovers = strayRun.data as { disposition: string; resources: { address: string; identifier: string | null; disposition: string }[] };
  assert.equal(strayLeftovers.disposition, "INCOMPLETE");
  assert.deepEqual(strayLeftovers.resources.filter((r) => r.address === "(not in state)").map((r) => [r.identifier, r.disposition]), [[CLEANUP_STRAY, "STILL_PRESENT"]]);
});

test("AWS Terraform in the console: a wrong phrase or a cancel at the cleanup approval or the removal signs nothing and removes nothing, an apply approval never authorizes a cleanup, and a reconnect never removes twice", async () => {
  const { w, port, target, project } = await cleanupJourney();
  const { prepared, sealed } = await prepareAndSealInConsole(port, project, target);
  const approvalPath = await approveViaUi(port, sealed, "alice");
  assert.equal((await applyInConsole(port, prepared.files, sealed, [approvalPath], applyPhrase(sealed))).exit, 0);
  const { proposalPath, summary } = await observeAndProposeInConsole(port, sealed);
  const approvalFiles = () => readdirSync(w.approvals).length;
  const signedBefore = approvalFiles();
  for (const answer of ["APPROVE DEV " + summary.shortId, "APPROVE CLEANUP DEV", null]) {
    const result = (await approveCleanupViaUi(port, proposalPath, summary.shortId, "alice", answer)).run!.result!;
    assert.notEqual(result.exit, 0);
    assert.equal(result.savedPath, undefined);
    assert.equal(approvalFiles(), signedBefore, "nothing was signed");
  }
  const destroys = () => engineCalls().filter((args) => args[0] === "plan" && args[1] === "-destroy").length;
  const applies = () => engineCalls().filter((args) => args[0] === "apply").length;
  const [destroysBefore, appliesBefore] = [destroys(), applies()];
  // The approval of the change itself, offered for the cleanup: refused before any engine runs, and nothing is used up.
  const misused = await cleanupViaUi(port, prepared.files, sealed, proposalPath, summary.shortId, target, [approvalPath]);
  assert.equal(misused.run!.result!.exit, 2, JSON.stringify(misused.run!.result));
  assert.equal(misused.run!.result!.code, "APPROVAL_UNVERIFIED");
  assert.equal(destroys(), destroysBefore);
  const cleanupApproval = (await approveCleanupViaUi(port, proposalPath, summary.shortId, "alice")).run!.result!.savedPath!;
  for (const answer of ["CLEANUP DEV " + summary.shortId, null]) {
    const result = (await cleanupViaUi(port, prepared.files, sealed, proposalPath, summary.shortId, target, [cleanupApproval], answer)).run!.result!;
    assert.notEqual(result.exit, 0);
    assert.notEqual(result.exit, 3, "nothing is spent: " + JSON.stringify(result));
    assert.equal(applies(), appliesBefore, "no destroy applied");
  }
  // The same cleanup approval still works, exactly once; a reconnect that asks again is refused, and the destroy ran once.
  const removed = (await cleanupViaUi(port, prepared.files, sealed, proposalPath, summary.shortId, target, [cleanupApproval])).run!.result!;
  assert.equal(removed.exit, 0, JSON.stringify(removed));
  assert.equal(applies(), appliesBefore + 1);
  const again = (await cleanupViaUi(port, prepared.files, sealed, proposalPath, summary.shortId, target, [cleanupApproval])).run!.result!;
  assert.equal(again.exit, 2, JSON.stringify(again));
  assert.equal(again.code, "PROPOSAL_ALREADY_EXECUTED");
  assert.equal(applies(), appliesBefore + 1, "a reconnect never removes twice");
  // Observing again after the cleanup is safe and reads the cloud again; it never applies.
  behaveAwsReads(awsToolDir, { existing: [CLEANUP_STATE_BUCKET, CLEANUP_QUEUE] });
  assert.equal((await call(port, "POST", "/pilot/observe", { body: { sealedPath: sealed.path } })).status, 202);
  const observed = (await finished(port)).run!.result!;
  assert.equal(observed.exit, 0);
  assert.equal((observed.data as { verdict: string }).verdict, "FAILED", "after the cleanup, the created things are missing from the cloud, and the observation says so");
  assert.equal(applies(), appliesBefore + 1);
});

test("the console refuses a cleanup proposal for the other channel, a malformed one, and a cleanup without approval files, before any command runs", async () => {
  const { port } = await cleanupJourney();
  const malformed = json({ kind: "CLEANUP_PROPOSAL", deletes: "all" }, "proposal");
  const reviewed = (await call(port, "POST", "/pilot/review-cleanup", { body: { proposalPath: malformed } })).body;
  assert.equal(reviewed.ok, false);
  assert.equal(reviewed.code, "PROPOSAL_INVALID");
  const noApprovals = await call(port, "POST", "/pilot/cleanup", { body: { environment: "DEV", requestPath: "/r.json", manifestPath: "/m.json", sealedPath: "/s.json", proposalPath: malformed, approvalPaths: [] } });
  assert.equal(noApprovals.status, 400);
  const noSealed = await call(port, "POST", "/pilot/cleanup", { body: { environment: "DEV", requestPath: "/r.json", manifestPath: "/m.json", proposalPath: malformed, approvalPaths: ["/a.json"] } });
  assert.equal(noSealed.status, 400, "the prepared change file is required: the list is checked against what that change made");
  const extra = await call(port, "POST", "/pilot/cleanup", { body: { environment: "DEV", requestPath: "/r.json", manifestPath: "/m.json", sealedPath: "/s.json", proposalPath: malformed, approvalPaths: ["/a.json"], force: true } });
  assert.equal(extra.status, 400, "no field the step does not take");
  assert.deepEqual(engineCalls().filter((args) => args[0] === "plan" && args[1] === "-destroy"), []);
});
