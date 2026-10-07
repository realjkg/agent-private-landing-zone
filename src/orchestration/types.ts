import type { IaCEngine } from "../build/types.js";
import type { Provider } from "../discovery/types.js";

export type OrchestrationPhase =
  | "PLAN"
  | "DO"
  | "CONVERGE_VERIFY"
  | "ACT";

export type OrchestrationExecutionContract = {
  phaseOrder: [
    "PLAN",
    "DO",
    "CONVERGE_VERIFY",
    "ACT",
  ];
  doMode:
    "PARALLEL_NON_OVERLAPPING";
  convergeRequired: true;
  actBoundary: "SINGLE";
};

export type OrchestrationIntent =
  | "ANSWER"
  | "DISCOVER"
  | "ASSESS"
  | "DESIGN"
  | "BUILD"
  | "CHANGE";

export type SpecialistRole =
  | "DISCOVERY"
  | "SECURITY"
  | "COST"
  | "RESILIENCY"
  | "RELIABILITY"
  | "PERFORMANCE"
  | "SUSTAINABILITY"
  | "ARCHITECTURE"
  | "BUILD"
  | "VALIDATOR";

export type SovereignCapability =
  | "EVIDENCE_READ"
  | "EVIDENCE_WRITE"
  | "CLOUD_READ"
  | "PROJECT_CODE_EXECUTION"
  | "PREVIEW_WRITE"
  | "MANAGED_ACCESS"
  | "DESIGN"
  | "BUILD_PREVIEW"
  | "VALIDATE";

export type CapabilityRequest =
  | SovereignCapability
  | "MUTATION";

export type CapabilityGrantor =
  | "OPERATOR"
  | "DETERMINISTIC_POLICY";

export type AgentDefinition = {
  id: string;
  role: SpecialistRole;
  description: string;
  maxCapabilities: SovereignCapability[];
};

export type TaskEnvelope = {
  taskId: string;
  requestId: string;
  request: string;
  intent: OrchestrationIntent;
  provider: Provider;
  engine: IaCEngine;
  evidenceRefs: string[];
};

export type OrchestrationAssignment = {
  agentId: string;
  role: SpecialistRole;
  scope: string;
  requiredCapabilities: SovereignCapability[];
};

export type CapabilityLease = {
  leaseId: string;
  taskId: string;
  agentId: string;
  scope: string;
  capabilities: SovereignCapability[];
  grantor: CapabilityGrantor;
  revocable: true;
};

export type OwnershipClaim = {
  taskId: string;
  agentId: string;
  scope: string;
};

export type EvidenceHandoff = {
  taskId: string;
  fromAgentId: string;
  toAgentId: string;
  evidenceRefs: string[];
  artifactRefs: string[];
};

export type OrchestrationPlan = {
  task: TaskEnvelope;
  execution: OrchestrationExecutionContract;
  assignments: OrchestrationAssignment[];
  ownershipClaims: OwnershipClaim[];
  validatorRequired: boolean;
  actEnabled: false;
};
