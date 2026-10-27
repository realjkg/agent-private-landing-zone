import assert from "node:assert/strict";
import { once } from "node:events";
import { request as httpRequest } from "node:http";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  chooseOperatorJob,
  createLocalOperatorServer,
  missingWorkspaceBuild,
  readBlockReason,
  readRecoveryVerification,
} from "../src/operator-ui/server.js";
import { probeLocalModels } from "../src/operator-ui/model-availability.js";

test("browser only advertises existing bounded qualification commands", () => {
  const offline = chooseOperatorJob("matrix-offline", "all");
  assert.deepEqual(offline.args, ["--offline-fixture"]);
  assert.equal(offline.script, "cli/private-agent-matrix.js");
  const live = chooseOperatorJob("matrix-live", "terraform-aws-brownfield");
  assert.deepEqual(live.args,
    ["--live-models", "--scenario", "terraform-aws-brownfield"]);
  assert.equal(chooseOperatorJob("chaos", "all").script, "cli/chaos-pillars.js");
  assert.deepEqual(chooseOperatorJob("aws-review", "").args, ["--live-models"]);
  for (const [mode, scenario] of [
    ["shell", "all"], ["matrix-live", "--terraform-apply"],
    ["chaos", "terraform-aws-brownfield"],
    ["aws-review", "azure-apply"],
  ]) {
    assert.throws(() => chooseOperatorJob(mode, scenario));
  }
});

test("localhost workspace rejects foreign hosts and origin, and needs CSRF to run", async () => {
  let calls = 0;
  const { server } = createLocalOperatorServer({
    root: process.cwd(),
    runner: async () => { calls += 1; return "SYNTHETIC PASS / ACT DISABLED"; },
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("ADDRESS_UNAVAILABLE");
    const url = "http://127.0.0.1:" + address.port;
    const page = await fetch(url);
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /Private Agent Workspace/);
    assert.match(html, /LOCAL/);
    assert.match(html, /synthetic/i);
    const token = html.match(/name="token" value="([0-9a-f]{48})"/)?.[1];
    assert.ok(token, "CSRF token must be present");
    const payload = (tokenValue: string) => new URLSearchParams({
      mode: "matrix-offline", scenario: "all", token: tokenValue,
    });
    const denied = await fetch(url + "/run", {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: payload("fake"),
    });
    assert.equal(denied.status, 403);
    const foreign = await fetch(url + "/run", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded",
        origin: "https://untrusted.example" },
      body: payload(token),
    });
    assert.equal(foreign.status, 403);
    const foreignHostStatus = await new Promise<number>((resolve, reject) => {
      const request = httpRequest(url + "/state", {
        headers: { Host: "untrusted.example" },
      }, (response) => {
        response.resume();
        response.on("end", () => resolve(response.statusCode ?? 0));
      });
      request.on("error", reject);
      request.end();
    });
    assert.equal(foreignHostStatus, 403);
    assert.equal(calls, 0);
    const start = await fetch(url + "/run", {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: payload(token),
    });
    assert.equal(start.status, 202);
    const status = await fetch(url + "/state");
    const result = await status.json() as { status: string; evidenceBasis: string; output: string };
    assert.equal(result.status, "PASS");
    assert.match(result.evidenceBasis, /NO LOCAL MODEL INFERENCE/);
    assert.match(result.output, /ACT DISABLED/);
    assert.equal(calls, 1);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => error ? reject(error) : resolve()));
  }
});

test("failed runner preserves BLOCKED and cannot imply deployment", async () => {
  const { server } = createLocalOperatorServer({
    root: process.cwd(),
    runner: async () => { throw new Error("MODEL_MISSING"); },
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("ADDRESS_UNAVAILABLE");
    const url = "http://127.0.0.1:" + address.port;
    const html = await (await fetch(url)).text();
    const token = html.match(/name="token" value="([0-9a-f]{48})"/)?.[1] ?? "";
    const response = await fetch(url + "/run", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ mode: "aws-review", scenario: "all", token }),
    });
    assert.equal(response.status, 202);
    const report = await (await fetch(url + "/state")).json() as { status: string; output: string };
    assert.equal(report.status, "BLOCKED");
    assert.match(report.output, /MODEL_MISSING/);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

async function withServer(
  options: Omit<Parameters<typeof createLocalOperatorServer>[0], "root">,
  body: (url: string, token: string) => Promise<void>,
): Promise<void> {
  const { server } = createLocalOperatorServer({ root: process.cwd(), ...options });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("ADDRESS_UNAVAILABLE");
    const url = "http://127.0.0.1:" + address.port;
    const html = await (await fetch(url)).text();
    const token = html.match(/name="token" value="([0-9a-f]{48})"/)?.[1] ?? "";
    await body(url, token);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

const startRun = (url: string, token: string, mode: string) => fetch(url + "/run", {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ mode, scenario: "all", token }),
});

