import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";

import {
  runPulumiPermutations, type PulumiCase,
} from "../src/qualification/pulumi-permutations.js";
import { buildPulumiTraceMatrix } from "../src/qualification/pulumi-traceability.js";

const sourceCommit = process.env.ALZ_SOURCE_COMMIT ||
  execFileSync("git", ["rev-parse", "--verify", "HEAD"], {
    encoding: "utf8",
  }).trim();
if (!/^[a-f0-9]{40}$/.test(sourceCommit)) throw new Error("TEST_SOURCE_COMMIT_INVALID");

test("Pulumi advertised-provider x estate matrix yields traceable, evidence-backed rows", async () => {
  const report = await runPulumiPermutations({ sourceCommit });
  assert.equal(report.passed, true, JSON.stringify(
    report.cases.filter((item) => item.disposition === "FAILED")));
  assert.equal(report.sourceCommit, sourceCommit);
  assert.equal(report.cases.length, 12);
  assert.equal(new Set(report.cases.map((item) => item.id)).size, 12);
  assert.equal(report.supportedProviderEstatePairs, 4);
  assert.equal(report.unknownOwnershipPairs, 2);
  assert.equal(report.planRequiredProviderEstatePairs, 6);
  assert.equal(report.directAndConversationalLanes, 12);
  assert.equal(report.chaosFaultCases, 44);
  assert.equal(report.applicableChaosFaultCases, 44);
  assert.equal(report.notApplicableChaosFaultCases, 0);
  assert.equal(report.traceRowCount, 126);
  assert.equal(report.tracePassed, 88);
  assert.equal(report.traceFailed, 0);
  assert.equal(report.traceUnverified, 32);
  assert.equal(report.tracePlanRequired, 6);
  assert.match(report.evidenceHash, /^[a-f0-9]{64}$/);
  assert.equal(report.localModelInference, "NOT_RUN");
  assert.equal(report.actualPulumiCliValidation, "NOT_RUN");
  assert.equal(report.actualPulumiPreview, "NOT_RUN");
  assert.equal(report.liveAwsAzureDiscovery, "NOT_RUN");
  assert.equal(report.realBackupRestore, "NOT_RUN");
  assert.equal(report.productionMutation, "DISABLED");

  for (const provider of ["AWS", "AZURE"] as const) {
    for (const estate of ["greenfield", "brownfield"] as const) {
      const expectedId = "pulumi-" + provider.toLowerCase() + "-" + estate;
      const item = report.cases.find((entry) => entry.id === expectedId);
      assert.ok(item, expectedId);
      assert.equal(item.disposition, "PASS", expectedId);
      assert.equal(item.direct, "PASS", expectedId);
      assert.equal(item.conversational, "PASS", expectedId);
      assert.equal(item.buildOrigin, "FIXTURE_GENERATOR", expectedId);
      assert.equal(item.mutationObserved, false, expectedId);
      assert.equal(item.chaos, "CONTAINED", expectedId);
      assert.equal(item.chaosFaults.length, 11, expectedId);
      assert.equal(item.chaosFaults.every((fault) =>
        fault.outcome === "CONTAINED" && /^[a-f0-9]{64}$/.test(fault.evidenceHash)),
        true, expectedId);
      assert.equal(item.operationalExcellence, "UNKNOWN");
      assert.match(item.directDesignHash ?? "", /^[a-f0-9]{64}$/);
      assert.match(item.conversationalDesignHash ?? "", /^[a-f0-9]{64}$/);
      assert.match(item.artifactHash ?? "", /^[a-f0-9]{64}$/);
      assert.match(item.policyHash ?? "", /^[a-f0-9]{64}$/);
      assert.match(item.previewHash ?? "", /^[a-f0-9]{64}$/);
    }
    const unknown = report.cases.find((item) =>
      item.id === "pulumi-" + provider.toLowerCase() + "-unknown");
    assert.ok(unknown);
    assert.equal(unknown.disposition, "BLOCKED");
    assert.equal(unknown.direct, "BLOCKED");
    assert.equal(unknown.conversational, "BLOCKED");
    assert.equal(unknown.buildOrigin, "NONE");
    assert.equal(unknown.chaos, "NOT_RUN");
  }
  for (const provider of ["PRIVATE", "KUBERNETES"] as const) {
    for (const estate of ["greenfield", "brownfield", "unknown"] as const) {
      const item = report.cases.find((entry) =>
        entry.id === "pulumi-" + provider.toLowerCase() + "-" + estate);
      assert.ok(item);
      assert.equal(item.disposition, "PLAN_REQUIRED");
      assert.equal(item.direct, "NOT_RUN");
      assert.equal(item.conversational, "NOT_RUN");
      assert.equal(item.buildOrigin, "NONE");
    }
  }
  assert.equal(new Set(report.traceRows.map((row) => row.id)).size, 126);
  assert.ok(report.traceRows.every((row) =>
    row.sourceCommit === sourceCommit &&
    row.sourceTest === "test/pulumi-permutations.test.ts" &&
    /^[a-f0-9]{64}$/.test(row.rowHash)));
  assert.ok(report.traceRows.filter((row) => row.status === "VERIFIED_OFFLINE")
    .every((row) => Boolean(row.observationHash)));
  assert.equal(report.traceRows.filter((row) =>
    row.phase === "LIVE_NOT_RUN" && row.observed !== "NOT_RUN").length, 0);
});

