import assert from "node:assert/strict";
import test from "node:test";

import { probeTargetPreflight, REQUIRED_PRIVATE_MODELS } from "../src/qualification/target-preflight.js";

const base = {
  sourceCommit: "a".repeat(40),
  targetHardwareId: "sovereign-lab-01",
  runnerName: "alz-operator-01",
  host: "lab-host",
  memoryBytes: 16 * 1024 ** 3,
  baseUrl: "http://127.0.0.1:11435",
};
const fixtures = REQUIRED_PRIVATE_MODELS.map((name, index) => ({
  name, model: name, digest: String(index + 1).repeat(64), size: 2_000_000_000,
}));
function localFetcher(overrides: {
  version?: string;
  models?: unknown[];
} = {}): typeof fetch {
  const fake = (async (url: string | URL | Request) => {
    const address = String(url);
    if (address.endsWith("/api/version")) {
      return Response.json({ version: overrides.version ?? "0.40.0" });
    }
    if (address.endsWith("/api/tags")) {
      return Response.json({ models: overrides.models ?? fixtures });
    }
    throw new Error("UNEXPECTED_REQUEST");
  });
  return fake as typeof fetch;
}
test("isolated target preflight proves local version and exact three model digests", async () => {
  const actual = await probeTargetPreflight(base, localFetcher());
  assert.equal(actual.passed, true);
  assert.equal(actual.runtimeVersion, "0.40.0");
  assert.equal(actual.models.length, 3);
  assert.equal(actual.checks.filter((x) => !x.passed).length, 0);
  assert.equal(actual.sourceCommit, base.sourceCommit);
  assert.equal(actual.actualModelInference, "NOT_RUN");
  assert.equal(actual.actualCloudProviderPreview, "NOT_RUN");
  assert.equal(actual.infrastructureAct, "DISABLED");
  assert.match(actual.hostFingerprint, /^[a-f0-9]{64}$/);
});
test("preflight never calls the network for non-loopback or invalid target", async () => {
  let calls = 0;
  const deny: typeof fetch = (async () => {
    calls += 1;
    throw new Error("NETWORK_MUST_NOT_BE_TOUCHED");
  }) as typeof fetch;
  for (const item of [
    { ...base, baseUrl: "https://api.ollama.com" },
    { ...base, baseUrl: "http://10.0.0.2:11434" },
    { ...base, baseUrl: "http://127.0.0.1:11435/api/tags" },
    { ...base, baseUrl: "http://username:password@localhost:11435" },
    { ...base, targetHardwareId: "UNKNOWN" },
    { ...base, runnerName: "UNKNOWN" },
    { ...base, sourceCommit: "uncommitted" },
    { ...base, skipLocalModel: true },
  ]) {
    const result = await probeTargetPreflight(item, deny);
    assert.equal(result.passed, false);
  }
  assert.equal(calls, 0);
});
test("preflight refuses wrong Ollama version and missing/ambiguous model tags", async () => {
  const stale = await probeTargetPreflight(base, localFetcher({ version: "0.39.0" }));
  assert.equal(stale.passed, false);
  assert.equal(stale.models.length, 0);
  const missing = await probeTargetPreflight(base, localFetcher({
    models: fixtures.slice(0, 2),
  }));
  assert.equal(missing.passed, false);
  assert.equal(missing.models.length, 2);
  const duplicates = await probeTargetPreflight(base, localFetcher({
    models: [fixtures[0], fixtures[0], ...fixtures.slice(1)],
  }));
  assert.equal(duplicates.passed, false);
  const invalidDigest = await probeTargetPreflight(base, localFetcher({
    models: [{ ...fixtures[0], digest: "xyz" }, ...fixtures.slice(1)],
  }));
  assert.equal(invalidDigest.passed, false);
});
test("unavailable Ollama remains BLOCKED and yields no false runtime evidence", async () => {
  const unavailable: typeof fetch = (async () => {
    throw new Error("CONNECTION_REFUSED");
  }) as typeof fetch;
  const report = await probeTargetPreflight(base, unavailable);
  assert.equal(report.passed, false);
  assert.equal(report.runtimeVersion, "NOT_RUN");
  assert.equal(report.models.length, 0);
  assert.equal(report.actualModelInference, "NOT_RUN");
});
