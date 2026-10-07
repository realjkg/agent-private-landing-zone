import type {
  IaCEngine,
} from "../../build/types.js";
import type {
  Provider,
} from "../../discovery/types.js";
import type {
  RecoveryScopeType,
  RecoveryTargetSpec,
} from "../target.js";

export type RecoveryOrganization =
  | "STARTUP"
  | "ENTERPRISE";

export type RecoveryEnvironment =
  | "DEVELOPMENT"
  | "PRODUCTION";

export type RecoveryCriticality =
  | "NON_CRITICAL"
  | "BUSINESS"
  | "CRITICAL";

export type RecoveryProfileSelection = {
  organization: RecoveryOrganization;
  environment: RecoveryEnvironment;
  criticality: RecoveryCriticality;
  compliancePacks: string[];
};

export type RecoveryTargetIntent = {
  targetId: string;
  owner: string;
  provider: Provider;
  scopeId: string;
  organization: RecoveryOrganization;
  environment: RecoveryEnvironment;
  criticality: RecoveryCriticality;
  compliancePacks?: string[];
};

export type RecoveryContinuityProfile = {
  rpoMinutes: number;
  rtoMinutes: number;
  retentionDays: number;
  maximumRestoreEvidenceAgeDays: number;
  captureEveryMinutes: number;
  verifyEveryMinutes: number;
  drillEveryMinutes: number;
  driftEveryMinutes: number;
  minimumHealthyCopies: number;
  minimumFailureDomains: number;
  immutable: boolean;
};

export type RecoverySecurityBaseline = {
  documentId: string;
  documentVersion: string;
  documentRef: string;
  expectedSha256: string;
  requiredDataClassification:
    | "PUBLIC"
    | "INTERNAL"
    | "CONFIDENTIAL"
    | "RESTRICTED";
  defaultDenyEgress: true;
  customerManagedEncryption: true;
  providerEdgeRecovery: true;
  immutableRecovery: true;
  centralControlCanDecrypt: false;
  isolatedPreviewRestore: true;
  tamperEvidentEvidence: true;
  compromiseContainment: true;
  actEnabled: false;
  lockedControls: string[];
};

export type RecoveryCompileContext = {
  scopeType?: RecoveryScopeType;
  engine: IaCEngine;
  approvedDesignHash: string;
  designRef: string;
  sourceOfTruthRef: string;
  destinationTargetRef: string;
  sourceCommit?: string;
  complianceOverlays?: Record<
    string,
    Partial<RecoveryContinuityProfile>
  >;
  authorizedOverrides?: Partial<RecoveryContinuityProfile>;
};

export type RecoveryMetadata = {
  apiVersion: "alz.io/recovery/v1";
  selection: RecoveryProfileSelection;
  objectives: {
    rpoMinutes: number;
    rtoMinutes: number;
    retentionDays: number;
    maximumRestoreEvidenceAgeDays: number;
  };
  destination: {
    placement: "PROVIDER_EDGE";
    targetRef: string;
    encryption: "CUSTOMER_MANAGED";
    immutable: boolean;
    minimumHealthyCopies: number;
    minimumFailureDomains: number;
    centralControlCanDecrypt: false;
  };
  automation: {
    captureEveryMinutes: number;
    verifyEveryMinutes: number;
    drillEveryMinutes: number;
    driftEveryMinutes: number;
    restoreMode: "ISOLATED_PREVIEW";
    productionMutation: false;
  };
  securityBaseline: {
    documentId: string;
    documentVersion: string;
    documentRef: string;
    expectedSha256: string;
    failClosedOnMissing: true;
    failClosedOnHashMismatch: true;
  };
  dataBoundary: {
    productionDataAllowed: boolean;
  };
  policy: {
    evaluator: "INHERIT";
    decisions: {
      capture: "recovery/capture";
      verify: "recovery/verify";
      drill: "recovery/drill";
      drift: "recovery/drift";
      restore: "recovery/restore";
    };
    compromiseBehavior: {
      NORMAL: "EVALUATE";
      SUSPECTED: "SUSPEND";
      CONTAINED: "SUSPEND";
      RECOVERY: "ISOLATED_ONLY";
      VERIFIED: "EVALUATE";
    };
  };
  provenance: {
    targetSchemaVersion: 1;
    profileCatalogVersion: 1;
    compilerVersion: "1";
    baselineDocumentHash: string;
    compiledTargetHash: string;
    compiledPolicyHash: string;
    sourceCommit?: string;
  };
};

export type CompiledRecoveryTarget =
  RecoveryTargetSpec & {
    recoveryMetadata: RecoveryMetadata;
  };

export type RecoveryProfileDiff = {
  changed: boolean;
  changes: Array<{
    path: string;
    from: string | number | boolean;
    to: string | number | boolean;
  }>;
};
