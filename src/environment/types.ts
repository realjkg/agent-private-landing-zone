import type { RuntimeProfileId } from "../runtime-profile/types.js";

export type EnvironmentProviderId = "KUBERNETES" | "OPENSHIFT" | "VCF" | "VCENTER" | "SOVEREIGN_EDGE";
export type EnvironmentDeployment = "LOCAL" | "SOVEREIGN_DOMAIN" | "EXTERNAL";
export type EnvironmentHealth = "HEALTHY" | "DEGRADED" | "UNKNOWN";
export type EvidenceStatus = "OBSERVED" | "INCOMPLETE" | "UNAVAILABLE";

export type EnvironmentBinding = {
  environmentId: string;
  provider: Exclude<EnvironmentProviderId, "SOVEREIGN_EDGE">;
  runtimeProfile: RuntimeProfileId;
  deployment: EnvironmentDeployment;
  origin: string;
  authRef?: string;
};

export type EnvironmentReadRequest = {
  method: "GET";
  origin: string;
  path: string;
  authRef?: string;
  timeoutMs: number;
  maxResponseBytes: number;
};
export type EnvironmentReadResponse = { status: number; body: string };
export type EnvironmentReadTransport = (request: EnvironmentReadRequest) => Promise<EnvironmentReadResponse>;

export type EnvironmentAsset = {
  id: string;
  kind: string;
  name: string;
  namespace?: string;
  parentId?: string;
  health: EnvironmentHealth;
};
export type EnvironmentLink = { from: string; to: string; relation: "CONTAINS" };
export type EnvironmentEvidence = {
  path: string;
  status: EvidenceStatus;
  responseSha256?: string;
  httpStatus?: number;
};
export type EnvironmentSnapshot = {
  schemaVersion: 1;
  environmentId: string;
  provider: EnvironmentProviderId;
  runtimeProfile: RuntimeProfileId;
  health: EnvironmentHealth;
  identityObserved: boolean;
  inventory: EnvironmentAsset[];
  topology: EnvironmentLink[];
  evidence: EnvironmentEvidence[];
  complete: boolean;
  warnings: string[];
  readOnly: true;
  mutationSupported: false;
};
export interface EnvironmentProvider {
  identify(): Promise<{ environmentId: string; provider: EnvironmentProviderId; observed: boolean }>;
  capabilities(): { discover: true; health: true; inventory: true; topology: true; evidence: true; mutation: false };
  discover(): Promise<EnvironmentSnapshot>;
  health(): Promise<EnvironmentHealth>;
  inventory(): Promise<EnvironmentAsset[]>;
  topology(): Promise<EnvironmentLink[]>;
  evidence(): Promise<EnvironmentEvidence[]>;
}
