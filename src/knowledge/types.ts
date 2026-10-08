export type KnowledgeSourceId =
  | "SOVEREIGN_LZ_CORPUS"
  | "TERRAFORM_REGISTRY"
  | "PULUMI_REGISTRY"
  | "PULUMI_CORE"
  | "PYTHON_STDLIB"
  | "AZURE_VERIFIED_MODULES"
  | "AZURE_BICEP_REGISTRY_MODULES"
  | "AWS_CDK"
  | "NIST_AI_RMF"
  | "NIST_ZERO_TRUST"
  | "OWASP_AGENT_SECURITY";

export type KnowledgeSourceClass =
  | "INTERNAL_CORPUS"
  | "DYNAMIC_REGISTRY"
  | "LANGUAGE_REFERENCE"
  | "VERIFIED_MODULE_CATALOG"
  | "SOURCE_CODE_REPOSITORY"
  | "GOVERNANCE_STANDARD"
  | "SECURITY_GUIDANCE";

export type KnowledgeTrust =
  | "INTERNAL"
  | "AUTHORITATIVE"
  | "PRIMARY_VENDOR"
  | "COMMUNITY_MIXED";

export type KnowledgeSource = {
  id: KnowledgeSourceId;
  sourceClass: KnowledgeSourceClass;
  canonicalUri: string;
  trust: KnowledgeTrust;
  dynamic: boolean;
  runtimeInternetRequired: false;
  mirrorRequiredForPrivateSovereign: boolean;
  ingestIncludes: string[];
  notes: string;
};

export type KnowledgeSnapshot = {
  schemaVersion: 1;
  sourceId: KnowledgeSourceId;
  sourceUri: string;
  retrievedAt: string;
  sourceVersion?: string;
  contentType:
    | "application/json"
    | "text/html"
    | "text/markdown"
    | "text/plain";
  sha256: string;
  localMirrorRef?: string;
  records: KnowledgeRecord[];
};

export type KnowledgeRecord = {
  recordId: string;
  kind:
    | "SOURCE_FACT"
    | "PACKAGE"
    | "PROVIDER"
    | "MODULE"
    | "POLICY"
    | "API"
    | "RESOURCE"
    | "FUNCTION"
    | "TYPE"
    | "LIBRARY_MODULE"
    | "CONTROL"
    | "GUIDANCE";
  title: string;
  version?: string;
  publisher?: string;
  classification?: string;
  sourceRef?: string;
  metadata: Record<string, unknown>;
};

export type KnowledgeIngestionResult = {
  source: KnowledgeSource;
  snapshot: KnowledgeSnapshot;
  accepted: boolean;
  reasons: string[];
  recordCount: number;
};
