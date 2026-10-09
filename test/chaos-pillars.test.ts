import assert from "node:assert/strict";
import test from "node:test";
import { runAgentKernel } from "../src/agent/graph.js";
import { fixtureThinker } from "../src/agent/fixture.js";
import {
  CHAOS_FAULTS, runChaosPillarQualification,
} from "../src/qualification/chaos-pillars.js";

async function scenario() {
  return runAgentKernel({
    provider: "AWS", engine: "TERRAFORM",
    mock: "brownfield",
    request: "Build a governed AWS brownfield landing zone using Terraform.",
    thinker: fixtureThinker, approveBuild: false,
  });
}

test("11 synthetic chaos failures produce fail-closed evidence across 7 pillars", async () => {
  const state = await scenario();
  const report = runChaosPillarQualification({
    sourceCommit: "a".repeat(40), state,
  });
  assert.equal(CHAOS_FAULTS.length, 11);
  assert.equal(report.faults.length, 11);
  assert.equal(report.passed, true, JSON.stringify(report.faults));
  assert.equal(report.status, "SIMULATION_ONLY");
  assert.equal(report.actEnabled, false);
  assert.match(report.evidenceHash, /^[a-f0-9]{64}$/);
  assert.equal(report.policyHash, state.design?.policies.bundleHash);
  assert.equal(report.pillarPosture.COST, state.design?.policies.cost.status);
  assert.equal(report.pillarPosture.SECURITY, state.design?.policies.security.status);
  assert.equal(report.pillarPosture.SUSTAINABILITY, state.design?.policies.sustainability.status);
  assert.equal(report.pillarPosture.PERFORMANCE, state.design?.policies.performance.status);
  assert.equal(report.pillarPosture.OPERATIONAL_EXCELLENCE, "UNKNOWN");
  for (const fault of report.faults) {
    assert.equal(fault.outcome, "CONTAINED", fault.fault);
    assert.equal(fault.mutationAttempted, false, fault.fault);
    assert.equal(fault.restoreExecuted, false, fault.fault);
    assert.equal(fault.evidenceMode, "SYNTHETIC_FAULT_INJECTION");
  }
});

test("chaos qualification refuses a non-assessed or mutated input", async () => {
  const state = await scenario();
  assert.throws(() => runChaosPillarQualification({
    sourceCommit: "UNKNOWN", state,
  }), /CHAOS_SOURCE_COMMIT_REQUIRED/);
  assert.throws(() => runChaosPillarQualification({
    sourceCommit: "a".repeat(40),
    state: { ...state, observation: undefined },
  }), /CHAOS_REQUIRES_SAFE_ASSESSED_DESIGN/);
});

test("simulated recovery evidence must remain explicitly not restored", async () => {
  const state = await scenario();
  const report = runChaosPillarQualification({
    sourceCommit: "b".repeat(40), state,
  });
  assert.notEqual(report.recoveryVerification, "FULLY_RESTORED");
  assert.equal(report.faults.find((x) => x.fault === "CORRUPTED_MANIFEST")?.outcome,
    "CONTAINED");
  assert.equal(report.faults.find((x) => x.fault === "STALE_DESIGN")?.outcome,
    "CONTAINED");
  assert.equal(report.faults.find((x) => x.fault === "MISSING_IAC_STATE")?.outcome,
    "CONTAINED");
});
