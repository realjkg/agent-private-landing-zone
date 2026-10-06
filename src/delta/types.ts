export type DeltaAction =
  | "REUSE"
  | "INTEGRATE"
  | "CONFIGURE"
  | "ADD"
  | "ADOPT"
  | "NO_TOUCH"
  | "BLOCKED";

export type DeltaDecision = {
  resourceId: string;
  resourceType: string;
  action: DeltaAction;
  reason: string;
  requiresExplicitAuthorization: boolean;
};

export type DeltaAssessment = {
  objective: string;
  environmentType:
    | "BROWNFIELD"
    | "GREENFIELD"
    | "UNKNOWN";
  desiredStateKnown: boolean;
  decisions: DeltaDecision[];
  blockers: string[];
  designRequired: boolean;
};
