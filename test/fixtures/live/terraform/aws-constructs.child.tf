terraform {
  required_providers {
    aws = { source = "hashicorp/aws" }
  }
}
resource "aws_secretsmanager_secret" "s" { name = "y" }
ephemeral "aws_secretsmanager_secret_version" "e" { secret_id = aws_secretsmanager_secret.s.id }
action "aws_lambda_invoke" "a" {
  config {
    function_name = "g"
    payload       = "{}"
  }
}
resource "terraform_data" "u" {
  provisioner "remote-exec" {
    inline = ["true"]
    connection {
      host = "127.0.0.1"
      type = "ssh"
    }
  }
  lifecycle {
    action_trigger {
      events  = [after_create]
      actions = [action.aws_lambda_invoke.a]
    }
  }
}
