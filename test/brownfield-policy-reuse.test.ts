import assert from "node:assert/strict";
import test from "node:test";

import {
  assessBrownfieldApplicationReuse,
  CLOUD_POLICY_FAMILIES,
  type BrownfieldManifest,
  type BrownfieldProvider,
} from "../src/governance/brownfield-reuse.js";

const fingerprint = (char: string) => char.repeat(64);
const sample = (provider: BrownfieldProvider): BrownfieldManifest => {
  const families: Record<BrownfieldProvider, [string, string]> = {
    AWS: ["CONTROL_TOWER_CONTROL", "SCP"],
    AZURE: ["AZURE_POLICY_ASSIGNMENT", "AZURE_VERIFIED_MODULE"],
    GCP: ["ORGANIZATION_POLICY", "POLICY_LIBRARY_CONSTRAINT"],
  };
  const [policy, module] = families[provider];
  return {
    schemaVersion: 1, provider, scope: provider === "AWS" ? "org/ou/ou-1111" :
      provider === "AZURE" ? "/providers/Microsoft.Management/managementGroups/platform" :
        "organizations/1234567890/folders/111",
    applicationLabel: "Existing customer application",
    controls: [
      { id: provider + "/policy", family: policy, sourceOfTruth: "customer-governance-repo@0123456",
        definitionSha256: fingerprint("a"), assignedScope: "organizational-inheritance" },
      { id: provider + "/module", family: module, sourceOfTruth: "customer-platform-iac@fedcba9",
        definitionSha256: fingerprint("b"), assignedScope: "application-scope" },
    ],
    protectedResources: [
      { id: provider + "/shared-network", category: "NETWORK", sourceOfTruth: "customer-network-team",
        configurationSha256: fingerprint("c"), ownership: "EXTERNAL_IAC", mutationPolicy: "READ_ONLY" },
      { id: provider + "/identity", category: "IDENTITY", sourceOfTruth: "customer-identity-team",
        configurationSha256: fingerprint("d"), ownership: "CUSTOMER", mutationPolicy: "READ_ONLY" },
      { id: provider + "/security-logs", category: "LOGGING", sourceOfTruth: "customer-security-team",
        configurationSha256: fingerprint("e"), ownership: "CUSTOMER", mutationPolicy: "READ_ONLY" },
    ],
  };
};
const copied = (value: BrownfieldManifest): BrownfieldManifest => structuredClone(value);

test("AWS, Azure, GCP manifest-only application label change leaves customer controls and resources untouched", () => {
  for (const provider of Object.keys(CLOUD_POLICY_FAMILIES) as BrownfieldProvider[]) {
    const before = sample(provider);
    const proposed = copied(before);
    proposed.applicationLabel = "New app display name";
    proposed.controls.reverse();
    proposed.protectedResources.reverse();
    const outcome = assessBrownfieldApplicationReuse(before, proposed);
    assert.equal(outcome.verdict, "DECLARED_APP_LABEL_ONLY", provider);
    assert.equal(outcome.controlsPreserved, true);
    assert.equal(outcome.protectedInfrastructurePreserved, true);
    assert.equal(outcome.applicationLabelChanged, true);
    assert.equal(outcome.nativePolicyComplianceVerified, false);
    assert.equal(outcome.importPerformed, false);
    assert.equal(outcome.providerCalls, 0);
    assert.equal(outcome.infrastructureMutationAllowed, false);
    assert.equal(outcome.evidenceBasis, "CUSTOMER_SUPPLIED_MANIFESTS_NOT_ATTESTED");
    assert.match(outcome.comparisonSha256, /^[a-f0-9]{64}$/);
    assert.equal(outcome.comparisonSha256, assessBrownfieldApplicationReuse(before, proposed).comparisonSha256);
  }
});

test("network drift, IAM/logging drift, policy fingerprint change, and removed Control Tower/AVM/GCP constraints are blocked", () => {
  for (const provider of Object.keys(CLOUD_POLICY_FAMILIES) as BrownfieldProvider[]) {
    const source = sample(provider);
    const variants: Array<[string, (value: BrownfieldManifest) => void]> = [
      ["network", (x) => { x.protectedResources[0]!.configurationSha256 = fingerprint("1"); }],
      ["identity", (x) => { x.protectedResources[1]!.id = "new-identity"; }],
      ["logging", (x) => { x.protectedResources[2]!.sourceOfTruth = "new-team"; }],
      ["policy", (x) => { x.controls[0]!.definitionSha256 = fingerprint("2"); }],
      ["scope", (x) => { x.scope += "-other"; }],
      ["ownership", (x) => { x.protectedResources[0]!.mutationPolicy = "UPDATE_ALLOWED"; }],
      ["removed-policy", (x) => { x.controls.pop(); }],
      ["added-policy", (x) => { x.controls.push({ ...x.controls[0]!, id: "different-control" }); }],
      ["definition-ref", (x) => { x.controls[1]!.sourceOfTruth = "different-commit"; }],
    ];
    for (const [name, mutate] of variants) {
      const proposed = copied(source);
      proposed.applicationLabel = "A new display name";
      mutate(proposed);
      const outcome = assessBrownfieldApplicationReuse(source, proposed);
      assert.equal(outcome.verdict, "BLOCKED", provider + "/" + name);
      assert.equal(outcome.infrastructureMutationAllowed, false);
      assert.equal(outcome.nativePolicyComplianceVerified, false);
    }
  }
});

test("missing trusted manifest lineage, malformed hashes, duplicate controls, provider switch and no name change cannot pass", () => {
  const before = sample("GCP");
  const changes: Array<(x: BrownfieldManifest) => void> = [
    (x) => { x.controls[0]!.sourceOfTruth = ""; },
    (x) => { x.controls[0]!.definitionSha256 = "unverified"; },
    (x) => { x.controls[1]!.assignedScope = ""; },
    (x) => { x.controls.push({ ...x.controls[0]! }); },
    (x) => { x.protectedResources[0]!.ownership = "UNKNOWN" as never; },
    (x) => { x.protectedResources = []; },
    (x) => { x.provider = "AWS"; },
    (x) => { x.applicationLabel = ""; },
    (x) => { x.controls[0]!.family = "UNTRUSTED_POLICY"; },
  ];
  for (const mutate of changes) {
    const proposed = copied(before);
    proposed.applicationLabel = "New display label";
    mutate(proposed);
    assert.equal(assessBrownfieldApplicationReuse(before, proposed).verdict, "BLOCKED");
  }
  assert.equal(assessBrownfieldApplicationReuse(before, copied(before)).verdict, "BLOCKED");
});

test("existing infrastructure adoption never follows from a matching manifest or a hash", () => {
  const before = sample("AZURE"), proposed = copied(before);
  proposed.applicationLabel = "App Two";
  const result = assessBrownfieldApplicationReuse(before, proposed);
  assert.equal(result.verdict, "DECLARED_APP_LABEL_ONLY");
  assert.equal(result.nativePolicyComplianceVerified, false);
  assert.equal(result.importPerformed, false);
  assert.equal(result.infrastructureMutationAllowed, false);
  assert.equal((result as unknown as Record<string, unknown>).productionQualified, undefined);
});
