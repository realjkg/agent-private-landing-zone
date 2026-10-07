import assert from "node:assert/strict";
import test from "node:test";

import {
  PHASE_E_SCENARIOS,
  runPhaseEQualification,
} from "../src/qualification/phase-e.js";

test("Phase E covers each implemented adapter exactly once", () => {
  assert.equal(
    PHASE_E_SCENARIOS.length,
    8,
  );

  const engines =
    PHASE_E_SCENARIOS.map(
      (scenario) =>
        scenario.engine,
    );

  assert.equal(
    new Set(engines).size,
    8,
  );
});

test("parallel simulated builds converge across direct and LangGraph paths without ACT", async () => {
  const result =
    await runPhaseEQualification();

  assert.deepEqual(
    result.phaseOrder,
    [
      "PLAN",
      "DO",
      "CONVERGE_VERIFY",
      "ACT",
    ],
  );
  assert.equal(
    result.doMode,
    "PARALLEL_NON_OVERLAPPING",
  );
  assert.equal(
    result.lanes.length,
    8,
  );
  assert.equal(
    result.converged,
    true,
  );
  assert.equal(
    result.actEnabled,
    false,
  );

  for (const lane of
    result.lanes) {
    assert.equal(
      lane.materiallyConsistent,
      true,
      lane.scenario.id,
    );
    assert.equal(
      lane.direct.executionMode,
      "PREVIEW_ONLY",
    );
    assert.equal(
      lane.conversational
        .executionMode,
      "PREVIEW_ONLY",
    );
    assert.equal(
      lane.direct
        .actionExecuted,
      false,
    );
    assert.equal(
      lane.conversational
        .actionExecuted,
      false,
    );
    assert.equal(
      lane.direct
        .mutationObserved,
      false,
    );
    assert.equal(
      lane.conversational
        .mutationObserved,
      false,
    );
    assert.ok(
      lane.direct.planHash
        .length > 0,
    );
    assert.ok(
      lane.direct
        .policyBundleHash
        .length === 64,
    );
    assert.ok(
      lane.adapterLimitation
        .length > 0,
    );
  }
});

test("Phase E records the adapter-specific authority and limitation differences", () => {
  const byEngine =
    new Map(
      PHASE_E_SCENARIOS.map(
        (scenario) => [
          scenario.engine,
          scenario,
        ],
      ),
    );

  assert.ok(
    byEngine.get(
      "CLOUDFORMATION",
    )?.requiredCapabilities.includes(
      "PREVIEW_WRITE",
    ),
  );
  assert.ok(
    byEngine.get(
      "AWS_CDK",
    )?.requiredCapabilities.includes(
      "PROJECT_CODE_EXECUTION",
    ),
  );
  assert.ok(
    byEngine.get(
      "ANSIBLE",
    )?.requiredCapabilities.includes(
      "MANAGED_ACCESS",
    ),
  );
  assert.ok(
    byEngine.get(
      "CROSSPLANE",
    )?.requiredCapabilities.includes(
      "PROJECT_CODE_EXECUTION",
    ),
  );
});
