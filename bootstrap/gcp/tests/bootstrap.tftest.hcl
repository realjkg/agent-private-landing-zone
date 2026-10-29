# SYNTHETIC: `terraform test` with a mocked google provider. No credential, no Google endpoint, nothing is created.
# It checks this package's own logic (names, grants, conditions, validations, outputs), never Google's behavior.

# Computed names get fixed, well-formed fake values, so the provider's own format checks pass under the mock.
mock_provider "google" {
  mock_data "google_project" {
    defaults = { number = "123456789012" }
  }
  mock_resource "google_service_account" {
    defaults = { name = "projects/examplefake-dev/serviceAccounts/mock-account@examplefake-dev.iam.gserviceaccount.com" }
  }
  mock_resource "google_iam_workload_identity_pool" {
    defaults = { name = "projects/123456789012/locations/global/workloadIdentityPools/mock-pool" }
  }
  mock_resource "google_iam_workload_identity_pool_provider" {
    defaults = { name = "projects/123456789012/locations/global/workloadIdentityPools/mock-pool/providers/oidc" }
  }
  mock_resource "google_project_iam_custom_role" {
    defaults = { name = "projects/examplefake-dev/roles/mock_role" }
  }
}

variables {
  environment = "DEV"
  engine      = "TERRAFORM"
  project_id  = "examplefake-dev"
  region      = "europe-west4"
  oidc_subjects = {
    DISCOVERY   = "repo:OWNER/REPO:environment:dev-discovery"
    STATE       = "repo:OWNER/REPO:environment:dev-state"
    STATE_WRITE = "repo:OWNER/REPO:environment:dev-state-write"
    APPLY       = "repo:OWNER/REPO:environment:dev-apply"
  }
  token_files = {
    DISCOVERY   = "/var/run/alz/dev/discovery.jwt"
    STATE       = "/var/run/alz/dev/state.jwt"
    STATE_WRITE = "/var/run/alz/dev/state-write.jwt"
    APPLY       = "/var/run/alz/dev/apply.jwt"
  }
  state_bucket_name = "examplefake-dev-state"
}

