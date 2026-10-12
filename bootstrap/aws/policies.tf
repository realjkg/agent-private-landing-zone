locals {
  bucket_arn = var.state_bucket_name == null ? "" : "arn:aws:s3:::${var.state_bucket_name}"
  state_key  = coalesce(var.state_key, "pilot/${local.env}.tfstate")
  state_arn  = "${local.bucket_arn}/${local.state_key}"
  lock_arn   = "${local.bucket_arn}/${local.state_key}.tflock"
  stack_arn  = "arn:aws:cloudformation:${var.region}:${var.account_id}:stack/${coalesce(var.cdk_stack_name, "unused")}/*"

  # Nothing the pilot runs may edit the roles or the OIDC provider that bound it.
  deny_bootstrap_edits = {
    Sid      = "DenyEditingBootstrapIdentity"
    Effect   = "Deny"
    Action   = "iam:*"
    Resource = ["arn:aws:iam::${var.account_id}:role/${var.name_prefix}-*", local.oidc_provider_arn]
  }

  # Inline policies by identity, as JSON text so both engines' maps have one type. APPLY's resource permissions come from apply_managed_policy_arns.
  terraform_policies = {
    STATE = jsonencode({ Version = "2012-10-17", Statement = [
      { Sid = "ReadState", Effect = "Allow", Action = "s3:GetObject", Resource = local.state_arn },
      { Sid = "TakeAndReleaseLock", Effect = "Allow", Action = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"], Resource = local.lock_arn },
      { Sid = "ListBucket", Effect = "Allow", Action = "s3:ListBucket", Resource = local.bucket_arn },
    ] })
    STATE_WRITE = jsonencode({ Version = "2012-10-17", Statement = [
      { Sid = "ReadWriteState", Effect = "Allow", Action = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"], Resource = [local.state_arn, local.lock_arn] },
      { Sid = "ListBucket", Effect = "Allow", Action = "s3:ListBucket", Resource = local.bucket_arn },
    ] })
    APPLY = jsonencode({ Version = "2012-10-17", Statement = [local.deny_bootstrap_edits] })
  }

  cdk_policies = {
    DISCOVERY = jsonencode({ Version = "2012-10-17", Statement = [
      { Sid = "DescribeStack", Effect = "Allow", Action = "cloudformation:DescribeStacks", Resource = local.stack_arn },
    ] })
    CHANGESET = jsonencode({ Version = "2012-10-17", Statement = [
      { Sid = "ChangeSets", Effect = "Allow", Action = ["cloudformation:CreateChangeSet", "cloudformation:DescribeChangeSet", "cloudformation:DeleteChangeSet", "cloudformation:GetTemplate", "cloudformation:DescribeStacks"], Resource = local.stack_arn },
      { Sid = "NeverExecute", Effect = "Deny", Action = ["cloudformation:ExecuteChangeSet", "cloudformation:CancelUpdateStack", "cloudformation:DeleteStack"], Resource = "*" },
    ] })
    APPLY = jsonencode({ Version = "2012-10-17", Statement = [
      { Sid = "ExecuteAndWatch", Effect = "Allow", Action = ["cloudformation:ExecuteChangeSet", "cloudformation:DescribeStacks", "cloudformation:DescribeStackEvents", "cloudformation:CancelUpdateStack"], Resource = local.stack_arn },
      { Sid = "NeverCreateChangeSetOrDelete", Effect = "Deny", Action = ["cloudformation:CreateChangeSet", "cloudformation:DeleteStack"], Resource = "*" },
      local.deny_bootstrap_edits,
    ] })
  }

  inline_policies = merge(
    { for name, policy in local.terraform_policies : name => policy if var.engine == "TERRAFORM" },
    { for name, policy in local.cdk_policies : name => policy if var.engine == "CDK" },
  )
}
