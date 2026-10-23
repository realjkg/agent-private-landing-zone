#!/usr/bin/env python3
"""Read-only AWS Organizations SCP/RCP evidence for brownfield ALZ planning."""
import argparse
import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path

def collect(client, account):
    lineage = [account]
    current = account
    for _ in range(12):
        parents = client.list_parents(ChildId=current).get("Parents", [])
        if len(parents) != 1:
            break
        parent = parents[0]["Id"]
        lineage.append(parent)
        if parent.startswith("r-"):
            break
        current = parent
    surfaces = {}
    for kind in ("SERVICE_CONTROL_POLICY", "RESOURCE_CONTROL_POLICY"):
        records = []
        for target in lineage:
            try:
                pages = client.get_paginator("list_policies_for_target").paginate(
                    TargetId=target, Filter=kind)
                for page in pages:
                    for item in page.get("Policies", []):
                        desc = client.describe_policy(PolicyId=item["Id"])["Policy"]
                        body = desc["Content"]
                        parsed = json.loads(body)
                        records.append({
                            "targetId":target,"policyId":item["Id"],
                            "name":item["Name"],"type":kind,
                            "contentSha256":hashlib.sha256(body.encode()).hexdigest(),
                            "document":parsed})
            except client.exceptions.PolicyTypeNotEnabledException:
                surfaces[kind] = {"status":"NOT_ENABLED","policies":[]}
                break
        else:
            surfaces[kind] = {"status":"DISCOVERED" if records else "NONE_ATTACHED",
                              "policies":records}
    return {"schemaVersion":1,"mode":"READ_ONLY","accountId":account,
            "capturedAt":datetime.now(timezone.utc).isoformat(),
            "scopeChain":lineage,"governance":{
                "scp":surfaces["SERVICE_CONTROL_POLICY"],
                "rcp":surfaces["RESOURCE_CONTROL_POLICY"],
                "opa":{"status":"UNKNOWN","note":"OPA must be collected from its own policy store; AWS evidence is not equivalent."}},
            "evaluationStatus":"NOT_EVALUATED","infrastructureAct":"DISABLED"}

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--account-id",required=True)
    parser.add_argument("--profile",default=None)
    parser.add_argument("--output",required=True)
    args = parser.parse_args()
    if not (len(args.account_id)==12 and args.account_id.isdigit()):
        parser.error("account-id must contain 12 digits")
    import boto3
    session=boto3.Session(profile_name=args.profile)
    identity=session.client("sts").get_caller_identity()
    org=session.client("organizations")
    # The caller must be management-account authorized for organization-wide reads.
    result=collect(org,args.account_id)
    result["collectorAccountId"]=identity["Account"]
    destination=Path(args.output)
    destination.parent.mkdir(parents=True,exist_ok=True)
    destination.write_text(json.dumps(result,indent=2,sort_keys=True)+"\n")
    print(f"Read-only policy evidence saved: {destination}")
    print("SCP:",result["governance"]["scp"]["status"],"RCP:",result["governance"]["rcp"]["status"])
    print("Enforcement evaluation: NOT_EVALUATED; policy text is sensitive.")
if __name__=="__main__":
    main()
