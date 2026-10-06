import type {
  Provider,
  SourceOfTruth,
} from "../discovery/types.js";

export type PostureStatus =
  | "SECURE"
  | "INSECURE"
  | "PARTIAL"
  | "UNKNOWN";

export type AssessmentSeverity =
  | "INFO"
  | "LOW"
  | "MEDIUM"
  | "HIGH"
  | "CRITICAL";

export type AssessmentDomain =
  | "IDENTITY"
  | "NETWORK"
  | "ENCRYPTION"
  | "LOGGING"
  | "SUPPLY_CHAIN"
  | "CONFIGURATION"
  | "RESILIENCY"
  | "OWNERSHIP"
  | "PLATFORM";

export type PostureFinding = {
  id: string;
  domain: AssessmentDomain;
  severity: AssessmentSeverity;
  title: string;
  detail: string;
  resourceId?: string;
  evidenceRefs: string[];
};

export type InventoryPosture = {
  totalAssets: number;
  physicalAssets: number;
  virtualAssets: number;
  cloudAssets: number;
  customerManaged: number;
  acceleratorManaged: number;
  otherIaCManaged: number;
  unknownOwnership: number;
};

export type SbomPosture = {
  status: "PRESENT" | "PARTIAL" | "MISSING" | "UNKNOWN";
  formats: string[];
  componentCount: number;
  vulnerableComponents: number;
  evidenceRefs: string[];
};

export type ResiliencyPosture = {
  status: PostureStatus;
  configurationBackup:
    | "PRESENT"
    | "PARTIAL"
    | "MISSING"
    | "UNKNOWN";
  restoreEvidence:
    | "VERIFIED"
    | "UNVERIFIED"
    | "MISSING"
    | "UNKNOWN";
  redundantControlPlane:
    | "PRESENT"
    | "MISSING"
    | "UNKNOWN";
  rpoKnown: boolean;
  rtoKnown: boolean;
  evidenceRefs: string[];
};

export type ConfigurationRecoveryResource = {
  resourceId: string;
  resourceType: string;
  name: string;
  ownership: string;
  mutationPolicy: string;
  sourceOfTruth: SourceOfTruth;
  scope?: string;
  region?: string;
};

export type ConfigurationRecoverySnapshot = {
  snapshotId: string;
  provider: Provider;
  capturedAt: string;
  resourceCount: number;
  resources: ConfigurationRecoveryResource[];
  sourceOfTruthCounts: Partial<Record<SourceOfTruth, number>>;
  evidenceRefs: string[];
  configurationHash: string;
  coverage:
    | "MANIFEST_ONLY"
    | "CONFIGURATION_EXPORT"
    | "FULL";
  restoreStatus:
    | "VERIFIED"
    | "UNVERIFIED"
    | "BLOCKED";
  blockers: string[];
};

export type DiscoveryAssessment = {
  assessmentId: string;
  assessedAt: string;
  inventory: InventoryPosture;
  securityStatus: PostureStatus;
  findings: PostureFinding[];
  sbom: SbomPosture;
  resiliency: ResiliencyPosture;
  recoverySnapshot: ConfigurationRecoverySnapshot;
  evidenceRefs: string[];
};
