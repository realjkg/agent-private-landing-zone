import type {
  EnvironmentState,
  Provider,
} from "../discovery/types.js";

export type IaCEngine = "TERRAFORM" | "PULUMI";

export type BuildStatus =
  | "DRAFT"
  | "VALIDATING"
  | "POLICY_FAILED"
  | "OWNERSHIP_BLOCKED"
  | "READY_FOR_APPROVAL"
  | "APPROVED"
  | "REJECTED"
  | "APPLIED"
  | "VERIFIED";

export type ScannerResult = {
  scanner: string;
  version?: string;
  passed: boolean;
  findings: Array<{
    ruleId: string;
    severity: "INFO" | "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
    message: string;
    resourceId?: string;
  }>;
  evidenceHash?: string;
};

export type BuildArtifact = {
  engine: IaCEngine;
  provider: Provider;
  path: string;
  contentHash: string;
  generatedAt: string;
  generatedBy: string;
};

export type BuildEvidence = {
  discoverySnapshotHash: string;
  assessmentId: string;
  designId: string;
  designHash: string;
  designId: string;
  designHash: string;
  policyBundleId: string;
  policyBundleHash: string;
  scannerResults: ScannerResult[];
  planHash?: string;
  approvalId?: string;
  approvedArtifactHash?: string;
};

export type BuildCandidate = {
  id: string;
  status: BuildStatus;
  environment: EnvironmentState;
  artifact: BuildArtifact;
  evidence: BuildEvidence;
  repairAttempt: number;
  maxRepairAttempts: number;
};

export type BuildGateDecision = {
  allowed: boolean;
  reasons: string[];
};
