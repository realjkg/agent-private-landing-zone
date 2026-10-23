#!/usr/bin/env python3
"""ACT-DEV-1 authenticated AWS read-only inventory; bootstrap and finance gates."""
import argparse
import hashlib
import json
import re
from datetime import datetime, timezone
from pathlib import Path
import sys

ROLES=("DISCOVERY","STATE","STATE_WRITE","APPLY")
BASELINE="arn:aws:controltower:us-east-2::baseline/17BSJV3IGJ2QSGA2"
MANAGEMENT="973471129135"
OU="ou-dnkl-3tbf48bv"
REGION="us-east-2"

class ReadinessRefusal(ValueError):
    pass

def deny(reason):
    raise ReadinessRefusal(reason)

def account_inspection(org,controltower,sts,*,account_id,ou_id=OU,management_id=MANAGEMENT):
    if not isinstance(account_id,str) or not re.fullmatch(r"\d{12}",account_id) or account_id==management_id:
        deny("DEDICATED_MEMBER_ACCOUNT_REQUIRED")
    caller=sts.get_caller_identity()["Account"]
    if caller!=management_id:
        deny("MANAGEMENT_READ_SESSION_REQUIRED")
    account=org.describe_account(AccountId=account_id)["Account"]
    parents=org.list_parents(ChildId=account_id)["Parents"]
    if account.get("Status",account.get("State")) not in ("ACTIVE",):
        deny("ACCOUNT_NOT_ACTIVE")
    if not any(p.get("Id")==ou_id and p.get("Type")=="ORGANIZATIONAL_UNIT" for p in parents):
        deny("ACCOUNT_NOT_IN_WORKLOAD_OU")
    ou=org.describe_organizational_unit(OrganizationalUnitId=ou_id)["OrganizationalUnit"]
    matched=False
    pages=controltower.get_paginator("list_enabled_baselines").paginate()
    for page in pages:
        for item in page.get("enabledBaselines",[]):
            if (item.get("baselineIdentifier")==BASELINE and
                item.get("targetIdentifier")==ou["Arn"] and
                item.get("statusSummary",{}).get("status")=="SUCCEEDED"):
                matched=True
    if not matched:
        deny("WORKLOAD_OU_BASELINE_UNVERIFIED")
    return {"kind":"ACT_DEV1_ACCOUNT_EVIDENCE","source":"AWS_API_READ_ONLY",
            "memberAccountId":account_id,"accountState":"ACTIVE","parentOuId":ou_id,
            "baselineStatus":"SUCCEEDED","managementAccountId":caller,
            "capturedAt":datetime.now(timezone.utc).isoformat(),
            "scopeVerified":True,"actEnabled":False}

def exact_trust(document, *, issuer, audience, subject, account_id):
    statements=document.get("Statement",[]) if isinstance(document,dict) else []
    if isinstance(statements,dict):
        statements=[statements]
    expected_provider="arn:aws:iam::"+account_id+":oidc-provider/"+issuer
    allowed=[]
    for stmt in statements:
        if not isinstance(stmt,dict) or stmt.get("Effect")!="Allow":
            continue
        acts=stmt.get("Action",[])
        if isinstance(acts,str): acts=[acts]
        if "sts:AssumeRoleWithWebIdentity" not in acts and "sts:*" not in acts and "*" not in acts:
            continue
        # Require precisely one permitted web-identity route; a broader parallel trust is not safe.
        principal=stmt.get("Principal",{})
        federated=principal.get("Federated") if isinstance(principal,dict) else None
        conditions=stmt.get("Condition",{})
        expected_conditions={"StringEquals":{issuer+":sub":subject,issuer+":aud":audience}}
        if (acts != ["sts:AssumeRoleWithWebIdentity"] or federated!=expected_provider
            or conditions!=expected_conditions):
            return False
        allowed.append(stmt)
    return len(allowed)==1

