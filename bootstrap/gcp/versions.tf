# UNVERIFIED until run by a project owner: validated offline only (docs/act-pilot-bootstrap-gcp.md).
# Run once per engine in the DEV project only: TERRAFORM (path 5) and GCP_API (path 6) are both admitted for DEV only (#339 and
# owner decision 6481421924); there is no QA or PROD run. Use a separate Terraform workspace or directory copy for each run, with
# the owner's own credentials for that project. Before running it, verify the checklist in docs/act-pilot-bootstrap-gcp.md
# ("Before bootstrap: the D12 checklist"); nothing here was ever applied by an agent.
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
