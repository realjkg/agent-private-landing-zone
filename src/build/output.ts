import type { BuildCandidate } from "./types.js";
import type { RepositoryEvidence } from "./repository.js";
import { writeEncryptedEvidence } from "../evidence/vault.js";
import type {
  Emitter,
} from "../observability/bus.js";

export type BuildRunRecord = {
  candidate: BuildCandidate;
  repository: RepositoryEvidence;
  previewSummary: string;
  gate: {
    allowed: boolean;
    reasons: string[];
  };
  executionMode: "PREVIEW_ONLY";
};

export async function writeBuildRun(
  record: BuildRunRecord,
  emitter?: Emitter,
): Promise<string> {
  const timestamp = new Date()
    .toISOString()
    .replace(/[:.]/g, "-")
    .replace("T", "_")
    .replace("Z", "");

  const filename =
    timestamp +
    "-" +
    record.candidate.environment.provider.toLowerCase() +
    "-" +
    record.candidate.artifact.engine.toLowerCase();

  return writeEncryptedEvidence(
    "build",
    filename,
    record,
    emitter,
  );
}
