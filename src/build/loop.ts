import { randomUUID } from "node:crypto";

import { discoverEnvironment } from "../discovery/discover.js";
import type {
  MockScenario,
  Provider,
} from "../discovery/types.js";
import { evaluateBuildGate } from "./gate.js";
import {
  createMockPreview,
  generateMockArtifact,
  runMockScanners,
} from "./mock.js";
import {
  createBuildArtifact,
  sha256,
} from "./provenance.js";
import {
  collectRepositoryEvidence,
  type RepositoryEvidence,
} from "./repository.js";
import type {
  BuildCandidate,
  BuildGateDecision,
  IaCEngine,
} from "./types.js";

export type BuildLoopOptions = {
  provider: Provider;
  engine: IaCEngine;
  mock: MockScenario;
  approve?: boolean;
  repositoryEvidence?: RepositoryEvidence;
};

export type BuildLoopResult = {
  candidate: BuildCandidate;
  repository: RepositoryEvidence;
  previewSummary: string;
  gate: BuildGateDecision;
  executionMode: "PREVIEW_ONLY";
};

export async function runBuildLoop(
  options: BuildLoopOptions,
): Promise<BuildLoopResult> {
  const environment = await discoverEnvironment({
    provider: options.provider,
    mock: options.mock,
  });

  const repository =
    options.repositoryEvidence ??
    collectRepositoryEvidence();

  const generated = generateMockArtifact(
    options.provider,
    options.engine,
  );

  const artifact = createBuildArtifact({
    engine: options.engine,
    provider: options.provider,
    path: generated.path,
    content: generated.content,
    generatedBy: "fixture-generator",
  });

  const scannerResults = runMockScanners(
    generated.content,
  );

  const preview = createMockPreview(
    environment,
    options.engine,
    artifact.contentHash,
  );

  const discoverySnapshotHash = sha256(
    JSON.stringify(environment),
  );

  const policyBundleHash = sha256(
    JSON.stringify({
      mode: "preview-only",
      ownership: environment.safeBuildMode,
      deleteAllowed: false,
    }),
  );

  const approvalId = options.approve
    ? `approval-${randomUUID()}`
    : undefined;

  const candidate: BuildCandidate = {
    id: `build-${randomUUID()}`,
    status: options.approve
      ? "APPROVED"
      : "READY_FOR_APPROVAL",
    environment,
    artifact,
    evidence: {
      discoverySnapshotHash,
      assessmentId: "assessment-fixture-v1",
      policyBundleId: "policy-fixture-v1",
      policyBundleHash,
      scannerResults,
      planHash: preview.hash,
      approvalId,
      approvedArtifactHash: options.approve
        ? artifact.contentHash
        : undefined,
    },
    repairAttempt: 0,
    maxRepairAttempts: 3,
  };

  const gate = evaluateBuildGate(
    candidate,
    true,
  );

  if (!repository.clean) {
    gate.allowed = false;
    gate.reasons.push(
      "Repository worktree is dirty; build evidence is not clean.",
    );
  }

  if (!repository.packageLockHash) {
    gate.allowed = false;
    gate.reasons.push(
      "package-lock.json evidence is missing.",
    );
  }

  return {
    candidate,
    repository,
    previewSummary: preview.summary,
    gate,
    executionMode: "PREVIEW_ONLY",
  };
}