test("trace matrix does not bless tampered, absent or inapplicable Pulumi recovery evidence", async () => {
  const report = await runPulumiPermutations({ sourceCommit });
  const original = report.cases.find((item) =>
    item.id === "pulumi-aws-brownfield");
  assert.ok(original);
  const tampered: PulumiCase = {
    ...original,
    chaosFaults: original.chaosFaults.map((fault) =>
      fault.fault === "MISSING_IAC_STATE" ?
        { ...fault, outcome: "NOT_APPLICABLE" as const } : fault),
  };
  const altered = buildPulumiTraceMatrix({ sourceCommit, cases: [tampered] });
  const row = altered.find((item) =>
    item.dimension === "MISSING_IAC_STATE");
  assert.ok(row);
  assert.equal(row.expected, "CONTAINED");
  assert.equal(row.observed, "NOT_APPLICABLE");
  assert.equal(row.status, "FAILED");

  const withoutEvidence: PulumiCase = {
    ...original, chaosFaults: original.chaosFaults.map((fault) =>
      fault.fault === "COST_BUDGET_SPIKE"
        ? { ...fault, evidenceHash: "" } : fault),
  };
  const missing = buildPulumiTraceMatrix({ sourceCommit, cases: [withoutEvidence] });
  assert.equal(missing.find((item) =>
    item.dimension === "COST_BUDGET_SPIKE")?.status, "FAILED");
});

test("source identity and duplicate trace rows cannot silently pass", async () => {
  await assert.rejects(
    runPulumiPermutations({ sourceCommit: "working-directory" }),
    /PULUMI_SOURCE_COMMIT_REQUIRED/,
  );
  const report = await runPulumiPermutations({ sourceCommit });
  assert.throws(() =>
    buildPulumiTraceMatrix({ sourceCommit, cases: [
      report.cases[0], report.cases[0],
    ] }), /PULUMI_TRACE_DUPLICATE_IDS/);
});

test("Azure greenfield original Phase E identity is retained", async () => {
  const report = await runPulumiPermutations({ sourceCommit });
  const original = report.cases.find((item) =>
    item.id === "pulumi-azure-greenfield");
  assert.ok(original);
  assert.equal(original.disposition, "PASS");
  assert.equal(original.buildOrigin, "FIXTURE_GENERATOR");
  assert.equal(report.traceRows.filter((row) =>
    row.provider === "AZURE" && row.estate === "greenfield" &&
    row.gate === "PULUMI_REAL_PREVIEW").length, 1);
});
