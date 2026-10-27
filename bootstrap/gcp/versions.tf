# UNVERIFIED until run by a project owner: validated offline only (docs/act-pilot-bootstrap-gcp.md).
# Run once per project and engine: DEV, QA and PROD for TERRAFORM (path 5); DEV only for GCP_API (path 6).
# Use a separate Terraform workspace or directory copy for each run, with credentials for that project.
terraform {
  required_version = ">= 1.10"

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = ">= 8.0, < 9.0"
    }
  }
}

provider "google" {
  project        = var.project_id
  region         = var.region
  default_labels = var.labels
}
