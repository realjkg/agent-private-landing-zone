import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";

import {
  chooseOperatorJob,
  createLocalOperatorServer,
} from "../src/operator-ui/server.js";

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
    assert.match(html, /SYNTHETIC/);
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
    const foreignHost = await fetch(url + "/state", {
      headers: { host: "untrusted.example" },
    });
    assert.equal(foreignHost.status, 403);
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
