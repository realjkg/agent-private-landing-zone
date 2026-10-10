import assert from "node:assert/strict";
import test from "node:test";

import {
  assertProductionDeploymentContract,
  evaluateObservabilityContract,
  PRODUCTION_DEPLOYMENT_CONTRACT,
  PRODUCTION_QUALIFICATION_PHASES,
  productionQualificationTransitionAllowed,
  type ObservabilityRuntimeEvidence,
} from "../src/qualification/production-contract.js";
import {
  PRODUCTION_SIGNALS,
} from "../src/observability/events.js";

test("production qualification lifecycle is PLAN DO CONVERGE VERIFY RELEASE", () => {
  assert.deepEqual(
    PRODUCTION_QUALIFICATION_PHASES,
    [
      "PLAN",
      "DO",
      "CONVERGE",
      "VERIFY",
      "RELEASE",
    ],
  );

  assert.equal(
    productionQualificationTransitionAllowed(
      "PLAN",
      "DO",
    ),
    true,
  );
  assert.equal(
    productionQualificationTransitionAllowed(
      "DO",
      "CONVERGE",
    ),
    true,
  );
  assert.equal(
    productionQualificationTransitionAllowed(
      "CONVERGE",
      "VERIFY",
    ),
    true,
  );
  assert.equal(
    productionQualificationTransitionAllowed(
      "VERIFY",
      "RELEASE",
    ),
    true,
  );
});

test("qualification failures route backward without skipping the release gate", () => {
  assert.equal(
    productionQualificationTransitionAllowed(
      "DO",
      "DO",
    ),
    true,
  );
  assert.equal(
    productionQualificationTransitionAllowed(
      "CONVERGE",
      "DO",
    ),
    true,
  );
  assert.equal(
    productionQualificationTransitionAllowed(
      "VERIFY",
      "DO",
    ),
    true,
  );
  assert.equal(
    productionQualificationTransitionAllowed(
      "VERIFY",
      "CONVERGE",
    ),
    true,
  );

  for (const [
    current,
    next,
  ] of [
    ["PLAN", "VERIFY"],
    ["PLAN", "RELEASE"],
    ["DO", "VERIFY"],
    ["DO", "RELEASE"],
    ["CONVERGE", "RELEASE"],
    ["RELEASE", "DO"],
  ] as const) {
    assert.equal(
      productionQualificationTransitionAllowed(
        current,
        next,
      ),
      false,
      current + " -> " + next,
    );
  }
});

test("Milestone 1 contract keeps Preview Operate non-mutating and sovereign", () => {
  assert.doesNotThrow(
    () =>
      assertProductionDeploymentContract(),
  );

  const spec =
    PRODUCTION_DEPLOYMENT_CONTRACT.spec;

  assert.equal(
    spec.operatingMode,
    "PREVIEW_OPERATE",
  );
  assert.equal(
    spec.infrastructureMutation,
    "DISABLED",
  );
  assert.equal(
    spec.release.actEnabled,
    false,
  );
  assert.equal(
    spec.release.genericCloudWriteCredentials,
    "prohibited",
  );
  assert.equal(
    spec.release.genericIacApply,
    "prohibited",
  );

  assert.equal(
    spec.identity.longLivedCloudCredentials,
    "PROHIBITED",
  );
  assert.equal(
    spec.identity.secretMaterial.modelVisibility,
    "PROHIBITED",
  );
  assert.equal(
    spec.identity.secretMaterial.opaqueReferencesRequired,
    true,
  );

  assert.equal(
    spec.securityPolicy.remoteOpaEndpointAllowed,
    false,
  );
  assert.equal(
    spec.securityPolicy.failClosedWhenOpaEnabled,
    true,
  );
  assert.equal(
    spec.securityPolicy.builtinOpaParityRequired,
    true,
  );

  assert.equal(
    spec.models.runtime,
    "LOCAL",
  );
  assert.equal(
    spec.evidence.location,
    "CUSTOMER_CONTROLLED",
  );
  assert.equal(
    spec.evidence.centralControlCanDecryptCustomerRecoveryData,
    false,
  );
});

