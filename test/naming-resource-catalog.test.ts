import assert from "node:assert/strict";
import test from "node:test";
import { assessPhysicalResourceName, type PhysicalNameIntent } from "../src/governance/naming-resource-catalog.js";

function sample(kind: PhysicalNameIntent["kind"]): PhysicalNameIntent {
  const provider: PhysicalNameIntent["provider"] = kind === "AWS_S3_BUCKET" ? "AWS" :
    kind === "AZURE_STORAGE_ACCOUNT" ? "AZURE" : "GCP";
  const proposedName = kind === "AWS_S3_BUCKET" ? "customer-data-prod-123" :
    kind === "AZURE_STORAGE_ACCOUNT" ? "custdataprod123" :
      kind === "GCP_PROJECT_ID" ? "customer-prod-123" : "app-records-stg-us-001";
  return {
    provider, kind, proposedName, operation: "CREATE_NEW",
    namespace: { scope: "customer/approved/environment", inventoryComplete: true, existing: [], reserved: [] },
  };
}

test("resource-specific lexical rules differ across AWS S3, Azure Storage, GCP project and logical application keys", () => {
  for (const kind of ["AWS_S3_BUCKET", "AZURE_STORAGE_ACCOUNT", "GCP_PROJECT_ID", "APP_LOGICAL_KEY"] as const) {
    const r = assessPhysicalResourceName(sample(kind));
    assert.equal(r.verdict, kind === "APP_LOGICAL_KEY" ? "LEXICAL_MATCH_PENDING_AUTHORITY" : "REVIEW", kind);
    assert.equal(r.uniquenessAttested, false);
    assert.equal(r.infrastructureMutationAllowed, false);
    assert.equal(r.providerCalls, 0);
    assert.match(r.sha256, /^[a-f0-9]{64}$/);
    assert.equal(r.sha256, assessPhysicalResourceName(sample(kind)).sha256);
  }
});
test("invalid provider-specific names are refused instead of applying generic app naming", () => {
  const cases: Array<[PhysicalNameIntent["kind"], string]> = [
    ["AWS_S3_BUCKET", "ab"], ["AWS_S3_BUCKET", "foo..bar"],
    ["AWS_S3_BUCKET", "foo.-bar"], ["AWS_S3_BUCKET", "192.168.1.1"],
    ["AWS_S3_BUCKET", "amzn-s3-demo-example"], ["AWS_S3_BUCKET", "customer-s3alias"],
    ["AZURE_STORAGE_ACCOUNT", "cust-data"], ["AZURE_STORAGE_ACCOUNT", "CUSTOMER"],
    ["AZURE_STORAGE_ACCOUNT", "a".repeat(25)],
    ["GCP_PROJECT_ID", "12project"], ["GCP_PROJECT_ID", "too"], ["GCP_PROJECT_ID", "my-google-app"],
    ["APP_LOGICAL_KEY", "CamelCase-App"], ["APP_LOGICAL_KEY", "app-"],
  ];
  for (const [kind, proposedName] of cases) {
    const s = sample(kind); s.proposedName = proposedName;
    assert.equal(assessPhysicalResourceName(s).verdict, "BLOCK", kind + "/" + proposedName);
  }
});
test("existing physical assets cannot be renamed, and references must match the exact existing resource", () => {
  const existing = sample("AZURE_STORAGE_ACCOUNT");
  existing.operation = "REFERENCE_EXISTING";
  existing.existingName = existing.proposedName;
  existing.namespace.existing = [existing.proposedName];
  assert.equal(assessPhysicalResourceName(existing).verdict, "REVIEW");
  const wrong = structuredClone(existing); wrong.existingName = "anotherstorage";
  assert.equal(assessPhysicalResourceName(wrong).verdict, "BLOCK");
  const rename = structuredClone(existing); rename.operation = "RENAME_EXISTING";
  assert.equal(assessPhysicalResourceName(rename).verdict, "BLOCK");
});
test("customer registry collisions, case folding and incomplete inventories cannot authorize a new physical name", () => {
  const baseline = sample("AWS_S3_BUCKET");
  for (const source of ["existing", "reserved"] as const) {
    const x = structuredClone(baseline);
    x.namespace[source] = [baseline.proposedName.toUpperCase()];
    assert.equal(assessPhysicalResourceName(x).verdict, "BLOCK");
  }
  const uncertain = structuredClone(baseline); uncertain.namespace.inventoryComplete = false;
  assert.equal(assessPhysicalResourceName(uncertain).verdict, "REVIEW");
  const wrongProvider = structuredClone(baseline); wrongProvider.provider = "GCP";
  assert.equal(assessPhysicalResourceName(wrongProvider).verdict, "BLOCK");
  const broken = structuredClone(baseline); broken.namespace.scope = "../customer";
  assert.equal(assessPhysicalResourceName(broken).verdict, "BLOCK");
});
