"""Offline, no-AWS smoke checks for guarded account-factory intake.

Run: python3 -m unittest discover -s tests_python -p 'test_aws_dev_intake.py'
Mocks boto3 clients; no credentials or network are required.
"""
import contextlib
import importlib.util
import io
import json
from pathlib import Path
import sys
import types
import unittest
from unittest.mock import patch

PATH = Path(__file__).resolve().parents[1] / "scripts" / "aws-dev-account-intake.py"


class Organization:
    def describe_organization(self):
        return {"Organization": {"MasterAccountId": "973471129135"}}

    def list_accounts(self):
        return {"Accounts": [{"Id": "973471129135", "Name": "Adapt Cloud"}]}

    def list_roots(self):
        return {"Roots": [{"Id": "r-example"}]}

    def list_organizational_units_for_parent(self, **kwargs):
        return {"OrganizationalUnits": [{"Id": "ou-example", "Name": "Security"}]}


class Client:
    def __init__(self, service):
        self.service = service

    def get_caller_identity(self):
        return {"Account": "973471129135", "Arn": "arn:aws:iam::973471129135:root"}

    def list_landing_zones(self):
        return {"landingZones": [{"arn": "arn:example"}]}

    def list_enabled_baselines(self):
        return {"enabledBaselines": []}

    def describe_budgets(self, **kwargs):
        return {"Budgets": []}


class Session:
    def __init__(self, region_name=None):
        pass

    def client(self, name, **kwargs):
        if name == "organizations":
            return Organization()
        return Client(name)


class TestAccountIntake(unittest.TestCase):
    def setUp(self):
        boto3 = types.ModuleType("boto3")
        boto3.session = types.SimpleNamespace(Session=Session)
        botocore = types.ModuleType("botocore")
        exceptions = types.ModuleType("botocore.exceptions")
        exceptions.ClientError = type("ClientError", (Exception,), {})
        exceptions.BotoCoreError = type("BotoCoreError", (Exception,), {})
        spec = importlib.util.spec_from_file_location("aws_dev_intake_test", PATH)
        module = importlib.util.module_from_spec(spec)
        with patch.dict(sys.modules, {"boto3": boto3, "botocore": botocore, "botocore.exceptions": exceptions}):
            spec.loader.exec_module(module)
        self.module = module

    def invoke(self, extra=None):
        args = ["aws-dev-account-intake.py", "--account-email", "info@adaptcloud.io",
                "--owner-email", "kristian@adaptcloud.io",
                "--owner-first-name", "Dev", "--owner-last-name", "Operator"]
        args += extra or []
        out = io.StringIO()
        with patch.object(sys, "argv", args), contextlib.redirect_stdout(out):
            rc = self.module.main()
        return rc, json.loads(out.getvalue())

    def test_missing_workload_ou_and_budgets_block(self):
        rc, payload = self.invoke()
        self.assertEqual(rc, 2)
        self.assertEqual(payload["decision"], "BLOCKED")
        self.assertFalse(payload["cloudMutation"])
        self.assertFalse(payload["actEnabled"])
        self.assertEqual(payload["creditCeilingUsd"], 80)
        self.assertEqual(payload["accountFactoryParameters"]["AccountEmail"], "info@adaptcloud.io")
        self.assertEqual(payload["accountFactoryParameters"]["SSOUserEmail"], "kristian@adaptcloud.io")
        self.assertEqual(len(payload["blockers"]), 3)

    def test_wrong_account_blocks_without_mutation(self):
        rc, payload = self.invoke(["--management-account", "111111111111"])
        self.assertEqual(rc, 2)
        self.assertEqual(payload["decision"], "BLOCKED")
        self.assertFalse(payload["cloudMutation"])


if __name__ == "__main__":
    unittest.main()
