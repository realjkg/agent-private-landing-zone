"""Synthetic joint qualification, independent of live AWS and external monitoring."""
import importlib.util
import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

ROOT=Path(__file__).resolve().parents[1]
def module(filename,name):
    spec=importlib.util.spec_from_file_location(name,ROOT/"scripts"/filename)
    value=importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value
cost=module("alz-cost-import.py","alz_cost")
grafana=module("alz-grafana-dashboard.py","alz_grafana")
policy=module("alz-policy-coverage.py","alz_policy")

class JointEvidenceTests(unittest.TestCase):
    def test_integrated_plan_only_pipeline(self):
        with tempfile.TemporaryDirectory() as directory:
            base=Path(directory)
            (base/"vInfo.csv").write_text("VM,Powerstate\nvm1,poweredOn\n",encoding="utf8")
            (base/"focus.csv").write_text("BilledCost,BillingCurrency,ChargePeriodStart,ChargePeriodEnd,ResourceId\n2.50,USD,2026-10-01T00:00:00Z,2026-10-02T00:00:00Z,aws-resource-1\n",encoding="utf8")
            (base/"assets.csv").write_text("cost_category,resource_id,monthly_usd,allocation_basis\nhardware,vm1,50,allocated_capacity\nlicensing,vm1,15,per_vm\nfacilities,host1,10,power_budget\n",encoding="utf8")
            report=cost.collect(SimpleNamespace(rvtools=str(base/"vInfo.csv"),focus=str(base/"focus.csv"),assets=str(base/"assets.csv")))
            self.assertEqual(report["rvtools"]["count"],1)
            self.assertEqual(report["totalsByCategoryUsd"]["cloud"],"2.50")
            self.assertEqual(report["totalsByCategoryUsd"]["hardware"],"50")
            self.assertTrue(all(report["sources"][key]["sha256"] for key in ("rvtools","focus","assets")))
            self.assertFalse(report["actualCostsVerified"])
            self.assertFalse(report["canAuthorizeSpend"])
            metrics=cost.prometheus(report)
            self.assertIn('category="facilities"} 10',metrics)
            self.assertNotIn("aws-resource-1",metrics)
            dashboard=grafana.dashboard()
            self.assertEqual(dashboard["dashboard"]["uid"],"sovereign-alz-cost")
            self.assertTrue(all(p["datasource"]["type"]=="prometheus" for p in dashboard["dashboard"]["panels"]))
            result=policy.coverage({"governance":{"opa":{"status":"DISCOVERED","policies":[{"id":"p1"}]},"scp":{"status":"DISCOVERED","policies":[]} }})
            self.assertEqual(result["surfaces"]["rcp"]["discovery"],"UNKNOWN")
            self.assertFalse(result["enforcementValidated"])
            self.assertFalse(result["infrastructureAct"]!="DISABLED")
    def test_reject_bad_inputs(self):
        with tempfile.TemporaryDirectory() as directory:
            base=Path(directory)
            (base/"bad.csv").write_text("BilledCost,BillingCurrency,ChargePeriodStart,ChargePeriodEnd\nNaN,USD,2026-10-01T00:00:00Z,2026-10-02T00:00:00Z\n")
            with self.assertRaisesRegex(ValueError,"Nonfinite"):
                cost.focus(base/"bad.csv")
            (base/"bad.csv").write_text("BilledCost,BillingCurrency,ChargePeriodStart,ChargePeriodEnd\n2,USD,2026-10-02T00:00:00Z,2026-10-01T00:00:00Z\n")
            with self.assertRaisesRegex(ValueError,"invalid time range"):
                cost.focus(base/"bad.csv")
            (base/"bad.csv").write_text("cost_category,resource_id,monthly_usd,allocation_basis\nhardware,vm1,-4,per_vm\n")
            with self.assertRaisesRegex(ValueError,"negative monthly"):
                cost.assets(base/"bad.csv")
            with self.assertRaisesRegex(ValueError,"Malformed"):
                policy.coverage({"opa":"ALLOW_ALL"})
    def test_missing_evidence_never_passes(self):
        result=policy.coverage({})
        self.assertTrue(all(entry["discovery"]=="UNKNOWN" for entry in result["surfaces"].values()))
        self.assertTrue(all(entry["status"]=="BLOCKED_MISSING_EVIDENCE" for entry in result["greenfieldProposal"]))
        self.assertFalse(result["enforcementValidated"])

if __name__=="__main__": unittest.main()
