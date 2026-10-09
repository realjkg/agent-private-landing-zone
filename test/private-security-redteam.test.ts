import assert from "node:assert/strict";
import test from "node:test";

import { runPrivateSecurityAdversarialMatrix } from "../src/qualification/private-security-redteam.js";

const sourceCommit = "a".repeat(40);

test("private adversarial campaign blocks known injection and privilege-escalation corpus", async () => {
  const originalFetch = globalThis.fetch;
  let networkCalls = 0;
  globalThis.fetch = (async () => {
    networkCalls++;
    throw new Error("SECURITY_TEST_NETWORK_USE_FORBIDDEN");
  }) as typeof fetch;
  try {
    const report = await runPrivateSecurityAdversarialMatrix(sourceCommit);
    assert.equal(report.passed, true, JSON.stringify(
      report.cases.filter((item) => item.result === "FAILED")));
    assert.deepEqual(report.totals, { cases: 49, passed: 49, failed: 0 });
    assert.equal(new Set(report.cases.map((item) => item.id)).size, 49);
    assert.equal(report.cases.filter((item) =>
      item.category === "PROMPT").length, 16);
    assert.equal(report.cases.filter((item) =>
      item.category === "BROKER").length, 12);
    assert.equal(report.cases.filter((item) =>
      item.category === "LEASE_PRIVILEGE").length, 14);
    assert.equal(report.cases.filter((item) =>
      item.category === "UNTRUSTED_CONTENT").length, 3);
    assert.equal(report.cases.filter((item) =>
      item.category === "DATA_EGRESS").length, 2);
    assert.equal(report.cases.filter((item) =>
      item.category === "CONTROL").length, 2);
    assert.ok(report.cases.every((item) => item.sourceCommit === sourceCommit &&
      /^[a-f0-9]{64}$/.test(item.evidenceHash)));
    assert.equal(report.cloudActionsExecuted, 0);
    assert.equal(report.noOpenAiCalls, true);
    assert.equal(report.noExternalNetwork, true);
    assert.equal(report.modelInference, "NOT_RUN");
    assert.equal(report.liveLeaseIssuer, "NOT_RUN");
    assert.equal(networkCalls, 0);
    assert.match(report.evidenceHash, /^[a-f0-9]{64}$/);
    for (const item of report.cases.filter((c) => c.category !== "CONTROL")) {
      assert.notEqual(item.observed, "ALLOWED", item.id);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("security corpus requires a pinned source identity", async () => {
  await assert.rejects(
    runPrivateSecurityAdversarialMatrix("dirty-working-directory"),
    /SECURITY_MATRIX_EXACT_SOURCE_COMMIT_REQUIRED/,
  );
});
