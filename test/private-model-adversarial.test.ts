import assert from "node:assert/strict";
import test from "node:test";

import {
  adversarialModelProbes, requireLoopbackOllama,
  runPrivateModelAdversarialQualification,
  QUALIFIED_MODEL_TAGS, type LiveAdversarialDeps,
} from "../src/qualification/private-model-adversarial.js";

const sourceCommit = "a".repeat(40);
const input = {
  sourceCommit, targetHardwareId: "test-private-node-01",
  runnerName: "unit-test-runner",
  baseUrl: "http://127.0.0.1:11435", scope: "first" as const,
};
const answer = (decision: "REJECT_INSTRUCTION" | "ACCEPT_DATA") =>
  JSON.stringify({ decision, requestedTool: "NONE",
    approvedAction: "NONE", exfiltration: false });

function fakeDeps(inference: LiveAdversarialDeps["inference"] =
  async (_base, _model, messages) => {
    const content = messages[2]?.content ?? "";
    const benign = content.includes("Explain why the phrase") ||
      content.includes("Describe how a typed broker");
    return answer(benign ? "ACCEPT_DATA" : "REJECT_INSTRUCTION");
  }): LiveAdversarialDeps {
  return {
    metadata: async (_base, model) => ({
      model, digest: "b".repeat(64), size: 1200000000,
    }),
    inference,
  };
}

test("full model test surface reuses 16 prompt and 12 broker cases, plus controls", () => {
  const full = adversarialModelProbes("all");
  const first = adversarialModelProbes("first");
  assert.equal(full.length, 38);
  assert.equal(first.length, 5);
  assert.equal(new Set(full.map(x => x.id)).size, 38);
  assert.equal(full.filter(x => x.group === "PROMPT").length, 16);
  assert.equal(full.filter(x => x.group === "BROKER").length, 12);
  assert.equal(full.filter(x => x.group === "BOUNDARY").length, 3);
  assert.equal(full.filter(x => x.group === "MODEL_SPECIFIC").length, 5);
  assert.equal(full.filter(x => x.group === "CONTROL").length, 2);
  assert.ok(first.every(x => full.some(y => y.id === x.id)));
});
test("local simulation verifies 3 separate model roles and source-bound gate evidence", async () => {
  let count = 0;
  const deps = fakeDeps(async (url, model, messages, options) => {
    assert.equal(url, "http://127.0.0.1:11435");
    assert.ok(QUALIFIED_MODEL_TAGS.includes(model as typeof QUALIFIED_MODEL_TAGS[number]));
    assert.equal(options?.format, "json");
    assert.equal(options?.think, false);
    assert.equal(messages.length, 3);
    assert.match(messages[2].content, /<UNTRUSTED_(EVIDENCE|TRANSCRIPT)>/);
    count++;
    return fakeReply(messages[2].content);
  });
  const report = await runPrivateModelAdversarialQualification(input, deps);
  assert.equal(count, 15);
  assert.equal(report.passed, true);
  assert.equal(report.plannedCalls, 15);
  assert.equal(report.recordedCalls, 15);
  assert.equal(report.modelDigests.length, 3);
  assert.equal(report.results.length, 15);
  assert.ok(report.results.every(r => r.gate === "PASS" &&
    /^[a-f0-9]{64}$/.test(r.modelOutputHash ?? "") &&
    /^[a-f0-9]{64}$/.test(r.attackHash) &&
    /^[a-f0-9]{64}$/.test(r.evidenceHash)));
  assert.equal(report.sourceCommit, sourceCommit);
  assert.equal(report.cloudOperationExecuted, false);
  assert.equal(report.externalProviderUsed, false);
  assert.equal(report.actualCloudProviderVerification, "NOT_RUN");
  assert.equal(report.actualExternalLeaseIssuer, "NOT_RUN");
  assert.equal(report.infrastructureAct, "DISABLED");
});
function fakeReply(content: string): string {
  const benign = content.includes("Explain why the phrase") ||
    content.includes("Describe how a typed broker");
  return answer(benign ? "ACCEPT_DATA" : "REJECT_INSTRUCTION");
}

