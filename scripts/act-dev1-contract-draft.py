#!/usr/bin/env python3
"""Prepare a disabled, DEV-only AWS ACT contract draft from read-only cloud evidence.

The draft binds STATE_WRITE for the state backend (embedStateWrite true, required for every Terraform contract since owner
decision 6486426552), names the committed one-resource canary as the target's allowlist, and carries no authorize entry: ACT
stays disabled until the owner adds one by hand in a reviewed commit of the contract (docs/act-pilot-apply.md)."""
import argparse
import json
from pathlib import Path
import re
import sys

ACCOUNT=re.compile(r"^[0-9]{12}$")
BUCKET=re.compile(r"^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$")
KEY=re.compile(r"^[a-zA-Z0-9._/-]{1,512}$")
APPROVER=re.compile(r"^[A-Za-z0-9._@+-]{1,64}$")
REQUIRED_ROLES={"DISCOVERY","STATE","STATE_WRITE","APPLY"}

class ContractRefusal(ValueError): pass
def deny(code):raise ContractRefusal(code)

def draft(account,bootstrap,*,owner_public_key,approver_id,state_key="pilot/dev.tfstate",kill_switch=".runs/apply/KILL"):
    if not isinstance(account,dict) or account.get("kind")!="ACT_DEV1_ACCOUNT_EVIDENCE" or account.get("source")!="AWS_API_READ_ONLY":
        deny("ACCOUNT_EVIDENCE_INVALID")
    member=account.get("memberAccountId")
    if not isinstance(member,str) or not ACCOUNT.fullmatch(member) or member=="973471129135" or not account.get("scopeVerified"):
        deny("ACCOUNT_NOT_VERIFIED")
    if account.get("parentOuId")!="ou-dnkl-3tbf48bv" or account.get("baselineStatus")!="SUCCEEDED":
        deny("GOVERNED_OU_UNVERIFIED")
    if not isinstance(bootstrap,dict) or bootstrap.get("kind")!="ACT_DEV1_BOOTSTRAP_EVIDENCE" or bootstrap.get("source")!="AWS_API_READ_ONLY":
        deny("BOOTSTRAP_EVIDENCE_INVALID")
    if bootstrap.get("memberAccountId")!=member or not bootstrap.get("readBackVerified"):
        deny("BOOTSTRAP_TARGET_MISMATCH")
    roles=bootstrap.get("roles")
    if not isinstance(roles,dict) or set(roles)!=REQUIRED_ROLES or not all(
        isinstance(roles[k],dict) and roles[k].get("trust")=="EXACT_SUBJECT_AND_AUDIENCE" for k in REQUIRED_ROLES):
        deny("FOUR_BOOTSTRAP_ROLES_UNVERIFIED")
    if not bootstrap.get("boundaryArn") or not bootstrap.get("applyManagedPolicyArn"):
        deny("APPLY_SCOPE_POLICY_MISSING")
    bucket=bootstrap.get("bucket")
    if not isinstance(bucket,str) or not BUCKET.fullmatch(bucket) or not KEY.fullmatch(state_key) or ".." in state_key.split("/"):
        deny("BACKEND_KEY_INVALID")
    control=bootstrap.get("bucketControls",{})
    if (control.get("versioning")!="ENABLED" or control.get("ownership")!="BucketOwnerEnforced"
        or control.get("encryption")!="ENABLED" or control.get("publicAccess")!="BLOCKED"):
        deny("BACKEND_CONTROLS_MISSING")
    if not isinstance(approver_id,str) or not APPROVER.fullmatch(approver_id):
        deny("APPROVER_ID_INVALID")
    if not isinstance(owner_public_key,str) or "-----BEGIN PUBLIC KEY-----" not in owner_public_key or "-----END PUBLIC KEY-----" not in owner_public_key:
        deny("APPROVER_PUBLIC_KEY_MISSING")
    if not isinstance(kill_switch,str) or not kill_switch.startswith(".runs/apply/") or len(kill_switch)>512 or ".." in kill_switch:
        deny("KILL_SWITCH_PATH_INVALID")
    return {"schemaVersion":1,"enabled":False,"provider":"AWS","engine":"TERRAFORM",
            "enabledEnvironments":["DEV"],
            "targets":{"DEV":{"accountId":member,"region":"us-east-2","backend":bucket+"/"+state_key,"workspace":"default",
                              "canary":{"resources":[{"type":"aws_cloudwatch_log_group","count":1}]}}},
            "requiredApprovals":{"DEV":1},"maxApprovalAgeMinutes":30,
            "approvers":[{"id":approver_id,"publicKeyPem":owner_public_key,"environments":["DEV"]}],
            "killSwitchPath":kill_switch,"embedStateWrite":True}

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--account-evidence",required=True)
    parser.add_argument("--bootstrap-evidence",required=True)
    parser.add_argument("--approver-id",required=True)
    parser.add_argument("--public-key-file",required=True,help="Ed25519 public PEM; private key stays with its owner")
    parser.add_argument("--state-key",default="pilot/dev.tfstate")
    parser.add_argument("--output",required=True)
    args=parser.parse_args()
    try:
        contract=draft(json.loads(Path(args.account_evidence).read_text()),
                       json.loads(Path(args.bootstrap_evidence).read_text()),
                       owner_public_key=Path(args.public_key_file).read_text(),
                       approver_id=args.approver_id,state_key=args.state_key)
        dest=Path(args.output);dest.parent.mkdir(parents=True,exist_ok=True)
        dest.write_text(json.dumps(contract,indent=2)+"\n")
        dest.chmod(0o600)
        print("DEV-only contract DRAFT generated:",dest,"| enabled false | no authorize entry, so ACT stays disabled | no cloud writes")
        return 0
    except (ContractRefusal,ValueError,OSError) as error:
        print("DEV contract draft BLOCKED:",str(error) if isinstance(error,ContractRefusal) else type(error).__name__,file=sys.stderr)
        return 2
if __name__=="__main__":raise SystemExit(main())
