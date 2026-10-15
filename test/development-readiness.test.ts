import assert from "node:assert/strict";
import test from "node:test";

import {
  DEVELOPMENT_CHECKS, reviewDevelopmentReadiness, type DevelopmentCheckInput,
} from "../src/qualification/development-readiness.js";
import {
  PRODUCTION_RELEASE_GATES, reviewProductionRelease,
} from "../src/qualification/release-admission.js";

const sha = "c".repeat(40);
test("no live evidence or local tests are required to continue development, but nothing is approved", () => {
  const report = reviewDevelopmentReadiness(sha);
  assert.equal(report.developmentMayContinue, true);
  assert.equal(report.localFeedback, "CHECKS_PENDING");
  assert.equal(report.checks.length, DEVELOPMENT_CHECKS.length);
  assert.ok(report.checks.every((x) => x.status === "NOT_RUN"));
  assert.deepEqual(report.pendingChecks, DEVELOPMENT_CHECKS.map((x) => x.id));
  assert.equal(report.evidenceOrigin, "OPERATOR_REPORTED_NOT_ATTESTED");
  assert.equal(report.gitHubPRValidationRequired, true);
  assert.equal(report.mergeApproved, false);
  assert.equal(report.productionReleaseApproved, false);
  assert.equal(report.liveQualificationPerformed, false);
  assert.equal(report.infrastructureAct, "DISABLED");
  assert.match(report.developmentReportSha256, /^[a-f0-9]{64}$/);
});

test("every production gate is deferred without counting a fixture or claiming release evidence", () => {
  const report = reviewDevelopmentReadiness(sha, DEVELOPMENT_CHECKS.map((x) => ({
    id: x.id, status: "REPORTED_PASS",
  })));
  assert.equal(report.localFeedback, "REPORTED_PASS");
  assert.deepEqual(report.failedChecks, []);
  assert.deepEqual(report.pendingChecks, []);
  assert.equal(report.developmentMayContinue, true);
  assert.equal(report.mergeApproved, false);
  assert.equal(report.productionReleaseApproved, false);
  assert.deepEqual(
    report.releaseGates.map((x) => x.id),
    PRODUCTION_RELEASE_GATES.map((x) => x.id),
  );
  assert.ok(report.releaseGates.every((x) => x.status === "DEFERRED_TO_RELEASE_QUALIFICATION" && x.evidenceCounted === false));
  for (const required of ["private-model-runtime", "aws-provider", "azure-provider", "arm64-final-image"]) {
    const gate = report.releaseGates.find((x) => x.id === required);
    assert.ok(gate, required);
    assert.equal(gate.evidenceCounted, false);
  }
});

test("a local regression stays visible without preventing DO iteration or changing ACT", () => {
  const report = reviewDevelopmentReadiness(sha, [
    { id: "typescript", status: "REPORTED_PASS" },
    { id: "installer-journeys", status: "REPORTED_FAIL" },
  ]);
  assert.equal(report.localFeedback, "FAILURES_NEED_FIX");
  assert.deepEqual(report.failedChecks, ["installer-journeys"]);
  assert.ok(report.pendingChecks.includes("ui-tests"));
  assert.equal(report.developmentMayContinue, true);
  assert.equal(report.mergeApproved, false);
  assert.equal(report.infrastructureAct, "DISABLED");
});

test("developer statements cannot masquerade as authority, checked source or evidence", () => {
  const valid: DevelopmentCheckInput[] = [{ id: "node-tests", status: "REPORTED_PASS" }];
  const first = reviewDevelopmentReadiness(sha, valid);
  assert.equal(first.developmentReportSha256, reviewDevelopmentReadiness(sha, valid).developmentReportSha256);
  assert.notEqual(first.developmentReportSha256, reviewDevelopmentReadiness("d".repeat(40), valid).developmentReportSha256);
  assert.throws(() => reviewDevelopmentReadiness("NOT_A_COMMIT"), /SOURCE_COMMIT_INVALID/);
  assert.throws(() => reviewDevelopmentReadiness(sha, [
    valid[0]!, valid[0]!,
  ]), /CHECK_INPUT_INVALID/);
  assert.throws(() => reviewDevelopmentReadiness(sha, [
    { id: "cloud-live-auth" as never, status: "REPORTED_PASS" },
  ]), /CHECK_INPUT_INVALID/);
  assert.throws(() => reviewDevelopmentReadiness(sha, [
    { id: "node-tests", status: "PRODUCTION_APPROVED" as never },
  ]), /CHECK_INPUT_INVALID/);
});

test("actual production admission still blocks a clean but empty live-evidence manifest", async () => {
  const report = reviewDevelopmentReadiness(sha, DEVELOPMENT_CHECKS.map((x) => ({
    id: x.id, status: "REPORTED_PASS",
  })));
  assert.equal(report.localFeedback, "REPORTED_PASS");
  const production = await reviewProductionRelease({
    manifest: {
      schemaVersion: 1,
      sourceCommit: sha,
      operatingMode: "PREVIEW_OPERATE",
      infrastructureAct: "DISABLED",
      records: [],
    },
    root: process.cwd(),
    expectedCommit: sha,
  });
  assert.equal(production.readyForIndependentReleaseReview, false);
  assert.equal(production.productionReleaseApproved, false);
  assert.equal(production.infrastructureAct, "DISABLED");
  assert.equal(production.gates.length, report.releaseGates.length);
  assert.ok(production.gates.every((gate) => gate.status === "BLOCKED"));
});
