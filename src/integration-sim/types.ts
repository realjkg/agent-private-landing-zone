export type TraceabilityMode =
  | "CONNECTED"
  | "DISCONNECTED"
  | "RECONCILED";

export type AuthorityClass =
  | "ADVISE"
  | "OPERATE";

export type ConnectorStatus =
  | "IMPLEMENTED"
  | "TEST_DOUBLE";

export type TargetConnectorId =
  | "AWS"
  | "AZURE"
  | "ANSIBLE_PRIVATE_EDGE"
  | "CROSSPLANE_KUBERNETES_EDGE"
  | "VCF"
  | "OPENSHIFT";

export type TraceabilityConnectorId =
  | "JIRA"
  | "SERVICENOW"
  | "CMDB";

export type TargetConnector = {
  id: TargetConnectorId;
  family:
    | "ENVIRONMENT"
    | "MANAGED_OPERATIONS";
  status: ConnectorStatus;
  substrates: string[];
  notes: string;
};

export type TraceabilityConnector = {
  id: TraceabilityConnectorId;
  family:
    | "ITSM"
    | "CMDB";
  status: ConnectorStatus;
  notes: string;
};

export type ExternalReference = {
  provider: TraceabilityConnectorId;
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
  previousRecordHash?: string;
  recordHash: string;
};

export type ConnectionSimulationResult = {
  target: TargetConnector;
  mode: TraceabilityMode;
  records: SovereignChangeRecord[];
  canonicalChangeRecordId: string;
  traceable: true;
  externalAuthorityGranted: false;
  infrastructureMutationAttempted: false;
};
