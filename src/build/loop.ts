import { randomUUID } from "node:crypto";

import { discoverEnvironment } from "../discovery/discover.js";
import type {
  MockScenario,
  Provider,
} from "../discovery/types.js";
import type {
  DesignSpec,
} from "../design/types.js";
import { evaluateBuildGate } from "./gate.js";
import { DISABLED_EMITTER, type Emitter } from "../observability/bus.js";
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
  mock?: MockScenario;
  approve?: boolean;
  design?: DesignSpec;
  repositoryEvidence?: RepositoryEvidence;
  /** Process observability bus; defaults to disabled (no emission). */
  emitter?: Emitter;
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
  if (!options.mock && !options.design) {
    throw new Error(
      "DESIGN_REQUIRED: non-fixture Build requires an evidence-linked DesignSpec.",
    );
  }

  if (
    options.design &&
    options.design.plugin.plugin !== options.engine
  ) {
    throw new Error(
      "DESIGN_ENGINE_MISMATCH: DesignSpec selected " +
        options.design.plugin.plugin +
        " but Build requested " +
        options.engine +
        ".",
    );
  }

  const environment = await discoverEnvironment({
    provider: options.provider,
    mock: options.mock,
    emitter: options.emitter,
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

  const designId =
    options.design?.designId ??
    "design-fixture-v1";
  const designHash =
    options.design?.designHash ??
    sha256(
      JSON.stringify({
        mode: "fixture-design",
        provider: options.provider,
        engine: options.engine,
        mock: options.mock,
      }),
    );

  const fixturePolicyBundleHash = sha256(
    JSON.stringify({
      mode: "preview-only",
      ownership: environment.safeBuildMode,
      deleteAllowed: false,
      designHash,
    }),
  );

  const policyBundleId =
    options.design?.policies.bundleId ??
    "policy-fixture-v1";
  const policyBundleHash =
    options.design?.policies.bundleHash ??
    fixturePolicyBundleHash;

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
      designId,
      designHash,
      policyBundleId,
      policyBundleHash,
      scannerResults,
      planHash: preview.hash,
      approvalId,
      approvedArtifactHash: options.approve
        ? artifact.contentHash
        : undefined,
      approvedDesignHash: options.approve
        ? designHash
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

  // Deterministic build-gate refusal: every accumulated reason is a real
  // policy denial on this path, reported once with the final decision.
  if (!gate.allowed) {
    (options.emitter ?? DISABLED_EMITTER).emit({
      signal: "policy-denials",
      status: "BLOCKED",
      component: "build-gate",
      detail: gate.reasons.join("; "),
      attributes: {
        provider: options.provider,
        engine: options.engine,
      },
    });
  }

  return {
    candidate,
    repository,
    previewSummary: preview.summary,
    gate,
    executionMode: "PREVIEW_ONLY",
  };
}
