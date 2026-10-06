import type {
  DiscoveredResource,
  MutationPolicy,
  OwnershipSummary,
  OwnershipType,
} from "./types.js";

export function mutationPolicyForOwnership(
  ownership: OwnershipType,
  explicitAdoption = false,
): MutationPolicy {
  switch (ownership) {
    case "MANAGED_BY_ACCELERATOR":
      return "ADDITIVE_ONLY";
    case "ADOPTED":
      return explicitAdoption ? "UPDATE_ALLOWED" : "READ_ONLY";
    default:
      return "READ_ONLY";
  }
}

export function enforceOwnershipPolicy(
  resource: DiscoveredResource,
): DiscoveredResource {
  const explicitAdoption =
    resource.ownership === "ADOPTED" &&
    resource.metadata?.explicitAdoption === true;

  return {
    ...resource,
    mutationPolicy: mutationPolicyForOwnership(
      resource.ownership,
      explicitAdoption,
    ),
  };
}

export function summarizeOwnership(
  resources: DiscoveredResource[],
): OwnershipSummary {
  return resources.reduce<OwnershipSummary>(
    (summary, resource) => {
      if (resource.mutationPolicy === "DELETE_ALLOWED") {
        throw new Error(
          `Discovery may not grant DELETE_ALLOWED: ${resource.resourceId}`,
        );
      }

      if (resource.mutationPolicy === "READ_ONLY") {
        summary.readOnly += 1;
      } else if (resource.mutationPolicy === "ADDITIVE_ONLY") {
        summary.additiveOnly += 1;
      } else if (resource.mutationPolicy === "UPDATE_ALLOWED") {
        summary.updateAllowed += 1;
      }

      if (resource.ownership === "UNKNOWN") {
        summary.unknown += 1;
      }

      return summary;
    },
    {
      readOnly: 0,
      additiveOnly: 0,
      updateAllowed: 0,
      unknown: 0,
    },
  );
}