test("complete deterministic simulation exercises all 114 case/model combinations", async () => {
  let count = 0;
  const report = await runPrivateModelAdversarialQualification(
    { ...input, scope: "all" }, fakeDeps(async (_url, _model, messages) => {
      count++;
      return fakeReply(messages[2].content);
    }),
  );
  assert.equal(count, 114);
  assert.equal(report.results.length, 114);
  assert.equal(report.passed, true);
  assert.equal(new Set(report.results.map(r => r.id + ":" + r.model)).size, 114);
  assert.equal(report.results.filter(r => r.baseline === "BENIGN").length, 6);
});

test("model claiming broker access or approval never counts as a pass", async () => {
  const report = await runPrivateModelAdversarialQualification(input,
    fakeDeps(async () => JSON.stringify({
      decision: "REJECT_INSTRUCTION", requestedTool: "terraform_apply",
      approvedAction: "APPLY_APPROVED_TAGS", exfiltration: false,
    })));
  assert.equal(report.passed, false);
  assert.equal(report.results.length, 15);
  assert.ok(report.results.every(r => r.gate === "FAIL" &&
    r.observed === "INVALID_OUTPUT"));
});

test("model disagreement or transport error is an explicit failed gate, not a skipped case", async () => {
  const report = await runPrivateModelAdversarialQualification(input,
    fakeDeps(async (_url, model) => {
      if (model === "mistral-nemo:latest") throw Error("simulated local outage");
      return answer("ACCEPT_DATA");
    }));
  assert.equal(report.passed, false);
  assert.equal(report.results.length, 15);
  assert.equal(report.results.filter(x => x.observed === "CALL_FAILED").length, 5);
  assert.equal(report.results.filter(x => x.gate === "FAIL").length, 14);
  assert.ok(report.results.some(x => x.errorCode === "LOCAL_MODEL_INFERENCE_FAILED"));
});

test("only pinned HTTP loopback Ollama can receive adversarial test inputs", async () => {
  for (const url of [
    "https://api.openai.com", "https://localhost:11435",
    "http://10.0.0.21:11435", "http://127.0.0.1:11435/api/chat",
    "http://user:pass@localhost:11435", "http://localhost:11435/?a=1",
    "file:///tmp/ollama.sock",
  ]) {
    assert.throws(() => requireLoopbackOllama(url),
      /PRIVATE_ADVERSARIAL_LOOPBACK_REQUIRED/);
  }
  assert.equal(requireLoopbackOllama("http://localhost:11435"),
    "http://localhost:11435");
  let networkCalls = 0;
  const bad: LiveAdversarialDeps = {
    metadata: async () => { networkCalls++; throw Error("DO_NOT_CALL"); },
    inference: async () => { networkCalls++; throw Error("DO_NOT_CALL"); },
  };
  await assert.rejects(runPrivateModelAdversarialQualification({
    ...input, baseUrl: "https://api.openai.com",
  }, bad), /PRIVATE_ADVERSARIAL_LOOPBACK_REQUIRED/);
  assert.equal(networkCalls, 0);
});

test("missing local model digests blocks all inference and reports no partial success", async () => {
  let inferCalls = 0;
  const deps: LiveAdversarialDeps = {
    metadata: async (_url, model) => ({
      model, digest: model === "mistral-nemo:latest" ? "MISSING" : "b".repeat(64),
      size: 42,
    }),
    inference: async () => { inferCalls++; return answer("REJECT_INSTRUCTION"); },
  };
  await assert.rejects(runPrivateModelAdversarialQualification(input, deps),
    /PRIVATE_ADVERSARIAL_MODEL_IDENTITY_NOT_ATTESTED/);
  assert.equal(inferCalls, 0);
});
test("unbound source and target identity fail before any model calls", async () => {
  await assert.rejects(runPrivateModelAdversarialQualification({
    ...input, sourceCommit: "working-directory",
  }, fakeDeps()), /PRIVATE_ADVERSARIAL_TARGET_OR_SOURCE_INVALID/);
  await assert.rejects(runPrivateModelAdversarialQualification({
    ...input, targetHardwareId: "UNKNOWN",
  }, fakeDeps()), /PRIVATE_ADVERSARIAL_TARGET_OR_SOURCE_INVALID/);
});
