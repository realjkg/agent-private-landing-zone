locals {
  principal_ids = { for key, sp in azuread_service_principal.identity : key => sp.object_id }
}

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
}

module "environment_qa" {
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
}

module "environment_prod" {
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
}
