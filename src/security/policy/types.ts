import type {
  SovereignCapability,
} from "../../orchestration/types.js";

export type DataClassification =
  | "PUBLIC"
  | "INTERNAL"
  | "CONFIDENTIAL"
  | "RESTRICTED";

export type CompromiseState =
  | "NORMAL"
  | "SUSPECTED"
  | "CONTAINED"
  | "RECOVERY"
  | "VERIFIED";

export type DataHandlingPolicy = {
  classification: DataClassification;
  externalModelAllowed: boolean;
  externalStorageAllowed: boolean;
  secretMaterialAllowed: false;
  retentionClass:
    | "EPHEMERAL"
    | "STANDARD"
    | "REGULATED";
};

export type EgressDestination = {
  scheme:
    | "https"
    | "http"
    | "ssh"
    | "local";
  host: string;
  port?: number;
  purpose: string;
};

export type SecretReference = {
  ref: string;
  kind:
    | "CREDENTIAL"
    | "TOKEN"
    | "KEY"
    | "CERTIFICATE"
    | "OTHER";
  owner: string;
  scope: string;
  metadata: Record<
    string,
    string | number | boolean
  >;
};

export type EvidenceLineageEntry = {
  lineageId: string;
  artifactType: string;
  artifactHash: string;
  policyDecisionHash: string;
  previousHash?: string;
  entryHash: string;
  createdAt: string;
};

export type SecurityPolicyInput =
  | {
      kind: "DATA_HANDLING";
      handling: DataHandlingPolicy;
      destination:
        | "LOCAL_MODEL"
        | "EXTERNAL_MODEL"
        | "LOCAL_STORAGE"
        | "EXTERNAL_STORAGE"
        | "OPERATOR_OUTPUT";
      containsSecretMaterial: boolean;
    }
  | {
      kind: "EGRESS";
      classification: DataClassification;
      destination: EgressDestination;
      allowedHosts: string[];
    }
  | {
      kind: "CAPABILITY";
      compromiseState: CompromiseState;
      requested:
        SovereignCapability[];
    }
  | {
      kind: "AUTOMATION";
      compromiseState: CompromiseState;
      operation:
        | "RECOVERY_CAPTURE"
        | "RECOVERY_VERIFY"
        | "RECOVERY_DRILL"
        | "RECOVERY_DRIFT";
    };

export type SecurityPolicyDecision = {
  allow: boolean;
  reasons: string[];
  obligations: string[];
  source:
    | "BUILTIN"
    | "OPA";
  decisionId?: string;
};

export type SecurityPolicyEvaluator = {
  evaluate(
    input: SecurityPolicyInput,
  ): Promise<SecurityPolicyDecision>;
};
