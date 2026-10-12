provider "azuread" {
  tenant_id = var.tenant_id
}

# One provider alias per environment: the contract has exactly DEV, QA and PROD, each in its own subscription.
provider "azurerm" {
  alias           = "dev"
  tenant_id       = var.tenant_id
  subscription_id = var.environments.DEV.subscription_id
  features {}
}

provider "azurerm" {
  alias           = "qa"
  tenant_id       = var.tenant_id
  subscription_id = var.environments.QA.subscription_id
  features {}
}

provider "azurerm" {
  alias           = "prod"
  tenant_id       = var.tenant_id
  subscription_id = var.environments.PROD.subscription_id
  features {}
}
