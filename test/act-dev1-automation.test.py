"""Synthetic ACT-DEV-1 acceptance tests: no network, no AWS credentials, no mutation."""
import base64
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import time
import unittest

ROOT=Path(__file__).resolve().parents[1]
def load(name):
    spec=importlib.util.spec_from_file_location(name.replace("-","_"),ROOT/"scripts"/name)
    mod=importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod
oidc=load("act-dev1-identity.py")
plan=load("act-dev1-canary-plan.py")
aws=load("act-dev1-readiness.py")
handoff=load("aws-dev-terraform-handoff.py")
apply_policy=load("act-dev1-apply-policy.py")

def jwt(claims):
    header=base64.urlsafe_b64encode(b'{"alg":"RS256","typ":"JWT"}').decode().rstrip("=")
    body=base64.urlsafe_b64encode(json.dumps(claims).encode()).decode().rstrip("=")
    return header+"."+body+".signaturefixture"

def canary():
    props={"name":"/alz/act-dev-1/canary-01","retention_in_days":30,
           "tags":{"environment":"DEV","managed-by":"sovereign-alz","purpose":"act-dev-1","owner":"qa"}}
    return {"format_version":"1.2","resource_changes":[{"mode":"managed","address":"aws_cloudwatch_log_group.pilot",
        "type":"aws_cloudwatch_log_group","change":{"actions":["create"],"before":None,"after":props,
            "after_unknown":{"arn":True,"id":True}}}],
        "planned_values":{"root_module":{"resources":[{"address":"aws_cloudwatch_log_group.pilot","values":props}]}},
        "configuration":{"provider_config":{"aws":{"expressions":{"region":{"constant_value":"us-east-2"}}}}}}

class FakeSTS:
    def __init__(self,role,account): self.role=role;self.account=account
    def assume_role_with_web_identity(self,**args):
        name=args["RoleArn"].split("/")[-1]
        return {"AssumedRoleUser":{"Arn":f"arn:aws:sts::{self.account}:assumed-role/{name}/alz-dev1-{self.role.lower().replace('_','-')}"},
                "Credentials":{"AccessKeyId":"FICTIONAL","SessionToken":"FICTIONAL"}}

