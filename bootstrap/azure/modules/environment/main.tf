locals {
  subscription_scope = "/subscriptions/${var.settings.subscription_id}"
  apply_scope        = var.settings.apply_resource_group_name == null ? local.subscription_scope : azurerm_resource_group.apply[0].id
}

# State storage: versioning and soft delete on, Entra ID authorization only (no account keys, no SAS).
resource "azurerm_resource_group" "state" {
  name     = var.settings.state_resource_group_name
  location = var.location
  tags     = var.tags
}

resource "azurerm_storage_account" "state" {
  name                            = var.settings.state_storage_account_name
  resource_group_name             = azurerm_resource_group.state.name
  location                        = azurerm_resource_group.state.location
  account_tier                    = "Standard"
  account_replication_type        = var.replication
  min_tls_version                 = "TLS1_2"
  https_traffic_only_enabled      = true
  allow_nested_items_to_be_public = false
  shared_access_key_enabled       = false
  default_to_oauth_authentication = true
  tags                            = var.tags

  # Deny by default. Only the runner's egress ranges (and trusted Azure services) reach the state account.
  network_rules {
    default_action = "Deny"
    bypass         = ["AzureServices"]
    ip_rules       = var.state_allowed_ip_ranges
  }

  blob_properties {
    versioning_enabled = true

    delete_retention_policy {
      days = var.retention_days
    }

    container_delete_retention_policy {
      days = var.retention_days
    }
  }
}

resource "azurerm_storage_container" "state" {
  name                  = var.settings.state_container_name
  storage_account_id    = azurerm_storage_account.state.id
  container_access_type = "private"
}

# The pilot's own resource group, when APPLY is scoped to one. Contributor on a group cannot create the group.
resource "azurerm_resource_group" "apply" {
  count    = var.settings.apply_resource_group_name == null ? 0 : 1
  name     = var.settings.apply_resource_group_name
  location = var.location
  tags     = var.tags
}

# STATE: read on the state container only.
resource "azurerm_role_assignment" "state" {
  scope                = azurerm_storage_container.state.resource_manager_id
  role_definition_name = "Storage Blob Data Reader"
  principal_id         = var.principal_ids["STATE"]
}

# STATE_WRITE: blob write (which includes the lease the lock takes), read and delete on the state container only.
resource "azurerm_role_assignment" "state_write" {
  scope                = azurerm_storage_container.state.resource_manager_id
  role_definition_name = "Storage Blob Data Contributor"
  principal_id         = var.principal_ids["STATE_WRITE"]
}

# DISCOVERY: read only, at the same scope APPLY writes to. It has no role on the state container.
resource "azurerm_role_assignment" "discovery" {
  scope                = local.apply_scope
  role_definition_name = "Reader"
  principal_id         = var.principal_ids["DISCOVERY"]
}

# APPLY: Contributor on the target resource group (or subscription). It cannot assign roles and has no role on the state container.
resource "azurerm_role_assignment" "apply" {
  scope                = local.apply_scope
  role_definition_name = "Contributor"
  principal_id         = var.principal_ids["APPLY"]
}

resource "azurerm_consumption_budget_subscription" "pilot" {
  count           = var.budget_amount == null ? 0 : 1
  name            = "act-pilot"
  subscription_id = local.subscription_scope
  amount          = var.budget_amount
  time_grain      = "Monthly"

  lifecycle {
    precondition {
      condition     = var.budget_start != null && length(var.alert_emails) > 0
      error_message = "A budget needs budget_start_date and at least one alert email."
    }
  }

  time_period {
    start_date = var.budget_start
  }

  dynamic "notification" {
    for_each = toset([80, 100])
    content {
      enabled        = true
      threshold      = notification.value
      operator       = "GreaterThan"
      threshold_type = "Actual"
      contact_emails = var.alert_emails
    }
  }
}
