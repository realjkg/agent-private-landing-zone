import assert from "node:assert/strict";
import test from "node:test";

import {
  createEvidenceHandoff,
  createOrchestrationPlan,
  findOwnershipCollision,
  issueCapabilityLease,
} from "../src/orchestration/plan.js";
import {
  getAgentForRole,
  listAgentDefinitions,
} from "../src/orchestration/registry.js";

test("build orchestration routes through all policy pillars and keeps ACT disabled", () => {
  const plan = createOrchestrationPlan({
    taskId: "task-1",
    requestId: "request-1",
    request:
      "Build a governed AWS landing zone using Terraform.",
    intent: "BUILD",
    provider: "AWS",
    engine: "TERRAFORM",
    evidenceRefs: [],
  });

  const roles =
    plan.assignments.map(
      (assignment) =>
        assignment.role,
    );

  for (const role of [
    "DISCOVERY",
    "SECURITY",
    "COST",
    "RESILIENCY",
    "RELIABILITY",
    "PERFORMANCE",
    "SUSTAINABILITY",
    "ARCHITECTURE",
    "BUILD",
    "VALIDATOR",
  ] as const) {
    assert.ok(roles.includes(role));
  }

  assert.equal(plan.actEnabled, false);
  assert.equal(
    plan.validatorRequired,
    true,
  );

  assert.equal(
    plan.assignments.some(
      (assignment) =>
        assignment.requiredCapabilities
          .includes(
            "MUTATION" as never,
          ),
    ),
    false,
  );
});

test("registered agents cannot self-grant or lease mutation capability", () => {
  const buildAgent =
    getAgentForRole("BUILD");

  assert.throws(
    () =>
      issueCapabilityLease({
        agent: buildAgent,
        taskId: "task-1",
        scope: "build:terraform",
        requested: [
          "BUILD_PREVIEW",
        ],
        grantor: "AGENT",
      }),
    /cannot grant themselves authority/i,
  );

  assert.throws(
    () =>
      issueCapabilityLease({
        agent: buildAgent,
        taskId: "task-1",
        scope: "build:terraform",
        requested: [
          "MUTATION",
        ],
        grantor:
          "DETERMINISTIC_POLICY",
      }),
    /mutation is unavailable/i,
  );
});

test("capability leases stay inside registered agent boundaries", () => {
  const securityAgent =
    getAgentForRole("SECURITY");

  assert.throws(
    () =>
      issueCapabilityLease({
        agent: securityAgent,
        taskId: "task-1",
        scope: "pillar:security",
        requested: [
          "CLOUD_READ",
        ],
        grantor: "OPERATOR",
      }),
    /exceeds registered agent boundary/i,
  );

  const lease =
    issueCapabilityLease({
      agent: securityAgent,
      taskId: "task-1",
      scope: "pillar:security",
      requested: [
        "EVIDENCE_READ",
      ],
      grantor: "OPERATOR",
    });

  assert.deepEqual(
    lease.capabilities,
    ["EVIDENCE_READ"],
  );
  assert.equal(lease.revocable, true);
});

test("logical ownership claims detect nested cross-task collisions", () => {
  const collision =
    findOwnershipCollision(
      [
        {
          taskId: "task-a",
          agentId: "local.cost",
          scope: "pillar:cost",
        },
      ],
      {
        taskId: "task-b",
        agentId: "local.cost",
        scope: "pillar:cost:tags",
      },
    );

  assert.ok(collision);

  const independent =
    findOwnershipCollision(
      [
        {
          taskId: "task-a",
          agentId: "local.cost",
          scope: "pillar:cost",
        },
      ],
      {
        taskId: "task-b",
        agentId:
          "local.reliability",
        scope:
          "pillar:reliability",
      },
    );

  assert.equal(
    independent,
    undefined,
  );
});

test("agent handoff requires evidence references rather than prose alone", () => {
  assert.throws(
    () =>
      createEvidenceHandoff({
        taskId: "task-1",
        fromAgentId:
          "local.discovery",
        toAgentId:
          "local.architecture",
        evidenceRefs: [],
      }),
    /evidence reference is required/i,
  );

  const handoff =
    createEvidenceHandoff({
      taskId: "task-1",
      fromAgentId:
        "local.discovery",
      toAgentId:
        "local.architecture",
      evidenceRefs: [
        "assessment:1",
        "assessment:1",
        "recovery:abc",
      ],
      artifactRefs: [
        "design:pending",
      ],
    });

  assert.deepEqual(
    handoff.evidenceRefs,
    [
      "assessment:1",
      "recovery:abc",
    ],
  );
});

test("registry exposes one bounded definition for each specialist role", () => {
  const definitions =
    listAgentDefinitions();

  assert.equal(
    definitions.length,
    10,
  );

  assert.equal(
    definitions.some(
      (agent) =>
        agent.maxCapabilities.includes(
          "MUTATION" as never,
        ),
    ),
    false,
  );
});


test("resiliency specialist can receive revocable encrypted evidence-write capability without mutation", () => {
  const resiliency =
    getAgentForRole("RESILIENCY");

  const lease =
    issueCapabilityLease({
      agent: resiliency,
      taskId: "recovery-task",
      scope: "recovery:target",
      requested: [
        "EVIDENCE_READ",
        "EVIDENCE_WRITE",
      ],
      grantor:
        "DETERMINISTIC_POLICY",
    });

  assert.deepEqual(
    lease.capabilities,
    [
      "EVIDENCE_READ",
      "EVIDENCE_WRITE",
    ],
  );
  assert.equal(
    lease.revocable,
    true,
  );
});
