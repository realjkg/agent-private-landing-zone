#!/usr/bin/env python3
"""AWS customer-zero evidence intake: read-only. Requires boto3 and current AWS credentials."""
import argparse
import json
import re
import sys

try:
    import boto3
    from botocore.exceptions import BotoCoreError, ClientError
except ImportError:
    print("BLOCKED: boto3 is required (available in AWS CloudShell).", file=sys.stderr)
    raise SystemExit(2)


def call(label, fn):
    try:
        return {"status": "OK", "data": fn()}
    except (BotoCoreError, ClientError, ValueError, KeyError) as exc:
        return {"status": "BLOCKED", "error": type(exc).__name__ + ": " + str(exc)[:240]}


def main():
    ap = argparse.ArgumentParser(description="Read-only AWS ALZ readiness evidence; never provisions resources")
    ap.add_argument("--identifier", default="adaptcloud-dev")
    ap.add_argument("--region", default="us-east-2")
    ap.add_argument("--expected-management-account", default="973471129135")
    args = ap.parse_args()
    if not re.fullmatch(r"[a-z][a-z0-9-]{2,40}", args.identifier):
        ap.error("identifier must be lowercase, 3-40 characters, alphanumeric and hyphens")
    if not re.fullmatch(r"\d{12}", args.expected_management_account):
        ap.error("management account must be a 12-digit AWS account ID")
    sess = boto3.session.Session(region_name=args.region)
    sts = call("identity", lambda: sess.client("sts").get_caller_identity())
    if sts["status"] != "OK":
        print(json.dumps({"decision": "BLOCKED", "identity": sts}, indent=2))
        return 2
    account = sts["data"]["Account"]
    principal = sts["data"]["Arn"]
    if account != args.expected_management_account:
        print(json.dumps({"decision": "BLOCKED", "reason": "Unexpected AWS account; no discovery performed", "account": account}, indent=2))
        return 2
    org = call("organization", lambda: sess.client("organizations").describe_organization()["Organization"])
    accounts = call("accounts", lambda: sess.client("organizations").list_accounts()["Accounts"])
    ct = sess.client("controltower", region_name=args.region)
    zones = call("landing_zones", lambda: ct.list_landing_zones()["landingZones"])
    summaries = []
    if zones["status"] == "OK":
        for entry in zones["data"]:
            arn = entry["arn"]
            detail = call("landing_zone", lambda arn=arn: ct.get_landing_zone(landingZoneIdentifier=arn)["landingZone"])
            if detail["status"] == "OK":
                z = detail["data"]
                summaries.append({"arn": arn, "status": z.get("status"), "version": z.get("version"),
                                  "drift": z.get("driftStatus", {}).get("status")})
            else:
                summaries.append({"arn": arn, "error": detail["error"]})
    baseline = call("enabled_baselines", lambda: ct.list_enabled_baselines()["enabledBaselines"])
    root = call("root", lambda: sess.client("organizations").list_roots()["Roots"][0]["Id"])
    ous = call("organizational_units", lambda: sess.client("organizations").list_organizational_units_for_parent(ParentId=root["data"])["OrganizationalUnits"]) if root["status"] == "OK" else {"status": "BLOCKED", "error": "Cannot list root"}
    oidc = call("oidc", lambda: sess.client("iam").list_open_id_connect_providers()["OpenIDConnectProviderList"])
    budgets = call("budgets", lambda: sess.client("budgets", region_name="us-east-1").describe_budgets(AccountId=account).get("Budgets", []))
    orgid = org["data"].get("Id") if org["status"] == "OK" else None
    management = org["data"].get("ManagementAccountId", org["data"].get("MasterAccountId")) if org["status"] == "OK" else None
    member_count = len([a for a in accounts["data"] if a["Id"] != account]) if accounts["status"] == "OK" else None
    healthy_zone = bool(summaries) and all(z.get("status") == "ACTIVE" and z.get("drift") == "IN_SYNC" for z in summaries)
    result = {
        "schemaVersion": 1, "scope": "PLAN_ONLY_READ_ONLY", "identifier": args.identifier,
        "cloudMutation": False, "actEnabled": False, "authorizedAdditionalSpendUsd": 0,
        "cumulativePilotCreditCeilingUsd": 80,
        "caller": {"account": account, "principalType": "ROOT" if principal.endswith(":root") else "ROLE_OR_USER"},
        "organization": {"status": org["status"], "id": orgid, "managementAccount": management},
        "memberAccountCount": member_count,
        "landingZones": summaries, "landingZoneListing": zones["status"],
        "enabledBaselines": {"status": baseline["status"], "targets": [
            {"target": b.get("targetIdentifier"), "state": b.get("statusSummary", {}).get("status")}
            for b in baseline.get("data", [])]},
        "organizationalUnits": {"status": ous["status"], "items": [
            {"name": u["Name"], "id": u["Id"]} for u in ous.get("data", [])]},
        "oidcProviderCount": len(oidc["data"]) if oidc["status"] == "OK" else None,
        "budgetCount": len(budgets["data"]) if budgets["status"] == "OK" else None,
        "creditEligibility": "NOT_VERIFIED",
        "creditCeilingHardStop": "NOT_AVAILABLE_IN_AWS_BUDGETS",
        "decision": "BLOCKED",
        "nextAction": "Review source account/Control Tower, verify AWS billing credits, and approve a separate DEV member account; never deploy workloads in the management account.",
        "checks": {
            "managementAccountVerified": org["status"] == "OK" and management == account,
            "controlTowerActiveInSync": healthy_zone,
            "separateDevAccountAvailable": bool(member_count),
            "financialHardCapVerified": False
        }
    }
    # Prevent silent success when evidence sources are unavailable.
    result["sourceErrors"] = {k: v["error"] for k, v in
        (("organization", org), ("accounts", accounts), ("landing_zones", zones),
         ("enabled_baselines", baseline), ("organizational_units", ous), ("oidc", oidc),
         ("budgets", budgets)) if v["status"] == "BLOCKED"}
    print(json.dumps(result, indent=2, sort_keys=True))
    return 0 if all(v == "OK" for v in [org["status"], accounts["status"], zones["status"],
                                        baseline["status"], ous["status"], oidc["status"], budgets["status"]]) else 2


if __name__ == "__main__":
    sys.exit(main())
