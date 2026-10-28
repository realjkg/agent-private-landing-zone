terraform {
  required_version = ">= 1.10.0, < 2.0.0"
  required_providers {
    azurerm = {
      source  = "hashicorp/azurerm"
      version = "= 4.81.0"
    }
  }
  backend "azurerm" {}
}

variable "resource_group_name" {
  type = string
  validation {
    condition     = can(regex("^[A-Za-z0-9][A-Za-z0-9._()-]{0,88}[A-Za-z0-9_()-]$", var.resource_group_name))
    error_message = "Name the existing pilot resource group that the bootstrap created."
  }
}

variable "location" {
  type = string
  validation {
    condition     = can(regex("^[a-z][a-z0-9]{2,30}$", var.location))
    error_message = "Use the pilot resource group's Azure region, for example eastus2."
  }
}

variable "canary_name" {
  type = string
  validation {
    condition     = can(regex("^vnet-alz-act-dev-1-[a-z0-9][a-z0-9-]{2,48}$", var.canary_name))
    error_message = "The canary virtual network name must start with vnet-alz-act-dev-1-."
  }
}

variable "owner" {
  type = string
  validation {
    condition     = can(regex("^[A-Za-z0-9._@+-]{1,80}$", var.owner))
    error_message = "Provide an approved owner tag."
  }
}

variable "unit_tags" {
  type = map(string)
  validation {
    condition     = join(",", sort(keys(var.unit_tags))) == "alz-build,alz-managed-by,alz-unit"
    error_message = "Provide exactly the three unit tags that ./alz apply prepare prints: alz-build, alz-managed-by and alz-unit."
  }
}

provider "azurerm" {
  features {}
  resource_provider_registrations = "none"
}

resource "azurerm_virtual_network" "act_dev1" {
  name                = var.canary_name
  resource_group_name = var.resource_group_name
  location            = var.location
  address_space       = ["10.250.0.0/24"]

  tags = merge({
    environment = "DEV"
    managed-by  = "sovereign-alz"
    purpose     = "act-dev-1"
    owner       = var.owner
  }, var.unit_tags)
}