run "terraform_engine_dev" {
  assert {
    condition     = length(google_service_account.identity) == 4 && google_service_account.identity["STATE_WRITE"].account_id == "alz-pilot-dev-state-write"
    error_message = "TERRAFORM has four service accounts named <prefix>-<env>-<identity>."
  }
  assert {
    condition     = alltrue([for i, m in google_service_account_iam_member.federated : m.role == "roles/iam.workloadIdentityUser" && endswith(m.member, "/subject/${var.oidc_subjects[i]}") && startswith(m.member, "principal://iam.googleapis.com/")])
    error_message = "Each service account trusts exactly its own subject's pool principal."
  }
  assert {
    condition     = alltrue([for s in values(var.oidc_subjects) : strcontains(google_iam_workload_identity_pool_provider.oidc.attribute_condition, "\"${s}\"")]) && google_iam_workload_identity_pool.pilot.workload_identity_pool_id == "alz-pilot-dev"
    error_message = "The provider admits the engine's subjects only."
  }
  assert {
    condition     = toset(google_project_iam_custom_role.workload["APPLY"].permissions) == toset(["pubsub.topics.create", "pubsub.topics.delete", "pubsub.topics.get"]) && toset(google_project_iam_custom_role.workload["DISCOVERY"].permissions) == toset(["cloudasset.assets.searchAllResources", "pubsub.topics.get"])
    error_message = "The minimal workload's permissions (D12): no topic update, publish, subscribe, IAM or service permission."
  }
  assert {
    condition     = alltrue([for m in google_project_iam_member.workload : startswith(m.role, "projects/")]) && length(google_project_iam_member.workload) == 2
    error_message = "Every project grant is one of this package's custom roles (D12): no predefined role."
  }
  assert {
    condition     = contains(keys(google_project_service.required), "cloudasset.googleapis.com") && contains(keys(google_project_service.required), "storage.googleapis.com")
    error_message = "Cloud Asset and Storage are enabled by the bootstrap, never at run time."
  }
  assert {
    condition     = length(google_storage_bucket.state) == 1 && google_storage_bucket.state[0].uniform_bucket_level_access && google_storage_bucket.state[0].public_access_prevention == "enforced" && google_storage_bucket.state[0].versioning[0].enabled && length(google_storage_bucket.state[0].lifecycle_rule) == 1
    error_message = "The state bucket: uniform access, public access prevention, versioning, one retention rule (P3 off)."
  }
  assert {
    condition     = endswith(google_storage_bucket_iam_member.state["STATE_lock"].condition[0].expression, ".endsWith(\".tflock\")") && google_storage_bucket_iam_member.state["STATE_lock"].member == "serviceAccount:alz-pilot-dev-state@examplefake-dev.iam.gserviceaccount.com"
    error_message = "STATE may create and delete the lock object only."
  }
  assert {
    condition     = toset(google_project_iam_custom_role.state["state_lock"].permissions) == toset(["storage.objects.create", "storage.objects.delete"]) && toset(google_project_iam_custom_role.state["state_read"].permissions) == toset(["storage.objects.get", "storage.objects.list"])
    error_message = "STATE reads, and writes only through the lock condition."
  }
  assert {
    condition     = length(google_storage_bucket_iam_member.state["DISCOVERY_readiness"].condition) == 0 && toset(google_project_iam_custom_role.state["readiness"].permissions) == toset(["storage.buckets.get"])
    error_message = "DISCOVERY reads bucket metadata only."
  }
  assert {
    condition     = length(google_org_policy_policy.no_service_account_keys) == 1 && length(google_iam_deny_policy.guardrails) == 1 && length(google_project_iam_audit_config.storage_data_access) == 0 && length(google_billing_budget.pilot) == 0
    error_message = "Key creation is forbidden and the deny guardrails are on; P5 and the budget are off by default."
  }
  assert {
    condition = anytrue([for rule in google_iam_deny_policy.guardrails[0].rules : anytrue([for deny in rule.deny_rule :
      toset(deny.denied_permissions) == toset(["storage.googleapis.com/buckets.setIamPolicy", "storage.googleapis.com/buckets.update", "storage.googleapis.com/buckets.delete"]) &&
    deny.denied_principals == tolist(["principal://iam.googleapis.com/projects/-/serviceAccounts/alz-pilot-dev-apply@examplefake-dev.iam.gserviceaccount.com"])])])
    error_message = "APPLY is denied changing any bucket's IAM policy or settings, and deleting one (review N2)."
  }
  assert {
    condition     = google_iam_workload_identity_pool_provider.oidc.attribute_condition == "assertion.sub in [${join(", ", [for s in values(var.oidc_subjects) : "\"${s}\""])}]"
    error_message = "With no required claims, the condition is the subject list alone."
  }
  assert {
    condition     = output.contract_target.backend == "examplefake-dev-state/pilot/dev" && output.contract_target.projectId == "examplefake-dev" && output.contract_target.workspace == "default" && output.contract_target.region == "europe-west4" && output.contract_target.canary == { resources = [{ type = "google_pubsub_topic", count = 1 }] } && toset(keys(output.contract_target)) == toset(["projectId", "region", "backend", "workspace", "canary"])
    error_message = "The contract target: D9's shape, with the one-topic canary."
  }
  assert {
    condition     = output.contract_settings.embedStateWrite == true && output.contract_settings.enabledEnvironments == ["DEV"]
    error_message = "TERRAFORM needs embedStateWrite so the state stays STATE_WRITE's."
  }
  assert {
    condition     = alltrue([for i, c in output.credential_configurations : toset(keys(jsondecode(c))) == toset(["type", "audience", "subject_token_type", "token_url", "credential_source"]) && jsondecode(c).type == "external_account" && jsondecode(c).credential_source == { file = var.token_files[i] }])
    error_message = "Each credential configuration is a WIF file source with no key, token or impersonation URL."
  }
}

