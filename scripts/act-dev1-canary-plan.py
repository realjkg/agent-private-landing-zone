#!/usr/bin/env python3
"""Strict offline validation of the one-create AWS ACT-DEV-1 Terraform canary."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import sys

LOG_GROUP = re.compile(r"^/alz/act-dev-1/[a-z0-9][a-z0-9-]{2,48}$")
REGION = "us-east-2"
REQUIRED_TAGS = {"environment":"DEV", "managed-by":"sovereign-alz", "purpose":"act-dev-1"}

class CanaryRefusal(ValueError):
    pass

def reject(reason):
    raise CanaryRefusal(reason)

def validate(plan, *, expected_name, expected_owner):
    if not isinstance(plan,dict) or plan.get("format_version") is None:
        reject("TERRAFORM_PLAN_FORMAT_MISSING")
    if not LOG_GROUP.fullmatch(expected_name) or not isinstance(expected_owner,str) or not re.fullmatch(r"[A-Za-z0-9._@+-]{1,80}",expected_owner):
        reject("EXPECTED_RESOURCE_INVALID")
    changes=plan.get("resource_changes")
    if not isinstance(changes,list) or len(changes)!=1:
        reject("EXACTLY_ONE_RESOURCE_REQUIRED")
    item=changes[0]
    change=item.get("change",{}) if isinstance(item,dict) else {}
    if (item.get("mode")!="managed" or item.get("type")!="aws_cloudwatch_log_group"
        or not isinstance(item.get("address"),str) or change.get("actions")!=["create"]
        or change.get("before") is not None or change.get("replace_paths")):
        reject("CANARY_MUST_BE_ADDITIVE_LOG_GROUP")
    after=change.get("after")
    if not isinstance(after,dict) or after.get("name")!=expected_name or after.get("retention_in_days")!=30:
        reject("CANARY_PROPERTIES_MISMATCH")
    tags=after.get("tags")
    if not isinstance(tags,dict) or any(tags.get(k)!=v for k,v in REQUIRED_TAGS.items()) or tags.get("owner")!=expected_owner:
        reject("CANARY_TAGS_INVALID")
    unknown=change.get("after_unknown",{})
    if not isinstance(unknown,dict) or any(unknown.get(field) for field in ("name","retention_in_days","tags")):
        reject("CANARY_VALUES_UNKNOWN")
    if plan.get("resource_drift") or plan.get("output_changes"):
        reject("DRIFT_OR_OUTPUT_CHANGE_UNREVIEWED")
    planned=plan.get("planned_values",{}).get("root_module",{}).get("resources",[])
    if not isinstance(planned,list) or len(planned)!=1 or planned[0].get("address")!=item["address"]:
        reject("PLANNED_VALUES_MISMATCH")
    values=planned[0].get("values")
    if not isinstance(values,dict) or any(values.get(field)!=after.get(field) for field in ("name","retention_in_days","tags")):
        reject("PLANNED_RESOURCE_PROPERTIES_MISMATCH")
    config=plan.get("configuration",{})
    provider=config.get("provider_config",{}) if isinstance(config,dict) else {}
    aws=provider.get("aws") if isinstance(provider,dict) else None
    region=aws.get("expressions",{}).get("region",{}).get("constant_value") if isinstance(aws,dict) else None
    variables=plan.get("variables",{})
    if region is None and isinstance(variables,dict):
        region=variables.get("region",{}).get("value")
    if region!=REGION:
        reject("REGION_NOT_BOUND_IN_PLAN")
    # A review of the real plan alone does not attest account/permissions or backend.
    return {"kind":"ACT_DEV1_CANARY_PLAN","schemaVersion":1,"verdict":"STRUCTURALLY_ACCEPTABLE",
            "mode":"PLAN_ONLY","resource":expected_name,"owner":expected_owner,
            "region":REGION,"action":"CREATE","resourceType":"aws_cloudwatch_log_group",
            "state":"NOT_APPLIED","infrastructureAct":"DISABLED",
            "requires":["EXACT_BACKEND_CONTRACT","LIVE_TARGET_IDENTITY","HUMAN_SIGNATURE","CLOUD_READBACK"]}

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--plan-json",required=True,help="Local terraform show -json file, not Terraform plan binary")
    parser.add_argument("--name",required=True)
    parser.add_argument("--owner",required=True)
    parser.add_argument("--output",required=True)
    args=parser.parse_args()
    try:
        path=Path(args.plan_json)
        body=path.read_bytes()
        report=validate(json.loads(body),expected_name=args.name,expected_owner=args.owner)
        report["planJsonSha256"]=hashlib.sha256(body).hexdigest()
        dst=Path(args.output)
        dst.parent.mkdir(parents=True,exist_ok=True)
        dst.write_text(json.dumps(report,indent=2)+"\n")
        print("CANARY PLAN STRUCTURE: ACCEPTABLE | ACT: DISABLED | CLOUD AUTHORITY: NOT ATTESTED")
        return 0
    except (CanaryRefusal,ValueError,OSError,TypeError) as ex:
        print("CANARY PLAN BLOCKED:",str(ex) if isinstance(ex,CanaryRefusal) else type(ex).__name__,file=sys.stderr)
        return 2
if __name__=="__main__":
    raise SystemExit(main())
