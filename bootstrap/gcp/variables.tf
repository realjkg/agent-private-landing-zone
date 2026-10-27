variable "environment" {
  description = "Which contract environment this project is."
  type        = string
  validation {
    condition     = contains(["DEV", "QA", "PROD"], var.environment)
    error_message = "environment is DEV, QA or PROD."
  }
}

variable "engine" {
  description = "TERRAFORM (path 5): DISCOVERY, STATE, STATE_WRITE and APPLY, and the state bucket. GCP_API (path 6): DISCOVERY and APPLY only, no state, DEV only. Both use the same identity variables (ALZ_<IDENTITY>_GOOGLE_*)."
  type        = string
  validation {
    condition     = contains(["TERRAFORM", "GCP_API"], var.engine)
    error_message = "engine is TERRAFORM or GCP_API."
  }
  validation {
    condition     = var.engine != "GCP_API" || var.environment == "DEV"
    error_message = "The GCP_API engine is DEV only."
  }
}

variable "project_id" {
  description = "This environment's project (the contract's projectId). One project per environment."
  type        = string
  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{4,28}[a-z0-9]$", var.project_id))
    error_message = "project_id is 6 to 30 lowercase letters, digits and hyphens, starting with a letter."
  }
}

variable "region" {
  description = "The contract's region for this environment, for example europe-west4. The state bucket is created there."
  type        = string
  validation {
    condition     = can(regex("^[a-z]+-[a-z]+[0-9]{1,2}$", var.region))
    error_message = "region looks like europe-west4."
  }
}

variable "name_prefix" {
  description = "Prefix of the service account, pool and role names. At most 11 characters, so every service account id stays within 30."
  type        = string
  default     = "alz-pilot"
  validation {
    condition     = can(regex("^[a-z]([a-z0-9-]{0,9}[a-z0-9])?$", var.name_prefix))
    error_message = "name_prefix is 1 to 11 lowercase letters, digits and hyphens, starting with a letter."
  }
}

variable "oidc_issuer_uri" {
  description = "The OIDC issuer the runner's tokens come from. The GitHub Actions default, or your own issuer."
  type        = string
  default     = "https://token.actions.githubusercontent.com"
  validation {
    condition     = can(regex("^https://[A-Za-z0-9.-]+(/[A-Za-z0-9._~-]+)*$", var.oidc_issuer_uri))
    error_message = "oidc_issuer_uri is an https URL with no query or fragment."
  }
}

variable "oidc_allowed_audiences" {
  description = "Audiences the tokens may carry. Empty means Google's default: the pool provider's full resource name."
  type        = list(string)
  default     = []
}

variable "oidc_subjects" {
  description = "The subject claim each identity trusts, one per identity of the engine. For GitHub: repo:OWNER/REPO:environment:NAME. Every identity needs its own subject."
  type        = map(string)
  validation {
    condition     = toset(keys(var.oidc_subjects)) == toset(var.engine == "GCP_API" ? ["DISCOVERY", "APPLY"] : ["DISCOVERY", "STATE", "STATE_WRITE", "APPLY"])
    error_message = "Name one subject for exactly the engine's identities: TERRAFORM has DISCOVERY, STATE, STATE_WRITE and APPLY; GCP_API has DISCOVERY and APPLY."
  }
  validation {
    condition     = length(distinct(values(var.oidc_subjects))) == length(values(var.oidc_subjects))
    error_message = "Each identity needs a different subject."
  }
  validation {
    # The subjects are written into the provider's attribute condition, so no character may end a CEL string. No wildcard either.
    condition     = alltrue([for s in values(var.oidc_subjects) : can(regex("^[A-Za-z0-9:._/@-]{1,127}$", s))])
    error_message = "A subject is 1 to 127 letters, digits and : . _ / @ - only."
  }
}

variable "token_files" {
  description = "Absolute path of each identity's OIDC token file on the runner. Only the credential configurations this package outputs name them; nothing reads them here."
  type        = map(string)
  validation {
    condition     = toset(keys(var.token_files)) == toset(keys(var.oidc_subjects))
    error_message = "Name one token file for each identity in oidc_subjects."
  }
  validation {
    condition     = alltrue([for p in values(var.token_files) : can(regex("^/[A-Za-z0-9._/-]{1,512}$", p))]) && length(distinct(values(var.token_files))) == length(values(var.token_files))
    error_message = "Each token file is a different absolute path of plain characters."
  }
}

