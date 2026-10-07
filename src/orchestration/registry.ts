import type {
  AgentDefinition,
  SpecialistRole,
} from "./types.js";

const REGISTRY: AgentDefinition[] = [
  {
    id: "local.discovery",
    role: "DISCOVERY",
    description:
      "Builds evidence-backed environment context without mutation.",
    maxCapabilities: [
      "EVIDENCE_READ",
      "CLOUD_READ",
    ],
  },
  {
    id: "local.security",
    role: "SECURITY",
    description:
      "Evaluates security policy and evidence without granting authority.",
    maxCapabilities: ["EVIDENCE_READ"],
  },
  {
    id: "local.cost",
    role: "COST",
    description:
      "Evaluates tagging, budget, and cost-governance evidence.",
    maxCapabilities: ["EVIDENCE_READ"],
  },
  {
    id: "local.resiliency",
    role: "RESILIENCY",
    description:
      "Evaluates recoverability, RPO/RTO, and recovery evidence.",
    maxCapabilities: [
      "EVIDENCE_READ",
      "EVIDENCE_WRITE",
    ],
  },
  {
    id: "local.reliability",
    role: "RELIABILITY",
    description:
      "Evaluates failure-domain and availability evidence.",
    maxCapabilities: ["EVIDENCE_READ"],
  },
  {
    id: "local.performance",
    role: "PERFORMANCE",
    description:
      "Evaluates measurable performance and capacity evidence.",
    maxCapabilities: ["EVIDENCE_READ"],
  },
  {
    id: "local.sustainability",
    role: "SUSTAINABILITY",
    description:
      "Evaluates resource-efficiency evidence without unsupported carbon claims.",
    maxCapabilities: ["EVIDENCE_READ"],
  },
  {
    id: "local.architecture",
    role: "ARCHITECTURE",
    description:
      "Produces governed design intent from approved evidence and constraints.",
    maxCapabilities: [
      "EVIDENCE_READ",
      "DESIGN",
    ],
  },
  {
    id: "local.build",
    role: "BUILD",
    description:
      "Coordinates preview-only build adapters within externally granted capabilities.",
    maxCapabilities: [
      "EVIDENCE_READ",
      "CLOUD_READ",
      "PROJECT_CODE_EXECUTION",
      "PREVIEW_WRITE",
      "MANAGED_ACCESS",
      "BUILD_PREVIEW",
    ],
  },
  {
    id: "local.validator",
    role: "VALIDATOR",
    description:
      "Independently validates evidence, policy, design, and preview results.",
    maxCapabilities: [
      "EVIDENCE_READ",
      "VALIDATE",
    ],
  },
];

export function listAgentDefinitions(): AgentDefinition[] {
  return REGISTRY.map((agent) => ({
    ...agent,
    maxCapabilities: [...agent.maxCapabilities],
  }));
}

export function getAgentForRole(
  role: SpecialistRole,
): AgentDefinition {
  const agent = REGISTRY.find(
    (candidate) => candidate.role === role,
  );

  if (!agent) {
    throw new Error(
      "ORCHESTRATOR_AGENT_NOT_REGISTERED: " + role,
    );
  }

  return {
    ...agent,
    maxCapabilities: [...agent.maxCapabilities],
  };
}
