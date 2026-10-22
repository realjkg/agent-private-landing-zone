#!/usr/bin/env python3
"""Control Tower DEV account onboarding preflight. No AWS writes."""
import argparse
import json
import re
import sys
import boto3
from botocore.exceptions import ClientError, BotoCoreError

def main():
    parser = argparse.ArgumentParser(description="Generate a governed DEV Account Factory intake; read-only")
    parser.add_argument("--identifier", default="adaptcloud-dev")
    parser.add_argument("--region", default="us-east-2")
    parser.add_argument("--account-email", required=True, help="Unique email address for a new AWS account")
    parser.add_argument("--owner-email", required=True, help="Account Factory IAM Identity Center administrator email")
    parser.add_argument("--owner-first-name", required=True)
    parser.add_argument("--owner-last-name", required=True)
    parser.add_argument("--management-account", default="973471129135")
    args = parser.parse_args()
    if not re.fullmatch(r"[a-z][a-z0-9-]{2,40}", args.identifier):
        parser.error("invalid identifier")
    if not re.fullmatch(r"[^\s@]+@[^\s@]+\.[^\s@]+", args.account_email) or not re.fullmatch(r"[^\s@]+@[^\s@]+\.[^\s@]+", args.owner_email):
        parser.error("invalid account/owner email")
    if not re.fullmatch(r"\d{12}", args.management_account):
        parser.error("invalid management account id")
    session = boto3.session.Session(region_name=args.region)
    errors = []
    try:
        sts = session.client("sts").get_caller_identity()
        if sts["Account"] != args.management_account:
            raise ValueError("current session is not the intended management account")
        org = session.client("organizations")
        info = org.describe_organization()["Organization"]
        if info.get("ManagementAccountId", info.get("MasterAccountId")) != args.management_account:
            raise ValueError("current account is not org management account")
        accounts = org.list_accounts()["Accounts"]
        roots = org.list_roots()["Roots"]
        root_id = roots[0]["Id"]
        ous = org.list_organizational_units_for_parent(ParentId=root_id)["OrganizationalUnits"]
        zones = session.client("controltower").list_landing_zones()["landingZones"]
        existing = [a for a in accounts if a["Name"].lower() == args.identifier.lower() or a.get("Email", "").lower() == args.account_email.lower()]
        if existing:
            errors.append("Name/email already present in organization: review reuse instead of creating account.")
        # Only an OU with a healthy AWSControlTowerBaseline is eligible for Account Factory.
        ctl = session.client("controltower")
        enabled = ctl.list_enabled_baselines()["enabledBaselines"]
        candidates = []
        for unit in ous:
            match = [b for b in enabled if b.get("targetIdentifier", "").endswith("/" + unit["Id"])
                     and b.get("statusSummary", {}).get("status") == "SUCCEEDED"]
            candidates.append({"id": unit["Id"], "name": unit["Name"], "baselineEnabled": bool(match)})
        # Billing credits cannot be reliably validated through this evidence probe.
        budget_response = session.client("budgets", region_name="us-east-1").describe_budgets(AccountId=args.management_account)
        budget_count = len(budget_response.get("Budgets", []))
        if not any(c["baselineEnabled"] and c["name"].lower() not in ("security", "audit", "log archive") for c in candidates):
            errors.append("No verified governed workload OU; create/register a Workloads OU using Control Tower before Account Factory.")
        if budget_count == 0:
            errors.append("No AWS Budgets found; set financial alerts and verify actual credit balance before account provisioning.")
        errors.append("Credit balance and cumulative $80 spend cap require independent owner verification; no automatic hard cap exists.")
        report = {"schemaVersion": 1, "mode": "ACCOUNT_FACTORY_PREPARE_ONLY",
                  "identifier": args.identifier, "region": args.region,
                  "managementAccount": args.management_account, "landingZoneCount": len(zones),
                  "candidateOUs": candidates, "existingAccountMatchCount": len(existing),
                  "budgetCount": budget_count, "accountEmail": args.account_email,
                  "accountFactoryParameters": {"AccountName": args.identifier,
                                               "AccountEmail": args.account_email,
                                               "SSOUserEmail": args.owner_email,
                                               "SSOUserFirstName": args.owner_first_name,
                                               "SSOUserLastName": args.owner_last_name,
                                               "ManagedOrganizationalUnit": "REVIEW_REGISTERED_OU"},
                  "terraformBootstrap": "bootstrap/aws",
                  "roleFamilies": ["DISCOVERY", "STATE", "STATE_WRITE", "APPLY"],
                  "cloudMutation": False, "actEnabled": False,
                  "creditCeilingUsd": 80, "authorizedAdditionalSpendUsd": 0,
                  "decision": "BLOCKED", "blockers": errors,
                  "nextAction": "Authenticate with an IAM Identity Center Account Factory provisioner; register a workload OU; verify actual credits and accept costs before enabling a separately approved account creation workflow."}
    except (ClientError, BotoCoreError, ValueError, KeyError) as exc:
        report = {"decision": "BLOCKED", "mode": "ACCOUNT_FACTORY_PREPARE_ONLY",
                  "error": type(exc).__name__ + ": " + str(exc)[:300], "cloudMutation": False}
    print(json.dumps(report, indent=2, sort_keys=True))
    return 0 if "error" not in report else 2

if __name__ == "__main__":
    sys.exit(main())