run "api_engine_dev" {
  variables {
    engine            = "GCP_API"
    state_bucket_name = null
    topic_prefix      = "alz-act-dev1-"
    oidc_subjects = {
      DISCOVERY = "repo:OWNER/REPO:environment:dev-api-discovery"
      APPLY     = "repo:OWNER/REPO:environment:dev-api-apply"
    }
    token_files = {
      DISCOVERY = "/var/run/alz/dev/api-discovery.jwt"
      APPLY     = "/var/run/alz/dev/api-apply.jwt"
    }
  }
  assert {
    condition     = length(google_service_account.identity) == 2 && google_service_account.identity["APPLY"].account_id == "alz-pilot-dev-api-apply" && google_iam_workload_identity_pool.pilot.workload_identity_pool_id == "alz-pilot-dev-api"
    error_message = "GCP_API has DISCOVERY and APPLY only, in its own accounts and pool."
  }
  assert {
    condition     = toset(google_project_iam_custom_role.workload["APPLY"].permissions) == toset(["pubsub.topics.create", "pubsub.topics.delete"]) && toset(google_project_iam_custom_role.workload["DISCOVERY"].permissions) == toset(["cloudasset.assets.searchAllResources", "pubsub.topics.get"])
    error_message = "Exactly path 6's grants (D12): APPLY creates and deletes topics, DISCOVERY reads them and searches the project's assets."
  }
  assert {
    condition     = contains(keys(google_project_service.required), "cloudasset.googleapis.com") && !contains(keys(google_project_service.required), "storage.googleapis.com")
    error_message = "GCP_API: Cloud Asset is enabled by the bootstrap (D12 item 6); no storage."
  }
  assert {
    condition     = length(google_storage_bucket.state) == 0 && length(google_storage_bucket_iam_member.state) == 0 && length(google_project_iam_custom_role.state) == 0 && length(google_project_iam_audit_config.storage_data_access) == 0
    error_message = "GCP_API gets no state bucket and no bucket grant."
  }
  assert {
    condition     = output.contract_target == { projectId = "examplefake-dev", region = "europe-west4", backend = "GCP_API_NO_STATE", workspace = "default", topicPrefix = "alz-act-dev1-", canary = { resources = [{ type = "google_pubsub_topic", count = 1 }] } }
    error_message = "The GCP_API target in D9's shape (D12 checklist item 8): the no-state sentinel, the topic prefix and the one-topic canary."
  }
  assert {
    condition     = output.contract_settings == { enabledEnvironments = ["DEV"] }
    error_message = "GCP_API has no state to embed."
  }
  assert {
    condition     = google_iam_deny_policy.guardrails[0].name == "alz-pilot-dev-api-guardrails"
    error_message = "The GCP_API guardrails are its own."
  }
}

run "p3_lock_versions_opt_in" {
  variables {
    lock_version_retention_days     = 7
    enable_storage_data_access_logs = true
  }
  assert {
    condition     = length(google_storage_bucket.state[0].lifecycle_rule) == 2 && anytrue([for rule in google_storage_bucket.state[0].lifecycle_rule : anytrue([for c in rule.condition : tolist(c.matches_suffix) == tolist([".tflock"])])]) && length(google_project_iam_audit_config.storage_data_access) == 1
    error_message = "P3 adds a *.tflock-only rule; P5 adds the audit config."
  }
}

run "refuses_api_outside_dev" {
  command = plan
  variables {
    environment       = "QA"
    engine            = "GCP_API"
    state_bucket_name = null
    topic_prefix      = "alz-act-qa1-"
    oidc_subjects     = { DISCOVERY = "repo:O/R:environment:qa-d", APPLY = "repo:O/R:environment:qa-a" }
    token_files       = { DISCOVERY = "/run/d.jwt", APPLY = "/run/a.jwt" }
  }
  expect_failures = [var.environment]
}

run "refuses_terraform_outside_dev" {
  command = plan
  variables {
    environment = "PROD"
  }
  expect_failures = [var.environment]
}

run "refuses_api_without_topic_prefix" {
  command = plan
  variables {
    engine            = "GCP_API"
    state_bucket_name = null
    oidc_subjects     = { DISCOVERY = "repo:O/R:environment:d", APPLY = "repo:O/R:environment:a" }
    token_files       = { DISCOVERY = "/run/d.jwt", APPLY = "/run/a.jwt" }
  }
  expect_failures = [var.topic_prefix]
}

