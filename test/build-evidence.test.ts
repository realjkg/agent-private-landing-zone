import assert from "node:assert/strict";
import test from "node:test";

import { evaluateBuildGate } from "../src/build/gate.js";
import {
  createBuildArtifact,
  sha256,
} from "../src/build/provenance.js";
import type { BuildCandidate } from "../src/build/types.js";
import { discoverEnvironment } from "../src/discovery/discover.js";

test("build artifact receives deterministic SHA-256 provenance", () => {
  const artifact = createBuildArtifact({
    engine: "TERRAFORM",
    provider: "AWS",
    path: "main.tf",
    content: "resource \"example\" \"test\" {}",
    generatedBy: "local-model",
    generatedAt: "2026-10-06T00:00:00.000Z",
  });

  assert.equal(
    artifact.contentHash,
    sha256("resource \"example\" \"test\" {}"),
  );
});

test("brownfield build remains blocked without exact human approval", async () => {
  const environment = await discoverEnvironment({
    provider: "AWS",
    mock: "brownfield",
  });

  const artifact = createBuildArtifact({
    engine: "PULUMI",
    provider: "AWS",
    path: "index.ts",
    content: "export {};",
    generatedBy: "local-model",
  });

  const candidate: BuildCandidate = {
    id: "candidate-1",
    status: "READY_FOR_APPROVAL",
    environment,
    artifact,
    evidence: {
      discoverySnapshotHash: "discovery-hash",
      assessmentId: "assessment-1",
      designId: "design-1",
      designHash: "design-hash-1",
      policyBundleId: "policy-v1",
      policyBundleHash: "policy-hash",
      scannerResults: [
        {
          scanner: "mock-static-scan",
          passed: true,
          findings: [],
        },
      ],
    },
    repairAttempt: 0,
    maxRepairAttempts: 3,
  };

  const decision = evaluateBuildGate(candidate);
  assert.equal(decision.allowed, false);
  assert.match(decision.reasons.join(" "), /approval/i);
});

test("exact approved artifact can pass deterministic gate", async () => {
  const environment = await discoverEnvironment({
    provider: "AZURE",
    mock: "greenfield",
  });

  const artifact = createBuildArtifact({
    engine: "TERRAFORM",
    provider: "AZURE",
    path: "main.tf",
    content: "terraform {}",
    generatedBy: "local-model",
  });

  const candidate: BuildCandidate = {
    id: "candidate-2",
    status: "APPROVED",
    environment,
    artifact,
    evidence: {
      discoverySnapshotHash: "discovery-hash",
      assessmentId: "assessment-2",
      designId: "design-2",
      designHash: "design-hash-2",
      policyBundleId: "policy-v1",
      policyBundleHash: "policy-hash",
      scannerResults: [
        {
          scanner: "mock-static-scan",
          passed: true,
          findings: [],
        },
      ],
      approvalId: "approval-1",
      approvedArtifactHash: artifact.contentHash,
    },
    repairAttempt: 0,
    maxRepairAttempts: 3,
  };

  const decision = evaluateBuildGate(candidate);
  assert.deepEqual(decision, {
    allowed: true,
    reasons: [],
  });
});

test("high severity findings block build", async () => {
  const environment = await discoverEnvironment({
    provider: "AWS",
    mock: "brownfield",
  });

  const artifact = createBuildArtifact({
    engine: "TERRAFORM",
    provider: "AWS",
    path: "main.tf",
    content: "terraform {}",
    generatedBy: "local-model",
  });

  const candidate: BuildCandidate = {
    id: "candidate-3",
    status: "APPROVED",
    environment,
    artifact,
    evidence: {
      discoverySnapshotHash: "discovery-hash",
      assessmentId: "assessment-3",
      designId: "design-3",
      designHash: "design-hash-3",
      policyBundleId: "policy-v1",
      policyBundleHash: "policy-hash",
      scannerResults: [
        {
          scanner: "mock-static-scan",
          passed: true,
          findings: [
            {
              ruleId: "EXAMPLE",
              severity: "HIGH",
              message: "unsafe change",
            },
          ],
        },
      ],
      approvalId: "approval-2",
      approvedArtifactHash: artifact.contentHash,
    },
    repairAttempt: 0,
    maxRepairAttempts: 3,
  };

  const decision = evaluateBuildGate(candidate);
  assert.equal(decision.allowed, false);
  assert.match(decision.reasons.join(" "), /Blocking findings/);
});
