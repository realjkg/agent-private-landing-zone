import { getAgentForRole } from "./registry.js";
import {
  capabilitiesForCompromiseState,
} from "../security/policy/builtin.js";
import type {
  CompromiseState,
} from "../security/policy/types.js";
import type {
  AgentDefinition,
  CapabilityGrantor,
  CapabilityLease,
  CapabilityRequest,
  EvidenceHandoff,
  OrchestrationAssignment,
  OrchestrationPlan,
  OwnershipClaim,
  SovereignCapability,
  SpecialistRole,
  TaskEnvelope,
} from "./types.js";

const PILLAR_ROLES: SpecialistRole[] = [
  "SECURITY",
  "COST",
  "RESILIENCY",
  "RELIABILITY",
  "PERFORMANCE",
  "SUSTAINABILITY",
];

function rolesForIntent(
  intent: TaskEnvelope["intent"],
): SpecialistRole[] {
  if (intent === "ANSWER") {
    return [];
  }

  if (intent === "DISCOVER") {
    return [
      "DISCOVERY",
      "VALIDATOR",
    ];
  }

  const assessed: SpecialistRole[] = [
    "DISCOVERY",
    ...PILLAR_ROLES,
  ];

  if (intent === "ASSESS") {
    return [
      ...assessed,
      "VALIDATOR",
    ];
  }

  if (intent === "DESIGN") {
    return [
      ...assessed,
      "ARCHITECTURE",
      "VALIDATOR",
    ];
  }

  return [
    ...assessed,
    "ARCHITECTURE",
    "BUILD",
    "VALIDATOR",
  ];
}

function scopeForRole(
  role: SpecialistRole,
  engine: TaskEnvelope["engine"],
): string {
  switch (role) {
    case "DISCOVERY":
      return "environment";
    case "SECURITY":
      return "pillar:security";
    case "COST":
      return "pillar:cost";
    case "RESILIENCY":
      return "pillar:resiliency";
    case "RELIABILITY":
      return "pillar:reliability";
    case "PERFORMANCE":
      return "pillar:performance";
    case "SUSTAINABILITY":
      return "pillar:sustainability";
    case "ARCHITECTURE":
      return "design";
    case "BUILD":
      return "build:" + engine.toLowerCase();
    case "VALIDATOR":
      return "validation";
  }
}

function requiredCapabilitiesForRole(
  role: SpecialistRole,
): SovereignCapability[] {
  switch (role) {
    case "DISCOVERY":
      return ["EVIDENCE_READ"];
    case "ARCHITECTURE":
      return [
        "EVIDENCE_READ",
        "DESIGN",
      ];
    case "BUILD":
      return [
        "EVIDENCE_READ",
        "BUILD_PREVIEW",
      ];
    case "VALIDATOR":
      return [
        "EVIDENCE_READ",
        "VALIDATE",
      ];
    default:
      return ["EVIDENCE_READ"];
  }
}

export function createOrchestrationPlan(
  task: TaskEnvelope,
): OrchestrationPlan {
  const assignments: OrchestrationAssignment[] =
    rolesForIntent(task.intent).map((role) => {
      const agent = getAgentForRole(role);

      return {
        agentId: agent.id,
        role,
        scope: scopeForRole(role, task.engine),
        requiredCapabilities:
          requiredCapabilitiesForRole(role),
      };
    });

  return {
    task,
    assignments,
    ownershipClaims: assignments.map(
      (assignment) => ({
        taskId: task.taskId,
        agentId: assignment.agentId,
        scope: assignment.scope,
      }),
    ),
    validatorRequired:
      task.intent !== "ANSWER",
    actEnabled: false,
  };
}

export function issueCapabilityLease(input: {
  agent: AgentDefinition;
  taskId: string;
  scope: string;
  requested: CapabilityRequest[];
  grantor: CapabilityGrantor | "AGENT";
  compromiseState?: CompromiseState;
}): CapabilityLease {
  if (input.grantor === "AGENT") {
    throw new Error(
      "CAPABILITY_GRANT_DENIED: agents cannot grant themselves authority.",
    );
  }

  if (input.requested.includes("MUTATION")) {
    throw new Error(
      "CAPABILITY_GRANT_DENIED: mutation is unavailable while ACT is disabled.",
    );
  }

  const capabilities =
    input.requested as SovereignCapability[];

  const stateAllowed =
    new Set(
      capabilitiesForCompromiseState(
        input.compromiseState ??
        "NORMAL",
      ),
    );

  const stateDenied =
    capabilities.filter(
      (capability) =>
        !stateAllowed.has(
          capability,
        ),
    );

  if (stateDenied.length > 0) {
    throw new Error(
      "CAPABILITY_GRANT_DENIED: compromise state denies capability: " +
        stateDenied.join(", "),
    );
  }

  const excessive = capabilities.filter(
    (capability) =>
      !input.agent.maxCapabilities.includes(
        capability,
      ),
  );

  if (excessive.length > 0) {
    throw new Error(
      "CAPABILITY_GRANT_DENIED: capability exceeds registered agent boundary: " +
        excessive.join(", "),
    );
  }

  const normalized = [...new Set(capabilities)].sort();

  return {
    leaseId:
      "lease:" +
      input.taskId +
      ":" +
      input.agent.id +
      ":" +
      normalized.join("+").toLowerCase(),
    taskId: input.taskId,
    agentId: input.agent.id,
    scope: input.scope,
    capabilities: normalized,
    grantor: input.grantor,
    revocable: true,
  };
}

export function scopesOverlap(
  left: string,
  right: string,
): boolean {
  return (
    left === right ||
    left.startsWith(right + ":") ||
    right.startsWith(left + ":")
  );
}

export function findOwnershipCollision(
  existing: OwnershipClaim[],
  candidate: OwnershipClaim,
): OwnershipClaim | undefined {
  return existing.find(
    (claim) =>
      claim.taskId !== candidate.taskId &&
      scopesOverlap(
        claim.scope,
        candidate.scope,
      ),
  );
}

export function createEvidenceHandoff(input: {
  taskId: string;
  fromAgentId: string;
  toAgentId: string;
  evidenceRefs: string[];
  artifactRefs?: string[];
}): EvidenceHandoff {
  if (input.evidenceRefs.length === 0) {
    throw new Error(
      "EVIDENCE_HANDOFF_DENIED: at least one evidence reference is required.",
    );
  }

  return {
    taskId: input.taskId,
    fromAgentId: input.fromAgentId,
    toAgentId: input.toAgentId,
    evidenceRefs: [
      ...new Set(input.evidenceRefs),
    ].sort(),
    artifactRefs: [
      ...new Set(input.artifactRefs ?? []),
    ].sort(),
  };
}
