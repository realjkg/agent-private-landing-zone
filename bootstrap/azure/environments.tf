locals {
  principal_ids = { for key, sp in azuread_service_principal.identity : key => sp.object_id }
}

# DEV is always created. QA and PROD exist only in the three-stage chain; in DEV-only mode they have no instance, so
# no resource, role assignment or budget is created in (or aimed at) another subscription. Every instance uses the same
# module, so the state-account and role properties are identical in both modes.

module "environment_dev" {
  source = "./modules/environment"
  providers = {
    azurerm = azurerm.dev
  }
  settings       = var.environments.DEV
  principal_ids  = local.principal_ids
  location       = var.location
  retention_days = var.state_retention_days
  replication    = var.state_replication_type
  budget_amount  = var.budget_monthly_amount
  budget_start   = var.budget_start_date
  alert_emails   = var.alert_emails
  tags           = var.tags

  state_allowed_ip_ranges = var.state_allowed_ip_ranges
  # Azure Bicep is DEV only (owner decision E2): only the DEV module ever defines the stack role.
  bicep_stack_role = var.bicep_deployment_stacks
}

module "environment_qa" {
  count  = contains(var.enabled_environments, "QA") ? 1 : 0
  source = "./modules/environment"
  providers = {
    azurerm = azurerm.qa
  }
  settings       = var.environments.QA
  principal_ids  = local.principal_ids
  location       = var.location
  retention_days = var.state_retention_days
  replication    = var.state_replication_type
  budget_amount  = var.budget_monthly_amount
  budget_start   = var.budget_start_date
  alert_emails   = var.alert_emails
  tags           = var.tags

  state_allowed_ip_ranges = var.state_allowed_ip_ranges
}

module "environment_prod" {
  count  = contains(var.enabled_environments, "PROD") ? 1 : 0
  source = "./modules/environment"
  providers = {
    azurerm = azurerm.prod
  }
  settings       = var.environments.PROD
  principal_ids  = local.principal_ids
  location       = var.location
  retention_days = var.state_retention_days
  replication    = var.state_replication_type
  budget_amount  = var.budget_monthly_amount
  budget_start   = var.budget_start_date
  alert_emails   = var.alert_emails
  tags           = var.tags

  state_allowed_ip_ranges = var.state_allowed_ip_ranges
}

# The chain's QA and PROD modules gained a count; existing state keeps its addresses.
moved {
  from = module.environment_qa
  to   = module.environment_qa[0]
}

moved {
  from = module.environment_prod
  to   = module.environment_prod[0]
}
