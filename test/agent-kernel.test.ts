import assert from "node:assert/strict";
import test from "node:test";

import { runAgentKernel } from "../src/agent/graph.js";
import type { Thinker } from "../src/agent/types.js";

const mockThinker: Thinker = async () => ({
  requestId: "assessment-fixture",
  plan: {
    complexity: "HIGH",
    freshDataRequired: false,
    impact: "HIGH",
    verificationRequired: true,
  },
  status: "OK",
  primary: {
    topRisk: "Fixture risk",
    whyItMatters: "Fixture reasoning",
    recommendedActions: [
      "Keep changes additive",
    ],
    confidence: "HIGH",
    assumptions: [],
  },
  validator: {
    topRisk: "Fixture risk",
    whyItMatters: "Fixture validation",
    recommendedActions: [
      "Keep changes additive",
    ],
    confidence: "HIGH",
    assumptions: [],
  },
  adjudication: "compatible",
  durationMs: 1,
});

test("brownfield review senses, understands, thinks, plans, and does not act", async () => {
  const state = await runAgentKernel({
    request:
      "Review this environment and assess operational risk.",
    provider: "AWS",
    engine: "TERRAFORM",
    mock: "brownfield",
    thinker: mockThinker,
  });

  assert.equal(
    state.environment?.classification,
    "BROWNFIELD",
  );
  assert.equal(
    state.engineeringAssessment?.topRisk,
    "Fixture risk",
  );
  assert.equal(
    state.postureAssessment?.securityStatus,
    "INSECURE",
  );
  assert.equal(
    state.postureAssessment?.sbom.status,
    "PARTIAL",
  );
  assert.equal(
    state.postureAssessment?.resiliency.restoreEvidence,
    "UNVERIFIED",
  );
  assert.equal(
    state.deltaAssessment?.designRequired,
    true,
  );
  assert.equal(
    state.action?.executed,
    false,
  );
  assert.equal(
    state.observation?.mutationObserved,
    false,
  );
});

test("build intent creates preview candidate but does not act", async () => {
  const state = await runAgentKernel({
    request:
      "Build additive infrastructure using Terraform.",
    provider: "AWS",
    engine: "TERRAFORM",
    mock: "brownfield",
    thinker: mockThinker,
  });

  assert.equal(state.intent, "BUILD");
  assert.ok(state.build);
  assert.equal(
    state.build?.executionMode,
    "PREVIEW_ONLY",
  );
  assert.equal(
    state.action?.executed,
    false,
  );
});

test("change intent never executes because ACT is disabled", async () => {
  const state = await runAgentKernel({
    request:
      "Deploy an additive platform resource.",
    provider: "AZURE",
    engine: "PULUMI",
    mock: "greenfield",
    thinker: mockThinker,
    approveBuild: true,
  });

  assert.equal(state.intent, "CHANGE");
  assert.equal(
    state.action?.status,
    "DISABLED",
  );
  assert.equal(
    state.action?.executed,
    false,
  );
  assert.equal(
    state.phase,
    "BLOCKED",
  );
});

test("unknown environment blocks build before candidate creation", async () => {
  const state = await runAgentKernel({
    request:
      "Build infrastructure using Terraform.",
    provider: "AWS",
    engine: "TERRAFORM",
    mock: "unknown",
    thinker: mockThinker,
  });

  assert.equal(
    state.environment?.classification,
    "UNKNOWN",
  );
  assert.equal(state.build, undefined);
  assert.equal(
    state.action?.executed,
    false,
  );
});
