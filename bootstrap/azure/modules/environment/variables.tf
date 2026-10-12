variable "settings" {
  type = object({
    subscription_id            = string
    state_resource_group_name  = string
    state_storage_account_name = string
    state_container_name       = string
    apply_resource_group_name  = optional(string)
  })
}

variable "principal_ids" {
  description = "Service principal object IDs by identity (DISCOVERY, STATE, STATE_WRITE, APPLY)."
  type        = map(string)
}

variable "location" {
  type = string
}

variable "retention_days" {
  type = number
}

variable "replication" {
  type = string
}

variable "budget_amount" {
  type    = number
  default = null
}

variable "budget_start" {
  type    = string
  default = null
}

variable "alert_emails" {
  type    = list(string)
  default = []
}

variable "tags" {
  type = map(string)
}

variable "state_allowed_ip_ranges" {
  description = "Public IPs or CIDRs of the pilot runner's egress; the state account denies everything else."
  type        = list(string)
}
