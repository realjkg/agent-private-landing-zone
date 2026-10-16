import { createHash } from "node:crypto";
import { assessBrownfieldApplicationReuse, type BrownfieldManifest } from "./brownfield-reuse.js";
import { inspectNativePolicyJson, type NativePolicyDocument } from "./native-policy-inspection.js";
import { inspectCloudPolicySnapshot, type CloudPolicySnapshot } from "./cloud-policy-snapshots.js";
import { assessPhysicalResourceName, type PhysicalNameIntent } from "./naming-resource-catalog.js";

/**
 * Offline preflight of DECLARED control effectiveness and application naming.
 * It does NOT evaluate the native policy language, prove inheritance, or grant
 * compliance, Terraform adoption, credentials, or infrastructure mutation.
 */
export const REQUIRED_POSTURE_DOMAINS = [
  "NETWORK", "IDENTITY", "ENCRYPTION", "LOGGING", "CHANGE_CONTROL", "VULNERABILITY",
] as const;
export type PostureDomain = typeof REQUIRED_POSTURE_DOMAINS[number];
export type ControlFact = {
  id: string;
  authority: "SECURITY_OWNER_APPROVED" | "CUSTOMER_DECLARED" | "UNKNOWN";
  sourceIntegrity: "REVIEWED_PINNED" | "UNPINNED" | "UNKNOWN";
  applicability: "EFFECTIVE_AT_TARGET" | "OUT_OF_SCOPE" | "UNKNOWN";
  effect: "PREVENTIVE" | "DETECTIVE" | "PROACTIVE" | "TEMPLATE_ONLY";
  state: "ENFORCED" | "AUDIT_ONLY" | "DISABLED" | "UNKNOWN";
  exception: "NONE" | "APPROVED_ACTIVE" | "EXPIRED" | "UNKNOWN";
  validationEvidence: "CUSTOMER_REPORTED" | "MISSING";
};
export type PostureFact = {
  resourceId: string;
  domain: PostureDomain;
  verdict: "PASS" | "FAIL" | "UNKNOWN";
  signal: "NONE" | "PUBLIC_ADMIN_PORT" | "UNRESTRICTED_PUBLIC_INGRESS" |
    "WILDCARD_PRIVILEGE" | "OPEN_EGRESS" | "ENCRYPTION_MISSING" |
    "LOGGING_DISABLED" | "SHARED_MUTABLE_STATE" | "UNPINNED_COMPONENT";
};
export type NamingConvention = {
  /** Customer-approved logical application key convention, NOT a blanket rule for every cloud resource. */
  standardId: string;
  standardSha256: string;
  authority: "CUSTOMER_NAMING_OWNER" | "UNVERIFIED";
  namespaceScope: string;
  namespaceComplete: boolean;
  stage: "development" | "staging" | "production";
  prefix: string;
  applicationCode: string;
  regionCode: string;
  sequence: string;
  proposedName: string;
  existingNames: string[];
  reservedNames: string[];
  /** Additional resource-specific validation is required for actual physical resource names. */
  resourceKind: "APP_LOGICAL_KEY" | "GCP_PROJECT_ID";
};
export type InheritanceScreenInput = {
  before: BrownfieldManifest;
  proposed: BrownfieldManifest;
  deploymentEngine: "TERRAFORM" | "CLOUDFORMATION" | "CDK" | "BICEP" | "OTHER";
  controlFacts: ControlFact[];
  postureFacts: PostureFact[];
  naming: NamingConvention;
  /** Optional native source files; absent/unevaluated sources remain REVIEW_REQUIRED. */
  nativePolicyDocuments?: NativePolicyDocument[];
  /** Optional customer-exported cloud GET responses; never live-verified by this API. */
  policySnapshots?: CloudPolicySnapshot[];
  /** Optional per-resource physical naming checks, separate from application display label. */
  physicalNamingIntents?: PhysicalNameIntent[];
};
export type InheritanceScreen = {
  mode: "OFFLINE_POLICY_DEBT_SCREEN";
  provider: BrownfieldManifest["provider"];
  declaredScope: string;
  verdict: "BLOCK_INHERITANCE" | "REVIEW_REQUIRED" | "CANDIDATE_FOR_INDEPENDENT_VERIFICATION";
  debtSignals: string[];
  missingEvidence: string[];
  acceptedControlReferences: string[];
  rejectedControlReferences: string[];
  namingCandidate: string;
  namingPassDeclared: boolean;
  manifestOnlyCompatible: boolean;
  nativeDocumentsScreened: number;
  policySnapshotsScreened: number;
  physicalNamesScreened: number;
  independentlyVerified: false;
  actualPolicyCompliance: "NOT_ASSESSED";
  previewAllowed: false;
  infrastructureMutationAllowed: false;
  evidenceOrigin: "CUSTOMER_DECLARED_UNATTESTED";
  sha256: string;
};
const SAFE_NAME = /^[a-z][a-z0-9-]{1,61}$/;
const PART = /^[a-z][a-z0-9]{0,23}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:\/@+* -]{0,511}$/;
const prefix = (s: string) => /^([a-z0-9]{1,16})$/.test(s);
const stable = (s: unknown): s is string => typeof s === "string" && ID.test(s);
const AZURE_POLICY_ARM_ID = /^\/(?:subscriptions\/[0-9a-fA-F-]{36}|providers\/Microsoft\.Management\/managementGroups\/[A-Za-z0-9._-]+)(?:\/[A-Za-z0-9._-]+)*$/;
const validPolicyId = (id: unknown, provider: BrownfieldManifest["provider"]) =>
  stable(id) || provider === "AZURE" && typeof id === "string" &&
    id.length <= 1024 && !id.split("/").includes("..") && AZURE_POLICY_ARM_ID.test(id);
