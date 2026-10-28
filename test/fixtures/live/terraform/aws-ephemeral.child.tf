terraform {
  required_providers {
    aws = { source = "hashicorp/aws" }
  }
}
resource "aws_ssm_parameter" "p" {
  name  = "y"
  type  = "String"
  value = "v"
}
ephemeral "aws_ssm_parameter" "e" { arn = aws_ssm_parameter.p.arn }
