import assert from "node:assert/strict";
import test from "node:test";

import {
  assessEnvironment,
} from "../src/assessment/posture.js";
import {
  createDesignSpec,
} from "../src/design/create.js";
import {
  assessDelta,
} from "../src/delta/assess.js";
import {
  discoverEnvironment,
} from "../src/discovery/discover.js";
import {
  compareRecoveryDrift,
  createSimulatedRecoveryPoint,
  runSimulatedRestoreDrill,
  verifyRecoveryPoint,
} from "../src/recovery/operations.js";
import {
  createRecoveryPolicy,
} from "../src/recovery/policy.js";
import {
  captureProviderConfiguration,
} from "../src/recovery/providers.js";

async function createAwsDesign(
  mock: "brownfield" | "greenfield",
) {
  const environment =
    await discoverEnvironment({
      provider: "AWS",
      mock,
    });
  const assessment =
    assessEnvironment(environment);
  const objective =
    "Design the governed platform using Terraform.";
  const delta =
    assessDelta(
      environment,
      objective,
    );
  const design =
    createDesignSpec({
      environment,
      assessment,
      delta,
      objective,
      constraints: [],
      engine: "TERRAFORM",
    });

  return {
    environment,
    assessment,
    design,
  };
}

test("manifest-only recovery stays explicitly incomplete and non-mutating", async () => {
  const {
    environment,
    assessment,
    design,
  } =
    await createAwsDesign(
      "brownfield",
    );

  const policy =
    createRecoveryPolicy({
      environment,
      design,
    });

  const point =
    createSimulatedRecoveryPoint({
      environment,
      assessment,
      design,
      policy,
      capturedAt:
        "2026-10-07T00:00:00.000Z",
    });

  assert.equal(
    point.coverage,
    "MANIFEST_ONLY",
  );
  assert.equal(
    point.actEnabled,
    false,
  );
  assert.ok(
    point.blockers.some(
      (blocker) =>
        blocker.includes(
          "CONFIGURATION_EXPORT",
        ),
    ),
  );
  assert.ok(
    point.blockers.some(
      (blocker) =>
        blocker.includes(
          "IAC_STATE",
        ),
    ),
  );

  const verification =
    verifyRecoveryPoint({
      point,
      policy,
    });

  assert.equal(
    verification.status,
    "BLOCKED",
  );
});

test("fully evidenced simulated recovery point verifies without enabling ACT", async () => {
  const base =
    await discoverEnvironment({
      provider: "AWS",
      mock: "greenfield",
    });

  const environment = {
    ...base,
    evidence: [
      ...base.evidence,
      {
        key:
          "aws.configuration_export",
        value: "present",
        source: "test",
      },
      {
        key: "terraform_state",
        value: "present",
        source: "test",
      },
      {
        key: "aws.organizations",
        value: "present",
        source: "test",
      },
      {
        key: "aws.control_tower",
        value: "present",
        source: "test",
      },
    ],
    resiliencyObservations: [
      {
        key: "rpo" as const,
        value: "4h",
        source: "test",
      },
      {
        key: "rto" as const,
        value: "2h",
        source: "test",
      },
      {
        key:
          "configuration_backup" as const,
        value: "present",
        source: "test",
      },
      {
        key:
          "restore_test" as const,
        value: "verified",
        source: "test",
      },
      {
        key:
          "redundant_control_plane" as const,
        value: "present",
        source: "test",
      },
    ],
  };

  const assessment =
    assessEnvironment(environment);
  const objective =
    "Design the governed platform using Terraform.";
  const design =
    createDesignSpec({
      environment,
      assessment,
      delta: assessDelta(
        environment,
        objective,
      ),
      objective,
      constraints: [],
      engine: "TERRAFORM",
    });

  const policy =
    createRecoveryPolicy({
      environment,
      design,
      overrides: {
        retentionDays: 30,
        owner:
          "platform-operations",
        immutability: "REQUIRED",
        offlineCopy: "OPTIONAL",
      },
    });

  const point =
    createSimulatedRecoveryPoint({
      environment,
      assessment,
      design,
      policy,
      capturedAt:
        "2026-10-07T00:00:00.000Z",
    });

  assert.equal(
    point.coverage,
    "FULL",
  );
  assert.equal(
    point.blockers.length,
    0,
  );

  const verification =
    verifyRecoveryPoint({
      point,
      policy,
    });

  assert.equal(
    verification.status,
    "VERIFIED",
  );

  const drill =
    runSimulatedRestoreDrill({
      point,
      verification,
      design,
    });

  assert.equal(
    drill.status,
    "READY_FOR_REVIEW",
  );
  assert.equal(
    drill.mutationAttempted,
    false,
  );
  assert.equal(
    drill.actEnabled,
    false,
  );
  assert.equal(
    drill.designHashMatches,
    true,
  );
});

test("provider configuration capture normalizes AWS and Azure evidence without secret material", async () => {
  const aws =
    await discoverEnvironment({
      provider: "AWS",
      mock: "brownfield",
    });
  const azure =
    await discoverEnvironment({
      provider: "AZURE",
      mock: "brownfield",
    });

  const awsCapture =
    captureProviderConfiguration(
      aws,
    );
  const azureCapture =
    captureProviderConfiguration(
      azure,
    );

  assert.equal(
    awsCapture.secretFree,
    true,
  );
  assert.equal(
    azureCapture.secretFree,
    true,
  );

  assert.ok(
    awsCapture
      .configurationEvidenceRefs
      .some(
        (ref) =>
          ref.includes(
            "aws.control_tower",
          ),
      ),
  );
  assert.ok(
    azureCapture
      .configurationEvidenceRefs
      .some(
        (ref) =>
          ref.includes(
            "azure.policy",
          ),
      ),
  );

  assert.deepEqual(
    awsCapture.missingEvidence,
    [],
  );
  assert.deepEqual(
    azureCapture.missingEvidence,
    [],
  );
});

test("drift comparison identifies current resources absent from the captured recovery point", async () => {
  const {
    environment,
    assessment,
    design,
  } =
    await createAwsDesign(
      "brownfield",
    );

  const policy =
    createRecoveryPolicy({
      environment,
      design,
    });
  const point =
    createSimulatedRecoveryPoint({
      environment,
      assessment,
      design,
      policy,
      capturedAt:
        "2026-10-07T00:00:00.000Z",
    });

  const currentEnvironment = {
    ...environment,
    resources: [
      ...environment.resources,
      {
        resourceId:
          "aws:test:unprotected",
        provider: "AWS" as const,
        resourceType:
          "AWS::S3::Bucket",
        name:
          "unprotected-resource",
        ownership:
          "MANAGED_BY_ACCELERATOR" as const,
        mutationPolicy:
          "ADDITIVE_ONLY" as const,
        sourceOfTruth:
          "TERRAFORM" as const,
      },
    ],
  };

  const currentAssessment =
    assessEnvironment(
      currentEnvironment,
    );

  const drift =
    compareRecoveryDrift({
      currentEnvironment,
      currentAssessment,
      point,
      design,
    });

  assert.equal(
    drift.status,
    "DRIFTED",
  );
  assert.ok(
    drift.currentNotProtected.includes(
      "aws:test:unprotected",
    ),
  );
  assert.ok(
    drift.recoverabilityRisks.some(
      (risk) =>
        risk.includes(
          "configuration hash differs",
        ),
    ),
  );
});
