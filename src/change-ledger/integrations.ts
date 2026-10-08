import type { ChangeReference, SovereignChangeRecord } from "./types.js";

/** Integrations are optional references and evidence; no external provider response grants ACT. */
export interface ITSMProvider {
  readonly id: "JIRA" | "SERVICENOW";
  createIncident(input: { summaryRef: string; evidenceRefs: string[] }): Promise<ChangeReference>;
  createChange(input: { localChangeRecordId: string; artifactHash: string; evidenceRefs: string[] }): Promise<ChangeReference>;
  readApproval(ref: ChangeReference): Promise<{ state: "PENDING" | "APPROVED" | "DENIED"; externalApprovalRef?: string }>;
  attachEvidence(ref: ChangeReference, evidenceRefs: string[]): Promise<void>;
  updateChange(ref: ChangeReference, localRecord: SovereignChangeRecord): Promise<void>;
}

export interface CMDBProvider {
  readonly id: "CMDB";
  resolveConfigurationItem(input: { environmentId: string; resourceId: string }): Promise<ChangeReference | null>;
}

export interface DevOpsEvidenceProvider {
  readonly id: "GITHUB" | "GITLAB" | "JENKINS" | "CIRCLECI";
  getImmutableRunEvidence(input: { projectRef: string; runRef: string }): Promise<{
    source: ChangeReference;
    artifactHash: string;
    commitHash: string;
    status: "PASS" | "FAIL" | "UNKNOWN";
    evidenceRefs: string[];
  }>;
}
export type EnterpriseIntegrationContract = ITSMProvider | CMDBProvider | DevOpsEvidenceProvider;
export const OPTIONAL_ENTERPRISE_INTEGRATIONS = [
  { id: "JIRA", kind: "ITSM", required: false },
  { id: "SERVICENOW", kind: "ITSM", required: false },
  { id: "CMDB", kind: "CMDB", required: false },
  { id: "GITHUB", kind: "DEVOPS_EVIDENCE", required: false },
  { id: "GITLAB", kind: "DEVOPS_EVIDENCE", required: false },
  { id: "JENKINS", kind: "DEVOPS_EVIDENCE", required: false },
  { id: "CIRCLECI", kind: "DEVOPS_EVIDENCE", required: false },
] as const;

/** An external approved ticket is evidence of workflow state, never policy authority. */
export function externalReferenceIsAuthority(_ref: ChangeReference): false { return false; }
