# IDs and names only. Nothing here is a secret. bootstrap/config.azure.template.json says where each value goes.
output "tenant_id" {
  value = var.tenant_id
}

output "identity_client_ids" {
  description = "ALZ_<IDENTITY>_ARM_CLIENT_ID, the same in every environment."
  value       = { for key, app in azuread_application.identity : key => app.client_id }
}

locals {
  # The module instance of each enabled environment (one() is null for a QA or PROD module with no instance).
  environment_modules = {
    DEV  = module.environment_dev
    QA   = one(module.environment_qa)
    PROD = one(module.environment_prod)
  }
}

output "enabled_environments" {
  description = "The environments this bootstrap created: the contract's enabledEnvironments is [\"DEV\"] exactly when this is [\"DEV\"]."
  value       = var.enabled_environments
}

output "contract_targets" {
  description = "The targets block of config/act-pilot-contract.json (provider AZURE, engine TERRAFORM), one entry per enabled environment."
  value = {
    for env in var.enabled_environments : env => {
      tenantId       = var.tenant_id
      subscriptionId = var.environments[env].subscription_id
      backend        = "${var.environments[env].state_storage_account_name}/${local.environment_modules[env].container_name}/${lower(env)}.tfstate"
      workspace      = "default"
    }
  }
}

output "apply_scopes" {
  description = "Where APPLY holds Contributor and DISCOVERY holds Reader, per enabled environment."
  value       = { for env in var.enabled_environments : env => local.environment_modules[env].apply_scope }
}
