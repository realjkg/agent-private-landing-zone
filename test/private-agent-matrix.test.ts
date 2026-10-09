import assert from "node:assert/strict";
import test from "node:test";

import { runAgentKernel } from "../src/agent/graph.js";
import { fixtureThinker } from "../src/agent/fixture.js";
import { PHASE_E_SCENARIOS } from "../src/qualification/phase-e.js";
import {
  runPrivateAgentMatrix,
  type MatrixRunnerDeps,
} from "../src/qualification/private-agent-matrix.js";

test("all eight existing ALZ scenarios converge through direct and conversational fixture paths", async () => {
  const report = await runPrivateAgentMatrix({
    sourceCommit: "a".repeat(40),
    mode: "OFFLINE_FIXTURE",
  });
  assert.equal(report.scenarioCount, 8);
  assert.equal(new Set(report.results.map((r) => r.id)).size, 8);
  assert.equal(report.passed, true, JSON.stringify(report.results.map((r) => ({id:r.id,d:r.direct.status,c:r.conversational.status,dh:r.direct.designHash,ch:r.conversational.designHash,reason:r.direct.errorCode ?? r.conversational.errorCode}))));
  assert.equal(report.agentAuthoredIacQualified, false);
  assert.equal(report.infrastructureAct, "DISABLED");
  assert.match(report.evidenceHash, /^[0-9a-f]{64}$/);
  for (const lane of report.results) {
    assert.equal(lane.converged, true, lane.id);
    assert.equal(lane.direct.status, "PASS", lane.id);
    assert.equal(lane.conversational.status, "PASS", lane.id);
    assert.equal(lane.direct.assessment, "FIXTURE", lane.id);
    assert.equal(lane.direct.buildArtifactOrigin, "FIXTURE_GENERATOR", lane.id);
    assert.equal(lane.direct.mutationObserved, false);
    assert.equal(lane.conversational.mutationObserved, false);
    assert.match(lane.direct.artifactHash ?? "", /^[0-9a-f]{64}$/);
    assert.match(lane.direct.policyHash ?? "", /^[0-9a-f]{64}$/);
  }
});

test("unsupported provider/adapter combination fails closed", async () => {
  const scenario = { ...PHASE_E_SCENARIOS[0], engine: "BICEP" as const };
  const report = await runPrivateAgentMatrix({
    sourceCommit: "b".repeat(40),
    mode: "OFFLINE_FIXTURE",
    scenarios: [scenario],
  });
  assert.equal(report.passed, false);
  assert.equal(report.results[0].direct.status, "BLOCKED");
});

test("unknown brownfield ownership never produces a permitted preview", async () => {
  const scenario = { ...PHASE_E_SCENARIOS[0], mock: "unknown" as "brownfield" };
  const report = await runPrivateAgentMatrix({
    sourceCommit: "b".repeat(40),
    mode: "OFFLINE_FIXTURE",
    scenarios: [scenario],
  });
  assert.equal(report.passed, false);
  assert.equal(report.results[0].direct.buildArtifactOrigin, "NONE");
  assert.equal(report.results[0].direct.mutationObserved, false);
});

test("failed one-lane model reasoning cannot be recorded as scenario convergence", async () => {
  const deps: MatrixRunnerDeps = {
    direct: async () => { throw new Error("MODEL_DOWN"); },
    metadata: async (_url, model) => ({ model, digest: "b".repeat(64), size: 1 }),
    conversation: async () => undefined,
  };
  const report = await runPrivateAgentMatrix({
    sourceCommit: "b".repeat(40),
    mode: "OFFLINE_FIXTURE",
    scenarios: [PHASE_E_SCENARIOS[0]],
  }, deps);
  assert.equal(report.passed, false);
  assert.equal(report.results[0].direct.status, "BLOCKED");
  assert.equal(report.results[0].conversational.status, "BLOCKED");
});

test("source SHA is mandatory for every evidence matrix", async () => {
  await assert.rejects(runPrivateAgentMatrix({
    sourceCommit: "UNKNOWN",
    mode: "OFFLINE_FIXTURE",
  }), /MATRIX_SOURCE_COMMIT_REQUIRED/);
});

test("live private model mode refuses missing digests without fallback", async () => {
  const deps: MatrixRunnerDeps = {
    direct: async (options) => runAgentKernel({
      ...options,
      thinker: fixtureThinker,
    }),
    metadata: async (_url, model) => ({ model, digest: "", size: 1 }),
    conversation: async () => undefined,
  };
  await assert.rejects(runPrivateAgentMatrix({
    sourceCommit: "b".repeat(40),
    mode: "LIVE_PRIVATE_MODELS",
    scenarios: [PHASE_E_SCENARIOS[0]],
  }, deps), /MODEL_DIGEST_NOT_ATTESTED/);
});
