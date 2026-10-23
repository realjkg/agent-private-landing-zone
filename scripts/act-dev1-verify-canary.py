#!/usr/bin/env python3
"""Independently verify ACT-DEV-1 CloudWatch canary using DISCOVERY OIDC, never APPLY credentials."""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import re
import sys
from datetime import datetime, timezone

EXPECTED={"environment":"DEV","managed-by":"sovereign-alz","purpose":"act-dev-1"}
GROUP=re.compile(r"^/alz/act-dev-1/[a-z0-9][a-z0-9-]{2,48}$")

class ReadBackRefusal(ValueError):pass
def deny(reason):raise ReadBackRefusal(reason)

def validate_log_group(description,tags,*,name,owner,account,region):
    if not GROUP.fullmatch(name) or not isinstance(owner,str) or not owner:
        deny("EXPECTED_CANARY_INVALID")
    observed=description.get("logGroups") if isinstance(description,dict) else None
    if not isinstance(observed,list):
        deny("LOG_GROUP_RESPONSE_INVALID")
    exact=[item for item in observed if item.get("logGroupName")==name]
    if len(exact)!=1:
        deny("CANARY_MISSING_OR_AMBIGUOUS")
    item=exact[0]
    if item.get("retentionInDays")!=30:
        deny("RETENTION_MISMATCH")
    arn=item.get("arn","")
    prefix=f"arn:aws:logs:{region}:{account}:log-group:{name}"
    if not isinstance(arn,str) or arn.removesuffix(":*")!=prefix:
        deny("RESOURCE_ARN_TARGET_MISMATCH")
    expected={**EXPECTED,"owner":owner}
    if not isinstance(tags,dict) or any(tags.get(k)!=v for k,v in expected.items()):
        deny("RESOURCE_TAGS_MISMATCH")
    return {"kind":"ACT_DEV1_INDEPENDENT_RESOURCE_EVIDENCE","source":"AWS_LOGS_READ_ONLY",
            "readBack":"EXACT_CANARY_OBSERVED","accountId":account,"region":region,"name":name,
            "retentionDays":30,"tags":expected,"resourceArn":prefix,
            "applyIdentityUsed":False,"cloudtrailMutationCorroboration":"REQUIRED_SEPARATELY",
            "stateVersionCorroboration":"REQUIRED_SEPARATELY",
            "costEvidence":"DELAYED_BILLING_REQUIRED","actEnabled":False,
            "capturedAt":datetime.now(timezone.utc).isoformat()}

def read_with_discovery(sts,logs,*,config,name,owner):
    account=config.get("accountId")
    discovery=config.get("identities",{}).get("DISCOVERY",{})
    role=discovery.get("roleArn")
    if not isinstance(account,str) or not isinstance(role,str) or not role.startswith(f"arn:aws:iam::{account}:role/"):
        deny("DISCOVERY_ROLE_SCOPE_INVALID")
    caller=sts.get_caller_identity()
    expected="arn:aws:sts::"+account+":assumed-role/"+role.split("/")[-1]+"/"
    if caller.get("Account")!=account or not str(caller.get("Arn","")).startswith(expected):
        deny("INDEPENDENT_DISCOVERY_SESSION_MISMATCH")
    info=logs.describe_log_groups(logGroupNamePrefix=name,limit=50)
    groups=info.get("logGroups",[])
    match=[x for x in groups if x.get("logGroupName")==name]
    if len(match)!=1:
        deny("CANARY_MISSING_OR_AMBIGUOUS")
    arn=match[0].get("arn","").removesuffix(":*")
    tags=logs.list_tags_for_resource(resourceArn=arn).get("tags",{})
    return validate_log_group(info,tags,name=name,owner=owner,account=account,region=config.get("region"))

def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument("--identity-config",required=True)
    p.add_argument("--name",required=True)
    p.add_argument("--owner",required=True)
    p.add_argument("--output",required=True)
    args=p.parse_args()
    try:
        if any(os.environ.get(k) for k in ("AWS_PROFILE","AWS_ACCESS_KEY_ID","AWS_SECRET_ACCESS_KEY","AWS_SESSION_TOKEN")):
            deny("AMBIENT_AWS_IDENTITY_FORBIDDEN")
        config=json.loads(Path(args.identity_config).read_text())
        # Reuse the same strict token checks and STS validation as D4; never print or save raw token material.
        location=Path(__file__).with_name("act-dev1-identity.py")
        spec=importlib.util.spec_from_file_location("act_dev1_oidc",location)
        identity=importlib.util.module_from_spec(spec);spec.loader.exec_module(identity)
        import boto3
        from botocore import UNSIGNED
        from botocore.config import Config
        factory=lambda role:boto3.client("sts",region_name="us-east-2",config=Config(signature_version=UNSIGNED))
        verified=identity.validate(config,sts_factory=factory)
        if not verified.get("verified"):
            deny("STS_IDENTITY_NOT_VERIFIED")
        token=Path(config["identities"]["DISCOVERY"]["tokenFile"]).read_text().strip()
        assumed=factory("DISCOVERY").assume_role_with_web_identity(
            RoleArn=config["identities"]["DISCOVERY"]["roleArn"],
            RoleSessionName="alz-dev1-resource-readback",WebIdentityToken=token,DurationSeconds=900)
        creds=assumed["Credentials"]
        client_args={"region_name":config["region"],"aws_access_key_id":creds["AccessKeyId"],
                     "aws_secret_access_key":creds["SecretAccessKey"],"aws_session_token":creds["SessionToken"]}
        report=read_with_discovery(boto3.client("sts",**client_args),
                                   boto3.client("logs",**client_args),
                                   config=config,name=args.name,owner=args.owner)
        target=Path(args.output);target.parent.mkdir(parents=True,exist_ok=True)
        target.write_text(json.dumps(report,indent=2)+"\n");target.chmod(0o600)
        print("ACT-DEV-1 independent AWS canary read-back VERIFIED; CloudTrail/state/cost checks still required")
        return 0
    except (ReadBackRefusal,ValueError,OSError,KeyError) as error:
        print("ACT-DEV-1 canary read-back BLOCKED:",str(error) if isinstance(error,ReadBackRefusal) else type(error).__name__,file=sys.stderr)
        return 2
if __name__=="__main__":raise SystemExit(main())
