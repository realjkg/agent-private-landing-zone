export type Provider = "AWS" | "AZURE";

export type EnvironmentClassification =
  | "BROWNFIELD"
  | "GREENFIELD"
  | "UNKNOWN";

export type ControlPlaneState =
  | "EXISTING"
  | "PARTIAL"
  | "MINIMAL"
  | "UNKNOWN";

export type OwnershipType =
  | "EXTERNAL"
  | "EXISTING"
  | "MANAGED_BY_CUSTOMER"
  | "MANAGED_BY_OTHER_IAC"
  | "MANAGED_BY_ACCELERATOR"
  | "ADOPTED"
  | "UNKNOWN";

export type MutationPolicy =
  | "READ_ONLY"
  | "ADDITIVE_ONLY"
  | "UPDATE_ALLOWED"
  | "DELETE_ALLOWED";

export type SourceOfTruth =
  | "TERRAFORM"
  | "BICEP"
  | "CLOUDFORMATION"
  | "CDK"
  | "CONTROL_TOWER"
  | "AFT"
  | "AZURE_POLICY"
  | "MANUAL"
  | "UNKNOWN";

export type SafeBuildMode =
  | "READ_ONLY"
  | "ADDITIVE_ONLY"
  | "GREENFIELD_BASELINE"
  | "BLOCKED";

export type DiscoveredResource = {
  resourceId: string;
  provider: Provider;
  resourceType: string;
  name: string;
  scope?: string;
  region?: string;
  ownership: OwnershipType;
  mutationPolicy: MutationPolicy;
  sourceOfTruth: SourceOfTruth;
  tags?: Record<string, string>;
  metadata?: Record<string, unknown>;
};

export type OwnershipSummary = {
  readOnly: number;
  additiveOnly: number;
  updateAllowed: number;
  unknown: number;
};

export type DiscoveryConflict = {
  code: string;
  message: string;
  resourceId?: string;
};

export type DiscoveryEvidence = {
  key: string;
  value: string;
  source: string;
};

export type EnvironmentState = {
  provider: Provider;
  classification: EnvironmentClassification;
  controlPlane: ControlPlaneState;
  resources: DiscoveredResource[];
  ownershipSummary: OwnershipSummary;
  conflicts: DiscoveryConflict[];
  safeBuildMode: SafeBuildMode;
  discoveredAt: string;
  evidence: DiscoveryEvidence[];
  warnings: string[];
};

export type MockScenario = "brownfield" | "greenfield" | "unknown";

export type DiscoveryOptions = {
  provider: Provider;
  mock?: MockScenario;
};

export type DiscoveryEvent =
  | "DISCOVERY_START"
  | "PROVIDER_DETECTED"
  | "RESOURCE_DISCOVERED"
  | "OWNERSHIP_CLASSIFIED"
  | "ENVIRONMENT_CLASSIFIED"
  | "DISCOVERY_COMPLETE"
  | "DISCOVERY_FAILED";

export type DiscoveryReporter = (
  event: DiscoveryEvent,
  detail?: string,
) => void;
