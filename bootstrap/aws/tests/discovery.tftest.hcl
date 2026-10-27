# Offline: a mocked AWS provider, no credentials, no network. Run from bootstrap/aws with `terraform init -backend=false && terraform test`.
# It checks the DISCOVERY scope policy as Terraform renders it; it does not show that AWS enforces it (the live DEV qualification does).
mock_provider "aws" {
  # The bootstrap's other policy documents are not under test here; a valid empty document keeps the provider's JSON checks quiet.
  mock_data "aws_iam_policy_document" {
    defaults = { json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}" }
  }
}

variables {
  environment               = "DEV"
  account_id                = "111111111111"
  region                    = "us-east-1"
  engine                    = "TERRAFORM"
  oidc_subjects             = { DISCOVERY = "d", STATE = "s", STATE_WRITE = "w", APPLY = "a" }
  apply_managed_policy_arns = ["arn:aws:iam::111111111111:policy/example-pilot-apply"]
  state_bucket_name         = "examplefake-dev-state"
  state_admin_principal_arns = [
    "arn:aws:iam::111111111111:role/example-bootstrap-admin",
  ]
}

run "default_is_view_only_with_the_deny" {
  command = plan

  assert {
    condition     = jsonencode([for k, v in aws_iam_role_policy_attachment.managed : v.policy_arn if startswith(k, "DISCOVERY/")]) == jsonencode(["arn:aws:iam::aws:policy/job-function/ViewOnlyAccess"])
    error_message = "The DISCOVERY default is ViewOnlyAccess."
  }
  assert {
    condition     = contains(jsondecode(aws_iam_role_policy.discovery_scope.policy).Statement[1].Action, "s3:GetObject*")
    error_message = "The deny names s3:GetObject*."
  }
  assert {
    condition     = jsondecode(aws_iam_role_policy.discovery_scope.policy).Statement[1].Effect == "Deny" && jsondecode(aws_iam_role_policy.discovery_scope.policy).Statement[1].Resource == "*"
    error_message = "The deny covers every resource."
  }
  assert {
    condition     = length(jsondecode(aws_iam_role_policy.discovery_scope.policy).Statement) == 2
    error_message = "No exception: one allow and one deny."
  }
}

run "the_deny_holds_for_an_override" {
  command = plan
  variables {
    engine                        = "CDK"
    cdk_stack_name                = "ExamplePilotStack"
    oidc_subjects                 = { DISCOVERY = "d", CHANGESET = "c", APPLY = "a" }
    discovery_managed_policy_arns = ["arn:aws:iam::aws:policy/ReadOnlyAccess"]
  }
  assert {
    condition     = contains(jsondecode(aws_iam_role_policy.discovery_scope.policy).Statement[1].Action, "secretsmanager:GetSecretValue")
    error_message = "The deny stays with ReadOnlyAccess."
  }
  expect_failures = [check.discovery_managed_policy_scope]
}

run "broad_override_refused" {
  command = plan
  variables {
    discovery_managed_policy_arns = ["arn:aws:iam::aws:policy/AdministratorAccess"]
  }
  expect_failures = [var.discovery_managed_policy_arns]
}

run "power_user_refused" {
  command = plan
  variables {
    discovery_managed_policy_arns = ["arn:aws:iam::aws:policy/PowerUserAccess"]
  }
  expect_failures = [var.discovery_managed_policy_arns]
}

run "scoped_exception" {
  command = plan
  variables {
    discovery_data_read_exceptions = [{
      actions   = ["ssm:GetParameter"]
      resources = ["arn:aws:ssm:us-east-1:111111111111:parameter/alz/pilot/version"]
      purpose   = "The plan refreshes a non-secret version parameter the project manages."
    }]
  }
  assert {
    condition     = !contains(jsondecode(aws_iam_role_policy.discovery_scope.policy).Statement[1].Action, "ssm:GetParameter")
    error_message = "A lifted action leaves the blanket deny."
  }
  assert {
    condition     = jsondecode(aws_iam_role_policy.discovery_scope.policy).Statement[2].Effect == "Deny" && jsondecode(aws_iam_role_policy.discovery_scope.policy).Statement[2].NotResource == ["arn:aws:ssm:us-east-1:111111111111:parameter/alz/pilot/version"]
    error_message = "A lifted action stays denied outside its named resources."
  }
}

run "exception_without_scope_refused" {
  command = plan
  variables {
    discovery_data_read_exceptions = [{ actions = ["s3:GetObject*"], resources = ["arn:aws:s3:::*"], purpose = "Reading everything for convenience." }]
  }
  expect_failures = [var.discovery_data_read_exceptions]
}

run "exception_without_purpose_refused" {
  command = plan
  variables {
    discovery_data_read_exceptions = [{ actions = ["kms:Decrypt"], resources = ["arn:aws:kms:us-east-1:111111111111:key/abc"], purpose = "need" }]
  }
  expect_failures = [var.discovery_data_read_exceptions]
}

run "exception_for_an_undenied_action_refused" {
  command = plan
  variables {
    discovery_data_read_exceptions = [{ actions = ["iam:CreateRole"], resources = ["arn:aws:iam::111111111111:role/x"], purpose = "Not a data read; must be refused." }]
  }
  expect_failures = [aws_iam_role_policy.discovery_scope]
}
