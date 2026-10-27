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
    condition     = jsondecode(aws_iam_role_policy.discovery_scope.policy).Statement[2].Effect == "Deny" && jsondecode(aws_iam_role_policy.discovery_scope.policy).Statement[2].Action == ["apigateway:GET"] && contains(jsondecode(aws_iam_role_policy.discovery_scope.policy).Statement[2].Resource, "arn:aws:apigateway:*::/apikeys/*")
    error_message = "API key values are denied on their own paths."
  }
  assert {
    condition     = length(jsondecode(aws_iam_role_policy.discovery_scope.policy).Statement) == 3
    error_message = "No exception: one allow, the blanket deny and the API key deny."
  }
  assert {
    condition     = length(aws_iam_role_policy.discovery_scope.policy) <= 10240
    error_message = "The inline policy fits the 10,240-character limit."
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
    condition     = jsondecode(aws_iam_role_policy.discovery_scope.policy).Statement[3].Effect == "Deny" && jsondecode(aws_iam_role_policy.discovery_scope.policy).Statement[3].NotResource == ["arn:aws:ssm:us-east-1:111111111111:parameter/alz/pilot/version"]
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
    # A write on an exact ARN: the ARN passes the variable's rule, and the precondition refuses the action the deny does not list.
    discovery_data_read_exceptions = [{ actions = ["sqs:SendMessage"], resources = ["arn:aws:sqs:us-east-1:111111111111:example-queue"], purpose = "Not a data read; must be refused." }]
  }
  expect_failures = [aws_iam_role_policy.discovery_scope]
}

# The managed-policy allowlist: exact AWS-managed ARNs only.
run "security_audit_and_view_only_accepted" {
  command = plan
  variables {
    discovery_managed_policy_arns = ["arn:aws:iam::aws:policy/job-function/ViewOnlyAccess", "arn:aws:iam::aws:policy/SecurityAudit"]
  }
}

run "lowercase_variant_refused" {
  command = plan
  variables {
    discovery_managed_policy_arns = ["arn:aws:iam::aws:policy/job-function/viewonlyaccess"]
  }
  expect_failures = [var.discovery_managed_policy_arns]
}

run "lowercase_admin_refused" {
  command = plan
  variables {
    discovery_managed_policy_arns = ["arn:aws:iam::aws:policy/administratoraccess"]
  }
  expect_failures = [var.discovery_managed_policy_arns]
}

run "trailing_space_refused" {
  command = plan
  variables {
    discovery_managed_policy_arns = ["arn:aws:iam::aws:policy/ReadOnlyAccess "]
  }
  expect_failures = [var.discovery_managed_policy_arns]
}

run "leading_space_refused" {
  command = plan
  variables {
    discovery_managed_policy_arns = [" arn:aws:iam::aws:policy/SecurityAudit"]
  }
  expect_failures = [var.discovery_managed_policy_arns]
}

run "customer_managed_lookalike_refused" {
  command = plan
  variables {
    discovery_managed_policy_arns = ["arn:aws:iam::111111111111:policy/AdministratorAccess"]
  }
  expect_failures = [var.discovery_managed_policy_arns]
}

run "customer_managed_view_only_lookalike_refused" {
  command = plan
  variables {
    discovery_managed_policy_arns = ["arn:aws:iam::111111111111:policy/job-function/ViewOnlyAccess"]
  }
  expect_failures = [var.discovery_managed_policy_arns]
}

run "secrets_manager_read_write_refused" {
  command = plan
  variables {
    discovery_managed_policy_arns = ["arn:aws:iam::aws:policy/SecretsManagerReadWrite"]
  }
  expect_failures = [var.discovery_managed_policy_arns]
}

run "other_partition_refused" {
  command = plan
  variables {
    discovery_managed_policy_arns = ["arn:aws-us-gov:iam::aws:policy/ReadOnlyAccess"]
  }
  expect_failures = [var.discovery_managed_policy_arns]
}

# Exceptions name exact resources: every wildcard form the review (PR #293, 6442107608) listed, and empty segments.
run "exact_object_and_api_key_accepted" {
  command = plan
  variables {
    discovery_data_read_exceptions = [
      { actions = ["s3:GetObject*"], resources = ["arn:aws:s3:::examplefake-pilot-config/settings.json"], purpose = "The plan refreshes one non-secret settings object." },
      { actions = ["secretsmanager:GetSecretValue"], resources = ["arn:aws:secretsmanager:us-east-1:111111111111:secret:alz/pilot/token-AbCdEf"], purpose = "The plan refreshes the one secret version the project manages." },
    ]
  }
}

run "every_object_in_every_bucket_refused" {
  command = plan
  variables {
    discovery_data_read_exceptions = [{ actions = ["s3:GetObject*"], resources = ["arn:aws:s3:::*/*"], purpose = "A purpose long enough to pass the length rule." }]
  }
  expect_failures = [var.discovery_data_read_exceptions]
}

