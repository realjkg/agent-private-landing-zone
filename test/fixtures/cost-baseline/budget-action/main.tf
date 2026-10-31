# ALZ REVIEW CANDIDATE — AWS cost baseline rendered by fixed code; NOT an applied plan.
# A budget sends alerts; it is not a hard cap. A budget action exists only when the owner configured one.
terraform {
  required_version = ">= 1.6.0"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "6.68.0"
    }
  }
}

variable "aws_region" {
  type = string
}

provider "aws" {
  region = var.aws_region

  default_tags {
    tags = {
      "cost-center" = "cc-1234"
      "environment" = "dev"
      "owner"       = "platform-team"
    }
  }
}

# Cross-region dependency: AWS Data Exports is served from us-east-1.
provider "aws" {
  alias  = "billing"
  region = "us-east-1"

  default_tags {
    tags = {
      "cost-center" = "cc-1234"
      "environment" = "dev"
      "owner"       = "platform-team"
    }
  }
}

data "aws_caller_identity" "current" {}

resource "aws_budgets_budget" "cost_baseline" {
  name         = "alz-cost-baseline"
  budget_type  = "COST"
  limit_amount = "1000.00"
  limit_unit   = "USD"
  time_unit    = "QUARTERLY"

  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 50
    threshold_type             = "PERCENTAGE"
    notification_type          = "ACTUAL"
    subscriber_email_addresses = ["finops@example.com"]
  }

  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 90
    threshold_type             = "PERCENTAGE"
    notification_type          = "ACTUAL"
    subscriber_email_addresses = ["finops@example.com"]
  }

  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 100
    threshold_type             = "PERCENTAGE"
    notification_type          = "FORECASTED"
    subscriber_email_addresses = ["finops@example.com"]
  }
}

# Opt-in budget action. Effect: When actual spend reaches 100% of 1000.00 USD (quarterly), AWS Budgets attaches arn:aws:iam::123456789012:policy/alz-deny-new-compute to roles workload-deployer, after a person approves the action in AWS Budgets. This restricts permissions; it does not stop running resources or cap spend.
resource "aws_budgets_budget_action" "cost_baseline" {
  budget_name        = aws_budgets_budget.cost_baseline.name
  action_type        = "APPLY_IAM_POLICY"
  approval_model     = "MANUAL"
  notification_type  = "ACTUAL"
  execution_role_arn = "arn:aws:iam::123456789012:role/alz-budget-action"

  action_threshold {
    action_threshold_type  = "PERCENTAGE"
    action_threshold_value = 100
  }

  definition {
    iam_action_definition {
      policy_arn = "arn:aws:iam::123456789012:policy/alz-deny-new-compute"
      roles      = ["workload-deployer"]
    }
  }

  subscriber {
    address           = "finops@example.com"
    subscription_type = "EMAIL"
  }
}

# force_destroy stays false: billing data is never deleted silently. Destroying a non-empty bucket fails closed,
# and its owner empties or keeps it; the lifecycle rule below expires old exports.
resource "aws_s3_bucket" "cost_export" {
  bucket        = "acme-cost-export"
  force_destroy = false
}

resource "aws_s3_bucket_public_access_block" "cost_export" {
  bucket                  = aws_s3_bucket.cost_export.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "cost_export" {
  bucket = aws_s3_bucket.cost_export.id

  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

# SSE-S3, as in the AWS Cloud Intelligence Dashboards data-exports destination bucket. A customer-managed key
# is not rendered; an owner who needs one adopts a bucket already configured with it (export.mode ADOPT_EXISTING).
resource "aws_s3_bucket_server_side_encryption_configuration" "cost_export" {
  bucket = aws_s3_bucket.cost_export.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "cost_export" {
  bucket = aws_s3_bucket.cost_export.id

  rule {
    id     = "expire-cost-export"
    status = "Enabled"

    filter {
      prefix = "cur2/"
    }

    expiration {
      days = 90
    }
  }
}

# AWS Data Exports writes the CUR 2.0 files and checks this policy; both principals are scoped to this account.
resource "aws_s3_bucket_policy" "cost_export" {
  bucket = aws_s3_bucket.cost_export.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "AllowDataExportsDelivery"
        Effect = "Allow"
        Principal = {
          Service = ["bcm-data-exports.amazonaws.com", "billingreports.amazonaws.com"]
        }
        Action   = ["s3:PutObject", "s3:GetBucketPolicy"]
        Resource = [aws_s3_bucket.cost_export.arn, "${aws_s3_bucket.cost_export.arn}/*"]
        Condition = {
          StringLike = {
            "aws:SourceAccount" = data.aws_caller_identity.current.account_id
            "aws:SourceArn" = [
              "arn:aws:cur:us-east-1:${data.aws_caller_identity.current.account_id}:definition/*",
              "arn:aws:bcm-data-exports:us-east-1:${data.aws_caller_identity.current.account_id}:export/*",
            ]
          }
        }
      },
      {
        Sid       = "DenyInsecureTransport"
        Effect    = "Deny"
        Principal = "*"
        Action    = "s3:*"
        Resource  = [aws_s3_bucket.cost_export.arn, "${aws_s3_bucket.cost_export.arn}/*"]
        Condition = { Bool = { "aws:SecureTransport" = "false" } }
      },
    ]
  })

  depends_on = [aws_s3_bucket_public_access_block.cost_export]
}

# CUR 2.0. Hourly granularity is line-item detail; AWS delivers the export at least once a day, not hourly.
resource "aws_bcmdataexports_export" "cur2" {
  provider = aws.billing

  export {
    name = "alz-cur2"

    data_query {
      query_statement = "SELECT identity_line_item_id, identity_time_interval, bill_billing_period_start_date, bill_payer_account_id, line_item_usage_account_id, line_item_line_item_type, line_item_usage_start_date, line_item_usage_end_date, line_item_product_code, line_item_usage_type, line_item_operation, line_item_resource_id, line_item_usage_amount, line_item_unblended_cost, line_item_blended_cost, line_item_currency_code, pricing_unit, product_region_code, resource_tags FROM COST_AND_USAGE_REPORT"
      table_configurations = {
        COST_AND_USAGE_REPORT = {
          TIME_GRANULARITY                      = "DAILY"
          INCLUDE_RESOURCES                     = "TRUE"
          INCLUDE_MANUAL_DISCOUNT_COMPATIBILITY = "FALSE"
          INCLUDE_SPLIT_COST_ALLOCATION_DATA    = "FALSE"
        }
      }
    }

    destination_configurations {
      s3_destination {
        s3_bucket = aws_s3_bucket.cost_export.bucket
        s3_prefix = "cur2"
        s3_region = var.aws_region

        s3_output_configurations {
          overwrite   = "OVERWRITE_REPORT"
          format      = "PARQUET"
          compression = "PARQUET"
          output_type = "CUSTOM"
        }
      }
    }

    refresh_cadence {
      frequency = "SYNCHRONOUS"
    }
  }

  depends_on = [aws_s3_bucket_policy.cost_export]
}