const uniq = (list: string[]): boolean => list.length === new Set(list).size;
const MODULE_FAMILIES = new Set([
  "CLOUDFORMATION_TEMPLATE", "SECURITY_GROUP", "IAM_POLICY",
  "AZURE_POLICY_INITIATIVE", "AZURE_POLICY_DEFINITION", "AZURE_VERIFIED_MODULE",
  "NETWORK_SECURITY_GROUP", "RBAC",
  "POLICY_LIBRARY_TEMPLATE", "POLICY_LIBRARY_CONSTRAINT", "ORG_POLICY_CONSTRAINT",
  "TERRAFORM_BLUEPRINT", "VPC_FIREWALL_POLICY",
]);
const DETECTIVE_FAMILIES = new Set(["AWS_CONFIG_RULE"]);
const ENFORCEABLE = new Set([
  "CONTROL_TOWER_CONTROL", "SCP", "RCP", "AZURE_POLICY_ASSIGNMENT",
  "ORGANIZATION_POLICY",
]);

function namingAssessment(name: NamingConvention): { debt: string[]; missing: string[]; passes: boolean } {
  const debt: string[] = [];
  const missing: string[] = [];
  if (!name || !stable(name.standardId) || !(typeof name.standardSha256 === "string" && HEX64.test(name.standardSha256)) ||
    !stable(name.namespaceScope) || !Array.isArray(name.existingNames) ||
    !Array.isArray(name.reservedNames)) {
    return { debt: ["Naming convention source, namespace, or reservations are invalid."], missing, passes: false };
  }
  if (name.authority !== "CUSTOMER_NAMING_OWNER") missing.push("Customer naming authority has not approved this convention.");
  if (name.namespaceComplete !== true) missing.push("Existing namespace inventory is incomplete; collisions cannot be ruled out.");
  if (!["development", "staging", "production"].includes(name.stage)) debt.push("Target stage is invalid.");
  if (!prefix(name.prefix) || !PART.test(name.applicationCode) ||
    !prefix(name.regionCode) || !/^[0-9]{2,4}$/.test(name.sequence)) debt.push("Naming components violate the declared limited character profile.");
  const stages: Record<string, string> = { development: "dev", staging: "stg", production: "prod" };
  const expected = [name.prefix, name.applicationCode, stages[name.stage], name.regionCode, name.sequence].join("-");
  if (name.proposedName !== expected) debt.push("Proposed technical name conflicts with the customer naming standard or stage.");
  if (typeof name.proposedName !== "string" || !SAFE_NAME.test(name.proposedName) ||
    name.proposedName.endsWith("-")) debt.push("Proposed technical name violates the restricted logical-key profile.");
  if (name.resourceKind === "GCP_PROJECT_ID") {
    // Cloud Resource Manager project ID is immutable and globally unique;
    // this is lexical preflight, not a global availability check.
    if (name.proposedName.length < 6 || name.proposedName.length > 30 ||
      /google|ssl/.test(name.proposedName)) debt.push("GCP project ID is invalid or contains a reserved component.");
    missing.push("Live uniqueness of a GCP project ID cannot be established offline.");
  } else if (name.resourceKind !== "APP_LOGICAL_KEY") {
    debt.push("Unknown naming resource type; provider resource-specific rules were not evaluated.");
  }
  if (![...name.existingNames, ...name.reservedNames].every((value) => typeof value === "string")) {
    debt.push("Namespace contains invalid names.");
  } else if ([...name.existingNames, ...name.reservedNames]
    .some((value) => value.toLowerCase() === name.proposedName?.toLowerCase())) {
    debt.push("Proposed technical name collides with an existing or reserved name in the declared namespace.");
  }
  if (!uniq(name.existingNames.map((v) => v.toLowerCase()))) missing.push("Duplicate entries indicate unreliable naming inventory.");
  return { debt, missing, passes: debt.length === 0 && missing.length === 0 };
}