class ACTDev1Synthetic(unittest.TestCase):
    def test_canary_hcl_static_scope_and_bootstrap_subject_handoff(self):
        hcl=(ROOT/"qualification/aws/act-dev1-canary/main.tf").read_text()
        self.assertEqual(hcl.count('resource "aws_cloudwatch_log_group"'),1)
        self.assertIn('backend "s3"',hcl)
        self.assertIn('retention_in_days = 30',hcl)
        self.assertNotIn('resource "aws_iam_',hcl)
        result=handoff.prepare(account="111111111111",management_account="973471129135",
            identifier="adaptcloud-dev",repo="realjkg/agent-private-landing-zone")
        self.assertIsNone(result["terraformVarsCandidate"]["oidc_subjects"])
        self.assertFalse(result["cloudMutation"])

    def test_iam_canary_policy_least_privilege(self):
        policy=apply_policy.build("111111111111","/alz/act-dev-1/canary-01","qa")
        self.assertEqual(policy["Version"],"2012-10-17")
        create=[x for x in policy["Statement"] if x["Sid"]=="AllowCanaryCreateWithReviewedTags"][0]
        self.assertEqual(create["Condition"]["StringEquals"]["aws:RequestTag/environment"],"DEV")
        self.assertNotIn("iam:*",create["Action"])
        with self.assertRaises(ValueError):
            apply_policy.build(aws.MANAGEMENT,"/alz/act-dev-1/canary-01","qa")
        with self.assertRaises(ValueError):
            apply_policy.build("111111111111","/unbounded/log-group","qa")
        self.assertIn("permissions_boundary",(ROOT/"bootstrap/aws/main.tf").read_text())
        self.assertIn('variable "apply_permissions_boundary_arn"',(ROOT/"bootstrap/aws/variables.tf").read_text())
    def test_canary_is_exactly_one_additive_create(self):
        accepted=plan.validate(canary(),expected_name="/alz/act-dev-1/canary-01",expected_owner="qa")
        self.assertEqual(accepted["verdict"],"STRUCTURALLY_ACCEPTABLE")
        self.assertEqual(accepted["state"],"NOT_APPLIED")
    def test_reject_mutation_expansion_and_drift(self):
        for actions in (["update"],["delete"],["delete","create"],["no-op"]):
            x=canary()
            x["resource_changes"][0]["change"]["actions"]=actions
            with self.assertRaises(plan.CanaryRefusal):
                plan.validate(x,expected_name="/alz/act-dev-1/canary-01",expected_owner="qa")
        x=canary();x["resource_changes"].append(x["resource_changes"][0])
        with self.assertRaises(plan.CanaryRefusal):plan.validate(x,expected_name="/alz/act-dev-1/canary-01",expected_owner="qa")
        x=canary();x["resource_drift"]=[{"type":"aws_s3_bucket"}]
        with self.assertRaises(plan.CanaryRefusal):plan.validate(x,expected_name="/alz/act-dev-1/canary-01",expected_owner="qa")
        x=canary();x["configuration"]["provider_config"]["aws"]["expressions"]["region"]["constant_value"]="us-west-2"
        with self.assertRaises(plan.CanaryRefusal):plan.validate(x,expected_name="/alz/act-dev-1/canary-01",expected_owner="qa")
        x=canary();del x["resource_changes"][0]["change"]["after"]["tags"]["owner"]
        with self.assertRaises(plan.CanaryRefusal):plan.validate(x,expected_name="/alz/act-dev-1/canary-01",expected_owner="qa")

    def identity_world(self,root):
        now=int(time.time())
        roles={}
        for ident in oidc.ROLES:
            p=Path(root)/("token-"+ident.lower()+".jwt")
            subject="repo:owner/repo:environment:dev-"+ident.lower()
            p.write_text(jwt({"iss":"https://issuer.example","aud":"sts.amazonaws.com",
                 "sub":subject,"iat":now-5,"nbf":now-5,"exp":now+600}))
            p.chmod(0o600)
            roles[ident]={"roleArn":"arn:aws:iam::111111111111:role/alz-pilot-dev-"+ident.lower().replace("_","-"),
                          "subject":subject,"tokenFile":str(p)}
        return {"environment":"DEV","engine":"TERRAFORM","accountId":"111111111111",
                "managementAccountId":"999999999999","region":"us-east-2",
                "issuer":"https://issuer.example","audience":"sts.amazonaws.com","identities":roles}
    def test_oidc_claims_and_authenticated_sts(self):
        with tempfile.TemporaryDirectory() as root:
            config=self.identity_world(root)
            report=oidc.validate(config,sts_factory=lambda role:FakeSTS(role,"111111111111"))
            self.assertTrue(report["verified"])
            self.assertEqual(len(report["roles"]),4)
            self.assertFalse(report["rawTokensStored"])
            exports=oidc.export_bindings(config,report)
            self.assertIn("ALZ_STATE_WRITE_AWS_WEB_IDENTITY_TOKEN_FILE",exports)
            self.assertNotIn("signaturefixture",exports)
            self.assertIn("unset AWS_PROFILE",exports)
            with self.assertRaisesRegex(oidc.IdentityRefusal,"STS_EVIDENCE_REQUIRED"):
                oidc.export_bindings(config,oidc.validate(config))
            preview=oidc.validate(config)
            self.assertFalse(preview["verified"])
    def test_oidc_wrong_subject_token_reuse_and_permissions_denied(self):
        with tempfile.TemporaryDirectory() as root:
            config=self.identity_world(root)
            config["identities"]["APPLY"]["subject"]="wrong"
            with self.assertRaisesRegex(oidc.IdentityRefusal,"OIDC_SUBJECT_MISMATCH"):
                oidc.validate(config)
            config=self.identity_world(root)
            config["identities"]["APPLY"]["tokenFile"]=config["identities"]["STATE"]["tokenFile"]
            with self.assertRaises(oidc.IdentityRefusal):oidc.validate(config)
            config=self.identity_world(root)
            p=Path(config["identities"]["STATE"]["tokenFile"]);p.chmod(0o644)
            with self.assertRaisesRegex(oidc.IdentityRefusal,"TOKEN_FILE_INSECURE"):
                oidc.validate(config)
    def test_account_readback_scope(self):
        account="111111111111"
        class Sts:
            def get_caller_identity(self):return {"Account":aws.MANAGEMENT}
        class Org:
            def describe_account(self,AccountId):return {"Account":{"Status":"ACTIVE"}}
            def list_parents(self,ChildId):return {"Parents":[{"Id":aws.OU,"Type":"ORGANIZATIONAL_UNIT"}]}
            def describe_organizational_unit(self,OrganizationalUnitId):
                return {"OrganizationalUnit":{"Arn":"arn:aws:organizations::123:ou/root/"+aws.OU}}
        class CT:
            def get_paginator(self,name):return self
            def paginate(self):
                return [{"enabledBaselines":[{"baselineIdentifier":aws.BASELINE,
                        "targetIdentifier":"arn:aws:organizations::123:ou/root/"+aws.OU,
                        "statusSummary":{"status":"SUCCEEDED"}}]}]
        report=aws.account_inspection(Org(),CT(),Sts(),account_id=account)
        self.assertTrue(report["scopeVerified"])
        with self.assertRaisesRegex(aws.ReadinessRefusal,"DEDICATED_MEMBER"):
            aws.account_inspection(Org(),CT(),Sts(),account_id=aws.MANAGEMENT)
    def test_bootstrap_control_readback_and_missing_trust(self):
        subjects={r:"subject-"+r for r in aws.ROLES}
        class Sts:
            def get_caller_identity(self):return {"Account":"111111111111"}
        class IAM:
            def get_role(self,RoleName):
                role=RoleName.split("-")[-1].upper()
                if RoleName.endswith("state-write"):role="STATE_WRITE"
                doc={"Statement":[{"Effect":"Allow","Action":"sts:AssumeRoleWithWebIdentity",
                     "Principal":{"Federated":"arn:aws:iam::111111111111:oidc-provider/token.actions.githubusercontent.com"},
                     "Condition":{"StringEquals":{"token.actions.githubusercontent.com:sub":subjects[role],
                       "token.actions.githubusercontent.com:aud":"sts.amazonaws.com"}}}]}
                role_data={"Arn":"arn:aws:iam::111111111111:role/"+RoleName,"AssumeRolePolicyDocument":doc}
                if role=="APPLY":
                    role_data["PermissionsBoundary"]={"PermissionsBoundaryArn":"arn:aws:iam::111111111111:policy/act-dev1-boundary"}
                return {"Role":role_data}
            def list_attached_role_policies(self,RoleName):
                return {"AttachedPolicies":[{"PolicyArn":"arn:aws:iam::111111111111:policy/act-dev1-apply"}]}
        class S3:
            def get_public_access_block(self,Bucket):
                return {"PublicAccessBlockConfiguration":{k:True for k in ("BlockPublicAcls","IgnorePublicAcls","BlockPublicPolicy","RestrictPublicBuckets")}}
            def get_bucket_versioning(self,Bucket):return {"Status":"Enabled"}
            def get_bucket_ownership_controls(self,Bucket):return {"OwnershipControls":{"Rules":[{"ObjectOwnership":"BucketOwnerEnforced"}]}}
            def get_bucket_encryption(self,Bucket):return {"ServerSideEncryptionConfiguration":{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"}}]}}
            def get_bucket_policy(self,Bucket):
                state="arn:aws:iam::111111111111:role/alz-pilot-dev-state"
                state_write="arn:aws:iam::111111111111:role/alz-pilot-dev-state-write"
                return {"Policy":json.dumps({"Statement":[
                    {"Sid":"DenyInsecureTransport","Effect":"Deny",
                     "Condition":{"Bool":{"aws:SecureTransport":"false"}}},
                    {"Sid":"DenyEveryoneElse","Effect":"Deny",
                     "Condition":{"ArnNotLike":{"aws:PrincipalArn":[state,state_write]}}},
                    {"Sid":"StateCannotWriteState","Effect":"Deny",
                     "NotResource":"arn:aws:s3:::fake-bucket/pilot/dev.tfstate.tflock",
                     "Principal":{"AWS":state}},
                    {"Sid":"StateWriteCannotDeleteVersions","Effect":"Deny",
                     "Principal":{"AWS":state_write}}
                ]})}
        result=aws.dev_bootstrap_inspection(IAM(),S3(),Sts(),account_id="111111111111",bucket="fake-bucket",subjects=subjects,apply_boundary_arn="arn:aws:iam::111111111111:policy/act-dev1-boundary",apply_policy_arn="arn:aws:iam::111111111111:policy/act-dev1-apply")
        self.assertTrue(result["readBackVerified"])
        self.assertEqual(result["effectiveDeniedActions"],"NOT_TESTED")
        broken={**subjects,"APPLY":"subject-DISCOVERY"}
        with self.assertRaises(aws.ReadinessRefusal):
            aws.dev_bootstrap_inspection(IAM(),S3(),Sts(),account_id="111111111111",bucket="fake-bucket",subjects=broken,apply_boundary_arn="arn:aws:iam::111111111111:policy/act-dev1-boundary",apply_policy_arn="arn:aws:iam::111111111111:policy/act-dev1-apply")

def load_tests(loader, tests, pattern):
    """Include legacy Terraform handoff tests in the same bounded qualification."""
    legacy=ROOT/"tests_python/test_aws_dev_terraform_handoff.py"
    spec=importlib.util.spec_from_file_location("legacy_handoff",legacy)
    mod=importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    tests.addTests(loader.loadTestsFromModule(mod))
    return tests

if __name__=="__main__":unittest.main()
