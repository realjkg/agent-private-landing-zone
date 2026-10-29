variable "environment" {
  description = "Which contract environment this project is. DEV only: both GCP paths are admitted for DEV only (#339, owner decision 6481421924)."
  type        = string
  validation {
    condition     = var.environment == "DEV"
    error_message = "environment is DEV: GCP Terraform and GCP API-native are admitted for DEV only."
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

variable "oidc_required_claims" {
  description = "Optional exact claims every token must also carry, ANDed into the provider's attribute condition. A subject is name-based; for GitHub, pin the numeric repository_id (and repository_owner_id) so a deleted-and-recreated or transferred repository with the same name cannot mint accepted tokens. Empty adds nothing."
  type        = map(string)
  default     = {}
  validation {
    condition     = alltrue([for k, v in var.oidc_required_claims : can(regex("^[a-z][a-z0-9_]{0,63}$", k)) && can(regex("^[A-Za-z0-9:._/@-]{1,127}$", v))])
    error_message = "A required claim is a lowercase claim name and a value of letters, digits and : . _ / @ - only (it is written into the attribute condition)."
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
  description = "Must stay empty. Owner decision D12 (#39 6483366237): every grant is a custom role listing exactly the reviewed permissions, and no predefined role is added to any pilot identity: no Viewer, Editor or Owner, no Pub/Sub role (publisher and subscriber publish and consume messages; pubsub.viewer is broader than topic metadata), no Cloud Asset, logging or monitoring viewer, no Token Creator. A role can only come back through a reviewed change to this package and a new owner decision."
  type        = list(string)
  default     = []
  validation {
    # D12: the allowlist this package once had (Pub/Sub publisher, subscriber and viewer, logging and monitoring viewer) is gone.
    condition     = length(var.apply_additional_roles) == 0
    error_message = "apply_additional_roles must be empty: owner decision D12 adds no predefined role to a pilot identity. Every grant is a custom role with exactly the reviewed permissions."
  }
  validation {
    condition     = length(distinct(var.apply_additional_roles)) == length(var.apply_additional_roles)
    error_message = "Name each additional role once."
  }
  validation {
    condition     = var.engine != "GCP_API" || length(var.apply_additional_roles) == 0
    error_message = "The GCP_API engine's APPLY gets the minimal workload's permissions only."
  }
}

variable "topic_prefix" {
  description = "GCP_API only (decision D4): the topic namespace the contract target's topicPrefix authorizes, like alz-act-dev1-. Each run's topic is this prefix and a suffix drawn at seal."
  type        = string
  default     = null
  validation {
    condition     = var.engine != "GCP_API" || (var.topic_prefix != null && can(regex("^alz-[a-z0-9-]{1,40}-$", coalesce(var.topic_prefix, "x"))))
    error_message = "The GCP_API engine needs a topic_prefix like alz-act-dev1-: alz-, 1 to 40 lowercase letters, digits or hyphens, and a final hyphen."
  }
  validation {
    condition     = var.engine != "TERRAFORM" || var.topic_prefix == null
    error_message = "The TERRAFORM engine names its topic in the canary project; leave topic_prefix unset."
  }
}

variable "parent" {
  description = "Optional organizations/<n> or folders/<n> the contract target names (decision D9). Owner-declared, not observed: no pilot identity reads it, and no evidence claims verified placement."
  type        = string
  default     = null
  validation {
    condition     = var.parent == null || can(regex("^(organizations|folders)/[1-9][0-9]{0,24}$", coalesce(var.parent, "x")))
    error_message = "parent is organizations/<number> or folders/<number>."
  }
}

variable "state_bucket_name" {
  description = "TERRAFORM: the state bucket (the first part of the contract's backend). Dotless names only, as the S1 provider spec (src/apply/providers/gcp.ts) accepts."
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
