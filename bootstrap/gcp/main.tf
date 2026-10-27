locals {
  env       = lower(var.environment)
  api       = var.engine == "GCP_API"
  terraform = var.engine == "TERRAFORM"
  # Each engine gets its own service accounts, pool and roles, so a GCP_API run never holds a TERRAFORM grant (the state bucket above all).
  engine_tag = local.api ? "api-" : ""
  identities = toset(local.api ? ["DISCOVERY", "APPLY"] : ["DISCOVERY", "STATE", "STATE_WRITE", "APPLY"])

  account_ids = { for i in local.identities : i => "${var.name_prefix}-${local.env}-${local.engine_tag}${lower(replace(i, "_", "-"))}" }
  emails      = { for i, id in local.account_ids : i => "${id}@${var.project_id}.iam.gserviceaccount.com" }
  members     = { for i, email in local.emails : i => "serviceAccount:${email}" }
  # Custom role ids allow letters, digits, underscores and dots only.
  role_base = "${replace(var.name_prefix, "-", "_")}_${local.env}_${replace(local.engine_tag, "-", "_")}"
  pool_id   = "${var.name_prefix}-${local.env}${local.api ? "-api" : ""}"

  # The minimal workload: one labeled Pub/Sub topic in the DEV project. GCP_API gets exactly what path 6 named (#303): APPLY creates and
  # deletes, DISCOVERY reads. Terraform also reads the topic back after creating it and can update its labels, and its DISCOVERY sweeps
  # the unit's resources through Cloud Asset Inventory.
  workload_permissions = local.api ? {
    DISCOVERY = ["pubsub.topics.get"]
    APPLY     = ["pubsub.topics.create", "pubsub.topics.delete"]
    } : {
    DISCOVERY = ["cloudasset.assets.searchAllResources", "pubsub.topics.get"]
    APPLY     = ["pubsub.topics.create", "pubsub.topics.delete", "pubsub.topics.get", "pubsub.topics.update"]
  }

  services = toset(concat(
    ["iam.googleapis.com", "iamcredentials.googleapis.com", "sts.googleapis.com", "pubsub.googleapis.com"],
    local.terraform ? ["storage.googleapis.com", "cloudasset.googleapis.com"] : [],
  ))
}

data "google_project" "this" {
  project_id = var.project_id
}

# Enabled and never disabled on destroy: other workloads in the project may rely on them.
resource "google_project_service" "required" {
  for_each           = local.services
  service            = each.value
  disable_on_destroy = false
}

# Workload identity federation: one pool and one OIDC provider per project and engine. The attribute condition admits only the
# engine's exact subjects, and each service account trusts exactly one of them.
resource "google_iam_workload_identity_pool" "pilot" {
  workload_identity_pool_id = local.pool_id
  display_name              = "ACT pilot ${var.environment}${local.api ? " API" : ""}"
  description               = "Federated identities of the ACT pilot (${var.engine}, ${var.environment}). Owner-managed; the pilot never edits it."

  depends_on = [google_project_service.required]
}

resource "google_iam_workload_identity_pool_provider" "oidc" {
  workload_identity_pool_id          = google_iam_workload_identity_pool.pilot.workload_identity_pool_id
  workload_identity_pool_provider_id = "oidc"
  display_name                       = "Runner OIDC issuer"
  attribute_mapping                  = { "google.subject" = "assertion.sub" }
  attribute_condition = join(" && ", concat(
    ["assertion.sub in [${join(", ", [for s in values(var.oidc_subjects) : "\"${s}\""])}]"],
    [for claim, value in var.oidc_required_claims : "assertion.${claim} == \"${value}\""],
  ))

  oidc {
    issuer_uri        = var.oidc_issuer_uri
    allowed_audiences = var.oidc_allowed_audiences
  }
}

# Service accounts only: no key is ever created (and the org policy below forbids one).
resource "google_service_account" "identity" {
  for_each     = local.account_ids
  account_id   = each.value
  display_name = "ACT pilot ${var.environment} ${each.key}${local.api ? " (API engine)" : ""}"
  description  = "ACT pilot ${each.key} identity, impersonated through workload identity federation only."

  depends_on = [google_project_service.required]
}

# The only principal that may impersonate each service account: the pool principal of its one subject.
resource "google_service_account_iam_member" "federated" {
  for_each           = local.identities
  service_account_id = google_service_account.identity[each.key].name
  role               = "roles/iam.workloadIdentityUser"
  member             = "principal://iam.googleapis.com/${google_iam_workload_identity_pool.pilot.name}/subject/${var.oidc_subjects[each.key]}"
}

resource "google_project_iam_custom_role" "workload" {
  for_each    = local.workload_permissions
  role_id     = "${local.role_base}${lower(each.key)}_workload"
  title       = "ACT pilot ${var.environment} ${each.key} workload${local.api ? " (API engine)" : ""}"
  description = "The minimal workload's permissions for the ACT pilot ${each.key} identity."
  permissions = each.value
}

resource "google_project_iam_member" "workload" {
  for_each = local.workload_permissions
  project  = var.project_id
  role     = google_project_iam_custom_role.workload[each.key].name
  member   = local.members[each.key]
}

resource "google_project_iam_member" "apply_additional" {
  for_each = toset(var.apply_additional_roles)
  project  = var.project_id
  role     = each.value
  member   = local.members["APPLY"]
}
