import assert from "node:assert/strict";
import test from "node:test";

import { GCP_LEAF_TYPES, GCP_MATERIAL_RISKS, GCP_SCAN_DEPTH, gcpIdentityIn, gcpProtectionOf, isGcpContainerType, isGcpIdentityType } from "../src/apply/cleanup-gcp.js";

// The GCP cleanup classifier (slice S3 of the GCP release-path PLAN; protected classes in docs/act-pilot-gcp-terraform-g0.md).
// SYNTHETIC: fake state entries only. It pins which entries a pilot cleanup may delete, and why every other one is kept.

const BUCKETS = ["alz-pilot-dev-state", "alz-pilot-qa-state"];
const P = "projects/alz-pilot-dev";
const judge = (type: string, id: string | null, holdsIdentity?: true) => gcpProtectionOf({ type, id, ...(holdsIdentity ? { holdsIdentity } : {}) }, BUCKETS);

test("only a reviewed leaf with an ordinary identifier is deletable: the minimal workload's topic", () => {
  assert.deepEqual(GCP_LEAF_TYPES, ["google_pubsub_topic"]);
  assert.equal(judge("google_pubsub_topic", P + "/topics/alz-unit-topic"), undefined);
  assert.equal(judge("google_pubsub_topic", null), undefined, "a dependent the state does not hold is judged by type");
  for (const type of ["google_pubsub_subscription", "google_compute_instance", "google_storage_bucket", "google_org_policy_policy", "google_project_organization_policy", "terraform_data", "null_resource", "random_id"]) {
    assert.equal(judge(type, "some-id"), "TYPE_UNREVIEWED", type);
  }
});

test("P4: the state bucket is PROTECTED_BACKEND under every identifier form, whatever type recorded it", () => {
  for (const [type, id] of [
    ["google_storage_bucket", "alz-pilot-dev-state"], ["google_storage_bucket", "alz-pilot-qa-state"], ["google_storage_bucket_object", "gs://alz-pilot-dev-state/pilot/dev/default.tfstate"],
    ["google_storage_bucket_iam_member", "b/alz-pilot-dev-state roles/storage.objectViewer serviceAccount:x@alz-pilot-dev.iam.gserviceaccount.com"],
    ["google_storage_bucket_acl", "projects/_/buckets/alz-pilot-dev-state"], ["terraform_data", "//storage.googleapis.com/projects/_/buckets/alz-pilot-dev-state"],
    ["google_storage_managed_folder", "alz-pilot-dev-state/pilot/"], ["google_storage_bucket", "https://www.googleapis.com/storage/v1/b/alz-pilot-dev-state"],
  ] as const) assert.equal(judge(type, id), "PROTECTED_BACKEND", type + " " + id);
  assert.equal(judge("google_storage_bucket", "alz-pilot-dev-state-2"), "TYPE_UNREVIEWED", "a neighbor bucket is not the backend");
});

test("identities and access are PROTECTED_IDENTITY by anchored prefix, and every resource-level binding with them", () => {
  for (const type of [
    "google_service_account", "google_service_account_key", "google_service_account_iam_member", "google_service_account_iam_binding",
    "google_iam_workload_identity_pool", "google_iam_workload_identity_pool_provider", "google_iam_workforce_pool", "google_iam_deny_policy",
    "google_iam_principal_access_boundary_policy", "google_project_iam_member", "google_project_iam_custom_role", "google_project_iam_audit_config",
    "google_folder_iam_policy", "google_organization_iam_custom_role", "google_billing_account_iam_member", "google_tags_tag_key_iam_binding",
    "google_tags_tag_value_iam_member", "google_cloud_identity_group", "google_cloud_identity_group_membership", "google_access_context_manager_access_level",
    "google_access_context_manager_service_perimeter_resource", "google_project_default_service_accounts", "google_pubsub_topic_iam_member",
    "google_storage_bucket_iam_binding", "google_kms_crypto_key_iam_member", "google_secret_manager_secret_iam_policy", "google_cloud_run_v2_service_iam_member",
  ]) {
    assert.equal(isGcpIdentityType(type), true, type);
    assert.equal(judge(type, P + "/whatever"), "PROTECTED_IDENTITY", type);
    assert.equal(judge(type, null), "PROTECTED_IDENTITY", type + " by type alone");
  }
});

