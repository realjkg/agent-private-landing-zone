provider "azuread" {
  tenant_id = var.tenant_id
}

# One provider alias per environment: the three-stage contract has DEV, QA and PROD, each in its own subscription.
# In DEV-only mode (enabled_environments = ["DEV"]) the QA and PROD modules have no instance, so nothing uses those two
# aliases. They are pointed at the DEV subscription only because a provider block needs one; no other subscription is named.
provider "azurerm" {
  alias           = "dev"
  tenant_id       = var.tenant_id
  subscription_id = var.environments.DEV.subscription_id
  features {}
}

provider "azurerm" {
  alias           = "qa"
  tenant_id       = var.tenant_id
  subscription_id = var.environments.QA == null ? var.environments.DEV.subscription_id : var.environments.QA.subscription_id
  features {}
}

provider "azurerm" {
  alias           = "prod"
  tenant_id       = var.tenant_id
  subscription_id = var.environments.PROD == null ? var.environments.DEV.subscription_id : var.environments.PROD.subscription_id
  features {}
}