def state_policy_valid(document, *, bucket, key, roles):
    statements=document.get("Statement",[]) if isinstance(document,dict) else []
    if not isinstance(statements,list):return False
    indexed={x.get("Sid"):x for x in statements if isinstance(x,dict)}
    def denied(name):
        s=indexed.get(name,{})
        return s.get("Effect")=="Deny"
    if not all(denied(k) for k in ("DenyInsecureTransport","DenyEveryoneElse",
                                    "StateCannotWriteState","StateWriteCannotDeleteVersions")):
        return False
    tls=indexed["DenyInsecureTransport"]
    if tls.get("Condition",{}).get("Bool",{}).get("aws:SecureTransport") not in ("false",False):
        return False
    everyone=indexed["DenyEveryoneElse"]
    exemptions=everyone.get("Condition",{}).get("ArnNotLike",{}).get("aws:PrincipalArn",[])
    if isinstance(exemptions,str):exemptions=[exemptions]
    if roles["STATE"] not in exemptions or roles["STATE_WRITE"] not in exemptions:
        return False
    state=indexed["StateCannotWriteState"]
    not_resources=state.get("NotResource",[])
    if isinstance(not_resources,str):not_resources=[not_resources]
    if f"arn:aws:s3:::{bucket}/{key}.tflock" not in not_resources:
        # Nonstandard keys require independent review; never infer a matching lock.
        return False
    if state.get("Principal",{}).get("AWS")!=roles["STATE"]:
        return False
    no_versions=indexed["StateWriteCannotDeleteVersions"]
    if no_versions.get("Principal",{}).get("AWS")!=roles["STATE_WRITE"]:
        return False
    return True

def dev_bootstrap_inspection(iam,s3,sts,*,account_id,bucket,subjects,state_key="pilot/dev.tfstate",issuer="token.actions.githubusercontent.com",audience="sts.amazonaws.com",role_prefix="alz-pilot-dev"):
    if not re.fullmatch(r"\d{12}",str(account_id)) or sts.get_caller_identity()["Account"]!=account_id or account_id==MANAGEMENT:
        deny("DEV_MEMBER_IDENTITY_MISMATCH")
    if not isinstance(subjects,dict) or set(subjects)!=set(ROLES) or len(set(subjects.values()))!=4:
        deny("FOUR_DISTINCT_OIDC_SUBJECTS_REQUIRED")
    roles={}
    for identity in ROLES:
        name=role_prefix+"-"+identity.lower().replace("_","-")
        data=iam.get_role(RoleName=name)["Role"]
        arn=data["Arn"]
        if arn!="arn:aws:iam::"+account_id+":role/"+name:
            deny("ROLE_ARN_MISMATCH")
        if not exact_trust(data["AssumeRolePolicyDocument"],issuer=issuer,audience=audience,subject=subjects[identity],account_id=account_id):
            deny("OIDC_TRUST_MISMATCH_"+identity)
        roles[identity]={"roleArn":arn,"subject":subjects[identity],"trust":"EXACT_SUBJECT_AND_AUDIENCE"}
    if len({x["roleArn"] for x in roles.values()})!=4:
        deny("ROLE_COLLAPSE")
    pab=s3.get_public_access_block(Bucket=bucket)["PublicAccessBlockConfiguration"]
    if any(pab.get(k) is not True for k in ("BlockPublicAcls","IgnorePublicAcls","BlockPublicPolicy","RestrictPublicBuckets")):
        deny("S3_PUBLIC_ACCESS_BLOCK_INCOMPLETE")
    if s3.get_bucket_versioning(Bucket=bucket).get("Status")!="Enabled":
        deny("STATE_VERSIONING_DISABLED")
    own=s3.get_bucket_ownership_controls(Bucket=bucket)["OwnershipControls"]["Rules"]
    if not any(r.get("ObjectOwnership")=="BucketOwnerEnforced" for r in own):
        deny("STATE_OWNERSHIP_UNVERIFIED")
    enc=s3.get_bucket_encryption(Bucket=bucket)["ServerSideEncryptionConfiguration"]["Rules"]
    if not any(r.get("ApplyServerSideEncryptionByDefault",{}).get("SSEAlgorithm") in ("AES256","aws:kms") for r in enc):
        deny("STATE_ENCRYPTION_UNVERIFIED")
    policy=s3.get_bucket_policy(Bucket=bucket)["Policy"]
    data=json.loads(policy)
    if not state_policy_valid(data,bucket=bucket,key=state_key,roles={k:v["roleArn"] for k,v in roles.items()}):
        deny("STATE_BUCKET_POLICY_INCOMPLETE")
    return {"kind":"ACT_DEV1_BOOTSTRAP_EVIDENCE","source":"AWS_API_READ_ONLY",
            "memberAccountId":account_id,"bucket":bucket,"roles":roles,
            "bucketControls":{"publicAccess":"BLOCKED","versioning":"ENABLED","ownership":"BucketOwnerEnforced",
                              "encryption":"ENABLED","policyFingerprintSha256":hashlib.sha256(policy.encode()).hexdigest()},
            "readBackVerified":True,"effectiveDeniedActions":"NOT_TESTED",
            "capturedAt":datetime.now(timezone.utc).isoformat(),"actEnabled":False}