run "every_object_in_a_bucket_refused" {
  command = plan
  variables {
    discovery_data_read_exceptions = [{ actions = ["s3:GetObject*"], resources = ["arn:aws:s3:::examplefake-bucket/*"], purpose = "A purpose long enough to pass the length rule." }]
  }
  expect_failures = [var.discovery_data_read_exceptions]
}

run "every_secret_refused" {
  command = plan
  variables {
    discovery_data_read_exceptions = [{ actions = ["secretsmanager:GetSecretValue"], resources = ["arn:aws:secretsmanager:us-east-1:111111111111:secret:*"], purpose = "A purpose long enough to pass the length rule." }]
  }
  expect_failures = [var.discovery_data_read_exceptions]
}

run "every_parameter_anywhere_refused" {
  command = plan
  variables {
    discovery_data_read_exceptions = [{ actions = ["ssm:GetParameter"], resources = ["arn:aws:ssm:*:*:parameter/*"], purpose = "A purpose long enough to pass the length rule." }]
  }
  expect_failures = [var.discovery_data_read_exceptions]
}

run "every_key_anywhere_refused" {
  command = plan
  variables {
    discovery_data_read_exceptions = [{ actions = ["kms:Decrypt"], resources = ["arn:aws:kms:*:*:key/*"], purpose = "A purpose long enough to pass the length rule." }]
  }
  expect_failures = [var.discovery_data_read_exceptions]
}

run "every_table_refused" {
  command = plan
  variables {
    discovery_data_read_exceptions = [{ actions = ["dynamodb:GetItem"], resources = ["arn:aws:dynamodb:us-east-1:111111111111:table/*"], purpose = "A purpose long enough to pass the length rule." }]
  }
  expect_failures = [var.discovery_data_read_exceptions]
}

run "single_character_wildcard_refused" {
  command = plan
  variables {
    discovery_data_read_exceptions = [{ actions = ["ssm:GetParameter"], resources = ["arn:aws:ssm:us-east-1:111111111111:parameter/alz/pilot/versio?"], purpose = "A purpose long enough to pass the length rule." }]
  }
  expect_failures = [var.discovery_data_read_exceptions]
}

run "wildcard_partition_refused" {
  command = plan
  variables {
    discovery_data_read_exceptions = [{ actions = ["s3:GetObject*"], resources = ["arn:*:s3:::examplefake-bucket/key"], purpose = "A purpose long enough to pass the length rule." }]
  }
  expect_failures = [var.discovery_data_read_exceptions]
}

run "other_partition_exception_refused" {
  command = plan
  variables {
    discovery_data_read_exceptions = [{ actions = ["s3:GetObject*"], resources = ["arn:aws-cn:s3:::examplefake-bucket/key"], purpose = "A purpose long enough to pass the length rule." }]
  }
  expect_failures = [var.discovery_data_read_exceptions]
}

run "empty_region_refused" {
  command = plan
  variables {
    discovery_data_read_exceptions = [{ actions = ["ssm:GetParameter"], resources = ["arn:aws:ssm::111111111111:parameter/alz/pilot/version"], purpose = "A purpose long enough to pass the length rule." }]
  }
  expect_failures = [var.discovery_data_read_exceptions]
}

run "empty_account_refused" {
  command = plan
  variables {
    discovery_data_read_exceptions = [{ actions = ["kms:Decrypt"], resources = ["arn:aws:kms:us-east-1::key/1234abcd-12ab-34cd-56ef-1234567890ab"], purpose = "A purpose long enough to pass the length rule." }]
  }
  expect_failures = [var.discovery_data_read_exceptions]
}

run "empty_resource_name_refused" {
  command = plan
  variables {
    discovery_data_read_exceptions = [{ actions = ["dynamodb:GetItem"], resources = ["arn:aws:dynamodb:us-east-1:111111111111:table/"], purpose = "A purpose long enough to pass the length rule." }]
  }
  expect_failures = [var.discovery_data_read_exceptions]
}

run "empty_secret_name_refused" {
  command = plan
  variables {
    discovery_data_read_exceptions = [{ actions = ["secretsmanager:GetSecretValue"], resources = ["arn:aws:secretsmanager:us-east-1:111111111111:secret:"], purpose = "A purpose long enough to pass the length rule." }]
  }
  expect_failures = [var.discovery_data_read_exceptions]
}

run "empty_path_segment_refused" {
  command = plan
  variables {
    discovery_data_read_exceptions = [{ actions = ["s3:GetObject*"], resources = ["arn:aws:s3:::examplefake-bucket//key"], purpose = "A purpose long enough to pass the length rule." }]
  }
  expect_failures = [var.discovery_data_read_exceptions]
}

run "not_an_arn_refused" {
  command = plan
  variables {
    discovery_data_read_exceptions = [{ actions = ["kms:Decrypt"], resources = ["key/1234abcd-12ab-34cd-56ef-1234567890ab"], purpose = "A purpose long enough to pass the length rule." }]
  }
  expect_failures = [var.discovery_data_read_exceptions]
}
