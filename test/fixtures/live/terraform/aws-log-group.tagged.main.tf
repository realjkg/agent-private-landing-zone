# ALZ REVIEW CANDIDATE — synthetic brownfield evidence; NOT an applied plan.
# Customer-managed Control Tower/Organizations assets are not declared here.
terraform {
  required_version = ">= 1.6.0"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = ">= 5.0, < 7.0"
    }
  }
}

variable "aws_region" {
  type = string
}

provider "aws" {
  region = var.aws_region
}

resource "aws_cloudwatch_log_group" "alz_audit" {
  name              = "/alz/preview/brownfield-audit"
  retention_in_days = 30

  tags = {
    ManagedBy        = "ALZ-preview-candidate"
    "alz-managed-by" = "alz"
    "alz-unit"       = "alzu-b2bc1082dc01f9c1e877"
    "alz-build"      = "build-00000000-0000-4000-8000-000000000001"
    "alz-expires"    = "2026-12-31"
  }
}
