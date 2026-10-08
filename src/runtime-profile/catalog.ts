import type {
  RuntimeProfile,
  RuntimeProfileId,
} from "./types.js";

export const RUNTIME_PROFILES:
  RuntimeProfile[] = [
    {
      id:
        "GOVERNED_ENTERPRISE_CONNECTED",
      sovereignty:
        "ENTERPRISE",
      connectivity:
        "CONNECTED",
      controlPlane:
        "LOCAL_OR_APPROVED",
      modelLocality:
        "LOCAL_OR_APPROVED",
      a2a:
        "POLICY_CONTROLLED",
      externalTelemetryAllowed:
        true,
      localTraceabilityRequired:
        true,
      genericInfrastructureAct:
        false,
      notes:
        "Connected enterprise profile with governed external integrations.",
    },
    {
      id:
        "SOVEREIGN_PUBLIC",
      sovereignty:
        "SOVEREIGN_PUBLIC",
      connectivity:
        "CONNECTED",
      controlPlane:
        "SOVEREIGN_PROVIDER",
      modelLocality:
        "SOVEREIGN_DOMAIN_ONLY",
      a2a:
        "POLICY_CONTROLLED",
      externalTelemetryAllowed:
        false,
      localTraceabilityRequired:
        true,
      genericInfrastructureAct:
        false,
      notes:
        "Provider-operated sovereign realm; telemetry must remain inside the approved sovereign domain.",
    },
    {
      id:
        "PRIVATE_SOVEREIGN_CONNECTED",
      sovereignty:
        "PRIVATE_SOVEREIGN",
      connectivity:
        "SAME_SOVEREIGN_DOMAIN_ONLY",
      controlPlane:
        "LOCAL_REQUIRED",
      modelLocality:
        "LOCAL_ONLY",
      a2a:
        "SAME_SOVEREIGN_DOMAIN_ONLY",
      externalTelemetryAllowed:
        false,
      localTraceabilityRequired:
        true,
      genericInfrastructureAct:
        false,
      notes:
        "Dedicated private sovereign infrastructure with connectivity confined to the approved sovereign control domain.",
    },
    {
      id:
        "PRIVATE_SOVEREIGN_DISCONNECTED",
      sovereignty:
        "PRIVATE_SOVEREIGN",
      connectivity:
        "DISCONNECTED",
      controlPlane:
        "LOCAL_REQUIRED",
      modelLocality:
        "LOCAL_ONLY",
      a2a:
        "DISABLED",
      externalTelemetryAllowed:
        false,
      localTraceabilityRequired:
        true,
      genericInfrastructureAct:
        false,
      notes:
        "No external runtime dependency; identity, models, telemetry, evidence and operations remain local.",
    },
    {
      id:
        "PRIVATE_SOVEREIGN_MULTI_SITE",
      sovereignty:
        "PRIVATE_SOVEREIGN",
      connectivity:
        "SAME_SOVEREIGN_DOMAIN_ONLY",
      controlPlane:
        "LOCAL_REQUIRED",
      modelLocality:
        "LOCAL_ONLY",
      a2a:
        "SAME_SOVEREIGN_DOMAIN_ONLY",
      externalTelemetryAllowed:
        false,
      localTraceabilityRequired:
        true,
      genericInfrastructureAct:
        false,
      notes:
        "Multiple private sites under the same approved legal and operational sovereignty domain.",
    },
    {
      id:
        "SOVEREIGN_EDGE",
      sovereignty:
        "PRIVATE_SOVEREIGN",
      connectivity:
        "INTERMITTENT",
      controlPlane:
        "LOCAL_REQUIRED",
      modelLocality:
        "LOCAL_ONLY",
      a2a:
        "SAME_SOVEREIGN_DOMAIN_ONLY",
      externalTelemetryAllowed:
        false,
      localTraceabilityRequired:
        true,
      genericInfrastructureAct:
        false,
      notes:
        "Local edge operation with buffered evidence and no dependency on external connectivity.",
    },
    {
      id:
        "HYBRID_SOVEREIGN_BOUNDARY",
      sovereignty:
        "HYBRID_SOVEREIGN",
      connectivity:
        "CONNECTED",
      controlPlane:
        "LOCAL_REQUIRED",
      modelLocality:
        "LOCAL_ONLY",
      a2a:
        "POLICY_CONTROLLED",
      externalTelemetryAllowed:
        true,
      localTraceabilityRequired:
        true,
      genericInfrastructureAct:
        false,
      notes:
        "Private sovereign zone with explicitly governed exchange to external enterprise or cloud zones.",
    },
    {
      id:
        "MANAGED_SOVEREIGN_TENANT",
      sovereignty:
        "PRIVATE_SOVEREIGN",
      connectivity:
        "SAME_SOVEREIGN_DOMAIN_ONLY",
      controlPlane:
        "LOCAL_REQUIRED",
      modelLocality:
        "SOVEREIGN_DOMAIN_ONLY",
      a2a:
        "SAME_SOVEREIGN_DOMAIN_ONLY",
      externalTelemetryAllowed:
        false,
      localTraceabilityRequired:
        true,
      genericInfrastructureAct:
        false,
      notes:
        "Dedicated tenant boundary operated by an approved sovereign managed-service authority.",
    },
  ];

export function runtimeProfile(
  id: RuntimeProfileId,
): RuntimeProfile {
  const profile =
    RUNTIME_PROFILES.find(
      (candidate) =>
        candidate.id === id,
    );

  if (!profile) {
    throw new Error(
      "RUNTIME_PROFILE_UNKNOWN: " +
        id,
    );
  }

  return profile;
}
