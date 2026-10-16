import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { inspectCloudPolicySnapshot, type CloudPolicySnapshot, type SnapshotMethod } from "../src/governance/cloud-policy-snapshots.js";
import type { BrownfieldProvider, PolicyRef } from "../src/governance/brownfield-reuse.js";

function scenario(provider: BrownfieldProvider): { ref: PolicyRef; target: string; snapshot: CloudPolicySnapshot } {
  const awsId = "arn:aws:controltower:us-east-1:123456789012:enabledcontrol/abc123";
  const awsOU = "arn:aws:organizations::123456789012:ou/o-12345678/ou-abcd-12345678";
  const azureId = "/subscriptions/00000000-0000-0000-0000-000000000000/providers/Microsoft.Authorization/policyAssignments/p1";
  const azureScope = "/subscriptions/00000000-0000-0000-0000-000000000000";
  const gcpTarget = "projects/123456789012";
  const id = provider === "AWS" ? awsId : provider === "AZURE" ? azureId : gcpTarget + "/policies/compute.disableSerialPortAccess";
  const target = provider === "AWS" ? awsOU : provider === "AZURE" ? azureScope + "/resourceGroups/app-prod" : gcpTarget;
  const method: SnapshotMethod = provider === "AWS" ? "AWS_CONTROL_TOWER_GET_ENABLED_CONTROL" :
    provider === "AZURE" ? "AZURE_POLICY_ASSIGNMENT_GET" : "GCP_ORGPOLICY_GET_EFFECTIVE_POLICY";
  const body = provider === "AWS" ? { enabledControlDetails: {
    arn: awsId, controlIdentifier: "arn:aws:controlcatalog:::control/EXAMPLE", targetIdentifier: awsOU,
    statusSummary: { status: "SUCCEEDED" }, driftStatusSummary: { driftStatus: "IN_SYNC" },
  } } : provider === "AZURE" ? { id: azureId, properties: {
    scope: azureScope, policyDefinitionId: "/providers/Microsoft.Authorization/policyDefinitions/example",
    enforcementMode: "Default", notScopes: [],
  } } : { name: id, spec: { rules: [{ enforce: true }] } };
  const content = JSON.stringify(body);
  const ref: PolicyRef = {
    id, assignedScope: provider === "AZURE" ? azureScope : target,
    sourceOfTruth: "customer-governance@reviewed-commit",
    definitionSha256: "a".repeat(64),
    family: provider === "AWS" ? "CONTROL_TOWER_CONTROL" :
      provider === "AZURE" ? "AZURE_POLICY_ASSIGNMENT" : "ORGANIZATION_POLICY",
  };
  return { ref, target, snapshot: {
    provider, targetScope: target, method, controlId: id, content,
    contentSha256: createHash("sha256").update(content).digest("hex"), inventoryComplete: true,
  } };
}
function mutate(item: ReturnType<typeof scenario>, fn: (document: Record<string, unknown>) => void) {
  const copy = structuredClone(item);
  const parsed = JSON.parse(copy.snapshot.content) as Record<string, unknown>;
  fn(parsed);
  copy.snapshot.content = JSON.stringify(parsed);
  copy.snapshot.contentSha256 = createHash("sha256").update(copy.snapshot.content).digest("hex");
  return copy;
}

test("native snapshots for all three providers stay explicitly unattested without cloud calls", () => {
  for (const provider of ["AWS", "AZURE", "GCP"] as const) {
    const { ref, snapshot, target } = scenario(provider);
    const result = inspectCloudPolicySnapshot(ref, provider, target, snapshot);
    assert.equal(result.verdict, "REVIEW", provider);
    assert.equal(result.attested, false);
    assert.equal(result.actAllowed, false);
    assert.equal(result.providerCalls, 0);
    assert.equal(result.sourceDigestMatched, true);
    assert.match(result.evidenceSha256, /^[0-9a-f]{64}$/);
    assert.equal(result.evidenceSha256, inspectCloudPolicySnapshot(ref, provider, target, snapshot).evidenceSha256);
  }
});

