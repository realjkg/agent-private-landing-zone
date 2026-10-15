import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { inspectNativePolicyJson, type NativePolicyDocument } from "../src/governance/native-policy-inspection.js";
import { screenBrownfieldInheritance, REQUIRED_POSTURE_DOMAINS, type InheritanceScreenInput } from "../src/governance/brownfield-inheritance.js";
import type { BrownfieldProvider, PolicyRef, BrownfieldManifest } from "../src/governance/brownfield-reuse.js";

const hex = (text: string) => createHash("sha256").update(text).digest("hex");
function example(provider: BrownfieldProvider, family: string, format: NativePolicyDocument["format"], data: unknown) {
  const document: NativePolicyDocument = {
    controlId: "customer-approved-policy",
    format,
    content: JSON.stringify(data),
  };
  const ref: PolicyRef = {
    id: document.controlId, family, assignedScope: "customer-platform-root",
    definitionSha256: hex(document.content), sourceOfTruth: "governance-source@reviewed-commit",
  };
  return { document, ref, result: inspectNativePolicyJson(provider, ref, document) };
}

test("AWS identity policies: structural detection of admin wildcard actions/resources", () => {
  const dangerous = example("AWS", "IAM_POLICY", "AWS_IDENTITY_POLICY_JSON", {
    Version: "2012-10-17", Statement: [{ Effect: "Allow", Action: "*", Resource: "*" }],
  });
  assert.equal(dangerous.result.status, "REJECT");
  assert.match(dangerous.result.reasons.join(" "), /wildcard/);
  const scoped = example("AWS", "IAM_POLICY", "AWS_IDENTITY_POLICY_JSON", {
    Version: "2012-10-17", Statement: [{ Effect: "Allow", Action: ["s3:GetObject"], Resource: "arn:aws:s3:::customer-data/objects/*" }],
  });
  assert.equal(scoped.result.status, "REVIEW");
  assert.match(scoped.result.reasons.join(" "), /effective grants/);
});

test("AWS security group: world-open 22, 3389 and all-protocol rejected; public HTTPS requires review", () => {
  for (const data of [
    { IpPermissions: [{ IpProtocol: "tcp", FromPort: 22, ToPort: 22, IpRanges: [{ CidrIp: "0.0.0.0/0" }] }] },
    { IpPermissions: [{ IpProtocol: "tcp", FromPort: 3389, ToPort: 3389, Ipv6Ranges: [{ CidrIpv6: "::/0" }] }] },
    { IpPermissions: [{ IpProtocol: "-1", IpRanges: [{ CidrIp: "0.0.0.0/0" }] }] },
  ]) {
    const checked = example("AWS", "SECURITY_GROUP", "AWS_SECURITY_GROUP_JSON", data);
    assert.equal(checked.result.status, "REJECT");
  }
  const https = example("AWS", "SECURITY_GROUP", "AWS_SECURITY_GROUP_JSON", {
    IpPermissions: [{ IpProtocol: "tcp", FromPort: 443, ToPort: 443, IpRanges: [{ CidrIp: "0.0.0.0/0" }] }],
  });
  assert.equal(https.result.status, "REVIEW");
  assert.match(https.result.reasons.join(" "), /authorization/);
});

test("Azure assignment: DoNotEnforce blocks, Enroll and exemptions require review, Default is still unattested", () => {
  const data = (mode: string) => ({
    properties: { policyDefinitionId: "/providers/Microsoft.Authorization/policyDefinitions/aaa", enforcementMode: mode },
  });
  assert.equal(example("AZURE", "AZURE_POLICY_ASSIGNMENT", "AZURE_POLICY_ASSIGNMENT_JSON", data("DoNotEnforce")).result.status, "REJECT");
  assert.equal(example("AZURE", "AZURE_POLICY_ASSIGNMENT", "AZURE_POLICY_ASSIGNMENT_JSON", data("Enroll")).result.status, "REVIEW");
  assert.equal(example("AZURE", "AZURE_POLICY_ASSIGNMENT", "AZURE_POLICY_ASSIGNMENT_JSON", data("Default")).result.status, "REVIEW");
  assert.equal(example("AZURE", "AZURE_POLICY_ASSIGNMENT", "AZURE_POLICY_ASSIGNMENT_JSON", {
    properties: { policyDefinitionId: "a", enforcementMode: "Default", notScopes: ["/excluded"], overrides: [{ kind: "policyEffect", value: "Disabled" }] },
  }).result.status, "REVIEW");
});

