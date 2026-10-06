import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { BuildCandidate } from "./types.js";
import type { RepositoryEvidence } from "./repository.js";

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
): Promise<string> {
  const directory = join(".runs", "build");
  await mkdir(directory, { recursive: true });

  const timestamp = new Date()
    .toISOString()
    .replace(/[:.]/g, "-")
    .replace("T", "_")
    .replace("Z", "");

  const filename =
    `${timestamp}-${record.candidate.environment.provider.toLowerCase()}-${record.candidate.artifact.engine.toLowerCase()}.json`;

  const path = join(directory, filename);

  await writeFile(
    path,
    JSON.stringify(record, null, 2) + "\n",
    "utf8",
  );

  return path;
}