test("production contract requires real AWS Azure qualification and control-plane recovery", () => {
  const spec =
    PRODUCTION_DEPLOYMENT_CONTRACT.spec;

  assert.equal(
    spec.providers.aws.realEnvironmentQualification,
    "required",
  );
  assert.equal(
    spec.providers.azure.realEnvironmentQualification,
    "required",
  );

  assert.deepEqual(
    spec.providers.aws.operatingModes,
    [
      "READ_ONLY_DISCOVERY",
      "GOVERNED_PREVIEW",
    ],
  );
  assert.deepEqual(
    spec.providers.azure.operatingModes,
    [
      "READ_ONLY_DISCOVERY",
      "GOVERNED_PREVIEW",
    ],
  );

  assert.equal(
    spec.recovery.infrastructureRecovery,
    "required",
  );
  assert.equal(
    spec.recovery.controlPlaneRecovery,
    "required",
  );
  assert.equal(
    spec.recovery.isolatedRestoreVerification,
    "required",
  );
});

const fullRuntimeEvidence: ObservabilityRuntimeEvidence = {
  busWired: true,
  structuredLogsActive: true,
  secretRedactionActive: true,
  signals: PRODUCTION_SIGNALS,
  healthEndpointServing: true,
  readinessEndpointServing: true,
  metricsEndpointServing: true,
};

test("the contract's observability block is satisfied by full runtime evidence", () => {
  const verdict =
    evaluateObservabilityContract(
      fullRuntimeEvidence,
    );

  assert.equal(verdict.satisfied, true);
  assert.deepEqual(verdict.failures, []);

  assert.doesNotThrow(() =>
    assertProductionDeploymentContract(
      PRODUCTION_DEPLOYMENT_CONTRACT,
      fullRuntimeEvidence,
    ),
  );
});

test("every unmet observability claim is named in the verdict and throws", () => {
  const cases: readonly [
    ObservabilityRuntimeEvidence,
    RegExp,
  ][] = [
    [
      { ...fullRuntimeEvidence, busWired: false },
      /event bus is not wired/,
    ],
    [
      { ...fullRuntimeEvidence, structuredLogsActive: false },
      /structured event sink is not active/,
    ],
    [
      { ...fullRuntimeEvidence, secretRedactionActive: false },
      /secret redaction is not active/,
    ],
    [
      { ...fullRuntimeEvidence, healthEndpointServing: false },
      /health endpoint is not serving/,
    ],
    [
      { ...fullRuntimeEvidence, readinessEndpointServing: false },
      /readiness endpoint is not serving/,
    ],
    [
      { ...fullRuntimeEvidence, metricsEndpointServing: false },
      /metrics endpoint is not serving/,
    ],
    [
      { ...fullRuntimeEvidence, signals: [] },
      /required signals not covered by this runtime: model-latency/,
    ],
  ];

  for (const [evidence, pattern] of cases) {
    const verdict =
      evaluateObservabilityContract(evidence);

    assert.equal(verdict.satisfied, false);
    assert.match(
      verdict.failures.join("; "),
      pattern,
    );

    assert.throws(
      () =>
        assertProductionDeploymentContract(
          PRODUCTION_DEPLOYMENT_CONTRACT,
          evidence,
        ),
      /PRODUCTION_CONTRACT_OBSERVABILITY_UNMET/,
    );
  }
});

test("one-shot processes do not fail the contract for not serving endpoints", () => {
  // A one-shot command serves no endpoints; the fields stay undefined and
  // are "not evaluated", never treated as failing.
  const verdict =
    evaluateObservabilityContract({
      busWired: true,
      structuredLogsActive: true,
      secretRedactionActive: true,
      signals: PRODUCTION_SIGNALS,
    });

  assert.equal(verdict.satisfied, true);
});

test("every contract signal is covered by the runtime signal catalog", () => {
  // A renamed signal must fail here loudly instead of orphaning the
  // contract requirement (and any alert rules keyed to it) silently.
  const catalog = new Set<string>(PRODUCTION_SIGNALS);

  for (const signal of PRODUCTION_DEPLOYMENT_CONTRACT.spec.observability.signals) {
    assert.equal(
      catalog.has(signal),
      true,
      "contract signal missing from the catalog: " + signal,
    );
  }
});
