import assert from "node:assert/strict";
import test from "node:test";

import { screenBrownfieldInheritance, REQUIRED_POSTURE_DOMAINS, type ControlFact, type InheritanceScreenInput } from "../src/governance/brownfield-inheritance.js";
import type { BrownfieldManifest, BrownfieldProvider } from "../src/governance/brownfield-reuse.js";

const hash = (x: string) => x.repeat(64);
const familyByCloud: Record<BrownfieldProvider, [string, string]> = {
  AWS: ["SCP", "CLOUDFORMATION_TEMPLATE"],
  AZURE: ["AZURE_POLICY_ASSIGNMENT", "AZURE_VERIFIED_MODULE"],
  GCP: ["ORGANIZATION_POLICY", "POLICY_LIBRARY_TEMPLATE"],
};
const construct = (provider: BrownfieldProvider): InheritanceScreenInput => {
  const [enforcer, template] = familyByCloud[provider];
  const before: BrownfieldManifest = {
    schemaVersion: 1, provider, scope: provider === "AWS" ? "organizations/o-1/ou-abc" :
      provider === "AZURE" ? "/subscriptions/00000000-0000-0000-0000-000000000000" : "organizations/123",
    applicationLabel: "Legacy Display",
    controls: [
      { id: provider + "/governance/enforce", family: enforcer, sourceOfTruth: "approved-governance@1", assignedScope: "customer-platform-root", definitionSha256: hash("a") },
      { id: provider + "/iac/template", family: template, sourceOfTruth: "approved-modules@2", assignedScope: "workload-scope", definitionSha256: hash("b") },
    ],
    protectedResources: [
      { id: provider + "/network", category: "NETWORK", sourceOfTruth: "network-state@v2", configurationSha256: hash("c"), ownership: "EXTERNAL_IAC", mutationPolicy: "READ_ONLY" },
      { id: provider + "/identity", category: "IDENTITY", sourceOfTruth: "identity-state@v3", configurationSha256: hash("d"), ownership: "CUSTOMER", mutationPolicy: "READ_ONLY" },
    ],
  };
  const proposed = structuredClone(before);
  proposed.applicationLabel = "Approved New Display";
  const controlFacts: ControlFact[] = [
    { id: before.controls[0]!.id, authority: "SECURITY_OWNER_APPROVED", sourceIntegrity: "REVIEWED_PINNED", applicability: "EFFECTIVE_AT_TARGET", effect: "PREVENTIVE", state: "ENFORCED", exception: "NONE", validationEvidence: "CUSTOMER_REPORTED" },
    { id: before.controls[1]!.id, authority: "SECURITY_OWNER_APPROVED", sourceIntegrity: "REVIEWED_PINNED", applicability: "EFFECTIVE_AT_TARGET", effect: "TEMPLATE_ONLY", state: "AUDIT_ONLY", exception: "NONE", validationEvidence: "CUSTOMER_REPORTED" },
  ];
  return {
    before, proposed, deploymentEngine: provider === "AWS" ? "CLOUDFORMATION" : "TERRAFORM",
    controlFacts,
    postureFacts: before.protectedResources.flatMap((resource) =>
      REQUIRED_POSTURE_DOMAINS.map((domain) => ({ resourceId: resource.id, domain, verdict: "PASS" as const, signal: "NONE" as const }))),
    naming: {
      standardId: "customer/caf-style-application-key@2",
      standardSha256: hash("f"), authority: "CUSTOMER_NAMING_OWNER",
      namespaceScope: "stage/root/platform", namespaceComplete: true,
      stage: "staging", prefix: "app", applicationCode: "billing",
      regionCode: "us", sequence: "001", proposedName: "app-billing-stg-us-001",
      existingNames: ["app-payments-stg-us-001"], reservedNames: ["app-core-stg-us-001"],
      resourceKind: "APP_LOGICAL_KEY",
    },
  };
};
const run = (input: InheritanceScreenInput) => screenBrownfieldInheritance(input);

