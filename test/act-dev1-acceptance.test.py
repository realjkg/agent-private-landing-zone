"""Synthetic contract drafting and independent AWS read-back; no provider access."""
import importlib.util
from pathlib import Path
import unittest

ROOT=Path(__file__).resolve().parents[1]
def load(name):
    spec=importlib.util.spec_from_file_location(name.replace("-","_"),ROOT/"scripts"/name)
    out=importlib.util.module_from_spec(spec);spec.loader.exec_module(out)
    return out

contract=load("act-dev1-contract-draft.py")
verify=load("act-dev1-verify-canary.py")

ACCOUNT="111111111111"
NAME="/alz/act-dev-1/canary-01"
OWNER="qa"
PEM="-----BEGIN PUBLIC KEY-----\nFAKE_SYNTHETIC_PUBLIC_KEY\n-----END PUBLIC KEY-----\n"

def evidence():
    account={"kind":"ACT_DEV1_ACCOUNT_EVIDENCE","source":"AWS_API_READ_ONLY",
             "memberAccountId":ACCOUNT,"scopeVerified":True,
             "parentOuId":"ou-dnkl-3tbf48bv","baselineStatus":"SUCCEEDED"}
    roles={k:{"trust":"EXACT_SUBJECT_AND_AUDIENCE"} for k in ("DISCOVERY","STATE","STATE_WRITE","APPLY")}
    bootstrap={"kind":"ACT_DEV1_BOOTSTRAP_EVIDENCE","source":"AWS_API_READ_ONLY",
               "memberAccountId":ACCOUNT,"readBackVerified":True,
               "roles":roles,"bucket":"alz-act-dev1-state",
               "boundaryArn":"arn:aws:iam::111111111111:policy/act-dev1-boundary",
               "applyManagedPolicyArn":"arn:aws:iam::111111111111:policy/act-dev1-apply",
               "bucketControls":{"publicAccess":"BLOCKED","versioning":"ENABLED",
                                 "ownership":"BucketOwnerEnforced","encryption":"ENABLED"}}
    return account,bootstrap

class ACTDev1Acceptance(unittest.TestCase):
    def test_dev_contract_draft_stays_disabled_and_pinnable_only_by_owner(self):
        a,b=evidence()
        document=contract.draft(a,b,owner_public_key=PEM,approver_id="alice")
        self.assertFalse(document["enabled"])
        self.assertEqual(document["engine"],"TERRAFORM")
        self.assertEqual(document["enabledEnvironments"],["DEV"])
        self.assertEqual(set(document["targets"]),{"DEV"})
        self.assertEqual(set(document["requiredApprovals"]),{"DEV"})
        self.assertNotIn("pin",document)
        self.assertEqual(document["targets"]["DEV"]["backend"],"alz-act-dev1-state/pilot/dev.tfstate")
    def test_contract_rejects_management_or_cross_account_and_missing_boundary(self):
        a,b=evidence()
        a["memberAccountId"]="973471129135"
        with self.assertRaises(contract.ContractRefusal):contract.draft(a,b,owner_public_key=PEM,approver_id="alice")
        a,b=evidence()
        b["memberAccountId"]="222222222222"
        with self.assertRaisesRegex(contract.ContractRefusal,"BOOTSTRAP_TARGET_MISMATCH"):
            contract.draft(a,b,owner_public_key=PEM,approver_id="alice")
        a,b=evidence();b.pop("boundaryArn")
        with self.assertRaisesRegex(contract.ContractRefusal,"APPLY_SCOPE_POLICY_MISSING"):
            contract.draft(a,b,owner_public_key=PEM,approver_id="alice")
        a,b=evidence()
        with self.assertRaises(contract.ContractRefusal):
            contract.draft(a,b,owner_public_key=PEM,approver_id="alice",state_key="../escape.tfstate")
    def test_cloudwatch_properties_and_identity_bound_to_exact_account(self):
        arn=f"arn:aws:logs:us-east-2:{ACCOUNT}:log-group:{NAME}:*"
        descriptor={"logGroups":[{"logGroupName":NAME,"retentionInDays":30,"arn":arn}]}
        tags={"environment":"DEV","managed-by":"sovereign-alz","purpose":"act-dev-1","owner":OWNER}
        result=verify.validate_log_group(descriptor,tags,name=NAME,owner=OWNER,account=ACCOUNT,region="us-east-2")
        self.assertEqual(result["readBack"],"EXACT_CANARY_OBSERVED")
        self.assertFalse(result["applyIdentityUsed"])
        self.assertEqual(result["cloudtrailMutationCorroboration"],"REQUIRED_SEPARATELY")
        with self.assertRaises(verify.ReadBackRefusal):
            verify.validate_log_group(descriptor,tags,name=NAME,owner=OWNER,account="222222222222",region="us-east-2")
        with self.assertRaises(verify.ReadBackRefusal):
            verify.validate_log_group(descriptor,{**tags,"environment":"PROD"},name=NAME,owner=OWNER,account=ACCOUNT,region="us-east-2")
    def test_independent_discovery_principal_required(self):
        class STS:
            def __init__(self,arn,account=ACCOUNT):self.arn=arn;self.account=account
            def get_caller_identity(self):return {"Account":self.account,"Arn":self.arn}
        class Logs:
            def describe_log_groups(self,**kwargs):
                return {"logGroups":[{"logGroupName":NAME,"retentionInDays":30,
                    "arn":f"arn:aws:logs:us-east-2:{ACCOUNT}:log-group:{NAME}:*"}]}
            def list_tags_for_resource(self,resourceArn):
                return {"tags":{"environment":"DEV","managed-by":"sovereign-alz","purpose":"act-dev-1","owner":OWNER}}
        config={"accountId":ACCOUNT,"region":"us-east-2",
                "identities":{"DISCOVERY":{"roleArn":"arn:aws:iam::111111111111:role/alz-pilot-dev-discovery"}}}
        good=STS("arn:aws:sts::111111111111:assumed-role/alz-pilot-dev-discovery/alz-dev1-resource-readback")
        self.assertEqual(verify.read_with_discovery(good,Logs(),config=config,name=NAME,owner=OWNER)["readBack"],"EXACT_CANARY_OBSERVED")
        apply=STS("arn:aws:sts::111111111111:assumed-role/alz-pilot-dev-apply/readback")
        with self.assertRaisesRegex(verify.ReadBackRefusal,"INDEPENDENT_DISCOVERY_SESSION"):
            verify.read_with_discovery(apply,Logs(),config=config,name=NAME,owner=OWNER)
        wrong=STS(good.arn,"222222222222")
        with self.assertRaises(verify.ReadBackRefusal):
            verify.read_with_discovery(wrong,Logs(),config=config,name=NAME,owner=OWNER)

if __name__=="__main__":unittest.main()
