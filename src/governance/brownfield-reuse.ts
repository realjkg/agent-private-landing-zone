import { createHash } from "node:crypto";

/**
 * Read-only comparison of CUSTOMER-SUPPLIED manifests, not a policy parser,
 * cloud connection, template importer, attestation or deployment authorization.
 */
export const CLOUD_POLICY_FAMILIES = {
  AWS: ["CONTROL_TOWER_CONTROL", "SCP", "RCP", "AWS_CONFIG_RULE", "CLOUDFORMATION_TEMPLATE", "SECURITY_GROUP", "IAM_POLICY"],
  AZURE: ["AZURE_POLICY_ASSIGNMENT", "AZURE_POLICY_INITIATIVE", "AZURE_POLICY_DEFINITION", "AZURE_VERIFIED_MODULE", "NETWORK_SECURITY_GROUP", "RBAC"],
  GCP: ["ORGANIZATION_POLICY", "ORG_POLICY_CONSTRAINT", "POLICY_LIBRARY_TEMPLATE", "POLICY_LIBRARY_CONSTRAINT", "TERRAFORM_BLUEPRINT", "IAM_POLICY", "VPC_FIREWALL_POLICY"],
} as const;
export type BrownfieldProvider = keyof typeof CLOUD_POLICY_FAMILIES;
export type PolicyRef = {
  /** Stable customer-supplied native control/asset identifier. */
  id: string;
  family: string;
  /** Immutable source lineage identifier: repo commit, IaC state or control ID. */
  sourceOfTruth: string;
  /** SHA-256 of the customer's source definition or effective assignment snapshot. */
  definitionSha256: string;
  /** Affected organizational-unit/management-group/org-folder-project scope. */
  assignedScope: string;
};
export type ProtectedResource = {
  id: string;
  category: "NETWORK" | "IDENTITY" | "LOGGING" | "ENCRYPTION" | "PLATFORM" | "POLICY";
  /** Hash of customer-reported resource configuration, without secrets. */
  configurationSha256: string;
  sourceOfTruth: string;
  ownership: "CUSTOMER" | "EXTERNAL_IAC";
  mutationPolicy: "READ_ONLY";
};
export type BrownfieldManifest = {
  schemaVersion: 1;
  provider: BrownfieldProvider;
  scope: string;
  /** Display-only designation: not an infrastructure logical/physical resource name. */
  applicationLabel: string;
  controls: PolicyRef[];
  protectedResources: ProtectedResource[];
};
export type BrownfieldReuseAssessment = {
  mode: "OFFLINE_DECLARATION_COMPARISON";
  provider: BrownfieldProvider | "UNKNOWN";
  verdict: "DECLARED_APP_LABEL_ONLY" | "BLOCKED";
  reasons: string[];
  controlsPreserved: boolean;
  protectedInfrastructurePreserved: boolean;
  applicationLabelChanged: boolean;
  nativePolicyComplianceVerified: false;
  importPerformed: false;
  providerCalls: 0;
  infrastructureMutationAllowed: false;
  evidenceBasis: "CUSTOMER_SUPPLIED_MANIFESTS_NOT_ATTESTED";
  comparisonSha256: string;
};

const HEX = /^[a-f0-9]{64}$/;
const KEY = /^[a-zA-Z0-9][a-zA-Z0-9._:/@+* -]{0,511}$/;
const AZURE_ARM_ID = /^\/(?:subscriptions|providers)\/[A-Za-z0-9][A-Za-z0-9._:/@+* -]{0,510}$/;
const textOk = (value: unknown): value is string => typeof value === "string" && !value.includes("../") && (KEY.test(value) || AZURE_ARM_ID.test(value));
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const exactFields = (value: object, allowed: readonly string[]): boolean =>
  Object.keys(value).length === allowed.length && Object.keys(value).every((key) => allowed.includes(key));
const isProvider = (value: unknown): value is BrownfieldProvider =>
  typeof value === "string" && Object.prototype.hasOwnProperty.call(CLOUD_POLICY_FAMILIES, value);

