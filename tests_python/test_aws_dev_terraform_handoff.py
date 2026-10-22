"""Offline plan-only contract tests. No AWS credentials or live calls."""
import importlib.util
import pathlib
import unittest

path = pathlib.Path(__file__).resolve().parents[1] / "scripts/aws-dev-terraform-handoff.py"
spec = importlib.util.spec_from_file_location("aws_tf_handoff", path)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

class TerraformHandoffTests(unittest.TestCase):
    def run_prepare(self, **changes):
        params = dict(account="111111111111", management_account="973471129135",
                      identifier="adaptcloud-dev", repo="realjkg/agent-private-landing-zone")
        params.update(changes)
        return module.prepare(**params)

    def test_terraform_first_no_mutation(self):
        result = self.run_prepare()
        self.assertEqual(result["engine"], "TERRAFORM")
        self.assertEqual(result["decision"], "BLOCKED")
        self.assertFalse(result["actEnabled"])
        self.assertFalse(result["cloudMutation"])
        self.assertEqual(result["cumulativeCreditCeilingUsd"], 80)
        self.assertEqual(result["cdk"]["mode"], "SEPARATE_PATH")
        self.assertEqual(result["terraformVarsCandidate"]["environment"], "DEV")

    def test_never_target_management_account(self):
        result = self.run_prepare(account="973471129135")
        self.assertIn("MANAGEMENT_ACCOUNT_FORBIDDEN", result["errors"])
        self.assertEqual(result["decision"], "BLOCKED")

    def test_reject_malformed_inputs(self):
        result = self.run_prepare(account="not-an-account", identifier="BAD", repo="invalid")
        self.assertEqual(len(result["errors"]), 3)

    def test_oidc_identities_are_unique(self):
        identities = self.run_prepare()["terraformVarsCandidate"]["oidc_subjects"]
        self.assertEqual(set(identities), {"DISCOVERY","STATE","STATE_WRITE","APPLY"})
        self.assertEqual(len(set(identities.values())), 4)

if __name__ == "__main__":
    unittest.main()
