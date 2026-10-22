#!/usr/bin/env python3
"""Generate review-only Terraform DEV bootstrap variables after verified account intake.

Never calls AWS, provisions infrastructure, assumes roles, or enables ACT.
"""
import argparse
import json
import pathlib
import re
import sys

ACCOUNT = re.compile(r"^[0-9]{12}$")
IDENT = re.compile(r"^[a-z][a-z0-9-]{2,40}$")
REPO = re.compile(r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$")


def prepare(*, account, identifier, repo, management_account, region="us-east-2"):
    errors = []
    if not ACCOUNT.fullmatch(account):
        errors.append("INVALID_DEV_ACCOUNT")
    if not ACCOUNT.fullmatch(management_account):
        errors.append("INVALID_MANAGEMENT_ACCOUNT")
    if account == management_account:
        errors.append("MANAGEMENT_ACCOUNT_FORBIDDEN")
    if not IDENT.fullmatch(identifier):
        errors.append("INVALID_LANDING_ZONE_IDENTIFIER")
    if not REPO.fullmatch(repo):
        errors.append("INVALID_GITHUB_REPO")
    if region != "us-east-2":
        errors.append("REGION_REQUIRES_SEPARATE_QUALIFICATION")
    # All IAM and backend names are proposals; the apply policy is an explicit owner decision.
    subjects = {k: f"repo:{repo}:environment:dev-{k.lower().replace('_', '-')}"
                for k in ("DISCOVERY", "STATE", "STATE_WRITE", "APPLY")}
    tfvars = {
        "environment": "DEV", "engine": "TERRAFORM", "account_id": account,
        "region": region, "name_prefix": "alz-pilot",
        "oidc_subjects": subjects,
        "state_bucket_name": f"{identifier}-{account}-tfstate",
        "state_admin_principal_arns": [],
        "apply_managed_policy_arns": [],
        "budget_monthly_usd": None,
        "alert_emails": ["info@adaptcloud.io", "kristian@adaptcloud.io"],
    }
    return {
        "kind": "AWS_DEV_TERRAFORM_BOOTSTRAP_HANDOFF_V1",
        "execution": "PLAN_ONLY", "actEnabled": False, "cloudMutation": False,
        "engine": "TERRAFORM", "identifier": identifier,
        "targetAccountId": account, "managementAccountId": management_account,
        "cumulativeCreditCeilingUsd": 80, "authorizedAdditionalSpendUsd": 0,
        "bootstrapModule": "bootstrap/aws", "terraformVarsCandidate": tfvars,
        "requiredOwnerInputs": [
            "Account Factory provisioning evidence and unique account email",
            "DEV account permission and SCP verification",
            "Verified credit balance and cumulative-cost control",
            "Explicit limited-scope APPLY managed policy ARN",
            "Explicit DEV bootstrap administrator ARN",
            "GitHub environment and workload OIDC subjects",
            "Monthly alert budget amount reviewed separately from cumulative $80 limit",
            "Terraform plan and signed pilot qualification gates",
        ],
        "cdk": {"mode": "SEPARATE_PATH", "status": "NOT_QUALIFIED",
                "note": "No automatic Terraform-to-CDK engine switching."},
        "errors": errors,
        "decision": "BLOCKED",
    }


def main():
    p = argparse.ArgumentParser(description="Plan-only Terraform DEV bootstrap handoff")
    p.add_argument("--dev-account", required=True)
    p.add_argument("--management-account", default="973471129135")
    p.add_argument("--identifier", default="adaptcloud-dev")
    p.add_argument("--github-repo", default="realjkg/agent-private-landing-zone")
    p.add_argument("--region", default="us-east-2")
    a = p.parse_args()
    result = prepare(account=a.dev_account, management_account=a.management_account,
                     identifier=a.identifier, repo=a.github_repo, region=a.region)
    print(json.dumps(result, indent=2, sort_keys=True))
    return 2  # Incomplete owner evidence must never accidentally signal deployment readiness.


if __name__ == "__main__":
    sys.exit(main())
