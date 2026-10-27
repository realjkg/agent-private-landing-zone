# TERRAFORM engine only: the state bucket, and bucket-level grants that separate STATE (read, lock) from STATE_WRITE (write).
# The GCP_API engine keeps no state and gets no bucket and no bucket grant.
locals {
  state_prefix  = coalesce(var.state_prefix, "pilot/${local.env}")
  object_prefix = "projects/_/buckets/${coalesce(var.state_bucket_name, "unused")}/objects/${local.state_prefix}/"
  # UNVERIFIED (G-4): IAM Conditions on Cloud Storage objects by resource name, with uniform bucket-level access. A list call names the bucket.
  in_prefix = "resource.type == \"storage.googleapis.com/Bucket\" || resource.name.startsWith(\"${local.object_prefix}\")"

  state_roles = local.terraform ? {
    state_read  = ["storage.objects.get", "storage.objects.list"]
    state_lock  = ["storage.objects.create", "storage.objects.delete"]
    state_write = ["storage.objects.create", "storage.objects.delete", "storage.objects.get", "storage.objects.list"]
    readiness   = ["storage.buckets.get"]
  } : {}

  state_bindings = local.terraform ? {
    STATE_read = { role = "state_read", identity = "STATE", title = "pilot-state-prefix", expression = local.in_prefix }
    # STATE creates and deletes only the lock object, never the state object.
    STATE_lock        = { role = "state_lock", identity = "STATE", title = "pilot-lock-object-only", expression = "resource.name.startsWith(\"${local.object_prefix}\") && resource.name.endsWith(\".tflock\")" }
    STATE_WRITE_write = { role = "state_write", identity = "STATE_WRITE", title = "pilot-state-prefix", expression = local.in_prefix }
    # DISCOVERY's readiness check reads the bucket's metadata (versioning, uniform access), never an object.
    DISCOVERY_readiness = { role = "readiness", identity = "DISCOVERY", title = "", expression = "" }
  } : {}
}

resource "google_storage_bucket" "state" {
  count                       = local.terraform ? 1 : 0
  name                        = var.state_bucket_name
  location                    = var.region
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"
  force_destroy               = var.force_destroy_state

  versioning {
    enabled = true
  }

  # Keep at least N newer versions and D days of history; delete an older noncurrent version only when both hold.
  lifecycle_rule {
    condition {
      with_state                 = "ARCHIVED"
      num_newer_versions         = var.noncurrent_versions_kept
      days_since_noncurrent_time = var.noncurrent_version_retention_days
    }
    action {
      type = "Delete"
    }
  }

  # OWNER ITEM P3: off until decided. Matches *.tflock only, never *.tfstate.
  dynamic "lifecycle_rule" {
    for_each = var.lock_version_retention_days == null ? [] : [var.lock_version_retention_days]
    content {
      condition {
        with_state                 = "ARCHIVED"
        matches_suffix             = [".tflock"]
        days_since_noncurrent_time = lifecycle_rule.value
      }
      action {
        type = "Delete"
      }
    }
  }

  depends_on = [google_project_service.required]
}

resource "google_project_iam_custom_role" "state" {
  for_each    = local.state_roles
  role_id     = "${local.role_base}${each.key}"
  title       = "ACT pilot ${var.environment} ${each.key}"
  description = "Granted on the ACT pilot state bucket only."
  permissions = each.value
}

resource "google_storage_bucket_iam_member" "state" {
  for_each = local.state_bindings
  bucket   = google_storage_bucket.state[0].name
  role     = google_project_iam_custom_role.state[each.value.role].name
  member   = local.members[each.value.identity]

  dynamic "condition" {
    for_each = each.value.expression == "" ? [] : [each.value]
    content {
      title      = condition.value.title
      expression = condition.value.expression
    }
  }
}
