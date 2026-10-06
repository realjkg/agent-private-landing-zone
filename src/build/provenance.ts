import { createHash } from "node:crypto";

import type {
  BuildArtifact,
  BuildEvidence,
  IaCEngine,
} from "./types.js";
import type { Provider } from "../discovery/types.js";

export function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function createBuildArtifact(input: {
  engine: IaCEngine;
  provider: Provider;
  path: string;
  content: string;
  generatedBy: string;
  generatedAt?: string;
}): BuildArtifact {
  return {
    engine: input.engine,
    provider: input.provider,
    path: input.path,
    contentHash: sha256(input.content),
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    generatedBy: input.generatedBy,
  };
}

export function evidenceComplete(evidence: BuildEvidence): boolean {
  return Boolean(
    evidence.discoverySnapshotHash &&
      evidence.assessmentId &&
      evidence.designId &&
      evidence.designHash &&
      evidence.policyBundleId &&
      evidence.policyBundleHash &&
      evidence.scannerResults.length > 0,
  );
}

export function approvalMatchesArtifact(
  artifact: BuildArtifact,
  evidence: BuildEvidence,
): boolean {
  return Boolean(
    evidence.approvalId &&
      evidence.approvedArtifactHash &&
      evidence.approvedArtifactHash === artifact.contentHash,
  );
}
