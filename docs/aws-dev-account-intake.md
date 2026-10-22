# DEV onboarding automation handoff (PLAN only)

An existing AWS Control Tower landing zone was verified ACTIVE/IN_SYNC (v3.1) in us-east-2 in Adapt Cloud org `o-0u6mts6li3`; only management account `973471129135` exists. The Security OU has no matching enabled baseline. AWS Budgets SDK returned 0 budgets. Actual AWS credits are **not** verified.

## Operator preflight (read-only)

Use already authenticated AWS CloudShell/IAM Identity Center session. Do not submit secret keys or access tokens.

```bash
python3 scripts/aws-dev-account-intake.py --identifier adaptcloud-dev \
  --management-account 973471129135 --region us-east-2 \
  --account-email 'UNIQUE_NEW_AWS_ACCOUNT_EMAIL' \
  --owner-email 'IDENTITY_CENTER_ADMIN_EMAIL' \
  --owner-first-name 'FIRST' --owner-last-name 'LAST' \
  > /tmp/alz-dev-intake.json
```

The output is a reviewable account-factory parameter candidate, not an account-creation request, and has `decision: BLOCKED` until a properly governed workload OU and credible spending guardrails exist. Do not send this document to an automatic apply process.

## Execution boundary still needed

1. Under approved management privileges, register a workload OU using Control Tower and verify `AWSControlTowerBaseline` for the target. Do not repurpose the Security OU.
2. Configure budget notifications (advisory only). Independently confirm eligible credits and maintain the $80 **cumulative** pilot spending ceiling; proposed alerts alone cannot guarantee it.
3. Account Factory uses its own authenticated provisioner / service catalog semantics, not a blanket `organizations:create-account` bypass; provision `adaptcloud-dev` only when approvals, unique account email, Identity Center owner, OU, and billing are verified.
4. Once member account exists, execute the **existing** `bootstrap/aws` Terraform plan there after reviewer approval; generate separate OIDC roles for DISCOVERY / STATE / STATE_WRITE / APPLY. Never apply from management account or use root for builder runtime.
5. No ACT until pinned contract and independently qualified human-authorized pilot gates.

This PR implements only read-only preparation, not an actual account creation engine. Final production UX should put this in the existing Sovereign ALZ `./alz` console as a single authenticated wizard.
