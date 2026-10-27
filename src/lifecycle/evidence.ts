import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

import { PLATFORM_LIFECYCLE_CHECKS, reviewProductionRelease, type ReleaseGateSubmission } from "../qualification/release-admission.js";
import type { RunReport } from "./journeys.js";

/**
 * Builds the `platform:<os-arch>` gate report from the journeys' own check files, then judges it with the one admission
 * review the release uses (src/qualification/release-admission.ts, reviewProductionRelease): the report is written, a
 * submission record for it is built, and the real review is run over that record in the evidence folder. The verdict it
 * gives is recorded beside the report. Nothing here submits or admits anything: a submittable report is one the owner may
 * hand to the admission flow. A synthetic run (`--synthetic`, or a fake host) is labeled SYNTHETIC, carries `fixture: true`
 * so the admission review refuses it, and is never marked submittable, whatever its checks say.
 */
export type EvidenceInput = {
  evidenceDir: string;
  platform: string;
  osVersion: string;
  sourceCommit: string;
  targetHardwareId: string;
  artifactSha256: string;
  synthetic: boolean;
  runs: readonly RunReport[];
  now?: () => Date;
};

export type EvidenceOutcome = {
  reportFile: string;
  reviewFile: string;
  record: ReleaseGateSubmission;
  label: "LIVE" | "SYNTHETIC";
  /** True only for a LIVE report the real admission review accepts as EVIDENCE_PRESENT for its platform gate. */
  submittable: boolean;
  reviewStatus: string;
  reviewBlockers: string[];
  /** The seven platform checks this report does not yet carry a passing entry for. */
  missingChecks: string[];
};

const sha = (bytes: string | Buffer): string => createHash("sha256").update(bytes).digest("hex");

export async function buildPlatformEvidence(input: EvidenceInput): Promise<EvidenceOutcome> {
  const gateId = "platform:" + input.platform;
  const checks: { name: string; passed: boolean; evidenceSha256: string; journey: string }[] = [];
  for (const run of input.runs) {
    for (const step of run.steps) {
      if (!step.check || !step.detailFile || !existsSync(step.detailFile)) continue;
      const passed = step.status === "PASS" || step.status === "SKIPPED_ALREADY_PASSED";
      // The latest run of a check wins; an earlier entry for the same name is replaced.
      const index = checks.findIndex((check) => check.name === step.name);
      const entry = { name: step.name, passed, evidenceSha256: sha(readFileSync(step.detailFile)), journey: run.journey };
      if (index >= 0) checks[index] = entry; else checks.push(entry);
    }
  }
  const missingChecks = PLATFORM_LIFECYCLE_CHECKS.filter((name) => !checks.some((check) => check.name === name && check.passed));
  const label = input.synthetic ? "SYNTHETIC" : "LIVE";
  const report = {
    schemaVersion: 1, gateId, executionMode: "LIFECYCLE", label,
    sourceCommit: input.sourceCommit, targetHardwareId: input.targetHardwareId,
    platform: input.platform, osVersion: input.osVersion, artifactSha256: input.artifactSha256,
    passed: missingChecks.length === 0 && checks.every((check) => check.passed),
    actEnabled: false, mutationObserved: false,
    // A synthetic report says so in the field the admission review refuses on, so it can never pass as live by mistake.
    ...(input.synthetic ? { fixture: true, synthetic: true } : {}),
    generatedAt: (input.now?.() ?? new Date()).toISOString(),
    checks,
    producer: "./alz lifecycle (produces evidence; never submits or admits it)",
  };
  mkdirSync(input.evidenceDir, { recursive: true, mode: 0o700 });
  const reportFile = join(input.evidenceDir, "platform-" + input.platform + ".json");
  const bytes = JSON.stringify(report, null, 2) + "\n";
  writeFileSync(reportFile, bytes, { mode: 0o600 });
  const record: ReleaseGateSubmission = {
    id: gateId, mode: "LIFECYCLE", sourceCommit: input.sourceCommit, targetHardwareId: input.targetHardwareId,
    evidencePath: basename(reportFile), evidenceSha256: sha(bytes),
  };
  const review = await reviewProductionRelease({
    manifest: { schemaVersion: 1, sourceCommit: input.sourceCommit, operatingMode: "PREVIEW_OPERATE", infrastructureAct: "DISABLED", records: [record] },
    root: input.evidenceDir, expectedCommit: input.sourceCommit,
  });
  const gate = review.gates.find((item) => item.id === gateId);
  const reviewStatus = gate?.status ?? "BLOCKED";
  const reviewBlockers = gate?.blockers ?? ["GATE_NOT_REVIEWED"];
  const submittable = !input.synthetic && reviewStatus === "EVIDENCE_PRESENT";
  const reviewFile = join(input.evidenceDir, "platform-" + input.platform + ".review.json");
  writeFileSync(reviewFile, JSON.stringify({
    schemaVersion: 1, gateId, label, submittable, reviewStatus, reviewBlockers, missingChecks, record,
    reviewedBy: "src/qualification/release-admission.ts reviewProductionRelease", reviewedAt: (input.now?.() ?? new Date()).toISOString(),
    note: input.synthetic ? "SYNTHETIC: this run qualifies nothing and is never submittable." : "Produced for the owner's admission flow; nothing was submitted or admitted here.",
  }, null, 2) + "\n", { mode: 0o600 });
  return { reportFile, reviewFile, record, label, submittable, reviewStatus, reviewBlockers, missingChecks: [...missingChecks] };
}
