# Project guardrails. Each is owner-run and owner-managed; the pilot's identities can change none of them.

# Owner decision 3 (PLAN Q5): no service account key can be created in a pilot project, so "never a key file" is a cloud-side fact.
resource "google_org_policy_policy" "no_service_account_keys" {
  count  = var.enforce_no_service_account_keys ? 1 : 0
  name   = "projects/${var.project_id}/policies/iam.disableServiceAccountKeyCreation"
  parent = "projects/${var.project_id}"

  spec {
    rules {
      enforce = "TRUE"
    }
  }
}

# The AWS bucket policy's "deny everyone else" and "deny editing the bootstrap identity", as an IAM deny policy. A deny outranks any
# allow, so a broad role later given to APPLY cannot make it a state fallback or let it edit what bounds it.
# UNVERIFIED: the permission names below are from memory, in the deny-policy form <service>.googleapis.com/<resource>.<verb>. A wrong
# name fails the bootstrap apply (it never silently allows), and the runbook checks them against Google's supported-permissions list first.
locals {
  deny_object_access = [for verb in ["create", "delete", "get", "list", "update"] : "storage.googleapis.com/objects.${verb}"]
  deny_identity_edits = [
    "iam.googleapis.com/serviceAccounts.delete", "iam.googleapis.com/serviceAccounts.update", "iam.googleapis.com/serviceAccounts.setIamPolicy",
    "iam.googleapis.com/serviceAccountKeys.create", "iam.googleapis.com/roles.update", "iam.googleapis.com/roles.delete",
    "iam.googleapis.com/workloadIdentityPools.update", "iam.googleapis.com/workloadIdentityPools.delete",
    "iam.googleapis.com/workloadIdentityPoolProviders.update", "iam.googleapis.com/workloadIdentityPoolProviders.delete",
    "cloudresourcemanager.googleapis.com/projects.setIamPolicy",
  ]
  deny_principal = { for i, email in local.emails : i => "principal://iam.googleapis.com/projects/-/serviceAccounts/${email}" }
}

resource "google_iam_deny_policy" "guardrails" {
  count        = var.deny_pilot_guardrails ? 1 : 0
  parent       = urlencode("cloudresourcemanager.googleapis.com/projects/${var.project_id}")
  name         = "${var.name_prefix}-${local.env}${local.api ? "-api" : ""}-guardrails"
  display_name = "ACT pilot ${var.environment} guardrails${local.api ? " (API engine)" : ""}"

  rules {
    description = "APPLY and DISCOVERY never touch Cloud Storage objects: state is STATE's and STATE_WRITE's only."
    deny_rule {
      denied_principals  = [local.deny_principal["APPLY"], local.deny_principal["DISCOVERY"]]
      denied_permissions = local.deny_object_access
    }
  }

  rules {
    description = "APPLY never edits the pilot's identities, roles, pool or the project's IAM policy."
    deny_rule {
      denied_principals  = [local.deny_principal["APPLY"]]
      denied_permissions = local.deny_identity_edits
    }
  }
}

# OWNER ITEM P5: off until decided. The qualifier's SEPARATED attestation needs state reads and writes in the audit log.
resource "google_project_iam_audit_config" "storage_data_access" {
  count   = local.terraform && var.enable_storage_data_access_logs ? 1 : 0
  project = var.project_id
  service = "storage.googleapis.com"

  audit_log_config {
    log_type = "DATA_READ"
  }
  audit_log_config {
    log_type = "DATA_WRITE"
  }
}

resource "google_billing_budget" "pilot" {
  count           = var.budget_monthly_usd == null ? 0 : 1
  billing_account = coalesce(var.billing_account_id, "unset")
  display_name    = "${var.name_prefix}-${local.env}${local.api ? "-api" : ""}"

  budget_filter {
    projects = ["projects/${data.google_project.this.number}"]
  }

  amount {
    specified_amount {
      currency_code = "USD"
      units         = tostring(var.budget_monthly_usd)
    }
  }

  threshold_rules {
    threshold_percent = 0.8
  }
  threshold_rules {
    threshold_percent = 1.0
  }

  lifecycle {
    precondition {
      condition     = var.billing_account_id != null && can(regex("^[0-9A-F]{6}-[0-9A-F]{6}-[0-9A-F]{6}$", coalesce(var.billing_account_id, "x")))
      error_message = "A budget needs billing_account_id, like 000000-000000-000000."
    }
  }
}