test("three clouds: declared controls without native source remain REVIEW_REQUIRED, never inherited as compliant", () => {
  for (const cloud of ["AWS", "AZURE", "GCP"] as const) {
    const input = construct(cloud);
    const output = run(input);
    assert.equal(output.verdict, "REVIEW_REQUIRED", cloud);
    assert.deepEqual(output.debtSignals, []);
    assert.match(output.missingEvidence.join(" "), /Native customer policy/);
    assert.equal(output.manifestOnlyCompatible, true);
    assert.equal(output.namingPassDeclared, true);
    assert.equal(output.actualPolicyCompliance, "NOT_ASSESSED");
    assert.equal(output.independentlyVerified, false);
    assert.equal(output.previewAllowed, false);
    assert.equal(output.infrastructureMutationAllowed, false);
    assert.deepEqual(output.rejectedControlReferences, []);
    assert.equal(output.acceptedControlReferences.length, 2);
    assert.match(output.sha256, /^[0-9a-f]{64}$/);
    assert.equal(output.sha256, run(input).sha256);
  }
});

test("known technical debt or weaker-than-claimed enforcement must prevent inheritance for every provider", () => {
  for (const cloud of ["AWS", "AZURE", "GCP"] as const) {
    const baseline = construct(cloud);
    const variants: Array<[string, (input: InheritanceScreenInput) => void]> = [
      ["public SSH", (x) => { x.postureFacts[0]!.signal = "PUBLIC_ADMIN_PORT"; x.postureFacts[0]!.verdict = "FAIL"; }],
      ["wildcard IAM", (x) => { x.postureFacts.find((v) => v.domain === "IDENTITY")!.signal = "WILDCARD_PRIVILEGE"; }],
      ["unencrypted storage", (x) => { x.postureFacts.find((v) => v.domain === "ENCRYPTION")!.signal = "ENCRYPTION_MISSING"; }],
      ["no logs", (x) => { x.postureFacts.find((v) => v.domain === "LOGGING")!.verdict = "FAIL"; }],
      ["shared mutable state", (x) => { x.postureFacts[0]!.signal = "SHARED_MUTABLE_STATE"; }],
      ["policy exception", (x) => { x.controlFacts[0]!.exception = "APPROVED_ACTIVE"; }],
      ["expired exception", (x) => { x.controlFacts[0]!.exception = "EXPIRED"; }],
      ["wrong OU/scope", (x) => { x.controlFacts[0]!.applicability = "OUT_OF_SCOPE"; }],
      ["audit-only prevention", (x) => { x.controlFacts[0]!.state = "AUDIT_ONLY"; }],
      ["disabled guardrail", (x) => { x.controlFacts[0]!.state = "DISABLED"; }],
      ["unpinned template", (x) => { x.controlFacts[1]!.sourceIntegrity = "UNPINNED"; }],
      ["module masquerading as enforcing", (x) => { x.controlFacts[1]!.effect = "PREVENTIVE"; x.controlFacts[1]!.state = "ENFORCED"; }],
      ["naming collision", (x) => { x.naming.existingNames = [x.naming.proposedName.toUpperCase()]; }],
      ["reserved name", (x) => { x.naming.reservedNames = [x.naming.proposedName]; }],
      ["wrong stage name", (x) => { x.naming.stage = "production"; }],
      ["changed governance", (x) => { x.proposed.controls[0]!.definitionSha256 = hash("0"); }],
      ["mutable network", (x) => { x.proposed.protectedResources[0]!.mutationPolicy = "UPDATE_ALLOWED"; }],
      ["unknown control fact", (x) => { x.controlFacts[0]!.id = "malicious/phantom"; }],
    ];
    for (const [label, update] of variants) {
      const input = structuredClone(baseline);
      update(input);
      const output = run(input);
      assert.equal(output.verdict, "BLOCK_INHERITANCE", cloud + ": " + label);
      assert.equal(output.infrastructureMutationAllowed, false);
    }
  }
});

