variable "tenant_id" {
  description = "Entra tenant ID shared by the pilot subscriptions."
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

variable "enabled_environments" {
  description = "Which pilot environments this bootstrap creates: [\"DEV\", \"QA\", \"PROD\"] (the default, the three-stage chain) or exactly [\"DEV\"] (the DEV-only pilot, the contract's enabledEnvironments). Nothing else is accepted."
  type        = list(string)
  default     = ["DEV", "QA", "PROD"]

  validation {
    condition = length(var.enabled_environments) == length(distinct(var.enabled_environments)) && (
      toset(var.enabled_environments) == toset(["DEV"]) || toset(var.enabled_environments) == toset(["DEV", "QA", "PROD"])
    )
    error_message = "enabled_environments is either [\"DEV\", \"QA\", \"PROD\"] or exactly [\"DEV\"] (the DEV-only pilot). QA or PROD without the others, and any other name, are refused."
  }
}

variable "environments" {
  description = "One entry per enabled environment. In the three-stage chain the subscriptions and state storage accounts must differ (the contract requires it). In DEV-only mode give DEV alone: a QA or PROD entry is refused, not ignored."
  type = object({
    DEV  = object({ subscription_id = string, state_resource_group_name = string, state_storage_account_name = string, state_container_name = optional(string, "tfstate"), apply_resource_group_name = optional(string) })
    QA   = optional(object({ subscription_id = string, state_resource_group_name = string, state_storage_account_name = string, state_container_name = optional(string, "tfstate"), apply_resource_group_name = optional(string) }))
    PROD = optional(object({ subscription_id = string, state_resource_group_name = string, state_storage_account_name = string, state_container_name = optional(string, "tfstate"), apply_resource_group_name = optional(string) }))
  })

  validation {
    condition     = toset([for name, e in var.environments : name if e != null]) == toset(var.enabled_environments)
    error_message = "environments must have exactly one entry per enabled environment: DEV, QA and PROD for the chain, DEV alone in DEV-only mode."
  }

  validation {
    condition     = length(distinct([for e in values(var.environments) : lower(e.subscription_id) if e != null])) == length([for e in values(var.environments) : e if e != null])
    error_message = "DEV, QA and PROD must use three different subscriptions."
  }

  validation {
    condition     = length(distinct([for e in values(var.environments) : e.state_storage_account_name if e != null])) == length([for e in values(var.environments) : e if e != null])
    error_message = "DEV, QA and PROD must use three different state storage accounts."
  }

  # DEV-only mode keeps APPLY's Contributor and DISCOVERY's Reader on the pilot resource group: without it they would fall back
  # to the whole subscription. The chain keeps its existing behavior (a group is optional there), so this rule is DEV-only.
  validation {
    condition     = toset(var.enabled_environments) != toset(["DEV"]) || try(trimspace(var.environments.DEV.apply_resource_group_name), "") != ""
    error_message = "DEV-only mode needs environments.DEV.apply_resource_group_name (a non-empty name): APPLY and DISCOVERY are scoped to that pilot resource group, never to the whole subscription."
  }

  validation {
    condition     = alltrue([for e in values(var.environments) : can(regex("^[a-z0-9]{3,24}$", e.state_storage_account_name)) if e != null])
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
      for e in var.enabled_environments :
      alltrue([for i in ["DISCOVERY", "STATE", "STATE_WRITE", "APPLY"] : try(var.oidc_subjects[i][e], "") != ""]) &&
      length(distinct([for i in ["DISCOVERY", "STATE", "STATE_WRITE", "APPLY"] : try(var.oidc_subjects[i][e], "")])) == 4
    ])
    error_message = "oidc_subjects needs DISCOVERY, STATE, STATE_WRITE and APPLY for every enabled environment, with four different subjects in each environment."
  }

  validation {
    condition     = alltrue([for i, by_env in var.oidc_subjects : contains(["DISCOVERY", "STATE", "STATE_WRITE", "APPLY"], i) && alltrue([for e in keys(by_env) : contains(var.enabled_environments, e)])])
    error_message = "oidc_subjects names only DISCOVERY, STATE, STATE_WRITE and APPLY, and only enabled environments. A subject for an environment that is not enabled (QA or PROD in DEV-only mode) is refused, not ignored."
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