def budget_inspection(budgets,*,account_id):
    all_budgets=[]
    for page in budgets.get_paginator("describe_budgets").paginate(AccountId=account_id):
        for item in page.get("Budgets",[]):
            name=item["BudgetName"]
            notices=budgets.describe_notifications_for_budget(AccountId=account_id,BudgetName=name).get("Notifications",[])
            all_budgets.append({"name":name,"type":item.get("BudgetType"),
                               "monthlyUsd":item.get("BudgetLimit",{}).get("Amount"),
                               "notificationCount":len(notices),
                               "hasActualAlert":any(x.get("NotificationType")=="ACTUAL" for x in notices)})
    return {"kind":"ACT_DEV1_BUDGET_EVIDENCE","source":"AWS_BUDGETS_READ_ONLY",
            "memberAccountId":account_id,"budgetCount":len(all_budgets),"budgets":all_budgets,
            "alertSubscribersVerified":False,"creditBalanceVerified":False,"hardSpendCap":False,
            "capturedAt":datetime.now(timezone.utc).isoformat(),
            "actEnabled":False}

def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument("--phase",choices=("account","bootstrap","budget"),required=True)
    p.add_argument("--profile",required=True)
    p.add_argument("--dev-account",required=True)
    p.add_argument("--ou-id",default=OU)
    p.add_argument("--bucket")
    p.add_argument("--state-key",default="pilot/dev.tfstate")
    p.add_argument("--oidc-subjects-file",help="JSON map of four exact observed OIDC subjects")
    p.add_argument("--output",required=True)
    a=p.parse_args()
    try:
        import boto3
        session=boto3.Session(profile_name=a.profile,region_name=REGION)
        sts=session.client("sts")
        if a.phase=="account":
            result=account_inspection(session.client("organizations"),session.client("controltower"),sts,
                                      account_id=a.dev_account,ou_id=a.ou_id)
        elif a.phase=="bootstrap":
            if not a.bucket or not a.oidc_subjects_file:
                deny("BUCKET_AND_OIDC_SUBJECTS_REQUIRED")
            result=dev_bootstrap_inspection(session.client("iam"),session.client("s3"),sts,
                                            account_id=a.dev_account,bucket=a.bucket,state_key=a.state_key,
                                            subjects=json.loads(Path(a.oidc_subjects_file).read_text()))
        else:
            if sts.get_caller_identity()["Account"] != MANAGEMENT:
                deny("MANAGEMENT_BILLING_SESSION_REQUIRED")
            result=budget_inspection(session.client("budgets",region_name="us-east-1"),account_id=a.dev_account)
        out=Path(a.output)
        out.parent.mkdir(parents=True,exist_ok=True)
        out.write_text(json.dumps(result,indent=2,sort_keys=True)+"\n")
        out.chmod(0o600)
        print("ACT-DEV-1",a.phase,"AWS read-back collected; no mutation; independent acceptance still required")
        return 0
    except Exception as exc:
        print("ACT-DEV-1 evidence BLOCKED:",str(exc) if isinstance(exc,ReadinessRefusal) else type(exc).__name__,file=sys.stderr)
        return 2
if __name__=="__main__":
    raise SystemExit(main())