test("missing evidence and unknown ownership require review rather than best-practice inheritance", () => {
  const input = construct("AZURE");
  const variants: Array<[string, (x: InheritanceScreenInput) => void]> = [
    ["missing review", (x) => { x.postureFacts.pop(); }],
    ["unknown review", (x) => { x.postureFacts[0]!.verdict = "UNKNOWN"; }],
    ["incomplete scope inventory", (x) => { x.naming.namespaceComplete = false; }],
    ["control authority", (x) => { x.controlFacts[0]!.authority = "CUSTOMER_DECLARED"; }],
    ["control coverage", (x) => { x.controlFacts[0]!.applicability = "UNKNOWN"; }],
    ["unknown exception", (x) => { x.controlFacts[0]!.exception = "UNKNOWN"; }],
    ["unknown revision", (x) => { x.controlFacts[0]!.sourceIntegrity = "UNKNOWN"; }],
    ["no owner", (x) => { x.naming.authority = "UNVERIFIED"; }],
    ["missing policy fact", (x) => { x.controlFacts.pop(); }],
  ];
  for (const [label, mutate] of variants) {
    const x = structuredClone(input);
    mutate(x);
    const result = run(x);
    assert.equal(result.verdict, "REVIEW_REQUIRED", label);
    assert.ok(result.missingEvidence.length > 0, label);
    assert.equal(result.independentlyVerified, false);
  }
});

test("CloudFormation proactive guards do not carry across to Terraform-created resources", () => {
  const input = construct("AWS");
  input.controlFacts[0]!.effect = "PROACTIVE";
  input.deploymentEngine = "TERRAFORM";
  const output = run(input);
  assert.equal(output.verdict, "REVIEW_REQUIRED");
  assert.match(output.missingEvidence.join(" "), /CloudFormation-hook/);
});

test("policy templates, AWS Config detective rules, and GCP constraint definitions cannot substitute for preventive policy enforcement", () => {
  const aws = construct("AWS");
  aws.before.controls[0]!.family = "AWS_CONFIG_RULE";
  aws.proposed.controls[0]!.family = "AWS_CONFIG_RULE";
  aws.controlFacts[0]!.effect = "DETECTIVE";
  assert.equal(run(aws).verdict, "REVIEW_REQUIRED");
  const gcp = construct("GCP");
  gcp.before.controls[0]!.family = "ORG_POLICY_CONSTRAINT";
  gcp.proposed.controls[0]!.family = "ORG_POLICY_CONSTRAINT";
  gcp.controlFacts[0]!.effect = "TEMPLATE_ONLY";
  gcp.controlFacts[0]!.state = "AUDIT_ONLY";
  assert.equal(run(gcp).verdict, "REVIEW_REQUIRED");
  const azure = construct("AZURE");
  azure.before.controls[0]!.family = "AZURE_POLICY_DEFINITION";
  azure.proposed.controls[0]!.family = "AZURE_POLICY_DEFINITION";
  azure.controlFacts[0]!.effect = "TEMPLATE_ONLY";
  azure.controlFacts[0]!.state = "AUDIT_ONLY";
  assert.equal(run(azure).verdict, "REVIEW_REQUIRED");
});

test("GCP project IDs are lexically restricted, globally unique only after later provider verification", () => {
  const input = construct("GCP");
  input.naming.resourceKind = "GCP_PROJECT_ID";
  const result = run(input);
  assert.equal(result.verdict, "REVIEW_REQUIRED");
  assert.match(result.missingEvidence.join(" "), /Live uniqueness/);
  input.naming.proposedName = "app-google-stg-us-001";
  input.naming.applicationCode = "google";
  assert.equal(run(input).verdict, "BLOCK_INHERITANCE");
  input.naming.proposedName = "app-billing-stg-us-001";
  input.naming.applicationCode = "billing";
  input.naming.proposedName += "-with-a-super-long-identifier";
  assert.equal(run(input).verdict, "BLOCK_INHERITANCE");
});
