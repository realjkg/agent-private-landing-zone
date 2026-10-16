import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { screenBrownfieldInheritance, REQUIRED_POSTURE_DOMAINS, type InheritanceScreenInput } from "../src/governance/brownfield-inheritance.js";
import type { CloudPolicySnapshot } from "../src/governance/cloud-policy-snapshots.js";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
function fixture(): InheritanceScreenInput {
  const target = "/subscriptions/00000000-0000-0000-0000-000000000000";
  const id = target + "/providers/Microsoft.Authorization/policyAssignments/platform";
  const content = JSON.stringify({ id, properties: {
    scope: target, enforcementMode: "Default", policyDefinitionId: "/providers/Microsoft.Authorization/policyDefinitions/p1", notScopes: [],
  } });
  const before = {
    schemaVersion: 1 as const, provider: "AZURE" as const,
    scope: target, applicationLabel: "Existing App",
    controls: [{ id, family: "AZURE_POLICY_ASSIGNMENT", definitionSha256: "a".repeat(64),
      sourceOfTruth: "customer-azure-policy@v1", assignedScope: target }],
    protectedResources: [{ id: target + "/resourceGroups/network", category: "NETWORK" as const,
      sourceOfTruth: "customer-terraform@v5", configurationSha256: "b".repeat(64),
      ownership: "EXTERNAL_IAC" as const, mutationPolicy: "READ_ONLY" as const }],
  };
  const proposed = structuredClone(before); proposed.applicationLabel = "New App";
  const policySnapshots: CloudPolicySnapshot[] = [{
    controlId: id, provider: "AZURE", method: "AZURE_POLICY_ASSIGNMENT_GET",
    targetScope: target, content, contentSha256: sha(content), inventoryComplete: true,
  }];
  return {
    before, proposed, deploymentEngine: "TERRAFORM",
    controlFacts: [{ id, authority: "SECURITY_OWNER_APPROVED", sourceIntegrity: "REVIEWED_PINNED",
      applicability: "EFFECTIVE_AT_TARGET", effect: "PREVENTIVE", state: "ENFORCED",
      exception: "NONE", validationEvidence: "CUSTOMER_REPORTED" }],
    postureFacts: REQUIRED_POSTURE_DOMAINS.map((domain) => ({
      resourceId: before.protectedResources[0]!.id, domain, verdict: "PASS" as const, signal: "NONE" as const,
    })),
    naming: { standardId: "customer-app-names@v1", standardSha256: "f".repeat(64),
      authority: "CUSTOMER_NAMING_OWNER", namespaceScope: "customer-app-names",
      namespaceComplete: true, stage: "staging", prefix: "app", applicationCode: "records", regionCode: "us", sequence: "001",
      proposedName: "app-records-stg-us-001", existingNames: [], reservedNames: [], resourceKind: "APP_LOGICAL_KEY" },
    policySnapshots,
    physicalNamingIntents: [{
      provider: "AZURE", kind: "AZURE_STORAGE_ACCOUNT", proposedName: "custstorage123",
      operation: "REFERENCE_EXISTING", existingName: "custstorage123",
      namespace: { scope: "customer-storage", inventoryComplete: true,
        existing: ["custstorage123"], reserved: [] },
    }],
  };
}
test("brownfield importer screens native exported Azure state and physical naming, never claims independent compliance", () => {
  const input = fixture();
  const result = screenBrownfieldInheritance(input);
  assert.equal(result.verdict, "REVIEW_REQUIRED", JSON.stringify({ debt: result.debtSignals, missing: result.missingEvidence }));
  assert.equal(result.policySnapshotsScreened, 1);
  assert.equal(result.physicalNamesScreened, 1);
  assert.equal(result.actualPolicyCompliance, "NOT_ASSESSED");
  assert.equal(result.independentlyVerified, false);
  assert.equal(result.infrastructureMutationAllowed, false);
  assert.equal(result.previewAllowed, false);
  assert.match(result.missingEvidence.join(" "), /independently attested/);
});
test("known weak Azure policy or physical-name collisions block entire brownfield inheritance", () => {
  const input = fixture();
  const weak = structuredClone(input);
  const json = JSON.parse(weak.policySnapshots![0]!.content);
  json.properties.enforcementMode = "DoNotEnforce";
  weak.policySnapshots![0]!.content = JSON.stringify(json);
  weak.policySnapshots![0]!.contentSha256 = sha(weak.policySnapshots![0]!.content);
  const bad = screenBrownfieldInheritance(weak);
  assert.equal(bad.verdict, "BLOCK_INHERITANCE");
  assert.match(bad.debtSignals.join(" "), /DoNotEnforce/);
  const colliding = structuredClone(input);
  colliding.physicalNamingIntents![0]!.namespace.reserved.push("custstorage123");
  assert.equal(screenBrownfieldInheritance(colliding).verdict, "BLOCK_INHERITANCE");
  const wrongScope = structuredClone(input);
  wrongScope.policySnapshots![0]!.targetScope = "/subscriptions/other";
  assert.equal(screenBrownfieldInheritance(wrongScope).verdict, "BLOCK_INHERITANCE");
});
test("missing policy snapshots and missing per-resource name checks cannot yield implicit inheritance approval", () => {
  const input = fixture();
  delete input.policySnapshots;
  delete input.physicalNamingIntents;
  const result = screenBrownfieldInheritance(input);
  assert.equal(result.verdict, "REVIEW_REQUIRED");
  assert.equal(result.policySnapshotsScreened, 0);
  assert.equal(result.physicalNamesScreened, 0);
  assert.match(result.missingEvidence.join(" "), /Effective provider-policy read snapshots/);
  assert.match(result.missingEvidence.join(" "), /Per-resource physical naming/);
});