test("all three providers reject identity, method, source digest and target scope mismatches", () => {
  for (const provider of ["AWS", "AZURE", "GCP"] as const) {
    const normal = scenario(provider);
    const variants = [
      (s: CloudPolicySnapshot) => { s.controlId = "other-control"; },
      (s: CloudPolicySnapshot) => { s.targetScope += "/elsewhere"; },
      (s: CloudPolicySnapshot) => { s.provider = provider === "AWS" ? "AZURE" : "AWS"; },
      (s: CloudPolicySnapshot) => { s.contentSha256 = "0".repeat(64); },
      (s: CloudPolicySnapshot) => { s.content = "{notjson"; s.contentSha256 = createHash("sha256").update(s.content).digest("hex"); },
      (s: CloudPolicySnapshot) => { s.content = "x".repeat(256001); s.contentSha256 = createHash("sha256").update(s.content).digest("hex"); },
      (s: CloudPolicySnapshot) => { s.method = "UNKNOWN" as never; },
    ];
    for (const change of variants) {
      const copy = structuredClone(normal);
      change(copy.snapshot);
      assert.equal(inspectCloudPolicySnapshot(copy.ref, provider, copy.target, copy.snapshot).verdict, "BLOCK");
    }
    const incomplete = structuredClone(normal);
    incomplete.snapshot.inventoryComplete = false;
    assert.equal(inspectCloudPolicySnapshot(incomplete.ref, provider, incomplete.target, incomplete.snapshot).verdict, "REVIEW");
  }
});

test("AWS Control Tower status/drift and wrong OU fail closed", () => {
  const basic = scenario("AWS");
  for (const fn of [
    (doc: Record<string, unknown>) => { (doc.enabledControlDetails as any).statusSummary.status = "FAILED"; },
    (doc: Record<string, unknown>) => { (doc.enabledControlDetails as any).driftStatusSummary.driftStatus = "DRIFTED"; },
    (doc: Record<string, unknown>) => { (doc.enabledControlDetails as any).targetIdentifier = "arn:aws:organizations::000000000000:ou/o-other/ou-other"; },
  ]) {
    const row = mutate(basic, fn);
    assert.equal(inspectCloudPolicySnapshot(row.ref, "AWS", row.target, row.snapshot).verdict, "BLOCK");
  }
  const changing = mutate(basic, d => { (d.enabledControlDetails as any).statusSummary.status = "UNDER_CHANGE"; });
  assert.equal(inspectCloudPolicySnapshot(changing.ref, "AWS", changing.target, changing.snapshot).verdict, "REVIEW");
});

test("Azure policy assignment scope boundaries and excluded resources fail closed", () => {
  const normal = scenario("AZURE");
  for (const fn of [
    (d: Record<string, unknown>) => { (d.properties as any).enforcementMode = "DoNotEnforce"; },
    (d: Record<string, unknown>) => { (d.properties as any).notScopes = [normal.target]; },
    (d: Record<string, unknown>) => { (d.properties as any).scope = "/subscriptions/another"; },
    (d: Record<string, unknown>) => { (d.properties as any).policyDefinitionId = ""; },
  ]) {
    const row = mutate(normal, fn);
    assert.equal(inspectCloudPolicySnapshot(row.ref, "AZURE", row.target, row.snapshot).verdict, "BLOCK");
  }
  const enroll = mutate(normal, d => { (d.properties as any).enforcementMode = "Enroll"; });
  assert.equal(inspectCloudPolicySnapshot(enroll.ref, "AZURE", enroll.target, enroll.snapshot).verdict, "REVIEW");
  const exclusionBoundary = mutate(normal, d => { (d.properties as any).notScopes = [normal.target + "-other"]; });
  assert.equal(inspectCloudPolicySnapshot(exclusionBoundary.ref, "AZURE", exclusionBoundary.target, exclusionBoundary.snapshot).verdict, "REVIEW");
});

test("GCP GetEffectivePolicy distinguishes effective state from drift, reset and unenforced values", () => {
  const normal = scenario("GCP");
  for (const fn of [
    (d: Record<string, unknown>) => { (d.spec as any).reset = true; },
    (d: Record<string, unknown>) => { (d.spec as any).rules[0].enforce = false; },
    (d: Record<string, unknown>) => { (d.spec as any).rules = [{ allowAll: true }]; },
    (d: Record<string, unknown>) => { d.name = "projects/222/policies/compute.disableSerialPortAccess"; },
  ]) {
    const row = mutate(normal, fn);
    assert.equal(inspectCloudPolicySnapshot(row.ref, "GCP", row.target, row.snapshot).verdict, "BLOCK");
  }
  const conditional = mutate(normal, d => { (d.spec as any).rules[0].condition = { expression: "resource.matchTag('env','prod')" }; });
  assert.equal(inspectCloudPolicySnapshot(conditional.ref, "GCP", conditional.target, conditional.snapshot).verdict, "REVIEW");
});
