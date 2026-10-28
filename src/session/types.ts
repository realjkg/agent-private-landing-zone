import type { AgentState } from "../agent/types.js";
import type { IaCEngine } from "../build/types.js";
import type {
  MockScenario,
  Provider,
} from "../discovery/types.js";
import type {
  RecoveryDriftComparison,
  RecoveryPoint,
  RecoveryPolicy,
  RecoveryVerification,
  SimulatedRestoreDrill,
} from "../recovery/types.js";

export type SessionCommand =
  | "RUN"
  | "STATUS"
  | "ENVIRONMENT"
  | "EVIDENCE"
  | "EXPLAIN"
  | "NEXT"
  | "COMPARE_IAC"
  | "RECOVERY_STATUS"
  | "RECOVERY_PREPARE"
  | "RECOVERY_VERIFY"
  | "RECOVERY_DRILL"
  | "RECOVERY_BLOCKERS"
  | "RECOVERY_DRIFT"
  | "RECOVERY_NEXT"
  | "USE_TERRAFORM"
  | "USE_PULUMI"
  | "USE_OPENTOFU"
  | "PROMPT_GUIDE"
  | "GUARDRAIL"
  | "HELP"
  // Read-only pilot context (src/session/pilot-context.ts): the session reads the records a person's pilot runs left.
  | "PILOT_BLUEPRINT"
  | "PILOT_PREVIEW"
  | "PILOT_STATUS"
  | "PILOT_OBSERVED"
  | "PILOT_FAILURE"
  | "PILOT_READINESS"
  // A request to approve, apply, clean up, change the contract or use hosted inference: refused with the person's exact step.
  | "PILOT_HANDOFF";

export type SessionTurn = {
  at: string;
  request: string;
  command: SessionCommand;
  response: string;
};

export type SessionInput = {
  request: string;
  provider: Provider;
  engine: IaCEngine;
  mock?: MockScenario;
  approveBuild: boolean;
  fixture: boolean;
};

export type SessionState = SessionInput & {
  agentState?: AgentState;
  recoveryPolicy?: RecoveryPolicy;
  recoveryPoint?: RecoveryPoint;
  recoveryVerification?: RecoveryVerification;
  recoveryDrill?: SimulatedRestoreDrill;
  recoveryDrift?: RecoveryDriftComparison;
  response?: string;
  history: SessionTurn[];
};
