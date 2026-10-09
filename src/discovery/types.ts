import type { Emitter } from "../observability/bus.js";

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

export type ScannerObservation = {
  id: string;
  scanner: string;
  source: string;
  status:
    | "PASS"
    | "FAIL"
    | "UNKNOWN";
  domain:
    | "IDENTITY"
    | "NETWORK"
    | "ENCRYPTION"
    | "LOGGING"
    | "SUPPLY_CHAIN"
    | "CONFIGURATION"
    | "RESILIENCY"
    | "OWNERSHIP"
    | "PLATFORM";
  severity:
    | "INFO"
    | "LOW"
    | "MEDIUM"
    | "HIGH"
    | "CRITICAL";
  title: string;
  detail: string;
  resourceId?: string;
};

export type SbomComponentObservation = {
  name: string;
  version?: string;
  componentType:
    | "PACKAGE"
    | "CONTAINER"
    | "FIRMWARE"
    | "MODEL"
    | "OPERATING_SYSTEM"
    | "DEVICE"
    | "OTHER";
  format:
    | "CYCLONEDX"
    | "SPDX"
    | "NATIVE"
    | "UNKNOWN";
  vulnerabilities: number;
  evidenceRefs: string[];
};

export type ResiliencyObservation = {
  key:
    | "configuration_backup"
    | "restore_test"
    | "redundant_control_plane"
    | "rpo"
    | "rto";
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
  scannerObservations: ScannerObservation[];
  sbomComponents: SbomComponentObservation[];
  sbomComplete: boolean;
  resiliencyObservations: ResiliencyObservation[];
  warnings: string[];
};

export type MockScenario =
  | "brownfield"
  | "greenfield"
  | "unknown";

export type DiscoveryEvidenceBundle = {
  resources?: DiscoveredResource[];
  scannerObservations?: ScannerObservation[];
  sbomComponents?: SbomComponentObservation[];
  sbomComplete?: boolean;
  resiliencyObservations?: ResiliencyObservation[];
};

export type DiscoveryOptions = {
  provider: Provider;
  mock?: MockScenario;
  evidenceBundle?: DiscoveryEvidenceBundle;
  /** Process observability bus; defaults to disabled (no emission). */
  emitter?: Emitter;
};

export type DiscoveryEvent =
  | "DISCOVERY_START"
  | "PROVIDER_DETECTED"
  | "RESOURCE_DISCOVERED"
  | "OWNERSHIP_CLASSIFIED"
  | "SCANNER_OBSERVED"
  | "SBOM_OBSERVED"
  | "RESILIENCY_OBSERVED"
  | "ENVIRONMENT_CLASSIFIED"
  | "DISCOVERY_COMPLETE"
  | "DISCOVERY_FAILED";

export type DiscoveryReporter = (
  event: DiscoveryEvent,
  detail?: string,
) => void;
