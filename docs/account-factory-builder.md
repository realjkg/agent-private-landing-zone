# Sovereign ALZ Builder — customer environment setup

## One builder for every practice

Modern Platforms Presales, Modern Platforms Delivery, Digital Presales, and Digital Delivery all use the same ALZ Builder. Practice selection tailors the guidance; **it is not another permission or approval system**. Staff use the AWS Identity Center session and effective permissions they already have. The builder never asks for access keys or issues a new administrator role.

The first destination is **DEV**, then QA or STAGING, then PROD when each separate environment is needed. Each is a **different AWS member account** under the same selected Control Tower management account. Adapt Cloud is our initial provenance environment, **not a hardcoded organization requirement** and not a place to deploy workloads.

## Quick start — guided account creation

In your already authenticated AWS SSO session, from the existing repository checkout:

```bash
./alz account-factory create adaptcloud-admin
```

The terminal guide prompts for practice, environment (DEV, QA, STAGING, PROD), new account name, unique account email, and Identity Center administrator details. It then discovers the signed-in management account and organization, the existing Control Tower landing zone and enabled OU, and the available Service Catalog Account Factory product/version/launch path. It displays the actual target details and asks **one clear confirmation** before making a real AWS account request. You do not manually enter Service Catalog product IDs, copy hashes, or complete another ALZ financial attestation.

AWS IAM/Service Catalog authorizes the actual request. Cloud account creation can result in charges from Control Tower-managed services; the wizard states this before confirmation. The Account Factory product provisions the account through the existing landing zone, without AWS Organizations CreateAccount bypass and without provisioning workloads into the management account.

On submission the builder writes private plan, intent and receipt files under `.runs/account-factory`. Record IDs can be queried using:

```bash
./alz account-factory status adaptcloud-admin rec-RECORD_ID
./alz account-factory verify adaptcloud-admin ACCOUNT_NAME UNIQUE_ACCOUNT_EMAIL
```

A Service Catalog SUCCEEDED record is an authoritative provider completion status; the separate read-back checks the resulting active member account and OU/Control Tower baseline. The account read-back currently **does not independently establish per-account Control Tower enrollment, cost forecasts or production release fitness**. It reports these as unknown rather than pretending a full live environment qualification passed.

## Practice-specific prerequisites (no separate ALZ grant)

| Practice | What staff need | What to hand off |
| --- | --- | --- |
| Modern Platforms Presales | Signed-in AWS SSO profile, dedicated account email, account admin, demonstration architecture | Platform account and design details |
| Modern Platforms Delivery | Signed-in AWS SSO profile, account name/email/admin, planned baseline use | Member account ID and baseline record |
| Digital Presales | Signed-in AWS SSO profile, digital demo scope, account email/admin | Digital workload concept and environment account |
| Digital Delivery | Signed-in AWS SSO profile, workload requirements, account email/admin | Environment inventory and runbook |

The shared minimum is an existing **AWS-authorized management-account role**, a fresh unique account email, an administrator email and name, a healthy Control Tower landing zone, and an OU with `AWSControlTowerBaseline` enabled. These are AWS requirements, not newly invented ALZ approval committees. Final human review is a single `CREATE ENV NAME` confirmation.

## Any verified AWS organization

The runtime resolves the actual AWS Organization ID and management-account ID from the named session, walks the OU hierarchy to find the target OU, and discovers the landing zone and Service Catalog product in that account. It rejects ambiguous or unhealthy targets instead of guessing.

For Adapt Cloud, the established SSO profile `adaptcloud-admin` and `Workloads` OU in `us-east-2` provide proven baseline provenance. To use another AWS organization, **select that organization's existing authenticated management-account profile**, and optionally configure its Control Tower home Region and managed OU:

```bash
export ALZ_ACCOUNT_FACTORY_REGION=us-east-2
export ALZ_ACCOUNT_FACTORY_OU=Workloads
./alz account-factory create YOUR_EXISTING_AWS_PROFILE
```

`ALZ_ACCOUNT_FACTORY_OU` accepts an OU name (unique within the discovered org) or a specific OU ID. Environment names and account emails are tenant-specific. No customer account, authorization evidence or model output is copied from Adapt Cloud into another organization.

If you prefer scripted prepare/submit instead of the guided command:

```bash
./alz account-factory prepare PROFILE MODERN_PLATFORMS_DELIVERY DEV ACCOUNT_NAME UNIQUE_EMAIL ADMIN_EMAIL FIRST LAST .runs/account-factory/dev-proposal.json
./alz account-factory submit PROFILE .runs/account-factory/dev-proposal.json .runs/account-factory/dev-receipt.json
```

The second command still asks for one final creation confirmation. Receipt/intent names are exclusive to avoid blind retries. Always check Service Catalog if submission is interrupted before trying again.

## What this does not change

- The ALZ Browser Operations area provides the four-practice guidance and Account Factory terminal handoffs. Browser-initiated AWS mutations and authenticated `studio.presidio.ai` agent delegation are **not yet integrated** in this PR.
- GitHub and GitLab are interchangeable source hosts for this local runtime; a future GitLab-runner AWS OIDC path is separate from the already-authenticated Account Factory SSO workflow.
- Terraform application roles and private-model security qualification remain separate; infrastructure ACT stays DISABLED.
- QA, STAGING and PROD are intentionally selected as separate member-account creation requests, not silently deployed as side effects of DEV.
- No AWS account has been created or modified by the unit/UI tests. Before claiming live success, run the guided creation from the operator's AWS session and retain the provider record and member-account read-back.