test("GCP Org Policy: allowAll, enforce=false and reset rejected; condition and inherited semantics remain review-only", () => {
  for (const policy of [
    { spec: { rules: [{ allowAll: true }] } },
    { spec: { rules: [{ enforce: false }] } },
    { spec: { reset: true, rules: [{ enforce: true }] } },
  ]) {
    assert.equal(example("GCP", "ORGANIZATION_POLICY", "GCP_ORG_POLICY_JSON", policy).result.status, "REJECT");
  }
  const conditional = example("GCP", "ORGANIZATION_POLICY", "GCP_ORG_POLICY_JSON", {
    spec: { rules: [{ enforce: true, condition: { expression: "resource.tags.env == 'prod'" } }] },
  });
  assert.equal(conditional.result.status, "REVIEW");
  const plain = example("GCP", "ORGANIZATION_POLICY", "GCP_ORG_POLICY_JSON", { spec: { rules: [{ enforce: true }] } });
  assert.equal(plain.result.status, "REVIEW");
});

test("untrusted documents: digest, family, identity, malformed JSON and document size mismatch are rejected", () => {
  const base = example("AWS", "IAM_POLICY", "AWS_IDENTITY_POLICY_JSON", {
    Version: "2012-10-17", Statement: [{ Effect: "Deny", Action: "iam:DeleteUser", Resource: "*" }],
  });
  const cases: Array<[PolicyRef, NativePolicyDocument]> = [
    [{ ...base.ref, definitionSha256: "0".repeat(64) }, base.document],
    [base.ref, { ...base.document, controlId: "another-policy" }],
    [base.ref, { ...base.document, content: "{" }],
    [base.ref, { ...base.document, content: "x".repeat(256001) }],
    [{ ...base.ref, family: "SCP" }, base.document],
    [base.ref, { ...base.document, format: "AZURE_POLICY_ASSIGNMENT_JSON" }],
  ];
  for (const [ref, doc] of cases) {
    assert.equal(inspectNativePolicyJson("AWS", ref, doc).status, "REJECT");
  }
});

test("native document rejection is enforced by the top-level brownfield screening contract", () => {
  const sample = example("AZURE", "AZURE_POLICY_ASSIGNMENT", "AZURE_POLICY_ASSIGNMENT_JSON", {
    properties: { policyDefinitionId: "/providers/Microsoft.Authorization/policyDefinitions/root", enforcementMode: "DoNotEnforce" },
  });
  const before: BrownfieldManifest = {
    schemaVersion: 1, provider: "AZURE", scope: "/subscriptions/abc", applicationLabel: "Before",
    controls: [sample.ref],
    protectedResources: [{
      id: "/subscriptions/abc/network/shared-vnet", category: "NETWORK",
      sourceOfTruth: "customer-terraform@1", configurationSha256: "f".repeat(64),
      ownership: "EXTERNAL_IAC", mutationPolicy: "READ_ONLY",
    }],
  };
  const proposed = structuredClone(before); proposed.applicationLabel = "After";
  const input: InheritanceScreenInput = {
    before, proposed, deploymentEngine: "TERRAFORM",
    controlFacts: [{
      id: sample.ref.id, authority: "SECURITY_OWNER_APPROVED", sourceIntegrity: "REVIEWED_PINNED",
      applicability: "EFFECTIVE_AT_TARGET", effect: "PREVENTIVE", state: "ENFORCED",
      exception: "NONE", validationEvidence: "CUSTOMER_REPORTED",
    }],
    postureFacts: REQUIRED_POSTURE_DOMAINS.map((domain) => ({
      resourceId: before.protectedResources[0]!.id, domain, verdict: "PASS" as const, signal: "NONE" as const,
    })),
    naming: {
      standardId: "customer/application-naming@1", standardSha256: "a".repeat(64),
      authority: "CUSTOMER_NAMING_OWNER", namespaceScope: "/subscriptions/abc",
      namespaceComplete: true, stage: "staging", prefix: "app", applicationCode: "records", regionCode: "us", sequence: "001",
      proposedName: "app-records-stg-us-001", existingNames: [], reservedNames: [], resourceKind: "APP_LOGICAL_KEY",
    },
    nativePolicyDocuments: [sample.document],
  };
  const result = screenBrownfieldInheritance(input);
  assert.equal(result.verdict, "BLOCK_INHERITANCE");
  assert.match(result.debtSignals.join(" "), /DoNotEnforce/);
  assert.equal(result.nativeDocumentsScreened, 1);
  assert.equal(result.actualPolicyCompliance, "NOT_ASSESSED");
});
