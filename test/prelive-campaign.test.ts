import assert from "node:assert/strict";
import test from "node:test";

import { runAgentKernel } from "../src/agent/graph.js";
import { fixtureThinker } from "../src/agent/fixture.js";
import { parseMatrixCliArgs } from "../src/qualification/matrix-arguments.js";
import { PHASE_E_SCENARIOS } from "../src/qualification/phase-e.js";
import { runPreliveCampaign } from "../src/qualification/prelive-campaign.js";
import {
  runPrivateAgentMatrix,
  type MatrixRunnerDeps,
} from "../src/qualification/private-agent-matrix.js";

test("strict matrix CLI parsing never drops the first unexpected argument", () => {
  const ids = PHASE_E_SCENARIOS.map((item) => item.id);
  assert.deepEqual(
    parseMatrixCliArgs(["--offline-fixture"], ids),
    { mode: "OFFLINE_FIXTURE" },
  );
  assert.deepEqual(
    parseMatrixCliArgs(["--scenario", ids[0], "--live-models"], ids),
    { mode: "LIVE_PRIVATE_MODELS", scenarioId: ids[0] },
  );
  const invalid: string[][] = [
    [], ["--unknown", "--offline-fixture"], ["--offline-fixture", "--unknown"],
    ["--offline-fixture", "--offline-fixture"],
    ["--offline-fixture", "--live-models"],
    ["--scenario", ids[0]], ["--offline-fixture", "--scenario"],
    ["--offline-fixture", "--scenario", "--live-models"],
    ["--offline-fixture", "--scenario", "nonexistent"],
    ["--offline-fixture", "--scenario", ids[0], "--scenario", ids[1]],
    ["--offline-fixture", "--terraform-apply"],
  ];
  for (const args of invalid) {
    assert.throws(() => parseMatrixCliArgs(args, ids), undefined, args.join(" "));
  }
});

test("pre-live campaign runs every existing scenario and all applicable faults", async () => {
  const campaign = await runPreliveCampaign({ sourceCommit: "a".repeat(40) });
  assert.equal(campaign.scenarioCount, 8);
  assert.equal(campaign.results.length, 8);
  assert.equal(new Set(campaign.results.map((r) => r.id)).size, 8);
  assert.equal(campaign.alternativeProviderChecks, 8);
  assert.equal(campaign.incompatibleProviderChecks, 3);
  assert.equal(campaign.expectedNonApplicablePairs, 5);
  assert.equal(campaign.totalChaosFaults, 8 * 11);
  assert.equal(campaign.applicableChaosFaults + campaign.notApplicableChaosFaults, 88);
  assert.equal(campaign.notApplicableChaosFaults, 5);
  assert.equal(campaign.outcome, "PRELIVE_OFFLINE_COMPLETE",
    JSON.stringify(campaign.results.filter((item) =>
      item.baseline !== "PASS" || item.unknownOwnership !== "BLOCKED" ||
      item.chaosStatus !== "PASS" || item.alternateProvider.result === "FAILED")));
  assert.equal(campaign.passed, true);
  assert.equal(campaign.infrastructureAct, "DISABLED");
  assert.equal(campaign.liveModelEvidence, "NOT_RUN");
  assert.equal(campaign.liveCloudDiscovery, "NOT_RUN");
  assert.equal(campaign.measuredCloudCost, "NOT_RUN");
  assert.equal(campaign.measuredCloudPerformance, "NOT_RUN");
  assert.equal(campaign.measuredCarbon, "NOT_RUN");
  assert.equal(campaign.physicalRestore, "NOT_RUN");
  assert.match(campaign.evidenceHash, /^[0-9a-f]{64}$/);
  assert.ok(campaign.overallElapsedMs >= 0);
  for (const item of campaign.results) {
    assert.equal(item.baseline, "PASS", item.id);
    assert.equal(item.unknownOwnership, "BLOCKED", item.id);
    assert.equal(item.chaosStatus, "PASS", item.id);
    assert.equal(item.faultResults.length, 11);
    assert.equal(item.applicableFaults + item.notApplicableFaults, 11);
    assert.ok(item.faultResults.every((f) =>
      ["CONTAINED", "NOT_APPLICABLE"].includes(f.outcome)), item.id);
    assert.equal(item.pillarPosture.OPERATIONAL_EXCELLENCE, "UNKNOWN");
    assert.match(item.policyHash ?? "", /^[0-9a-f]{64}$/);
    assert.match(item.artifactHash ?? "", /^[0-9a-f]{64}$/);
    assert.match(item.evidenceHash, /^[0-9a-f]{64}$/);
  }
  const infrastructureAsCodeState = campaign.results.filter((item) =>
    ["TERRAFORM", "OPENTOFU", "PULUMI"].includes(item.adapter));
  assert.equal(infrastructureAsCodeState.length, 3);
  assert.ok(infrastructureAsCodeState.every((item) =>
    item.faultResults.find((f) => f.fault === "MISSING_IAC_STATE")?.outcome === "CONTAINED"));
  assert.equal(campaign.results.filter((item) =>
    item.alternateProvider.result === "BLOCKED").length, 3);
});

test("unsafe simulated mutation must be observed and cannot be called clean", async () => {
  const scenario = PHASE_E_SCENARIOS[0];
  const state = await runAgentKernel({
    request: scenario.request, provider: scenario.provider,
    engine: scenario.engine, mock: scenario.mock,
    thinker: fixtureThinker, approveBuild: false,
  });
  const unsafeState = {
    ...state,
    action: { ...state.action!, executed: true },
    observation: { ...state.observation!, mutationObserved: true },
  };
  const deps: MatrixRunnerDeps = {
    direct: async () => unsafeState,
    conversation: async () => unsafeState,
    metadata: async (_url, model) => ({
      model, digest: "a".repeat(64), size: 1,
    }),
  };
  const result = await runPrivateAgentMatrix({
    sourceCommit: "b".repeat(40),
    mode: "OFFLINE_FIXTURE", scenarios: [scenario],
  }, deps);
  assert.equal(result.passed, false);
  for (const lane of [result.results[0].direct, result.results[0].conversational]) {
    assert.equal(lane.status, "BLOCKED");
    assert.equal(lane.mutationObserved, true);
    assert.equal(lane.actionExecuted, true);
  }
});

test("invalid prelive source identifier blocks before any simulation", async () => {
  await assert.rejects(
    runPreliveCampaign({ sourceCommit: "UNCOMMITTED" }),
    /PRELIVE_SOURCE_COMMIT_REQUIRED/,
  );
});
