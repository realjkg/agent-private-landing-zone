import type {
  Provider,
} from "../discovery/types.js";
import type {
  DeltaAction,
} from "../delta/types.js";

export type RecoveryArtifactKind =
  | "INVENTORY_MANIFEST"
  | "CONFIGURATION_EXPORT"
  | "IAC_SOURCE"
  | "IAC_STATE"
  | "POLICY_CONFIGURATION";

export type RecoveryCoverage =
  | "MANIFEST_ONLY"
  | "CONFIGURATION_EXPORT"
  | "IAC_STATE"
  | "FULL";

export type RecoveryProtection =
  | "HASHED"
  | "ENCRYPTED_EVIDENCE"
  | "UNKNOWN";

export type RecoveryPolicy = {
  policyId: string;
  provider: Provider;
  scope: string;
  retentionDays:
    | number
    | "UNKNOWN";
  rpo: string | "UNKNOWN";
  rto: string | "UNKNOWN";
  owner: string | "UNKNOWN";
  immutability:
    | "REQUIRED"
    | "OPTIONAL"
    | "UNKNOWN";
  offlineCopy:
    | "REQUIRED"
    | "OPTIONAL"
    | "UNKNOWN";
  requiredArtifacts:
    RecoveryArtifactKind[];
  evidenceRefs: string[];
};

export type PlatformConfigurationCapture = {
  provider: Provider;
  resourceIds: string[];
  configurationEvidenceRefs: string[];
  missingEvidence: string[];
  secretFree: true;
};

export type RecoveryArtifact = {
  artifactId: string;
  kind: RecoveryArtifactKind;
  provider: Provider;
  source: string;
  resourceIds: string[];
  evidenceRefs: string[];
  contentHash: string;
  protection: RecoveryProtection;
  secretFree: true;
};

export type RecoveryPoint = {
  recoveryPointId: string;
  kind:
    "SIMULATED_PLATFORM_RECOVERY_POINT";
  provider: Provider;
  capturedAt: string;
  policyId: string;
  sourceConfigurationHash: string;
  designHash?: string;
  policyBundleHash?: string;
  artifacts: RecoveryArtifact[];
  coverage: RecoveryCoverage;
  recoveryPointHash: string;
  restoreStatus: "UNVERIFIED";
  restorePrerequisites: string[];
  blockers: string[];
  unknowns: string[];
  actEnabled: false;
};

export type RecoveryCheck = {
  name: string;
  status:
    | "PASS"
    | "FAIL"
    | "UNKNOWN";
  detail: string;
};

export type RecoveryVerification = {
  recoveryPointId: string;
  status:
    | "VERIFIED"
    | "PARTIAL"
    | "BLOCKED";
  verifiedAt: string;
  checks: RecoveryCheck[];
  blockers: string[];
  unknowns: string[];
  evidenceRefs: string[];
};

export type RestoreDecision = {
  resourceId: string;
  resourceType: string;
  action: DeltaAction;
  reconstructible: boolean;
  rationale: string;
};

export type SimulatedRestoreDrill = {
  drillId: string;
  recoveryPointId: string;
  designHash: string;
  status:
    | "READY_FOR_REVIEW"
    | "BLOCKED";
  designHashMatches: boolean;
  decisions: RestoreDecision[];
  blockers: string[];
  evidenceRefs: string[];
  mutationAttempted: false;
  actEnabled: false;
};

export type RecoveryDriftComparison = {
  status:
    | "MATCHED"
    | "DRIFTED";
  currentConfigurationHash: string;
  recoveryConfigurationHash: string;
  designHash: string;
  currentNotProtected: string[];
  recoveryOnly: string[];
  expectedDesignDelta: string[];
  recoverabilityRisks: string[];
};
