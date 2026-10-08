export type RuntimeProfileId =
  | "GOVERNED_ENTERPRISE_CONNECTED"
  | "SOVEREIGN_PUBLIC"
  | "PRIVATE_SOVEREIGN_CONNECTED"
  | "PRIVATE_SOVEREIGN_DISCONNECTED"
  | "PRIVATE_SOVEREIGN_MULTI_SITE"
  | "SOVEREIGN_EDGE"
  | "HYBRID_SOVEREIGN_BOUNDARY"
  | "MANAGED_SOVEREIGN_TENANT";

export type SovereigntyClass =
  | "ENTERPRISE"
  | "SOVEREIGN_PUBLIC"
  | "PRIVATE_SOVEREIGN"
  | "HYBRID_SOVEREIGN";

export type ConnectivityClass =
  | "CONNECTED"
  | "SAME_SOVEREIGN_DOMAIN_ONLY"
  | "DISCONNECTED"
  | "INTERMITTENT";

export type A2APolicy =
  | "POLICY_CONTROLLED"
  | "SAME_SOVEREIGN_DOMAIN_ONLY"
  | "DISABLED";

export type ControlPlaneLocality =
  | "LOCAL_REQUIRED"
  | "SOVEREIGN_PROVIDER"
  | "LOCAL_OR_APPROVED";

export type ModelLocality =
  | "LOCAL_ONLY"
  | "SOVEREIGN_DOMAIN_ONLY"
  | "LOCAL_OR_APPROVED";

export type RuntimeProfile = {
  id: RuntimeProfileId;
  sovereignty: SovereigntyClass;
  connectivity: ConnectivityClass;
  controlPlane: ControlPlaneLocality;
  modelLocality: ModelLocality;
  a2a: A2APolicy;
  externalTelemetryAllowed: boolean;
  localTraceabilityRequired: true;
  genericInfrastructureAct: false;
  notes: string;
};
