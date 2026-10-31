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
  limit_amount = "250.00"
  limit_unit   = "USD"
  time_unit    = "MONTHLY"

  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 80
    threshold_type             = "PERCENTAGE"
    notification_type          = "ACTUAL"
    subscriber_sns_topic_arns  = ["arn:aws:sns:eu-west-1:123456789012:billing-alerts"]
    subscriber_email_addresses = ["cfo@example.com"]
  }

  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 100
    threshold_type             = "PERCENTAGE"
    notification_type          = "ACTUAL"
    subscriber_sns_topic_arns  = ["arn:aws:sns:eu-west-1:123456789012:billing-alerts"]
    subscriber_email_addresses = ["cfo@example.com"]
  }

  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 100
    threshold_type             = "PERCENTAGE"
    notification_type          = "FORECASTED"
    subscriber_sns_topic_arns  = ["arn:aws:sns:eu-west-1:123456789012:billing-alerts"]
    subscriber_email_addresses = ["cfo@example.com"]
  }
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
          TIME_GRANULARITY                      = "HOURLY"
          INCLUDE_RESOURCES                     = "TRUE"
          INCLUDE_MANUAL_DISCOUNT_COMPATIBILITY = "FALSE"
          INCLUDE_SPLIT_COST_ALLOCATION_DATA    = "FALSE"
        }
      }
    }

    destination_configurations {
      s3_destination {
        s3_bucket = "corp-billing-exports"
        s3_prefix = "cur2"
        s3_region = "eu-west-1"

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
}
