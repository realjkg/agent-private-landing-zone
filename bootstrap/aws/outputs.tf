# IDs and names only. Nothing here is a secret. bootstrap/config.aws.template.json says where each value goes.
output "role_arns" {
  description = "ALZ_<IDENTITY>_AWS_ROLE_ARN for this environment."
  value       = local.role_arns
}

output "oidc_provider_arn" {
  value = local.oidc_provider_arn
}

output "contract_target" {
  description = "This environment's entry in the contract's targets block."
  value = merge(
    {
      accountId = var.account_id
      region    = var.region
      backend   = var.engine == "TERRAFORM" ? "${var.state_bucket_name}/${local.state_key}" : var.cdk_stack_name
      workspace = "default"
    },
    # Only the CDK engine's targets carry capabilities. Empty means a stack with IAM resources needs an explicit owner decision.
    { for name, value in { capabilities = [] } : name => value if var.engine == "CDK" },
  )
}
