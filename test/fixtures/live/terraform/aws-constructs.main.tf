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
action "aws_lambda_invoke" "a" {
  config {
    function_name = "f"
    payload       = "{}"
  }
}
resource "terraform_data" "t" {
  input = "x"
  provisioner "local-exec" { command = "echo hi" }
  lifecycle {
    action_trigger {
      events  = [after_create]
      actions = [action.aws_lambda_invoke.a]
    }
  }
}
module "child" { source = "./child" }
