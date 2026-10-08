export type TraceMode = "DISCONNECTED" | "CONNECTED" | "RECONCILED";
export type AuthorityClass = "ADVISE" | "OPERATE";
export type ApprovalMode = "ADVISORY" | "LOCAL" | "STANDARD_PREAPPROVED" | "NORMAL" | "EMERGENCY";
export type ApprovalState = "NOT_REQUIRED" | "PENDING" | "APPROVED" | "DENIED";
export type ExternalSystem = "JIRA" | "SERVICENOW" | "CMDB" | "GITHUB" | "GITLAB" | "JENKINS" | "CIRCLECI";
export type ChangePhase = "REQUESTED" | "RECONCILED";
export type ChangeReference = { system: ExternalSystem; recordId: string };

export type ChangeRequest = {
  changeRecordId: string;
  actionId: string;
  actionType: string;
  authorityClass: AuthorityClass;
  environmentId: string;
  substrate: string;
  resourceIds: string[];
  initiatingRef?: string;
  requestorId: string;
  agentActorId?: string;
  approval: { mode: ApprovalMode; state: ApprovalState; reference?: string };
  policyDecisionId?: string;
  capabilityLeaseId?: string;
  playbook: { id: string; version: string; sha256: string };
  preconditions: string[];
  maxTargets: number;
  execution: { status: "NOT_EXECUTED" | "SUCCEEDED" | "FAILED"; startedAt?: string; finishedAt?: string };
  verification: "NOT_RUN" | "PASS" | "FAIL";
  recovery: "NOT_REQUIRED" | "NOT_RUN" | "SUCCEEDED" | "FAILED";
  evidenceRefs: string[];
  relatedChangeRecordIds: string[];
  mode: TraceMode;
  externalRefs: ChangeReference[];
};
export type SovereignChangeRecord = ChangeRequest & {
  schemaVersion: 1;
  revision: number;
  phase: ChangePhase;
  at: string;
  sequence: number;
  previousRecordHash: string | null;
  supersedesRecordHash: string | null;
  recordHash: string;
  actAuthorizedByLedger: false;
};
export type LedgerAnchorPayload = {
  schemaVersion: 1;
  source: "SOVEREIGN_LOCAL_CHANGE_LEDGER";
  headHash: string | null;
  count: number;
  records: SovereignChangeRecord[];
  evidenceRefs: string[];
};
export type SignedLedgerExport = {
  payload: LedgerAnchorPayload;
  signatureAlgorithm: "Ed25519";
  signatureBase64: string;
};
export type LedgerVerification = { valid: true; count: number; headHash: string | null };
