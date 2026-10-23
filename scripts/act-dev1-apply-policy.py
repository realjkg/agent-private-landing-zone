#!/usr/bin/env python3
"""Generate a reviewed, narrowly scoped IAM APPLY allowlist for a single log-group canary."""
import argparse
import json
from pathlib import Path
import re

ACCOUNT=re.compile(r"^[0-9]{12}$")
GROUP=re.compile(r"^/alz/act-dev-1/[a-z0-9][a-z0-9-]{2,48}$")
OWNER=re.compile(r"^[A-Za-z0-9._@+-]{1,80}$")

def build(account,group,owner):
    if not isinstance(account,str) or not ACCOUNT.fullmatch(account) or account=="973471129135":
        raise ValueError("DEDICATED_DEV_ACCOUNT_REQUIRED")
    if not isinstance(group,str) or not GROUP.fullmatch(group):
        raise ValueError("CANARY_NAME_INVALID")
    if not isinstance(owner,str) or not OWNER.fullmatch(owner):
        raise ValueError("OWNER_INVALID")
    arn=f"arn:aws:logs:us-east-2:{account}:log-group:{group}"
    tags={"aws:RequestTag/environment":"DEV","aws:RequestTag/managed-by":"sovereign-alz",
          "aws:RequestTag/purpose":"act-dev-1","aws:RequestTag/owner":owner}
    return {
      "Version":"2012-10-17",
      "Statement":[
        {"Sid":"AllowCanaryCreateWithReviewedTags","Effect":"Allow",
         "Action":["logs:CreateLogGroup","logs:TagResource"],
         "Resource":arn,
         "Condition":{"StringEquals":{"aws:RequestedRegion":"us-east-2",**tags},
                      "ForAllValues:StringEquals":{"aws:TagKeys":["environment","managed-by","purpose","owner"]}}},
        {"Sid":"AllowCanaryRetentionAndReadback","Effect":"Allow",
         "Action":["logs:PutRetentionPolicy","logs:ListTagsForResource"],
         "Resource":arn,
         "Condition":{"StringEquals":{"aws:RequestedRegion":"us-east-2"}}},
        {"Sid":"AllowDescribeForTerraformOnly","Effect":"Allow",
         "Action":"logs:DescribeLogGroups","Resource":"*",
         "Condition":{"StringEquals":{"aws:RequestedRegion":"us-east-2"}}},
        {"Sid":"DenyCanaryDeleteAndUntags","Effect":"Deny",
         "Action":["logs:DeleteLogGroup","logs:DeleteRetentionPolicy","logs:UntagResource","logs:UntagLogGroup"],
         "Resource":"*"},
        {"Sid":"DenyBootstrapModificationAndStateByApply","Effect":"Deny",
         "Action":["iam:*","s3:*","organizations:*","controltower:*"],"Resource":"*"}
      ]
    }

def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument("--dev-account",required=True)
    p.add_argument("--log-group",required=True)
    p.add_argument("--owner",required=True)
    p.add_argument("--output",required=True)
    args=p.parse_args()
    try:
        value=build(args.dev_account,args.log_group,args.owner)
    except ValueError as exc:
        p.error(str(exc))
    out=Path(args.output);out.parent.mkdir(parents=True,exist_ok=True)
    out.write_text(json.dumps(value,indent=2)+"\n")
    out.chmod(0o600)
    print("IAM policy candidate saved for independent review:",out,
          "| no IAM write, no ACT enable, no account changes")
if __name__=="__main__":main()
