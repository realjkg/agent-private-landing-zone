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


def prepare(*, account, identifier, repo, management_account, region="us-east-2", oidc_subjects=None):
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
    # The real 2026 subject must be observed from the execution host; never guess it from a repository name.
    allowed = {"DISCOVERY", "STATE", "STATE_WRITE", "APPLY"}
    subjects = oidc_subjects if isinstance(oidc_subjects, dict) and set(oidc_subjects)==allowed and all(
        isinstance(v, str) and v for v in oidc_subjects.values()) and len(set(oidc_subjects.values()))==4 else None
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
            "Exact OIDC subjects measured from four workload tokens (a guessed GitHub subject is not acceptable)",
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
    p.add_argument("--oidc-subjects-file", help="Local JSON object containing four observed subjects, not guessed subjects")
    a = p.parse_args()
    provided_subjects = None
    if a.oidc_subjects_file:
        try:
            provided_subjects = json.loads(pathlib.Path(a.oidc_subjects_file).read_text())
        except (OSError, ValueError) as error:
            print(json.dumps({"decision":"BLOCKED","error":"OIDC_SUBJECT_EVIDENCE_UNREADABLE"}))
            return 2
    result = prepare(account=a.dev_account, management_account=a.management_account,
                     identifier=a.identifier, repo=a.github_repo, region=a.region,
                     oidc_subjects=provided_subjects)
    print(json.dumps(result, indent=2, sort_keys=True))
    return 2  # Incomplete owner evidence must never accidentally signal deployment readiness.


if __name__ == "__main__":
    sys.exit(main())
