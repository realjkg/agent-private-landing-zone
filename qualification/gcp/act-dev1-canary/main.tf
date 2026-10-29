terraform {
  required_version = ">= 1.10.0, < 2.0.0"
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "= 8.9.0"
    }
  }
  backend "gcs" {}
}

variable "region" {
  type = string
  validation {
    condition     = can(regex("^[a-z]+-[a-z]+[0-9]{1,2}$", var.region))
    error_message = "Use the contract's DEV region, for example europe-west4. The seal refuses any other region."
  }
}

variable "canary_name" {
  type = string
  validation {
    condition     = can(regex("^alz-act-dev-1-[a-z0-9][a-z0-9-]{1,40}[a-z0-9]$", var.canary_name))
    error_message = "The canary topic name must start with alz-act-dev-1-."
  }
}

variable "owner" {
  type = string
  validation {
    condition     = can(regex("^[a-z0-9][a-z0-9_-]{0,62}$", var.owner))
    error_message = "Provide an approved owner label: lowercase letters, digits, underscores and hyphens."
  }
}

variable "unit_labels" {
  type = map(string)
  validation {
    condition     = join(",", sort(keys(var.unit_labels))) == "alz-build,alz-managed-by,alz-unit"
    error_message = "Provide exactly the three unit labels that ./alz apply prepare prints: alz-build, alz-managed-by and alz-unit."
  }
}

provider "google" {
  # The contract's DEV projectId, written here as a constant: the product refuses a project that is an expression
  # or another project's id (review N1 of #339). Replace the placeholder before the first seal.
  project        = "examplefake-dev"
  default_labels = var.unit_labels
}

resource "google_pubsub_topic" "act_dev1" {
  name = var.canary_name

  labels = {
    environment = "dev"
    managed-by  = "sovereign-alz"
    purpose     = "act-dev-1"
    owner       = var.owner
  }

  message_storage_policy {
    allowed_persistence_regions = [var.region]
  }
}
