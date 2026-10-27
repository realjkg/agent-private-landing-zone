import assert from "node:assert/strict";
import test from "node:test";

import {
  PHASE_E_SCENARIOS,
  runPhaseEQualification,
} from "../src/qualification/phase-e.js";
import { ACT_RELEASE_PATHS, PRODUCTION_RELEASE_GATES } from "../src/qualification/release-admission.js";

test("Phase E covers each engine and provider pair at most once, every implemented adapter at least once, and every release path the owner selected", () => {
  assert.equal(
    PHASE_E_SCENARIOS.length,
    9,
  );
  const pairs =
    PHASE_E_SCENARIOS.map(
      (scenario) =>
        scenario.engine + "/" + scenario.provider,
    );
  assert.equal(
    new Set(pairs).size,
    pairs.length,
    "one scenario per engine and provider",
  );
  assert.equal(
    new Set(PHASE_E_SCENARIOS.map((scenario) => scenario.engine)).size,
    8,
    "every implemented adapter has a lane",
  );
  // The release paths (config/release/scope.json; src/qualification/release-admission.ts ACT_RELEASE_PATHS) each
  // have a brownfield preview scenario of their own: the Azure Terraform path is not covered by the AWS one.
  const ENGINE_NAMES: Record<string, string> = { TERRAFORM: "TERRAFORM", CDK: "AWS_CDK", BICEP: "BICEP" };
  for (const path of ACT_RELEASE_PATHS) {
    const scenario = PHASE_E_SCENARIOS.find(
      (item) => item.provider === path.provider && item.engine === ENGINE_NAMES[path.engine],
    );
    assert.ok(scenario, path.provider + " " + path.engine + " has a preview scenario");
    assert.equal(scenario.mock, "brownfield", scenario.id);
    assert.ok(PRODUCTION_RELEASE_GATES.some((gate) => gate.id === "preview:" + scenario.id), "preview:" + scenario.id + " is a release gate");
  }
  assert.deepEqual(
    PHASE_E_SCENARIOS.find((item) => item.id === "terraform-azure-brownfield"),
    {
      id: "terraform-azure-brownfield", provider: "AZURE", mock: "brownfield", engine: "TERRAFORM",
      request: "Build a governed Azure brownfield landing zone using Terraform.", requiredCapabilities: ["EVIDENCE_READ", "BUILD_PREVIEW", "CLOUD_READ"],
    },
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
    9,
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
