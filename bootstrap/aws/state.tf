# Terraform engine only: the state bucket and the policy that separates STATE (read, lock) from STATE_WRITE (write, lock).
resource "aws_s3_bucket" "state" {
  count         = var.engine == "TERRAFORM" ? 1 : 0
  bucket        = var.state_bucket_name
  force_destroy = var.force_destroy_state
}

resource "aws_s3_bucket_versioning" "state" {
  count  = var.engine == "TERRAFORM" ? 1 : 0
  bucket = aws_s3_bucket.state[0].id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "state" {
  count  = var.engine == "TERRAFORM" ? 1 : 0
  bucket = aws_s3_bucket.state[0].id

  rule {
    bucket_key_enabled = true

    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_public_access_block" "state" {
  count                   = var.engine == "TERRAFORM" ? 1 : 0
  bucket                  = aws_s3_bucket.state[0].id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "state" {
  count  = var.engine == "TERRAFORM" ? 1 : 0
  bucket = aws_s3_bucket.state[0].id

  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "state" {
  count  = var.engine == "TERRAFORM" ? 1 : 0
  bucket = aws_s3_bucket.state[0].id

  rule {
    id     = "expire-old-versions"
    status = "Enabled"

    filter {}

    noncurrent_version_expiration {
      noncurrent_days = var.noncurrent_version_retention_days
    }

    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }

  depends_on = [aws_s3_bucket_versioning.state]
}

data "aws_iam_policy_document" "state" {
  count = var.engine == "TERRAFORM" ? 1 : 0

  statement {
    sid       = "DenyInsecureTransport"
    effect    = "Deny"
    actions   = ["s3:*"]
    resources = [local.bucket_arn, "${local.bucket_arn}/*"]

    principals {
      type        = "*"
      identifiers = ["*"]
    }

    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }

  # Only STATE, STATE_WRITE and the named administrators can touch the bucket. DISCOVERY, APPLY and every other principal are denied
  # whatever their own policies say, so APPLY cannot become a state fallback by being given a broad S3 policy.
  statement {
    sid       = "DenyEveryoneElse"
    effect    = "Deny"
    actions   = ["s3:*"]
    resources = [local.bucket_arn, "${local.bucket_arn}/*"]

    principals {
      type        = "*"
      identifiers = ["*"]
    }

    condition {
      test     = "ArnNotLike"
      variable = "aws:PrincipalArn"
      values   = concat([local.role_arns["STATE"], local.role_arns["STATE_WRITE"]], var.state_admin_principal_arns)
    }
  }

  # STATE may create and delete only the lock object, never the state object.
  statement {
    sid           = "StateCannotWriteState"
    effect        = "Deny"
    actions       = ["s3:PutObject", "s3:DeleteObject", "s3:DeleteObjectVersion"]
    not_resources = [local.lock_arn]

    principals {
      type        = "AWS"
      identifiers = [local.role_arns["STATE"]]
    }
  }

  # Nobody in the pilot erases state history.
  statement {
    sid       = "StateWriteCannotDeleteVersions"
    effect    = "Deny"
    actions   = ["s3:DeleteObjectVersion"]
    resources = ["${local.bucket_arn}/*"]

    principals {
      type        = "AWS"
      identifiers = [local.role_arns["STATE_WRITE"]]
    }
  }
}

resource "aws_s3_bucket_policy" "state" {
  count  = var.engine == "TERRAFORM" ? 1 : 0
  bucket = aws_s3_bucket.state[0].id
  policy = data.aws_iam_policy_document.state[0].json

  depends_on = [aws_s3_bucket_public_access_block.state, aws_iam_role.identity]
}
