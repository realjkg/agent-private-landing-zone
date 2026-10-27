variable "environment" {
  description = "Which contract environment this account is."
  type        = string
  validation {
    condition     = contains(["DEV", "QA", "PROD"], var.environment)
    error_message = "environment is DEV, QA or PROD."
  }
}

variable "account_id" {
  description = "The 12 digit account ID of this environment (the contract's accountId)."
  type        = string
  validation {
    condition     = can(regex("^[0-9]{12}$", var.account_id))
    error_message = "account_id is 12 digits."
  }
}

variable "region" {
  description = "The contract's region for this environment."
  type        = string
}

variable "engine" {
  description = "TERRAFORM creates four roles and the state bucket. CDK creates three roles and no bucket."
  type        = string
  validation {
    condition     = contains(["TERRAFORM", "CDK"], var.engine)
    error_message = "engine is TERRAFORM or CDK."
  }
}

variable "name_prefix" {
  description = "Role name prefix. Lowercase only: the pilot requires lowercase role ARNs."
  type        = string
  default     = "alz-pilot"
  validation {
    condition     = can(regex("^[a-z0-9-]{1,30}$", var.name_prefix))
    error_message = "name_prefix is lowercase letters, digits and hyphens."
  }
}

variable "oidc_issuer_host" {
  description = "Issuer host and path without https://. The GitHub Actions default, or your own issuer."
  type        = string
  default     = "token.actions.githubusercontent.com"
}

variable "oidc_audience" {
  description = "Audience the tokens carry."
  type        = string
  default     = "sts.amazonaws.com"
}

variable "existing_oidc_provider_arn" {
  description = "An account holds one OIDC provider per issuer URL. Set this to reuse the account's existing one instead of creating it."
  type        = string
  default     = null
}

variable "oidc_subjects" {
  description = "Subject claim each role trusts, by identity. For GitHub: repo:OWNER/REPO:environment:NAME. Every identity needs its own subject."
  type        = map(string)
  validation {
    condition     = length(distinct(values(var.oidc_subjects))) == length(values(var.oidc_subjects))
    error_message = "Each identity needs a different subject."
  }
}

variable "apply_managed_policy_arns" {
  description = "What APPLY may do to the pilot's resources. No default: least privilege is the owner's decision. A customer managed policy scoped to the pilot is better than an AWS managed one."
  type        = list(string)
  validation {
    condition     = length(var.apply_managed_policy_arns) > 0
    error_message = "Name at least one policy for APPLY."
  }
}

variable "apply_permissions_boundary_arn" {
  description = "Optional reviewed IAM permissions boundary for the APPLY role. Mandatory for ACT-DEV-1 acceptance; limits the effective scope even if other policies are attached."
  type        = string
  default     = null
  validation {
    condition     = var.apply_permissions_boundary_arn == null || can(regex("^arn:aws:iam::[0-9]{12}:policy/[A-Za-z0-9+=,.@_/-]+$", var.apply_permissions_boundary_arn))
    error_message = "Provide a customer-managed IAM policy ARN for APPLY, or null."
  }
}

variable "discovery_managed_policy_arns" {
  description = "Managed policies for DISCOVERY, both engines. The default, ViewOnlyAccess, lists and describes control-plane metadata; the inline act-pilot-discovery-scope policy adds exactly the reads the product makes (discovery-policy.json) and denies data-plane and secret reads whatever this list names. An override is an exception to the owner's control-plane-only decision: record its scope (which resource types and resources) and its purpose (which DISCOVERY read needs it) beside the value. Broad policies are refused; ReadOnlyAccess draws a plan warning."
  type        = list(string)
  default     = ["arn:aws:iam::aws:policy/job-function/ViewOnlyAccess"]
  validation {
    condition = alltrue([for arn in var.discovery_managed_policy_arns : !can(regex(
      "^arn:aws[a-z-]*:iam::aws:policy/(.*/)?(AdministratorAccess.*|PowerUserAccess|[A-Za-z0-9]*FullAccess[A-Za-z0-9-]*|SystemAdministrator|DatabaseAdministrator|NetworkAdministrator|DataScientist)$", arn
    ))])
    error_message = "DISCOVERY is read-only and limited to control-plane metadata: AdministratorAccess, PowerUserAccess, *FullAccess and the administrator job-function policies are refused. Name a scoped read policy and record its scope and purpose."
  }
}

variable "discovery_data_read_exceptions" {
  description = "Exceptions to the DISCOVERY deny on data-plane and secret reads. Each names actions the deny lists (discovery-policy.json), the exact resource ARNs they apply to, and the purpose. The action stays denied on every other resource. Empty by default: the owner's decision is control-plane metadata only."
  type = list(object({
    actions   = list(string)
    resources = list(string)
    purpose   = string
  }))
  default = []
  validation {
    condition = alltrue([for e in var.discovery_data_read_exceptions :
      length(e.actions) > 0 && length(e.resources) > 0 && length(trimspace(e.purpose)) >= 20 &&
      alltrue([for r in e.resources : can(regex("^arn:aws[a-z-]*:[a-z0-9-]+:", r)) && !can(regex("^arn:aws[a-z-]*:[a-z0-9-]+:[^:]*:[^:]*:\\*$", r))]) &&
      alltrue([for a in e.actions : can(regex("^[a-z0-9-]+:[A-Za-z0-9*]+$", a))])
    ])
    error_message = "Each DISCOVERY data-read exception needs at least one action, at least one specific resource ARN (not \"*\" or a whole-service wildcard), and a purpose of at least 20 characters."
  }
}

variable "state_bucket_name" {
  description = "Terraform engine: the state bucket (the first part of the contract's backend)."
  type        = string
  default     = null
  validation {
    condition     = var.engine != "TERRAFORM" || (var.state_bucket_name != null && can(regex("^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$", coalesce(var.state_bucket_name, "x"))))
    error_message = "The Terraform engine needs a valid state_bucket_name."
  }
}

variable "state_key" {
  description = "Terraform engine: the state object key. Defaults to pilot/<environment>.tfstate. The lock object is this key plus .tflock."
  type        = string
  default     = null
}

variable "state_admin_principal_arns" {
  description = "Terraform engine: role ARN patterns that may administer the bucket (the person who runs this bootstrap, and break-glass). Every other principal except STATE and STATE_WRITE is denied by the bucket policy."
  type        = list(string)
  default     = []
  validation {
    condition     = var.engine != "TERRAFORM" || length(var.state_admin_principal_arns) > 0
    error_message = "List the role that runs this bootstrap, or it locks itself out of the bucket."
  }
}

variable "noncurrent_version_retention_days" {
  description = "Days an overwritten or deleted state version is kept."
  type        = number
  default     = 90
}

variable "force_destroy_state" {
  description = "Leave false. Teardown sets it true once, so a versioned bucket with objects can be destroyed."
  type        = bool
  default     = false
}

variable "cdk_stack_name" {
  description = "CDK engine: the CloudFormation stack name (the contract's backend)."
  type        = string
  default     = null
  validation {
    condition     = var.engine != "CDK" || var.cdk_stack_name != null
    error_message = "The CDK engine needs cdk_stack_name."
  }
}

variable "budget_monthly_usd" {
  description = "Monthly cost budget in USD for this account. Null creates no budget."
  type        = number
  default     = null
}

variable "alert_emails" {
  description = "Budget alert recipients. Required when a budget is set."
  type        = list(string)
  default     = []
}

variable "tags" {
  type    = map(string)
  default = { purpose = "act-pilot-bootstrap" }
}
