import { createHash } from "node:crypto";

import { PRODUCTION_RELEASE_GATES, type ReleaseGateMode } from "./release-admission.js";

/**
 * Advisory development feedback only. This does not verify CI provenance or
 * review actual release evidence; the release admission verifier remains the
 * only source of release-gate decisions. ACT authority is never granted here.
 */
export const DEVELOPMENT_CHECKS = [
  { id: "typescript", description: "TypeScript build/type check" },
  { id: "node-tests", description: "Deterministic Node regression tests" },
  { id: "ui-tests", description: "React/console deterministic tests" },
  { id: "offline-provider-fixtures", description: "Synthetic provider and IaC tests" },
  { id: "installer-journeys", description: "Scripted installer agent journeys" },
  { id: "security-boundaries", description: "Authorization/CSRF/policy negative tests" },
] as const;
export type DevelopmentCheckId = typeof DEVELOPMENT_CHECKS[number]["id"];
export type DevelopmentCheckState = "REPORTED_PASS" | "REPORTED_FAIL" | "NOT_RUN";
export type DevelopmentCheckInput = { id: DevelopmentCheckId; status: DevelopmentCheckState };

export type DevelopmentReport = {
  schemaVersion: 1;
  mode: "OFFLINE_DEVELOPMENT_ONLY";
  sourceCommit: string;
  evidenceOrigin: "OPERATOR_REPORTED_NOT_ATTESTED";
  developmentMayContinue: true;
  localFeedback: "REPORTED_PASS" | "FAILURES_NEED_FIX" | "CHECKS_PENDING";
  checks: Array<{ id: DevelopmentCheckId; status: DevelopmentCheckState; description: string }>;
  failedChecks: DevelopmentCheckId[];
  pendingChecks: DevelopmentCheckId[];
  releaseGates: Array<{
    id: string;
    mode: ReleaseGateMode;
    status: "DEFERRED_TO_RELEASE_QUALIFICATION";
    evidenceCounted: false;
  }>;
  /** A green local report never constitutes GitHub CI or a merge approval. */
  gitHubPRValidationRequired: true;
  mergeApproved: false;
  productionReleaseApproved: false;
  liveQualificationPerformed: false;
  liveQualificationDeferred: true;
  infrastructureAct: "DISABLED";
  developmentReportSha256: string;
};

const SHA40 = /^[a-f0-9]{40}$/;
const validStatuses: readonly string[] = ["REPORTED_PASS", "REPORTED_FAIL", "NOT_RUN"];
const validIds = new Set<string>(DEVELOPMENT_CHECKS.map((x) => x.id));

export function reviewDevelopmentReadiness(
  sourceCommit: string,
  submitted: readonly DevelopmentCheckInput[] = [],
): DevelopmentReport {
  if (!SHA40.test(sourceCommit)) throw new Error("DEVELOPMENT_SOURCE_COMMIT_INVALID");
  const observations = new Map<string, DevelopmentCheckState>();
  for (const entry of submitted) {
    if (!entry || !validIds.has(entry.id) || !validStatuses.includes(entry.status) || observations.has(entry.id)) {
      throw new Error("DEVELOPMENT_CHECK_INPUT_INVALID");
    }
    observations.set(entry.id, entry.status);
  }
  const checks = DEVELOPMENT_CHECKS.map((x) => ({
    id: x.id, description: x.description, status: observations.get(x.id) ?? "NOT_RUN",
  }));
  const failedChecks = checks.filter((x) => x.status === "REPORTED_FAIL").map((x) => x.id);
  const pendingChecks = checks.filter((x) => x.status === "NOT_RUN").map((x) => x.id);
  const localFeedback = failedChecks.length ? "FAILURES_NEED_FIX" as const :
    pendingChecks.length ? "CHECKS_PENDING" as const : "REPORTED_PASS" as const;
  const releaseGates = PRODUCTION_RELEASE_GATES.map((gate) => ({
    id: gate.id, mode: gate.mode,
    status: "DEFERRED_TO_RELEASE_QUALIFICATION" as const,
    evidenceCounted: false as const,
  }));
  const canonical = {
    schemaVersion: 1 as const,
    mode: "OFFLINE_DEVELOPMENT_ONLY" as const,
    sourceCommit,
    evidenceOrigin: "OPERATOR_REPORTED_NOT_ATTESTED" as const,
    developmentMayContinue: true as const,
    localFeedback,
    checks, failedChecks, pendingChecks, releaseGates,
    gitHubPRValidationRequired: true as const,
    mergeApproved: false as const,
    productionReleaseApproved: false as const,
    liveQualificationPerformed: false as const,
    liveQualificationDeferred: true as const,
    infrastructureAct: "DISABLED" as const,
  };
  const developmentReportSha256 = createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
  return { ...canonical, developmentReportSha256 };
}