function validate(manifest: BrownfieldManifest): string[] {
  const reasons: string[] = [];
  if (!manifest || manifest.schemaVersion !== 1 || !isProvider(manifest.provider)) {
    return ["Unsupported manifest schema or provider."];
  }
  if (!exactFields(manifest, ["schemaVersion", "provider", "scope", "applicationLabel", "controls", "protectedResources"])) reasons.push("Unexpected manifest fields; application-only schema is closed.");
  if (!textOk(manifest.scope) || !textOk(manifest.applicationLabel)) reasons.push("Scope or display label is invalid.");
  if (!Array.isArray(manifest.controls) || manifest.controls.length === 0) {
    reasons.push("A customer governance-control inventory is required.");
  } else {
    const seen = new Set<string>();
    for (const control of manifest.controls) {
      if (!control || !textOk(control.id) || seen.has(control.id)) {
        reasons.push("Control identifier missing or duplicated.");
        continue;
      }
      seen.add(control.id);
      if (!exactFields(control, ["id", "family", "sourceOfTruth", "definitionSha256", "assignedScope"]) ||
        !(CLOUD_POLICY_FAMILIES[manifest.provider] as readonly string[]).includes(control.family) ||
        !textOk(control.sourceOfTruth) || !textOk(control.assignedScope) ||
        !HEX.test(control.definitionSha256)) {
        reasons.push("Control reference, scope, source or policy fingerprint is unqualified: " + control.id);
      }
    }
  }
  if (!Array.isArray(manifest.protectedResources) || manifest.protectedResources.length === 0) {
    reasons.push("An existing customer infrastructure inventory is required.");
  } else {
    const seen = new Set<string>();
    for (const resource of manifest.protectedResources) {
      if (!resource || !textOk(resource.id) || seen.has(resource.id)) {
        reasons.push("Protected resource ID missing or duplicated.");
        continue;
      }
      seen.add(resource.id);
      if (!exactFields(resource, ["id", "category", "configurationSha256", "sourceOfTruth", "ownership", "mutationPolicy"]) ||
        !["NETWORK", "IDENTITY", "LOGGING", "ENCRYPTION", "PLATFORM", "POLICY"].includes(resource.category) ||
        !textOk(resource.sourceOfTruth) ||
        !HEX.test(resource.configurationSha256) ||
        !["CUSTOMER", "EXTERNAL_IAC"].includes(resource.ownership) ||
        resource.mutationPolicy !== "READ_ONLY") {
        reasons.push("Existing infrastructure must remain externally owned and READ_ONLY: " + resource.id);
      }
    }
  }
  return reasons;
}
const sorted = <T extends { id: string }>(items: readonly T[]): T[] =>
  [...items].sort((a, b) => a.id.localeCompare(b.id));

export function assessBrownfieldApplicationReuse(
  before: BrownfieldManifest,
  proposed: BrownfieldManifest,
): BrownfieldReuseAssessment {
  const reasons = [...validate(before).map((r) => "Baseline: " + r),
    ...validate(proposed).map((r) => "Proposed: " + r)];
  const valid = reasons.length === 0;
  const sameScope = valid && before.provider === proposed.provider && before.scope === proposed.scope;
  const controlsPreserved = sameScope && same(sorted(before.controls), sorted(proposed.controls));
  const protectedInfrastructurePreserved =
    sameScope && same(sorted(before.protectedResources), sorted(proposed.protectedResources));
  const applicationLabelChanged = valid && before.applicationLabel !== proposed.applicationLabel;
  if (valid && !sameScope) reasons.push("Provider or organizational scope changed; existing controls cannot be assumed applicable.");
  if (valid && !controlsPreserved) reasons.push("An existing policy/control reference, assignment, version or fingerprint changed.");
  if (valid && !protectedInfrastructurePreserved) reasons.push("An existing network, identity, logging, encryption or platform resource changed.");
  if (valid && !applicationLabelChanged) reasons.push("No application display-label change was supplied.");
  const canonical = {
    mode: "OFFLINE_DECLARATION_COMPARISON" as const,
    provider: before && isProvider(before.provider) ? before.provider : "UNKNOWN" as const,
    verdict: reasons.length ? "BLOCKED" as const : "DECLARED_APP_LABEL_ONLY" as const,
    reasons, controlsPreserved, protectedInfrastructurePreserved,
    applicationLabelChanged,
    nativePolicyComplianceVerified: false as const,
    importPerformed: false as const,
    providerCalls: 0 as const,
    infrastructureMutationAllowed: false as const,
    evidenceBasis: "CUSTOMER_SUPPLIED_MANIFESTS_NOT_ATTESTED" as const,
  };
  return { ...canonical, comparisonSha256: createHash("sha256").update(JSON.stringify(canonical)).digest("hex") };
}
