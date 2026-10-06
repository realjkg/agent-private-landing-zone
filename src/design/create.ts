import {
  randomUUID,
} from "node:crypto";

import {
  sha256,
} from "../build/provenance.js";
import type {
  IaCEngine,
} from "../build/types.js";
import type {
  EnvironmentState,
} from "../discovery/types.js";
import type {
  DeltaAssessment,
} from "../delta/types.js";
import type {
  DiscoveryAssessment,
} from "../assessment/types.js";
import {
  selectDesignPlugin,
} from "./select-plugin.js";
import type {
  DesignSpec,
} from "./types.js";

export function createDesignSpec(input: {
  environment: EnvironmentState;
  assessment: DiscoveryAssessment;
  delta: DeltaAssessment;
  objective: string;
  constraints: string[];
  engine: IaCEngine;
}): DesignSpec {
  const plugin = selectDesignPlugin(
    input.environment.provider,
    input.objective,
    input.engine,
  );

  const entries =
    input.delta.decisions.map(
      (decision) => ({
        resourceId:
          decision.resourceId,
        resourceType:
          decision.resourceType,
        action: decision.action,
        rationale: decision.reason,
        requiresExplicitAuthorization:
          decision.requiresExplicitAuthorization,
      }),
    );

  const reuse = entries
    .filter((entry) =>
      entry.action === "REUSE" ||
      entry.action === "INTEGRATE",
    )
    .map((entry) => entry.resourceId);

  const additions = entries
    .filter(
      (entry) => entry.action === "ADD",
    )
    .map((entry) => entry.resourceId);

  const forbiddenChanges = entries
    .filter((entry) =>
      entry.action === "NO_TOUCH" ||
      entry.action === "BLOCKED",
    )
    .map((entry) => entry.resourceId);

  for (
    const resource of
    input.environment.resources
  ) {
    if (
      resource.mutationPolicy ===
      "READ_ONLY" &&
      !forbiddenChanges.includes(
        resource.resourceId,
      )
    ) {
      forbiddenChanges.push(
        resource.resourceId,
      );
    }
  }

  const securityControls =
    input.assessment.findings.map(
      (finding) =>
        finding.severity +
        " " +
        finding.domain +
        ": " +
        finding.title,
    );

  const resiliencyControls = [
    "Configuration backup: " +
      input.assessment.resiliency
        .configurationBackup,
    "Restore evidence: " +
      input.assessment.resiliency
        .restoreEvidence,
    "Recovery snapshot: " +
      input.assessment.recoverySnapshot
        .coverage,
  ];

  const assumptions: string[] = [];

  if (additions.length === 0) {
    assumptions.push(
      "Desired new resources are not yet decomposed into resource-level ADD entries; Build must not invent them.",
    );
  }

  if (
    input.assessment.sbom.status !==
    "PRESENT"
  ) {
    assumptions.push(
      "Software supply-chain coverage is incomplete.",
    );
  }

  const evidenceRefs = [
    ...input.assessment.evidenceRefs,
    "assessment:" +
      input.assessment.assessmentId,
    "recovery:" +
      input.assessment.recoverySnapshot
        .configurationHash,
  ];

  const blocked =
    input.delta.blockers.length > 0 ||
    plugin.status === "INCOMPATIBLE";

  const reviewRequired =
    plugin.status === "PLANNED" ||
    input.assessment.securityStatus !==
      "SECURE" ||
    input.assessment.resiliency
      .restoreEvidence !== "VERIFIED" ||
    additions.length === 0;

  const status = blocked
    ? "BLOCKED"
    : reviewRequired
      ? "REVIEW_REQUIRED"
      : "PROPOSED";

  const normalized = {
    provider: input.environment.provider,
    environment:
      input.environment.classification,
    objective: input.objective,
    status,
    plugin,
    entries,
    constraints: input.constraints,
    reuse,
    additions,
    forbiddenChanges:
      [...forbiddenChanges].sort(),
    securityControls,
    resiliencyControls,
    assumptions,
    evidenceRefs:
      [...new Set(evidenceRefs)].sort(),
  };

  return {
    designId:
      "design-" + randomUUID(),
    designHash:
      sha256(JSON.stringify(normalized)),
    generatedAt:
      new Date().toISOString(),
    ...normalized,
  };
}