test("recovery verification is read only from the workflow's literal line", () => {
  assert.equal(readRecoveryVerification("x\nRecovery verification: BLOCKED\ny"), "BLOCKED");
  assert.equal(readRecoveryVerification("Recovery verification: VERIFIED"), "VERIFIED");
  assert.equal(readRecoveryVerification("Recovery verification: PARTIAL"), "PARTIAL");
  assert.equal(readRecoveryVerification("no such line"), "NOT_REPORTED");
  // Anything but the exact vocabulary on its own line is not a report.
  assert.equal(readRecoveryVerification("Recovery verification: VERIFIED-ish"), "NOT_REPORTED");
  assert.equal(readRecoveryVerification("echo Recovery verification: VERIFIED"), "NOT_REPORTED");
});

test("a resilience PASS carries its own recovery verification; other workflows carry none", async () => {
  const chaosOutput = "RECOVERY / MISSING_BACKUP: CONTAINED\n" +
    "Recovery verification: BLOCKED\nRestore: NOT RUN; cloud changes: NONE; ACT: DISABLED";
  await withServer({ runner: async (job) =>
    job.mode === "chaos" ? chaosOutput : "SYNTHETIC PASS" }, async (url, token) => {
    assert.equal((await startRun(url, token, "chaos")).status, 202);
    const chaos = await (await fetch(url + "/state")).json() as Record<string, unknown>;
    assert.equal(chaos.status, "PASS");
    assert.equal(chaos.recoveryVerification, "BLOCKED");

    assert.equal((await startRun(url, token, "matrix-offline")).status, 202);
    const matrix = await (await fetch(url + "/state")).json() as Record<string, unknown>;
    assert.equal(matrix.status, "PASS");
    assert.equal("recoveryVerification" in matrix, false);
  });
});

test("a blocked resilience run without a report says NOT_REPORTED, never VERIFIED", async () => {
  await withServer({ runner: async () => { throw new Error("WORKFLOW_BLOCKED_EXIT_1"); } },
    async (url, token) => {
      assert.equal((await startRun(url, token, "chaos")).status, 202);
      const state = await (await fetch(url + "/state")).json() as Record<string, unknown>;
      assert.equal(state.status, "BLOCKED");
      assert.equal(state.recoveryVerification, "NOT_REPORTED");
    });
});

test("GET /models is advisory: it reports availability and never gates POST /run", async () => {
  let probes = 0;
  let runs = 0;
  await withServer({
    modelProbe: async () => {
      probes += 1;
      return { status: "UNAVAILABLE", reason: "NO_LOCAL_MODEL_SERVER",
        required: ["qwen3:1.7b"], missing: [] };
    },
    runner: async () => { runs += 1; return "ok"; },
  }, async (url, token) => {
    const models = await (await fetch(url + "/models")).json() as Record<string, unknown>;
    assert.equal(models.status, "UNAVAILABLE");
    assert.equal(models.reason, "NO_LOCAL_MODEL_SERVER");
    // The run path is unchanged: validation still decides, not the probe.
    assert.equal((await startRun(url, token, "matrix-live")).status, 202);
    assert.equal(runs, 1);
    assert.equal(probes, 1);
    // The localhost-only guard covers the new route too.
    const foreign = await fetch(url + "/models", { headers: { origin: "https://untrusted.example" } });
    assert.equal(foreign.status, 403);
    assert.equal(probes, 1);
  });
});