run "refuses_malformed_topic_prefix" {
  command = plan
  variables {
    engine            = "GCP_API"
    state_bucket_name = null
    topic_prefix      = "goog-topic-"
    oidc_subjects     = { DISCOVERY = "repo:O/R:environment:d", APPLY = "repo:O/R:environment:a" }
    token_files       = { DISCOVERY = "/run/d.jwt", APPLY = "/run/a.jwt" }
  }
  expect_failures = [var.topic_prefix]
}

run "refuses_topic_prefix_on_terraform" {
  command = plan
  variables {
    topic_prefix = "alz-act-dev1-"
  }
  expect_failures = [var.topic_prefix]
}

run "parent_is_carried_owner_declared" {
  variables {
    parent = "folders/123456789012"
  }
  assert {
    condition     = output.contract_target.parent == "folders/123456789012"
    error_message = "A stated parent is carried into the target (D9); nothing reads it."
  }
}

run "refuses_malformed_parent" {
  command = plan
  variables {
    parent = "folders/*"
  }
  expect_failures = [var.parent]
}

run "refuses_api_with_state_bucket" {
  command = plan
  variables {
    topic_prefix  = "alz-act-dev1-"
    engine        = "GCP_API"
    oidc_subjects = { DISCOVERY = "repo:O/R:environment:d", APPLY = "repo:O/R:environment:a" }
    token_files   = { DISCOVERY = "/run/d.jwt", APPLY = "/run/a.jwt" }
  }
  expect_failures = [var.state_bucket_name]
}

run "refuses_api_with_additional_roles" {
  command = plan
  variables {
    topic_prefix           = "alz-act-dev1-"
    engine                 = "GCP_API"
    state_bucket_name      = null
    oidc_subjects          = { DISCOVERY = "repo:O/R:environment:d", APPLY = "repo:O/R:environment:a" }
    token_files            = { DISCOVERY = "/run/d.jwt", APPLY = "/run/a.jwt" }
    apply_additional_roles = ["roles/pubsub.editor"]
  }
  expect_failures = [var.apply_additional_roles]
}

run "refuses_owner_role" {
  command = plan
  variables {
    apply_additional_roles = ["roles/owner"]
  }
  expect_failures = [var.apply_additional_roles]
}

run "refuses_editor_role" {
  command = plan
  variables {
    apply_additional_roles = ["roles/pubsub.editor", "roles/editor"]
  }
  expect_failures = [var.apply_additional_roles]
}

run "refuses_iam_admin_role" {
  command = plan
  variables {
    apply_additional_roles = ["roles/iam.serviceAccountTokenCreator"]
  }
  expect_failures = [var.apply_additional_roles]
}

run "refuses_missing_state_bucket" {
  command = plan
  variables {
    state_bucket_name = null
  }
  expect_failures = [var.state_bucket_name]
}

run "refuses_dotted_bucket" {
  command = plan
  variables {
    state_bucket_name = "state.example.com"
  }
  expect_failures = [var.state_bucket_name]
}

run "refuses_google_bucket" {
  command = plan
  variables {
    state_bucket_name = "goog-pilot-state"
  }
  expect_failures = [var.state_bucket_name]
}

run "refuses_parent_prefix" {
  command = plan
  variables {
    state_prefix = "pilot/../other"
  }
  expect_failures = [var.state_prefix]
}

run "refuses_shared_subject" {
  command = plan
  variables {
    oidc_subjects = {
      DISCOVERY   = "repo:O/R:environment:one"
      STATE       = "repo:O/R:environment:one"
      STATE_WRITE = "repo:O/R:environment:sw"
      APPLY       = "repo:O/R:environment:a"
    }
  }
  expect_failures = [var.oidc_subjects]
}

run "refuses_subject_that_ends_a_cel_string" {
  command = plan
  variables {
    oidc_subjects = {
      DISCOVERY   = "repo:O/R:environment:d\" || true || \""
      STATE       = "repo:O/R:environment:s"
      STATE_WRITE = "repo:O/R:environment:sw"
      APPLY       = "repo:O/R:environment:a"
    }
  }
  expect_failures = [var.oidc_subjects]
}

