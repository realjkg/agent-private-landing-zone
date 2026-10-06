import type { AgentState } from "../agent/types.js";
import type { IaCEngine } from "../build/types.js";
import type {
  MockScenario,
  Provider,
} from "../discovery/types.js";

export type SessionCommand =
  | "RUN"
  | "STATUS"
  | "ENVIRONMENT"
  | "EVIDENCE"
  | "EXPLAIN"
  | "NEXT"
  | "COMPARE_IAC"
  | "USE_TERRAFORM"
  | "USE_PULUMI"
  | "HELP";

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
  response?: string;
  history: SessionTurn[];
};
