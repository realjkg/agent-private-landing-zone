terraform {
  required_providers {
    aws = { source = "hashicorp/aws", version = "6.68.0" }
  }
}
provider "aws" {
  region                      = "us-east-1"
  skip_credentials_validation = true
  skip_requesting_account_id  = true
  skip_metadata_api_check     = true
}

resource "aws_secretsmanager_secret" "s" { name = "x" }
ephemeral "aws_secretsmanager_secret_version" "e" { secret_id = aws_secretsmanager_secret.s.id }
module "child" { source = "./child" }
