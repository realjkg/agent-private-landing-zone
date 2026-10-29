locals {
  subscription_scope = "/subscriptions/${var.settings.subscription_id}"
  # APPLY and DISCOVERY are scoped to the pilot resource group in every mode (owner decision of 2026-10-28: no subscription-wide
  # Contributor). The module refuses an environment without one (variables.tf), so there is no subscription fallback.
  apply_scope = azurerm_resource_group.apply[0].id
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

# The pilot's own resource group, where APPLY and DISCOVERY are scoped. APPLY's role cannot create, change or delete a group.
# (The count is kept so existing state keeps its address; the module's validation makes it always 1.)
resource "azurerm_resource_group" "apply" {
  count    = var.settings.apply_resource_group_name == null ? 0 : 1
  name     = var.settings.apply_resource_group_name
  location = var.location
  tags     = var.tags
}

# APPLY and the state (owner decision 6486426552, issue #39): APPLY has no role on the state resource group, account or container,
# no data action anywhere, and the account takes no shared key or SAS, so APPLY's only path to the state would be a grant it does not
# hold. That is denial by ABSENCE of a grant. The owner also asked for an EFFECTIVE (explicit) denial, and this configuration has none,
# because no mechanism it can use provides one for blob data actions:
# - Azure RBAC deny assignments cannot be created by a customer directly; Azure creates them only for managed applications and for
#   deployment stacks. Whether a stack's deny settings cover blob DATA actions is unverified offline; this file claims nothing it
#   cannot show.
# - An ABAC condition narrows only the role assignment that carries it, so it cannot deny APPLY anything APPLY is granted elsewhere.
# - Network rules and private endpoints tell networks apart, not identities: APPLY runs on the same host as STATE_WRITE.
# - ADLS Gen2 ACLs are consulted only after RBAC has not granted access, so they cannot override a later RBAC grant.
# Azure Terraform therefore stays BLOCKED on this item (config/release/status.json, act:azure-terraform). The binding itself (the plan
# names STATE_WRITE for the backend, and no identity may carry a client secret) is in src/apply and is not a substitute for a denial.

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

# APPLY, Azure Terraform path (owner decision of 2026-10-28, "Azure APPLY role"): a custom role, defined, assignable and assigned at
# the pilot resource group only, in place of the built-in Contributor. It lists exactly the ARM operations `terraform apply` runs as
# APPLY for the canary (one empty virtual network): azurerm reads the network before it creates it (the import check) and after,
# writes it with its tags, and deletes it at the governed cleanup. The plan, its refresh and every data source run as DISCOVERY
# (Reader), not APPLY. No wildcard, no Microsoft.Authorization action (APPLY cannot assign roles or write deny assignments), no
# resource group write or delete, no data action, nothing at subscription scope, and no role on the state container. Each action is
# justified in docs/act-pilot-bootstrap.md, "APPLY's role". The application's canary allowlist is not the IAM boundary: this role is.
locals {
  apply_actions = [
    "Microsoft.Network/virtualNetworks/read",
    "Microsoft.Network/virtualNetworks/write",
    "Microsoft.Network/virtualNetworks/delete",
  ]
}

resource "azurerm_role_definition" "apply" {
  # Custom role names are unique in the tenant: the subscription and the group make each environment's its own.
  name        = "alz-pilot-apply-${var.settings.subscription_id}-${azurerm_resource_group.apply[0].name}"
  scope       = azurerm_resource_group.apply[0].id
  description = "ACT pilot APPLY, Azure Terraform path: read, write and delete virtual networks in this resource group only."

  permissions {
    actions     = local.apply_actions
    not_actions = []
  }

  assignable_scopes = [azurerm_resource_group.apply[0].id]
}

resource "azurerm_role_assignment" "apply" {
  scope              = azurerm_resource_group.apply[0].id
  role_definition_id = azurerm_role_definition.apply.role_definition_resource_id
  principal_id       = var.principal_ids["APPLY"]
}

# Azure Bicep (path 4, DEV only; owner decision E2): one more custom role, defined and assignable only at the pilot resource group,
# assigned to APPLY only. It lists exactly the operations the engine's az calls need (docs/act-pilot-bicep.md, "Identities and
# roles"), deny settings included. With Contributor gone (owner decision of 2026-10-28), it is APPLY's whole Bicep authority, so it
# also reads the stack deployment's operation statuses (UNVERIFIED P1, formerly covered by Contributor). DISCOVERY gets nothing new:
# it keeps Reader. No Microsoft.Authorization action, no role assignment right, nothing at subscription scope.
locals {
  bicep_stack_actions = [
    "Microsoft.Resources/deployments/read",
    "Microsoft.Resources/deployments/write",
    "Microsoft.Resources/deployments/operationstatuses/read",
    "Microsoft.Resources/deployments/validate/action",
    "Microsoft.Resources/deployments/whatIf/action",
    "Microsoft.Resources/deploymentStacks/read",
    "Microsoft.Resources/deploymentStacks/write",
    "Microsoft.Resources/deploymentStacks/delete",
    "Microsoft.Resources/deploymentStacks/validate/action",
    "Microsoft.Resources/deploymentStacks/manageDenySetting/action",
    "Microsoft.Network/virtualNetworks/read",
    "Microsoft.Network/virtualNetworks/write",
    "Microsoft.Network/virtualNetworks/delete",
  ]
}

resource "azurerm_role_definition" "bicep_stack_apply" {
  count       = var.bicep_stack_role ? 1 : 0
  name        = "alz-pilot-bicep-stack-apply-${azurerm_resource_group.apply[0].name}"
  scope       = azurerm_resource_group.apply[0].id
  description = "ACT pilot APPLY, Azure Bicep path (DEV only): ARM what-if, one deployment stack with deny settings, and its virtual network, in this resource group only."

  permissions {
    actions     = local.bicep_stack_actions
    not_actions = []
  }

  assignable_scopes = [azurerm_resource_group.apply[0].id]
}

resource "azurerm_role_assignment" "bicep_stack_apply" {
  count              = var.bicep_stack_role ? 1 : 0
  scope              = azurerm_resource_group.apply[0].id
  role_definition_id = azurerm_role_definition.bicep_stack_apply[0].role_definition_resource_id
  principal_id       = var.principal_ids["APPLY"]
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
