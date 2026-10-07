export type PillarName =
  | "SECURITY"
  | "COST"
  | "RESILIENCY"
  | "RELIABILITY"
  | "PERFORMANCE"
  | "SUSTAINABILITY";

export type PillarStatus =
  | "SATISFIED"
  | "PARTIAL"
  | "VIOLATED"
  | "UNKNOWN";

export type PolicyRequirement = {
  id: string;
  description: string;
  status: PillarStatus;
  evidenceRefs: string[];
  controls: string[];
};

export type PillarPolicy = {
  pillar: PillarName;
  status: PillarStatus;
  requirements: PolicyRequirement[];
  controls: string[];
  evidenceRefs: string[];
  unknowns: string[];
};

export type PillarPolicyBundle = {
  version: "1";
  bundleId: string;
  bundleHash: string;
  security: PillarPolicy;
  cost: PillarPolicy;
  resiliency: PillarPolicy;
  reliability: PillarPolicy;
  performance: PillarPolicy;
  sustainability: PillarPolicy;
};
