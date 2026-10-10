import assert from "node:assert/strict";
import { once } from "node:events";
import { request as httpRequest } from "node:http";
import test from "node:test";

import {
  chooseOperatorJob,
  createLocalOperatorServer,
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
