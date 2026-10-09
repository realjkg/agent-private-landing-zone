import type {
  Emitter,
} from "../observability/bus.js";
import { randomUUID } from "node:crypto";

import { sha256 } from "../build/provenance.js";
import type { EnvironmentState } from "../discovery/types.js";
import type {
  ConfigurationRecoverySnapshot,
} from "./types.js";
import {
  writeEncryptedEvidence,
} from "../evidence/vault.js";

export function createConfigurationRecoverySnapshot(
  environment: EnvironmentState,
): ConfigurationRecoverySnapshot {
  const resources = environment.resources
    .map((resource) => ({
      resourceId: resource.resourceId,
      resourceType: resource.resourceType,
      name: resource.name,
      ownership: resource.ownership,
      mutationPolicy: resource.mutationPolicy,
      sourceOfTruth: resource.sourceOfTruth,
      scope: resource.scope,
      region: resource.region,
    }))
    .sort((a, b) =>
      a.resourceId.localeCompare(b.resourceId),
    );

  const sourceOfTruthCounts:
    ConfigurationRecoverySnapshot["sourceOfTruthCounts"] = {};

  for (const resource of resources) {
    sourceOfTruthCounts[resource.sourceOfTruth] =
      (sourceOfTruthCounts[resource.sourceOfTruth] ?? 0) + 1;
  }

  const evidenceRefs =
    environment.evidence.map(
      (item) =>
        item.source + ":" + item.key,
    );

  const blockers: string[] = [];

  if (
    environment.classification === "UNKNOWN"
  ) {
    blockers.push(
      "Environment classification is UNKNOWN.",
    );
  }

  if (
    environment.resources.some(
      (resource) =>
        resource.ownership === "UNKNOWN",
    )
  ) {
    blockers.push(
      "At least one resource has UNKNOWN ownership.",
    );
  }

  blockers.push(
    "Provider-native configuration export is not captured yet; this snapshot is a normalized recovery manifest.",
  );

  if (
    !environment.evidence.some(
      (item) =>
        item.key.includes("restore") &&
        item.value === "verified",
    )
  ) {
    blockers.push(
      "No verified restore exercise was observed.",
    );
  }

  const normalized = {
    provider: environment.provider,
    classification:
      environment.classification,
    controlPlane:
      environment.controlPlane,
    resources,
    sourceOfTruthCounts,
    evidenceRefs,
  };

  return {
    snapshotId:
      "recovery-" + randomUUID(),
    provider: environment.provider,
    capturedAt: new Date().toISOString(),
    resourceCount: resources.length,
    resources,
    sourceOfTruthCounts,
    evidenceRefs,
    configurationHash:
      sha256(JSON.stringify(normalized)),
    coverage: "MANIFEST_ONLY",
    restoreStatus:
      blockers.length === 0
        ? "VERIFIED"
        : environment.classification ===
            "UNKNOWN"
          ? "BLOCKED"
          : "UNVERIFIED",
    blockers,
  };
}

export async function writeConfigurationRecoverySnapshot(
  snapshot: ConfigurationRecoverySnapshot,
  emitter?: Emitter,
): Promise<string> {
  const filename =
    snapshot.capturedAt
      .replace(/[:.]/g, "-") +
    "-" +
    snapshot.provider.toLowerCase() +
    "-" +
    snapshot.snapshotId;

  return writeEncryptedEvidence(
    "recovery",
    filename,
    snapshot,
    emitter,
  );
}
