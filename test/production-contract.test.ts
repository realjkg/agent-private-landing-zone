import assert from "node:assert/strict";
import test from "node:test";

import {
  assertProductionDeploymentContract,
  PRODUCTION_DEPLOYMENT_CONTRACT,
  PRODUCTION_QUALIFICATION_PHASES,
  productionQualificationTransitionAllowed,
} from "../src/qualification/production-contract.js";

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