run "refuses_wildcard_subject" {
  command = plan
  variables {
    oidc_subjects = {
      DISCOVERY   = "repo:O/R:*"
      STATE       = "repo:O/R:environment:s"
      STATE_WRITE = "repo:O/R:environment:sw"
      APPLY       = "repo:O/R:environment:a"
    }
  }
  expect_failures = [var.oidc_subjects]
}

run "refuses_missing_identity_subject" {
  command = plan
  variables {
    oidc_subjects = { DISCOVERY = "repo:O/R:environment:d", STATE_WRITE = "repo:O/R:environment:sw", APPLY = "repo:O/R:environment:a" }
    token_files   = { DISCOVERY = "/run/d.jwt", STATE_WRITE = "/run/sw.jwt", APPLY = "/run/a.jwt" }
  }
  expect_failures = [var.oidc_subjects]
}

run "refuses_relative_or_shared_token_file" {
  command = plan
  variables {
    token_files = {
      DISCOVERY   = "run/discovery.jwt"
      STATE       = "/run/s.jwt"
      STATE_WRITE = "/run/s.jwt"
      APPLY       = "/run/a.jwt"
    }
  }
  expect_failures = [var.token_files]
}

run "refuses_long_prefix" {
  command = plan
  variables {
    name_prefix = "alz-pilot-xyz"
  }
  expect_failures = [var.name_prefix]
}

run "refuses_budget_without_billing_account" {
  command = plan
  variables {
    budget_monthly_usd = 50
  }
  expect_failures = [google_billing_budget.pilot]
}

run "pins_required_claims" {
  variables {
    oidc_required_claims = { repository_id = "123456789", repository_owner_id = "987654321" }
  }
  assert {
    condition     = endswith(google_iam_workload_identity_pool_provider.oidc.attribute_condition, " && assertion.repository_id == \"123456789\" && assertion.repository_owner_id == \"987654321\"") && startswith(google_iam_workload_identity_pool_provider.oidc.attribute_condition, "assertion.sub in [")
    error_message = "Each required claim is ANDed into the condition (review N3)."
  }
}

run "refuses_required_claim_that_ends_a_cel_string" {
  command = plan
  variables {
    oidc_required_claims = { repository_id = "1\" || true || \"" }
  }
  expect_failures = [var.oidc_required_claims]
}

run "refuses_required_claim_with_an_expression_name" {
  command = plan
  variables {
    oidc_required_claims = { "sub || true" = "x" }
  }
  expect_failures = [var.oidc_required_claims]
}

run "refuses_pubsub_viewer_role" {
  command = plan
  variables {
    apply_additional_roles = ["roles/pubsub.viewer"]
  }
  expect_failures = [var.apply_additional_roles]
}

run "refuses_pubsub_publisher_role" {
  command = plan
  variables {
    apply_additional_roles = ["roles/pubsub.publisher"]
  }
  expect_failures = [var.apply_additional_roles]
}

run "refuses_logging_viewer_role" {
  command = plan
  variables {
    apply_additional_roles = ["roles/logging.viewer"]
  }
  expect_failures = [var.apply_additional_roles]
}

run "refuses_storage_admin_role" {
  command = plan
  variables {
    apply_additional_roles = ["roles/storage.admin"]
  }
  expect_failures = [var.apply_additional_roles]
}

run "refuses_deployment_manager_editor_role" {
  command = plan
  variables {
    apply_additional_roles = ["roles/deploymentmanager.editor"]
  }
  expect_failures = [var.apply_additional_roles]
}

run "refuses_cloud_build_editor_role" {
  command = plan
  variables {
    apply_additional_roles = ["roles/cloudbuild.builds.editor"]
  }
  expect_failures = [var.apply_additional_roles]
}

run "refuses_any_admin_or_unreviewed_role" {
  command = plan
  variables {
    apply_additional_roles = ["roles/pubsub.viewer", "roles/pubsub.admin"]
  }
  expect_failures = [var.apply_additional_roles]
}