test("model probe mirrors the live workflows' own preconditions", async () => {
  const env = {
    OLLAMA_BASE_URL: "http://127.0.0.1:11434",
    ROUTER_MODEL: "qwen3:1.7b", PRIMARY_MODEL: "qwen3:4b",
    VALIDATOR_MODEL: "mistral-nemo:latest",
  };
  const digest = "a".repeat(64);
  const inventory = (names: string[]) => (async () => new Response(JSON.stringify({
    models: names.map((name) => ({ name, model: name, digest })),
  }))) as unknown as typeof fetch;
  const neverCalled = (async () => {
    throw new Error("PROBE_MUST_NOT_FETCH");
  }) as unknown as typeof fetch;

  const ready = await probeLocalModels({ env,
    fetcher: inventory(["qwen3:1.7b", "qwen3:4b", "mistral-nemo:latest"]) });
  assert.deepEqual([ready.status, ready.reason], ["AVAILABLE", "READY"]);

  const partial = await probeLocalModels({ env, fetcher: inventory(["qwen3:4b"]) });
  assert.deepEqual([partial.status, partial.reason], ["UNAVAILABLE", "MODELS_NOT_INSTALLED"]);
  assert.deepEqual(partial.missing, ["qwen3:1.7b", "mistral-nemo:latest"]);

  const down = await probeLocalModels({ env, fetcher: (async () => {
    throw new TypeError("fetch failed");
  }) as unknown as typeof fetch });
  assert.deepEqual([down.status, down.reason], ["UNAVAILABLE", "NO_LOCAL_MODEL_SERVER"]);

  const broken = await probeLocalModels({ env,
    fetcher: (async () => new Response("nope", { status: 500 })) as unknown as typeof fetch });
  assert.equal(broken.reason, "MODEL_INVENTORY_UNAVAILABLE");

  // Off-machine or credentialed endpoints are never probed.
  for (const OLLAMA_BASE_URL of ["http://10.0.0.5:11434", "https://127.0.0.1:11434",
    "http://user:pw@127.0.0.1:11434", "not a url"]) {
    const remote = await probeLocalModels({ env: { ...env, OLLAMA_BASE_URL }, fetcher: neverCalled });
    assert.deepEqual([remote.status, remote.reason], ["UNAVAILABLE", "MODEL_ENDPOINT_NOT_LOOPBACK"]);
  }
  const disabled = await probeLocalModels({ env: { ...env, AGENT_SKIP_LOCAL_MODEL: "1" },
    fetcher: neverCalled });
  assert.deepEqual([disabled.status, disabled.reason], ["UNAVAILABLE", "LIVE_MODELS_DISABLED"]);
});

test("a failing model probe answers 503 instead of hanging the console", async () => {
  await withServer({ modelProbe: async () => { throw new Error("PROBE_BROKE"); } },
    async (url) => {
      const response = await fetch(url + "/models");
      assert.equal(response.status, 503);
      assert.deepEqual(await response.json(), { error: "MODEL_PROBE_FAILED" });
    });
});

test("only known local setup states become a block reason", () => {
  assert.equal(readBlockReason("WORKFLOW_BLOCKED_EXIT_1\nMATRIX_BLOCKED: SOURCE_WORKTREE_DIRTY"),
    "SOURCE_WORKTREE_DIRTY");
  assert.equal(readBlockReason("SOURCE_WORKTREE_DIRTY: qualify from a clean commit"),
    "SOURCE_WORKTREE_DIRTY");
  assert.equal(readBlockReason("WORKSPACE_NEEDS_BUILD"), "WORKSPACE_NEEDS_BUILD");
  assert.equal(readBlockReason("QUALIFICATION_BLOCKED: fetch failed"), undefined);
  assert.equal(readBlockReason("NOT_SOURCE_WORKTREE_DIRTYISH"), undefined);
});

test("a blocked run carries its setup reason; other failures carry none", async () => {
  let failure = "WORKFLOW_BLOCKED_EXIT_1\nMATRIX_BLOCKED: SOURCE_WORKTREE_DIRTY";
  await withServer({ runner: async () => { throw new Error(failure); } }, async (url, token) => {
    assert.equal((await startRun(url, token, "matrix-offline")).status, 202);
    const dirty = await (await fetch(url + "/state")).json() as Record<string, unknown>;
    assert.equal(dirty.status, "BLOCKED");
    assert.equal(dirty.blockReason, "SOURCE_WORKTREE_DIRTY");
    failure = "QUALIFICATION_BLOCKED: fetch failed";
    assert.equal((await startRun(url, token, "aws-review")).status, 202);
    const other = await (await fetch(url + "/state")).json() as Record<string, unknown>;
    assert.equal(other.status, "BLOCKED");
    assert.equal("blockReason" in other, false);
  });
});

