terraform {
  required_version = ">= 1.10.0, < 2.0.0"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = ">= 5.0.0, < 7.0.0"
    }
  }
  backend "s3" {}
}

variable "region" {
  type = string
  validation {
    condition     = var.region == "us-east-2"
    error_message = "ACT-DEV-1 is qualified only in us-east-2."
  }
}

variable "canary_name" {
  type = string
  validation {
    condition     = can(regex("^/alz/act-dev-1/[a-z0-9][a-z0-9-]{2,48}$", var.canary_name))
    error_message = "The canary log group must stay under /alz/act-dev-1/."
  }
}

variable "owner" {
  type = string
  validation {
    condition     = can(regex("^[A-Za-z0-9._@+-]{1,80}$", var.owner))
    error_message = "Provide an approved owner tag."
  }
}

provider "aws" {
  region = var.region
}

resource "aws_cloudwatch_log_group" "act_dev1" {
  name              = var.canary_name
  retention_in_days = 30

  tags = {
    environment = "DEV"
    managed-by  = "sovereign-alz"
    purpose     = "act-dev-1"
    owner       = var.owner
  }
}
