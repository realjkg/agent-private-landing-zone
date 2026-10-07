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
  RecoveryAutomationController,
  planRecoveryAutomationActions,
  runRecoveryAutomationCycle,
  type RecoveryAutomationContext,
} from "../src/recovery/automation.js";
import {
  parseRecoveryTargets,
} from "../src/recovery/target-loader.js";
import {
  validateRecoveryTarget,
  type RecoveryTargetSpec,
} from "../src/recovery/target.js";

async function recoveryContext(
  provider: "AWS" | "AZURE",
  engine: "TERRAFORM" | "BICEP",
): Promise<RecoveryAutomationContext> {
  const base =
    await discoverEnvironment({
      provider,
      mock: "greenfield",
    });

  const providerEvidence =
    provider === "AWS"
      ? [
          {
            key:
              "aws.organizations",
            value: "present",
            source: "test",
          },
          {
            key:
              "aws.control_tower",
            value: "present",
            source: "test",
          },
          {
            key:
              "aws.configuration_export",
            value: "present",
            source: "test",
          },
        ]
      : [
          {
            key:
              "azure.management_groups",
            value: "present",
            source: "test",
          },
          {
            key: "azure.policy",
            value: "present",
            source: "test",
          },
          {
            key:
              "azure.configuration_export",
            value: "present",
            source: "test",
          },
        ];

  const stateEvidence =
    engine === "TERRAFORM"
      ? [
          {
            key:
              "terraform_state",
            value: "present",
            source: "test",
          },
        ]
      : [];

  const environment = {
    ...base,
    evidence: [
      ...base.evidence,
      ...providerEvidence,
      ...stateEvidence,
      {
        key:
          "recovery_encryption",
        value: "present",
        source: "test",
      },
    ],
    resiliencyObservations: [
      {
        key: "rpo" as const,
        value: "60m",
        source: "test",
      },
      {
        key: "rto" as const,
        value: "240m",
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
    provider === "AWS"
      ? "Design this platform using Terraform."
      : "Design this platform using Bicep.";

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
      engine,
    });

  return {
    environment,
    assessment,
    design,
  };
}

function targetFor(
  context: RecoveryAutomationContext,
): RecoveryTargetSpec {
  const isAws =
    context.environment.provider ===
    "AWS";

  return {
    targetId:
      isAws
        ? "aws-fixture"
        : "azure-fixture",
    enabled: true,
    owner: "platform-operations",
    provider:
      context.environment.provider,
    scope: {
      type:
        isAws
          ? "AWS_ORGANIZATION"
          : "AZURE_MANAGEMENT_GROUP",
      id:
        isAws
          ? "o-fixture"
          : "platform",
    },
    environment: {
      mode: "FIXTURE",
      fixture: "greenfield",
    },
    source: {
      engine:
        context.design.plugin.plugin,
      approvedDesignHash:
        context.design.designHash,
      designRef:
        "fixture:" +
        context.design.designId,
      sourceOfTruthRef:
        "fixture:git",
    },
    protectedArtifacts:
      isAws
        ? [
            "INVENTORY_MANIFEST",
            "CONFIGURATION_EXPORT",
            "IAC_SOURCE",
            "IAC_STATE",
            "POLICY_CONFIGURATION",
          ]
        : [
            "INVENTORY_MANIFEST",
            "CONFIGURATION_EXPORT",
            "IAC_SOURCE",
            "POLICY_CONFIGURATION",
          ],
    evidenceDestination: {
      kind:
        "LOCAL_ENCRYPTED_VAULT",
      namespace:
        isAws
          ? "aws-fixture"
          : "azure-fixture",
    },
    schedule: {
      captureEveryMinutes: 60,
      verifyEveryMinutes: 60,
      drillEveryMinutes: 1440,
      driftEveryMinutes: 60,
    },
    objectives: {
      retentionDays: 30,
      rpoMinutes: 60,
      rtoMinutes: 240,
    },
    protection: {
      encryptionRequired: true,
      immutability: "REQUIRED",
      offlineCopy: "OPTIONAL",
    },
    capabilityRequests: [
      "EVIDENCE_READ",
      "EVIDENCE_WRITE",
    ],
  };
}

test("enabled recovery target requires scoped protection and evidence-write inputs", async () => {
  const context =
    await recoveryContext(
      "AWS",
      "TERRAFORM",
    );

  const target =
    targetFor(context);

  const valid =
    validateRecoveryTarget(
      target,
    );

  assert.equal(valid.valid, true);

  const invalid:
    RecoveryTargetSpec = {
      ...target,
      scope: {
        type:
          "AZURE_SUBSCRIPTION",
        id: "wrong-provider",
      },
      capabilityRequests: [
        "EVIDENCE_READ",
      ],
    };

  const rejected =
    validateRecoveryTarget(
      invalid,
    );

  assert.equal(
    rejected.valid,
    false,
  );
  assert.match(
    rejected.blockers.join(" "),
    /incompatible|EVIDENCE_WRITE/i,
  );
});

test("AWS target runs capture verify drill and drift automatically", async () => {
  const context =
    await recoveryContext(
      "AWS",
      "TERRAFORM",
    );
  const target =
    targetFor(context);

  const result =
    await runRecoveryAutomationCycle({
      target,
      context,
      grantedCapabilities: [
        "EVIDENCE_READ",
        "EVIDENCE_WRITE",
      ],
      now:
        new Date(
          "2026-10-07T04:00:00.000Z",
        ),
      persistEvidence: false,
    });

  assert.equal(
    result.status,
    "HEALTHY",
  );
  assert.deepEqual(
    result.steps.map(
      (step) => step.action,
    ),
    [
      "CAPTURE",
      "VERIFY",
      "DRILL",
      "DRIFT",
    ],
  );
  assert.equal(
    result.state.recoveryPoint
      ?.coverage,
    "FULL",
  );
  assert.equal(
    result.state.verification
      ?.status,
    "VERIFIED",
  );
  assert.equal(
    result.state.drill?.status,
    "READY_FOR_REVIEW",
  );
  assert.equal(
    result.state.drift?.status,
    "MATCHED",
  );
  assert.equal(
    result.actEnabled,
    false,
  );
});

test("Azure target executes the same noninteractive recovery loop without IaC state requirement for Bicep", async () => {
  const context =
    await recoveryContext(
      "AZURE",
      "BICEP",
    );
  const target =
    targetFor(context);

  const result =
    await runRecoveryAutomationCycle({
      target,
      context,
      grantedCapabilities: [
        "EVIDENCE_READ",
        "EVIDENCE_WRITE",
      ],
      now:
        new Date(
          "2026-10-07T04:00:00.000Z",
        ),
      persistEvidence: false,
    });

  assert.equal(
    result.status,
    "HEALTHY",
  );
  assert.equal(
    result.state.recoveryPoint
      ?.coverage,
    "FULL",
  );
  assert.equal(
    result.state.verification
      ?.status,
    "VERIFIED",
  );
  assert.equal(
    result.actEnabled,
    false,
  );
});

test("due-work planner prevents unnecessary target collection between cadences", async () => {
  const context =
    await recoveryContext(
      "AWS",
      "TERRAFORM",
    );
  const target =
    targetFor(context);

  const first =
    await runRecoveryAutomationCycle({
      target,
      context,
      grantedCapabilities: [
        "EVIDENCE_READ",
        "EVIDENCE_WRITE",
      ],
      now:
        new Date(
          "2026-10-07T04:00:00.000Z",
        ),
      persistEvidence: false,
    });

  assert.deepEqual(
    planRecoveryAutomationActions(
      target,
      first.state,
      new Date(
        "2026-10-07T04:30:00.000Z",
      ),
    ),
    [],
  );

  let contextLoads = 0;

  const controller =
    new RecoveryAutomationController({
      targets: [target],
      contextProvider:
        async () => {
          contextLoads += 1;
          return context;
        },
      grantedCapabilities: [
        "EVIDENCE_READ",
        "EVIDENCE_WRITE",
      ],
      persistEvidence: false,
    });

  const initial =
    await controller.tick(
      new Date(
        "2026-10-07T05:00:00.000Z",
      ),
    );

  assert.equal(
    initial[0].status,
    "HEALTHY",
  );
  assert.equal(contextLoads, 1);

  const idle =
    await controller.tick(
      new Date(
        "2026-10-07T05:30:00.000Z",
      ),
    );

  assert.equal(
    idle[0].status,
    "IDLE",
  );
  assert.equal(
    contextLoads,
    1,
  );
});

test("automation blocks rather than self-granting missing target capabilities", async () => {
  const context =
    await recoveryContext(
      "AWS",
      "TERRAFORM",
    );
  const target =
    targetFor(context);

  const result =
    await runRecoveryAutomationCycle({
      target,
      context,
      grantedCapabilities: [
        "EVIDENCE_READ",
      ],
      now:
        new Date(
          "2026-10-07T04:00:00.000Z",
        ),
      persistEvidence: false,
    });

  assert.equal(
    result.status,
    "BLOCKED",
  );
  assert.match(
    result.blockers.join(" "),
    /EVIDENCE_WRITE/,
  );
  assert.equal(
    result.steps.length,
    0,
  );
});


test("target loader rejects incomplete automation inputs before scheduling", () => {
  assert.throws(
    () =>
      parseRecoveryTargets([
        {
          targetId: "bad-target",
          enabled: true,
          owner: "ops",
          provider: "AWS"
        },
      ]),
    /scope|source|schedule|objectives/i,
  );
});


test("controller resumes prior state without reloading context before the next cadence", async () => {
  const context =
    await recoveryContext(
      "AZURE",
      "BICEP",
    );
  const target =
    targetFor(context);

  const first =
    await runRecoveryAutomationCycle({
      target,
      context,
      grantedCapabilities: [
        "EVIDENCE_READ",
        "EVIDENCE_WRITE",
      ],
      now:
        new Date(
          "2026-10-07T06:00:00.000Z",
        ),
      persistEvidence: false,
    });

  let loads = 0;

  const resumed =
    new RecoveryAutomationController({
      targets: [target],
      contextProvider:
        async () => {
          loads += 1;
          return context;
        },
      grantedCapabilities: [
        "EVIDENCE_READ",
        "EVIDENCE_WRITE",
      ],
      initialStates: [
        first.state,
      ],
      persistEvidence: false,
    });

  const result =
    await resumed.tick(
      new Date(
        "2026-10-07T06:30:00.000Z",
      ),
    );

  assert.equal(
    result[0].status,
    "IDLE",
  );
  assert.equal(loads, 0);
});


test("suspected compromise suspends scheduled recovery before context collection", async () => {
  const context =
    await recoveryContext(
      "AWS",
      "TERRAFORM",
    );
  const target =
    targetFor(context);

  let loads = 0;

  const controller =
    new RecoveryAutomationController({
      targets: [target],
      contextProvider:
        async () => {
          loads += 1;
          return context;
        },
      grantedCapabilities: [
        "EVIDENCE_READ",
        "EVIDENCE_WRITE",
      ],
      compromiseState:
        "SUSPECTED",
      persistEvidence: false,
    });

  const result =
    await controller.tick(
      new Date(
        "2026-10-07T07:00:00.000Z",
      ),
    );

  assert.equal(
    result[0].status,
    "BLOCKED",
  );
  assert.equal(loads, 0);
  assert.match(
    result[0].blockers.join(" "),
    /suspended/i,
  );
  assert.ok(
    result[0].steps.every(
      (step) =>
        step.status ===
        "BLOCKED",
    ),
  );
});
