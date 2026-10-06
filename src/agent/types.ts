import type {
  EnvironmentState,
  MockScenario,
  Provider,
} from "../discovery/types.js";
import type {
  BuildLoopResult,
} from "../build/loop.js";
import type { IaCEngine } from "../build/types.js";
import type {
  AgentResult,
  EngineeringAssessment,
} from "../loop.js";

export type AgentIntent =
  | "ANSWER"
  | "DISCOVER"
  | "ASSESS"
  | "BUILD"
  | "CHANGE";

export type AgentPhase =
  | "RECEIVED"
  | "SENSING"
  | "UNDERSTANDING"
  | "THINKING"
  | "PLANNING"
  | "BUILDING"
  | "AWAITING_APPROVAL"
  | "ACTING"
  | "OBSERVING"
  | "COMPLETE"
  | "BLOCKED"
  | "FAILED";

export type AgentUnderstanding = {
  environmentKnown: boolean;
  environmentType:
    | "BROWNFIELD"
    | "GREENFIELD"
    | "UNKNOWN";
  safeBuildMode:
    | "READ_ONLY"
    | "ADDITIVE_ONLY"
    | "GREENFIELD_BASELINE"
    | "BLOCKED";
  requiresEvidence: boolean;
  mutationRequested: boolean;
  approvalRequired: boolean;
  constraints: string[];
};

export type AgentPlan = {
  intent: AgentIntent;
  steps: Array<
    | "DISCOVER"
    | "ASSESS"
    | "BUILD"
    | "VALIDATE"
    | "APPROVE"
    | "ACT"
    | "OBSERVE"
    | "ANSWER"
  >;
  mutationAllowed: boolean;
  requiresApproval: boolean;
  reasons: string[];
};

export type ActionResult = {
  attempted: boolean;
  executed: boolean;
  status: "DISABLED" | "BLOCKED" | "NOT_REQUIRED";
  reason: string;
};

export type ObservationResult = {
  verified: boolean;
  mutationObserved: boolean;
  evidence: string[];
};

export type AgentState = {
  requestId: string;
  request: string;
  phase: AgentPhase;
  intent: AgentIntent;
  provider: Provider;
  engine: IaCEngine;
  mock: MockScenario;
  environment?: EnvironmentState;
  understanding?: AgentUnderstanding;
  assessment?: AgentResult;
  engineeringAssessment?: EngineeringAssessment;
  plan?: AgentPlan;
  build?: BuildLoopResult;
  action?: ActionResult;
  observation?: ObservationResult;
  events: AgentEvent[];
  error?: string;
};

export type AgentEvent = {
  at: string;
  phase: AgentPhase;
  event: string;
  detail?: string;
};

export type Thinker = (
  request: string,
  evidence: string,
) => Promise<AgentResult>;

export type AgentKernelOptions = {
  request: string;
  provider: Provider;
  engine: IaCEngine;
  mock: MockScenario;
  thinker?: Thinker;
  approveBuild?: boolean;
};

export type LocalThinker = (
  request: string,
  evidence?: string,
) => Promise<AgentResult>;
