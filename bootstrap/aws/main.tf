locals {
  env        = lower(var.environment)
  identities = toset(var.engine == "TERRAFORM" ? ["DISCOVERY", "STATE", "STATE_WRITE", "APPLY"] : ["DISCOVERY", "CHANGESET", "APPLY"])
  role_names = { for i in local.identities : i => "${var.name_prefix}-${local.env}-${lower(replace(i, "_", "-"))}" }
  role_arns  = { for i, name in local.role_names : i => "arn:aws:iam::${var.account_id}:role/${name}" }

  oidc_provider_arn = var.existing_oidc_provider_arn != null ? var.existing_oidc_provider_arn : aws_iam_openid_connect_provider.this[0].arn

  managed_policies = merge(
    { for arn in var.apply_managed_policy_arns : "APPLY/${arn}" => { identity = "APPLY", arn = arn } },
    { for arn in var.discovery_managed_policy_arns : "DISCOVERY/${arn}" => { identity = "DISCOVERY", arn = arn } if var.engine == "TERRAFORM" },
  )
}

resource "aws_iam_openid_connect_provider" "this" {
  count          = var.existing_oidc_provider_arn == null ? 1 : 0
  url            = "https://${var.oidc_issuer_host}"
  client_id_list = [var.oidc_audience]
}

# Trust: only the OIDC provider, only this audience, only this identity's exact subject.
data "aws_iam_policy_document" "trust" {
  for_each = local.identities

  statement {
    actions = ["sts:AssumeRoleWithWebIdentity"]

    principals {
      type        = "Federated"
      identifiers = [local.oidc_provider_arn]
    }

    condition {
      test     = "StringEquals"
      variable = "${var.oidc_issuer_host}:aud"
      values   = [var.oidc_audience]
    }

    condition {
      test     = "StringEquals"
      variable = "${var.oidc_issuer_host}:sub"
      values   = [var.oidc_subjects[each.key]]
    }
  }
}

resource "aws_iam_role" "identity" {
  for_each             = local.identities
  name                 = local.role_names[each.key]
  assume_role_policy   = data.aws_iam_policy_document.trust[each.key].json
  max_session_duration = 3600
  permissions_boundary  = each.key == "APPLY" ? var.apply_permissions_boundary_arn : null
}

resource "aws_iam_role_policy_attachment" "managed" {
  for_each   = local.managed_policies
  role       = aws_iam_role.identity[each.value.identity].name
  policy_arn = each.value.arn
}

resource "aws_iam_role_policy" "identity" {
  for_each = local.inline_policies
  name     = "act-pilot-${lower(replace(each.key, "_", "-"))}"
  role     = aws_iam_role.identity[each.key].name
  policy   = each.value
}

resource "aws_budgets_budget" "pilot" {
  count        = var.budget_monthly_usd == null ? 0 : 1
  name         = "${var.name_prefix}-${local.env}"
  budget_type  = "COST"
  limit_amount = tostring(var.budget_monthly_usd)
  limit_unit   = "USD"
  time_unit    = "MONTHLY"

  dynamic "notification" {
    for_each = toset([80, 100])
    content {
      comparison_operator        = "GREATER_THAN"
      threshold                  = notification.value
      threshold_type             = "PERCENTAGE"
      notification_type          = "ACTUAL"
      subscriber_email_addresses = var.alert_emails
    }
  }

  lifecycle {
    precondition {
      condition     = length(var.alert_emails) > 0
      error_message = "A budget needs at least one alert email."
    }
  }
}
