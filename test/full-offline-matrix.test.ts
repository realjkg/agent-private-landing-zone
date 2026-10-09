import assert from "node:assert/strict";
import test from "node:test";

import { catalogOfflineCases } from "../src/qualification/coverage-catalog.js";
import { runOfflineCoverage } from "../src/qualification/full-offline-matrix.js";

const commit = "b".repeat(40);

test("catalog covers every declared provider/adapter/estate and excludes N/A", () => {
  const cases = catalogOfflineCases();
  assert.equal(cases.length, 78);
  assert.equal(new Set(cases.map((c) => c.id)).size, cases.length);
  for (const [expected, count] of [
    ["PREVIEW", 24], ["DENY_UNKNOWN", 13],
    ["DENY_GREENFIELD", 2], ["NOT_APPLICABLE", 9],
    ["PLAN_REQUIRED", 30],
  ] as const) assert.equal(cases.filter((c) => c.expected === expected).length, count);
  for (const name of ["CLOUDFORMATION", "AWS_CDK"]) {
    for (const estate of ["greenfield", "brownfield", "unknown"]) {
      const wrong = cases.find((c) => c.engine === name &&
        c.provider === "AZURE" && c.estate === estate);
      assert.equal(wrong?.expected, "NOT_APPLICABLE");
    }
  }
  for (const name of ["TERRAFORM", "PULUMI", "OPENTOFU",
    "CROSSPLANE", "ANSIBLE"]) {
    for (const provider of ["AWS", "AZURE"]) {
      for (const estate of ["greenfield", "brownfield"]) {
        assert.equal(cases.find((c) => c.engine === name &&
          c.provider === provider && c.estate === estate)?.expected,
          "PREVIEW", name + "/" + provider + "/" + estate);
      }
    }
  }
  assert.equal(cases.find((c) => c.id === "bicep-aws-brownfield")?.expected,
    "NOT_APPLICABLE");
  assert.equal(cases.find((c) => c.id === "aws_cdk-aws-greenfield")?.expected,
    "DENY_GREENFIELD");
  assert.equal(cases.find((c) => c.id === "cloudformation-aws-greenfield")?.expected,
    "DENY_GREENFIELD");
});

test("all 39 applicable scenarios produce source-bound, per-gate offline evidence", async () => {
  const report = await runOfflineCoverage({ sourceCommit: commit });
  assert.equal(report.passed, true, JSON.stringify(
    report.rows.filter((row) => row.status === "FAILED").slice(0, 15)));
  assert.equal(report.mode, "OFFLINE_FIXTURE_ONLY");
  assert.deepEqual(report.count, {
    cases: 78, previews: 24, ownershipDenied: 13,
    existingStackDenied: 2, notApplicable: 9,
    planRequired: 30, offlineVerified: 498, failed: 0,
    liveNotRun: 96, applicableFaults: 252, faultNotApplicable: 12,
  });
  assert.equal(report.rows.length, 645);
  assert.equal(report.executedCases.length, 39);
  assert.equal(report.excludedCases.length, 39);
  assert.match(report.evidenceHash, /^[a-f0-9]{64}$/);
  assert.equal(new Set(report.rows.map((row) => row.id)).size, 645);
  assert.ok(report.rows.every((row) => row.sourceCommit === commit &&
    /^[a-f0-9]{64}$/.test(row.rowHash)));
  assert.equal(report.rows.filter((row) => row.status === "NOT_APPLICABLE").length,
    21);
  assert.equal(report.rows.filter((row) => row.status === "PLAN_REQUIRED").length,
    30);
  assert.ok(report.rows.filter((row) => row.status === "VERIFIED_OFFLINE")
    .every((row) => Boolean(row.evidenceHash)));
  assert.ok(report.rows.filter((row) => row.status === "NOT_RUN")
    .every((row) => row.observed === "NOT_RUN"));
  assert.ok(report.excludedCases.every((id) => !report.executedCases.includes(id)));
  for (const pair of ["terraform-aws-greenfield", "terraform-azure-brownfield",
    "opentofu-azure-greenfield", "ansible-azure-greenfield",
    "crossplane-azure-brownfield", "pulumi-aws-brownfield",
    "bicep-azure-greenfield"]) {
    assert.ok(report.executedCases.includes(pair), pair);
    const rows = report.rows.filter((row) => row.caseId === pair);
    assert.equal(rows.length, 24, pair);
    assert.ok(rows.some((row) => row.gate === "DIRECT" &&
      row.status === "VERIFIED_OFFLINE"), pair);
    assert.ok(rows.some((row) => row.gate === "CONVERSATIONAL" &&
      row.status === "VERIFIED_OFFLINE"), pair);
  }
  for (const id of ["aws_cdk-azure-greenfield",
    "cloudformation-azure-brownfield", "bicep-aws-greenfield"]) {
    assert.ok(!report.executedCases.includes(id), id);
    assert.equal(report.rows.find((row) => row.caseId === id)?.status,
      "NOT_APPLICABLE");
  }
  assert.equal(report.actualPrivateModelInference, "NOT_RUN");
  assert.equal(report.actualProviderIaCPreview, "NOT_RUN");
  assert.equal(report.actualCloudDiscovery, "NOT_RUN");
  assert.equal(report.actualPhysicalRecovery, "NOT_RUN");
  assert.equal(report.actualInfrastructureMutation, false);
});

test("the full catalog refuses unbound or forged source identity", async () => {
  await assert.rejects(runOfflineCoverage({ sourceCommit: "WORKTREE" }),
    /OFFLINE_COVERAGE_REQUIRES_EXACT_SOURCE_COMMIT/);
});
