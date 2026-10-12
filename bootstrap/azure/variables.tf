variable "tenant_id" {
  description = "Entra tenant ID shared by the three subscriptions."
  type        = string
}

variable "location" {
  description = "Azure region for the state resources and the pilot resource group."
  type        = string
}

variable "name_prefix" {
  description = "Prefix for the app registration display names."
  type        = string
  default     = "alz-pilot"
}

variable "environments" {
  description = "The three pilot environments. Subscriptions and state storage accounts must differ (the contract requires it)."
  type = object({
    DEV  = object({ subscription_id = string, state_resource_group_name = string, state_storage_account_name = string, state_container_name = optional(string, "tfstate"), apply_resource_group_name = optional(string) })
    QA   = object({ subscription_id = string, state_resource_group_name = string, state_storage_account_name = string, state_container_name = optional(string, "tfstate"), apply_resource_group_name = optional(string) })
    PROD = object({ subscription_id = string, state_resource_group_name = string, state_storage_account_name = string, state_container_name = optional(string, "tfstate"), apply_resource_group_name = optional(string) })
  })

  validation {
    condition     = length(distinct([for e in values(var.environments) : lower(e.subscription_id)])) == 3
    error_message = "DEV, QA and PROD must use three different subscriptions."
  }

  validation {
    condition     = length(distinct([for e in values(var.environments) : e.state_storage_account_name])) == 3
    error_message = "DEV, QA and PROD must use three different state storage accounts."
  }

  validation {
    condition     = alltrue([for e in values(var.environments) : can(regex("^[a-z0-9]{3,24}$", e.state_storage_account_name))])
    error_message = "A storage account name is 3 to 24 lowercase letters and digits."
  }
}

variable "oidc_issuer" {
  description = "Issuer URL of the token source. The GitHub Actions default, or your own issuer for a self-hosted runner (it must be publicly reachable so Entra can fetch its discovery document)."
  type        = string
  default     = "https://token.actions.githubusercontent.com"
}

variable "oidc_audience" {
  description = "Audience the tokens carry. This is the Entra default; change it only if your issuer cannot mint it."
  type        = string
  default     = "api://AzureADTokenExchange"
}

variable "oidc_subjects" {
  description = "Subject claim each federated credential accepts, by identity and then environment. For GitHub: repo:OWNER/REPO:environment:NAME. Every identity needs its own subject in each environment so one token cannot serve two identities."
  type        = map(map(string))

  validation {
    condition = alltrue([
      for e in ["DEV", "QA", "PROD"] :
      alltrue([for i in ["DISCOVERY", "STATE", "STATE_WRITE", "APPLY"] : try(var.oidc_subjects[i][e], "") != ""]) &&
      length(distinct([for i in ["DISCOVERY", "STATE", "STATE_WRITE", "APPLY"] : try(var.oidc_subjects[i][e], "")])) == 4
    ])
    error_message = "oidc_subjects needs DISCOVERY, STATE, STATE_WRITE and APPLY for DEV, QA and PROD, with four different subjects in each environment."
  }
}

variable "state_retention_days" {
  description = "Days that soft-deleted blobs and containers are kept."
  type        = number
  default     = 30
}

variable "state_replication_type" {
  description = "Replication type of the state storage accounts."
  type        = string
  default     = "GRS"
}

variable "budget_monthly_amount" {
  description = "Monthly subscription budget in the billing currency. Null creates no budget."
  type        = number
  default     = null
}

variable "budget_start_date" {
  description = "First day of a month, RFC 3339 (for example 2026-11-01T00:00:00Z). Required when a budget is set."
  type        = string
  default     = null
}

variable "alert_emails" {
  description = "Addresses that receive budget alerts. Required when a budget is set."
  type        = list(string)
  default     = []
}

variable "tags" {
  description = "Tags for every resource that takes them."
  type        = map(string)
  default     = { purpose = "act-pilot-bootstrap" }
}

variable "state_allowed_ip_ranges" {
  description = "Public IPs or CIDRs the pilot runner reaches the state storage accounts from. The accounts deny every other network, so an empty list would lock the runner out."
  type        = list(string)

  validation {
    condition     = length(var.state_allowed_ip_ranges) > 0
    error_message = "List at least one runner egress IP or CIDR; the state accounts deny all other networks."
  }
}