test("containers are CONTAINS_OTHERS: projects, folders, organizations, API enablement, deployments and perimeters, by type and by a scope identifier", () => {
  for (const type of [
    "google_project", "google_folder", "google_organization", "google_project_service", "google_project_service_identity", "google_deployment_manager_deployment",
    "google_infra_manager_deployment", "google_access_context_manager_service_perimeter", "google_access_context_manager_service_perimeters",
  ]) {
    assert.equal(isGcpContainerType(type), true, type);
    assert.equal(judge(type, "x"), "CONTAINS_OTHERS", type);
  }
  for (const id of ["projects/alz-pilot-dev", "projects/123456789012", "folders/42", "organizations/123456789012", "projects/alz-pilot-dev/"]) {
    assert.equal(judge("google_pubsub_topic", id), "CONTAINS_OTHERS", id);
    assert.equal(judge("terraform_data", id), "CONTAINS_OTHERS", id);
  }
  assert.equal(isGcpContainerType("google_project_iam_member"), false);
  assert.equal(isGcpContainerType("google_organization_iam_member"), false);
});

test("an identity's name under any other type, a wrapper holding one, a blank identifier or a malformed type is UNCLASSIFIABLE", () => {
  for (const id of [
    P + "/serviceAccounts/alz-pilot-dev-apply@alz-pilot-dev.iam.gserviceaccount.com", "alz-pilot-dev-apply@alz-pilot-dev.iam.gserviceaccount.com",
    "projects/123/locations/global/workloadIdentityPools/alz-pilot-dev", "locations/global/workforcePools/people", P + "/roles/alz_pilot_dev_apply_workload",
    "roles/editor", "principal://iam.googleapis.com/projects/1/locations/global/workloadIdentityPools/p/subject/s", "serviceAccount:x@y.com",
    "user:person@example.com", "group:admins@example.com", "  ",
  ]) {
    assert.equal(judge("google_pubsub_topic", id), "UNCLASSIFIABLE", id);
    assert.equal(judge("terraform_data", id), "UNCLASSIFIABLE", id);
  }
  assert.equal(judge("terraform_data", "a-uuid", true), "UNCLASSIFIABLE");
  assert.equal(judge("google_pubsub_topic", P + "/topics/t", true), "UNCLASSIFIABLE");
  for (const type of ["Google_Pubsub_Topic", "google-pubsub-topic", "", "google_", "AWS::IAM::Role", "toString"]) assert.equal(judge(type, "x"), "UNCLASSIFIABLE", type);
});

test("the wrapper scan finds an identity anywhere in the attributes, and treats anything nested too deep as one", () => {
  assert.equal(gcpIdentityIn({ input: "hello", output: ["a", { b: 1 }] }), false);
  for (const value of [
    { input: "alz-pilot-dev-apply@alz-pilot-dev.iam.gserviceaccount.com" }, { triggers_replace: ["x", { member: "serviceAccount:a@b.iam.gserviceaccount.com" }] },
    { "principal://iam.googleapis.com/x": true }, [["projects/p/serviceAccounts/x"]], "roles/owner",
  ]) assert.equal(gcpIdentityIn(value), true, JSON.stringify(value));
  let deep: unknown = "plain";
  for (let i = 0; i <= GCP_SCAN_DEPTH; i += 1) deep = [deep];
  assert.equal(gcpIdentityIn(deep), true, "past the scan depth is not ruled out");
  let shallow: unknown = "plain";
  for (let i = 0; i < GCP_SCAN_DEPTH; i += 1) shallow = [shallow];
  assert.equal(gcpIdentityIn(shallow), false);
});

test("the material risks name what is lost for good, in U.S. English, for each risky type", () => {
  for (const type of ["google_storage_bucket", "google_sql_database_instance", "google_kms_crypto_key", "google_secret_manager_secret", "google_bigquery_dataset", "google_compute_disk", "google_logging_project_bucket_config", "google_pubsub_topic"]) {
    assert.ok((GCP_MATERIAL_RISKS[type] ?? "").length > 20, type);
    assert.ok(GCP_MATERIAL_RISKS[type].length < 512, type);
  }
});
