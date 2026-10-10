export type TraceabilityMode =
  | "CONNECTED"
  | "DISCONNECTED"
  | "RECONCILED";

export type AuthorityClass =
  | "ADVISE"
  | "OPERATE";

export type ConnectorStatus =
  | "IMPLEMENTED"
  | "PROJECT_CONNECTED"
  | "TEST_DOUBLE";

export type TargetConnectorId =
  | "AWS"
  | "AZURE"
  | "ANSIBLE_PRIVATE_EDGE"
  | "CROSSPLANE_KUBERNETES_EDGE"
  | "VCF"
  | "OPENSHIFT"
  | "AZURE_LOCAL_AI_FOUNDRY"
  | "AWS_OUTPOSTS_SAGEMAKER"
  | "VMWARE_PRIVATE_AI"
  | "NUTANIX_AI"
  | "REDHAT_OPENSHIFT_AI"
  | "LANGCHAIN_PRIVATE"
  | "AUTOGEN_PRIVATE"
  | "CREWAI_PRIVATE";

export type EvidenceConnectorId =
  | "JIRA"
  | "SERVICENOW"
  | "CMDB"
  | "GITHUB"
  | "GITLAB"
  | "CIRCLECI"
  | "JENKINS";

export type TargetConnector = {
  id: TargetConnectorId;
  family:
    | "ENVIRONMENT"
    | "MANAGED_OPERATIONS"
    | "AGENT_BUILDER";
  status: ConnectorStatus;
  substrates: string[];
  /**
   * Loopback-only simulation endpoint (e.g. "http://127.0.0.1").
   * Declared by TEST_DOUBLE connectors so the no-egress claim is
   * machine-checkable; never a reachable external host.
   */
  endpoint?: string;
  notes: string;
};

export type EvidenceConnector = {
  id: EvidenceConnectorId;
  family:
    | "ITSM"
    | "CMDB"
    | "DEVOPS";
  status: ConnectorStatus;
  notes: string;
};

export type ExternalReference = {
  provider: EvidenceConnectorId;
  recordId: string;
};

export type SovereignChangeRecord = {
  schemaVersion: 1;
  changeRecordId: string;
  targetConnector: TargetConnectorId;
  targetStatus: ConnectorStatus;
  traceabilityMode: TraceabilityMode;
  authorityClass: AuthorityClass;
  actionType: "SYNTHETIC_CONNECTION_TEST";
  actor: "test-integration-agent";
  policyDecision:
    "SIMULATED_ALLOW_NO_EXECUTION";
  capabilityLease:
    "SIMULATED_NON_EXECUTING_LEASE";
  execution:
    "NOT_EXECUTED_SYNTHETIC";
  verification:
    "PASS";
  externalReferences:
    ExternalReference[];
  parentChangeRecordIds: string[];
  previousRecordHash?: string;
  recordHash: string;
};

export type ConnectionSimulationResult = {
  target: TargetConnector;
  evidenceConnector?: EvidenceConnector;
  mode: TraceabilityMode;
  records: SovereignChangeRecord[];
  canonicalChangeRecordId: string;
  traceable: true;
  externalAuthorityGranted: false;
  infrastructureMutationAttempted: false;
};