test("workspace readiness names the console build and every job script", () => {
  const root = mkdtempSync(join(tmpdir(), "alz-readiness-"));
  try {
    const missing = missingWorkspaceBuild(root);
    assert.deepEqual(missing, [
      "dist/operator-ui/app/index.html",
      "dist/cli/private-agent-matrix.js",
      "dist/cli/qualify-aws-terraform-agent.js",
      "dist/cli/chaos-pillars.js",
    ]);
    for (const path of missing) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), "");
    }
    assert.deepEqual(missingWorkspaceBuild(root), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("bootstrap builds the console UI as well as the runtime", () => {
  const launcher = readFileSync("alz", "utf8");
  const bootstrap = launcher.slice(launcher.indexOf('"bootstrap"'), launcher.indexOf("exit 0"));
  // The runtime step is the compile alone (`build:runtime`, no marker); bootstrap writes the marker itself after the UI build.
  assert.match(bootstrap, /npm run build:runtime\n/);
  assert.match(bootstrap, /npm run build:ui\n/);
  assert.match(bootstrap, /write_build_marker\n/);
  assert.doesNotMatch(bootstrap, /^\s+npm run build\n|^\s+npm run build:complete\b/m, "no step inside bootstrap writes the marker before the last one");
});

// --- the launcher, executed --------------------------------------------------------------------------------------
// A copy of ./alz in a temporary checkout, with a fake dist/, a fake npm and a fake git on a private PATH. Nothing real
// is built, and the real .runs folder is never touched. Synthetic: this qualifies the launcher's logic, not a platform.

type Launcher = { root: string; bin: string; run: (args: string[], env?: Record<string, string>) => ReturnType<typeof spawnSync> };

function launcher(label: string, npmScript: string): Launcher {
  const root = mkdtempSync(join(tmpdir(), "alz-launcher-" + label + "-"));
  const bin = join(root, "fake-bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(root, "alz"), readFileSync("alz", "utf8"));
  chmodSync(join(root, "alz"), 0o755);
  // The fake git answers only `rev-parse HEAD`, with the commit the test chooses through FAKE_COMMIT.
  writeFileSync(join(bin, "git"), "#!/bin/sh\necho \"${FAKE_COMMIT:-unknown}\"\n");
  // The fake npm's `run build:runtime` writes dist/ like the real compile (no marker), and `run build` adds the marker like the
  // real build does after a successful compile; then the test's own script runs.
  writeFileSync(join(bin, "npm"), "#!/bin/sh\necho \"npm $*\"\n" +
    'case "$*" in "run build:runtime"|"run build") rm -f dist/.alz-build-complete; mkdir -p dist/cli; echo "console.log(\'operator ran \' + process.argv.slice(2).join(\' \'))" > dist/cli/operator.js ;; esac\n' +
    'case "$*" in "run build") printf \'{"schemaVersion":1,"sourceCommit":"%s"}\\n\' "${FAKE_COMMIT:-unknown}" > dist/.alz-build-complete ;; esac\n' +
    npmScript + "\nexit 0\n");
  chmodSync(join(bin, "git"), 0o755);
  chmodSync(join(bin, "npm"), 0o755);
  const run: Launcher["run"] = (args, env = {}) => spawnSync("bash", [join(root, "alz"), ...args], {
    encoding: "utf8", cwd: root,
    env: { PATH: bin + ":" + dirname(process.execPath) + ":/usr/bin:/bin", HOME: root, FAKE_COMMIT: "c0ffee", ...env },
  });
  return { root, bin, run };
}

function fakeDist(root: string, marker = true): void {
  mkdirSync(join(root, "dist", "cli"), { recursive: true });
  writeFileSync(join(root, "dist", "cli", "operator.js"), "console.log('operator ran ' + process.argv.slice(2).join(' '));\n");
  if (marker) writeFileSync(join(root, "dist", ".alz-build-complete"), JSON.stringify({ schemaVersion: 1, sourceCommit: "c0ffee" }) + "\n");
  else rmSync(join(root, "dist", ".alz-build-complete"), { force: true });
}

const REFUSAL = /^The local build is not ready: \.\/alz bootstrap did not finish, or the source changed after it ran\.\nRun: \.\/alz bootstrap\n/;

const stateOf = (root: string): { startedAt: string; step: string; completedAt: string | null; sourceCommit: string } =>
  JSON.parse(readFileSync(join(root, ".runs", "bootstrap", "state.json"), "utf8"));

test("./alz refuses to run dist/ while the bootstrap state is unfinished or from another commit, and runs it when the state is finished or absent", () => {
  const { root, run } = launcher("gate", "exit 0");
  try {
    fakeDist(root);
    // No state file but the build's own marker: a released archive or CI's own npm build runs as before.
    let result = run(["help"]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /operator ran help/);
    // No state file and no marker: an unfinished build whose .runs/ was deleted is refused, in two lines.
    fakeDist(root, false);
    result = run(["help"]);
    assert.equal(result.status, 2);
    assert.doesNotMatch(result.stdout, /operator ran/);
    assert.match(result.stdout, REFUSAL);
    assert.equal(result.stdout.split("\n").filter(Boolean).length, 2, "exactly two lines, whatever tools exist");
    // A marker from another commit than the checkout's is a stale build: refused. An archive (no checkout) says "unknown" and runs.
    fakeDist(root);
    result = run(["help"], { FAKE_COMMIT: "deadbeef" });
    assert.equal(result.status, 2, "the marker names c0ffee, the checkout is at deadbeef");
    assert.match(result.stdout, REFUSAL);
    result = run(["help"], { FAKE_COMMIT: "unknown" });
    assert.equal(result.status, 0, "no checkout: the marker's commit cannot be compared, so the build runs");
    writeFileSync(join(root, "dist", ".alz-build-complete"), JSON.stringify({ schemaVersion: 1, sourceCommit: "unknown" }) + "\n");
    result = run(["help"]);
    assert.equal(result.status, 0, "an archive's marker says unknown and runs in a checkout too");
    writeFileSync(join(root, "dist", ".alz-build-complete"), "not json");
    assert.equal(run(["help"]).status, 2, "an unreadable marker is refused");
    fakeDist(root);
    mkdirSync(join(root, ".runs", "bootstrap"), { recursive: true });
    const state = join(root, ".runs", "bootstrap", "state.json");
    const unfinished = { startedAt: "2026-10-27T00:00:00Z", step: "npm run build", completedAt: null, sourceCommit: "c0ffee" };
    for (const [label, content] of [
      ["unfinished", JSON.stringify(unfinished)],
      ["another commit", JSON.stringify({ ...unfinished, completedAt: "2026-10-27T00:05:00Z", sourceCommit: "0ld" })],
      ["unreadable", "not json"],
      ["empty completedAt", JSON.stringify({ ...unfinished, completedAt: "" })],
    ] as const) {
      writeFileSync(state, content);
      result = run(["help"]);
      assert.equal(result.status, 2, label);
      assert.doesNotMatch(result.stdout, /operator ran/, label + ": dist/ is never run");
      assert.match(result.stdout, REFUSAL, label);
    }
    writeFileSync(state, JSON.stringify({ ...unfinished, completedAt: "2026-10-27T00:05:00Z" }));
    result = run(["help"]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /operator ran help/);
    // The same finished state is stale once the checkout moves to another commit.
    result = run(["help"], { FAKE_COMMIT: "deadbeef" });
    assert.equal(result.status, 2);
    assert.match(result.stdout, /Run: \.\/alz bootstrap/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("./alz bootstrap records its state before the first step, completes it only at the end, and keeps the log when it fails or is stopped", () => {
  // A fake npm that stops the bootstrap at the build step the way Ctrl-C or a closed terminal would: a stop signal to the launcher.
  const stopped = launcher("stopped", 'case "$*" in "run build:runtime") kill -TERM $PPID ;; esac\nexit 0');
  try {
    const result = stopped.run(["bootstrap"]);
    assert.notEqual(result.status, 0, "a stopped bootstrap never reports success");
    assert.match(result.stdout, /Local setup did not finish\. Review \.runs\/bootstrap\/latest\.log, then run \.\/alz bootstrap again\.\nNo infrastructure changes were made\.\n/);
    assert.doesNotMatch(result.stdout, /Ready\./);
    assert.equal(result.stdout.split("\n").filter(Boolean).length, 3, "the terminal output stays short: the banner and two lines");
    const state = stateOf(stopped.root);
    assert.equal(state.completedAt, null, "an interrupted bootstrap is never marked finished");
    assert.equal(state.step, "npm run build", "the step that was running is recorded");
    assert.equal(state.sourceCommit, "c0ffee");
    assert.match(state.startedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    const latest = readFileSync(join(stopped.root, ".runs", "bootstrap", "latest.log"), "utf8");
    assert.match(latest, /npm ci\nnpm run build:runtime\n/, "the detailed log is kept even when the run is stopped");
    fakeDist(stopped.root);
    const refused = stopped.run(["help"]);
    assert.equal(refused.status, 2, "a partial dist/ left by the stopped bootstrap is refused");
    assert.match(refused.stdout, /did not finish/);
  } finally {
    rmSync(stopped.root, { recursive: true, force: true });
  }

  // A failing step is recorded the same way; a finished bootstrap completes the state and ./alz then runs dist/.
  const failing = launcher("failing", 'case "$*" in "run build:ui") exit 7 ;; esac\nexit 0');
  try {
    const result = failing.run(["bootstrap"]);
    assert.equal(result.status, 7, "the failing step's exit code is kept");
    assert.match(result.stdout, /Local setup did not finish/);
    assert.equal(stateOf(failing.root).step, "npm run build:ui");
    assert.equal(stateOf(failing.root).completedAt, null);
    assert.ok(existsSync(join(failing.root, ".runs", "bootstrap", "latest.log")));
  } finally {
    rmSync(failing.root, { recursive: true, force: true });
  }
  const finished = launcher("finished", "exit 0");
  try {
    const result = finished.run(["bootstrap"]);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /Preparing Sovereign ALZ local model interface\.\.\.\nReady\. Open the private local workspace with \.\/alz\nDetailed build log: \.runs\/bootstrap\/latest\.log\n/);
    const state = stateOf(finished.root);
    assert.equal(state.step, "done");
    const marker = JSON.parse(readFileSync(join(finished.root, "dist", ".alz-build-complete"), "utf8")) as Record<string, unknown>;
    assert.deepEqual(marker, { schemaVersion: 1, sourceCommit: "c0ffee" }, "the build marker is written last, for the bootstrapped commit, with no timestamp");
    assert.match(readFileSync(join(finished.root, ".runs", "bootstrap", "latest.log"), "utf8"), /npm ci\nnpm run build:runtime\nnpm run build:ui\n/, "bootstrap compiles without a marker and writes it itself at the end");
    assert.match(state.completedAt!, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    assert.equal(state.sourceCommit, "c0ffee");
    assert.match(readFileSync(join(finished.root, ".runs", "bootstrap", "latest.log"), "utf8"), /npm ci\nnpm run build:runtime\nnpm run build:ui\n/);
    fakeDist(finished.root);
    const ran = finished.run(["help"]);
    assert.equal(ran.status, 0);
    assert.match(ran.stdout, /operator ran help/);
  } finally {
    rmSync(finished.root, { recursive: true, force: true });
  }
});

test("a build whose .runs/ was deleted while it was half done is still refused: dist/ carries its own completion marker", () => {
  // The fake npm's build step writes dist/ and its marker (as the real one does); bootstrap removes the marker again before the
  // UI step, which moves .runs/ away and fails, as an operator clearing logs mid-build and a failing build would.
  const half = launcher("half", 'case "$*" in "run build:ui") mv .runs .runs-moved; exit 1 ;; esac');
  try {
    const result = half.run(["bootstrap"]);
    assert.equal(result.status, 1);
    assert.match(result.stdout, /Local setup did not finish/);
    assert.ok(existsSync(join(half.root, "dist", "cli", "operator.js")), "the partial dist/ is there");
    assert.ok(!existsSync(join(half.root, "dist", ".alz-build-complete")), "its marker is not");
    assert.ok(!existsSync(join(half.root, ".runs", "bootstrap", "state.json")), "and the state file is gone");
    const refused = half.run(["help"]);
    assert.equal(refused.status, 2, "no state and no marker: refused, never run");
    assert.doesNotMatch(refused.stdout, /operator ran/);
    assert.match(refused.stdout, REFUSAL);
    // A new bootstrap that finishes writes both again, and ./alz runs.
    writeFileSync(join(half.bin, "npm"), readFileSync(join(half.bin, "npm"), "utf8").replace('mv .runs .runs-moved; exit 1', "exit 0"));
    assert.equal(half.run(["bootstrap"]).status, 0);
    assert.match(half.run(["help"]).stdout, /operator ran help/);
  } finally {
    rmSync(half.root, { recursive: true, force: true });
  }
});

test("bootstrap killed between its compile and its UI build leaves no marker, even with .runs/ deleted: the next ./alz is refused", () => {
  // The fake npm's compile step has finished (dist/ exists), and the launcher is stopped before the UI step starts.
  const gap = launcher("gap", 'case "$*" in "run build:ui") mv .runs .runs-moved; kill -TERM $PPID ;; esac\nexit 0');
  try {
    const result = gap.run(["bootstrap"]);
    assert.notEqual(result.status, 0);
    assert.ok(existsSync(join(gap.root, "dist", "cli", "operator.js")), "the compile's output is there");
    assert.ok(!existsSync(join(gap.root, "dist", ".alz-build-complete")), "the compile wrote no marker");
    assert.ok(!existsSync(join(gap.root, ".runs", "bootstrap", "state.json")), "and the state is gone");
    const refused = gap.run(["help"]);
    assert.equal(refused.status, 2);
    assert.match(refused.stdout, REFUSAL);
  } finally {
    rmSync(gap.root, { recursive: true, force: true });
  }
});

test("a stale marker never survives a failed build: npm run build removes it before compiling, and a failing compile writes none", () => {
  // The real package.json scripts, run against a temporary checkout copy with a fake tsc that fails, so nothing real is built.
  const root = mkdtempSync(join(tmpdir(), "alz-build-fail-"));
  try {
    const pkg = JSON.parse(readFileSync("package.json", "utf8")) as { scripts: Record<string, string> };
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "fake", version: "0.0.0", scripts: { build: pkg.scripts.build, "build:runtime": pkg.scripts["build:runtime"], "build:complete": pkg.scripts["build:complete"], "build:ui": pkg.scripts["build:ui"] } }));
    mkdirSync(join(root, "dist"), { recursive: true });
    writeFileSync(join(root, "dist", ".alz-build-complete"), JSON.stringify({ schemaVersion: 1, sourceCommit: "stale" }) + "\n");
    const bin = join(root, "fake-bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "tsc"), "#!/bin/sh\nmkdir -p dist; echo partial > dist/partial.js; exit 2\n");
    chmodSync(join(bin, "tsc"), 0o755);
    // The fake bin comes first, so its tsc and vite shadow the real ones; npm itself comes from this test's own PATH.
    const env = { ...process.env, PATH: bin + ":" + (process.env.PATH ?? ""), HOME: root };
    const failed = spawnSync("npm", ["run", "build"], { cwd: root, encoding: "utf8", env });
    assert.notEqual(failed.status, 0, failed.stdout + failed.stderr);
    assert.ok(existsSync(join(root, "dist", "partial.js")), "the failing compile still emitted");
    assert.ok(!existsSync(join(root, "dist", ".alz-build-complete")), "the stale marker is gone and no new one was written");
    // A compile that succeeds writes the marker, for this checkout's commit ("unknown" outside git), with no timestamp.
    writeFileSync(join(bin, "tsc"), "#!/bin/sh\nexit 0\n");
    const ok = spawnSync("npm", ["run", "build"], { cwd: root, encoding: "utf8", env });
    assert.equal(ok.status, 0, ok.stdout + ok.stderr);
    assert.deepEqual(JSON.parse(readFileSync(join(root, "dist", ".alz-build-complete"), "utf8")), { schemaVersion: 1, sourceCommit: "unknown" });
    // The UI build removes it before it starts, so a partial UI never carries one; a fake vite that fails leaves none.
    writeFileSync(join(bin, "vite"), "#!/bin/sh\nexit 3\n");
    chmodSync(join(bin, "vite"), 0o755);
    const ui = spawnSync("npm", ["run", "build:ui"], { cwd: root, encoding: "utf8", env });
    assert.notEqual(ui.status, 0);
    assert.ok(!existsSync(join(root, "dist", ".alz-build-complete")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