variable "apply_additional_roles" {
  description = "Predefined roles APPLY needs beyond the minimal workload's Pub/Sub permissions, granted on this project. Least privilege is the owner's decision. Owner, editor and every role that administers IAM, the project, org policy or billing is refused."
  type        = list(string)
  default     = []
  validation {
    condition     = alltrue([for r in var.apply_additional_roles : can(regex("^roles/[A-Za-z0-9.]+$", r)) && !contains(["roles/owner", "roles/editor"], r) && !can(regex("^roles/(iam|resourcemanager|orgpolicy|billing|accesscontextmanager)\\.", r))])
    error_message = "apply_additional_roles may not include roles/owner, roles/editor, or an iam, resourcemanager, orgpolicy, billing or accesscontextmanager role."
  }
  validation {
    condition     = var.engine != "GCP_API" || length(var.apply_additional_roles) == 0
    error_message = "The GCP_API engine's APPLY gets the minimal workload's permissions only."
  }
}

variable "state_bucket_name" {
  description = "TERRAFORM: the state bucket (the first part of the contract's backend). Dotless names only, as the provider spec accepts."
  type        = string
  default     = null
  validation {
    condition     = var.engine != "TERRAFORM" || (var.state_bucket_name != null && can(regex("^[a-z0-9][a-z0-9_-]{1,61}[a-z0-9]$", coalesce(var.state_bucket_name, "x"))) && !startswith(coalesce(var.state_bucket_name, "x"), "goog") && !strcontains(coalesce(var.state_bucket_name, "x"), "google"))
    error_message = "The TERRAFORM engine needs a valid, dotless state_bucket_name, with no goog prefix and no google in it."
  }
  validation {
    condition     = var.engine != "GCP_API" || var.state_bucket_name == null
    error_message = "The GCP_API engine keeps no state: leave state_bucket_name unset."
  }
}

variable "state_prefix" {
  description = "TERRAFORM: the state prefix (the rest of the contract's backend). Defaults to pilot/<environment>. The state object is <prefix>/default.tfstate and the lock object <prefix>/default.tflock."
  type        = string
  default     = null
  validation {
    condition     = var.state_prefix == null || can(regex("^[A-Za-z0-9._-]+(/[A-Za-z0-9._-]+)*$", coalesce(var.state_prefix, "x"))) && !contains(split("/", coalesce(var.state_prefix, "x")), "..") && !contains(split("/", coalesce(var.state_prefix, "x")), ".")
    error_message = "state_prefix is segments of letters, digits, dot, underscore and hyphen, with no . or .. segment."
  }
}

variable "noncurrent_versions_kept" {
  description = "TERRAFORM: a noncurrent object version is deleted only once at least this many newer versions exist..."
  type        = number
  default     = 10
}

variable "noncurrent_version_retention_days" {
  description = "...and it has been noncurrent for at least this many days."
  type        = number
  default     = 90
}

variable "lock_version_retention_days" {
  description = "OWNER ITEM P3 (docs/act-pilot-gcp-terraform-g0.md), off until the owner decides: days after which a noncurrent *.tflock version is deleted. Never matches *.tfstate. Null adds no rule."
  type        = number
  default     = null
}

variable "enable_storage_data_access_logs" {
  description = "OWNER ITEM P5, off until the owner decides: Cloud Storage Data Access audit logs (DATA_READ, DATA_WRITE) on this project, so state reads and writes are attributable. They are billed as log volume."
  type        = bool
  default     = false
}

variable "enforce_no_service_account_keys" {
  description = "Enforce the org policy iam.disableServiceAccountKeyCreation on this project (owner decision 3). Leave true; set false only in the second of two runs in one project, which would otherwise manage the same policy twice."
  type        = bool
  default     = true
}

variable "deny_pilot_guardrails" {
  description = "An IAM deny policy on this project: APPLY and DISCOVERY can never touch Cloud Storage objects (so neither can become a state fallback), and APPLY can never edit the pilot's service accounts, pool, roles or the project's IAM policy. Set false only if a reviewed blueprint must write objects."
  type        = bool
  default     = true
}

variable "force_destroy_state" {
  description = "Leave false. Teardown sets it true once, so a versioned bucket with objects can be destroyed."
  type        = bool
  default     = false
}

variable "billing_account_id" {
  description = "The billing account for the budget, like 000000-000000-000000. Required when a budget is set."
  type        = string
  default     = null
}

variable "budget_monthly_usd" {
  description = "Monthly cost budget in USD for this project. Null creates no budget."
  type        = number
  default     = null
}

variable "labels" {
  description = "Labels on every resource this package creates."
  type        = map(string)
  default     = { purpose = "act-pilot-bootstrap" }
}
