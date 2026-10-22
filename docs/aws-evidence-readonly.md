# AWS evidence intake — single read-only command

Run with an **already authenticated** AWS Identity Center / operator session. The script does not sign in, assume roles, request secrets, call provisioning APIs, create budgets, or enable ACT.

```bash
AWS_PAGER="" python3 scripts/aws-evidence-readonly.py \
  --identifier adaptcloud-dev \
  --expected-management-account 973471129135 \
  --region us-east-2 > /tmp/alz-evidence.json
```

Requires Python 3 and boto3 (usually installed in AWS CloudShell). Output is a JSON evidence packet; import/review locally. Do **not** run the live pilot or bootstrap Terraform from this evidence alone.

Checks: STS account identity, AWS Organizations identity/accounts/OUs, Control Tower landing-zone health/baseline inventory, OIDC provider count, AWS Budgets API count. Sensitive role session IDs and service manifests are intentionally not exported. An unexpected account or missing permission blocks verification. An account with only its management account remains BLOCKED for infrastructure ACT even if Control Tower is healthy.

This is preparatory discovery. **AWS Budgets are not an $80 cumulative hard cap**; a zero-budget result only confirms no budgets, not credit eligibility or billing headroom. Before any DEV account creation / Terraform apply, the owner must approve the target and IAM trust, verify billing credits, forecast bounded test cost, and satisfy the existing signed, pinned pilot contract gates. Use isolated member accounts, never the management account, for test resources. Terraform first; CDK subsequently qualifies independently.

The collector currently does **not** gather Cost Explorer charges or AWS credit balance and does not create the new Workloads OU, member account, OIDC provider, or IAM roles. It is an incremental evidence collector for the existing `./alz` operator experience, not a replacement for the console wizard.
