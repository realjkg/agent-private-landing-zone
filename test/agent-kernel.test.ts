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
  assert.equal(
    state.design?.plugin.plugin,
    "TERRAFORM",
  );
  assert.equal(
    state.build?.candidate.evidence.designHash,
    state.design?.designHash,
  );
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


test("agent reports safe phase progress without exposing chain of thought", async () => {
  const progress: string[] = [];

  await runAgentKernel({
    request:
      "Assess this environment.",
    provider: "AWS",
    engine: "TERRAFORM",
    mock: "brownfield",
    thinker: mockThinker,
    progress: (message) => {
      progress.push(message);
    },
  });

  assert.ok(
    progress.some(
      (message) =>
        message.includes(
          "Sensing environment",
        ),
    ),
  );
  assert.ok(
    progress.some(
      (message) =>
        message.includes(
          "Reasoning about the request",
        ),
    ),
  );
  assert.ok(
    progress.some(
      (message) =>
        message.includes(
          "Planning safe next steps",
        ),
    ),
  );
});


test("design intent creates DesignSpec without a build candidate", async () => {
  const state = await runAgentKernel({
    request:
      "Design this landing zone using AWS CDK.",
    provider: "AWS",
    engine: "TERRAFORM",
    mock: "brownfield",
    thinker: mockThinker,
  });

  assert.equal(state.intent, "DESIGN");
  assert.equal(
    state.design?.plugin.plugin,
    "AWS_CDK",
  );
  assert.equal(
    state.design?.plugin.evidencePath,
    "CDK_SYNTH_CHANGE_SET",
  );
  assert.equal(state.build, undefined);
  assert.equal(
    state.action?.executed,
    false,
  );
});

test("planned Ansible build is designed but blocked before preview", async () => {
  const state = await runAgentKernel({
    request:
      "Build the attached edge configuration using Ansible.",
    provider: "AWS",
    engine: "TERRAFORM",
    mock: "brownfield",
    thinker: mockThinker,
  });

  assert.equal(state.intent, "BUILD");
  assert.equal(
    state.design?.plugin.plugin,
    "ANSIBLE",
  );
  assert.equal(
    state.design?.plugin.evidencePath,
    "CHECK_MODE",
  );
  assert.equal(state.build, undefined);
  assert.ok(
    state.events.some(
      (event) =>
        event.event === "BUILD_BLOCKED" &&
        event.detail?.includes("ANSIBLE"),
    ),
  );
  assert.equal(
    state.action?.executed,
    false,
  );
});


test("OpenTofu build intent produces a preview-only candidate", async () => {
  const state = await runAgentKernel({
    request:
      "Build additive infrastructure using OpenTofu.",
    provider: "AWS",
    engine: "OPENTOFU",
    mock: "brownfield",
    thinker: mockThinker,
  });

  assert.equal(
    state.design?.plugin.plugin,
    "OPENTOFU",
  );
  assert.equal(
    state.design?.plugin.status,
    "READY",
  );
  assert.equal(
    state.build?.candidate.artifact.engine,
    "OPENTOFU",
  );
  assert.equal(
    state.build?.executionMode,
    "PREVIEW_ONLY",
  );
  assert.equal(
    state.action?.executed,
    false,
  );
});


test("Bicep DesignSpec drives the fixture build even when session fallback is Terraform", async () => {
  const state = await runAgentKernel({
    request:
      "Build the approved Azure delta using Bicep.",
    provider: "AZURE",
    engine: "TERRAFORM",
    mock: "greenfield",
    thinker: mockThinker,
  });

  assert.equal(
    state.design?.plugin.plugin,
    "BICEP",
  );
  assert.equal(
    state.design?.plugin.status,
    "READY",
  );
  assert.equal(
    state.build?.candidate.artifact.engine,
    "BICEP",
  );
  assert.equal(
    state.build?.executionMode,
    "PREVIEW_ONLY",
  );
  assert.equal(
    state.action?.executed,
    false,
  );
});

test("CloudFormation DesignSpec drives an existing-stack preview fixture", async () => {
  const state = await runAgentKernel({
    request:
      "Build the existing AWS stack update using CloudFormation.",
    provider: "AWS",
    engine: "PULUMI",
    mock: "brownfield",
    thinker: mockThinker,
  });

  assert.equal(
    state.design?.plugin.plugin,
    "CLOUDFORMATION",
  );
  assert.equal(
    state.design?.plugin.status,
    "READY",
  );
  assert.equal(
    state.build?.candidate.artifact.engine,
    "CLOUDFORMATION",
  );
  assert.equal(
    state.action?.executed,
    false,
  );
});
