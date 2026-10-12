# IDs and names only. Nothing here is a secret. bootstrap/config.azure.template.json says where each value goes.
output "tenant_id" {
  value = var.tenant_id
}

output "identity_client_ids" {
  description = "ALZ_<IDENTITY>_ARM_CLIENT_ID, the same in every environment."
  value       = { for key, app in azuread_application.identity : key => app.client_id }
}

output "contract_targets" {
  description = "The targets block of config/act-pilot-contract.json (provider AZURE, engine TERRAFORM)."
  value = {
    DEV = {
      tenantId       = var.tenant_id
      subscriptionId = var.environments.DEV.subscription_id
      backend        = "${var.environments.DEV.state_storage_account_name}/${module.environment_dev.container_name}/dev.tfstate"
      workspace      = "default"
    }
    QA = {
      tenantId       = var.tenant_id
      subscriptionId = var.environments.QA.subscription_id
      backend        = "${var.environments.QA.state_storage_account_name}/${module.environment_qa.container_name}/qa.tfstate"
      workspace      = "default"
    }
    PROD = {
      tenantId       = var.tenant_id
      subscriptionId = var.environments.PROD.subscription_id
      backend        = "${var.environments.PROD.state_storage_account_name}/${module.environment_prod.container_name}/prod.tfstate"
      workspace      = "default"
    }
  }
}

output "apply_scopes" {
  description = "Where APPLY holds Contributor and DISCOVERY holds Reader, per environment."
  value = {
    DEV  = module.environment_dev.apply_scope
    QA   = module.environment_qa.apply_scope
    PROD = module.environment_prod.apply_scope
  }
}
