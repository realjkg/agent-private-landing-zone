# UNVERIFIED until run by an account owner: not validated against live provider schemas.
# Run once per account (DEV, QA, PROD), each in its own Terraform workspace, with credentials for that account.
terraform {
  required_version = ">= 1.10"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = ">= 5.0, < 7.0"
    }
  }
}

provider "aws" {
  region              = var.region
  allowed_account_ids = [var.account_id] # refuses to run against any other account
  default_tags {
    tags = var.tags
  }
}
