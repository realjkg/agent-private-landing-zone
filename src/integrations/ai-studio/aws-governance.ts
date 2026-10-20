/**
 * AWS governance ownership classification for the existing-estate builder.
 * This does not grant IAM authority or replace inspection of the actual engine plan.
 * IaC resource aliases are normalized so a generic agent cannot bypass policy.
 */
export type GovernanceOperation = "CREATE" | "UPDATE" | "DELETE" | "IMPORT" | "READ";
export type GovernanceVerdict = "REUSE" | "APPLICATION_CHANGE" | "GOVERNANCE_APPROVAL_REQUIRED" | "PARALLEL_GOVERNANCE_FORBIDDEN" | "BOOTSTRAP_APPROVAL_REQUIRED" | "UNKNOWN_REVIEW_REQUIRED";
export type ResourceIntent = { resourceType: string; action: GovernanceOperation };
export type ClassifiedResource = ResourceIntent & { verdict: GovernanceVerdict; reason: string };

const normalize = (s: string): string => s.trim().toLowerCase().replace(/[^a-z0-9]/g, "");
// Explicitly enumerate the high-impact estate root and account-vending resources.
const ESTATE_ROOTS = new Set(["awscontroltowerlandingzone", "awsorganizationsorganization"]);
const OPAQUE_WRAPPERS = new Set([
  "awscloudformationstack", "awscloudformationstackset",
  "awscloudformationstacksetinstance", "awscdkcustomresource",
  "awscustomresource", "awspulumistackreference"
]);
const GOVERNANCE_TYPES = new Set([
  "awscontroltowerenabledcontrol", "awscontroltowercontrol",
  "awsorganizationspolicy", "awsorganizationsorganizationalunit",
  "awsorganizationsaccount", "awscontroltowerenabledbaseline",
  "awscontroltowerbaseline", "awsservicecatalogprovisionedproduct"
]);
export type GovernanceEvidence = {
  organization: "EXISTS" | "ABSENT" | "UNKNOWN";
  landingZone: "EXISTS" | "ABSENT" | "UNKNOWN";
  managementAccountVerified: boolean;
};
export function classifyAwsResource(input: ResourceIntent, evidence?: GovernanceEvidence): ClassifiedResource {
  const type = normalize(String(input?.resourceType ?? ""));
  const action = input?.action;
  if (!type || !["CREATE", "UPDATE", "DELETE", "IMPORT", "READ"].includes(action))
    return { ...input, verdict: "UNKNOWN_REVIEW_REQUIRED", reason: "INVALID_RESOURCE_INTENT" };
  if (action === "READ") return { ...input, verdict: "REUSE", reason: "DISCOVERY_ONLY" };
  if (OPAQUE_WRAPPERS.has(type) || type.startsWith("custom") || type.startsWith("awscustomresource"))
    return { ...input, verdict: "UNKNOWN_REVIEW_REQUIRED", reason: "OPAQUE_NESTED_INFRASTRUCTURE_REQUIRES_EXPANSION" };
  if (ESTATE_ROOTS.has(type)) {
    if (action !== "CREATE")
      return { ...input, verdict: "GOVERNANCE_APPROVAL_REQUIRED", reason: "ROOT_GOVERNANCE_LIFECYCLE_CHANGE" };
    const state = type === "awscontroltowerlandingzone" ? evidence?.landingZone : evidence?.organization;
    if (state === "EXISTS")
      return { ...input, verdict: "PARALLEL_GOVERNANCE_FORBIDDEN", reason: "GOVERNANCE_ROOT_ALREADY_EXISTS" };
    if (state === "ABSENT" && evidence?.managementAccountVerified)
      return { ...input, verdict: "BOOTSTRAP_APPROVAL_REQUIRED", reason: "FIRST_TIME_GOVERNANCE_BOOTSTRAP" };
    return { ...input, verdict: "UNKNOWN_REVIEW_REQUIRED", reason: "GOVERNANCE_DISCOVERY_AND_MANAGEMENT_IDENTITY_REQUIRED" };
  }
  if (GOVERNANCE_TYPES.has(type) || type.startsWith("awscontroltower") || type.startsWith("awsorganizations"))
    return { ...input, verdict: "GOVERNANCE_APPROVAL_REQUIRED", reason: "POLICY_OWNER_AUTHORITY_REQUIRED" };
  if (type.includes("landingzone") || type.includes("controltower") || type.includes("organization"))
    return { ...input, verdict: "UNKNOWN_REVIEW_REQUIRED", reason: "AMBIGUOUS_GOVERNANCE_RESOURCE" };
  return { ...input, verdict: "APPLICATION_CHANGE", reason: "SUBJECT_TO_NORMAL_IAC_AND_POLICY_GATES" };
}