export function screenBrownfieldInheritance(input: InheritanceScreenInput): InheritanceScreen {
  const baseline = assessBrownfieldApplicationReuse(input.before, input.proposed);
  const debtSignals: string[] = [...baseline.reasons];
  const missingEvidence: string[] = [];
  const acceptedControlReferences: string[] = [];
  const rejectedControlReferences: string[] = [];
  const controls = input.before.controls ?? [];
  const controlFacts = input.controlFacts ?? [];
  const postureFacts = input.postureFacts ?? [];
  if (!Array.isArray(controlFacts) || !Array.isArray(postureFacts)) {
    debtSignals.push("Policy or resource observations must be arrays.");
  } else {
    const declared = new Map(controls.map((x) => [x.id, x]));
    const seen = new Set<string>();
    let preventive = 0;
    for (const fact of controlFacts) {
      if (!fact || !validPolicyId(fact.id, input.before.provider) || seen.has(fact.id) || !declared.has(fact.id)) {
        debtSignals.push("Unknown or duplicate policy fact."); continue;
      }
      seen.add(fact.id);
      const ref = declared.get(fact.id)!;
      let rejected = false;
      if (fact.state === "DISABLED" || fact.state === "AUDIT_ONLY" && fact.effect === "PREVENTIVE") {
        debtSignals.push("Inactive or audit-only preventive control cannot be inherited as enforcement: " + ref.id);
        rejected = true;
      }
      if (fact.exception === "EXPIRED" || fact.exception === "APPROVED_ACTIVE") {
        debtSignals.push("Inherited security policy contains a bypass or expired exception: " + ref.id);
        rejected = true;
      }
      if (fact.applicability === "OUT_OF_SCOPE") {
        debtSignals.push("Control does not cover the proposed application scope: " + ref.id); rejected = true;
      }
      if (fact.sourceIntegrity === "UNPINNED") {
        debtSignals.push("Existing module or policy is not pinned to a reviewed revision: " + ref.id); rejected = true;
      }
      if (MODULE_FAMILIES.has(ref.family) && (fact.effect !== "TEMPLATE_ONLY" || fact.state === "ENFORCED") ||
        DETECTIVE_FAMILIES.has(ref.family) && fact.effect !== "DETECTIVE" ||
        ENFORCEABLE.has(ref.family) && fact.effect === "TEMPLATE_ONLY") {
        debtSignals.push("Policy effect is misclassified for native control family: " + ref.id); rejected = true;
      }
      if (input.before.provider === "AWS" && fact.effect === "PROACTIVE" &&
        input.deploymentEngine !== "CLOUDFORMATION" && input.deploymentEngine !== "CDK") {
        missingEvidence.push("CloudFormation-hook proactive enforcement cannot be assumed for other deployment engines: " + ref.id);
      }
      if (fact.authority !== "SECURITY_OWNER_APPROVED" || fact.sourceIntegrity === "UNKNOWN" ||
        fact.applicability === "UNKNOWN" || fact.exception === "UNKNOWN" ||
        fact.state === "UNKNOWN" || fact.validationEvidence !== "CUSTOMER_REPORTED") {
        missingEvidence.push("Control effectiveness, lineage, authority or applicability is unverified: " + ref.id);
      }
      if (fact.state === "ENFORCED" && fact.effect === "PREVENTIVE" && !rejected) preventive++;
      if (rejected) rejectedControlReferences.push(ref.id);
      else acceptedControlReferences.push(ref.id);
    }
    if (controlFacts.length !== controls.length || seen.size !== controls.length)
      missingEvidence.push("Every customer control must have exactly one authority/effect observation.");
    if (preventive === 0) missingEvidence.push("No effective preventive guardrail has been declared; detective or module-only controls are insufficient.");
    const resourceIds = new Set((input.before.protectedResources ?? []).map((r) => r.id));
    const observed = new Set<string>();
    for (const fact of postureFacts) {
      if (!fact || !resourceIds.has(fact.resourceId) || !REQUIRED_POSTURE_DOMAINS.includes(fact.domain)) {
        debtSignals.push("Unknown resource or risk domain in preexisting posture facts."); continue;
      }
      const key = fact.resourceId + "/" + fact.domain;
      if (observed.has(key)) { debtSignals.push("Duplicate resource posture observation: " + key); continue; }
      observed.add(key);
      if (fact.verdict === "FAIL" || fact.signal !== "NONE" && fact.signal !== undefined) {
        debtSignals.push("Inherited technical debt detected (" + fact.signal + "): " + key);
      } else if (fact.verdict !== "PASS" || fact.signal === undefined) {
        missingEvidence.push("Resource control posture not assessed: " + key);
      }
    }
    for (const resourceId of resourceIds) for (const domain of REQUIRED_POSTURE_DOMAINS) {
      if (!observed.has(resourceId + "/" + domain))
        missingEvidence.push("Missing " + domain + " baseline review for " + resourceId);
    }
  }
  let nativeDocumentsScreened = 0;
  if (!Array.isArray(input.nativePolicyDocuments)) {
    missingEvidence.push("Native customer policy/template sources have not been provided for review.");
  } else {
    const refs = new Map(controls.map((control) => [control.id, control]));
    const observed = new Set<string>();
    for (const document of input.nativePolicyDocuments) {
      if (!document || typeof document.controlId !== "string" || observed.has(document.controlId) ||
        !refs.has(document.controlId)) {
        debtSignals.push("Native document is duplicated, malformed or does not match an existing customer control.");
        continue;
      }
      observed.add(document.controlId);
      const finding = inspectNativePolicyJson(input.before.provider, refs.get(document.controlId)!, document);
      nativeDocumentsScreened++;
      if (finding.status === "REJECT")
        debtSignals.push("Native policy source rejected: " + document.controlId + " — " + finding.reasons.join("; "));
      else if (finding.status === "REVIEW")
        missingEvidence.push("Native policy requires authoritative review: " + document.controlId + " — " + finding.reasons.join("; "));
    }
    for (const ref of controls) {
      if (!observed.has(ref.id)) missingEvidence.push("Missing native customer policy/template source: " + ref.id);
    }
  }
  let policySnapshotsScreened = 0;
  const nativeSnapshotFamilies = new Set(["CONTROL_TOWER_CONTROL", "AZURE_POLICY_ASSIGNMENT", "ORGANIZATION_POLICY"]);
  const requiredSnapshotRefs = controls.filter((ref) => nativeSnapshotFamilies.has(ref.family));
  if (!Array.isArray(input.policySnapshots)) {
    if (requiredSnapshotRefs.length)
      missingEvidence.push("Effective provider-policy read snapshots have not been supplied.");
  } else {
    const refs = new Map(requiredSnapshotRefs.map((ref) => [ref.id, ref]));
    const seen = new Set<string>();
    for (const snapshot of input.policySnapshots) {
      if (!snapshot || typeof snapshot.controlId !== "string" ||
        seen.has(snapshot.controlId) || !refs.has(snapshot.controlId)) {
        debtSignals.push("Native policy snapshot is duplicated or not bound to an enforcing control.");
        continue;
      }
      seen.add(snapshot.controlId);
      const result = inspectCloudPolicySnapshot(refs.get(snapshot.controlId)!, input.before.provider, input.before.scope, snapshot);
      policySnapshotsScreened++;
      if (result.verdict === "BLOCK")
        debtSignals.push("Effective policy snapshot rejected: " + snapshot.controlId + " — " + result.reasons.join("; "));
      else
        missingEvidence.push("Customer-exported native policy read is not independently attested: " + snapshot.controlId + " — " + result.reasons.join("; "));
    }
    for (const ref of requiredSnapshotRefs) if (!seen.has(ref.id))
      missingEvidence.push("Missing effective policy snapshot for existing control: " + ref.id);
  }
  let physicalNamesScreened = 0;
  if (!Array.isArray(input.physicalNamingIntents)) {
    missingEvidence.push("Per-resource physical naming evidence has not been supplied.");
  } else {
    for (const intent of input.physicalNamingIntents) {
      const result = assessPhysicalResourceName(intent);
      physicalNamesScreened++;
      if (intent.provider !== input.before.provider || result.verdict === "BLOCK")
        debtSignals.push("Physical resource naming conflict: " + intent.proposedName + " — " + result.reasons.join("; "));
      else if (result.verdict === "REVIEW")
        missingEvidence.push("Physical resource naming requires authoritative verification: " + intent.proposedName + " — " + result.reasons.join("; "));
    }
  }
  const naming = namingAssessment(input.naming);
  debtSignals.push(...naming.debt);
  missingEvidence.push(...naming.missing);
  if (!baseline.controlsPreserved || !baseline.protectedInfrastructurePreserved ||
    !baseline.applicationLabelChanged) debtSignals.push("The requested change is not a display-label-only reuse.");
  const verdict = debtSignals.length ? "BLOCK_INHERITANCE" as const :
    missingEvidence.length ? "REVIEW_REQUIRED" as const :
      "CANDIDATE_FOR_INDEPENDENT_VERIFICATION" as const;
  const canonical = {
    mode: "OFFLINE_POLICY_DEBT_SCREEN" as const,
    provider: input.before.provider,
    declaredScope: input.before.scope,
    verdict, debtSignals: [...new Set(debtSignals)].sort(),
    missingEvidence: [...new Set(missingEvidence)].sort(),
    acceptedControlReferences: acceptedControlReferences.sort(),
    rejectedControlReferences: rejectedControlReferences.sort(),
    namingCandidate: input.naming?.proposedName ?? "",
    namingPassDeclared: naming.passes,
    manifestOnlyCompatible: baseline.verdict === "DECLARED_APP_LABEL_ONLY",
    nativeDocumentsScreened,
    policySnapshotsScreened, physicalNamesScreened,
    independentlyVerified: false as const, actualPolicyCompliance: "NOT_ASSESSED" as const,
    previewAllowed: false as const, infrastructureMutationAllowed: false as const,
    evidenceOrigin: "CUSTOMER_DECLARED_UNATTESTED" as const,
  };
  return { ...canonical, sha256: createHash("sha256").update(JSON.stringify(canonical)).digest("hex") };
}
