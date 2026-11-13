# AWS costs in the private agent

The local session can answer a bounded natural-language cost question with AWS Cost Explorer and can list tags for selected KMS and EC2 cost-driver resources. Both paths are live AWS reads. They run only against the account returned by STS for the current profile; the agent cannot ask for organization-wide or another account's charges.

## Sign in and ask

Use an authenticated IAM Identity Center profile. The AWS CLI command exchanges that profile's SSO session for short-lived credentials in memory; the credential JSON is not printed, written to disk, or sent to a model. Profiles using `credential_process`, `source_profile` or non-SSO credential chains are refused. On a governed runner, the existing DISCOVERY web-identity credentials remain supported.

```sh
aws sso login --profile adaptcloud-admin
AWS_PROFILE=adaptcloud-admin ./alz session aws
```

In the local conversation, ask for example:

- “How much did KMS and EC2 cost last month? Break it down by usage type.”
- “Show KMS spend for the last 30 days by region.”
- “List tags and labels on KMS keys and EC2 volumes, snapshots, NAT gateways, and VPC endpoints.”

Dates support a named month, `YYYY-MM`, last month, this month, and last 7, 14, 30, 60 or 90 days. The default is the last complete month. Spend uses Cost Explorer `UnblendedCost`, grouped by service, region or usage type. A KMS/EC2 question is filtered to those service names; an explicit AWS region in the question also filters the result.

Resource tag discovery uses the AWS Resource Groups Tagging API in the profile's configured region (or a region named in the question) and shows at most 50 resources. AWS only returns resources that have been tagged before; this is not a complete inventory of untagged resources.

## What the results prove

Cost Explorer returns service and usage aggregates. It does not identify the exact KMS key, volume, snapshot, NAT gateway or endpoint behind each charge. Tag inventory is a separate read and is not cost attribution. Billing data can lag. Missing rows are not proof of zero spend.

Neither command changes AWS. The agent cannot destroy an arbitrary resource based on a cost row. The existing accelerator cleanup can destroy only a reviewed, tracked deployment unit after its contract, plan, requester and approval checks. For unrelated resources, a human owner must identify the resource and use its owning stack's reviewed change set. This is especially important in the organization management account, where Control Tower and billing resources must remain intact.
